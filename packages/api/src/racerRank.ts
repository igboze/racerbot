/**
 * NEAR Racer Cards — pure rank logic (no I/O).
 *
 * Volume is lifetime NEAR traded through the bot, buys + sells, NEAR chain only.
 * Per fill, the NEAR value is `input_amount` (NEAR spent on a buy, NEAR received
 * on a sell — also NEAR for USDC-mode trades, whose USDC leg is settled outside
 * the fill). Legacy rows without `input_amount` fall back to `fee_paid / 0.015`:
 * the platform fee is exactly 1.5% of `input_amount` on every row that has both.
 *
 * Ranks are lifetime: callers pass the best rank key ever stored as a floor, so
 * a rank never drops even if fills are later excluded (see rankFor).
 */

export const PLATFORM_FEE_RATE = 0.015;

/** A buy→sell of the same token within this window can be a wash round trip… */
export const WASH_WINDOW_MS = 5 * 60 * 1000;
/**
 * …and is one only when it comes back flat: sell value / buy value inside this
 * range. Fast snipes that really moved (big win or big loss) keep their volume;
 * a buy sold straight back at about the same value is volume farming.
 */
export const WASH_MIN_RATIO = 0.9;
export const WASH_MAX_RATIO = 1.03;

export type FillSide = 'buy' | 'sell';

export interface RacerFill {
  side: FillSide;
  token: string;
  venue: string;
  at: Date;
  /** NEAR value of the fill, see fillNearValue */
  nearValue: number;
  positionId?: string | null;
  positionClosed?: boolean;
}

export function fillNearValue(inputAmount: unknown, feePaid: unknown): number {
  const input = Number(inputAmount);
  if (Number.isFinite(input) && input > 0) return input;
  const fee = Number(feePaid);
  if (Number.isFinite(fee) && fee > 0) return fee / PLATFORM_FEE_RATE;
  return 0;
}

/**
 * Indexes (into `fills`) of both legs of every wash round trip. Each sell is
 * paired with the most recent still-unpaired buy of the same token at most
 * WASH_WINDOW_MS earlier; the pair is a wash when the sell came back flat.
 */
export function washFillIndexes(fills: RacerFill[]): Set<number> {
  const order = fills.map((_, i) => i).sort((a, b) => fills[a].at.getTime() - fills[b].at.getTime());
  const openBuys = new Map<string, number[]>();
  const wash = new Set<number>();
  for (const i of order) {
    const f = fills[i];
    if (f.side === 'buy') {
      const list = openBuys.get(f.token) ?? [];
      list.push(i);
      openBuys.set(f.token, list);
      continue;
    }
    const list = openBuys.get(f.token);
    if (!list?.length) continue;
    const buyIdx = list[list.length - 1];
    const buy = fills[buyIdx];
    if (f.at.getTime() - buy.at.getTime() > WASH_WINDOW_MS || buy.nearValue <= 0) continue;
    const ratio = f.nearValue / buy.nearValue;
    if (ratio >= WASH_MIN_RATIO && ratio <= WASH_MAX_RATIO) {
      wash.add(buyIdx);
      wash.add(i);
      list.pop();
    }
  }
  return wash;
}

// ── Confidential trades ──────────────────────────────────────────────────────

const YOCTO_PER_NEAR = 1e24;

/** The confidential_executors fields the rank reads (amounts in yoctoNEAR). */
export interface ConfidentialExecutor {
  account_id: string;
  status: string;
  token: string | null;
  venue: string | null;
  size_yocto: string;
  amount_spent: string | null;
  fee_paid: string | null;
  returned_amount: string | null;
  opened_at: Date | string | null;
  exited_at: Date | string | null;
}

function yoctoToNear(v: unknown): number {
  try {
    return Number(BigInt(String(v ?? '0').split('.')[0])) / YOCTO_PER_NEAR;
  } catch {
    return 0;
  }
}

/**
 * A confidential position as fills, so it counts like any other NEAR trade.
 * Confidential trades never reach `fills`: each executor holds one position.
 * Buy = NEAR spent + fee, when it opened. Sell = NEAR returned on exit minus
 * the funding the buy never used (size − spent − fee), when it exited. The
 * sold event carries no NEAR value, so a sell only counts once it has exited;
 * with rounded returns the stored amount can be the first part only.
 */
export function executorFills(e: ConfidentialExecutor): RacerFill[] {
  if (!e.opened_at || e.amount_spent == null || !e.token) return [];
  const spent = yoctoToNear(e.amount_spent);
  const fee = yoctoToNear(e.fee_paid);
  if (!(spent > 0)) return [];
  const exited = !!e.exited_at && e.returned_amount != null && ['exited', 'closed'].includes(e.status);
  const base = { token: e.token, venue: e.venue || 'confidential', positionId: `exec:${e.account_id}`, positionClosed: exited };
  const fills: RacerFill[] = [{ ...base, side: 'buy', at: new Date(e.opened_at), nearValue: spent + fee }];
  if (exited) {
    const unspent = Math.max(0, yoctoToNear(e.size_yocto) - spent - fee);
    const proceeds = yoctoToNear(e.returned_amount) - unspent;
    if (proceeds > 0) fills.push({ ...base, side: 'sell', at: new Date(e.exited_at!), nearValue: proceeds });
  }
  return fills;
}

export interface RacerVolume {
  gross: number;
  /** Volume that counts for rank: gross minus wash round trips */
  net: number;
  washLegs: number;
}

export function racerVolume(fills: RacerFill[]): RacerVolume {
  const wash = washFillIndexes(fills);
  let gross = 0;
  let net = 0;
  fills.forEach((f, i) => {
    gross += f.nearValue;
    if (!wash.has(i)) net += f.nearValue;
  });
  return { gross, net, washLegs: wash.size };
}

// ── Tiers ────────────────────────────────────────────────────────────────────

export interface Tier {
  title: string;
  /** Lifetime NEAR volume where the tier starts */
  min: number;
  /** Where levels II and III start */
  levels: [number, number];
}

/** Lifetime NEAR volume bands (proposed — pending owner confirmation). */
export const TIERS: Tier[] = [
  { title: 'Rookie', min: 0, levels: [2, 5] },
  { title: 'Street Racer', min: 10, levels: [25, 50] },
  { title: 'Circuit Racer', min: 100, levels: [250, 500] },
  { title: 'Pro Driver', min: 1_000, levels: [2_000, 3_500] },
  { title: 'Grand Prix', min: 5_000, levels: [10_000, 17_500] },
  { title: 'Champion', min: 25_000, levels: [50_000, 75_000] },
  { title: 'Legend', min: 100_000, levels: [250_000, 500_000] },
];

/** Rookie I = 1 … Legend III = 21. 0 means "no rank stored yet". */
export const MAX_RANK_KEY = TIERS.length * 3;

const LEVEL_LABELS = ['I', 'II', 'III'] as const;
export type LevelLabel = (typeof LEVEL_LABELS)[number];

export interface RankInfo {
  tierIndex: number;
  title: string;
  level: 1 | 2 | 3;
  levelLabel: LevelLabel;
  /** "Circuit Racer II" */
  name: string;
  /** Monotonic: compare two ranks with this */
  key: number;
  /** Next tier title, null at Legend */
  nextTitle: string | null;
  /** "Circuit Racer III", null at Legend III */
  nextLevelName: string | null;
  /** 0–100, progress from the start of this level toward the next one */
  progressPct: number;
}

/** Lifetime volume where the rank with this key starts. */
function keyMin(key: number): number {
  const tier = TIERS[Math.floor((key - 1) / 3)];
  const level = (key - 1) % 3;
  return level === 0 ? tier.min : tier.levels[level - 1];
}

function keyName(key: number): string {
  return `${TIERS[Math.floor((key - 1) / 3)].title} ${LEVEL_LABELS[(key - 1) % 3]}`;
}

export function rankKeyFor(volume: number): number {
  const v = Number.isFinite(volume) && volume > 0 ? volume : 0;
  for (let key = MAX_RANK_KEY; key > 1; key--) {
    if (v >= keyMin(key)) return key;
  }
  return 1;
}

/**
 * Rank for a lifetime volume. `floorKey` is the best rank ever stored: the
 * result is never below it, so a lifetime rank does not drop when fills are
 * later excluded. Progress is measured from where the shown level starts.
 */
export function rankFor(volume: number, floorKey = 0): RankInfo {
  const v = Number.isFinite(volume) && volume > 0 ? volume : 0;
  const floor = Number.isInteger(floorKey) ? Math.min(MAX_RANK_KEY, Math.max(0, floorKey)) : 0;
  const key = Math.max(rankKeyFor(v), floor);
  const tierIndex = Math.floor((key - 1) / 3);
  const level = (((key - 1) % 3) + 1) as 1 | 2 | 3;
  const hasNext = key < MAX_RANK_KEY;
  const start = keyMin(key);
  const progressPct = hasNext
    ? Math.min(100, Math.max(0, Math.floor(((v - start) / (keyMin(key + 1) - start)) * 100)))
    : 100;
  return {
    tierIndex,
    title: TIERS[tierIndex].title,
    level,
    levelLabel: LEVEL_LABELS[level - 1],
    name: keyName(key),
    key,
    nextTitle: TIERS[tierIndex + 1]?.title ?? null,
    nextLevelName: hasNext ? keyName(key + 1) : null,
    progressPct,
  };
}

/** The card only boasts a percentile when it is worth sharing. */
export const MAX_SHOWN_TOP_PERCENT = 50;

/**
 * "Top X%" among NEAR racers (everyone with counted volume > 0), rounded up,
 * at least 1. Null with no volume.
 */
export function topPercent(myVolume: number, allVolumes: number[]): number | null {
  if (!(myVolume > 0)) return null;
  const racers = allVolumes.filter(v => v > 0);
  if (!racers.includes(myVolume)) racers.push(myVolume);
  const ahead = racers.filter(v => v > myVolume).length;
  return Math.max(1, Math.ceil(((ahead + 1) / racers.length) * 100));
}

// ── Finish (from PnL) ────────────────────────────────────────────────────────

export type Finish = 'bronze' | 'silver' | 'gold' | 'holo';

/** Closed positions only; buys count NEAR spent (fee included), sells NEAR back. */
function closedPositions(fills: RacerFill[]) {
  const byPos = new Map<string, { buys: number; sells: number; firstBuy: number; lastSell: number }>();
  for (const f of fills) {
    if (!f.positionClosed || !f.positionId) continue;
    const t = f.at.getTime();
    const p = byPos.get(f.positionId) ?? { buys: 0, sells: 0, firstBuy: Infinity, lastSell: -Infinity };
    if (f.side === 'buy') { p.buys += f.nearValue; p.firstBuy = Math.min(p.firstBuy, t); }
    else { p.sells += f.nearValue; p.lastSell = Math.max(p.lastSell, t); }
    byPos.set(f.positionId, p);
  }
  // No buy means no cost basis (e.g. a deposited token sold off)
  return [...byPos.values()].filter(p => p.buys > 0);
}

/** Realized ROI (%) over closed positions, net of fees. Null with no closed position. */
export function realizedRoiPct(fills: RacerFill[]): number | null {
  let spent = 0;
  let back = 0;
  for (const p of closedPositions(fills)) {
    spent += p.buys;
    back += p.sells;
  }
  return spent > 0 ? ((back - spent) / spent) * 100 : null;
}

export function finishFor(roiPct: number | null): Finish {
  if (roiPct === null || roiPct < 0) return 'bronze';
  if (roiPct < 25) return 'silver';
  if (roiPct < 100) return 'gold';
  return 'holo';
}

// ── Badges ───────────────────────────────────────────────────────────────────

export type BadgeId = 'founding' | 'streak' | 'multi_venue' | 'diamond_hands';

export const BADGE_LABELS: Record<BadgeId, string> = {
  founding: 'Founding Racer',
  streak: '7-Day Streak',
  multi_venue: 'Multi-Track',
  diamond_hands: 'Diamond Hands',
};

export const STREAK_DAYS = 7;
export const MULTI_VENUE_MIN = 3;
export const DIAMOND_MIN_HOLD_MS = 7 * 24 * 60 * 60 * 1000;
export const DIAMOND_MIN_ROI_PCT = 50;

/** Longest run of consecutive UTC days with at least one fill. */
export function longestDayStreak(fills: RacerFill[]): number {
  const days = [...new Set(fills.map(f => Math.floor(f.at.getTime() / 86_400_000)))].sort((a, b) => a - b);
  let best = 0;
  let run = 0;
  for (let i = 0; i < days.length; i++) {
    run = i > 0 && days[i] === days[i - 1] + 1 ? run + 1 : 1;
    best = Math.max(best, run);
  }
  return best;
}

export function badgesFor(fills: RacerFill[], foundingCutoff: Date | null): BadgeId[] {
  const badges: BadgeId[] = [];
  if (foundingCutoff && fills.some(f => f.at.getTime() < foundingCutoff.getTime())) badges.push('founding');
  if (longestDayStreak(fills) >= STREAK_DAYS) badges.push('streak');
  if (new Set(fills.map(f => f.venue)).size >= MULTI_VENUE_MIN) badges.push('multi_venue');
  // Held a week or more (first buy → last sell) and closed at +50% or better
  if (closedPositions(fills).some(p =>
    p.lastSell - p.firstBuy >= DIAMOND_MIN_HOLD_MS && ((p.sells - p.buys) / p.buys) * 100 >= DIAMOND_MIN_ROI_PCT,
  )) badges.push('diamond_hands');
  return badges;
}

// ── Profile ──────────────────────────────────────────────────────────────────

export interface RacerProfile {
  hasTrades: boolean;
  volume: RacerVolume;
  /** Shown rank: the better of the stored best and the computed one */
  rank: RankInfo;
  /** Rank from the current fills alone, ignoring the stored best */
  computedKey: number;
  /** Null when there is nothing worth showing (no volume, or outside the top half) */
  topPercent: number | null;
  finish: Finish;
  badges: BadgeId[];
}

export function buildRacerProfile(
  fills: RacerFill[],
  allNetVolumes: number[],
  foundingCutoff: Date | null,
  storedBestKey = 0,
): RacerProfile {
  const volume = racerVolume(fills);
  const top = topPercent(volume.net, allNetVolumes);
  return {
    hasTrades: fills.length > 0,
    volume,
    rank: rankFor(volume.net, storedBestKey),
    computedKey: rankKeyFor(volume.net),
    topPercent: top !== null && top <= MAX_SHOWN_TOP_PERCENT ? top : null,
    finish: finishFor(realizedRoiPct(fills)),
    badges: badgesFor(fills, foundingCutoff),
  };
}

/** Rank key from every fill except the most recent one (0 with no fills). */
export function rankKeyBeforeLatestFill(fills: RacerFill[]): number {
  if (!fills.length) return 0;
  let latest = 0;
  fills.forEach((f, i) => { if (f.at.getTime() >= fills[latest].at.getTime()) latest = i; });
  return rankKeyFor(racerVolume(fills.filter((_, i) => i !== latest)).net);
}

// ── Rank-up announcements ────────────────────────────────────────────────────

/** Whether a move from `announcedKey` up to `key` deserves a share prompt. */
export function isAnnounceableRankUp(announcedKey: number, key: number, mode: 'level' | 'tier' = 'level'): boolean {
  if (key <= announcedKey) return false;
  if (mode === 'level') return true;
  // Tier mode: only a new tier counts. A first-ever rank (announced 0) is a tier change.
  return announcedKey === 0 || Math.floor((key - 1) / 3) > Math.floor((announcedKey - 1) / 3);
}
