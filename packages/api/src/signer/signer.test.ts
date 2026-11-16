import { describe, it, expect, afterEach } from 'vitest';
import { decide, POLICY } from './policy.js';
import { signBody, toWire, signerEnabled } from '../moneyOut.js';
import { formatSecurityAlert } from '../securityAlerts.js';

describe('signer policy', () => {
  const ok = { paused: false, breakerTripped: false, userCountLastHour: 0, globalCountInWindow: 0 };

  it('allows a normal withdrawal', () => {
    expect(decide(ok)).toEqual({ allowed: true });
  });

  it('refuses everything while paused or after the breaker tripped', () => {
    expect(decide({ ...ok, paused: true }).allowed).toBe(false);
    expect(decide({ ...ok, breakerTripped: true }).allowed).toBe(false);
  });

  it('limits withdrawals per user per hour', () => {
    const r = decide({ ...ok, userCountLastHour: POLICY.perUserPerHour() });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/per hour/);
    expect(r.trippedNow).toBeUndefined();
  });

  it('trips the circuit breaker when withdrawals spike across all users', () => {
    const r = decide({ ...ok, globalCountInWindow: POLICY.globalMaxInWindow() });
    expect(r.allowed).toBe(false);
    expect(r.trippedNow).toBe(true);
  });
});

describe('signer request signing', () => {
  it('signs timestamp and body together, so neither can be changed', () => {
    const base = signBody('s'.repeat(32), '1000', '{"op":"near"}');
    expect(signBody('s'.repeat(32), '1001', '{"op":"near"}')).not.toBe(base);
    expect(signBody('s'.repeat(32), '1000', '{"op":"sui"}')).not.toBe(base);
    expect(signBody('t'.repeat(32), '1000', '{"op":"near"}')).not.toBe(base);
  });

  it('sends bigints as strings', () => {
    expect(toWire({ amountRaw: 10n ** 20n })).toBe('{"amountRaw":"100000000000000000000"}');
  });
});

describe('signerEnabled', () => {
  const saved = { url: process.env.SIGNER_URL, signer: process.env.RACERBOT_SIGNER };
  afterEach(() => {
    process.env.SIGNER_URL = saved.url;
    process.env.RACERBOT_SIGNER = saved.signer;
    if (saved.url === undefined) delete process.env.SIGNER_URL;
    if (saved.signer === undefined) delete process.env.RACERBOT_SIGNER;
  });

  it('is off without SIGNER_URL, so withdrawals run as before', () => {
    delete process.env.SIGNER_URL;
    expect(signerEnabled()).toBe(false);
  });

  it('is on in the API when SIGNER_URL is set, and never inside the signer itself', () => {
    process.env.SIGNER_URL = 'http://signer.railway.internal:8790';
    delete process.env.RACERBOT_SIGNER;
    expect(signerEnabled()).toBe(true);
    process.env.RACERBOT_SIGNER = 'true';
    expect(signerEnabled()).toBe(false);
  });
});

describe('security alert text', () => {
  it('names the amount, chain and full destination, and flags a new address', () => {
    const text = formatSecurityAlert(
      { kind: 'withdrawal', chain: 'NEAR', asset: 'NEAR', amount: '1.5', to: 'alice.near', txHash: 'abc' },
      true
    );
    expect(text).toContain('1.5 NEAR');
    expect(text).toContain('alice.near');
    expect(text).toContain('First time sending to this address');
    expect(text).toContain('Not you?');
  });

  it('escapes HTML from user-controlled values', () => {
    const text = formatSecurityAlert({ kind: 'wallet_import', chain: 'Sui', address: '<b>x</b>', active: false }, null);
    expect(text).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});
