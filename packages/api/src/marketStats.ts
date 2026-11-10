/**
 * Real 24h market numbers for NEAR tokens, from DexScreener's public token API.
 *
 * The token screener used to estimate volume and liquidity from market cap and
 * report every 24h change as 0. This fetches, per token, the price and 24h
 * change of its most liquid pair, its summed 24h volume across pairs, and its
 * liquidity, 30 tokens per request, cached for two minutes.
 */

import { createLogger } from '@racerbot/shared';

const logger = createLogger('market-stats');

const DEXSCREENER_TOKENS_URL = 'https://api.dexscreener.com/tokens/v1/near/';
const BATCH = 30;
const CONCURRENCY = 4;
const TTL_MS = 2 * 60 * 1000;
/** A pair thinner than this cannot set a token's price */
export const MIN_PRICE_LIQUIDITY_USD = 1000;

export interface TokenMarketStats {
  /** USD price from the most liquid pair where the token is the base, if that pair has real liquidity */
  priceUsd: number | null;
  change24h: number;
  volume24h: number;
  liquidityUsd: number;
  marketCap: number | null;
}

interface DexPair {
  baseToken?: { address?: string };
  quoteToken?: { address?: string };
  priceUsd?: string;
  priceChange?: { h24?: number };
  volume?: { h24?: number };
  liquidity?: { usd?: number };
  marketCap?: number;
  fdv?: number;
}

const cache = new Map<string, { stats: TokenMarketStats | null; at: number }>();

/** Folds every pair a token appears in into one set of numbers. Exported for tests. */
export function statsFromPairs(address: string, pairs: DexPair[]): TokenMarketStats | null {
  const addr = address.toLowerCase();
  const mine = pairs.filter(p =>
    p.baseToken?.address?.toLowerCase() === addr || p.quoteToken?.address?.toLowerCase() === addr);
  if (mine.length === 0) return null;

  const volume24h = mine.reduce((s, p) => s + (Number(p.volume?.h24) || 0), 0);
  const liquidityUsd = mine.reduce((s, p) => s + (Number(p.liquidity?.usd) || 0), 0);
  const asBase = mine
    .filter(p => p.baseToken?.address?.toLowerCase() === addr && Number(p.priceUsd) > 0)
    .sort((a, b) => (Number(b.liquidity?.usd) || 0) - (Number(a.liquidity?.usd) || 0));
  const best = asBase[0];
  const bestLiquid = best && (Number(best.liquidity?.usd) || 0) >= MIN_PRICE_LIQUIDITY_USD;

  return {
    priceUsd: bestLiquid ? Number(best.priceUsd) : null,
    change24h: best ? Number(best.priceChange?.h24) || 0 : 0,
    volume24h: Math.round(volume24h),
    liquidityUsd: Math.round(liquidityUsd),
    marketCap: bestLiquid ? (Number(best.marketCap) || Number(best.fdv) || null) : null,
  };
}

async function fetchBatch(addresses: string[], fetchImpl: typeof fetch): Promise<void> {
  const url = DEXSCREENER_TOKENS_URL + addresses.map(encodeURIComponent).join(',');
  try {
    const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`DexScreener answered ${res.status}`);
    const pairs = (await res.json()) as DexPair[];
    const list = Array.isArray(pairs) ? pairs : [];
    const at = Date.now();
    for (const a of addresses) cache.set(a.toLowerCase(), { stats: statsFromPairs(a, list), at });
  } catch (err: any) {
    // Leave these uncached so the next refresh tries again
    logger.debug(`Market stats batch failed: ${err?.message || err}`);
  }
}

/**
 * Market stats for many tokens. Tokens DexScreener does not list map to null;
 * tokens whose request failed are left out of the map.
 */
export async function getTokenMarketStats(
  addresses: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, TokenMarketStats | null>> {
  const now = Date.now();
  const unique = [...new Set(addresses.map(a => a.trim()).filter(Boolean))];
  const stale = unique.filter(a => {
    const hit = cache.get(a.toLowerCase());
    return !hit || now - hit.at > TTL_MS;
  });

  const batches: string[][] = [];
  for (let i = 0; i < stale.length; i += BATCH) batches.push(stale.slice(i, i + BATCH));
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    await Promise.all(batches.slice(i, i + CONCURRENCY).map(b => fetchBatch(b, fetchImpl)));
  }

  const out = new Map<string, TokenMarketStats | null>();
  for (const a of unique) {
    const hit = cache.get(a.toLowerCase());
    if (hit) out.set(a.toLowerCase(), hit.stats);
  }
  return out;
}

/** Test hook */
export function resetMarketStatsCache(): void {
  cache.clear();
}
