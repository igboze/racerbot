import { describe, it, expect, vi } from 'vitest';
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


describe('near: RPC duty split (FastNEAR reads / QuickNode writes)', () => {
  const FN = 'https://rpc.mainnet.fastnear.com';
  const QN = 'https://falling-frosty-uranium.near-mainnet.quiknode.pro/abc123/';

  it('orders read providers FastNEAR-first and trade providers QuickNode-first', () => {
    const near = new MultiRpcNear([QN, FN]) as any;
    expect(near.readProviders[0].url).toBe(FN);
    expect(near.readProviders[0].isQuickNode).toBe(false);
    expect(near.readProviders[1].url).toBe(QN);
    expect(near.readProviders[1].isQuickNode).toBe(true);
    expect(near.tradeProviders[0].url).toBe(QN);
    expect(near.tradeProviders[1].url).toBe(FN);
  });

  it('view() fails over to QuickNode only when FastNEAR is unavailable', async () => {
    const near = new MultiRpcNear([FN, QN]) as any;
    // Force FastNEAR read providers into circuit-open state
    for (const p of near.readProviders.filter((x: any) => !x.isQuickNode)) {
      p.healthy = false;
      p.circuitBreakerOpen = true;
      p.circuitBreakerUntil = Date.now() + 60_000;
    }
    // Intercept at the connection layer to record which provider(s) were used
    const attempted: string[] = [];
    near.getConnection = async (url: string) => {
      attempted.push(url);
      return {
        account: async () => ({
          viewFunction: async () => ({ ok: true }),
        }),
      };
    };
    const result = await near.view('token.near', 'ft_metadata', {});
    expect(result).toEqual({ ok: true });
    expect(attempted).toEqual([QN]); // FastNEAR excluded from the fan-out entirely

    // When FastNEAR is healthy again, QuickNode receives no read traffic
    for (const p of near.readProviders) {
      p.healthy = true;
      p.circuitBreakerOpen = false;
      p.circuitBreakerUntil = 0;
    }
    attempted.length = 0;
    await near.view('token.near', 'ft_metadata', {});
    expect(attempted).toEqual([FN]);
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
  it('fetches launch/metadata/supply once across repeated state calls', async () => {
    const token = `cached-${Date.now()}.nearlytrade.near`;
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
