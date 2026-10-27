/**
 * Solana market data shared by the TP/SL trigger engine, limit orders and
 * fleet orders in this process.
 *
 * Every Solana token with an open order or trigger is priced with ONE batched
 * Jupiter call (up to 50 mints per call) at most every SOLANA_REFRESH_MS, so
 * the free API limit is respected however many orders exist. Supply (for
 * market cap) is cached for 10 minutes. No RPC is used.
 *
 * Prices: SOL per token. Market cap: USD (and SOL for the TP/SL engine).
 */
import { getSolanaPricesUsd, getSolanaTokenInfo, getSolUsdPrice, isSolanaToken } from '@racerbot/shared';

const SOLANA_REFRESH_MS = Number(process.env.SOLANA_LIMIT_REFRESH_MS || 8000);
const SUPPLY_TTL_MS = 10 * 60_000;
/** Older than this, a Solana price is not used to fire anything. */
export const SOLANA_PRICE_MAX_AGE_MS = 60_000;

export interface SolanaMarket { priceSol: number; mcapUsd: number; mcapSol: number; ts: number }

const market = new Map<string, SolanaMarket>();
const supplyCache = new Map<string, { supply: number; ts: number }>();
let inflight: Promise<void> | null = null;
const queued = new Set<string>();

async function doRefresh(mints: string[]): Promise<void> {
  const [prices, solUsd] = await Promise.all([
    getSolanaPricesUsd(mints).catch(() => new Map<string, number>()),
    getSolUsdPrice(),
  ]);
  for (const mint of mints) {
    let priceUsd = prices.get(mint) ?? 0;
    let sup = supplyCache.get(mint);
    if (!sup || Date.now() - sup.ts > SUPPLY_TTL_MS || priceUsd <= 0) {
      const info = await getSolanaTokenInfo(mint).catch(() => null);
      if (info) {
        sup = { supply: info.totalSupply, ts: Date.now() };
        supplyCache.set(mint, sup);
        if (priceUsd <= 0 && info.priceUsd > 0) priceUsd = info.priceUsd;
      }
    }
    if (priceUsd > 0 && solUsd > 0) {
      const mcapUsd = sup && sup.supply > 0 ? priceUsd * sup.supply : 0;
      market.set(mint, { priceSol: priceUsd / solUsd, mcapUsd, mcapSol: mcapUsd / solUsd, ts: Date.now() });
    }
  }
}

/**
 * Refreshes every given mint whose price is older than SOLANA_REFRESH_MS
 * (or all of them with force). Concurrent callers share one batched call.
 */
export async function refreshSolanaMarkets(mints: string[], force = false): Promise<void> {
  const now = Date.now();
  for (const m of mints) {
    if (!isSolanaToken(m)) continue;
    const hit = market.get(m);
    if (force || !hit || now - hit.ts >= SOLANA_REFRESH_MS) queued.add(m);
  }
  while (inflight) await inflight; // wait for a running batch, then run ours
  if (queued.size === 0) return;
  const batch = [...queued];
  queued.clear();
  inflight = doRefresh(batch).finally(() => { inflight = null; });
  await inflight;
}

/** Latest Solana market for a mint, or null when unknown or too old to act on. */
export function getSolanaMarket(mint: string): SolanaMarket | null {
  const hit = market.get(mint);
  if (!hit || Date.now() - hit.ts > SOLANA_PRICE_MAX_AGE_MS) return null;
  return hit;
}
