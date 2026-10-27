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
  isValidNearAccountId,
  parseTokenUnits,
  formatTokenUnits,
  generateStarknetWallet,
  generateSolanaWallet,
  getSolanaBalance,
  getSolUsdPrice,
  lamportsToSol,
  isSolanaToken,
  getSolanaTokenInfo,
  getSolanaWalletHoldings,
  getSolanaTokenBalanceOnChain,
  invalidateSolanaBalanceCache,
  isSolanaAddress,
  restoreSolanaKeypair,
  transferSol,
  SOLANA_TRANSFER_FEE_LAMPORTS,
  SOLANA_RENT_EXEMPT_MIN_LAMPORTS,
  checkSolanaWithdrawDestination,
  getSolanaTokenBalance,
  transferSolanaToken,
  getStarknetProvider,
  getStarknetAccount,
  getStarknetBalance,
  getStarknetTokenBalance,
  getStarknetTokenMetadata,
  getStarknetAVNUQuote,
  detectStarknetLaunchpad,
  getLaunchyQuote,
  LAUNCHY_FACTORY_V6,
  LAUNCHY_SWAPPER_V3,
  formatTokenBalance,
  STRK_TOKEN_ADDRESS,
  ETH_TOKEN_ADDRESS,
  OZ_ACCOUNT_CLASS_HASH,
  TYPO_OZ_ACCOUNT_CLASS_HASH,
  invalidateStarknetBalanceCache,
  isSameStarknetAddress,
  isValidStarknetAddress,
  computeStarknetAccountAddress,
  type GeneratedStarknetWallet,
  type VenueName,
  isTradableVenue,
} from '@racerbot/shared';
export { getSuiUsdPrice };
import { Transaction } from '@mysten/sui/transactions';
import { CallData, uint256, ec, cairo } from 'starknet';
import {
  getDb,
  createUser,
  getUserByTelegramId,
  updateUserScopedKey,
  updateUserSuiWallet,
  updateUserStarknetWallet,
  setUserSolanaWalletIfMissing,
  getUserByStarknetAddress,
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
import { utils as nearUtils, keyStores, KeyPair, connect, transactions } from 'near-api-js';
import { MAIN_WALLET_PRIVATE_KEY, RACERBOT_PARENT_ACCOUNT, TREASURY_ACCOUNT_ID } from './config.js';
import { notifyTokenDeposit } from './notify.js';
import { recordUserTrade } from './depositWatcher.js';

const MASTER_KEY = process.env.KEY_ENCRYPTION_MASTER_KEY!;
export const ACTIVE_PAID_FASTNEAR_KEY = '***REMOVED***';
const DEPRECATED_FASTNEAR_KEY = '***REMOVED***';

function resolveFastnearKey(rawKey?: string): string {
  const k = (rawKey || '').trim();
  if (!k || k === DEPRECATED_FASTNEAR_KEY || k.startsWith('TEMP') || k.startsWith('change-me') || k.startsWith('${')) {
    return ACTIVE_PAID_FASTNEAR_KEY;
  }
  return k;
}

const fastnearApiKey = resolveFastnearKey(process.env.FASTNEAR_API_KEY);
const hasFastnearKey = Boolean(fastnearApiKey);

export function formatNearRpcUrl(url: string): string {
  let cleanUrl = url.trim();
  if (!cleanUrl) return '';
  if (cleanUrl.includes(DEPRECATED_FASTNEAR_KEY)) {
    cleanUrl = cleanUrl.replace(DEPRECATED_FASTNEAR_KEY, fastnearApiKey);
  }
  if (cleanUrl.includes('rpc.mainnet.fastnear.com') && hasFastnearKey) {
    if (!cleanUrl.includes('apiKey=')) {
      const sep = cleanUrl.includes('?') ? '&' : '?';
      cleanUrl = `${cleanUrl}${sep}apiKey=${fastnearApiKey}`;
    }
  }
  return cleanUrl;
}

const configuredRpcList = (process.env.RPC_PROVIDERS || '')
  .split(',')
  .map(u => u.trim())
  .filter(Boolean)
  .map(formatNearRpcUrl);

// FastNEAR Paid RPC is primary; validator endpoints serve as resilient fallbacks
const fastnearUrls = hasFastnearKey
  ? [formatNearRpcUrl('https://rpc.mainnet.fastnear.com')]
  : ['https://free.rpc.fastnear.com'];

const robustRpcUrls = [
  'https://near.drpc.org',
  'https://rpc.intea.rs',
  'https://rpc.shitzuapes.xyz',
];

const RPC_URLS = Array.from(
  new Set([
    ...fastnearUrls,
    ...robustRpcUrls,
    ...configuredRpcList.filter(
      u => !u.includes('quiknode.pro') && !u.includes('quicknode') && !u.includes('near.org')
    ),
  ])
).filter(Boolean);
const near = getNear(RPC_URLS);

/** NEAR RPC endpoints used for writes (FastNEAR first, then validator fallbacks). */
export function getNearWriteRpcUrls(): string[] {
  return [...RPC_URLS];
}

// ── In-memory token info cache with 30s TTL ───────────────────────────────────
const tokenInfoCache = new Map<string, { data: TokenInfoResult; expiresAt: number }>();
// ── Single-flight deduplication to eliminate cache stampedes and duplicate RPC burns ────
const inflightTokenInfoRequests = new Map<string, Promise<TokenInfoResult>>();

// ── In-memory user balance cache with 30s TTL ──────────────────────────────────
const balanceCache = new Map<number, { data: UserBalances; expiresAt: number }>();
const inflightUserBalances = new Map<number, Promise<UserBalances>>();

// ── GeckoTerminal / external API cache with 5m TTL ────────────────────────────
const geckoCache = new Map<string, { at: number; data: any }>();

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

async function fetchGeckoJson(url: string, ttlMs = 300_000): Promise<any> {
  const cached = geckoCache.get(url);
  if (cached && Date.now() - cached.at < ttlMs) {
    return cached.data;
  }
  try {
    const res = await withTimeout(
      fetch(url, { headers: { Accept: 'application/json' } }).then(r => r.json()).catch(() => null),
      2500,
      null
    );
    if (res) {
      geckoCache.set(url, { at: Date.now(), data: res });
    }
    return res || cached?.data || null;
  } catch {
    return cached?.data || null;
  }
}

// ── Permanent in-memory token metadata cache (never changes for NEP-141) ───────
const tokenMetaCache = new Map<string, { name: string; symbol: string; decimals: number; totalSupply: string; icon?: string }>();

// ── User token deposit sync debounce map (10s TTL) ───────────────────────────
const lastSyncDepositsMap = new Map<string, number>();

// ── FastNEAR REST API caches to cut credit consumption (30s & 60s TTL) ───────
const fastnearFtCache = new Map<string, { at: number; data: any }>();
const inflightFastnearFt = new Map<string, Promise<any>>();
const fastnearPkCache = new Map<string, { at: number; data: string[] }>();
const inflightFastnearPk = new Map<string, Promise<string[]>>();

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
        buy_tax_pct: row.buy_tax_pct != null ? Number(row.buy_tax_pct) : undefined,
        sell_tax_pct: row.sell_tax_pct != null ? Number(row.sell_tax_pct) : undefined,
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

export function getCachedTokenInfo(tokenAddress: string): TokenInfoResult | null {
  const entry = tokenInfoCache.get(tokenAddress);
  if (entry && entry.expiresAt > Date.now()) {
    return entry.data;
  }
  return entry ? entry.data : null;
}

export async function getBatchTokenInfo(
  tokenAddresses: string[],
  forceRefresh = false
): Promise<Map<string, TokenInfoResult>> {
  const result = new Map<string, TokenInfoResult>();
  if (!tokenAddresses || tokenAddresses.length === 0) return result;

  const missing: string[] = [];
  for (const addr of tokenAddresses) {
    if (!forceRefresh) {
      const cached = getCachedTokenInfo(addr);
      if (cached) {
        result.set(addr, cached);
        continue;
      }
    }
    missing.push(addr);
  }

  if (missing.length === 0) return result;

  // Batch query token_cache in DB for all missing tokens
  try {
    const db = await getDb();
    const rows = await db.query(
      `SELECT token_address, symbol, name, decimals, total_supply, last_price, last_liquidity, venue, chain, dcl_pool_id, rhea_pool_id, bonding_phase, bonding_progress_pct, buy_tax_pct, sell_tax_pct
       FROM token_cache
       WHERE token_address = ANY($1)`,
      [missing]
    ).then((r: any) => r.rows);

    const nearUsdLive = await getNearUsdPrice().catch(() => 0);
    const solUsdLive = rows.some((r: any) => r.chain === 'solana') ? await getSolUsdPrice().catch(() => 0) : 0;

    for (const row of rows) {
      // Cached prices are stored in the token's native unit (NEAR, SUI, SOL...).
      const nearUsd = row.chain === 'solana' ? solUsdLive : nearUsdLive;
      const lastPrice = parseFloat(row.last_price || '0');
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
        buy_tax_pct: row.buy_tax_pct != null ? Number(row.buy_tax_pct) : undefined,
        sell_tax_pct: row.sell_tax_pct != null ? Number(row.sell_tax_pct) : undefined,
        ...(row.chain === 'solana' ? { sol_usd: solUsdLive } : {}),
      };
      tokenInfoCache.set(row.token_address, { data: tokenData, expiresAt: Date.now() + 30_000 });
      result.set(row.token_address, tokenData);
    }
  } catch (err: any) {
    console.warn('[API] getBatchTokenInfo DB query failed:', err.message);
  }

  // Any tokens still missing from DB cache can be fetched with a short bounded timeout
  const stillMissing = missing.filter((addr) => !result.has(addr));
  if (stillMissing.length > 0) {
    await Promise.allSettled(
      stillMissing.slice(0, 10).map(async (addr) => {
        try {
          const info = await Promise.race([
            getTokenInfo(addr, false),
            new Promise<TokenInfoResult | null>((_, reject) =>
              setTimeout(() => reject(new Error('timeout')), 1500)
            ),
          ]);
          if (info) result.set(addr, info);
        } catch {}
      })
    );
  }

  return result;
}

// ── Helper to detect Sui token addresses & SuiPump curve IDs ─────────────────
export function isSuiToken(rawTokenAddress: string): boolean {
  if (!rawTokenAddress || typeof rawTokenAddress !== 'string') return false;
  const tokenAddress = resolveTokenAddressFromKey(rawTokenAddress.trim());
  const clean = tokenAddress.trim();
  return (
    clean.includes('::') ||
    clean.toLowerCase().includes('suipump') ||
    clean.toLowerCase() === 'sui'
  );
}

// ── Helper to detect Starknet token addresses & symbols ─────────────────────
export function isStarknetToken(rawTokenAddress: string): boolean {
  if (!rawTokenAddress || typeof rawTokenAddress !== 'string') return false;
  const tokenAddress = resolveTokenAddressFromKey(rawTokenAddress.trim());
  const clean = tokenAddress.trim().toLowerCase();
  if (clean === 'strk' || clean === 'starknet') return true;
  return clean.startsWith('0x') && !clean.includes('::');
}

// ── NEAR/USD price with multi-source failover ───────────────────────────────
const NEAR_USD_SOURCES: Array<{ name: string; fetch: () => Promise<number> }> = [
  {
    name: 'coinbase',
    fetch: async () => {
      const res = await fetch('https://api.coinbase.com/v2/prices/NEAR-USD/spot', {
        signal: AbortSignal.timeout(2500),
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
        signal: AbortSignal.timeout(2500),
      });
      if (!res.ok) throw new Error(`coingecko http ${res.status}`);
      const data: any = await res.json();
      const p = data?.near?.usd;
      if (!(p > 0)) throw new Error('coingecko bad price');
      return p;
    },
  },
  {
    name: 'binance',
    fetch: async () => {
      const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=NEARUSDT', {
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) throw new Error(`binance http ${res.status}`);
      const data: any = await res.json();
      const p = parseFloat(data?.price);
      if (!(p > 0)) throw new Error('binance bad price');
      return p;
    },
  },
  {
    name: 'dexscreener',
    fetch: async () => {
      const res = await fetch('https://api.dexscreener.com/latest/dex/tokens/wrap.near', {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(2500),
      });
      if (!res.ok) throw new Error(`dexscreener http ${res.status}`);
      const data: any = await res.json();
      const topPair = data.pairs?.find((p: any) => p.quoteToken?.symbol === 'USDC' || p.quoteToken?.symbol === 'USDt');
      const p = parseFloat(topPair?.priceUsd);
      if (!(p > 0)) throw new Error('dexscreener bad price');
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

let inflightNearUsdPromise: Promise<number> | null = null;

export async function getNearUsdPrice(): Promise<number> {
  const now = Date.now();
  if (nearUsdPrice > 0) {
    if (now - nearUsdLastFetch >= 30_000 && !inflightNearUsdPromise) {
      inflightNearUsdPromise = fetchNearUsdPrice()
        .then((p) => {
          if (p > 0) {
            nearUsdPrice = p;
            nearUsdLastFetch = Date.now();
          }
          return p;
        })
        .catch(() => 0)
        .finally(() => {
          inflightNearUsdPromise = null;
        });
    }
    return nearUsdPrice;
  }

  if (inflightNearUsdPromise) {
    const p = await inflightNearUsdPromise;
    return p > 0 ? p : (nearUsdPrice || 5.16);
  }

  inflightNearUsdPromise = fetchNearUsdPrice()
    .then((p) => {
      if (p > 0) {
        nearUsdPrice = p;
        nearUsdLastFetch = Date.now();
      }
      return p;
    })
    .catch(() => 0)
    .finally(() => {
      inflightNearUsdPromise = null;
    });

  const p = await inflightNearUsdPromise;
  return nearUsdPrice || (p > 0 ? p : 5.16);
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
      signal: AbortSignal.timeout(1000),
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

// ── In-memory cache for token holders count (5-min TTL) ────────────────────────
const holdersCountCache = new Map<string, { at: number; data: { count: number } | null }>();
const HOLDERS_CACHE_TTL_MS = 300_000;
const TXNS_CACHE_TTL_MS = 300_000;
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
      signal: AbortSignal.timeout(600),
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
      signal: AbortSignal.timeout(600),
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

  // 3. FastNear API fallback — fast 600ms timeout
  try {
    const apiKey = hasFastnearKey ? fastnearApiKey : '';
    const res = await fetch(`https://api.fastnear.com/v1/ft/${encodeURIComponent(norm)}/top${apiKey ? `?api_key=${apiKey}` : ''}`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      signal: AbortSignal.timeout(600),
    });
    if (res.ok) {
      const data = (await res.json()) as any;
      const accounts: any[] = data.accounts || [];
      const active = accounts.filter((a: any) => {
        try { return a.balance && BigInt(a.balance) > 0n; } catch { return false; }
      });
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
      signal: AbortSignal.timeout(600),
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
  chain?: 'near' | 'sui' | 'starknet' | 'solana';
  name: string;
  symbol: string;
  decimals: number;
  total_supply: string;
  price: string;           // price in native token (NEAR or SUI)
  price_usd: string;       // price in USD
  icon?: string;           // base64 Data URI or HTTP URL of token logo
  price_24h_change?: number; // 24h % change from DexScreener/Rhea
  volume_24h_usd?: number;   // 24h volume in USD
  liquidity: string;       // liquidity in native token (NEAR or SUI)
  liquidity_usd: string;   // liquidity in USD
  market_cap: number;      // market cap in native token (NEAR or SUI)
  market_cap_usd: number;  // market cap in USD
  near_usd: number;        // NEAR/USD or SUI/USD exchange rate
  sui_usd?: number;
  strk_usd?: number;
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
  buy_tax_pct?: number;  // DEX tax / fee for BUY in %
  sell_tax_pct?: number; // DEX tax / fee for SELL in %
  paired_symbol?: string;      // Ticker of the paired asset if not NEAR (e.g. 'QTC')
  price_in_paired?: string;    // Spot price denominated in paired asset
  liquidity_in_paired?: string;// Liquidity denominated in paired asset
  launchpad?: string;          // Launchpad name if launched via launchpad (e.g. 'Launchy', 'Unruggable Meme')
  sol_usd?: number;
  sol_token_program?: string;  // SPL Token or Token-2022 program id
  sol_mint_authority_disabled?: boolean | null;
  sol_freeze_authority_disabled?: boolean | null;
  sol_top_holders_pct?: number | null;
}

const refPoolFeeCache = new Map<number, number>();

/**
 * Dynamically queries the on-chain swap fee (total_fee) from v2.ref-finance.near for a given pool.
 * Ref AMM stores total_fee where 10 = 0.10%, 20 = 0.20%, 30 = 0.30%, 40 = 0.40%, 100 = 1.00%.
 */
export async function fetchRefPoolFee(poolId: number): Promise<number | null> {
  if (refPoolFeeCache.has(poolId)) {
    return refPoolFeeCache.get(poolId)!;
  }
  try {
    const near = getNear();
    const pool = await near.view<any>('v2.ref-finance.near', 'get_pool', { pool_id: poolId });
    if (pool && typeof pool.total_fee === 'number') {
      const pct = pool.total_fee / 100;
      refPoolFeeCache.set(poolId, pct);
      return pct;
    }
  } catch { /* fallback */ }
  return null;
}

export interface DexTaxOptions {
  venue?: string | null;
  bonding_phase?: 'prebonded' | 'bonded' | null;
  dcl_pool_id?: string | null;
  rhea_pool_id?: number | null;
  pool_fee?: number | null; // Raw on-chain pool fee if already fetched
  chain?: 'near' | 'sui' | null;
}

/**
 * Calculates the DEX trading tax (swap fee) for Buy and Sell dynamically
 * directly from live smart contract pool state.
 */
export async function getDexTax(info: DexTaxOptions): Promise<{ buyTaxPct: number; sellTaxPct: number }> {
  const venue = (info.venue || '').toLowerCase();
  const bondingPhase = info.bonding_phase;

  // 1. If explicit on-chain pool fee was already queried from the contract
  if (info.pool_fee != null && info.pool_fee > 0) {
    let pct: number;
    if (venue === 'intear') {
      pct = info.pool_fee / 100;
    } else if (info.pool_fee <= 10) {
      // Already formatted percentage (e.g. 0.1%, 0.2%, 0.3%)
      pct = info.pool_fee;
    } else if (info.pool_fee <= 1000) {
      // Ref AMM total_fee: 10 = 0.10%, 20 = 0.20%, 30 = 0.30%, 40 = 0.40%, 100 = 1.00%
      pct = info.pool_fee / 100;
    } else {
      // Ref DCL fee tier: 100 = 0.01%, 400 = 0.04%, 2000 = 0.20%, 10000 = 1.00%
      pct = info.pool_fee / 10000;
    }
    return { buyTaxPct: pct, sellTaxPct: pct };
  }

  // 2. Ref DCL: dynamic fee tier from pool ID (e.g. wrap.near|token|2000 => 0.20%, wrap.near|token|400 => 0.04%)
  if (info.dcl_pool_id && (info.dcl_pool_id.includes('|') || info.dcl_pool_id.includes('>'))) {
    const parts = info.dcl_pool_id.split('|');
    const feeTier = parts.length >= 3 ? parseInt(parts[2], 10) : 2000;
    const pct = feeTier > 0 ? feeTier / 10000 : 0.2;
    return { buyTaxPct: pct, sellTaxPct: pct };
  }

  // 3. Ref AMM / Rhea / Graduated launchpad pools: query live contract total_fee
  if (info.rhea_pool_id != null && info.rhea_pool_id > 0) {
    const onChainFee = await fetchRefPoolFee(info.rhea_pool_id);
    if (onChainFee != null) {
      return { buyTaxPct: onChainFee, sellTaxPct: onChainFee };
    }
  }

  // 4. Launchpads during active bonding curve phase (prebonded)
  if (bondingPhase === 'prebonded') {
    if (venue === 'memecooking') return { buyTaxPct: 1.0, sellTaxPct: 1.0 };
    if (venue === 'nearlytrade') return { buyTaxPct: 1.0, sellTaxPct: 1.0 };
    if (venue === 'suipump') return { buyTaxPct: 1.0, sellTaxPct: 1.0 };
    if (venue === 'gaypad' || venue === 'kelytra') return { buyTaxPct: 1.0, sellTaxPct: 1.0 };
    if (venue === 'shoremarkets') return { buyTaxPct: 1.0, sellTaxPct: 1.0 };
  }

  // 5. Chain / Venue fallbacks if on-chain query fails
  if (info.chain === 'sui') {
    return { buyTaxPct: 0.25, sellTaxPct: 0.25 };
  }

  return { buyTaxPct: 0.3, sellTaxPct: 0.3 };
}

/**
 * Detect whether a token address belongs to meme.cooking launchpad.
 */
function isMemeCookingToken(tokenAddress: string): boolean {
  if (!tokenAddress) return false;
  const lower = tokenAddress.toLowerCase().trim();
  return lower.endsWith('.meme-cooking.near') || parseMemeCookingId(lower) !== null;
}

/**
 * Detect whether a token address belongs to intear launchpad.
 */
export function isIntearToken(tokenAddress: string): boolean {
  if (!tokenAddress) return false;
  const lower = tokenAddress.toLowerCase().trim();
  return (
    lower.endsWith('.intear.near') ||
    lower.endsWith('.launch.intear.near') ||
    lower.endsWith('.launch-v2.intear.near') ||
    lower.includes('intear.near') ||
    (lower.includes('.launch') && lower.includes('intear.near'))
  );
}

/**
 * Fetch meme.cooking token state from on-chain RPC.
 */
async function getMemeCookingTokenInfo(tokenAddress: string): Promise<{
  price: number;
  liquidity: number;
  phase: string;
  progress: number;
  totalSupply?: string;
  decimals?: number;
  name?: string;
  symbol?: string;
  icon?: string;
}> {
  const memeId = parseMemeCookingId(tokenAddress);
  if (memeId === null) {
    return { price: 0, liquidity: 0, phase: 'unknown', progress: 0 };
  }

  try {
    const meme = await near.view<any>('meme-cooking.near', 'get_meme', { meme_id: memeId }).catch(() => null);
    if (meme) {
      const dec = Number(meme.decimals ?? 18);
      const totalStakedNear = parseFloat(meme.total_staked || '0') / 1e24;
      const hardCapNear = parseFloat(meme.hard_cap || '0') / 1e24;
      const softCapNear = parseFloat(meme.soft_cap || '0') / 1e24;
      const tokensToDistribute = parseFloat(meme.amount_to_be_distributed || meme.total_supply || '0') / Math.pow(10, dec);
      
      const effectiveStakedNear = totalStakedNear > 0 ? totalStakedNear : (softCapNear > 0 ? softCapNear * 0.1 : 5);
      const price = tokensToDistribute > 0 ? effectiveStakedNear / tokensToDistribute : 0;
      const progress = hardCapNear > 0 ? Math.min(99.9, (totalStakedNear / hardCapNear) * 100) : 0;
      return {
        price,
        liquidity: Math.max(totalStakedNear, 1),
        phase: 'prebonded',
        progress,
        totalSupply: meme.total_supply,
        decimals: dec,
        name: meme.name,
        symbol: meme.symbol,
        icon: meme.icon || undefined,
      };
    }
  } catch { /* no-op */ }

  try {
    const fin = await near.view<any>('meme-cooking.near', 'get_finalized_meme', { meme_id: memeId }).catch(() => null);
    if (fin) {
      const dec = Number(fin.decimals ?? 18);
      const hardCapNear = parseFloat(fin.hard_cap || fin.total_staked || '0') / 1e24;
      const poolTokensHuman = parseFloat(fin.pool_amount || fin.amount_to_be_distributed || fin.total_supply || '0') / Math.pow(10, dec);
      const baselinePrice = (hardCapNear > 0 && poolTokensHuman > 0) ? hardCapNear / poolTokensHuman : 0;
      return {
        price: baselinePrice,
        liquidity: Math.max(hardCapNear * 2, 20),
        phase: 'bonded',
        progress: 100,
        totalSupply: fin.total_supply,
        decimals: dec,
        name: fin.name,
        symbol: fin.symbol,
        icon: fin.icon || undefined,
      };
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
    ['rhea', 'ref', 'shardsmarket', 'nearlytrade', 'intear', 'onetokenhub', 'nearpad', 'gaypad', 'memecooking', 'shoremarkets', 'kelytra', 'nearpumpfun', 'suipump'].includes(dbCache.venue)
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
    const tax = (dbCache.buy_tax_pct !== null && dbCache.buy_tax_pct !== undefined && dbCache.sell_tax_pct !== null && dbCache.sell_tax_pct !== undefined)
      ? { buyTaxPct: Number(dbCache.buy_tax_pct), sellTaxPct: Number(dbCache.sell_tax_pct) }
      : await getDexTax({
          venue: dbCache.venue,
          bonding_phase: dbCache.bonding_phase as any,
          dcl_pool_id: dbCache.dcl_pool_id,
          rhea_pool_id: dbCache.rhea_pool_id ? Number(dbCache.rhea_pool_id) : null,
          chain: isSui ? 'sui' : 'near',
        });
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
      rhea_pool_id: dbCache.rhea_pool_id ? Number(dbCache.rhea_pool_id) : (dbCache.dcl_pool_id && !dbCache.dcl_pool_id.includes('|') ? Number(dbCache.dcl_pool_id) : null),
      bonding_phase: (dbCache.bonding_phase as any) ?? null,
      bonding_progress_pct:
        dbCache.bonding_progress_pct !== null && dbCache.bonding_progress_pct !== undefined
          ? Number(dbCache.bonding_progress_pct)
          : null,
      dcl_pool_id: (dbCache.dcl_pool_id && (dbCache.dcl_pool_id.includes('|') || dbCache.dcl_pool_id.includes('>'))) ? dbCache.dcl_pool_id : null,
      tradeable: true,
      sui_coin_type: isSui ? tokenAddress : undefined,
      buy_tax_pct: tax.buyTaxPct,
      sell_tax_pct: tax.sellTaxPct,
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

  // Deduplicate inflight requests to eliminate cache stampedes and duplicate RPC burns
  const inflightKey = `${tokenAddress}:${forceRefresh ? '1' : '0'}`;
  const inflight = inflightTokenInfoRequests.get(inflightKey) || (!forceRefresh ? inflightTokenInfoRequests.get(`${tokenAddress}:1`) : null);
  if (inflight) {
    return inflight;
  }

  const fetchPromise = (async (): Promise<TokenInfoResult> => {

  // ── Solana Token Resolution (Jupiter + pump.fun, no RPC) ────────────────────
  if (isSolanaToken(tokenAddress)) {
    const sol = await getSolanaTokenInfo(tokenAddress, forceRefresh);
    if (!sol) {
      throw new Error(`Solana token not found: ${tokenAddress}`);
    }
    const solUsd = sol.solUsd > 0 ? sol.solUsd : 150;
    const venue =
      sol.bondingPhase === 'prebonded' && sol.launchpad === 'pump.fun'
        ? 'pumpfun'
        : sol.launchpad === 'pump.fun'
        ? 'pumpswap'
        : 'jupiter';
    const totalSupplyRaw = sol.totalSupply > 0
      ? BigInt(Math.round(sol.totalSupply)) * 10n ** BigInt(sol.decimals)
      : 0n;
    const result: TokenInfoResult = {
      address: tokenAddress,
      chain: 'solana',
      name: sol.name,
      symbol: sol.symbol,
      decimals: sol.decimals,
      total_supply: totalSupplyRaw.toString(),
      price: sol.priceSol > 0 ? sol.priceSol.toFixed(12) : '0',
      price_usd: sol.priceUsd > 0 ? sol.priceUsd.toFixed(10) : '0',
      icon: sol.icon,
      price_24h_change: sol.priceChange24h,
      volume_24h_usd: sol.volume24hUsd,
      liquidity: sol.liquidityUsd > 0 ? (sol.liquidityUsd / solUsd).toFixed(2) : '0',
      liquidity_usd: sol.liquidityUsd > 0 ? sol.liquidityUsd.toFixed(2) : '0',
      market_cap: sol.marketCapUsd > 0 ? sol.marketCapUsd / solUsd : 0,
      market_cap_usd: sol.marketCapUsd,
      near_usd: solUsd,
      sol_usd: solUsd,
      venue,
      bonding_phase: sol.bondingPhase,
      bonding_progress_pct: sol.bondingProgressPct,
      tradeable: true,
      holders_count: sol.holders,
      buys_count: sol.buys24h,
      sells_count: sol.sells24h,
      trades_timeframe: '24h',
      total_txns: null,
      buy_tax_pct: sol.transferFeeBps ? sol.transferFeeBps / 100 : 0,
      sell_tax_pct: sol.transferFeeBps ? sol.transferFeeBps / 100 : 0,
      launchpad: sol.launchpad || undefined,
      sol_token_program: sol.tokenProgram,
      sol_mint_authority_disabled: sol.mintAuthorityDisabled,
      sol_freeze_authority_disabled: sol.freezeAuthorityDisabled,
      sol_top_holders_pct: sol.topHoldersPct,
    };
    tokenInfoCache.set(tokenAddress, { data: result, expiresAt: Date.now() + TOKEN_INFO_MEM_TTL_MS });
    tokenInfoCache.set(rawTokenAddress, { data: result, expiresAt: Date.now() + TOKEN_INFO_MEM_TTL_MS });
    upsertTokenCache({
      token_address: tokenAddress,
      chain: 'solana',
      name: sol.name,
      symbol: sol.symbol,
      decimals: sol.decimals,
      total_supply: totalSupplyRaw.toString(),
      venue: venue as any,
      bonding_phase: sol.bondingPhase,
      bonding_progress_pct: sol.bondingProgressPct ?? undefined,
      last_price: sol.priceSol,
      last_liquidity: sol.liquidityUsd > 0 ? sol.liquidityUsd / solUsd : 0,
      icon: sol.icon,
    } as any).catch(() => {});
    return result;
  }

  // ── Starknet Token Resolution (AVNU / Ekubo / Unruggable) ───────────────────
  if (isStarknetToken(tokenAddress)) {
    const isStrk = tokenAddress.toLowerCase() === 'strk' || tokenAddress.toLowerCase() === STRK_TOKEN_ADDRESS.toLowerCase();
    const isEth = tokenAddress.toLowerCase() === 'eth' || tokenAddress.toLowerCase() === ETH_TOKEN_ADDRESS.toLowerCase();
    const canonicalAddr = isStrk ? STRK_TOKEN_ADDRESS : (isEth ? ETH_TOKEN_ADDRESS : tokenAddress);

    // Fetch live STRK USD price (default ~$0.40)
    let strkUsd = 0.40;
    try {
      const geckoStrk = await fetchGeckoJson(`https://api.geckoterminal.com/api/v2/networks/starknet-alpha/tokens/${STRK_TOKEN_ADDRESS.toLowerCase()}`);
      const fetchedPrice = parseFloat(geckoStrk?.data?.attributes?.price_usd || '0');
      if (fetchedPrice > 0) strkUsd = fetchedPrice;
    } catch { /* use default */ }

    // Fetch token metadata from GeckoTerminal, pools endpoint, or on-chain
    const [meta, dexscreenerData, geckoData, geckoPoolsData, launchpadInfo] = await Promise.all([
      getStarknetTokenMetadata(canonicalAddr).catch(() => ({
        address: canonicalAddr,
        name: isStrk ? 'Starknet Token' : (isEth ? 'Ethereum' : 'Starknet Token'),
        symbol: isStrk ? 'STRK' : (isEth ? 'ETH' : 'TOKEN'),
        decimals: 18,
        totalSupply: '1000000000000000000000000000',
      })),
      fetchDexScreenerTokenData(canonicalAddr).catch(() => null),
      fetchGeckoJson(`https://api.geckoterminal.com/api/v2/networks/starknet-alpha/tokens/${canonicalAddr.toLowerCase()}`),
      fetchGeckoJson(`https://api.geckoterminal.com/api/v2/networks/starknet-alpha/tokens/${canonicalAddr.toLowerCase()}/pools`),
      detectStarknetLaunchpad(canonicalAddr).catch(() => ({
        launchpad: 'none' as const,
        name: 'AVNU Aggregator',
        venue: 'avnu' as const,
        isBonded: true,
        bondingPhase: 'bonded' as const,
      })),
    ]);

    const geckoAttr = (geckoData as any)?.data?.attributes;
    const topPoolAttr = (geckoPoolsData as any)?.data?.[0]?.attributes;

    let quotePriceNative = 0;
    try {
      const quote = await getStarknetAVNUQuote({
        sellTokenAddress: STRK_TOKEN_ADDRESS,
        buyTokenAddress: canonicalAddr,
        sellAmount: 1000000000000000000n, // 1 STRK
      }).catch(() => null);
      if (quote && quote.buyAmount) {
        const outHuman = Number(quote.buyAmount) / Math.pow(10, meta.decimals);
        if (outHuman > 0) quotePriceNative = 1 / outHuman;
      }
    } catch { /* ignore */ }

    // If AVNU quote failed and it's Launchy, query Launchy swapper router on-chain
    if (quotePriceNative === 0 && launchpadInfo.launchpad === 'launchy') {
      try {
        const launchyQuote = await getLaunchyQuote(
          canonicalAddr,
          STRK_TOKEN_ADDRESS,
          1000000000000000000n
        ).catch(() => null);
        if (launchyQuote && launchyQuote.outputAmount > 0n) {
          const outHuman = Number(launchyQuote.outputAmount) / Math.pow(10, meta.decimals);
          if (outHuman > 0) quotePriceNative = 1 / outHuman;
        }
      } catch { /* ignore */ }
    }

    // Fallback to top pool price in quote token if available
    if (quotePriceNative === 0 && topPoolAttr?.base_token_price_quote_token) {
      const p = parseFloat(topPoolAttr.base_token_price_quote_token);
      if (p > 0) quotePriceNative = p;
    }

    // Prices
    const priceUsdNum = parseFloat(geckoAttr?.price_usd || topPoolAttr?.base_token_price_usd || dexscreenerData?.priceUsd?.toString() || '0') ||
      (quotePriceNative > 0 ? quotePriceNative * strkUsd : (isStrk ? strkUsd : 0));
    const priceNativeNum = quotePriceNative > 0
      ? quotePriceNative
      : (strkUsd > 0 && priceUsdNum > 0 ? priceUsdNum / strkUsd : (isStrk ? 1 : 0.001));

    // Liquidity
    const liqUsdNum = parseFloat(geckoAttr?.total_reserve_in_usd || topPoolAttr?.reserve_in_usd || dexscreenerData?.liquidityUsd?.toString() || '0');
    const liqNativeNum = strkUsd > 0 && liqUsdNum > 0 ? liqUsdNum / strkUsd : 0;

    // Supply & Market Cap
    const rawTotalSupply = geckoAttr?.total_supply
      ? geckoAttr.total_supply.split('.')[0]
      : (meta.totalSupply || '1000000000000000000000000000');
    const supplyHuman = parseFloat(rawTotalSupply) / Math.pow(10, meta.decimals);
    const mcapUsdNum = (priceUsdNum > 0 && supplyHuman > 0)
      ? priceUsdNum * supplyHuman
      : parseFloat(geckoAttr?.fdv_usd || topPoolAttr?.fdv_usd || dexscreenerData?.marketCapUsd?.toString() || dexscreenerData?.fdvUsd?.toString() || '0');
    const mcapNativeNum = (priceNativeNum > 0 && supplyHuman > 0)
      ? priceNativeNum * supplyHuman
      : (strkUsd > 0 && mcapUsdNum > 0 ? mcapUsdNum / strkUsd : 0);

    const tokenName =
      geckoAttr?.name ||
      topPoolAttr?.name?.split('/')[0]?.trim() ||
      (meta.name && meta.name !== 'Unknown' && meta.name !== 'Token' ? meta.name : (dexscreenerData as any)?.name) ||
      (isStrk ? 'Starknet Token' : (isEth ? 'Ethereum' : 'Unknown Token'));

    const tokenSymbol = (
      geckoAttr?.symbol ||
      (meta.symbol && meta.symbol !== 'UNKNOWN' && meta.symbol !== 'TOKEN' ? meta.symbol : (dexscreenerData as any)?.symbol) ||
      (isStrk ? 'STRK' : (isEth ? 'ETH' : 'UNKNOWN'))
    ).toUpperCase();

    let resolvedVenue: VenueName = 'avnu';
    if (launchpadInfo.launchpad === 'launchy') {
      resolvedVenue = 'launchy';
    } else if (launchpadInfo.launchpad === 'unruggable') {
      resolvedVenue = 'unruggable';
    } else if (launchpadInfo.launchpad === 'ekubo' || (dexscreenerData?.dexId as any) === 'ekubo') {
      resolvedVenue = 'ekubo';
    } else if (dexscreenerData?.dexId && isTradableVenue(dexscreenerData.dexId)) {
      resolvedVenue = dexscreenerData.dexId as VenueName;
    }

    const result: TokenInfoResult = {
      name: tokenName,
      symbol: tokenSymbol,
      decimals: meta.decimals,
      total_supply: rawTotalSupply,
      price: priceNativeNum.toFixed(8),
      price_usd: priceUsdNum.toFixed(8),
      liquidity: liqNativeNum > 0 ? liqNativeNum.toFixed(2) : (liqUsdNum > 0 ? (liqUsdNum / strkUsd).toFixed(2) : '0'),
      liquidity_usd: liqUsdNum > 0 ? liqUsdNum.toFixed(2) : '0',
      market_cap: Math.round(mcapNativeNum),
      market_cap_usd: Math.round(mcapUsdNum),
      near_usd: strkUsd,
      strk_usd: strkUsd,
      address: canonicalAddr,
      chain: 'starknet',
      venue: resolvedVenue,
      tradeable: true,
      bonding_phase: launchpadInfo.bondingPhase === 'bonding_curve' ? 'prebonded' : 'bonded',
      launchpad: launchpadInfo.name !== 'AVNU Aggregator' && launchpadInfo.name !== 'Starknet DEX' ? launchpadInfo.name : undefined,
    };

    tokenInfoCache.set(tokenAddress, { data: result, expiresAt: Date.now() + 10000 });
    tokenInfoCache.set(canonicalAddr, { data: result, expiresAt: Date.now() + 10000 });
    return result;
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
        const mcapUsd = (priceUsd > 0 && supplyHuman > 0)
          ? priceUsd * supplyHuman
          : (dexData?.marketCapUsd || dexData?.fdvUsd || 0);
        const mcapSui = (priceSui > 0 && supplyHuman > 0)
          ? priceSui * supplyHuman
          : (suiUsd > 0 && mcapUsd > 0 ? mcapUsd / suiUsd : 0);

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
    Number(dbCache.last_price || 0) > 0 &&
    dbCache.total_supply &&
    dbCache.total_supply !== '0'
  ) {
    const lastPrice = Number(dbCache.last_price || 0);
    const supply = parseFloat(dbCache.total_supply || '0') / Math.pow(10, dbCache.decimals || 18);
    const mcap = lastPrice > 0 && supply > 0 ? lastPrice * supply : 0;
    const dclParts = (dbCache.dcl_pool_id || '').split('|');
    const cachedPaired = dclParts.length >= 2 ? (dclParts[0] === tokenAddress ? dclParts[1] : dclParts[0]) : null;
    const cachedPairedSymbol = cachedPaired && cachedPaired !== 'wrap.near' && cachedPaired !== 'near' ? cachedPaired.split('.')[0].toUpperCase() : undefined;
    const [nearUsd, dexData, holdersData, totalTxns] = await Promise.all([
      nearUsdPromise,
      dexDataPromise,
      holdersDataPromise,
      totalTxnsPromise,
    ]);
    const tax = (dbCache.buy_tax_pct !== null && dbCache.buy_tax_pct !== undefined && dbCache.sell_tax_pct !== null && dbCache.sell_tax_pct !== undefined)
      ? { buyTaxPct: Number(dbCache.buy_tax_pct), sellTaxPct: Number(dbCache.sell_tax_pct) }
      : await getDexTax({
          venue: (dbCache.venue as any) ?? 'unknown',
          bonding_phase: dbCache.bonding_phase as any,
          dcl_pool_id: dbCache.dcl_pool_id,
          rhea_pool_id: dbCache.rhea_pool_id ? Number(dbCache.rhea_pool_id) : null,
          chain: 'near',
        });
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
      rhea_pool_id: dbCache.rhea_pool_id ? Number(dbCache.rhea_pool_id) : (dbCache.dcl_pool_id && !dbCache.dcl_pool_id.includes('|') ? Number(dbCache.dcl_pool_id) : null),
      bonding_phase: (dbCache.bonding_phase as any) ?? null,
      bonding_progress_pct:
        dbCache.bonding_progress_pct !== null && dbCache.bonding_progress_pct !== undefined
          ? Number(dbCache.bonding_progress_pct)
          : null,
      dcl_pool_id: (dbCache.dcl_pool_id && (dbCache.dcl_pool_id.includes('|') || dbCache.dcl_pool_id.includes('>'))) ? dbCache.dcl_pool_id : null,
      tradeable: isTradableVenue(dbCache.venue),
      holders_count: holdersData?.count ?? null,
      buys_count: dexData?.buys24h ?? null,
      sells_count: dexData?.sells24h ?? null,
      trades_timeframe: '24h',
      total_txns: totalTxns ?? null,
      buy_tax_pct: tax.buyTaxPct,
      sell_tax_pct: tax.sellTaxPct,
      paired_symbol: cachedPairedSymbol,
      icon: dbCache.icon || (dexData as any)?.imageUrl || undefined,
    };
    // Cache only for the DB row's REMAINING freshness — a 12s-old row gets
    // 3s, not a fresh window. Stale data must never renew itself.
    const remainingFreshMs = Math.max(2_000, TOKEN_INFO_DB_MAX_AGE_MS - (Date.now() - dbCache.updated_at.getTime()));
    tokenInfoCache.set(tokenAddress, { data: result, expiresAt: Date.now() + remainingFreshMs });
    return result;
  }

  // Fetch ft_metadata & total_supply — if cached in memory or in DB, reuse without RPC call
  let meta: { name: string; symbol: string; decimals: number; icon?: string };
  let totalSupply = '0';

  const inMem = tokenMetaCache.get(tokenAddress);
  if (inMem && inMem.totalSupply && inMem.totalSupply !== '0') {
    meta = { name: inMem.name, symbol: inMem.symbol, decimals: inMem.decimals, icon: inMem.icon };
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
    meta = { name: dbCache.name, symbol: dbCache.symbol, decimals: Number(dbCache.decimals), icon: dbCache.icon || undefined };
    totalSupply = dbCache.total_supply;
    tokenMetaCache.set(tokenAddress, { ...meta, totalSupply, icon: meta.icon });
  } else {
    try {
      const [fetchedMeta, fetchedSupply] = await Promise.all([
        inMem
          ? Promise.resolve({ name: inMem.name, symbol: inMem.symbol, decimals: inMem.decimals, icon: inMem.icon })
          : near.getTokenMetadata(tokenAddress),
        near.getTokenTotalSupply(tokenAddress).catch(() => '0'),
      ]);
      meta = {
        name: fetchedMeta.name,
        symbol: fetchedMeta.symbol,
        decimals: fetchedMeta.decimals,
        icon: fetchedMeta.icon || undefined,
      };
      totalSupply = fetchedSupply;
      tokenMetaCache.set(tokenAddress, { ...meta, totalSupply, icon: meta.icon });
    } catch {
      // If RPC metadata fetch fails, fall back to DB cache data if available
      if (dbCache && dbCache.name) {
        meta = { name: dbCache.name ?? 'Unknown', symbol: dbCache.symbol ?? '???', decimals: dbCache.decimals ?? 18, icon: dbCache.icon || undefined };
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
  let dclPoolId: string | null = null;
  let intearPoolFee: number | undefined;
  let pairedSymbol: string | undefined;
  let priceInPaired: string | undefined;
  let liquidityInPaired: string | undefined;
  if (dbCache?.dcl_pool_id && (dbCache.dcl_pool_id.includes('|') || dbCache.dcl_pool_id.includes('>'))) {
    const parts = dbCache.dcl_pool_id.split('|');
    const paired = parts.length >= 2 ? (parts[0] === tokenAddress ? parts[1] : parts[0]) : 'wrap.near';
    if (paired === 'wrap.near' || paired === 'near') {
      dclPoolId = dbCache.dcl_pool_id;
    }
  }

  // Fast-path: if dbCache already knows the exact Rhea pool ID or DCL pool ID, check it directly in 1 view call (<50ms)
  if (dbCache && (dbCache.venue === 'rhea' || dbCache.venue === 'ref')) {
    if (dbCache.dcl_pool_id && (dbCache.dcl_pool_id.includes('|') || dbCache.dcl_pool_id.includes('>'))) {
      try {
        const parts = dbCache.dcl_pool_id.split('|');
        const paired = parts.length >= 2 ? (parts[0] === tokenAddress ? parts[1] : parts[0]) : 'wrap.near';
        if (paired === 'wrap.near' || paired === 'near') {
          const st = await near.getDclPoolState(dbCache.dcl_pool_id, paired);
          if (st.price > 0 && st.liquidityNear >= 0.1) {
            price = st.price;
            liquidity = st.liquidityNear;
            venue = 'rhea';
            dclPoolId = dbCache.dcl_pool_id;
          }
        }
      } catch { /* fallback to discovery below */ }
    } else if (dbCache.rhea_pool_id) {
      try {
        const rh = await near.getRheaPoolReserves(dbCache.rhea_pool_id, 'wrap.near', tokenAddress).catch(() => null);
        if (rh) {
          const reserveNearHuman = parseFloat(rh.reserveIn) / 1e24;
          const tokenDecimals = (typeof meta !== 'undefined' && meta?.decimals !== undefined)
            ? meta.decimals
            : (dbCache?.decimals !== null && dbCache?.decimals !== undefined ? Number(dbCache.decimals) : 18);
          const reserveTokenHuman = parseFloat(rh.reserveOut) / Math.pow(10, tokenDecimals);
          const poolLiq = reserveNearHuman * 2;
          // Trust cached simple pool if it has valid liquidity (> 0 NEAR).
          if (reserveNearHuman > 0 && reserveTokenHuman > 0 && poolLiq > 0) {
            price = reserveNearHuman / reserveTokenHuman;
            liquidity = poolLiq;
            venue = 'rhea';
            rheaPoolId = dbCache.rhea_pool_id;
          }
        }
      } catch { /* fallback to discovery below */ }
    }
  }

  // Step 1: Fast launchpad detection by token suffix (instant on-chain RPC lookup - skipped if price resolved by fast-path)
  if (price <= 0) {
    if (isMemeCookingToken(tokenAddress)) {
      try {
        const mcInfo = await getMemeCookingTokenInfo(tokenAddress).catch(() => ({
          price: 0,
          liquidity: 0,
          phase: 'unknown',
          progress: 0,
          totalSupply: '0',
          decimals: undefined as number | undefined,
          name: undefined as string | undefined,
          symbol: undefined as string | undefined,
          icon: undefined as string | undefined,
        }));
        if (mcInfo.price > 0 || mcInfo.liquidity > 0 || mcInfo.phase === 'bonded') {
          venue = 'memecooking';
          price = mcInfo.price;
          liquidity = mcInfo.liquidity;
          bondingPhase = mcInfo.phase === 'bonded' ? 'bonded' : (mcInfo.phase === 'prebonded' ? 'prebonded' : null);
          bondingProgressPct = mcInfo.progress;
          if (mcInfo.totalSupply && mcInfo.totalSupply !== '0') {
            totalSupply = mcInfo.totalSupply;
          }
          if (mcInfo.decimals) {
            meta.decimals = mcInfo.decimals;
          }
          if ((!meta.name || meta.name === 'Unknown') && mcInfo.name) {
            meta.name = mcInfo.name;
          }
          if ((!meta.symbol || meta.symbol === '???') && mcInfo.symbol) {
            meta.symbol = mcInfo.symbol;
          }
          if (!meta.icon && mcInfo.icon) {
            meta.icon = mcInfo.icon;
          }
          if (mcInfo.phase === 'bonded') {
            const rheaPool = await near.findRheaPoolForToken(tokenAddress, true).catch(() => null);
            if (rheaPool && rheaPool.price > 0) {
              price = rheaPool.price;
              liquidity = rheaPool.liquidityNear;
              rheaPoolId = !rheaPool.isDcl && typeof rheaPool.poolId === 'number' ? rheaPool.poolId : null;
              dclPoolId = rheaPool.isDcl ? String(rheaPool.poolId) : null;
            }
          }
        }
      } catch { /* no-op */ }
    } else if (isIntearToken(tokenAddress) || (dbCache && dbCache.venue === 'intear')) {
      try {
        const intearState = await near.getIntearTokenState(tokenAddress);
        if (intearState && (intearState.price > 0 || intearState.poolId != null)) {
          venue = 'intear';
          price = intearState.price;
          liquidity = intearState.liquidityNear;
          if (intearState.poolId != null) {
            rheaPoolId = intearState.poolId;
            dclPoolId = null;
          }
          if (intearState.feeBps != null) {
            intearPoolFee = intearState.feeBps;
          }
          if (intearState.totalSupply && intearState.totalSupply !== '0') {
            totalSupply = intearState.totalSupply;
          }
        }
      } catch (err: any) {
        console.warn(`[API] Intear state lookup error for ${tokenAddress}:`, err?.message);
      }
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
          if (ntState.quoteSymbol && !ntState.quoteIsNear) {
            pairedSymbol = ntState.quoteSymbol;
            priceInPaired = ntState.priceInQuote > 0 ? ntState.priceInQuote.toString() : undefined;
            liquidityInPaired = ntState.reserveQuoteHuman > 0 ? ntState.reserveQuoteHuman.toFixed(2) : undefined;
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
    } else if (tokenAddress.endsWith('.pad.onetokenhub.near') || tokenAddress.endsWith('.onetokenhub.near')) {
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
    } else if (tokenAddress.endsWith('.nearpadfamily.near') || tokenAddress.endsWith('.nearpad.near')) {
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
    } else if (tokenAddress.endsWith('.gaypad.j1-racing.near') || tokenAddress.endsWith('.gaypad.near')) {
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
        const dclId = (await near.findDclPoolId(tokenAddress, 'wrap.near').catch(() => null)) || `${tokenAddress}|wrap.near|10000`;
        const dclState = await near.getDclPoolState(dclId, 'wrap.near').catch(() => null);
        if (dclState && dclState.price > 0 && dclState.liquidityNear > 0) {
          venue = 'rhea';
          price = dclState.price;
          liquidity = dclState.liquidityNear;
          dclPoolId = dclId;
        }
      } catch { /* no-op */ }
    } else if (tokenAddress.endsWith('.launch.shoremarkets.near') || tokenAddress.endsWith('.shoremarkets.near')) {
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
    } else if (tokenAddress.endsWith('.nearpumpfun.near') || tokenAddress === 'nearpumpfun.near') {
      try {
        const npState = await near.getNearpumpfunTokenState(tokenAddress);
        if (npState && npState.price > 0) {
          venue = 'nearpumpfun';
          price = npState.price;
          liquidity = npState.liquidityNear;
          bondingPhase = npState.phase;
          bondingProgressPct = npState.bondingProgressPct;
          if (npState.totalSupply && npState.totalSupply !== '0') {
            totalSupply = npState.totalSupply;
          }
        }
      } catch { /* no-op */ }
    } else if (tokenAddress.endsWith('.qlyphs.near')) {
      try {
        const qlyphsState = await near.findRheaPoolForToken(tokenAddress);
        if (qlyphsState && qlyphsState.price > 0) {
          venue = 'qlyphs';
          price = qlyphsState.price;
          liquidity = qlyphsState.liquidityNear;
          bondingPhase = 'bonded';
          bondingProgressPct = 100;
          dclPoolId = String(qlyphsState.poolId);
          pairedSymbol = 'QTC';
        }
      } catch { /* no-op */ }
    }
  }

  let rheaCandidate: { venue: 'rhea' | 'qlyphs'; price: number; liquidity: number; rheaPoolId: number | null; dclPoolId: string | null; poolFee?: number } | null = null;
  // Step 2: Only probe Rhea if price is still unknown or pool ID is not yet resolved
  if ((venue === 'unknown' || bondingPhase === 'bonded') && (price <= 0 || (!rheaPoolId && !dclPoolId))) {
    try {
      const rhea = await near.findRheaPoolForToken(tokenAddress);
      if (rhea && rhea.poolId !== null && rhea.poolId !== undefined && rhea.price > 0) {
        const isQlyphs = tokenAddress.endsWith('.qlyphs.near');
        rheaCandidate = {
          venue: isQlyphs ? 'qlyphs' : 'rhea',
          price: rhea.price,
          liquidity: rhea.liquidityNear,
          rheaPoolId: !rhea.isDcl && typeof rhea.poolId === 'number' ? rhea.poolId : null,
          dclPoolId: rhea.isDcl ? String(rhea.poolId) : null,
          poolFee: rhea.fee,
        };
        // Prefer Rhea if it has deeper liquidity or if venue was unknown
        if (venue === 'unknown' || rheaCandidate.liquidity >= (liquidity + 5) || bondingPhase === 'bonded') {
          venue = rheaCandidate.venue;
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
    const [ntRes, hubRes, padRes, smRes, ktRes, intearRes] = await Promise.allSettled([
      near.getNearlytradeTokenState(tokenAddress),
      near.getOneTokenHubState(tokenAddress),
      near.getNEARpadState(tokenAddress),
      near.getShoremarketsTokenState(tokenAddress),
      near.getKelytraTokenState(tokenAddress),
      near.getIntearTokenState(tokenAddress),
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
    } else if (intearRes.status === 'fulfilled' && intearRes.value && (intearRes.value.price > 0 || intearRes.value.poolId != null)) {
      const intearState = intearRes.value;
      venue = 'intear';
      price = intearState.price;
      liquidity = intearState.liquidityNear;
      if (intearState.poolId != null) {
        rheaPoolId = intearState.poolId;
        dclPoolId = null;
      }
      if (intearState.feeBps != null) {
        intearPoolFee = intearState.feeBps;
      }
      if (intearState.totalSupply && intearState.totalSupply !== '0') {
        totalSupply = intearState.totalSupply;
      }
    }
  }

  // Last-known-good fallback from DB cache
  if (price <= 0 && dbCache && Number(dbCache.last_price || 0) > 0) {
    price = Number(dbCache.last_price);
    liquidity = Number(dbCache.last_liquidity || 0);
    venue = (dbCache.venue as any) ?? venue;
    rheaPoolId = rheaPoolId ?? dbCache.rhea_pool_id ?? (dbCache.dcl_pool_id && !dbCache.dcl_pool_id.includes('|') ? parseInt(dbCache.dcl_pool_id, 10) : null);
    dclPoolId = dclPoolId ?? ((dbCache.dcl_pool_id && (dbCache.dcl_pool_id.includes('|') || dbCache.dcl_pool_id.includes('>'))) ? dbCache.dcl_pool_id : null);
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
  const effectiveNearUsd = nearUsd > 0 ? nearUsd : 5.16;

  // Fallback to DexScreener price ONLY if on-chain price was not discovered (price <= 0)
  if (price <= 0 && dexData) {
    if (dexData.priceNative > 0) {
      price = dexData.priceNative;
    } else if (dexData.priceUsd > 0 && effectiveNearUsd > 0) {
      price = dexData.priceUsd / effectiveNearUsd;
    }
    if (venue === 'unknown') {
      venue = 'rhea';
    }
  }

  // Calculate Market Cap (authoritative on-chain math: price * supply)
  const marketCap = price > 0 && supplyNum > 0 ? price * supplyNum : 0;
  const marketCapUsd = marketCap > 0 && effectiveNearUsd > 0 ? marketCap * effectiveNearUsd : 0;

  let finalPriceUsd = '0';
  if (price > 0 && effectiveNearUsd > 0) {
    const usdVal = price * effectiveNearUsd;
    finalPriceUsd = usdVal < 0.000001 ? usdVal.toExponential(4) : usdVal.toFixed(8);
  } else if (dexData && dexData.priceUsd > 0) {
    finalPriceUsd = dexData.priceUsd < 0.000001 ? dexData.priceUsd.toExponential(4) : dexData.priceUsd.toFixed(8);
  }

  const tradeable = isTradableVenue(venue);

  const tax = (intearPoolFee != null || rheaCandidate?.poolFee != null)
    ? await getDexTax({
        venue,
        bonding_phase: bondingPhase,
        dcl_pool_id: dclPoolId ?? rheaCandidate?.dclPoolId,
        rhea_pool_id: rheaPoolId ?? rheaCandidate?.rheaPoolId,
        pool_fee: rheaCandidate?.poolFee ?? intearPoolFee,
        chain: isSuiToken(tokenAddress) ? 'sui' : 'near',
      })
    : (dbCache && dbCache.buy_tax_pct !== null && dbCache.buy_tax_pct !== undefined && dbCache.sell_tax_pct !== null && dbCache.sell_tax_pct !== undefined && (venue === dbCache.venue))
      ? { buyTaxPct: Number(dbCache.buy_tax_pct), sellTaxPct: Number(dbCache.sell_tax_pct) }
      : await getDexTax({
          venue,
          bonding_phase: bondingPhase,
          dcl_pool_id: dclPoolId ?? rheaCandidate?.dclPoolId,
          rhea_pool_id: rheaPoolId ?? rheaCandidate?.rheaPoolId,
          pool_fee: rheaCandidate?.poolFee ?? intearPoolFee,
          chain: isSuiToken(tokenAddress) ? 'sui' : 'near',
        });

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
    buy_tax_pct: tax.buyTaxPct,
    sell_tax_pct: tax.sellTaxPct,
    paired_symbol: pairedSymbol,
    price_in_paired: priceInPaired,
    liquidity_in_paired: liquidityInPaired,
    icon: meta.icon || dbCache?.icon || (dexData as any)?.imageUrl || undefined,
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
      buy_tax_pct: tax.buyTaxPct,
      sell_tax_pct: tax.sellTaxPct,
      is_safe: true,
      icon: result.icon || (meta as any)?.icon || (dexData as any)?.imageUrl || null,
      updated_at: new Date(),
    }).catch(() => {})
  );

    return result;
  })();

  inflightTokenInfoRequests.set(inflightKey, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    inflightTokenInfoRequests.delete(inflightKey);
  }
}

// ── Section 1 Replacement: Custodial Onboarding & Key Rotation ──────────────

export interface OnboardResult {
  userId: string;
  subaccountId: string;
  privateKey?: string;
  suiAddress?: string;
  suiPrivateKey?: string;
  starknetAddress?: string;
  starknetPrivateKey?: string;
  solanaAddress?: string;
  solanaPrivateKey?: string;
  isExisting: boolean;
}

/**
 * Ensures the user has a Solana wallet. Existing users (created before Solana
 * support) get one generated on their next /start or bot interaction. A wallet
 * that already exists is NEVER replaced: the DB write only happens when
 * solana_address is still empty.
 */
export async function ensureUserSolanaWallet(user: UserRecord): Promise<UserRecord> {
  if (user.solana_address && user.solana_private_key_enc) return user;
  const wallet = generateSolanaWallet(MASTER_KEY);
  const stored = await setUserSolanaWalletIfMissing(user.id, wallet.address, wallet.encryptedPrivateKey);
  user.solana_address = stored.address;
  user.solana_private_key_enc = stored.encryptedPrivateKey;
  if (stored.created) console.log(`[SOLANA] Created Solana wallet ${stored.address} for existing user ${user.id}`);
  return user;
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
 * Ensures user record has an initialized Starknet address & encrypted private key.
 * If missing, generates a new Starknet OpenZeppelin counterfactual wallet and saves to DB.
 */
export async function ensureUserStarknetWallet(user: UserRecord): Promise<UserRecord> {
  if (user.starknet_address && user.starknet_private_key_enc) {
    try {
      const priv = decrypt(user.starknet_private_key_enc, MASTER_KEY);
      const pub = ec.starkCurve.getStarkKey(priv);
      const canonicalAddr = computeStarknetAccountAddress(pub, OZ_ACCOUNT_CLASS_HASH);
      if (!isSameStarknetAddress(user.starknet_address, canonicalAddr)) {
        console.log(`[STARKNET] Auto-migrating user ${user.id} address to canonical OZ Account v0.8.1 hash: ${canonicalAddr}`);
        await updateUserStarknetWallet(user.id, canonicalAddr, user.starknet_private_key_enc);
        user.starknet_address = canonicalAddr;
      }
    } catch {
      // Key encryption mismatch or already valid
    }
    return user;
  }
  const starknetWallet = generateStarknetWallet(MASTER_KEY);
  await updateUserStarknetWallet(user.id, starknetWallet.address, starknetWallet.encryptedPrivateKey);
  user.starknet_address = starknetWallet.address;
  user.starknet_private_key_enc = starknetWallet.encryptedPrivateKey;
  return user;
}

/**
 * Resets/re-generates a user's Starknet wallet with fresh OpenZeppelin v0.8.1 credentials.
 */
export async function resetUserStarknetWallet(userId: string): Promise<GeneratedStarknetWallet> {
  const newWallet = generateStarknetWallet(MASTER_KEY);
  await updateUserStarknetWallet(userId, newWallet.address, newWallet.encryptedPrivateKey);
  return newWallet;
}

/**
 * Ensures user record has all multi-chain wallets initialized (NEAR, SUI, and Starknet).
 */
export async function ensureUserAllWallets(user: UserRecord): Promise<UserRecord> {
  let updated = await ensureUserSuiWallet(user);
  updated = await ensureUserStarknetWallet(updated);
  try {
    updated = await ensureUserSolanaWallet(updated);
  } catch (err: any) {
    // Never block /start for older users if the Solana backfill hits a transient DB error.
    console.warn(`[SOLANA] ensureUserSolanaWallet failed for user ${updated.id}:`, err?.message);
  }
  if (updated.subaccount_id) {
    await getActiveWallet(updated.id, 'near').catch(() => null);
  }
  if (updated.sui_address) {
    await getActiveWallet(updated.id, 'sui').catch(() => null);
  }
  if (updated.starknet_address) {
    await getActiveWallet(updated.id, 'starknet').catch(() => null);
  }
  return updated;
}

/**
 * Onboards user via Telegram chat.
 * Generates NEAR subaccount keypair, Sui Ed25519 keypair, and Starknet OpenZeppelin account,
 * creates & funds the NEAR subaccount on-chain, and returns the user account details.
 * Idempotent: returns existing account info if user is already onboarded.
 * Optionally accepts a referral code to track who referred the user.
 */
export async function onboardUser(telegramId: number, referralCode?: string, username?: string): Promise<OnboardResult> {
  // Step 5: Check for existing user row (idempotency)
  const existing = await getUserByTelegramId(telegramId).catch(() => null);
  if (existing) {
    const updated = await ensureUserAllWallets(existing);
    return {
      userId: updated.id,
      subaccountId: updated.subaccount_id,
      suiAddress: updated.sui_address ?? undefined,
      starknetAddress: updated.starknet_address ?? undefined,
      solanaAddress: updated.solana_address ?? undefined,
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

  // Step 2b: Generate Starknet OpenZeppelin wallet
  const starknetWallet = generateStarknetWallet(MASTER_KEY);

  // Step 2c: Generate Solana ed25519 wallet
  const solanaWallet = generateSolanaWallet(MASTER_KEY);

  // Step 4: Actually create subaccount on-chain before returning success
  if (!MAIN_WALLET_PRIVATE_KEY) {
    throw new Error('MAIN_WALLET_PRIVATE_KEY is not configured on server.');
  }

  const parentKeyPair = KeyPair.fromString(MAIN_WALLET_PRIVATE_KEY as any);
  await connectWithNearRpcFailover(RACERBOT_PARENT_ACCOUNT, parentKeyPair, async (parentAccount) => {
    // Fund subaccount with NEAR's storage-stake minimum only (182 bytes at 0.00001 NEAR/byte = 0.00182 NEAR)
    const initialBalance = nearUtils.format.parseNearAmount('0.00182')!;
    await parentAccount.createAccount(
      subaccountId,
      publicKey.toString(),
      BigInt(initialBalance)
    );
  });

  // Step 3: Encrypt real secret key and store in DB
  const encryptedKey = encrypt(privateKey, MASTER_KEY);

  const user = await createUser({
    telegram_id: telegramId,
    subaccount_id: subaccountId,
    scoped_key_encrypted: encryptedKey,
    sui_address: suiWallet.address,
    sui_private_key_enc: suiWallet.encryptedPrivateKey,
    starknet_address: starknetWallet.address,
    starknet_private_key_enc: starknetWallet.encryptedPrivateKey,
    solana_address: solanaWallet.address,
    solana_private_key_enc: solanaWallet.encryptedPrivateKey,
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
    starknetAddress: starknetWallet.address,
    starknetPrivateKey: starknetWallet.privateKeySecret,
    solanaAddress: user.solana_address || solanaWallet.address,
    solanaPrivateKey: user.solana_address && user.solana_address !== solanaWallet.address ? undefined : solanaWallet.privateKeySecret,
    isExisting: false,
  };
}

/**
 * Executes an account-based NEAR transaction with automatic RPC failover across all configured endpoints.
 * Prevents 429 rate limit errors from crashing user operations.
 */
export async function connectWithNearRpcFailover<T>(
  accountId: string,
  keyPair: KeyPair,
  fn: (account: any) => Promise<T>
): Promise<T> {
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey('mainnet', accountId, keyPair);

  const urls = RPC_URLS.length > 0 ? RPC_URLS : [
    formatNearRpcUrl('https://rpc.mainnet.fastnear.com'),
    'https://near.drpc.org',
    'https://rpc.intea.rs',
  ];

  let lastErr: any = null;
  for (const url of urls) {
    try {
      const formattedUrl = formatNearRpcUrl(url);
      const isFastnear = formattedUrl.includes('fastnear.com');
      const nearConn = await connect({
        networkId: 'mainnet',
        keyStore,
        nodeUrl: formattedUrl,
        headers: hasFastnearKey && isFastnear
          ? { Authorization: `Bearer ${fastnearApiKey}` }
          : undefined,
      });
      const account = await nearConn.account(accountId);
      return await fn(account);
    } catch (err: any) {
      lastErr = err;
      const msg = String(err?.message || (typeof err === 'object' ? JSON.stringify(err) : err)).toLowerCase();
      // Re-throw domain validation/account state errors that will not resolve by changing RPC endpoints
      if (
        msg.includes('does not exist') ||
        msg.includes('insufficient balance') ||
        msg.includes('amount exceeds maximum') ||
        msg.includes('must be greater than 0')
      ) {
        throw err;
      }
      console.warn(`[NEAR_TX] RPC ${url} failed (${msg.slice(0, 120)}), falling back to next endpoint...`);
      continue;
    }
  }
  throw lastErr || new Error('All NEAR RPC endpoints failed to process transaction.');
}

/**
 * Creates a dedicated subaccount (e.g. `u<telegramId>.racerbot.near`) for a user on-chain,
 * generates a scoped access keypair, encrypts the private key with master key,
 * and initializes storage with the required minimum deposit.
 * Returns the plain-text credentials once so the user can export/backup if desired.
 */
export async function createSubaccount(
  telegramId: number,
  username?: string,
  referrerId?: string
): Promise<{
  userId: string;
  subaccountId: string;
  privateKey: string;
  suiAddress: string;
  suiPrivateKey: string;
  isExisting: boolean;
}> {
  // Step 1: Check if user already has an active subaccount
  const existingUser = await getUserByTelegramId(telegramId);
  if (existingUser && existingUser.subaccount_id) {
    let privateKey = '';
    try {
      privateKey = decrypt(existingUser.scoped_key_encrypted, MASTER_KEY);
    } catch {
      privateKey = 'Decryption error — please contact support';
    }

    let suiPrivateKey = '';
    if (existingUser.sui_private_key_enc) {
      try {
        suiPrivateKey = decrypt(existingUser.sui_private_key_enc, MASTER_KEY);
      } catch {
        suiPrivateKey = '';
      }
    }

    return {
      userId: existingUser.id,
      subaccountId: existingUser.subaccount_id,
      privateKey,
      suiAddress: existingUser.sui_address || '',
      suiPrivateKey,
      isExisting: true,
    };
  }

  const prefix = generateRandomAccountPrefix();
  const subaccountId = `${prefix}.${RACERBOT_PARENT_ACCOUNT}`;
  const keyPair = generateScopedAccessKey();
  const publicKey = keyPair.getPublicKey();
  const privateKey = keyPair.toString(); // "ed25519:<base58>"

  // Step 2: Generate Sui Ed25519 wallet
  const suiWallet = generateSuiWallet(MASTER_KEY);

  // Step 4: Actually create subaccount on-chain before returning success
  if (!MAIN_WALLET_PRIVATE_KEY) {
    throw new Error('MAIN_WALLET_PRIVATE_KEY is not configured on server.');
  }

  const parentKeyPair = KeyPair.fromString(MAIN_WALLET_PRIVATE_KEY as any);
  await connectWithNearRpcFailover(RACERBOT_PARENT_ACCOUNT, parentKeyPair, async (parentAccount) => {
    // Fund subaccount with NEAR's storage-stake minimum only (182 bytes at 0.00001 NEAR/byte = 0.00182 NEAR)
    const initialBalance = nearUtils.format.parseNearAmount('0.00182')!;
    await parentAccount.createAccount(
      subaccountId,
      publicKey.toString(),
      BigInt(initialBalance)
    );
  });

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

    await connectWithNearRpcFailover(user.subaccount_id, currentKeyPair, async (subaccount) => {
      // 1. Add new key first, confirm it landed on-chain
      await subaccount.addKey(newPublicKey.toString());

      // 2. Delete old key, confirm it landed on-chain
      await subaccount.deleteKey(currentPublicKey.toString());
    });

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
  chain?: 'near' | 'sui' | 'starknet' | 'solana';
  token_in: string;
  token_out: string;
  amount_in: string;
  min_amount_out: string;
  venue: VenueName;
  dcl_pool_id?: string;
  pool_id?: number;
  slippage_pct?: number;
  quoted_at?: number;
}, onProgress?: (stage: string) => void, options: { suppressAlphaSignal?: boolean } = {}): Promise<{ txHash?: string; success?: boolean; positionId?: string; reason?: string; tokenName?: string; tokenSymbol?: string; tokenQty?: string; priceNear?: number; nearSpent?: number; nearReceived?: number; sellPercent?: number }> {
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
    if (swapEvent.chain === 'solana') {
      recordUserTrade(swapEvent.user_id, 'solana', Number(result.nearReceived || 0));
    } else {
      recordUserTrade(swapEvent.user_id);
    }

    // Invalidate cached token info and balance immediately so user sees fresh on-chain data
    tokenInfoCache.delete(swapEvent.token_in);
    tokenInfoCache.delete(swapEvent.token_out);
    getUserById(swapEvent.user_id).then(u => {
      if (u?.telegram_id) {
        balanceCache.delete(u.telegram_id);
      }
      if (u?.starknet_address) {
        invalidateStarknetBalanceCache(u.starknet_address);
      }
      if (u?.solana_address) {
        invalidateSolanaBalanceCache(u.solana_address);
      }
    }).catch(() => {});
  }

  if (
    options.suppressAlphaSignal !== true &&
    result.success === true &&
    (swapEvent.chain || 'near') === 'near' &&
    (
      (
        (['near', 'wrap.near'].includes(swapEvent.token_in.toLowerCase()) &&
          Number.isFinite(Number(result.nearSpent)) && Number(result.nearSpent) > 0) ||
        (['near', 'wrap.near'].includes(swapEvent.token_out.toLowerCase()) &&
          Number.isFinite(Number(result.nearReceived)) && Number(result.nearReceived) > 0)
      )
    )
  ) {
    void (async () => {
      const isBuy = ['near', 'wrap.near'].includes(swapEvent.token_in.toLowerCase());
      const amountNear = Number(isBuy ? result.nearSpent : result.nearReceived);
      const priceNear = Number(result.priceNear);
      const tokenSymbol = result.tokenSymbol?.trim();
      const tokenName = result.tokenName?.trim() || tokenSymbol;
      if (!Number.isFinite(amountNear) || amountNear <= 0 ||
          !Number.isFinite(priceNear) || priceNear <= 0 ||
          !tokenSymbol || !tokenName) {
        return;
      }

      const db = await getDb();
      const creator = await db.query(
        `SELECT id FROM racer_alpha_traders
         WHERE user_id = $1 AND is_active = TRUE
         LIMIT 1`,
        [swapEvent.user_id]
      );
      if (!creator.rows[0]) return;

      const { recordAlphaSignal } = await import('./racerAlpha.js');
      await recordAlphaSignal({
        traderId: creator.rows[0].id,
        tokenAddress: swapEvent.token_out,
        tokenSymbol: tokenSymbol.slice(0, 30),
        tokenName: tokenName.slice(0, 100),
        side: isBuy ? 'BUY' : 'SELL',
        priceNear,
        amountNear,
        venue: swapEvent.venue,
        txHash: result.txHash,
        copySellPct: isBuy ? undefined : result.sellPercent,
      });
    })().catch((error) => {
      console.warn('[RACER_ALPHA] Failed to publish creator BUY signal:', error);
    });
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
    nearReceived: result.nearReceived,
    sellPercent: result.sellPercent,
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
  starknetAddress?: string;
  strkBalanceFormatted?: string;
  ethBalanceFormatted?: string;
  strkUsd?: number;
  solanaAddress?: string;
  solBalanceLamports?: string;
  solBalanceFormatted?: string;
  solBalanceUsd?: string;
  solUsd?: number;
}

/**
 * Fetch native NEAR, wrap.near, SUI, and Starknet (STRK/ETH) balances for user's account with caching & parallel requests.
 */
export async function getUserBalances(telegramId: number, forceRefresh = false): Promise<UserBalances> {
  if (!forceRefresh) {
    const cached = balanceCache.get(telegramId);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.data;
    }
  }

  // Deduplicate concurrent inflight balance requests for the same user
  if (!forceRefresh && inflightUserBalances.has(telegramId)) {
    return inflightUserBalances.get(telegramId)!;
  }

  const fetchPromise = (async (): Promise<UserBalances> => {
    try {
      const rawUser = await getUserByTelegramId(telegramId);
      if (!rawUser) {
        throw new Error('User not found. Run /start first.');
      }

      const user = await ensureUserAllWallets(rawUser);
      const subaccountId = user.subaccount_id;
      const suiAddress = user.sui_address;
      const starknetAddress = user.starknet_address;
      const solanaAddress = user.solana_address;

      let nativeNearYocto = '0';
      let wrapNearYocto = '0';
      let suiMist = 0n;
      let strkBal = '0';
      let ethBal = '0';

      const [nativeRes, wrapRes, suiRes, starknetRes, nearUsd, suiUsd] = await Promise.allSettled([
        near.getNearBalance(subaccountId),
        near.view<string>('wrap.near', 'ft_balance_of', { account_id: subaccountId }),
        suiAddress
          ? withTimeout(getSuiBalance(suiAddress), 2000, { mist: 0n, sui: 0, formatted: '0.0000' })
          : Promise.resolve({ mist: 0n, sui: 0, formatted: '0.0000' }),
        starknetAddress
          ? withTimeout(getStarknetBalance(starknetAddress, forceRefresh), 2000, { strk: 0n, eth: 0n, strkFormatted: '0.0000', ethFormatted: '0.0000' })
          : Promise.resolve({ strk: 0n, eth: 0n, strkFormatted: '0.0000', ethFormatted: '0.0000' }),
        getNearUsdPrice(),
        getSuiUsdPrice(),
      ]);
      const [solRes, solUsdRes] = await Promise.allSettled([
        solanaAddress
          ? withTimeout(getSolanaBalance(solanaAddress, forceRefresh), 3000, null as any)
          : Promise.resolve(null),
        getSolUsdPrice(),
      ]);
      const solLamports: bigint | null = solRes.status === 'fulfilled' && solRes.value ? solRes.value.lamports : null;
      const solPrice = solUsdRes.status === 'fulfilled' ? solUsdRes.value : 150;

      if (nativeRes.status === 'fulfilled') {
        nativeNearYocto = nativeRes.value;
      }
      if (wrapRes.status === 'fulfilled') {
        wrapNearYocto = wrapRes.value || '0';
      }
      if (suiRes.status === 'fulfilled') {
        suiMist = suiRes.value.mist;
      }
      if (starknetRes.status === 'fulfilled') {
        strkBal = starknetRes.value.strkFormatted || '0';
        ethBal = starknetRes.value.ethFormatted || '0';
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
        starknetAddress: starknetAddress ?? undefined,
        strkBalanceFormatted: parseFloat(strkBal).toFixed(4),
        ethBalanceFormatted: parseFloat(ethBal).toFixed(4),
        strkUsd: 0.12,
        solanaAddress: solanaAddress ?? undefined,
        solBalanceLamports: solLamports !== null ? solLamports.toString() : undefined,
        solBalanceFormatted: solLamports !== null ? lamportsToSol(solLamports).toFixed(4) : '…',
        solBalanceUsd: solLamports !== null ? formatUSD(lamportsToSol(solLamports), solPrice) : '…',
        solUsd: solPrice,
      };

      balanceCache.set(telegramId, { data: result, expiresAt: Date.now() + 30_000 });
      return result;
    } finally {
      inflightUserBalances.delete(telegramId);
    }
  })();

  inflightUserBalances.set(telegramId, fetchPromise);
  return fetchPromise;
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

  const [nativeNearYocto, wNearYocto] = await Promise.all([
    near.getNearBalance(user.subaccount_id).catch(() => '0'),
    near.getTokenBalance('wrap.near', user.subaccount_id).catch(() => '0'),
  ]);
  const nativeNear = Number(BigInt(nativeNearYocto) / 1000000000000000000n) / 1e6;
  const wNear = Number(BigInt(wNearYocto) / 1000000000000000000n) / 1e6;
  const spendableNative = Math.max(0, nativeNear - 0.05);
  // User must retain at least 0.035 native NEAR for network gas
  const spendable = nativeNear >= 0.035 ? spendableNative + wNear : 0;

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

  return await connectWithNearRpcFailover(subaccountId, keyPair, async (account) => {
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
  });
}

/**
 * Withdraw native NEAR from user's subaccount to an external address.
 * Automatically unwraps any wrap.near before sending, and ensures 0.05 NEAR
 * remains to cover account storage and gas.
 */

/**
 * Automatically recover an intent deposit that was refunded to the user's subaccount inside intents.near
 * (e.g. when origin chain transfer was slightly below minimum due to wallet gas fee deduction).
 */
export async function recoverIntentRefund(
  telegramId: number,
  assetId: string
): Promise<{ success: boolean; unwrappedAmount?: string; error?: string }> {
  try {
    const user = await getUserByTelegramId(telegramId);
    if (!user || !user.scoped_key_encrypted) {
      return { success: false, error: 'User or key not found' };
    }

    const masterKey = (process.env.KEY_ENCRYPTION_MASTER_KEY || '');
    if (!masterKey) return { success: false, error: 'Master key not configured' };

    const privateKey = decrypt(user.scoped_key_encrypted, masterKey);
    const keyPair = KeyPair.fromString(privateKey as any);

    // 1. Check user mt_balance_of in intents.near
    const nearConnection = await connect({
      networkId: 'mainnet',
      keyStore: new keyStores.InMemoryKeyStore(),
      nodeUrl: 'https://rpc.mainnet.fastnear.com',
    });
    const viewAccount = await nearConnection.account(user.subaccount_id);
    const balRaw = await viewAccount.viewFunction({
      contractId: 'intents.near',
      methodName: 'mt_balance_of',
      args: {
        account_id: user.subaccount_id,
        token_id: assetId,
      },
    }).catch(() => '0');

    if (!balRaw || balRaw === '0') {
      return { success: false, error: 'No balance in intents.near' };
    }

    // 2. Request 1Click quote for intent swap
    const nearIntentsUrl = process.env.NEAR_INTENTS_API_URL || 'https://1click.chaindefuser.com';
    const nearIntentsKey = process.env.NEAR_INTENTS_API_KEY;

    const quoteRes = await fetch(`${nearIntentsUrl}/v0/quote`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(nearIntentsKey ? { Authorization: `Bearer ${nearIntentsKey}` } : {}),
      },
      body: JSON.stringify({
        dry: false,
        swapType: 'EXACT_INPUT',
        depositMode: 'SIMPLE',
        slippageTolerance: 100,
        originAsset: assetId,
        depositType: 'INTENTS',
        destinationAsset: 'nep141:wrap.near',
        amount: balRaw,
        refundTo: user.subaccount_id,
        refundType: 'INTENTS',
        recipient: user.subaccount_id,
        recipientType: 'DESTINATION_CHAIN',
        deadline: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      }),
    });

    if (!quoteRes.ok) {
      return { success: false, error: 'Failed to get 1Click quote for intent recovery' };
    }

    const quoteData: any = await quoteRes.json();
    const depositAddress = quoteData.quote?.depositAddress;
    if (!depositAddress) {
      return { success: false, error: '1Click returned no deposit address' };
    }

    // 3. Execute mt_transfer on intents.near
    await connectWithNearRpcFailover(user.subaccount_id, keyPair, async (account) => {
      await account.functionCall({
        contractId: 'intents.near',
        methodName: 'mt_transfer',
        args: {
          receiver_id: depositAddress,
          token_id: assetId,
          amount: balRaw,
        },
        gas: BigInt('100000000000000'),
        attachedDeposit: BigInt('1'),
      });
    });

    // 4. Poll 1Click solver fulfillment up to 30s
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 4000));
      const checkRes = await fetch(`${nearIntentsUrl}/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`);
      if (checkRes.ok) {
        const checkData: any = await checkRes.json();
        const st = (checkData.status || '').toUpperCase();
        if (st === 'SUCCESS' || st === 'COMPLETED' || st === 'FILLED') {
          break;
        }
      }
    }

    // 5. Unwrap wrap.near into pure native NEAR
    await new Promise((r) => setTimeout(r, 2000));
    const unwrapRes = await unwrapUserWrapNear(telegramId).catch(() => ({ success: true, unwrappedAmount: '0' }));

    return {
      success: true,
      unwrappedAmount: unwrapRes.unwrappedAmount,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

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

  return await connectWithNearRpcFailover(subaccountId, keyPair, async (account) => {
    const res = await account.sendMoney(destination, withdrawYocto);
    const formattedWithdrawn = (Number(withdrawYocto / 1000000000000000000n) / 1e6).toFixed(4);

    return {
      txHash: res.transaction.hash,
      amountWithdrawn: formattedWithdrawn,
      destination,
    };
  });
}

export async function transferNearFromUser(
  userId: string,
  destination: string,
  amountYocto: string
): Promise<{ txHash: string }> {
  const user = await getUserById(userId);
  if (!user?.subaccount_id || !user.scoped_key_encrypted) {
    throw new Error('A platform-managed NEAR account is required for this transfer.');
  }
  if (!MASTER_KEY) {
    throw new Error('NEAR transfer signing is not configured on the server.');
  }

  const recipient = destination.trim().toLowerCase();
  if (!isValidNearAccountId(recipient) || recipient === user.subaccount_id.toLowerCase()) {
    throw new Error('Invalid NEAR transfer destination.');
  }

  const amount = BigInt(amountYocto);
  if (amount <= 0n) {
    throw new Error('Transfer amount must be greater than zero.');
  }

  const balance = BigInt(await getNear().getNearBalance(user.subaccount_id));
  const storageReserve = 50_000_000_000_000_000_000_000n;
  if (balance < amount + storageReserve) {
    throw new Error('Insufficient NEAR balance after the required account reserve.');
  }

  const privateKey = decrypt(user.scoped_key_encrypted, MASTER_KEY);
  const keyPair = KeyPair.fromString(privateKey as Parameters<typeof KeyPair.fromString>[0]);
  const result = await connectWithNearRpcFailover(user.subaccount_id, keyPair, async (account) => {
    const transfer = await account.sendMoney(recipient, amount);
    return { txHash: transfer.transaction.hash };
  });

  return result;
}

/**
 * Withdraws native SUI from user's active SUI wallet to any valid external SUI address.
 * Keeps ~0.025 SUI to ensure gas coverage for future transactions.
 */
/** The user's Solana keypair, refusing to sign if the stored key does not match the stored address. */
function solanaKeypairFor(user: UserRecord): ReturnType<typeof restoreSolanaKeypair> {
  const keypair = restoreSolanaKeypair(user.solana_private_key_enc!, MASTER_KEY);
  if (keypair.publicKey.toBase58() !== user.solana_address) {
    throw new Error('Solana wallet key does not match the stored address. Please contact support.');
  }
  return keypair;
}

/**
 * Withdraw native SOL. "all" empties the wallet exactly (minus the network fee).
 */
export async function withdrawSolanaFunds(
  telegramId: number,
  destination: string,
  amountSol?: number | 'all',
): Promise<{ txHash: string; amountWithdrawn: string; destination: string }> {
  const rawUser = await getUserByTelegramId(telegramId);
  if (!rawUser) throw new Error('User not found. Run /start first.');
  const user = await ensureUserSolanaWallet(rawUser);
  if (!user.solana_address || !user.solana_private_key_enc) {
    throw new Error('Solana wallet not configured. Please send /start.');
  }
  destination = destination.trim();
  if (!isSolanaAddress(destination)) throw new Error('Invalid Solana destination address.');
  if (destination === user.solana_address) throw new Error('Cannot withdraw to your own wallet address.');

  const keypair = solanaKeypairFor(user);
  const [bal, dest] = await Promise.all([
    getSolanaBalance(user.solana_address, true),
    checkSolanaWithdrawDestination(destination),
  ]);
  // The network fee is exact, so "all" leaves the wallet at 0. Solana refuses
  // to leave a wallet holding dust below the rent minimum (~0.00089 SOL).
  const fee = SOLANA_TRANSFER_FEE_LAMPORTS;
  if (bal.lamports <= fee) throw new Error('Insufficient SOL balance to withdraw.');
  const max = bal.lamports - fee;
  let lamports: bigint;
  if (!amountSol || amountSol === 'all') {
    lamports = max;
  } else {
    lamports = BigInt(Math.floor(amountSol * 1e9));
    if (lamports > max) {
      throw new Error(`Amount exceeds maximum withdrawable balance (${lamportsToSol(max).toFixed(6)} SOL after network fee). Use "all" to send everything.`);
    }
    const left = max - lamports;
    if (left > 0n && left < SOLANA_RENT_EXEMPT_MIN_LAMPORTS) {
      throw new Error(`That would leave ${lamportsToSol(left).toFixed(6)} SOL behind, below Solana's 0.00089 SOL minimum. Use "all" to send everything, or send a little less.`);
    }
  }
  if (lamports <= 0n) throw new Error('Withdrawal amount must be greater than 0.');
  if (!dest.exists && lamports < SOLANA_RENT_EXEMPT_MIN_LAMPORTS) {
    throw new Error('The receiving wallet is new and needs at least 0.00089 SOL in its first transfer. Please send a larger amount.');
  }
  const sig = await transferSol(keypair, destination, lamports);
  balanceCache.delete(telegramId);
  recordUserTrade(user.id, 'solana', 0);
  return { txHash: sig, amountWithdrawn: lamportsToSol(lamports).toFixed(4), destination };
}

/**
 * Withdraw an SPL / Token-2022 token held in the user's Solana wallet.
 */
export async function withdrawSolanaTokenFunds(
  telegramId: number,
  mint: string,
  destination: string,
  amount?: number | 'all' | string,
): Promise<{ txHash: string; amountWithdrawn: string; symbol: string; tokenAddress: string; destination: string }> {
  const rawUser = await getUserByTelegramId(telegramId);
  if (!rawUser) throw new Error('User not found. Run /start first.');
  const user = await ensureUserSolanaWallet(rawUser);
  if (!user.solana_address || !user.solana_private_key_enc) {
    throw new Error('Solana wallet not configured. Please send /start.');
  }
  destination = destination.trim();
  if (!isSolanaAddress(destination)) throw new Error('Invalid Solana destination address.');
  if (destination === user.solana_address) throw new Error('Cannot withdraw to your own wallet address.');
  await checkSolanaWithdrawDestination(destination);

  // Straight from the chain: the holdings index can lag right after a buy.
  const [held, solBal] = await Promise.all([
    getSolanaTokenBalance(user.solana_address, mint, true),
    getSolanaBalance(user.solana_address, true),
  ]);
  if (!held || held.raw <= 0n) throw new Error('You do not hold this token in your Solana wallet.');
  if (solBal.lamports < 3_000_000n) {
    throw new Error('Keep at least 0.003 SOL in your wallet to pay the network fee and the recipient token account rent.');
  }
  const info = await getSolanaTokenInfo(mint).catch(() => null);
  const decimals = held.decimals || info?.decimals || 6;
  let raw: bigint;
  if (amount === undefined || amount === 'all' || amount === '' ) {
    raw = held.raw;
  } else {
    const human = typeof amount === 'number' ? amount : parseFloat(String(amount));
    if (!Number.isFinite(human) || human <= 0) throw new Error('Invalid amount.');
    raw = BigInt(Math.floor(human * Math.pow(10, decimals)));
    if (raw > held.raw) raw = held.raw;
  }
  const keypair = solanaKeypairFor(user);
  const sig = await transferSolanaToken(keypair, mint, destination, raw, decimals, held.programId || info?.tokenProgram || '', raw === held.raw);

  // Keep the bot's position in step with the wallet.
  const positions = await getOpenPositions(user.id).catch(() => []);
  const pos = positions.find((p) => p.token_address === mint && p.chain === 'solana');
  if (pos) {
    const remaining = held.raw - raw;
    await updatePosition(remaining <= 0n
      ? { position_id: pos.id, status: 'closed', closed_at: new Date(), quantity_held: '0' }
      : { position_id: pos.id, quantity_held: remaining.toString() }).catch(() => {});
  }
  balanceCache.delete(telegramId);
  return {
    txHash: sig,
    amountWithdrawn: (Number(raw) / Math.pow(10, decimals)).toFixed(4),
    symbol: info?.symbol || 'TOKEN',
    tokenAddress: mint,
    destination,
  };
}

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
 * Withdraw native STRK, ETH, or any ERC-20 token on Starknet.
 * Automatically deploys the OpenZeppelin account contract if not yet deployed on-chain,
 * validates destination felt252 address, deducts gas reserve for native STRK/ETH,
 * signs and executes the ERC-20 transfer, and invalidates balance caches.
 */
export async function withdrawStarknetFunds(
  telegramId: number,
  destination: string,
  amount?: number | 'all',
  tokenAddressInput: string = STRK_TOKEN_ADDRESS
): Promise<{
  txHash: string;
  amountWithdrawn: string;
  symbol: string;
  destination: string;
  tokenAddress: string;
}> {
  const user = await getUserByTelegramId(telegramId);
  if (!user || !user.starknet_address || !user.starknet_private_key_enc) {
    throw new Error('Starknet wallet not configured. Please initialize your wallet via /start.');
  }

  destination = destination.trim();
  if (!isValidStarknetAddress(destination)) {
    throw new Error('Invalid destination Starknet address. Must be a valid 0x... hex address.');
  }
  if (isSameStarknetAddress(destination, user.starknet_address)) {
    throw new Error('Cannot withdraw to your own wallet address.');
  }

  const rawToken = tokenAddressInput.trim().toLowerCase();
  const isStrk = rawToken === 'strk' || isSameStarknetAddress(rawToken, STRK_TOKEN_ADDRESS);
  const isEth = rawToken === 'eth' || isSameStarknetAddress(rawToken, ETH_TOKEN_ADDRESS);
  const canonicalToken = isStrk ? STRK_TOKEN_ADDRESS : (isEth ? ETH_TOKEN_ADDRESS : tokenAddressInput.trim());

  const metadata = await getStarknetTokenMetadata(canonicalToken);
  const decimals = metadata.decimals ?? 18;
  const symbol = metadata.symbol || (isStrk ? 'STRK' : (isEth ? 'ETH' : 'TOKEN'));

  const provider = getStarknetProvider();
  const privateKeySecret = decrypt(user.starknet_private_key_enc, MASTER_KEY);
  const publicKey = ec.starkCurve.getStarkKey(privateKeySecret);
  const canonicalAddress = computeStarknetAccountAddress(publicKey);

  let activeUserAddress = user.starknet_address;
  if (!isSameStarknetAddress(canonicalAddress, activeUserAddress)) {
    console.log(`[STARKNET_WITHDRAW] Auto-migrating user ${user.id} to canonical deployable address ${canonicalAddress}`);
    await updateUserStarknetWallet(user.id, canonicalAddress, user.starknet_private_key_enc);
    activeUserAddress = canonicalAddress;
  }

  const activeAccount = getStarknetAccount(privateKeySecret, activeUserAddress, provider);

  // Check if account is deployed on-chain; auto-deploy if needed
  let isDeployed = false;
  try {
    const classHash = await provider.getClassHashAt(activeUserAddress);
    if (classHash) isDeployed = true;
  } catch {
    isDeployed = false;
  }

  if (!isDeployed) {
    console.log(`[STARKNET_WITHDRAW] Account ${activeUserAddress} is undeployed on-chain. Auto-deploying OpenZeppelin Account contract...`);
    const deployRes = await activeAccount.deployAccount({
      classHash: OZ_ACCOUNT_CLASS_HASH,
      constructorCalldata: CallData.compile({ publicKey }),
      addressSalt: publicKey,
    });
    await provider.waitForTransaction(deployRes.transaction_hash, { retryInterval: 1500 });
    console.log(`[STARKNET_WITHDRAW] Account ${activeUserAddress} successfully deployed!`);
  }

  // Check token balance
  const currentBal = await getStarknetTokenBalance(activeUserAddress, canonicalToken);
  if (currentBal <= 0n) {
    throw new Error(`You have 0 ${symbol} in your Starknet wallet.`);
  }

  // Reserve gas fee if withdrawing native STRK
  const gasReserve = isStrk ? 50_000_000_000_000_000n : 0n; // 0.05 STRK
  let rawWithdrawAmount: bigint;

  if (!amount || amount === 'all') {
    if (isStrk) {
      if (currentBal <= gasReserve) {
        throw new Error(`Insufficient STRK balance to withdraw. At least 0.05 STRK must remain for transaction gas.`);
      }
      rawWithdrawAmount = currentBal - gasReserve;
    } else {
      rawWithdrawAmount = currentBal;
    }
  } else {
    rawWithdrawAmount = BigInt(Math.floor(amount * Math.pow(10, decimals)));
    if (isStrk && rawWithdrawAmount + gasReserve > currentBal) {
      const maxWithdrawable = (Number(currentBal - gasReserve) / 1e18).toFixed(4);
      throw new Error(`Amount exceeds maximum withdrawable balance (${maxWithdrawable} STRK after gas reserve).`);
    } else if (!isStrk && rawWithdrawAmount > currentBal) {
      const maxWithdrawable = (Number(currentBal) / Math.pow(10, decimals)).toFixed(4);
      throw new Error(`Amount exceeds available balance (${maxWithdrawable} ${symbol}).`);
    }
  }

  if (rawWithdrawAmount <= 0n) {
    throw new Error('Withdrawal amount must be greater than 0.');
  }

  // Execute transfer
  console.log(`[STARKNET_WITHDRAW] Transferring ${rawWithdrawAmount} units of ${symbol} from ${activeUserAddress} to ${destination}...`);
  const transferCall = {
    contractAddress: canonicalToken,
    entrypoint: 'transfer',
    calldata: CallData.compile({
      recipient: destination,
      amount: cairo.uint256(rawWithdrawAmount),
    }),
  };

  const txRes = await activeAccount.execute([transferCall]);
  await provider.waitForTransaction(txRes.transaction_hash, { retryInterval: 1500 }).catch((e) => {
    console.warn(`[STARKNET_WITHDRAW] waitForTransaction non-fatal warning:`, e?.message);
  });

  // Evict balance cache
  invalidateStarknetBalanceCache(activeUserAddress);
  invalidateStarknetBalanceCache(canonicalToken);
  balanceCache.delete(telegramId);
  tradeBalanceCache.delete(telegramId);

  const formattedWithdrawn = formatTokenBalance(rawWithdrawAmount, decimals);
  return {
    txHash: txRes.transaction_hash,
    amountWithdrawn: formattedWithdrawn,
    symbol,
    destination,
    tokenAddress: canonicalToken,
  };
}

/**
 * Withdraw / send NEP-141 or SUI token from user's wallet to an external destination address.
 * Automatically checks recipient storage registration (for NEAR NEP-141) and registers them if needed,
 * validates user balance, converts human amounts according to token decimals, and updates position quantities.
 */
export async function withdrawTokenFunds(
  telegramId: number,
  tokenInput: string,
  destination: string,
  amount?: number | 'all' | string
): Promise<{
  txHash: string;
  amountWithdrawn: string;
  symbol: string;
  tokenAddress: string;
  destination: string;
  chain: 'near' | 'sui' | 'starknet' | 'solana';
}> {
  const user = await getUserByTelegramId(telegramId);
  if (!user) {
    throw new Error('User not found. Run /start first.');
  }

  destination = destination.trim();
  if (!destination) {
    throw new Error('Invalid destination account address.');
  }

  const rawToken = tokenInput.trim();
  if (!rawToken) {
    throw new Error('Token contract or symbol is required.');
  }

  // 1. Resolve token address from holdings or input
  const openPositions = await getOpenPositions(user.id).catch(() => []);
  let resolvedAddress = rawToken;

  // Check if rawToken matches any user position by token_address, symbol, or shortKey
  const matchingPos = openPositions.find((p) => {
    if (p.token_address.toLowerCase() === rawToken.toLowerCase()) return true;
    const short = getShortTokenKey(p.token_address);
    if (short.toLowerCase() === rawToken.toLowerCase()) return true;
    return false;
  });

  if (matchingPos) {
    resolvedAddress = matchingPos.token_address;
  } else {
    // Check ticker resolution
    const resolvedFromKey = resolveTokenAddressFromKey(rawToken);
    if (resolvedFromKey) {
      resolvedAddress = resolvedFromKey;
    }
  }

  // Solana token (SPL / Token-2022) withdrawals
  if (matchingPos?.chain === 'solana' || isSolanaToken(resolvedAddress)) {
    const res = await withdrawSolanaTokenFunds(telegramId, resolvedAddress, destination, amount);
    return { ...res, chain: 'solana' };
  }

  const isSuiDest = isValidSuiAddress(destination) && !destination.endsWith('.near');
  const isSuiTok = isSuiToken(resolvedAddress);

  // Check Starknet
  const isStarknetDest = isValidStarknetAddress(destination) && !destination.endsWith('.near');
  const isStarknetTok =
    matchingPos?.chain === 'starknet' ||
    resolvedAddress.toLowerCase() === 'strk' ||
    resolvedAddress.toLowerCase() === 'eth' ||
    isSameStarknetAddress(resolvedAddress, STRK_TOKEN_ADDRESS) ||
    isSameStarknetAddress(resolvedAddress, ETH_TOKEN_ADDRESS) ||
    (resolvedAddress.startsWith('0x') && !resolvedAddress.includes('::') && !isSuiTok);

  if (isStarknetTok || (isStarknetDest && !isSuiTok && !isSuiDest)) {
    const starknetRes = await withdrawStarknetFunds(
      telegramId,
      destination,
      amount as any,
      resolvedAddress
    );
    return {
      txHash: starknetRes.txHash,
      amountWithdrawn: starknetRes.amountWithdrawn,
      symbol: starknetRes.symbol,
      tokenAddress: starknetRes.tokenAddress,
      destination: starknetRes.destination,
      chain: 'starknet',
    };
  }

  if (isSuiDest || isSuiTok) {
    // ── SUI Token Withdrawal ────────────────────────────────────────────────
    if (!user.sui_address || !user.sui_private_key_enc) {
      throw new Error('SUI wallet not configured. Please initialize your wallet via /start.');
    }
    if (!isValidSuiAddress(destination)) {
      throw new Error('Invalid destination SUI address. Must be a valid 0x... hex address.');
    }
    if (destination.toLowerCase() === user.sui_address.toLowerCase()) {
      throw new Error('Cannot withdraw to your own wallet address.');
    }

    const keypair = restoreSuiKeypair(user.sui_private_key_enc, MASTER_KEY);
    const [tokenBal, meta] = await Promise.all([
      getSuiTokenBalance(user.sui_address, resolvedAddress),
      getSuiTokenMetadata(resolvedAddress).catch(() => ({ name: 'Token', symbol: 'TOKEN', decimals: 6 })),
    ]);

    if (!tokenBal || tokenBal.raw <= 0n || tokenBal.coinObjectIds.length === 0) {
      throw new Error(`You have 0 ${meta.symbol} in your SUI wallet.`);
    }

    let withdrawRaw: bigint;
    if (!amount || amount === 'all') {
      withdrawRaw = tokenBal.raw;
    } else {
      withdrawRaw = parseTokenUnits(String(amount), meta.decimals);
      if (withdrawRaw > tokenBal.raw) {
        throw new Error(`Amount exceeds your balance (${tokenBal.formatted} ${meta.symbol}).`);
      }
    }

    if (withdrawRaw <= 0n) {
      throw new Error('Withdrawal amount must be greater than 0.');
    }

    const tx = new Transaction();
    tx.setSender(user.sui_address);
    let primaryCoin = tx.object(tokenBal.coinObjectIds[0]);
    if (tokenBal.coinObjectIds.length > 1) {
      tx.mergeCoins(primaryCoin, tokenBal.coinObjectIds.slice(1).map((id) => tx.object(id)));
    }
    const [coinToSend] = tx.splitCoins(primaryCoin, [tx.pure.u64(withdrawRaw.toString())]);
    tx.transferObjects([coinToSend], destination);

    const res = await executeSuiTransaction(tx, keypair);
    if (res.status !== 'success') {
      throw new Error(`SUI token transfer failed: ${res.errorMessage || 'Transaction execution rejected'}`);
    }

    // Invalidate caches & update position
    balanceCache.delete(telegramId);
    tradeBalanceCache.delete(telegramId);
    suiTradeBalanceCache.delete(telegramId);

    const pos = openPositions.find((p) => p.token_address === resolvedAddress);
    if (pos) {
      const remaining = tokenBal.raw - withdrawRaw;
      if (remaining <= 0n) {
        await updatePosition({ position_id: pos.id, status: 'closed', closed_at: new Date(), quantity_held: '0' });
      } else {
        await updatePosition({ position_id: pos.id, quantity_held: remaining.toString() });
      }
    }

    const formattedWithdrawn = formatTokenUnits(withdrawRaw, meta.decimals);
    return {
      txHash: res.digest,
      amountWithdrawn: formattedWithdrawn,
      symbol: meta.symbol,
      tokenAddress: resolvedAddress,
      destination,
      chain: 'sui',
    };
  }

  // ── NEAR NEP-141 Token Withdrawal ─────────────────────────────────────────
  if (!isValidNearAccountId(destination)) {
    throw new Error('Invalid destination NEAR account address.');
  }
  if (destination === user.subaccount_id) {
    throw new Error('Cannot withdraw to your own wallet address.');
  }

  // Fetch token metadata
  const metadata = await near.getTokenMetadata(resolvedAddress).catch(() => null);
  if (!metadata || metadata.decimals === undefined) {
    throw new Error(`Could not find NEP-141 metadata for "${resolvedAddress}". Verify the token address.`);
  }

  const decimals = metadata.decimals ?? 18;
  const symbol = metadata.symbol || resolvedAddress.split('.')[0].toUpperCase();

  // Fetch user's token balance
  const balanceRaw = await near.getTokenBalance(resolvedAddress, user.subaccount_id).catch(() => '0');
  const rawBalBig = BigInt(balanceRaw || '0');
  if (rawBalBig <= 0n) {
    throw new Error(`You have 0 ${symbol} in your wallet.`);
  }

  let withdrawRaw: bigint;
  if (!amount || amount === 'all') {
    withdrawRaw = rawBalBig;
  } else {
    withdrawRaw = parseTokenUnits(String(amount), decimals);
    if (withdrawRaw > rawBalBig) {
      const humanHeld = formatTokenUnits(rawBalBig, decimals);
      throw new Error(`Amount exceeds your balance (${humanHeld} ${symbol}).`);
    }
  }

  if (withdrawRaw <= 0n) {
    throw new Error('Withdrawal amount must be greater than 0.');
  }

  // Storage registration check for recipient
  let needsRegistration = false;
  let minDeposit = BigInt('1250000000000000000000'); // 0.00125 NEAR
  try {
    const isRegistered = await near.checkStorageRegistered(destination, resolvedAddress);
    if (!isRegistered) {
      const bounds = await near.view<any>(resolvedAddress, 'storage_balance_bounds', {}).catch(() => null);
      if (bounds?.min) {
        minDeposit = BigInt(bounds.min);
      }
      needsRegistration = true;
    }
  } catch {
    // If view fails or contract doesn't support storage_balance_of, proceed with direct ft_transfer
  }

  // Pre-flight check: ensure user has enough native NEAR for gas and storage deposit
  const userNearYocto = BigInt(await near.getNearBalance(user.subaccount_id).catch(() => '0'));
  const gasReserveYocto = BigInt('15000000000000000000000'); // 0.015 NEAR gas
  const totalNeededNearYocto = (needsRegistration ? minDeposit : 0n) + gasReserveYocto;
  if (userNearYocto < totalNeededNearYocto) {
    if (needsRegistration) {
      const neededFormatted = (Number(minDeposit / 1000000000000000000n) / 1e6).toFixed(4);
      throw new Error(`Recipient is not registered for ${symbol}. Your wallet needs ~${neededFormatted} NEAR to cover recipient storage deposit.`);
    } else {
      throw new Error('Insufficient NEAR balance for transaction gas (~0.015 NEAR needed).');
    }
  }

  const actions: any[] = [];
  if (needsRegistration) {
    actions.push(
      transactions.functionCall(
        'storage_deposit',
        { account_id: destination, registration_only: true },
        BigInt('30000000000000'), // 30 Tgas
        minDeposit
      )
    );
  }
  actions.push(
    transactions.functionCall(
      'ft_transfer',
      {
        receiver_id: destination,
        amount: withdrawRaw.toString(),
        memo: 'Sent via RacerBot',
      },
      BigInt('50000000000000'), // 50 Tgas
      BigInt('1') // 1 yoctoNEAR attached deposit required by NEP-141
    )
  );

  const privateKey = decrypt(user.scoped_key_encrypted, MASTER_KEY);
  const keyPair = KeyPair.fromString(privateKey as any);

  const res = await connectWithNearRpcFailover(user.subaccount_id, keyPair, async (account) => {
    return await account.signAndSendTransaction({
      receiverId: resolvedAddress,
      actions,
    });
  });

  if (res?.status && typeof res.status === 'object' && 'Failure' in res.status) {
    throw new Error(`Token transfer failed on-chain: ${JSON.stringify(res.status.Failure)}`);
  }

  // Cache invalidation & position update
  invalidateBalanceCache(telegramId);
  const pos = openPositions.find((p) => p.token_address === resolvedAddress);
  if (pos) {
    const remaining = rawBalBig - withdrawRaw;
    if (remaining <= 0n) {
      await updatePosition({
        position_id: pos.id,
        status: 'closed',
        closed_at: new Date(),
        quantity_held: '0',
      });
    } else {
      await updatePosition({
        position_id: pos.id,
        quantity_held: remaining.toString(),
      });
    }
  }

  const formattedWithdrawn = formatTokenUnits(withdrawRaw, decimals);
  return {
    txHash: res.transaction.hash,
    amountWithdrawn: formattedWithdrawn,
    symbol,
    tokenAddress: resolvedAddress,
    destination,
    chain: 'near',
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

  const res = await connectWithNearRpcFailover(TREASURY_ACCOUNT_ID, keyPair, async (account) => {
    const yocto = BigInt(nearUtils.format.parseNearAmount(amountNear.toFixed(8))!);
    return await account.sendMoney(destinationSubaccount, yocto);
  });

  return { txHash: res.transaction.hash };
}

/**
 * Detects on-chain FT holdings for a user's wallet subaccount across indexers (FastNEAR & NearBlocks)
 * and RPC. Catches all tokens inside the wallet, creates or updates positions, and initializes the
 * entry price baseline for PNL calculation from the point of discovery.
 */
export async function syncUserTokenDeposits(userId: string, subaccountId: string, forceRefresh = false): Promise<number> {
  const lastSync = lastSyncDepositsMap.get(userId);
  if (!forceRefresh && lastSync && Date.now() - lastSync < 10_000) {
    return 0;
  }
  lastSyncDepositsMap.set(userId, Date.now());

  let newDepositsCount = 0;
  try {
    const discoveredTokens = new Set<string>();
    const indexerBalances = new Map<string, string>();
    const indexerTimeoutMs = forceRefresh ? 2000 : 3500;

    // 1. Fetch FT holdings across FastNEAR and NearBlocks in parallel
    const fastnearPromise = (async () => {
      try {
        const cacheKey = subaccountId;
        let data: any = null;
        if (!forceRefresh) {
          const cached = fastnearFtCache.get(cacheKey);
          if (cached && Date.now() - cached.at < 30_000) {
            data = cached.data;
          }
        }
        if (!data) {
          let reqPromise = inflightFastnearFt.get(cacheKey);
          if (!reqPromise) {
            reqPromise = (async () => {
              const controller = new AbortController();
              const timeout = setTimeout(() => controller.abort(), indexerTimeoutMs);
              const apiKey = fastnearApiKey;
              const url = `https://api.fastnear.com/v1/account/${subaccountId}/ft${apiKey ? `?api_key=${apiKey}` : ''}`;
              const res = await fetch(url, { signal: controller.signal });
              clearTimeout(timeout);
              if (res.ok) {
                const parsed = (await res.json()) as any;
                fastnearFtCache.set(cacheKey, { at: Date.now(), data: parsed });
                return parsed;
              }
              return null;
            })().finally(() => inflightFastnearFt.delete(cacheKey));
            inflightFastnearFt.set(cacheKey, reqPromise);
          }
          data = await reqPromise;
        }

        if (data) {
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
        const timeout = setTimeout(() => controller.abort(), indexerTimeoutMs);
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
    discoveredTokens.delete('aurora');

    const existingTokens = Array.from(posMap.keys());
    const newDiscovered = Array.from(discoveredTokens).filter(t => !posMap.has(t));
    // Prioritize newly discovered tokens with non-zero indexer balances, limit to 20 to avoid RPC saturation
    const topNewDiscovered = newDiscovered
      .filter(t => {
        const bal = indexerBalances.get(t);
        return bal && bal !== '0';
      })
      .slice(0, 20);

    const allTokensToCheck = Array.from(new Set([...existingTokens, ...topNewDiscovered]));
    const near = getNear();

    // 3. Fetch NEAR token balances and metadata in batches of 8 to stay well under QuickNode rate limits
    if (allTokensToCheck.length > 0) {
      const allInfoMap = await getBatchTokenInfo(allTokensToCheck, false).catch(() => new Map());
      const balanceResults: PromiseSettledResult<{ value: string; trusted: boolean }>[] = [];
      const infoResults: PromiseSettledResult<TokenInfoResult | null>[] = [];
      const BATCH_SIZE = 8;

      for (let i = 0; i < allTokensToCheck.length; i += BATCH_SIZE) {
        const batch = allTokensToCheck.slice(i, i + BATCH_SIZE);
        const batchBalances = await Promise.allSettled(
          batch.map(async (tokenAddress): Promise<{ value: string; trusted: boolean }> => {
            try {
              const value = await Promise.race([
                near.getTokenBalance(tokenAddress, subaccountId),
                new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2500)),
              ]);
              return { value: value || '0', trusted: true };
            } catch (err: any) {
              const msg = err?.message || '';
              if (msg.includes('not registered') || msg.includes('does not exist')) {
                return { value: '0', trusted: true };
              }
              const idx = indexerBalances.get(tokenAddress);
              return idx !== undefined ? { value: idx, trusted: false } : { value: '0', trusted: false };
            }
          })
        );
        const batchInfos: PromiseSettledResult<TokenInfoResult | null>[] = batch.map(t => ({
          status: 'fulfilled' as const,
          value: allInfoMap.get(t) || null,
        }));
        balanceResults.push(...batchBalances);
        infoResults.push(...batchInfos);
      }

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
        const currentPrice = info?.price && parseFloat(info.price) > 0 ? parseFloat(info.price) : 0;
        const nearUsdRate = info?.near_usd || 5.16;
        const valUsd = humanBalance * currentPrice * nearUsdRate;
        const isDustOrZero = rawBalBigInt === 0n || humanBalance < 0.000001 || (currentPrice > 0 && valUsd < 0.01 && humanBalance < 1);

        const existing = posMap.get(tokenAddress);

        if (existing) {
          if (!bal.trusted) {
            console.warn(`[DEPOSIT] Skipped reconcile for ${tokenAddress} (user ${userId}): balance unverifiable`);
          } else if (isDustOrZero) {
            await updatePosition({
              position_id: existing.id,
              status: 'closed',
              closed_at: new Date(),
              quantity_held: '0',
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
                positionId: newPos.id,
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
                  positionId: newPos.id,
                }).catch(() => {});
              }
            }
          }
        }
      } catch (suiErr: any) {
        console.warn(`[DEPOSIT] Sui syncUserTokenDeposits error: ${suiErr?.message}`);
      }
    }

    // ── 4b. Reconcile Solana Token Holdings & Discover External Deposits ──────
    // One Jupiter holdings call per sync (no RPC credits). Unknown mints are
    // looked up at most 10 per sync to stay inside the free API rate limit.
    if (user?.solana_address) {
      try {
        const solPositions = existingPositions.filter(p => p.chain === 'solana');
        const holdings = await getSolanaWalletHoldings(user.solana_address, forceRefresh);
        const solPosMap = new Map(solPositions.map(p => [p.token_address, p]));

        // Existing positions: follow the wallet (sold or sent out elsewhere -> close).
        for (const pos of solPositions) {
          const h = holdings.tokens.get(pos.token_address);
          if (!h || h.raw <= 0n) {
            // Indexers can lag behind a fresh buy: never close a young position, and
            // confirm the zero on-chain before closing anything.
            const openedAt = pos.opened_at ? new Date(pos.opened_at).getTime() : 0;
            if (Date.now() - openedAt < 10 * 60_000) continue;
            const onChain = await getSolanaTokenBalanceOnChain(user.solana_address, pos.token_address);
            if (onChain === null) continue;
            if (onChain > 0n) {
              if (pos.quantity_held !== onChain.toString()) {
                await updatePosition({ position_id: pos.id, quantity_held: onChain.toString() }).catch(() => {});
              }
              continue;
            }
            await updatePosition({ position_id: pos.id, status: 'closed', closed_at: new Date(), quantity_held: '0' }).catch(() => {});
            console.log(`[DEPOSIT] Closed Solana position ${pos.token_address} (user ${userId}): balance is 0`);
          } else if (pos.quantity_held !== h.raw.toString()) {
            await updatePosition({ position_id: pos.id, quantity_held: h.raw.toString() }).catch(() => {});
          }
        }

        // New tokens that arrived from outside the bot.
        const newMints = [...holdings.tokens.values()]
          .filter(h => h.raw > 0n && !solPosMap.has(h.mint) && h.mint !== 'So11111111111111111111111111111111111111112')
          .slice(0, 10);
        if (newMints.length > 0) {
          const db = await getDb();
          for (const h of newMints) {
            const recentClosed = await db.query(
              `SELECT 1 FROM positions WHERE user_id = $1 AND token_address = $2 AND status = 'closed' AND closed_at > NOW() - INTERVAL '15 minutes' LIMIT 1`,
              [userId, h.mint]
            ).catch(() => null);
            if (recentClosed?.rows?.length) continue;

            const info = await getSolanaTokenInfo(h.mint).catch(() => null);
            if (!info) continue; // unknown / spam mint with no market: do not add to bags
            const valueUsd = h.uiAmount * info.priceUsd;
            if (info.priceUsd > 0 && valueUsd < 0.01) continue; // dust / spam airdrops

            const newPos = await createPosition({
              user_id: userId,
              chain: 'solana',
              token_address: h.mint,
              quantity_held: h.raw.toString(),
              avg_entry_price: info.priceSol > 0 ? info.priceSol.toString() : '0',
            });
            await db.query(
              'UPDATE positions SET is_external_deposit = TRUE, external_deposit_detected_at = NOW() WHERE id = $1',
              [newPos.id]
            ).catch(() => {});
            newDepositsCount++;
            if (user.telegram_id) {
              notifyTokenDeposit(user.telegram_id, {
                tokenSymbol: info.symbol || 'TOKEN',
                tokenName: info.name || undefined,
                amountFormatted: h.uiAmount >= 1_000_000 ? `${(h.uiAmount / 1_000_000).toFixed(2)}M` : h.uiAmount.toLocaleString('en-US', { maximumFractionDigits: 4 }),
                address: user.solana_address,
                chain: 'solana',
                positionId: newPos.id,
              }).catch(() => {});
            }
          }
        }
      } catch (solErr: any) {
        console.warn(`[DEPOSIT] Solana syncUserTokenDeposits error: ${solErr?.message}`);
      }
    }

    // ── 5. Reconcile Starknet Token Holdings ──────────────────────────────────
    if (user?.starknet_address) {
      try {
        const starknetPositions = existingPositions.filter(p => p.chain === 'starknet' || isStarknetToken(p.token_address));
        for (const pos of starknetPositions) {
          try {
            const bal = await getStarknetTokenBalance(user.starknet_address, pos.token_address);
            if (bal > 0n && bal.toString() !== pos.quantity_held) {
              await updatePosition({
                position_id: pos.id,
                quantity_held: bal.toString(),
              });
            }
          } catch {
            // Ignore temporary RPC error
          }
        }
      } catch (starkErr: any) {
        console.warn(`[DEPOSIT] Starknet syncUserTokenDeposits error: ${starkErr?.message}`);
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

  // 1. Try FastNEAR public key API (cached 60s with single-flight coalescing)
  try {
    const cacheKey = publicKey;
    let accList: string[] | null = null;
    const cached = fastnearPkCache.get(cacheKey);
    if (cached && Date.now() - cached.at < 60_000) {
      accList = cached.data;
    }
    if (!accList) {
      let reqPromise = inflightFastnearPk.get(cacheKey);
      if (!reqPromise) {
        reqPromise = (async () => {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 4000);
          const apiKey = fastnearApiKey;
          const url = `https://api.fastnear.com/v1/public_key/${encodeURIComponent(publicKey)}${apiKey ? `?api_key=${apiKey}` : ''}`;
          const res = await fetch(url, { signal: controller.signal });
          clearTimeout(timeout);
          if (res.ok) {
            const data = (await res.json()) as any;
            if (Array.isArray(data.account_ids)) {
              const accs = data.account_ids
                .filter((acc: any) => typeof acc === 'string' && acc.trim())
                .map((acc: string) => acc.trim().toLowerCase());
              fastnearPkCache.set(cacheKey, { at: Date.now(), data: accs });
              return accs;
            }
          }
          return [];
        })().finally(() => inflightFastnearPk.delete(cacheKey));
        inflightFastnearPk.set(cacheKey, reqPromise);
      }
      accList = await reqPromise;
    }
    if (accList && accList.length > 0) {
      for (const a of accList) accounts.add(a);
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

  // 3. If no named accounts were found, add implicit account (64 hex characters)
  if (accounts.size === 0) {
    try {
      const rawHex = nearUtils.PublicKey.fromString(publicKey).data;
      const implicitAccount = Buffer.from(rawHex).toString('hex').toLowerCase();
      accounts.add(implicitAccount);
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
    const rawHex = nearUtils.PublicKey.fromString(publicKey).data;
    const implicitAccount = Buffer.from(rawHex).toString('hex').toLowerCase();
    if (accountId.toLowerCase() === implicitAccount) {
      // By NEAR protocol definition, the private key of an implicit account is always the FullAccess owner
      return { exists: true, isFullAccess: true };
    }
  } catch {
    // continue
  }

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
  targetAccountId?: string,
  setAsActive = true
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

  // 6. Encrypt key and insert
  const encryptedKey = encrypt(normalizedPrivateKey, MASTER_KEY);

  const wallet = await createUserWallet({
    userId: user.id,
    chain: 'near',
    address: accountId,
    name: cleanName,
    encryptedPrivateKey: encryptedKey,
    isImported: true,
    isActive: setAsActive,
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
  walletName: string,
  setAsActive = true
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

  // 4. Create in DB
  const wallet = await createUserWallet({
    userId: user.id,
    chain: 'sui',
    address,
    name: cleanName,
    encryptedPrivateKey: encryptedKey,
    isImported: true,
    isActive: setAsActive,
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

export async function listUserStarknetWallets(telegramId: number): Promise<UserWalletRecord[]> {
  const user = await getUserByTelegramId(telegramId);
  if (!user) throw new Error('User not found. Run /start first.');
  return getUserWallets(user.id, 'starknet');
}

export async function switchActiveStarknetWallet(telegramId: number, walletId: string): Promise<UserWalletRecord> {
  const user = await getUserByTelegramId(telegramId);
  if (!user) throw new Error('User not found. Run /start first.');
  const wallet = await setActiveWallet(user.id, 'starknet', walletId);
  balanceCache.delete(telegramId);
  if (wallet.address) {
    invalidateStarknetBalanceCache(wallet.address);
  }
  return wallet;
}

export async function renameUserStarknetWallet(telegramId: number, walletId: string, newName: string): Promise<UserWalletRecord> {
  const user = await getUserByTelegramId(telegramId);
  if (!user) throw new Error('User not found. Run /start first.');
  const trimmed = newName.trim();
  if (!trimmed || trimmed.length > 30) {
    throw new Error('Wallet name must be between 1 and 30 characters.');
  }
  return renameUserWallet(user.id, walletId, trimmed);
}
