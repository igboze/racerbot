import { describe, expect, it } from 'vitest';
import { isStockQuote } from './intentsRoute.js';

describe('stock pairs', () => {
  it('recognises tokenized stocks and assets as quote tokens', () => {
    expect(isStockQuote('nttwo.rwa.assetize.near')).toBe(true);
    expect(isStockQuote('bnb-0xa9ee28c80f960b889dfbd1902055218cba016f75.omdep.near')).toBe(true);
  });
  it('leaves ordinary quote tokens to the on-chain route', () => {
    expect(isStockQuote('wrap.near')).toBe(false);
    expect(isStockQuote('prl.omft.near')).toBe(false);
    expect(isStockQuote('usdc.near')).toBe(false);
  });
});
