import { describe, it, expect, vi, afterEach } from 'vitest';

const respond = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));

afterEach(() => vi.unstubAllGlobals());

describe('DexScreener prices on NEAR', () => {
  const pair = (quote: string) => ({
    chainId: 'near', dexId: 'ref', pairAddress: 'p1',
    baseToken: { address: 'oyster.v2-launchpad.justhoot.near', symbol: 'OYSTER', name: 'Oyster' },
    quoteToken: { address: quote, symbol: 'Q' },
    priceNative: '0.0000244', priceUsd: '0.0000283', liquidity: { usd: 1000 }, volume: { h24: 1 }, priceChange: { h24: 0 }, txns: { h24: { buys: 1, sells: 1 } },
  });

  it('ignores priceNative when the pair is not quoted in wNEAR (it is in the quote token)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => respond({ pairs: [pair('prl.omft.near')] })));
    const { fetchDexScreenerTokenData } = await import('./wallet.js');
    const d = await fetchDexScreenerTokenData('oyster.v2-launchpad.justhoot.near', 'near');
    expect(d!.priceNative).toBe(0);
    expect(d!.priceUsd).toBeCloseTo(0.0000283);
  });

  it('keeps priceNative for wNEAR pairs', async () => {
    vi.stubGlobal('fetch', vi.fn(() => respond({ pairs: [pair('wrap.near')] })));
    const { fetchDexScreenerTokenData } = await import('./wallet.js');
    const d = await fetchDexScreenerTokenData('oyster.v2-launchpad.justhoot.near', 'near');
    expect(d!.priceNative).toBeCloseTo(0.0000244);
  });
});

describe('1Click assets for NEAR wallets', () => {
  it('picks the NEAR-delivery id of a bridged token, not its home-chain id', async () => {
    vi.stubGlobal('fetch', vi.fn(() => respond([
      { assetId: 'nep141:prl.omft.near', blockchain: 'prl', symbol: 'PRL' },
      { assetId: '1cs_v1:near:nep141:prl.omft.near', blockchain: 'near', contractAddress: 'prl.omft.near', symbol: 'PRL' },
      { assetId: 'nep141:wrap.near', blockchain: 'near', contractAddress: 'wrap.near', symbol: 'wNEAR' },
    ])));
    const { getIntentsNearAsset, isIntentsToken } = await import('./intentsPrivate.js');
    expect(await getIntentsNearAsset('prl.omft.near')).toBe('1cs_v1:near:nep141:prl.omft.near');
    expect(await getIntentsNearAsset('wrap.near')).toBe('nep141:wrap.near');
    expect(await isIntentsToken('oyster.v2-launchpad.justhoot.near')).toBe(false);
  });
});
