import 'dotenv/config';
import {
  getNear,
  encrypt,
  decrypt,
  generateScopedAccessKey,
  generateRandomAccountPrefix,
  parseMemeCookingId,
  generateSuiWallet,
  restoreSuiKeypair,
  restoreSuiKeypairFromSecret,
  getSuiClient,
  getSuiBalance,
  getSuiTokenBalance,
  getSuiTokenMetadata,
  getSuiTokenSupply,
  getSuiPumpCurveState,
  getSuiUsdPrice,
  getSuiRouterQuote,
  isValidSuiAddress,
  executeSuiTransaction,
  resolveTokenAddressFromKey,
  getShortTokenKey,
  registerShortTokenKey,
  type VenueName,
  isTradableVenue,
} from '@racerbot/shared';
import { Transaction } from '@mysten/sui/transactions';
import {
  getDb,
  createUser,
  getUserByTelegramId,
  updateUserScopedKey,
  updateUserSuiWallet,
  getTokenCache,
  findTokenAddressByShortKey,
  upsertTokenCache,
  getOpenPositions,
  createPosition,
  updatePosition,
  generateReferralCode,
  getUserByReferralCode,
  createReferral,
  getUserById,
  getUserWallets,
  getActiveWallet,
  createUserWallet,
  setActiveWallet,
  renameUserWallet,
  deleteUserWallet,
  type UserRecord,
  type UserWalletRecord,
} from '@racerbot/db';
import { utils as nearUtils, keyStores, KeyPair, connect } from 'near-api-js';
import { MAIN_WALLET_PRIVATE_KEY, RACERBOT_PARENT_ACCOUNT, TREASURY_ACCOUNT_ID } from './config.js';
import { notifyTokenDeposit } from './notify.js';
import { recordUserTrade } from './depositWatcher.js';

const MASTER_KEY = process.env.KEY_ENCRYPTION_MASTER_KEY!;
const configuredRpcList = (process.env.RPC_PROVIDERS || '').split(',').map(u => u.trim()).filter(Boolean);
const qnUrl = (process.env.QUICKNODE_ENDPOINT_URL || '').trim();
const fnFirstList = [
  ...configuredRpcList.filter(u => u.includes('fastnear.com')),
  ...(qnUrl ? [qnUrl] : []),
  ...configuredRpcList.filter(u => !u.includes('fastnear.com')),
];
const RPC_URLS = fnFirstList.length > 0 ? Array.from(new Set(fnFirstList)) : [
  'https://rpc.mainnet.fastnear.com',
  'https://falling-frosty-uranium.near-mainnet.quiknode.pro/0c22cd8057497654c686680b7e7b1dfd0e3bb9ec/'
];
const near = getNear(RPC_URLS);

// ── In-memory token info cache with 30s TTL ───────────────────────────────────
const tokenInfoCache = new Map<string, { data: TokenInfoResult; expiresAt: number }>();

// ── In-memory user balance cache with 8s TTL ──────────────────────────────────
const balanceCache = new Map<number, { data: UserBalances; expiresAt: number }>();

// ── Permanent in-memory token metadata cache (never changes for NEP-141) ───────
const tokenMetaCache = new Map<string, { name: string; symbol: string; decimals: number; totalSupply: string }>();

// ── User token deposit sync debounce map (10s TTL) ───────────────────────────
const lastSyncDepositsMap = new Map<string, number>();

// ── NEAR/USD price cache — refresh every 2 minutes ───────────────────────────
let nearUsdPrice = 0;
let nearUsdLastFetch = 0;

/**
 * FIX 6: Warm the in-memory tokenInfoCache from the DB on startup.
 * Runs a single query for all token_cache rows updated in the last 30 minutes
 * and pre-populates the cache so the first user request after a Railway redeploy
 * doesn't need to hit the blockchain for already-known tokens.
 */
export async function warmTokenInfoCache(): Promise<void> {
  try {
    const db = await getDb();
    const result = await db.query(
      `SELECT * FROM token_cache
       WHERE updated_at > NOW() - INTERVAL '30 minutes'
         AND last_price IS NOT NULL
         AND last_price > 0
       ORDER BY updated_at DESC
       LIMIT 500`
    );
    const nearUsd = await getNearUsdPrice().catch(() => 0);
    let warmed = 0;
    for (const row of result.rows) {
      const lastPrice = parseFloat(row.last_price || '0');
      if (lastPrice <= 0) continue;
      const supply = parseFloat(row.total_supply || '0') / Math.pow(10, row.decimals || 18);
      const mcap = lastPrice > 0 && supply > 0 ? lastPrice * supply : 0;
      const tokenData: TokenInfoResult = {
        address: row.token_address,
        chain: (row.chain as any) || 'near',
        name: row.name ?? '',
        symbol: row.symbol ?? '',
        decimals: row.decimals ?? 18,
        total_supply: row.total_supply ?? '0',
        price: lastPrice.toFixed(12),
        price_usd: nearUsd > 0 ? (lastPrice * nearUsd).toFixed(8) : '0',
        liquidity: row.last_liquidity?.toString() ?? '0',
        liquidity_usd: nearUsd > 0 ? (parseFloat(row.last_liquidity || '0') * nearUsd).toFixed(2) : '0',
        market_cap: mcap,
        market_cap_usd: nearUsd > 0 ? mcap * nearUsd : 0,
        near_usd: nearUsd,
        venue: (row.venue as any) ?? 'unknown',
        rhea_pool_id: row.rhea_pool_id != null ? Number(row.rhea_pool_id) : null,
        bonding_phase: (row.bonding_phase as any) ?? null,
        bonding_progress_pct: row.bonding_progress_pct != null ? Number(row.bonding_progress_pct) : null,
        dcl_pool_id: row.dcl_pool_id ?? null,
        tradeable: isTradableVenue(row.venue),
      };
      // Use a shorter TTL (15s) for warmed entries — they're older DB data, not live RPC
      tokenInfoCache.set(row.token_address, { data: tokenData, expiresAt: Date.now() + 15000 });
      warmed++;
    }
    console.log(`[API] Token cache warmed: ${warmed} tokens pre-loaded from DB.`);
  } catch (err: any) {
    console.warn('[API] Token cache warm failed (non-fatal):', err.message);
  }
}

// ── Helper to detect Sui token addresses & SuiPump curve IDs ─────────────────
export function isSuiToken(rawTokenAddress: string): boolean {
  if (!rawTokenAddress || typeof rawTokenAddress !== 'string') return false;
  const tokenAddress = resolveTokenAddressFromKey(rawTokenAddress.trim());
  const clean = tokenAddress.trim();
  return (
    clean.startsWith('0x') ||
    clean.includes('::') ||
    clean.toLowerCase().includes('suipump')
  );
}

// ── NEAR/USD price with multi-source failover ───────────────────────────────
const NEAR_USD_SOURCES: Array<{ name: string; fetch: () => Promise<number> }> = [
  {
    name: 'binance',
    fetch: async () => {
      const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=NEARUSDT', {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) throw new Error(`binance http ${res.status}`);
      const data: any = await res.json();
      const p = parseFloat(data?.price);
      if (!(p > 0)) throw new Error('binance bad price');
      return p;
    },
  },
  {
    name: 'coinbase',
    fetch: async () => {
      const res = await fetch('https://api.coinbase.com/v2/prices/NEAR-USD/spot', {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) throw new Error(`coinbase http ${res.status}`);
      const data: any = await res.json();
      const p = parseFloat(data?.data?.amount);
      if (!(p > 0)) throw new Error('coinbase bad price');
      return p;
    },
  },
  {
    name: 'coingecko',
    fetch: async () => {
      const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=near&vs_currencies=usd', {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) throw new Error(`coingecko http ${res.status}`);
      const data: any = await res.json();
      const p = data?.near?.usd;
      if (!(p > 0)) throw new Error('coingecko bad price');
      return p;
    },
  },
];

async function fetchNearUsdPrice(): Promise<number> {
  for (const src of NEAR_USD_SOURCES) {
    try {
      return await src.fetch();
    } catch (err: any) {
      console.warn(`[NEAR_USD] ${src.name} failed: ${err?.message || err}`);
    }
  }
  return 0;
}

export async function getNearUsdPrice(): Promise<number> {
  const now = Date.now();
  if (nearUsdPrice > 0) {
    if (now - nearUsdLastFetch >= 120_000) {
      fetchNearUsdPrice()
        .then((p) => {
          if (p > 0) {
            nearUsdPrice = p;
            nearUsdLastFetch = Date.now();
          }
        })
        .catch(() => {});
    }
    return nearUsdPrice;
  }

  const p = await fetchNearUsdPrice();
  if (p > 0) {
    nearUsdPrice = p;
    nearUsdLastFetch = now;
  }
  return nearUsdPrice || 4.9;
}

export interface DexScreenerData {
  priceUsd: number;
  priceNative: number;
  marketCapUsd: number;
  fdvUsd: number;
  volume24hUsd: number;
  priceChange24h: number;
  dexId?: string;
  pairAddress?: string;
  buys24h?: number;
  sells24h?: number;
  txns?: {
    m5?: { buys: number; sells: number };
    h1?: { buys: number; sells: number };
    h6?: { buys: number; sells: number };
    h24?: { buys: number; sells: number };
  };
  liquidityUsd?: number;
  liquidityNative?: number;
}

export async function fetchDexScreenerTokenData(tokenAddress: string): Promise<DexScreenerData | null> {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(tokenAddress)}`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    if (!data.pairs || data.pairs.length === 0) return null;
    const nearPairs = data.pairs.filter(
      (p: any) => p.chainId === 'near' || p.chainId === 'sui' || p.dexId?.includes('rhea') || p.dexId?.includes('ref')
    );
    const pool = (nearPairs.length > 0 ? nearPairs : data.pairs).sort(
      (a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
    )[0];
    if (!pool) return null;

    const buys24h = pool.txns?.h24?.buys ?? (pool.txns?.h6?.buys || pool.txns?.h1?.buys || pool.txns?.m5?.buys || 0);
    const sells24h = pool.txns?.h24?.sells ?? (pool.txns?.h6?.sells || pool.txns?.h1?.sells || pool.txns?.m5?.sells || 0);

    return {
      priceUsd: pool.priceUsd ? parseFloat(pool.priceUsd) : 0,
      priceNative: pool.priceNative ? parseFloat(pool.priceNative) : 0,
      marketCapUsd: pool.marketCap || pool.fdv || 0,
      fdvUsd: pool.fdv || pool.marketCap || 0,
      volume24hUsd: pool.volume?.h24 || 0,
      priceChange24h: pool.priceChange?.h24 || 0,
      dexId: pool.dexId,
      pairAddress: pool.pairAddress,
      buys24h,
      sells24h,
      txns: pool.txns,
      liquidityUsd: pool.liquidity?.usd ? Number(pool.liquidity.usd) : 0,
      liquidityNative: pool.liquidity?.quote ? Number(pool.liquidity.quote) : 0,
    };
  } catch {
    return null;
  }
}

// ── In-memory cache for token holders count (60s TTL) ────────────────────────
const holdersCountCache = new Map<string, { at: number; data: { count: number } | null }>();
const HOLDERS_CACHE_TTL_MS = 60_000;
const TXNS_CACHE_TTL_MS = 60_000;
const txnsCountCache = new Map<string, { at: number; count: number }>();

/**
 * Fetches exact total token holders count for NEAR tokens via NearBlocks (with FastNear fallback).
 */
export async function fetchTokenHoldersCount(
  tokenAddress: string,
  isSui: boolean = false
): Promise<{ count: number } | null> {
  if (isSui) return null;
  const norm = tokenAddress.toLowerCase().trim();
  const cached = holdersCountCache.get(norm);
  if (cached && Date.now() - cached.at < HOLDERS_CACHE_TTL_MS) {
    return cached.data;
  }

  // 1. Primary: NearBlocks exact holders count endpoint (returns total network-wide holders integer)
  try {
    const res = await fetch(`https://api.nearblocks.io/v1/fts/${encodeURIComponent(norm)}/holders/count`, {
      signal: AbortSignal.timeout(3000),
      headers: { Accept: 'application/json' },
    });
    if (res.ok) {
      const data = (await res.json()) as any;
      const rawCount = data?.holders?.[0]?.count;
      if (rawCount !== undefined && rawCount !== null) {
        const count = parseInt(String(rawCount), 10);
        if (!isNaN(count) && count > 0) {
          const result = { count };
          holdersCountCache.set(norm, { at: Date.now(), data: result });
          return result;
        }
      }
    }
  } catch { /* fallback */ }

  // 2. Secondary: NearBlocks holders list (can also carry total in count field or pagination)
  try {
    const res = await fetch(`https://api.nearblocks.io/v1/fts/${encodeURIComponent(norm)}/holders?page=1&per_page=1`, {
      signal: AbortSignal.timeout(3000),
      headers: { Accept: 'application/json' },
    });
    if (res.ok) {
      const data = (await res.json()) as any;
      // NearBlocks returns total count in count, total, or holders array header
      const totalCount = data?.count ?? data?.total ?? data?.holders_count;
      if (totalCount !== undefined && totalCount !== null) {
        const count = parseInt(String(totalCount), 10);
        if (!isNaN(count) && count > 0) {
          const result = { count };
          holdersCountCache.set(norm, { at: Date.now(), data: result });
          return result;
        }
      }
    }
  } catch { /* fallback */ }

  // 3. FastNear API fallback — this endpoint returns at most the top 100 accounts;
  //    do NOT use accounts.length as a total because it will always be capped at 100.
  //    Only use it to confirm there is at least 1 holder with a non-zero balance.
  try {
    const res = await fetch(`https://api.fastnear.com/v1/ft/${encodeURIComponent(norm)}/top`, {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = (await res.json()) as any;
      const accounts: any[] = data.accounts || [];
      const active = accounts.filter((a: any) => {
        try { return a.balance && BigInt(a.balance) > 0n; } catch { return false; }
      });
      // Only return a count if fewer than 100 active — otherwise the value is capped/unreliable.
      // If exactly 100, we cannot distinguish "exactly 100 holders" from "100+ holders" (cap hit).
      if (active.length > 0 && active.length < 100) {
        const result = { count: active.length };
        holdersCountCache.set(norm, { at: Date.now(), data: result });
        return result;
      }
    }
  } catch { /* non-fatal */ }

  return null;
}


/**
 * Fetches total on-chain transactions count for NEAR token contracts.
 */
export async function fetchTokenTotalTxns(
  tokenAddress: string,
  isSui: boolean = false
): Promise<number | null> {
  if (isSui) return null;
  const norm = tokenAddress.toLowerCase().trim();
  const cached = txnsCountCache.get(norm);
  if (cached && Date.now() - cached.at < TXNS_CACHE_TTL_MS) {
    return cached.count;
  }

  try {
    const res = await fetch(`https://api.nearblocks.io/v1/account/${encodeURIComponent(norm)}/txns/count`, {
      signal: AbortSignal.timeout(2000),
      headers: { Accept: 'application/json' },
    });
    if (res.ok) {
      const data = (await res.json()) as any;
      const rawCount = data?.txns?.[0]?.count;
      if (rawCount !== undefined && rawCount !== null) {
        const count = parseInt(String(rawCount), 10);
        if (!isNaN(count) && count > 0) {
          txnsCountCache.set(norm, { at: Date.now(), count });
          return count;
        }
      }
    }
  } catch { /* non-fatal */ }

  return null;
}

export interface TokenInfoResult {
  address: string;
  chain?: 'near' | 'sui';
  name: string;
  symbol: string;
  decimals: number;
  total_supply: string;
  price: string;           // price in native token (NEAR or SUI)
  price_usd: string;       // price in USD
  price_24h_change?: number; // 24h % change from DexScreener/Rhea
  volume_24h_usd?: number;   // 24h volume in USD
  liquidity: string;       // liquidity in native token (NEAR or SUI)
  liquidity_usd: string;   // liquidity in USD
  market_cap: number;      // market cap in native token (NEAR or SUI)
  market_cap_usd: number;  // market cap in USD
  near_usd: number;        // NEAR/USD or SUI/USD exchange rate
  sui_usd?: number;
  venue: VenueName | 'unknown' | (string & {});
  rhea_pool_id?: number | null;
  bonding_phase?: 'prebonded' | 'bonded' | null;
  bonding_progress_pct?: number | null;
  dcl_pool_id?: string | null;
  tradeable: boolean;   // false for venues we support info but not trading on
  sui_curve_address?: string;
  sui_coin_type?: string;
  holders_count?: number | null;
  buys_count?: number | null;
  sells_count?: number | null;
  trades_timeframe?: '24h' | 'Curve' | null;
  total_txns?: number | null;
}

/**
 * Detect whether a token address belongs to meme.cooking launchpad.
 */
function isMemooCookingToken(tokenAddress: string): boolean {
  return tokenAddress.endsWith('.meme-cooking.near');
}

/**
 * Detect whether a token address belongs to intear launchpad.
 */
function isIntearToken(tokenAddress: string): boolean {
  return tokenAddress.endsWith('.launch.intear.near') || tokenAddress.endsWith('.intear.near');
}

/**
 * Fetch meme.cooking token state from on-chain.
 */
async function getMemeCookingTokenInfo(tokenAddress: string): Promise<{ price: number; liquidity: number; phase: string; progress: number }> {
  const memeId = parseMemeCookingId(tokenAddress);
  if (memeId === null) {
    return { price: 0, liquidity: 0, phase: 'unknown', progress: 0 };
  }

  try {
    const meme = await near.view<any>('meme-cooking.near', 'get_meme', { meme_id: memeId }).catch(() => null);
    if (meme) {
      const totalStaked = parseFloat(meme.total_staked || '0') / 1e24;
      const hardCap = parseFloat(meme.hard_cap || '0') / 1e24;
      const tokensToDistribute = parseFloat(meme.amount_to_be_distributed || meme.total_supply || '0') / Math.pow(10, meme.decimals || 18);
      const price = tokensToDistribute > 0 ? totalStaked / tokensToDistribute : 0;
      const progress = hardCap > 0 ? Math.min(100, (totalStaked / hardCap) * 100) : 0;
      return { price, liquidity: totalStaked, phase: 'prebonded', progress };
    }
  } catch { /* no-op */ }

  try {
    const fin = await near.view<any>('meme-cooking.near', 'get_finalized_meme', { meme_id: memeId }).catch(() => null);
    if (fin) {
      return { price: 0, liquidity: 0, phase: 'bonded', progress: 100 };
    }
  } catch { /* no-op */ }

  return { price: 0, liquidity: 0, phase: 'unknown', progress: 0 };
}

/**
 * Get token info with a short in-memory TTL cache.
 * Fetches ft_metadata + pool reserves from Shardsmarket, Rhea, NearlyTrade, or other known launchpads.
 * Never returns hardcoded data.
 *
 * Freshness contract (volatile meme tokens move 30%+ in seconds):
 *  - In-memory cache: 15s max.
 *  - DB token_cache (written by the detector): accepted only when <15s old,
 *    and re-cached in memory only for the row's REMAINING freshness — a stale
 *    row must never start a fresh cache window.
 *  - forceRefresh skips BOTH caches and always reads live pool state. Before
 *    this, forceRefresh only skipped the in-memory cache, so holdings/PNL
 *    views could show prices up to ~2 minutes old (150k mcap shown at 200k).
 */
const TOKEN_INFO_MEM_TTL_MS = 15_000;
const TOKEN_INFO_DB_MAX_AGE_MS = 15_000;

/**
 * Fast-path route resolution for swaps.
 * Resolves token venue, pool IDs, chain, symbol, and decimals from in-memory cache
 * or Postgres DB cache in < 2ms, bypassing all DexScreener/RPC discovery.
 * If the token has never been seen before, falls back to full getTokenInfo.
 */
export async function getFastTokenRoute(rawTokenAddress: string): Promise<TokenInfoResult> {
  let tokenAddress = resolveTokenAddressFromKey(rawTokenAddress);
  if (tokenAddress.startsWith('t_')) {
    const dbResolved = await findTokenAddressByShortKey(tokenAddress).catch(() => null);
    if (dbResolved) {
      registerShortTokenKey(tokenAddress, dbResolved);
      tokenAddress = dbResolved;
    }
  }

  // 1. In-memory cache hit (< 0.1ms)
  const cached = tokenInfoCache.get(tokenAddress) || tokenInfoCache.get(rawTokenAddress);
  if (cached && Date.now() < cached.expiresAt && cached.data.tradeable) {
    return cached.data;
  }

  // 2. DB cache hit (< 2ms)
  const dbCache = await getTokenCache(tokenAddress).catch(() => null);
  if (
    dbCache &&
    dbCache.venue &&
    ['rhea', 'ref', 'shardsmarket', 'nearlytrade', 'intear', 'onetokenhub', 'nearpad', 'gaypad', 'memecooking', 'shoremarkets', 'kelytra', 'suipump'].includes(dbCache.venue)
  ) {
    const isSui = dbCache.chain === 'sui' || isSuiToken(tokenAddress);
    if (isSui && (Number(dbCache.last_liquidity || 0) === 0 || dbCache.total_supply === '1000000000000000')) {
      return getTokenInfo(rawTokenAddress, true);
    }
    const nativeUsd = isSui ? await getSuiUsdPrice().catch(() => 2.0) : await getNearUsdPrice().catch(() => 4.5);
    const lastPrice = Number(dbCache.last_price || 0);
    const decimals = dbCache.decimals !== null && dbCache.decimals !== undefined ? Number(dbCache.decimals) : (isSui ? 9 : 18);
    const supply = parseFloat(dbCache.total_supply || '0') / Math.pow(10, decimals);
    const mcap = lastPrice > 0 && supply > 0 ? lastPrice * supply : 0;

    const result: TokenInfoResult = {
      address: tokenAddress,
      chain: (dbCache.chain as any) || (isSui ? 'sui' : 'near'),
      name: dbCache.name || 'Token',
      symbol: dbCache.symbol || 'TOKEN',
      decimals,
      total_supply: dbCache.total_supply || '0',
      price: dbCache.last_price?.toString() || '0',
      price_usd: nativeUsd > 0 ? (lastPrice * nativeUsd).toFixed(8) : '0',
      liquidity: dbCache.last_liquidity?.toString() || '0',
      liquidity_usd: nativeUsd > 0 ? (Number(dbCache.last_liquidity || 0) * nativeUsd).toFixed(2) : '0',
      market_cap: mcap,
      market_cap_usd: nativeUsd > 0 ? mcap * nativeUsd : 0,
      near_usd: isSui ? 0 : nativeUsd,
      sui_usd: isSui ? nativeUsd : 0,
      venue: dbCache.venue as any,
      rhea_pool_id: dbCache.rhea_pool_id ? Number(dbCache.rhea_pool_id) : null,
      bonding_phase: (dbCache.bonding_phase as any) ?? null,
      bonding_progress_pct:
        dbCache.bonding_progress_pct !== null && dbCache.bonding_progress_pct !== undefined
          ? Number(dbCache.bonding_progress_pct)
          : null,
      dcl_pool_id: dbCache.dcl_pool_id ?? null,
      tradeable: true,
      sui_coin_type: isSui ? tokenAddress : undefined,
    };

    tokenInfoCache.set(tokenAddress, { data: result, expiresAt: Date.now() + TOKEN_INFO_MEM_TTL_MS });
    tokenInfoCache.set(rawTokenAddress, { data: result, expiresAt: Date.now() + TOKEN_INFO_MEM_TTL_MS });
    return result;
  }

  // 3. Fallback: full resolution if never cached
  return getTokenInfo(rawTokenAddress, false);
}

export async function getTokenInfo(rawTokenAddress: string, forceRefresh = false): Promise<TokenInfoResult> {
  let tokenAddress = resolveTokenAddressFromKey(rawTokenAddress);
  if (tokenAddress.startsWith('t_')) {
    const dbResolved = await findTokenAddressByShortKey(tokenAddress).catch(() => null);
    if (dbResolved) {
      registerShortTokenKey(tokenAddress, dbResolved);
      tokenAddress = dbResolved;
    }
  }

  if (!forceRefresh) {
    const cached = tokenInfoCache.get(tokenAddress) || tokenInfoCache.get(rawTokenAddress);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.data;
    }
  }

  // ── SUI / SuiPump Token Resolution ──────────────────────────────────────────
  if (isSuiToken(tokenAddress)) {
    const [curve, suiUsd] = await Promise.all([
      getSuiPumpCurveState(tokenAddress),
      getSuiUsdPrice().catch(() => 2.0),
    ]);

    if (!curve) {
      // Fallback: fetch on-chain CoinMetadata, DexScreener market data, Aftermath SOR route, and on-chain supply in parallel
      const [meta, dexData, routerQuote, onChainSupply] = await Promise.all([
        getSuiTokenMetadata(tokenAddress).catch(() => null),
        fetchDexScreenerTokenData(tokenAddress).catch(() => null),
        getSuiRouterQuote({
          coinInType: '0x2::sui::SUI',
          coinOutType: tokenAddress,
          amountIn: 1_000_000_000n, // 1 SUI probe quote
        }).catch(() => null),
        getSuiTokenSupply(tokenAddress).catch(() => null),
      ]);

      if (meta || dexData || routerQuote) {
        const decimals = meta?.decimals ?? (dexData as any)?.decimals ?? 9;
        const name = meta?.name || (dexData as any)?.name || tokenAddress.split('::').pop() || 'Sui Token';
        const symbol = meta?.symbol || (dexData as any)?.symbol || tokenAddress.split('::').pop() || 'SUI';

        let priceSui = 0;
        if (dexData?.priceNative && dexData.priceNative > 0) {
          priceSui = dexData.priceNative;
        } else if (routerQuote?.spotPrice && routerQuote.spotPrice > 0) {
          priceSui = routerQuote.spotPrice;
        } else if (routerQuote?.expectedAmountOut && routerQuote.expectedAmountOut > 0n) {
          const inHuman = Number(routerQuote.amountIn) / 1e9;
          const outHuman = Number(routerQuote.expectedAmountOut) / Math.pow(10, decimals);
          if (outHuman > 0) priceSui = inHuman / outHuman;
        }

        const priceUsd = priceSui > 0 ? priceSui * suiUsd : (dexData?.priceUsd || 0);
        const venue = (dexData?.dexId || routerQuote?.venue || 'sui_dex').toLowerCase();

        // Calculate accurate liquidity in SUI and USD
        const liqSui = dexData?.liquidityNative && dexData.liquidityNative > 0
          ? dexData.liquidityNative
          : (dexData?.liquidityUsd && suiUsd > 0 ? dexData.liquidityUsd / suiUsd : 0);
        const liqUsd = dexData?.liquidityUsd || (liqSui > 0 ? liqSui * suiUsd : 0);

        // Derive accurate total supply
        let totalSupply = onChainSupply;
        if (!totalSupply) {
          const capUsd = dexData?.fdvUsd || dexData?.marketCapUsd || 0;
          const pUsd = priceUsd > 0 ? priceUsd : (dexData?.priceUsd || 0);
          if (capUsd > 0 && pUsd > 0) {
            const rawTokens = capUsd / pUsd;
            try {
              totalSupply = (BigInt(Math.round(rawTokens)) * BigInt(10 ** decimals)).toString();
            } catch {
              totalSupply = Math.round(rawTokens * Math.pow(10, decimals)).toString();
            }
          } else {
            totalSupply = (1_000_000_000n * BigInt(10 ** decimals)).toString();
          }
        }

        const supplyHuman = parseFloat(totalSupply) / Math.pow(10, decimals);
        const mcapUsd = dexData?.marketCapUsd || (dexData?.fdvUsd) || (priceUsd > 0 ? priceUsd * supplyHuman : 0);
        const mcapSui = suiUsd > 0 && mcapUsd > 0 ? mcapUsd / suiUsd : (priceSui > 0 ? priceSui * supplyHuman : 0);

        const result: TokenInfoResult = {
          address: tokenAddress,
          chain: 'sui',
          name,
          symbol,
          decimals,
          total_supply: totalSupply,
          price: priceSui > 0 ? priceSui.toFixed(9) : '0',
          price_usd: priceUsd > 0 ? priceUsd.toFixed(8) : '0',
          liquidity: liqSui > 0 ? liqSui.toFixed(2) : '0',
          liquidity_usd: liqUsd > 0 ? liqUsd.toFixed(2) : '0',
          market_cap: mcapSui,
          market_cap_usd: mcapUsd,
          near_usd: suiUsd,
          sui_usd: suiUsd,
          venue: venue as any,
          bonding_phase: 'bonded',
          tradeable: true,
          sui_coin_type: tokenAddress,
          buys_count: dexData?.buys24h ?? null,
          sells_count: dexData?.sells24h ?? null,
          trades_timeframe: '24h',
          total_txns: null,
        };
        tokenInfoCache.set(tokenAddress, { data: result, expiresAt: Date.now() + TOKEN_INFO_MEM_TTL_MS });
        tokenInfoCache.set(rawTokenAddress, { data: result, expiresAt: Date.now() + TOKEN_INFO_MEM_TTL_MS });

        upsertTokenCache({
          token_address: tokenAddress,
          chain: 'sui',
          name,
          symbol,
          decimals,
          total_supply: totalSupply,
          venue: venue as any,
          bonding_phase: 'bonded',
          last_price: priceSui,
          last_liquidity: liqSui,
        }).catch(() => {});

        return result;
      }

      throw new Error(`Sui token or DEX pool not found: ${tokenAddress}`);
    }

    const priceSui = curve.lastPriceSui;
    const priceUsd = priceSui * suiUsd;
    const mcapSui = curve.marketCapSui;
    const mcapUsd = mcapSui * suiUsd;
    const liqSui = curve.reserveSui;
    const liqUsd = liqSui * suiUsd;
    const curveTotalSupply = (1_000_000_000n * BigInt(10 ** curve.decimals)).toString();

    const result: TokenInfoResult = {
      address: curve.tokenType || curve.curveId,
      chain: 'sui',
      name: curve.name,
      symbol: curve.symbol,
      decimals: curve.decimals,
      total_supply: curveTotalSupply,
      price: priceSui.toFixed(9),
      price_usd: priceUsd.toFixed(8),
      liquidity: liqSui.toFixed(4),
      liquidity_usd: liqUsd.toFixed(2),
      market_cap: mcapSui,
      market_cap_usd: mcapUsd,
      near_usd: suiUsd,
      sui_usd: suiUsd,
      venue: 'suipump',
      bonding_phase: curve.graduated ? 'bonded' : 'prebonded',
      bonding_progress_pct: curve.bondingProgressPct,
      tradeable: true,
      sui_curve_address: curve.curveId,
      sui_coin_type: curve.tokenType,
      buys_count: curve.buys ?? null,
      sells_count: curve.sells ?? null,
      trades_timeframe: 'Curve',
      total_txns: null,
    };

    tokenInfoCache.set(tokenAddress, { data: result, expiresAt: Date.now() + TOKEN_INFO_MEM_TTL_MS });
    if (curve.curveId) {
      tokenInfoCache.set(curve.curveId, { data: result, expiresAt: Date.now() + TOKEN_INFO_MEM_TTL_MS });
    }
    if (curve.tokenType) {
      tokenInfoCache.set(curve.tokenType, { data: result, expiresAt: Date.now() + TOKEN_INFO_MEM_TTL_MS });
    }

    upsertTokenCache({
      token_address: curve.tokenType,
      chain: 'sui',
      name: curve.name,
      symbol: curve.symbol,
      decimals: curve.decimals,
      total_supply: curve.reserveTokensRaw.toString(),
      pool_address: curve.curveId,
      venue: 'suipump',
      bonding_phase: curve.graduated ? 'bonded' : 'prebonded',
      bonding_progress_pct: curve.bondingProgressPct,
      last_price: priceSui,
      last_liquidity: liqSui,
    }).catch(() => {});

    return result;
  }

  // Fetch NEAR/USD price, DexScreener live market stats, on-chain holders, and total txns in parallel
  const nearUsdPromise = getNearUsdPrice().catch(() => 0);
  const dexDataPromise = fetchDexScreenerTokenData(tokenAddress).catch(() => null);
  const holdersDataPromise = fetchTokenHoldersCount(tokenAddress).catch(() => null);
  const totalTxnsPromise = fetchTokenTotalTxns(tokenAddress).catch(() => null);

  // Always read the DB row (metadata + pool IDs are stable topology, reused
  // below), but only ACCEPT its cached price when it's <15s old — and never
  // on forceRefresh: callers asking for live data get live pool reads.
  const dbCache = await getTokenCache(tokenAddress).catch(() => null);
  if (
    !forceRefresh &&
    dbCache &&
    dbCache.updated_at &&
    Date.now() - dbCache.updated_at.getTime() < TOKEN_INFO_DB_MAX_AGE_MS &&
    Number(dbCache.last_price || 0) > 0
  ) {
    const lastPrice = Number(dbCache.last_price || 0);
    const supply = parseFloat(dbCache.total_supply || '0') / Math.pow(10, dbCache.decimals || 18);
    const mcap = lastPrice > 0 && supply > 0 ? lastPrice * supply : 0;
    const [nearUsd, dexData, holdersData, totalTxns] = await Promise.all([
      nearUsdPromise,
      dexDataPromise,
      holdersDataPromise,
      totalTxnsPromise,
    ]);
    const result: TokenInfoResult = {
      address: tokenAddress,
      name: dbCache.name ?? '',
      symbol: dbCache.symbol ?? '',
      decimals: dbCache.decimals ?? 18,
      total_supply: dbCache.total_supply ?? '0',
      price: dbCache.last_price?.toString() ?? '0',
      price_usd: nearUsd > 0 ? (lastPrice * nearUsd).toFixed(8) : '0',
      price_24h_change: dexData?.priceChange24h !== undefined ? dexData.priceChange24h : undefined,
      volume_24h_usd: dexData?.volume24hUsd !== undefined ? dexData.volume24hUsd : undefined,
      liquidity: dbCache.last_liquidity?.toString() ?? '0',
      liquidity_usd: nearUsd > 0 ? (Number(dbCache.last_liquidity || 0) * nearUsd).toFixed(2) : '0',
      market_cap: mcap,
      market_cap_usd: nearUsd > 0 ? mcap * nearUsd : 0,
      near_usd: nearUsd,
      venue: (dbCache.venue as any) ?? 'unknown',
      rhea_pool_id: dbCache.rhea_pool_id,
      bonding_phase: (dbCache.bonding_phase as any) ?? null,
      bonding_progress_pct:
        dbCache.bonding_progress_pct !== null && dbCache.bonding_progress_pct !== undefined
          ? Number(dbCache.bonding_progress_pct)
          : null,
      dcl_pool_id: dbCache.dcl_pool_id ?? null,
      tradeable: isTradableVenue(dbCache.venue),
      holders_count: holdersData?.count ?? null,
      buys_count: dexData?.buys24h ?? null,
      sells_count: dexData?.sells24h ?? null,
      trades_timeframe: '24h',
      total_txns: totalTxns ?? null,
    };
    // Cache only for the DB row's REMAINING freshness — a 12s-old row gets
    // 3s, not a fresh window. Stale data must never renew itself.
    const remainingFreshMs = Math.max(2_000, TOKEN_INFO_DB_MAX_AGE_MS - (Date.now() - dbCache.updated_at.getTime()));
    tokenInfoCache.set(tokenAddress, { data: result, expiresAt: Date.now() + remainingFreshMs });
    return result;
  }

  // Fetch ft_metadata & total_supply — if cached in memory or in DB, reuse without RPC call
  let meta: { name: string; symbol: string; decimals: number };
  let totalSupply = '0';

  const inMem = tokenMetaCache.get(tokenAddress);
  if (inMem && inMem.totalSupply && inMem.totalSupply !== '0') {
    meta = { name: inMem.name, symbol: inMem.symbol, decimals: inMem.decimals };
    totalSupply = inMem.totalSupply;
  } else if (
    dbCache &&
    dbCache.name &&
    dbCache.symbol &&
    dbCache.decimals !== null &&
    dbCache.decimals !== undefined &&
    dbCache.total_supply &&
    dbCache.total_supply !== '0'
  ) {
    meta = { name: dbCache.name, symbol: dbCache.symbol, decimals: Number(dbCache.decimals) };
    totalSupply = dbCache.total_supply;
    tokenMetaCache.set(tokenAddress, { ...meta, totalSupply });
  } else {
    try {
      const [fetchedMeta, fetchedSupply] = await Promise.all([
        inMem
          ? Promise.resolve({ name: inMem.name, symbol: inMem.symbol, decimals: inMem.decimals })
          : near.getTokenMetadata(tokenAddress),
        near.getTokenTotalSupply(tokenAddress).catch(() => '0'),
      ]);
      meta = fetchedMeta;
      totalSupply = fetchedSupply;
      tokenMetaCache.set(tokenAddress, { ...meta, totalSupply });
    } catch {
      // If RPC metadata fetch fails, fall back to DB cache data if available
      if (dbCache && dbCache.name) {
        meta = { name: dbCache.name ?? 'Unknown', symbol: dbCache.symbol ?? '???', decimals: dbCache.decimals ?? 18 };
        totalSupply = dbCache.total_supply ?? '0';
      } else {
        // Last resort: return a minimal result so the caller can still identify the token
        return {
          address: tokenAddress,
          name: 'Unknown',
          symbol: '???',
          decimals: 18,
          total_supply: '0',
          price: '0',
          price_usd: '0',
          liquidity: '0',
          liquidity_usd: '0',
          market_cap: 0,
          market_cap_usd: 0,
          near_usd: 0,
          venue: 'unknown',
          tradeable: false,
        };
      }
    }
  }

  // Safety fallback: if totalSupply is still missing or '0', fetch directly from contract
  if ((!totalSupply || totalSupply === '0') && tokenAddress) {
    try {
      const onChainSupply = await near.getTokenTotalSupply(tokenAddress).catch(() => '0');
      if (onChainSupply && onChainSupply !== '0') {
        totalSupply = onChainSupply;
        tokenMetaCache.set(tokenAddress, { ...meta, totalSupply });
      }
    } catch { /* no-op */ }
  }

  let price = 0;
  let liquidity = 0;
  let venue: TokenInfoResult['venue'] = 'unknown';
  let rheaPoolId: number | null = dbCache?.rhea_pool_id ?? null;
  let bondingPhase: 'prebonded' | 'bonded' | null = (dbCache?.bonding_phase as any) ?? null;
  let bondingProgressPct: number | null =
    dbCache?.bonding_progress_pct !== null && dbCache?.bonding_progress_pct !== undefined
      ? Number(dbCache.bonding_progress_pct)
      : null;
  let dclPoolId: string | null = dbCache?.dcl_pool_id ?? null;

  // Fast-path: if dbCache already knows the exact Rhea pool ID or DCL pool ID, check it directly in 1 view call (<50ms)
  if (dbCache && (dbCache.venue === 'rhea' || dbCache.venue === 'ref')) {
    if (dbCache.dcl_pool_id) {
      try {
        const parts = dbCache.dcl_pool_id.split('|');
        const paired = parts.length >= 2 ? (parts[0] === tokenAddress ? parts[1] : parts[0]) : 'wrap.near';
        const st = await near.getDclPoolState(dbCache.dcl_pool_id, paired);
        if (st.price > 0 && st.liquidityNear >= 0.1) {
          price = st.price;
          liquidity = st.liquidityNear;
          venue = 'rhea';
          dclPoolId = dbCache.dcl_pool_id;
        }
      } catch { /* fallback to discovery below */ }
    } else if (dbCache.rhea_pool_id) {
      try {
        const rh = await near.getRheaPoolReserves(dbCache.rhea_pool_id, 'wrap.near', tokenAddress).catch(() => null);
        if (rh) {
          const reserveNearHuman = parseFloat(rh.reserveIn) / 1e24;
          const reserveTokenHuman = parseFloat(rh.reserveOut) / Math.pow(10, meta.decimals);
          const poolLiq = reserveNearHuman * 2;
          // Only trust cached simple pool if it has meaningful liquidity (>= 5 NEAR).
          // Dust/spam pools (e.g. < 5 NEAR) shouldn't prevent discovery of deep DCL or launchpad pools.
          if (reserveNearHuman > 0 && reserveTokenHuman > 0 && poolLiq >= 5) {
            price = reserveNearHuman / reserveTokenHuman;
            liquidity = poolLiq;
            venue = 'rhea';
            rheaPoolId = dbCache.rhea_pool_id;
          }
        }
      } catch { /* fallback to discovery below */ }
    }
  }

  // Step 1: Fast launchpad detection by token suffix (instant on-chain RPC lookup)
  if (isMemooCookingToken(tokenAddress)) {
    try {
      const mcInfo = await getMemeCookingTokenInfo(tokenAddress).catch(() => ({ price: 0, liquidity: 0, phase: 'unknown', progress: 0 }));
      if (mcInfo.price > 0 || mcInfo.liquidity > 0) {
        venue = 'memecooking';
        price = mcInfo.price;
        liquidity = mcInfo.liquidity;
        bondingPhase = mcInfo.phase === 'bonded' ? 'bonded' : (mcInfo.phase === 'prebonded' ? 'prebonded' : null);
        bondingProgressPct = mcInfo.progress;
      }
    } catch { /* no-op */ }
  } else if (isIntearToken(tokenAddress)) {
    try {
      const intearState = await near.getIntearTokenState(tokenAddress);
      if (intearState && intearState.price > 0) {
        venue = 'intear';
        price = intearState.price;
        liquidity = intearState.liquidityNear;
        if (intearState.totalSupply && intearState.totalSupply !== '0') {
          totalSupply = intearState.totalSupply;
        }
      }
    } catch { /* no-op */ }
  } else if (tokenAddress.endsWith('.nearlytrade.near')) {
    try {
      const ntState = await near.getNearlytradeTokenState(tokenAddress);
      if (ntState && ntState.price > 0) {
        venue = 'nearlytrade';
        price = ntState.price;
        liquidity = ntState.liquidityNear;
        bondingPhase = ntState.phase;
        bondingProgressPct = ntState.bondingProgressPct;
        dclPoolId = ntState.dclPoolId;
        if (ntState.totalSupply && ntState.totalSupply !== '0') {
          totalSupply = ntState.totalSupply;
        }
      }
    } catch { /* no-op */ }
  } else if (tokenAddress.endsWith('.factory.shardsmarket.near')) {
    try {
      const smState = await near.getShardsmarketTokenState(tokenAddress);
      const reserveNearYocto = parseFloat(smState.poolQuote || '0');
      const reserveTokenRaw = parseFloat(smState.poolToken || '0');
      if (reserveNearYocto > 0 && reserveTokenRaw > 0) {
        const reserveNearHuman = reserveNearYocto / 1e24;
        const reserveTokenHuman = reserveTokenRaw / Math.pow(10, meta.decimals);
        if (reserveTokenHuman > 0) {
          price = reserveNearHuman / reserveTokenHuman;
          liquidity = reserveNearHuman * 2;
          venue = 'shardsmarket';
          if (smState.totalSupply && smState.totalSupply !== '0') {
            totalSupply = smState.totalSupply;
          }
        }
      }
    } catch { /* no-op */ }
  } else if (tokenAddress.endsWith('.pad.onetokenhub.near')) {
    try {
      const hubState = await near.getOneTokenHubState(tokenAddress);
      if (hubState && hubState.price > 0) {
        venue = 'onetokenhub';
        price = hubState.price;
        liquidity = hubState.liquidityNear;
        dclPoolId = hubState.dclPoolId;
        if (hubState.totalSupply && hubState.totalSupply !== '0') {
          totalSupply = hubState.totalSupply;
        }
      }
    } catch { /* no-op */ }
  } else if (tokenAddress.endsWith('.nearpadfamily.near')) {
    try {
      const padState = await near.getNEARpadState(tokenAddress);
      if (padState && padState.price > 0) {
        venue = 'nearpad';
        price = padState.price;
        liquidity = padState.liquidityNear;
        dclPoolId = padState.dclPoolId;
        if (padState.totalSupply && padState.totalSupply !== '0') {
          totalSupply = padState.totalSupply;
        }
      }
    } catch { /* no-op */ }
  } else if (tokenAddress.endsWith('.gaypad.j1-racing.near')) {
    try {
      const gpState = await near.getGaypadTokenState(tokenAddress);
      if (gpState && gpState.price > 0) {
        venue = 'gaypad';
        price = gpState.price;
        liquidity = gpState.liquidityNear;
        bondingPhase = gpState.phase;
        bondingProgressPct = gpState.bondingProgressPct;
        if (gpState.totalSupply && gpState.totalSupply !== '0') {
          totalSupply = gpState.totalSupply;
        }
      }
    } catch { /* no-op */ }
  } else if (tokenAddress.endsWith('.launchpad.justhoot.near') || tokenAddress.endsWith('.justhoot.near')) {
    try {
      const dclId = `${tokenAddress}|wrap.near|10000`;
      const dclState = await near.getDclPoolState(dclId, 'wrap.near').catch(() => null);
      if (dclState && dclState.price > 0 && dclState.liquidityNear > 0) {
        venue = 'rhea';
        price = dclState.price;
        liquidity = dclState.liquidityNear;
        dclPoolId = dclId;
      }
    } catch { /* no-op */ }
  } else if (tokenAddress.endsWith('.launch.shoremarkets.near')) {
    try {
      const smState = await near.getShoremarketsTokenState(tokenAddress);
      if (smState && smState.price > 0) {
        venue = 'shoremarkets';
        price = smState.price;
        liquidity = smState.liquidityNear;
        bondingPhase = smState.phase;
        bondingProgressPct = smState.bondingProgressPct;
        dclPoolId = smState.dclPoolId;
        if (smState.totalSupply && smState.totalSupply !== '0') {
          totalSupply = smState.totalSupply;
        }
      }
    } catch { /* no-op */ }
  } else if (tokenAddress.endsWith('.exchange.kelytradevs.near') || tokenAddress.endsWith('.kelytra.near')) {
    try {
      const ktState = await near.getKelytraTokenState(tokenAddress);
      if (ktState && ktState.price > 0) {
        venue = 'kelytra';
        price = ktState.price;
        liquidity = ktState.liquidityNear;
        bondingPhase = ktState.phase;
        bondingProgressPct = ktState.bondingProgressPct;
        dclPoolId = ktState.dclPoolId;
        if (ktState.totalSupply && ktState.totalSupply !== '0') {
          totalSupply = ktState.totalSupply;
        }
      }
    } catch { /* no-op */ }
  }

  // Step 2: If price was not found or if token is potentially on Ref/Rhea (bonded or general token)
  let rheaCandidate: { venue: 'rhea'; price: number; liquidity: number; rheaPoolId: number | null; dclPoolId: string | null } | null = null;
  if (venue === 'unknown' || bondingPhase === 'bonded') {
    try {
      const rhea = await near.findRheaPoolForToken(tokenAddress);
      if (rhea && rhea.poolId !== null && rhea.poolId !== undefined && rhea.price > 0) {
        rheaCandidate = {
          venue: 'rhea',
          price: rhea.price,
          liquidity: rhea.liquidityNear,
          rheaPoolId: !rhea.isDcl && typeof rhea.poolId === 'number' ? rhea.poolId : null,
          dclPoolId: rhea.isDcl ? String(rhea.poolId) : null,
        };
        // Prefer Rhea if it has deeper liquidity or if venue was unknown
        if (venue === 'unknown' || rheaCandidate.liquidity >= (liquidity + 5) || bondingPhase === 'bonded') {
          venue = 'rhea';
          price = rheaCandidate.price;
          liquidity = rheaCandidate.liquidity;
          rheaPoolId = rheaCandidate.rheaPoolId;
          dclPoolId = rheaCandidate.dclPoolId ?? dclPoolId;
        }
      }
    } catch { /* no-op */ }
  }

  // Step 3: Generic fallback venue probe for non-standard suffixes (only if still unknown)
  if (venue === 'unknown' && price <= 0) {
    const [ntRes, hubRes, padRes, smRes, ktRes] = await Promise.allSettled([
      near.getNearlytradeTokenState(tokenAddress),
      near.getOneTokenHubState(tokenAddress),
      near.getNEARpadState(tokenAddress),
      near.getShoremarketsTokenState(tokenAddress),
      near.getKelytraTokenState(tokenAddress),
    ]);

    if (ntRes.status === 'fulfilled' && ntRes.value && ntRes.value.price > 0) {
      const ntState = ntRes.value;
      venue = 'nearlytrade';
      price = ntState.price;
      liquidity = ntState.liquidityNear;
      bondingPhase = ntState.phase;
      bondingProgressPct = ntState.bondingProgressPct;
      dclPoolId = ntState.dclPoolId;
      if (ntState.totalSupply && ntState.totalSupply !== '0') {
        totalSupply = ntState.totalSupply;
      }
    } else if (hubRes.status === 'fulfilled' && hubRes.value && hubRes.value.price > 0) {
      const hubState = hubRes.value;
      venue = 'onetokenhub';
      price = hubState.price;
      liquidity = hubState.liquidityNear;
      dclPoolId = hubState.dclPoolId;
      if (hubState.totalSupply && hubState.totalSupply !== '0') {
        totalSupply = hubState.totalSupply;
      }
    } else if (padRes.status === 'fulfilled' && padRes.value && padRes.value.price > 0) {
      const padState = padRes.value;
      venue = 'nearpad';
      price = padState.price;
      liquidity = padState.liquidityNear;
      dclPoolId = padState.dclPoolId;
      if (padState.totalSupply && padState.totalSupply !== '0') {
        totalSupply = padState.totalSupply;
      }
    } else if (smRes.status === 'fulfilled' && smRes.value && smRes.value.price > 0) {
      const smState = smRes.value;
      venue = 'shoremarkets';
      price = smState.price;
      liquidity = smState.liquidityNear;
      bondingPhase = smState.phase;
      bondingProgressPct = smState.bondingProgressPct;
      dclPoolId = smState.dclPoolId;
      if (smState.totalSupply && smState.totalSupply !== '0') {
        totalSupply = smState.totalSupply;
      }
    } else if (ktRes.status === 'fulfilled' && ktRes.value && ktRes.value.price > 0) {
      const ktState = ktRes.value;
      venue = 'kelytra';
      price = ktState.price;
      liquidity = ktState.liquidityNear;
      bondingPhase = ktState.phase;
      bondingProgressPct = ktState.bondingProgressPct;
      dclPoolId = ktState.dclPoolId;
      if (ktState.totalSupply && ktState.totalSupply !== '0') {
        totalSupply = ktState.totalSupply;
      }
    }
  }

  // Last-known-good fallback from DB cache
  if (price <= 0 && dbCache && Number(dbCache.last_price || 0) > 0) {
    price = Number(dbCache.last_price);
    liquidity = Number(dbCache.last_liquidity || 0);
    venue = (dbCache.venue as any) ?? venue;
    rheaPoolId = rheaPoolId ?? dbCache.rhea_pool_id ?? null;
    dclPoolId = dclPoolId ?? dbCache.dcl_pool_id ?? null;
    bondingPhase = bondingPhase ?? (dbCache.bonding_phase as any) ?? null;
    if (bondingProgressPct === null && dbCache.bonding_progress_pct !== null && dbCache.bonding_progress_pct !== undefined) {
      bondingProgressPct = Number(dbCache.bonding_progress_pct);
    }
  }

  const [nearUsd, dexData, holdersData, totalTxns] = await Promise.all([
    nearUsdPromise,
    dexDataPromise,
    holdersDataPromise,
    totalTxnsPromise,
  ]);

  const supplyNum = parseFloat(totalSupply) / Math.pow(10, meta.decimals);

  // Fallback to DexScreener price ONLY if on-chain price was not discovered (price <= 0)
  if (price <= 0 && dexData) {
    if (dexData.priceNative > 0) {
      price = dexData.priceNative;
    } else if (dexData.priceUsd > 0 && nearUsd > 0) {
      price = dexData.priceUsd / nearUsd;
    }
    if (venue === 'unknown') {
      venue = 'rhea';
    }
  }

  // Calculate Market Cap (authoritative on-chain math: price * supply)
  let marketCap = price > 0 && supplyNum > 0 ? price * supplyNum : 0;
  let marketCapUsd = marketCap > 0 && nearUsd > 0 ? marketCap * nearUsd : 0;

  // Fallback to DexScreener market cap ONLY if on-chain market cap was 0
  if (marketCap <= 0 && dexData && (dexData.marketCapUsd > 0 || dexData.fdvUsd > 0)) {
    marketCapUsd = dexData.marketCapUsd || dexData.fdvUsd;
    if (nearUsd > 0) {
      marketCap = marketCapUsd / nearUsd;
    }
  }

  let finalPriceUsd = '0';
  if (price > 0 && nearUsd > 0) {
    const usdVal = price * nearUsd;
    finalPriceUsd = usdVal < 0.000001 ? usdVal.toExponential(4) : usdVal.toFixed(8);
  } else if (dexData && dexData.priceUsd > 0) {
    finalPriceUsd = dexData.priceUsd < 0.000001 ? dexData.priceUsd.toExponential(4) : dexData.priceUsd.toFixed(8);
  }

  const tradeable = isTradableVenue(venue);

  const result: TokenInfoResult = {
    address: tokenAddress,
    name: meta.name,
    symbol: meta.symbol,
    decimals: meta.decimals,
    total_supply: totalSupply,
    price: price > 0 ? price.toFixed(12) : '0',
    price_usd: finalPriceUsd,
    price_24h_change: dexData?.priceChange24h !== undefined ? dexData.priceChange24h : undefined,
    volume_24h_usd: dexData?.volume24hUsd !== undefined ? dexData.volume24hUsd : undefined,
    liquidity: liquidity.toFixed(4),
    liquidity_usd: liquidity > 0 && nearUsd > 0 ? (liquidity * nearUsd).toFixed(2) : '0',
    market_cap: marketCap,
    market_cap_usd: marketCapUsd,
    near_usd: nearUsd,
    venue,
    rhea_pool_id: rheaPoolId ?? rheaCandidate?.rheaPoolId ?? null,
    bonding_phase: bondingPhase,
    bonding_progress_pct: bondingProgressPct,
    dcl_pool_id: dclPoolId ?? rheaCandidate?.dclPoolId ?? null,
    tradeable,
    holders_count: holdersData?.count ?? null,
    buys_count: dexData?.buys24h ?? null,
    sells_count: dexData?.sells24h ?? null,
    trades_timeframe: '24h',
    total_txns: totalTxns ?? null,
  };

  tokenInfoCache.set(tokenAddress, { data: result, expiresAt: Date.now() + TOKEN_INFO_MEM_TTL_MS });

  // Async DB update (non-blocking)
  setImmediate(() =>
    upsertTokenCache({
      token_address: tokenAddress,
      name: meta.name,
      symbol: meta.symbol,
      decimals: meta.decimals,
      total_supply: totalSupply,
      pool_address: tokenAddress,
      venue: venue as any,
      rhea_pool_id: rheaPoolId,
      bonding_phase: bondingPhase,
      bonding_progress_pct: bondingProgressPct,
      dcl_pool_id: dclPoolId,
      last_price: price,
      last_liquidity: liquidity,
      updated_at: new Date(),
    }).catch(() => {})
  );

  return result;
}

// ── Section 1 Replacement: Custodial Onboarding & Key Rotation ──────────────

export interface OnboardResult {
  userId: string;
  subaccountId: string;
  privateKey?: string;
  suiAddress?: string;
  suiPrivateKey?: string;
  isExisting: boolean;
}

/**
 * Ensures user record has an initialized Sui address & encrypted private key.
 * If missing, generates a new Sui keypair and saves to DB.
 */
export async function ensureUserSuiWallet(user: UserRecord): Promise<UserRecord> {
  if (user.sui_address && user.sui_private_key_enc) {
    return user;
  }
  const suiWallet = generateSuiWallet(MASTER_KEY);
  await updateUserSuiWallet(user.id, suiWallet.address, suiWallet.encryptedPrivateKey);
  user.sui_address = suiWallet.address;
  user.sui_private_key_enc = suiWallet.encryptedPrivateKey;
  return user;
}

/**
 * Onboards user via Telegram chat.
 * Generates NEAR subaccount keypair and Sui Ed25519 keypair, creates & funds the NEAR subaccount on-chain,
 * and returns the user account details.
 * Idempotent: returns existing account info if user is already onboarded.
 * Optionally accepts a referral code to track who referred the user.
 */
export async function onboardUser(telegramId: number, referralCode?: string, username?: string): Promise<OnboardResult> {
  // Step 5: Check for existing user row (idempotency)
  const existing = await getUserByTelegramId(telegramId).catch(() => null);
  if (existing) {
    const updated = await ensureUserSuiWallet(existing);
    return {
      userId: updated.id,
      subaccountId: updated.subaccount_id,
      suiAddress: updated.sui_address ?? undefined,
      isExisting: true,
    };
  }

  // Validate referral code if provided
  let referrerId: string | null = null;
  if (referralCode) {
    const referrer = await getUserByReferralCode(referralCode);
    if (referrer) {
      referrerId = referrer.id;
    }
  }

  // Step 1: Generate exactly one NEAR ed25519 keypair
  const keyPair = generateScopedAccessKey();
  const publicKey = keyPair.getPublicKey();
  const privateKey = keyPair.toString();
  const prefix = generateRandomAccountPrefix();
  const subaccountId = `${prefix}.${RACERBOT_PARENT_ACCOUNT}`;

  // Step 2: Generate Sui Ed25519 wallet
  const suiWallet = generateSuiWallet(MASTER_KEY);

  // Step 4: Actually create subaccount on-chain before returning success
  if (!MAIN_WALLET_PRIVATE_KEY) {
    throw new Error('MAIN_WALLET_PRIVATE_KEY is not configured on server.');
  }

  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey(
    'mainnet',
    RACERBOT_PARENT_ACCOUNT,
    KeyPair.fromString(MAIN_WALLET_PRIVATE_KEY as any)
  );

  const nearConn = await connect({
    networkId: 'mainnet',
    keyStore,
    nodeUrl: RPC_URLS[0] || 'https://rpc.mainnet.fastnear.com',
  });

  const parentAccount = await nearConn.account(RACERBOT_PARENT_ACCOUNT);

  // Fund subaccount with NEAR's storage-stake minimum only (182 bytes at 0.00001 NEAR/byte = 0.00182 NEAR),
  // not a gas buffer. Gas and trading balance are expected to come from the user's own deposit
  // before any trade or subaccount-signed action.
  const initialBalance = nearUtils.format.parseNearAmount('0.00182')!;

  // Submit on-chain createAccount and await confirmation
  await parentAccount.createAccount(
    subaccountId,
    publicKey.toString(),
    BigInt(initialBalance)
  );

  // Step 3: Encrypt real secret key and store in DB
  const encryptedKey = encrypt(privateKey, MASTER_KEY);

  const user = await createUser({
    telegram_id: telegramId,
    subaccount_id: subaccountId,
    scoped_key_encrypted: encryptedKey,
    sui_address: suiWallet.address,
    sui_private_key_enc: suiWallet.encryptedPrivateKey,
  });

  // Generate referral code based on username
  if (username) {
    await generateReferralCode(user.id, username);
  }

  // Create referral record if referrer exists
  if (referrerId) {
    await createReferral(referrerId, user.id);
  }

  return {
    userId: user.id,
    subaccountId,
    privateKey, // Raw exported NEAR private key string (ed25519:<base58>)
    suiAddress: suiWallet.address,
    suiPrivateKey: suiWallet.privateKeySecret,
    isExisting: false,
  };
}

const activeRotations = new Set<number>();

export interface RotateKeyResult {
  success: boolean;
  subaccountId: string;
  newPrivateKey: string;
}

/**
 * Rotates user's keypair on-chain and updates encrypted storage in DB.
 * Idempotent against double invocation using activeRotations set.
 */
export async function rotateUserKey(telegramId: number): Promise<RotateKeyResult> {
  if (activeRotations.has(telegramId)) {
    throw new Error('A key rotation is already in progress for this account. Please wait.');
  }

  activeRotations.add(telegramId);
  try {
    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      throw new Error('User not found. Run /start first.');
    }

    // Decrypt current key
    const currentPrivateKey = decrypt(user.scoped_key_encrypted, MASTER_KEY);
    const currentKeyPair = KeyPair.fromString(currentPrivateKey as any);
    const currentPublicKey = currentKeyPair.getPublicKey();

    // Generate new keypair
    const newKeyPair = generateScopedAccessKey();
    const newPublicKey = newKeyPair.getPublicKey();
    const newPrivateKey = newKeyPair.toString();

    // Connect as subaccount using current key
    const keyStore = new keyStores.InMemoryKeyStore();
    await keyStore.setKey('mainnet', user.subaccount_id, currentKeyPair);

    const nearConn = await connect({
      networkId: 'mainnet',
      keyStore,
      nodeUrl: RPC_URLS[0] || 'https://rpc.mainnet.fastnear.com',
    });

    const subaccount = await nearConn.account(user.subaccount_id);

    // 1. Add new key first, confirm it landed on-chain
    await subaccount.addKey(newPublicKey.toString());

    // 2. Delete old key, confirm it landed on-chain
    await subaccount.deleteKey(currentPublicKey.toString());

    // 3. Encrypt and store new key in DB only after on-chain swap confirmed
    const encryptedNewKey = encrypt(newPrivateKey, MASTER_KEY);
    await updateUserScopedKey(user.id, encryptedNewKey);

    return {
      success: true,
      subaccountId: user.subaccount_id,
      newPrivateKey,
    };
  } finally {
    activeRotations.delete(telegramId);
  }
}

let directExecutor: any = null;

/**
 * Execute a swap directly via SwapExecutor so the trade executes on-chain fast (~1s),
 * records the fill into the database synchronously, and returns the txHash & positionId
 * immediately for real-time PnL tracking and UI display.
 */
export async function publishSwap(swapEvent: {
  user_id: string;
  chain?: 'near' | 'sui';
  token_in: string;
  token_out: string;
  amount_in: string;
  min_amount_out: string;
  venue: VenueName;
  dcl_pool_id?: string;
  pool_id?: number;
  slippage_pct?: number;
  quoted_at?: number;
}, onProgress?: (stage: string) => void): Promise<{ txHash?: string; success?: boolean; positionId?: string; reason?: string; tokenName?: string; tokenSymbol?: string; tokenQty?: string; priceNear?: number; nearSpent?: number }> {
  if (!directExecutor) {
    const { SwapExecutor } = await import('@racerbot/executor');
    directExecutor = new SwapExecutor();
  }
  const result = await directExecutor.execute({
    type: 'execute_swap',
    ...swapEvent,
    // Manual API-initiated trade: the caller renders the success message, so
    // the executor must not ALSO publish 'trade_confirmed' (duplicate message).
    notify_user: false,
    timestamp: Date.now(),
  }, onProgress);

  if (result.success !== false) {
    // Record user trade to prevent deposit false positives
    recordUserTrade(swapEvent.user_id);

    // Invalidate cached token info and balance immediately so user sees fresh on-chain data
    tokenInfoCache.delete(swapEvent.token_in);
    tokenInfoCache.delete(swapEvent.token_out);
    getUserById(swapEvent.user_id).then(u => {
      if (u?.telegram_id) {
        balanceCache.delete(u.telegram_id);
      }
    }).catch(() => {});
  }

  return {
    txHash: result.txHash,
    success: result.success !== false,
    positionId: result.positionId,
    reason: result.reason,
    tokenName: result.tokenName,
    tokenSymbol: result.tokenSymbol,
    tokenQty: result.tokenQty,
    priceNear: result.priceNear,
    nearSpent: result.nearSpent,
  };
}

export function invalidateBalanceCache(telegramId: number): void {
  balanceCache.delete(telegramId);
}

export function invalidateTokenInfoCache(tokenAddress: string): void {
  tokenInfoCache.delete(tokenAddress);
}

export interface UserBalances {
  subaccountId: string;
  nativeNearYocto: string;
  nativeNearFormatted: string;
  nativeNearUsd: string;
  wrapNearYocto: string;
  wrapNearFormatted: string;
  wrapNearUsd: string;
  totalNearFormatted: string;
  totalNearUsd: string;
  nearUsd: number;
  suiAddress?: string;
  suiBalanceMist?: string;
  suiBalanceFormatted?: string;
  suiBalanceUsd?: string;
  suiUsd?: number;
}

/**
 * Fetch native NEAR, wrap.near, and SUI balances for user's account with caching & parallel requests.
 */
export async function getUserBalances(telegramId: number, forceRefresh = false): Promise<UserBalances> {
  if (!forceRefresh) {
    const cached = balanceCache.get(telegramId);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.data;
    }
  }

  const rawUser = await getUserByTelegramId(telegramId);
  if (!rawUser) {
    throw new Error('User not found. Run /start first.');
  }

  const user = await ensureUserSuiWallet(rawUser);
  const subaccountId = user.subaccount_id;
  const suiAddress = user.sui_address;

  let nativeNearYocto = '0';
  let wrapNearYocto = '0';
  let suiMist = 0n;

  const [nativeRes, wrapRes, suiRes, nearUsd, suiUsd] = await Promise.allSettled([
    near.getNearBalance(subaccountId),
    near.view<string>('wrap.near', 'ft_balance_of', { account_id: subaccountId }),
    suiAddress ? getSuiBalance(suiAddress) : Promise.resolve({ mist: 0n, sui: 0, formatted: '0.0000' }),
    getNearUsdPrice(),
    getSuiUsdPrice(),
  ]);

  if (nativeRes.status === 'fulfilled') {
    nativeNearYocto = nativeRes.value;
  }
  if (wrapRes.status === 'fulfilled') {
    wrapNearYocto = wrapRes.value || '0';
  }
  if (suiRes.status === 'fulfilled') {
    suiMist = suiRes.value.mist;
  }

  const nearPrice = nearUsd.status === 'fulfilled' ? nearUsd.value : 4.9;
  const suiPrice = suiUsd.status === 'fulfilled' ? suiUsd.value : 2.0;

  const nativeNear = Number(BigInt(nativeNearYocto) / 1000000000000000000n) / 1e6;
  const wrapNear = Number(BigInt(wrapNearYocto) / 1000000000000000000n) / 1e6;
  
  // Subtract storage reserve (0.05 NEAR) from display balance to show spendable amount
  const storageReserve = 0.05;
  const spendableNativeNear = Math.max(0, nativeNear - storageReserve);
  const totalNear = spendableNativeNear + wrapNear;

  const spendableSui = Number(suiMist) / 1e9;

  // Format USD values
  const formatUSD = (val: number, rate: number) => {
    const usdValue = val * rate;
    if (usdValue >= 1000) return `$${(usdValue / 1000).toFixed(2)}K`;
    if (usdValue >= 1) return `$${usdValue.toFixed(2)}`;
    return `$${usdValue.toFixed(4)}`;
  };

  const result: UserBalances = {
    subaccountId,
    nativeNearYocto,
    nativeNearFormatted: spendableNativeNear.toFixed(4),
    nativeNearUsd: formatUSD(spendableNativeNear, nearPrice),
    wrapNearYocto,
    wrapNearFormatted: wrapNear.toFixed(4),
    wrapNearUsd: formatUSD(wrapNear, nearPrice),
    totalNearFormatted: totalNear.toFixed(4),
    totalNearUsd: formatUSD(totalNear, nearPrice),
    nearUsd: nearPrice,
    suiAddress: suiAddress ?? undefined,
    suiBalanceMist: suiMist.toString(),
    suiBalanceFormatted: spendableSui.toFixed(4),
    suiBalanceUsd: formatUSD(spendableSui, suiPrice),
    suiUsd: suiPrice,
  };

  balanceCache.set(telegramId, { data: result, expiresAt: Date.now() + 8000 });
  return result;
}

// ── Lightweight trade-path balance (SPEED) ────────────────────────────────────
const tradeBalanceCache = new Map<number, { data: number; expiresAt: number }>();
const suiTradeBalanceCache = new Map<number, { data: number; expiresAt: number }>();
const TRADE_BALANCE_TTL_MS = 5_000;

export async function getTradeSpendableNear(telegramId: number): Promise<number> {
  const cached = tradeBalanceCache.get(telegramId);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.data;
  }

  const user = await getUserByTelegramId(telegramId);
  if (!user) {
    throw new Error('User not found. Run /start first.');
  }

  const nativeNearYocto = await near.getNearBalance(user.subaccount_id).catch(() => '0');
  const nativeNear = Number(BigInt(nativeNearYocto) / 1000000000000000000n) / 1e6;
  const spendable = Math.max(0, nativeNear - 0.015);

  tradeBalanceCache.set(telegramId, { data: spendable, expiresAt: Date.now() + TRADE_BALANCE_TTL_MS });
  return spendable;
}

export async function getTradeSpendableSui(telegramId: number): Promise<number> {
  const cached = suiTradeBalanceCache.get(telegramId);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.data;
  }

  const user = await getUserByTelegramId(telegramId);
  if (!user) {
    throw new Error('User not found. Run /start first.');
  }

  const updated = await ensureUserSuiWallet(user);
  if (!updated.sui_address) return 0;

  const bal = await getSuiBalance(updated.sui_address).catch(() => ({ mist: 0n, sui: 0, formatted: '0.0000' }));
  const spendable = Math.max(0, bal.sui - 0.01); // 0.01 SUI gas reserve

  suiTradeBalanceCache.set(telegramId, { data: spendable, expiresAt: Date.now() + TRADE_BALANCE_TTL_MS });
  return spendable;
}

/**
 * One-time Ref Finance storage deposit needed for an account that is not yet
 * registered on v2.ref-finance.near (0 when already registered). Cached 60s —
 * used to include the deposit in the pre-trade insufficient-balance check so
 * the user gets a clear message BEFORE any transaction is attempted.
 */
const refStorageNeededCache = new Map<string, { neededYocto: bigint; at: number }>();

export async function getRefStorageDepositNeeded(subaccountId: string): Promise<bigint> {
  const cached = refStorageNeededCache.get(subaccountId);
  if (cached && Date.now() - cached.at < 60_000) {
    return cached.neededYocto;
  }

  let neededYocto = 0n;
  try {
    const storage = await near.view<any>('v2.ref-finance.near', 'storage_balance_of', { account_id: subaccountId });
    if (!storage || !storage.total || storage.total === '0') {
      const bounds = await near.view<any>('v2.ref-finance.near', 'storage_balance_bounds', {}).catch(() => null);
      neededYocto = bounds?.min && BigInt(bounds.min) > 0n ? BigInt(bounds.min) : BigInt('100000000000000000000000');
    }
  } catch {
    // view failed — do not block the trade path over a check; treat as 0
  }

  refStorageNeededCache.set(subaccountId, { neededYocto, at: Date.now() });
  return neededYocto;
}

/**
 * Unwraps any wrap.near held in user's subaccount into pure native NEAR.
 */
export async function unwrapUserWrapNear(telegramId: number): Promise<{ success: boolean; unwrappedAmount: string }> {
  const user = await getUserByTelegramId(telegramId);
  if (!user) {
    throw new Error('User not found. Run /start first.');
  }

  const subaccountId = user.subaccount_id;
  const wrapBal = await near.view<string>('wrap.near', 'ft_balance_of', { account_id: subaccountId }).catch(() => '0');
  if (!wrapBal || wrapBal === '0') {
    return { success: true, unwrappedAmount: '0' };
  }

  const privateKey = decrypt(user.scoped_key_encrypted, MASTER_KEY);
  const keyPair = KeyPair.fromString(privateKey as any);
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey('mainnet', subaccountId, keyPair);

  const nearConn = await connect({
    networkId: 'mainnet',
    keyStore,
    nodeUrl: RPC_URLS[0] || 'https://rpc.mainnet.fastnear.com',
  });
  const account = await nearConn.account(subaccountId);

  await account.functionCall({
    contractId: 'wrap.near',
    methodName: 'near_withdraw',
    args: { amount: wrapBal },
    gas: BigInt('30000000000000'),
    attachedDeposit: BigInt('1'),
  });

  const formatted = (Number(BigInt(wrapBal) / 1000000000000000000n) / 1e6).toFixed(4);
  invalidateBalanceCache(telegramId);
  return { success: true, unwrappedAmount: formatted };
}

/**
 * Withdraw native NEAR from user's subaccount to an external address.
 * Automatically unwraps any wrap.near before sending, and ensures 0.05 NEAR
 * remains to cover account storage and gas.
 */
export async function withdrawFunds(
  telegramId: number,
  destination: string,
  amountNear?: number | 'all'
): Promise<{ txHash: string; amountWithdrawn: string; destination: string }> {
  const user = await getUserByTelegramId(telegramId);
  if (!user) {
    throw new Error('User not found. Run /start first.');
  }

  const subaccountId = user.subaccount_id;
  destination = destination.trim();
  if (!destination || destination === subaccountId) {
    throw new Error('Invalid destination account address.');
  }

  // Auto-unwrap any wrap.near first
  await unwrapUserWrapNear(telegramId).catch(() => {});

  const currentBalanceYocto = BigInt(await near.getNearBalance(subaccountId));
  const reserveYocto = BigInt('50000000000000000000000'); // 0.05 NEAR reserved

  if (currentBalanceYocto <= reserveYocto) {
    throw new Error('Insufficient balance to withdraw. A minimum of 0.05 NEAR must remain to cover on-chain account storage.');
  }

  const maxWithdrawableYocto = currentBalanceYocto - reserveYocto;

  let withdrawYocto: bigint;
  if (!amountNear || amountNear === 'all') {
    withdrawYocto = maxWithdrawableYocto;
  } else {
    withdrawYocto = BigInt(Math.floor(amountNear * 1e6)) * 1000000000000000000n;
    if (withdrawYocto > maxWithdrawableYocto) {
      const maxFormatted = (Number(maxWithdrawableYocto / 1000000000000000000n) / 1e6).toFixed(4);
      throw new Error(`Amount exceeds maximum withdrawable balance (${maxFormatted} NEAR after storage reserve).`);
    }
  }

  if (withdrawYocto <= 0n) {
    throw new Error('Withdrawal amount must be greater than 0.');
  }

  const privateKey = decrypt(user.scoped_key_encrypted, MASTER_KEY);
  const keyPair = KeyPair.fromString(privateKey as any);
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey('mainnet', subaccountId, keyPair);

  const nearConn = await connect({
    networkId: 'mainnet',
    keyStore,
    nodeUrl: RPC_URLS[0] || 'https://rpc.mainnet.fastnear.com',
  });
  const account = await nearConn.account(subaccountId);

  const res = await account.sendMoney(destination, withdrawYocto);
  const formattedWithdrawn = (Number(withdrawYocto / 1000000000000000000n) / 1e6).toFixed(4);

  return {
    txHash: res.transaction.hash,
    amountWithdrawn: formattedWithdrawn,
    destination,
  };
}

/**
 * Withdraws native SUI from user's active SUI wallet to any valid external SUI address.
 * Keeps ~0.025 SUI to ensure gas coverage for future transactions.
 */
export async function withdrawSuiFunds(
  telegramId: number,
  destination: string,
  amountSui?: number | 'all'
): Promise<{ txHash: string; amountWithdrawn: string; destination: string }> {
  const user = await getUserByTelegramId(telegramId);
  if (!user || !user.sui_address || !user.sui_private_key_enc) {
    throw new Error('SUI wallet not configured. Please initialize your wallet via /start.');
  }

  destination = destination.trim();
  if (!isValidSuiAddress(destination)) {
    throw new Error('Invalid destination SUI address. Must be a valid 0x... hex address.');
  }
  if (destination.toLowerCase() === user.sui_address.toLowerCase()) {
    throw new Error('Cannot withdraw to your own wallet address.');
  }

  const keypair = restoreSuiKeypair(user.sui_private_key_enc, MASTER_KEY);
  const bal = await getSuiBalance(user.sui_address);
  const gasReserveMist = 25_000_000n; // 0.025 SUI reserved for gas execution

  if (bal.mist <= gasReserveMist) {
    throw new Error('Insufficient balance to withdraw. A minimum of 0.025 SUI must remain to cover transaction gas.');
  }

  const maxWithdrawableMist = bal.mist - gasReserveMist;
  let withdrawMist: bigint;
  if (!amountSui || amountSui === 'all') {
    withdrawMist = maxWithdrawableMist;
  } else {
    withdrawMist = BigInt(Math.floor(amountSui * 1e9));
    if (withdrawMist > maxWithdrawableMist) {
      const maxFormatted = (Number(maxWithdrawableMist) / 1e9).toFixed(4);
      throw new Error(`Amount exceeds maximum withdrawable balance (${maxFormatted} SUI after gas reserve).`);
    }
  }

  if (withdrawMist <= 0n) {
    throw new Error('Withdrawal amount must be greater than 0.');
  }

  const tx = new Transaction();
  tx.setSender(user.sui_address);
  const [coinToSend] = tx.splitCoins(tx.gas, [tx.pure.u64(withdrawMist.toString())]);
  tx.transferObjects([coinToSend], destination);

  const res = await executeSuiTransaction(tx, keypair);
  if (res.status !== 'success') {
    throw new Error(`SUI withdrawal failed: ${res.errorMessage || 'Transaction execution rejected'}`);
  }

  // Invalidate balance caches
  balanceCache.delete(telegramId);
  tradeBalanceCache.delete(telegramId);
  suiTradeBalanceCache.delete(telegramId);

  const formattedWithdrawn = (Number(withdrawMist) / 1e9).toFixed(4);
  return {
    txHash: res.digest,
    amountWithdrawn: formattedWithdrawn,
    destination,
  };
}

/**
 * Pay accrued referral rewards from the treasury wallet to a referrer's
 * RacerBot subaccount. Signed with the treasury key (TREASURY_PRIVATE_KEY env).
 */
export async function payReferralReward(
  destinationSubaccount: string,
  amountNear: number
): Promise<{ txHash: string }> {
  const treasuryKey = (process.env.TREASURY_PRIVATE_KEY || '').trim();
  if (!treasuryKey) {
    throw new Error('Reward payouts are not configured on the server yet. Please contact support.');
  }
  if (!(amountNear > 0)) {
    throw new Error('Claim amount must be greater than 0.');
  }

  const keyPair = KeyPair.fromString(treasuryKey as any);
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey('mainnet', TREASURY_ACCOUNT_ID, keyPair);

  const nearConn = await connect({
    networkId: 'mainnet',
    keyStore,
    nodeUrl: RPC_URLS[0] || 'https://rpc.mainnet.fastnear.com',
  });
  const account = await nearConn.account(TREASURY_ACCOUNT_ID);

  const yocto = BigInt(nearUtils.format.parseNearAmount(amountNear.toFixed(8))!);
  const res = await account.sendMoney(destinationSubaccount, yocto);
  return { txHash: res.transaction.hash };
}

/**
 * Detects on-chain FT holdings for a user's wallet subaccount across indexers (FastNEAR & NearBlocks)
 * and RPC. Catches all tokens inside the wallet, creates or updates positions, and initializes the
 * entry price baseline for PNL calculation from the point of discovery.
 */
export async function syncUserTokenDeposits(userId: string, subaccountId: string): Promise<number> {
  const lastSync = lastSyncDepositsMap.get(userId);
  if (lastSync && Date.now() - lastSync < 10_000) {
    return 0;
  }
  lastSyncDepositsMap.set(userId, Date.now());

  let newDepositsCount = 0;
  try {
    const discoveredTokens = new Set<string>();
    const indexerBalances = new Map<string, string>();

    // 1. Fetch FT holdings across FastNEAR and NearBlocks in parallel
    const fastnearPromise = (async () => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3500);
        const apiKey = (process.env.FASTNEAR_API_KEY || '').trim();
        const url = `https://api.fastnear.com/v1/account/${subaccountId}/ft${apiKey ? `?api_key=${apiKey}` : ''}`;
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
        if (res.ok) {
          const data = (await res.json()) as any;
          if (Array.isArray(data.tokens)) {
            for (const t of data.tokens) {
              const cid = t?.contract_id || t;
              if (typeof cid === 'string' && cid) {
                discoveredTokens.add(cid);
                if (t.balance) indexerBalances.set(cid, t.balance.toString());
              }
            }
          } else if (Array.isArray(data.contract_ids)) {
            for (const cid of data.contract_ids) {
              if (typeof cid === 'string' && cid) discoveredTokens.add(cid);
            }
          }
        }
      } catch {
        // FastNEAR timeout/network error — fallback continues gracefully
      }
    })();

    const nearblocksPromise = (async () => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3500);
        const res = await fetch(`https://api.nearblocks.io/v1/account/${subaccountId}/inventory`, {
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (res.ok) {
          const data = (await res.json()) as any;
          const fts = data?.inventory?.fts;
          if (Array.isArray(fts)) {
            for (const item of fts) {
              const cid = item?.contract;
              if (typeof cid === 'string' && cid) {
                discoveredTokens.add(cid);
                if (item.amount) indexerBalances.set(cid, item.amount.toString());
              }
            }
          }
        }
      } catch {
        // NearBlocks fallback continues gracefully
      }
    })();

    // 2. Fetch existing open positions in DB
    const [existingPositions, user] = await Promise.all([
      getOpenPositions(userId).catch(() => []),
      getUserById(userId).catch(() => null),
      Promise.allSettled([fastnearPromise, nearblocksPromise]),
    ]);

    const nearPositions = existingPositions.filter(p => p.chain === 'near' || (!p.chain && !isSuiToken(p.token_address)));
    const suiPositions = existingPositions.filter(p => p.chain === 'sui' || isSuiToken(p.token_address));

    const posMap = new Map(nearPositions.map(p => [p.token_address, p]));
    for (const p of nearPositions) {
      discoveredTokens.add(p.token_address);
    }

    // Exclude wrap.near (wNEAR is trading collateral, not a meme/speculative token) and 'near'
    discoveredTokens.delete('wrap.near');
    discoveredTokens.delete('near');

    const allTokensToCheck = Array.from(discoveredTokens);
    const near = getNear();

    // 3. Fetch NEAR token balances and metadata in parallel
    if (allTokensToCheck.length > 0) {
      const [balanceResults, infoResults] = await Promise.all([
        Promise.allSettled(
          allTokensToCheck.map(async (tokenAddress): Promise<{ value: string; trusted: boolean }> => {
            try {
              const value = await Promise.race([
                near.getTokenBalanceOnTradeRpc(tokenAddress, subaccountId),
                new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2500)),
              ]);
              return { value, trusted: true };
            } catch {
              const idx = indexerBalances.get(tokenAddress);
              // Stale indexer data is UNTRUSTED — it lags after DEX sells! Never use it to create new positions!
              return idx !== undefined ? { value: idx, trusted: false } : { value: '0', trusted: false };
            }
          })
        ),
        Promise.allSettled(
          allTokensToCheck.map(tokenAddress => getTokenInfo(tokenAddress, false).catch(() => null))
        ),
      ]);

      for (let i = 0; i < allTokensToCheck.length; i++) {
        const tokenAddress = allTokensToCheck[i];
        const balRes = balanceResults[i];
        const bal = balRes.status === 'fulfilled'
          ? balRes.value
          : (indexerBalances.has(tokenAddress)
              ? { value: indexerBalances.get(tokenAddress)!, trusted: false }
              : { value: '0', trusted: false });
        const rawBal = bal.value;
        const infoRes = infoResults[i];
        const info = infoRes.status === 'fulfilled' ? infoRes.value : null;

        const decimals = info?.decimals ?? 18;
        const cleanRaw = String(rawBal || '0').replace(/["'\s]/g, '').split('.')[0] || '0';
        let rawBalBigInt = 0n;
        try {
          rawBalBigInt = BigInt(cleanRaw);
        } catch {
          rawBalBigInt = 0n;
        }
        const humanBalance = Number(rawBalBigInt) / Math.pow(10, decimals);
        const isDustOrZero = rawBalBigInt === 0n || humanBalance < 0.000001;

        const existing = posMap.get(tokenAddress);
        const currentPrice = info?.price && parseFloat(info.price) > 0 ? parseFloat(info.price) : 0;

        if (existing) {
          if (!bal.trusted) {
            console.warn(`[DEPOSIT] Skipped reconcile for ${tokenAddress} (user ${userId}): balance unverifiable`);
          } else if (isDustOrZero) {
            await updatePosition({
              position_id: existing.id,
              status: 'closed',
              closed_at: new Date(),
            });
            console.log(`[DEPOSIT] Closed phantom/sold position for ${tokenAddress} (user ${userId})`);
          } else {
            const updates: any = { position_id: existing.id };
            let hasUpdates = false;

            if (existing.quantity_held !== rawBal) {
              updates.quantity_held = rawBal;
              hasUpdates = true;
            }

            if ((!existing.avg_entry_price || parseFloat(existing.avg_entry_price) <= 0) && currentPrice > 0) {
              updates.avg_entry_price = currentPrice.toString();
              hasUpdates = true;
            }

            if (hasUpdates) {
              await updatePosition(updates);
            }
          }
        } else if (!isDustOrZero) {
          // STRICT GUARD: To create a new external deposit, the balance MUST be confirmed by real RPC
          if (!bal.trusted) {
            console.log(`[DEPOSIT] Skipped creating deposit for ${tokenAddress} (user ${userId}): unverified RPC balance`);
            continue;
          }

          // Check if this token was sold or closed in the last 15 minutes.
          // Stale indexers or delayed on-chain balances must NEVER resurrect a sold position!
          const db = await getDb();
          const recentClosed = await db.query(
            `SELECT 1 FROM positions WHERE user_id = $1 AND token_address = $2 AND status = 'closed' AND closed_at > NOW() - INTERVAL '15 minutes' LIMIT 1`,
            [userId, tokenAddress]
          ).catch(() => null);
          if (recentClosed?.rows?.length) {
            console.log(`[DEPOSIT] Guard triggered: skipped reviving recently closed position for ${tokenAddress} (user ${userId})`);
            continue;
          }

          const recentSell = await db.query(
            `SELECT 1 FROM fills f JOIN positions p ON f.position_id = p.id WHERE p.user_id = $1 AND p.token_address = $2 AND f.side = 'sell' AND f.executed_at > NOW() - INTERVAL '15 minutes' LIMIT 1`,
            [userId, tokenAddress]
          ).catch(() => null);
          if (recentSell?.rows?.length) {
            console.log(`[DEPOSIT] Guard triggered: skipped creating deposit for recently sold token ${tokenAddress} (user ${userId})`);
            continue;
          }

          const entryPrice = currentPrice > 0 ? currentPrice.toString() : '0';
          const newPos = await createPosition({
            user_id: userId,
            token_address: tokenAddress,
            quantity_held: rawBal,
            avg_entry_price: entryPrice,
          });

          await db.query(
            'UPDATE positions SET is_external_deposit = TRUE, external_deposit_detected_at = NOW() WHERE id = $1',
            [newPos.id]
          );

          newDepositsCount++;
          console.log(`[DEPOSIT] Tracked new external deposit for user ${userId}: ${tokenAddress}, balance=${humanBalance.toFixed(4)}, entryPrice=${entryPrice}`);

          getUserById(userId).then(u => {
            if (u?.telegram_id) {
              notifyTokenDeposit(u.telegram_id, {
                tokenSymbol: info?.symbol || 'TOKEN',
                tokenName: info?.name || undefined,
                amountFormatted: humanBalance >= 1_000_000 ? `${(humanBalance / 1_000_000).toFixed(2)}M` : humanBalance.toLocaleString('en-US', { maximumFractionDigits: 4 }),
                address: subaccountId,
                chain: 'near',
              }).catch(() => {});
            }
          }).catch(() => {});
        }
      }
    }

    // ── 4. Reconcile Sui Token Holdings & Discover External Deposits ──────────
    if (user?.sui_address) {
      try {
        const suiClient = getSuiClient();
        const allBalances = await suiClient.getAllBalances({ owner: user.sui_address }).catch(() => []);
        
        const suiIndexerBalances = new Map<string, string>();
        const suiDiscoveredTokens = new Set<string>();

        for (const b of allBalances) {
          const ct = b.coinType;
          if (
            ct === '0x2::sui::SUI' ||
            ct === '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI'
          ) {
            continue;
          }
          suiIndexerBalances.set(ct, b.totalBalance);
          suiDiscoveredTokens.add(ct);
        }

        // Also ensure all existing open Sui positions are checked (even if balance is 0 on-chain now)
        for (const p of suiPositions) {
          suiDiscoveredTokens.add(p.token_address);
        }

        const suiPosMap = new Map(suiPositions.map(p => [p.token_address, p]));
        const allSuiTokens = Array.from(suiDiscoveredTokens);

        if (allSuiTokens.length > 0) {
          const suiInfoResults = await Promise.allSettled(
            allSuiTokens.map(t => getTokenInfo(t, false).catch(() => null))
          );

          for (let i = 0; i < allSuiTokens.length; i++) {
            const tokenAddress = allSuiTokens[i];
            const rawBal = suiIndexerBalances.get(tokenAddress) || '0';
            const infoRes = suiInfoResults[i];
            const info = infoRes.status === 'fulfilled' ? infoRes.value : null;
            const decimals = info?.decimals ?? 6;

            let rawBalBigInt = 0n;
            try {
              rawBalBigInt = BigInt(rawBal);
            } catch {
              rawBalBigInt = 0n;
            }

            const humanBalance = Number(rawBalBigInt) / Math.pow(10, decimals);
            const isDustOrZero = rawBalBigInt === 0n || humanBalance < 0.000001;
            const existing = suiPosMap.get(tokenAddress);
            const currentPrice = info?.price && parseFloat(info.price) > 0 ? parseFloat(info.price) : 0;

            if (existing) {
              if (isDustOrZero) {
                await updatePosition({
                  position_id: existing.id,
                  status: 'closed',
                  closed_at: new Date(),
                });
                console.log(`[DEPOSIT] Closed phantom/sold SUI position for ${tokenAddress} (user ${userId})`);
              } else {
                const updates: any = { position_id: existing.id };
                let hasUpdates = false;

                if (existing.quantity_held !== rawBal) {
                  updates.quantity_held = rawBal;
                  hasUpdates = true;
                }
                if ((!existing.avg_entry_price || parseFloat(existing.avg_entry_price) <= 0) && currentPrice > 0) {
                  updates.avg_entry_price = currentPrice.toString();
                  hasUpdates = true;
                }
                if (hasUpdates) {
                  await updatePosition(updates);
                }
              }
            } else if (!isDustOrZero) {
              // Check if this Sui token was sold or closed in the last 15 minutes.
              const db = await getDb();
              const recentClosed = await db.query(
                `SELECT 1 FROM positions WHERE user_id = $1 AND token_address = $2 AND status = 'closed' AND closed_at > NOW() - INTERVAL '15 minutes' LIMIT 1`,
                [userId, tokenAddress]
              ).catch(() => null);
              if (recentClosed?.rows?.length) {
                console.log(`[DEPOSIT] Guard triggered: skipped reviving recently closed SUI position for ${tokenAddress} (user ${userId})`);
                continue;
              }

              const recentSell = await db.query(
                `SELECT 1 FROM fills f JOIN positions p ON f.position_id = p.id WHERE p.user_id = $1 AND p.token_address = $2 AND f.side = 'sell' AND f.executed_at > NOW() - INTERVAL '15 minutes' LIMIT 1`,
                [userId, tokenAddress]
              ).catch(() => null);
              if (recentSell?.rows?.length) {
                console.log(`[DEPOSIT] Guard triggered: skipped creating deposit for recently sold SUI token ${tokenAddress} (user ${userId})`);
                continue;
              }

              // External SUI token deposit detected!
              const entryPrice = currentPrice > 0 ? currentPrice.toString() : '0';
              const newPos = await createPosition({
                user_id: userId,
                chain: 'sui',
                token_address: tokenAddress,
                quantity_held: rawBal,
                avg_entry_price: entryPrice,
              });

              await db.query(
                'UPDATE positions SET is_external_deposit = TRUE, external_deposit_detected_at = NOW() WHERE id = $1',
                [newPos.id]
              );

              newDepositsCount++;
              console.log(`[DEPOSIT] Tracked new external SUI deposit for user ${userId}: ${tokenAddress}, balance=${humanBalance.toFixed(4)}, entryPrice=${entryPrice}`);

              if (user.telegram_id) {
                notifyTokenDeposit(user.telegram_id, {
                  tokenSymbol: info?.symbol || 'TOKEN',
                  tokenName: info?.name || undefined,
                  amountFormatted: humanBalance >= 1_000_000
                    ? `${(humanBalance / 1_000_000).toFixed(2)}M`
                    : humanBalance.toLocaleString('en-US', { maximumFractionDigits: 4 }),
                  address: user.sui_address,
                  chain: 'sui',
                }).catch(() => {});
              }
            }
          }
        }
      } catch (suiErr: any) {
        console.warn(`[DEPOSIT] Sui syncUserTokenDeposits error: ${suiErr?.message}`);
      }
    }
  } catch (err: any) {
    console.warn(`[DEPOSIT] syncUserTokenDeposits error: ${err.message}`);
  }
  return newDepositsCount;
}

/**
 * Pre-warm storage deposit on NEAR for a user and token so future snipes/buys
 * don't need a separate storage_deposit transaction at execution time.
 */
export async function prewarmStorageDeposit(user: UserRecord, tokenAddress: string): Promise<void> {
  if (!user.subaccount_id || !tokenAddress || tokenAddress === 'wrap.near' || tokenAddress === 'near') return;
  try {
    const isReg = await near.checkStorageRegistered(user.subaccount_id, tokenAddress).catch(() => false);
    if (isReg) return;

    const privateKey = decrypt(user.scoped_key_encrypted, MASTER_KEY);
    const keyPair = KeyPair.fromString(privateKey as any);
    await near.addKey(user.subaccount_id, keyPair);
    await near.ensureStorageDeposit(user.subaccount_id, tokenAddress);
    console.log(`[SNIPE] Storage pre-warmed for ${tokenAddress} on ${user.subaccount_id}`);
  } catch (err: any) {
    console.warn(`[SNIPE] Storage pre-warm for ${tokenAddress} (${user.subaccount_id}):`, err?.message);
  }
}

// ── Multi-Wallet Management & Import (Option A) ───────────────────────────────

export const MAX_NEAR_WALLETS_PER_USER = 5;

/**
 * Validates and parses a NEAR private key string (ed25519:... or base58).
 */
export function validateAndParseNearKey(keyInput: string): KeyPair {
  const trimmed = keyInput.trim();
  if (!trimmed) {
    throw new Error('Private key cannot be empty.');
  }

  const normalized = trimmed.startsWith('ed25519:') ? trimmed : `ed25519:${trimmed}`;

  try {
    return KeyPair.fromString(normalized as any);
  } catch {
    throw new Error('Invalid NEAR private key format. Must be an ed25519 base58 key (e.g. ed25519:...).');
  }
}

/**
 * Discovers NEAR account IDs linked to a public key via FastNEAR indexer and KitWallet fallback.
 */
export async function findAccountsForNearPublicKey(publicKey: string): Promise<string[]> {
  const accounts = new Set<string>();

  // 1. Try FastNEAR public key API
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const apiKey = (process.env.FASTNEAR_API_KEY || '').trim();
    const url = `https://api.fastnear.com/v1/public_key/${encodeURIComponent(publicKey)}${apiKey ? `?api_key=${apiKey}` : ''}`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (res.ok) {
      const data = (await res.json()) as any;
      if (Array.isArray(data.account_ids)) {
        for (const acc of data.account_ids) {
          if (typeof acc === 'string' && acc.trim()) {
            accounts.add(acc.trim().toLowerCase());
          }
        }
      }
    }
  } catch {
    // FastNEAR fallback continues
  }

  // 2. Try NearBlocks / KitWallet fallback if FastNEAR returned empty
  if (accounts.size === 0) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(`https://api.kitwallet.app/publicKey/${encodeURIComponent(publicKey)}/accounts`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.ok) {
        const data = (await res.json()) as any;
        if (Array.isArray(data)) {
          for (const acc of data) {
            if (typeof acc === 'string' && acc.trim()) {
              accounts.add(acc.trim().toLowerCase());
            }
          }
        }
      }
    } catch {
      // Fallback continues
    }
  }

  // 3. If no named accounts were found, check if it's an implicit account (64 hex characters)
  if (accounts.size === 0) {
    try {
      const rawHex = nearUtils.PublicKey.fromString(publicKey).data;
      const implicitAccount = Buffer.from(rawHex).toString('hex').toLowerCase();
      // Check if this implicit account exists on-chain
      const bal = await near.getNearBalance(implicitAccount).catch(() => '0');
      if (bal !== '0') {
        accounts.add(implicitAccount);
      }
    } catch {
      // ignore
    }
  }

  return Array.from(accounts);
}

/**
 * Validates on-chain that the key has access to the specified NEAR account.
 */
export async function verifyNearAccountAccess(accountId: string, publicKey: string): Promise<{ exists: boolean; isFullAccess: boolean }> {
  try {
    const keyInfo = await near.viewAccessKey(accountId, publicKey);
    if (!keyInfo) {
      return { exists: false, isFullAccess: false };
    }
    const isFullAccess = keyInfo.permission === 'FullAccess';
    return { exists: true, isFullAccess };
  } catch (err: any) {
    const msg = err?.message || '';
    if (msg.includes('does not exist') || msg.includes('access key') || msg.includes('UnknownAccessKey')) {
      return { exists: false, isFullAccess: false };
    }
    const bal = await near.getNearBalance(accountId).catch(() => null);
    if (bal === null) {
      return { exists: false, isFullAccess: false };
    }
    return { exists: true, isFullAccess: false };
  }
}

/**
 * Imports an external NEAR wallet into RacerBot for a user.
 */
export async function importNearWallet(
  telegramId: number,
  privateKeyInput: string,
  walletName: string,
  targetAccountId?: string
): Promise<{ wallet: UserWalletRecord; accountId: string; isFullAccess: boolean }> {
  const user = await getUserByTelegramId(telegramId);
  if (!user) {
    throw new Error('User not found. Run /start first.');
  }

  // 1. Parse and validate key
  const keyPair = validateAndParseNearKey(privateKeyInput);
  const publicKey = keyPair.getPublicKey().toString();
  const normalizedPrivateKey = keyPair.toString();

  // 2. Discover or verify account ID
  let accountId = targetAccountId?.trim().toLowerCase();
  if (!accountId) {
    const discovered = await findAccountsForNearPublicKey(publicKey);
    if (discovered.length === 0) {
      throw new Error(
        'Could not find any NEAR account associated with this key. If this is a new implicit account, please fund it with NEAR on-chain first.'
      );
    }
    if (discovered.length === 1) {
      accountId = discovered[0];
    } else {
      throw new Error(`MULTIPLE_ACCOUNTS:${discovered.join(',')}`);
    }
  }

  // 3. Verify access on-chain
  const access = await verifyNearAccountAccess(accountId, publicKey);
  if (!access.exists) {
    throw new Error(`Account "${accountId}" does not exist on NEAR mainnet.`);
  }

  // 4. Enforce wallet limits and uniqueness
  const existingWallets = await getUserWallets(user.id, 'near');
  if (existingWallets.length >= MAX_NEAR_WALLETS_PER_USER) {
    throw new Error(`You have reached the maximum limit of ${MAX_NEAR_WALLETS_PER_USER} NEAR wallets.`);
  }

  if (existingWallets.some(w => w.address.toLowerCase() === accountId)) {
    throw new Error(`Wallet "${accountId}" is already added to your account.`);
  }

  // 5. Clean name
  let cleanName = walletName.trim();
  if (!cleanName || cleanName.length > 30) {
    cleanName = `Wallet ${existingWallets.length + 1}`;
  }

  // 6. Encrypt key and insert (active by default upon import)
  const encryptedKey = encrypt(normalizedPrivateKey, MASTER_KEY);

  const wallet = await createUserWallet({
    userId: user.id,
    chain: 'near',
    address: accountId,
    name: cleanName,
    encryptedPrivateKey: encryptedKey,
    isImported: true,
    isActive: true,
  });

  // Invalidate balance caches
  balanceCache.delete(telegramId);
  tradeBalanceCache.delete(telegramId);

  // Pre-warm storage check for Ref Finance
  getRefStorageDepositNeeded(accountId).catch(() => {});

  return {
    wallet,
    accountId,
    isFullAccess: access.isFullAccess,
  };
}

export async function listUserNearWallets(telegramId: number): Promise<UserWalletRecord[]> {
  const user = await getUserByTelegramId(telegramId);
  if (!user) throw new Error('User not found. Run /start first.');
  return getUserWallets(user.id, 'near');
}

export async function switchActiveNearWallet(telegramId: number, walletId: string): Promise<UserWalletRecord> {
  const user = await getUserByTelegramId(telegramId);
  if (!user) throw new Error('User not found. Run /start first.');
  const wallet = await setActiveWallet(user.id, 'near', walletId);
  balanceCache.delete(telegramId);
  tradeBalanceCache.delete(telegramId);
  return wallet;
}

export async function renameUserNearWallet(telegramId: number, walletId: string, newName: string): Promise<UserWalletRecord> {
  const user = await getUserByTelegramId(telegramId);
  if (!user) throw new Error('User not found. Run /start first.');
  const trimmed = newName.trim();
  if (!trimmed || trimmed.length > 30) {
    throw new Error('Wallet name must be between 1 and 30 characters.');
  }
  return renameUserWallet(user.id, walletId, trimmed);
}

export async function deleteUserNearWallet(telegramId: number, walletId: string): Promise<{ success: boolean; fallbackWallet?: UserWalletRecord }> {
  const user = await getUserByTelegramId(telegramId);
  if (!user) throw new Error('User not found. Run /start first.');
  const result = await deleteUserWallet(user.id, walletId);
  balanceCache.delete(telegramId);
  tradeBalanceCache.delete(telegramId);
  return result;
}

// ── SUI Multi-Wallet Management ─────────────────────────────────────────────

export const MAX_SUI_WALLETS_PER_USER = 5;

/**
 * Imports an external SUI wallet into RacerBot for a user.
 * Supports Bech32 (suiprivkey1...), hex, base64, or base58 keys.
 */
export async function importSuiWallet(
  telegramId: number,
  privateKeyInput: string,
  walletName: string
): Promise<{ wallet: UserWalletRecord; address: string }> {
  const user = await getUserByTelegramId(telegramId);
  if (!user) {
    throw new Error('User not found. Run /start first.');
  }

  const existingWallets = await getUserWallets(user.id, 'sui');
  if (existingWallets.length >= MAX_SUI_WALLETS_PER_USER) {
    throw new Error(`You have reached the maximum of ${MAX_SUI_WALLETS_PER_USER} SUI wallets.`);
  }

  // 1. Restore keypair from input
  const keypair = restoreSuiKeypairFromSecret(privateKeyInput);
  const address = keypair.toSuiAddress();
  const secretKey = keypair.getSecretKey();

  // 2. Prevent duplicate import of the exact same address
  const duplicate = existingWallets.find((w) => w.address.toLowerCase() === address.toLowerCase());
  if (duplicate) {
    throw new Error(`This SUI wallet address is already added as "${duplicate.name}".`);
  }

  // 3. Name the wallet
  const cleanName = walletName.trim() || `Wallet ${existingWallets.length + 1}`;
  const encryptedKey = encrypt(secretKey, MASTER_KEY);

  // 4. Create in DB and set active
  const wallet = await createUserWallet({
    userId: user.id,
    chain: 'sui',
    address,
    name: cleanName,
    encryptedPrivateKey: encryptedKey,
    isImported: true,
    isActive: true,
  });

  // Invalidate balance caches
  balanceCache.delete(telegramId);
  tradeBalanceCache.delete(telegramId);

  return {
    wallet,
    address,
  };
}

export async function listUserSuiWallets(telegramId: number): Promise<UserWalletRecord[]> {
  const user = await getUserByTelegramId(telegramId);
  if (!user) throw new Error('User not found. Run /start first.');
  return getUserWallets(user.id, 'sui');
}

export async function switchActiveSuiWallet(telegramId: number, walletId: string): Promise<UserWalletRecord> {
  const user = await getUserByTelegramId(telegramId);
  if (!user) throw new Error('User not found. Run /start first.');
  const wallet = await setActiveWallet(user.id, 'sui', walletId);
  balanceCache.delete(telegramId);
  tradeBalanceCache.delete(telegramId);
  return wallet;
}

export async function renameUserSuiWallet(telegramId: number, walletId: string, newName: string): Promise<UserWalletRecord> {
  const user = await getUserByTelegramId(telegramId);
  if (!user) throw new Error('User not found. Run /start first.');
  const trimmed = newName.trim();
  if (!trimmed || trimmed.length > 30) {
    throw new Error('Wallet name must be between 1 and 30 characters.');
  }
  return renameUserWallet(user.id, walletId, trimmed);
}

export async function deleteUserSuiWallet(telegramId: number, walletId: string): Promise<{ success: boolean; fallbackWallet?: UserWalletRecord }> {
  const user = await getUserByTelegramId(telegramId);
  if (!user) throw new Error('User not found. Run /start first.');
  const result = await deleteUserWallet(user.id, walletId);
  balanceCache.delete(telegramId);
  tradeBalanceCache.delete(telegramId);
  return result;
}