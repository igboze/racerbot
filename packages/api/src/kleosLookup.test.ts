import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getErc20TokenInfo = vi.fn();
vi.mock('@racerbot/shared', async (importActual) => ({
  ...(await importActual<typeof import('@racerbot/shared')>()),
  getErc20TokenInfo: (...args: any[]) => getErc20TokenInfo(...args),
}));

const { lookupKleosToken, getHypeUsdPrice } = await import('./wallet.js');

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

  it('reads the token from Elysium mainnet and prices it from the Kleos board, as read-only', async () => {
    getErc20TokenInfo.mockResolvedValue({ address: KSOCKS, name: 'kSocks', symbol: 'KSOCKS', decimals: 18, totalSupply: (10n ** 27n).toString() });
    const info = await lookupKleosToken(KSOCKS.toLowerCase());

    expect(getErc20TokenInfo).toHaveBeenCalledWith(KSOCKS.toLowerCase(), 'elysium', false);
    expect(info).toMatchObject({ chain: 'elysium', venue: 'kleos', symbol: 'KSOCKS', tradeable: false, icon: 'https://img/ksocks.jpg' });
    expect(info!.market_cap).toBeCloseTo(200); // 1B supply at 2e-7 HYPE
    expect(info!.market_cap_usd).toBeCloseTo(16000);
    expect(Number(info!.liquidity_usd)).toBeCloseTo(4000);
  });

  it('returns nothing when the address has no contract on Elysium mainnet', async () => {
    getErc20TokenInfo.mockResolvedValue(null);
    expect(await lookupKleosToken(KSOCKS)).toBeNull();
  });

  it('takes the HYPE price from Hyperliquid, not a DexScreener pair that quotes HYPE', async () => {
    expect(await getHypeUsdPrice()).toBe(80);
  });
});
