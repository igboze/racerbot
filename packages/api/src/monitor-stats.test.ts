import { describe, it, expect } from 'vitest';
import { summarizeAttempts, formatReasons } from './monitorStats.js';
import type { TradeAttemptRow } from '@racerbot/db';

function attempt(overrides: Partial<TradeAttemptRow> = {}): TradeAttemptRow {
  return {
    id: 't1',
    user_id: 'u1',
    side: 'buy',
    venue: 'rhea',
    token_in: 'wrap.near',
    token_out: 'token.near',
    amount_in: '1',
    status: 'success',
    tx_hash: null,
    error: null,
    timings: { presign_ms: 100, sign_ms: 1000, post_ms: 200 },
    slippage_pct: null,
    created_at: new Date(),
    ...overrides,
  };
}

describe('summarizeAttempts', () => {
  it('returns zeros for an empty window', () => {
    const s = summarizeAttempts([]);
    expect(s.total).toBe(0);
    expect(s.failed).toBe(0);
    expect(s.failureRatePct).toBe(0);
    expect(s.topReasons).toEqual([]);
    expect(s.timing).toEqual({ presignAvg: null, signAvg: null, signP90: null, postAvg: null });
    expect(s.slowest).toEqual([]);
  });

  it('computes 100% failure rate when everything fails', () => {
    const rows = [
      attempt({ id: 'a', status: 'failed', error: 'slippage exceeded' }),
      attempt({ id: 'b', status: 'failed', error: 'slippage exceeded' }),
    ];
    const s = summarizeAttempts(rows);
    expect(s.failed).toBe(2);
    expect(s.failureRatePct).toBe(100);
    expect(s.topReasons).toEqual([['slippage exceeded', 2]]);
  });

  it('groups failure reasons with the most common first', () => {
    const rows = [
      attempt({ id: 'a', status: 'failed', error: 'timeout' }),
      attempt({ id: 'b', status: 'failed', error: 'slippage exceeded' }),
      attempt({ id: 'c', status: 'failed', error: 'timeout' }),
      attempt({ id: 'd', status: 'failed', error: null }),
    ];
    const s = summarizeAttempts(rows);
    expect(s.failed).toBe(4);
    expect(s.topReasons[0]).toEqual(['timeout', 2]);
    expect(s.topReasons).toContainEqual(['unknown', 1]);
  });

  it('truncates long error strings to 120 chars', () => {
    const long = 'x'.repeat(200);
    const s = summarizeAttempts([attempt({ status: 'failed', error: long })]);
    expect(s.topReasons[0][0].length).toBe(121); // 120 + ellipsis
    expect(s.topReasons[0][0].endsWith('…')).toBe(true);
  });

  it('computes venue failure counts', () => {
    const rows = [
      attempt({ id: 'a', venue: 'rhea', status: 'failed' }),
      attempt({ id: 'b', venue: 'rhea' }),
      attempt({ id: 'c', venue: 'memecooking' }),
    ];
    const s = summarizeAttempts(rows);
    expect(s.venueFailures.rhea).toEqual({ attempts: 2, failed: 1 });
    expect(s.venueFailures.memecooking).toEqual({ attempts: 1, failed: 0 });
  });

  it('computes p90 sign time over ordered samples', () => {
    const signMs = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    const rows = signMs.map((ms, i) =>
      attempt({ id: `s${i}`, timings: { presign_ms: ms / 2, sign_ms: ms, post_ms: ms } })
    );
    const s = summarizeAttempts(rows);
    expect(s.timing.signAvg).toBe(550);
    expect(s.timing.signP90).toBe(900); // ceil(0.9*10)=9 → index 8 (0-based)
    expect(s.timing.presignAvg).toBe(275);
    expect(s.timing.postAvg).toBe(550);
  });

  it('ignores rows with missing timings and ranks slowest first', () => {
    const rows = [
      attempt({ id: 'a', timings: { sign_ms: 500 } }),
      attempt({ id: 'b', timings: null }),
      attempt({ id: 'c', timings: { sign_ms: 2000 } }),
      attempt({ id: 'd', timings: { sign_ms: 900 } }),
    ];
    const s = summarizeAttempts(rows);
    expect(s.slowest.map((r) => r.id)).toEqual(['c', 'd', 'a']);
    expect(s.timing.signAvg).toBe(1133); // (500+2000+900)/3
  });
});

describe('formatReasons', () => {
  it('joins reasons with counts', () => {
    expect(formatReasons([['timeout', 3], ['slippage', 1]])).toBe('×3 timeout\n×1 slippage');
  });

  it('caps at max entries and handles empty input', () => {
    const reasons: Array<[string, number]> = [['a', 1], ['b', 1], ['c', 1], ['d', 1]];
    expect(formatReasons(reasons, 2).split('\n')).toHaveLength(2);
    expect(formatReasons([])).toBe('none');
  });
});

describe('buildVolumeUpdateText', () => {
  it('formats report with NEAR, SUI, Starknet, and Solana volumes and USD estimates', async () => {
    const { buildVolumeUpdateText } = await import('./monitorStats.js');
    const stats = {
      volume24hNear: 1000,
      fees24hNear: 15,
      trades24h: 20,
      buys24h: 25,
      sells24h: 5,
      activeTraders24h: 12,
      volumeTotalNear: 50000,
      feesTotalNear: 750,
      tradesTotal: 1000,
      volume24hSui: 500,
      fees24hSui: 7.5,
      trades24hSui: 10,
      volumeTotalSui: 20000,
      feesTotalSui: 300,
      tradesTotalSui: 400,
      volume24hStarknet: 800,
      fees24hStarknet: 12,
      trades24hStarknet: 15,
      volumeTotalStarknet: 1839.73,
      feesTotalStarknet: 27.596,
      tradesTotalStarknet: 14,
      volume24hSolana: 120,
      fees24hSolana: 1.8,
      trades24hSolana: 8,
      volumeTotalSolana: 450,
      feesTotalSolana: 6.75,
      tradesTotalSolana: 30,
      usersTotal: 250,
      newUsers24h: 5,
    };

    const text = buildVolumeUpdateText(stats as any, 2.5, 1.8, 0.4, 150);
    expect(text).toContain('📊 *RacerBot Daily Report*');
    expect(text).toContain('• Total trades: `53` (25 buys / 5 sells)');
    expect(text).toContain('〽️ *NEAR — 24h*');
    expect(text).toContain('• Volume: `1,000 NEAR` (~$2,500)');
    expect(text).toContain('🔵 *SUI — 24h*');
    expect(text).toContain('• Volume: `500 SUI` (~$900)');
    expect(text).toContain('⚡ *Starknet — 24h*');
    expect(text).toContain('• Volume: `800 STRK` (~$320)');
    expect(text).toContain('• Trades: `15`');
    expect(text).toContain('🟣 *Solana — 24h*');
    expect(text).toContain('• Volume: `120 SOL` (~$18,000)');
    expect(text).toContain('• Trades: `8`');
    expect(text).toContain('• Starknet volume: `1,839.73 STRK` (~$736)');
    expect(text).toContain('• Solana volume: `450 SOL` (~$67,500)');
    expect(text).toContain('• Total trades: `1,444`');
  });
});
