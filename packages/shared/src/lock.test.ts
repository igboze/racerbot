import { describe, it, expect, vi, afterEach } from 'vitest';
import { withAccountLock, LOCK_CONTENTION_ERROR, LOCK_ACQUISITION_TIMEOUT_ERROR } from './lock.js';
import type { RedisClient } from './redis.js';

function createMockRedis(): RedisClient {
  const store = new Map<string, { value: string; expiresAt?: number }>();

  return {
    async publish() {
      return 1;
    },
    async subscribe() {},
    async unsubscribe() {},
    async get(key: string) {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt && entry.expiresAt < Date.now()) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key: string, value: string, ttlSeconds?: number) {
      store.set(key, {
        value,
        expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined,
      });
    },
    async setNxPx(key: string, value: string, ttlMs: number) {
      const entry = store.get(key);
      const isExpired = entry?.expiresAt && entry.expiresAt < Date.now();
      if (!entry || isExpired) {
        store.set(key, {
          value,
          expiresAt: Date.now() + ttlMs,
        });
        return true;
      }
      return false;
    },
    async eval(script: string, numkeys: number, ...args: (string | number)[]) {
      const key = String(args[0]);
      const token = String(args[1]);
      const entry = store.get(key);
      if (entry && entry.value === token) {
        store.delete(key);
        return 1;
      }
      return 0;
    },
    async del(key: string) {
      store.delete(key);
    },
    async hget() {
      return null;
    },
    async hset() {},
    async hgetall() {
      return {};
    },
    async sadd() {
      return 1;
    },
    async smembers() {
      return [];
    },
    async disconnect() {},
  };
}

describe('withAccountLock', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects with timeout error when a Redis command never resolves (connection drop)', async () => {
    vi.useFakeTimers();

    // Simulates a hung ioredis command queue: setNxPx never settles,
    // which previously made withAccountLock wait forever.
    const hungRedis: RedisClient = {
      ...createMockRedis(),
      async setNxPx(): Promise<boolean> {
        return new Promise<boolean>(() => {});
      },
    };

    const promise = withAccountLock(hungRedis, 'user-sub-hang.racer.near', async () => 'never');
    const assertion = expect(promise).rejects.toThrow(LOCK_ACQUISITION_TIMEOUT_ERROR);

    await vi.advanceTimersByTimeAsync(8_000);
    await assertion;
  });

  it('acquires the lock, runs fn, and releases the lock', async () => {
    const redis = createMockRedis();
    const accountId = 'user-sub-1.racer.near';

    let executed = false;
    const result = await withAccountLock(redis, accountId, async () => {
      executed = true;
      // Lock key should exist in redis during execution
      const inLock = await redis.get(`lock:swap:${accountId}`);
      expect(inLock).toBeTruthy();
      return 'ok';
    });

    expect(executed).toBe(true);
    expect(result).toBe('ok');
    // Lock should be released after execution
    const after = await redis.get(`lock:swap:${accountId}`);
    expect(after).toBeNull();
  });

  it('releases lock even when fn throws', async () => {
    const redis = createMockRedis();
    const accountId = 'user-sub-2.racer.near';

    await expect(
      withAccountLock(redis, accountId, async () => {
        throw new Error('On-chain simulation failure');
      })
    ).rejects.toThrow('On-chain simulation failure');

    // Account must not be left locked
    const after = await redis.get(`lock:swap:${accountId}`);
    expect(after).toBeNull();

    // A subsequent lock attempt should succeed immediately
    const nextResult = await withAccountLock(redis, accountId, async () => 'next-ok');
    expect(nextResult).toBe('next-ok');
  });

  it('serializes concurrent operations for the same accountId', async () => {
    const redis = createMockRedis();
    const accountId = 'user-sub-3.racer.near';

    const events: string[] = [];

    const op1 = withAccountLock(
      redis,
      accountId,
      async () => {
        events.push('op1:start');
        await new Promise((r) => setTimeout(r, 60));
        events.push('op1:end');
        return 'op1-done';
      },
      { retryDelayMs: 20 }
    );

    const op2 = withAccountLock(
      redis,
      accountId,
      async () => {
        events.push('op2:start');
        await new Promise((r) => setTimeout(r, 20));
        events.push('op2:end');
        return 'op2-done';
      },
      { retryDelayMs: 20 }
    );

    const [res1, res2] = await Promise.all([op1, op2]);

    expect(res1).toBe('op1-done');
    expect(res2).toBe('op2-done');
    // op1 started and completed before op2 started
    expect(events).toEqual(['op1:start', 'op1:end', 'op2:start', 'op2:end']);
  });

  it('clears access key cache ONLY when lock acquisition required > 1 attempt (contended)', async () => {
    const redis = createMockRedis();
    const accountId = 'user-sub-4.racer.near';
    const onContended1 = vi.fn();
    const onContended2 = vi.fn();

    const op1 = withAccountLock(
      redis,
      accountId,
      async () => {
        await new Promise((r) => setTimeout(r, 50));
        return 'op1';
      },
      { retryDelayMs: 15, onContended: onContended1 }
    );

    const op2 = withAccountLock(
      redis,
      accountId,
      async () => 'op2',
      { retryDelayMs: 15, onContended: onContended2 }
    );

    await Promise.all([op1, op2]);

    // op1 acquired on first attempt (uncontended) -> onContended not called
    expect(onContended1).not.toHaveBeenCalled();
    // op2 contended against op1 (attempts > 1) -> onContended called with accountId
    expect(onContended2).toHaveBeenCalledWith(accountId);
  });

  it('fails with specific message when lock cannot be acquired within retry budget', async () => {
    const redis = createMockRedis();
    const accountId = 'user-sub-5.racer.near';

    // Pre-lock the key
    await redis.setNxPx(`lock:swap:${accountId}`, 'external-token', 100_000);

    await expect(
      withAccountLock(
        redis,
        accountId,
        async () => 'never-reached',
        { maxAttempts: 3, retryDelayMs: 10 }
      )
    ).rejects.toThrow(LOCK_CONTENTION_ERROR);
  });

  it('does not release another holder lock if token changed (TTL expiration scenario)', async () => {
    const redis = createMockRedis();
    const accountId = 'user-sub-6.racer.near';

    await withAccountLock(
      redis,
      accountId,
      async () => {
        // Simulate lock expired and another process acquired it with a different token
        await redis.del(`lock:swap:${accountId}`);
        await redis.setNxPx(`lock:swap:${accountId}`, 'other-process-token', 100_000);
      }
    );

    // The other process's lock should still exist
    const current = await redis.get(`lock:swap:${accountId}`);
    expect(current).toBe('other-process-token');
  });
});
