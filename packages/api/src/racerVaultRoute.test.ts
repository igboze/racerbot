import { describe, expect, it, vi } from 'vitest';

// The NearlyTrade launch below trades only against nTTWO, which has no route from NEAR (checked on-chain).
const NO_ROUTE = 'Token dcty-3.nearlytrade.near is paired with nttwo.rwa.assetize.near. No NEAR route to nttwo.rwa.assetize.near was found, so it cannot be traded from NEAR.';

vi.mock('@racerbot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@racerbot/shared')>()),
  getNear: () => ({
    planNearlytradeRoute: async () => { throw new Error(NO_ROUTE); },
    findDclPoolId: async () => null,
    getIntearTokenState: async () => null,
  }),
}));

const { planVaultHops } = await import('./racerVault.js');

describe('planVaultHops for a launch that cannot be routed from NEAR', () => {
  it('refuses with the reason instead of planning a pool that does not exist', async () => {
    const buy = planVaultHops({
      tokenAddress: 'dcty-3.nearlytrade.near', venue: 'nearlytrade', side: 'BUY', amountIn: '1000', slippagePct: 2,
    });
    await expect(buy).rejects.toThrow(/cannot be bought with NEAR yet/);
    await expect(buy).rejects.toThrow(/nttwo\.rwa\.assetize\.near/);
  });

  it('refuses sells the same way (there is no route back to NEAR either)', async () => {
    await expect(planVaultHops({
      tokenAddress: 'dcty-3.nearlytrade.near', venue: 'nearlytrade', side: 'SELL', amountIn: '1000', slippagePct: 2,
    })).rejects.toThrow(/cannot be sold for NEAR yet/);
  });
});
