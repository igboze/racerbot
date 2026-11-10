/**
 * Solana chain module for RacerBot.
 *
 * Design goal: keep paid RPC (QuickNode) credit usage as close to zero as
 * possible.
 *
 *  - Quotes, swap building, token metadata, prices and wallet balances come
 *    from free HTTP APIs (Jupiter lite API, pump.fun), not from RPC.
 *  - Jupiter's /build response already carries the recent blockhash and the
 *    address lookup tables, so building a swap needs no RPC call at all.
 *  - The few RPC calls that remain (broadcast, signature status, parsing the
 *    confirmed transaction, withdraw blockhash) go to free read endpoints first
 *    (SOLANA_READ_RPC_URLS, default: public mainnet RPC). The paid RPC
 *    (SOLANA_RPC_URL, e.g. QuickNode) is only used when every free endpoint
 *    fails, so in normal operation it consumes no credits.
 *  - Everything is cached and in-flight requests are de-duplicated.
 *
 * Trading:
 *  - Jupiter routes BOTH pre-bonded pump.fun tokens (label "Pump.fun", the
 *    bonding curve program) and bonded tokens (PumpSwap "Pump.fun Amm",
 *    Raydium, Meteora, Orca, Raydium Launchlab, ...), so one code path covers
 *    every launch phase.
 *  - The platform fee is a plain SOL transfer appended to the same
 *    transaction (atomic: if the swap fails, no fee is taken). Same rates as
 *    NEAR: 1.5% on buys, 1.5% on sells (2% when proceeds exceed $200).
 */
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { encrypt, decrypt } from './crypto.js';
import { createRedis, type RedisClient } from './redis.js';

// ── Constants ────────────────────────────────────────────────────────────────

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const SOL_DECIMALS = 9;
export const LAMPORTS_PER_SOL_BIG = 1_000_000_000n;

/** Platform fee: identical to NEAR (1.5% buys, 1.5% sells, 2% sells over $200). */
export const SOLANA_FEE_BPS = 150n;
export const SOLANA_SELL_FEE_BPS_HIGH = 200n;
export const SOLANA_SELL_FEE_HIGH_USD_THRESHOLD = 200;
export const SOLANA_BPS_DENOMINATOR = 10000n;

/** Dev fee wallet that receives the platform fee in SOL. Override with SOLANA_DEV_FEE_WALLET. */
export const DEFAULT_SOLANA_DEV_FEE_WALLET =
  (process.env.SOLANA_TREASURY_ADDRESS || process.env.SOLANA_DEV_FEE_WALLET || '5ba1CAazPrdYYcaTYyzTqMExgCadu2aFauW24r28dh5g').trim();

/** SOL kept in the wallet for network fees and token account rent (~0.0021 SOL per new token account). */
export const SOLANA_MIN_RESERVE_LAMPORTS = 5_000_000n; // 0.005 SOL

const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

/** pump.fun bonding curve: initial virtual token reserves (1.073B tokens with 6 decimals). */
const PUMP_INITIAL_VIRTUAL_TOKEN_RESERVES = 1_073_000_000_000_000n;

// ── Endpoint configuration ──────────────────────────────────────────────────

function splitList(v: string | undefined): string[] {
  return (v || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** Free endpoints used first for every read and broadcast. */
const READ_RPC_URLS: string[] = (() => {
  const list = splitList(process.env.SOLANA_READ_RPC_URLS);
  return list.length > 0 ? list : ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'];
})();

/** Paid endpoint (QuickNode). Only used when all free endpoints fail. */
const PAID_RPC_URL = (process.env.SOLANA_RPC_URL || process.env.QUICKNODE_SOLANA_RPC_URL || '').trim();

/** Set SOLANA_PAID_RPC_FALLBACK=false to never touch the paid RPC. */
const PAID_RPC_FALLBACK_ENABLED = (process.env.SOLANA_PAID_RPC_FALLBACK || 'true').toLowerCase() !== 'false';

const JUPITER_API_KEY = (process.env.JUPITER_API_KEY || '').trim();
/** With a key: api.jup.ag (higher limits). Without: the free keyless lite API. */
const JUPITER_BASE = (process.env.JUPITER_API_BASE || (JUPITER_API_KEY ? 'https://api.jup.ag' : 'https://lite-api.jup.ag')).replace(/\/+$/, '');
const PUMP_API_BASE = (process.env.PUMPFUN_API_BASE || 'https://frontend-api-v3.pump.fun').replace(/\/+$/, '');
// pump.fun's public API sits behind a CDN that expects browser-like headers.
const PUMP_HEADERS: Record<string, string> = {
  accept: 'application/json',
  origin: 'https://pump.fun',
  referer: 'https://pump.fun/',
  'user-agent': 'Mozilla/5.0 (compatible; RacerBot/1.0)',
};

/** Priority fee level for swaps: medium | high | veryHigh (Jupiter computeUnitPricePercentile). */
const PRIORITY_LEVEL = (process.env.SOLANA_PRIORITY_LEVEL || 'high').trim();
/** Compute unit limit set on swaps (no simulation, which would cost an RPC call). */
const SWAP_COMPUTE_UNIT_LIMIT = Number(process.env.SOLANA_SWAP_CU_LIMIT || 400_000);
/** Upper bound on the priority price so a fee spike can never drain a small wallet (1,000,000 = 1 lamport per CU). */
const MAX_PRIORITY_MICROLAMPORTS = BigInt(process.env.SOLANA_MAX_PRIORITY_MICROLAMPORTS || 2_000_000);

// ── Small helpers ───────────────────────────────────────────────────────────

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** True for a base58 string that decodes to a 32-byte ed25519 public key (wallet or mint). */
export function isSolanaAddress(value: string | null | undefined): boolean {
  if (!value || typeof value !== 'string') return false;
  const v = value.trim();
  if (!BASE58_RE.test(v)) return false;
  try {
    return bs58.decode(v).length === 32;
  } catch {
    return false;
  }
}

/** Token mints are Solana addresses; kept as a separate name for readability at call sites. */
export const isSolanaToken = isSolanaAddress;

export function lamportsToSol(lamports: bigint | number | string): number {
  return Number(BigInt(String(lamports).split('.')[0] || '0')) / 1e9;
}

export function solToLamports(sol: number): bigint {
  if (!Number.isFinite(sol) || sol <= 0) return 0n;
  return BigInt(Math.floor(sol * 1e9));
}

async function fetchJson<T = any>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const { timeoutMs = 8000, ...rest } = init;
  const res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const msg = typeof body === 'object' && body ? (body.error || body.message || JSON.stringify(body)) : String(body).slice(0, 200);
    const err: any = new Error(`HTTP ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return body as T;
}

/** Simple TTL cache with in-flight de-duplication. */
class TtlCache<T> {
  private store = new Map<string, { at: number; value: T }>();
  private inflight = new Map<string, Promise<T>>();
  constructor(private ttlMs: number, private max = 5000) {}
  peek(key: string): T | undefined {
    const hit = this.store.get(key);
    return hit && Date.now() - hit.at < this.ttlMs ? hit.value : undefined;
  }
  delete(key: string) { this.store.delete(key); }
  async get(key: string, loader: () => Promise<T>, force = false): Promise<T> {
    if (!force) {
      const hit = this.peek(key);
      if (hit !== undefined) return hit;
    }
    const running = this.inflight.get(key);
    if (running) return running;
    const p = loader()
      .then((v) => {
        if (this.store.size >= this.max) {
          const first = this.store.keys().next().value;
          if (first !== undefined) this.store.delete(first);
        }
        this.store.set(key, { at: Date.now(), value: v });
        return v;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }
}

// ── Jupiter request pacing ──────────────────────────────────────────────────
// Keyless Jupiter allows ~0.5 req/s per IP. Requests are spaced out so the
// bot never gets 429-banned; trade requests jump the queue ahead of reads.

const JUPITER_MIN_INTERVAL_MS = Number(
  process.env.JUPITER_MIN_INTERVAL_MS || (JUPITER_API_KEY ? 1000 : 2000),
);
let jupiterNextSlot = 0;
let jupiterTradeWaiting = 0;

/** A read that cannot get a Jupiter slot within this time gives up (callers fall back or retry later). */
const JUPITER_READ_MAX_WAIT_MS = Number(process.env.JUPITER_READ_MAX_WAIT_MS || 15_000);

// All services (API, executor, triggers, detector) usually leave from the same
// IP and share one Jupiter allowance, so the spacing is enforced across them
// through Redis when it is available. Trades reserve the next free slot (they
// queue); reads only take a slot that is free right now, so trades go first.
const JUP_SLOT_LUA = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local nxt = tonumber(redis.call('GET', KEYS[1]) or '0')
local slot = math.max(now, nxt)
if slot - now > tonumber(ARGV[2]) then return -1 end
redis.call('SET', KEYS[1], tostring(slot + tonumber(ARGV[1])), 'PX', 60000)
return slot - now`;
const JUP_BACKOFF_LUA = `
local t = redis.call('TIME')
local until_ms = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000) + tonumber(ARGV[1])
local nxt = tonumber(redis.call('GET', KEYS[1]) or '0')
if until_ms > nxt then redis.call('SET', KEYS[1], tostring(until_ms), 'PX', 60000) end
return 1`;
let jupRedis: RedisClient | null = null;
let jupRedisDisabledUntil = 0;

function jupiterRedis(): RedisClient | null {
  if (jupRedis || !process.env.REDIS_URL || Date.now() < jupRedisDisabledUntil) return jupRedis;
  try {
    jupRedis = createRedis(process.env.REDIS_URL);
  } catch {
    jupRedisDisabledUntil = Date.now() + 60_000;
  }
  return jupRedis;
}

/** Wait (ms) before this call may use Jupiter, -1 when a read must try again later, null when Redis is unavailable. */
async function globalJupiterSlot(priority: 'trade' | 'read'): Promise<number | null> {
  const r = jupiterRedis();
  if (!r) return null;
  try {
    const res = await Promise.race([
      r.eval(JUP_SLOT_LUA, 1, 'racer:jupiter:next_slot', String(JUPITER_MIN_INTERVAL_MS), priority === 'trade' ? '600000' : '0'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('redis slow')), 400)),
    ]);
    return Number(res);
  } catch {
    // Redis trouble never blocks trading: fall back to this process's own pacing for a minute.
    jupRedisDisabledUntil = Date.now() + 60_000;
    jupRedis = null;
    return null;
  }
}

async function jupiterSlot(priority: 'trade' | 'read'): Promise<void> {
  if (Date.now() >= jupRedisDisabledUntil && process.env.REDIS_URL) {
    const started = Date.now();
    for (;;) {
      const wait = await globalJupiterSlot(priority);
      if (wait === null) break; // use the local limiter below
      if (wait >= 0) {
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        return;
      }
      if (Date.now() - started > JUPITER_READ_MAX_WAIT_MS) {
        throw new Error('Jupiter is busy (free tier rate limit). Try again shortly.');
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  if (priority === 'trade') jupiterTradeWaiting++;
  const started = Date.now();
  try {
    for (;;) {
      if (priority === 'read' && Date.now() - started > JUPITER_READ_MAX_WAIT_MS) {
        throw new Error('Jupiter is busy (free tier rate limit). Try again shortly.');
      }
      if (priority === 'read' && jupiterTradeWaiting > 0) {
        await new Promise((r) => setTimeout(r, 150));
        continue;
      }
      const now = Date.now();
      if (now >= jupiterNextSlot) {
        jupiterNextSlot = now + JUPITER_MIN_INTERVAL_MS;
        return;
      }
      await new Promise((r) => setTimeout(r, Math.min(jupiterNextSlot - now, 500)));
    }
  } finally {
    if (priority === 'trade') jupiterTradeWaiting--;
  }
}

async function jupiterGet<T = any>(path: string, priority: 'trade' | 'read' = 'read', timeoutMs = 8000): Promise<T> {
  let lastErr: any;
  for (let attempt = 0; attempt < 3; attempt++) {
    await jupiterSlot(priority);
    try {
      return await fetchJson<T>(`${JUPITER_BASE}${path}`, {
        timeoutMs,
        headers: JUPITER_API_KEY ? { 'x-api-key': JUPITER_API_KEY } : undefined,
      });
    } catch (err: any) {
      lastErr = err;
      if (err?.status === 429) {
        const backoff = 2500 * (attempt + 1);
        jupiterNextSlot = Date.now() + backoff;
        // Tell the other services too, so they all back off together.
        jupiterRedis()?.eval(JUP_BACKOFF_LUA, 1, 'racer:jupiter:next_slot', String(backoff)).catch(() => {});
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// ── RPC (free first, paid only as a last resort) ────────────────────────────

let rpcId = 0;
let paidRpcCalls = 0;

/** Number of calls that had to fall back to the paid RPC since start (for monitoring). */
export function getSolanaPaidRpcCallCount(): number {
  return paidRpcCalls;
}

async function rpcPost<T>(url: string, method: string, params: any[], timeoutMs: number): Promise<T> {
  const body = await fetchJson<any>(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    timeoutMs,
  });
  if (body?.error) {
    const err: any = new Error(body.error.message || JSON.stringify(body.error));
    err.rpcCode = body.error.code;
    err.rpcData = body.error.data;
    throw err;
  }
  return body?.result as T;
}

/**
 * JSON-RPC call against the free endpoints, falling back to the paid RPC only
 * when all of them fail. Errors that the chain itself returns (e.g. a
 * transaction simulation error) are not retried on the paid endpoint.
 */
export async function solanaRpc<T = any>(
  method: string,
  params: any[] = [],
  opts: { timeoutMs?: number; allowPaid?: boolean } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  let lastErr: any;
  for (const url of READ_RPC_URLS) {
    try {
      return await rpcPost<T>(url, method, params, timeoutMs);
    } catch (err: any) {
      lastErr = err;
      // A real JSON-RPC error from a healthy node is the answer; do not spend credits repeating it.
      // Exception: free nodes that refuse a method or a list size for THEIR plan
      // (publicnode: "Indexed requests require a personal token", "A maximum of 10 accounts")
      // are endpoint limits, not answers, so the next endpoint is tried.
      const endpointLimit = /personal token|maximum of \d+|not available on|method not found|not supported/i.test(String(err?.message || ''));
      if (err?.rpcCode !== undefined && err.rpcCode !== -32005 && err.rpcCode !== 429 && err.rpcCode !== -32603 && !endpointLimit) {
        throw err;
      }
    }
  }
  if (PAID_RPC_URL && PAID_RPC_FALLBACK_ENABLED && opts.allowPaid !== false) {
    paidRpcCalls++;
    return rpcPost<T>(PAID_RPC_URL, method, params, timeoutMs);
  }
  throw lastErr || new Error(`Solana RPC ${method} failed`);
}

// ── Keys ────────────────────────────────────────────────────────────────────

export interface GeneratedSolanaWallet {
  address: string;
  /** base58 64-byte secret key (imports directly into Phantom / Solflare). */
  privateKeySecret: string;
  encryptedPrivateKey: string;
}

export function generateSolanaWallet(masterKey: string): GeneratedSolanaWallet {
  const kp = Keypair.generate();
  const privateKeySecret = bs58.encode(Buffer.from(kp.secretKey));
  return {
    address: kp.publicKey.toBase58(),
    privateKeySecret,
    encryptedPrivateKey: encrypt(privateKeySecret, masterKey),
  };
}

/** Accepts base58 (64-byte or 32-byte seed) or a JSON byte array, as exported by Phantom/Solflare/CLI. */
export function restoreSolanaKeypairFromSecret(rawSecret: string): Keypair {
  const clean = (rawSecret || '').trim();
  if (clean.startsWith('[')) {
    const arr = JSON.parse(clean) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  const bytes = bs58.decode(clean);
  if (bytes.length === 64) return Keypair.fromSecretKey(Uint8Array.from(bytes));
  if (bytes.length === 32) return Keypair.fromSeed(Uint8Array.from(bytes));
  throw new Error('Invalid Solana private key. Expected a base58 secret key or a JSON byte array.');
}

export function restoreSolanaKeypair(encryptedPrivateKey: string, masterKey: string): Keypair {
  return restoreSolanaKeypairFromSecret(decrypt(encryptedPrivateKey, masterKey));
}

/** Decrypts to the base58 secret the user can import into Phantom. */
export function exportSolanaPrivateKey(encryptedPrivateKey: string, masterKey: string): string {
  const kp = restoreSolanaKeypair(encryptedPrivateKey, masterKey);
  return bs58.encode(Buffer.from(kp.secretKey));
}

// ── Prices ──────────────────────────────────────────────────────────────────

const solUsdCache = new TtlCache<number>(60_000, 4);

export async function getSolUsdPrice(): Promise<number> {
  try {
    return await solUsdCache.get('sol', async () => {
      try {
        const j = await jupiterGet<any>(`/price/v3?ids=${SOL_MINT}`, 'read', 4000);
        const p = Number(j?.[SOL_MINT]?.usdPrice);
        if (p > 0) return p;
      } catch { /* fall through */ }
      const cb = await fetchJson<any>('https://api.coinbase.com/v2/prices/SOL-USD/spot', { timeoutMs: 3000 });
      const p = Number(cb?.data?.amount);
      if (p > 0) return p;
      throw new Error('no SOL price');
    });
  } catch {
    return solUsdCache.peek('sol') ?? 150;
  }
}

/** Converts a human token amount (e.g. "1250.5") to raw base units without float drift. */
export function solanaUiToRaw(ui: number | string, decimals: number): bigint {
  const n = typeof ui === 'number' ? ui : Number(ui);
  if (!Number.isFinite(n) || n <= 0) return 0n;
  const d = Math.max(0, Math.min(18, Math.floor(decimals)));
  // toFixed avoids exponent notation for normal ranges; trim to the token's precision.
  const [whole, frac = ''] = n.toFixed(Math.min(d, 18)).split('.');
  return BigInt(whole + frac.padEnd(d, '0').slice(0, d));
}

const tokenPriceCache = new TtlCache<number>(10_000, 20_000);

/**
 * USD prices for many mints in as few Jupiter calls as possible (50 per call).
 * Mints Jupiter does not know are left out of the result. Used by background
 * engines (limit orders, fleet orders) so polling many tokens stays cheap.
 */
export async function getSolanaPricesUsd(mints: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const missing: string[] = [];
  for (const m of new Set(mints)) {
    const hit = tokenPriceCache.peek(m);
    if (hit !== undefined) out.set(m, hit);
    else missing.push(m);
  }
  for (let i = 0; i < missing.length; i += 50) {
    const chunk = missing.slice(i, i + 50);
    try {
      const j = await jupiterGet<any>(`/price/v3?ids=${chunk.join(',')}`, 'read', 6000);
      for (const m of chunk) {
        const p = Number(j?.[m]?.usdPrice);
        if (p > 0) {
          out.set(m, p);
          await tokenPriceCache.get(m, async () => p, true);
        }
      }
    } catch { /* leave missing; callers fall back per token */ }
  }
  return out;
}

// ── Balances (free APIs first, RPC fallback) ────────────────────────────────

export interface SolanaTokenHolding {
  mint: string;
  raw: bigint;
  uiAmount: number;
  decimals: number;
  programId: string;
  account: string;
}

export interface SolanaWalletHoldings {
  lamports: bigint;
  tokens: Map<string, SolanaTokenHolding>;
  /** True when the data came from a source that answered (not a guess). */
  trusted: boolean;
}

const holdingsCache = new TtlCache<SolanaWalletHoldings>(20_000, 10_000);

async function loadHoldingsFromJupiter(address: string): Promise<SolanaWalletHoldings> {
  const j = await jupiterGet<any>(`/ultra/v1/holdings/${address}`, 'read', 6000);
  const tokens = new Map<string, SolanaTokenHolding>();
  for (const [mint, accounts] of Object.entries<any>(j?.tokens || {})) {
    const list = Array.isArray(accounts) ? accounts : [];
    for (const acc of list) {
      const raw = BigInt(String(acc?.amount ?? '0'));
      if (raw <= 0n) continue;
      const prev = tokens.get(mint);
      // Prefer the associated token account; sum others into it.
      if (prev) {
        prev.raw += raw;
        prev.uiAmount += Number(acc?.uiAmount || 0);
        if (acc?.isAssociatedTokenAccount) prev.account = acc.account;
      } else {
        tokens.set(mint, {
          mint,
          raw,
          uiAmount: Number(acc?.uiAmount || 0),
          decimals: Number(acc?.decimals ?? 0),
          programId: String(acc?.programId || TOKEN_PROGRAM_ID),
          account: String(acc?.account || ''),
        });
      }
    }
  }
  return { lamports: BigInt(String(j?.amount ?? '0')), tokens, trusted: true };
}

async function loadHoldingsFromRpc(address: string): Promise<SolanaWalletHoldings> {
  // Fallback only (Jupiter holdings failed). getTokenAccountsByOwner is an
  // "indexed" call that free nodes may refuse and that costs many credits on a
  // paid node, so it never touches the paid RPC.
  const [bal, classic, t22] = await Promise.all([
    solanaRpc<any>('getBalance', [address, { commitment: 'confirmed' }], { allowPaid: false }),
    solanaRpc<any>('getTokenAccountsByOwner', [address, { programId: TOKEN_PROGRAM_ID }, { encoding: 'jsonParsed', commitment: 'confirmed' }], { allowPaid: false }),
    solanaRpc<any>('getTokenAccountsByOwner', [address, { programId: TOKEN_2022_PROGRAM_ID }, { encoding: 'jsonParsed', commitment: 'confirmed' }], { allowPaid: false }),
  ]);
  const tokens = new Map<string, SolanaTokenHolding>();
  for (const [programId, res] of [[TOKEN_PROGRAM_ID, classic], [TOKEN_2022_PROGRAM_ID, t22]] as const) {
    for (const item of res?.value || []) {
      const info = item?.account?.data?.parsed?.info;
      if (!info?.mint) continue;
      const raw = BigInt(String(info.tokenAmount?.amount ?? '0'));
      if (raw <= 0n) continue;
      const prev = tokens.get(info.mint);
      if (prev) {
        prev.raw += raw;
        prev.uiAmount += Number(info.tokenAmount?.uiAmount || 0);
      } else {
        tokens.set(info.mint, {
          mint: info.mint,
          raw,
          uiAmount: Number(info.tokenAmount?.uiAmount || 0),
          decimals: Number(info.tokenAmount?.decimals ?? 0),
          programId,
          account: String(item.pubkey || ''),
        });
      }
    }
  }
  return { lamports: BigInt(String(bal?.value ?? '0')), tokens, trusted: true };
}

/** SOL + SPL balances of a wallet. Jupiter first (no RPC), RPC fallback. Cached 20s. */
export async function getSolanaWalletHoldings(address: string, force = false): Promise<SolanaWalletHoldings> {
  return holdingsCache.get(address, async () => {
    try {
      return await loadHoldingsFromJupiter(address);
    } catch {
      return loadHoldingsFromRpc(address);
    }
  }, force);
}

/**
 * SOL balance read from the FREE endpoints only (never the paid RPC).
 * Used by background polling such as deposit detection. Returns null on failure.
 */
export async function getSolanaBalanceFreeOnly(address: string): Promise<bigint | null> {
  try {
    const r = await solanaRpc<any>('getBalance', [address, { commitment: 'confirmed' }], { timeoutMs: 5000, allowPaid: false });
    return BigInt(String(r?.value ?? '0'));
  } catch {
    return null;
  }
}

/**
 * Token balance for one mint straight from the chain (free RPC, paid only as fallback).
 * Used to double-check before closing a position, since indexers can lag a
 * few seconds behind a fresh buy. Returns null when it cannot be determined.
 */
export async function getSolanaTokenBalanceOnChain(owner: string, mint: string): Promise<bigint | null> {
  // Reads the owner's associated token accounts (classic + Token-2022) with one
  // plain getMultipleAccounts call. Free nodes refuse the "indexed"
  // getTokenAccountsByOwner method, but serve this. Bot wallets only ever hold ATAs.
  try {
    const o = new PublicKey(owner);
    const m = new PublicKey(mint);
    const atas = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map((tp) =>
      PublicKey.findProgramAddressSync([o.toBuffer(), new PublicKey(tp).toBuffer(), m.toBuffer()], new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID))[0].toBase58(),
    );
    const r = await solanaRpc<any>('getMultipleAccounts', [atas, { encoding: 'base64', dataSlice: { offset: 64, length: 8 }, commitment: 'confirmed' }], { timeoutMs: 6000 });
    let total = 0n;
    for (const acc of r?.value || []) {
      const b64 = Array.isArray(acc?.data) ? acc.data[0] : null;
      if (!b64) continue;
      const buf = Buffer.from(b64, 'base64');
      if (buf.length >= 8) total += buf.readBigUInt64LE(0);
    }
    return total;
  } catch {
    return null;
  }
}

/** One getMultipleAccounts call: [classic ATA, Token-2022 ATA, mint]. Null on any failure. */
async function readTokenBalanceFromAtas(
  owner: string,
  mint: string,
): Promise<{ raw: bigint; uiAmount: number; decimals: number; programId: string | null } | null> {
  try {
    const o = new PublicKey(owner);
    const m = new PublicKey(mint);
    const programs = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];
    const atas = programs.map((tp) =>
      PublicKey.findProgramAddressSync([o.toBuffer(), new PublicKey(tp).toBuffer(), m.toBuffer()], new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID))[0].toBase58(),
    );
    const r = await solanaRpc<any>(
      'getMultipleAccounts',
      [[...atas, mint], { encoding: 'base64', commitment: 'confirmed' }],
      { timeoutMs: 6000, allowPaid: false },
    );
    const vals: any[] = r?.value || [];
    const mintAcc = vals[2];
    const mintB64 = Array.isArray(mintAcc?.data) ? mintAcc.data[0] : null;
    if (!mintB64) return null; // unknown mint or bad response: let the caller fall back
    const mintBuf = Buffer.from(mintB64, 'base64');
    if (mintBuf.length < 45) return null;
    const decimals = mintBuf[44];
    let raw = 0n;
    let programId: string | null = null;
    for (let i = 0; i < 2; i++) {
      const acc = vals[i];
      const b64 = Array.isArray(acc?.data) ? acc.data[0] : null;
      if (!b64) continue;
      const buf = Buffer.from(b64, 'base64');
      if (buf.length < 72) continue;
      const amt = buf.readBigUInt64LE(64);
      raw += amt;
      if (!programId || amt > 0n) programId = String(acc.owner || programs[i]);
    }
    return { raw, uiAmount: Number(raw) / 10 ** decimals, decimals, programId: programId ?? (mintAcc.owner ? String(mintAcc.owner) : null) };
  } catch {
    return null;
  }
}

export function invalidateSolanaBalanceCache(address: string): void {
  holdingsCache.delete(address);
  solBalanceCache.delete(address);
}

export interface SolanaBalanceResult {
  lamports: bigint;
  formatted: string;
}

const solBalanceCache = new TtlCache<bigint>(15_000, 20_000);

/**
 * Native SOL balance. Uses the free public RPC getBalance (a single cheap call),
 * reusing a fresh holdings snapshot when one is already cached. Cached 15s.
 */
export async function getSolanaBalance(address: string, force = false): Promise<SolanaBalanceResult> {
  if (!force) {
    const h = holdingsCache.peek(address);
    if (h) return { lamports: h.lamports, formatted: lamportsToSol(h.lamports).toFixed(4) };
  }
  const lamports = await solBalanceCache.get(address, async () => {
    const r = await solanaRpc<any>('getBalance', [address, { commitment: 'confirmed' }], { timeoutMs: 5000 });
    return BigInt(String(r?.value ?? '0'));
  }, force);
  return { lamports, formatted: lamportsToSol(lamports).toFixed(4) };
}

export async function getSolanaTokenBalance(
  address: string,
  mint: string,
  force = false,
): Promise<{ raw: bigint; uiAmount: number; decimals: number; programId: string | null }> {
  // A forced read comes straight from the chain: the holdings index can lag a
  // few seconds behind a fresh buy and report 0, which would close a live position.
  if (force) {
    const direct = await readTokenBalanceFromAtas(address, mint);
    if (direct) return direct;
  }
  const h = await getSolanaWalletHoldings(address, force);
  const t = h.tokens.get(mint);
  return t
    ? { raw: t.raw, uiAmount: t.uiAmount, decimals: t.decimals, programId: t.programId }
    : { raw: 0n, uiAmount: 0, decimals: 0, programId: null };
}

// ── Token info (Jupiter tokens API + pump.fun curve data) ────────────────────

export interface SolanaTokenInfo {
  mint: string;
  name: string;
  symbol: string;
  decimals: number;
  icon?: string;
  tokenProgram: string;
  totalSupply: number;          // human units
  priceUsd: number;
  priceSol: number;
  marketCapUsd: number;
  liquidityUsd: number;
  volume24hUsd: number;
  priceChange24h: number;
  holders: number | null;
  buys24h: number | null;
  sells24h: number | null;
  launchpad: string | null;     // e.g. 'pump.fun'
  /** 'prebonded' while on a launchpad bonding curve, 'bonded' once migrated to an AMM. */
  bondingPhase: 'prebonded' | 'bonded';
  bondingProgressPct: number | null;
  mintAuthorityDisabled: boolean | null;
  freezeAuthorityDisabled: boolean | null;
  topHoldersPct: number | null;
  transferFeeBps: number | null;
  solUsd: number;
}

const tokenInfoCache = new TtlCache<SolanaTokenInfo | null>(15_000, 5000);

async function fetchPumpCoin(mint: string): Promise<any | null> {
  try {
    const coin = await fetchJson<any>(`${PUMP_API_BASE}/coins-v2/${mint}`, { timeoutMs: 5000, headers: PUMP_HEADERS });
    return coin && coin.mint === mint ? coin : null;
  } catch {
    return null;
  }
}

const curveProgressCache = new TtlCache<number | null>(15_000, 5000);

/**
 * Bonding progress (0-100) read from the pump.fun bonding curve account.
 * Layout: 8-byte discriminator, then u64 virtual_token_reserves,
 * virtual_sol_reserves, real_token_reserves, real_sol_reserves,
 * token_total_supply, then bool complete. The gap between virtual and real
 * token reserves is constant for the life of the curve, which gives the
 * starting real reserves. Free RPC only.
 */
async function getPumpCurveProgress(bondingCurve: string): Promise<number | null> {
  return curveProgressCache.get(bondingCurve, async () => {
    try {
      const r = await solanaRpc<any>('getAccountInfo', [bondingCurve, { encoding: 'base64', commitment: 'confirmed' }], { timeoutMs: 4000, allowPaid: false });
      const b64 = r?.value?.data?.[0];
      if (!b64) return null;
      const buf = Buffer.from(b64, 'base64');
      if (buf.length < 49) return null;
      const vtr = buf.readBigUInt64LE(8);
      const rtr = buf.readBigUInt64LE(24);
      const complete = buf[48] === 1;
      if (complete) return 100;
      const offset = vtr - rtr;
      const initialReal = PUMP_INITIAL_VIRTUAL_TOKEN_RESERVES - offset;
      if (initialReal <= 0n) return null;
      const pct = (1 - Number(rtr) / Number(initialReal)) * 100;
      return Math.max(0, Math.min(100, pct));
    } catch {
      return null;
    }
  });
}

/**
 * Token metadata, price, market cap and launch phase. No RPC is used.
 * Returns null when no source knows the mint.
 */
export async function getSolanaTokenInfo(mint: string, force = false): Promise<SolanaTokenInfo | null> {
  return tokenInfoCache.get(mint, async () => {
    const looksPump = mint.endsWith('pump');
    const [jupRes, pumpRes, solUsd] = await Promise.all([
      jupiterGet<any[]>(`/tokens/v2/search?query=${mint}`, 'read', 6000).catch(() => null),
      looksPump ? fetchPumpCoin(mint) : Promise.resolve(null),
      getSolUsdPrice(),
    ]);
    const jup = Array.isArray(jupRes) ? jupRes.find((t) => t?.id === mint) || null : null;
    let pump = pumpRes;
    // Not a "...pump" vanity mint but Jupiter says it launched on pump.fun: ask pump.fun for curve data.
    if (!pump && jup?.launchpad === 'pump.fun') pump = await fetchPumpCoin(mint);

    if (!jup && !pump) return null;

    const decimals = Number(jup?.decimals ?? pump?.base_decimals ?? 6);
    let priceUsd = Number(jup?.usdPrice || 0);
    let marketCapUsd = Number(jup?.mcap || jup?.fdv || 0);
    let totalSupply = Number(jup?.totalSupply || 0);

    let bondingPhase: 'prebonded' | 'bonded' = 'bonded';
    let bondingProgressPct: number | null = null;
    if (pump) {
      bondingPhase = pump.complete ? 'bonded' : 'prebonded';
      if (pump.complete) {
        bondingProgressPct = 100;
      } else if (typeof pump.bonding_curve === 'string' && pump.bonding_curve) {
        bondingProgressPct = await getPumpCurveProgress(pump.bonding_curve);
      }
      if (!totalSupply) totalSupply = Number(pump.total_supply || 0) / Math.pow(10, decimals);
      if (priceUsd <= 0) priceUsd = Number(pump.price_usd || 0);
      if (marketCapUsd <= 0) marketCapUsd = Number(pump.usd_market_cap || pump.market_cap_usd || 0);
    }
    if (marketCapUsd <= 0 && priceUsd > 0 && totalSupply > 0) marketCapUsd = priceUsd * totalSupply;

    const s24 = jup?.stats24h || {};
    return {
      mint,
      name: String(jup?.name || pump?.name || 'Solana Token'),
      symbol: String(jup?.symbol || pump?.symbol || 'TOKEN'),
      decimals,
      icon: jup?.icon || pump?.image_uri || undefined,
      tokenProgram: String(jup?.tokenProgram || pump?.token_program || TOKEN_PROGRAM_ID),
      totalSupply,
      priceUsd,
      priceSol: solUsd > 0 ? priceUsd / solUsd : 0,
      marketCapUsd,
      liquidityUsd: Number(jup?.liquidity || 0),
      volume24hUsd: Number(s24.buyVolume || 0) + Number(s24.sellVolume || 0),
      priceChange24h: Number(s24.priceChange || 0),
      holders: jup?.holderCount != null ? Number(jup.holderCount) : null,
      buys24h: s24.numBuys != null ? Number(s24.numBuys) : null,
      sells24h: s24.numSells != null ? Number(s24.numSells) : null,
      launchpad: jup?.launchpad || (pump ? 'pump.fun' : null),
      bondingPhase,
      bondingProgressPct,
      mintAuthorityDisabled: jup?.audit?.mintAuthorityDisabled ?? (jup?.mintAuthority === null ? true : null),
      freezeAuthorityDisabled: jup?.audit?.freezeAuthorityDisabled ?? (jup?.freezeAuthority === null ? true : null),
      topHoldersPct: jup?.audit?.topHoldersPercentage != null ? Number(jup.audit.topHoldersPercentage) : null,
      transferFeeBps: pump?.transfer_fee_bps != null ? Number(pump.transfer_fee_bps) : null,
      solUsd,
    };
  }, force);
}

// ── Token detection from pasted text and links ─────────────────────────────

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY7cDXd9yKZbJw8x';
/** Quote-side mints that are never the token a user means when they paste a link. */
const QUOTE_MINTS = new Set([SOL_MINT, USDC_MINT, USDT_MINT]);
const B58 = '1-9A-HJ-NP-Za-km-z';
const PLAIN_ADDR_RE = new RegExp(`(?:^|[\\s:=(\\[])([${B58}]{32,44})(?=$|[\\s.,;:!?)\\]])`, 'g');
const URL_RE = /https?:\/\/[^\s<>"']+|(?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s<>"']+/gi;
const URL_ADDR_RE = new RegExp(`(?:^|[\\/?=&_\\-#.])([${B58}]{32,44})(?=$|[\\/?=&_\\-#.])`, 'g');
/** DexScreener and similar sites lowercase the address in their links, so base58 rules do not apply. */
const URL_ANY_ADDR_RE = /(?:^|[\/?=&_\-#.])([A-Za-z0-9]{32,44})(?=$|[\/?=&_\-#.])/g;
/** Sites whose links usually carry a pool (pair) address instead of the token mint. */
const PAIR_LINK_HOSTS = /dexscreener\.com|photon-sol|tinyastro\.io|axiom\.trade|geckoterminal\.com|dextools\.io|birdeye\.so\/pool/i;

/**
 * Finds the Solana address a user means in pasted text: a bare mint
 * (also "CA: <mint>" or with trailing punctuation) or any link that carries
 * one (pump.fun, DexScreener, Birdeye, GMGN, Photon, Axiom, BullX, Jupiter,
 * Raydium, Solscan...). In links the last non-SOL/USDC/USDT address wins
 * (e.g. Raydium "inputMint=SOL&outputMint=<mint>").
 * `maybePair` is true when the link usually holds a pool address.
 */
export function extractSolanaCandidate(text: string): { address: string; maybePair: boolean } | null {
  if (!text) return null;
  for (const url of text.match(URL_RE) || []) {
    const pairHost = PAIR_LINK_HOSTS.test(url);
    let last: string | null = null;
    for (const m of url.matchAll(pairHost ? URL_ANY_ADDR_RE : URL_ADDR_RE)) {
      // Pool links: any 32-44 char id (possibly lowercased) that is not a plain word.
      const ok = pairHost ? /\d/.test(m[1]) || isSolanaAddress(m[1]) : isSolanaAddress(m[1]);
      if (ok && !QUOTE_MINTS.has(m[1])) last = m[1];
    }
    if (last) return { address: last, maybePair: pairHost };
  }
  for (const m of text.matchAll(PLAIN_ADDR_RE)) {
    if (isSolanaAddress(m[1]) && !QUOTE_MINTS.has(m[1])) return { address: m[1], maybePair: false };
  }
  return null;
}

const pairMintCache = new TtlCache<string | null>(10 * 60_000, 2000);

/**
 * Resolves a DEX pool (pair) address to its token mint with the free
 * DexScreener API (no key, no RPC). Returns null when it is not a known pool.
 */
export async function resolveSolanaPairToMint(address: string): Promise<string | null> {
  if (!/^[A-Za-z0-9]{32,44}$/.test(address)) return null;
  return pairMintCache.get(address, async () => {
    try {
      // DexScreener accepts lowercased ids. A pool id resolves directly; a
      // (lowercased) token id is found through search.
      const j = await fetchJson<any>(`https://api.dexscreener.com/latest/dex/pairs/solana/${address}`, { timeoutMs: 5000 });
      let pair = j?.pair || (Array.isArray(j?.pairs) ? j.pairs[0] : null);
      if (!pair) {
        const sj = await fetchJson<any>(`https://api.dexscreener.com/latest/dex/search?q=${address}`, { timeoutMs: 5000 });
        const low = address.toLowerCase();
        const hit = (Array.isArray(sj?.pairs) ? sj.pairs : []).find((p: any) => p?.chainId === 'solana' &&
          [p?.pairAddress, p?.baseToken?.address, p?.quoteToken?.address].some((a: any) => String(a || '').toLowerCase() === low));
        if (!hit) return null;
        for (const t of [hit.baseToken, hit.quoteToken]) {
          if (String(t?.address || '').toLowerCase() === low && isSolanaAddress(t.address)) return t.address;
        }
        pair = hit;
      }
      const base = String(pair.baseToken?.address || '');
      const quote = String(pair.quoteToken?.address || '');
      const mint = QUOTE_MINTS.has(base) && quote && !QUOTE_MINTS.has(quote) ? quote : base;
      return isSolanaAddress(mint) && !QUOTE_MINTS.has(mint) ? mint : null;
    } catch {
      return null;
    }
  });
}

// ── pump.fun launch feed (free HTTP API, no RPC) ─────────────────────────────

export interface PumpLaunch {
  mint: string;
  creator: string;
  name: string;
  symbol: string;
  createdAt: number; // ms
  complete: boolean;
}

function toLaunch(c: any): PumpLaunch | null {
  if (!c || typeof c.mint !== 'string' || typeof c.creator !== 'string') return null;
  return {
    mint: c.mint,
    creator: c.creator,
    name: String(c.name || ''),
    symbol: String(c.symbol || ''),
    createdAt: Number(c.created_timestamp || 0),
    complete: Boolean(c.complete),
  };
}

/**
 * Newest pump.fun launches across ALL creators (newest first). One call covers
 * every watched deployer at once, so deployer snipes scale without extra calls.
 * pump.fun launches roughly one coin every few seconds, so 50 covers minutes.
 */
export async function getPumpLatestLaunches(limit = 50): Promise<PumpLaunch[]> {
  const list = await fetchJson<any[]>(
    `${PUMP_API_BASE}/coins?offset=0&limit=${Math.min(Math.max(limit, 1), 50)}&sort=created_timestamp&order=DESC&includeNsfw=true`,
    { timeoutMs: 5000, headers: PUMP_HEADERS },
  );
  return (Array.isArray(list) ? list : []).map(toLaunch).filter((x): x is PumpLaunch => !!x);
}

/** Coins created by one wallet on pump.fun, newest first (fallback / catch-up path). */
export async function getPumpLaunchesByCreator(creator: string, limit = 20): Promise<PumpLaunch[]> {
  const res = await fetchJson<any>(
    `${PUMP_API_BASE}/coins-v2/user-created-coins/${creator}?offset=0&limit=${Math.min(Math.max(limit, 1), 50)}&includeNsfw=true`,
    { timeoutMs: 6000, headers: PUMP_HEADERS },
  );
  const coins = Array.isArray(res?.coins) ? res.coins : Array.isArray(res) ? res : [];
  return coins
    .map(toLaunch)
    .filter((x: PumpLaunch | null): x is PumpLaunch => !!x)
    .sort((a: PumpLaunch, b: PumpLaunch) => b.createdAt - a.createdAt);
}

/** pump.fun's view of a mint (one pump.fun API call, no Jupiter, no RPC). Null when pump.fun does not know it. */
export async function getPumpCoinState(mint: string): Promise<{ complete: boolean; createdAt: number } | null> {
  const coin = await fetchPumpCoin(mint);
  return coin ? { complete: Boolean(coin.complete), createdAt: Number(coin.created_timestamp || 0) } : null;
}

/** True once the token can be bought: a live pump.fun curve, or a priced token Jupiter can route. */
export async function isSolanaTokenTradable(mint: string): Promise<boolean> {
  const info = await getSolanaTokenInfo(mint, true).catch(() => null);
  if (!info) return false;
  if (info.launchpad === 'pump.fun' && info.bondingPhase === 'prebonded') return true;
  return info.priceUsd > 0 && (info.liquidityUsd > 0 || info.launchpad === 'pump.fun');
}

// ── Swap building (Jupiter /build, zero RPC) ─────────────────────────────────

interface JupIx {
  programId: string;
  accounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  data: string; // base64
}

function toIx(ix: JupIx): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
    data: Buffer.from(ix.data, 'base64'),
  });
}

function blockhashToString(bh: any): string {
  if (typeof bh === 'string') return bh;
  if (Array.isArray(bh) || bh instanceof Uint8Array) return bs58.encode(Buffer.from(bh as any));
  throw new Error('Jupiter returned an unexpected blockhash format');
}

export interface SolanaSwapBuild {
  tx: VersionedTransaction;
  inAmount: bigint;
  outAmount: bigint;
  minOutAmount: bigint;
  routeLabels: string[];
  lastValidBlockHeight: number;
  feeLamports: bigint;
}

/**
 * Builds a signed-ready versioned transaction for a swap, with the platform
 * fee appended as a SOL transfer to the dev wallet.
 *
 * Buys: `amount` is the SOL to swap AFTER the fee was taken out; the fee
 * transfer runs in the same transaction.
 * Sells: the fee is computed by the caller from the quote (via `feeFromQuote`)
 * and transferred after the swap has unwrapped SOL to the user.
 */
export async function buildSolanaSwap(params: SolanaSwapParams): Promise<SolanaSwapBuild> {
  const plan = await buildSolanaSwapPlan(params);
  return {
    tx: compileSolanaPlan(plan, plan.instructions, plan.owner, plan.blockhash),
    inAmount: plan.inAmount,
    outAmount: plan.outAmount,
    minOutAmount: plan.minOutAmount,
    routeLabels: plan.routeLabels,
    lastValidBlockHeight: plan.lastValidBlockHeight,
    feeLamports: plan.feeLamports,
  };
}

export interface SolanaSwapParams {
  owner: string;
  inputMint: string;
  outputMint: string;
  amount: bigint;
  slippageBps: number;
  /** Fixed fee (buys). */
  feeLamports?: bigint;
  /** Fee from quoted SOL output (sells). Receives the quoted out amount in lamports. */
  feeFromQuote?: (outLamports: bigint) => bigint;
  feeRecipient?: string;
}

/** A built swap before it is compiled into a transaction (lets RaceFleet reuse one route for many wallets). */
export interface SolanaSwapPlan {
  owner: string;
  inputMint: string;
  outputMint: string;
  instructions: TransactionInstruction[];
  /** Index of the Jupiter swap instruction inside `instructions`. */
  swapIndex: number;
  alts: AddressLookupTableAccount[];
  blockhash: string;
  lastValidBlockHeight: number;
  inAmount: bigint;
  outAmount: bigint;
  minOutAmount: bigint;
  slippageBps: number;
  routeLabels: string[];
  feeLamports: bigint;
}

export function compileSolanaPlan(
  plan: SolanaSwapPlan,
  instructions: TransactionInstruction[],
  payer: string,
  blockhash: string,
): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey: new PublicKey(payer),
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(plan.alts);
  return new VersionedTransaction(message);
}

export async function buildSolanaSwapPlan(params: SolanaSwapParams): Promise<SolanaSwapPlan> {
  const q = new URLSearchParams({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amount.toString(),
    taker: params.owner,
    slippageBps: String(Math.max(1, Math.min(5000, Math.round(params.slippageBps)))),
    computeUnitPricePercentile: PRIORITY_LEVEL,
    wrapAndUnwrapSol: 'true',
    // Leave room in the 1232-byte transaction for the fee transfer we append.
    maxAccounts: '54',
  });
  const j = await jupiterGet<any>(`/swap/v2/build?${q.toString()}`, 'trade', 10_000);
  if (!j || j.error || !j.swapInstruction) {
    const reason = j?.error || j?.errorMessage || 'No route found';
    throw new Error(`No Solana swap route: ${reason}`);
  }

  const outAmount = BigInt(String(j.outAmount ?? '0'));
  const minOutAmount = BigInt(String(j.otherAmountThreshold ?? j.outAmount ?? '0'));
  const feeRecipient = params.feeRecipient || DEFAULT_SOLANA_DEV_FEE_WALLET;
  let feeLamports = params.feeLamports ?? 0n;
  if (params.feeFromQuote) feeLamports = params.feeFromQuote(outAmount);

  const owner = new PublicKey(params.owner);
  // Priority price from Jupiter (instruction tag 3 = SetComputeUnitPrice), with a healthy floor to beat Solana network congestion.
  const MIN_PRIORITY_MICROLAMPORTS = 100_000n; // 0.00004 SOL min priority fee
  let priceMicroLamports = MIN_PRIORITY_MICROLAMPORTS;
  for (const ix of (j.computeBudgetInstructions || []) as JupIx[]) {
    const d = Buffer.from(ix.data, 'base64');
    if (d[0] === 3 && d.length >= 9) {
      const p = d.readBigUInt64LE(1);
      if (p > priceMicroLamports) priceMicroLamports = p;
    }
  }
  if (priceMicroLamports > MAX_PRIORITY_MICROLAMPORTS) priceMicroLamports = MAX_PRIORITY_MICROLAMPORTS;

  const setupIxs = ((j.setupInstructions || []) as JupIx[]).map(toIx);
  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: SWAP_COMPUTE_UNIT_LIMIT }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priceMicroLamports }),
    ...setupIxs,
    toIx(j.swapInstruction),
    ...(j.cleanupInstruction ? [toIx(j.cleanupInstruction)] : []),
    ...((j.otherInstructions || []) as JupIx[]).map(toIx),
  ];
  if (feeLamports > 0n) {
    ixs.push(SystemProgram.transfer({ fromPubkey: owner, toPubkey: new PublicKey(feeRecipient), lamports: feeLamports }));
  }

  const alts: AddressLookupTableAccount[] = Object.entries<string[]>(j.addressesByLookupTableAddress || {}).map(
    ([key, addresses]) =>
      new AddressLookupTableAccount({
        key: new PublicKey(key),
        state: {
          deactivationSlot: BigInt('18446744073709551615'),
          lastExtendedSlot: 0,
          lastExtendedSlotStartIndex: 0,
          authority: undefined,
          addresses: addresses.map((a) => new PublicKey(a)),
        },
      }),
  );

  const bhMeta = j.blockhashWithMetadata;
  if (!bhMeta?.blockhash) throw new Error('Jupiter build returned no blockhash');

  return {
    owner: params.owner,
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    instructions: ixs,
    swapIndex: 2 + setupIxs.length,
    alts,
    blockhash: blockhashToString(bhMeta.blockhash),
    lastValidBlockHeight: Number(bhMeta.lastValidBlockHeight || 0),
    inAmount: BigInt(String(j.inAmount ?? params.amount)),
    outAmount,
    minOutAmount,
    slippageBps: Math.max(1, Math.min(5000, Math.round(params.slippageBps))),
    routeLabels: (j.routePlan || []).map((r: any) => r?.swapInfo?.label).filter(Boolean),
    feeLamports,
  };
}

// ── One route, many wallets (RaceFleet "fire together") ─────────────────────

/** Platform fee as a plain SOL transfer to the dev wallet (appended after a swap). */
export function solanaFeeTransferIx(from: string, lamports: bigint, recipient = DEFAULT_SOLANA_DEV_FEE_WALLET): TransactionInstruction {
  return SystemProgram.transfer({ fromPubkey: new PublicKey(from), toPubkey: new PublicKey(recipient), lamports });
}

const PUMP_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PUMP_AMM_PROGRAM_ID = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

function ataOf(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
  )[0];
}

/** Owner-derived accounts a Jupiter route may touch: the owner, its token accounts and pump.fun volume PDAs. */
type OwnerSlot =
  | { kind: 'owner' }
  | { kind: 'ata'; mint: PublicKey; tokenProgram: PublicKey }
  | { kind: 'pda'; program: PublicKey; seed: string };

function ownerSlots(plan: SolanaSwapPlan): Map<string, OwnerSlot> {
  const owner = new PublicKey(plan.owner);
  const slots = new Map<string, OwnerSlot>([[plan.owner, { kind: 'owner' }]]);
  const candidates = new Set<string>([plan.inputMint, plan.outputMint, SOL_MINT]);
  for (const ix of plan.instructions) for (const k of ix.keys) candidates.add(k.pubkey.toBase58());
  const programs = [new PublicKey(TOKEN_PROGRAM_ID), new PublicKey(TOKEN_2022_PROGRAM_ID)];
  const used = new Set<string>();
  for (const ix of plan.instructions) for (const k of ix.keys) used.add(k.pubkey.toBase58());
  for (const m of candidates) {
    let mint: PublicKey;
    try { mint = new PublicKey(m); } catch { continue; }
    for (const tp of programs) {
      const ata = ataOf(owner, mint, tp).toBase58();
      if (used.has(ata)) slots.set(ata, { kind: 'ata', mint, tokenProgram: tp });
    }
  }
  for (const prog of [PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID]) {
    const program = new PublicKey(prog);
    const pda = PublicKey.findProgramAddressSync([Buffer.from('user_volume_accumulator'), owner.toBuffer()], program)[0].toBase58();
    if (used.has(pda)) slots.set(pda, { kind: 'pda', program, seed: 'user_volume_accumulator' });
  }
  return slots;
}

function slotFor(slot: OwnerSlot, owner: PublicKey): PublicKey {
  if (slot.kind === 'owner') return owner;
  if (slot.kind === 'ata') return ataOf(owner, slot.mint, slot.tokenProgram);
  return PublicKey.findProgramAddressSync([Buffer.from(slot.seed), owner.toBuffer()], slot.program)[0];
}

/**
 * Offset of in_amount inside the Jupiter swap instruction data, or -1 when the
 * layout is not the one we verified (in_amount u64, quoted_out u64, slippage u16
 * right after the 8-byte discriminator, with an optional 1-byte id before them).
 */
function jupiterAmountOffset(plan: SolanaSwapPlan): number {
  const d = plan.instructions[plan.swapIndex]?.data;
  if (!d) return -1;
  for (const off of [8, 9]) {
    if (d.length < off + 18) continue;
    if (d.readBigUInt64LE(off) === plan.inAmount && d.readBigUInt64LE(off + 8) === plan.outAmount && d.readUInt16LE(off + 16) === plan.slippageBps) {
      return off;
    }
  }
  return -1;
}

/**
 * Re-targets a built route to another wallet: swaps the owner and every
 * owner-derived account, and (for sells) patches the input amount and quoted
 * output. Returns null when the instruction layout is unknown and the amount
 * must change, so the caller can build that wallet separately instead.
 * Callers must simulate the result before sending.
 */
export function remapSolanaSwapPlan(plan: SolanaSwapPlan, newOwner: string, newAmount?: bigint): TransactionInstruction[] | null {
  const owner = new PublicKey(newOwner);
  const slots = ownerSlots(plan);
  const replace = new Map<string, PublicKey>();
  for (const [addr, slot] of slots) replace.set(addr, slotFor(slot, owner));

  const amountChanges = newAmount !== undefined && newAmount !== plan.inAmount;
  const off = amountChanges ? jupiterAmountOffset(plan) : -1;
  if (amountChanges && off < 0) return null;

  return plan.instructions.map((ix, i) => {
    let data = ix.data;
    if (i === plan.swapIndex && amountChanges) {
      data = Buffer.from(ix.data);
      data.writeBigUInt64LE(newAmount!, off);
      data.writeBigUInt64LE((plan.outAmount * newAmount!) / plan.inAmount, off + 8);
    }
    return new TransactionInstruction({
      programId: ix.programId,
      data,
      keys: ix.keys.map((k) => ({ ...k, pubkey: replace.get(k.pubkey.toBase58()) ?? k.pubkey })),
    });
  });
}

/**
 * Changes the slippage of an already built route in place (verified layout
 * only). Returns false when the layout is unknown; the caller then rebuilds.
 */
export function setSolanaPlanSlippage(plan: SolanaSwapPlan, slippageBps: number): boolean {
  const off = jupiterAmountOffset(plan);
  if (off < 0) return false;
  const bps = Math.max(1, Math.min(5000, Math.round(slippageBps)));
  const ix = plan.instructions[plan.swapIndex];
  const data = Buffer.from(ix.data);
  data.writeUInt16LE(bps, off + 16);
  plan.instructions[plan.swapIndex] = new TransactionInstruction({ programId: ix.programId, keys: ix.keys, data });
  plan.slippageBps = bps;
  return true;
}

/** Quote only (no transaction). Used to size slippage for many wallets trading the same pool at once. */
export async function getJupiterQuoteOut(inputMint: string, outputMint: string, amount: bigint): Promise<bigint | null> {
  try {
    const q = new URLSearchParams({ inputMint, outputMint, amount: amount.toString(), slippageBps: '100' });
    const j = await jupiterGet<any>(`/swap/v1/quote?${q.toString()}`, 'trade', 8000);
    const out = BigInt(String(j?.outAmount ?? '0'));
    return out > 0n ? out : null;
  } catch {
    return null;
  }
}

/** Simulates a transaction without signatures (free RPC only). */
export async function simulateSolanaTx(tx: VersionedTransaction): Promise<{ ok: boolean; error: string | null }> {
  try {
    const b64 = Buffer.from(tx.serialize()).toString('base64');
    const r = await solanaRpc<any>('simulateTransaction', [b64, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' }], { timeoutMs: 8000, allowPaid: false });
    const err = r?.value?.err;
    return err ? { ok: false, error: describeSolanaError(err) } : { ok: true, error: null };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'simulation failed' };
  }
}

/** Fresh blockhash for signing many transactions at once. */
export async function getSolanaLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
  return latestBlockhash();
}

/**
 * Broadcasts many signed transactions at the same instant, then confirms them
 * together with one getSignatureStatuses call per round (not one per tx).
 * Unconfirmed ones are re-broadcast every 3 s until the blockhash expires.
 */
export async function sendAndConfirmManySolana(
  txs: VersionedTransaction[],
  lastValidBlockHeight: number,
): Promise<SolanaSendResult[]> {
  const items = txs.map((tx) => ({
    b64: Buffer.from(tx.serialize()).toString('base64'),
    sig: bs58.encode(Buffer.from(tx.signatures[0])),
    done: null as SolanaSendResult | null,
  }));
  const fire = (list: typeof items) =>
    Promise.all(list.map((it) => Promise.all([broadcastFree(it.b64), broadcastJupiter(it.b64)])));

  // Everything goes out together.
  const first = await fire(items);
  // Anything no free endpoint (or Jupiter) accepted gets one paid attempt.
  await Promise.all(items.map(async (it, i) => {
    const [freeSig, jupOk] = first[i];
    if (!freeSig && !jupOk) await broadcastPaid(it.b64);
  }));

  const started = Date.now();
  let lastRebroadcast = Date.now();
  let lastHeightCheck = 0;
  while (items.some((it) => !it.done) && Date.now() - started < 75_000) {
    await new Promise((r) => setTimeout(r, confirmPollDelay(started)));
    const pending = items.filter((it) => !it.done);
    // Chunks of 10 keep every free endpoint happy (some cap list sizes).
    await Promise.all(Array.from({ length: Math.ceil(pending.length / 10) }, (_, c) => pending.slice(c * 10, c * 10 + 10)).map(async (chunk) => {
      try {
        const st = await solanaRpc<any>('getSignatureStatuses', [chunk.map((p) => p.sig), { searchTransactionHistory: false }], { timeoutMs: 6000, allowPaid: false });
        (st?.value || []).forEach((s: any, i: number) => {
          if (!s) return;
          const it = chunk[i];
          if (s.err) it.done = { signature: it.sig, confirmed: false, error: describeSolanaError(s.err) };
          else if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') it.done = { signature: it.sig, confirmed: true, error: null };
        });
      } catch { /* keep polling */ }
    }));
    if (Date.now() - lastRebroadcast > 3000) {
      lastRebroadcast = Date.now();
      void fire(items.filter((it) => !it.done));
    }
    if (lastValidBlockHeight > 0 && Date.now() - lastHeightCheck > 10_000) {
      lastHeightCheck = Date.now();
      try {
        const height = await solanaRpc<number>('getBlockHeight', [{ commitment: 'confirmed' }], { timeoutMs: 4000, allowPaid: false });
        if (height > lastValidBlockHeight) break;
      } catch { /* ignore */ }
    }
  }
  // Final look with history for anything still open.
  const open = items.filter((it) => !it.done);
  for (let c = 0; c < open.length; c += 10) {
    const chunk = open.slice(c, c + 10);
    try {
      const st = await solanaRpc<any>('getSignatureStatuses', [chunk.map((p) => p.sig), { searchTransactionHistory: true }], { timeoutMs: 6000 });
      (st?.value || []).forEach((s: any, i: number) => {
        const it = chunk[i];
        if (s && !s.err) it.done = { signature: it.sig, confirmed: true, error: null };
        else if (s?.err) it.done = { signature: it.sig, confirmed: false, error: describeSolanaError(s.err) };
      });
    } catch { /* ignore */ }
  }
  return items.map((it) => it.done ?? { signature: it.sig, confirmed: false, error: 'Not confirmed in time (blockhash expired). Nothing was spent for this wallet.' });
}

/** Sell fee: 1.5%, or 2% when proceeds are above $200 (same as NEAR). */
export function solanaSellFeeBps(proceedsLamports: bigint, solUsd: number): bigint {
  const usd = lamportsToSol(proceedsLamports) * (solUsd > 0 ? solUsd : 0);
  return usd > SOLANA_SELL_FEE_HIGH_USD_THRESHOLD ? SOLANA_SELL_FEE_BPS_HIGH : SOLANA_FEE_BPS;
}

// ── Broadcast & confirmation ────────────────────────────────────────────────

/**
 * Most swaps land within 1 to 3 seconds, so the first checks come quickly
 * (one cheap free-RPC call each), then slow down to spare the free endpoints.
 */
function confirmPollDelay(startedAt: number): number {
  const elapsed = Date.now() - startedAt;
  return elapsed < 8_000 ? 500 : elapsed < 20_000 ? 1_000 : 1_500;
}

async function broadcastFree(serialized: string): Promise<string | null> {
  const results = await Promise.allSettled(
    READ_RPC_URLS.map((url) =>
      rpcPost<string>(url, 'sendTransaction', [serialized, { encoding: 'base64', skipPreflight: true, maxRetries: 3 }], 6000),
    ),
  );
  for (const r of results) if (r.status === 'fulfilled' && r.value) return r.value;
  return null;
}

async function broadcastJupiter(serialized: string): Promise<boolean> {
  if (!JUPITER_API_KEY) return false;
  try {
    await fetchJson<any>('https://api.jup.ag/tx/v1/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': JUPITER_API_KEY },
      body: JSON.stringify({ signedTransaction: serialized }),
      timeoutMs: 6000,
    });
    return true;
  } catch {
    return false;
  }
}

async function broadcastPaid(serialized: string): Promise<boolean> {
  if (!PAID_RPC_URL || !PAID_RPC_FALLBACK_ENABLED) return false;
  try {
    paidRpcCalls++;
    await rpcPost<string>(PAID_RPC_URL, 'sendTransaction', [serialized, { encoding: 'base64', skipPreflight: true, maxRetries: 3 }], 6000);
    return true;
  } catch {
    return false;
  }
}

async function broadcastAll(serialized: string): Promise<boolean> {
  const tasks: Promise<any>[] = [broadcastFree(serialized)];
  if (PAID_RPC_URL && PAID_RPC_FALLBACK_ENABLED) {
    tasks.push(broadcastPaid(serialized));
  }
  if (JUPITER_API_KEY) {
    tasks.push(broadcastJupiter(serialized));
  }
  const results = await Promise.allSettled(tasks);
  return results.some((r) => r.status === 'fulfilled' && r.value);
}

export interface SolanaSendResult {
  signature: string;
  confirmed: boolean;
  error: string | null;
}

/**
 * Signs nothing: expects a signed transaction. Broadcasts it across available
 * endpoints (free RPCs, paid TPU-connected RPC if configured, and Jupiter's lander),
 * re-broadcasts periodically, and polls the signature status until it lands, fails,
 * or the blockhash expires.
 */
export async function sendAndConfirmSolanaTransaction(
  tx: VersionedTransaction,
  lastValidBlockHeight: number,
  onProgress?: (stage: string) => void,
): Promise<SolanaSendResult> {
  const serialized = Buffer.from(tx.serialize()).toString('base64');
  const signature = bs58.encode(Buffer.from(tx.signatures[0]));

  onProgress?.('signing_and_broadcasting');
  const broadcastOk = await broadcastAll(serialized);
  if (!broadcastOk) {
    return { signature, confirmed: false, error: 'Could not broadcast the transaction. Please try again.' };
  }

  onProgress?.('confirming');
  const started = Date.now();
  let lastRebroadcast = Date.now();
  let lastValidityCheck = Date.now();
  const HARD_TIMEOUT_MS = 75_000;
  const recentBlockhash = tx.message?.recentBlockhash;

  while (Date.now() - started < HARD_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, confirmPollDelay(started)));
    try {
      const st = await solanaRpc<any>('getSignatureStatuses', [[signature], { searchTransactionHistory: false }], { timeoutMs: 5000, allowPaid: true });
      const s = st?.value?.[0];
      if (s) {
        if (s.err) return { signature, confirmed: false, error: describeSolanaError(s.err) };
        if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') {
          return { signature, confirmed: true, error: null };
        }
      }
    } catch { /* keep polling */ }

    if (Date.now() - lastRebroadcast > 2500) {
      lastRebroadcast = Date.now();
      void broadcastAll(serialized);
    }

    // Only verify blockhash expiration after at least 15 seconds have passed
    if (Date.now() - lastValidityCheck > 15_000) {
      lastValidityCheck = Date.now();
      if (recentBlockhash) {
        try {
          const res = await solanaRpc<any>('isBlockhashValid', [recentBlockhash, { commitment: 'confirmed' }], { timeoutMs: 4000, allowPaid: true });
          const isValid = res?.value ?? res;
          if (isValid === false) {
            // One last look in history before declaring it dropped.
            const st = await solanaRpc<any>('getSignatureStatuses', [[signature], { searchTransactionHistory: true }], { timeoutMs: 5000, allowPaid: true });
            const s = st?.value?.[0];
            if (s && !s.err) return { signature, confirmed: true, error: null };
            if (s?.err) return { signature, confirmed: false, error: describeSolanaError(s.err) };
            return { signature, confirmed: false, error: 'Transaction expired before it landed (network congestion). Nothing was spent. Please try again.' };
          }
        } catch { /* ignore RPC error and continue polling */ }
      } else if (lastValidBlockHeight > 0) {
        try {
          const epoch = await solanaRpc<any>('getEpochInfo', [{ commitment: 'confirmed' }], { timeoutMs: 4000, allowPaid: true });
          const height = epoch?.blockHeight;
          if (height && height > lastValidBlockHeight) {
            const st = await solanaRpc<any>('getSignatureStatuses', [[signature], { searchTransactionHistory: true }], { timeoutMs: 5000, allowPaid: true });
            const s = st?.value?.[0];
            if (s && !s.err) return { signature, confirmed: true, error: null };
            if (s?.err) return { signature, confirmed: false, error: describeSolanaError(s.err) };
            return { signature, confirmed: false, error: 'Transaction expired before it landed (network congestion). Nothing was spent. Please try again.' };
          }
        } catch { /* ignore RPC error and continue polling */ }
      }
    }
  }

  // Final check with history (may use paid RPC once).
  try {
    const st = await solanaRpc<any>('getSignatureStatuses', [[signature], { searchTransactionHistory: true }], { timeoutMs: 6000, allowPaid: true });
    const s = st?.value?.[0];
    if (s && !s.err) return { signature, confirmed: true, error: null };
    if (s?.err) return { signature, confirmed: false, error: describeSolanaError(s.err) };
  } catch { /* ignore */ }
  return { signature, confirmed: false, error: 'Transaction was not confirmed in time. Check your wallet before retrying.' };
}

export function describeSolanaError(err: any): string {
  const s = typeof err === 'string' ? err : JSON.stringify(err);
  if (/"Custom":6001|SlippageToleranceExceeded|0x1771/.test(s)) return 'Price moved more than your slippage setting. Try again or raise slippage.';
  const rent = /InsufficientFundsForRent[^0-9]*(\d+)/.exec(s);
  if (rent) {
    return rent[1] === '0'
      ? 'This would leave your wallet with less than 0.00089 SOL, which Solana does not allow. Send everything ("all") or leave a little more.'
      : 'The receiving wallet is new and needs at least 0.00089 SOL in its first transfer. Please send a larger amount.';
  }
  if (/InsufficientFunds|"Custom":1\b|0x1\b/.test(s)) return 'Insufficient SOL to cover the trade, fees and rent.';
  return `Transaction failed on-chain: ${s.slice(0, 160)}`;
}

/**
 * Exact balance changes for `owner` in a confirmed transaction:
 * SOL delta (lamports, includes fees) and token delta (raw units) for `mint`.
 */
export async function getSolanaTxDeltas(
  signature: string,
  owner: string,
  mint: string,
): Promise<{ solDelta: bigint; tokenDelta: bigint; feeLamports: bigint } | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const tx = await solanaRpc<any>('getTransaction', [signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }], { timeoutMs: 8000 });
      if (!tx?.meta) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      const keys: string[] = (tx.transaction?.message?.accountKeys || []).map((k: any) => (typeof k === 'string' ? k : k.pubkey));
      const idx = keys.indexOf(owner);
      const solDelta = idx >= 0 ? BigInt(tx.meta.postBalances[idx]) - BigInt(tx.meta.preBalances[idx]) : 0n;
      const sumFor = (list: any[]): bigint => {
        let total = 0n;
        for (const b of list || []) {
          if (b?.owner === owner && b?.mint === mint) total += BigInt(String(b?.uiTokenAmount?.amount ?? '0'));
        }
        return total;
      };
      const tokenDelta = sumFor(tx.meta.postTokenBalances) - sumFor(tx.meta.preTokenBalances);
      return { solDelta, tokenDelta, feeLamports: BigInt(tx.meta.fee || 0) };
    } catch {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  return null;
}

// ── Transfers (withdraw) ────────────────────────────────────────────────────

function associatedTokenAddress(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
  )[0];
}

async function latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
  const r = await solanaRpc<any>('getLatestBlockhash', [{ commitment: 'confirmed' }], { timeoutMs: 5000 });
  return { blockhash: r.value.blockhash, lastValidBlockHeight: Number(r.value.lastValidBlockHeight) };
}

const SOL_TRANSFER_CU_LIMIT = 1_500;
const SOL_TRANSFER_CU_PRICE = 50_000_000; // 50 lamports per CU (50,000,000 micro-lamports -> 75,000 lamports priority fee)
/**
 * Exact network fee of a plain SOL transfer sent by transferSol (base fee plus
 * a capped priority fee). Lets "withdraw all" leave the wallet at exactly 0:
 * Solana refuses to leave a wallet with dust below the rent minimum.
 */
export const SOLANA_TRANSFER_FEE_LAMPORTS = 5000n + BigInt(Math.ceil((SOL_TRANSFER_CU_PRICE * SOL_TRANSFER_CU_LIMIT) / 1_000_000));

/**
 * Refuses destinations where funds would be lost: token mints, token accounts
 * and programs. Plain wallets (and addresses with no account yet) pass.
 * Returns whether the destination account already exists and its lamports.
 */
export async function checkSolanaWithdrawDestination(destination: string): Promise<{ exists: boolean; lamports: bigint }> {
  if (!isSolanaAddress(destination)) throw new Error('Invalid Solana destination address.');
  const r = await solanaRpc<any>('getMultipleAccounts', [[destination], { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, commitment: 'confirmed' }], { timeoutMs: 6000 });
  const acc = r?.value?.[0];
  if (!acc) return { exists: false, lamports: 0n };
  const owner = String(acc.owner || '');
  if (owner === TOKEN_PROGRAM_ID || owner === TOKEN_2022_PROGRAM_ID) {
    throw new Error('That address is a token (mint or token account), not a wallet. Funds sent there would be lost. Please use a wallet address.');
  }
  if (acc.executable) {
    throw new Error('That address is a program, not a wallet. Funds sent there would be lost. Please use a wallet address.');
  }
  return { exists: true, lamports: BigInt(String(acc.lamports ?? 0)) };
}

/** Sends native SOL. Returns the signature once confirmed. */
export async function transferSol(keypair: Keypair, to: string, lamports: bigint): Promise<string> {
  if (!isSolanaAddress(to)) throw new Error('Invalid Solana destination address.');
  if (lamports <= 0n) throw new Error('Amount must be greater than 0.');
  const { blockhash, lastValidBlockHeight } = await latestBlockhash();
  const msg = new TransactionMessage({
    payerKey: keypair.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      // Explicit limit so the fee is known exactly (SOLANA_TRANSFER_FEE_LAMPORTS).
      ComputeBudgetProgram.setComputeUnitLimit({ units: SOL_TRANSFER_CU_LIMIT }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: SOL_TRANSFER_CU_PRICE }),
      SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: new PublicKey(to), lamports }),
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([keypair]);
  const res = await sendAndConfirmSolanaTransaction(tx, lastValidBlockHeight);
  if (!res.confirmed) throw new Error(res.error || 'SOL transfer failed.');
  invalidateSolanaBalanceCache(keypair.publicKey.toBase58());
  return res.signature;
}

/** Sends an SPL / Token-2022 token, creating the recipient's token account if needed. */
export async function transferSolanaToken(
  keypair: Keypair,
  mint: string,
  to: string,
  rawAmount: bigint,
  decimals: number,
  tokenProgramId: string,
  /** Close the (now empty) source token account and return its ~0.002 SOL rent to the sender. */
  closeSourceIfEmptied = false,
): Promise<string> {
  if (!isSolanaAddress(to)) throw new Error('Invalid Solana destination address.');
  if (rawAmount <= 0n) throw new Error('Amount must be greater than 0.');
  const mintPk = new PublicKey(mint);
  const destOwner = new PublicKey(to);

  let programId: PublicKey;
  let resolvedDecimals = decimals;

  if (tokenProgramId && (tokenProgramId === TOKEN_PROGRAM_ID || tokenProgramId === TOKEN_2022_PROGRAM_ID)) {
    programId = new PublicKey(tokenProgramId);
  } else {
    try {
      const mintAcc = await solanaRpc<any>('getAccountInfo', [mint, { encoding: 'base64' }], { timeoutMs: 5000, allowPaid: true });
      const owner = mintAcc?.value?.owner;
      programId = owner ? new PublicKey(owner) : new PublicKey(tokenProgramId || TOKEN_PROGRAM_ID);
      const b64 = Array.isArray(mintAcc?.value?.data) ? mintAcc.value.data[0] : null;
      if (b64) {
        const buf = Buffer.from(b64, 'base64');
        if (buf.length >= 45) {
          resolvedDecimals = buf.readUInt8(44);
        }
      }
    } catch {
      programId = new PublicKey(tokenProgramId || TOKEN_PROGRAM_ID);
    }
  }

  if (resolvedDecimals === undefined || resolvedDecimals === null || isNaN(resolvedDecimals)) {
    resolvedDecimals = 6;
  }

  const sourceAta = associatedTokenAddress(keypair.publicKey, mintPk, programId);
  const destAta = associatedTokenAddress(destOwner, mintPk, programId);

  const createIdempotent = new TransactionInstruction({
    programId: new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
    keys: [
      { pubkey: keypair.publicKey, isSigner: true, isWritable: true },
      { pubkey: destAta, isSigner: false, isWritable: true },
      { pubkey: destOwner, isSigner: false, isWritable: false },
      { pubkey: mintPk, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });

  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0); // TransferChecked
  data.writeBigUInt64LE(rawAmount, 1);
  data.writeUInt8(resolvedDecimals, 9);
  const transferChecked = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: sourceAta, isSigner: false, isWritable: true },
      { pubkey: mintPk, isSigner: false, isWritable: false },
      { pubkey: destAta, isSigner: false, isWritable: true },
      { pubkey: keypair.publicKey, isSigner: true, isWritable: false },
    ],
    data,
  });

  const { blockhash, lastValidBlockHeight } = await latestBlockhash();
  const msg = new TransactionMessage({
    payerKey: keypair.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000 }),
      createIdempotent,
      transferChecked,
      // Classic SPL only: Token-2022 accounts can hold withheld fees that block closing.
      ...(closeSourceIfEmptied && programId.toBase58() === TOKEN_PROGRAM_ID
        ? [new TransactionInstruction({
            programId,
            keys: [
              { pubkey: sourceAta, isSigner: false, isWritable: true },
              { pubkey: keypair.publicKey, isSigner: false, isWritable: true },
              { pubkey: keypair.publicKey, isSigner: true, isWritable: false },
            ],
            data: Buffer.from([9]), // CloseAccount
          })]
        : []),
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([keypair]);
  const res = await sendAndConfirmSolanaTransaction(tx, lastValidBlockHeight);
  if (!res.confirmed) throw new Error(res.error || 'Token transfer failed.');
  invalidateSolanaBalanceCache(keypair.publicKey.toBase58());
  return res.signature;
}

// ── Multi-wallet helpers (RaceFleet) ────────────────────────────────────────

/**
 * Native SOL balance of many wallets via getMultipleAccounts. Chunks of 10:
 * the free public RPC (publicnode) rejects more than 10 accounts per call.
 */
export async function getSolanaLamportsMulti(addresses: string[]): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  const chunks: string[][] = [];
  for (let i = 0; i < addresses.length; i += 10) chunks.push(addresses.slice(i, i + 10));
  await Promise.all(chunks.map(async (chunk) => {
    const r = await solanaRpc<any>('getMultipleAccounts', [chunk, { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, commitment: 'confirmed' }], { timeoutMs: 8000 });
    const values: any[] = r?.value || [];
    chunk.forEach((addr, j) => out.set(addr, BigInt(String(values[j]?.lamports ?? 0))));
  }));
  return out;
}

/** Rent-exempt minimum for a plain system account (0 data bytes). */
export const SOLANA_RENT_EXEMPT_MIN_LAMPORTS = 890_880n;

const BATCH_CU_PRICE = 50_000; // micro-lamports per CU
/** Explicit CU limit for n system transfers (each uses ~150 CU), so the fee is known exactly. */
function batchCuLimit(n: number): number {
  return 1_000 + 300 * n;
}
/** Exact network fee (base + priority) of a batch with `signatures` signers and `n` transfers. */
function batchFeeLamports(signatures: number, n: number): bigint {
  return 5000n * BigInt(signatures) + BigInt(Math.ceil((BATCH_CU_PRICE * batchCuLimit(n)) / 1_000_000));
}

async function sendLegacyBatch(payer: Keypair, signers: Keypair[], instructions: TransactionInstruction[]): Promise<SolanaSendResult> {
  const { blockhash, lastValidBlockHeight } = await latestBlockhash();
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: batchCuLimit(instructions.length) }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: BATCH_CU_PRICE }),
      ...instructions,
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  const uniq = new Map<string, Keypair>();
  for (const k of [payer, ...signers]) uniq.set(k.publicKey.toBase58(), k);
  tx.sign([...uniq.values()]);
  return sendAndConfirmSolanaTransaction(tx, lastValidBlockHeight);
}

/**
 * Sends SOL from one wallet to many (10 transfers per transaction to stay
 * under the 1232-byte limit). Returns per-recipient success.
 */
export async function sendSolToMany(
  from: Keypair,
  transfers: Array<{ to: string; lamports: bigint }>,
): Promise<{ sent: Array<{ to: string; lamports: bigint; signature: string }>; failed: Array<{ to: string; error: string }> }> {
  const sent: Array<{ to: string; lamports: bigint; signature: string }> = [];
  const failed: Array<{ to: string; error: string }> = [];
  const valid = transfers.filter((t) => t.lamports > 0n && isSolanaAddress(t.to));
  for (let i = 0; i < valid.length; i += 10) {
    const batch = valid.slice(i, i + 10);
    try {
      const res = await sendLegacyBatch(
        from,
        [],
        batch.map((t) => SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: new PublicKey(t.to), lamports: t.lamports })),
      );
      if (res.confirmed) batch.forEach((t) => sent.push({ ...t, signature: res.signature }));
      else batch.forEach((t) => failed.push({ to: t.to, error: res.error || 'not confirmed' }));
    } catch (err: any) {
      batch.forEach((t) => failed.push({ to: t.to, error: err?.message || 'send failed' }));
    }
  }
  invalidateSolanaBalanceCache(from.publicKey.toBase58());
  return { sent, failed };
}

/**
 * Moves ALL native SOL from many wallets into one destination, leaving each
 * source at exactly 0 (a system account may hold 0 or at least the rent
 * minimum, never dust in between).
 *
 * When the fee payer (the user's main wallet) can cover fees, it pays them and
 * 6 sources are swept per transaction. Otherwise every source pays its own
 * exact fee in its own transaction.
 */
export async function sweepSolFromMany(
  sources: Keypair[],
  destination: string,
  feePayer: Keypair,
): Promise<{ sweptLamports: bigint; walletsSwept: number; failed: number }> {
  const payerAddr = feePayer.publicKey.toBase58();
  const balances = await getSolanaLamportsMulti([...sources.map((k) => k.publicKey.toBase58()), payerAddr]);
  const dest = new PublicKey(destination);
  let sweptLamports = 0n;
  let walletsSwept = 0;
  let failed = 0;

  const batches = Math.ceil(sources.length / 6);
  const payerCanFund = (balances.get(payerAddr) ?? 0n) >= batchFeeLamports(7, 6) * BigInt(Math.max(1, batches)) + SOLANA_RENT_EXEMPT_MIN_LAMPORTS;
  if (!payerCanFund) {
    // Self-paid: each wallet sends its balance minus its own exact fee.
    for (const k of sources) {
      const bal = balances.get(k.publicKey.toBase58()) ?? 0n;
      const fee = batchFeeLamports(1, 1);
      if (bal <= fee) continue;
      try {
        const res = await sendLegacyBatch(k, [], [SystemProgram.transfer({ fromPubkey: k.publicKey, toPubkey: dest, lamports: bal - fee })]);
        if (res.confirmed) { sweptLamports += bal - fee; walletsSwept++; } else failed++;
      } catch { failed++; }
    }
    invalidateSolanaBalanceCache(destination);
    return { sweptLamports, walletsSwept, failed };
  }

  const withFunds = sources.filter((k) => (balances.get(k.publicKey.toBase58()) ?? 0n) > 0n);
  for (let i = 0; i < withFunds.length; i += 6) {
    const batch = withFunds.slice(i, i + 6);
    const ixs = batch.map((k) =>
      SystemProgram.transfer({ fromPubkey: k.publicKey, toPubkey: dest, lamports: balances.get(k.publicKey.toBase58())! }),
    );
    try {
      const res = await sendLegacyBatch(feePayer, batch, ixs);
      if (res.confirmed) {
        for (const k of batch) sweptLamports += balances.get(k.publicKey.toBase58())!;
        walletsSwept += batch.length;
      } else {
        failed += batch.length;
      }
    } catch {
      failed += batch.length;
    }
  }
  invalidateSolanaBalanceCache(destination);
  invalidateSolanaBalanceCache(feePayer.publicKey.toBase58());
  return { sweptLamports, walletsSwept, failed };
}

// ── Links ───────────────────────────────────────────────────────────────────

export function solscanTxUrl(signature: string): string {
  return `https://solscan.io/tx/${signature}`;
}
export function solscanTokenUrl(mint: string): string {
  return `https://solscan.io/token/${mint}`;
}
export function solscanAccountUrl(address: string): string {
  return `https://solscan.io/account/${address}`;
}
export function pumpFunTokenUrl(mint: string): string {
  return `https://pump.fun/coin/${mint}`;
}
