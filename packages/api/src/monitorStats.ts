import type { TradeAttemptRow, VolumeStats } from '@racerbot/db';

export interface AttemptSummary {
  total: number;
  failed: number;
  failureRatePct: number;
  topReasons: Array<[string, number]>;
  venueFailures: Record<string, { attempts: number; failed: number }>;
  timing: {
    presignAvg: number | null;
    signAvg: number | null;
    signP90: number | null;
    postAvg: number | null;
  };
  slowest: TradeAttemptRow[];
}

function avg(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/** Truncate long error strings to a compact reason key. */
function reasonKey(error: string | null): string {
  if (!error) return 'unknown';
  const e = error.trim();
  if (e.length === 0) return 'unknown';
  return e.length > 120 ? e.slice(0, 120) + '…' : e;
}

/**
 * Pure aggregation over a set of trade attempts. No I/O — fully unit-testable.
 * Rows are expected newest-first (as returned by getRecentTradeAttempts) but
 * ordering does not affect the aggregates.
 */
export function summarizeAttempts(rows: TradeAttemptRow[], limitSlowest = 5): AttemptSummary {
  const total = rows.length;
  const failedRows = rows.filter((r) => r.status === 'failed');

  const reasonCounts = new Map<string, number>();
  for (const r of failedRows) {
    const key = reasonKey(r.error);
    reasonCounts.set(key, (reasonCounts.get(key) || 0) + 1);
  }
  const topReasons = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1]);

  const venueFailures: Record<string, { attempts: number; failed: number }> = {};
  for (const r of rows) {
    const v = r.venue || 'unknown';
    if (!venueFailures[v]) venueFailures[v] = { attempts: 0, failed: 0 };
    venueFailures[v].attempts += 1;
    if (r.status === 'failed') venueFailures[v].failed += 1;
  }

  const presign: number[] = [];
  const sign: number[] = [];
  const post: number[] = [];
  for (const r of rows) {
    const t = r.timings;
    if (!t) continue;
    if (typeof t.presign_ms === 'number') presign.push(t.presign_ms);
    if (typeof t.sign_ms === 'number') sign.push(t.sign_ms);
    if (typeof t.post_ms === 'number') post.push(t.post_ms);
  }
  const signSorted = [...sign].sort((a, b) => a - b);

  const slowest = [...rows]
    .filter((r) => typeof r.timings?.sign_ms === 'number')
    .sort((a, b) => (b.timings!.sign_ms ?? 0) - (a.timings!.sign_ms ?? 0))
    .slice(0, limitSlowest);

  return {
    total,
    failed: failedRows.length,
    failureRatePct: total === 0 ? 0 : Math.round((failedRows.length / total) * 1000) / 10,
    topReasons,
    venueFailures,
    timing: {
      presignAvg: avg(presign),
      signAvg: avg(sign),
      signP90: percentile(signSorted, 90),
      postAvg: avg(post),
    },
    slowest,
  };
}

/** Compact one-line-per-reason formatter used by both alerts and /failures. */
export function formatReasons(topReasons: Array<[string, number]>, max = 3): string {
  if (topReasons.length === 0) return 'none';
  return topReasons
    .slice(0, max)
    .map(([reason, count]) => `×${count} ${reason}`)
    .join('\n');
}

// ── Daily volume update formatting ──────────────────────────────────────────

/**
 * Admin volume report: every chain in its own coin, then all chains together
 * in USD (the only unit they share). A chain whose price can't be fetched is
 * left out of the USD total, and the report says so.
 * HyperEVM and Elysium both trade against HYPE, so `hypeUsd` prices both.
 */
export function buildVolumeUpdateText(
  s: VolumeStats,
  nearUsd: number,
  suiUsd = 0,
  strkUsd = 0,
  solUsd = 0,
  hypeUsd = 0,
): string {
  const amt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  const usd = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  const approx = (n: number, price: number) => (price > 0 ? ` (~${usd(n * price)})` : '');

  const chains = [
    { name: 'NEAR', head: '〽️ *NEAR — 24h*', unit: 'NEAR', price: nearUsd, v24: s.volume24hNear, t24: s.trades24h, vAll: s.volumeTotalNear, tAll: s.tradesTotal },
    { name: 'SUI', head: '🔵 *SUI — 24h*', unit: 'SUI', price: suiUsd, v24: s.volume24hSui, t24: s.trades24hSui, vAll: s.volumeTotalSui, tAll: s.tradesTotalSui },
    { name: 'Starknet', head: '⚡ *Starknet — 24h*', unit: 'STRK', price: strkUsd, v24: s.volume24hStarknet || 0, t24: s.trades24hStarknet || 0, vAll: s.volumeTotalStarknet || 0, tAll: s.tradesTotalStarknet || 0 },
    { name: 'Solana', head: '🟣 *Solana — 24h*', unit: 'SOL', price: solUsd, v24: s.volume24hSolana || 0, t24: s.trades24hSolana || 0, vAll: s.volumeTotalSolana || 0, tAll: s.tradesTotalSolana || 0 },
    { name: 'HyperEVM', head: '🟢 *HyperEVM — 24h*', unit: 'HYPE', price: hypeUsd, v24: s.volume24hHyperevm || 0, t24: s.trades24hHyperevm || 0, vAll: s.volumeTotalHyperevm || 0, tAll: s.tradesTotalHyperevm || 0 },
    { name: 'Elysium', head: '🏛 *Elysium (Kleos) — 24h*', unit: 'HYPE', price: hypeUsd, v24: s.volume24hElysium || 0, t24: s.trades24hElysium || 0, vAll: s.volumeTotalElysium || 0, tAll: s.tradesTotalElysium || 0 },
  ];

  const total24hTrades = chains.reduce((n, c) => n + c.t24, 0);
  const totalTrades = chains.reduce((n, c) => n + c.tAll, 0);
  const usd24h = chains.reduce((n, c) => n + (c.price > 0 ? c.v24 * c.price : 0), 0);
  const usdAll = chains.reduce((n, c) => n + (c.price > 0 ? c.vAll * c.price : 0), 0);
  const unpriced = chains.filter(c => !(c.price > 0) && (c.v24 > 0 || c.vAll > 0)).map(c => c.name);

  const perChain = chains.map(c =>
    `${c.head}\n` +
    `• Volume: \`${amt(c.v24)} ${c.unit}\`${approx(c.v24, c.price)}\n` +
    `• Trades: \`${c.t24}\`\n\n`,
  ).join('');
  const allTime = chains.map(c => `• ${c.name} volume: \`${amt(c.vAll)} ${c.unit}\`${approx(c.vAll, c.price)}\n`).join('');

  return (
    `📊 *RacerBot Daily Report*\n\n` +

    `👥 *Users*\n` +
    `• Total: \`${s.usersTotal.toLocaleString('en-US')}\`\n` +
    `• New today: \`${s.newUsers24h}\`\n\n` +

    `🔥 *Last 24h*\n` +
    `• Total trades: \`${total24hTrades}\` (${s.buys24h} buys / ${s.sells24h} sells)\n` +
    `• Active traders: \`${s.activeTraders24h}\`\n\n` +

    `💰 *All chains together (USD)*\n` +
    `• 24h volume: \`${usd(usd24h)}\`\n` +
    `• All-time volume: \`${usd(usdAll)}\`\n` +
    (unpriced.length ? `• _No price right now for ${unpriced.join(', ')}: not in these totals_\n` : '') +
    `\n` +

    perChain +

    `📈 *All Time*\n` +
    allTime +
    `• Total trades: \`${totalTrades.toLocaleString('en-US')}\``
  );
}
