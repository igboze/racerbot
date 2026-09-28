import { randomUUID } from 'crypto';
import type { RedisClient } from './redis.js';
import { clearAccessKeyCache } from './near.js';

export const LOCK_CONTENTION_ERROR =
  'Another transaction is already in progress for this wallet — please wait a moment and try again';

export const LOCK_ACQUISITION_TIMEOUT_ERROR =
  'Timed out while preparing your transaction (wallet lock). The network is congested — please retry.';

/**
 * Thrown when Redis itself is broken (commands erroring), as opposed to the
 * lock being genuinely held by another in-flight trade. The old code conflated
 * the two — every Redis outage surfaced to users as "Another transaction is
 * already in progress", which was both wrong and unactionable.
 */
export const LOCK_STORAGE_UNAVAILABLE_ERROR =
  'Trade coordination storage is temporarily unavailable — please retry in a few seconds.';

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
  /** TTL in milliseconds. Default: 30_000 (30 seconds) */
  ttlMs?: number;
  /** Maximum acquisition attempts (initial attempt + retries). Default: 20 */
  maxAttempts?: number;
  /** Delay between attempts in milliseconds. Default: 100 */
  retryDelayMs?: number;
  /** Callback fired when lock was acquired after contention (attempts > 1) */
  onContended?: (accountId: string) => void | Promise<void>;
}

const inMemoryLocks = new Map<string, Promise<void>>();

/**
 * Fallback mutex per accountId when Redis is unavailable/offline.
 * Prevents transaction collisions in single-instance environments even if Redis fails.
 */
async function withInMemoryLock<T>(
  accountId: string,
  fn: () => Promise<T>,
  ttlMs = 30_000
): Promise<T> {
  const lockKey = `lock:swap:${accountId}`;
  const t0 = Date.now();
  console.log(`[LOCK:IN-MEM] Requesting in-memory lock for ${lockKey}`);

  while (inMemoryLocks.has(accountId)) {
    try {
      await inMemoryLocks.get(accountId);
    } catch {
      // previous lock settled with error
    }
  }

  let releaseLock: () => void = () => {};
  const lockPromise = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });

  const timer = setTimeout(() => {
    if (inMemoryLocks.get(accountId) === lockPromise) {
      console.warn(`[LOCK:IN-MEM] In-memory lock for ${lockKey} expired after ${ttlMs}ms`);
      inMemoryLocks.delete(accountId);
    }
    releaseLock();
  }, ttlMs);

  inMemoryLocks.set(accountId, lockPromise);
  console.log(`[LOCK:IN-MEM] In-memory lock acquired for ${lockKey} in ${Date.now() - t0}ms`);

  try {
    return await fn();
  } finally {
    clearTimeout(timer);
    if (inMemoryLocks.get(accountId) === lockPromise) {
      inMemoryLocks.delete(accountId);
    }
    releaseLock();
    console.log(`[LOCK:IN-MEM] In-memory lock released for ${lockKey}`);
  }
}

/**
 * Executes an async action protected by a distributed Redis lock per accountId.
 * Lock key: lock:swap:<accountId>
 * Lock TTL: 30_000ms (30 seconds, matches trade deadline)
 *
 * Safe release: only deletes the lock if the stored token matches the caller's token.
 * Contention: retries up to maxAttempts (20) with retryDelayMs (100ms) — ~2s
 * window, but a contending trade picks the lock up within 100ms of it
 * being released.
 */
export async function withAccountLock<T>(
  redis: RedisClient,
  accountId: string,
  fn: () => Promise<T>,
  options?: LockOptions
): Promise<T> {
  const ttlMs = options?.ttlMs ?? 30_000;
  const maxAttempts = options?.maxAttempts ?? 20;
  const retryDelayMs = options?.retryDelayMs ?? 100;
  const lockKey = `lock:swap:${accountId}`;
  const token = randomUUID();
  const t0 = Date.now();

  // If Redis is explicitly offline or not ready, fallback to in-memory lock
  // so trades never hang for 8s and fail when Redis is unavailable.
  if (typeof redis.isConnected === 'function' && !redis.isConnected()) {
    const status = typeof redis.getStatus === 'function' ? redis.getStatus() : 'unknown';
    console.warn(`[LOCK] Redis client not ready (status: ${status}). Falling back to in-memory lock for ${accountId}.`);
    return withInMemoryLock(accountId, fn, ttlMs);
  }

  console.log(`[LOCK] Requesting lock for account=${accountId}, key=${lockKey}, ttl=${ttlMs}ms`);

  let acquired = false;
  let attempts = 0;
  let timedOut = false;
  // Track WHY acquisition failed: a clean `false` from Redis means another
  // trade genuinely holds the lock; a thrown error means Redis itself is
  // misbehaving and must be reported honestly (not as lock contention).
  let sawGenuineContention = false;
  let lastRedisError: unknown = null;

  const releaseLock = async () => {
    try {
      if (typeof redis.eval === 'function') {
        await redis.eval(RELEASE_LOCK_SCRIPT, 1, lockKey, token);
      } else {
        const current = await redis.get(lockKey);
        if (current === token) {
          await redis.del(lockKey);
        }
      }
      console.log(`[LOCK] Lock released for ${lockKey} in ${Date.now() - t0}ms`);
    } catch (err: any) {
      console.warn(`[LOCK] Failed to release lock ${lockKey}:`, err?.message);
    }
  };

  const acquisition = (async () => {
    for (let i = 1; i <= maxAttempts; i++) {
      if (timedOut) break;
      attempts = i;
      try {
        if (typeof redis.setNxPx === 'function') {
          acquired = await redis.setNxPx(lockKey, token, ttlMs);
        } else {
          const res = await (redis as any).set(lockKey, token, 'PX', ttlMs, 'NX');
          acquired = res === 'OK' || res === true;
        }
        if (!acquired) sawGenuineContention = true;
      } catch (err: any) {
        lastRedisError = err;
        console.warn(`[LOCK] Attempt ${i}/${maxAttempts} for ${lockKey} error:`, err?.message || err);
        acquired = false;
      }

      if (timedOut) {
        // If the timeout fired while the Redis command was in flight, and the
        // command ended up acquiring the lock, immediately release it so no
        // orphaned lock is left in Redis.
        if (acquired) {
          await releaseLock();
          acquired = false;
        }
        break;
      }

      if (acquired) {
        console.log(`[LOCK] Lock acquired for ${lockKey} on attempt ${attempts} in ${Date.now() - t0}ms`);
        break;
      }

      if (i < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  })();

  // Hard ceiling: even if Redis commands hang (connection drop, lost reply),
  // acquisition must give up within ACQUISITION_TIMEOUT_MS.
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      const elapsed = Date.now() - t0;
      const redisStatus = typeof redis.getStatus === 'function' ? redis.getStatus() : 'unknown';
      console.error(`[LOCK] TIMEOUT after ${elapsed}ms acquiring ${lockKey} (attempts: ${attempts}, redisStatus: ${redisStatus})`);
      reject(new Error(LOCK_ACQUISITION_TIMEOUT_ERROR));
    }, ACQUISITION_TIMEOUT_MS);
  });

  try {
    await Promise.race([acquisition, timeout]);
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
  }

  if (!acquired) {
    // Every attempt errored (never a clean "key exists" answer) → Redis is
    // down/misconfigured, not contended. Say so instead of blaming another
    // in-flight transaction that doesn't exist.
    if (!sawGenuineContention && lastRedisError) {
      console.warn(`[LOCK] Redis errors during lock acquisition for ${lockKey}:`, (lastRedisError as any)?.message);
      throw new Error(LOCK_STORAGE_UNAVAILABLE_ERROR);
    }
    console.warn(`[LOCK] Contention: failed to acquire ${lockKey} after ${attempts} attempts in ${Date.now() - t0}ms`);
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
    await releaseLock();
  }
}
