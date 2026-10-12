import { describe, it, expect } from 'vitest';
import {
  calculateMinAmountOut,
  calculateExpectedOutput,
  calculateMinOutAdj,
  parseMemeCookingId,
  getPlatformFeeBps,
  getPlatformFeeRatio,
} from './utils.js';

describe('utils: fee and slippage math', () => {
  describe('getPlatformFeeBps & getPlatformFeeRatio (Dynamic Fees)', () => {
    it('charges 1.5% (150 bps) for all buys regardless of amount', () => {
      expect(getPlatformFeeBps(true, 50)).toBe(150n);
      expect(getPlatformFeeBps(true, 200)).toBe(150n);
      expect(getPlatformFeeBps(true, 500)).toBe(150n);
      expect(getPlatformFeeBps(true, 5000)).toBe(150n);
      expect(getPlatformFeeRatio(true, 500)).toBe(0.015);
    });

    it('charges 1.5% (150 bps) for sells <= $200 USD', () => {
      expect(getPlatformFeeBps(false, 50)).toBe(150n);
      expect(getPlatformFeeBps(false, 199.99)).toBe(150n);
      expect(getPlatformFeeBps(false, 200)).toBe(150n);
      expect(getPlatformFeeRatio(false, 200)).toBe(0.015);
    });

    it('charges 2.0% (200 bps) for sells above $200 USD', () => {
      expect(getPlatformFeeBps(false, 200.01)).toBe(200n);
      expect(getPlatformFeeBps(false, 250)).toBe(200n);
      expect(getPlatformFeeBps(false, 1000)).toBe(200n);
      expect(getPlatformFeeRatio(false, 1000)).toBe(0.02);
    });
  });
  describe('calculateMinAmountOut & calculateExpectedOutput', () => {
    it('calculates normal buy at 2% slippage', () => {
      // 1000 tokens expected -> 2% slippage -> 980 minimum tokens
      const expectedOutput = '1000000000000000000'; // 1 token (18 decimals)
      const minOut = calculateMinAmountOut(expectedOutput, 2);
      expect(minOut).toBe('980000000000000000');
    });

    it('calculates normal sell at 2% slippage', () => {
      // 5 NEAR expected in yoctoNEAR -> 2% slippage -> 4.9 NEAR
      const expectedOutput = 5_000_000_000_000_000_000_000_000n;
      const minOut = calculateMinAmountOut(expectedOutput, 2);
      const expected = (5_000_000_000_000_000_000_000_000n * 9800n) / 10000n;
      expect(minOut).toBe(expected.toString());
    });

    it('calculates 5% stop-loss default slippage', () => {
      // 1000 units -> 5% slippage -> 950 units
      const expectedOutput = '1000000';
      const minOut = calculateMinAmountOut(expectedOutput, 5);
      expect(minOut).toBe('950000');
    });

    it('throws or returns explicit error on zero-liquidity pool input', () => {
      const amountIn = '1000000000000000000';
      // reserveIn is 0
      expect(() => calculateExpectedOutput(amountIn, '0', '1000000')).toThrow(/positive/i);
      // reserveOut is 0
      expect(() => calculateExpectedOutput(amountIn, '1000000', '0')).toThrow(/positive/i);
      // both 0
      expect(() => calculateExpectedOutput(amountIn, '0', '0')).toThrow(/positive/i);
    });
  });

  describe('fee-rescaling logic (minOutAdj calculation)', () => {
    // 1.5% fee = 150 bps => 98.5% (9850 / 10000)
    it('calculates exact rescaled minimum for small amount magnitude', () => {
      const amountIn = '10000'; // 10,000 units
      const minAmountOut = '50000';
      const adj = calculateMinOutAdj(minAmountOut, amountIn);
      const feeAmount = (BigInt(amountIn) * 150n) / 10000n; // 150
      const swapAmount = BigInt(amountIn) - feeAmount; // 9850
      const expected = (BigInt(minAmountOut) * swapAmount) / BigInt(amountIn); // 49250
      expect(adj).toBe(expected.toString());
      expect(adj).toBe('49250');
    });

    it('calculates exact rescaled minimum for medium amount magnitude (1 NEAR)', () => {
      const amountIn = '1000000000000000000000000'; // 1 NEAR in yoctoNEAR
      const minAmountOut = '250000000000000000000000000'; // 250 tokens
      const adj = calculateMinOutAdj(minAmountOut, amountIn);
      const feeAmount = (BigInt(amountIn) * 150n) / 10000n;
      const swapAmount = BigInt(amountIn) - feeAmount;
      const expected = (BigInt(minAmountOut) * swapAmount) / BigInt(amountIn);
      expect(adj).toBe(expected.toString());
      expect(BigInt(adj)).toBe(246250000000000000000000000n);
    });

    it('calculates exact rescaled minimum for large amount magnitude (10,000 NEAR)', () => {
      const amountIn = '10000000000000000000000000000'; // 10,000 NEAR in yoctoNEAR
      const minAmountOut = '987654321098765432109876543210';
      const adj = calculateMinOutAdj(minAmountOut, amountIn);
      const feeAmount = (BigInt(amountIn) * 150n) / 10000n;
      const swapAmount = BigInt(amountIn) - feeAmount;
      const expected = (BigInt(minAmountOut) * swapAmount) / BigInt(amountIn);
      expect(adj).toBe(expected.toString());
      expect(BigInt(adj)).toBe((BigInt(minAmountOut) * 9850n) / 10000n);
    });
  });

  describe('parseMemeCookingId', () => {
    it('parses symbol-id format (e.g. zolanear-1726.meme-cooking.near)', () => {
      expect(parseMemeCookingId('zolanear-1726.meme-cooking.near')).toBe(1726);
      expect(parseMemeCookingId('jambo-1679.meme-cooking.near')).toBe(1679);
    });

    it('parses numeric id format (e.g. 1990.meme-cooking.near)', () => {
      expect(parseMemeCookingId('1990.meme-cooking.near')).toBe(1990);
    });

    it('parses hyphenated symbol format (e.g. my-cool-coin-42.meme-cooking.near)', () => {
      expect(parseMemeCookingId('my-cool-coin-42.meme-cooking.near')).toBe(42);
    });

    it('returns null for non-meme-cooking or invalid addresses', () => {
      expect(parseMemeCookingId('wrap.near')).toBeNull();
      expect(parseMemeCookingId('invalid-address.near')).toBeNull();
      expect(parseMemeCookingId('notanumber.meme-cooking.near')).toBeNull();
    });
  });
});
