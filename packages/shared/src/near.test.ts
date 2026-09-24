import { describe, it, expect, vi } from 'vitest';
import { MultiRpcNear } from './near.js';

describe('near: storage-deposit cache', () => {
  it('calls storage_balance_of once and serves second call from registeredCache', async () => {
    const near = new MultiRpcNear(['https://rpc.mainnet.fastnear.com']);
    const accountId = `user-${Date.now()}.racerbot.near`;
    const tokenAddress = `token-${Date.now()}.near`;

    // Mock only the network view call
    const viewSpy = vi.spyOn(near, 'view').mockImplementation(async (contractId, method, args) => {
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
