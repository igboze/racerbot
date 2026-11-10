/**
 * NEAR AI Cloud private inference, verified.
 *
 * A swarm plan only counts as an AI plan when we can prove the model ran inside
 * a NEAR AI trusted execution environment (TEE) and that the answer we got is
 * the one that TEE signed. Follows docs.near.ai/cloud/verification:
 *
 * 1. Preflight (before the completion, cached for a few minutes): fetch the
 *    model's attestation with a fresh 32-byte nonce, and for every candidate
 *    report check the Intel TDX quote (dcap-qvl, Intel PCS collateral, debug
 *    TDs rejected), that its report_data binds the signing address and our
 *    nonce, that mr_config matches the attested app compose, and that the
 *    NVIDIA GPU evidence carries our nonce and passes NVIDIA NRAS.
 * 2. Completion: send exact request bytes with x-no-aliasing and keep the
 *    exact response bytes.
 * 3. Signature: fetch /v1/signature/{id}; it must be a provider_tee signature
 *    over "<model>:<sha256(request)>:<sha256(response)>", recover the EIP-191
 *    signer, and match exactly one signer verified in step 1.
 *
 * Anything missing or wrong means "not verified"; callers then do not use the answer.
 */

import { createHash, randomBytes } from 'node:crypto';
import { verifyMessage } from 'ethers';
import { createLogger } from '@racerbot/shared';

const logger = createLogger('near-ai-tee');

export const NEAR_AI_BASE_URL = 'https://cloud-api.near.ai';
export const DEFAULT_TEE_MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash-1017';
const NRAS_URL = 'https://nras.attestation.nvidia.com/v3/attest/gpu';
const INTEL_PCS_URL = 'https://api.trustedservices.intel.com/tdx/certification/v4';
/** Quote statuses we accept. UpToDate is ideal; the others still verify cryptographically (same as NEAR's reference verifier). */
const DEFAULT_TCB_STATUSES = ['UpToDate', 'SWHardeningNeeded', 'OutOfDate'];
const DEFAULT_ATTESTATION_TTL_MS = 10 * 60 * 1000;

/** What the TDX check reports back, whichever library produced it */
export interface TdxQuoteResult {
  status: string;
  reportData: Buffer;
  mrConfigId: Buffer;
  /** 8 bytes; bit 0 of the first byte is the TDX debug flag */
  tdAttributes: Buffer | null;
}

/** Outside services, swappable in tests */
export interface TeeDeps {
  fetch: typeof fetch;
  verifyTdxQuote: (quoteHex: string) => Promise<TdxQuoteResult>;
  /** Returns NVIDIA's overall verdict and the nonce NRAS attested */
  verifyGpu: (payload: Record<string, unknown>) => Promise<{ pass: boolean; nonce: string | null }>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface ModelAttestation {
  signing_address?: string;
  signing_algo?: string;
  intel_quote?: string;
  nvidia_payload?: string;
  tls_cert_fingerprint?: string;
  info?: { tcb_info?: string | { app_compose?: string } };
}

export interface VerifiedSigners {
  model: string;
  /** Lower-case 0x addresses of model TEEs whose attestation fully verified */
  signers: string[];
  checkedAt: number;
  /** Why nothing verified, when signers is empty */
  reason?: string;
}

export interface TeeChatResult {
  /** The model's text, only when verification passed */
  content: string | null;
  verified: boolean;
  /** Plain-language reason when not verified */
  reason?: string;
  signer?: string;
  attestedAt?: number;
}

// ── Small helpers ──────────────────────────────────────────────────────────

export function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function hexToBuffer(value: unknown): Buffer | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    const hex = value.replace(/^0x/i, '');
    return /^[0-9a-f]*$/i.test(hex) && hex.length % 2 === 0 ? Buffer.from(hex, 'hex') : null;
  }
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (Array.isArray(value) && value.every(n => Number.isInteger(n) && n >= 0 && n < 256)) return Buffer.from(value);
  return null;
}

const ADDRESS_RE = /^0x[0-9a-f]{40}$/i;

function appComposeOf(a: ModelAttestation): string | null {
  const raw = a.info?.tcb_info;
  if (!raw) return null;
  try {
    const info = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return typeof info?.app_compose === 'string' ? info.app_compose : null;
  } catch {
    return null;
  }
}

function decodeJwtPayload(jwt: string): any {
  const part = jwt.split('.')[1] || '';
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

// ── Real outside services ──────────────────────────────────────────────────

/** Intel TDX quote check with Phala's dcap-qvl (pure WebAssembly; rejects debug TDs by default) */
async function verifyTdxQuoteWithDcap(quoteHex: string): Promise<TdxQuoteResult> {
  // @ts-ignore - native wasm package without types
  const dcap: any = await import('@phala/dcap-qvl-node');
  const lib = dcap.js_verify ? dcap : dcap.default;
  const raw = Buffer.from(quoteHex.replace(/^0x/i, ''), 'hex');
  const collateral = await lib.js_get_collateral(process.env.INTEL_PCS_URL || INTEL_PCS_URL, raw);
  const result = lib.js_verify(raw, collateral, BigInt(Math.floor(Date.now() / 1000)));
  return tdxResultFromDcap(result);
}

/** dcap-qvl's verified report → the fields we check. Exported for tests. */
export function tdxResultFromDcap(result: any): TdxQuoteResult {
  const td = result?.report?.TD10 || result?.report?.TD15?.base || result?.report?.TD15 || {};
  const reportData = hexToBuffer(td.report_data);
  const mrConfigId = hexToBuffer(td.mr_config_id);
  if (!reportData || !mrConfigId) throw new Error('TDX report is missing report_data or mr_config_id');
  return {
    status: String(result?.status || ''),
    reportData,
    mrConfigId,
    tdAttributes: hexToBuffer(td.td_attributes),
  };
}

/** NVIDIA Remote Attestation Service: submits the GPU evidence unchanged */
async function verifyGpuWithNras(payload: Record<string, unknown>): Promise<{ pass: boolean; nonce: string | null }> {
  const res = await fetch(process.env.NVIDIA_NRAS_URL || NRAS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`NVIDIA NRAS answered ${res.status}`);
  const body: any = await res.json();
  return nrasVerdict(body);
}

/** NRAS answers [["JWT", token], {gpu: token, ...}]; the first token holds the overall result */
export function nrasVerdict(body: any): { pass: boolean; nonce: string | null } {
  const token = Array.isArray(body) && Array.isArray(body[0]) ? body[0][1] : null;
  if (typeof token !== 'string') return { pass: false, nonce: null };
  const claims = decodeJwtPayload(token);
  return {
    pass: claims['x-nvidia-overall-att-result'] === true,
    nonce: typeof claims.eat_nonce === 'string' ? claims.eat_nonce : null,
  };
}

const realDeps: TeeDeps = {
  fetch: (...args) => fetch(...args),
  verifyTdxQuote: verifyTdxQuoteWithDcap,
  verifyGpu: verifyGpuWithNras,
  now: () => Date.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
};

// ── Step 1: model attestation ──────────────────────────────────────────────

function allowedTcbStatuses(): Set<string> {
  const fromEnv = process.env.NEAR_AI_TEE_TCB_STATUSES;
  return new Set((fromEnv ? fromEnv.split(',') : DEFAULT_TCB_STATUSES).map(s => s.trim()).filter(Boolean));
}

/**
 * Checks one model attestation against our nonce. Returns the verified signer
 * (lower-case 0x address) or throws with the reason.
 */
export async function verifyModelAttestation(a: ModelAttestation, nonceHex: string, deps: TeeDeps = realDeps): Promise<string> {
  if ((a.signing_algo || '').toLowerCase() !== 'ecdsa') throw new Error(`unsupported signing algorithm ${a.signing_algo}`);
  const address = String(a.signing_address || '');
  if (!ADDRESS_RE.test(address)) throw new Error('signing address is not an Ethereum address');
  if (!a.intel_quote) throw new Error('no Intel TDX quote');
  if (!a.nvidia_payload) throw new Error('no NVIDIA GPU evidence');

  // Intel TDX: genuine hardware, acceptable patch level, not a debug TD
  const tdx = await deps.verifyTdxQuote(a.intel_quote);
  if (!allowedTcbStatuses().has(tdx.status)) throw new Error(`TDX status ${tdx.status || 'unknown'} not accepted`);
  if (tdx.tdAttributes && tdx.tdAttributes.length > 0 && (tdx.tdAttributes[0] & 1) === 1) throw new Error('TDX debug mode is on');

  // report_data = signer binding (32 bytes) + our nonce (32 bytes)
  if (tdx.reportData.length < 64) throw new Error('report_data is too short');
  const addrBytes = Buffer.from(address.slice(2), 'hex');
  const expectedFirst = a.tls_cert_fingerprint
    ? createHash('sha256').update(addrBytes).update(Buffer.from(a.tls_cert_fingerprint.replace(/^0x/i, ''), 'hex')).digest()
    : Buffer.concat([addrBytes, Buffer.alloc(32 - addrBytes.length)]);
  if (!tdx.reportData.subarray(0, 32).equals(expectedFirst)) throw new Error('report_data does not bind the signing address');
  if (!tdx.reportData.subarray(32, 64).equals(Buffer.from(nonceHex, 'hex'))) throw new Error('report_data does not carry our nonce');

  // The software in the TEE is the attested app compose
  const compose = appComposeOf(a);
  if (!compose) throw new Error('no app compose in the attestation');
  const expectedConfig = Buffer.concat([Buffer.from([1]), createHash('sha256').update(compose, 'utf8').digest()]);
  if (!tdx.mrConfigId.subarray(0, 33).equals(expectedConfig)) throw new Error('mr_config does not match the app compose');

  // NVIDIA GPU: our nonce, passed by NVIDIA's attestation service
  let gpuPayload: Record<string, unknown>;
  try {
    gpuPayload = JSON.parse(a.nvidia_payload);
  } catch {
    throw new Error('GPU evidence is not JSON');
  }
  if (String(gpuPayload.nonce || '').toLowerCase() !== nonceHex.toLowerCase()) throw new Error('GPU evidence does not carry our nonce');
  const gpu = await deps.verifyGpu(gpuPayload);
  if (!gpu.pass) throw new Error('NVIDIA did not pass the GPU evidence');
  if (gpu.nonce && gpu.nonce.toLowerCase() !== nonceHex.toLowerCase()) throw new Error('NVIDIA verdict is for another nonce');

  return address.toLowerCase();
}

const signerCache = new Map<string, VerifiedSigners>();
const inflight = new Map<string, Promise<VerifiedSigners>>();

/** Clears cached attestation results (tests, and after a signer mismatch) */
export function resetTeeCache(): void {
  signerCache.clear();
  inflight.clear();
}

function ttlMs(): number {
  const v = Number(process.env.NEAR_AI_ATTESTATION_TTL_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_ATTESTATION_TTL_MS;
}

/** Preflight evidence for a model: the TEE signers that verified, cached for a few minutes */
export async function getVerifiedSigners(model: string, apiKey: string, deps: TeeDeps = realDeps): Promise<VerifiedSigners> {
  const cached = signerCache.get(model);
  if (cached && cached.signers.length > 0 && deps.now() - cached.checkedAt < ttlMs()) return cached;
  const running = inflight.get(model);
  if (running) return running;

  const job = (async (): Promise<VerifiedSigners> => {
    const checkedAt = deps.now();
    const nonce = randomBytes(32).toString('hex');
    const base = process.env.NEAR_AI_BASE_URL || NEAR_AI_BASE_URL;
    const url = `${base}/v1/attestation/report?model=${encodeURIComponent(model)}&provider=near&signing_algo=ecdsa&nonce=${nonce}`;
    let report: any;
    try {
      const res = await deps.fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', 'x-no-aliasing': 'true' },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) return { model, signers: [], checkedAt, reason: `attestation request failed (${res.status})` };
      report = await res.json();
    } catch (err: any) {
      return { model, signers: [], checkedAt, reason: `attestation request failed (${err?.message || err})` };
    }
    const candidates: ModelAttestation[] = Array.isArray(report?.model_attestations) ? report.model_attestations : [];
    if (candidates.length === 0) return { model, signers: [], checkedAt, reason: 'NEAR AI returned no TEE attestation for this model' };

    const signers: string[] = [];
    const failures: string[] = [];
    for (const candidate of candidates) {
      try {
        signers.push(await verifyModelAttestation(candidate, nonce, deps));
      } catch (err: any) {
        failures.push(err?.message || String(err));
      }
    }
    if (failures.length) logger.warn(`NEAR AI TEE attestation: ${failures.length}/${candidates.length} reports failed: ${failures.join('; ')}`);
    const result: VerifiedSigners = signers.length
      ? { model, signers, checkedAt }
      : { model, signers, checkedAt, reason: `TEE attestation did not verify (${failures[0]})` };
    if (signers.length) signerCache.set(model, result);
    return result;
  })();

  inflight.set(model, job);
  try {
    return await job;
  } finally {
    inflight.delete(model);
  }
}

// ── Steps 2 and 3: signed completion ───────────────────────────────────────

/**
 * Runs one chat completion on a NEAR AI TEE model and returns its text only if
 * the response signature traces back to a TEE we attested.
 */
export async function teeChatCompletion(
  body: Record<string, unknown> & { model: string },
  apiKey: string,
  deps: TeeDeps = realDeps,
): Promise<TeeChatResult> {
  const model = body.model;
  const base = process.env.NEAR_AI_BASE_URL || NEAR_AI_BASE_URL;

  // Preflight first: evidence fetched after the completion does not count
  const preflight = await getVerifiedSigners(model, apiKey, deps);
  if (preflight.signers.length === 0) return { content: null, verified: false, reason: preflight.reason || 'no verified TEE' };

  const requestBytes = Buffer.from(JSON.stringify({ ...body, stream: false }), 'utf8');
  let responseBytes: Buffer;
  try {
    const res = await deps.fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Accept-Encoding': 'identity',
        'x-no-aliasing': 'true',
        Authorization: `Bearer ${apiKey}`,
      },
      body: requestBytes,
      signal: AbortSignal.timeout(45000),
    });
    responseBytes = Buffer.from(await res.arrayBuffer());
    if (!res.ok) return { content: null, verified: false, reason: `NEAR AI answered ${res.status}` };
  } catch (err: any) {
    return { content: null, verified: false, reason: `NEAR AI did not answer (${err?.message || err})` };
  }

  let completion: any;
  try {
    completion = JSON.parse(responseBytes.toString('utf8'));
  } catch {
    return { content: null, verified: false, reason: 'NEAR AI answer was not JSON' };
  }
  const chatId = typeof completion?.id === 'string' ? completion.id : '';
  const content = completion?.choices?.[0]?.message?.content;
  if (!chatId) return { content: null, verified: false, reason: 'NEAR AI answer had no id to check its signature' };
  if (typeof content !== 'string' || !content) return { content: null, verified: false, reason: 'NEAR AI returned no content' };

  // The signature can lag the response briefly: a short, bounded retry
  let sig: any = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await deps.fetch(
        `${base}/v1/signature/${encodeURIComponent(chatId)}?model=${encodeURIComponent(model)}&signing_algo=ecdsa`,
        { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }, signal: AbortSignal.timeout(10000) },
      );
      if (res.status === 404) { await deps.sleep(500 * (attempt + 1)); continue; }
      if (!res.ok) return { content: null, verified: false, reason: `signature request failed (${res.status})` };
      sig = await res.json();
      break;
    } catch (err: any) {
      return { content: null, verified: false, reason: `signature request failed (${err?.message || err})` };
    }
  }
  if (!sig || sig.error_code || typeof sig.text !== 'string' || typeof sig.signature !== 'string') {
    return { content: null, verified: false, reason: 'NEAR AI has no signature for this answer' };
  }
  if (sig.signature_kind !== 'provider_tee') {
    return { content: null, verified: false, reason: `answer was not signed by the model TEE (${sig.signature_kind || 'unknown kind'})` };
  }
  if (String(sig.signing_algo || 'ecdsa').toLowerCase() !== 'ecdsa') {
    return { content: null, verified: false, reason: 'unexpected signature algorithm' };
  }
  const expectedText = `${model}:${sha256Hex(requestBytes)}:${sha256Hex(responseBytes)}`;
  if (sig.text !== expectedText) return { content: null, verified: false, reason: 'signature covers different request or response bytes' };

  let recovered: string;
  try {
    recovered = verifyMessage(sig.text, sig.signature).toLowerCase();
  } catch {
    return { content: null, verified: false, reason: 'signature is malformed' };
  }
  const claimed = String(sig.signing_address || '').toLowerCase();
  if (recovered !== claimed) return { content: null, verified: false, reason: 'signature does not match its signing address' };

  const matches = preflight.signers.filter(s => s === recovered);
  if (matches.length !== 1) {
    // A new TEE key may have rolled out: drop the cache so the next plan re-attests
    signerCache.delete(model);
    return { content: null, verified: false, reason: 'answer was signed by a key we have not attested' };
  }
  return { content, verified: true, signer: recovered, attestedAt: preflight.checkedAt };
}
