import { connect, keyStores, Near, Account, KeyPair, utils, transactions } from 'near-api-js';
import { markProviderError, markProviderSuccess, createProvider, isProviderAvailable, RPCProvider } from './rpc.js';
import { calculateExpectedOutput, calculateMinAmountOut, parseMemeCookingId } from './utils.js';
import { upsertTokenCache } from '@racerbot/db';
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
const registeredCache = new Set<string>();
const noRheaPoolCache = new Map<string, number>();
// Permanent cache for quote-asset decimals (decimals never change after launch).
const quoteDecimalsCache = new Map<string, number>();
// 10-second cache for the NEAR-denominated price of a quote asset.
const quoteNearPriceCache = new Map<string, { at: number; rate: number }>();
const QUOTE_NEAR_PRICE_TTL_MS = 10_000;

let cachedRefPools: { fromIndex: number; pools: any[] }[] | null = null;
let lastRefPoolsFetch = 0;
let fetchRefPoolsInFlight: Promise<{ fromIndex: number; pools: any[] }[]> | null = null;

async function getAllRefPoolsOnChain(near: MultiRpcNear): Promise<{ fromIndex: number; pools: any[] }[]> {
  const now = Date.now();
  if (cachedRefPools && now - lastRefPoolsFetch < 300_000) {
    return cachedRefPools;
  }
  if (fetchRefPoolsInFlight) {
    return fetchRefPoolsInFlight;
  }

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

export function parseIntearPool(rawBytes: Buffer): { asset1: string; reserve1: string; asset2: string; reserve2: string } | null {
  if (!rawBytes || rawBytes.length < 5 || rawBytes[0] !== 1) return null;
  let offset = 1;

  // Asset 1
  const asset1Type = rawBytes.readUInt8(offset);
  offset += 1;
  let asset1 = 'near';
  if (asset1Type === 1) {
    const len = rawBytes.readUInt32LE(offset);
    offset += 4;
    asset1 = rawBytes.toString('utf8', offset, offset + len);
    offset += len;
  }
  // Reserve 1 (u128)
  const r1Buf = rawBytes.subarray(offset, offset + 16);
  offset += 16;
  let reserve1 = 0n;
  for (let i = 0; i < 16; i++) {
    reserve1 |= BigInt(r1Buf[i]) << BigInt(8 * i);
  }

  // Asset 2
  const asset2Type = rawBytes.readUInt8(offset);
  offset += 1;
  let asset2 = 'near';
  if (asset2Type === 1) {
    const len = rawBytes.readUInt32LE(offset);
    offset += 4;
    asset2 = rawBytes.toString('utf8', offset, offset + len);
    offset += len;
  }
  // Reserve 2 (u128)
  const r2Buf = rawBytes.subarray(offset, offset + 16);
  offset += 16;
  let reserve2 = 0n;
  for (let i = 0; i < 16; i++) {
    reserve2 |= BigInt(r2Buf[i]) << BigInt(8 * i);
  }

  return { asset1, reserve1: reserve1.toString(), asset2, reserve2: reserve2.toString() };
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

  constructor(rpcUrls: string[], networkId = 'mainnet') {
    const rawApiKey = (process.env.FASTNEAR_API_KEY || '').trim();
    const apiKey = rawApiKey.startsWith('${') ? '' : rawApiKey;
    const hasValidKey = apiKey && !apiKey.startsWith('TEMP') && !apiKey.startsWith('change-me');
    const rawQn = (process.env.QUICKNODE_ENDPOINT_URL || '').trim();
    const qnUrl = rawQn.startsWith('${') ? '' : rawQn;
    const initialUrls = [...rpcUrls].filter(u => u && !u.startsWith('${'));
    if (qnUrl && !initialUrls.includes(qnUrl)) {
      initialUrls.push(qnUrl);
    }

    // Allow FastNEAR, official Pagoda RPC, dRPC, and QuickNode endpoints
    const allowedUrls = initialUrls.filter(url => {
      const isQn = url.includes('quiknode.pro') || url.includes('quicknode');
      const isFn = url.includes('fastnear.com') && !url.includes('free.rpc.fastnear.com'); // exclude rate-limited free endpoint from trade/read list
      const isNearOrg = url.includes('near.org');
      const isDrpc = url.includes('drpc.org');
      return isQn || isFn || isNearOrg || isDrpc;
    });

    const defaultQn = 'https://blissful-capable-road.near-mainnet.quiknode.pro/a998ed07e93a1d084f6e81cad734c368c1ecbba6/';
    const sanitizedUrls = allowedUrls.length > 0
      ? Array.from(new Set(allowedUrls))
      : ['https://rpc.mainnet.fastnear.com', 'https://rpc.mainnet.near.org', 'https://near.drpc.org', qnUrl || defaultQn];

    // Read URLs: QuickNode first (dedicated RPC), then Pagoda, FastNEAR, dRPC
    const readUrls = [
      ...sanitizedUrls.filter(u => u.includes('quiknode.pro') || u.includes('quicknode')),
      ...sanitizedUrls.filter(u => u.includes('near.org')),
      ...sanitizedUrls.filter(u => u.includes('fastnear.com')),
      ...sanitizedUrls.filter(u => u.includes('drpc.org')),
    ];

    // Trade URLs: QuickNode first, then Pagoda official node, FastNEAR, dRPC.
    // Pagoda (rpc.mainnet.near.org) and dRPC connect directly to block producers,
    // ensuring broadcasted transactions are instantly relayed to the mempool even
    // if QuickNode reaches daily quota limits.
    const tradeUrls = [
      ...sanitizedUrls.filter(u => u.includes('quiknode.pro') || u.includes('quicknode')),
      ...sanitizedUrls.filter(u => u.includes('near.org')),
      ...sanitizedUrls.filter(u => u.includes('fastnear.com')),
      ...sanitizedUrls.filter(u => u.includes('drpc.org')),
    ];

    this.readProviders = readUrls.map((url, i) => {
      const isQn = url.includes('quiknode.pro') || url.includes('quicknode');
      const isNearOrg = url.includes('near.org');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (url.includes('rpc.mainnet.fastnear.com') && hasValidKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }
      const name = isQn ? `quicknode-read-${i}` : (isNearOrg ? `pagoda-read-${i}` : `fastnear-read-${i}`);
      return createProvider(url, name, isQn, headers);
    });

    this.tradeProviders = tradeUrls.map((url, i) => {
      const isQn = url.includes('quiknode.pro') || url.includes('quicknode');
      const isNearOrg = url.includes('near.org');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (url.includes('rpc.mainnet.fastnear.com') && hasValidKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }
      const name = isQn ? `quicknode-trade-${i}` : (isNearOrg ? `pagoda-trade-${i}` : `trade-rpc-${i}`);
      return createProvider(url, name, isQn, headers);
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

    const apiKey = (process.env.FASTNEAR_API_KEY || '').trim();
    const hasValidKey = apiKey && !apiKey.startsWith('TEMP') && !apiKey.startsWith('change-me');
    let nodeUrl = providerUrl;
    const isMainnetFastnear = nodeUrl.includes('rpc.mainnet.fastnear.com');

    if (isMainnetFastnear && hasValidKey && !nodeUrl.includes('apiKey=')) {
      const sep = nodeUrl.includes('?') ? '&' : '?';
      nodeUrl = `${nodeUrl}${sep}apiKey=${apiKey}`;
    }

    const conn = await connect({
      networkId: this.networkId,
      nodeUrl,
      keyStore: this.keyStore,
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
  private static readonly HEDGE_MS = 250;
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
   * Read-only view call — QuickNode-first with hedged FastNEAR fallback.
   *
   * Semantics:
   *   1. Send to ALL eligible QuickNode providers immediately.
   *   2. First success wins, abort all others.
   *   3. If QuickNode rejects (network error) before HEDGE_MS, launch FastNEAR immediately.
   *      If still no success at HEDGE_MS, launch FastNEAR regardless.
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

    const fastnear = this.readProviders.filter(p => !p.isQuickNode);
    const quicknode = this.readProviders.filter(p => p.isQuickNode);

    const HEDGE_MS = MultiRpcNear.HEDGE_MS;
    const VIEW_TIMEOUT_MS = MultiRpcNear.VIEW_TIMEOUT_MS;

    // Pick best candidates per group (fall back to all in group if none eligible).
    const fnTargets = eligible(fastnear).length > 0 ? eligible(fastnear) : fastnear;
    const qnTargets = eligible(quicknode).length > 0 ? eligible(quicknode) : quicknode;

    if (fnTargets.length === 0 && qnTargets.length === 0) {
      throw new Error('No NEAR RPC providers configured');
    }

    // Controllers for each group's HTTP requests.
    const fnCtrl = new AbortController();
    const qnCtrl = new AbortController();

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
        fnCtrl.abort();
        qnCtrl.abort();
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

        // Network error on QuickNode before HEDGE_MS → launch FastNEAR early.
        if (!settled && fnTargets.length > 0 && hedgeTimer !== null) {
          clearTimeout(hedgeTimer);
          hedgeTimer = null;
          launchFastNear();
        }

        // If all started attempts have failed, reject.
        if (resolved >= started && settled === false) {
          fail(result.err ?? new Error('All NEAR RPC providers failed'));
        }
      };

      const launchFastNear = () => {
        for (const p of fnTargets) {
          started++;
          const attempt = tryProvider(p, fnCtrl.signal);
          allAttempts.push(attempt);
          attempt.then(onAttemptDone);
        }
      };

      const launchQuickNode = () => {
        for (const p of qnTargets) {
          started++;
          const attempt = tryProvider(p, qnCtrl.signal);
          allAttempts.push(attempt);
          attempt.then(onAttemptDone);
        }
      };

      // Hard cap: reject regardless of in-flight state.
      capTimer = setTimeout(() => {
        fail(new Error('NEAR RPC view hard cap exceeded (3000 ms)'));
      }, VIEW_TIMEOUT_MS);

      if (qnTargets.length > 0) {
        launchQuickNode();
        // Hedge: after HEDGE_MS with no response from QuickNode, also send to FastNEAR fallback.
        if (fnTargets.length > 0) {
          hedgeTimer = setTimeout(() => {
            hedgeTimer = null;
            if (!settled) launchFastNear();
          }, HEDGE_MS);
        }
      } else {
        // QuickNode not configured — go straight to FastNEAR.
        launchFastNear();
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
  }

  /**
   * Get account NEAR balance from trade RPC providers (hedged optimistic/final view_account).
   */
  async getNearBalance(accountId: string): Promise<string> {
    for (const provider of this.tradeProviders) {
      try {
        const res = await fetch(provider.url, {
          method: 'POST',
          headers: provider.headers ?? { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'racerbot-bal',
            method: 'query',
            params: { request_type: 'view_account', account_id: accountId, finality: 'optimistic' },
          }),
          signal: AbortSignal.timeout(2500),
        });
        const data: any = await res.json();
        if (data?.result?.amount) return data.result.amount as string;
      } catch {}
    }
    // Fallback: final finality across providers
    for (const provider of this.tradeProviders) {
      try {
        const res = await fetch(provider.url, {
          method: 'POST',
          headers: provider.headers ?? { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'racerbot-bal-final',
            method: 'query',
            params: { request_type: 'view_account', account_id: accountId, finality: 'final' },
          }),
          signal: AbortSignal.timeout(2500),
        });
        const data: any = await res.json();
        if (data?.result?.amount) return data.result.amount as string;
      } catch {}
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
  async findRheaPoolId(tokenA: string, tokenB: string): Promise<number> {
    const cacheKey1 = `${tokenA}:${tokenB}`;
    const cacheKey2 = `${tokenB}:${tokenA}`;
    if (rheaPoolIdCache.has(cacheKey1)) return rheaPoolIdCache.get(cacheKey1)!;
    if (rheaPoolIdCache.has(cacheKey2)) return rheaPoolIdCache.get(cacheKey2)!;

    // 1. Check Ref Finance indexer top pools (covers thousands of active pools instantly)
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

    // 2. Fast REST lookup via api.ref.finance (covers ALL Ref Finance pools)
    // Resolves any pool in <5s — avoids slow 30x on-chain batch scanning.
    try {
      const _url = 'https://api.ref.finance/list-pools-by-tokens?token0=' +
        encodeURIComponent(tokenA) + '&token1=' + encodeURIComponent(tokenB);
      const _r = await fetch(_url, { signal: AbortSignal.timeout(5000) });
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
        }
      }
    } catch { /* no-op */ }
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
    if (pairedToken === 'usdt.tether-token.near' || pairedToken === 'usdc.near') {
      try {
        const pId = await this.findRheaPoolId('wrap.near', pairedToken).catch(() => null);
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
    // General fallback: check if pairedToken has a wNEAR pool on Ref
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
    } catch { /* no-op */ }
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
              return {
                poolId: dclPoolId,
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
  async findDclPoolId(tokenA: string, tokenB: string): Promise<string | null> {
    const key = `${tokenA}:${tokenB}`;
    const cached = dclPoolIdCache.get(key);
    if (cached) return cached;

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
        if (pool && pool.state === 'Running' && !isWhitelisted) {
          const quoteReserve = BigInt(
            pool.token_x === quoteToken ? (pool.total_x || '0')
            : pool.token_y === quoteToken ? (pool.total_y || '0')
            : '0'
          );
          return { poolId, quoteReserve };
        }
        throw new Error('not running or whitelisted');
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

    const reserveNear = baseIsX ? (pool.total_x || '0') : (pool.total_y || '0');
    const reserveToken = baseIsX ? (pool.total_y || '0') : (pool.total_x || '0');
    const reserveNearNum = parseFloat(reserveNear) / Math.pow(10, baseDecimals);
    const liquidityNear = reserveNearNum * rateInNear * 2;

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

    const dclPoolId = launch?.pool_id || (await this.findDclPoolId('wrap.near', tokenAddress).catch(() => null));
    if (!launch && !dclPoolId) {
      throw new Error(`Token ${tokenAddress} not found on NEARpad launchpad`);
    }

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

    if (dclPoolId) {
      try {
        const dcl = await this.getDclPoolState(dclPoolId, pairedToken);
        price = dcl.price;
        liquidityNear = dcl.liquidityNear;
        reserveNear = dcl.reserveNear;
        reserveToken = dcl.reserveToken;
      } catch {
        // Pool may be creating or empty
      }
    }

    return {
      token: tokenAddress,
      dclPoolId,
      status: launch?.status || 'Active',
      pairedToken,
      price,
      liquidityNear,
      reserveNear,
      reserveToken,
      totalSupply: '0',
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
    | { kind: 'multihop'; quote: string; launchPoolId: string; hop1: { type: 'dcl' | 'v2'; poolId: string } }
  > {
    const st = await this.getShoremarketsTokenState(tokenAddress);
    const launchPoolId = st.pool_id;

    if (st.quoteIsNear) {
      return { kind: 'direct', launchPoolId, quote: 'wrap.near' };
    }

    const quote = st.quote;

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

    const leftPoint = Number(launch.left_point);
    const rightPoint = Number(launch.right_point);
    const currentPoint = Number(pool.current_point);
    const span = rightPoint - leftPoint;
    const offset = currentPoint - leftPoint;
    const progressPct = span > 0 ? Math.min(100, Math.max(0, (offset / span) * 100)) : 100;

    const live = launch.step === 'Done' && pool.state === 'Running';
    const isBonded = launch.step === 'Done' && (progressPct >= 100 || pool.state !== 'Running');
    const bondingPhase: 'prebonded' | 'bonded' = isBonded ? 'bonded' : 'prebonded';

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
    | { kind: 'multihop'; quote: string; launchPoolId: string; hop1: { type: 'dcl' | 'v2'; poolId: string } }
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

    // 5. Fallback: DCL pool
    if (dclHop) {
      const res = { kind: 'multihop' as const, quote, launchPoolId, hop1: { type: 'dcl' as const, poolId: dclHop } };
      ntRouteCache.set(tokenAddress, { at: Date.now(), route: res });
      return res;
    }

    throw new Error(
      `Token ${tokenAddress} is paired with ${quote}. No NEAR route to ${quote} was found, so it cannot be traded from NEAR.`
    );
  }

  /**
   * Find pool ID on dex.intear.near (slimedragon.near/xyk) for a token
   */
  async findIntearPoolId(tokenAddress: string): Promise<number> {
    if (intearPoolCache.has(tokenAddress)) {
      return intearPoolCache.get(tokenAddress)!;
    }

    // Scan pools from newest (250 down to 0) in parallel batches of 25
    for (let start = 250; start >= 0; start -= 25) {
      const promises: Promise<{ id: number; data: any } | null>[] = [];
      const batchStart = Math.max(0, start - 24);
      for (let i = start; i >= batchStart; i--) {
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
        if (r) {
          if (r.data.asset1.includes('.near')) intearPoolCache.set(r.data.asset1, r.id);
          if (r.data.asset2.includes('.near')) intearPoolCache.set(r.data.asset2, r.id);
          if (r.data.asset1 === tokenAddress || r.data.asset2 === tokenAddress) {
            intearPoolCache.set(tokenAddress, r.id);
            // FIX 5: Persist found pool ID to DB so it survives process restarts.
            // This prevents the expensive 250-pool scan from repeating after a Railway redeploy.
            setImmediate(() => {
              upsertTokenCache({
                token_address: tokenAddress,
                venue: 'intear',
                // Store pool ID in dcl_pool_id column (reuse existing column; intear uses integer IDs)
                dcl_pool_id: String(r.id),
                updated_at: new Date(),
              }).catch(() => {});
            });
            return r.id;
          }
        }
      }
    }

    throw new Error(`Intear pool for ${tokenAddress} not found on dex.intear.near`);
  }

  /**
   * Query Intear token state, reserves, real spot price, and liquidity on-chain.
   */
  async getIntearTokenState(tokenAddress: string): Promise<{
    poolId: number;
    poolMsg: string;
    price: number;
    liquidityNear: number;
    reserveNear: string;
    reserveToken: string;
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
    const meta = await this.getTokenMetadata(tokenAddress).catch(() => ({
      name: tokenAddress.split('.')[0] || 'Unknown',
      symbol: (tokenAddress.split('.')[0] || 'TKN').toUpperCase(),
      decimals: 24,
      total_supply: '0',
    }));

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
    const reserveNear = BigInt(isToken1 ? pool.reserve2 : pool.reserve1);
    const reserveToken = BigInt(isToken1 ? pool.reserve1 : pool.reserve2);

    const nearAmt = Number(reserveNear) / 1e24;
    const tokenDecFactor = Math.pow(10, meta.decimals);
    const tokenAmt = Number(reserveToken) / tokenDecFactor;

    const price = tokenAmt > 0 ? nearAmt / tokenAmt : 0;
    const liquidityNear = nearAmt * 2;

    const launchData = await this.view<any>('launch.intear.near', 'get_launch_data', {
      token_account_id: tokenAddress,
    }).catch(() => undefined);

    return {
      poolId,
      poolMsg,
      price,
      liquidityNear,
      reserveNear: reserveNear.toString(),
      reserveToken: reserveToken.toString(),
      name: meta.name,
      symbol: meta.symbol,
      decimals: meta.decimals,
      totalSupply: meta.total_supply,
      launchData,
    };
  }

  /**
   * Compute expected output and min_amount_out dynamically from live pool reserves.
   * Never uses cached reserves older than the call itself.
   */
  async computeMinAmountOut(
    venue: 'rhea' | 'ref' | 'shardsmarket' | 'nearlytrade' | 'intear' | 'memecooking' | 'onetokenhub' | 'gaypad' | 'nearpad' | 'shoremarkets' | 'kelytra',
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
              pool_ids: [route.hop1.poolId, launchPoolId],
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
              pool_ids: [launchPoolId, route.hop1.poolId],
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
    } else if (venue === 'rhea' || venue === 'ref') {
      const inToken = tokenIn === 'near' ? 'wrap.near' : tokenIn;
      const outToken = tokenOut === 'near' ? 'wrap.near' : tokenOut;

      if (dclPoolId) {
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
        if (!interToken || rheaState.pairedToken === 'wrap.near') {
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
          } catch { /* fall through */ }
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
              const poolIds = isBuyDirection
                ? [route.hop1.poolId, launchPoolId]
                : [launchPoolId, route.hop1.poolId];
              const q = await this.view<any>('dclv2.ref-labs.near', 'quote', {
                pool_ids: poolIds,
                input_token: inToken,
                output_token: outToken,
                input_amount: amountIn,
              });
              const finalOut = BigInt(q?.amount || '0');
              if (finalOut <= 0n) throw new Error('Atomic 2-hop DCL quote returned 0');
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
      let state;
      try {
        state = await this.getIntearTokenState(targetToken);
      } catch {
        throw new Error(
          `Intear RPC failed for ${targetToken}. Token may be on Intear but RPC is unreachable.`
        );
      }
      const reserveNear = BigInt(state.reserveNear);
      const reserveToken = BigInt(state.reserveToken);

      const isBuy = tokenIn === 'wrap.near' || tokenIn === 'near';
      const reserveIn = isBuy ? reserveNear : reserveToken;
      const reserveOut = isBuy ? reserveToken : reserveNear;

      // Intear XYK pool fee (30 bps / 0.3%)
      const expected = calculateExpectedOutput(amountIn, reserveIn, reserveOut, 30);
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
    waitForMs = 40_000,
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
    const signOnce = async (forceIncrement = false): Promise<{ hash: string; signedB64: string; nonce: bigint }> => {
      const publicKey = await account.connection.signer.getPublicKey(accountId, account.connection.networkId);
      if (!publicKey) {
        throw new Error(`No matching key pair found for ${accountId}`);
      }
      const pkStr = publicKey.toString();
      const nonceCacheKey = `${accountId}:${pkStr}`;

      (account as any).accessKeyByPublicKeyCache = {};
      // Access-key nonce and block hash are hedged across ALL trade providers
      // (QuickNode + FastNEAR). Both are chain-global reads, so racing endpoints
      // is safe and removes the single-pinned-RPC stall from the sign path;
      // the nonce read takes the MAX answer across providers.
      const [rawAccessKey, blockHashB58] = await Promise.all([
        this.queryAccessKeyHedged(accountId, pkStr),
        this.fetchBlockHashHedged(),
      ]);
      const chainNonce = BigInt(rawAccessKey?.nonce || 0);

      const prevTracked = this.highestUsedNonce.get(nonceCacheKey) ?? 0n;
      let baseNonce = chainNonce > prevTracked ? chainNonce : prevTracked;
      if (forceIncrement && baseNonce <= prevTracked) {
        baseNonce = prevTracked;
      }
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
      try {
        await this.broadcastToAll(signed.signedB64);
      } catch (err: any) {
        await this.broadcastSigned(signed.signedB64);
      }
      // The network has accepted the signed transaction. Confirmation and
      // receipt execution can take longer, but callers can now immediately
      // show a truthful "submitted" state instead of appearing frozen.
      onBroadcast?.(signed.hash);

      const broadcastMs = Date.now() - tStart;
      const seen = { everSeen: false };
      // Phase 1: Fan-out poll across all trade providers (QuickNode + FastNEAR)
      const firstWindow = Math.min(8_000, Math.max(4_000, waitForMs - 15_000));
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
        // it was dropped by the mempool (congestion / relay drop).
        // Re-sign with a strictly incremented fresh nonce so the mempool receives
        // a brand-new nonce that cannot conflict with the dropped transaction.
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
        const remainingMs = Math.max(10_000, waitForMs - (Date.now() - tStart));
        outcome = await this.awaitOutcome(freshSigned.hash, accountId, remainingMs, seen2, allProviderUrls);
        }
      }

      // Perf instrumentation for trade_attempts timings (click→quote→sign→
      // broadcast→confirm). Attached non-enumerably-safe plain fields.
      outcome.__perf = {
        broadcastMs,
        confirmMs: Date.now() - tStart,
      };
      return outcome;
    } finally {
      // Invariant: always wipe access key nonce cache when leaving signAndSendTransactionAll,
      // so no subsequent trade attempt ever uses a stale or gapped in-memory nonce.
      (account as any).accessKeyByPublicKeyCache = {};
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

      const data: any = await res.json();
      if (data?.error) throw new Error(data.error.message || JSON.stringify(data.error));
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
              new Promise<null>(r => setTimeout(() => r(null), 30))
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
      const qnUrl = process.env.QUICKNODE_ENDPOINT_URL || 'https://blissful-capable-road.near-mainnet.quiknode.pro/a998ed07e93a1d084f6e81cad734c368c1ecbba6/';
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

      const data: any = await res.json();
      const hash = data?.result?.header?.hash;
      if (!hash) throw new Error(data?.error?.message || 'no block hash in response');
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
      const qnUrl = process.env.QUICKNODE_ENDPOINT_URL || 'https://blissful-capable-road.near-mainnet.quiknode.pro/a998ed07e93a1d084f6e81cad734c368c1ecbba6/';
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
      const data: any = await res.json();
      if (data?.error) {
        const errMsg = data.error.message || JSON.stringify(data.error);
        console.warn(`[NEAR] broadcastToAll ${provider.name || provider.url} error:`, errMsg);
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
    // All URLs to poll in round-robin. Always starts with pinned.
    // extraUrls are queried after pinned each iteration (fan-out polling after rescue).
    const allPollUrls: string[] = [pinnedUrl, ...((extraUrls ?? []).filter(u => u !== pinnedUrl))];

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
        if (msg.includes('parse error') || msg.includes('429') || msg.includes('rate limit')) {
          const provider = this.tradeProviders.find(p => p.url === providerUrl);
          if (provider) {
            markProviderError(provider);
          }
        }
      }
      return null;
    };

    let polls = 0;
    while (Date.now() < deadline) {
      // Primary check: pinnedUrl (QuickNode)
      const outcome = await tryRpc(pinnedUrl).catch((err) => {
        lastErr = err as Error;
        return null;
      });

      if (outcome) {
        const fes = outcome.final_execution_status;
        const fullyExecuted = fes === 'EXECUTED' || fes === 'EXECUTED_OPTIMISTIC' || fes === 'FINAL';
        if (fullyExecuted && Array.isArray(outcome.receipts_outcome) && outcome.receipts_outcome.length > 0) {
          return outcome;
        }
      }

      // If primary RPC hasn't confirmed after 2 polls (~200ms), also query secondary endpoints in parallel
      if (polls >= 2 && allPollUrls.length > 1) {
        for (const url of allPollUrls) {
          if (url === pinnedUrl) continue;
          if (Date.now() >= deadline) break;
          const altOutcome = await tryRpc(url).catch(() => null);
          if (altOutcome) {
            const fes = altOutcome.final_execution_status;
            const fullyExecuted = fes === 'EXECUTED' || fes === 'EXECUTED_OPTIMISTIC' || fes === 'FINAL';
            if (fullyExecuted && Array.isArray(altOutcome.receipts_outcome) && altOutcome.receipts_outcome.length > 0) {
              return altOutcome;
            }
          }
        }
      }

      polls++;
      // Fast polling: 100ms for first 10 polls (~1s), then 200ms for next 10 polls, then 400ms
      const pollDelay = polls < 10 ? 100 : (polls < 20 ? 200 : 400);
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
      if (msg.includes('parse error') || msg.includes('429') || msg.includes('rate limit')) {
        const provider = this.tradeProviders.find(p => p.url === providerUrl);
        if (provider) {
          markProviderError(provider);
        }
      }
      return { outcome: null, error: lastError };
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Safe defaults so a missing/partial RPC_PROVIDERS never crashes a service (FastNEAR, Pagoda, dRPC, QuickNode). */
export const DEFAULT_RPC_URLS = [
  'https://rpc.mainnet.fastnear.com',
  'https://rpc.mainnet.near.org',
  'https://near.drpc.org',
  process.env.QUICKNODE_ENDPOINT_URL || 'https://blissful-capable-road.near-mainnet.quiknode.pro/a998ed07e93a1d084f6e81cad734c368c1ecbba6/',
];

let _nearInstance: MultiRpcNear | null = null;
let _freeNearInstance: MultiRpcNear | null = null;

export function getFreeNear(): MultiRpcNear {
  if (!_freeNearInstance) {
    // Uses FastNEAR free public endpoint — no paid API key attached
    _freeNearInstance = new MultiRpcNear(['https://free.rpc.fastnear.com']);
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
 * FastNEAR Indexer REST API helpers (https://api.fastnear.com)
 */
export async function getFastnearAccountTokens(
  accountId: string,
  apiUrl = process.env.FASTNEAR_API_URL || 'https://api.fastnear.com'
): Promise<{ account_id: string; contract_ids: string[] }> {
  const res = await fetch(`${apiUrl}/v1/account/${accountId}/ft`);
  if (!res.ok) throw new Error(`FastNEAR API error: ${res.statusText}`);
  return res.json() as Promise<{ account_id: string; contract_ids: string[] }>;
}

export async function getFastnearPublicKeyAccounts(
  publicKey: string,
  apiUrl = process.env.FASTNEAR_API_URL || 'https://api.fastnear.com'
): Promise<{ public_key: string; account_ids: string[] }> {
  const res = await fetch(`${apiUrl}/v0/public_key/${publicKey}/all`);
  if (!res.ok) throw new Error(`FastNEAR API error: ${res.statusText}`);
  return res.json() as Promise<{ public_key: string; account_ids: string[] }>;
}
