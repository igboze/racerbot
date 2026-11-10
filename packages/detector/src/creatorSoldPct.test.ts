import { describe, it, expect } from 'vitest';
import { soldPctFromBalances } from './copyTrade.js';

describe('share of a position an Alpha caller sold', () => {
  it('is the tokens sold over what they held before', () => {
    expect(soldPctFromBalances(25n, 75n)).toBe(25);
    expect(soldPctFromBalances(100n, 0n)).toBe(100);
    expect(soldPctFromBalances(1n, 999n)).toBe(1);
    expect(soldPctFromBalances(0n, 10n)).toBeNull();
  });
});
