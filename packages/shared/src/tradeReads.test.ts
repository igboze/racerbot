import { describe, it, expect } from 'vitest';
import { runAsTrade, inTrade } from './near.js';

describe('runAsTrade', () => {
  it('marks every read inside a trade, across awaits and nested calls', async () => {
    const nested = async () => { await new Promise(r => setTimeout(r, 5)); return inTrade(); };
    expect(await runAsTrade(async () => {
      await Promise.resolve();
      const [a, b] = await Promise.all([nested(), nested()]);
      return a && b && inTrade();
    })).toBe(true);
  });

  it('leaves reads outside a trade on the free-first order', async () => {
    expect(inTrade()).toBe(false);
    await runAsTrade(async () => undefined);
    expect(inTrade()).toBe(false);
  });
});
