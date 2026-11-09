import { describe, it, expect } from 'vitest';
import { buildWeeklyRacerProfile, weekFills, weekKey, weekStart } from './racerRank.js';
import {
  fillNearValue, washFillIndexes, racerVolume, rankFor, topPercent, realizedRoiPct, finishFor,
  badgesFor, longestDayStreak, buildRacerProfile, rankKeyBeforeLatestFill, rankKeyFor, isAnnounceableRankUp,
  TIERS, MAX_RANK_KEY, executorFills, type RacerFill, type ConfidentialExecutor,
} from './racerRank.js';

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
const min = (m: number) => new Date(T0 + m * 60_000);
const day = (d: number) => new Date(T0 + d * 86_400_000);
const fill = (o: Partial<RacerFill> & Pick<RacerFill, 'side' | 'nearValue'>): RacerFill =>
  ({ token: 'tok.near', venue: 'rhea', at: min(0), ...o });

describe('fillNearValue', () => {
  it('uses input_amount, then fee_paid / 1.5%, else 0', () => {
    expect(fillNearValue('12.5', '0.1875')).toBe(12.5);
    expect(fillNearValue(null, '0.15')).toBeCloseTo(10);
    expect(fillNearValue('0', '0.03')).toBeCloseTo(2);
    expect(fillNearValue(null, null)).toBe(0);
    expect(fillNearValue('garbage', '0')).toBe(0);
  });
});

describe('wash round trips', () => {
  it('drops both legs of a flat buy→sell of the same token within 5 minutes', () => {
    const fills = [fill({ side: 'buy', nearValue: 10, at: min(0) }), fill({ side: 'sell', nearValue: 9.7, at: min(2) })];
    expect([...washFillIndexes(fills)].sort()).toEqual([0, 1]);
    expect(racerVolume(fills)).toEqual({ gross: 19.7, net: 0, washLegs: 2 });
  });

  it('keeps a fast round trip whose value really moved (a snipe)', () => {
    const win = [fill({ side: 'buy', nearValue: 10, at: min(0) }), fill({ side: 'sell', nearValue: 18, at: min(1) })];
    const loss = [fill({ side: 'buy', nearValue: 10, at: min(0) }), fill({ side: 'sell', nearValue: 6, at: min(1) })];
    expect(racerVolume(win).net).toBe(28);
    expect(racerVolume(loss).net).toBe(16);
  });

  it('keeps flat round trips slower than 5 minutes, or across different tokens', () => {
    const slow = [fill({ side: 'buy', nearValue: 10, at: min(0) }), fill({ side: 'sell', nearValue: 10, at: min(6) })];
    const other = [fill({ side: 'buy', nearValue: 10, at: min(0) }), fill({ side: 'sell', nearValue: 10, at: min(1), token: 'b.near' })];
    expect(racerVolume(slow).washLegs).toBe(0);
    expect(racerVolume(other).washLegs).toBe(0);
  });

  it('pairs each buy at most once, regardless of input order', () => {
    const fills = [
      fill({ side: 'sell', nearValue: 10, at: min(2) }),
      fill({ side: 'buy', nearValue: 10, at: min(0) }),
      fill({ side: 'sell', nearValue: 10, at: min(3) }),
    ];
    expect([...washFillIndexes(fills)].sort()).toEqual([0, 1]);
  });
});

describe('rankFor', () => {
  it('maps volume to tier and level I/II/III', () => {
    expect(rankFor(0).name).toBe('Rookie I');
    expect(rankFor(3).name).toBe('Rookie II');
    expect(rankFor(9.99).name).toBe('Rookie III');
    expect(rankFor(10).name).toBe('Street Racer I');
    expect(rankFor(60).name).toBe('Street Racer III');
    expect(rankFor(250).name).toBe('Circuit Racer II');
    expect(rankFor(4_999).name).toBe('Pro Driver III');
    expect(rankFor(17_472).name).toBe('Grand Prix II');
    expect(rankFor(99_999).name).toBe('Champion III');
    expect(rankFor(1e9).name).toBe('Legend III');
  });

  it('has a strictly increasing key, Rookie I = 1 to Legend III = 21', () => {
    const keys = [0, 2, 5, 10, 25, 50, 100, 1_000, 100_000].map(v => rankFor(v).key);
    expect(keys).toEqual([...keys].sort((a, b) => a - b));
    expect(new Set(keys).size).toBe(keys.length);
    expect(rankFor(0).key).toBe(1);
    expect(rankFor(1e9).key).toBe(MAX_RANK_KEY);
    expect(MAX_RANK_KEY).toBe(21);
    for (let k = 1; k <= MAX_RANK_KEY; k++) expect(rankFor(0, k).key).toBe(k);
  });

  it('measures progress toward the next level', () => {
    // Street Racer III runs 50 → 100 (Circuit Racer I)
    expect(rankFor(75)).toMatchObject({ name: 'Street Racer III', nextLevelName: 'Circuit Racer I', progressPct: 50 });
    // Circuit Racer I runs 100 → 250
    expect(rankFor(130)).toMatchObject({ nextLevelName: 'Circuit Racer II', progressPct: 20 });
    expect(rankFor(55).nextTitle).toBe('Circuit Racer');
    expect(rankFor(600_000)).toMatchObject({ name: 'Legend III', nextTitle: null, nextLevelName: null, progressPct: 100 });
    expect(rankFor(-5).name).toBe('Rookie I');
    expect(rankFor(NaN).name).toBe('Rookie I');
  });

  it('keeps level edges inside each tier', () => {
    TIERS.forEach((t, i) => {
      expect(t.levels[0]).toBeGreaterThan(t.min);
      expect(t.levels[1]).toBeGreaterThan(t.levels[0]);
      if (TIERS[i + 1]) expect(TIERS[i + 1].min).toBeGreaterThan(t.levels[1]);
    });
  });
});

describe('topPercent', () => {
  const all = [1, 5, 20, 50, 100, 200, 400, 800, 1600, 17_000, 0, 0];
  it('ranks among racers with volume, rounding up', () => {
    expect(topPercent(17_000, all)).toBe(10);
    expect(topPercent(800, all)).toBe(30);
    expect(topPercent(1, all)).toBe(100);
  });
  it('is null without volume and counts a racer missing from the list', () => {
    expect(topPercent(0, all)).toBeNull();
    expect(topPercent(5_000, [1, 2, 3])).toBe(25);
    expect(topPercent(5, [5])).toBe(100);
  });
});

describe('finish from realized PnL', () => {
  const closed = (buy: number, sell: number, id = 'p1'): RacerFill[] => [
    fill({ side: 'buy', nearValue: buy, positionId: id, positionClosed: true, at: min(0) }),
    fill({ side: 'sell', nearValue: sell, positionId: id, positionClosed: true, at: min(60) }),
  ];
  it('uses closed positions only', () => {
    expect(realizedRoiPct([fill({ side: 'buy', nearValue: 10, positionId: 'open' })])).toBeNull();
    expect(realizedRoiPct(closed(10, 15))).toBeCloseTo(50);
    expect(realizedRoiPct([...closed(10, 5, 'a'), ...closed(10, 25, 'b')])).toBeCloseTo(50);
  });
  it('ignores closed positions without a buy (deposited tokens)', () => {
    expect(realizedRoiPct([fill({ side: 'sell', nearValue: 50, positionId: 'd', positionClosed: true })])).toBeNull();
  });
  it('maps ROI to bronze / silver / gold / holo', () => {
    expect(finishFor(null)).toBe('bronze');
    expect(finishFor(-1)).toBe('bronze');
    expect(finishFor(0)).toBe('silver');
    expect(finishFor(25)).toBe('gold');
    expect(finishFor(100)).toBe('holo');
  });
});

describe('badges', () => {
  const cutoff = new Date(Date.UTC(2026, 11, 1));
  it('gives Founding Racer for a fill before the cutoff, and none without a cutoff', () => {
    const fills = [fill({ side: 'buy', nearValue: 1, at: day(0) })];
    expect(badgesFor(fills, cutoff)).toContain('founding');
    expect(badgesFor(fills, null)).not.toContain('founding');
    expect(badgesFor([fill({ side: 'buy', nearValue: 1, at: new Date(Date.UTC(2027, 0, 1)) })], cutoff)).not.toContain('founding');
  });
  it('gives the streak badge for 7 consecutive days', () => {
    const six = [0, 1, 2, 3, 4, 5].map(d => fill({ side: 'buy', nearValue: 1, at: day(d) }));
    expect(longestDayStreak(six)).toBe(6);
    expect(badgesFor(six, null)).not.toContain('streak');
    const seven = [...six, fill({ side: 'buy', nearValue: 1, at: day(6) }), fill({ side: 'buy', nearValue: 1, at: day(9) })];
    expect(longestDayStreak(seven)).toBe(7);
    expect(badgesFor(seven, null)).toContain('streak');
  });
  it('gives Multi-Track for three venues', () => {
    const fills = ['rhea', 'intear', 'nearlytrade'].map(venue => fill({ side: 'buy', nearValue: 1, venue }));
    expect(badgesFor(fills.slice(0, 2), null)).not.toContain('multi_venue');
    expect(badgesFor(fills, null)).toContain('multi_venue');
  });
  it('gives Diamond Hands for a week-long hold closed at +50%', () => {
    const hold = (sellDay: number, sell: number) => [
      fill({ side: 'buy', nearValue: 10, positionId: 'p', positionClosed: true, at: day(0) }),
      fill({ side: 'sell', nearValue: sell, positionId: 'p', positionClosed: true, at: day(sellDay) }),
    ];
    expect(badgesFor(hold(8, 15), null)).toContain('diamond_hands');
    expect(badgesFor(hold(3, 30), null)).not.toContain('diamond_hands');
    expect(badgesFor(hold(8, 14), null)).not.toContain('diamond_hands');
  });
});

describe('buildRacerProfile', () => {
  it('builds a friendly Rookie profile with no trades', () => {
    const p = buildRacerProfile([], [5, 50], new Date());
    expect(p).toMatchObject({ hasTrades: false, topPercent: null, finish: 'bronze', badges: [] });
    expect(p.rank.name).toBe('Rookie I');
  });
  it('hides a percentile outside the top half', () => {
    const all = [1, 2, 3, 4, 200];
    expect(buildRacerProfile([fill({ side: 'buy', nearValue: 200 })], all, null).topPercent).toBe(20);
    expect(buildRacerProfile([fill({ side: 'buy', nearValue: 1 })], all, null).topPercent).toBeNull();
  });
  it('ranks on volume net of wash round trips', () => {
    const fills = [
      fill({ side: 'buy', nearValue: 8, at: min(0) }),
      fill({ side: 'buy', nearValue: 50, at: min(10), token: 'w.near' }),
      fill({ side: 'sell', nearValue: 49, at: min(11), token: 'w.near' }),
    ];
    const p = buildRacerProfile(fills, [], null);
    expect(p.volume.gross).toBe(107);
    expect(p.rank.name).toBe('Rookie III');
  });
});

describe('lifetime rank', () => {
  it('never shows a rank below the stored best', () => {
    // Stored Circuit Racer II (key 8); fills now only add up to Street Racer I
    const r = rankFor(12, 8);
    expect(r.name).toBe('Circuit Racer II');
    expect(r.progressPct).toBe(0);
    expect(rankFor(300, 8).progressPct).toBe(20);
    // A higher computed rank wins over a lower stored one
    expect(rankFor(600, 4).name).toBe('Circuit Racer III');
  });

  it('ignores a nonsense stored key', () => {
    expect(rankFor(3, -4).name).toBe('Rookie II');
    expect(rankFor(3, 99).key).toBe(MAX_RANK_KEY);
    expect(rankFor(3, 2.5).name).toBe('Rookie II');
  });

  it('keeps the stored best in the profile, with the computed key alongside', () => {
    const p = buildRacerProfile([fill({ side: 'buy', nearValue: 12 })], [], null, 8);
    expect(p.rank.name).toBe('Circuit Racer II');
    expect(p.computedKey).toBe(rankKeyFor(12));
    expect(p.computedKey).toBe(4);
  });
});

describe('rank before the latest fill (seeding)', () => {
  it('drops only the most recent fill', () => {
    const fills = [fill({ side: 'sell', nearValue: 3, at: min(30) }), fill({ side: 'buy', nearValue: 9, at: min(0) })];
    expect(rankKeyBeforeLatestFill(fills)).toBe(rankKeyFor(9));
    expect(rankKeyFor(12)).toBeGreaterThan(rankKeyBeforeLatestFill(fills));
    expect(rankKeyBeforeLatestFill([fill({ side: 'buy', nearValue: 3 })])).toBe(1);
    expect(rankKeyBeforeLatestFill([])).toBe(0);
  });
});

describe('isAnnounceableRankUp', () => {
  it('announces every level up by default, and nothing that is not up', () => {
    expect(isAnnounceableRankUp(4, 5)).toBe(true);
    expect(isAnnounceableRankUp(5, 5)).toBe(false);
    expect(isAnnounceableRankUp(6, 5)).toBe(false);
  });
  it('in tier mode announces only a new tier', () => {
    expect(isAnnounceableRankUp(4, 5, 'tier')).toBe(false);   // Street I → II
    expect(isAnnounceableRankUp(6, 7, 'tier')).toBe(true);    // Street III → Circuit I
    expect(isAnnounceableRankUp(5, 9, 'tier')).toBe(true);    // jump into a later tier
    expect(isAnnounceableRankUp(0, 2, 'tier')).toBe(true);
  });
});

describe('confidential trades (executorFills)', () => {
  const N = (near: number) => (BigInt(Math.round(near * 1000)) * 10n ** 21n).toString();
  const exec = (o: Partial<ConfidentialExecutor> = {}): ConfidentialExecutor => ({
    account_id: 'x1.exec.near', status: 'open', token: 'tok.near', venue: 'rhea', size_yocto: N(10),
    amount_spent: N(9.8), fee_paid: N(0.2), returned_amount: null, opened_at: min(0), exited_at: null, ...o,
  });

  it('counts an open position as a buy of NEAR spent plus fee', () => {
    const fills = executorFills(exec());
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ side: 'buy', token: 'tok.near', venue: 'rhea', positionId: 'exec:x1.exec.near', positionClosed: false });
    expect(fills[0].nearValue).toBeCloseTo(10);
  });

  it('counts an exited position as a sell of the NEAR returned minus unused funding', () => {
    // Funded 12, spent 9.8 + 0.2 fee, 2 never used; 17 came back, so the sell brought 15
    const fills = executorFills(exec({ size_yocto: N(12), status: 'exited', returned_amount: N(17), exited_at: day(9) }));
    expect(fills.map(f => f.side)).toEqual(['buy', 'sell']);
    expect(fills[1].nearValue).toBeCloseTo(15);
    expect(fills.every(f => f.positionClosed)).toBe(true);
    expect(realizedRoiPct(fills)).toBeCloseTo(50);
  });

  it('adds no sell when nothing came back, and nothing for an executor that never bought', () => {
    expect(executorFills(exec({ status: 'closed', returned_amount: N(0), exited_at: min(30) }))).toHaveLength(1);
    expect(executorFills(exec({ amount_spent: null }))).toEqual([]);
    expect(executorFills(exec({ opened_at: null }))).toEqual([]);
    expect(executorFills(exec({ amount_spent: 'garbage' }))).toEqual([]);
  });

  it('applies the wash rule to a flat confidential round trip', () => {
    const fills = executorFills(exec({ status: 'exited', returned_amount: N(9.9), exited_at: min(2) }));
    // 10 in, 9.9 back within 2 minutes: both legs excluded
    expect(racerVolume(fills)).toMatchObject({ net: 0, washLegs: 2 });
  });
});

describe('weekly card', () => {
  const fill = (at: string, nearValue: number) => ({ side: 'buy' as const, token: 't', venue: 'rhea', at: new Date(at), nearValue });

  it('starts the racing week on Monday 00:00 UTC', () => {
    expect(weekStart(new Date('2026-11-09T00:00:00Z')).toISOString()).toBe('2026-11-09T00:00:00.000Z'); // Monday
    expect(weekStart(new Date('2026-11-15T23:59:59Z')).toISOString()).toBe('2026-11-09T00:00:00.000Z'); // Sunday
    expect(weekStart(new Date('2026-11-16T00:00:01Z')).toISOString()).toBe('2026-11-16T00:00:00.000Z');
    expect(weekKey(new Date('2026-11-12T10:00:00Z'))).toBe('2026-11-09');
  });

  it('ranks from this week\'s volume only, starting over each Monday', () => {
    const now = new Date('2026-11-12T10:00:00Z');
    const fills = [fill('2026-11-01T10:00:00Z', 5_000), fill('2026-11-10T10:00:00Z', 30)];
    expect(weekFills(fills, now)).toHaveLength(1);
    const week = buildWeeklyRacerProfile(fills, [30], null, now);
    expect(week.rank.name).toBe('Street Racer II');
    // A new week with no trades is back at the start
    const next = buildWeeklyRacerProfile(fills, [], null, new Date('2026-11-17T10:00:00Z'));
    expect(next.hasTrades).toBe(false);
    expect(next.rank.name).toBe('Rookie I');
  });
});
