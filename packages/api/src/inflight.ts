/**
 * In-memory in-flight trade guard.
 *
 * Keyed by telegramId + tokenAddress + side. If a user taps Buy/Sell twice
 * for the same token while one trade is running, the second tap gets an
 * immediate answer instead of stacking two trades (and two nonce-consuming
 * transactions) behind the account lock.
 *
 * Pure in-memory + exported for unit testing. In a multi-replica deployment
 * the Redis account lock remains the cross-process backstop; this guard is
 * for fast, user-visible duplicate rejection.
 */

const inFlight = new Set<string>();

export function inFlightKey(telegramId: number, tokenAddress: string, side: 'buy' | 'sell'): string {
  return `${telegramId}:${tokenAddress.toLowerCase()}:${side}`;
}

/** Returns true when the key was free and is now claimed; false when busy. */
export function tryAcquireInFlight(key: string): boolean {
  if (inFlight.has(key)) return false;
  inFlight.add(key);
  return true;
}

export function releaseInFlight(key: string): void {
  inFlight.delete(key);
}

/** Run fn under the in-flight guard, releasing in a finally block. */
export async function withInFlightGuard<T>(
  key: string,
  fn: () => Promise<T>
): Promise<{ ran: true; result: T } | { ran: false }> {
  if (!tryAcquireInFlight(key)) {
    return { ran: false };
  }
  try {
    return { ran: true, result: await fn() };
  } finally {
    releaseInFlight(key);
  }
}

/** Test helper — current size of the guard set. */
export function inFlightCount(): number {
  return inFlight.size;
}
