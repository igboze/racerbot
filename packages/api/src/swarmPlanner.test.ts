import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./wallet.js', () => ({
  getTokenInfo: async (address: string) => ({ address, symbol: 'HOOT', name: 'Hoot', price: '0.001', liquidity_usd: '50000', venue: 'rhea' }),
}));
vi.mock('@racerbot/db', () => ({ getDb: async () => null }));

const { planSwarmSession, setSwarmTeeDepsForTests } = await import('./nearAiSwarm.js');
const { resetTeeCache } = await import('./nearAiTee.js');
const { fakeNearAiTee } = await import('./__fixtures__/nearAiTeeFake.js');

const balances = { nativeNearFormatted: '50' } as any;
const TOKEN = 'hoot-8ecf65.launchpad.justhoot.near';

/** The model answers from a NEAR AI TEE we can attest (or one link of the proof is broken) */
function modelAnswers(content: unknown, brk?: Parameters<typeof fakeNearAiTee>[0]['break']) {
  const fake = fakeNearAiTee({ content, break: brk });
  setSwarmTeeDepsForTests(fake.deps);
  return fake;
}

describe('swarm planner with NEAR AI', () => {
  beforeEach(() => {
    vi.stubEnv('NEAR_AI_API_KEY', 'test-key');
    resetTeeCache();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    setSwarmTeeDepsForTests(undefined);
  });

  const aiPlan = {
    strategy: 'twap_dca', drone_count: 3, max_slippage_pct: 1.2,
    exit_triggers: [{ order: 1, type: 'take_profit_pct', target_value: 100, sell_pct: 50 }],
    reasoning: 'Split into three.',
  };

  it('keeps exits the model invented as suggestions, never as armed triggers', async () => {
    modelAnswers(aiPlan);
    const plan = await planSwarmSession({ prompt: `buy 3 NEAR of ${TOKEN} in 3 parts`, userBalances: balances });
    expect(plan.planner.source).toBe('near_ai_tee');
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
    expect(plan.planner.source).toBe('near_ai_tee');
    expect(plan.strategy).toBe('twap_dca');
  });

  it('labels a verified plan with the model and the TEE that signed it', async () => {
    const fake = modelAnswers(aiPlan);
    const plan = await planSwarmSession({ prompt: `buy 3 NEAR of ${TOKEN}`, userBalances: balances });
    expect(plan.planner).toMatchObject({
      source: 'near_ai_tee',
      label: 'NEAR AI TEE · deepseek-ai/DeepSeek-V4.1-Flash-1017 · verified',
      tee: { verified: true, signer: fake.teeAddress },
    });
  });

  it('says so when NEAR AI is configured but does not answer', async () => {
    modelAnswers({}, 'model-down');
    const plan = await planSwarmSession({ prompt: `buy 3 NEAR of ${TOKEN}`, userBalances: balances });
    expect(plan.planner.source).toBe('rules');
    expect(plan.planner.label).toBe('Racer rule planner (NEAR AI TEE not verified: NEAR AI answered 503)');
  });

  it('throws away an AI answer whose TEE proof does not check out', async () => {
    for (const brk of ['tampered-response', 'other-signer', 'gpu-fail', 'wrong-nonce'] as const) {
      resetTeeCache();
      modelAnswers({ ...aiPlan, strategy: 'liquidity_sweep' }, brk);
      const plan = await planSwarmSession({ prompt: `buy 3 NEAR of ${TOKEN}`, userBalances: balances });
      expect(plan.planner.source).toBe('rules');
      expect(plan.planner.label).toContain('NEAR AI TEE not verified');
      expect(plan.strategy).not.toBe('liquidity_sweep');
    }
  });

  it('a plain rule planner label when no model is configured, and never asks OpenAI', async () => {
    vi.stubEnv('NEAR_AI_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', 'sk-should-not-be-used');
    const fake = modelAnswers({});
    const plan = await planSwarmSession({ prompt: `buy 3 NEAR of ${TOKEN}`, userBalances: balances });
    expect(plan.planner.label).toBe('Racer rule planner');
    expect(fake.calls).toHaveLength(0);
  });
});
