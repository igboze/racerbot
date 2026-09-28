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
