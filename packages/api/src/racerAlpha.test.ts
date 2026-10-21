import { describe, expect, it } from 'vitest';
import { splitAlphaKeyPayment } from './alphaPayment.js';

describe('RacerAlpha viewing-key payment split', () => {
  it('splits creator and treasury payments exactly in yoctoNEAR', () => {
    const split = splitAlphaKeyPayment(2);

    expect(split.totalYocto).toBe(2n * 10n ** 24n);
    expect(split.creatorYocto).toBe(19n * 10n ** 23n);
    expect(split.treasuryYocto).toBe(1n * 10n ** 23n);
    expect(split.creatorYocto + split.treasuryYocto).toBe(split.totalYocto);
  });

  it('routes the full demo-listing payment to treasury', () => {
    const split = splitAlphaKeyPayment(3.5, true);

    expect(split.creatorYocto).toBe(0n);
    expect(split.treasuryYocto).toBe(split.totalYocto);
  });

  it('rejects invalid prices before attempting a transfer', () => {
    expect(() => splitAlphaKeyPayment(0)).toThrow('Viewing key price');
    expect(() => splitAlphaKeyPayment(0.001)).toThrow('Viewing key price');
    expect(() => splitAlphaKeyPayment(Number.NaN)).toThrow('Viewing key price');
  });
});
