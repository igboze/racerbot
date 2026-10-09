import { describe, it, expect } from 'vitest';
import { generateTokenInfoCardImage } from './tokenInfoCardImageGenerator.js';

describe('tokenInfoCardImageGenerator', () => {
  it('full data returns a Buffer that starts with PNG signature (89 50 4E 47)', async () => {
    const buffer = await generateTokenInfoCardImage({
      tokenAddress: 'weasel.nearlytrade.near',
      name: 'Quantum Weasel',
      symbol: 'WEASEL',
      venue: 'NearlyTrade (Ref DCL)',
      priceNear: '0.00000276 NEAR',
      priceUsd: '$0.00001325',
      marketCapUsd: '$13.18K',
      liquidityNear: '22.37 QTC',
      liquidityUsd: '$6.1K',
      totalSupply: '994.59M',
      decimals: 18,
      buyTaxPct: 1.0,
      sellTaxPct: 1.0,
      holdersCount: 66,
      buysCount: 38,
      sellsCount: 58,
      totalTxns: 1324,
      pairedSymbol: 'QTC',
      badges: [{ type: 'pass', label: 'HONEYPOT PASSED' }],
    });

    expect(buffer).not.toBeNull();
    expect(Buffer.isBuffer(buffer)).toBe(true);

    if (buffer) {
      expect(buffer[0]).toBe(0x89);
      expect(buffer[1]).toBe(0x50); // 'P'
      expect(buffer[2]).toBe(0x4e); // 'N'
      expect(buffer[3]).toBe(0x47); // 'G'
    }
  });

  it('only four required fields still returns a Buffer (N/A path)', async () => {
    const buffer = await generateTokenInfoCardImage({
      tokenAddress: 'test.near',
      name: 'Test Token',
      symbol: 'TEST',
      venue: 'Ref Finance',
    });

    expect(buffer).not.toBeNull();
    expect(Buffer.isBuffer(buffer)).toBe(true);

    if (buffer) {
      expect(buffer[0]).toBe(0x89);
      expect(buffer[1]).toBe(0x50);
      expect(buffer[2]).toBe(0x4e);
      expect(buffer[3]).toBe(0x47);
    }
  });

  it('a broken icon string still returns a Buffer', async () => {
    const buffer = await generateTokenInfoCardImage({
      tokenAddress: 'broken.near',
      name: 'Broken Icon Token',
      symbol: 'BROKEN',
      venue: 'Unknown',
      icon: 'invalid-not-a-real-data-uri',
    });

    expect(buffer).not.toBeNull();
    expect(Buffer.isBuffer(buffer)).toBe(true);

    if (buffer) {
      expect(buffer[0]).toBe(0x89);
      expect(buffer[1]).toBe(0x50);
      expect(buffer[2]).toBe(0x4e);
      expect(buffer[3]).toBe(0x47);
    }
  });
});
