import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Never reach a real database from this test: dotenv does not override a variable that is already set
process.env.DATABASE_URL = 'postgres://swarm-exec-test@127.0.0.1:1/none';
process.env.DATABASE_URL_UNPOOLED = 'postgres://swarm-exec-test@127.0.0.1:1/none';

let sessions: Record<string, any> = {};
const triggers: any[] = [];
const positions: any[] = [];

vi.mock('@racerbot/db', () => ({
  getAiSwarmSessionById: vi.fn(async (id: string) => (sessions[id] ? structuredClone(sessions[id]) : null)),
  updateAiSwarmSession: vi.fn(async (id: string, f: any) => {
    sessions[id] = { ...sessions[id], ...f };
  }),
  listAiSwarmSessionsByStatus: vi.fn(async (status: string) => Object.values(sessions).filter((s: any) => s.status === status).map(s => structuredClone(s))),
  getUserById: vi.fn(async (id: string) => ({ id, telegram_id: 111 })),
  getOpenPositions: vi.fn(async () => positions),
  createTrigger: vi.fn(async (t: any) => { triggers.push(t); return t; }),
}));
const buy = vi.fn(async (_u: string, _t: string, amount: number) => ({ success: true, amountNear: amount, txHash: `tx${amount}`, positionId: 'pos-1', tokenQty: '1' }));
vi.mock('./routes.js', () => ({ executeBuyHelper: (...a: any[]) => (buy as any)(...a) }));
const sell = vi.fn(async () => ({ success: true, nearReceived: 1 }));
vi.mock('./sellHelper.js', () => ({ sellAtTarget: (...a: any[]) => (sell as any)(...a) }));

const ex = await import('./swarmExecutor.js');

const tranche = (i: number, o: any = {}) => ({ droneIndex: i, droneName: `Tranche ${i + 1}`, amountNear: 1, venue: 'rhea', delaySec: i * 20, delayMs: i * 20000, maxSlippagePct: 1.5, isConfidential: false, status: 'pending', ...o });
const session = (o: any) => ({
  id: 's1', user_id: 'u1', status: 'review', token_address: 'hoot.near', token_symbol: 'HOOT', drone_count: 3, stealth_mode: false,
  plan_json: { action: 'buy', tranches: [tranche(0), tranche(1), tranche(2)] }, execution_state: {}, ...o,
});

async function runAll() {
  // Flush every scheduled tranche and the async work after it
  for (let i = 0; i < 10; i++) {
    await vi.runAllTimersAsync();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  sessions = {};
  triggers.length = 0;
  positions.length = 0;
  buy.mockClear();
  sell.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('swarm executor', () => {
  it('a buy plan buys each tranche and finishes', async () => {
    sessions.s1 = session({});
    await ex.launchSwarmSession('s1');
    await runAll();
    expect(buy).toHaveBeenCalledTimes(3);
    expect(sell).not.toHaveBeenCalled();
    expect(sessions.s1.status).toBe('completed');
    expect(sessions.s1.execution_state.completed_tranches).toBe(3);
    expect(sessions.s1.execution_state.filled_amount_near).toBe(3);
  });

  it('a sell plan sells, never buys, in equal shares of the starting position', async () => {
    positions.push({ id: 'pos-9', token_address: 'hoot.near', chain: 'near', status: 'open' });
    const share = 100 / 3;
    sessions.s1 = session({ plan_json: { action: 'sell', sellPct: 100, tranches: [0, 1, 2].map(i => tranche(i, { amountNear: 0, sellPct: share })) } });
    await ex.launchSwarmSession('s1');
    await runAll();
    expect(buy).not.toHaveBeenCalled();
    expect(sell).toHaveBeenCalledTimes(3);
    const pcts = sell.mock.calls.map((c: any) => c[2]);
    expect(pcts).toEqual([33.33, 50, 100]);
    expect(sell.mock.calls.every((c: any) => c[1] === 'pos-9')).toBe(true);
    expect(sessions.s1.status).toBe('completed');
  });

  it('works out each sell tranche as a share of what is left', () => {
    expect(ex.sellPctOfRemaining(25, 0)).toBe(25);
    expect(ex.sellPctOfRemaining(25, 1)).toBeCloseTo(33.33, 2);
    expect(ex.sellPctOfRemaining(25, 3)).toBe(100);
    expect(ex.sellPctOfRemaining(50, 2)).toBe(0);
  });

  it('a sell with no open position fails the tranche instead of buying', async () => {
    sessions.s1 = session({ plan_json: { action: 'sell', tranches: [tranche(0, { amountNear: 0, sellPct: 100 })] } });
    await ex.launchSwarmSession('s1');
    await runAll();
    expect(buy).not.toHaveBeenCalled();
    expect(sessions.s1.execution_state.tranche_status[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('No open position') });
  });

  it('resuming after a pause runs only the tranches that have not run', async () => {
    sessions.s1 = session({});
    await ex.launchSwarmSession('s1');
    await vi.advanceTimersByTimeAsync(1);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(buy).toHaveBeenCalledTimes(1);
    await ex.pauseSwarmSession('s1');
    await runAll();
    expect(buy).toHaveBeenCalledTimes(1);
    expect(sessions.s1.status).toBe('paused');

    await ex.launchSwarmSession('s1');
    await runAll();
    expect(buy).toHaveBeenCalledTimes(3);
    expect(buy.mock.calls.map((c: any) => c[2])).toEqual([1, 1, 1]);
    expect(sessions.s1.status).toBe('completed');
    expect(sessions.s1.execution_state.tranche_status.map((t: any) => t.status)).toEqual(['filled', 'filled', 'filled']);
  });

  it('adds the exit trigger once per position, not once per tranche', async () => {
    sessions.s1 = session({ plan_json: { action: 'buy', exitTrigger: { type: 'market_cap', targetValue: 250000, sellPct: 100 }, tranches: [tranche(0), tranche(1), tranche(2)] } });
    await ex.launchSwarmSession('s1');
    await runAll();
    expect(triggers).toHaveLength(1);
    expect(triggers[0]).toMatchObject({ position_id: 'pos-1', type: 'market_cap', target_value: 250000 });
  });

  it('arms multiple exitTriggers in the exact sequence ordered by the user', async () => {
    sessions.s1 = session({
      plan_json: {
        action: 'buy',
        exitTriggers: [
          { type: 'take_profit_pct', targetValue: 100, sellPct: 50, order: 1, targetDisplay: '+100% TP' },
          { type: 'market_cap', targetValue: 500000, sellPct: 50, order: 2, targetDisplay: '500.0K MC' },
          { type: 'stop_loss_pct', targetValue: 20, sellPct: 100, order: 3, targetDisplay: '-20% SL' },
        ],
        tranches: [tranche(0), tranche(1)],
      },
    });
    await ex.launchSwarmSession('s1');
    await runAll();
    expect(triggers).toHaveLength(3);
    expect(triggers.map((t: any) => ({ type: t.type, target_value: t.target_value, sell_pct: t.sell_pct }))).toEqual([
      { type: 'take_profit_pct', target_value: 100, sell_pct: 50 },
      { type: 'market_cap', target_value: 500000, sell_pct: 50 },
      { type: 'stop_loss_pct', target_value: 20, sell_pct: 100 },
    ]);
  });

  it('after a restart, executing swarms become paused, and a tranche caught mid-flight is not re-run', async () => {
    sessions.s1 = session({
      status: 'executing',
      execution_state: { tranche_status: [tranche(0, { status: 'filled' }), tranche(1, { status: 'dispatching' }), tranche(2)], executionLog: [] },
    });
    expect(await ex.recoverInterruptedSwarms()).toBe(1);
    expect(sessions.s1.status).toBe('paused');
    expect(sessions.s1.execution_state.tranche_status.map((t: any) => t.status)).toEqual(['filled', 'failed', 'pending']);

    await ex.launchSwarmSession('s1');
    await runAll();
    expect(buy).toHaveBeenCalledTimes(1);
  });

  it('will not launch a finished or aborted swarm', async () => {
    sessions.s1 = session({ status: 'completed' });
    await expect(ex.launchSwarmSession('s1')).rejects.toThrow(/Cannot launch/);
    sessions.s1 = session({ status: 'aborted' });
    await expect(ex.launchSwarmSession('s1')).rejects.toThrow(/Cannot launch/);
  });
});
