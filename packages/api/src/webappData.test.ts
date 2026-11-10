import { describe, it, expect, vi } from 'vitest';

vi.mock('@racerbot/db', async (orig) => ({ ...(await orig<any>()), getDb: async () => null }));

const { statsFromPairs, getTokenMarketStats, resetMarketStatsCache } = await import('./marketStats.js');
const { applyMarketStats, roundPrice, maxDrawdownFromCurve, riskFromDrawdown } = await import('./racerAlpha.js');
const { summarizePublicStats } = await import('./publicStats.js');
const { nearTradeLinks } = await import('./tradeLinks.js');

const pair = (base: string, quote: string, o: { price?: number; chg?: number; vol?: number; liq?: number; mcap?: number }) => ({
  baseToken: { address: base }, quoteToken: { address: quote },
  priceUsd: o.price !== undefined ? String(o.price) : undefined,
  priceChange: { h24: o.chg ?? 0 }, volume: { h24: o.vol ?? 0 }, liquidity: { usd: o.liq ?? 0 }, marketCap: o.mcap,
});

const token = (address: string, o: Partial<{ priceUsd: number; priceNear: number; marketCap: number; volume24h: number; liquidityUsd: number; change24h: number }> = {}) => ({
  address, symbol: address.split('.')[0].toUpperCase(), name: address, venue: 'rhea', launchpad: 'ref',
  priceUsd: 0, priceNear: 0, change24h: 0, marketCap: 0, volume24h: 0, bondingProgress: 100, bondingPhase: 'dex_pool',
  liquidityUsd: 0, sparkline: [], holders: 0, decimals: 18, ...o,
}) as any;

describe('real market numbers for the token screener', () => {
  it('takes price and change from the most liquid pair, and adds up volume and liquidity', () => {
    const s = statsFromPairs('blackdragon.tkn.near', [
      pair('blackdragon.tkn.near', 'wrap.near', { price: 6.352e-9, chg: -3.48, vol: 1983.89, liq: 39722, mcap: 635293 }),
      pair('blackdragon.tkn.near', 'usdt.tether-token.near', { price: 7e-9, chg: 9, vol: 100, liq: 50 }),
      pair('other.near', 'wrap.near', { price: 1, vol: 1e9, liq: 1e9 }),
    ])!;
    expect(s).toEqual({ priceUsd: 6.352e-9, change24h: -3.48, volume24h: 2084, liquidityUsd: 39772, marketCap: 635293 });
  });

  it('does not let a near-empty pool set the price', () => {
    const s = statsFromPairs('thin.near', [pair('thin.near', 'wrap.near', { price: 94748, chg: 0, vol: 5, liq: 12 })])!;
    expect(s.priceUsd).toBeNull();
    expect(s.marketCap).toBeNull();
  });

  it('asks DexScreener 30 tokens at a time and caches the answers', async () => {
    resetMarketStatsCache();
    const addrs = Array.from({ length: 65 }, (_, i) => `t${i}.near`);
    const calls: string[] = [];
    const fake = (async (url: string) => {
      calls.push(url);
      const asked = decodeURIComponent(url.split('/near/')[1]).split(',');
      return new Response(JSON.stringify(asked.slice(0, 1).map(a => pair(a, 'wrap.near', { price: 1, liq: 5000, vol: 10 }))));
    }) as any;
    const m = await getTokenMarketStats(addrs, fake);
    expect(calls).toHaveLength(3);
    expect(m.get('t0.near')?.priceUsd).toBe(1);
    expect(m.get('t1.near')).toBeNull();
    await getTokenMarketStats(addrs, fake);
    expect(calls).toHaveLength(3);
  });

  it('fixes prices, fills change and volume, and drops big tokens no pool backs', async () => {
    const list = [
      token('blackdragon.tkn.near', { priceUsd: 1e-8, priceNear: 2.8e-9, marketCap: 1_000_000 }),
      token('dave.patata-monster.near', { priceUsd: 94748, marketCap: 94_748_945_000_000, volume24h: 9_955_618_000_000 }),
      token('small.near', { priceUsd: 0.01, marketCap: 50_000, volume24h: 999_999, liquidityUsd: 100 }),
    ];
    const stats = new Map<string, any>([
      ['blackdragon.tkn.near', { priceUsd: 6.352e-9, change24h: -3.48, volume24h: 1984, liquidityUsd: 39722, marketCap: 635293 }],
      ['dave.patata-monster.near', null],
      ['small.near', null],
    ]);
    const out = await applyMarketStats(list, stats);
    expect(out.map(t => t.address)).toEqual(['blackdragon.tkn.near', 'small.near']);
    expect(out[0]).toMatchObject({ priceUsd: 6.352e-9, change24h: -3.48, volume24h: 1984, liquidityUsd: 39722, marketCap: 635293 });
    expect(out[0].priceNear).toBeCloseTo(2.8e-9 * 0.6352, 15);
    // An unbacked volume far above the pool's size is not shown
    expect(out[1].volume24h).toBe(0);
  });

  it('keeps tiny prices instead of rounding them to 0.00000001', () => {
    expect(roundPrice(6.352123456e-9)).toBe(6.35212e-9);
    expect(roundPrice(1.23456789)).toBe(1.23457);
    expect(roundPrice(-1)).toBe(0);
  });
});

describe('live trade links', () => {
  const pool = 'nep141:blackdragon.tkn.near___nep141:wrap.near';
  it('links the pool, not NearBlocks, for anonymised GeckoTerminal ids', () => {
    expect(nearTradeLinks('a30c899703961ede3d295edc231d77ae', '0f5c562eed6565de184d01acf3f9b14a', pool)).toEqual({
      txHash: '',
      txUrl: 'https://www.geckoterminal.com/near/pools/nep141%3Ablackdragon.tkn.near___nep141%3Awrap.near',
      maker: null,
    });
  });
  it('links NearBlocks for a real NEAR transaction hash, and keeps a real account', () => {
    const hash = '6Xq1vV8hJm5bH9u7p2s3k4L5n6M7o8P9q1R2s3T4u5V';
    expect(nearTradeLinks(hash, 'alice.near', pool)).toEqual({ txHash: hash, txUrl: `https://nearblocks.io/txns/${hash}`, maker: 'alice.near' });
  });
});

describe('home page totals', () => {
  it('adds every chain, priced in USD', () => {
    const s: any = {
      volumeTotalNear: 1000, tradesTotal: 50, volumeTotalSui: 10, tradesTotalSui: 2, volumeTotalStarknet: 0, tradesTotalStarknet: 0,
      volumeTotalSolana: 1, tradesTotalSolana: 1, volumeTotalHyperevm: 2, tradesTotalHyperevm: 3, volumeTotalElysium: 1, tradesTotalElysium: 4, usersTotal: 77,
    };
    expect(summarizePublicStats(s, { near: 3.5, sui: 2, strk: 0.2, sol: 150, hype: 30 }, 1)).toEqual({
      volumeRoutedUsd: 3500 + 20 + 150 + 90, trades: 60, users: 77, updatedAt: 1,
    });
  });
});

describe('leaderboard numbers from real history', () => {
  it('measures the largest fall from a peak', () => {
    expect(maxDrawdownFromCurve([100, 120, 90, 130, 117])).toBe(-25);
    expect(maxDrawdownFromCurve([100, 110, 120])).toBe(0);
    expect(maxDrawdownFromCurve([])).toBe(0);
  });
  it('rates risk from that drawdown, and leaves a trader with no history unrated', () => {
    expect(riskFromDrawdown(0)).toEqual({ score: 0, level: 'UNRATED' });
    expect(riskFromDrawdown(-4)).toEqual({ score: 1.3, level: 'LOW' });
    expect(riskFromDrawdown(-25)).toEqual({ score: 8.3, level: 'MEDIUM-HIGH' });
    expect(riskFromDrawdown(-60).score).toBe(10);
  });
});
