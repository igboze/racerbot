import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { buildRecoveryKit, ownerExitArgs, sweepArgs } from './recoveryKit.js';

/** Read borsh strings back out, the way the executor's #[serializer(borsh)] arguments are read */
function readBorshStrings(b64: string): string[] {
  const buf = Buffer.from(b64, 'base64');
  const out: string[] = [];
  let i = 0;
  while (i < buf.length) {
    const len = buf.readUInt32LE(i);
    out.push(buf.subarray(i + 4, i + 4 + len).toString('utf8'));
    i += 4 + len;
  }
  return out;
}

const salt = '9f2c1a7e4b6d8f0a1c3e5f7a9b0d2e4f';
const payout = 'speedy.racerbot.near';

describe('recovery kit', () => {
  it('encodes owner_exit(to, salt) and sweep(token, to, salt) as the executor reads them', () => {
    expect(readBorshStrings(ownerExitArgs(payout, salt))).toEqual([payout, salt]);
    expect(readBorshStrings(sweepArgs('hoot.near', payout, salt))).toEqual(['hoot.near', payout, salt]);
  });

  it('carries the hash the router stored, so the executor accepts the salt', () => {
    const kit = buildRecoveryKit({ payoutAddress: payout, salt, executors: [] });
    // The executor checks sha256(salt bytes ++ address bytes) against owner_hash
    expect(kit.ownerHash).toBe(crypto.createHash('sha256').update(Buffer.concat([Buffer.from(salt), Buffer.from(payout)])).digest('hex'));
  });

  it('lists live executors with ready commands, and skips deleted ones', () => {
    const kit = buildRecoveryKit({
      payoutAddress: payout,
      salt,
      executors: [
        { account_id: 'a1.router.near', status: 'open', token: 'hoot.near' },
        { account_id: 'a2.router.near', status: 'ready', token: null },
        { account_id: 'a3.router.near', status: 'closed', token: 'hoot.near' },
        { account_id: 'a4.router.near', status: 'open', token: 'wrap.near' },
      ],
      generatedAt: new Date('2026-11-02T12:00:00Z'),
    });
    expect(kit).toMatchObject({ kind: 'racerbot-confidential-recovery-kit', version: 1, generatedAt: '2026-11-02T12:00:00.000Z', ownerSalt: salt });
    expect(kit.executors.map(e => e.account)).toEqual(['a1.router.near', 'a2.router.near', 'a4.router.near']);
    const [open, ready, wnear] = kit.executors as any[];
    expect(open.ownerExit.command).toContain(`a1.router.near owner_exit base64-args '${ownerExitArgs(payout, salt)}'`);
    expect(open.sweepToken.command).toContain(`a1.router.near sweep base64-args '${sweepArgs('hoot.near', payout, salt)}'`);
    expect(open.ownerExit.command).toContain('network-config mainnet');
    expect(ready.sweepToken).toBeUndefined();
    // wNEAR only leaves through an exit, never a sweep
    expect(wnear.sweepToken).toBeUndefined();
    expect(kit.howToRecover.join(' ')).toMatch(/7 days/);
  });
});
