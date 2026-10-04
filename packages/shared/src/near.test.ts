import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MultiRpcNear } from './near.js';
import { calculateMinAmountOut } from './utils.js';

describe('near: storage-deposit cache', () => {
  it('calls storage_balance_of once and serves second call from registeredCache', async () => {
    const near = new MultiRpcNear(['https://rpc.mainnet.fastnear.com']);
    const accountId = `user-${Date.now()}.racerbot.near`;
    const tokenAddress = `token-${Date.now()}.near`;

    // Mock only the network view call
    const viewSpy = vi.spyOn(near, 'view').mockImplementation(async (contractId, method, _args) => {
      if (contractId === tokenAddress && method === 'storage_balance_of') {
        return { total: '12500000000000000000000', available: '12500000000000000000000' };
      }
      return null;
    });

    // First call: should query RPC and cache the registration
    await near.ensureStorageDeposit(accountId, tokenAddress);
    expect(viewSpy).toHaveBeenCalledTimes(1);
    expect(viewSpy).toHaveBeenCalledWith(tokenAddress, 'storage_balance_of', {
      account_id: accountId,
    });

    // Second call: should hit registeredCache and avoid RPC call
    await near.ensureStorageDeposit(accountId, tokenAddress);
    expect(viewSpy).toHaveBeenCalledTimes(1);

    viewSpy.mockRestore();
  });
});

describe('near: nearlytrade bonding-curve quotes', () => {
  const token = `curve-${Date.now()}.nearlytrade.near`;
  const poolId = `${token}|wrap.near|10000`;
  const quoteAmount = '98765432100000000000000';

  function mockNearlytradeViews(near: MultiRpcNear, quoteResult: any) {
    return vi.spyOn(near, 'view').mockImplementation(async (contractId: string, method: string) => {
      if (contractId === 'nearlytrade.near' && method === 'get_launch_by_token') {
        return {
          pool_id: poolId,
          left_point: 200,
          right_point: 500000,
          step: 'Running',
          token_is_x: true,
          total_supply: '1000000000000000000000000000',
        };
      }
      if (contractId === token && method === 'ft_metadata') {
        return { name: 'Curve Token', symbol: 'CURVE', decimals: 18 };
      }
      if (contractId === token && method === 'ft_total_supply') {
        return '1000000000000000000000000000';
      }
      if (contractId === 'dclv2.ref-labs.near' && method === 'get_pool') {
        return {
          state: 'Running',
          current_point: 1000,
          total_x: '500000000000000000000000000000',
          total_y: '25000000000000000000000000',
        };
      }
      if (contractId === 'dclv2.ref-labs.near' && method === 'quote') {
        return quoteResult;
      }
      return null;
    });
  }

  it('uses the DCL quote view (not xyk reserve math) for bonding-curve output', async () => {
    const near = new MultiRpcNear(['https://rpc.mainnet.fastnear.com']);
    const viewSpy = mockNearlytradeViews(near, { amount: quoteAmount });

    const amountIn = '1000000000000000000000000'; // 1 NEAR
    const result = await near.computeMinAmountOut('nearlytrade', 'wrap.near', token, amountIn, 2);

    expect(viewSpy).toHaveBeenCalledWith('dclv2.ref-labs.near', 'quote', {
      pool_ids: [poolId],
      input_token: 'wrap.near',
      output_token: token,
      input_amount: amountIn,
    });
    expect(result.expectedOutput).toBe(quoteAmount);
    expect(result.minAmountOut).toBe(calculateMinAmountOut(quoteAmount, 2));
    viewSpy.mockRestore();
  });

  it('falls back to reserve math only when the DCL quote view is unavailable', async () => {
    const near = new MultiRpcNear(['https://rpc.mainnet.fastnear.com']);
    const viewSpy = mockNearlytradeViews(near, { amount: '0' }); // quote returns nothing

    const amountIn = '1000000000000000000000000';
    const result = await near.computeMinAmountOut('nearlytrade', 'wrap.near', token, amountIn, 2);

    // xyk on total reserves: (1e24 * 5e29) / (2.5e25 + 1e24) ≈ 1.923e28 — nowhere near the quote amount
    expect(result.expectedOutput).not.toBe(quoteAmount);
    expect(BigInt(result.expectedOutput)).toBeGreaterThan(0n);
    viewSpy.mockRestore();
  });
});


describe('near: RPC duty split (FastNEAR main / QuickNode fallback)', () => {
  const FN = 'https://rpc.mainnet.fastnear.com';
  const QN = 'https://falling-frosty-uranium.near-mainnet.quiknode.pro/abc123/';
  const originalQn = process.env.QUICKNODE_ENDPOINT_URL;

  beforeEach(() => {
    delete process.env.QUICKNODE_ENDPOINT_URL;
  });

  afterEach(() => {
    if (originalQn) {
      process.env.QUICKNODE_ENDPOINT_URL = originalQn;
    } else {
      delete process.env.QUICKNODE_ENDPOINT_URL;
    }
  });

  it('orders read providers FastNEAR-first and trade providers FastNEAR-first', () => {
    const near = new MultiRpcNear([QN, FN]) as any;
    expect(near.readProviders[0].url).toBe(FN);
    expect(near.readProviders[0].isQuickNode).toBe(false);
    expect(near.readProviders[1].url).toBe(QN);
    expect(near.readProviders[1].isQuickNode).toBe(true);
    expect(near.tradeProviders[0].url).toBe(FN);
    expect(near.tradeProviders[1].url).toBe(QN);
  });

  // The view layer issues raw fetch() JSON-RPC calls (so the AbortSignal can
  // actually cancel HTTP). Mock fetch and return call_function-shaped bodies.
  function rpcResponse(value: any): Response {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        jsonrpc: '2.0',
        id: 1,
        result: { result: Array.from(Buffer.from(JSON.stringify(value))), logs: [] },
      }),
      text: async () => '',
    } as unknown as Response;
  }

  it('view() uses FastNEAR and never touches QuickNode when FastNEAR responds', async () => {
    const near = new MultiRpcNear([FN, QN]) as any;
    const attempted: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      attempted.push(url);
      return rpcResponse({ ok: true });
    }));

    const result = await near.view('token.near', 'ft_metadata', {});
    expect(result).toEqual({ ok: true });
    expect(attempted).toEqual([FN]); // single read provider, QuickNode untouched

    vi.unstubAllGlobals();
  });

  it('view() hedges to QuickNode when FastNEAR errors during the call', async () => {
    const near = new MultiRpcNear([FN, QN]) as any;
    const attempted: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      attempted.push(url);
      if (url === FN) {
        // FastNEAR network-level failure -> hedge fires immediately
        throw new Error('fetch failed: ETIMEDOUT');
      }
      return rpcResponse({ ok: true, source: 'quicknode' });
    }));

    const result = await near.view('token.near', 'ft_metadata', {});
    expect(result).toEqual({ ok: true, source: 'quicknode' });
    expect(attempted).toEqual([FN, QN]);

    vi.unstubAllGlobals();
  });
});

describe('near: view request coalescing', () => {
  it('serves concurrent identical view calls from a single in-flight request', async () => {
    const near = new MultiRpcNear(['https://rpc.mainnet.fastnear.com']) as any;
    let calls = 0;
    near.viewOnce = vi.fn(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20)); // simulate RPC latency
      return { value: 42 };
    });

    const [a, b, c] = await Promise.all([
      near.view('token.near', 'ft_metadata', {}),
      near.view('token.near', 'ft_metadata', {}),
      near.view('token.near', 'ft_metadata', {}),
    ]);
    expect(a.value).toBe(42);
    expect(b.value).toBe(42);
    expect(c.value).toBe(42);
    expect(calls).toBe(1); // one RPC for three concurrent callers

    // After settle, a new call issues a fresh request
    await near.view('token.near', 'ft_metadata', {});
    expect(calls).toBe(2);
  });

  it('does not coalesce different args', async () => {
    const near = new MultiRpcNear(['https://rpc.mainnet.fastnear.com']) as any;
    let calls = 0;
    near.viewOnce = vi.fn(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return calls;
    });
    await Promise.all([
      near.view('token.near', 'ft_balance_of', { account_id: 'a.near' }),
      near.view('token.near', 'ft_balance_of', { account_id: 'b.near' }),
    ]);
    expect(calls).toBe(2);
  });
});

describe('near: viewCached display-path cache', () => {
  it('serves repeat calls within TTL and refetches after expiry', async () => {
    const near = new MultiRpcNear(['https://rpc.mainnet.fastnear.com']) as any;
    let calls = 0;
    near.view = vi.fn(async () => {
      calls++;
      return { price: calls };
    });

    const first = await near.viewCached('ref-finance.near', 'ft_price', {}, 30);
    const second = await near.viewCached('ref-finance.near', 'ft_price', {}, 30);
    expect(first).toEqual(second);
    expect(calls).toBe(1);

    await new Promise((r) => setTimeout(r, 45)); // outlive the 30ms TTL
    const third = await near.viewCached('ref-finance.near', 'ft_price', {}, 30);
    expect(third.price).toBe(2);
    expect(calls).toBe(2);
  });
});

describe('near: nearlytrade static launch cache', () => {
  it('fetches launch/metadata/supply once across repeated state calls', async () => {    const token = `cached-${Date.now()}.nearlytrade.near`;
    const poolId = `${token}|wrap.near|10000`;
    const near = new MultiRpcNear(['https://rpc.mainnet.fastnear.com']);
    const counts: Record<string, number> = {};
    const viewSpy = vi.spyOn(near, 'view').mockImplementation(async (contractId: string, method: string) => {
      const k = `${contractId}:${method}`;
      counts[k] = (counts[k] || 0) + 1;
      if (contractId === 'nearlytrade.near' && method === 'get_launch_by_token') {
        return { pool_id: poolId, left_point: 200, right_point: 500000, step: 'Running', token_is_x: true, total_supply: '1' };
      }
      if (method === 'ft_metadata') return { name: 'T', symbol: 'T', decimals: 18 };
      if (method === 'ft_total_supply') return '1000';
      if (contractId === 'dclv2.ref-labs.near' && method === 'get_pool') {
        return { state: 'Running', current_point: 1000, total_x: '5e27'.replace('e', ''), total_y: '25000000000000000000000000' };
      }
      return null;
    });

    await near.getNearlytradeTokenState(token);
    await near.getNearlytradeTokenState(token);

    // Static trio fetched exactly once; pool view stays fresh (twice)
    expect(counts['nearlytrade.near:get_launch_by_token']).toBe(1);
    expect(counts[`${token}:ft_metadata`]).toBe(1);
    expect(counts[`${token}:ft_total_supply`]).toBe(1);
    expect(counts['dclv2.ref-labs.near:get_pool']).toBe(2);
    viewSpy.mockRestore();
  });
});

describe('near: single pinned trade RPC (no fallback)', () => {
  const FN = 'https://rpc.mainnet.fastnear.com';
  const QN = 'https://falling-frosty-uranium.near-mainnet.quiknode.pro/abc123/';

  it('pins the write path to tradeProviders[0] (FastNEAR when configured)', () => {
    const near = new MultiRpcNear([FN, QN]) as any;
    expect(near.tradeProvider.url).toBe(FN);

    const qnOnly = new MultiRpcNear([QN]) as any;
    expect(qnOnly.tradeProvider.url).toBe(QN);
  });

  it('never blocks trades while a provider is configured — regardless of health flags', () => {
    const near = new MultiRpcNear([FN]) as any;
    expect(() => near.checkTradeProviders()).not.toThrow();

    // Even fully unhealthy / circuit-open, the gate must NOT throw: with a
    // single-RPC write path, health flags are informational only.
    for (const p of near.tradeProviders) {
      p.healthy = false;
      p.errorCount = 99;
      p.circuitBreakerOpen = true;
      p.circuitBreakerUntil = Date.now() + 60_000;
    }
    expect(() => near.checkTradeProviders()).not.toThrow();
  });

  it('throws only when no trade provider is configured at all', () => {
    const near = new MultiRpcNear([FN]) as any;
    near.tradeProviders = [];
    expect(() => near.checkTradeProviders()).toThrow(/configured/i);
  });

  it('startHealthChecks is idempotent (guard against double-start)', () => {
    const near = new MultiRpcNear([FN]) as any;
    const t1 = near.startHealthChecks(30_000);
    const t2 = near.startHealthChecks(30_000);
    expect(t2).toBe(t1);
    clearInterval(t1);
  });
});

describe('near: sign-path nonce/block hedged across trade providers', () => {
  const FN = 'https://rpc.mainnet.fastnear.com';
  const QN = 'https://falling-frosty-uranium.near-mainnet.quiknode.pro/abc123/';

  function queryResult(value: any): Response {
    return {
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: value }),
      text: async () => '',
    } as unknown as Response;
  }

  it('nonce read races all trade providers and takes the MAX nonce', async () => {
    const near = new MultiRpcNear([QN, FN]) as any;
    const attempted: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      attempted.push(url);
      return queryResult({ nonce: url === QN ? 100 : 97 });
    }));

    const ak = await near.queryAccessKeyHedged('a.near', 'ed25519:xyz');
    expect(ak.nonce).toBe(100); // max wins — a stale lower nonce would collide
    expect(attempted).toContain(QN);
    expect(attempted).toContain(FN);
    vi.unstubAllGlobals();
  });

  it('nonce read falls back when the pinned provider errors', async () => {
    const near = new MultiRpcNear([QN, FN]) as any;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === QN) throw new Error('fetch failed: ETIMEDOUT');
      return queryResult({ nonce: 42 });
    }));

    const ak = await near.queryAccessKeyHedged('a.near', 'ed25519:xyz');
    expect(ak.nonce).toBe(42);
    vi.unstubAllGlobals();
  });

  it('block hash hedge returns a healthy provider answer when pinned is down', async () => {
    const near = new MultiRpcNear([QN, FN]) as any;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === QN) throw new Error('down');
      return queryResult({ header: { hash: 'HASH_FROM_FN' } });
    }));

    const hash = await near.fetchBlockHashHedged();
    expect(hash).toBe('HASH_FROM_FN');
    vi.unstubAllGlobals();
  });

  it('throws only when every trade provider fails', async () => {
    const near = new MultiRpcNear([QN, FN]) as any;
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));

    await expect(near.queryAccessKeyHedged('a.near', 'ed25519:xyz')).rejects.toThrow(/all trade RPC/);
    await expect(near.fetchBlockHashHedged()).rejects.toThrow(/all trade RPC/);
    vi.unstubAllGlobals();
  });
});

describe('near: awaitOutcome neverSeen classification (mempool blackhole detection)', () => {
  const FN = 'https://rpc.mainnet.fastnear.com';

  const unknownTxResponse = () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      jsonrpc: '2.0',
      id: 'await-outcome',
      error: {
        name: 'HANDLER_ERROR',
        cause: { info: {}, name: 'UNKNOWN_TRANSACTION' },
        code: -32000,
        message: 'Server error',
        data: "Transaction abc doesn't exist",
      },
    }),
  }) as unknown as Response;

  it('flags neverSeen when the node never knew the tx (safe to retry)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => unknownTxResponse()));
    const near = new MultiRpcNear([FN]) as any;
    const state = { everSeen: false };
    const err = await near.awaitOutcome('abc', 'alice.near', 1_500, state).catch((e: any) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.neverSeen).toBe(true);
    expect(err.message).toMatch(/never reached the NEAR network/);
    expect(state.everSeen).toBe(false);
    vi.unstubAllGlobals();
  }, 15_000);

  it('does NOT flag neverSeen once the node reports the tx (slow confirmation)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        jsonrpc: '2.0',
        id: 'await-outcome',
        result: {
          final_execution_status: 'FINAL',
          status: { SuccessValue: '' },
          receipts_outcome: [{ outcome: { status: { SuccessValue: '' }, logs: [] } }],
        },
      }),
    }) as unknown as Response));
    const near = new MultiRpcNear([FN]) as any;
    const state = { everSeen: false };
    const outcome = await near.awaitOutcome('abc', 'alice.near', 3_000, state);
    expect(outcome.final_execution_status).toBe('FINAL');
    expect(state.everSeen).toBe(true);
    vi.unstubAllGlobals();
  }, 15_000);

  it('keeps polling while the receipt tree is still executing (fes=INCLUDED), returns when FINAL', async () => {
    // A 2.4s "confirm" with a partial receipt tree made a successful DCL sell
    // look like a refund (production tx BGMBn3YV…). The poller must wait for
    // full execution even when receipts_outcome is already non-empty.
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++;
      const final = calls >= 3;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          jsonrpc: '2.0',
          id: 'await-outcome',
          result: {
            final_execution_status: final ? 'FINAL' : 'INCLUDED',
            status: { SuccessValue: '' },
            receipts_outcome: [{ outcome: { status: { SuccessValue: '' }, logs: [] } }],
          },
        }),
      } as unknown as Response;
    }));
    const near = new MultiRpcNear([FN]) as any;
    const outcome = await near.awaitOutcome('abc', 'alice.near', 5_000, { everSeen: false });
    expect(outcome.final_execution_status).toBe('FINAL');
    expect(calls).toBeGreaterThanOrEqual(3);
    vi.unstubAllGlobals();
  }, 15_000);

  it('times out as slow-confirmation (not neverSeen) when stuck at INCLUDED', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        jsonrpc: '2.0',
        id: 'await-outcome',
        result: {
          final_execution_status: 'INCLUDED',
          status: { SuccessValue: '' },
          receipts_outcome: [{ outcome: { status: { SuccessValue: '' }, logs: [] } }],
        },
      }),
    }) as unknown as Response));
    const near = new MultiRpcNear([FN]) as any;
    const err = await near.awaitOutcome('abc', 'alice.near', 1_500, { everSeen: false }).catch((e: any) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.neverSeen).toBe(false);
    expect(err.message).toMatch(/not confirmed within/);
    vi.unstubAllGlobals();
  }, 15_000);
});


describe('near: waitForOutcome recovery fan-out', () => {
  const QN = 'https://example.quiknode.pro/abc';
  const FN = 'https://rpc.mainnet.fastnear.com';

  const unknownTxResponse = () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      jsonrpc: '2.0',
      id: 'await-outcome',
      error: {
        name: 'HANDLER_ERROR',
        cause: { info: {}, name: 'UNKNOWN_TRANSACTION' },
        code: -32000,
        message: 'Server error',
        data: "Transaction abc doesn't exist",
      },
    }),
  }) as unknown as Response;

  const finalOutcomeResponse = () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      jsonrpc: '2.0',
      id: 'await-outcome',
      result: {
        final_execution_status: 'FINAL',
        status: { SuccessValue: '' },
        receipts_outcome: [{ outcome: { status: { SuccessValue: '' }, logs: [] } }],
      },
    }),
  }) as unknown as Response;

  it('recovers via a peer provider when the pinned RPC never sees the tx', async () => {
    // Regression: recovery polling used to query ONLY the pinned trade RPC —
    // when that endpoint lagged or rate-limited, landed transactions were
    // reported as "confirmation is taking longer than usual".
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === FN) return unknownTxResponse();
      return finalOutcomeResponse();
    }));
    const near = new MultiRpcNear([FN, QN]) as any;
    const outcome = await near.waitForOutcome('abc', 'alice.near', 8_000);
    expect(outcome).toBeTruthy();
    expect(outcome.final_execution_status).toBe('FINAL');
    vi.unstubAllGlobals();
  }, 15_000);

  it('returns null when no provider can confirm within the window', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => unknownTxResponse()));
    const near = new MultiRpcNear([FN, QN]) as any;
    const outcome = await near.waitForOutcome('abc', 'alice.near', 3_000);
    expect(outcome).toBeNull();
    vi.unstubAllGlobals();
  }, 15_000);
});
