import { AsyncLocalStorage } from 'node:async_hooks';
import { connect, keyStores, Near, Account, KeyPair, utils, transactions } from 'near-api-js';
import { markProviderError, markProviderSuccess, createProvider, isProviderAvailable, RPCProvider } from './rpc.js';
import { calculateExpectedOutput, calculateMinAmountOut, parseMemeCookingId } from './utils.js';
import { upsertTokenCache, getTokenCache } from '@racerbot/db';
import { redactSecrets, TradeError } from './errors.js';

export interface NearConfig {
  rpcUrls: string[];
  networkId?: string;
}

export interface TokenMetadata {
  name: string;
  symbol: string;
  decimals: number;
  total_supply: string;
  icon?: string;
}

export interface PoolReserves {
  token_in: string;
  token_out: string;
  reserve_in: string;
  reserve_out: string;
  total_fee: number;
}

const rheaPoolIdCache = new Map<string, number>();

// NearlyTrade launch record + token metadata + total supply cache (60s TTL).
// Static per token; the DCL pool view inside getNearlytradeTokenState stays fresh.
const ntStaticCache = new Map<string, { at: number; launch: any; meta: any; supply: string }>();
const ntRouteCache = new Map<string, { at: number; route: any }>();
// ShoreMarkets launch record + token metadata + total supply cache (60s TTL).
const smStaticCache = new Map<string, { at: number; launch: any; meta: any; supply: string }>();
const intearPoolCache = new Map<string, number>();
const dclPoolIdCache = new Map<string, string>();
const noDclPoolCache = new Map<string, number>();
const noRheaPoolPairCache = new Map<string, number>();
const registeredCache = new Set<string>();
export const intearRegisteredCache = new Set<string>();
const noRheaPoolCache = new Map<string, number>();
// Permanent cache for quote-asset decimals (decimals never change after launch).
const quoteDecimalsCache = new Map<string, number>();
const quoteSymbolCache = new Map<string, string>();
// 10-second cache for the NEAR-denominated price of a quote asset.
const quoteNearPriceCache = new Map<string, { at: number; rate: number }>();
const QUOTE_NEAR_PRICE_TTL_MS = 10_000;

let cachedRefPools: { fromIndex: number; pools: any[] }[] | null = null;
let lastRefPoolsFetch = 0;
let fetchRefPoolsInFlight: Promise<{ fromIndex: number; pools: any[] }[]> | null = null;

async function getAllRefPoolsOnChain(near: MultiRpcNear): Promise<{ fromIndex: number; pools: any[] }[]> {
  const now = Date.now();
  const CACHE_TTL_MS = 900_000; // 15 minutes TTL

  if (cachedRefPools && now - lastRefPoolsFetch < CACHE_TTL_MS) {
    return cachedRefPools;
  }

  // Stale-while-revalidate: if we already have pools, return them immediately
  // and trigger the refresh in the background without blocking the bot user request!
  if (cachedRefPools && cachedRefPools.length > 0) {
    if (!fetchRefPoolsInFlight) {
      // Trigger background refresh detached
      getAllRefPoolsOnChainBackground(near).catch(() => {});
    }
    return cachedRefPools;
  }

  if (fetchRefPoolsInFlight) {
    return fetchRefPoolsInFlight;
  }

  return getAllRefPoolsOnChainBackground(near);
}

async function getAllRefPoolsOnChainBackground(near: MultiRpcNear): Promise<{ fromIndex: number; pools: any[] }[]> {
  if (fetchRefPoolsInFlight) return fetchRefPoolsInFlight;

  fetchRefPoolsInFlight = (async () => {
    try {
      const numPools = await withTimeout(
        near.view<number>('v2.ref-finance.near', 'get_number_of_pools', {}).catch(() => 0),
        3000,
        'get_number_of_pools timeout'
      ).catch(() => 0);
      if (!numPools || numPools <= 0) return cachedRefPools || [];

      const batchSize = 250;
      const maxBatches = 2; // Check up to 500 most recently created pools only (new tokens are at the end)
      const starts: number[] = [];
      for (let s = Math.max(0, numPools - batchSize); s >= 0 && starts.length < maxBatches; s -= batchSize) {
        starts.push(s);
      }

      console.log(`[findRheaPoolForToken] Refreshing latest on-chain pools (${starts.length * batchSize} of ${numPools}, cached 5m)...`);
      const results: { fromIndex: number; pools: any[] }[] = [];
      const batchResults = await Promise.allSettled(
        starts.map(async (fromIndex) => {
          const pools = await withTimeout(
            near.view<any[]>('v2.ref-finance.near', 'get_pools', { from_index: fromIndex, limit: batchSize }),
            3500,
            'get_pools timeout'
          );
          return { fromIndex, pools: pools || [] };
        })
      );
      for (const r of batchResults) {
        if (r.status === 'fulfilled') {
          results.push(r.value);
        }
      }

      cachedRefPools = results;
      lastRefPoolsFetch = Date.now();
      return results;
    } catch (err: any) {
      console.warn('[findRheaPoolForToken] Failed to refresh on-chain pool cache:', err?.message || err);
      return cachedRefPools || [];
    } finally {
      fetchRefPoolsInFlight = null;
    }
  })();

  return fetchRefPoolsInFlight;
}

let lastIndexerFetch = 0;
let indexerPoolsCache: any[] = [];

export async function getRefIndexerPools(): Promise<any[]> {
  const now = Date.now();
  if (indexerPoolsCache.length > 0 && now - lastIndexerFetch < 300_000) {
    return indexerPoolsCache;
  }
  try {
    const res = await fetch('https://indexer.ref.finance/list-top-pools', {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        indexerPoolsCache = data;
        lastIndexerFetch = now;
        return data;
      }
    }
  } catch {
    // Fall back to existing cache or empty array
  }
  return indexerPoolsCache;
}

export function parseIntearPool(rawBytes: Buffer): {
  asset1: string;
  reserve1: string;
  asset2: string;
  reserve2: string;
  type?: 'public' | 'private' | 'launch';
  feeBps?: number;
} | null {
  if (!rawBytes || rawBytes.length < 5) return null;
  let offset = 0;
  // Byte 0: Option tag or pool envelope (usually 1)
  const tag0 = rawBytes[offset++];
  const poolVariant = rawBytes[offset++];

  function readString(): string {
    if (offset + 4 > rawBytes.length) return '';
    const len = rawBytes.readUInt32LE(offset);
    offset += 4;
    if (offset + len > rawBytes.length) return '';
    const s = rawBytes.toString('utf8', offset, offset + len);
    offset += len;
    return s;
  }

  function readAssetId(): string {
    if (offset >= rawBytes.length) return 'unknown';
    const t = rawBytes[offset++];
    if (t === 0) return 'near';
    if (t === 1) return readString();
    return 'unknown';
  }

  function readU128(): bigint {
    if (offset + 16 > rawBytes.length) return 0n;
    const s = rawBytes.subarray(offset, offset + 16);
    offset += 16;
    let v = 0n;
    for (let i = 0; i < 16; i++) v |= BigInt(s[i]) << BigInt(8 * i);
    return v;
  }

  if (poolVariant === 3) {
    // Launch pool V2 (INTEARnear LaunchV2):
    // asset1: AssetId, reserve1: u128, asset2: AssetId, reserve2: u128, fees
    const a1 = readAssetId();
    const r1 = readU128();
    const a2 = readAssetId();
    const r2 = readU128();

    let totalFeePpm = 0;
    if (offset + 4 <= rawBytes.length) {
      const numFees = rawBytes.readUInt32LE(offset);
      offset += 4;
      for (let i = 0; i < numFees && offset < rawBytes.length; i++) {
        const receiverType = rawBytes[offset++];
        if (receiverType === 0 || receiverType === 1 || receiverType === 2) {
          readString(); // AccountId
        }
        if (offset + 4 <= rawBytes.length) {
          const fee = rawBytes.readUInt32LE(offset);
          offset += 4;
          totalFeePpm += fee;
        }
      }
    }
    const feeBps = Math.round(totalFeePpm / 100);

    return {
      asset1: a1,
      reserve1: r1.toString(),
      asset2: a2,
      reserve2: r2.toString(),
      type: 'launch',
      feeBps: feeBps > 0 ? feeBps : 210,
    };
  } else if (poolVariant === 2) {
    // Launch pool (INTEARnear/launch LaunchV1):
    // near_amount: u128 (real deposited NEAR + phantom liquidity)
    // launched_asset: AssetId
    // balance: u128 (token balance)
    const reserveNear = readU128();
    const asset1 = 'near';
    const asset2 = readAssetId();
    const reserveToken = readU128();

    // Fees: Vec<(FeeReceiver, u32)>
    let totalFeePpm = 0;
    if (offset + 4 <= rawBytes.length) {
      const numFees = rawBytes.readUInt32LE(offset);
      offset += 4;
      for (let i = 0; i < numFees && offset < rawBytes.length; i++) {
        const receiverType = rawBytes[offset++];
        if (receiverType === 0 || receiverType === 1 || receiverType === 2) {
          readString(); // AccountId
        }
        if (offset + 4 <= rawBytes.length) {
          const fee = rawBytes.readUInt32LE(offset);
          offset += 4;
          totalFeePpm += fee;
        }
      }
    }
    const feeBps = Math.round(totalFeePpm / 100);

    return {
      asset1,
      reserve1: reserveNear.toString(),
      asset2,
      reserve2: reserveToken.toString(),
      type: 'launch',
      feeBps: feeBps > 0 ? feeBps : 110,
    };
  } else if (poolVariant === 0 || poolVariant === 1) {
    // Public (0) or Private (1) XYK pool
    const saveOffset = offset;
    const a1 = readAssetId();
    const r1 = readU128();
    const a2 = readAssetId();
    const r2 = readU128();

    if (a1 !== 'unknown' && a2 !== 'unknown') {
      return {
        asset1: a1,
        reserve1: r1.toString(),
        asset2: a2,
        reserve2: r2.toString(),
        type: poolVariant === 0 ? 'public' : 'private',
        feeBps: 30,
      };
    }

    offset = saveOffset;
    const altA1 = readAssetId();
    const altA2 = readAssetId();
    const altR1 = readU128();
    const altR2 = readU128();
    return {
      asset1: altA1,
      reserve1: altR1.toString(),
      asset2: altA2,
      reserve2: altR2.toString(),
      type: poolVariant === 0 ? 'public' : 'private',
      feeBps: 30,
    };
  }

  return null;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, errMsg: string): Promise<T> {
  let timeoutId: any;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(errMsg)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

/**
 * Multi-RPC NEAR connection.
 * Reads hedge across healthy providers (idempotent, safe to race).
 * Writes (BUY/SELL): signing reads (nonce, block hash) hedge across ALL trade
 * providers — chain-global values, safe to race; max nonce wins. Broadcast
 * fans out identical signed bytes to all trade providers (idempotent — NEAR
 * dedupes the same signed tx), confirmation polls across them too. The
 * per-account Redis lock + highestUsedNonce tracking keep nonce discipline,
 * so hedging never produces duplicate or conflicting transactions.
 */
const dclPathCache = new Map<string, { at: number; path: string[] | null }>();
const bestHopCache = new Map<string, { at: number; hop: { kind: 'dcl'; path: string[] } | { kind: 'v2'; poolId: number } | null }>();
const INTENTS_TOKENS_URL = 'https://1click.chaindefuser.com/v0/tokens';
const INTENTS_TOKENS_TTL_MS = 5 * 60_000;
let intentsTokens: { at: number; byContract: Map<string, { price: number; decimals: number }> } | null = null;

/** NEAR per token from NEAR Intents' token list (USD prices, refreshed every few minutes), or null */
async function getIntentsTokenNearRate(contract: string): Promise<{ rateInNear: number; decimals: number } | null> {
  if (!intentsTokens || Date.now() - intentsTokens.at > INTENTS_TOKENS_TTL_MS) {
    const res = await fetch(INTENTS_TOKENS_URL, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`NEAR Intents tokens returned ${res.status}`);
    const list = (await res.json()) as any[];
    const byContract = new Map<string, { price: number; decimals: number }>();
    for (const t of Array.isArray(list) ? list : []) {
      const id = String(t?.assetId || '');
      if (!id.startsWith('nep141:')) continue;
      const price = Number(t.price);
      if (price > 0) byContract.set(id.slice('nep141:'.length).toLowerCase(), { price, decimals: Number(t.decimals) || 18 });
    }
    intentsTokens = { at: Date.now(), byContract };
  }
  const token = intentsTokens.byContract.get(contract.toLowerCase());
  const near = intentsTokens.byContract.get('wrap.near');
  if (!token || !near || near.price <= 0) return null;
  return { rateInNear: token.price / near.price, decimals: token.decimals };
}

/**
 * Reads made while a trade runs (quotes, balances, registration checks) go to the premium FastNEAR RPC
 * first, with the free community nodes as the backup. Everything else keeps the free-first order, which
 * saves premium credits on the high-volume background reads (cards, price polling, holdings scans).
 */
const tradeReads = new AsyncLocalStorage<boolean>();
const isTradeRead = () => tradeReads.getStore() === true;

/** Whether the current call runs inside runAsTrade (its reads go premium-first) */
export const inTrade = isTradeRead;

/** Runs `fn` as a trade: every NEAR read it makes, however deep, uses the premium RPC first */
export function runAsTrade<T>(fn: () => Promise<T>): Promise<T> {
  return tradeReads.run(true, fn);
}

export class MultiRpcNear {
  private readProviders: RPCProvider[];
  private tradeProviders: RPCProvider[];
  private keyStore: keyStores.InMemoryKeyStore;
  private networkId: string;
  private connections: Map<string, Near> = new Map();
  private accountCache: Map<string, Account> = new Map();
  private highestUsedNonce: Map<string, bigint> = new Map();
  private nonceCacheRefreshInterval: NodeJS.Timeout | null = null;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private currentIndex = 0;
  // Coalescing: identical in-flight view calls share one request
  private inflightViews = new Map<string, Promise<any>>();
  // Short-TTL result cache for display-path reads only (see viewCached)
  private viewResultCache = new Map<string, { at: number; value: any }>();
  // Coalescing and short TTL cache for account NEAR balances to minimize paid RPC calls
  private inflightNearBalances = new Map<string, Promise<string>>();
  private nearBalanceCache = new Map<string, { at: number; value: string }>();

  constructor(rpcUrls: string[], networkId = 'mainnet') {
    const ACTIVE_PAID_FASTNEAR_KEY = ''; // keys come only from FASTNEAR_API_KEY
    const DEPRECATED_FASTNEAR_KEY = 'REDACTED';
    let rawApiKey = (process.env.FASTNEAR_API_KEY || '').trim();
    if (!rawApiKey || rawApiKey === DEPRECATED_FASTNEAR_KEY || rawApiKey.startsWith('TEMP') || rawApiKey.startsWith('change-me') || rawApiKey.startsWith('${')) {
      rawApiKey = ACTIVE_PAID_FASTNEAR_KEY;
    }
    const apiKey = rawApiKey;
    const hasValidKey = Boolean(apiKey);
    const rawQn = (process.env.QUICKNODE_ENDPOINT_URL || '').trim();
    const qnUrl = rawQn.startsWith('${') ? '' : rawQn;
    // A retired QuickNode endpoint that still appears in some deployed RPC_PROVIDERS lists
    const isBrokenDefaultQn = (u: string) => u.startsWith('https://blissful-capable-road.near-mainnet.quiknode.pro/');
    const initialUrls = [...rpcUrls].filter(u => u && !u.startsWith('${') && !isBrokenDefaultQn(u));
    if (qnUrl && !isBrokenDefaultQn(qnUrl) && !initialUrls.includes(qnUrl)) {
      initialUrls.push(qnUrl);
    }

    // Allow FastNEAR, community validator nodes (Shitzu, Intear), and QuickNode endpoints
    const allowedUrls = initialUrls.filter(url => {
      const isQn = (url.includes('quiknode.pro') || url.includes('quicknode')) && !isBrokenDefaultQn(url);
      const isFn = url.includes('fastnear.com');
      const isShitzu = url.includes('shitzuapes.xyz');
      const isIntear = url.includes('intea.rs');
      return isQn || isFn || isShitzu || isIntear;
    });

    const fallbackUrls = ['https://near.drpc.org', 'https://rpc.intea.rs', 'https://rpc.shitzuapes.xyz', 'https://free.rpc.fastnear.com', 'https://rpc.mainnet.fastnear.com'];
    const sanitizedUrls = allowedUrls.length > 0
      ? Array.from(new Set(allowedUrls))
      : fallbackUrls;

    const fastnearPaidEndpoint = hasValidKey
      ? `https://rpc.mainnet.fastnear.com?apiKey=${apiKey}`
      : 'https://rpc.mainnet.fastnear.com';

    const normalizedUrls = sanitizedUrls
      .filter(u => !u.includes('near.org'))
      .map(u => {
        if (u.includes('rpc.mainnet.fastnear.com') && hasValidKey && !u.includes('apiKey=')) {
          return fastnearPaidEndpoint;
        }
        return u;
      });

    // Read URLs: Free validator nodes first (zero credit consumption: Shitzu, Intear, Free FastNEAR),
    // then paid FastNEAR (primary dedicated RPC), QuickNode, and others
    const readUrls = Array.from(new Set([
      ...normalizedUrls.filter(u => u.includes('shitzuapes.xyz')),
      ...normalizedUrls.filter(u => u.includes('intea.rs')),
      ...normalizedUrls.filter(u => u.includes('free.rpc.fastnear.com')),
      ...normalizedUrls.filter(u => u.includes('fastnear.com') && !u.includes('free.rpc.fastnear.com')),
      ...normalizedUrls.filter(u => u.includes('quiknode.pro') || u.includes('quicknode')),
      ...normalizedUrls.filter(u => !u.includes('fastnear.com') && !u.includes('quicknode') && !u.includes('quiknode.pro') && !u.includes('shitzu') && !u.includes('intea')),
    ]));

    // Trade URLs: FastNEAR first (primary dedicated RPC), QuickNode, Shitzu, Intear, Free FastNEAR
    const tradeUrls = Array.from(new Set([
      ...normalizedUrls.filter(u => u.includes('fastnear.com') && !u.includes('free.rpc.fastnear.com')),
      ...normalizedUrls.filter(u => u.includes('quiknode.pro') || u.includes('quicknode')),
      ...normalizedUrls.filter(u => u.includes('shitzuapes.xyz')),
      ...normalizedUrls.filter(u => u.includes('intea.rs')),
      ...normalizedUrls.filter(u => u.includes('free.rpc.fastnear.com')),
      ...normalizedUrls.filter(u => !u.includes('near.org')),
    ]));
    if (tradeUrls.length === 0) {
      tradeUrls.push(...normalizedUrls);
    }

    this.readProviders = readUrls.map((rawUrl, i) => {
      const isQn = rawUrl.includes('quiknode.pro') || rawUrl.includes('quicknode');
      const isPaidFn = Boolean(rawUrl.includes('rpc.mainnet.fastnear.com') && hasValidKey);
      let url = rawUrl;
      if (isPaidFn && !url.includes('apiKey=')) {
        const sep = url.includes('?') ? '&' : '?';
        url = `${url}${sep}apiKey=${apiKey}`;
      }
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (isPaidFn) {
        headers['apiKey'] = apiKey;
        headers['Authorization'] = `Bearer ${apiKey}`;
      }
      const name = isQn
        ? `quicknode-read-${i}`
        : url.includes('shitzu')
        ? `shitzu-read-${i}`
        : url.includes('intea')
        ? `intear-read-${i}`
        : url.includes('near.org')
        ? `pagoda-read-${i}`
        : `fastnear-read-${i}`;
      return createProvider(url, name, isQn, headers, isPaidFn);
    });

    this.tradeProviders = tradeUrls.map((rawUrl, i) => {
      const isQn = rawUrl.includes('quiknode.pro') || rawUrl.includes('quicknode');
      const isPaidFn = Boolean(rawUrl.includes('rpc.mainnet.fastnear.com') && hasValidKey);
      let url = rawUrl;
      if (isPaidFn && !url.includes('apiKey=')) {
        const sep = url.includes('?') ? '&' : '?';
        url = `${url}${sep}apiKey=${apiKey}`;
      }
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (isPaidFn) {
        headers['apiKey'] = apiKey;
        headers['Authorization'] = `Bearer ${apiKey}`;
      }
      const name = isQn
        ? `quicknode-trade-${i}`
        : url.includes('shitzu')
        ? `shitzu-trade-${i}`
        : url.includes('intea')
        ? `intear-trade-${i}`
        : url.includes('near.org')
        ? `pagoda-trade-${i}`
        : `trade-rpc-${i}`;
      return createProvider(url, name, isQn, headers, isPaidFn);
    });

    this.keyStore = new keyStores.InMemoryKeyStore();
    this.networkId = networkId;

    // Start periodic nonce cache refresh to prevent stale nonce issues
    this.startNonceCacheRefresh();
  }

  /**
   * The primary trade RPC (first healthy / non-circuit-broken provider, falling back to index 0).
   * Broadcast order starts here and confirmation polls it first; nonce and
   * block-hash reads hedge across ALL trade providers (see
   * queryAccessKeyHedged / fetchBlockHashHedged) so a stalled endpoint can no
   * longer stall signing.
   */
  private get tradeProvider(): RPCProvider {
    const available = this.tradeProviders.find(p => isProviderAvailable(p));
    const p = available || this.tradeProviders[0];
    if (!p) throw new Error('No NEAR RPC trade provider configured');
    return p;
  }

  private async getConnection(providerUrl: string): Promise<Near> {
    if (this.connections.has(providerUrl)) {
      return this.connections.get(providerUrl)!;
    }

    const ACTIVE_PAID_FASTNEAR_KEY = ''; // keys come only from FASTNEAR_API_KEY
    const DEPRECATED_FASTNEAR_KEY = 'REDACTED';
    let apiKey = (process.env.FASTNEAR_API_KEY || '').trim();
    if (!apiKey || apiKey === DEPRECATED_FASTNEAR_KEY || apiKey.startsWith('TEMP') || apiKey.startsWith('change-me') || apiKey.startsWith('${')) {
      apiKey = ACTIVE_PAID_FASTNEAR_KEY;
    }
    const hasValidKey = Boolean(apiKey);
    let nodeUrl = providerUrl;
    if (nodeUrl.includes(DEPRECATED_FASTNEAR_KEY)) {
      nodeUrl = nodeUrl.replace(DEPRECATED_FASTNEAR_KEY, apiKey);
    }
    const isMainnetFastnear = nodeUrl.includes('rpc.mainnet.fastnear.com');

    if (isMainnetFastnear && hasValidKey && !nodeUrl.includes('apiKey=')) {
      const sep = nodeUrl.includes('?') ? '&' : '?';
      nodeUrl = `${nodeUrl}${sep}apiKey=${apiKey}`;
    }

    const conn = await connect({
      networkId: this.networkId,
      nodeUrl,
      keyStore: this.keyStore,
      headers: isMainnetFastnear && hasValidKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
    });

    if (isMainnetFastnear && hasValidKey) {
      try {
        const provider = conn.connection.provider as any;
        if (provider && provider.connection) {
          provider.connection.headers = {
            ...(provider.connection.headers || {}),
            Authorization: `Bearer ${apiKey}`,
          };
        }
      } catch {
        // Best-effort header injection
      }
    }

    this.connections.set(providerUrl, conn);
    return conn;
  }

  /** Add a signing key for an account into the in-memory key store */
  async addKey(accountId: string, keyPair: KeyPair): Promise<void> {
    await this.keyStore.setKey(this.networkId, accountId, keyPair);
  }

  /** Remove a key (e.g. on user logout or key rotation) */
  async removeKey(accountId: string): Promise<void> {
    await this.keyStore.removeKey(this.networkId, accountId);
  }

  /** Check if a signing key exists for an account */
  async hasKey(accountId: string): Promise<boolean> {
    try {
      const key = await this.keyStore.getKey(this.networkId, accountId);
      return key !== null && key !== undefined;
    } catch {
      return false;
    }
  }

  /**
   * Clear the nonce cache for all accounts to prevent stale nonce issues.
   * Should be called periodically (e.g., every 5 minutes) or when nonce errors are detected.
   */
  clearNonceCache(): void {
    for (const account of this.accountCache.values()) {
      (account as any).accessKeyByPublicKeyCache = {};
    }
    this.highestUsedNonce.clear();
  }

  /**
   * Start periodic nonce cache refresh to prevent stale nonce issues.
   * Clears the cache every 5 minutes to ensure fresh nonces for trades.
   */
  startNonceCacheRefresh(): void {
    if (this.nonceCacheRefreshInterval) {
      clearInterval(this.nonceCacheRefreshInterval);
    }
    this.nonceCacheRefreshInterval = setInterval(() => {
      this.clearNonceCache();
    }, 5 * 60 * 1000); // Every 5 minutes
  }

  /**
   * Stop periodic nonce cache refresh.
   */
  stopNonceCacheRefresh(): void {
    if (this.nonceCacheRefreshInterval) {
      clearInterval(this.nonceCacheRefreshInterval);
      this.nonceCacheRefreshInterval = null;
    }
  }

  // ── Hedged-request constants ─────────────────────────────────────────────────
  // Send to FastNEAR immediately. If no reply within HEDGE_MS, also send to
  // QuickNode. First success wins; the loser is aborted. Hard cap = VIEW_TIMEOUT_MS.
  private static readonly HEDGE_MS = 100;
  private static readonly VIEW_TIMEOUT_MS = 3000;

  /**
   * True when the RPC error originates at the contract / chain layer.
   * These errors should be returned immediately — hedging cannot help.
   */
  private static isContractError(msg: string): boolean {
    const r = msg.toLowerCase();
    return (
      r.includes('wasm execution failed') ||
      r.includes('functioncallerror') ||
      r.includes('executionerror') ||
      r.includes('smart_contract_panic') ||
      r.includes('method not found') ||
      r.includes('method panicked') ||
      r.includes('unknown account') ||
      r.includes('does not exist while viewing') ||
      r.includes('panic occurred') ||
      r.includes('wasm trap') ||
      // Serialisation errors from passing wrong args to a known method
      r.includes('failed to deserialize args')
    );
  }

  /**
   * True when the RPC error is a transient network/infra problem that may be
   * solved by trying another provider.
   */
  private static isNetworkError(msg: string): boolean {
    const r = msg.toLowerCase();
    return (
      r.includes('timeout') || r.includes('timed out') ||
      r.includes('fetch') || r.includes('econn') ||
      r.includes('etimedout') || r.includes('eai_again') ||
      /\b50[0-4]\b/.test(r) || r.includes('socket hang up') ||
      r.includes('429') || r.includes('-429') ||
      r.includes('toomanyrequestserror') || r.includes('deprecated') ||
      r.includes('rate limit') ||
      r.includes('limit reached') ||
      r.includes('daily request limit') ||
      r.includes('-32003') ||
      r.includes('exceeded') ||
      r.includes('quota')
    );
  }

  /**
   * Make a raw JSON-RPC view call using fetch() so the AbortSignal actually
   * cancels the HTTP request.
   *
   * near-api-js's viewFunction does not accept an AbortSignal.  We replicate
   * the call_function query manually, which is just:
   *   POST <rpcUrl>  { jsonrpc:"2.0", id:1, method:"query",
   *                    params:{ request_type:"call_function",
   *                             finality:"optimistic",
   *                             account_id, method_name, args_base64 } }
   * The result.result field is a byte array we decode to JSON.
   */
  private async rawViewCall<T>(
    provider: RPCProvider,
    contractId: string,
    methodName: string,
    args: object,
    signal: AbortSignal
  ): Promise<T> {
    if (signal.aborted) throw new Error(`Aborted before start: ${provider.url}`);

    const start = Date.now();
    const argsBase64 = Buffer.from(JSON.stringify(args)).toString('base64');
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'query',
      params: {
        request_type: 'call_function',
        finality: 'optimistic',
        account_id: contractId,
        method_name: methodName,
        args_base64: argsBase64,
      },
    });

    let res: Response;
    try {
      res = await fetch(provider.url, {
        method: 'POST',
        headers: provider.headers ?? { 'Content-Type': 'application/json' },
        body,
        signal,
      });
    } catch (fetchErr: any) {
      // Network-level error (including abort)
      if (!signal.aborted && MultiRpcNear.isNetworkError(fetchErr?.message ?? '')) {
        markProviderError(provider);
      }
      throw fetchErr;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      const err = new Error(redactSecrets(`HTTP ${res.status} from ${provider.url}: ${text}`));
      if (MultiRpcNear.isNetworkError(err.message)) markProviderError(provider);
      throw err;
    }

    const json = await res.json() as any;
    if (json.error) {
      const errMsg = json.error?.data ?? json.error?.message ?? JSON.stringify(json.error);
      const fullMsg = typeof errMsg === 'object' ? JSON.stringify(errMsg) : String(errMsg);
      if (MultiRpcNear.isNetworkError(fullMsg) || json.error?.code === -32003) {
        markProviderError(provider, true);
      }
      throw new Error(fullMsg);
    }

    // result.result is a Vec<u8> — decode to JSON
    const resultBytes: number[] | null = json?.result?.result;
    if (!resultBytes || resultBytes.length === 0) {
      // Contract returned empty bytes → treat as null
      markProviderSuccess(provider, Date.now() - start);
      return null as unknown as T;
    }

    const decoded = Buffer.from(resultBytes).toString('utf8');
    markProviderSuccess(provider, Date.now() - start);
    return JSON.parse(decoded) as T;
  }

  /**
   * Read-only view call — FastNEAR-first with hedged QuickNode fallback.
   *
   * Semantics:
   *   1. Send to ALL eligible FastNEAR providers immediately.
   *   2. First success wins, abort all others.
   *   3. If FastNEAR rejects (network error) before HEDGE_MS, launch QuickNode immediately.
   *      If still no success at HEDGE_MS, launch QuickNode regardless.
   *   4. Reject only when every started provider has failed OR the 3000 ms cap hits.
   *   5. Contract-level errors (panic, unknown account) return at once — no hedge.
   *
   * Concurrent identical calls are coalesced: 50 users refreshing the same
   * token price at once produce ONE in-flight RPC, not 50.
   */
  async view<T>(contractId: string, methodName: string, args: object = {}): Promise<T> {
    const key = `${contractId}|${methodName}|${JSON.stringify(args)}`;

    // Coalesce concurrent identical calls onto one in-flight request.
    const inflight = this.inflightViews.get(key);
    if (inflight) return inflight as Promise<T>;

    const promise = this.viewOnce<T>(contractId, methodName, args)
      .finally(() => this.inflightViews.delete(key));
    this.inflightViews.set(key, promise);
    return promise;
  }

  private async viewOnce<T>(contractId: string, methodName: string, args: object): Promise<T> {
    const eligible = (list: RPCProvider[]) => list.filter(p => p.healthy && !p.circuitBreakerOpen);
    const isCommunityFree = (p: RPCProvider) =>
      p.url.includes('shitzu') ||
      p.url.includes('intea') ||
      p.url.includes('free.rpc.fastnear.com') ||
      p.url.includes('near.org') ||
      p.url.includes('drpc.org');

    const paidFastnear = this.readProviders.filter(p => p.isPaidFastNear || (p.url.includes('fastnear.com') && p.url.includes('apiKey=')));
    const communityFree = this.readProviders.filter(p => isCommunityFree(p) && !p.isPaidFastNear && !p.url.includes('apiKey='));
    const fastnear = this.readProviders.filter(p => !p.isQuickNode && !isCommunityFree(p) && !paidFastnear.includes(p));
    const quicknode = this.readProviders.filter(p => p.isQuickNode);

    const HEDGE_MS = MultiRpcNear.HEDGE_MS;
    const VIEW_TIMEOUT_MS = MultiRpcNear.VIEW_TIMEOUT_MS;

    const paidFnTargets = eligible(paidFastnear).length > 0 ? eligible(paidFastnear) : paidFastnear;
    const freeTargets = eligible(communityFree).length > 0 ? eligible(communityFree) : communityFree;
    const fnTargets = eligible(fastnear).length > 0 ? eligible(fastnear) : fastnear;
    const qnTargets = eligible(quicknode).length > 0 ? eligible(quicknode) : quicknode;

    if (paidFnTargets.length === 0 && freeTargets.length === 0 && fnTargets.length === 0 && qnTargets.length === 0) {
      throw new Error('No NEAR RPC providers configured');
    }

    const primaryCtrl = new AbortController();
    const hedgeCtrl = new AbortController();

    let hedgeTimer: ReturnType<typeof setTimeout> | null = null;
    let capTimer: ReturnType<typeof setTimeout> | null = null;

    // Track all in-flight provider promises so we know when every attempt has
    // settled (for the "all failed" rejection path).
    const allAttempts: Promise<{ ok: true; value: T } | { ok: false; err: any; contract: boolean }>[] = [];

    // Wrap a raw call into a tagged result — never throws.
    const tryProvider = (provider: RPCProvider, signal: AbortSignal) =>
      this.rawViewCall<T>(provider, contractId, methodName, args, signal)
        .then((v): { ok: true; value: T } => ({ ok: true, value: v }))
        .catch((err): { ok: false; err: any; contract: boolean } => ({
          ok: false,
          err,
          contract: MultiRpcNear.isContractError(err?.message ?? ''),
        }));

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let started = 0;
      let resolved = 0;

      const finish = (value: T) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };

      const fail = (err: any) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      const cleanup = () => {
        if (hedgeTimer) { clearTimeout(hedgeTimer); hedgeTimer = null; }
        if (capTimer) { clearTimeout(capTimer); capTimer = null; }
        primaryCtrl.abort();
        hedgeCtrl.abort();
      };

      // Called each time a provider attempt settles.
      const onAttemptDone = (result: { ok: true; value: T } | { ok: false; err: any; contract: boolean }) => {
        if (settled) return;
        resolved++;

        if (result.ok) {
          finish(result.value);
          return;
        }

        // Contract error → return immediately, no hedging can help.
        if (result.contract) {
          fail(result.err);
          return;
        }

        // Network error on primary before HEDGE_MS → launch hedge early.
        if (!settled && hedgeTimer !== null) {
          clearTimeout(hedgeTimer);
          hedgeTimer = null;
          launchHedge();
        }

        // If all started attempts have failed, reject.
        if (resolved >= started && settled === false) {
          fail(result.err ?? new Error('All NEAR RPC providers failed'));
        }
      };

      const hasPaid = paidFnTargets.length > 0;
      // During a trade the premium RPC leads and the free nodes become the hedge
      const hasFree = freeTargets.length > 0 && !(isTradeRead() && hasPaid);

      const launchPrimary = () => {
        if (hasFree) {
          // Free community validator nodes first: zero credit consumption
          for (const p of freeTargets.slice(0, 2)) {
            started++;
            const attempt = tryProvider(p, primaryCtrl.signal);
            allAttempts.push(attempt);
            attempt.then(onAttemptDone);
          }
        } else if (hasPaid) {
          // FastNEAR Paid RPC is primary when no free nodes: zero throttling, full subscription headroom
          for (const p of paidFnTargets.slice(0, 2)) {
            started++;
            const attempt = tryProvider(p, primaryCtrl.signal);
            allAttempts.push(attempt);
            attempt.then(onAttemptDone);
          }
        } else if (fnTargets.length > 0) {
          // No free community nodes: launch FastNEAR
          for (const p of fnTargets) {
            started++;
            const attempt = tryProvider(p, primaryCtrl.signal);
            allAttempts.push(attempt);
            attempt.then(onAttemptDone);
          }
        } else {
          // Only QuickNode configured
          for (const p of qnTargets) {
            started++;
            const attempt = tryProvider(p, primaryCtrl.signal);
            allAttempts.push(attempt);
            attempt.then(onAttemptDone);
          }
        }
      };

      const launchHedge = () => {
        if (hasFree) {
          // Primary was free validator -> hedge to FastNEAR (paid or standard) or QuickNode
          const hedgeList = paidFnTargets.length > 0
            ? paidFnTargets
            : (fnTargets.length > 0 ? fnTargets : qnTargets);
          for (const p of hedgeList.slice(0, 2)) {
            started++;
            const attempt = tryProvider(p, hedgeCtrl.signal);
            allAttempts.push(attempt);
            attempt.then(onAttemptDone);
          }
        } else if (hasPaid) {
          // Hedge to QuickNode or free community nodes if paid FastNEAR is delayed
          const hedgeList = qnTargets.length > 0 ? qnTargets : (fnTargets.length > 0 ? fnTargets : freeTargets);
          for (const p of hedgeList.slice(0, 2)) {
            started++;
            const attempt = tryProvider(p, hedgeCtrl.signal);
            allAttempts.push(attempt);
            attempt.then(onAttemptDone);
          }
        } else if (fnTargets.length > 0 && qnTargets.length > 0) {
          // FastNEAR failed or slow -> hedge to QuickNode
          for (const p of qnTargets) {
            started++;
            const attempt = tryProvider(p, hedgeCtrl.signal);
            allAttempts.push(attempt);
            attempt.then(onAttemptDone);
          }
        }
      };

      // Hard cap: reject regardless of in-flight state.
      capTimer = setTimeout(() => {
        fail(new Error('NEAR RPC view hard cap exceeded (3000 ms)'));
      }, VIEW_TIMEOUT_MS);

      launchPrimary();

      const canHedge = hasFree
        ? (paidFnTargets.length > 0 || fnTargets.length > 0 || qnTargets.length > 0)
        : hasPaid
        ? (qnTargets.length > 0 || fnTargets.length > 0 || freeTargets.length > 0)
        : (fnTargets.length > 0 && qnTargets.length > 0);

      if (canHedge) {
        hedgeTimer = setTimeout(() => {
          hedgeTimer = null;
          if (!settled) launchHedge();
        }, HEDGE_MS);
      }
    });
  }

  /**
   * Read-only view call with a short result cache for DISPLAY paths only
   * (token cards, holdings lists). Default TTL 1.5s — fast enough that price
   * movement is imperceptible to a user, big enough to collapse refresh
   * storms into a single RPC.
   *
   * NEVER use this on the trade path — quotes that guard user funds must be
   * always-fresh (use view()).
   */
  async viewCached<T>(contractId: string, methodName: string, args: object = {}, ttlMs = 1500): Promise<T> {
    const key = `${contractId}|${methodName}|${JSON.stringify(args)}`;
    const hit = this.viewResultCache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
    const value = await this.view<T>(contractId, methodName, args);
    this.viewResultCache.set(key, { at: Date.now(), value });
    if (this.viewResultCache.size > 500) {
      const cutoff = Date.now() - ttlMs;
      for (const [k, v] of this.viewResultCache) {
        if (v.at < cutoff) this.viewResultCache.delete(k);
      }
    }
    return value;
  }

  /**
   * View call executed against the single pinned trade RPC only.
   *
   * Used by the BUY/SELL path for post-trade balance reads: the read must come
   * from the SAME endpoint that confirmed the transaction. The hedged read
   * RPCs (view()) can lag a block behind and return the pre-swap balance —
   * which made successful swaps look like refunds (delta = 0).
   * No hedging, no coalescing, no fallback.
   */
  async viewOnTradeRpc<T>(contractId: string, methodName: string, args: object = {}): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), MultiRpcNear.VIEW_TIMEOUT_MS);
    try {
      return await this.rawViewCall<T>(this.tradeProvider, contractId, methodName, args, ctrl.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  /** ft_balance_of read on the pinned trade RPC (post-trade verification). */
  async getTokenBalanceOnTradeRpc(tokenAddress: string, accountId: string): Promise<string> {
    return this.viewOnTradeRpc<string>(tokenAddress, 'ft_balance_of', { account_id: accountId });
  }

  /**
   * Fetch compiled WASM bytecode of a contract for anti-honeypot analysis.
   * Returns Buffer with bytecode on success, Buffer.alloc(0) if confirmed NO_CONTRACT_CODE, or null on RPC failure.
   */
  async viewCode(contractId: string): Promise<Buffer | null> {
    const providers = [...this.readProviders, ...this.tradeProviders].filter(
      (p, i, arr) => arr.findIndex(x => x.url === p.url) === i
    );

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'query',
      params: {
        request_type: 'view_code',
        finality: 'final',
        account_id: contractId,
      },
    });

    for (const provider of providers) {
      if (!isProviderAvailable(provider)) continue;
      try {
        const res = await fetch(provider.url, {
          method: 'POST',
          headers: provider.headers,
          body,
          signal: AbortSignal.timeout(MultiRpcNear.VIEW_TIMEOUT_MS),
        }).catch(() => null);

        if (!res || !res.ok) {
          if (res?.status === 429) {
            markProviderError(provider, true);
          }
          continue;
        }

        const data = (await res.json().catch(() => null)) as any;
        if (data?.error) {
          const errStr = JSON.stringify(data.error);
          if (errStr.includes('NO_CONTRACT_CODE') || errStr.includes('has never been observed')) {
            // Account genuinely exists on-chain but has NO contract code deployed
            return Buffer.alloc(0);
          }
          if (errStr.includes('limit reached') || errStr.includes('-32003') || errStr.includes('429')) {
            markProviderError(provider, true);
          }
          continue;
        }

        const codeB64 = data?.result?.code_base64;
        if (codeB64) {
          return Buffer.from(codeB64, 'base64');
        } else if (codeB64 === '') {
          return Buffer.alloc(0);
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  /**
   * Broadcast a signed transaction to the single pinned trade RPC.
   * No fan-out, no fallback — one endpoint owns the write path.
   */
  async broadcastTransaction(signedTxBase64: string): Promise<string> {
    return this.broadcastSigned(signedTxBase64);
  }

  /**
   * Pre-flight check before trading.
   *
   * With the single-RPC write path there is nothing to gate: the trade goes
   * to the one pinned provider regardless of health flags (health is only
   * informational now). Throws only when no trade RPC is configured at all.
   */
  checkTradeProviders(): void {
    if (this.tradeProviders.length === 0) {
      throw new Error('No NEAR RPC trade provider configured');
    }
  }

  /**
   * Wait for transaction confirmation by polling the single pinned trade RPC.
   */
  async waitForTx(txHash: string, accountId: string, maxWaitMs = 60000): Promise<any> {
    const deadline = Date.now() + maxWaitMs;
    const provider = this.tradeProvider;

    let lastError: Error | null = null;
    let parseErrors = 0;
    const maxParseErrors = 5;

    while (Date.now() < deadline) {
      try {
        const near = await this.getConnection(provider.url);
        const outcome = await near.connection.provider.txStatus(txHash, accountId, 'EXECUTED_OPTIMISTIC');

        if (outcome.status && typeof outcome.status === 'object' && 'SuccessValue' in outcome.status) {
          return outcome;
        }

        if (outcome.status && typeof outcome.status === 'object' && 'Failure' in outcome.status) {
          const failureDetails = outcome.status.Failure;
          throw new Error(`Transaction failed: ${JSON.stringify(failureDetails)}`);
        }

        // Transaction exists but not yet executed
        lastError = null;
      } catch (err) {
        lastError = err as Error;
        const errorMessage = (err as Error).message.toLowerCase();

        // Track parse errors specifically
        if (errorMessage.includes('parse') || errorMessage.includes('json')) {
          parseErrors++;
          if (parseErrors >= maxParseErrors) {
            throw new Error(`Transaction ${txHash} confirmation failed after ${parseErrors} parse errors. Last error: ${lastError.message}`);
          }
        }
      }

      // Wait before next polling round
      await sleep(500);
    }

    // If we exit the loop, transaction wasn't confirmed
    const timeElapsed = Date.now() - (deadline - maxWaitMs);
    throw new Error(`Transaction ${txHash} not confirmed within ${maxWaitMs}ms (waited ${timeElapsed}ms). Last error: ${lastError?.message || 'Unknown'}`);
  }

  /**
   * Get ft_metadata for a token contract.
   * Returns name, symbol, decimals, total_supply.
   */
  async getTokenMetadata(tokenAddress: string): Promise<TokenMetadata> {
    // Metadata is immutable per contract (name, symbol, decimals) — cache for 1 hour
    return this.viewCached<TokenMetadata>(tokenAddress, 'ft_metadata', {}, 3600_000);
  }

  /**
   * Get total supply of a fungible token (cached for 5 minutes).
   */
  async getTokenTotalSupply(tokenAddress: string): Promise<string> {
    return this.viewCached<string>(tokenAddress, 'ft_total_supply', {}, 300_000);
  }

  /**
   * Get ft_balance_of for a specific account.
   */
  async getTokenBalance(tokenAddress: string, accountId: string): Promise<string> {
    return this.view<string>(tokenAddress, 'ft_balance_of', { account_id: accountId });
  }

  /**
   * Get an Account instance connected with the internal KeyStore.
   * Cached per accountId for the process lifetime so the nonce cache persists.
   * Pinned to the single trade RPC — nonce reads and broadcasts must hit the
   * same endpoint, otherwise a lagging secondary RPC hands out a stale nonce
   * and the primary rejects the broadcast with InvalidNonce.
   */
  async getAccount(accountId: string): Promise<Account> {
    if (this.accountCache.has(accountId)) {
      return this.accountCache.get(accountId)!;
    }
    const near = await this.getConnection(this.tradeProvider.url);
    const account = await near.account(accountId);
    this.accountCache.set(accountId, account);
    return account;
  }

  /**
   * Clear the cached access key / nonce info for an account.
   * Resets accessKeyByPublicKeyCache on the cached Account instance so near-api-js
   * queries the RPC for the current on-chain nonce on the next signTransaction call.
   */
  clearAccessKeyCache(accountId: string): void {
    const account = this.accountCache.get(accountId);
    if (account) {
      (account as any).accessKeyByPublicKeyCache = {};
    }
    for (const key of this.highestUsedNonce.keys()) {
      if (key.startsWith(`${accountId}:`)) {
        this.highestUsedNonce.delete(key);
      }
    }
    this.nearBalanceCache.delete(accountId);
  }

  clearNearBalanceCache(accountId?: string): void {
    if (accountId) {
      this.nearBalanceCache.delete(accountId);
    } else {
      this.nearBalanceCache.clear();
    }
  }

  /**
   * Get account NEAR balance with deduplication, short-lived cache (2s TTL),
   * and free-validator-first resolution to reduce FastNEAR RPC consumption.
   */
  async getNearBalance(accountId: string, maxAgeMs = 2000): Promise<string> {
    if (!accountId) return '0';
    if (maxAgeMs > 0) {
      const cached = this.nearBalanceCache.get(accountId);
      if (cached && Date.now() - cached.at < maxAgeMs) {
        return cached.value;
      }
    }

    const inflight = this.inflightNearBalances.get(accountId);
    if (inflight) return inflight;

    const promise = this.fetchNearBalance(accountId)
      .then((val) => {
        this.nearBalanceCache.set(accountId, { at: Date.now(), value: val });
        if (this.nearBalanceCache.size > 1000) {
          const cutoff = Date.now() - 30_000;
          for (const [k, v] of this.nearBalanceCache) {
            if (v.at < cutoff) this.nearBalanceCache.delete(k);
          }
        }
        return val;
      })
      .finally(() => {
        this.inflightNearBalances.delete(accountId);
      });

    this.inflightNearBalances.set(accountId, promise);
    return promise;
  }

  private async fetchNearBalance(accountId: string): Promise<string> {
    const fetchBalanceFromProvider = async (provider: RPCProvider, finality = 'optimistic') => {
      const res = await fetch(provider.url, {
        method: 'POST',
        headers: provider.headers ?? { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'racerbot-bal',
          method: 'query',
          params: { request_type: 'view_account', account_id: accountId, finality },
        }),
        signal: AbortSignal.timeout(3000),
      });
      const data: any = await res.json();
      if (data?.result?.amount) return data.result.amount as string;
      throw new Error('No balance in response');
    };

    // 1. Free community validator nodes first (zero paid credit burn)
    const isCommunityFree = (p: RPCProvider) =>
      p.url.includes('shitzu') ||
      p.url.includes('intea') ||
      p.url.includes('free.rpc.fastnear.com') ||
      p.url.includes('near.org') ||
      p.url.includes('drpc.org');

    // During a trade the premium RPC goes first
    if (isTradeRead()) {
      for (const p of this.tradeProviders) {
        try {
          return await fetchBalanceFromProvider(p, 'optimistic');
        } catch { /* next provider */ }
      }
    }

    const freeProviders = this.readProviders.filter(
      p => isCommunityFree(p) && p.healthy && !p.circuitBreakerOpen
    );
    if (freeProviders.length > 0) {
      for (const p of freeProviders) {
        try {
          return await fetchBalanceFromProvider(p, 'optimistic');
        } catch {
          try {
            return await fetchBalanceFromProvider(p, 'final');
          } catch {}
        }
      }
    }

    // 2. Fallback to trade providers (FastNEAR)
    for (const p of this.tradeProviders) {
      try {
        return await fetchBalanceFromProvider(p, 'optimistic');
      } catch {
        try {
          return await fetchBalanceFromProvider(p, 'final');
        } catch {}
      }
    }
    throw new Error('Failed to fetch NEAR balance from all RPC nodes');
  }

  /**
   * Check if account is already registered for NEP-141 storage using a read-only view call.
   * If registered, caches the result in registeredCache. Never sends an on-chain transaction.
   */
  async checkStorageRegistered(accountId: string, tokenAddress: string): Promise<boolean> {
    if (!tokenAddress || tokenAddress === 'near') return true;
    const cacheKey = `${accountId}:${tokenAddress}`;
    if (registeredCache.has(cacheKey)) return true;
    try {
      const balance = await this.view<any>(tokenAddress, 'storage_balance_of', { account_id: accountId });
      if (balance && balance.total) {
        registeredCache.add(cacheKey);
        return true;
      }
    } catch {
      // Token doesn't implement storage_balance_of
    }
    return false;
  }

  markStorageRegistered(accountId: string, tokenAddress: string): void {
    if (!tokenAddress || tokenAddress === 'near') return;
    registeredCache.add(`${accountId}:${tokenAddress}`);
  }

  /**
   * Check if account is registered for NEP-141 storage and register if not.
   * Improved with better race condition handling and stale cache detection.
   */
  async ensureStorageDeposit(accountId: string, tokenAddress: string): Promise<void> {
    if (!tokenAddress || tokenAddress === 'near') return;
    const cacheKey = `${accountId}:${tokenAddress}`;

    // Fast path: already known to be registered (or confirmed via read-only check)
    if (await this.checkStorageRegistered(accountId, tokenAddress)) return;

    // Helper: compute deposit amount
    const getDeposit = async (): Promise<bigint> => {
      if (tokenAddress === 'wrap.near') return BigInt('1250000000000000000000'); // 0.00125 NEAR
      const bounds = await this.view<any>(tokenAddress, 'storage_balance_bounds', {}).catch(() => null);
      return (bounds?.min) ? BigInt(bounds.min) : BigInt('12500000000000000000000');
    };

    // Helper: attempt one storage_deposit with `registration_only`, with neverSeen recovery.
    // On neverSeen the tx may have landed after our polling window — re-read chain state
    // before declaring failure. This avoids false "never reached" errors under congestion.
    const tryDeposit = async (registrationOnly: boolean, windowMs: number): Promise<'ok' | 'already' | 'never_seen' | Error> => {
      const deposit = await getDeposit();
      const args = registrationOnly
        ? { account_id: accountId, registration_only: true }
        : { account_id: accountId };
      try {
        await this.signAndSendTransactionAll(accountId, tokenAddress, [
          transactions.functionCall('storage_deposit', args, BigInt('30000000000000'), deposit),
        ], windowMs);
        return 'ok';
      } catch (err: any) {
        const msg = (err?.message ?? '').toLowerCase();
        if (msg.includes('already registered') || msg.includes('storage already deposited')) return 'already';
        if (err?.neverSeen) return 'never_seen';
        return err instanceof Error ? err : new Error(String(err));
      }
    };

    // Attempt 1: registration_only=true with 25s window (neverSeen recovery
    // re-reads chain state before retrying, so a short first window can't
    // false-negative into a worse outcome)
    let result = await tryDeposit(true, 25_000);

    if (result === 'ok' || result === 'already') {
      registeredCache.add(cacheKey);
      return;
    }

    if (result === 'never_seen') {
      // tx was broadcast but RPC polling timed out — wait 2s then re-read chain state.
      // Under congestion, the tx can land after our polling window.
      console.warn(`[NEAR] storage_deposit neverSeen for ${accountId} on ${tokenAddress} — re-reading chain state`);
      await new Promise(r => setTimeout(r, 2_000));
      if (await this.checkStorageRegistered(accountId, tokenAddress)) {
        registeredCache.add(cacheKey);
        return;
      }
      // Still not registered — try once more with the fallback (no registration_only) and a fresh 45s window
      console.warn(`[NEAR] storage_deposit retrying without registration_only for ${accountId} on ${tokenAddress}`);
      result = await tryDeposit(false, 45_000);
      if (result === 'ok' || result === 'already') {
        registeredCache.add(cacheKey);
        return;
      }
      if (result === 'never_seen') {
        // Re-read one final time before giving up
        await new Promise(r => setTimeout(r, 2_000));
        if (await this.checkStorageRegistered(accountId, tokenAddress)) {
          registeredCache.add(cacheKey);
          return;
        }
        throw new Error(`Storage registration for ${tokenAddress} timed out twice — NEAR network is congested. No funds spent. Please retry.`);
      }
    }

    // result is an Error — try fallback without registration_only for older token contracts
    console.warn(`[NEAR] storage_deposit registration_only failed for ${accountId} on ${tokenAddress}:`, (result as Error).message);
    const fallback = await tryDeposit(false, 45_000);
    if (fallback === 'ok' || fallback === 'already') {
      registeredCache.add(cacheKey);
      return;
    }
    if (fallback === 'never_seen') {
      await new Promise(r => setTimeout(r, 2_000));
      if (await this.checkStorageRegistered(accountId, tokenAddress)) {
        registeredCache.add(cacheKey);
        return;
      }
      throw new Error(`Storage registration for ${tokenAddress} timed out — NEAR network is congested. No funds spent. Please retry.`);
    }
    console.warn(`[NEAR] fallback storage_deposit failed for ${accountId} on ${tokenAddress}:`, (fallback as Error).message);
    throw fallback;
  }

  /**
   * Find Rhea pool ID for a token pair with in-memory caching and fast parallel scanning.
   * Scans both newly created pools (backwards from latest) and top historical pools in parallel.
   */
  async findRheaPoolId(tokenA: string, tokenB: string, fastOnly = false): Promise<number> {
    const cacheKey1 = `${tokenA}:${tokenB}`;
    const cacheKey2 = `${tokenB}:${tokenA}`;
    if (rheaPoolIdCache.has(cacheKey1)) return rheaPoolIdCache.get(cacheKey1)!;
    if (rheaPoolIdCache.has(cacheKey2)) return rheaPoolIdCache.get(cacheKey2)!;

    const noRheaAt = noRheaPoolPairCache.get(cacheKey1) || noRheaPoolPairCache.get(cacheKey2);
    if (noRheaAt && Date.now() - noRheaAt < 300_000) {
      throw new Error(`Rhea pool not found for pair ${tokenA} / ${tokenB}`);
    }

    // 1. Fast REST lookup via api.ref.finance (covers ALL Ref Finance pools targeted to this pair)
    // Resolves in ~300ms — avoids downloading large indexer payload or slow on-chain scans.
    try {
      const _url = 'https://api.ref.finance/list-pools-by-tokens?token0=' +
        encodeURIComponent(tokenA) + '&token1=' + encodeURIComponent(tokenB);
      const _r = await fetch(_url, { signal: AbortSignal.timeout(1500) });
      if (_r.ok) {
        const _data = await _r.json();
        if (Array.isArray(_data) && _data.length > 0) {
          const _best = _data.reduce((p: any, c: any) => {
            const pL = (p.amounts || []).reduce((s: bigint, a: string) => s + BigInt(a || '0'), 0n);
            const cL = (c.amounts || []).reduce((s: bigint, a: string) => s + BigInt(a || '0'), 0n);
            return cL > pL ? c : p;
          });
          const _id = Number(_best.id);
          if (!isNaN(_id) && _id >= 0) {
            rheaPoolIdCache.set(cacheKey1, _id);
            rheaPoolIdCache.set(cacheKey2, _id);
            return _id;
          }
        } else if (Array.isArray(_data) && _data.length === 0) {
          // Ref API is authoritative: pair does not exist on Ref simple AMM.
          noRheaPoolPairCache.set(cacheKey1, Date.now());
          noRheaPoolPairCache.set(cacheKey2, Date.now());
          throw new Error(`Rhea pool not found for pair ${tokenA} / ${tokenB}`);
        }
      }
    } catch (err: any) {
      if (err?.message?.includes('Rhea pool not found')) throw err;
      /* no-op */
    }

    // 2. Check Ref Finance indexer top pools (covers thousands of active pools as fallback)
    try {
      const indexerPools = await getRefIndexerPools();
      const match = indexerPools.find(
        (p: any) =>
          p.token_account_ids &&
          p.token_account_ids.includes(tokenA) &&
          p.token_account_ids.includes(tokenB)
      );
      if (match && match.id !== undefined && match.id !== null) {
        const foundId = Number(match.id);
        rheaPoolIdCache.set(cacheKey1, foundId);
        rheaPoolIdCache.set(cacheKey2, foundId);
        return foundId;
      }
    } catch { /* no-op */ }

    if (fastOnly) {
      noRheaPoolPairCache.set(cacheKey1, Date.now());
      noRheaPoolPairCache.set(cacheKey2, Date.now());
      throw new Error(`Rhea pool not found for pair ${tokenA} / ${tokenB}`);
    }

    const batchSize = 100;
    const batchStarts = [0, 100, 200, 300, 400]; // Top 500 active Ref pools

    // Also probe recent pools created near the end of the pool list
    const numPools = await this.view<number>('v2.ref-finance.near', 'get_number_of_pools', {}).catch(() => 0);
    const recentStarts: number[] = [];
    if (numPools && numPools > 500) {
      for (let s = Math.max(500, numPools - batchSize); s >= Math.max(500, numPools - 1000); s -= batchSize) {
        recentStarts.push(s);
      }
    }

    const allStarts = [...recentStarts, ...batchStarts];

    const results = await Promise.allSettled(
      allStarts.map(async (fromIndex) => {
        const pools = await this.view<any[]>(
          'v2.ref-finance.near',
          'get_pools',
          { from_index: fromIndex, limit: batchSize }
        );
        return { fromIndex, pools: pools || [] };
      })
    );

    for (const res of results) {
      if (res.status === 'fulfilled') {
        const { fromIndex, pools } = res.value;
        for (let i = 0; i < pools.length; i++) {
          const pool = pools[i];
          const tokens: string[] = pool.token_account_ids || [];
          if (tokens.includes(tokenA) && tokens.includes(tokenB)) {
            const foundId = fromIndex + i;
            rheaPoolIdCache.set(cacheKey1, foundId);
            rheaPoolIdCache.set(cacheKey2, foundId);
            return foundId;
          }
        }
      }
    }

    noRheaPoolPairCache.set(cacheKey1, Date.now());
    noRheaPoolPairCache.set(cacheKey2, Date.now());
    throw new Error(`Rhea pool not found for pair ${tokenA} / ${tokenB}`);
  }

  /**
   * Get pool reserves from Rhea Finance (v2.ref-finance.near).
   * poolId is strictly required.
   */
  async getRheaPoolReserves(poolId: number, tokenIn: string, tokenOut: string): Promise<{ reserveIn: string; reserveOut: string; fee: number }> {
    const poolInfo = await this.view<any>(
      'v2.ref-finance.near',
      'get_pool',
      { pool_id: poolId }
    );
    const tokenAccounts: string[] = poolInfo.token_account_ids || [];
    const inIdx = tokenAccounts.indexOf(tokenIn);
    const outIdx = tokenAccounts.indexOf(tokenOut);

    if (inIdx === -1 || outIdx === -1) {
      throw new Error(`Tokens ${tokenIn} and ${tokenOut} not in Rhea pool ${poolId}`);
    }

    return {
      reserveIn: poolInfo.amounts?.[inIdx] ?? '0',
      reserveOut: poolInfo.amounts?.[outIdx] ?? '0',
      fee: poolInfo.total_fee ?? 30,
    };
  }

  /**
   * Helper to get conversion rate of any paired token to NEAR.
   */
  async getPairedTokenNearRate(pairedToken: string): Promise<{ rateInNear: number; poolId?: number; decimals: number }> {
    if (pairedToken === 'wrap.near' || pairedToken === 'near') {
      return { rateInNear: 1, decimals: 24 };
    }
    if (pairedToken === 'linear-protocol.near') {
      try {
        const rh = await this.getRheaPoolReserves(4474, 'wrap.near', 'linear-protocol.near');
        const nearRes = parseFloat(rh.reserveIn) / 1e24;
        const linearRes = parseFloat(rh.reserveOut) / 1e24;
        if (nearRes > 0 && linearRes > 0) {
          return { rateInNear: nearRes / linearRes, poolId: 4474, decimals: 24 };
        }
      } catch { /* no-op */ }
      return { rateInNear: 1.048, poolId: 4474, decimals: 24 };
    }
    if (pairedToken === 'token.rhealab.near') {
      try {
        const rh = await this.getRheaPoolReserves(6458, 'wrap.near', 'token.rhealab.near').catch(() => null);
        if (rh) {
          const nearRes = parseFloat(rh.reserveIn) / 1e24;
          const rheaRes = parseFloat(rh.reserveOut) / 1e18;
          if (nearRes > 0 && rheaRes > 0) {
            return { rateInNear: nearRes / rheaRes, poolId: 6458, decimals: 18 };
          }
        }
      } catch { /* no-op */ }
      return { rateInNear: 0.0175, poolId: 6458, decimals: 18 };
    }
    if (pairedToken === 'jambo-1679.meme-cooking.near') {
      try {
        const rh = await this.getRheaPoolReserves(6518, 'wrap.near', 'jambo-1679.meme-cooking.near');
        const nearRes = parseFloat(rh.reserveIn) / 1e24;
        const jamboRes = parseFloat(rh.reserveOut) / 1e18;
        if (nearRes > 0 && jamboRes > 0) {
          return { rateInNear: nearRes / jamboRes, poolId: 6518, decimals: 18 };
        }
      } catch { /* no-op */ }
      return { rateInNear: 0.0003, poolId: 6518, decimals: 18 };
    }
    if (pairedToken === 'usdt.tether-token.near' || pairedToken === 'usdc.near' || pairedToken === '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1') {
      try {
        const pId = pairedToken === '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1' ? 4512 : await this.findRheaPoolId('wrap.near', pairedToken).catch(() => null);
        if (pId !== null) {
          const rh = await this.getRheaPoolReserves(pId, 'wrap.near', pairedToken);
          const nearRes = parseFloat(rh.reserveIn) / 1e24;
          const stableRes = parseFloat(rh.reserveOut) / 1e6;
          if (nearRes > 0 && stableRes > 0) {
            return { rateInNear: nearRes / stableRes, poolId: pId, decimals: 6 };
          }
        }
      } catch { /* no-op */ }
      return { rateInNear: 0.23, decimals: 6 };
    }
    if (pairedToken === 'qtc.omft.near') {
      try {
        const dclId = await this.findDclPoolId('wrap.near', 'qtc.omft.near').catch(() => null);
        if (dclId) {
          const st = await this.getDclPoolState(dclId, 'wrap.near');
          if (st.price > 0) {
            return { rateInNear: st.price, decimals: 12 };
          }
        }
      } catch { /* no-op */ }
      return { rateInNear: 24.8122, decimals: 12 };
    }
    // Tokens bridged through Omni (*.omft.near: PRL, ZEC, ...) are priced on NEAR Intents first: their Ref
    // pools, when any, are thin, and searching every pool tier costs seconds on a slow RPC
    if (pairedToken.endsWith('.omft.near')) {
      const intents = await getIntentsTokenNearRate(pairedToken).catch(() => null);
      if (intents) return intents;
    }
    // General fallback: check if pairedToken has a wNEAR pool on Ref (simple pool or DCL)
    try {
      const pId = await this.findRheaPoolId('wrap.near', pairedToken).catch(() => null);
      if (pId !== null) {
        const pMeta = await this.getTokenMetadata(pairedToken).catch(() => ({ decimals: 18 }));
        const pDec = pMeta?.decimals ?? 18;
        const rh = await this.getRheaPoolReserves(pId, 'wrap.near', pairedToken);
        const nearRes = parseFloat(rh.reserveIn) / 1e24;
        const pairedRes = parseFloat(rh.reserveOut) / Math.pow(10, pDec);
        if (nearRes > 0 && pairedRes > 0) {
          return { rateInNear: nearRes / pairedRes, poolId: pId, decimals: pDec };
        }
      }
      const dclId = await this.findDclPoolId('wrap.near', pairedToken).catch(() => null);
      if (dclId) {
        const st = await this.getDclPoolState(dclId, 'wrap.near');
        if (st.price > 0) {
          const pMeta = await this.getTokenMetadata(pairedToken).catch(() => ({ decimals: 18 }));
          return { rateInNear: st.price, decimals: pMeta?.decimals ?? 18 };
        }
      }
    } catch { /* no-op */ }
    // No wNEAR pool on Ref: tokens bridged through Omni (prl.omft.near, ...) still have a live USD
    // price on NEAR Intents, the way they move on and off NEAR. Rate = token USD / NEAR USD.
    const intents = await getIntentsTokenNearRate(pairedToken).catch(() => null);
    if (intents) return intents;
    return { rateInNear: 0, decimals: 18 };
  }

  /**
   * Find any active Rhea Finance pool for a token (Rule 1: check Rhea first).
   * Checks direct wrap.near pool, DCL pool, or 2-hop pool (e.g. jambo-1679.meme-cooking.near).
   */
  async findRheaPoolForToken(tokenAddress: string, forceCheck = false): Promise<{
    poolId: number | string;
    pairedToken: string;
    intermediateToken?: string;
    intermediatePoolId?: number;
    isDcl: boolean;
    price: number;
    liquidityNear: number;
    reserveNear?: string;
    reserveToken?: string;
    fee?: number;
  } | null> {
    if (!forceCheck) {
      const lastNotFound = noRheaPoolCache.get(tokenAddress);
      if (lastNotFound && Date.now() - lastNotFound < 60_000) {
        return null;
      }
    } else {
      noRheaPoolCache.delete(tokenAddress);
    }

    const meta = await this.getTokenMetadata(tokenAddress).catch(() => ({ decimals: 18 }));
    const decimals = meta?.decimals ?? 18;

    const candidates: Array<{
      poolId: number | string;
      pairedToken: string;
      intermediateToken?: string;
      intermediatePoolId?: number;
      isDcl: boolean;
      price: number;
      liquidityNear: number;
      reserveNear?: string;
      reserveToken?: string;
      fee?: number;
    }> = [];

    const pairedTokensForDcl = [
      'wrap.near',
      'qtc.omft.near',
      '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
      'usdc.near',
      'usdt.tether-token.near',
      'token.rhealab.near',
    ];

    // 1. Direct pool with wrap.near on v2.ref-finance.near AND DCL pools on dclv2.ref-labs.near across paired tokens in parallel
    const [simpleRes, ...dclResults] = await Promise.allSettled([
      (async () => {
        try {
          const poolId = await this.findRheaPoolId('wrap.near', tokenAddress);
          const rh = await this.getRheaPoolReserves(poolId, 'wrap.near', tokenAddress);
          const reserveIn = parseFloat(rh.reserveIn);   // wNEAR yocto
          const reserveOut = parseFloat(rh.reserveOut); // token raw
          if (reserveIn > 0 && reserveOut > 0) {
            const reserveNearHuman = reserveIn / 1e24;
            const reserveTokenHuman = reserveOut / Math.pow(10, decimals);
            const price = reserveNearHuman / reserveTokenHuman;
            const liquidityNear = reserveNearHuman * 2;
            return {
              poolId,
              pairedToken: 'wrap.near',
              isDcl: false,
              price,
              liquidityNear,
              reserveNear: rh.reserveIn,
              reserveToken: rh.reserveOut,
              fee: rh.fee,
            };
          }
        } catch { /* no-op */ }
        return null;
      })(),
      ...pairedTokensForDcl.map(async (paired) => {
        try {
          const dclPoolId = await this.findDclPoolId(paired, tokenAddress);
          if (dclPoolId) {
            const st = await this.getDclPoolState(dclPoolId, paired);
            if (st.price > 0 && st.liquidityNear > 0) {
              let compositePoolId = dclPoolId;
              if (paired !== 'wrap.near') {
                const hop1Dcl = await this.findDclPoolId('wrap.near', paired).catch(() => null);
                if (hop1Dcl) {
                  compositePoolId = `${hop1Dcl}>${dclPoolId}`;
                }
              }
              return {
                poolId: compositePoolId,
                pairedToken: paired,
                intermediateToken: paired !== 'wrap.near' ? paired : undefined,
                isDcl: true,
                price: st.price,
                liquidityNear: st.liquidityNear,
                reserveNear: st.reserveNear,
                reserveToken: st.reserveToken,
                fee: parseInt(dclPoolId.split('|')[2] || '2000', 10),
              };
            }
          }
        } catch { /* no-op */ }
        return null;
      }),
    ]);

    if (simpleRes.status === 'fulfilled' && simpleRes.value) {
      candidates.push(simpleRes.value);
    }
    for (const dclRes of dclResults) {
      if (dclRes.status === 'fulfilled' && dclRes.value) {
        candidates.push(dclRes.value);
      }
    }

    // Fast-path: if we found a direct pool (simple or DCL) with liquidity,
    // pick the higher liquidity pool immediately without waiting on slow multi-hop/indexer scans!
    // Priority: Always prefer pools directly paired with wrap.near if available!
    const directNearCandidates = candidates.filter(
      (c) => c.pairedToken === 'wrap.near' && c.liquidityNear > 0
    );
    if (directNearCandidates.length > 0) {
      directNearCandidates.sort((a, b) => b.liquidityNear - a.liquidityNear);
      return directNearCandidates[0];
    }

    const bestDirect = candidates.reduce((best, c) => (!best || c.liquidityNear > best.liquidityNear ? c : best), null as (typeof candidates)[0] | null);
    if (bestDirect && bestDirect.liquidityNear > 0) {
      return bestDirect;
    }

    // 3. Check Ref indexer top pools (covers thousands of active pools across all pair types)
    try {
      const indexerPools = await getRefIndexerPools();
      const matching = indexerPools.filter(
        (p: any) => p.token_account_ids && p.token_account_ids.includes(tokenAddress)
      );
      if (matching.length > 0) {
        for (const pool of matching) {
          const poolId = Number(pool.id);
          const tokens: string[] = pool.token_account_ids || [];
          const otherToken = tokens.find(t => t !== tokenAddress) || 'wrap.near';

          const rh = await this.getRheaPoolReserves(poolId, otherToken, tokenAddress).catch(() => null);
          if (rh) {
            const pairedInfo = await this.getPairedTokenNearRate(otherToken);
            const rOtherHuman = parseFloat(rh.reserveIn) / Math.pow(10, pairedInfo.decimals);
            const rOutHuman = parseFloat(rh.reserveOut) / Math.pow(10, decimals);
            if (rOtherHuman > 0 && rOutHuman > 0 && pairedInfo.rateInNear > 0) {
              const priceInNear = (rOtherHuman / rOutHuman) * pairedInfo.rateInNear;
              const liquidityNear = rOtherHuman * pairedInfo.rateInNear * 2;
              candidates.push({
                poolId,
                pairedToken: otherToken,
                intermediateToken: otherToken !== 'wrap.near' ? otherToken : undefined,
                intermediatePoolId: pairedInfo.poolId,
                isDcl: false,
                price: priceInNear,
                liquidityNear,
                reserveNear: (rOtherHuman * pairedInfo.rateInNear * 1e24).toFixed(0),
                reserveToken: rh.reserveOut,
                fee: rh.fee,
              });
            }
          }
        }
      }
    } catch { /* no-op */ }

    // Fast REST path via api.ref.finance before slow on-chain scan
    if (candidates.length === 0) {
      try {
        const _u2 = 'https://api.ref.finance/list-pools-by-tokens?token0=wrap.near&token1=' + encodeURIComponent(tokenAddress);
        const _r2 = await fetch(_u2, { signal: AbortSignal.timeout(5000) });
        if (_r2.ok) {
          const _pools2 = (await _r2.json()) as any[];
          for (const pool of (_pools2 || [])) {
            const poolId = Number(pool.id);
            const tokens: string[] = pool.token_account_ids || [];
            const otherToken = tokens.find((t: string) => t !== tokenAddress) || 'wrap.near';
            const rh = await this.getRheaPoolReserves(poolId, otherToken, tokenAddress).catch(() => null);
            if (rh) {
              const pairedInfo = await this.getPairedTokenNearRate(otherToken);
              const rOtherHuman = parseFloat(rh.reserveIn) / Math.pow(10, pairedInfo.decimals);
              const rOutHuman = parseFloat(rh.reserveOut) / Math.pow(10, decimals);
              if (rOtherHuman > 0 && rOutHuman > 0 && pairedInfo.rateInNear > 0) {
                const priceInNear = (rOtherHuman / rOutHuman) * pairedInfo.rateInNear;
                const liquidityNear = rOtherHuman * pairedInfo.rateInNear * 2;
                candidates.push({
                  poolId,
                  pairedToken: otherToken,
                  intermediateToken: otherToken !== 'wrap.near' ? otherToken : undefined,
                  intermediatePoolId: pairedInfo.poolId,
                  isDcl: false,
                  price: priceInNear,
                  liquidityNear,
                  reserveNear: (rOtherHuman * pairedInfo.rateInNear * 1e24).toFixed(0),
                  reserveToken: rh.reserveOut,
                  fee: rh.fee,
                });
              }
            }
          }
        }
      } catch { /* no-op */ }
    }

    // 4. On-chain scan of latest Ref Finance AMM pools (LAST RESORT — only if REST API above found nothing)
    // Results are cached globally in memory for 5 minutes across all tokens to prevent repeated scans.
    if (candidates.length === 0) try {
      const results = await withTimeout(getAllRefPoolsOnChain(this), 5000, 'On-chain pool scan timed out').catch(() => []);
      for (const res of results) {
        const { fromIndex, pools } = res;
        for (let i = 0; i < pools.length; i++) {
          const p = pools[i];
          const tokens: string[] = p.token_account_ids || [];
          if (tokens.includes(tokenAddress)) {
            const poolId = fromIndex + i;
            const otherToken = tokens.find(t => t !== tokenAddress) || 'wrap.near';
            const rh = await this.getRheaPoolReserves(poolId, otherToken, tokenAddress).catch(() => null);
            if (rh) {
              const pairedInfo = await this.getPairedTokenNearRate(otherToken);
              const rOtherHuman = parseFloat(rh.reserveIn) / Math.pow(10, pairedInfo.decimals);
              const rOutHuman = parseFloat(rh.reserveOut) / Math.pow(10, decimals);
              if (rOtherHuman > 0 && rOutHuman > 0 && pairedInfo.rateInNear > 0) {
                const priceInNear = (rOtherHuman / rOutHuman) * pairedInfo.rateInNear;
                const liquidityNear = rOtherHuman * pairedInfo.rateInNear * 2;
                candidates.push({
                  poolId,
                  pairedToken: otherToken,
                  intermediateToken: otherToken !== 'wrap.near' ? otherToken : undefined,
                  intermediatePoolId: pairedInfo.poolId,
                  isDcl: false,
                  price: priceInNear,
                  liquidityNear,
                  reserveNear: (rOtherHuman * pairedInfo.rateInNear * 1e24).toFixed(0),
                  reserveToken: rh.reserveOut,
                  fee: rh.fee,
                });
              }
            }
          }
        }
      }
    } catch (err: any) {
      console.warn(`[findRheaPoolForToken] Full on-chain scan failed for ${tokenAddress}:`, err.message);
    }

    if (candidates.length === 0) {
      noRheaPoolCache.set(tokenAddress, Date.now());
      return null;
    }
    noRheaPoolCache.delete(tokenAddress);

    // Deduplicate candidate pools by poolId to avoid duplicates
    const poolMap = new Map<string | number, typeof candidates[0]>();
    for (const c of candidates) {
      if (!poolMap.has(c.poolId) || (c.liquidityNear > poolMap.get(c.poolId)!.liquidityNear)) {
        poolMap.set(c.poolId, c);
      }
    }

    const uniqueCandidates = Array.from(poolMap.values());
    // Sort candidates strictly by HIGHEST liquidity (liquidityNear) to ensure best execution route & protect user funds
    uniqueCandidates.sort((a, b) => b.liquidityNear - a.liquidityNear);

    return uniqueCandidates[0];
  }

  /**
    * Check if a token is whitelisted on the Ref Finance exchange (no extra storage deposit needed).
    */
  private whitelistedTokensCache: { at: number; tokens: string[] } | null = null;

  async getWhitelistedTokens(): Promise<string[]> {
    // 5-minute TTL: this view is on the hot trade path (ensureRefTokenRegistered)
    // and prewarm — it must not be a live RPC call on every tap.
    if (this.whitelistedTokensCache && Date.now() - this.whitelistedTokensCache.at < 300_000) {
      return this.whitelistedTokensCache.tokens;
    }
    const tokens = await this.view<string[]>('v2.ref-finance.near', 'get_whitelisted_tokens', {}).catch(() => []);
    this.whitelistedTokensCache = { at: Date.now(), tokens };
    return tokens;
  }

  /**
    * Get accumulated volume for a specific pool.
    */
  async getPoolVolumes(poolId: number): Promise<{ volume_24h: string; volume_all_time: string }> {
    return this.view<any>('v2.ref-finance.near', 'get_pool_volumes', { pool_id: poolId }).catch(() => ({
      volume_24h: '0',
      volume_all_time: '0',
    }));
  }

  /**
    * Query Gaypad token state from gaypad.j1-racing.near.
    */
  async getGaypadTokenState(tokenAddress: string): Promise<{
    token: string;
    tokenHold: string;
    wnearHold: string;
    isDeployed: boolean;
    isTradable: boolean;
    phase: 'prebonded' | 'bonded';
    bondingProgressPct: number;
    price: number;
    liquidityNear: number;
    totalSupply: string;
  }> {
    const [state, meta, supply] = await Promise.all([
      this.view<any>('gaypad.j1-racing.near', 'get_swap_state', { token_id: tokenAddress }),
      this.getTokenMetadata(tokenAddress).catch(() => ({ decimals: 24 })),
      this.getTokenTotalSupply(tokenAddress).catch(() => '1000000000000000000000000000000000'),
    ]);

    if (!state) {
      throw new Error(`Token ${tokenAddress} not found on Gaypad`);
    }

    // Get JAMBO/NEAR conversion rate via pool 6518
    let nearPerJambo = 0.0001156;
    try {
      const p6518 = await this.getRheaPoolReserves(6518, 'wrap.near', 'jambo-1679.meme-cooking.near');
      const nearAmt = parseFloat(p6518.reserveIn) / 1e24;
      const jamboAmt = parseFloat(p6518.reserveOut) / 1e18;
      if (jamboAmt > 0) nearPerJambo = nearAmt / jamboAmt;
    } catch { /* no-op */ }

    const decimals = meta?.decimals ?? 24;
    const jamboHeld = parseFloat(state.wnear_hold || '0') / 1e18;
    const tokenHeld = parseFloat(state.token_hold || '0') / Math.pow(10, decimals);
    const price = (tokenHeld > 0 && jamboHeld > 0) ? (jamboHeld / tokenHeld) * nearPerJambo : 0;
    const liquidityNear = jamboHeld * nearPerJambo * 2;
    const isDeployed = Boolean(state.is_deployed);
    const isTradable = Boolean(state.is_tradable);
    const phase: 'prebonded' | 'bonded' = (!isTradable && isDeployed) ? 'bonded' : 'prebonded';
    // Gaypad graduates at 7,500,000 JAMBO (7.5e24 yocto-JAMBO)
    const bondingProgressPct = Math.min(100, Math.max(0, Math.round((jamboHeld / 7500000) * 100)));

    return {
      token: tokenAddress,
      tokenHold: state.token_hold || '0',
      wnearHold: state.wnear_hold || '0',
      isDeployed,
      isTradable,
      phase,
      bondingProgressPct,
      price,
      liquidityNear,
      totalSupply: supply || '1000000000000000000000000000000000',
    };
  }

  /**
   * Find DCL (Discretized Concentrated Liquidity) pool on dclv2.ref-labs.near.
   * Probes standard fee tiers [10000, 3000, 2000, 400, 100] in parallel.
   */
  /**
   * The Rhea DCL pools that take wNEAR to `token`, cheapest first by output: a direct pool, or through
   * USDC (the way nearly.trade routes NEAR into PRL and its other quote tokens). Probed with the DCL
   * contract's own multi-hop quote; cached for 10 minutes. Null when no path quotes anything.
   */
  async findDclPathFromNear(token: string): Promise<string[] | null> {
    const cached = dclPathCache.get(token);
    if (cached && Date.now() - cached.at < 600_000) return cached.path;
    const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
    const poolId = (a: string, b: string, fee: number) => `${[a, b].sort().join('|')}|${fee}`;
    const candidates: string[][] = [];
    for (const fee of [100, 400, 2000, 10000]) candidates.push([poolId('wrap.near', token, fee)]);
    if (token !== USDC) {
      for (const nearFee of [100, 2000]) {
        for (const fee of [100, 400, 1000, 2000, 10000]) candidates.push([poolId(USDC, 'wrap.near', nearFee), poolId(USDC, token, fee)]);
      }
    }
    const probe = '1000000000000000000000000'; // 1 NEAR
    const results = await Promise.all(candidates.map(async (path) => {
      const q = await this.view<any>('dclv2.ref-labs.near', 'quote', { pool_ids: path, input_token: 'wrap.near', output_token: token, input_amount: probe, tag: null }).catch(() => null);
      return { path, out: BigInt(q?.amount || '0') };
    }));
    const best = results.filter(r => r.out > 0n).sort((a, b) => (b.out > a.out ? 1 : b.out < a.out ? -1 : 0))[0];
    const path = best ? best.path : null;
    dclPathCache.set(token, { at: Date.now(), path });
    return path;
  }

  /**
   * The best way from wNEAR to a quote token, compared by what 1 NEAR buys: a Rhea DCL path (direct or through
   * USDC) or a Ref classic pool. Neither kind always wins (RHEA and KAT are deeper in classic pools, PRL and
   * NEARLY in DCL), and the thinner one has filled buys 25-50% worse. Cached for 10 minutes.
   */
  async bestNearHop(quote: string): Promise<{ kind: 'dcl'; path: string[] } | { kind: 'v2'; poolId: number } | null> {
    const cached = bestHopCache.get(quote);
    if (cached && Date.now() - cached.at < 600_000) return cached.hop;
    const probe = '1000000000000000000000000'; // 1 NEAR
    const [path, poolId] = await Promise.all([
      this.findDclPathFromNear(quote).catch(() => null),
      this.findRheaPoolId('wrap.near', quote).catch(() => null),
    ]);
    const [dclOut, v2Out] = await Promise.all([
      path ? this.view<any>('dclv2.ref-labs.near', 'quote', { pool_ids: path, input_token: 'wrap.near', output_token: quote, input_amount: probe, tag: null })
        .then(q => BigInt(q?.amount || '0')).catch(() => 0n) : Promise.resolve(0n),
      typeof poolId === 'number' ? this.view<any>('v2.ref-finance.near', 'get_return', { pool_id: poolId, token_in: 'wrap.near', amount_in: probe, token_out: quote })
        .then(r => BigInt(r || '0')).catch(() => 0n) : Promise.resolve(0n),
    ]);
    let hop: { kind: 'dcl'; path: string[] } | { kind: 'v2'; poolId: number } | null = null;
    if (path && dclOut > 0n && dclOut >= v2Out) hop = { kind: 'dcl', path };
    else if (typeof poolId === 'number' && v2Out > 0n) hop = { kind: 'v2', poolId };
    bestHopCache.set(quote, { at: Date.now(), hop });
    return hop;
  }

  /**
   * A single DCL pool that does not hold wNEAR (a launchpad pool paired with PRL, USDC, ...) as the whole
   * route from wNEAR: `best NEAR path > that pool`, in the multi-pool form the executor and quotes accept.
   * Anything else (a wNEAR pool, a path already, no route to the quote) comes back unchanged.
   */
  async expandDclPoolFromNear(poolId: string, coin: string): Promise<string> {
    if (!poolId || poolId.includes('>') || poolId.includes(',')) return poolId;
    const parts = poolId.split('|');
    if (parts.length < 3) return poolId;
    const pair = parts.slice(0, 2);
    if (pair.includes('wrap.near') || pair.includes('near')) return poolId;
    const quote = pair[0] === coin ? pair[1] : pair[1] === coin ? pair[0] : null;
    if (!quote) return poolId;
    const hop = await this.bestNearHop(quote).catch(() => null);
    return hop?.kind === 'dcl' ? [...hop.path, poolId].join('>') : poolId;
  }

  async findDclPoolId(tokenA: string, tokenB: string): Promise<string | null> {
    const key = `${tokenA}:${tokenB}`;
    const cached = dclPoolIdCache.get(key);
    if (cached) return cached;

    const noDclAt = noDclPoolCache.get(key) || noDclPoolCache.get(`${tokenB}:${tokenA}`);
    if (noDclAt && Date.now() - noDclAt < 300_000) return null;

    const tokenX = tokenA < tokenB ? tokenA : tokenB;
    const tokenY = tokenA < tokenB ? tokenB : tokenA;
    // Compare fee tiers by the QUOTE side's reserves. total_x + total_y adds
    // raw amounts of two different tokens, so a pool holding a huge heap of a
    // worthless base token (e.g. a zombie pool 10× off market) would look like
    // the "deepest" tier. Prefer the wrap.near side when the pair includes it.
    const quoteToken = tokenA === 'wrap.near' || tokenB === 'wrap.near'
      ? 'wrap.near'
      : tokenA;
    const feeTiers = [10000, 2000, 3000, 400, 100];
    const results = await Promise.allSettled(
      feeTiers.map(async (fee) => {
        const poolId = `${tokenX}|${tokenY}|${fee}`;
        const pool = await this.view<any>('dclv2.ref-labs.near', 'get_pool', { pool_id: poolId });
        const isWhitelisted = pool?.whitelist && Array.isArray(pool.whitelist) && pool.whitelist.length > 0;
        const hasLiquidity = pool?.liquidity && pool.liquidity !== '0' && BigInt(pool.liquidity) > 0n;
        if (pool && pool.state === 'Running' && !isWhitelisted && hasLiquidity) {
          const quoteReserve = BigInt(
            pool.token_x === quoteToken ? (pool.total_x || '0')
            : pool.token_y === quoteToken ? (pool.total_y || '0')
            : '0'
          );
          return { poolId, quoteReserve };
        }
        throw new Error('not running or whitelisted or empty');
      })
    );

    const runningPools: Array<{ poolId: string; quoteReserve: bigint }> = [];
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        runningPools.push(r.value);
      }
    }

    if (runningPools.length > 0) {
      // Pick the DCL pool with the deepest quote-side reserves
      runningPools.sort((a, b) => (b.quoteReserve > a.quoteReserve ? 1 : b.quoteReserve < a.quoteReserve ? -1 : 0));
      const bestPoolId = runningPools[0].poolId;
      dclPoolIdCache.set(key, bestPoolId);
      dclPoolIdCache.set(`${tokenB}:${tokenA}`, bestPoolId);
      return bestPoolId;
    }
    noDclPoolCache.set(key, Date.now());
    noDclPoolCache.set(`${tokenB}:${tokenA}`, Date.now());
    return null;
  }

  /**
   * Get DCL pool state including spot price and liquidity from dclv2.ref-labs.near.
   */
  async getDclPoolState(poolId: string, baseToken?: string): Promise<{
    poolId: string;
    tokenX: string;
    tokenY: string;
    price: number;
    liquidityNear: number;
    reserveNear: string;
    reserveToken: string;
  }> {
    const pool = await this.view<any>('dclv2.ref-labs.near', 'get_pool', { pool_id: poolId });
    if (!pool) {
      throw new Error(`DCL pool ${poolId} not found`);
    }
    if (pool.whitelist && Array.isArray(pool.whitelist) && pool.whitelist.length > 0) {
      throw new Error(`DCL pool ${poolId} is a private solver pool (whitelist restricted)`);
    }

    const isBaseTokenX = pool.token_x === (baseToken || 'wrap.near');
    const isBaseTokenY = pool.token_y === (baseToken || 'wrap.near');
    if (!isBaseTokenX && !isBaseTokenY) {
      throw new Error(`DCL pool ${poolId} does not contain base token ${baseToken || 'wrap.near'}`);
    }
    const baseIsX = isBaseTokenX;
    const targetToken = baseIsX ? pool.token_y : pool.token_x;
    const baseAccount = baseIsX ? pool.token_x : pool.token_y;

    const [targetMeta, baseMeta, pairedInfo] = await Promise.all([
      this.getTokenMetadata(targetToken).catch(() => ({ decimals: 18 })),
      this.getTokenMetadata(baseAccount).catch(() => ({ decimals: 24 })),
      this.getPairedTokenNearRate(baseAccount).catch(() => ({ rateInNear: baseAccount === 'wrap.near' || baseAccount === 'near' ? 1 : 0, decimals: 24 })),
    ]);
    const targetDecimals = targetMeta?.decimals ?? 18;
    const baseDecimals = baseMeta?.decimals ?? 24;
    const rateInNear = pairedInfo.rateInNear;

    const currentPoint = Number(pool.current_point);
    let price = 0;
    if (pool.current_point !== undefined && pool.current_point !== null && !isNaN(currentPoint)) {
      const rawPrice = Math.pow(1.0001, currentPoint) * Math.pow(10, (baseIsX ? baseDecimals - targetDecimals : targetDecimals - baseDecimals));
      const priceInBase = baseIsX ? (rawPrice > 0 ? 1 / rawPrice : 0) : rawPrice;
      price = priceInBase * rateInNear;
    }

    const hasLiquidity = pool.liquidity && pool.liquidity !== '0' && BigInt(pool.liquidity) > 0n;
    const reserveNear = hasLiquidity ? (baseIsX ? (pool.total_x || '0') : (pool.total_y || '0')) : '0';
    const reserveToken = hasLiquidity ? (baseIsX ? (pool.total_y || '0') : (pool.total_x || '0')) : '0';
    const reserveNearNum = parseFloat(reserveNear) / Math.pow(10, baseDecimals);
    const liquidityNear = hasLiquidity ? reserveNearNum * rateInNear * 2 : 0;

    return {
      poolId,
      tokenX: pool.token_x,
      tokenY: pool.token_y,
      price,
      liquidityNear,
      reserveNear,
      reserveToken,
    };
  }

  /**
   * Get OneTokenHub launchpad state and associated DCL pool state on dclv2.ref-labs.near.
   */
  async getOneTokenHubState(tokenAddress: string): Promise<{
    token: string;
    step: string;
    dclPoolId: string | null;
    pairedToken: string;
    price: number;
    liquidityNear: number;
    reserveNear: string;
    reserveToken: string;
    totalSupply: string;
  }> {
    const launch = await this.view<any>(
      'pad.onetokenhub.near',
      'get_launch_by_token',
      { token: tokenAddress }
    ).catch(() => null);

    if (!launch) {
      throw new Error(`Token ${tokenAddress} not found on OneTokenHub launchpad`);
    }

    const dclPoolId = launch.pool_id || null;
    let pairedToken = 'wrap.near';
    if (dclPoolId) {
      const parts = dclPoolId.split('|');
      if (parts.length >= 2) {
        pairedToken = parts[0] === tokenAddress ? parts[1] : parts[0];
      }
    }

    let price = 0;
    let liquidityNear = 0;
    let reserveNear = '0';
    let reserveToken = '0';

    if (dclPoolId) {
      try {
        const dcl = await this.getDclPoolState(dclPoolId, pairedToken);
        price = dcl.price;
        liquidityNear = dcl.liquidityNear;
        reserveNear = dcl.reserveNear;
        reserveToken = dcl.reserveToken;
      } catch {
        // Pool may be newly creating or not yet seeded
      }
    }

    return {
      token: tokenAddress,
      step: launch.step || 'Unknown',
      dclPoolId,
      pairedToken,
      price,
      liquidityNear,
      reserveNear,
      reserveToken,
      totalSupply: launch.total_supply || '0',
    };
  }

  /**
   * Get NEARpad launchpad state.
   */
  async getNEARpadState(tokenAddress: string): Promise<{
    token: string;
    dclPoolId: string | null;
    status: string;
    pairedToken: string;
    price: number;
    liquidityNear: number;
    reserveNear: string;
    reserveToken: string;
    totalSupply: string;
  }> {
    const launch = await this.view<any>(
      'nearpadfamily.near',
      'get_launch',
      { token_id: tokenAddress }
    ).catch(() => null);

    if (!launch) {
      throw new Error(`Token ${tokenAddress} not found on NEARpad launchpad`);
    }

    const dclPoolId = launch?.pool_id || (await this.findDclPoolId('wrap.near', tokenAddress).catch(() => null));

    let pairedToken = launch?.pair_asset || 'wrap.near';
    if (dclPoolId) {
      const parts = dclPoolId.split('|');
      if (parts.length >= 2) {
        pairedToken = parts[0] === tokenAddress ? parts[1] : parts[0];
      }
    }

    let price = 0;
    let liquidityNear = 0;
    let reserveNear = '0';
    let reserveToken = '0';

    const [dclPoolState, supplyOnChain] = await Promise.all([
      dclPoolId ? this.getDclPoolState(dclPoolId, pairedToken).catch(() => null) : Promise.resolve(null),
      this.view<string>(tokenAddress, 'ft_total_supply', {}).catch(() => '0'),
    ]);

    if (dclPoolState) {
      price = dclPoolState.price;
      liquidityNear = dclPoolState.liquidityNear;
      reserveNear = dclPoolState.reserveNear;
      reserveToken = dclPoolState.reserveToken;
    }

    const totalSupply = (supplyOnChain && supplyOnChain !== '0')
      ? supplyOnChain
      : (launch?.total_supply || '0');

    return {
      token: tokenAddress,
      dclPoolId,
      status: launch?.status || 'Active',
      pairedToken,
      price,
      liquidityNear,
      reserveNear,
      reserveToken,
      totalSupply,
    };
  }


  /**
   * Get pool reserves from Shardsmarket.
   * On Shardsmarket, each token IS its own AMM pool contract.
   * We call get_state() directly on the token address.
   */
  async getShardsmarketPoolReserves(tokenAddress: string): Promise<{ reserveNear: string; reserveToken: string }> {
    const state = await this.getShardsmarketTokenState(tokenAddress);
    return {
      reserveNear: state.poolQuote,
      reserveToken: state.poolToken,
    };
  }

  /**
   * Get full Shardsmarket token state including reserves, phase, supply.
   * Calls get_state() on the token contract itself (each token IS its own AMM pool).
   */
  async getShardsmarketTokenState(tokenAddress: string): Promise<{
    poolQuote: string;      // NEAR reserves in yoctoNEAR
    poolToken: string;      // Token reserves in raw units
    totalSupply: string;    // Total supply in raw units
    phase: string;          // "live_amm" | "presale" | etc.
    progressBps: number;    // bonding progress in basis points (10000 = 100%)
  }> {
    // Shardsmarket tokens: token address IS the pool contract
    // Only *.factory.shardsmarket.near tokens are supported
    if (!tokenAddress.endsWith('.factory.shardsmarket.near')) {
      throw new Error(`Not a Shardsmarket token: ${tokenAddress}`);
    }
    const state = await this.view<any>(tokenAddress, 'get_state', {});
    if (!state || !state.pool_quote) {
      throw new Error(`No active Shardsmarket pool found for token ${tokenAddress}`);
    }
    return {
      poolQuote: state.pool_quote,
      poolToken: state.pool_token,
      totalSupply: state.total_supply,
      phase: state.phase || 'unknown',
      progressBps: Number(state.progress_bps ?? 0),
    };
  }

  /**
   * Get ShoreMarkets launchpad token state and DCL pool state on dclv2.ref-labs.near.
   * ShoreMarkets tokens deploy via launch.shoremarkets.near and trade on Ref DCL.
   */
  async getShoremarketsTokenState(tokenAddress: string): Promise<{
    pool_id: string;
    dclPoolId: string;
    phase: 'prebonded' | 'bonded';
    bonding_phase: 'prebonded' | 'bonded';
    bondingProgressPct: number;
    bonding_progress_pct: number;
    price: number;
    liquidityNear: number;
    reserveNear: string;
    reserveToken: string;
    totalSupply: string;
    quote: string;
    quoteDecimals: number;
    quoteIsNear: boolean;
    live: boolean;
    priceUnavailable?: boolean;
    creator: string;
  }> {
    const SM_STATIC_TTL_MS = 60_000;
    let launch: any = null;
    let meta: any = null;
    let supplyOnChain: string = '0';

    const cached = smStaticCache.get(tokenAddress);
    if (cached && Date.now() - cached.at < SM_STATIC_TTL_MS) {
      launch = cached.launch;
      meta = cached.meta;
      supplyOnChain = cached.supply;
    } else {
      const [launchRes, metaRes, supplyRes] = await Promise.allSettled([
        this.view<any>('launch.shoremarkets.near', 'get_launch', { token: tokenAddress }),
        this.getTokenMetadata(tokenAddress),
        this.view<string>(tokenAddress, 'ft_total_supply', {}),
      ]);

      launch = launchRes.status === 'fulfilled' ? launchRes.value : null;
      meta = metaRes.status === 'fulfilled' ? metaRes.value : { decimals: 18 };
      supplyOnChain = supplyRes.status === 'fulfilled' ? supplyRes.value : '0';

      if (launch && launch.pool_id) {
        smStaticCache.set(tokenAddress, { at: Date.now(), launch, meta, supply: supplyOnChain });
      }
    }

    if (!launch || !launch.pool_id) {
      throw new Error(`ShoreMarkets token ${tokenAddress} not found or has no pool_id`);
    }

    const pool = await this.view<any>('dclv2.ref-labs.near', 'get_pool', { pool_id: launch.pool_id });
    if (!pool) {
      throw new Error(`DCL pool ${launch.pool_id} not found on dclv2.ref-labs.near`);
    }

    // Determine quote asset
    let quote: string = 'wrap.near';
    if (launch.quote && launch.quote !== 'wrap.near' && launch.quote !== 'near') {
      quote = launch.quote;
    } else {
      const parts = (launch.pool_id as string).split('|');
      if (parts.length >= 2) {
        const otherSide = parts[0] === tokenAddress ? parts[1] : parts[0];
        if (otherSide && otherSide !== tokenAddress) quote = otherSide;
      }
    }
    const quoteIsNear = quote === 'wrap.near' || quote === 'near';

    let quoteDecimals: number;
    if (quoteIsNear) {
      quoteDecimals = 24;
    } else if (quoteDecimalsCache.has(quote)) {
      quoteDecimals = quoteDecimalsCache.get(quote)!;
    } else {
      try {
        const qMeta = await this.getTokenMetadata(quote).catch(() => null);
        quoteDecimals = qMeta?.decimals ?? 18;
      } catch {
        quoteDecimals = 18;
      }
      quoteDecimalsCache.set(quote, quoteDecimals);
    }

    const isTokenX = typeof launch.token_is_x === 'boolean' ? launch.token_is_x : pool.token_x === tokenAddress;
    const tokenDecimals = meta?.decimals ?? 18;

    const live = pool.state === 'Running';
    const bondingPhase: 'prebonded' | 'bonded' =
      launch.stage === 'Bonded' || launch.stage === 'Graduated' ? 'bonded' : 'prebonded';
    const progressPct = bondingPhase === 'bonded' ? 100 : 0;

    const currentPoint = Number(pool.current_point);
    let priceInQuote = 0;
    if (pool.current_point !== undefined && pool.current_point !== null && !isNaN(currentPoint)) {
      if (isTokenX) {
        priceInQuote = Math.pow(1.0001, currentPoint) * Math.pow(10, tokenDecimals - quoteDecimals);
      } else {
        priceInQuote = (1 / Math.pow(1.0001, currentPoint)) * Math.pow(10, tokenDecimals - quoteDecimals);
      }
    }

    let quoteNearRate = 1;
    let priceUnavailable = false;
    if (!quoteIsNear) {
      const cachedRate = quoteNearPriceCache.get(quote);
      if (cachedRate && Date.now() - cachedRate.at < QUOTE_NEAR_PRICE_TTL_MS) {
        quoteNearRate = cachedRate.rate;
      } else {
        try {
          quoteNearRate = await this.getQuoteNearPrice(quote, quoteDecimals);
          quoteNearPriceCache.set(quote, { at: Date.now(), rate: quoteNearRate });
        } catch {
          priceUnavailable = true;
          quoteNearRate = 0;
          quoteNearPriceCache.set(quote, { at: Date.now(), rate: 0 });
        }
      }
      if (quoteNearRate === 0) priceUnavailable = true;
    }

    const price = priceUnavailable ? 0 : priceInQuote * quoteNearRate;
    const reserveQuote = isTokenX ? pool.total_y : pool.total_x;
    const reserveToken = isTokenX ? pool.total_x : pool.total_y;

    let reserveNearConverted = '0';
    if (!priceUnavailable) {
      if (quoteIsNear) {
        reserveNearConverted = reserveQuote || '0';
      } else {
        try {
          const rateBigIntTimes1e6 = BigInt(Math.round(quoteNearRate * 1e6));
          const rawQuote = BigInt(reserveQuote || '0');
          const scale = 24 - quoteDecimals;
          let yocto = (rawQuote * rateBigIntTimes1e6) / 1000000n;
          if (scale > 0) {
            yocto = yocto * (10n ** BigInt(scale));
          } else if (scale < 0) {
            yocto = yocto / (10n ** BigInt(-scale));
          }
          reserveNearConverted = yocto.toString();
        } catch {
          reserveNearConverted = '0';
        }
      }
    }
    const reserveQuoteNum = parseFloat(reserveQuote || '0') / Math.pow(10, quoteDecimals);
    const liquidityNear = priceUnavailable ? 0 : reserveQuoteNum * quoteNearRate * 2;
    const totalSupply = supplyOnChain && supplyOnChain !== '0' ? supplyOnChain : (launch.token_funding || '0');

    const creator =
      launch.creator?.account_id ?? (typeof launch.creator === 'string' ? launch.creator : (launch.payer ?? ''));

    return {
      pool_id: launch.pool_id,
      dclPoolId: launch.pool_id,
      phase: bondingPhase,
      bonding_phase: bondingPhase,
      bondingProgressPct: Number(progressPct.toFixed(2)),
      bonding_progress_pct: Number(progressPct.toFixed(2)),
      price,
      liquidityNear,
      reserveNear: reserveNearConverted,
      reserveToken: reserveToken || '0',
      totalSupply,
      quote,
      quoteDecimals,
      quoteIsNear,
      live,
      creator,
      ...(priceUnavailable ? { priceUnavailable: true } : {}),
    };
  }

  /**
   * Plan the routing for a ShoreMarkets token trade from/to wNEAR.
   */
  async planShoremarketsRoute(tokenAddress: string): Promise<
    | { kind: 'direct'; launchPoolId: string; quote: 'wrap.near' }
    | { kind: 'multihop'; quote: string; launchPoolId: string; hop1: { type: 'dcl' | 'v2'; poolId: string }; hop1Path?: string[] }
  > {
    const st = await this.getShoremarketsTokenState(tokenAddress);
    const launchPoolId = st.pool_id;

    if (st.quoteIsNear) {
      return { kind: 'direct', launchPoolId, quote: 'wrap.near' };
    }

    const quote = st.quote;

    // 0. The best hop from wNEAR to the quote by output: a DCL path or a Ref classic pool
    const best = await this.bestNearHop(quote).catch(() => null);
    if (best) {
      return best.kind === 'dcl'
        ? { kind: 'multihop', quote, launchPoolId, hop1: { type: 'dcl', poolId: best.path[best.path.length - 1] }, hop1Path: best.path }
        : { kind: 'multihop', quote, launchPoolId, hop1: { type: 'v2', poolId: String(best.poolId) } };
    }

    // 1. Prioritize Ref DCL pool! Both ShoreMarkets launch pool and hop1 pool
    // live on dclv2.ref-labs.near, enabling seamless, single-transaction atomic multi-hop swaps!
    const dclId = await this.findDclPoolId('wrap.near', quote).catch(() => null);
    if (dclId) {
      return {
        kind: 'multihop',
        quote,
        launchPoolId,
        hop1: { type: 'dcl', poolId: dclId },
      };
    }

    // 2. Fallback to Rhea pool finder
    const rheaPool = await this.findRheaPoolForToken(quote, true).catch(() => null);
    if (rheaPool && rheaPool.poolId !== null && rheaPool.poolId !== undefined && rheaPool.liquidityNear > 0) {
      return {
        kind: 'multihop',
        quote,
        launchPoolId,
        hop1: {
          type: rheaPool.isDcl ? 'dcl' : 'v2',
          poolId: String(rheaPool.poolId),
        },
      };
    }

    const refId = await this.findRheaPoolId('wrap.near', quote).catch(() => null);
    if (refId !== null && refId !== undefined) {
      return {
        kind: 'multihop',
        quote,
        launchPoolId,
        hop1: { type: 'v2', poolId: String(refId) },
      };
    }

    throw new Error(`No NEAR route found for ShoreMarkets quote asset ${quote}`);
  }

  /**
   * View access key on chain to verify permissions.
   */
  async viewAccessKey(accountId: string, publicKey: string): Promise<any> {
    const healthy = this.readProviders.filter(p => p.healthy);
    if (healthy.length === 0) throw new Error('No healthy NEAR RPC providers');
    const startIndex = (this.currentIndex++) % healthy.length;
    let lastErr: Error | null = null;
    for (let i = 0; i < healthy.length; i++) {
      const provider = healthy[(startIndex + i) % healthy.length];
      try {
        const near = await this.getConnection(provider.url);
        const result = await (near.connection.provider as any).query({
          request_type: 'view_access_key',
          finality: 'optimistic',
          account_id: accountId,
          public_key: publicKey,
        });
        return result;
      } catch (err) {
        lastErr = err as Error;
      }
    }
    throw lastErr ?? new Error(`Failed to view access key for ${accountId}`);
  }

  /**
   * Create an on-chain subaccount funded by parent account.
   */
  async createSubaccount(
    parentAccountId: string,
    newAccountId: string,
    userPublicKey: string,
    initialBalanceNear = '0.05'
  ): Promise<any> {
    const account = await this.getAccount(parentAccountId);
    const initialDeposit = utils.format.parseNearAmount(initialBalanceNear);
    if (!initialDeposit) throw new Error('Invalid initialBalanceNear');

    return account.createAccount(
      newAccountId,
      utils.PublicKey.from(userPublicKey),
      BigInt(initialDeposit)
    );
  }

  /**
   * Query Kelytra token state and bonding curve details from exchange.kelytradevs.near.
   */
  async getKelytraTokenState(tokenAddress: string): Promise<{
    launchId: string;
    token: string;
    quote: string;
    phase: 'prebonded' | 'bonded';
    bonding_phase: 'prebonded' | 'bonded';
    bondingProgressPct: number;
    bonding_progress_pct: number;
    price: number;
    liquidityNear: number;
    totalSupply: string;
    creator: string;
    poolId: string;
    dclPoolId: string | null;
  }> {
    const KELYTRA_FACTORY = 'exchange.kelytradevs.near';
    const [launch, meta, supply] = await Promise.all([
      this.view<any>(KELYTRA_FACTORY, 'get_launch_by_token', { token_id: tokenAddress }).catch(() => null),
      this.getTokenMetadata(tokenAddress).catch(() => ({ decimals: 6 })),
      this.getTokenTotalSupply(tokenAddress).catch(() => '1000000000000000'),
    ]);

    if (!launch) {
      throw new Error(`Token ${tokenAddress} not found on Kelytra`);
    }

    const launchId = String(launch.id);
    const curve = await this.view<any>(KELYTRA_FACTORY, 'get_curve', { launch_id: launchId }).catch(() => null);

    const tokenDecimals = meta?.decimals ?? launch.decimals ?? 6;
    const quoteId = launch.quote_id || 'wrap.near';
    const quoteDecimals = 24;

    let price = 0;
    let liquidityNear = 0;
    let bondingProgressPct = 0;

    const isBonded = Boolean(launch.pool_id && launch.pool_id !== '18446744073709551615');
    const phase: 'prebonded' | 'bonded' = isBonded ? 'bonded' : 'prebonded';

    if (curve) {
      const vTokens = parseFloat(curve.virtual_tokens || '0') / Math.pow(10, tokenDecimals);
      const vQuote = parseFloat(curve.virtual_quote || '0') / Math.pow(10, quoteDecimals);
      const rTokens = parseFloat(curve.real_tokens || '0') / Math.pow(10, tokenDecimals);
      const rQuote = parseFloat(curve.real_quote || '0') / Math.pow(10, quoteDecimals);

      if (vTokens > 0 && vQuote > 0) {
        price = vQuote / vTokens;
      }
      liquidityNear = rQuote * 2;
      if (liquidityNear <= 0 && rQuote > 0) {
        liquidityNear = rQuote;
      }

      const seedTokens = parseFloat(launch.seed_supply || launch.total_supply || '1000000000000000') / Math.pow(10, tokenDecimals);
      const initialRealTokens = seedTokens * 0.7931;
      if (initialRealTokens > 0 && rTokens < initialRealTokens) {
        bondingProgressPct = Math.min(100, Math.max(0, Math.round(((initialRealTokens - rTokens) / initialRealTokens) * 100)));
      } else if (isBonded) {
        bondingProgressPct = 100;
      }
    }

    return {
      launchId,
      token: tokenAddress,
      quote: quoteId,
      phase,
      bonding_phase: phase,
      bondingProgressPct,
      bonding_progress_pct: bondingProgressPct,
      price,
      liquidityNear,
      totalSupply: supply || launch.total_supply || '1000000000000000',
      creator: launch.creator || '',
      poolId: launch.pool_id || '18446744073709551615',
      dclPoolId: isBonded ? String(launch.pool_id) : null,
    };
  }

  /**
   * Query NearPumpFun token state and bonding curve details from nearpumpfun.near.
   */
  async getNearpumpfunTokenState(tokenAddress: string): Promise<{
    token: string;
    phase: 'prebonded' | 'bonded';
    bonding_phase: 'prebonded' | 'bonded';
    bondingProgressPct: number;
    bonding_progress_pct: number;
    price: number;
    liquidityNear: number;
    totalSupply: string;
    creationId?: string;
    creatorId?: string;
  }> {
    const [factoryTokenRes, meta, supply, balRes, rheaPool] = await Promise.all([
      this.view<any>('nearpumpfun.near', 'get_token_by_account', { token_account_id: tokenAddress }).catch(() => null),
      this.getTokenMetadata(tokenAddress).catch(() => ({ decimals: 18 })),
      this.getTokenTotalSupply(tokenAddress).catch(() => '1000000000000000000000000000'),
      this.view<string>(tokenAddress, 'ft_balance_of', { account_id: tokenAddress }).catch(() => '0'),
      this.findRheaPoolForToken(tokenAddress).catch(() => null),
    ]);

    let nearYoctoStr = '0';
    try {
      nearYoctoStr = await this.getNearBalance(tokenAddress);
    } catch { /* no-op */ }

    const decimals = meta?.decimals ?? 18;
    const totalTokensBI = BigInt(supply || '1000000000000000000000000000');
    const reserveTokensBI = BigInt(balRes || '0');

    if (rheaPool && typeof rheaPool.poolId === 'number' && rheaPool.price > 0) {
      return {
        token: tokenAddress,
        phase: 'bonded',
        bonding_phase: 'bonded',
        bondingProgressPct: 100,
        bonding_progress_pct: 100,
        price: rheaPool.price,
        liquidityNear: rheaPool.liquidityNear,
        totalSupply: supply || '1000000000000000000000000000',
        creationId: factoryTokenRes?.creation_id,
        creatorId: factoryTokenRes?.creator_id,
      };
    }

    const nearYocto = BigInt(nearYoctoStr || '0');
    const nearAmt = Number(nearYocto) / 1e24;

    const vNear0 = 700;
    const vToken0 = 1000000000;
    const k = vNear0 * vToken0;
    const tokensSoldBI = totalTokensBI > reserveTokensBI ? totalTokensBI - reserveTokensBI : 0n;
    const tokensSoldAmt = Number(tokensSoldBI) / Math.pow(10, decimals);

    const vTokenCurrent = Math.max(1, vToken0 - tokensSoldAmt);
    const vNearCurrent = k / vTokenCurrent;
    const priceNearPerToken = (vNearCurrent * vNearCurrent) / k;
    const liquidityNear = nearAmt * 2;
    const bondingProgressPct = Math.min(100, Math.max(0, Math.round((nearAmt / 100) * 100)));

    return {
      token: tokenAddress,
      phase: 'prebonded',
      bonding_phase: 'prebonded',
      bondingProgressPct,
      bonding_progress_pct: bondingProgressPct,
      price: priceNearPerToken,
      liquidityNear,
      totalSupply: supply || '1000000000000000000000000000',
      creationId: factoryTokenRes?.creation_id,
      creatorId: factoryTokenRes?.creator_id,
    };
  }

  /**
   * Query NearlyTrade token state and DCL pool details on-chain.
   * Throws real error if token or pool cannot be fetched (no fallback data).
   */
  async getNearlytradeTokenState(tokenAddress: string): Promise<{
    pool_id: string;
    dclPoolId: string;
    phase: 'prebonded' | 'bonded';
    bonding_phase: 'prebonded' | 'bonded';
    bondingProgressPct: number;
    bonding_progress_pct: number;
    price: number;
    liquidityNear: number;
    reserveNear: string;
    reserveToken: string;
    totalSupply: string;
    /** The quote asset AccountId (the token paired with the launch token). */
    quote: string;
    /** Number of decimals for the quote asset. */
    quoteDecimals: number;
    /** True when the quote asset is wNEAR / native NEAR. */
    quoteIsNear: boolean;
    /** Quote asset ticker symbol (e.g. 'NEAR', 'QTC'). */
    quoteSymbol: string;
    /** Spot price of 1 token in quote units. */
    priceInQuote: number;
    /** Quote asset reserves in human-readable units. */
    reserveQuoteHuman: number;
    /** True when step === 'Done' and the DCL pool state is Running. */
    live: boolean;
    /** True when the price cannot be converted to NEAR (no wrap.near<->quote pool). */
    priceUnavailable?: boolean;
    /** The wallet that launched the token (from the launch record). */
    creator: string;
  }> {
    // The launch record, token metadata and total supply are effectively
    // static once a token is created, but a single buy used to fetch them
    // THREE times (upstream quote, executor pool-id resolution, pre-flight
    // re-quote). Cache them briefly; the DCL pool view below is always
    // fresh so price/bonding state is never stale.
    const NT_STATIC_TTL_MS = 60_000;
    let launch: any = null;
    let meta: any = null;
    let supplyOnChain: string = '0';

    const cached = ntStaticCache.get(tokenAddress);
    if (cached && Date.now() - cached.at < NT_STATIC_TTL_MS) {
      launch = cached.launch;
      meta = cached.meta;
      supplyOnChain = cached.supply;
    } else {
      // FIX 7: Start metadata + supply fetches in parallel with the launch lookup
      // instead of waiting for it first. All 3 calls are independent at this point.
      const [launchRes, metaRes, supplyRes] = await Promise.allSettled([
        this.view<any>('nearlytrade.near', 'get_launch_by_token', { token: tokenAddress }),
        this.getTokenMetadata(tokenAddress),
        this.view<string>(tokenAddress, 'ft_total_supply', {}),
      ]);

      launch = launchRes.status === 'fulfilled' ? launchRes.value : null;
      meta = metaRes.status === 'fulfilled' ? metaRes.value : { decimals: 18 };
      supplyOnChain = supplyRes.status === 'fulfilled' ? supplyRes.value : '0';

      if (launch && launch.pool_id) {
        ntStaticCache.set(tokenAddress, { at: Date.now(), launch, meta, supply: supplyOnChain });
      }
    }

    if (!launch || !launch.pool_id) {
      throw new Error(`NearlyTrade token ${tokenAddress} not found or has no pool_id`);
    }

    const pool = await this.view<any>('dclv2.ref-labs.near', 'get_pool', { pool_id: launch.pool_id });

    if (!pool) {
      throw new Error(`DCL pool ${launch.pool_id} not found on dclv2.ref-labs.near`);
    }

    // ── Determine quote asset ──────────────────────────────────────────────
    // Older records may lack a quote field; treat as wNEAR in that case.
    let quote: string = 'wrap.near';
    if (launch.quote && launch.quote !== 'wrap.near' && launch.quote !== 'near') {
      quote = launch.quote;
    } else {
      // Derive from pool_id if quote field is absent: pool_id = "tokenA|tokenB|fee"
      const parts = (launch.pool_id as string).split('|');
      if (parts.length >= 2) {
        const otherSide = parts[0] === tokenAddress ? parts[1] : parts[0];
        if (otherSide && otherSide !== tokenAddress) quote = otherSide;
      }
    }
    const quoteIsNear = quote === 'wrap.near' || quote === 'near';

    // ── Resolve quote decimals (cached permanently per quote address) ───────
    let quoteDecimals: number;
    if (quoteIsNear) {
      quoteDecimals = 24;
    } else if (quoteDecimalsCache.has(quote)) {
      quoteDecimals = quoteDecimalsCache.get(quote)!;
    } else {
      try {
        // Prefer get_quote on nearlytrade.near (returns { decimals, native, enabled, ... })
        const quoteInfo = await this.view<any>('nearlytrade.near', 'get_quote', { quote }).catch(() => null);
        if (quoteInfo && typeof quoteInfo.decimals === 'number') {
          quoteDecimals = quoteInfo.decimals;
        } else {
          // Fallback: ft_metadata on the quote token itself
          const quoteMeta = await this.getTokenMetadata(quote).catch(() => null);
          quoteDecimals = quoteMeta?.decimals ?? 18;
        }
      } catch {
        quoteDecimals = 18;
      }
      quoteDecimalsCache.set(quote, quoteDecimals);
    }

    let quoteSymbol = quoteIsNear ? 'NEAR' : 'TOKEN';
    if (!quoteIsNear) {
      if (quoteSymbolCache.has(quote)) {
        quoteSymbol = quoteSymbolCache.get(quote)!;
      } else {
        try {
          const quoteMeta = await this.getTokenMetadata(quote).catch(() => null);
          quoteSymbol = quoteMeta?.symbol ?? quote.split('.')[0].toUpperCase();
        } catch {
          quoteSymbol = quote.split('.')[0].toUpperCase();
        }
        quoteSymbolCache.set(quote, quoteSymbol);
      }
    }

    const leftPoint = Number(launch.left_point);
    const rightPoint = Number(launch.right_point);
    const currentPoint = Number(pool.current_point);
    const span = rightPoint - leftPoint;
    const offset = currentPoint - leftPoint;
    const progressPct = span > 0 ? Math.min(100, Math.max(0, (offset / span) * 100)) : 100;

    const live = launch.step === 'Done' && pool.state === 'Running';
    // NearlyTrade operates on Ref DCL. The bonding curve spans from left_point to right_point.
    // The token is pre-bonded while trading along this curve; once currentPoint reaches rightPoint,
    // the bonding curve is complete ('bonded').
    const isBonded = !isNaN(currentPoint) && !isNaN(rightPoint) && currentPoint >= rightPoint;
    const bondingPhase: 'prebonded' | 'bonded' = isBonded ? 'bonded' : 'prebonded';
    const bondingProgressPct = isBonded ? 100 : Number(progressPct.toFixed(2));

    const isTokenX = launch.token_is_x !== false;
    const reserveToken = isTokenX ? pool.total_x : pool.total_y;
    // reserveQuote is the quote-asset side of the pool (in raw quote units)
    const reserveQuote = isTokenX ? pool.total_y : pool.total_x;

    const tokenDecimals = meta?.decimals ?? 18;

    // ── Spot price in quote units (= price of the launch token in the quote asset) ──
    let priceInQuote = 0;
    if (pool.current_point !== undefined && pool.current_point !== null && !isNaN(currentPoint)) {
      // 1.0001^point = raw price of token_x in token_y units.
      // Multiply by 10^(tokenDecimals - quoteDecimals) to get human-readable ratio.
      if (isTokenX) {
        priceInQuote = Math.pow(1.0001, currentPoint) * Math.pow(10, tokenDecimals - quoteDecimals);
      } else {
        priceInQuote = (1 / Math.pow(1.0001, currentPoint)) * Math.pow(10, tokenDecimals - quoteDecimals);
      }
    }

    // ── Convert quote-side reserves and price to NEAR ───────────────────────
    let quoteNearRate = 1; // quote units to NEAR
    let priceUnavailable = false;
    if (!quoteIsNear) {
      const cached = quoteNearPriceCache.get(quote);
      if (cached && Date.now() - cached.at < QUOTE_NEAR_PRICE_TTL_MS) {
        quoteNearRate = cached.rate;
      } else {
        try {
          quoteNearRate = await this.getQuoteNearPrice(quote, quoteDecimals);
          quoteNearPriceCache.set(quote, { at: Date.now(), rate: quoteNearRate });
        } catch {
          // No wrap.near<->quote pool found — cannot express value in NEAR.
          priceUnavailable = true;
          quoteNearRate = 0;
          quoteNearPriceCache.set(quote, { at: Date.now(), rate: 0 });
        }
      }
      if (quoteNearRate === 0) priceUnavailable = true;
    }

    const price = priceUnavailable ? 0 : priceInQuote * quoteNearRate;
    let reserveNearConverted = '0';
    if (!priceUnavailable) {
      if (quoteIsNear) {
        reserveNearConverted = reserveQuote || '0';
      } else {
        try {
          const rateBigIntTimes1e6 = BigInt(Math.round(quoteNearRate * 1e6));
          const rawQuote = BigInt(reserveQuote || '0');
          const scale = 24 - quoteDecimals;
          let yocto = (rawQuote * rateBigIntTimes1e6) / 1000000n;
          if (scale > 0) {
            yocto = yocto * (10n ** BigInt(scale));
          } else if (scale < 0) {
            yocto = yocto / (10n ** BigInt(-scale));
          }
          reserveNearConverted = yocto.toString();
        } catch {
          reserveNearConverted = '0';
        }
      }
    }
    const reserveQuoteNum = parseFloat(reserveQuote || '0') / Math.pow(10, quoteDecimals);
    const liquidityNear = priceUnavailable ? 0 : reserveQuoteNum * quoteNearRate * 2;

    const totalSupply = supplyOnChain && supplyOnChain !== '0' ? supplyOnChain : (launch.total_supply || '0');

    return {
      pool_id: launch.pool_id,
      dclPoolId: launch.pool_id,
      phase: bondingPhase,
      bonding_phase: bondingPhase,
      bondingProgressPct,
      bonding_progress_pct: bondingProgressPct,
      price,
      liquidityNear,
      reserveNear: reserveNearConverted,
      reserveToken: reserveToken || '0',
      totalSupply,
      quote,
      quoteDecimals,
      quoteIsNear,
      quoteSymbol,
      priceInQuote,
      reserveQuoteHuman: reserveQuoteNum,
      live,
      creator: launch.creator ?? '',
      ...(priceUnavailable ? { priceUnavailable: true } : {}),
    };
  }

  /**
   * Returns the price of one human-readable unit of `quoteToken` in NEAR.
   * Searches for a wrap.near <-> quoteToken pool via DCL and Ref AMM,
   * strictly prioritizing active pools with verified on-chain liquidity (> 0.1 NEAR)
   * to avoid picking dead or unseeded 0-liquidity pools.
   */
  private async getQuoteNearPrice(quoteToken: string, quoteDecimals: number): Promise<number> {
    // 1. Direct DCL pool on dclv2.ref-labs.near with verified liquidity (> 0.1 NEAR) — fast 1 RPC call
    const dclId = await this.findDclPoolId('wrap.near', quoteToken).catch(() => null);
    if (dclId) {
      try {
        const st = await this.getDclPoolState(dclId, 'wrap.near');
        if (st.price > 0 && st.liquidityNear > 0.1) return st.price;
      } catch { /* try other paths */ }
    }

    const pairedRate = await this.getPairedTokenNearRate(quoteToken).catch(() => null);
    if (pairedRate && pairedRate.rateInNear > 0) {
      return pairedRate.rateInNear;
    }

    // 2. If quoteToken is a NearlyTrade token itself (e.g. diarhea.nearlytrade.near), check its launchpad curve state
    if (quoteToken.endsWith('.nearlytrade.near')) {
      try {
        const ntLaunch = await this.view<any>('nearlytrade.near', 'get_launch_by_token', { token: quoteToken }).catch(() => null);
        if (ntLaunch && ntLaunch.pool_id) {
          const ntPool = await this.view<any>('dclv2.ref-labs.near', 'get_pool', { pool_id: ntLaunch.pool_id }).catch(() => null);
          if (ntPool && ntPool.current_point !== undefined && ntPool.current_point !== null) {
            const isTokenX = ntLaunch.token_is_x !== false;
            const quoteIsNear = !ntLaunch.quote || ntLaunch.quote === 'wrap.near' || ntLaunch.quote === 'near';
            const cp = Number(ntPool.current_point);
            if (!isNaN(cp)) {
              const baseP = isTokenX ? Math.pow(1.0001, cp) : (1 / Math.pow(1.0001, cp));
              if (quoteIsNear) {
                const p = baseP * Math.pow(10, quoteDecimals - 24);
                if (p > 0) return p;
              } else {
                let subQuoteDecimals = 18;
                try {
                  const sqMeta = await this.getTokenMetadata(ntLaunch.quote).catch(() => null);
                  if (sqMeta && typeof sqMeta.decimals === 'number') subQuoteDecimals = sqMeta.decimals;
                } catch { /* default 18 */ }
                const priceInSubQuote = baseP * Math.pow(10, quoteDecimals - subQuoteDecimals);
                const subQuoteRate = await this.getQuoteNearPrice(ntLaunch.quote, subQuoteDecimals).catch(() => 0);
                if (subQuoteRate > 0) {
                  return priceInSubQuote * subQuoteRate;
                }
              }
            }
          }
        }
      } catch { /* no-op */ }
    }

    // 3. Fallback: Ref AMM (v2.ref-finance.near) with liquidity validation
    const refId = await this.findRheaPoolId('wrap.near', quoteToken).catch(() => null);
    if (refId !== null && refId !== undefined) {
      const rh = await this.getRheaPoolReserves(refId, 'wrap.near', quoteToken).catch(() => null);
      if (rh) {
        const nearHuman = parseFloat(rh.reserveIn) / 1e24;
        const quoteHuman = parseFloat(rh.reserveOut) / Math.pow(10, quoteDecimals);
        const liqNear = nearHuman * 2;
        if (quoteHuman > 0 && liqNear > 0.1) return nearHuman / quoteHuman;
      }
    }

    // 4. Comprehensive pool finder: scans both DCL and Ref AMM, verifies on-chain liquidity
    try {
      const bestPool = await this.findRheaPoolForToken(quoteToken, false);
      if (bestPool && bestPool.price > 0 && bestPool.liquidityNear > 0.1) {
        return bestPool.price;
      }
    } catch { /* fallback to other avenues */ }

    // 5. Absolute last resort: if no pool has >0.1 NEAR liquidity, take any pool with price > 0
    if (refId !== null && refId !== undefined) {
      try {
        const rh = await this.getRheaPoolReserves(refId, 'wrap.near', quoteToken).catch(() => null);
        if (rh) {
          const nearHuman = parseFloat(rh.reserveIn) / 1e24;
          const quoteHuman = parseFloat(rh.reserveOut) / Math.pow(10, quoteDecimals);
          if (quoteHuman > 0 && nearHuman > 0) return nearHuman / quoteHuman;
        }
      } catch { /* no-op */ }
    }
    if (dclId) {
      try {
        const st = await this.getDclPoolState(dclId, 'wrap.near');
        if (st.price > 0) return st.price;
      } catch { /* no-op */ }
    }

    throw new Error(`No wrap.near<->${quoteToken} pool found`);
  }

  /**
   * Plan the routing for a NearlyTrade token trade from/to wNEAR.
   * Returns { kind: 'direct' } when the quote is wNEAR.
   * Returns { kind: 'multihop', quote, launchPoolId, hop1 } otherwise.
   * Throws if no wrap.near<->quote pool exists.
   */
  async planNearlytradeRoute(tokenAddress: string): Promise<
    | { kind: 'direct'; launchPoolId: string; quote: 'wrap.near' }
    | { kind: 'multihop'; quote: string; launchPoolId: string; hop1: { type: 'dcl' | 'v2'; poolId: string }; hop1Path?: string[] }
  > {
    const cachedRoute = ntRouteCache.get(tokenAddress);
    if (cachedRoute && Date.now() - cachedRoute.at < 600_000) {
      return cachedRoute.route;
    }

    const st = await this.getNearlytradeTokenState(tokenAddress);
    const launchPoolId = st.pool_id;

    if (st.quoteIsNear) {
      const res = { kind: 'direct' as const, launchPoolId, quote: 'wrap.near' as const };
      ntRouteCache.set(tokenAddress, { at: Date.now(), route: res });
      return res;
    }

    const quote = st.quote;

    // 0. The best hop from wNEAR to the quote by output: a DCL path (a thin direct NEAR/PRL pool filled buys
    // 43% worse than NEAR -> USDC -> PRL) or a Ref classic pool (RHEA and KAT are deeper there)
    const best = await this.bestNearHop(quote).catch(() => null);
    if (best) {
      const res = best.kind === 'dcl'
        ? { kind: 'multihop' as const, quote, launchPoolId, hop1: { type: 'dcl' as const, poolId: best.path[best.path.length - 1] }, hop1Path: best.path }
        : { kind: 'multihop' as const, quote, launchPoolId, hop1: { type: 'v2' as const, poolId: String(best.poolId) } };
      ntRouteCache.set(tokenAddress, { at: Date.now(), route: res });
      return res;
    }

    // 1. Fast path: Direct Ref DCL pool for wrap.near <-> quote (instant DCL resolution)
    const dclHop = await this.findDclPoolId('wrap.near', quote).catch(() => null);
    if (dclHop) {
      const dclState = await this.getDclPoolState(dclHop, 'wrap.near').catch(() => null);
      if (dclState && dclState.liquidityNear > 0.1) {
        const res = {
          kind: 'multihop' as const,
          quote,
          launchPoolId,
          hop1: { type: 'dcl' as const, poolId: dclHop },
        };
        ntRouteCache.set(tokenAddress, { at: Date.now(), route: res });
        return res;
      }
    }

    // 2. Fast path: Direct Ref v2 AMM pool for wrap.near <-> quote
    const refHop = await this.findRheaPoolId('wrap.near', quote).catch(() => null);
    if (refHop !== null && refHop !== undefined) {
      const res = {
        kind: 'multihop' as const,
        quote,
        launchPoolId,
        hop1: { type: 'v2' as const, poolId: String(refHop) },
      };
      ntRouteCache.set(tokenAddress, { at: Date.now(), route: res });
      return res;
    }

    // 3. Fallback: comprehensive search (using cached pools, not forceCheck=true)
    const rheaPool = await this.findRheaPoolForToken(quote, false).catch(() => null);
    if (
      rheaPool &&
      rheaPool.pairedToken === 'wrap.near' &&
      rheaPool.poolId !== null &&
      rheaPool.poolId !== undefined &&
      rheaPool.liquidityNear > 0
    ) {
      const res = {
        kind: 'multihop' as const,
        quote,
        launchPoolId,
        hop1: {
          type: rheaPool.isDcl ? ('dcl' as const) : ('v2' as const),
          poolId: String(rheaPool.poolId),
        },
      };
      ntRouteCache.set(tokenAddress, { at: Date.now(), route: res });
      return res;
    }

    // 4. Fallback: Ref v2 AMM pool if not yet found
    if (refHop !== null && refHop !== undefined) {
      const res = { kind: 'multihop' as const, quote, launchPoolId, hop1: { type: 'v2' as const, poolId: String(refHop) } };
      ntRouteCache.set(tokenAddress, { at: Date.now(), route: res });
      return res;
    }

    // 5. Fallback: DCL pool with verified liquidity
    if (dclHop) {
      const dclState = await this.getDclPoolState(dclHop, 'wrap.near').catch(() => null);
      if (dclState && dclState.liquidityNear > 0) {
        const res = { kind: 'multihop' as const, quote, launchPoolId, hop1: { type: 'dcl' as const, poolId: dclHop } };
        ntRouteCache.set(tokenAddress, { at: Date.now(), route: res });
        return res;
      }
    }

    throw new Error(
      `Token ${tokenAddress} is paired with ${quote}. No NEAR route to ${quote} was found, so it cannot be traded from NEAR.`
    );
  }

  /**
   * Simulate a swap on dex.intear.near (slimedragon.near/xyk).
   * Executes the exact on-chain math accounting for phantom liquidity and any
   * custom fee configuration (fixed, scheduled curves, dynamic, holder/creator fees).
   * Supports two-hop routes when the launch token is paired with token.intear.near.
   */
  async simulateIntearSwap(
    poolId: number,
    tokenAddress: string,
    amountIn: string | bigint,
    isBuy: boolean,
    pairedAsset: string = 'near'
  ): Promise<{ amountIn: string; amountOut: string } | null> {
    if (pairedAsset === 'token.intear.near') {
      const intearNearPoolId = (await this.findIntearPoolId('token.intear.near').catch(() => 274)) || 274;
      const intearNearBuf = Buffer.alloc(4);
      intearNearBuf.writeUInt32LE(intearNearPoolId, 0);
      const intearNearMsg = intearNearBuf.toString('base64');

      const targetPoolBuf = Buffer.alloc(4);
      targetPoolBuf.writeUInt32LE(poolId, 0);
      const targetPoolMsg = targetPoolBuf.toString('base64');

      try {
        if (isBuy) {
          // Hop 1: near -> token.intear.near on active pool
          const hop1 = await this.view<any>('dex.intear.near', 'simulate_swap_simple', {
            dex_id: 'slimedragon.near/xyk',
            message: intearNearMsg,
            asset_in: 'near',
            asset_out: 'nep141:token.intear.near',
            amount: { ExactIn: amountIn.toString() },
            trader: 'user.intear.near',
          });
          if (!Array.isArray(hop1) || hop1.length < 2) return null;
          const tearOut = String(hop1[1]);

          // Hop 2: token.intear.near -> targetToken on target pool
          const hop2 = await this.view<any>('dex.intear.near', 'simulate_swap_simple', {
            dex_id: 'slimedragon.near/xyk',
            message: targetPoolMsg,
            asset_in: 'nep141:token.intear.near',
            asset_out: `nep141:${tokenAddress}`,
            amount: { ExactIn: tearOut },
            trader: 'user.intear.near',
          });
          if (!Array.isArray(hop2) || hop2.length < 2) return null;
          return {
            amountIn: amountIn.toString(),
            amountOut: String(hop2[1]),
          };
        } else {
          // Hop 1: targetToken -> token.intear.near on target pool
          const hop1 = await this.view<any>('dex.intear.near', 'simulate_swap_simple', {
            dex_id: 'slimedragon.near/xyk',
            message: targetPoolMsg,
            asset_in: `nep141:${tokenAddress}`,
            asset_out: 'nep141:token.intear.near',
            amount: { ExactIn: amountIn.toString() },
            trader: 'user.intear.near',
          });
          if (!Array.isArray(hop1) || hop1.length < 2) return null;
          const tearOut = String(hop1[1]);

          // Hop 2: token.intear.near -> near on active pool
          const hop2 = await this.view<any>('dex.intear.near', 'simulate_swap_simple', {
            dex_id: 'slimedragon.near/xyk',
            message: intearNearMsg,
            asset_in: 'nep141:token.intear.near',
            asset_out: 'near',
            amount: { ExactIn: tearOut },
            trader: 'user.intear.near',
          });
          if (!Array.isArray(hop2) || hop2.length < 2) return null;
          return {
            amountIn: amountIn.toString(),
            amountOut: String(hop2[1]),
          };
        }
      } catch {
        return null;
      }
    }

    // Direct single hop (e.g. token.intear.near or near-paired token)
    const poolBuf = Buffer.alloc(4);
    poolBuf.writeUInt32LE(poolId, 0);
    const poolMsg = poolBuf.toString('base64');

    const assetIn = isBuy ? 'near' : `nep141:${tokenAddress}`;
    const assetOut = isBuy ? `nep141:${tokenAddress}` : 'near';

    try {
      const res = await this.view<any>('dex.intear.near', 'simulate_swap_simple', {
        dex_id: 'slimedragon.near/xyk',
        message: poolMsg,
        asset_in: assetIn,
        asset_out: assetOut,
        amount: { ExactIn: amountIn.toString() },
        trader: 'user.intear.near',
      });

      if (Array.isArray(res) && res.length >= 2) {
        return {
          amountIn: String(res[0]),
          amountOut: String(res[1]),
        };
      }
    } catch {
      // Fall back on simulation failure
    }
    return null;
  }

  /**
   * Find pool ID on dex.intear.near (slimedragon.near/xyk) for a token
   */
  async findIntearPoolId(tokenAddress: string): Promise<number> {
    if (intearPoolCache.has(tokenAddress)) {
      return intearPoolCache.get(tokenAddress)!;
    }

    // Check DB cache first
    try {
      const dbCached = await getTokenCache(tokenAddress);
      if (dbCached && dbCached.venue === 'intear') {
        const rawId = dbCached.rhea_pool_id ?? (dbCached.dcl_pool_id && !dbCached.dcl_pool_id.includes('|') ? parseInt(dbCached.dcl_pool_id, 10) : null);
        if (rawId !== null && !isNaN(rawId) && rawId >= 0) {
          intearPoolCache.set(tokenAddress, rawId);
          return rawId;
        }
      }
    } catch {}

    // Query live total pool count on dex.intear.near dynamically
    let totalPools = 300;
    try {
      const poolCountB64 = await this.view<string>('dex.intear.near', 'dex_view', {
        dex_id: 'slimedragon.near/xyk',
        method: 'get_pool_count',
        args: '',
      });
      if (poolCountB64) {
        const count = Buffer.from(poolCountB64, 'base64').readUInt32LE(0);
        if (count > 0) totalPools = count;
      }
    } catch {}

    // Scan pools from newest down in parallel batches of 25
    for (let start = totalPools - 1; start >= 0; start -= 25) {
      const promises: Promise<{ id: number; data: any } | null>[] = [];
      const batchEnd = Math.max(0, start - 24);
      for (let i = start; i >= batchEnd; i--) {
        const buf = Buffer.alloc(4);
        buf.writeUInt32LE(i, 0);
        promises.push(
          this.view<string>('dex.intear.near', 'dex_view', {
            dex_id: 'slimedragon.near/xyk',
            method: 'get_pool',
            args: buf.toString('base64'),
          })
            .then((res) => {
              if (!res) return null;
              const rawBytes = Buffer.from(typeof res === 'string' ? res : JSON.stringify(res), 'base64');
              const pool = parseIntearPool(rawBytes);
              return pool ? { id: i, data: pool } : null;
            })
            .catch(() => null)
        );
      }

      const results = await Promise.all(promises);
      for (const r of results) {
        if (r && r.data) {
          const isTokenIntear = tokenAddress === 'token.intear.near';
          const r1 = BigInt(r.data.reserve1 || '0');
          const r2 = BigInt(r.data.reserve2 || '0');

          if (r.data.asset1 === tokenAddress || r.data.asset2 === tokenAddress) {
            const paired = r.data.asset1 === tokenAddress ? r.data.asset2 : r.data.asset1;
            // Only accept pools paired with NEAR, wNEAR, or token.intear.near (for launch tokens)
            if (paired === 'near' || paired === 'wrap.near' || paired === 'token.intear.near') {
              // Ensure pool has liquidity if searching for token.intear.near
              if (isTokenIntear && (r1 === 0n || r2 === 0n)) {
                continue;
              }
              intearPoolCache.set(tokenAddress, r.id);
              setImmediate(() => {
                upsertTokenCache({
                  token_address: tokenAddress,
                  venue: 'intear',
                  rhea_pool_id: r.id,
                  dcl_pool_id: null,
                  updated_at: new Date(),
                }).catch(() => {});
              });
              return r.id;
            }
          }

          // Cache other launch tokens encountered along the way
          if (r.data.asset1 && r.data.asset1 !== 'near' && r.data.asset1 !== 'wrap.near' && r.data.asset1 !== 'token.intear.near' && r.data.asset1.includes('.near')) {
            intearPoolCache.set(r.data.asset1, r.id);
          }
          if (r.data.asset2 && r.data.asset2 !== 'near' && r.data.asset2 !== 'wrap.near' && r.data.asset2 !== 'token.intear.near' && r.data.asset2.includes('.near')) {
            intearPoolCache.set(r.data.asset2, r.id);
          }
        }
      }
    }

    if (tokenAddress === 'token.intear.near') {
      // Fallback to active pool 274 if scan didn't find one
      intearPoolCache.set('token.intear.near', 274);
      return 274;
    }

    throw new Error(`Intear pool for ${tokenAddress} not found on dex.intear.near`);
  }

  /**
   * Query Intear token state, reserves, real spot price, and liquidity on-chain.
   */
  async getIntearTokenState(tokenAddress: string): Promise<{
    poolId: number;
    poolMsg: string;
    pairedAsset: string;
    price: number;
    liquidityNear: number;
    reserveNear: string;
    reserveToken: string;
    feeBps: number;
    taxPct: number;
    name: string;
    symbol: string;
    decimals: number;
    totalSupply: string;
    launchData?: {
      telegram?: string | null;
      x?: string | null;
      website?: string | null;
      description?: string | null;
      launched_by?: string | null;
    };
  }> {
    const [meta, totalSupply] = await Promise.all([
      this.getTokenMetadata(tokenAddress).catch(() => ({
        name: tokenAddress.split('.')[0] || 'Unknown',
        symbol: (tokenAddress.split('.')[0] || 'TKN').toUpperCase(),
        decimals: 24,
        total_supply: '0',
      })),
      this.getTokenTotalSupply(tokenAddress).catch(() => '0'),
    ]);

    const poolId = await this.findIntearPoolId(tokenAddress);
    const poolBuf = Buffer.alloc(4);
    poolBuf.writeUInt32LE(poolId, 0);
    const poolMsg = poolBuf.toString('base64');

    const poolRaw = await this.view<string>('dex.intear.near', 'dex_view', {
      dex_id: 'slimedragon.near/xyk',
      method: 'get_pool',
      args: poolMsg,
    });

    if (!poolRaw) {
      throw new Error(`Failed to fetch Intear pool ${poolId}`);
    }

    const rawBytes = Buffer.from(typeof poolRaw === 'string' ? poolRaw : JSON.stringify(poolRaw), 'base64');
    const pool = parseIntearPool(rawBytes);
    if (!pool) {
      throw new Error(`Failed to parse Intear pool ${poolId}`);
    }

    const isToken1 = pool.asset1 === tokenAddress;
    const pairedAsset = isToken1 ? pool.asset2 : pool.asset1;
    const rawReserveToken = BigInt(isToken1 ? pool.reserve1 : pool.reserve2);
    const rawReservePaired = BigInt(isToken1 ? pool.reserve2 : pool.reserve1);

    const tokenDecimals = meta.decimals ?? 24;
    const tokenDecFactor = Math.pow(10, tokenDecimals);
    const tokenAmt = Number(rawReserveToken) / tokenDecFactor;

    let nearAmt = 0;
    let reserveNear = rawReservePaired;

    if (pairedAsset === 'near' || pairedAsset === 'wrap.near') {
      nearAmt = Number(rawReservePaired) / 1e24;
    } else if (pairedAsset === 'token.intear.near') {
      // If paired with token.intear.near, resolve INTEAR's live price in NEAR from active pool
      let intearPriceNear = 0.00515;
      try {
        const intearPoolId = (await this.findIntearPoolId('token.intear.near').catch(() => 274)) || 274;
        const intearBuf = Buffer.alloc(4);
        intearBuf.writeUInt32LE(intearPoolId, 0);
        const intearRaw = await this.view<string>('dex.intear.near', 'dex_view', {
          dex_id: 'slimedragon.near/xyk',
          method: 'get_pool',
          args: intearBuf.toString('base64'),
        });
        if (intearRaw) {
          const intearP = parseIntearPool(Buffer.from(typeof intearRaw === 'string' ? intearRaw : JSON.stringify(intearRaw), 'base64'));
          if (intearP && BigInt(intearP.reserve1) > 0n && BigInt(intearP.reserve2) > 0n) {
            const isTear1 = intearP.asset1 === 'token.intear.near';
            const tearRes = BigInt(isTear1 ? intearP.reserve1 : intearP.reserve2);
            const nearRes = BigInt(isTear1 ? intearP.reserve2 : intearP.reserve1);
            if (tearRes > 0n) {
              intearPriceNear = Number(nearRes) / Number(tearRes);
            }
          }
        }
      } catch {}
      const intearAmt = Number(rawReservePaired) / 1e24;
      nearAmt = intearAmt * intearPriceNear;
      reserveNear = BigInt(Math.floor(nearAmt * 1e24));
    } else {
      // Unknown paired asset: cannot assume 1:1 with NEAR!
      nearAmt = 0;
      reserveNear = 0n;
    }

    const price = tokenAmt > 0 ? nearAmt / tokenAmt : 0;
    const liquidityNear = nearAmt * 2;
    const feeBps = pool.feeBps ?? 210;
    const taxPct = feeBps / 100;

    const launchContract = tokenAddress.includes('launch-v2') ? 'launch-v2.intear.near' : 'launch.intear.near';
    let launchData = await this.view<any>(launchContract, 'get_launch_data', {
      token_account_id: tokenAddress,
    }).catch(() => undefined);

    if (!launchData && launchContract !== 'launch.intear.near') {
      launchData = await this.view<any>('launch.intear.near', 'get_launch_data', {
        token_account_id: tokenAddress,
      }).catch(() => undefined);
    }

    const finalSupply = (totalSupply && totalSupply !== '0') ? totalSupply : (meta as any).total_supply || '0';

    return {
      poolId,
      poolMsg,
      pairedAsset: pairedAsset || 'near',
      price,
      liquidityNear,
      reserveNear: reserveNear.toString(),
      reserveToken: rawReserveToken.toString(),
      feeBps,
      taxPct,
      name: meta.name,
      symbol: meta.symbol,
      decimals: tokenDecimals,
      totalSupply: finalSupply,
      launchData,
    };
  }

  /**
   * Check if assets are registered on dex.intear.near for a user account.
   */
  async areIntearAssetsRegistered(accountId: string, assetIds: string[]): Promise<boolean> {
    if (!assetIds || assetIds.length === 0) return true;
    try {
      const formatted = assetIds.map(a => (a === 'near' || a.startsWith('nep141:') ? a : `nep141:${a}`));
      return await this.view<boolean>('dex.intear.near', 'are_assets_registered', {
        asset_ids: formatted,
        for: { Account: accountId },
      });
    } catch {
      return false;
    }
  }

  /**
   * Get user storage balance on dex.intear.near.
   */
  async getIntearStorageBalance(accountId: string): Promise<{ total: string; available: string } | null> {
    try {
      return await this.view<any>('dex.intear.near', 'storage_balance_of', {
        account_id: accountId,
      });
    } catch {
      return null;
    }
  }

  /**
   * Ensure an asset is registered for the account on dex.intear.near.
   * If not registered, performs storage_deposit (if available < 0.002 NEAR) and register_assets.
   */
  async ensureIntearAssetRegistered(accountId: string, assetId: string): Promise<void> {
    const formattedAsset = assetId === 'near' || assetId.startsWith('nep141:') ? assetId : `nep141:${assetId}`;
    const cacheKey = `${accountId}:${formattedAsset}`;
    if (intearRegisteredCache.has(cacheKey)) return;

    const isRegistered = await this.areIntearAssetsRegistered(accountId, [formattedAsset]).catch(() => false);
    if (isRegistered) {
      intearRegisteredCache.add(cacheKey);
      return;
    }

    const storageBal = await this.getIntearStorageBalance(accountId).catch(() => null);
    const available = BigInt(storageBal?.available ?? '0');
    const actions: any[] = [];

    // dex.intear.near requires min 0.005 NEAR storage deposit. Each registered asset costs ~0.001 NEAR.
    if (available < BigInt('2000000000000000000000')) {
      actions.push(
        transactions.functionCall(
          'storage_deposit',
          { account_id: accountId },
          BigInt('30000000000000'),
          BigInt('5000000000000000000000') // 0.005 NEAR
        )
      );
    }

    actions.push(
      transactions.functionCall(
        'register_assets',
        { asset_ids: [formattedAsset] },
        BigInt('30000000000000'),
        BigInt('1') // 1 yoctoNEAR
      )
    );

    await this.signAndSendTransactionAll(accountId, 'dex.intear.near', actions);
    intearRegisteredCache.add(cacheKey);
  }

  markIntearAssetRegistered(accountId: string, assetId: string): void {
    const formattedAsset = assetId === 'near' || assetId.startsWith('nep141:') ? assetId : `nep141:${assetId}`;
    intearRegisteredCache.add(`${accountId}:${formattedAsset}`);
  }

  /**
   * Compute expected output and min_amount_out dynamically from live pool reserves.
   * Never uses cached reserves older than the call itself.
   */
  async computeMinAmountOut(
    venue: 'rhea' | 'ref' | 'shardsmarket' | 'nearlytrade' | 'intear' | 'memecooking' | 'onetokenhub' | 'gaypad' | 'nearpad' | 'shoremarkets' | 'kelytra' | 'nearpumpfun' | 'qlyphs',
    tokenIn: string,
    tokenOut: string,
    amountIn: string,
    slippagePct: number = 2,
    rheaPoolId?: number | null,
    dclPoolId?: string | null
  ): Promise<{ expectedOutput: string; minAmountOut: string }> {
    if (venue === 'memecooking') {
      const targetToken = tokenIn === 'wrap.near' || tokenIn === 'near' ? tokenOut : tokenIn;

      // Fast path: if Rhea pool or DCL pool is already known, quote Rhea immediately
      if (rheaPoolId !== null && rheaPoolId !== undefined) {
        return this.computeMinAmountOut('rhea', tokenIn, tokenOut, amountIn, slippagePct, typeof rheaPoolId === 'number' ? rheaPoolId : null, dclPoolId);
      }

      // Check pre-bonded Meme.Cooking launchpad curve first (instant 1-view call)
      const memeId = parseMemeCookingId(targetToken);
      const meme = memeId !== null ? await this.view<any>('meme-cooking.near', 'get_meme', { meme_id: memeId }).catch(() => null) : null;

      if (meme) {
        // If meme is already bonded/graduated to Rhea DEX, find the Rhea pool
        if (meme.pool_id || meme.has_bonded || meme.status === 'Bonded') {
          const rhea = await this.findRheaPoolForToken(targetToken).catch(() => null);
          if (rhea && rhea.poolId !== null && rhea.poolId !== undefined && rhea.price > 0) {
            return this.computeMinAmountOut('rhea', tokenIn, tokenOut, amountIn, slippagePct, typeof rhea.poolId === 'number' ? rhea.poolId : null, rhea.isDcl ? String(rhea.poolId) : null);
          }
        }

        const hardCap = BigInt(meme.hard_cap || '100000000000000000000000000');
        const tokensToDistribute = BigInt(meme.amount_to_be_distributed || meme.total_supply || '0');
        const isBuy = tokenIn === 'wrap.near' || tokenIn === 'near';

        let expected = 0n;
        if (isBuy) {
          const amountInBI = BigInt(amountIn);
          if (hardCap > 0n && tokensToDistribute > 0n) {
            expected = (amountInBI * tokensToDistribute) / hardCap;
          }
        } else {
          expected = BigInt(amountIn);
        }

        const minOut = calculateMinAmountOut(expected, slippagePct);
        return { expectedOutput: expected.toString(), minAmountOut: minOut };
      }

      // If meme was not found on launchpad, check Rhea DEX as fallback
      const rhea = await this.findRheaPoolForToken(targetToken).catch(() => null);
      if (rhea && rhea.poolId !== null && rhea.poolId !== undefined && rhea.price > 0) {
        return this.computeMinAmountOut('rhea', tokenIn, tokenOut, amountIn, slippagePct, typeof rhea.poolId === 'number' ? rhea.poolId : null, rhea.isDcl ? String(rhea.poolId) : null);
      }

      throw new Error(`Meme.Cooking token ${targetToken} is not active and has no DEX pool.`);
    } else if (venue === 'shardsmarket') {
      const targetToken = tokenIn === 'wrap.near' ? tokenOut : tokenIn;
      const reserves = await this.getShardsmarketPoolReserves(targetToken);
      const reserveNear = BigInt(reserves.reserveNear);
      const reserveToken = BigInt(reserves.reserveToken);

      const isBuy = tokenIn === 'wrap.near';
      const reserveIn = isBuy ? reserveNear : reserveToken;
      const reserveOut = isBuy ? reserveToken : reserveNear;

      const expected = calculateExpectedOutput(amountIn, reserveIn, reserveOut);
      const minOut = calculateMinAmountOut(expected, slippagePct);
      return { expectedOutput: expected.toString(), minAmountOut: minOut };
    } else if (venue === 'shoremarkets') {
      const targetToken = tokenIn === 'wrap.near' || tokenIn === 'near' ? tokenOut : tokenIn;
      const inToken = tokenIn === 'near' ? 'wrap.near' : tokenIn;
      const outToken = tokenOut === 'near' ? 'wrap.near' : tokenOut;

      let state;
      try {
        state = await this.getShoremarketsTokenState(targetToken);
      } catch (smErr) {
        // Fallback: try Rhea pool if token has graduated
        const rhea = await this.findRheaPoolForToken(targetToken).catch(() => null);
        if (rhea && typeof rhea.poolId === 'number') {
          return this.computeMinAmountOut('rhea', tokenIn, tokenOut, amountIn, slippagePct, rhea.poolId);
        }
        throw smErr;
      }

      // Non-NEAR quote (e.g. USDC, USDT) -> multi-hop quote
      if (!state.quoteIsNear) {
        const route = await this.planShoremarketsRoute(targetToken);
        if (route.kind !== 'multihop') {
          throw new Error(`Expected multihop route for non-NEAR quote ShoreMarkets token ${targetToken} but got '${route.kind}'`);
        }
        const launchPoolId = state.pool_id;
        const isBuy = tokenIn === 'wrap.near' || tokenIn === 'near';

        if (isBuy) {
          if (route.hop1.type === 'dcl') {
            // Atomic multi-pool quote on dclv2.ref-labs.near: wrap.near -> quote -> launch token
            const q = await this.view<any>('dclv2.ref-labs.near', 'quote', {
              // The whole path from wNEAR (e.g. NEAR -> USDC -> PRL), not only its last pool
              pool_ids: [...(route.hop1Path ?? [route.hop1.poolId]), launchPoolId],
              input_token: 'wrap.near',
              output_token: outToken,
              input_amount: amountIn,
            });
            const finalOut = BigInt(q?.amount || '0');
            if (finalOut <= 0n) throw new Error('ShoreMarkets DCL multi-hop quote returned 0');
            const minFinal = calculateMinAmountOut(finalOut, slippagePct);
            return { expectedOutput: finalOut.toString(), minAmountOut: minFinal };
          } else {
            // Fallback: Hop 1 on Ref v2 AMM
            const ret = await this.view<string>('v2.ref-finance.near', 'get_return', {
              pool_id: Number(route.hop1.poolId),
              token_in: 'wrap.near',
              amount_in: amountIn,
              token_out: route.quote,
            });
            const hop1Out = ret || '0';
            if (BigInt(hop1Out) <= 0n) throw new Error('Hop1 quote returned 0');

            // Hop 2: quote -> launch token on DCL
            const q2 = await this.view<any>('dclv2.ref-labs.near', 'quote', {
              pool_ids: [launchPoolId],
              input_token: route.quote,
              output_token: outToken,
              input_amount: hop1Out,
            });
            const finalOut = BigInt(q2?.amount || '0');
            if (finalOut <= 0n) throw new Error('Hop2 quote returned 0');
            const minHop1 = calculateMinAmountOut(BigInt(hop1Out), slippagePct);
            const minFinal = calculateMinAmountOut(finalOut, slippagePct);
            return { expectedOutput: finalOut.toString(), minAmountOut: minFinal, minHop1AmountOut: minHop1 } as any;
          }
        } else {
          if (route.hop1.type === 'dcl') {
            // Atomic multi-pool sell quote on dclv2.ref-labs.near: launch token -> quote -> wrap.near
            const q = await this.view<any>('dclv2.ref-labs.near', 'quote', {
              pool_ids: [launchPoolId, ...(route.hop1Path ? [...route.hop1Path].reverse() : [route.hop1.poolId])],
              input_token: inToken,
              output_token: 'wrap.near',
              input_amount: amountIn,
            });
            const finalOut = BigInt(q?.amount || '0');
            if (finalOut <= 0n) throw new Error('ShoreMarkets DCL multi-hop sell quote returned 0');
            const minFinal = calculateMinAmountOut(finalOut, slippagePct);
            return { expectedOutput: finalOut.toString(), minAmountOut: minFinal };
          } else {
            // Fallback: Hop 1 on DCL
            const q1 = await this.view<any>('dclv2.ref-labs.near', 'quote', {
              pool_ids: [launchPoolId],
              input_token: inToken,
              output_token: route.quote,
              input_amount: amountIn,
            });
            const hop1Out = q1?.amount || '0';
            if (BigInt(hop1Out) <= 0n) throw new Error('Hop1 sell quote returned 0');

            // Hop 2 on Ref v2 AMM
            const ret = await this.view<string>('v2.ref-finance.near', 'get_return', {
              pool_id: Number(route.hop1.poolId),
              token_in: route.quote,
              amount_in: hop1Out,
              token_out: 'wrap.near',
            });
            const finalOut = BigInt(ret || '0');
            if (finalOut <= 0n) throw new Error('Hop2 sell quote returned 0');
            const minHop1 = calculateMinAmountOut(BigInt(hop1Out), slippagePct);
            const minFinal = calculateMinAmountOut(finalOut, slippagePct);
            return { expectedOutput: finalOut.toString(), minAmountOut: minFinal, minHop1AmountOut: minHop1 } as any;
          }
        }
      }

      // Single-hop (quote is wNEAR)
      if (state.dclPoolId) {
        try {
          const quoteRes = await this.view<any>('dclv2.ref-labs.near', 'quote', {
            pool_ids: [state.dclPoolId],
            input_token: inToken,
            output_token: outToken,
            input_amount: amountIn,
          });
          const expected = BigInt(quoteRes?.amount || '0');
          if (expected > 0n) {
            const minOut = calculateMinAmountOut(expected, slippagePct);
            return { expectedOutput: expected.toString(), minAmountOut: minOut };
          }
        } catch {
          // quote view failed — fall through
        }
      }

      const reserveNear = BigInt(state.reserveNear);
      const reserveToken = BigInt(state.reserveToken);
      const isBuy = tokenIn === 'wrap.near' || tokenIn === 'near';
      const reserveIn = isBuy ? reserveNear : reserveToken;
      const reserveOut = isBuy ? reserveToken : reserveNear;
      const expected = calculateExpectedOutput(amountIn, reserveIn, reserveOut, 100);
      const minOut = calculateMinAmountOut(expected, slippagePct);
      return { expectedOutput: expected.toString(), minAmountOut: minOut };
    } else if (venue === 'rhea' || venue === 'ref' || venue === 'qlyphs') {
      const inToken = tokenIn === 'near' ? 'wrap.near' : tokenIn;
      const outToken = tokenOut === 'near' ? 'wrap.near' : tokenOut;
      // A launchpad pool paired with another token (PRL...) is quoted along the full path from wNEAR
      if (dclPoolId) {
        dclPoolId = await this.expandDclPoolFromNear(dclPoolId, inToken === 'wrap.near' ? outToken : inToken).catch(() => dclPoolId!);
      }

      if (dclPoolId) {
        const isMultiDcl = dclPoolId.includes('>') || dclPoolId.includes(',');
        if (isMultiDcl) {
          const isBuy = inToken === 'wrap.near';
          const poolIds = isBuy
            ? (dclPoolId.includes('>') ? dclPoolId.split('>') : dclPoolId.split(','))
            : (dclPoolId.includes('>') ? dclPoolId.split('>').reverse() : dclPoolId.split(',').reverse());
          try {
            const quote = await this.view<any>('dclv2.ref-labs.near', 'quote', {
              pool_ids: poolIds,
              input_token: inToken,
              output_token: outToken,
              input_amount: amountIn,
            });
            const expected = BigInt(quote?.amount || '0');
            if (expected > 0n) {
              const minOut = calculateMinAmountOut(expected, slippagePct);
              return { expectedOutput: expected.toString(), minAmountOut: minOut };
            }
          } catch {
            // fallback to discovery below
          }
        } else {
          const poolTokens = dclPoolId.split('|').slice(0, 2);
          const hasTokens = (poolTokens.includes(inToken) || (inToken === 'wrap.near' && poolTokens.includes('wrap.near'))) &&
                            poolTokens.includes(outToken);
          if (hasTokens) {
            try {
              const quote = await this.view<any>('dclv2.ref-labs.near', 'quote', {
                pool_ids: [dclPoolId],
                input_token: inToken,
                output_token: outToken,
                input_amount: amountIn,
              });
              const expected = BigInt(quote?.amount || '0');
              if (expected > 0n) {
                const minOut = calculateMinAmountOut(expected, slippagePct);
                return { expectedOutput: expected.toString(), minAmountOut: minOut };
              }
            } catch {
              // fallback to simple pool if quote view fails
            }
          }
        }
      }
      let poolId = rheaPoolId;
      const targetToken = tokenIn === 'wrap.near' || tokenIn === 'near' ? tokenOut : tokenIn;

      // FAST PATH: If poolId is already known, test it directly with get_return in 1 RPC call (<100ms)!
      if (typeof poolId === 'number' && poolId >= 0) {
        try {
          const ret = await this.view<string>('v2.ref-finance.near', 'get_return', {
            pool_id: poolId,
            token_in: inToken,
            amount_in: amountIn,
            token_out: outToken,
          });
          const expected = BigInt(ret || '0');
          if (expected > 0n) {
            const minOut = calculateMinAmountOut(expected, slippagePct);
            return { expectedOutput: expected.toString(), minAmountOut: minOut };
          }
        } catch {
          // get_return failed on this poolId — fall through to multi-hop / discovery
        }
      }

      // Reused below: when the catch branch already fetched pool state, don't
      // pay for a second findRheaPoolForToken round trip.
      let rheaState: Awaited<ReturnType<typeof this.findRheaPoolForToken>> | undefined;
      if (poolId === null || poolId === undefined) {
        try {
          poolId = await this.findRheaPoolId(tokenIn, tokenOut);
        } catch {
          rheaState = await this.findRheaPoolForToken(targetToken);
          if (rheaState && typeof rheaState.poolId === 'number') poolId = rheaState.poolId;
        }
      }

      if (rheaState === undefined) {
        rheaState = await this.findRheaPoolForToken(targetToken).catch(() => null);
      }

      if (rheaState && rheaState.isDcl) {
        const dclId = String(rheaState.poolId);
        const interToken = rheaState.intermediateToken;
        const interPoolId = rheaState.intermediatePoolId;

        const isBuy = inToken === 'wrap.near';
        const isMultiDcl = dclId.includes('>') || dclId.includes(',');
        if (isMultiDcl) {
          const poolIds = isBuy
            ? (dclId.includes('>') ? dclId.split('>') : dclId.split(','))
            : (dclId.includes('>') ? dclId.split('>').reverse() : dclId.split(',').reverse());
          try {
            const quoteRes = await this.view<any>('dclv2.ref-labs.near', 'quote', {
              pool_ids: poolIds,
              input_token: inToken,
              output_token: outToken,
              input_amount: amountIn,
            });
            const expected = BigInt(quoteRes?.amount || '0');
            if (expected > 0n) {
              const minOut = calculateMinAmountOut(expected, slippagePct);
              return { expectedOutput: expected.toString(), minAmountOut: minOut };
            }
          } catch (err: any) {
            console.warn(`[computeMinAmountOut] Multi-DCL quote error for pool ${dclId}:`, err?.message || err);
          }
          throw new Error(`Insufficient liquidity in Ref DCL route (${dclId}) — pool has zero active liquidity or has been drained.`);
        } else if (!interToken || rheaState.pairedToken === 'wrap.near') {
          try {
            const quoteRes = await this.view<any>('dclv2.ref-labs.near', 'quote', {
              pool_ids: [dclId],
              input_token: inToken,
              output_token: outToken,
              input_amount: amountIn,
            });
            const expected = BigInt(quoteRes?.amount || '0');
            if (expected > 0n) {
              const minOut = calculateMinAmountOut(expected, slippagePct);
              return { expectedOutput: expected.toString(), minAmountOut: minOut };
            }
          } catch (err: any) {
            console.warn(`[computeMinAmountOut] DCL quote error for pool ${dclId}:`, err?.message || err);
          }
          throw new Error(`Insufficient liquidity in Ref DCL pool (${dclId}) — pool has zero active liquidity or has been drained.`);
        } else if (interToken && interPoolId) {
          if (isBuy) {
            const hop1Out = await this.view<string>('v2.ref-finance.near', 'get_return', {
              pool_id: interPoolId,
              token_in: 'wrap.near',
              amount_in: amountIn,
              token_out: interToken,
            }).catch(() => null);

            if (hop1Out) {
              const quoteRes = await this.view<any>('dclv2.ref-labs.near', 'quote', {
                pool_ids: [dclId],
                input_token: interToken,
                output_token: outToken,
                input_amount: hop1Out,
              }).catch(() => null);

              const expected = BigInt(quoteRes?.amount || '0');
              if (expected > 0n) {
                const minOut = calculateMinAmountOut(expected, slippagePct);
                return { expectedOutput: expected.toString(), minAmountOut: minOut };
              }
            }
          } else {
            const quoteRes = await this.view<any>('dclv2.ref-labs.near', 'quote', {
              pool_ids: [dclId],
              input_token: inToken,
              output_token: interToken,
              input_amount: amountIn,
            }).catch(() => null);

            const hop1Out = quoteRes?.amount ? String(quoteRes.amount) : null;
            if (hop1Out) {
              const hop2Out = await this.view<string>('v2.ref-finance.near', 'get_return', {
                pool_id: interPoolId,
                token_in: interToken,
                amount_in: hop1Out,
                token_out: 'wrap.near',
              }).catch(() => null);

              const expected = BigInt(hop2Out || '0');
              if (expected > 0n) {
                const minOut = calculateMinAmountOut(expected, slippagePct);
                return { expectedOutput: expected.toString(), minAmountOut: minOut };
              }
            }
          }
          throw new Error(`Insufficient liquidity in Ref DCL route (${dclId}) — pool has zero active liquidity or has been drained.`);
        }
      }

      if (rheaState && rheaState.intermediateToken && rheaState.intermediatePoolId) {
        const interToken = rheaState.intermediateToken;
        const interPoolId = rheaState.intermediatePoolId;
        const targetPoolId = typeof rheaState.poolId === 'number' ? rheaState.poolId : poolId;

        const isBuy = inToken === 'wrap.near';
        if (isBuy && targetPoolId !== null && targetPoolId !== undefined) {
          const hop1Out = await this.view<string>('v2.ref-finance.near', 'get_return', {
            pool_id: interPoolId,
            token_in: 'wrap.near',
            amount_in: amountIn,
            token_out: interToken,
          }).catch(() => null);

          if (hop1Out) {
            const hop2Out = await this.view<string>('v2.ref-finance.near', 'get_return', {
              pool_id: targetPoolId,
              token_in: interToken,
              amount_in: hop1Out,
              token_out: outToken,
            }).catch(() => null);

            const expected = BigInt(hop2Out || '0');
            if (expected > 0n) {
              const minOut = calculateMinAmountOut(expected, slippagePct);
              return { expectedOutput: expected.toString(), minAmountOut: minOut };
            }
          }
        } else if (!isBuy && targetPoolId !== null && targetPoolId !== undefined) {
          const hop1Out = await this.view<string>('v2.ref-finance.near', 'get_return', {
            pool_id: targetPoolId,
            token_in: inToken,
            amount_in: amountIn,
            token_out: interToken,
          }).catch(() => null);

          if (hop1Out) {
            const hop2Out = await this.view<string>('v2.ref-finance.near', 'get_return', {
              pool_id: interPoolId,
              token_in: interToken,
              amount_in: hop1Out,
              token_out: 'wrap.near',
            }).catch(() => null);

            const expected = BigInt(hop2Out || '0');
            if (expected > 0n) {
              const minOut = calculateMinAmountOut(expected, slippagePct);
              return { expectedOutput: expected.toString(), minAmountOut: minOut };
            }
          }
        }
      }

      if (typeof poolId === 'number' && poolId >= 0) {
        // Try on-chain get_return on v2.ref-finance.near first (supports SIMPLE_POOL, STABLE_SWAP, RATED_SWAP)
        try {
          const ret = await this.view<string>('v2.ref-finance.near', 'get_return', {
            pool_id: poolId,
            token_in: inToken,
            amount_in: amountIn,
            token_out: outToken,
          });
          const expected = BigInt(ret || '0');
          if (expected > 0n) {
            const minOut = calculateMinAmountOut(expected, slippagePct);
            return { expectedOutput: expected.toString(), minAmountOut: minOut };
          }
        } catch {
          // Fallback to local reserve calculation
        }

        const reserves = await this.getRheaPoolReserves(poolId, tokenIn, tokenOut);
        const reserveIn = BigInt(reserves.reserveIn);
        const reserveOut = BigInt(reserves.reserveOut);

        const expected = calculateExpectedOutput(amountIn, reserveIn, reserveOut, reserves.fee);
        const minOut = calculateMinAmountOut(expected, slippagePct);
        return { expectedOutput: expected.toString(), minAmountOut: minOut };
      }

      if (rheaState && rheaState.price > 0) {
        const isBuy = inToken === 'wrap.near';
        const targetMeta = await this.getTokenMetadata(targetToken).catch(() => ({ decimals: 18 }));
        const targetDecimals = targetMeta?.decimals ?? 18;
        let expectedBI = 0n;
        if (isBuy) {
          const amountInNear = parseFloat(amountIn) / 1e24;
          const tokensOut = amountInNear / rheaState.price;
          expectedBI = BigInt(Math.floor(tokensOut * Math.pow(10, targetDecimals)));
        } else {
          const tokensIn = parseFloat(amountIn) / Math.pow(10, targetDecimals);
          const nearOut = tokensIn * rheaState.price;
          expectedBI = BigInt(Math.floor(nearOut * 1e24));
        }
        if (expectedBI > 0n) {
          const minOut = calculateMinAmountOut(expectedBI, slippagePct);
          return { expectedOutput: expectedBI.toString(), minAmountOut: minOut };
        }
      }

      throw new Error(`No active liquidity pool found for token ${outToken} on Rhea / Ref Finance.`);
    } else if (venue === 'nearlytrade') {
      const targetToken = tokenIn === 'wrap.near' || tokenIn === 'near' ? tokenOut : tokenIn;
      const inToken = tokenIn === 'near' ? 'wrap.near' : tokenIn;
      const outToken = tokenOut === 'near' ? 'wrap.near' : tokenOut;

      // FAST PATH: If dclPoolId is known and direct wNEAR-paired, quote dclv2.ref-labs.near directly in 1 RPC call!
      if (dclPoolId && (dclPoolId.includes('wrap.near') || dclPoolId.includes('|wrap.near|'))) {
        try {
          const quoteRes = await this.view<any>('dclv2.ref-labs.near', 'quote', {
            pool_ids: [dclPoolId],
            input_token: inToken,
            output_token: outToken,
            input_amount: amountIn,
          });
          const expected = BigInt(quoteRes?.amount || '0');
          if (expected > 0n) {
            const minOut = calculateMinAmountOut(expected, slippagePct);
            return { expectedOutput: expected.toString(), minAmountOut: minOut };
          }
        } catch {
          // quote view failed — fall through to full NearlyTrade resolution
        }
      }

      let state;
      try {
        state = await this.getNearlytradeTokenState(targetToken);
      } catch {
        // If NearlyTrade RPC fails, check if Rhea has a pool as fallback
        try {
          const rheaPoolId = await this.findRheaPoolId(tokenIn, tokenOut);
          if (rheaPoolId) {
            const ret = await this.view<string>('v2.ref-finance.near', 'get_return', {
              pool_id: rheaPoolId,
              token_in: inToken,
              amount_in: amountIn,
              token_out: outToken,
            });
            const expected = BigInt(ret || '0');
            if (expected > 0n) {
              const minOut = calculateMinAmountOut(expected, slippagePct);
              return { expectedOutput: expected.toString(), minAmountOut: minOut };
            }
          }
        } catch {
          // Ignore Rhea lookup errors
        }
        throw new Error(
          `NearlyTrade token ${targetToken} is not yet bonded and has no Rhea pool. Wait for bonding or pool creation.`
        );
      }

      // ── Multi-hop quoting for non-NEAR quote assets ──────────────────────
      if (!state.quoteIsNear) {
        const isBuyDirection = inToken === 'wrap.near';
        const launchPoolId = state.dclPoolId;

        try {
          const route = await this.planNearlytradeRoute(targetToken);
          if (route.kind === 'multihop') {
            if (route.hop1.type === 'dcl') {
              // Native atomic 2-pool quote on dclv2.ref-labs.near
              // The whole path from wNEAR (e.g. NEAR -> USDC -> PRL), not only its last pool
              const poolIds = isBuyDirection
                ? [...(route.hop1Path ?? [route.hop1.poolId]), launchPoolId]
                : [launchPoolId, ...(route.hop1Path ? [...route.hop1Path].reverse() : [route.hop1.poolId])];
              const q = await this.view<any>('dclv2.ref-labs.near', 'quote', {
                pool_ids: poolIds,
                input_token: inToken,
                output_token: outToken,
                input_amount: amountIn,
              });
              const finalOut = BigInt(q?.amount || '0');
              if (finalOut <= 0n) throw new Error('Atomic multi-hop DCL quote returned 0');
              const minFinal = calculateMinAmountOut(finalOut, slippagePct);
              return { expectedOutput: finalOut.toString(), minAmountOut: minFinal };
            }

            if (isBuyDirection) {
              // Hop 1: wNEAR → quote (v2 AMM)
              const ret = await this.view<string>('v2.ref-finance.near', 'get_return', {
                pool_id: Number(route.hop1.poolId),
                token_in: 'wrap.near',
                amount_in: amountIn,
                token_out: route.quote,
              });
              const hop1Out = ret || '0';
              if (BigInt(hop1Out) <= 0n) throw new Error('Hop1 quote returned 0');
              // Hop 2: quote → launch token (DCL)
              const q2 = await this.view<any>('dclv2.ref-labs.near', 'quote', {
                pool_ids: [launchPoolId],
                input_token: route.quote,
                output_token: outToken,
                input_amount: hop1Out,
              });
              const finalOut = BigInt(q2?.amount || '0');
              if (finalOut <= 0n) throw new Error('Hop2 quote returned 0');
              const minHop1 = calculateMinAmountOut(BigInt(hop1Out), slippagePct);
              const minFinal = calculateMinAmountOut(finalOut, slippagePct);
              return { expectedOutput: finalOut.toString(), minAmountOut: minFinal, minHop1AmountOut: minHop1 } as any;
            } else {
              // Sell direction: launch token → quote (DCL) → wNEAR (v2 AMM)
              const q1 = await this.view<any>('dclv2.ref-labs.near', 'quote', {
                pool_ids: [launchPoolId],
                input_token: inToken,
                output_token: route.quote,
                input_amount: amountIn,
              });
              const hop1Out = q1?.amount || '0';
              if (BigInt(hop1Out) <= 0n) throw new Error('Hop1 sell quote returned 0');
              const ret = await this.view<string>('v2.ref-finance.near', 'get_return', {
                pool_id: Number(route.hop1.poolId),
                token_in: route.quote,
                amount_in: hop1Out,
                token_out: 'wrap.near',
              });
              const finalOut = ret || '0';
              if (BigInt(finalOut) <= 0n) throw new Error('Hop2 sell quote returned 0');
              const minHop1 = calculateMinAmountOut(BigInt(hop1Out), slippagePct);
              const minFinal = calculateMinAmountOut(BigInt(finalOut), slippagePct);
              return { expectedOutput: finalOut.toString(), minAmountOut: minFinal, minHop1AmountOut: minHop1 } as any;
            }
          }
        } catch (routeErr: any) {
          // If it's a 'No NEAR route' error, rethrow clearly. Otherwise fall through.
          if ((routeErr as Error).message?.includes('No NEAR route')) throw routeErr;
          throw new Error(
            `NearlyTrade multi-hop quote failed for ${targetToken} (quote=${state.quote}): ${(routeErr as Error).message}`
          );
        }
      }

      // ── Single-hop (quote is wNEAR) ─────────────────────────────────────
      // NearlyTrade liquidity is a DCL bonding curve (single-sided concentrated
      // liquidity over a point range), so xyk reserve math systematically
      // overestimates output for trades that move the point — producing a
      // min_amount_out the pool can never satisfy. Quote from the same DCL view
      // the executor swaps against, and only fall back to reserve math when the
      // quote view is unavailable.
      if (state.dclPoolId) {
        try {
          const quoteRes = await this.view<any>('dclv2.ref-labs.near', 'quote', {
            pool_ids: [state.dclPoolId],
            input_token: inToken,
            output_token: outToken,
            input_amount: amountIn,
          });
          const expected = BigInt(quoteRes?.amount || '0');
          if (expected > 0n) {
            const minOut = calculateMinAmountOut(expected, slippagePct);
            return { expectedOutput: expected.toString(), minAmountOut: minOut };
          }
        } catch {
          // quote view failed — fall through to reserve math
        }
      }

      // Reserve math fallback is only valid for NEAR-paired pools.
      // For non-NEAR quotes we would need the quote price to convert — skip.
      if (!state.quoteIsNear) {
        throw new Error(
          `NearlyTrade multi-hop quote unavailable for ${targetToken} (quote=${state.quote}). Cannot fall back to reserve math for non-NEAR quote assets.`
        );
      }

      const reserveNear = BigInt(state.reserveNear);
      const reserveToken = BigInt(state.reserveToken);

      const isBuy = tokenIn === 'wrap.near';
      const reserveIn = isBuy ? reserveNear : reserveToken;
      const reserveOut = isBuy ? reserveToken : reserveNear;

      // NearlyTrade DCL pools have 1% pool fee (100 bps)
      const expected = calculateExpectedOutput(amountIn, reserveIn, reserveOut, 100);
      const minOut = calculateMinAmountOut(expected, slippagePct);
      return { expectedOutput: expected.toString(), minAmountOut: minOut };
    } else if (venue === 'intear') {
      const targetToken = (tokenIn === 'wrap.near' || tokenIn === 'near') ? tokenOut : tokenIn;
      const isBuy = tokenIn === 'wrap.near' || tokenIn === 'near';

      // Priority 0: Intear Router API quote (fast, official aggregator quote)
      try {
        const routerIn = isBuy ? 'near' : `nep141:${targetToken}`;
        const routerOut = isBuy ? `nep141:${targetToken}` : 'near';
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000);
        const res = await fetch(
          `https://router.intear.tech/route?token_in=${encodeURIComponent(routerIn)}&token_out=${encodeURIComponent(routerOut)}&amount_in=${amountIn}&slippage=${slippagePct}&max_wait_ms=2000&slippage_type=Fixed`,
          { signal: controller.signal }
        );
        clearTimeout(timeoutId);
        if (res.ok) {
          const data: any = await res.json();
          if (data && data.estimated_amount && data.worst_case_amount && BigInt(data.worst_case_amount) > 0n) {
            return {
              expectedOutput: String(data.estimated_amount),
              minAmountOut: String(data.worst_case_amount),
            };
          }
        }
      } catch {
        // Fall back to RPC simulation
      }

      let state: any;
      try {
        state = await this.getIntearTokenState(targetToken);
      } catch {
        // Fall back on lookup error
      }
      const poolId: number | null = typeof rheaPoolId === 'number'
        ? rheaPoolId
        : (state?.poolId ?? (await this.findIntearPoolId(targetToken).catch(() => null)));
      const pairedAsset = state?.pairedAsset ?? 'near';

      // Priority 1: Exact on-chain simulation via simulate_swap_simple
      // Accounts for phantom liquidity, scheduled fee curves, dynamic curves,
      // creator fees, holder fees, and dex fees (including 2-hop routes).
      if (poolId !== null && poolId !== undefined && poolId >= 0) {
        const sim = await this.simulateIntearSwap(poolId, targetToken, amountIn, isBuy, pairedAsset).catch(() => null);
        if (sim && BigInt(sim.amountOut) > 0n) {
          const minOut = calculateMinAmountOut(sim.amountOut, slippagePct);
          return { expectedOutput: sim.amountOut, minAmountOut: minOut };
        }
      }

      // Priority 2: Fallback to token state calculation using true pool fee BPS
      if (!state) {
        try {
          state = await this.getIntearTokenState(targetToken);
        } catch {
          throw new Error(
            `Intear RPC failed for ${targetToken}. Token may be on Intear but RPC is unreachable.`
          );
        }
      }
      const reserveNear = BigInt(state.reserveNear);
      const reserveToken = BigInt(state.reserveToken);

      const reserveIn = isBuy ? reserveNear : reserveToken;
      const reserveOut = isBuy ? reserveToken : reserveNear;

      if (reserveIn <= 0n || reserveOut <= 0n) {
        if (slippagePct >= 100) {
          return { expectedOutput: '0', minAmountOut: '0' };
        }
        throw new Error(`Intear pool ${poolId ?? targetToken} has no liquidity yet.`);
      }

      // Use actual on-chain fee bps from pool state (e.g. 110 bps for 1.1%, 9010 bps for 90.1%)
      const poolFeeBps = Math.min(9999, Math.max(0, state.feeBps ?? 30));
      const expected = calculateExpectedOutput(amountIn, reserveIn, reserveOut, poolFeeBps);
      const minOut = calculateMinAmountOut(expected, slippagePct);
      return { expectedOutput: expected.toString(), minAmountOut: minOut };
    } else if (venue === 'onetokenhub') {
      const targetToken = (tokenIn === 'wrap.near' || tokenIn === 'near') ? tokenOut : tokenIn;
      let poolId = dclPoolId;
      if (!poolId) {
        const state = await this.getOneTokenHubState(targetToken);
        poolId = state.dclPoolId;
      }
      if (!poolId) {
        throw new Error(`No DCL pool found for OneTokenHub token ${targetToken}`);
      }

      const inToken = tokenIn === 'near' ? 'wrap.near' : tokenIn;
      const outToken = tokenOut === 'near' ? 'wrap.near' : tokenOut;
      const quote = await this.view<any>('dclv2.ref-labs.near', 'quote', {
        pool_ids: [poolId],
        input_token: inToken,
        output_token: outToken,
        input_amount: amountIn,
      });
      const expected = BigInt(quote?.amount || '0');
      if (expected <= 0n) {
        throw new Error(`Insufficient liquidity or zero output for OneTokenHub quote on pool ${poolId}`);
      }
      const minOut = calculateMinAmountOut(expected, slippagePct);
      return { expectedOutput: expected.toString(), minAmountOut: minOut };
    } else if (venue === 'nearpad') {
      const targetToken = (tokenIn === 'wrap.near' || tokenIn === 'near') ? tokenOut : tokenIn;
      let poolId = dclPoolId;
      if (!poolId) {
        const state = await this.getNEARpadState(targetToken).catch(() => null);
        poolId = state?.dclPoolId ?? (await this.findDclPoolId('wrap.near', targetToken).catch(() => null));
      }

      if (poolId) {
        const inToken = tokenIn === 'near' ? 'wrap.near' : tokenIn;
        const outToken = tokenOut === 'near' ? 'wrap.near' : tokenOut;
        try {
          const quote = await this.view<any>('dclv2.ref-labs.near', 'quote', {
            pool_ids: [poolId],
            input_token: inToken,
            output_token: outToken,
            input_amount: amountIn,
          });
          const expected = BigInt(quote?.amount || '0');
          if (expected > 0n) {
            const minOut = calculateMinAmountOut(expected, slippagePct);
            return { expectedOutput: expected.toString(), minAmountOut: minOut };
          }
        } catch {
          // quote fallback to reserve math
        }
      }

      let state;
      try {
        state = await this.getNEARpadState(targetToken);
      } catch {
        throw new Error(
          `NEARpad RPC failed for ${targetToken}. Token may be on NEARpad but RPC is unreachable.`
        );
      }
      const reserveNear = BigInt(state.reserveNear);
      const reserveToken = BigInt(state.reserveToken);

      const isBuy = tokenIn === 'wrap.near' || tokenIn === 'near';
      const reserveIn = isBuy ? reserveNear : reserveToken;
      const reserveOut = isBuy ? reserveToken : reserveNear;

      // NEARpad DCL pool fee default (100 bps / 1%)
      const expected = calculateExpectedOutput(amountIn, reserveIn, reserveOut, 100);
      const minOut = calculateMinAmountOut(expected, slippagePct);
      return { expectedOutput: expected.toString(), minAmountOut: minOut };
    } else if (venue === 'gaypad') {
      const targetToken = (tokenIn === 'wrap.near' || tokenIn === 'near') ? tokenOut : tokenIn;
      // Rule 1: If Rhea pool is already known or available, check Rhea first
      if (typeof rheaPoolId === 'number' && rheaPoolId >= 0) {
        return this.computeMinAmountOut('rhea', tokenIn, tokenOut, amountIn, slippagePct, rheaPoolId);
      }
      const rhea = await this.findRheaPoolForToken(targetToken).catch(() => null);
      if (rhea && typeof rhea.poolId === 'number') {
        return this.computeMinAmountOut('rhea', tokenIn, tokenOut, amountIn, slippagePct, rhea.poolId);
      }
      // Otherwise pre-bonded on Gaypad
      const state = await this.getGaypadTokenState(targetToken);
      const isBuy = tokenIn === 'wrap.near' || tokenIn === 'near';
      const p6518 = await this.view<string>('v2.ref-finance.near', 'get_return', {
        pool_id: 6518,
        token_in: 'wrap.near',
        amount_in: isBuy ? amountIn : '1000000000000000000000000',
        token_out: 'jambo-1679.meme-cooking.near',
      }).catch(() => '0');
      const jamboIn = BigInt(p6518 || '0');
      const reserveJambo = BigInt(state.wnearHold || '0');
      const reserveToken = BigInt(state.tokenHold || '0');
      const reserveIn = isBuy ? reserveJambo : reserveToken;
      const reserveOut = isBuy ? reserveToken : reserveJambo;
      const effectiveAmountIn = isBuy ? jamboIn : BigInt(amountIn);
      const expectedOut = calculateExpectedOutput(effectiveAmountIn.toString(), reserveIn, reserveOut, 0);
      if (!isBuy) {
        const nearOut = await this.view<string>('v2.ref-finance.near', 'get_return', {
          pool_id: 6518,
          token_in: 'jambo-1679.meme-cooking.near',
          amount_in: expectedOut.toString(),
          token_out: 'wrap.near',
        }).catch(() => '0');
        const expected = BigInt(nearOut || '0');
        return { expectedOutput: expected.toString(), minAmountOut: calculateMinAmountOut(expected, slippagePct) };
      }
      const expected = BigInt(expectedOut);
      return { expectedOutput: expected.toString(), minAmountOut: calculateMinAmountOut(expected, slippagePct) };
    } else if (venue === 'kelytra') {
      const targetToken = (tokenIn === 'wrap.near' || tokenIn === 'near') ? tokenOut : tokenIn;
      if (typeof rheaPoolId === 'number' && rheaPoolId >= 0) {
        return this.computeMinAmountOut('rhea', tokenIn, tokenOut, amountIn, slippagePct, rheaPoolId);
      }
      const rhea = await this.findRheaPoolForToken(targetToken).catch(() => null);
      if (rhea && typeof rhea.poolId === 'number') {
        return this.computeMinAmountOut('rhea', tokenIn, tokenOut, amountIn, slippagePct, rhea.poolId);
      }
      const state = await this.getKelytraTokenState(targetToken);
      const isBuy = tokenIn === 'wrap.near' || tokenIn === 'near';
      const curve = await this.view<any>('exchange.kelytradevs.near', 'get_curve', { launch_id: state.launchId }).catch(() => null);
      if (curve) {
        const vQuote = BigInt(curve.virtual_quote || '1');
        const vTokens = BigInt(curve.virtual_tokens || '1');
        const reserveIn = isBuy ? vQuote : vTokens;
        const reserveOut = isBuy ? vTokens : vQuote;
        const expected = calculateExpectedOutput(amountIn, reserveIn, reserveOut, 100);
        const minOut = calculateMinAmountOut(expected, slippagePct);
        return { expectedOutput: expected.toString(), minAmountOut: minOut };
      }
      const price = state.price;
      const meta = await this.getTokenMetadata(targetToken).catch(() => ({ decimals: 6 }));
      const tokenDecimals = meta?.decimals ?? 6;
      let expectedBI = 0n;
      if (isBuy && price > 0) {
        const nearIn = parseFloat(amountIn) / 1e24;
        const tokensOut = nearIn / price;
        expectedBI = BigInt(Math.floor(tokensOut * Math.pow(10, tokenDecimals)));
      } else if (!isBuy && price > 0) {
        const tokensIn = parseFloat(amountIn) / Math.pow(10, tokenDecimals);
        const nearOut = tokensIn * price;
        expectedBI = BigInt(Math.floor(nearOut * 1e24));
      }
      const minOut = calculateMinAmountOut(expectedBI, slippagePct);
      return { expectedOutput: expectedBI.toString(), minAmountOut: minOut };
    } else {
      throw new Error(`Unsupported venue: ${venue}`);
    }
  }

  /** Start health-check interval for all providers. Guarded against double-start. */
  startHealthChecks(intervalMs = 30_000): NodeJS.Timeout {
    if (this.healthCheckInterval) {
      return this.healthCheckInterval;
    }
    this.healthCheckInterval = setInterval(async () => {
      for (const list of [this.readProviders, this.tradeProviders]) {
        for (const provider of list) {
          const start = Date.now();
          try {
            const near = await this.getConnection(provider.url);
            await withTimeout(near.connection.provider.status(), 5000, `Health check timeout ${provider.url}`);
            markProviderSuccess(provider, Date.now() - start);
          } catch {
            markProviderError(provider);
          }
        }
      }
    }, intervalMs);
    return this.healthCheckInterval;
  }

  /**
   * Current spot price of `tokenAddress` in NEAR plus the NEAR-side reserve,
   * read from the venue's live pool state. Used for trigger price refreshes
   * and initial token pricing. Returns null when no live pool is found.
   */
  /**
   * Get the spot price for a token at a given venue.
   * Pass knownRheaPoolId / knownDclPoolId to skip the expensive pool-discovery
   * scan and go directly to a single get_pool RPC call.
   */
  async getVenueSpotPrice(
    venue: string,
    tokenAddress: string,
    decimals: number,
    knownRheaPoolId?: number | null,
    knownDclPoolId?: string | null,
  ): Promise<{ price: number; reserveNearYocto: string } | null> {
    if (knownDclPoolId && venue !== 'nearlytrade') {
      const parts = knownDclPoolId.split('|');
      const isDirectNearPool = parts[0] === 'wrap.near' || parts[1] === 'wrap.near';
      if (isDirectNearPool) {
        // Seed the in-process cache so findDclPoolId also benefits
        const keyAB = `wrap.near:${tokenAddress}`;
        const keyBA = `${tokenAddress}:wrap.near`;
        if (!dclPoolIdCache.has(keyAB)) dclPoolIdCache.set(keyAB, knownDclPoolId);
        if (!dclPoolIdCache.has(keyBA)) dclPoolIdCache.set(keyBA, knownDclPoolId);
        try {
          const st = await this.getDclPoolState(knownDclPoolId, 'wrap.near');
          if (st.price > 0 && st.liquidityNear > 0) {
            return {
              price: st.price,
              reserveNearYocto: st.reserveNear,
            };
          }
        } catch { /* pool may have drained — fall through to Rhea */ }
      }
    }
    if (knownRheaPoolId != null && knownRheaPoolId >= 0) {
      // Seed the in-process cache so findRheaPoolId also benefits
      const keyAB = `wrap.near:${tokenAddress}`;
      const keyBA = `${tokenAddress}:wrap.near`;
      if (!rheaPoolIdCache.has(keyAB)) rheaPoolIdCache.set(keyAB, knownRheaPoolId);
      if (!rheaPoolIdCache.has(keyBA)) rheaPoolIdCache.set(keyBA, knownRheaPoolId);
      try {
        const rh = await this.getRheaPoolReserves(knownRheaPoolId, 'wrap.near', tokenAddress);
        const reserveIn = parseFloat(rh.reserveIn);
        const reserveOut = parseFloat(rh.reserveOut);
        if (reserveIn > 0 && reserveOut > 0) {
          const reserveNearHuman = reserveIn / 1e24;
          const reserveTokenHuman = reserveOut / Math.pow(10, decimals);
          return {
            price: reserveNearHuman / reserveTokenHuman,
            reserveNearYocto: rh.reserveIn,
          };
        }
      } catch { /* pool may have been removed — fall through to full scan */ }
    }
    // ── Slow-path: discover pool via full scan ────────────────────────────────
    if (venue === 'rhea' || venue === 'ref') {
      const rhea = await this.findRheaPoolForToken(tokenAddress).catch(() => null);
      if (rhea) {
        return {
          price: rhea.price,
          reserveNearYocto: rhea.reserveNear || (rhea.liquidityNear * 1e24 / 2).toFixed(0),
        };
      }
      return null;
    }
    if (venue === 'gaypad') {
      const rhea = await this.findRheaPoolForToken(tokenAddress).catch(() => null);
      if (rhea) {
        return {
          price: rhea.price,
          reserveNearYocto: rhea.reserveNear || (rhea.liquidityNear * 1e24 / 2).toFixed(0),
        };
      }
      const st = await this.getGaypadTokenState(tokenAddress).catch(() => null);
      if (st && st.price > 0) {
        return {
          price: st.price,
          reserveNearYocto: (st.liquidityNear * 1e24 / 2).toFixed(0),
        };
      }
      return null;
    }
    if (venue === 'nearpumpfun') {
      const rhea = await this.findRheaPoolForToken(tokenAddress).catch(() => null);
      if (rhea && rhea.price > 0) {
        return {
          price: rhea.price,
          reserveNearYocto: rhea.reserveNear || ((rhea.liquidityNear * 1e24) / 2).toFixed(0),
        };
      }
      const st = await this.getNearpumpfunTokenState(tokenAddress).catch(() => null);
      if (st && st.price > 0) {
        return {
          price: st.price,
          reserveNearYocto: ((st.liquidityNear * 1e24) / 2).toFixed(0),
        };
      }
      return null;
    }
    if (venue === 'nearlytrade') {
      const rhea = await this.findRheaPoolForToken(tokenAddress).catch(() => null);
      const st = await this.getNearlytradeTokenState(tokenAddress).catch(() => null);
      if (rhea && rhea.price > 0 && rhea.liquidityNear >= 5) {
        if (!st || !st.quoteIsNear || st.phase === 'bonded' || rhea.price > (st.price || 0) || rhea.liquidityNear >= 50) {
          return {
            price: rhea.price,
            reserveNearYocto: rhea.reserveNear || ((rhea.liquidityNear * 1e24) / 2).toFixed(0),
          };
        }
      }
      if (!st || st.priceUnavailable || !(st.price > 0)) {
        if (rhea && rhea.price > 0) {
          return {
            price: rhea.price,
            reserveNearYocto: rhea.reserveNear || ((rhea.liquidityNear * 1e24) / 2).toFixed(0),
          };
        }
        return null;
      }
      return { reserveNearYocto: st.reserveNear, price: st.price };
    }
    if (venue === 'shardsmarket') {
      const rhea = await this.findRheaPoolForToken(tokenAddress).catch(() => null);
      const st = await this.getShardsmarketTokenState(tokenAddress).catch(() => null);
      if (st) {
        const rNear = parseFloat(st.poolQuote);
        const rTok = parseFloat(st.poolToken);
        const smPrice = rNear > 0 && rTok > 0 ? (rNear / 1e24) / (rTok / Math.pow(10, decimals)) : 0;
        if (rhea && rhea.price > 0 && rhea.liquidityNear >= 5 && (rhea.price > smPrice || rhea.liquidityNear >= 50)) {
          return {
            price: rhea.price,
            reserveNearYocto: rhea.reserveNear || ((rhea.liquidityNear * 1e24) / 2).toFixed(0),
          };
        }
        if (smPrice > 0) {
          return { reserveNearYocto: st.poolQuote, price: smPrice };
        }
      }
      if (rhea && rhea.price > 0) {
        return {
          price: rhea.price,
          reserveNearYocto: rhea.reserveNear || ((rhea.liquidityNear * 1e24) / 2).toFixed(0),
        };
      }
      return null;
    }
    if (venue === 'intear') {
      const st = await this.getIntearTokenState(tokenAddress);
      if (!(st.price > 0)) return null;
      return { reserveNearYocto: st.reserveNear, price: st.price };
    }
    if (venue === 'onetokenhub') {
      const rhea = await this.findRheaPoolForToken(tokenAddress).catch(() => null);
      const st = await this.getOneTokenHubState(tokenAddress).catch(() => null);
      if (rhea && rhea.price > 0 && rhea.liquidityNear >= 5 && (!st || rhea.price > (st.price || 0) || rhea.liquidityNear >= 50)) {
        return {
          price: rhea.price,
          reserveNearYocto: rhea.reserveNear || ((rhea.liquidityNear * 1e24) / 2).toFixed(0),
        };
      }
      if (!st || !(st.price > 0)) {
        if (rhea && rhea.price > 0) {
          return {
            price: rhea.price,
            reserveNearYocto: rhea.reserveNear || ((rhea.liquidityNear * 1e24) / 2).toFixed(0),
          };
        }
        return null;
      }
      return { reserveNearYocto: st.reserveNear, price: st.price };
    }
    if (venue === 'nearpad') {
      const rhea = await this.findRheaPoolForToken(tokenAddress).catch(() => null);
      const st = await this.getNEARpadState(tokenAddress).catch(() => null);
      if (rhea && rhea.price > 0 && rhea.liquidityNear >= 5 && (!st || rhea.price > (st.price || 0) || rhea.liquidityNear >= 50)) {
        return {
          price: rhea.price,
          reserveNearYocto: rhea.reserveNear || ((rhea.liquidityNear * 1e24) / 2).toFixed(0),
        };
      }
      if (!st || !(st.price > 0)) {
        if (rhea && rhea.price > 0) {
          return {
            price: rhea.price,
            reserveNearYocto: rhea.reserveNear || ((rhea.liquidityNear * 1e24) / 2).toFixed(0),
          };
        }
        return null;
      }
      return { reserveNearYocto: st.reserveNear, price: st.price };
    }
    if (venue === 'shoremarkets') {
      const rhea = await this.findRheaPoolForToken(tokenAddress).catch(() => null);
      const st = await this.getShoremarketsTokenState(tokenAddress).catch(() => null);
      if (rhea && rhea.price > 0 && rhea.liquidityNear >= 5) {
        if (!st || !st.quoteIsNear || st.phase === 'bonded' || rhea.price > (st.price || 0) || rhea.liquidityNear >= 50) {
          return {
            price: rhea.price,
            reserveNearYocto: rhea.reserveNear || ((rhea.liquidityNear * 1e24) / 2).toFixed(0),
          };
        }
      }
      if (!st || st.priceUnavailable || !(st.price > 0)) {
        if (rhea && rhea.price > 0) {
          return {
            price: rhea.price,
            reserveNearYocto: rhea.reserveNear || ((rhea.liquidityNear * 1e24) / 2).toFixed(0),
          };
        }
        return null;
      }
      return { reserveNearYocto: st.reserveNear, price: st.price };
    }
    if (venue === 'memecooking') {
      const rhea = await this.findRheaPoolForToken(tokenAddress).catch(() => null);
      if (rhea && rhea.price > 0) {
        return {
          price: rhea.price,
          reserveNearYocto: rhea.reserveNear || (rhea.liquidityNear * 1e24 / 2).toFixed(0),
        };
      }
      const memeId = parseMemeCookingId(tokenAddress);
      if (memeId !== null) {
        const meme = await this.view<any>('meme-cooking.near', 'get_meme', { meme_id: memeId }).catch(() => null);
        if (meme) {
          const hardCapYocto = BigInt(meme.hard_cap || '100000000000000000000000000');
          const tokensToDistribute = BigInt(meme.amount_to_be_distributed || meme.total_supply || '0');
          if (hardCapYocto > 0n && tokensToDistribute > 0n) {
            const hardCapNear = Number(hardCapYocto) / 1e24;
            const supplyHuman = Number(tokensToDistribute) / Math.pow(10, decimals);
            if (supplyHuman > 0) {
              return {
                price: hardCapNear / supplyHuman,
                reserveNearYocto: hardCapYocto.toString(),
              };
            }
          }
        }
      }
      return null;
    }
    return null;
  }

  /**
   * Build + sign the transaction ONCE, then broadcast the same signed bytes
   * to ALL healthy RPC providers simultaneously, then poll for the execution
   * outcome. This is the write path used by the executor — a single slow or
   * dead RPC can no longer delay or drop a trade.
   *
   * Returns a FinalExecutionOutcome-shaped object:
   *   { status, transaction: { hash }, transaction_outcome, receipts_outcome }
   */
  async signAndSendTransactionAll(
    accountId: string,
    receiverId: string,
    actions: any[],
    waitForMs = 55_000,
    onBroadcast?: (txHash: string) => void
  ): Promise<any> {
    const tStart = Date.now();
    const account = await this.getAccount(accountId);
    const allProviderUrls = this.tradeProviders.map(p => p.url);

    // Build and sign transaction with monotonic nonce tracking.
    // Near requires tx.nonce > ak.nonce. When a transaction is dropped by mempool
    // under congestion, its nonce is never committed to chain, leaving on-chain ak.nonce
    // un-advanced. To prevent repeating the exact same dropped/stale nonce across retries
    // or phase-2 re-signs, we maintain highestUsedNonce per account+key and strictly
    // advance past it.
    let confirmedOnChain = false;
    let signerPkStr: string | null = null;
    const signOnce = async (forceIncrement = false): Promise<{ hash: string; signedB64: string; nonce: bigint }> => {
      const publicKey = await account.connection.signer.getPublicKey(accountId, account.connection.networkId);
      if (!publicKey) {
        throw new Error(`No matching key pair found for ${accountId}`);
      }
      const pkStr = publicKey.toString();
      signerPkStr = pkStr;
      const nonceCacheKey = `${accountId}:${pkStr}`;

      (account as any).accessKeyByPublicKeyCache = {};
      // Access-key nonce and block hash are hedged across ALL trade providers
      // (QuickNode + FastNEAR). Both are chain-global reads, so racing endpoints
      // is safe and removes the single-pinned-RPC stall from the sign path;
      // the nonce read takes the MAX answer across providers.
      const [rawAccessKey, blockHashB58, accountState] = await Promise.all([
        this.queryAccessKeyHedged(accountId, pkStr),
        this.fetchBlockHashHedged(),
        account.state().catch(() => null),
      ]);
      const chainNonce = BigInt(rawAccessKey?.nonce || 0);

      // Pre-flight balance check: verify account balance covers total attached deposits
      // plus the network gas reserve (NEAR base gas price is 10^8 yocto/gas; using 1.5x buffer = 1.5 * 10^8 yocto).
      if (accountState?.amount && !forceIncrement) {
        let totalGas = 0n;
        let totalDeposit = 0n;
        for (const action of actions) {
          if (action.functionCall) {
            totalGas += BigInt(action.functionCall.gas || 0);
            totalDeposit += BigInt(action.functionCall.deposit || 0);
          } else if (action.transfer) {
            totalDeposit += BigInt(action.transfer.deposit || 0);
          }
        }
        const gasPriceYocto = 150_000_000n; // 1.5x base gas price (1.5 * 10^8 yocto)
        const gasReserve = totalGas * gasPriceYocto;
        const totalRequired = totalDeposit + gasReserve;
        const currentBal = BigInt(accountState.amount);
        if (currentBal < totalRequired) {
          const balNear = (Number(currentBal) / 1e24).toFixed(4);
          const reqNear = (Number(totalRequired) / 1e24).toFixed(4);
          const gasNear = (Number(gasReserve) / 1e24).toFixed(4);
          throw new TradeError(
            `Insufficient NEAR balance: wallet has ${balNear} NEAR, but this trade requires ${reqNear} NEAR ` +
            `(${gasNear} NEAR network gas reserve + attached deposit). Please deposit more NEAR.`,
            { code: 'INSUFFICIENT_BALANCE', txHash: '' }
          );
        }
      }

      // Monotonicity guarantee: nextNonce MUST strictly exceed BOTH:
      // 1. The on-chain access key nonce (chainNonce)
      // 2. Any nonce previously signed by this process (prevUsed), which prevents
      //    replaying the same nonce if an immediate prior tx (like storage_deposit)
      //    has landed or is in flight while an RPC read is lagging.
      const prevUsed = this.highestUsedNonce.get(nonceCacheKey) ?? 0n;
      const baseNonce = chainNonce > prevUsed ? chainNonce : prevUsed;
      const nextNonce = baseNonce + 1n;
      this.highestUsedNonce.set(nonceCacheKey, nextNonce);

      const blockHash = utils.serialize.base_decode(blockHashB58);

      const [txHash, signedTx] = await withTimeout<any[]>(
        transactions.signTransaction(
          receiverId,
          nextNonce,
          actions,
          blockHash,
          account.connection.signer,
          accountId,
          account.connection.networkId
        ),
        8_000,
        `Signing timed out for ${accountId}`
      );

      return {
        hash: utils.serialize.base_encode(txHash as Uint8Array),
        signedB64: Buffer.from(transactions.encodeTransaction(signedTx)).toString('base64'),
        nonce: nextNonce,
      };
    };

    let signed: { hash: string; signedB64: string; nonce: bigint };
    try {
      signed = await signOnce(false);
      // Validate-and-include first, so a rejected tx fails in ~1s with the node's reason
      // instead of being silently dropped and polled for ~24s
      let inclusion = await this.sendIncluded(signed.signedB64);
      for (let retry = 0; inclusion.status === 'invalid' && MultiRpcNear.isInvalidNonce(inclusion.error) && retry < 2; retry++) {
        signed = await signOnce(true);
        inclusion = await this.sendIncluded(signed.signedB64);
      }
      if (inclusion.status === 'invalid') {
        throw new TradeError(MultiRpcNear.describeInvalidTx(inclusion.error), { code: 'INVALID_TX', txHash: signed.hash });
      }
      if (inclusion.status === 'unknown') {
        // Congestion or transport errors: fall back to the async fan-out and the existing poll/re-sign path
        try {
          await this.broadcastToAll(signed.signedB64);
        } catch (err: any) {
          await this.broadcastSigned(signed.signedB64);
        }
      }
      // The network has accepted the signed transaction. Confirmation and
      // receipt execution can take longer, but callers can now immediately
      // show a truthful "submitted" state instead of appearing frozen.
      onBroadcast?.(signed.hash);

      const broadcastMs = Date.now() - tStart;
      const seen = { everSeen: inclusion.status === 'included' };
      // Phase 1: Fan-out poll across all trade providers (FastNEAR + validator nodes).
      // Under network congestion, block inclusion and receipt routing often take 18-28s.
      // Give Phase 1 up to 30s before assuming a mempool drop.
      const firstWindow = Math.min(30_000, Math.max(15_000, waitForMs - 22_000));
      let outcome: any;
      try {
        outcome = await this.awaitOutcome(signed.hash, accountId, firstWindow, seen, allProviderUrls);
      } catch (firstErr: any) {
        if (!firstErr?.neverSeen) {
          // The tx WAS seen on-chain but not fully executed within the first
          // window (congestion, slow receipt tree). Do NOT give up early —
          // keep polling the SAME hash for the remaining wait budget. Giving
          // up here pushed every slow confirm into the executor's recovery
          // path and surfaced false "confirmation is taking longer" errors.
          if (firstErr?.code !== 'NOT_CONFIRMED') throw firstErr;
          const remainMs = waitForMs - (Date.now() - tStart);
          if (remainMs <= 2_000) throw firstErr;
          console.warn(`[NEAR] tx ${signed.hash} seen on-chain but not fully executed within ${firstWindow}ms — continuing to poll for ${remainMs}ms`);
          outcome = await this.awaitOutcome(signed.hash, accountId, remainMs, seen, allProviderUrls);
        } else {

        // Phase 2: If the transaction was never seen anywhere after firstWindow,
        // it may have been dropped or delayed. Before re-signing, verify if the
        // on-chain access key nonce has advanced past signed.nonce. If it has,
        // the transaction is actually executing on-chain — keep polling signed.hash!
        let currentChainNonce = 0n;
        if (signerPkStr) {
          try {
            const freshAk = await this.queryAccessKeyHedged(accountId, signerPkStr);
            currentChainNonce = BigInt(freshAk?.nonce ?? 0);
          } catch {}
        }

        if (currentChainNonce >= signed.nonce) {
          console.warn(`[NEAR] tx ${signed.hash} not seen by poller yet, but on-chain nonce advanced to ${currentChainNonce} >= ${signed.nonce} — continuing to poll`);
          const remainMs = Math.max(20_000, waitForMs - (Date.now() - tStart));
          outcome = await this.awaitOutcome(signed.hash, accountId, remainMs, seen, allProviderUrls);
        } else {
          // The nonce hasn't advanced on chain — re-sign with monotonically advanced nonce
          console.warn(`[NEAR] tx ${signed.hash} (nonce ${signed.nonce}) never seen on any provider after ${firstWindow}ms — re-signing with fresh incremented nonce`);
          let freshSigned: { hash: string; signedB64: string; nonce: bigint };
          try {
            freshSigned = await signOnce(true);
          } catch {
            // If re-signing fails, rethrow the original neverSeen error
            throw firstErr;
          }

          console.warn(`[NEAR] re-signed fresh tx hash=${freshSigned.hash} nonce=${freshSigned.nonce} — broadcasting to all providers`);
          try {
            await this.broadcastToAll(freshSigned.signedB64);
          } catch {
            await this.broadcastSigned(freshSigned.signedB64);
          }
          onBroadcast?.(freshSigned.hash);

          const seen2 = { everSeen: false };
          const remainingMs = Math.max(22_000, waitForMs - (Date.now() - tStart));
          outcome = await this.awaitOutcome(freshSigned.hash, accountId, remainingMs, seen2, allProviderUrls);
        }
        }
      }

      // Mark transaction confirmed on-chain so nonce state is preserved
      confirmedOnChain = true;

      // Perf instrumentation for trade_attempts timings (click→quote→sign→
      // broadcast→confirm). Attached non-enumerably-safe plain fields.
      outcome.__perf = {
        broadcastMs,
        confirmMs: Date.now() - tStart,
      };
      return outcome;
    } finally {
      // Invariant: always wipe access key nonce cache when leaving signAndSendTransactionAll,
      // and if the transaction was never confirmed on-chain, clear highestUsedNonce so no
      // subsequent trade attempt ever uses a stale or gapped in-memory nonce.
      (account as any).accessKeyByPublicKeyCache = {};
      if (signerPkStr) {
        const nonceCacheKey = `${accountId}:${signerPkStr}`;
        // Keep highestUsedNonce tracked even on timeout to prevent immediate retry
        // collisions with mempool-delayed transactions. If chainNonce has genuinely advanced,
        // signOnce will naturally use max(chainNonce, prevUsed) + 1n.
      }
    }
  }

  /**
   * Access-key (nonce) read for signing, hedged across ALL trade providers in
   * parallel. The nonce is account state — identical on every endpoint — so
   * racing providers is safe; among successful answers we take the MAX nonce
   * (a fresher provider may already see a just-landed tx; a stale lower nonce
   * would collide with it). Falls back from optimistic to final finality.
   */
  private async queryAccessKeyHedged(accountId: string, publicKey: string): Promise<any> {
    const attempt = async (provider: RPCProvider, finality: string): Promise<any> => {
      const start = Date.now();
      const res = await fetch(provider.url, {
        method: 'POST',
        headers: provider.headers ?? { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'racerbot-ak',
          method: 'query',
          params: { request_type: 'view_access_key', account_id: accountId, public_key: publicKey, finality },
        }),
        signal: AbortSignal.timeout(4000),
      });

      if (res.status === 402 && provider.headers?.['Authorization']) {
        delete provider.headers['Authorization'];
        console.warn(`[NEAR] Cleared exhausted Authorization header from ${provider.url}`);
      }

      if (res.status === 429) {
        markProviderError(provider, true);
        throw new Error(`HTTP 429 Rate Limit from ${provider.url}`);
      }

      const data: any = await res.json();
      if (data?.error) {
        const errMsg = data.error.message || JSON.stringify(data.error);
        if (MultiRpcNear.isNetworkError(errMsg) || errMsg.includes('limit') || errMsg.includes('429')) {
          markProviderError(provider, true);
        }
        throw new Error(errMsg);
      }
      markProviderSuccess(provider, Date.now() - start);
      return data?.result;
    };
    const maxNonce = (results: PromiseSettledResult<any>[]) => {
      const ok = results.filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled' && r.value != null);
      if (ok.length === 0) return null;
      return ok.reduce((a, b) => (BigInt(b.value?.nonce ?? 0) > BigInt(a.value?.nonce ?? 0) ? b : a)).value;
    };

    // Fast-path: query all trade providers in parallel.
    // If the primary provider (FastNEAR, index 0) resolves quickly, wait at most 100ms for others to compare max nonce.
    // This prevents a slow secondary provider (QuickNode) from blocking signing for 800ms+!
    const queryWithHedging = async (finality: string): Promise<any | null> => {
      if (this.tradeProviders.length === 1) {
        return attempt(this.tradeProviders[0], finality).catch(() => null);
      }
      const attempts = this.tradeProviders.map(p => attempt(p, finality));
      const primaryPromise = attempts[0];
      const otherAttempts = attempts.slice(1);

      try {
        const primaryRes = await primaryPromise;
        if (primaryRes != null) {
          const otherResults = await Promise.allSettled(
            otherAttempts.map(p => Promise.race([
              p,
              new Promise<null>(r => setTimeout(() => r(null), 200))
            ]))
          );
          const okOthers = otherResults
            .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled' && r.value != null);
          const allOk = [primaryRes, ...okOthers.map(o => o.value)];
          return allOk.reduce((a, b) => (BigInt(b?.nonce ?? 0) > BigInt(a?.nonce ?? 0) ? b : a));
        }
      } catch {}

      const allSettled = await Promise.allSettled(attempts);
      return maxNonce(allSettled);
    };

    const best = await queryWithHedging('optimistic');
    if (best) return best;

    console.warn('[NEAR] view_access_key (optimistic) failed on all trade providers — retrying with final finality');
    const bestFinal = await queryWithHedging('final');
    if (bestFinal) return bestFinal;

    // Fallback to read providers
    if (this.readProviders.length > 0) {
      const readFin = await Promise.allSettled(this.readProviders.map(p => attempt(p, 'final')));
      const bestRead = maxNonce(readFin);
      if (bestRead) return bestRead;
    }

    // Direct emergency fallbacks to free FastNEAR and QuickNode default
    try {
      const freeP = createProvider('https://free.rpc.fastnear.com', 'free-fastnear-ak', false);
      const res = await attempt(freeP, 'final');
      if (res) return res;
    } catch {}

    try {
      const qnUrl = process.env.QUICKNODE_ENDPOINT_URL || '';
      if (!qnUrl) throw new Error('QUICKNODE_ENDPOINT_URL not set');
      const qnP = createProvider(qnUrl, 'emergency-qn-ak', true);
      const res = await attempt(qnP, 'final');
      if (res) return res;
    } catch {}

    throw new Error('view_access_key failed on all trade RPC providers');
  }

  /**
   * Recent block hash for tx validity, hedged across ALL trade providers —
   * first success wins. A block hash is chain-global, so any healthy endpoint
   * answers identically; hedging removes the single-endpoint stall from the
   * sign path.
   */
  private async fetchBlockHashHedged(): Promise<string> {
    const fetchFrom = async (provider: RPCProvider): Promise<string> => {
      const start = Date.now();
      const res = await fetch(provider.url, {
        method: 'POST',
        headers: provider.headers ?? { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'racerbot-block', method: 'block', params: { finality: 'final' } }),
        signal: AbortSignal.timeout(5000),
      });

      if (res.status === 402 && provider.headers?.['Authorization']) {
        delete provider.headers['Authorization'];
        console.warn(`[NEAR] Cleared exhausted Authorization header from ${provider.url}`);
      }

      if (res.status === 429) {
        markProviderError(provider, true);
        throw new Error(`HTTP 429 Rate Limit from ${provider.url}`);
      }

      const data: any = await res.json();
      const hash = data?.result?.header?.hash;
      if (!hash) {
        const errMsg = data?.error?.message || 'no block hash in response';
        if (MultiRpcNear.isNetworkError(errMsg) || errMsg.includes('limit') || errMsg.includes('429')) {
          markProviderError(provider, true);
        }
        throw new Error(errMsg);
      }
      markProviderSuccess(provider, Date.now() - start);
      return hash as string;
    };

    // Fast-path: query primary trade provider. If it succeeds within 250ms, return immediately
    // without hitting secondary providers. Secondary providers are only queried if primary fails or is slow.
    const primary = this.tradeProviders.find(p => p.healthy && !p.circuitBreakerOpen) || this.tradeProviders[0];
    if (primary) {
      try {
        const hash = await Promise.race([
          fetchFrom(primary),
          new Promise<null>((_, reject) => setTimeout(() => reject(new Error('primary-timeout')), 250)),
        ]);
        if (hash) return hash;
      } catch {
        // Primary failed or exceeded 250ms — fall back to all trade providers
      }
    }

    try {
      return await Promise.any(this.tradeProviders.map(fetchFrom));
    } catch {
      // Fallback across read providers if all trade providers failed
      if (this.readProviders.length > 0) {
        try {
          return await Promise.any(this.readProviders.map(fetchFrom));
        } catch {}
      }
    }

    // Direct emergency fallbacks to free FastNEAR and QuickNode default
    try {
      const freeP = createProvider('https://free.rpc.fastnear.com', 'free-fastnear-block', false);
      const hash = await fetchFrom(freeP);
      if (hash) return hash;
    } catch {}

    try {
      const qnUrl = process.env.QUICKNODE_ENDPOINT_URL || '';
      if (!qnUrl) throw new Error('QUICKNODE_ENDPOINT_URL not set');
      const qnP = createProvider(qnUrl, 'emergency-qn-block', true);
      const hash = await fetchFrom(qnP);
      if (hash) return hash;
    } catch {}

    throw new Error('Block fetch failed on all trade RPC providers');
  }

  /** Broadcast signed bytes to the single pinned trade RPC. No fallback. */
  private async broadcastSigned(signedB64: string): Promise<string> {
    const provider = this.tradeProvider;
    const start = Date.now();
    try {
      const res = await fetch(provider.url, {
        method: 'POST',
        headers: provider.headers ?? { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'racerbot-broadcast',
          method: 'broadcast_tx_async',
          params: [signedB64],
        }),
        signal: AbortSignal.timeout(5000),
      });
      const data: any = await res.json();
      if (data?.error) {
        const errMsg = data.error.message || JSON.stringify(data.error);
        if (MultiRpcNear.isNetworkError(errMsg) || data.error?.code === -32003) {
          markProviderError(provider, true);
        }
        throw new Error(errMsg);
      }
      markProviderSuccess(provider, Date.now() - start);
      return data?.result as string;
    } catch (err) {
      markProviderError(provider);
      throw err;
    }
  }

  /**
   * Send signed bytes with send_tx(wait_until: INCLUDED) to all trade providers.
   * Unlike broadcast_tx_async, a node validates the tx and rejects an invalid one
   * (bad nonce, unknown key, low balance, expired block hash) in about a second
   * instead of silently dropping it.
   *  - 'included': some provider confirmed block inclusion
   *  - 'invalid':  no provider included it and at least one rejected it as INVALID_TRANSACTION
   *  - 'unknown':  timeouts or transport errors only (congestion); caller falls back to async broadcast
   * A success outranks a rejection: a node that sees an already-included tx can report InvalidNonce.
   */
  private async sendIncluded(signedB64: string, timeoutMs = 6000): Promise<
    { status: 'included' } | { status: 'invalid'; error: any } | { status: 'unknown' }
  > {
    const attempts = this.tradeProviders.map(async (provider) => {
      const res = await fetch(provider.url, {
        method: 'POST',
        headers: provider.headers ?? { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'racerbot-send-included',
          method: 'send_tx',
          params: { signed_tx_base64: signedB64, wait_until: 'INCLUDED' },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const data: any = await res.json();
      if (data?.error) {
        const invalid = data.error?.cause?.name === 'INVALID_TRANSACTION'
          ? (data.error?.data?.TxExecutionError?.InvalidTxError ?? data.error?.data ?? {})
          : undefined;
        throw Object.assign(new Error(data.error.message || 'send_tx error'), { invalid });
      }
      return data?.result;
    });

    try {
      await Promise.any(attempts);
      return { status: 'included' };
    } catch (agg: any) {
      const rejection = (agg?.errors ?? []).find((e: any) => e?.invalid !== undefined);
      return rejection ? { status: 'invalid', error: rejection.invalid } : { status: 'unknown' };
    }
  }

  /** True when an InvalidTxError is a nonce clash, which a fresh nonce resolves. */
  private static isInvalidNonce(invalidTxError: any): boolean {
    return Boolean(invalidTxError && typeof invalidTxError === 'object' && 'InvalidNonce' in invalidTxError);
  }

  /** Human-readable reason for an InvalidTxError returned by send_tx. */
  private static describeInvalidTx(invalidTxError: any): string {
    const e = invalidTxError ?? {};
    if (e.InvalidAccessKeyError) return 'The network rejected the transaction: this account\'s signing key is not authorized on-chain. No funds were spent.';
    if (e.NotEnoughBalance) return 'The network rejected the transaction: not enough NEAR to cover the amount plus gas. No funds were spent.';
    if (e.LackBalanceForState) return 'The network rejected the transaction: it would leave the account below its storage reserve. No funds were spent.';
    if (e.Expired) return 'The network rejected the transaction because it expired before inclusion. No funds were spent; please retry.';
    if (e.InvalidNonce) return 'Another transaction from this account was sent at the same moment. No funds were spent; please retry.';
    return `The network rejected the transaction (${JSON.stringify(e).slice(0, 160)}). No funds were spent.`;
  }

  /**
   * Fan-out broadcast: send signed bytes to ALL trade providers in parallel.
   * Broadcasts to all trade providers simultaneously. If at least one provider accepts,
   * returns success. If ALL providers reject the broadcast, throws immediately with
   * the rejection reason so caller fails fast instead of hanging on a doomed poll.
   */
  private async broadcastToAll(signedB64: string): Promise<void> {
    const promises = this.tradeProviders.map(async (provider) => {
      const res = await fetch(provider.url, {
        method: 'POST',
        headers: provider.headers ?? { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'racerbot-fanout',
          method: 'broadcast_tx_async',
          params: [signedB64],
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.status === 429) {
        markProviderError(provider, true);
        throw new Error(`${provider.name || provider.url}: HTTP 429 Rate Limit`);
      }
      const data: any = await res.json();
      if (data?.error) {
        const errMsg = data.error.message || JSON.stringify(data.error);
        console.warn(`[NEAR] broadcastToAll ${provider.name || provider.url} error:`, errMsg);
        if (MultiRpcNear.isNetworkError(errMsg) || errMsg.includes('limit') || errMsg.includes('429')) {
          markProviderError(provider, true);
        }
        throw new Error(`${provider.name || provider.url}: ${errMsg}`);
      }
      console.log(`[NEAR] broadcastToAll ${provider.name || provider.url} accepted tx`);
      return data?.result;
    });

    try {
      // First provider to accept returns immediately so confirmation polling begins without delay
      await Promise.any(promises);
      // Ensure other trade providers also complete their broadcast so all nodes relay the tx
      Promise.allSettled(promises).catch(() => {});
    } catch {
      // All rejected
      const results = await Promise.allSettled(promises);
      const errors = results
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map(r => r.reason?.message ?? String(r.reason));
      const firstError = errors[0] || 'Unknown broadcast error';
      console.error('[NEAR] All providers rejected broadcast:', errors);
      throw new Error(`Transaction broadcast rejected by all RPC nodes: ${firstError}`);
    }
  }

  /**
   * Poll for a transaction outcome on the single pinned trade RPC.
   * Uses `EXPERIMENTAL_tx_status` with `wait_until: 'NONE'` — non-long-polling;
   * returns immediately once the tx appears in the chain (no receipt-tree wait).
   *
   * No indexer race, no secondary RPC — the endpoint that accepted the
   * broadcast is the single source of truth for its outcome.
   *
   * HANDLER_ERROR / TIMEOUT_ERROR from the RPC is treated as "pending, retry" — NOT fatal.
   * The old `txStatus` long-poll was causing false failures when the RPC held the connection
   * open waiting for cross-contract receipt trees, then returned TIMEOUT_ERROR.
   *
   * On deadline, throws TradeError with code NOT_CONFIRMED and the tx hash —
   * the tx WAS broadcast and may still land, so callers must not report a
   * definitive failure; they should re-check on-chain (waitForOutcome).
   */
  private async awaitOutcome(
    txHash: string,
    accountId: string,
    maxMs: number,
    state?: { everSeen: boolean },
    extraUrls?: string[]
  ): Promise<any> {
    const deadline = Date.now() + maxMs;
    let lastErr: Error | null = null;
    const pinnedUrl = this.tradeProvider.url;
    // All healthy trade URLs to poll. Start with tradeProvider, but include all available trade providers
    const healthyTradeUrls = this.tradeProviders
      .filter(p => isProviderAvailable(p))
      .map(p => p.url);
    const candidateUrls = healthyTradeUrls.length > 0 ? healthyTradeUrls : this.tradeProviders.map(p => p.url);
    const allPollUrls: string[] = Array.from(new Set([
      pinnedUrl,
      ...candidateUrls,
      ...(extraUrls ?? []),
    ]));

    /**
     * Try a single RPC provider for tx status.
     *
     * Strategy: try the newer `tx` method first (non-long-polling, fast).
     * If the provider returns -32601 (method not found), fall back to
     * `EXPERIMENTAL_tx_status` with array params (universally supported).
     * In both cases, TIMEOUT_ERROR / HANDLER_ERROR / UNKNOWN_TRANSACTION
     * are treated as "pending" — return null so the caller retries.
     * -32601 (method not found) is also treated as "skip, retry later".
     */
    const tryRpc = async (providerUrl: string): Promise<any | null> => {
      const callRpc = async (method: string, params: any): Promise<any | null> => {
        try {
          const provider = this.tradeProviders.find(p => p.url === providerUrl);
          const headers = provider?.headers ?? { 'Content-Type': 'application/json' };
          const res = await fetch(providerUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify({ jsonrpc: '2.0', id: 'await-outcome', method, params }),
            signal: AbortSignal.timeout(2500),
          });

          if (res.status === 429) {
            if (provider) markProviderError(provider, true);
            return null;
          }

          const text = await res.text();
          if (!text || text.trim() === '') {
            throw new Error(`HTTP ${res.status}: ${res.statusText}`);
          }

          let parsed: any;
          try {
            parsed = JSON.parse(text);
          } catch {
            throw new Error(`HTTP ${res.status}: ${res.statusText}`);
          }

          // If HTTP returned error status and no JSON-RPC error payload was received, throw
          if (!res.ok && !parsed?.error) {
            throw new Error(`HTTP ${res.status}: ${res.statusText}`);
          }

          return parsed;
        } catch (err: any) {
          if (err instanceof SyntaxError) {
            throw new Error(`Parse error: Invalid JSON response from ${providerUrl}`);
          }
          throw err;
        }
      };

      try {
        // Non-blocking status query: wait_until: 'NONE' returns immediately
        // (prevents FastNEAR/QuickNode 30-second server-side long-poll lockup)
        let data: any = await callRpc('EXPERIMENTAL_tx_status', {
          tx_hash: txHash,
          sender_account_id: accountId,
          wait_until: 'NONE',
        });

        // Fallback 1: If provider rejects object params with parse error, try array params
        if (data?.error?.code === -32700 || data?.error?.message?.includes('Parse error')) {
          data = await callRpc('EXPERIMENTAL_tx_status', [txHash, accountId]);
        }

        // Fallback 2: If provider doesn't support EXPERIMENTAL_tx_status (-32601), fall back to `tx`
        if (data?.error?.code === -32601) {
          data = await callRpc('tx', {
            tx_hash: txHash,
            sender_account_id: accountId,
            wait_until: 'NONE',
          });
          if (data?.error?.code === -32700 || data?.error?.message?.includes('Parse error')) {
            data = await callRpc('tx', [txHash, accountId]);
          }
        }

        if (data?.error) {
          const code: number = data.error?.code ?? 0;
          const errName: string = data.error?.cause?.name ?? data.error?.name ?? (typeof data.error === 'string' ? data.error : data.error?.message ?? '');
          const errMsg: string = typeof data.error === 'string' ? data.error : (data.error?.message ?? '');
          const errData: string = typeof data.error?.data === 'string' ? data.error.data : JSON.stringify(data.error?.data ?? '');

          // Rate limit exceeded handling
          if (
            code === -32003 ||
            MultiRpcNear.isNetworkError(errMsg) ||
            MultiRpcNear.isNetworkError(errName) ||
            MultiRpcNear.isNetworkError(errData)
          ) {
            const provider = this.tradeProviders.find(p => p.url === providerUrl);
            if (provider) markProviderError(provider, true);
            return null;
          }

          // Transient / "not yet indexed" conditions — return null to retry
          if (
            code === -32601 ||                         // method still not available
            errName.includes('TIMEOUT') ||
            errName.includes('HANDLER_ERROR') ||
            errName.includes('UNKNOWN_TRANSACTION') ||
            errMsg.includes('does not exist') ||
            errData.includes('does not exist') ||
            errName.includes('Parse error')           // Treat parse errors as transient
          ) {
            return null;
          }
          throw new Error(data.error.message || JSON.stringify(data.error));
        }

        const outcome = data?.result;
        if (outcome) {
          // The node KNOWS this transaction — even if receipts are still
          // executing. Distinguishes "slow confirmation" from "tx vanished".
          if (state) state.everSeen = true;
          if (outcome.status !== undefined && outcome.status !== null) {
            return outcome;
          }
        }
      } catch (err: any) {
        // Network-level or thrown error — record and continue
        lastErr = err as Error;
        const msg = (err.message || '').toLowerCase();
        
        // If it's a parse error or rate limit, mark the provider as unhealthy
        if (msg.includes('parse error') || msg.includes('429') || msg.includes('rate limit') || msg.includes('daily request limit')) {
          const provider = this.tradeProviders.find(p => p.url === providerUrl);
          if (provider) {
            markProviderError(provider, true);
          }
        }
      }
      return null;
    };

    let polls = 0;
    while (Date.now() < deadline) {
      // Query all candidate RPC endpoints concurrently from poll 0 to capture the fastest confirmation
      const pollTargets = allPollUrls.length > 0 ? allPollUrls : [pinnedUrl];
      const outcomes = await Promise.allSettled(pollTargets.map(url => tryRpc(url)));
      for (const res of outcomes) {
        if (res.status === 'fulfilled' && res.value) {
          const outcome = res.value;
          const fes = outcome.final_execution_status;
          const fullyExecuted = fes === 'EXECUTED' || fes === 'EXECUTED_OPTIMISTIC' || fes === 'FINAL';
          if (fullyExecuted && Array.isArray(outcome.receipts_outcome) && outcome.receipts_outcome.length > 0) {
            return outcome;
          }
        }
      }

      polls++;
      // Ultra-fast responsive polling: 80ms for first 15 polls (~1.2s), then 150ms for next 15 polls, then 300ms
      const pollDelay = polls < 15 ? 80 : (polls < 30 ? 150 : 300);
      await sleep(pollDelay);
    }

    const neverSeen = !(state?.everSeen);
    const errMsg = lastErr ? `: ${redactSecrets((lastErr as any).message ?? String(lastErr))}` : '';
    const timeoutErr = new TradeError(
      neverSeen
        ? `Transaction ${txHash} never reached the NEAR network within ${maxMs}ms — it was not executed and no funds were spent`
        : `Transaction ${txHash} not confirmed within ${maxMs}ms${errMsg}`,
      { code: 'NOT_CONFIRMED', txHash }
    );
    (timeoutErr as any).neverSeen = neverSeen;
    throw timeoutErr;
  }

  /**
   * Re-check the on-chain outcome of a previously broadcast transaction.
   * Used when confirmation polling timed out: the tx may have landed even
   * though the RPC never reported it. Polls up to maxMs and returns the
   * outcome once the executed receipt tree is present, or null if the
   * outcome is still unknown (caller must treat it as UNKNOWN, not failed).
   *
   * Fans out across ALL trade providers in round-robin — the pinned RPC
   * that accepted the broadcast is often the one lagging or rate-limited
   * on status polls, while a peer node already sees the same tx.
   */
  async waitForOutcome(txHash: string, accountId: string, maxMs = 60_000): Promise<any | null> {
    const deadline = Date.now() + maxMs;
    const urls = this.tradeProviders.map(p => p.url);
    let i = 0;
    while (Date.now() < deadline) {
      const url = urls[i++ % urls.length]; // undefined → queryOutcomeOnce default (pinned)
      const { outcome } = await this.queryOutcomeOnce(txHash, accountId, url).catch(() => ({ outcome: null, error: null }));
      if (outcome) return outcome;
      await sleep(1_000);
    }
    return null;
  }

  /**
   * Single-shot outcome query on ONE trade RPC (pinned by default). Returns the
   * outcome (only once the receipt tree is present) or null for any transient
   * condition — unknown tx, rate limit, RPC error, empty receipt tree.
   * Structured as { outcome, error } so callers can surface the last real
   * error (e.g. in the NOT_CONFIRMED timeout message).
   */
  private async queryOutcomeOnce(txHash: string, accountId: string, providerUrl: string = this.tradeProvider.url): Promise<{ outcome: any | null; error: Error | null }> {
    let lastError: Error | null = null;

    const callRpc = async (method: string, params: any): Promise<any | null> => {
      try {
        const provider = this.tradeProviders.find(p => p.url === providerUrl);
        const headers = provider?.headers ?? { 'Content-Type': 'application/json' };
        const res = await fetch(providerUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({ jsonrpc: '2.0', id: 'await-outcome', method, params }),
          signal: AbortSignal.timeout(2500),
        });

        if (res.status === 429) {
          const provider = this.tradeProviders.find(p => p.url === providerUrl);
          if (provider) markProviderError(provider);
          return null;
        }

        const text = await res.text();
        if (!text || text.trim() === '') {
          throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }

        let parsed: any;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }

        // If HTTP returned error status and no JSON-RPC error payload was received, throw
        if (!res.ok && !parsed?.error) {
          throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }

        return parsed;
      } catch (err: any) {
        if (err instanceof SyntaxError) {
          throw new Error(`Parse error: Invalid JSON response from ${providerUrl}`);
        }
        throw err;
      }
    };

    try {
      // First attempt: EXPERIMENTAL_tx_status with object params and wait_until: 'NONE'
      // Non-blocking query returns immediately instead of holding connection open
      let data: any = await callRpc('EXPERIMENTAL_tx_status', {
        tx_hash: txHash,
        sender_account_id: accountId,
        wait_until: 'NONE',
      });

      // Fallback 1: If provider rejects object params with parse error, try 2-element array [txHash, accountId]
      if (data?.error?.code === -32700 || data?.error?.message?.includes('Parse error')) {
        data = await callRpc('EXPERIMENTAL_tx_status', [txHash, accountId]);
      }

      // Fallback 2: If provider doesn't support EXPERIMENTAL_tx_status (-32601), fall back to `tx`
      if (data?.error?.code === -32601) {
        data = await callRpc('tx', {
          tx_hash: txHash,
          sender_account_id: accountId,
          wait_until: 'NONE',
        });
        if (data?.error?.code === -32700 || data?.error?.message?.includes('Parse error')) {
          data = await callRpc('tx', [txHash, accountId]);
        }
      }

      if (data?.error) {
        const code: number = data.error?.code ?? 0;
        const errName: string = data.error?.cause?.name ?? data.error?.name ?? (typeof data.error === 'string' ? data.error : data.error?.message ?? '');
        const errMsg: string = typeof data.error === 'string' ? data.error : (data.error?.message ?? '');
        const errData: string = typeof data.error?.data === 'string' ? data.error.data : JSON.stringify(data.error?.data ?? '');

        // Rate limit exceeded handling
        if (
          code === -32003 ||
          MultiRpcNear.isNetworkError(errMsg) ||
          MultiRpcNear.isNetworkError(errName) ||
          MultiRpcNear.isNetworkError(errData)
        ) {
          const provider = this.tradeProviders.find(p => p.url === providerUrl);
          if (provider) markProviderError(provider, true);
          return { outcome: null, error: null };
        }

        // Transient / "not yet indexed" conditions — return null to retry
        if (
          code === -32601 ||                         // method still not available
          errName.includes('TIMEOUT') ||
          errName.includes('HANDLER_ERROR') ||
          errName.includes('UNKNOWN_TRANSACTION') ||
          errMsg.includes('does not exist') ||
          errData.includes('does not exist') ||
          errName.includes('Parse error')           // Treat parse errors as transient
        ) {
          return { outcome: null, error: null };
        }
        throw new Error(data.error.message || JSON.stringify(data.error));
      }

      const outcome = data?.result;
      if (outcome && outcome.status !== undefined && outcome.status !== null
        && Array.isArray(outcome.receipts_outcome) && outcome.receipts_outcome.length > 0) {
        return { outcome, error: null };
      }
      return { outcome: null, error: null };
    } catch (err: any) {
      // Network-level or thrown error — record and continue
      lastError = err as Error;
      const msg = (err.message || '').toLowerCase();

      // If it's a parse error or rate limit, mark the provider as unhealthy
      if (msg.includes('parse error') || msg.includes('429') || msg.includes('rate limit') || msg.includes('daily request limit')) {
        const provider = this.tradeProviders.find(p => p.url === providerUrl);
        if (provider) {
          markProviderError(provider, true);
        }
      }
      return { outcome: null, error: lastError };
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Safe defaults so a missing/partial RPC_PROVIDERS never crashes a service (Free validator nodes first, then FastNEAR). */
export const DEFAULT_RPC_URLS = [
  'https://rpc.mainnet.fastnear.com',
  'https://near.drpc.org',
  'https://rpc.intea.rs',
  'https://rpc.shitzuapes.xyz',
  'https://free.rpc.fastnear.com',
];

let _nearInstance: MultiRpcNear | null = null;
let _freeNearInstance: MultiRpcNear | null = null;

export const FREE_RPC_URLS = [
  'https://near.drpc.org',
  'https://rpc.intea.rs',
  'https://rpc.shitzuapes.xyz',
  'https://free.rpc.fastnear.com',
];

export function getFreeNear(): MultiRpcNear {
  if (!_freeNearInstance) {
    // Uses free public RPC endpoints with automatic failover — no paid API key attached
    _freeNearInstance = new MultiRpcNear(FREE_RPC_URLS);
  }
  return _freeNearInstance;
}

export function getNear(rpcUrls?: string[]): MultiRpcNear {

  if (!_nearInstance) {
    const urls =
      rpcUrls ??
      (process.env.RPC_PROVIDERS ?? '')
        .split(',')
        .map((u) => u.trim())
        .filter(Boolean);
    _nearInstance = new MultiRpcNear(urls.length > 0 ? urls : DEFAULT_RPC_URLS);
  }
  return _nearInstance;
}

/**
 * Clear the cached access key / nonce info on the singleton MultiRpcNear instance.
 */
export function clearAccessKeyCache(accountId: string): void {
  if (_nearInstance) {
    _nearInstance.clearAccessKeyCache(accountId);
  }
}

/**
 * FastNEAR Indexer REST API helpers (https://api.fastnear.com) with in-memory caching
 * and single-flight request coalescing to minimize credit consumption.
 */
const fastnearTokensCache = new Map<string, { at: number; data: { account_id: string; contract_ids: string[] } }>();
const inflightFastnearTokens = new Map<string, Promise<{ account_id: string; contract_ids: string[] }>>();

export async function getFastnearAccountTokens(
  accountId: string,
  apiUrl = process.env.FASTNEAR_API_URL || 'https://api.fastnear.com',
  ttlMs = 30_000
): Promise<{ account_id: string; contract_ids: string[] }> {
  const cacheKey = `${apiUrl}:${accountId}`;
  if (ttlMs > 0) {
    const cached = fastnearTokensCache.get(cacheKey);
    if (cached && Date.now() - cached.at < ttlMs) {
      return cached.data;
    }
  }
  const inflight = inflightFastnearTokens.get(cacheKey);
  if (inflight) return inflight;

  const promise = (async () => {
    const res = await fetch(`${apiUrl}/v1/account/${accountId}/ft`);
    if (!res.ok) throw new Error(`FastNEAR API error: ${res.statusText}`);
    const data = (await res.json()) as { account_id: string; contract_ids: string[] };
    fastnearTokensCache.set(cacheKey, { at: Date.now(), data });
    return data;
  })().finally(() => {
    inflightFastnearTokens.delete(cacheKey);
  });

  inflightFastnearTokens.set(cacheKey, promise);
  return promise;
}

const fastnearPkCache = new Map<string, { at: number; data: { public_key: string; account_ids: string[] } }>();
const inflightFastnearPk = new Map<string, Promise<{ public_key: string; account_ids: string[] }>>();

export async function getFastnearPublicKeyAccounts(
  publicKey: string,
  apiUrl = process.env.FASTNEAR_API_URL || 'https://api.fastnear.com',
  ttlMs = 60_000
): Promise<{ public_key: string; account_ids: string[] }> {
  const cacheKey = `${apiUrl}:${publicKey}`;
  if (ttlMs > 0) {
    const cached = fastnearPkCache.get(cacheKey);
    if (cached && Date.now() - cached.at < ttlMs) {
      return cached.data;
    }
  }
  const inflight = inflightFastnearPk.get(cacheKey);
  if (inflight) return inflight;

  const promise = (async () => {
    const res = await fetch(`${apiUrl}/v0/public_key/${publicKey}/all`);
    if (!res.ok) throw new Error(`FastNEAR API error: ${res.statusText}`);
    const data = (await res.json()) as { public_key: string; account_ids: string[] };
    fastnearPkCache.set(cacheKey, { at: Date.now(), data });
    return data;
  })().finally(() => {
    inflightFastnearPk.delete(cacheKey);
  });

  inflightFastnearPk.set(cacheKey, promise);
  return promise;
}
