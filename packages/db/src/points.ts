// ── RacerBot Points (Season 1 → $RACER airdrop) ─────────────────────────────
//
// Append-only, fully idempotent points ledger. Every point traces back to the
// fill / referral / day that earned it via (user_id, action, ref_id), so live
// hooks, backfills and retries can never double-award.
//
// Trading points are anchored to volume (which maps 1:1 to fees paid at the
// flat 1.5% fee), making wash-trading to farm points cost more in fees than
// the points can ever be worth. Referral points only unlock on QUALIFIED
// referrals (referee actually trades), so sybil signups earn nothing.

import { getDb, getReferralByReferredUser } from './db.js';

export const POINTS_CONFIG = {
  /** Points per 1 NEAR of trade volume (buy or sell) */
  TRADE_POINTS_PER_NEAR: 1.5,
  /** One-time bonus on the user's first real trade */
  FIRST_TRADE: 100,
  /** Points per day with ≥1 real trade */
  DAILY_ACTIVE: 25,
  /** Referrer bonus when a referred user makes their first trade */
  REFERRAL_QUALIFIED: 500,
  /** Bonus to the referred user on their first trade */
  REFERRAL_WELCOME: 250,
  /** Share of the referee's trade points paid to the referrer */
  REFERRAL_OVERRIDE_PCT: 0.05,
  /** Fixed bonus pts awarded to the copier per successful copy-trade fill */
  COPY_TRADE_BONUS: 25,
  /** Share of the copier's volume-pts awarded to the wallet being copied (leader bonus) */
  COPY_LEADER_PCT: 0.10,
  /** Users registered before this date get the Early Bird multiplier */
  EARLY_BIRD_CUTOFF: new Date('2026-09-30T00:00:00Z'),
  EARLY_BIRD_MULT: 1.25,
  /** Season 1 snapshot time */
  SEASON_1_END: new Date('2026-10-15T23:59:59Z'),
  /** Consecutive-day streak multipliers for the daily-activity points */
  STREAK_TIERS: [
    { days: 14, mult: 2 },
    { days: 7, mult: 1.5 },
    { days: 3, mult: 1.25 },
  ],
} as const;

export type PointsAction =
  | 'trade'
  | 'first_trade'
  | 'daily_active'
  | 'referral_qualified'
  | 'referral_welcome'
  | 'referral_override'
  /** Fixed per-fill bonus for the user who executed a copy trade */
  | 'copy_trade'
  /** 10% of copier's volume points awarded to the wallet being followed */
  | 'copy_leader';

/**
 * Award points idempotently. Returns true only when the row was inserted
 * (i.e. this exact award never happened before).
 */
export async function awardPoints(
  userId: string,
  action: PointsAction,
  points: number,
  refId: string
): Promise<boolean> {
  const pts = Math.round(points);
  if (!Number.isFinite(pts) || pts <= 0) return false;
  const db = await getDb();
  const r = await db.query(
    `INSERT INTO points_ledger (user_id, action, points, ref_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, action, ref_id) DO NOTHING`,
    [userId, action, pts, refId]
  );
  return (r.rowCount ?? 0) > 0;
}

/** Distinct UTC trade dates (real fills only) for a user, newest first. */
async function getTradeDates(userId: string, upToDate: string): Promise<string[]> {
  const db = await getDb();
  const r = await db.query(
    `SELECT DISTINCT (created_at AT TIME ZONE 'UTC')::date::text AS d
     FROM fills
     WHERE user_id = $1
       AND side IN ('buy', 'sell')
       AND (tx_hash IS NULL OR tx_hash NOT LIKE 'deposit\\_%')
       AND (created_at AT TIME ZONE 'UTC')::date <= $2::date
     ORDER BY d DESC
     LIMIT 40`,
    [userId, upToDate]
  );
  return r.rows.map((row: any) => row.d as string);
}

/** Length of the consecutive-day streak ending on dateStr (0 if not a trade day). */
function streakEnding(datesDesc: string[], dateStr: string): number {
  if (datesDesc.length === 0 || datesDesc[0] !== dateStr) return 0;
  const DAY_MS = 86_400_000;
  let streak = 1;
  let prev = new Date(`${dateStr}T00:00:00Z`).getTime();
  for (let i = 1; i < datesDesc.length; i++) {
    const cur = new Date(`${datesDesc[i]}T00:00:00Z`).getTime();
    if (prev - cur === DAY_MS) {
      streak++;
      prev = cur;
    } else {
      break;
    }
  }
  return streak;
}

/**
 * Award all points tied to one real trade fill:
 *  - trade volume points (1.5 pts per NEAR)
 *  - one-time first-trade bonus + referral qualification on the first trade
 *  - daily-activity points with streak multiplier
 *  - 5% referral override to the referrer
 *
 * Safe to call for the same fill any number of times — every award is keyed.
 */
export async function awardPointsForTradeFill(
  userId: string,
  fillId: string,
  txHash: string | null,
  volumeNear: number,
  tradedAt: Date = new Date()
): Promise<void> {
  if (!Number.isFinite(volumeNear) || volumeNear <= 0) return;
  if (txHash && txHash.startsWith('deposit_')) return;

  const tradePts = volumeNear * POINTS_CONFIG.TRADE_POINTS_PER_NEAR;
  const tradeInserted = await awardPoints(userId, 'trade', tradePts, fillId);

  // First-ever real trade → welcome bonus + referral qualification.
  const firstInserted = await awardPoints(userId, 'first_trade', POINTS_CONFIG.FIRST_TRADE, 'first');
  if (firstInserted) {
    const referral = await getReferralByReferredUser(userId).catch(() => null);
    if (referral) {
      await awardPoints(referral.referrer_id, 'referral_qualified', POINTS_CONFIG.REFERRAL_QUALIFIED, referral.id);
      await awardPoints(userId, 'referral_welcome', POINTS_CONFIG.REFERRAL_WELCOME, referral.id);
    }
  }

  // Daily activity (with streak multiplier) — first fill of the UTC day only.
  const dateStr = tradedAt.toISOString().slice(0, 10);
  const dailyRef = `daily:${dateStr}`;
  const db = await getDb();
  const existing = await db.query(
    'SELECT 1 FROM points_ledger WHERE user_id = $1 AND action = $2 AND ref_id = $3',
    [userId, 'daily_active', dailyRef]
  );
  if (existing.rows.length === 0) {
    const dates = await getTradeDates(userId, dateStr);
    const streak = streakEnding(dates, dateStr);
    const tier = POINTS_CONFIG.STREAK_TIERS.find(t => streak >= t.days);
    const mult = tier ? tier.mult : 1;
    await awardPoints(userId, 'daily_active', POINTS_CONFIG.DAILY_ACTIVE * mult, dailyRef);
  }

  // Referral override: referrer earns 5% of the referee's trade points.
  if (tradeInserted && tradePts >= 1) {
    const referral = await getReferralByReferredUser(userId).catch(() => null);
    if (referral) {
      await awardPoints(
        referral.referrer_id,
        'referral_override',
        tradePts * POINTS_CONFIG.REFERRAL_OVERRIDE_PCT,
        `ovr:${fillId}`
      );
    }
  }
}

export interface PointsSummary {
  basePoints: number;
  effectivePoints: number;
  earlyBird: boolean;
  multiplier: number;
  rank: number;
  totalUsers: number;
  breakdown: Record<string, number>;
  seasonEnd: Date;
}

export async function getPointsSummary(userId: string): Promise<PointsSummary> {
  const db = await getDb();
  const r = await db.query(
    'SELECT action, SUM(points)::float AS pts FROM points_ledger WHERE user_id = $1 GROUP BY action',
    [userId]
  );
  const breakdown: Record<string, number> = {};
  let base = 0;
  for (const row of r.rows) {
    breakdown[row.action as string] = Math.round(row.pts);
    base += row.pts;
  }

  const u = await db.query('SELECT created_at FROM users WHERE id = $1', [userId]);
  const createdAt = u.rows[0]?.created_at ? new Date(u.rows[0].created_at) : new Date();
  const earlyBird = createdAt < POINTS_CONFIG.EARLY_BIRD_CUTOFF;
  const mult = earlyBird ? POINTS_CONFIG.EARLY_BIRD_MULT : 1;
  const effective = Math.round(base * mult);

  const all = await db.query(
    `SELECT pl.user_id, SUM(pl.points)::float AS base, (u.created_at < $1::timestamptz) AS early
     FROM points_ledger pl
     JOIN users u ON u.id = pl.user_id
     GROUP BY pl.user_id, u.created_at`,
    [POINTS_CONFIG.EARLY_BIRD_CUTOFF.toISOString()]
  );
  let rank = 1;
  for (const row of all.rows) {
    if (row.user_id === userId) continue;
    const e = row.base * (row.early ? POINTS_CONFIG.EARLY_BIRD_MULT : 1);
    if (e > effective) rank++;
  }

  return {
    basePoints: Math.round(base),
    effectivePoints: effective,
    earlyBird,
    multiplier: mult,
    rank,
    totalUsers: all.rows.length,
    breakdown,
    seasonEnd: POINTS_CONFIG.SEASON_1_END,
  };
}

export interface LeaderboardEntry {
  userId: string;
  label: string;
  points: number;
}

export async function getPointsLeaderboard(limit = 10): Promise<LeaderboardEntry[]> {
  const db = await getDb();
  const r = await db.query(
    `SELECT pl.user_id, u.username, u.telegram_id,
            SUM(pl.points)::float AS base,
            (u.created_at < $1::timestamptz) AS early
     FROM points_ledger pl
     JOIN users u ON u.id = pl.user_id
     GROUP BY pl.user_id, u.username, u.telegram_id, u.created_at
     ORDER BY (SUM(pl.points) * CASE WHEN u.created_at < $1::timestamptz THEN $2::numeric ELSE 1 END) DESC
     LIMIT $3`,
    [POINTS_CONFIG.EARLY_BIRD_CUTOFF.toISOString(), POINTS_CONFIG.EARLY_BIRD_MULT, limit]
  );
  return r.rows.map((row: any) => ({
    userId: row.user_id,
    label: row.username ? `@${row.username}` : `Trader ${String(row.telegram_id).slice(-4)}`,
    points: Math.round(row.base * (row.early ? POINTS_CONFIG.EARLY_BIRD_MULT : 1)),
  }));
}

/**
 * Retroactively award Season 1 points for every historical fill.
 * Idempotent — safe to re-run at any time.
 *
 * Perf: the naive path (awardPointsForTradeFill per fill) costs ~6 DB round
 * trips per fill, which is minutes over a remote connection. This batch
 * version computes every award in memory from three prefetched queries and
 * inserts in 500-row chunks — total round trips ≈ rows/500 + 3.
 */
export async function backfillAllPoints(
  onProgress?: (processed: number, total: number) => void
): Promise<{ fillsProcessed: number; awardsQueued: number }> {
  const db = await getDb();
  const [fills, referrals, tokenRows] = await Promise.all([
    db.query(
      `SELECT id, user_id, token_address, amount, price, fee_paid, tx_hash, created_at
       FROM fills WHERE side IN ('buy', 'sell') ORDER BY created_at ASC`
    ),
    db.query('SELECT id, referrer_id, referred_user_id FROM referrals'),
    db.query('SELECT token_address, decimals FROM token_cache'),
  ]);

  const decimalsByToken = new Map<string, number>(
    tokenRows.rows.map((r: any) => [r.token_address as string, (r.decimals ?? 18) as number])
  );
  const referralByUser = new Map<string, any>(
    referrals.rows.map((r: any) => [r.referred_user_id as string, r])
  );

  type AwardRow = [string, string, number, string];
  const rows: AwardRow[] = [];
  const seen = new Set<string>();
  const push = (userId: string, action: PointsAction, points: number, refId: string) => {
    const pts = Math.round(points);
    if (!Number.isFinite(pts) || pts <= 0) return;
    const key = `${userId}|${action}|${refId}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push([userId, action, pts, refId]);
  };

  const userDates = new Map<string, Set<string>>();
  const firstTradeDone = new Set<string>();
  let processed = 0;

  for (const f of fills.rows) {
    if (f.tx_hash && String(f.tx_hash).startsWith('deposit_')) continue;
    const price = parseFloat(f.price || '0');
    if (!(price > 0)) continue;

    // Volume: fee_paid is authoritative — the platform fee is exactly 1.5% of
    // the NEAR volume, and unlike amount it is always recorded in NEAR units.
    // Fee-less legacy fills fall back to amount × price with a plausibility
    // guard: amount is raw for most tokens but human in some legacy rows, so
    // when the human interpretation implies an impossible volume (> 1 000
    // NEAR in one fill) the raw interpretation wins.
    const feePaid = parseFloat(f.fee_paid || '0');
    let volumeNear: number;
    if (feePaid > 0) {
      volumeNear = feePaid / 0.015;
    } else {
      const decimals = decimalsByToken.get(f.token_address) ?? 18;
      const amount = parseFloat(f.amount || '0');
      const asHuman = amount * price;
      const asRaw = (decimals > 0 ? amount / Math.pow(10, decimals) : amount) * price;
      volumeNear = asHuman > 1_000 && asRaw < asHuman ? asRaw : asHuman;
    }
    if (!(volumeNear > 0)) continue;

    const tradePts = volumeNear * POINTS_CONFIG.TRADE_POINTS_PER_NEAR;
    push(f.user_id, 'trade', tradePts, f.id);

    const dateStr = new Date(f.created_at).toISOString().slice(0, 10);
    if (!userDates.has(f.user_id)) userDates.set(f.user_id, new Set());
    userDates.get(f.user_id)!.add(dateStr);

    if (!firstTradeDone.has(f.user_id)) {
      firstTradeDone.add(f.user_id);
      push(f.user_id, 'first_trade', POINTS_CONFIG.FIRST_TRADE, 'first');
      const referral = referralByUser.get(f.user_id);
      if (referral) {
        push(referral.referrer_id, 'referral_qualified', POINTS_CONFIG.REFERRAL_QUALIFIED, referral.id);
        push(f.user_id, 'referral_welcome', POINTS_CONFIG.REFERRAL_WELCOME, referral.id);
      }
    }

    if (tradePts >= 1) {
      const referral = referralByUser.get(f.user_id);
      if (referral) {
        push(
          referral.referrer_id,
          'referral_override',
          tradePts * POINTS_CONFIG.REFERRAL_OVERRIDE_PCT,
          `ovr:${f.id}`
        );
      }
    }

    processed++;
    if (onProgress && processed % 500 === 0) onProgress(processed, fills.rows.length);
  }

  // Daily activity with streak multipliers, computed from each user's date set
  const DAY_MS = 86_400_000;
  for (const [userId, datesSet] of userDates) {
    for (const d of datesSet) {
      let streak = 1;
      let cur = new Date(`${d}T00:00:00Z`).getTime();
      while (datesSet.has(new Date(cur - DAY_MS).toISOString().slice(0, 10))) {
        streak++;
        cur -= DAY_MS;
      }
      const tier = POINTS_CONFIG.STREAK_TIERS.find(t => streak >= t.days);
      push(userId, 'daily_active', POINTS_CONFIG.DAILY_ACTIVE * (tier ? tier.mult : 1), `daily:${d}`);
    }
  }

  // Batch insert — conflicts (already awarded) are skipped
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const values: string[] = [];
    const params: any[] = [];
    chunk.forEach((r, idx) => {
      const b = idx * 4;
      values.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4})`);
      params.push(r[0], r[1], r[2], r[3]);
    });
    await db.query(
      `INSERT INTO points_ledger (user_id, action, points, ref_id)
       VALUES ${values.join(',')}
       ON CONFLICT (user_id, action, ref_id) DO NOTHING`,
      params
    );
  }

  return { fillsProcessed: processed, awardsQueued: rows.length };
}

/**
 * Award points for a successful copy-trade fill:
 *  - Copier gets volume-pts (1.5 pts/NEAR) + fixed COPY_TRADE_BONUS (25 pts)
 *  - The wallet being copied (leader) gets COPY_LEADER_PCT (10%) of the copier's volume pts
 *
 * @param copierUserId  Internal user.id of the follower
 * @param copyFillId    copy_trade_fills.id — used as the idempotency key
 * @param volumeNear    NEAR value of the copy-trade (the buy_amount_near)
 * @param leaderUserId  Internal user.id of the user whose wallet was being copied
 *                      (undefined if the leader isn't a RacerBot user)
 */
export async function awardPointsForCopyTrade(
  copierUserId: string,
  copyFillId: string,
  volumeNear: number,
  leaderUserId: string | undefined
): Promise<void> {
  if (!Number.isFinite(volumeNear) || volumeNear <= 0) return;

  // 1. Volume points for the copier (same rate as normal trades)
  const tradePts = volumeNear * POINTS_CONFIG.TRADE_POINTS_PER_NEAR;
  await awardPoints(copierUserId, 'trade', tradePts, `copy:${copyFillId}`);

  // 2. Fixed copy-trade bonus
  await awardPoints(copierUserId, 'copy_trade', POINTS_CONFIG.COPY_TRADE_BONUS, copyFillId);

  // 3. Leader bonus — only if the target wallet belongs to a RacerBot user
  if (leaderUserId && tradePts >= 1) {
    await awardPoints(
      leaderUserId,
      'copy_leader',
      tradePts * POINTS_CONFIG.COPY_LEADER_PCT,
      `lead:${copyFillId}`
    );
  }
}
