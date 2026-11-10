import { describe, it, expect } from 'vitest';
import { splitFleetBuy, FLEET_BUY_FEE_BPS } from './raceFleet.js';

describe('fleet bundle buy fee', () => {
  it('takes 1.5% of each wallet buy and swaps the rest', () => {
    const one = 10n ** 24n;
    expect(FLEET_BUY_FEE_BPS).toBe(150n);
    expect(splitFleetBuy(one)).toEqual({ swapYocto: (one * 985n) / 1000n, feeYocto: (one * 15n) / 1000n });
  });
});
