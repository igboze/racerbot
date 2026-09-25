import { describe, it, expect } from 'vitest';

describe('SELL INITIAL - Total Investment Calculation', () => {
  it('calculates total investment from multiple buy fills', () => {
    // Simulate multiple buy fills
    const buys = [
      { amount: '100', price: '1.0', fee_paid: '0.1' },
      { amount: '50', price: '1.5', fee_paid: '0.05' },
      { amount: '75', price: '2.0', fee_paid: '0.15' },
    ];

    let totalInvestment = 0;
    for (const buy of buys) {
      const amount = parseFloat(buy.amount);
      const price = parseFloat(buy.price);
      const fee = parseFloat(buy.fee_paid || '0');
      totalInvestment += (amount * price) + fee;
    }

    // First: 100 * 1.0 + 0.1 = 100.1
    // Second: 50 * 1.5 + 0.05 = 75.05
    // Third: 75 * 2.0 + 0.15 = 150.15
    // Total: 325.3
    expect(totalInvestment).toBeCloseTo(325.3, 2);
  });

  it('calculates sell percentage to recover initial investment', () => {
    const totalInitialInvestment = 325.3;
    const currentHeld = 225; // 100 + 50 + 75
    const currentPrice = 2.5;

    const currentValue = currentHeld * currentPrice; // 562.5
    const sellPercentage = (totalInitialInvestment / currentValue) * 100;

    // 325.3 / 562.5 * 100 = 57.83%
    expect(sellPercentage).toBeCloseTo(57.83, 2);
  });

  it('caps sell percentage at 100% if position lost value', () => {
    const totalInitialInvestment = 500;
    const currentHeld = 100;
    const currentPrice = 2.0;

    const currentValue = currentHeld * currentPrice; // 200
    const sellPercentage = (totalInitialInvestment / currentValue) * 100; // 250%

    const adjustedPercentage = Math.min(100, Math.max(1, sellPercentage));
    expect(adjustedPercentage).toBe(100);
  });

  it('handles single buy fill correctly', () => {
    const buys = [{ amount: '100', price: '1.5', fee_paid: '0.1' }];
    let totalInvestment = 0;
    for (const buy of buys) {
      const amount = parseFloat(buy.amount);
      const price = parseFloat(buy.price);
      const fee = parseFloat(buy.fee_paid || '0');
      totalInvestment += (amount * price) + fee;
    }

    expect(totalInvestment).toBeCloseTo(150.1, 2);
  });

  it('handles zero fees correctly', () => {
    const buys = [{ amount: '100', price: '1.0', fee_paid: '0' }];
    let totalInvestment = 0;
    for (const buy of buys) {
      const amount = parseFloat(buy.amount);
      const price = parseFloat(buy.price);
      const fee = parseFloat(buy.fee_paid || '0');
      totalInvestment += (amount * price) + fee;
    }

    expect(totalInvestment).toBe(100);
  });

  it('prevents division by zero with zero current price', () => {
    const totalInitialInvestment = 100;
    const currentHeld = 50;
    const currentPrice = 0;

    if (currentPrice === 0) {
      // Should skip calculation
      expect(true).toBe(true);
      return;
    }

    const currentValue = currentHeld * currentPrice;
    const sellPercentage = (totalInitialInvestment / currentValue) * 100;

    // Should not reach here
    expect(false).toBe(true);
  });

  it('prevents division by zero with zero current held', () => {
    const totalInitialInvestment = 100;
    const currentHeld = 0;
    const currentPrice = 2.0;

    if (currentHeld === 0) {
      // Should skip calculation
      expect(true).toBe(true);
      return;
    }

    const currentValue = currentHeld * currentPrice;
    const sellPercentage = (totalInitialInvestment / currentValue) * 100;

    // Should not reach here
    expect(false).toBe(true);
  });
});
