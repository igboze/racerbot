/**
 * In-flight trade guard — cross-replica safe via Redis SETNX.
 *
 * A local in-memory Set provides a fast first-pass reject within a single
 * process (avoids a Redis round-trip when the same user double-taps quickly).
 * A Redis NX key is the authoritative cross-process backstop so that two
 * Railway replicas cannot both start a trade for the same user+token at once.
 *
 * TTL: 220 000 ms — slightly over the TRADE_DEADLINE_MS (210 s) so the key is
 * guaranteed to be reclaimed even if the process crashes mid-trade and the
 * finally-block never runs.
 */

import type { RedisClient } from '@racerbot/shared';

const GUARD_TTL_MS = 220_000;

// Fast local dedup — avoids a Redis round-trip for rapid double-taps.
const localInFlight = new Set<string>();

// Module-level Redis client — injected once on first use.
let _redis: RedisClient | null = null;

export function setInFlightRedis(client: RedisClient): void {
  _redis = client;
}

export function inFlightKey(telegramId: number, tokenAddress: string, side: 'buy' | 'sell'): string {
  return `inflight:${telegramId}:${tokenAddress.toLowerCase()}:${side}`;
}

/**
 * Try to acquire the guard.
 * Returns true when the key was free and is now claimed; false when busy.
 * Prefers Redis when available; falls back to the local Set.
 */
export async function tryAcquireInFlight(key: string): Promise<boolean> {
  // Fast path: local check avoids a Redis RTT for in-process double-taps.
  if (localInFlight.has(key)) return false;

  if (_redis) {
    try {
      const acquired = await _redis.setNxPx(key, '1', GUARD_TTL_MS);
      if (!acquired) return false;
    } catch {
      // Redis down — fall through to local-only guard (better than blocking all trades).
    }
  }

  localInFlight.add(key);
  return true;
}

export async function releaseInFlight(key: string): Promise<void> {
  localInFlight.delete(key);
  if (_redis) {
    try {
      await _redis.del(key);
    } catch {
      // TTL will reclaim the key automatically; ignore transient errors.
    }
  }
}

/** Run fn under the in-flight guard, releasing in a finally block. */
export async function withInFlightGuard<T>(
  key: string,
  fn: () => Promise<T>
): Promise<{ ran: true; result: T } | { ran: false }> {
  if (!(await tryAcquireInFlight(key))) {
    return { ran: false };
  }
  try {
    return { ran: true, result: await fn() };
  } finally {
    await releaseInFlight(key);
  }
}

/** Test helper — current size of the local guard set. */
export function inFlightCount(): number {
  return localInFlight.size;
}
