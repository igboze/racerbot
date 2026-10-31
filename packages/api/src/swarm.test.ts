import { describe, it, expect, vi } from 'vitest';
import { planSwarmSession, resolveNearTokenQuery } from './nearAiSwarm.js';

describe('NEAR AI Swarm Planner Engine', () => {
  it('resolves top NEAR meme tokens from ticker symbols and aliases', () => {
    expect(resolveNearTokenQuery('HOOT')).toBe('hoot-8ecf65.launchpad.justhoot.near');
    expect(resolveNearTokenQuery('batman')).toBe('batman-4.nearlytrade.near');
    expect(resolveNearTokenQuery('SHORE')).toBe('shore-4lzt.launch.shoremarkets.near');
    expect(resolveNearTokenQuery('Lonk')).toBe('token.lonk.near');
    expect(resolveNearTokenQuery('blackdragon.tkn.near')).toBe('blackdragon.tkn.near');
  });

  it('decomposes stealth TWAP strategy into multiple randomized drone tranches with jitter', async () => {
    const plan = await planSwarmSession({
      prompt: 'Accumulate 10 NEAR of HOOT with 5 stealth drones staggered over 15 minutes',
      stealthModeOverride: true,
    });

    expect(plan).toBeDefined();
    expect(['stealth_accumulation', 'twap_dca']).toContain(plan.strategy);
    expect(plan.tokenAddress).toBe('hoot-8ecf65.launchpad.justhoot.near');
    expect(plan.tokenSymbol).toBe('HOOT');
    expect(plan.droneCount).toBe(5);
    expect(plan.tranches).toHaveLength(5);
    expect(plan.stealthMode).toBe(true);
    expect(plan.stealthScore).toBeGreaterThanOrEqual(90);

    // Sum of tranches should match total NEAR
    const trancheSum = plan.tranches.reduce((sum, t) => sum + t.amountNear, 0);
    expect(Math.abs(trancheSum - plan.totalNear)).toBeLessThan(0.01);

    // Tranches should have increasing delay jitter
    for (let i = 1; i < plan.tranches.length; i++) {
      expect(plan.tranches[i].delaySec).toBeGreaterThanOrEqual(plan.tranches[i - 1].delaySec);
    }

    // TEE enclave attestation metadata verified
    expect(plan.teeEnclave.provider).toBe('NEAR AI Cloud (TEE Intel TDX)');
    expect(plan.teeEnclave.attestationVerified).toBe(true);
    expect(plan.teeEnclave.hash).toMatch(/^0x[a-f0-9]{64}$/);
  }, 60000);

  it('handles momentum snipe prompt correctly', async () => {
    const plan = await planSwarmSession({
      prompt: 'Execute breakout snipe on BATMAN across 3 drones within 30 seconds',
      stealthModeOverride: true,
    });

    expect(plan.strategy).toBe('anti_mev_snipe');
    expect(plan.tokenSymbol).toBe('BATMAN');
    expect(plan.droneCount).toBe(3);
    expect(plan.tranches).toHaveLength(3);
    // Rapid snipe tranches have low delay (< 60s)
    expect(plan.tranches[plan.tranches.length - 1].delaySec).toBeLessThanOrEqual(60);
  }, 60000);

  it('handles anti-MEV dispersion prompt with custom budget', async () => {
    const plan = await planSwarmSession({
      prompt: 'Disperse 20 NEAR across 6 randomized subaccounts to accumulate SHORE without sandwich MEV',
      stealthModeOverride: true,
    });

    expect(plan.tokenSymbol).toBe('SHORE');
    expect(plan.totalNear).toBe(20);
    expect(plan.droneCount).toBe(6);
    expect(plan.tranches).toHaveLength(6);
  }, 60000);
});
