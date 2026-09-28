import { randomUUID } from 'crypto';
import type { RedisClient } from './redis.js';
import { clearAccessKeyCache } from './near.js';

export const LOCK_CONTENTION_ERROR =
  'Another transaction is already in progress for this wallet — please wait a moment and try again';

export const LOCK_ACQUISITION_TIMEOUT_ERROR =
  'Timed out while preparing your transaction (wallet lock). The network is congested — please retry.';

/** Hard cap on how long lock acquisition may take, even with Redis trouble. */
const ACQUISITION_TIMEOUT_MS = 8_000;

export const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

export interface LockOptions {
  /** TTL in milliseconds. Default: 100_000 (100 seconds) */
  ttlMs?: number;
  /** Maximum acquisition attempts (initial attempt + retries). Default: 20 */
  maxAttempts?: number;
  /** Delay between attempts in milliseconds. Default: 100 */
  retryDelayMs?: number;
  /** Callback fired when lock was acquired after contention (attempts > 1) */
  onContended?: (accountId: string) => void | Promise<void>;
}

/**
 * Executes an async action protected by a distributed Redis lock per accountId.
 * Lock key: lock:swap:<accountId>
 * Lock TTL: 100_000ms (100 seconds)
 *
 * Safe release: only deletes the lock if the stored token matches the caller's token.
 * Contention: retries up to maxAttempts (20) with retryDelayMs (100ms) — same ~2s
 * window as before, but a contending trade picks the lock up within 100ms of it
 * being released instead of up to 500ms.
 */
export async function withAccountLock<T>(
  redis: RedisClient,
  accountId: string,
  fn: () => Promise<T>,
  options?: LockOptions
): Promise<T> {
  const ttlMs = options?.ttlMs ?? 100_000;
  const maxAttempts = options?.maxAttempts ?? 20;
  const retryDelayMs = options?.retryDelayMs ?? 100;
  const lockKey = `lock:swap:${accountId}`;
  const token = randomUUID();

  let acquired = false;
  let attempts = 0;

  const acquisition = (async () => {
    for (let i = 1; i <= maxAttempts; i++) {
      attempts = i;
      try {
        if (typeof redis.setNxPx === 'function') {
          acquired = await redis.setNxPx(lockKey, token, ttlMs);
        } else {
          const res = await (redis as any).set(lockKey, token, 'PX', ttlMs, 'NX');
          acquired = res === 'OK' || res === true;
        }
      } catch {
        acquired = false;
      }

      if (acquired) {
        break;
      }

      if (i < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  })();

  // Hard ceiling: even if Redis commands hang (connection drop, lost reply),
  // acquisition must give up within ACQUISITION_TIMEOUT_MS. The stray SET may
  // still land later — the TTL (default 100s) expires it automatically.
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(LOCK_ACQUISITION_TIMEOUT_ERROR)), ACQUISITION_TIMEOUT_MS)
  );

  await Promise.race([acquisition, timeout]);

  if (!acquired) {
    throw new Error(LOCK_CONTENTION_ERROR);
  }

  // If the lock was contended (required > 1 attempt), clear access key info so
  // near-api-js re-queries the RPC for the current on-chain nonce.
  if (attempts > 1) {
    if (options?.onContended) {
      await options.onContended(accountId);
    } else {
      clearAccessKeyCache(accountId);
    }
  }

  try {
    return await fn();
  } finally {
    try {
      if (typeof redis.eval === 'function') {
        await redis.eval(RELEASE_LOCK_SCRIPT, 1, lockKey, token);
      } else {
        const current = await redis.get(lockKey);
        if (current === token) {
          await redis.del(lockKey);
        }
      }
    } catch (err: any) {
      console.warn(`[LOCK] Failed to release lock ${lockKey}:`, err?.message);
    }
  }
}
