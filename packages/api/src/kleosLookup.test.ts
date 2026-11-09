import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getErc20TokenInfo = vi.fn();
const resolveKleosRoute = vi.fn();
const getRonsPadLaunch = vi.fn();
const resolveAscendRoute = vi.fn(async (..._args: any[]): Promise<any> => null);
const quoteAscend = vi.fn();
vi.mock('@racerbot/shared', async (importActual) => ({
  ...(await importActual<typeof import('@racerbot/shared')>()),
  getErc20TokenInfo: (...args: any[]) => getErc20TokenInfo(...args),
  resolveKleosRoute: (...args: any[]) => resolveKleosRoute(...args),
  getRonsPadLaunch: (...args: any[]) => getRonsPadLaunch(...args),
  resolveAscendRoute: (...args: any[]) => resolveAscendRoute(...args),
  quoteAscend: (...args: any[]) => quoteAscend(...args),
}));

const { lookupKleosToken, getHypeUsdPrice, getTokenInfo } = await import('./wallet.js');

const KSOCKS = '0xd8C9bd555DEcc4Ae694E6C3e492Ef9DD96d2979d';

function respond(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
}

describe('Kleos (Elysium mainnet) tokens', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('hyperliquid.xyz/info')) return respond({ HYPE: '80' });
      if (url.includes('thekleos.xyz/api/board')) {
        return respond([{ address: KSOCKS, name: 'kSocks', symbol: 'KSOCKS', image: 'https://img/ksocks.jpg', launch: { price: 2e-7, liquidityHype: 50 } }]);
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    getErc20TokenInfo.mockReset();
  });

  it('reads the token from Elysium mainnet and prices it from the Kleos board, read-only with KLEOS_TRADING=off', async () => {
    vi.stubEnv('KLEOS_TRADING', 'off');
    getErc20TokenInfo.mockResolvedValue({ address: KSOCKS, name: 'kSocks', symbol: 'KSOCKS', decimals: 18, totalSupply: (10n ** 27n).toString() });
    const info = await lookupKleosToken(KSOCKS.toLowerCase());

    expect(getErc20TokenInfo).toHaveBeenCalledWith(KSOCKS.toLowerCase(), 'elysium', false);
    expect(info).toMatchObject({ chain: 'elysium', venue: 'kleos', symbol: 'KSOCKS', tradeable: false, icon: 'https://img/ksocks.jpg' });
    expect(info!.market_cap).toBeCloseTo(200); // 1B supply at 2e-7 HYPE
    expect(info!.market_cap_usd).toBeCloseTo(16000);
    expect(Number(info!.liquidity_usd)).toBeCloseTo(4000);
    vi.unstubAllEnvs();
  });

  it('is tradeable by default, with the launch taxes from the board', async () => {
    getErc20TokenInfo.mockResolvedValue({ address: KSOCKS, name: 'kSocks', symbol: 'KSOCKS', decimals: 18, totalSupply: '0' });
    const coin = { address: KSOCKS, symbol: 'KSOCKS', launch: { price: 1e-7, v4: { buyBps: 300, sellBps: 100 } } };
    expect(await lookupKleosToken(KSOCKS, coin)).toMatchObject({ tradeable: true, buy_tax_pct: 3, sell_tax_pct: 1 });
  });

  it('still finds a listed coin when Elysium mainnet does not answer', async () => {
    getErc20TokenInfo.mockResolvedValue(null);
    expect(await lookupKleosToken(KSOCKS)).toMatchObject({ venue: 'kleos', symbol: 'KSOCKS', name: 'kSocks' });
  });

  it('returns nothing for an address that is neither on Elysium mainnet nor on the board', async () => {
    getErc20TokenInfo.mockResolvedValue(null);
    expect(await lookupKleosToken('0x000000000000000000000000000000000000dEaD', null)).toBeNull();
  });

  it('shows a coin with no HYPE route as read-only, with the reason', async () => {
    getErc20TokenInfo.mockResolvedValue({ address: KSOCKS, name: 'kPair', symbol: 'KPAIR', decimals: 18, totalSupply: '0' });
    const coin = { address: KSOCKS, symbol: 'KPAIR', launch: { price: 1e-7, v4: { pair: { symbol: 'BLOB' }, v5: { routeFee: 0 } } } };
    const info = await lookupKleosToken(KSOCKS, coin);
    expect(info).toMatchObject({ tradeable: false });
    expect(info!.trade_block_reason).toContain('$BLOB');
  });

  it('takes the HYPE price from Hyperliquid, not a DexScreener pair that quotes HYPE', async () => {
    expect(await getHypeUsdPrice()).toBe(80);
  });

  it('marks an Elysium token no Kleos router trades as read-only, in plain words', async () => {
    getErc20TokenInfo.mockResolvedValue({ address: KSOCKS, name: 'Other', symbol: 'OTHER', decimals: 18, totalSupply: '0' });
    resolveKleosRoute.mockRejectedValue(new Error('No Kleos router trades this coin.'));
    const info = await lookupKleosToken(KSOCKS, null);
    expect(info).toMatchObject({ chain: 'elysium', tradeable: false });
    expect(info!.trade_block_reason).toMatch(/not a Kleos, RonsPad or Ascend coin/);
  });

  it('never takes an Elysium coin listed on DexScreener for a HyperEVM token', async () => {
    const NEW_COIN = '0x3Dc4CE6d3251288c5bE893375C45080A9Ea30a1A';
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('hyperliquid.xyz/info')) return respond({ HYPE: '80' });
      if (url.includes('thekleos.xyz/api/board')) return respond([]);
      if (url.includes('dexscreener.com')) {
        return respond({ pairs: [{ chainId: 'elysium', dexId: 'uniswap', baseToken: { address: NEW_COIN, symbol: 'LWIZARD', name: 'Lizard' }, priceUsd: '0.01', liquidity: { usd: 500 } }] });
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    }));
    // No contract on HyperEVM; an ERC-20 on Elysium mainnet that a Kleos router quotes
    getErc20TokenInfo.mockImplementation(async (_a: string, chain: string, testnet: boolean) =>
      chain === 'elysium' && !testnet ? { address: NEW_COIN, name: 'Lizard', symbol: 'LWIZARD', decimals: 18, totalSupply: '0' } : null);
    getRonsPadLaunch.mockResolvedValue(null);
    resolveKleosRoute.mockResolvedValue({ kind: 'v5', router: '0x15c7Ee481CE8c57461bC8620adC5Fb784374c240', hopFee: 0 });
    const info = await getTokenInfo(NEW_COIN, true);
    expect(info).toMatchObject({ chain: 'elysium', venue: 'kleos', symbol: 'LWIZARD', tradeable: true });
  });

  it('recognises an Ascend coin (ORPHEUS) that DexScreener lists on Elysium, instead of calling it a HyperEVM token', async () => {
    const ORPHEUS = '0x7701a31c0b3815fe6d09a8a313967c5977a5fa7a';
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('hyperliquid.xyz/info')) return respond({ HYPE: '80' });
      if (url.includes('thekleos.xyz/api/board')) return respond([]);
      if (url.includes('dexscreener.com')) {
        return respond({ pairs: [{ chainId: 'elysium', dexId: 'uniswap', baseToken: { address: ORPHEUS, symbol: 'ORPHEUS', name: 'Orpheus' }, priceUsd: '0.0008', liquidity: { usd: 36546 } }] });
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    }));
    getErc20TokenInfo.mockImplementation(async (_a: string, chain: string, testnet: boolean) =>
      chain === 'elysium' && !testnet ? { address: ORPHEUS, name: 'Orpheus', symbol: 'ORPHEUS', decimals: 18, totalSupply: (10n ** 27n).toString() } : null);
    getRonsPadLaunch.mockResolvedValue(null);
    resolveAscendRoute.mockResolvedValue({ quote: '0xbA876237B0F021A6c6D852d6c26E107997cC5E81', quoteSymbol: 'WHYPE', launchKey: {} });
    quoteAscend.mockResolvedValue(10n ** 18n * 100n);
    const info = await getTokenInfo(ORPHEUS, true);
    expect(info).toMatchObject({ chain: 'elysium', venue: 'ascend', launchpad: 'Ascend', symbol: 'ORPHEUS', tradeable: true, liquidity_usd: '36546.00' });
    expect(Number(info.price_usd)).toBeCloseTo(0.0008, 9);
  });
});

