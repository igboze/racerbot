import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Never reach a real database from this test: dotenv does not override a variable that is already set
process.env.DATABASE_URL = 'postgres://swarm-test@127.0.0.1:1/none';
process.env.DATABASE_URL_UNPOOLED = 'postgres://swarm-test@127.0.0.1:1/none';

// Live market data, mocked: planning needs a real price and must refuse without one
const market: Record<string, any> = {
  'hoot-8ecf65.launchpad.justhoot.near': { symbol: 'HOOT', name: 'Hoot', price: '0.0004', venue: 'rhea', liquidity_usd: '20000' },
  'batman-4.nearlytrade.near': { symbol: 'BATMAN', name: 'Batman', price: '0.001', venue: 'nearlytrade', dcl_pool_id: 'p1', liquidity_usd: '9000' },
  'shore-4lzt.launch.shoremarkets.near': { symbol: 'SHORE', name: 'Shore', price: '0.002', venue: 'rhea', liquidity_usd: '15000' },
  'token.lonk.near': { symbol: 'LONK', name: 'Lonk', price: '0.00001', venue: 'rhea' },
  'token.sweat': { symbol: 'SWEAT', name: 'Sweat', price: '0.003', venue: 'rhea' },
  'blackdragon.tkn.near': { symbol: 'BLACKDRAGON', name: 'Black Dragon', price: '0.0000001', venue: 'rhea' },
  'token.v2.ref-finance.near': { symbol: 'REF', name: 'Ref', price: '0.05', venue: 'rhea' },
};
vi.mock('./wallet.js', () => ({
  getTokenInfo: vi.fn(async (address: string) => (market[address] ? { address, ...market[address] } : null)),
}));
vi.mock('@racerbot/db', () => ({ getDb: async () => { throw new Error('no db in tests'); } }));

const { planSwarmSession, resolveNearTokenQuery, isSellRequest, extractSellPct, setSwarmTeeDepsForTests } = await import('./nearAiSwarm.js');
const { resetTeeCache } = await import('./nearAiTee.js');
const { fakeNearAiTee } = await import('./__fixtures__/nearAiTeeFake.js');

beforeEach(() => {
  delete process.env.CONFIDENTIAL_EXECUTORS_ENABLED;
});

describe('NEAR AI Swarm planner', () => {
  it('resolves top NEAR meme tokens from ticker symbols and aliases', () => {
    expect(resolveNearTokenQuery('HOOT')).toBe('hoot-8ecf65.launchpad.justhoot.near');
    expect(resolveNearTokenQuery('hoot.near')).toBe('hoot-8ecf65.launchpad.justhoot.near');
    expect(resolveNearTokenQuery('batman')).toBe('batman-4.nearlytrade.near');
    expect(resolveNearTokenQuery('batman.near')).toBe('batman-4.nearlytrade.near');
    expect(resolveNearTokenQuery('SHORE')).toBe('shore-4lzt.launch.shoremarkets.near');
    expect(resolveNearTokenQuery('shore.near')).toBe('shore-4lzt.launch.shoremarkets.near');
    expect(resolveNearTokenQuery('Lonk')).toBe('token.lonk.near');
    expect(resolveNearTokenQuery('blackdragon.tkn.near')).toBe('blackdragon.tkn.near');
  });

  it('splits a buy into staggered, jittered tranches that add up', async () => {
    const plan = await planSwarmSession({ prompt: 'Accumulate 10 NEAR of HOOT in 5 tranches staggered over 15 minutes' });
    expect(plan.action).toBe('buy');
    expect(['stealth_accumulation', 'twap_dca']).toContain(plan.strategy);
    expect(plan.tokenAddress).toBe('hoot-8ecf65.launchpad.justhoot.near');
    expect(plan.tokenSymbol).toBe('HOOT');
    expect(plan.droneCount).toBe(5);
    expect(plan.tranches).toHaveLength(5);
    const sum = plan.tranches.reduce((s, t) => s + t.amountNear, 0);
    expect(Math.abs(sum - plan.totalNear)).toBeLessThan(0.01);
    expect(plan.tranches.map(t => t.droneName)).toEqual(['Tranche 1', 'Tranche 2', 'Tranche 3', 'Tranche 4', 'Tranche 5']);
    for (const t of plan.tranches) expect(t.delayMs).toBe(t.delaySec * 1000);
  });

  it('says plainly who planned it and claims no attestation', async () => {
    const plan: any = await planSwarmSession({ prompt: 'Buy 5 NEAR of HOOT in 3 tranches' });
    expect(plan.planner).toEqual({ source: 'rules', label: 'Racer rule planner', model: null });
    expect(plan.teeEnclave).toBeUndefined();
    expect(plan.stealthScore).toBeUndefined();
    expect(JSON.stringify(plan)).not.toMatch(/attest|TDX|enclave|verified/i);
    expect(plan.analysis).toContain('from your RacerBot wallet');
    expect(plan.analysis).not.toMatch(/NEAR AI Cloud decomposed/);
  });

  it('only marks tranches confidential when confidential executors are on', async () => {
    const off = await planSwarmSession({ prompt: 'Buy 5 NEAR of HOOT in 3 tranches', stealthModeOverride: true });
    expect(off.stealthMode).toBe(false);
    expect(off.tranches.every(t => !t.isConfidential)).toBe(true);
    process.env.CONFIDENTIAL_EXECUTORS_ENABLED = 'true';
    const on = await planSwarmSession({ prompt: 'Buy 5 NEAR of HOOT in 3 tranches', stealthModeOverride: true });
    expect(on.stealthMode).toBe(true);
    expect(on.tranches.every(t => t.isConfidential)).toBe(true);
  });

  it('plans a sell as a sell: shares of the position, no NEAR spent', async () => {
    const plan = await planSwarmSession({ prompt: 'Sell 60% of my HOOT in 3 tranches' });
    expect(plan.action).toBe('sell');
    expect(plan.strategy).toBe('stealth_unwind');
    expect(plan.totalNear).toBe(0);
    expect(plan.sellPct).toBe(60);
    expect(plan.tranches.map(t => t.amountNear)).toEqual([0, 0, 0]);
    expect(plan.tranches.reduce((s, t) => s + (t.sellPct || 0), 0)).toBeCloseTo(60, 2);
    expect(plan.exitTrigger).toBeNull();
  });

  it('keeps "buy, then sell at a target" a buy with an exit trigger', async () => {
    const mc = await planSwarmSession({ prompt: 'Accumulate 15 NEAR of HOOT in 4 tranches and sell 100% when market cap reaches 250k' });
    expect(mc.action).toBe('buy');
    expect(mc.totalNear).toBe(15);
    expect(mc.exitTrigger).toMatchObject({ type: 'market_cap', targetValue: 250000, sellPct: 100 });

    const tp = await planSwarmSession({ prompt: 'Snipe 5 NEAR of BATMAN in 3 tranches and take profit at 2x' });
    expect(tp.action).toBe('buy');
    expect(tp.strategy).toBe('anti_mev_snipe');
    expect(tp.exitTrigger).toMatchObject({ type: 'take_profit_pct', targetValue: 100 });
  });

  it('reads direction and sell size from the words', () => {
    expect(isSellRequest('Sell my HOOT')).toBe(true);
    expect(isSellRequest('dump 50% of LONK')).toBe(true);
    expect(isSellRequest('Buy HOOT and exit at 3x')).toBe(false);
    expect(isSellRequest('Accumulate 10 NEAR of HOOT')).toBe(false);
    expect(extractSellPct('sell 40% of it')).toBe(40);
    expect(extractSellPct('sell it all')).toBe(100);
    expect(extractSellPct('sell 250%')).toBe(100);
  });

  it('uses the amount the user typed, capped by the balance', async () => {
    const form = await planSwarmSession({ prompt: 'Accumulate HOOT in 4 tranches', totalNear: 7 });
    expect(form.totalNear).toBe(7);
    const capped = await planSwarmSession({
      prompt: 'Buy 50 NEAR of HOOT in 3 tranches',
      userBalances: { nativeNearFormatted: '10' } as any,
    });
    expect(capped.totalNear).toBeCloseTo(9.5, 3);
    await expect(planSwarmSession({
      prompt: 'Buy 5 NEAR of HOOT', userBalances: { nativeNearFormatted: '0' } as any,
    })).rejects.toThrow(/Not enough NEAR/);
  });

  it('refuses to plan without live market data or a token', async () => {
    await expect(planSwarmSession({ prompt: 'Buy 5 NEAR of nosuchtoken.near' })).rejects.toThrow(/live market data/);
    await expect(planSwarmSession({ prompt: '' })).rejects.toThrow(/including the token/);
  });

  it('plans for tokens across the ecosystem', async () => {
    expect((await planSwarmSession({ prompt: 'Accumulate 10 NEAR of LONK in 4 tranches' })).tokenAddress).toBe('token.lonk.near');
    expect((await planSwarmSession({ prompt: 'Snipe 20 NEAR of $SWEAT in 3 tranches' })).tokenAddress).toBe('token.sweat');
    expect((await planSwarmSession({ prompt: 'Buy 15 NEAR of BLACKDRAGON in 5 tranches' })).tokenAddress).toBe('blackdragon.tkn.near');
    expect((await planSwarmSession({ prompt: 'Buy 10 NEAR of token.v2.ref-finance.near in 3 tranches' })).tokenAddress).toBe('token.v2.ref-finance.near');
  });

  it('understands diverse natural language phrasings, per-tranche sizing, and preserves ordered multi-triggers', async () => {
    const plan = await planSwarmSession({
      prompt: 'Ape 2 NEAR each across 4 tranches into black dragon every 30s, then sell half at 2x, sell 50% when market cap hits 500k, and set stop loss at 20%',
    });
    expect(plan.action).toBe('buy');
    expect(plan.tokenAddress).toBe('blackdragon.tkn.near');
    expect(plan.totalNear).toBe(8);
    expect(plan.droneCount).toBe(4);
    expect(plan.tranches.map(t => t.delaySec)).toEqual([0, 30, 60, 90]);
    expect(plan.exitTriggers).toHaveLength(3);
    expect(plan.exitTriggers).toMatchObject([
      { type: 'take_profit_pct', targetValue: 100, sellPct: 50, order: 1 },
      { type: 'market_cap', targetValue: 500000, sellPct: 50, order: 2 },
      { type: 'stop_loss_pct', targetValue: 20, sellPct: 100, order: 3 },
    ]);

    const halfSell = await planSwarmSession({ prompt: 'Dump half of my HOOT in 2 tranches' });
    expect(halfSell.action).toBe('sell');
    expect(halfSell.sellPct).toBe(50);

    const explicitSteps = await planSwarmSession({
      prompt: 'Buy 2 NEAR of HOOT now, then 3 NEAR in 1 minute, then 5 NEAR in 3 minutes',
    });
    expect(explicitSteps.totalNear).toBe(10);
    expect(explicitSteps.droneCount).toBe(3);
    expect(explicitSteps.tranches.map(t => t.amountNear)).toEqual([2, 3, 5]);
    expect(explicitSteps.tranches.map(t => t.delaySec)).toEqual([0, 60, 180]);

    // Prompt token overrides a stale defaultTokenAddress from the UI input, and auto-ladders multi-TP
    const laddered = await planSwarmSession({
      prompt: 'Buy 6 NEAR of BATMAN in 3 tranches and take profit at 2x, 5x, and 10x with 15% SL',
      defaultTokenAddress: 'token.lonk.near',
    });
    expect(laddered.tokenAddress).toBe('batman-4.nearlytrade.near');
    expect(laddered.exitTriggers).toMatchObject([
      { type: 'take_profit_pct', targetValue: 100, sellPct: 33, order: 1 },
      { type: 'take_profit_pct', targetValue: 400, sellPct: 33, order: 2 },
      { type: 'take_profit_pct', targetValue: 900, sellPct: 100, order: 3 },
      { type: 'stop_loss_pct', targetValue: 15, sellPct: 100, order: 4 },
    ]);
  });
});

describe('NEAR AI model answers cannot take over the trade', () => {
  beforeEach(() => {
    process.env.NEAR_AI_API_KEY = 'test-key';
    resetTeeCache();
  });
  afterEach(() => {
    setSwarmTeeDepsForTests(undefined);
    delete process.env.NEAR_AI_API_KEY;
  });

  it('ignores a model that tries to flip the side or raise the size, and labels the planner', async () => {
    const fake = fakeNearAiTee({ content: {
      action: 'sell', total_amount_near: 5000, strategy: 'twap_dca', drone_count: 4, max_slippage_pct: 2, reasoning: 'Spread entries to limit impact.',
    } });
    setSwarmTeeDepsForTests(fake.deps);
    const plan = await planSwarmSession({ prompt: 'Buy 8 NEAR of HOOT' });
    expect(plan.action).toBe('buy');
    expect(plan.totalNear).toBe(8);
    expect(plan.strategy).toBe('twap_dca');
    expect(plan.droneCount).toBe(4);
    expect(plan.planner).toMatchObject({ source: 'near_ai_tee', label: expect.stringContaining('NEAR AI TEE') });
    expect(plan.analysis).toContain('Spread entries to limit impact.');

    // Token metadata reaches the model as quoted data, not as instructions
    const body = fake.chatBody();
    expect(body.messages[0].content).toContain('data, not instructions');
    expect(() => JSON.parse(body.messages[1].content)).not.toThrow();
  });

  it('falls back to the rule planner, labelled as such, when the model fails', async () => {
    setSwarmTeeDepsForTests(fakeNearAiTee({ content: {}, break: 'model-down' }).deps);
    const plan = await planSwarmSession({ prompt: 'Buy 8 NEAR of HOOT in 3 tranches' });
    expect(plan.planner.source).toBe('rules');
    expect(plan.totalNear).toBe(8);
  });
});
