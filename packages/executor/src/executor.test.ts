import { describe, it, expect, vi, beforeAll } from 'vitest';
import { KeyPair } from 'near-api-js';
import { encrypt, getNear, type SwapEvent, type RedisClient, type MultiRpcNear } from '@racerbot/shared';

process.env.KEY_ENCRYPTION_MASTER_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.MAIN_WALLET_PRIVATE_KEY =
  'ed25519:46rV5h6XvKY5wDGty1Jd3LeUePVvccfKGmdPtT7sUbyq1Tw7Z4e3mQZXvGKpq6rHpV8Xxto5GAaus5tWpdFfY4V4';
process.env.RACERBOT_PARENT_ACCOUNT = 'racerbot.near';
process.env.ROUTER_CONTRACT_ID = 'router.near';
process.env.TREASURY_ACCOUNT_ID = 'treasury.near';

vi.mock('@racerbot/db', () => ({
  getDb: vi.fn(),
  getUserById: vi.fn().mockResolvedValue({
    id: 'test-user-1',
    subaccount_id: 'alice.racerbot.near',
    scoped_key_encrypted: 'dummy',
    slippage_pct: 2,
  }),
  createFill: vi.fn().mockResolvedValue({ id: 'fill-1' }),
  getOpenPositions: vi.fn().mockResolvedValue([]),
  getPositionById: vi.fn().mockResolvedValue(null),
  getFillsByPosition: vi.fn().mockResolvedValue([]),
  createPosition: vi.fn().mockResolvedValue({ id: 'pos-1' }),
  updatePosition: vi.fn().mockResolvedValue({}),
  getTokenCache: vi.fn().mockResolvedValue(null),
  recordFee: vi.fn().mockResolvedValue({}),
  recordTradeAttempt: vi.fn().mockResolvedValue('attempt-1'),
  updateTradeAttempt: vi.fn().mockResolvedValue(undefined),
  getReferralByReferredUser: vi.fn().mockResolvedValue(null),
  activateReferral: vi.fn().mockResolvedValue({}),
  addReferralReward: vi.fn().mockResolvedValue({}),
}));

function createTestRedis(): RedisClient {
  const store = new Map<string, { value: string; expiresAt?: number }>();

  return {
    async publish() {
      return 1;
    },
    async subscribe() {},
    async unsubscribe() {},
    async get(key: string) {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt && entry.expiresAt < Date.now()) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key: string, value: string, ttlSeconds?: number) {
      store.set(key, {
        value,
        expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined,
      });
    },
    async setNxPx(key: string, value: string, ttlMs: number) {
      const entry = store.get(key);
      const isExpired = entry?.expiresAt && entry.expiresAt < Date.now();
      if (!entry || isExpired) {
        store.set(key, {
          value,
          expiresAt: Date.now() + ttlMs,
        });
        return true;
      }
      return false;
    },
    async eval(script: string, numkeys: number, ...args: (string | number)[]) {
      const key = String(args[0]);
      const token = String(args[1]);
      const entry = store.get(key);
      if (entry && entry.value === token) {
        store.delete(key);
        return 1;
      }
      return 0;
    },
    async del(key: string) {
      store.delete(key);
    },
    async hget() {
      return null;
    },
    async hset() {},
    async hgetall() {
      return {};
    },
    async sadd() {
      return 1;
    },
    async smembers() {
      return [];
    },
    async disconnect() {},
  };
}

const { SwapExecutor, addUserKey } = await import('./executor.js');

describe('SwapExecutor distributed locking', () => {
  const userId = 'test-user-1';
  const subaccountId = 'alice.racerbot.near';

  beforeAll(async () => {
    const realNear = getNear();
    vi.spyOn(realNear, 'getWhitelistedTokens').mockResolvedValue(['token.near', 'wrap.near']);
    vi.spyOn(realNear, 'hasKey').mockResolvedValue(true);
    vi.spyOn(realNear, 'view').mockResolvedValue({ total: '1000' });
    let tokenBal = 10000000000000000000000000n;
    vi.spyOn(realNear, 'getTokenBalance').mockImplementation(async () => {
      const b = tokenBal;
      tokenBal += 1000000000000000000000n;
      return b.toString();
    });
    vi.spyOn(realNear, 'ensureStorageDeposit').mockResolvedValue(undefined);
    vi.spyOn(realNear, 'findRheaPoolId').mockResolvedValue(123);
    // Pre-flight price check: a huge fresh quote so it never blocks test trades.
    vi.spyOn(realNear, 'computeMinAmountOut').mockResolvedValue({
      expectedOutput: '999999999999999999999999999999999',
      minAmountOut: '999999999999999999999999999999999',
    });
    vi.spyOn(realNear, 'getAccount').mockResolvedValue({
      functionCall: vi.fn().mockResolvedValue({}),
      sendMoney: vi.fn().mockResolvedValue({}),
    } as any);

    const keyPair = KeyPair.fromRandom('ed25519');
    const encryptedKey = encrypt(keyPair.toString(), process.env.KEY_ENCRYPTION_MASTER_KEY!);
    await addUserKey(userId, subaccountId, encryptedKey);
  });

  it('serializes two concurrent execute() calls for the SAME accountId and asserts only one signs at a time', async () => {
    const testRedis = createTestRedis();
    const timestamps: { start: number; end: number }[] = [];

    let bal1 = 10000000000000000000000000n;
    const mockNear = {
      getAccount: vi.fn().mockResolvedValue({
        functionCall: vi.fn().mockResolvedValue({}),
        sendMoney: vi.fn().mockResolvedValue({}),
      }),
      getTokenBalance: vi.fn().mockImplementation(async () => {
        const current = bal1;
        bal1 += 1000000000000000000000n;
        return current.toString();
      }),
      ensureStorageDeposit: vi.fn().mockResolvedValue(undefined),
      findRheaPoolId: vi.fn().mockResolvedValue(123),
      clearAccessKeyCache: vi.fn(),
      signAndSendTransactionAll: vi.fn().mockImplementation(async () => {
        const start = Date.now();
        // Hold the lock for 700ms so concurrent call waiting on 500ms backoff experiences contention
        await new Promise((r) => setTimeout(r, 700));
        const end = Date.now();
        timestamps.push({ start, end });
        return {
          transaction: { hash: `tx-${timestamps.length}` },
          receipts_outcome: [
            {
              outcome: {
                logs: [
                  `EVENT_JSON:${JSON.stringify({
                    standard: 'nep141',
                    version: '1.0.0',
                    event: 'ft_transfer',
                    data: [{ receiver_id: subaccountId, amount: '1000000' }],
                  })}`,
                ],
              },
            },
          ],
          status: { SuccessValue: '' },
        };
      }),
    } as unknown as MultiRpcNear;

    const executor = new SwapExecutor(testRedis, mockNear);

    const swapEvent: SwapEvent = {
      type: 'execute_swap',
      user_id: userId,
      token_in: 'wrap.near',
      token_out: 'token.near',
      amount_in: '1000000000000000000000000',
      min_amount_out: '1000000',
      venue: 'ref',
      pool_id: 123,
      timestamp: Date.now(),
    };

    // Trigger two concurrent execute calls for the same subaccount
    const call1 = executor.execute(swapEvent);
    const call2 = executor.execute(swapEvent);

    const [res1, res2] = await Promise.all([call1, call2]);

    expect(res1.success).toBe(true);
    expect(res2.success).toBe(true);
    expect(timestamps).toHaveLength(2);

    // Call 2 visibly waited for Call 1 to complete signing before starting its own signing
    expect(timestamps[1].start).toBeGreaterThanOrEqual(timestamps[0].end - 10);

    // Call 2 experienced contention and therefore cleared the cached access key / nonce
    expect(mockNear.clearAccessKeyCache).toHaveBeenCalledWith(subaccountId);
  });

  it('fails with specific already-in-progress message if lock cannot be acquired within retry budget', async () => {
    const testRedis = createTestRedis();
    // Simulate persistent lock held by another process
    await testRedis.setNxPx(`lock:swap:${subaccountId}`, 'other-process-token', 100_000);

    // Mock setNxPx to always fail immediately to avoid 2.5s real time wait
    testRedis.setNxPx = vi.fn().mockResolvedValue(false);

    const mockNear = {
      getAccount: vi.fn().mockResolvedValue({}),
      getTokenBalance: vi.fn().mockResolvedValue('10000000000000000000000000'),
      findRheaPoolId: vi.fn().mockResolvedValue(123),
      signAndSendTransactionAll: vi.fn(),
    } as unknown as MultiRpcNear;

    const executor = new SwapExecutor(testRedis, mockNear);

    const swapEvent: SwapEvent = {
      type: 'execute_swap',
      user_id: userId,
      token_in: 'wrap.near',
      token_out: 'token.near',
      amount_in: '1000000000000000000000000',
      min_amount_out: '1000000',
      venue: 'ref',
      pool_id: 123,
      timestamp: Date.now(),
    };

    await expect(executor.execute(swapEvent)).rejects.toThrow(
      'Another transaction is already in progress for this wallet — please wait a moment and try again'
    );

    // Should never have called signAndSendTransactionAll
    expect(mockNear.signAndSendTransactionAll).not.toHaveBeenCalled();
  });

  it('releases the lock when signing throws an error so subsequent swaps are not permanently locked', async () => {
    const testRedis = createTestRedis();

    let shouldFail = true;
    let bal3 = 10000000000000000000000000n;
    const mockNear = {
      getAccount: vi.fn().mockResolvedValue({
        functionCall: vi.fn().mockResolvedValue({}),
        sendMoney: vi.fn().mockResolvedValue({}),
      }),
      getTokenBalance: vi.fn().mockImplementation(async () => {
        const current = bal3;
        bal3 += 1000000000000000000000n;
        return current.toString();
      }),
      ensureStorageDeposit: vi.fn().mockResolvedValue(undefined),
      findRheaPoolId: vi.fn().mockResolvedValue(123),
      clearAccessKeyCache: vi.fn(),
      signAndSendTransactionAll: vi.fn().mockImplementation(async () => {
        if (shouldFail) {
          throw new Error('RPC Broadcast Timeout');
        }
        return {
          transaction: { hash: 'tx-success-after-failure' },
          receipts_outcome: [
            {
              outcome: {
                logs: [
                  `EVENT_JSON:${JSON.stringify({
                    standard: 'nep141',
                    version: '1.0.0',
                    event: 'ft_transfer',
                    data: [{ receiver_id: subaccountId, amount: '1000000' }],
                  })}`,
                ],
              },
            },
          ],
          status: { SuccessValue: '' },
        };
      }),
    } as unknown as MultiRpcNear;

    const executor = new SwapExecutor(testRedis, mockNear);

    const swapEvent: SwapEvent = {
      type: 'execute_swap',
      user_id: userId,
      token_in: 'wrap.near',
      token_out: 'token.near',
      amount_in: '1000000000000000000000000',
      min_amount_out: '1000000',
      venue: 'ref',
      pool_id: 123,
      timestamp: Date.now(),
    };

    // First call fails
    await expect(executor.execute(swapEvent)).rejects.toThrow('RPC Broadcast Timeout');

    // Assert lock was released
    const lockVal = await testRedis.get(`lock:swap:${subaccountId}`);
    expect(lockVal).toBeNull();

    // Second call should succeed immediately without being blocked
    shouldFail = false;
    const res = await executor.execute(swapEvent);
    expect(res.success).toBe(true);
    expect(res.txHash).toBe('tx-success-after-failure');
  });
});

describe('RefRegistrationTracker (Fix 2 — per-account storage caching)', () => {
  it('tracks Ref storage confirmation per account, not process-wide', async () => {
    const { RefRegistrationTracker } = await import('./executor.js');
    const tracker = new RefRegistrationTracker();

    expect(tracker.isStorageConfirmed('alice.near')).toBe(false);
    tracker.confirmStorage('alice.near');
    expect(tracker.isStorageConfirmed('alice.near')).toBe(true);

    // The old code used one global boolean: after the first account checked
    // out, EVERY later user skipped registration and could be refunded by Ref.
    // A second account must still require its own check.
    expect(tracker.isStorageConfirmed('bob.near')).toBe(false);
  });

  it('confirms tokens independently of storage accounts', async () => {
    const { RefRegistrationTracker } = await import('./executor.js');
    const tracker = new RefRegistrationTracker();

    expect(tracker.isTokenConfirmed('token-a.near')).toBe(false);
    tracker.confirmToken('token-a.near');
    expect(tracker.isTokenConfirmed('token-a.near')).toBe(true);
    expect(tracker.isStorageConfirmed('token-a.near')).toBe(false);
  });
});
