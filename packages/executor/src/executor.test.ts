import { describe, it, expect, vi, beforeAll } from 'vitest';
import { KeyPair } from 'near-api-js';
import { encrypt, getNear, type SwapEvent, type RedisClient, type MultiRpcNear } from '@racerbot/shared';

process.env.KEY_ENCRYPTION_MASTER_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.MAIN_WALLET_PRIVATE_KEY =
  'ed25519:REDACTED_MOCK_KEY_4GxWXcLUqaDoT7mz4qAiCgXiBPaMcr6UmEcVkQ8wq';
process.env.RACERBOT_PARENT_ACCOUNT = 'racerbot.near';
process.env.ROUTER_CONTRACT_ID = 'router.near';
process.env.TREASURY_ACCOUNT_ID = 'treasury.near';

vi.mock('@racerbot/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@racerbot/shared')>();
  return {
    ...actual,
    checkTokenSafety: vi.fn().mockResolvedValue({ isHoneypot: false, reasons: [], dangerousMethods: [] }),
  };
});

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
  awardPointsForTradeFill: vi.fn().mockResolvedValue(undefined),
  getActiveWallet: vi.fn().mockResolvedValue(null),
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
    // Post-trade verification now reads on the pinned trade RPC — mirror the
    // same incrementing-balance behavior for that method.
    vi.spyOn(realNear, 'getTokenBalanceOnTradeRpc').mockImplementation(async () => {
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

describe('buildWrapNearBuyActions deposit buffering', () => {
  const sub = 'alice.racerbot.near';
  const ONE = 10n ** 24n;
  const amount = 25n * ONE;
  const fee = (amount * 150n) / 10000n;
  const swap = amount - fee;
  const BUFFER = 10n ** 22n; // 0.01 NEAR

  const mockNearWithBalance = (bal: bigint) =>
    ({ getTokenBalance: vi.fn().mockResolvedValue(bal.toString()) }) as unknown as MultiRpcNear;

  const depositOf = (actions: any[]) => BigInt(actions[0].functionCall.deposit.toString());

  it('deposits the FULL spend when a stale balance read reports dust (mainnet tx 2zciEK9b…)', async () => {
    // The pre-trade read claimed 0.00125 wNEAR, so the old code topped up to
    // exact equality — the real (lower) balance left ft_transfer_call short
    // and the whole tx panicked. The clamped buffer must make the deposit
    // alone cover fee + swap.
    const executor = new SwapExecutor(createTestRedis(), mockNearWithBalance(ONE / 800n));
    const actions = await (executor as any).buildWrapNearBuyActions(sub, amount, fee, swap, 'dclv2.ref-labs.near', '{}');
    expect(actions[0].functionCall.methodName).toBe('near_deposit');
    expect(depositOf(actions)).toBe(amount);
  });

  it('skips near_deposit when the balance covers spend plus buffer', async () => {
    const executor = new SwapExecutor(createTestRedis(), mockNearWithBalance(amount + ONE));
    const actions = await (executor as any).buildWrapNearBuyActions(sub, amount, fee, swap, 'dclv2.ref-labs.near', '{}');
    expect(actions).toHaveLength(2);
    expect(actions[0].functionCall.methodName).toBe('ft_transfer');
  });

  it('adds headroom on partial balances without exceeding the authorized amount', async () => {
    const bal = amount - 5n * ONE; // 5 NEAR short
    const executor = new SwapExecutor(createTestRedis(), mockNearWithBalance(bal));
    const actions = await (executor as any).buildWrapNearBuyActions(sub, amount, fee, swap, 'dclv2.ref-labs.near', '{}');
    const dep = depositOf(actions);
    expect(dep).toBe(5n * ONE + BUFFER); // shortfall + buffer
    expect(dep).toBeLessThanOrEqual(amount);
  });

  it('caps near_deposit at maxNativeDeposit when activeTradeWNearState is set for combined NEAR + USDC buys', async () => {
    const executor = new SwapExecutor(createTestRedis(), mockNearWithBalance(0n));
    const twoNear = 2n * ONE;
    const threeNearFromUsdc = 3n * ONE;
    const fiveNearBuy = 5n * ONE;
    const fiveNearFee = (fiveNearBuy * 150n) / 10000n;
    const fiveNearSwap = fiveNearBuy - fiveNearFee;

    (executor as any).activeTradeWNearState.set(sub, {
      wNearBal: threeNearFromUsdc,
      maxNativeDeposit: twoNear,
    });
    const actions = await (executor as any).buildWrapNearBuyActions(
      sub,
      fiveNearBuy,
      fiveNearFee,
      fiveNearSwap,
      'v2.ref-finance.near',
      '{}'
    );
    expect(actions).toHaveLength(3);
    expect(actions[0].functionCall.methodName).toBe('near_deposit');
    expect(depositOf(actions)).toBe(twoNear);
    expect(actions[1].functionCall.methodName).toBe('ft_transfer');
    expect(actions[2].functionCall.methodName).toBe('ft_transfer_call');
  });

  it('executes a USDC-only buy by swapping USDC to wrap.near first and skipping near_deposit', async () => {
    const NEAR_USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
    const sentTxs: { receiverId: string; actions: any[] }[] = [];
    const fiveNear = 5n * ONE;
    let outTokenBal = 0n;
    let wNearDynamic = 0n;

    const mockNear = {
      getAccount: vi.fn().mockResolvedValue({
        functionCall: vi.fn().mockResolvedValue({}),
        sendMoney: vi.fn().mockResolvedValue({}),
      }),
      getNearBalance: vi.fn().mockResolvedValue((9n * 10n ** 22n).toString()), // 0.09 NEAR (gas only)
      getTokenBalance: vi.fn().mockImplementation(async (token: string) => {
        if (token === NEAR_USDC) return (50_000_000n).toString(); // 50 USDC
        if (token === 'wrap.near') return wNearDynamic.toString();
        const cur = outTokenBal;
        outTokenBal += 1000000000000000000000n;
        return cur.toString();
      }),
      getTokenBalanceOnTradeRpc: vi.fn().mockImplementation(async (token: string) => {
        if (token === 'wrap.near') return wNearDynamic.toString();
        const cur = outTokenBal;
        outTokenBal += 1000000000000000000000n;
        return cur.toString();
      }),
      view: vi.fn().mockImplementation(async (contractId: string, methodName: string) => {
        if (contractId === 'v2.ref-finance.near' && methodName === 'get_return') {
          return (fiveNear + 10n ** 22n).toString();
        }
        return { total: '1000' };
      }),
      ensureStorageDeposit: vi.fn().mockResolvedValue(undefined),
      findRheaPoolId: vi.fn().mockResolvedValue(123),
      clearAccessKeyCache: vi.fn(),
      computeMinAmountOut: vi.fn().mockResolvedValue({
        expectedOutput: '999999999999999999999999999999999',
        minAmountOut: '999999999999999999999999999999999',
      }),
      getTokenMetadata: vi.fn().mockResolvedValue({ symbol: 'TEST', name: 'Test Token', decimals: 18 }),
      signAndSendTransactionAll: vi.fn().mockImplementation(async (_sub: string, receiverId: string, actions: any[]) => {
        sentTxs.push({ receiverId, actions });
        if (receiverId === NEAR_USDC) {
          wNearDynamic = fiveNear + 10n ** 22n;
        }
        return {
          transaction: { hash: `tx-${sentTxs.length}` },
          receipts_outcome: [{ outcome: { status: { SuccessValue: '' }, logs: ['Swapped 100 wrap.near for 1000 token.near'] } }],
          status: { SuccessValue: '' },
        };
      }),
    } as unknown as MultiRpcNear;

    const executor = new SwapExecutor(createTestRedis(), mockNear);
    const res = await executor.execute({
      type: 'execute_swap',
      user_id: 'test-user-1',
      token_in: 'wrap.near',
      token_out: 'token.near',
      amount_in: fiveNear.toString(),
      min_amount_out: '1',
      venue: 'rhea',
      pool_id: 123,
    });

    expect(res.success).toBe(true);
    expect(res.usdcSpent).toBeDefined();
    expect(Number(res.usdcSpent)).toBeGreaterThan(0);
    // First tx swaps USDC -> wrap.near on Ref pool 4512
    const usdcTx = sentTxs.find((t) => t.receiverId === NEAR_USDC);
    expect(usdcTx).toBeDefined();
    // Second tx buys token.near using wrap.near WITHOUT near_deposit (since user only had 0.04 NEAR gas reserve)
    const wrapNearTx = sentTxs.find((t) => t.receiverId === 'wrap.near');
    expect(wrapNearTx).toBeDefined();
    const hasNearDeposit = wrapNearTx!.actions.some((a: any) => a.functionCall?.methodName === 'near_deposit');
    expect(hasNearDeposit).toBe(false);
  });

  it('executes a combined NEAR + USDC buy by swapping only the USDC shortfall and combining with native NEAR', async () => {
    const NEAR_USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
    const sentTxs: { receiverId: string; actions: any[] }[] = [];
    const fiveNear = 5n * ONE;
    const nativeBalYocto = 205n * 10n ** 22n; // 2.05 NEAR -> 2.00 NEAR spendable after 0.05 reserve
    const shortfallThreeNear = 3n * ONE;
    let outTokenBal = 0n;
    let wNearDynamic = 0n;

    const mockNear = {
      getAccount: vi.fn().mockResolvedValue({
        functionCall: vi.fn().mockResolvedValue({}),
        sendMoney: vi.fn().mockResolvedValue({}),
      }),
      getNearBalance: vi.fn().mockResolvedValue(nativeBalYocto.toString()),
      getTokenBalance: vi.fn().mockImplementation(async (token: string) => {
        if (token === NEAR_USDC) return (50_000_000n).toString(); // 50 USDC
        if (token === 'wrap.near') return wNearDynamic.toString();
        const cur = outTokenBal;
        outTokenBal += 1000000000000000000000n;
        return cur.toString();
      }),
      getTokenBalanceOnTradeRpc: vi.fn().mockImplementation(async (token: string) => {
        if (token === 'wrap.near') return wNearDynamic.toString();
        const cur = outTokenBal;
        outTokenBal += 1000000000000000000000n;
        return cur.toString();
      }),
      view: vi.fn().mockImplementation(async (contractId: string, methodName: string) => {
        if (contractId === 'v2.ref-finance.near' && methodName === 'get_return') {
          return (shortfallThreeNear + 10n ** 22n).toString();
        }
        return { total: '1000' };
      }),
      ensureStorageDeposit: vi.fn().mockResolvedValue(undefined),
      findRheaPoolId: vi.fn().mockResolvedValue(123),
      clearAccessKeyCache: vi.fn(),
      computeMinAmountOut: vi.fn().mockResolvedValue({
        expectedOutput: '999999999999999999999999999999999',
        minAmountOut: '999999999999999999999999999999999',
      }),
      getTokenMetadata: vi.fn().mockResolvedValue({ symbol: 'TEST', name: 'Test Token', decimals: 18 }),
      signAndSendTransactionAll: vi.fn().mockImplementation(async (_sub: string, receiverId: string, actions: any[]) => {
        sentTxs.push({ receiverId, actions });
        if (receiverId === NEAR_USDC) {
          wNearDynamic = shortfallThreeNear + 10n ** 22n;
        }
        return {
          transaction: { hash: `tx-${sentTxs.length}` },
          receipts_outcome: [{ outcome: { status: { SuccessValue: '' }, logs: ['Swapped 100 wrap.near for 1000 token.near'] } }],
          status: { SuccessValue: '' },
        };
      }),
    } as unknown as MultiRpcNear;

    const executor = new SwapExecutor(createTestRedis(), mockNear);
    const res = await executor.execute({
      type: 'execute_swap',
      user_id: 'test-user-1',
      token_in: 'wrap.near',
      token_out: 'token.near',
      amount_in: fiveNear.toString(),
      min_amount_out: '1',
      venue: 'rhea',
      pool_id: 123,
    });

    expect(res.success).toBe(true);
    expect(res.usdcSpent).toBeDefined();
    const usdcTx = sentTxs.find((t) => t.receiverId === NEAR_USDC);
    expect(usdcTx).toBeDefined();
    const wrapNearTx = sentTxs.find((t) => t.receiverId === 'wrap.near');
    expect(wrapNearTx).toBeDefined();
    // Combined buy must include near_deposit for the native NEAR portion (<= 2.00 NEAR) + ft_transfer + ft_transfer_call
    expect(wrapNearTx!.actions[0].functionCall?.methodName).toBe('near_deposit');
    const depositedNative = BigInt(wrapNearTx!.actions[0].functionCall.deposit.toString());
    expect(depositedNative).toBeGreaterThan(0n);
    expect(depositedNative).toBeLessThanOrEqual(2n * ONE);
    expect(wrapNearTx!.actions[1].functionCall?.methodName).toBe('ft_transfer');
    expect(wrapNearTx!.actions[2].functionCall?.methodName).toBe('ft_transfer_call');
  });

  it('aborts immediately before Step 2 if the USDC -> wrap.near leg refunds on-chain', async () => {
    const NEAR_USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
    const sentTxs: { receiverId: string; actions: any[] }[] = [];
    const twoNear = 2n * ONE;
    const minGasOnlyYocto = 90n * 10n ** 21n; // 0.09 NEAR

    const mockNear = {
      getAccount: vi.fn().mockResolvedValue({
        functionCall: vi.fn().mockResolvedValue({}),
        sendMoney: vi.fn().mockResolvedValue({}),
      }),
      getNearBalance: vi.fn().mockResolvedValue(minGasOnlyYocto.toString()),
      getTokenBalance: vi.fn().mockImplementation(async (token: string) => {
        if (token === NEAR_USDC) return (50_000_000n).toString();
        return '0';
      }),
      getTokenBalanceOnTradeRpc: vi.fn().mockResolvedValue('0'),
      view: vi.fn().mockResolvedValue({ total: '1000' }),
      ensureStorageDeposit: vi.fn().mockResolvedValue(undefined),
      findRheaPoolId: vi.fn().mockResolvedValue(123),
      clearAccessKeyCache: vi.fn(),
      computeMinAmountOut: vi.fn().mockResolvedValue({ expectedOutput: '1000', minAmountOut: '900' }),
      getTokenMetadata: vi.fn().mockResolvedValue({ symbol: 'TEST', name: 'Test Token', decimals: 18 }),
      signAndSendTransactionAll: vi.fn().mockImplementation(async (_sub: string, receiverId: string, actions: any[]) => {
        sentTxs.push({ receiverId, actions });
        return {
          transaction: { hash: `tx-${sentTxs.length}` },
          receipts_outcome: [
            {
              outcome: {
                status: { SuccessValue: Buffer.from('"0"').toString('base64') },
                logs: ['Refund 11000000 from v2.ref-finance.near to testuser.racerbot.near'],
              },
            },
          ],
          status: { SuccessValue: Buffer.from('"0"').toString('base64') },
        };
      }),
    } as unknown as MultiRpcNear;

    const executor = new SwapExecutor(createTestRedis(), mockNear);
    await expect(
      executor.execute({
        type: 'execute_swap',
        user_id: 'test-user-1',
        token_in: 'wrap.near',
        token_out: 'token.near',
        amount_in: twoNear.toString(),
        min_amount_out: '1',
        venue: 'rhea',
        pool_id: 123,
      })
    ).rejects.toThrow(/USDC -> NEAR conversion failed/);

    expect(sentTxs.some((t) => t.receiverId === 'wrap.near')).toBe(false);
  });

  it('clamps near_deposit in combined NEAR + USDC buys when storage deposits reduce native NEAR balance', async () => {
    const NEAR_USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
    const sentTxs: { receiverId: string; actions: any[] }[] = [];
    const fiveNear = 5n * ONE;
    const initialNativeYocto = 205n * 10n ** 22n; // 2.05 NEAR -> 2.00 NEAR spendable initially
    const postStorageNativeYocto = 202n * 10n ** 22n; // 2.02 NEAR -> 1.985 NEAR max after 0.035 gas reserve
    const shortfallThreeNear = 3n * ONE;
    let nearBalCallCount = 0;
    let outTokenBal = 0n;
    let wNearDynamic = 0n;

    const mockNear = {
      getAccount: vi.fn().mockResolvedValue({
        functionCall: vi.fn().mockResolvedValue({}),
        sendMoney: vi.fn().mockResolvedValue({}),
      }),
      getNearBalance: vi.fn().mockImplementation(async () => {
        nearBalCallCount++;
        return (nearBalCallCount === 1 ? initialNativeYocto : postStorageNativeYocto).toString();
      }),
      getTokenBalance: vi.fn().mockImplementation(async (token: string) => {
        if (token === NEAR_USDC) return (50_000_000n).toString();
        if (token === 'wrap.near') return wNearDynamic.toString();
        const cur = outTokenBal;
        outTokenBal += 1000000000000000000000n;
        return cur.toString();
      }),
      getTokenBalanceOnTradeRpc: vi.fn().mockImplementation(async (token: string) => {
        if (token === 'wrap.near') return wNearDynamic.toString();
        const cur = outTokenBal;
        outTokenBal += 1000000000000000000000n;
        return cur.toString();
      }),
      view: vi.fn().mockImplementation(async (contractId: string, methodName: string) => {
        if (contractId === 'v2.ref-finance.near' && methodName === 'get_return') {
          return (shortfallThreeNear + 5n * 10n ** 22n).toString();
        }
        return { total: '1000' };
      }),
      ensureStorageDeposit: vi.fn().mockResolvedValue(undefined),
      findRheaPoolId: vi.fn().mockResolvedValue(123),
      clearAccessKeyCache: vi.fn(),
      computeMinAmountOut: vi.fn().mockResolvedValue({
        expectedOutput: '999999999999999999999999999999999',
        minAmountOut: '999999999999999999999999999999999',
      }),
      getTokenMetadata: vi.fn().mockResolvedValue({ symbol: 'TEST', name: 'Test Token', decimals: 18 }),
      signAndSendTransactionAll: vi.fn().mockImplementation(async (_sub: string, receiverId: string, actions: any[]) => {
        sentTxs.push({ receiverId, actions });
        if (receiverId === NEAR_USDC) {
          wNearDynamic = shortfallThreeNear + 5n * 10n ** 22n;
        }
        return {
          transaction: { hash: `tx-${sentTxs.length}` },
          receipts_outcome: [{ outcome: { status: { SuccessValue: '' }, logs: ['Swapped 100 wrap.near for 1000 token.near'] } }],
          status: { SuccessValue: '' },
        };
      }),
    } as unknown as MultiRpcNear;

    const executor = new SwapExecutor(createTestRedis(), mockNear);
    const res = await executor.execute({
      type: 'execute_swap',
      user_id: 'test-user-1',
      token_in: 'wrap.near',
      token_out: 'token.near',
      amount_in: fiveNear.toString(),
      min_amount_out: '1',
      venue: 'rhea',
      pool_id: 123,
    });

    expect(res.success).toBe(true);
    const wrapNearTx = sentTxs.find((t) => t.receiverId === 'wrap.near');
    expect(wrapNearTx).toBeDefined();
    const depositedNative = BigInt(wrapNearTx!.actions[0].functionCall.deposit.toString());
    const expectedClampedMax = postStorageNativeYocto - 35n * 10n ** 21n; // 1.985 NEAR
    expect(depositedNative).toBeLessThanOrEqual(expectedClampedMax);
  });

  it('in USDC-Only mode (trade_currency: usdc), buys strictly with USDC without wrapping native NEAR and converts sell proceeds into USDC', async () => {
    const NEAR_USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
    const twoNear = 2n * 10n ** 24n;
    const sentTxs: Array<{ receiverId: string; actions: any[] }> = [];
    let wNearDynamic = 0n;
    let outTokenBal = 10000000000000000000000n;
    let usdcDynamic = 50_000_000n; // 50 USDC

    const mockNear = {
      getAccount: vi.fn().mockResolvedValue({
        functionCall: vi.fn().mockResolvedValue({}),
        sendMoney: vi.fn().mockResolvedValue({}),
      }),
      getNearBalance: vi.fn().mockResolvedValue((10n * 10n ** 24n).toString()), // 10 NEAR native available
      getTokenBalance: vi.fn().mockImplementation(async (token: string) => {
        if (token === NEAR_USDC) return usdcDynamic.toString();
        if (token === 'wrap.near') return wNearDynamic.toString();
        return outTokenBal.toString();
      }),
      getTokenBalanceOnTradeRpc: vi.fn().mockImplementation(async (token: string) => {
        if (token === NEAR_USDC) return usdcDynamic.toString();
        if (token === 'wrap.near') return wNearDynamic.toString();
        const cur = outTokenBal;
        outTokenBal += 5000000000000000000000n;
        return cur.toString();
      }),
      view: vi.fn().mockImplementation(async (contractId: string, methodName: string, args: any) => {
        if (contractId === 'v2.ref-finance.near' && methodName === 'get_return') {
          if (args?.token_in === NEAR_USDC) return (twoNear + 5n * 10n ** 22n).toString();
          if (args?.token_in === 'wrap.near') return '9800000'; // 9.80 USDC
        }
        return { total: '1000' };
      }),
      ensureStorageDeposit: vi.fn().mockResolvedValue(undefined),
      findRheaPoolId: vi.fn().mockResolvedValue(123),
      clearAccessKeyCache: vi.fn(),
      computeMinAmountOut: vi.fn().mockResolvedValue({
        expectedOutput: '999999999999999999999999999999999',
        minAmountOut: '999999999999999999999999999999999',
      }),
      getTokenMetadata: vi.fn().mockResolvedValue({ symbol: 'TEST', name: 'Test Token', decimals: 18 }),
      signAndSendTransactionAll: vi.fn().mockImplementation(async (_sub: string, receiverId: string, actions: any[]) => {
        sentTxs.push({ receiverId, actions });
        if (receiverId === NEAR_USDC) {
          wNearDynamic = twoNear + 5n * 10n ** 22n;
        }
        if (receiverId === 'token.near') {
          wNearDynamic = twoNear; // Received 2 wrap.near from selling token.near
        }
        if (receiverId === 'wrap.near' && actions.some((a) => a.functionCall?.methodName === 'ft_transfer_call' && a.functionCall?.args)) {
          usdcDynamic += 9_850_000n; // +9.85 USDC
        }
        return {
          transaction: { hash: `tx-${sentTxs.length}` },
          receipts_outcome: [{ outcome: { status: { SuccessValue: '' }, logs: ['Swapped 2000000000000000000000000 token.near for 2000000000000000000000000 wrap.near'] } }],
          status: { SuccessValue: '' },
        };
      }),
    } as unknown as MultiRpcNear;

    const executor = new SwapExecutor(createTestRedis(), mockNear);

    // 1. BUY in USDC-Only mode: should swap USDC -> wrap.near and NOT call near_deposit on wrap.near
    const buyRes = await executor.execute({
      type: 'execute_swap',
      user_id: 'test-user-1',
      token_in: 'wrap.near',
      token_out: 'token.near',
      amount_in: twoNear.toString(),
      min_amount_out: '1',
      venue: 'rhea',
      pool_id: 123,
      trade_currency: 'usdc',
    });
    expect(buyRes.success).toBe(true);
    const buyWrapTx = sentTxs.find((t) => t.receiverId === 'wrap.near');
    expect(buyWrapTx).toBeDefined();
    expect(buyWrapTx!.actions.some((a) => a.functionCall?.methodName === 'near_deposit')).toBe(false);

    // 2. SELL in USDC-Only mode: should sell token -> wrap.near, then atomically pay fee + swap remaining wrap.near -> USDC
    sentTxs.length = 0;
    wNearDynamic = 0n;
    const sellRes = await executor.execute({
      type: 'execute_swap',
      user_id: 'test-user-1',
      token_in: 'token.near',
      token_out: 'wrap.near',
      amount_in: '5000000000000000000000',
      min_amount_out: '1',
      venue: 'rhea',
      pool_id: 123,
      trade_currency: 'usdc',
    });
    expect(sellRes.success).toBe(true);
    expect(sellRes.usdcReceived).toBeCloseTo(9.85, 2);
  });
});
