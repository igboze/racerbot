import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./wallet.js', () => ({
  getTokenInfo: async (address: string) => ({ address, symbol: 'HOOT', name: 'Hoot', price: '0.001', liquidity_usd: '50000', venue: 'rhea' }),
}));
vi.mock('@racerbot/db', () => ({ getDb: async () => null }));

const { planSwarmSession } = await import('./nearAiSwarm.js');

const balances = { nativeNearFormatted: '50' } as any;
const TOKEN = 'hoot-8ecf65.launchpad.justhoot.near';

function modelAnswers(content: unknown, status = 200) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }],
  }), { status })));
}

describe('swarm planner with NEAR AI', () => {
  beforeEach(() => {
    vi.stubEnv('NEAR_AI_TEST_LIVE', '1');
    vi.stubEnv('NEAR_AI_API_KEY', 'test-key');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const aiPlan = {
    strategy: 'twap_dca', drone_count: 3, max_slippage_pct: 1.2,
    exit_triggers: [{ order: 1, type: 'take_profit_pct', target_value: 100, sell_pct: 50 }],
    reasoning: 'Split into three.',
  };

  it('keeps exits the model invented as suggestions, never as armed triggers', async () => {
    modelAnswers(aiPlan);
    const plan = await planSwarmSession({ prompt: `buy 3 NEAR of ${TOKEN} in 3 parts`, userBalances: balances });
    expect(plan.planner.source).toBe('near_ai');
    expect(plan.exitTriggers).toEqual([]);
    expect(plan.exitTrigger).toBeNull();
    expect(plan.suggestedExitTriggers).toHaveLength(1);
    expect(plan.suggestedExitTriggers![0]).toMatchObject({ type: 'take_profit_pct', sellPct: 50 });
  });

  it('arms the exits the user wrote, and suggests nothing on top', async () => {
    modelAnswers(aiPlan);
    const plan = await planSwarmSession({ prompt: `buy 3 NEAR of ${TOKEN} in 3 parts and take profit 50% at 2x`, userBalances: balances });
    expect(plan.exitTriggers!.length).toBeGreaterThan(0);
    expect(plan.suggestedExitTriggers).toBeUndefined();
  });

  it('reads a model answer wrapped in a ```json fence', async () => {
    modelAnswers('```json\n' + JSON.stringify(aiPlan) + '\n```');
    const plan = await planSwarmSession({ prompt: `buy 3 NEAR of ${TOKEN}`, userBalances: balances });
    expect(plan.planner.source).toBe('near_ai');
    expect(plan.strategy).toBe('twap_dca');
  });

  it('says so when NEAR AI is configured but does not answer', async () => {
    modelAnswers({}, 503);
    const plan = await planSwarmSession({ prompt: `buy 3 NEAR of ${TOKEN}`, userBalances: balances });
    expect(plan.planner).toMatchObject({ source: 'rules', label: 'Racer rule planner (NEAR AI did not answer)' });
  });

  it('a plain rule planner label when no model is configured', async () => {
    vi.stubEnv('NEAR_AI_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    const plan = await planSwarmSession({ prompt: `buy 3 NEAR of ${TOKEN}`, userBalances: balances });
    expect(plan.planner.label).toBe('Racer rule planner');
  });
});
