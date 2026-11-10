import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { teeChatCompletion, getVerifiedSigners, resetTeeCache, nrasVerdict, tdxResultFromDcap } from './nearAiTee.js';
import { fakeNearAiTee, type TeeBreak } from './__fixtures__/nearAiTeeFake.js';

const MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash-1017';
const body = { model: MODEL, messages: [{ role: 'user', content: 'plan it' }], temperature: 0.2 };

describe('NEAR AI TEE verification', () => {
  beforeEach(() => resetTeeCache());

  it('accepts an answer signed by the attested model TEE over the exact bytes', async () => {
    const fake = fakeNearAiTee({ content: '{"ok":true}' });
    const r = await teeChatCompletion(body, 'key', fake.deps);
    expect(r).toMatchObject({ verified: true, content: '{"ok":true}', signer: fake.teeAddress });

    // Attestation came first, with a fresh 32-byte nonce, the model, and no aliasing
    const attest = new URL(fake.calls[0].url);
    expect(attest.pathname).toBe('/v1/attestation/report');
    expect(attest.searchParams.get('model')).toBe(MODEL);
    expect(attest.searchParams.get('signing_algo')).toBe('ecdsa');
    expect(attest.searchParams.get('nonce')).toMatch(/^[0-9a-f]{64}$/);
    expect(fake.calls[1].init.headers['x-no-aliasing']).toBe('true');
    expect(fake.calls[1].init.headers['Accept-Encoding']).toBe('identity');
  });

  const failures: [TeeBreak, RegExp][] = [
    ['no-attestation', /no TEE attestation/],
    ['wrong-nonce', /nonce/],
    ['wrong-address', /signing address/],
    ['debug-td', /debug/],
    ['bad-tcb', /Revoked/],
    ['wrong-compose', /app compose/],
    ['gpu-fail', /NVIDIA/],
    ['tampered-response', /different request or response/],
    ['other-signer', /not attested/],
    ['gateway-signature', /not signed by the model TEE/],
    ['no-signature', /no signature/],
    ['model-down', /503/],
  ];
  for (const [brk, reason] of failures) {
    it(`refuses the answer when ${brk}`, async () => {
      const fake = fakeNearAiTee({ content: '{"ok":true}', break: brk });
      const r = await teeChatCompletion(body, 'key', fake.deps);
      expect(r.verified).toBe(false);
      expect(r.content).toBeNull();
      expect(r.reason).toMatch(reason);
    });
  }

  it('reuses a fresh attestation instead of re-checking hardware for every plan', async () => {
    const fake = fakeNearAiTee({ content: '{}' });
    await teeChatCompletion(body, 'key', fake.deps);
    await teeChatCompletion(body, 'key', fake.deps);
    expect(fake.calls.filter(c => c.url.includes('/attestation/report'))).toHaveLength(1);
  });

  it('does not cache a failed attestation', async () => {
    const bad = fakeNearAiTee({ content: '{}', break: 'gpu-fail' });
    expect((await getVerifiedSigners(MODEL, 'key', bad.deps)).signers).toEqual([]);
    const good = fakeNearAiTee({ content: '{}' });
    expect((await getVerifiedSigners(MODEL, 'key', good.deps)).signers).toEqual([good.teeAddress]);
  });

  it('reads the overall verdict from NVIDIA NRAS', () => {
    const jwt = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
    expect(nrasVerdict([['JWT', jwt({ 'x-nvidia-overall-att-result': true, eat_nonce: 'ab' })], {}])).toEqual({ pass: true, nonce: 'ab' });
    expect(nrasVerdict([['JWT', jwt({ 'x-nvidia-overall-att-result': false })], {}]).pass).toBe(false);
    expect(nrasVerdict({}).pass).toBe(false);
  });
});

describe('Intel TDX quote check (dcap-qvl)', () => {
  it('verifies a real TDX quote and reads its report data', async () => {
    // Sample quote and collateral from Phala's dcap-qvl repository (MIT)
    const dir = fileURLToPath(new URL('./__fixtures__/', import.meta.url));
    const quote = readFileSync(dir + 'tdx_quote');
    const collateral = JSON.parse(readFileSync(dir + 'tdx_quote_collateral.json', 'utf8'));
    const issued = Date.parse(JSON.parse(collateral.tcb_info).issueDate) / 1000;
    // @ts-ignore - native wasm package without types
    const dcap: any = await import('@phala/dcap-qvl-node');
    const lib = dcap.js_verify ? dcap : dcap.default;
    const result = tdxResultFromDcap(lib.js_verify(quote, collateral, BigInt(issued + 60)));
    expect(result.status).toBe('UpToDate');
    expect(result.reportData).toHaveLength(64);
    expect(result.mrConfigId).toHaveLength(48);
    expect(result.tdAttributes).toHaveLength(8);
  });

  it('rejects a tampered quote', async () => {
    const dir = fileURLToPath(new URL('./__fixtures__/', import.meta.url));
    const quote = Buffer.from(readFileSync(dir + 'tdx_quote'));
    quote[600] ^= 0xff;
    const collateral = JSON.parse(readFileSync(dir + 'tdx_quote_collateral.json', 'utf8'));
    const issued = Date.parse(JSON.parse(collateral.tcb_info).issueDate) / 1000;
    // @ts-ignore - native wasm package without types
    const dcap: any = await import('@phala/dcap-qvl-node');
    const lib = dcap.js_verify ? dcap : dcap.default;
    expect(() => lib.js_verify(quote, collateral, BigInt(issued + 60))).toThrow();
  });
});
