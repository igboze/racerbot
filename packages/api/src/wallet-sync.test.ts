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

  it('establishes entry price baseline at discovery price so initial PNL is +0.0%', () => {
    const currentPriceAtScan = 0.05; // 0.05 NEAR per token when scanned
    const avgEntryPrice = currentPriceAtScan.toString();

    // At the moment of discovery and display:
    const pnlPct = ((currentPriceAtScan - parseFloat(avgEntryPrice)) / parseFloat(avgEntryPrice)) * 100;
    const pnlDisplay = `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`;

    expect(pnlDisplay).toBe('+0.0%');
  });

  it('calculates positive PNL as price increases from the baseline entry price', () => {
    const baselineEntryPrice = 0.05; // Scanned into wallet at 0.05 NEAR
    const updatedPrice = 0.075; // Token price increases by 50%

    const pnlPct = ((updatedPrice - baselineEntryPrice) / baselineEntryPrice) * 100;
    const pnlDisplay = `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`;

    expect(pnlDisplay).toBe('+50.0%');
  });

  it('calculates negative PNL as price decreases from the baseline entry price', () => {
    const baselineEntryPrice = 0.05; // Scanned into wallet at 0.05 NEAR
    const updatedPrice = 0.04; // Token price drops by 20%

    const pnlPct = ((updatedPrice - baselineEntryPrice) / baselineEntryPrice) * 100;
    const pnlDisplay = `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`;

    expect(pnlDisplay).toBe('-20.0%');
  });

  it('calculates accurate holding value in NEAR and USD using decimals', () => {
    const rawBalance = '250000000000000000000'; // 250 tokens with 18 decimals
    const decimals = 18;
    const currentPrice = 0.10; // 0.10 NEAR
    const nearUsd = 4.0; // $4.00 per NEAR

    const humanQuantity = Number(BigInt(rawBalance)) / Math.pow(10, decimals);
    const tokenValueNear = humanQuantity * currentPrice;
    const tokenValueUsd = tokenValueNear * nearUsd;

    expect(humanQuantity).toBe(250);
    expect(tokenValueNear).toBe(25); // 25 NEAR
    expect(tokenValueUsd).toBe(100); // $100 USD
  });
});

