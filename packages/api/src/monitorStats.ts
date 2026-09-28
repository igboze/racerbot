import type { TradeAttemptRow } from '@racerbot/db';

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
