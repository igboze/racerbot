import { connect, keyStores, Near, Account, KeyPair, utils, transactions } from 'near-api-js';
import { markProviderError, markProviderSuccess, createProvider, RPCProvider } from './rpc.js';
import { calculateExpectedOutput, calculateMinAmountOut, parseMemeCookingId } from './utils.js';
import { upsertTokenCache } from '@racerbot/db';
import { redactSecrets } from './errors.js';

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
      const numPools = await near.view<number>('v2.ref-finance.near', 'get_number_of_pools', {}).catch(() => 0);
      if (!numPools || numPools <= 0) return cachedRefPools || [];

      console.log(`[findRheaPoolForToken] Refreshing on-chain pool cache across all ${numPools} pools (cached for 5m)...`);
      const batchSize = 250;
      const starts: number[] = [];
      for (let s = Math.max(0, numPools - batchSize); s >= 0; s -= batchSize) {
        starts.push(s);
      }

      const results: { fromIndex: number; pools: any[] }[] = [];
      const concurrency = 6;
      for (let i = 0; i < starts.length; i += concurrency) {
        const slice = starts.slice(i, i + concurrency);
        const batchResults = await Promise.allSettled(
          slice.map(async (fromIndex) => {
            const pools = await near.view<any[]>('v2.ref-finance.near', 'get_pools', { from_index: fromIndex, limit: batchSize });
            return { fromIndex, pools: pools || [] };
          })
        );
        for (const r of batchResults) {
          if (r.status === 'fulfilled') {
            results.push(r.value);
          }
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
 * Writes (BUY/SELL: nonce fetch, sign, broadcast, confirm) go to ONE pinned
 * RPC provider — no fan-out, no fallback. If that RPC fails, the trade fails
 * with a clear error instead of racing duplicates across endpoints.
 */
export class MultiRpcNear {
  private readProviders: RPCProvider[];
  private tradeProviders: RPCProvider[];
  private keyStore: keyStores.InMemoryKeyStore;
  private networkId: string;
  private connections: Map<string, Near> = new Map();
  private accountCache: Map<string, Account> = new Map();
  private nonceCacheRefreshInterval: NodeJS.Timeout | null = null;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private currentIndex = 0;
  // Coalescing: identical in-flight view calls share one request
  private inflightViews = new Map<string, Promise<any>>();
  // Short-TTL result cache for display-path reads only (see viewCached)
  private viewResultCache = new Map<string, { at: number; value: any }>();

  constructor(rpcUrls: string[], networkId = 'mainnet') {
    const apiKey = (process.env.FASTNEAR_API_KEY || '').trim();
    const hasValidKey = apiKey && !apiKey.startsWith('TEMP') && !apiKey.startsWith('change-me');
    const qnUrl = (process.env.QUICKNODE_ENDPOINT_URL || '').trim();
    const initialUrls = [...rpcUrls];
    if (qnUrl && !initialUrls.includes(qnUrl)) {
      initialUrls.push(qnUrl);
    }

    // Strictly filter: allow ONLY FastNEAR and QuickNode endpoints
    const fastnearAndQnUrls = initialUrls.filter(url => {
      const isQn = url.includes('quiknode.pro') || url.includes('quicknode');
      const isFn = url.includes('fastnear.com');
      return isQn || isFn;
    });

    const sanitizedUrls = fastnearAndQnUrls.length > 0
      ? Array.from(new Set(fastnearAndQnUrls))
      : ['https://rpc.mainnet.fastnear.com'];

    // Prioritize QuickNode first, then FastNEAR
    const prioritizedUrls = [
      ...sanitizedUrls.filter(u => u.includes('quiknode.pro') || u.includes('quicknode')),
      ...sanitizedUrls.filter(u => u.includes('fastnear.com')),
    ];
    // Duty split:
    //   READS  → FastNEAR first (purpose-built for fast read-heavy workloads;
    //            protects the free tier by keeping QuickNode out of the fan-out).
    //            QuickNode is the automatic failover when every FastNEAR
    //            provider is unhealthy or circuit-open.
    //   WRITES → ONE pinned provider only (tradeProviders[0]: QuickNode when
    //            configured, else FastNEAR). No fan-out, no fallback — nonce,
    //            broadcast and confirmation all use the same endpoint.
    const readUrls = [
      ...sanitizedUrls.filter(u => u.includes('fastnear.com')),
      ...sanitizedUrls.filter(u => u.includes('quiknode.pro') || u.includes('quicknode')),
    ];

    this.readProviders = readUrls.map((url, i) => {
      const isQn = url.includes('quiknode.pro') || url.includes('quicknode');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (url.includes('rpc.mainnet.fastnear.com') && hasValidKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }
      return createProvider(url, isQn ? `quicknode-read-${i}` : `fastnear-read-${i}`, isQn, headers);
    });

    const tradeUrls = Array.from(new Set(prioritizedUrls));

    this.tradeProviders = tradeUrls.map((url, i) => {
      const isQn = url.includes('quiknode.pro') || url.includes('quicknode');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (url.includes('rpc.mainnet.fastnear.com') && hasValidKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }
      return createProvider(url, isQn ? `quicknode-trade-${i}` : `trade-rpc-${i}`, isQn, headers);
    });

    this.keyStore = new keyStores.InMemoryKeyStore();
    this.networkId = networkId;

    // Start periodic nonce cache refresh to prevent stale nonce issues
    this.startNonceCacheRefresh();
  }

  /**
   * THE single RPC endpoint for the trade write path (BUY/SELL).
   * Pinned to tradeProviders[0] — QuickNode when configured, else FastNEAR.
   * Used for nonce fetch (getAccount), broadcast, and confirmation polling.
   * There is deliberately NO fallback: if this endpoint fails, the trade fails.
   */
  private get tradeProvider(): RPCProvider {
    const p = this.tradeProviders[0];
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
  private static readonly HEDGE_MS = 400;
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
      r.includes('rate limit')
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
      throw new Error(errMsg);
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
   *   3. If FastNEAR rejects (network error) before HEDGE_MS, launch QN immediately.
   *      If still no success at HEDGE_MS, launch QN regardless.
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

        // Network error on FastNEAR before HEDGE_MS → launch QN early.
        if (!settled && qnTargets.length > 0 && hedgeTimer !== null) {
          clearTimeout(hedgeTimer);
          hedgeTimer = null;
          launchQuickNode();
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

      if (fnTargets.length > 0) {
        launchFastNear();
        // Hedge: after HEDGE_MS with no response, also send to QN.
        if (qnTargets.length > 0) {
          hedgeTimer = setTimeout(() => {
            hedgeTimer = null;
            if (!settled) launchQuickNode();
          }, HEDGE_MS);
        }
      } else {
        // FastNEAR not configured — go straight to QuickNode.
        launchQuickNode();
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
    // Metadata is immutable per token — safe for the display-path cache and
    // it is fetched on nearly every token card / holdings / quote path.
    return this.viewCached<TokenMetadata>(tokenAddress, 'ft_metadata', {}, 60_000);
  }

  /**
   * Get total supply of a fungible token.
   */
  async getTokenTotalSupply(tokenAddress: string): Promise<string> {
    return this.view<string>(tokenAddress, 'ft_total_supply', {});
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
   * Get account NEAR balance from the single pinned trade RPC.
   */
  async getNearBalance(accountId: string): Promise<string> {
    const provider = this.tradeProvider;
    const near = await this.getConnection(provider.url);
    const account = await near.account(accountId);
    const state = await withTimeout<any>(account.state(), 4500, `RPC timeout on ${provider.url}`);
    return state.amount as string;
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

  /**
   * Check if account is registered for NEP-141 storage and register if not.
   * Improved with better race condition handling and stale cache detection.
   */
  async ensureStorageDeposit(accountId: string, tokenAddress: string): Promise<void> {
    if (!tokenAddress || tokenAddress === 'near') return;
    const cacheKey = `${accountId}:${tokenAddress}`;

    // Fast path: already known to be registered (or confirmed via read-only check)
    if (await this.checkStorageRegistered(accountId, tokenAddress)) return;

    try {
      // Query token's storage balance bounds to get exact required deposit if possible
      let deposit = BigInt('12500000000000000000000'); // 0.0125 NEAR fallback
      if (tokenAddress === 'wrap.near') {
        deposit = BigInt('1250000000000000000000'); // 0.00125 NEAR
      } else {
        const bounds = await this.view<any>(tokenAddress, 'storage_balance_bounds', {}).catch(() => null);
        if (bounds && bounds.min) {
          deposit = BigInt(bounds.min);
        }
      }

      await this.signAndSendTransactionAll(accountId, tokenAddress, [
        transactions.functionCall(
          'storage_deposit',
          { account_id: accountId, registration_only: true },
          BigInt('30000000000000'),
          deposit
        ),
      ], 15_000);
      registeredCache.add(cacheKey);
    } catch (err) {
      const errorMessage = (err as Error).message?.toLowerCase() || '';
      // If error indicates already registered, add to cache and succeed
      if (errorMessage.includes('already registered') || errorMessage.includes('storage already deposited')) {
        registeredCache.add(cacheKey);
        return;
      }

      console.warn(`[NEAR] storage_deposit registration_only failed for ${accountId} on ${tokenAddress}:`, (err as Error).message);
      // Try once more without registration_only for older token contracts
      try {
        const deposit = tokenAddress === 'wrap.near'
          ? BigInt('1250000000000000000000')
          : BigInt('12500000000000000000000');
        await this.signAndSendTransactionAll(accountId, tokenAddress, [
          transactions.functionCall(
            'storage_deposit',
            { account_id: accountId },
            BigInt('30000000000000'),
            deposit
          ),
        ], 15_000);
        registeredCache.add(cacheKey);
      } catch (err2) {
        const error2Message = (err2 as Error).message?.toLowerCase() || '';
        // If second attempt also indicates already registered, add to cache and succeed
        if (error2Message.includes('already registered') || error2Message.includes('storage already deposited')) {
          registeredCache.add(cacheKey);
          return;
        }
        console.warn(`[NEAR] fallback storage_deposit failed for ${accountId} on ${tokenAddress}:`, (err2 as Error).message);
        throw err2;
      }
    }
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
   * Find any active Rhea Finance pool for a token (Rule 1: check Rhea first).
   * Checks direct wrap.near pool, DCL pool, or 2-hop pool (e.g. jambo-1679.meme-cooking.near).
   */
  async findRheaPoolForToken(tokenAddress: string): Promise<{
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
    const lastNotFound = noRheaPoolCache.get(tokenAddress);
    if (lastNotFound && Date.now() - lastNotFound < 60_000) {
      return null;
    }

    const meta = await this.getTokenMetadata(tokenAddress).catch(() => ({ decimals: 18 }));
    const decimals = meta?.decimals ?? 18;

    // Helper to get conversion rate of any paired token to NEAR
    const getPairedTokenNearRate = async (pairedToken: string): Promise<{ rateInNear: number; poolId?: number; decimals: number }> => {
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
      return { rateInNear: 1, decimals: 18 };
    };

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

    // 1. Direct pool with wrap.near on v2.ref-finance.near
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
        candidates.push({
          poolId,
          pairedToken: 'wrap.near',
          isDcl: false,
          price,
          liquidityNear,
          reserveNear: rh.reserveIn,
          reserveToken: rh.reserveOut,
          fee: rh.fee,
        });
      }
    } catch { /* no-op */ }

    // Early exit: if we already have a direct wrap.near pool, no need to scan further
    if (candidates.length > 0) return candidates[0];

    // 2. DCL pool on dclv2.ref-labs.near with wrap.near
    try {
      const dclPoolId = await this.findDclPoolId('wrap.near', tokenAddress);
      if (dclPoolId) {
        const st = await this.getDclPoolState(dclPoolId, 'wrap.near');
        if (st.price > 0 && st.liquidityNear > 0) {
          candidates.push({
            poolId: dclPoolId,
            pairedToken: 'wrap.near',
            isDcl: true,
            price: st.price,
            liquidityNear: st.liquidityNear,
            reserveNear: st.reserveNear,
            reserveToken: st.reserveToken,
          });
        }
      }
    } catch { /* no-op */ }

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
            const pairedInfo = await getPairedTokenNearRate(otherToken);
            const rOtherHuman = parseFloat(rh.reserveIn) / Math.pow(10, pairedInfo.decimals);
            const rOutHuman = parseFloat(rh.reserveOut) / Math.pow(10, decimals);
            if (rOtherHuman > 0 && rOutHuman > 0) {
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
              const pairedInfo = await getPairedTokenNearRate(otherToken);
              const rOtherHuman = parseFloat(rh.reserveIn) / Math.pow(10, pairedInfo.decimals);
              const rOutHuman = parseFloat(rh.reserveOut) / Math.pow(10, decimals);
              if (rOtherHuman > 0 && rOutHuman > 0) {
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

    // 4. On-chain scan of ALL Ref Finance AMM pools (LAST RESORT — only if REST API above found nothing)
    // Results are cached globally in memory for 5 minutes across all tokens to prevent repeated scans.
    if (candidates.length === 0) try {
      const results = await getAllRefPoolsOnChain(this);
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
              const pairedInfo = await getPairedTokenNearRate(otherToken);
              const rOtherHuman = parseFloat(rh.reserveIn) / Math.pow(10, pairedInfo.decimals);
              const rOutHuman = parseFloat(rh.reserveOut) / Math.pow(10, decimals);
              if (rOtherHuman > 0 && rOutHuman > 0) {
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
    let nearPerJambo = 0.2968;
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
    // Gaypad graduates at 7.5 JAMBO
    const bondingProgressPct = Math.min(100, Math.round((jamboHeld / 7.5) * 100));

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
    const feeTiers = [10000, 3000, 2000, 400, 100];

    const results = await Promise.allSettled(
      feeTiers.map(async (fee) => {
        const poolId = `${tokenX}|${tokenY}|${fee}`;
        const pool = await this.view<any>('dclv2.ref-labs.near', 'get_pool', { pool_id: poolId });
        if (pool && pool.state === 'Running') {
          return poolId;
        }
        throw new Error('not running');
      })
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        dclPoolIdCache.set(key, r.value);
        dclPoolIdCache.set(`${tokenB}:${tokenA}`, r.value);
        return r.value;
      }
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

    const isBaseTokenX = pool.token_x === (baseToken || 'wrap.near');
    const isBaseTokenY = pool.token_y === (baseToken || 'wrap.near');
    const baseIsX = isBaseTokenX || (!isBaseTokenY);
    const targetToken = baseIsX ? pool.token_y : pool.token_x;
    const baseAccount = baseIsX ? pool.token_x : pool.token_y;

    const [targetMeta, baseMeta] = await Promise.all([
      this.getTokenMetadata(targetToken).catch(() => ({ decimals: 18 })),
      this.getTokenMetadata(baseAccount).catch(() => ({ decimals: 24 })),
    ]);
    const targetDecimals = targetMeta?.decimals ?? 18;
    const baseDecimals = baseMeta?.decimals ?? 24;

    const currentPoint = Number(pool.current_point);
    let price = 0;
    if (pool.current_point !== undefined && pool.current_point !== null && !isNaN(currentPoint)) {
      const rawPrice = Math.pow(1.0001, currentPoint) * Math.pow(10, (baseIsX ? baseDecimals - targetDecimals : targetDecimals - baseDecimals));
      price = baseIsX ? (rawPrice > 0 ? 1 / rawPrice : 0) : rawPrice;
    }

    const reserveNear = baseIsX ? (pool.total_x || '0') : (pool.total_y || '0');
    const reserveToken = baseIsX ? (pool.total_y || '0') : (pool.total_x || '0');
    const reserveNearNum = parseFloat(reserveNear) / Math.pow(10, baseDecimals);
    const liquidityNear = reserveNearNum * 2;

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
      ...(priceUnavailable ? { priceUnavailable: true } : {}),
    };
  }

  /**
   * Returns the price of one human-readable unit of `quoteToken` in NEAR.
   * Searches for a wrap.near <-> quoteToken pool via DCL first, then Ref AMM.
   * Throws when no pool is found.
   */
  private async getQuoteNearPrice(quoteToken: string, quoteDecimals: number): Promise<number> {
    // 1. Try DCL pool on dclv2.ref-labs.near
    const dclId = await this.findDclPoolId('wrap.near', quoteToken).catch(() => null);
    if (dclId) {
      try {
        const st = await this.getDclPoolState(dclId, 'wrap.near');
        if (st.price > 0) return st.price; // st.price = NEAR per token
      } catch { /* try Ref */ }
    }
    // 2. Try Ref AMM (v2.ref-finance.near)
    const refId = await this.findRheaPoolId('wrap.near', quoteToken).catch(() => null);
    if (refId !== null && refId !== undefined) {
      const rh = await this.getRheaPoolReserves(refId, 'wrap.near', quoteToken).catch(() => null);
      if (rh) {
        const nearHuman = parseFloat(rh.reserveIn) / 1e24;
        const quoteHuman = parseFloat(rh.reserveOut) / Math.pow(10, quoteDecimals);
        if (quoteHuman > 0) return nearHuman / quoteHuman;
      }
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
    const st = await this.getNearlytradeTokenState(tokenAddress);
    const launchPoolId = st.pool_id;

    if (st.quoteIsNear) {
      return { kind: 'direct', launchPoolId, quote: 'wrap.near' };
    }

    const quote = st.quote;
    // Prefer DCL pool for hop1
    const dclHop = await this.findDclPoolId('wrap.near', quote).catch(() => null);
    if (dclHop) {
      return { kind: 'multihop', quote, launchPoolId, hop1: { type: 'dcl', poolId: dclHop } };
    }
    // Fallback: Ref v2 AMM pool
    const refHop = await this.findRheaPoolId('wrap.near', quote).catch(() => null);
    if (refHop !== null && refHop !== undefined) {
      return { kind: 'multihop', quote, launchPoolId, hop1: { type: 'v2', poolId: String(refHop) } };
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
    venue: 'rhea' | 'ref' | 'shardsmarket' | 'nearlytrade' | 'intear' | 'memecooking' | 'onetokenhub' | 'gaypad' | 'nearpad',
    tokenIn: string,
    tokenOut: string,
    amountIn: string,
    slippagePct: number = 2,
    rheaPoolId?: number | null,
    dclPoolId?: string | null
  ): Promise<{ expectedOutput: string; minAmountOut: string }> {
    if (venue === 'memecooking') {
      const targetToken = tokenIn === 'wrap.near' || tokenIn === 'near' ? tokenOut : tokenIn;
      // Check Rhea DEX first for bonded tokens
      const rhea = await this.findRheaPoolForToken(targetToken).catch(() => null);
      if (rhea && rhea.poolId !== null && rhea.poolId !== undefined && rhea.price > 0) {
        return this.computeMinAmountOut('rhea', tokenIn, tokenOut, amountIn, slippagePct, typeof rhea.poolId === 'number' ? rhea.poolId : null, rhea.isDcl ? String(rhea.poolId) : null);
      }

      // Pre-bonded on Meme.Cooking launchpad
      const memeId = parseMemeCookingId(targetToken);
      const meme = memeId !== null ? await this.view<any>('meme-cooking.near', 'get_meme', { meme_id: memeId }).catch(() => null) : null;

      if (meme) {
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
      if (poolId === null || poolId === undefined) {
        try {
          poolId = await this.findRheaPoolId(tokenIn, tokenOut);
        } catch {
          const target = tokenIn === 'wrap.near' || tokenIn === 'near' ? tokenOut : tokenIn;
          const rhea = await this.findRheaPoolForToken(target);
          if (rhea && typeof rhea.poolId === 'number') poolId = rhea.poolId;
        }
      }

      const targetToken = tokenIn === 'wrap.near' || tokenIn === 'near' ? tokenOut : tokenIn;
      const rheaState = await this.findRheaPoolForToken(targetToken).catch(() => null);

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

      throw new Error(`No active liquidity pool found for token ${outToken} on Rhea / Ref Finance.`);
    } else if (venue === 'nearlytrade') {
      const targetToken = tokenIn === 'wrap.near' || tokenIn === 'near' ? tokenOut : tokenIn;
      let state;
      try {
        state = await this.getNearlytradeTokenState(targetToken);
      } catch {
        // If NearlyTrade RPC fails, check if Rhea has a pool as fallback
        try {
          const rheaPoolId = await this.findRheaPoolId(tokenIn, tokenOut);
          if (rheaPoolId) {
            const inToken = tokenIn === 'near' ? 'wrap.near' : tokenIn;
            const outToken = tokenOut === 'near' ? 'wrap.near' : tokenOut;
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
      const inToken = tokenIn === 'near' ? 'wrap.near' : tokenIn;
      const outToken = tokenOut === 'near' ? 'wrap.near' : tokenOut;

      // ── Multi-hop quoting for non-NEAR quote assets ──────────────────────
      if (!state.quoteIsNear) {
        const isBuyDirection = inToken === 'wrap.near';
        const launchPoolId = state.dclPoolId;

        // For a non-NEAR quote, quote each hop separately and chain outputs.
        // We cannot rely on multi-pool atomic quoting on dclv2.ref-labs.near
        // (not verified to accept 2 pool_ids in the quote view).
        try {
          const route = await this.planNearlytradeRoute(targetToken);
          if (route.kind === 'multihop') {
            if (isBuyDirection) {
              // Hop 1: wNEAR → quote
              let hop1Out: string;
              if (route.hop1.type === 'dcl') {
                const q1 = await this.view<any>('dclv2.ref-labs.near', 'quote', {
                  pool_ids: [route.hop1.poolId],
                  input_token: 'wrap.near',
                  output_token: route.quote,
                  input_amount: amountIn,
                });
                hop1Out = q1?.amount || '0';
              } else {
                const ret = await this.view<string>('v2.ref-finance.near', 'get_return', {
                  pool_id: Number(route.hop1.poolId),
                  token_in: 'wrap.near',
                  amount_in: amountIn,
                  token_out: route.quote,
                });
                hop1Out = ret || '0';
              }
              if (BigInt(hop1Out) <= 0n) throw new Error('Hop1 quote returned 0');
              // Hop 2: quote → launch token
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
              // Sell direction: launch token → quote → wNEAR
              const q1 = await this.view<any>('dclv2.ref-labs.near', 'quote', {
                pool_ids: [launchPoolId],
                input_token: inToken,
                output_token: route.quote,
                input_amount: amountIn,
              });
              const hop1Out = q1?.amount || '0';
              if (BigInt(hop1Out) <= 0n) throw new Error('Hop1 sell quote returned 0');
              let finalOut: string;
              if (route.hop1.type === 'dcl') {
                const q2 = await this.view<any>('dclv2.ref-labs.near', 'quote', {
                  pool_ids: [route.hop1.poolId],
                  input_token: route.quote,
                  output_token: 'wrap.near',
                  input_amount: hop1Out,
                });
                finalOut = q2?.amount || '0';
              } else {
                const ret = await this.view<string>('v2.ref-finance.near', 'get_return', {
                  pool_id: Number(route.hop1.poolId),
                  token_in: route.quote,
                  amount_in: hop1Out,
                  token_out: 'wrap.near',
                });
                finalOut = ret || '0';
              }
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
      // Rule 1: Check Rhea first!
      const rhea = await this.findRheaPoolForToken(targetToken);
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
  async getVenueSpotPrice(
    venue: string,
    tokenAddress: string,
    decimals: number
  ): Promise<{ price: number; reserveNearYocto: string } | null> {
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
    if (venue === 'shardsmarket') {
      const st = await this.getShardsmarketTokenState(tokenAddress);
      const rNear = parseFloat(st.poolQuote);
      const rTok = parseFloat(st.poolToken);
      if (rNear <= 0 || rTok <= 0) return null;
      return {
        reserveNearYocto: st.poolQuote,
        price: rNear / 1e24 / (rTok / Math.pow(10, decimals)),
      };
    }
    if (venue === 'nearlytrade') {
      const st = await this.getNearlytradeTokenState(tokenAddress);
      if (st.priceUnavailable || !(st.price > 0)) return null;
      return { reserveNearYocto: st.reserveNear, price: st.price };
    }
    if (venue === 'intear') {
      const st = await this.getIntearTokenState(tokenAddress);
      if (!(st.price > 0)) return null;
      return { reserveNearYocto: st.reserveNear, price: st.price };
    }
    if (venue === 'onetokenhub') {
      const st = await this.getOneTokenHubState(tokenAddress).catch(() => null);
      if (!st || !(st.price > 0)) return null;
      return { reserveNearYocto: st.reserveNear, price: st.price };
    }
    if (venue === 'nearpad') {
      const st = await this.getNEARpadState(tokenAddress).catch(() => null);
      if (!st || !(st.price > 0)) return null;
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
    waitForMs = 20_000
  ): Promise<any> {
    const tStart = Date.now();
    const account = await this.getAccount(accountId);
    // signTransaction is protected on Account — sign via the same code path
    // near-api-js uses internally (returns [txHash, signedTx]).
    const signOnce = async (): Promise<{ hash: string; signedB64: string }> => {
      const [txHash, signedTx] = await withTimeout<any[]>(
        (account as any).signTransaction(receiverId, actions),
        8_000,
        `Signing timed out for ${accountId}`
      );
      return {
        hash: utils.serialize.base_encode(txHash as Uint8Array),
        signedB64: Buffer.from(transactions.encodeTransaction(signedTx)).toString('base64'),
      };
    };

    let signed = await signOnce();
    let broadcastErr: Error | null = null;
    try {
      await this.broadcastSigned(signed.signedB64);
    } catch (err) {
      broadcastErr = err as Error;
    }

    // Stale cached access-key nonce → the single RPC rejected the nonce.
    // Clear it, re-sign with a fresh nonce and rebroadcast exactly once
    // to the SAME endpoint (a nonce refresh, not an RPC fallback).
    if (broadcastErr && /nonce/i.test(broadcastErr.message ?? '')) {
      (account as any).accessKeyByPublicKeyCache = {};
      signed = await signOnce();
      broadcastErr = null;
      try {
        await this.broadcastSigned(signed.signedB64);
      } catch (err) {
        broadcastErr = err as Error;
      }
    }

    if (broadcastErr) {
      throw new Error(redactSecrets(`Trade broadcast failed: ${broadcastErr.message}`));
    }

    const broadcastMs = Date.now() - tStart;
    const outcome = await this.awaitOutcome(signed.hash, accountId, waitForMs);
    // Perf instrumentation for trade_attempts timings (click→quote→sign→
    // broadcast→confirm). Attached non-enumerably-safe plain fields.
    outcome.__perf = {
      broadcastMs,
      confirmMs: Date.now() - tStart,
    };
    return outcome;
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
        throw new Error(data.error.message || JSON.stringify(data.error));
      }
      markProviderSuccess(provider, Date.now() - start);
      return data?.result as string;
    } catch (err) {
      markProviderError(provider);
      throw err;
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
   */
  private async awaitOutcome(txHash: string, accountId: string, maxMs: number): Promise<any> {
    const deadline = Date.now() + maxMs;
    let lastErr: Error | null = null;
    const pinnedUrl = this.tradeProvider.url;

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
          const res = await fetch(providerUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 'await-outcome', method, params }),
            signal: AbortSignal.timeout(6000),
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
            errMsg.toLowerCase().includes('rate limit') ||
            errName.toLowerCase().includes('rate limit') ||
            errData.toLowerCase().includes('rate limit')
          ) {
            const provider = this.tradeProviders.find(p => p.url === providerUrl);
            if (provider) markProviderError(provider);
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
        if (outcome && outcome.status !== undefined && outcome.status !== null) {
          return outcome;
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

    while (Date.now() < deadline) {
      // Single pinned trade RPC — the endpoint that accepted the broadcast is
      // the only source of truth for its outcome. No fallback.
      const outcome = await tryRpc(pinnedUrl).catch((err) => {
        lastErr = err as Error;
        return null;
      });

      if (outcome) {
        // wait_until 'NONE' returns as soon as the tx is included — receipts
        // may not have executed yet (empty/partial receipts_outcome). Success
        // determination inspects receipts, so keep polling until the executed
        // receipt tree is present.
        if (Array.isArray(outcome.receipts_outcome) && outcome.receipts_outcome.length > 0) {
          return outcome;
        }
      }

      await sleep(250); // Fast confirmation polling on the pinned RPC
    }

    const errMsg = lastErr ? `: ${redactSecrets((lastErr as any).message ?? String(lastErr))}` : '';
    throw new Error(
      `Transaction ${txHash} not confirmed within ${maxMs}ms${errMsg}`
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Safe defaults so a missing/partial RPC_PROVIDERS never crashes a service (FastNEAR only). */
export const DEFAULT_RPC_URLS = [
  'https://rpc.mainnet.fastnear.com',
  'https://free.rpc.fastnear.com',
];

/** Singleton factory — call once per process, reuse the connection pool */
let _nearInstance: MultiRpcNear | null = null;

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

