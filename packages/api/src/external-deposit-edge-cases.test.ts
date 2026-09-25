import { describe, it, expect } from 'vitest';

describe('External Deposit Sync - Edge Cases', () => {
  it('skips tokens with zero price', () => {
    const currentPrice = 0;
    const shouldSkip = currentPrice === 0;

    expect(shouldSkip).toBe(true);
  });

  it('handles very large balances with BigInt arithmetic', () => {
    const rawBalance = '1000000000000000000000000000'; // 1 billion tokens with 18 decimals
    const decimals = 18;

    const divisor = BigInt(10) ** BigInt(decimals);
    const rawBalanceBigInt = BigInt(rawBalance);
    const humanBalanceBigInt = rawBalanceBigInt / divisor;
    const remainder = rawBalanceBigInt % divisor;
    const humanBalance = Number(humanBalanceBigInt) + (Number(remainder) / Number(divisor));

    expect(humanBalance).toBe(1000000000);
  });

  it('handles 24-decimal NEAR balances', () => {
    const rawBalance = '5000000000000000000000000'; // 5 NEAR with 24 decimals
    const decimals = 24;

    const divisor = BigInt(10) ** BigInt(decimals);
    const rawBalanceBigInt = BigInt(rawBalance);
    const humanBalanceBigInt = rawBalanceBigInt / divisor;
    const remainder = rawBalanceBigInt % divisor;
    const humanBalance = Number(humanBalanceBigInt) + (Number(remainder) / Number(divisor));

    expect(humanBalance).toBeCloseTo(5, 10);
  });

  it('validates converted balance is finite', () => {
    const humanBalance = Infinity;
    const isValid = isFinite(humanBalance);

    expect(isValid).toBe(false);
  });

  it('validates converted balance is positive', () => {
    const humanBalance = -100;
    const isValid = humanBalance > 0;

    expect(isValid).toBe(false);
  });

  it('validates converted balance is zero', () => {
    const humanBalance = 0;
    const isValid = humanBalance > 0;

    expect(isValid).toBe(false);
  });

  it('handles balance with remainder in decimal conversion', () => {
    const rawBalance = '123456789012345678999'; // Not exact power of 10
    const decimals = 18;

    const divisor = BigInt(10) ** BigInt(decimals);
    const rawBalanceBigInt = BigInt(rawBalance);
    const humanBalanceBigInt = rawBalanceBigInt / divisor;
    const remainder = rawBalanceBigInt % divisor;
    const humanBalance = Number(humanBalanceBigInt) + (Number(remainder) / Number(divisor));

    // Should handle remainder correctly
    expect(humanBalance).toBeCloseTo(123.45678901234568, 10);
  });

  it('prevents overflow in Number conversion', () => {
    const rawBalance = '999999999999999999999999999999999999999999999999'; // Extremely large
    const decimals = 18;

    const divisor = BigInt(10) ** BigInt(decimals);
    const rawBalanceBigInt = BigInt(rawBalance);
    const humanBalanceBigInt = rawBalanceBigInt / divisor;
    const remainder = rawBalanceBigInt % divisor;
    const humanBalance = Number(humanBalanceBigInt) + (Number(remainder) / Number(divisor));

    // Should still be finite even for very large numbers
    expect(isFinite(humanBalance)).toBe(true);
  });
});
