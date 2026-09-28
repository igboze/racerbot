import { describe, it, expect } from 'vitest';
import {
  inFlightKey,
  tryAcquireInFlight,
  releaseInFlight,
  withInFlightGuard,
  inFlightCount,
} from './inflight.js';

describe('in-flight trade guard (Fix 4)', () => {
  it('rejects a duplicate tap for the same telegramId + token + side', () => {
    const key = inFlightKey(42, 'token.near', 'buy');
    expect(tryAcquireInFlight(key)).toBe(true);
    expect(tryAcquireInFlight(key)).toBe(false); // duplicate tap
    releaseInFlight(key);
    expect(tryAcquireInFlight(key)).toBe(true); // free again after release
    releaseInFlight(key);
    expect(inFlightCount()).toBe(0);
  });

  it('treats different sides and tokens as independent keys', () => {
    const buyKey = inFlightKey(42, 'token.near', 'buy');
    const sellKey = inFlightKey(42, 'token.near', 'sell');
    const otherTokenKey = inFlightKey(42, 'other.near', 'buy');
    expect(tryAcquireInFlight(buyKey)).toBe(true);
    expect(tryAcquireInFlight(sellKey)).toBe(true);
    expect(tryAcquireInFlight(otherTokenKey)).toBe(true);
    releaseInFlight(buyKey);
    releaseInFlight(sellKey);
    releaseInFlight(otherTokenKey);
  });

  it('normalizes token address case in the key', () => {
    expect(inFlightKey(1, 'Token.Near', 'buy')).toBe(inFlightKey(1, 'token.near', 'buy'));
  });

  it('withInFlightGuard releases the key even when fn throws', async () => {
    const key = inFlightKey(7, 'crash.near', 'buy');
    await expect(withInFlightGuard(key, async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(inFlightCount()).toBe(0);
    // A later tap can acquire again
    expect(tryAcquireInFlight(key)).toBe(true);
    releaseInFlight(key);
  });

  it('withInFlightGuard reports ran:false on a duplicate without running fn', async () => {
    const key = inFlightKey(9, 'dup.near', 'sell');
    expect(tryAcquireInFlight(key)).toBe(true);
    let ran = false;
    const result = await withInFlightGuard(key, async () => { ran = true; });
    expect(result.ran).toBe(false);
    expect(ran).toBe(false);
    releaseInFlight(key);
  });
});
