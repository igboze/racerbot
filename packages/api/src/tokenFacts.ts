/**
 * On-chain facts the Racer Alpha console shows for any NEAR token, read through FastNEAR:
 *   - launch time: the token contract's first transaction (FastNEAR transactions API), cached for good
 *   - total supply: ft_total_supply on the paid FastNEAR RPC (the free community nodes time out on
 *     launchpad tokens under load), falling back to the shared multi-RPC client
 *
 * The token list is large, so facts are filled in the background (launchpad tokens first, a few
 * requests at a time) and read synchronously with peekTokenFacts. The API key is sent as a header,
 * never in a URL, so it cannot end up in logs.
 */
import { createLogger, getNear } from '@racerbot/shared';

const logger = createLogger('token-facts');

const FASTNEAR_KEY = (process.env.FASTNEAR_API_KEY || '').trim();
const FASTNEAR_RPC = 'https://rpc.mainnet.fastnear.com';
const FASTNEAR_TX_API = process.env.FASTNEAR_TX_API_URL || 'https://tx.main.fastnear.com';
const REQUEST_TIMEOUT_MS = 6_000;
const SUPPLY_TTL_MS = 60 * 60_000;
const RETRY_AFTER_MS = 10 * 60_000;
const WARM_CONCURRENCY = 4;

export interface TokenFacts {
  /** First transaction of the token contract, ms since epoch */
  launchedAt?: number;
  totalSupply?: string;
  /** The account does not exist on NEAR */
  missing?: boolean;
}

interface Entry extends TokenFacts {
  supplyAt?: number;
  failedAt?: number;
}

const facts = new Map<string, Entry>();
const inflight = new Map<string, Promise<TokenFacts>>();
const queue: string[] = [];
const queued = new Set<string>();
let workers = 0;

const authHeaders = (): Record<string, string> => ({
  'Content-Type': 'application/json',
  ...(FASTNEAR_KEY ? { Authorization: `Bearer ${FASTNEAR_KEY}` } : {}),
});

class MissingAccount extends Error {}

/** A view call on the paid FastNEAR RPC, then the shared client if FastNEAR fails */
export async function fastnearView<T>(contract: string, method: string, args: object = {}): Promise<T> {
  try {
    const res = await fetch(FASTNEAR_RPC, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        jsonrpc: '2.0', id: 'racer-alpha', method: 'query',
        params: {
          request_type: 'call_function', finality: 'optimistic', account_id: contract, method_name: method,
          args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
        },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body: any = await res.json();
    if (body.error) {
      const name = body.error.cause?.name || body.error.name || '';
      if (name === 'UNKNOWN_ACCOUNT') throw new MissingAccount(contract);
      throw new Error(body.error.cause?.info?.error_message || body.error.message || name || 'RPC error');
    }
    if (body.result?.error) throw new Error(body.result.error);
    return JSON.parse(Buffer.from(body.result.result).toString() || 'null') as T;
  } catch (err) {
    if (err instanceof MissingAccount) throw err;
    logger.debug(`FastNEAR ${contract}.${method} failed, using fallback RPC: ${(err as Error)?.message}`);
    return getNear().view<T>(contract, method, args);
  }
}

/** When the token contract first appeared on-chain (its earliest transaction), or null if unknown */
export async function fetchLaunchTime(address: string): Promise<number | null> {
  const res = await fetch(`${FASTNEAR_TX_API}/v0/account`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ account_id: address, desc: false, limit: 1 }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`FastNEAR transactions API HTTP ${res.status}`);
  const body: any = await res.json();
  const ns = body?.account_txs?.[0]?.tx_block_timestamp;
  return ns ? Number(BigInt(ns) / 1_000_000n) : null;
}

/** Load (or refresh) one token's facts. Launch time is fetched once; supply hourly. */
export function loadTokenFacts(address: string): Promise<TokenFacts> {
  const key = address.toLowerCase().trim();
  const running = inflight.get(key);
  if (running) return running;
  const job = (async (): Promise<TokenFacts> => {
    const entry: Entry = facts.get(key) ?? {};
    try {
      const needsSupply = !entry.supplyAt || Date.now() - entry.supplyAt > SUPPLY_TTL_MS;
      const [supply, launchedAt] = await Promise.all([
        needsSupply ? fastnearView<string>(key, 'ft_total_supply') : Promise.resolve(entry.totalSupply),
        entry.launchedAt ? Promise.resolve(entry.launchedAt) : fetchLaunchTime(key).catch(() => null),
      ]);
      if (supply && /^\d+$/.test(String(supply))) {
        entry.totalSupply = String(supply);
        entry.supplyAt = Date.now();
      }
      if (launchedAt) entry.launchedAt = launchedAt;
      entry.failedAt = undefined;
    } catch (err) {
      if (err instanceof MissingAccount) entry.missing = true;
      else entry.failedAt = Date.now();
    }
    facts.set(key, entry);
    return { launchedAt: entry.launchedAt, totalSupply: entry.totalSupply, missing: entry.missing };
  })().finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

/** What is known about a token right now, without waiting */
export function peekTokenFacts(address: string): TokenFacts {
  const e = facts.get(address.toLowerCase().trim());
  return e ? { launchedAt: e.launchedAt, totalSupply: e.totalSupply, missing: e.missing } : {};
}

function needsLoad(key: string): boolean {
  const e = facts.get(key);
  if (!e) return true;
  if (e.missing) return false;
  if (e.failedAt && Date.now() - e.failedAt < RETRY_AFTER_MS) return false;
  return !e.launchedAt || !e.supplyAt || Date.now() - e.supplyAt > SUPPLY_TTL_MS;
}

/** Queue tokens for background loading, in the order given (callers put launchpad tokens first) */
export function warmTokenFacts(addresses: string[]): void {
  for (const a of addresses) {
    const key = a.toLowerCase().trim();
    if (!key || queued.has(key) || !needsLoad(key)) continue;
    queued.add(key);
    queue.push(key);
  }
  while (workers < WARM_CONCURRENCY && queue.length > 0) {
    workers++;
    void (async () => {
      try {
        for (let key = queue.shift(); key; key = queue.shift()) {
          queued.delete(key);
          await loadTokenFacts(key).catch(() => undefined);
        }
      } finally {
        workers--;
      }
    })();
  }
}

/** Test hook */
export function resetTokenFactsForTests(): void {
  facts.clear();
  inflight.clear();
  queue.length = 0;
  queued.clear();
}
