import { describe, it, expect, vi, afterEach } from 'vitest';

process.env.KEY_ENCRYPTION_MASTER_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const { fetchDexScreenerTokenData } = await import('./wallet.js');

const WHYPE = '0x5555555555555555555555555555555555555555';
const pair = (base: any, quote: any, priceUsd: string, priceNative: string, liq: number) => ({
  chainId: 'hyperevm', dexId: 'hyperswap', pairAddress: '0xpair' + liq, baseToken: base, quoteToken: quote,
  priceUsd, priceNative, liquidity: { usd: liq }, marketCap: 1234, fdv: 1234, priceChange: { h24: 5 }, volume: { h24: 10 },
});
const usdc = { address: '0xb88339cb7199b77e23db6e890353e22632ba630f', symbol: 'USDC', name: 'USD Coin' };
const whype = { address: WHYPE, symbol: 'WHYPE', name: 'Wrapped HYPE' };
const meme = { address: '0x9b530b0ac8817f4b6c29cff236df85ed33ece660', symbol: 'MEME', name: 'Meme' };

describe('DexScreener price for the token asked about', () => {
  afterEach(() => vi.unstubAllGlobals());
  const respond = (pairs: any[]) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ pairs }))));

  it('uses a pool where the token is the base', async () => {
    respond([pair(usdc, whype, '1.0007', '0.0114', 9_000_000), pair(meme, whype, '0.00004', '0.0000005', 50_000), pair(whype, usdc, '87.6', '87.6', 2_000_000)]);
    const d = await fetchDexScreenerTokenData(WHYPE, 'hyperevm');
    expect(d?.symbol).toBe('WHYPE');
    expect(d?.priceUsd).toBeCloseTo(87.6);
  });

  it('derives the price when the token only appears as the quote', async () => {
    // USDC/WHYPE: 1 USDC = 0.0114 WHYPE and USDC is $1.0007, so WHYPE is about $87.8
    respond([pair(usdc, whype, '1.0007', '0.0114', 9_000_000)]);
    const d = await fetchDexScreenerTokenData(WHYPE, 'hyperevm');
    expect(d?.symbol).toBe('WHYPE');
    expect(d?.priceUsd).toBeCloseTo(1.0007 / 0.0114, 3);
    expect(d?.marketCapUsd).toBe(0); // the pair's market cap belongs to USDC
  });
});
