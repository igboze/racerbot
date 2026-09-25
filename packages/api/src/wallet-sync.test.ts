import { describe, it, expect } from 'vitest';

describe('Token Sync Balance Conversion - Unit Tests', () => {
  it('correctly converts raw yocto balance to human-readable quantity', () => {
    // Simulate FastNEAR API response with raw balance
    const rawBalance = '100000000000000000000'; // 100 tokens with 18 decimals
    const decimals = 18;

    const rawBalanceBigInt = BigInt(rawBalance);
    const humanBalance = Number(rawBalanceBigInt) / Math.pow(10, decimals);

    expect(humanBalance).toBe(100);
  });

  it('correctly converts balance with different decimals', () => {
    // Test with 6 decimals (like USDT)
    const rawBalance = '50000000'; // 50 tokens with 6 decimals
    const decimals = 6;

    const rawBalanceBigInt = BigInt(rawBalance);
    const humanBalance = Number(rawBalanceBigInt) / Math.pow(10, decimals);

    expect(humanBalance).toBe(50);
  });

  it('correctly converts balance with 24 decimals (NEAR)', () => {
    // Test with 24 decimals (NEAR native)
    const rawBalance = '5000000000000000000000000'; // 5 NEAR with 24 decimals
    const decimals = 24;

    const rawBalanceBigInt = BigInt(rawBalance);
    const humanBalance = Number(rawBalanceBigInt) / Math.pow(10, decimals);

    expect(humanBalance).toBeCloseTo(5, 10);
  });

  it('handles very small balances correctly', () => {
    // Test with very small balance
    const rawBalance = '1000000'; // 0.001 tokens with 9 decimals
    const decimals = 9;

    const rawBalanceBigInt = BigInt(rawBalance);
    const humanBalance = Number(rawBalanceBigInt) / Math.pow(10, decimals);

    expect(humanBalance).toBe(0.001);
  });

  it('handles zero balance correctly', () => {
    const rawBalance = '0';
    const decimals = 18;

    const rawBalanceBigInt = BigInt(rawBalance);
    const humanBalance = Number(rawBalanceBigInt) / Math.pow(10, decimals);

    expect(humanBalance).toBe(0);
  });

  it('handles large balances correctly', () => {
    const rawBalance = '1000000000000000000000000000'; // 1 billion tokens with 18 decimals
    const decimals = 18;

    const rawBalanceBigInt = BigInt(rawBalance);
    const humanBalance = Number(rawBalanceBigInt) / Math.pow(10, decimals);

    expect(humanBalance).toBe(1000000000);
  });
});
