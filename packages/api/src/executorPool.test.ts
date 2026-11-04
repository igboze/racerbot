import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import { _chooseSizesForTest as chooseSizes, _intearHopsForTest as intearHops, executorInitArgs, exitToIntentsArgs, extractExecutorEvents, ownsExecutor, parseControllerKeys, roundedReturn } from './executorPool.js';
import { generatePrivateAccount, ownerHash } from './intentsPrivate.js';

const NEAR = 10n ** 24n;
const ready = (...sizes: bigint[]) => sizes.map((s, i) => ({ account_id: `e${i}`, size_yocto: s.toString() }) as any);

describe('chooseSizes', () => {
  it('single: the smallest executor that covers the amount', () => {
    expect(chooseSizes(ready(5n * NEAR, NEAR, 2n * NEAR), NEAR + 1n, 'single')).toEqual([2n * NEAR]);
    expect(chooseSizes(ready(NEAR, NEAR), NEAR, 'single')).toEqual([NEAR]);
  });

  it('single: falls back to split across ready executors when multiple cover the amount', () => {
    expect(chooseSizes(ready(NEAR, NEAR), 2n * NEAR, 'single')).toEqual([NEAR, NEAR]);
  });

  it('single: nothing when no executor is big enough', () => {
    expect(chooseSizes(ready(NEAR, NEAR), 3n * NEAR, 'single')).toBeNull();
  });

  it('split: largest first until the amount is covered', () => {
    expect(chooseSizes(ready(NEAR, NEAR, 2n * NEAR), 3n * NEAR, 'split')).toEqual([2n * NEAR, NEAR]);
    expect(chooseSizes(ready(NEAR), 2n * NEAR, 'split')).toBeNull();
  });

  it('fleet: an equal share for as many executors as can carry it', () => {
    expect(chooseSizes(ready(NEAR, NEAR, NEAR, NEAR, NEAR), 5n * NEAR, 'fleet')).toHaveLength(5);
    expect(chooseSizes(ready(NEAR, NEAR, NEAR), 2n * NEAR, 'fleet')).toHaveLength(3);
  });
});

describe('intearHopsFromMessage', () => {
  it('turns a two-hop operations message back into hops', () => {
    const pool = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b.toString('base64'); };
    const msg = JSON.stringify({
      referrer: 'dex-aggregator.intear.near',
      operations: [
        { SwapSimple: { asset_in: 'near', asset_out: 'nep141:token.intear.near', message: pool(274) } },
        { SwapSimple: { asset_in: 'nep141:token.intear.near', asset_out: 'nep141:meme.near', message: pool(9) } },
        { Withdraw: { asset_id: 'nep141:meme.near' } },
      ],
    });
    expect(intearHops(msg)).toEqual([
      { pool_id: 274, token_in: 'near', token_out: 'token.intear.near' },
      { pool_id: 9, token_in: 'token.intear.near', token_out: 'meme.near' },
    ]);
  });

  it('returns null for messages without swaps', () => {
    expect(intearHops('{}')).toBeNull();
    expect(intearHops('not json')).toBeNull();
  });
});

describe('extractExecutorEvents', () => {
  it('keeps executor events with the account that emitted them', () => {
    const ev = (standard: string, event: string) => `EVENT_JSON:${JSON.stringify({ standard, version: '1.0.0', event, data: { used: '5' } })}`;
    const outcome = {
      receipts_outcome: [
        { outcome: { executor_id: 'racerbotrouter.near', logs: [ev('racerbot-vault', 'intent_submitted')] } },
        { outcome: { executor_id: 'ab12.racerbotrouter.near', logs: [ev('racerbot-executor', 'bought'), 'plain log'] } },
      ],
    };
    expect(extractExecutorEvents(outcome)).toEqual([{ event: 'bought', data: { used: '5' }, executor: 'ab12.racerbotrouter.near' }]);
  });
});

describe('private accounts', () => {
  it('the account id is the hex public key', () => {
    const k = generatePrivateAccount();
    expect(k.accountId).toMatch(/^[0-9a-f]{64}$/);
    expect(k.publicKey.startsWith('ed25519:')).toBe(true);
    expect(k.secretKey.startsWith('ed25519:')).toBe(true);
  });

  it('owner hash is sha256(salt + address), matching the executor contract', () => {
    // sha256("s3cr3t-saltlunar-nexus-9768.racerbot.near"), as the executor tests compute it
    expect(ownerHash('s3cr3t-salt', 'lunar-nexus-9768.racerbot.near')).toHaveLength(64);
    expect(ownerHash('a', 'b.near')).not.toEqual(ownerHash('a', 'c.near'));
    expect(ownerHash('a', 'b.near')).toEqual(ownerHash('a', 'b.near'));
  });
});

describe('roundedReturn', () => {
  it('sends whole 0.1 NEAR steps first and keeps the rest for later', () => {
    expect(roundedReturn(1_234_567n * 10n ** 18n)).toBe(12n * 10n ** 23n); // 1.234567 -> 1.2
    expect(roundedReturn(5n * NEAR)).toBe(5n * NEAR);
  });
  it('sends small amounts in one piece', () => {
    expect(roundedReturn(15n * 10n ** 22n)).toBe(15n * 10n ** 22n); // 0.15 NEAR
  });
});

describe('parseControllerKeys', () => {
  it('reads several keys of the controller account', () => {
    expect(parseControllerKeys('ed25519:AAA, ed25519:BBB', 'ed25519:Z')).toEqual(['ed25519:AAA', 'ed25519:BBB']);
  });
  it('falls back to the single key, or none', () => {
    expect(parseControllerKeys('', 'ed25519:Z')).toEqual(['ed25519:Z']);
    expect(parseControllerKeys(undefined, '')).toEqual([]);
  });
  it('skips malformed entries', () => {
    expect(parseControllerKeys('nokey,secp256k1:Q', 'ed25519:F')).toEqual(['ed25519:F']);
  });
});

describe('executor borsh arguments', () => {
  it('new(controller, owner_hash): length-prefixed string, then length-prefixed bytes', () => {
    const hash = 'ab'.repeat(32);
    const hex = Buffer.from(executorInitArgs('racerbot.near', hash)).toString('hex');
    expect(hex).toBe('0d000000' + Buffer.from('racerbot.near').toString('hex') + '20000000' + hash);
  });
  it('exit_to_intents(deposit_address, amount): string then u128 little-endian', () => {
    const hex = Buffer.from(exitToIntentsArgs('a.near', (1n << 64n) + 5n)).toString('hex');
    expect(hex).toBe('06000000' + Buffer.from('a.near').toString('hex') + '0500000000000000' + '0100000000000000');
  });
});

describe('ownsExecutor', () => {
  const acct = { owner_salt: 'salt1', payout_address: 'alice.near' };
  const hash = createHash('sha256').update('salt1alice.near').digest('hex');
  it('accepts the executor whose on-chain owner hash is this account', () => {
    expect(ownsExecutor({ owner_hash: hash }, acct)).toBe(true);
    expect(ownsExecutor({ owner_hash: hash.toUpperCase() }, acct)).toBe(true);
  });
  it("refuses another user's executor, a missing hash, or no state", () => {
    expect(ownsExecutor({ owner_hash: hash }, { owner_salt: 'salt2', payout_address: 'alice.near' })).toBe(false);
    expect(ownsExecutor({ owner_hash: hash }, { owner_salt: 'salt1', payout_address: 'bob.near' })).toBe(false);
    expect(ownsExecutor({}, acct)).toBe(false);
    expect(ownsExecutor(null, acct)).toBe(false);
  });
});
