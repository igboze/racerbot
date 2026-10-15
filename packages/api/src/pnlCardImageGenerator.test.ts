import { describe, it, expect } from 'vitest';
import { generatePNLCardImage } from './pnlCardImageGenerator.js';
import { PNLCardData } from './pnlCardGenerator.js';

describe('generatePNLCardImage', () => {
  const baseData: PNLCardData = {
    tokenAddress: 'token.intear.near',
    tokenName: 'Hoodle',
    tokenSymbol: 'HOODL',
    entryPrice: 1.0,
    currentPrice: 1.0537,
    quantityHeld: 100,
    initialInvestment: 140.9,
    unrealizedValue: 147.61,
    realizedPnl: 0,
    unrealizedPnl: 6.71,
    totalPnl: 6.71,
    pnlPercent: 5.37,
    isProfit: true,
    holdDuration: '10m 1s',
    positionId: 'pos-123',
    positionStatus: 'open',
    entryMarketCap: 1000000,
    currentMarketCap: 1053700,
    isExternalDeposit: false,
    totalBuys: 1,
    totalSells: 0,
    totalFeesPaid: 0.1,
    buyFeesPaid: 0.1,
    sellFeesPaid: 0,
    tokenPriceChangePct: 5.37,
    nearUsd: 1.0,
    showNetWorth: true,
    referralCode: 'HEntechnologue-HI97C',
  };

  it('renders a profit PNL card as a valid PNG buffer', async () => {
    const buf = await generatePNLCardImage(baseData);
    expect(buf).not.toBeNull();
    expect(Buffer.isBuffer(buf)).toBe(true);
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    expect(buf![0]).toBe(0x89);
    expect(buf![1]).toBe(0x50);
    expect(buf![2]).toBe(0x4e);
    expect(buf![3]).toBe(0x47);
  });

  it('renders a loss PNL card as a valid PNG buffer', async () => {
    const lossData: PNLCardData = {
      ...baseData,
      tokenSymbol: 'RAEN',
      pnlPercent: -9.01,
      isProfit: false,
    };
    const buf = await generatePNLCardImage(lossData);
    expect(buf).not.toBeNull();
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf![0]).toBe(0x89);
    expect(buf![1]).toBe(0x50);
  });

  it('renders when showNetWorth is false (market cap mode)', async () => {
    const mcapData: PNLCardData = {
      ...baseData,
      showNetWorth: false,
    };
    const buf = await generatePNLCardImage(mcapData);
    expect(buf).not.toBeNull();
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf![0]).toBe(0x89);
  });
});
