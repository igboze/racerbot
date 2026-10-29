/**
 * NEAR Intents Confidential Intents client: each confidential user gets a private balance account
 * (an ed25519 key pair; its 64-hex implicit ID is the account, no on-chain creation). Money enters
 * with a shield quote (deposit to a one-time address) and leaves with an unshield quote signed by
 * the account's key. Verified on mainnet 2026-10-29: shield ~19 s, unshield ~12 s, 1:1.
 */
import crypto from 'crypto';
import { KeyPair, utils } from 'near-api-js';
import { createLogger, getNear } from '@racerbot/shared';

const logger = createLogger('intents-private');

const API_URL = process.env.NEAR_INTENTS_API_URL || 'https://1click.chaindefuser.com';
const API_KEY = process.env.NEAR_INTENTS_API_KEY || '';
const WNEAR_ASSET = 'nep141:wrap.near';
const QUOTE_DEADLINE_MS = 30 * 60_000;

export interface PrivateAccountKeys {
  /** 64-hex implicit account ID inside NEAR Intents */
  accountId: string;
  publicKey: string;
  secretKey: string;
}

export interface MoveQuote {
  depositAddress: string;
  amountIn: string;
  amountOut: string;
  minAmountOut: string;
  timeEstimate?: number;
  depositMemo?: string;
}

export type MoveStatus = 'PENDING_DEPOSIT' | 'KNOWN_DEPOSIT_TX' | 'PROCESSING' | 'SUCCESS' | 'INCOMPLETE_DEPOSIT' | 'REFUNDED' | 'FAILED';
const FINAL_STATUSES = new Set<MoveStatus>(['SUCCESS', 'INCOMPLETE_DEPOSIT', 'REFUNDED', 'FAILED']);

/** A new private balance account. Store `secretKey` encrypted; it is the only way to move the funds. */
export function generatePrivateAccount(): PrivateAccountKeys {
  const kp = KeyPair.fromRandom('ed25519');
  const publicKey = kp.getPublicKey();
  return {
    accountId: Buffer.from(publicKey.data).toString('hex'),
    publicKey: publicKey.toString(),
    secretKey: kp.toString(),
  };
}

async function api<T>(method: 'GET' | 'POST', path: string, body?: unknown, bearer?: string): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  else if (API_KEY) headers['X-API-Key'] = API_KEY;
  const res = await fetch(`${API_URL}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`1Click ${path} ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

/**
 * Versioned nonce: magic prefix, version 0, the verifier's current salt, the deadline (ns, LE) and
 * 15 random bytes whose first 8 are the current time (ns, LE): 1Click's login rejects them otherwise.
 */
async function versionedNonce(deadline: Date): Promise<string> {
  const saltHex = await getNear().view<string>('intents.near', 'current_salt', {});
  const deadlineNs = Buffer.alloc(8);
  deadlineNs.writeBigUInt64LE(BigInt(deadline.getTime()) * 1_000_000n);
  const random = Buffer.concat([Buffer.alloc(8), crypto.randomBytes(7)]);
  random.writeBigInt64LE(BigInt(Date.now()) * 1_000_000n);
  return Buffer.concat([Buffer.from('5628f6c6', 'hex'), Buffer.from([0]), Buffer.from(saltHex, 'hex'), deadlineNs, random]).toString('base64');
}

function signRaw(keys: PrivateAccountKeys, payload: string): string {
  const { signature } = KeyPair.fromString(keys.secretKey as any).sign(Buffer.from(payload, 'utf8'));
  return `ed25519:${utils.serialize.base_encode(signature)}`;
}

const sessions = new Map<string, { token: string; expiresAt: number }>();

/** User-Session token for reading this account's private balance (cached until shortly before expiry). */
async function session(keys: PrivateAccountKeys): Promise<string> {
  const cached = sessions.get(keys.accountId);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;
  const deadline = new Date(Date.now() + 5 * 60_000);
  const payload = JSON.stringify({
    signer_id: keys.accountId,
    verifying_contract: 'intents.near',
    deadline: deadline.toISOString(),
    nonce: await versionedNonce(deadline),
    intents: [],
  });
  const auth = await api<{ accessToken: string; expiresIn: number }>('POST', '/v0/auth/authenticate', {
    signedData: { standard: 'raw_ed25519', payload, public_key: keys.publicKey, signature: signRaw(keys, payload) },
  }, 'none');
  sessions.set(keys.accountId, { token: auth.accessToken, expiresAt: Date.now() + auth.expiresIn * 1000 });
  return auth.accessToken;
}

/** Private wNEAR balance (yocto) of the account; 0 when it holds none. */
export async function getPrivateNearBalance(keys: PrivateAccountKeys): Promise<bigint> {
  const token = await session(keys);
  const res = await api<{ balances: { tokenId: string; available: string }[] }>(
    'GET', `/v0/account/balances?tokenIds=${encodeURIComponent(WNEAR_ASSET)}`, undefined, token);
  const entry = res.balances.find(b => b.tokenId === WNEAR_ASSET);
  return BigInt(entry?.available || '0');
}

function moveQuote(q: any): MoveQuote {
  const quote = q?.quote || {};
  if (!quote.depositAddress) throw new Error('1Click returned no deposit address');
  return {
    depositAddress: quote.depositAddress,
    amountIn: quote.amountIn,
    amountOut: quote.amountOut,
    minAmountOut: quote.minAmountOut,
    timeEstimate: quote.timeEstimate,
    depositMemo: quote.depositMemo,
  };
}

/**
 * Quote for moving `amount` wNEAR from a public NEAR account into a private account.
 * The sender then transfers exactly `amount` wNEAR to `depositAddress`; refunds go back to `refundTo`.
 */
export async function quoteShield(privateAccountId: string, amount: bigint, refundTo: string): Promise<MoveQuote> {
  return moveQuote(await api('POST', '/v0/quote', {
    dry: false,
    swapType: 'EXACT_INPUT',
    slippageTolerance: 100,
    originAsset: WNEAR_ASSET,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: WNEAR_ASSET,
    amount: amount.toString(),
    recipient: privateAccountId,
    recipientType: 'CONFIDENTIAL_INTENTS',
    refundTo,
    refundType: 'ORIGIN_CHAIN',
    confidentiality: 'basic',
    deadline: new Date(Date.now() + QUOTE_DEADLINE_MS).toISOString(),
  }));
}

/**
 * Move `amount` from the private account to `recipient` on NEAR (arrives as native NEAR; a new
 * implicit or named account is created/credited). Refunds stay in the private account.
 */
export async function unshield(keys: PrivateAccountKeys, amount: bigint, recipient: string): Promise<MoveQuote & { intentHash: string }> {
  const quote = moveQuote(await api('POST', '/v0/quote', {
    dry: false,
    swapType: 'EXACT_INPUT',
    slippageTolerance: 100,
    originAsset: WNEAR_ASSET,
    depositType: 'CONFIDENTIAL_INTENTS',
    destinationAsset: WNEAR_ASSET,
    amount: amount.toString(),
    recipient,
    recipientType: 'DESTINATION_CHAIN',
    refundTo: keys.accountId,
    refundType: 'CONFIDENTIAL_INTENTS',
    confidentiality: 'basic',
    deadline: new Date(Date.now() + QUOTE_DEADLINE_MS).toISOString(),
  }));
  const generated = await api<{ intent: { standard: string; payload: unknown } }>('POST', '/v0/generate-intent', {
    type: 'swap_transfer',
    standard: 'raw_ed25519',
    signerId: keys.accountId,
    depositAddress: quote.depositAddress,
  });
  // Sign exactly what was generated: raw_ed25519 signs the payload string's UTF-8 bytes
  const payload = typeof generated.intent.payload === 'string' ? generated.intent.payload : JSON.stringify(generated.intent.payload);
  const submitted = await api<{ intentHash: string }>('POST', '/v0/submit-intent', {
    type: 'swap_transfer',
    signedData: { ...generated.intent, public_key: keys.publicKey, signature: signRaw(keys, payload) },
  });
  return { ...quote, intentHash: submitted.intentHash };
}

/** Optional hint that a deposit was sent (1Click also detects it on its own, ~14 s in testing). */
export async function notifyDeposit(depositAddress: string, txHash: string): Promise<void> {
  await api('POST', '/v0/deposit/submit', { depositAddress, txHash }).catch(e =>
    logger.debug(`deposit/submit hint failed (non-fatal): ${e?.message}`));
}

export async function getMoveStatus(depositAddress: string): Promise<{ status: MoveStatus; details?: any }> {
  const s = await api<any>('GET', `/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`);
  return { status: s.status, details: s.swapDetails };
}

/** Poll until the move settles (or `timeoutMs` passes, returning the last status seen). */
export async function waitForMove(depositAddress: string, timeoutMs = 120_000, pollMs = 2_000): Promise<{ status: MoveStatus; details?: any }> {
  const start = Date.now();
  let last: { status: MoveStatus; details?: any } = { status: 'PENDING_DEPOSIT' };
  while (Date.now() - start < timeoutMs) {
    last = await getMoveStatus(depositAddress).catch(() => last);
    if (FINAL_STATUSES.has(last.status)) return last;
    await new Promise(r => setTimeout(r, pollMs));
  }
  return last;
}

/** sha256(salt + payout address), hex: the executor owner hash that never reveals the address on-chain. */
export function ownerHash(salt: string, payoutAddress: string): string {
  return crypto.createHash('sha256').update(salt + payoutAddress).digest('hex');
}
