/**
 * Confidential trading with per-position executors.
 *
 * Money lives in three places: the user's NEAR Intents private balance, ready executors (funded
 * before the click), and open positions (one executor each). A buy takes a ready executor and swaps
 * in one relayer transaction; the replacement is created and funded in the background. After the
 * final sell the executor pays the fee, returns all NEAR to the private balance, then deletes itself.
 *
 * The relayer signs every executor transaction, so the user's wallet never appears in a trade.
 * Off until CONFIDENTIAL_EXECUTORS_ENABLED=true (the contracts must be deployed first).
 */
import crypto from 'crypto';
import { KeyPair, transactions } from 'near-api-js';
import { createLogger, decrypt, encrypt, getNear, getNearUsdPrice } from '@racerbot/shared';
import {
  claimReadyExecutors,
  createConfidentialAccount,
  getConfidentialAccount,
  getExecutor,
  getUserConfidentialMove,
  insertConfidentialMove,
  insertExecutor,
  listExecutorsByStatus,
  listOpenConfidentialMoves,
  listUserConfidentialMoves,
  listUserExecutors,
  updateConfidentialMove,
  updateExecutor,
  type ConfidentialAccountRecord,
  type ConfidentialExecutorRecord,
  type UserRecord,
} from '@racerbot/db';
import {
  generatePrivateAccount,
  getMoveStatus,
  getPrivateNearBalance,
  notifyDeposit,
  ownerHash,
  quoteShield,
  quoteShieldFromAsset,
  unshield,
  type MoveQuote,
  type PrivateAccountKeys,
} from './intentsPrivate.js';
import { planVaultHops, quoteMinimumOut, RACER_VAULT_CONTRACT_ID } from './racerVault.js';
import { extractRouterEvents } from './routerEvents.js';
import { encodeExecPlan, type ExecPlan, type ExecVenue } from './executorPlan.js';
import { hasManagedWallet } from './webWallet.js';

const logger = createLogger('executor-pool');

export const EXECUTORS_ENABLED = process.env.CONFIDENTIAL_EXECUTORS_ENABLED === 'true';
const ROUTER = RACER_VAULT_CONTRACT_ID;
const RELAYER_ACCOUNT = process.env.EXECUTOR_RELAYER_ACCOUNT_ID || process.env.RELAYER_ACCOUNT_ID || 'racerbot.near';
const RELAYER_KEY = (process.env.EXECUTOR_RELAYER_PRIVATE_KEY || process.env.RELAYER_PRIVATE_KEY || '').trim();
const MASTER_KEY = process.env.KEY_ENCRYPTION_MASTER_KEY || process.env.ENCRYPTION_MASTER_KEY || '';

/** RacerBot's deposit per executor: storage stake, registrations, buffer (mostly returned at deletion) */
const CREATION_DEPOSIT = 12_000_000_000_000_000_000_000n; // 0.012 NEAR
const ONE_NEAR = 10n ** 24n;
const MIN_EXECUTOR_SIZE = ONE_NEAR / 10n; // 0.1 NEAR
const HARD_POOL_CAP = 100n * ONE_NEAR;
const BUY_FEE_BPS = 150;
const SELL_FEE_BPS = 150;
const LARGE_SELL_FEE_BPS = 200;
const LARGE_SELL_USD = 200;
const CLOSE_DELAY_MS = 30_000; // executor waits 20 blocks after exiting
const STALE_READY_MS = 24 * 3600_000;
const TGAS = 1_000_000_000_000n;

export interface ConfidentialTradeResult {
  success: boolean;
  executors: string[];
  txHashes: string[];
  amountIn: string;
  fee?: string;
  reason?: string;
}

// ── Relayer ───────────────────────────────────────────────────────────────────

interface RelayerLane {
  account: string;
  key: string;
  queue: Promise<unknown>;
  pending: number;
  keyLoaded: boolean;
}

/**
 * Relayer accounts from EXECUTOR_RELAYERS (`acct1.near=ed25519:...,acct2.near=ed25519:...`), else
 * the single EXECUTOR_RELAYER_ACCOUNT_ID / _PRIVATE_KEY. Each must be allowed with router.set_relayer.
 */
export function parseRelayers(spec: string | undefined, fallbackAccount: string, fallbackKey: string): { account: string; key: string }[] {
  const lanes = (spec || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
    .map(item => {
      const eq = item.indexOf('=');
      return eq > 0 ? { account: item.slice(0, eq).trim(), key: item.slice(eq + 1).trim() } : null;
    })
    .filter((l): l is { account: string; key: string } => !!l && !!l.account && l.key.startsWith('ed25519:'));
  if (lanes.length > 0) return lanes;
  return fallbackKey ? [{ account: fallbackAccount, key: fallbackKey }] : [];
}

const relayerLanes: RelayerLane[] = parseRelayers(process.env.EXECUTOR_RELAYERS, RELAYER_ACCOUNT, RELAYER_KEY)
  .map(l => ({ ...l, queue: Promise.resolve(), pending: 0, keyLoaded: false }));

/**
 * Sign with the least busy relayer. Each relayer account sends one transaction at a time (one
 * access key cannot sign two nonces at once safely); several accounts let split and fleet buys
 * go out together.
 */
async function relayerCall(receiver: string, method: string, args: object, gasTgas: number, deposit = 0n): Promise<any> {
  if (relayerLanes.length === 0) throw new Error('Executor relayer key is not configured');
  const lane = relayerLanes.reduce((best, l) => (l.pending < best.pending ? l : best));
  lane.pending++;
  const run = async () => {
    const near = getNear();
    if (!lane.keyLoaded) {
      await near.addKey(lane.account, KeyPair.fromString(lane.key as any));
      lane.keyLoaded = true;
    }
    return near.signAndSendTransactionAll(lane.account, receiver, [
      transactions.functionCall(method, args, BigInt(gasTgas) * TGAS, deposit),
    ]);
  };
  const next = lane.queue.then(run, run).finally(() => { lane.pending--; });
  lane.queue = next.catch(() => undefined);
  return next;
}

interface ExecutorEvent {
  event: string;
  data: Record<string, any>;
  executor: string;
}

/** Executor events (standard racerbot-executor) from a transaction outcome, in order */
export function extractExecutorEvents(outcome: any): ExecutorEvent[] {
  const events: ExecutorEvent[] = [];
  for (const ro of outcome?.receipts_outcome || []) {
    for (const log of ro?.outcome?.logs || []) {
      if (typeof log !== 'string' || !log.startsWith('EVENT_JSON:')) continue;
      try {
        const ev = JSON.parse(log.slice('EVENT_JSON:'.length));
        if (ev?.standard === 'racerbot-executor') events.push({ event: ev.event, data: ev.data || {}, executor: ro.outcome.executor_id });
      } catch {}
    }
  }
  return events;
}

function failureOf(outcome: any): string | null {
  const s = outcome?.status;
  if (s && typeof s === 'object' && 'Failure' in s) {
    const text = JSON.stringify(s.Failure);
    return text.match(/Smart contract panicked: ([^"\\]+)/)?.[1] ?? text.slice(0, 200);
  }
  return null;
}

// ── Accounts ──────────────────────────────────────────────────────────────────

/** The user's private balance account, created on first use (no on-chain transaction) */
export async function ensureConfidentialAccount(user: UserRecord): Promise<ConfidentialAccountRecord> {
  const existing = await getConfidentialAccount(user.id);
  if (existing) return existing;
  if (!MASTER_KEY) throw new Error('Encryption master key is not configured');
  const keys = generatePrivateAccount();
  return createConfidentialAccount({
    user_id: user.id,
    private_account_id: keys.accountId,
    public_key: keys.publicKey,
    secret_key_encrypted: encrypt(keys.secretKey, MASTER_KEY),
    payout_address: user.subaccount_id,
    owner_salt: crypto.randomBytes(16).toString('hex'),
  });
}

function keysOf(acct: ConfidentialAccountRecord): PrivateAccountKeys {
  return { accountId: acct.private_account_id, publicKey: acct.public_key, secretKey: decrypt(acct.secret_key_encrypted, MASTER_KEY) };
}

export async function privateBalance(acct: ConfidentialAccountRecord): Promise<bigint> {
  return getPrivateNearBalance(keysOf(acct));
}

// ── Pool ──────────────────────────────────────────────────────────────────────

/** Create an executor and fund it from the private balance (~15 s; runs in the background) */
async function spawnExecutor(acct: ConfidentialAccountRecord, size: bigint): Promise<void> {
  const name = crypto.randomBytes(8).toString('hex');
  const executor = `${name}.${ROUTER}`;
  await insertExecutor({ account_id: executor, user_id: acct.user_id, size_yocto: size.toString() });
  try {
    const created = await relayerCall(ROUTER, 'create_executor', {
      name,
      owner_hash: ownerHash(acct.owner_salt, acct.payout_address),
    }, 100, CREATION_DEPOSIT);
    // The router's callback reports whether the account was created and initialised
    const routerEvents = extractRouterEvents(created).map(ev => ev.event);
    if (!routerEvents.includes('executor_created')) {
      throw new Error(`create_executor: ${failureOf(created) || routerEvents.join(',') || 'not created'}`);
    }
    await updateExecutor(executor, { status: 'funding', tx_hash: created?.transaction?.hash });

    const move = await unshield(keysOf(acct), size, executor);
    const rec = await insertConfidentialMove({
      user_id: acct.user_id, kind: 'refill', executor_account_id: executor,
      deposit_address: move.depositAddress, amount: size.toString(), destination: executor, intent_hash: move.intentHash,
    });
    logger.info(`Funding executor ${executor} with ${size} from ${acct.private_account_id} (move ${rec.id})`);
  } catch (e: any) {
    logger.warn(`Executor ${executor} setup failed: ${e?.message}`);
    await updateExecutor(executor, { status: 'failed', last_error: e?.message || 'setup failed' });
  }
}

const refilling = new Set<string>();

/** Top the ready pool back up to the user's settings, within their private balance and cap */
export async function refillPool(acct: ConfidentialAccountRecord): Promise<number> {
  if (!EXECUTORS_ENABLED || !acct.enabled || !acct.auto_refill || refilling.has(acct.user_id)) return 0;
  refilling.add(acct.user_id);
  try {
    const live = await listUserExecutors(acct.user_id, ['creating', 'funding', 'ready', 'claimed']);
    const missing = [...acct.pool_sizes];
    for (const e of live) {
      const i = missing.indexOf(e.size_yocto);
      if (i >= 0) missing.splice(i, 1);
    }
    if (missing.length === 0) return 0;
    const cap = BigInt(acct.pool_cap_yocto) < HARD_POOL_CAP ? BigInt(acct.pool_cap_yocto) : HARD_POOL_CAP;
    let committed = live.reduce((s, e) => s + BigInt(e.size_yocto), 0n);
    let available = await privateBalance(acct).catch(() => 0n);
    const toCreate: bigint[] = [];
    for (const raw of missing) {
      const size = BigInt(raw);
      if (size < MIN_EXECUTOR_SIZE || committed + size > cap || size > available) continue;
      toCreate.push(size);
      committed += size;
      available -= size;
    }
    // Each spawn waits on the relayer queue for its create, then funds in parallel
    await Promise.all(toCreate.map(size => spawnExecutor(acct, size)));
    return toCreate.length;
  } finally {
    refilling.delete(acct.user_id);
  }
}

// ── Plans ─────────────────────────────────────────────────────────────────────

const LAUNCHPAD_RECEIVERS = new Set(['gaypad.j1-racing.near', 'exchange.kelytradevs.near']);

/** Intear 2-hop routes arrive as an operations message; turn its swaps back into hops */
function intearHopsFromMessage(msg: string): { pool_id: number; token_in: string; token_out: string }[] | null {
  try {
    const ops = JSON.parse(msg)?.operations;
    const swaps = (Array.isArray(ops) ? ops : []).map((o: any) => o?.SwapSimple).filter(Boolean);
    if (swaps.length === 0) return null;
    const token = (a: string) => (a === 'near' ? 'near' : String(a).replace(/^nep141:/, ''));
    return swaps.map((s: any) => ({
      pool_id: Buffer.from(String(s.message || ''), 'base64').readUInt32LE(0),
      token_in: token(s.asset_in),
      token_out: token(s.asset_out),
    }));
  } catch {
    return null;
  }
}

/** Route and price-protect one executor's trade, in the executor's plan format */
async function buildPlan(p: {
  tokenAddress: string; venue: string; isBuy: boolean; amountIn: bigint; swapAmount: bigint;
  slippagePct: number; poolId?: number | null; dclPoolId?: string | null; correlationId: string;
}): Promise<ExecPlan> {
  const [planned, minOut] = await Promise.all([
    planVaultHops({
      tokenAddress: p.tokenAddress, venue: p.venue, side: p.isBuy ? 'BUY' : 'SELL',
      amountIn: p.swapAmount.toString(), slippagePct: p.slippagePct, poolId: p.poolId, dclPoolId: p.dclPoolId,
    }),
    // Quote the amount the venue actually receives (input minus RacerBot's fee on buys)
    quoteMinimumOut({
      tokenAddress: p.tokenAddress, venue: p.venue, isBuy: p.isBuy, amountIn: p.swapAmount.toString(),
      slippagePct: p.slippagePct, poolId: p.poolId, dclPoolId: p.dclPoolId,
    }),
  ]);

  let venue: ExecVenue;
  let receiver: string | null = null;
  let hops = planned.hops.map(h => ({
    pool_id: h.pool_id ?? null, dcl_pool_id: h.dcl_pool_id ?? null, token_in: h.token_in, token_out: h.token_out,
  }));
  switch (planned.venue) {
    case 'Dcl': case 'Nearlytrade': venue = 'Dcl'; break;
    case 'RefAmm': case 'Rhea': venue = 'RefAmm'; break;
    case 'Shardsmarket':
      if (!p.isBuy) throw new Error('Shardsmarket sells are not available in confidential mode yet');
      venue = 'Shardsmarket';
      break;
    case 'BondingCurve': venue = 'BondingCurve'; break;
    case 'Intear': {
      venue = 'Intear';
      const fromMsg = planned.custom_msg ? intearHopsFromMessage(planned.custom_msg) : null;
      if (fromMsg) hops = fromMsg.map(h => ({ ...h, dcl_pool_id: null }));
      // Intear names native NEAR "near", never wNEAR
      hops = hops.map(h => ({ ...h, token_in: h.token_in === 'wrap.near' ? 'near' : h.token_in, token_out: h.token_out === 'wrap.near' ? 'near' : h.token_out }));
      break;
    }
    case 'GenericFtCall':
      if (!planned.custom_contract || !LAUNCHPAD_RECEIVERS.has(planned.custom_contract)) {
        throw new Error('This token is in a pre-bonding auction, which confidential mode cannot trade');
      }
      venue = 'Launchpad';
      receiver = planned.custom_contract;
      break;
    default:
      throw new Error(`Venue ${planned.venue} is not supported in confidential mode`);
  }
  return {
    venue,
    token: p.tokenAddress,
    hops: hops.map((h, i) => ({ ...h, min_amount_out: i === hops.length - 1 ? minOut : '0' })),
    amount_in: p.amountIn.toString(),
    min_amount_out: minOut,
    receiver,
    deadline_sec: Math.floor(Date.now() / 1000) + 120,
    correlation_id: p.correlationId,
  };
}

/** Executors to spend for `amount`: one big enough (single), or several that add up (split/fleet) */
function chooseSizes(ready: ConfidentialExecutorRecord[], amount: bigint, mode: ConfidentialAccountRecord['buy_mode']): bigint[] | null {
  const sizes = ready.map(e => BigInt(e.size_yocto)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (mode === 'single') {
    const fit = sizes.find(s => s >= amount);
    return fit ? [fit] : null;
  }
  if (mode === 'fleet') {
    // Spread evenly over every ready executor that can carry an equal share
    for (let n = Math.min(sizes.length, 10); n >= 1; n--) {
      const share = amount / BigInt(n);
      const usable = sizes.filter(s => s >= share);
      if (usable.length >= n) return usable.slice(0, n);
    }
    return null;
  }
  // split: largest first until covered
  const picked: bigint[] = [];
  let left = amount;
  for (const s of [...sizes].reverse()) {
    if (left <= 0n) break;
    picked.push(s);
    left -= s;
  }
  return left <= 0n ? picked : null;
}

// ── Trading ───────────────────────────────────────────────────────────────────

export async function confidentialBuy(p: {
  user: UserRecord; tokenAddress: string; venue: string; amountYocto: bigint;
  slippagePct?: number; poolId?: number | null; dclPoolId?: string | null;
}): Promise<ConfidentialTradeResult> {
  const fail = (reason: string): ConfidentialTradeResult => ({ success: false, executors: [], txHashes: [], amountIn: p.amountYocto.toString(), reason });
  if (!EXECUTORS_ENABLED) return fail('Confidential executors are not enabled yet');
  const acct = await ensureConfidentialAccount(p.user);
  if (!acct.enabled) return fail('Confidential mode is switched off for this account');

  const ready = await listUserExecutors(acct.user_id, ['ready']);
  const sizes = chooseSizes(ready, p.amountYocto, acct.buy_mode);
  if (!sizes) {
    void refillPool(acct).catch(() => undefined);
    return fail('No ready executor covers this amount yet. Your pool is refilling (about 15 seconds); try again shortly or lower the amount.');
  }
  const claimed = await claimReadyExecutors(acct.user_id, sizes.map(String));
  if (claimed.length !== sizes.length) {
    for (const e of claimed) await updateExecutor(e.account_id, { status: 'ready' });
    return fail('Another trade took a ready executor; try again');
  }

  const group = `pos_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  // Each executor spends its share, never more than it holds
  let left = p.amountYocto;
  const shares = claimed.map((e, i) => {
    const even = p.amountYocto / BigInt(claimed.length);
    const want = acct.buy_mode === 'fleet' ? even : left;
    const share = want < BigInt(e.size_yocto) ? want : BigInt(e.size_yocto);
    left -= share;
    return i === claimed.length - 1 && acct.buy_mode === 'fleet' ? share + left : share;
  });

  const results = await Promise.all(claimed.map(async (e, i) => {
    if (i > 0 && acct.buy_mode === 'fleet' && acct.fleet_stagger_max_sec > 0) {
      await new Promise(r => setTimeout(r, Math.random() * acct.fleet_stagger_max_sec * 1000));
    }
    const amountIn = shares[i];
    const swapAmount = amountIn - (amountIn * BigInt(BUY_FEE_BPS)) / 10_000n;
    try {
      const plan = await buildPlan({
        tokenAddress: p.tokenAddress, venue: p.venue, isBuy: true, amountIn, swapAmount,
        slippagePct: p.slippagePct ?? 2, poolId: p.poolId, dclPoolId: p.dclPoolId, correlationId: group,
      });
      const outcome = await relayerCall(ROUTER, 'exec_buy', {
        executor: e.account_id, plan: encodeExecPlan(plan).toString('base64'), fee_bps: BUY_FEE_BPS,
      }, 300);
      const events = extractExecutorEvents(outcome);
      const bought = events.find(ev => ev.event === 'bought');
      const err = failureOf(outcome);
      if (bought) {
        await updateExecutor(e.account_id, {
          status: 'open', token: p.tokenAddress, venue: plan.venue, position_group: group,
          amount_spent: String(bought.data.used), fee_paid: String(bought.data.fee), event: bought, tx_hash: outcome?.transaction?.hash,
        });
        return { ok: true, executor: e.account_id, hash: outcome?.transaction?.hash, fee: BigInt(bought.data.fee || 0) };
      }
      // Nothing bought: the executor still holds its NEAR and goes back to the pool
      await updateExecutor(e.account_id, { status: 'ready', last_error: err || 'buy_failed', event: events.at(-1), tx_hash: outcome?.transaction?.hash });
      return { ok: false, executor: e.account_id, hash: outcome?.transaction?.hash, reason: err || 'The exchange rejected the swap (price moved or no liquidity)' };
    } catch (err: any) {
      await updateExecutor(e.account_id, { status: 'ready', last_error: err?.message || 'buy failed' });
      return { ok: false, executor: e.account_id, reason: err?.message || 'buy failed' };
    }
  }));

  void refillPool(acct).catch(e => logger.warn(`Refill after buy failed: ${e?.message}`));
  const ok = results.filter(r => r.ok);
  return {
    success: ok.length > 0,
    executors: ok.map(r => r.executor),
    txHashes: results.map(r => r.hash).filter(Boolean) as string[],
    amountIn: p.amountYocto.toString(),
    fee: ok.reduce((s, r) => s + (r.fee ?? 0n), 0n).toString(),
    reason: ok.length === results.length ? undefined : results.find(r => !r.ok)?.reason,
  };
}

/** Sell `percent` of a token across every executor holding it; fully sold executors start closing */
export async function confidentialSell(p: {
  user: UserRecord; tokenAddress: string; venue: string; percent: number;
  slippagePct?: number; poolId?: number | null; dclPoolId?: string | null;
}): Promise<ConfidentialTradeResult> {
  const fail = (reason: string): ConfidentialTradeResult => ({ success: false, executors: [], txHashes: [], amountIn: '0', reason });
  if (!EXECUTORS_ENABLED) return fail('Confidential executors are not enabled yet');
  const acct = await getConfidentialAccount(p.user.id);
  if (!acct) return fail('No confidential positions');
  const holding = (await listUserExecutors(acct.user_id, ['open'])).filter(e => e.token === p.tokenAddress);
  if (holding.length === 0) return fail('No confidential position in this token');
  const pct = Math.min(100, Math.max(1, Math.round(p.percent)));
  const near = getNear();
  let total = 0n;

  const results = await Promise.all(holding.map(async (e) => {
    try {
      const balance = BigInt(await near.getTokenBalance(p.tokenAddress, e.account_id));
      const amountIn = pct === 100 ? balance : (balance * BigInt(pct)) / 100n;
      if (amountIn <= 0n) return { ok: false, executor: e.account_id, reason: 'Nothing to sell' };
      total += amountIn;
      const plan = await buildPlan({
        tokenAddress: p.tokenAddress, venue: p.venue, isBuy: false, amountIn, swapAmount: amountIn,
        slippagePct: p.slippagePct ?? 2, poolId: p.poolId, dclPoolId: p.dclPoolId, correlationId: e.position_group || e.account_id,
      });
      const outcome = await relayerCall(ROUTER, 'exec_sell', { executor: e.account_id, plan: encodeExecPlan(plan).toString('base64') }, 300);
      const sold = extractExecutorEvents(outcome).find(ev => ev.event === 'sold');
      await updateExecutor(e.account_id, { event: sold ?? { event: 'sell_failed' }, tx_hash: outcome?.transaction?.hash });
      if (!sold) return { ok: false, executor: e.account_id, hash: outcome?.transaction?.hash, reason: failureOf(outcome) || 'The exchange rejected the sell' };
      // Close once nothing is left, however the sells were split (a partial sell can still empty it)
      const left = pct === 100 ? 0n : BigInt(await near.getTokenBalance(p.tokenAddress, e.account_id).catch(() => '1'));
      if (left === 0n) {
        // With rounded returns, also wait a random 5-60 s so the return is not timed with the sell
        const delay = acct.round_returns ? 5_000 + Math.random() * 55_000 : 0;
        setTimeout(() => {
          closeExecutor(e.account_id).catch(err => logger.warn(`Close of ${e.account_id} failed: ${err?.message}`));
        }, delay);
      }
      return { ok: true, executor: e.account_id, hash: outcome?.transaction?.hash };
    } catch (err: any) {
      return { ok: false, executor: e.account_id, reason: err?.message || 'sell failed' };
    }
  }));

  const ok = results.filter(r => r.ok);
  return {
    success: ok.length > 0,
    executors: ok.map(r => r.executor),
    txHashes: results.map(r => (r as any).hash).filter(Boolean),
    amountIn: total.toString(),
    reason: ok.length === results.length ? undefined : results.find(r => !r.ok)?.reason,
  };
}

/** Tokens held for `token` across the user's open executors (a position may span several) */
export async function positionBalance(userId: string, token: string): Promise<{ total: bigint; executors: { account: string; balance: bigint }[] }> {
  const near = getNear();
  const open = (await listUserExecutors(userId, ['open'])).filter(e => e.token === token);
  const executors = await Promise.all(open.map(async e => ({
    account: e.account_id,
    balance: BigInt(await near.getTokenBalance(token, e.account_id).catch(() => '0')),
  })));
  return { total: executors.reduce((s, e) => s + e.balance, 0n), executors };
}

/** Everything the confidential wallet screen shows */
export async function confidentialOverview(user: UserRecord) {
  const acct = await getConfidentialAccount(user.id);
  if (!acct) {
    return {
      enabled: EXECUTORS_ENABLED,
      account: {
        payoutAddress: user.subaccount_id,
        settings: {
          poolSizes: Array(5).fill(ONE_NEAR.toString()),
          poolCap: (5n * ONE_NEAR).toString(),
          autoRefill: true,
          buyMode: 'split' as const,
          fleetStaggerMaxSec: 0,
          roundReturns: false,
          enabled: true,
        },
      },
      privateBalance: '0',
      pool: [],
      positions: [],
      closing: [],
      needsAttention: [],
      moves: [],
    };
  }
  const [balance, executors, moves] = await Promise.all([
    privateBalance(acct).catch(() => null),
    listUserExecutors(acct.user_id, ['creating', 'funding', 'ready', 'claimed', 'open', 'exiting', 'exited', 'failed']),
    listUserConfidentialMoves(acct.user_id, 30),
  ]);
  const near = getNear();
  const positions = await Promise.all(executors.filter(e => e.status === 'open' && e.token).map(async e => ({
    executor: e.account_id,
    token: e.token,
    ...(await near.getTokenMetadata(e.token as string).then(
      (m: any) => ({ symbol: m?.symbol || null, decimals: m?.decimals ?? 18 }),
      () => ({ symbol: null, decimals: 18 }),
    )),
    venue: e.venue,
    group: e.position_group,
    spent: e.amount_spent,
    fee: e.fee_paid,
    balance: await near.getTokenBalance(e.token as string, e.account_id).catch(() => '0'),
    openedAt: e.opened_at,
  })));
  return {
    enabled: EXECUTORS_ENABLED,
    account: {
      payoutAddress: acct.payout_address,
      settings: {
        poolSizes: acct.pool_sizes,
        poolCap: acct.pool_cap_yocto,
        autoRefill: acct.auto_refill,
        buyMode: acct.buy_mode,
        fleetStaggerMaxSec: acct.fleet_stagger_max_sec,
        roundReturns: acct.round_returns,
        enabled: acct.enabled,
      },
    },
    privateBalance: balance?.toString() ?? null,
    pool: executors.filter(e => ['creating', 'funding', 'ready', 'claimed'].includes(e.status))
      .map(e => ({ executor: e.account_id, size: e.size_yocto, status: e.status })),
    positions,
    closing: executors.filter(e => ['exiting', 'exited'].includes(e.status)).map(e => ({ executor: e.account_id, status: e.status, returned: e.returned_amount })),
    needsAttention: executors.filter(e => e.status === 'failed').map(e => ({ executor: e.account_id, error: e.last_error })),
    moves: moves.map(m => ({ kind: m.kind, amount: m.amount, status: m.status, destination: m.destination, txHash: m.tx_hash, at: m.created_at })),
  };
}

/** Pool sizes for a total: whole 1 NEAR executors plus one for the remainder (at least 0.1 NEAR) */
export function poolSizesForTotal(totalYocto: bigint): string[] {
  const sizes: string[] = [];
  let left = totalYocto;
  while (left >= ONE_NEAR && sizes.length < 20) {
    sizes.push(ONE_NEAR.toString());
    left -= ONE_NEAR;
  }
  if (left >= MIN_EXECUTOR_SIZE) sizes.push(left.toString());
  return sizes;
}

export const POOL_LIMITS = { min: MIN_EXECUTOR_SIZE, hardCap: HARD_POOL_CAP, defaultTotal: 5n * ONE_NEAR };

// ── Exit and close ────────────────────────────────────────────────────────────

/** Sell fee for an exit: the bot's 1.5%, or 2% when proceeds are worth more than $200 */
async function exitFeeBps(executor: string, state: any): Promise<number> {
  const near = getNear();
  const wnear = BigInt(await near.getTokenBalance('wrap.near', executor).catch(() => '0'));
  const proceeds = BigInt(state?.native_available || 0) + wnear - BigInt(state?.value_after_buy || 0);
  if (state?.status !== 'Open' || proceeds <= 0n) return SELL_FEE_BPS;
  const usd = (Number(proceeds) / 1e24) * (await getNearUsdPrice().catch(() => 0));
  return usd > LARGE_SELL_USD ? LARGE_SELL_FEE_BPS : SELL_FEE_BPS;
}

/** Return all of an executor's NEAR to the owner's private balance (fee on proceeds), then mark it exited */
export async function closeExecutor(executor: string): Promise<void> {
  const near = getNear();
  const state = await near.view<any>(executor, 'get_state', {}).catch((e: any) => {
    // Never created (setup failed before the account existed): nothing to return
    if (/does not exist|UNKNOWN_ACCOUNT|AccountDoesNotExist/i.test(String(e?.message))) return null;
    throw e;
  });
  if (state === null) {
    await updateExecutor(executor, { status: 'closed', last_error: 'account was never created' });
    return;
  }
  const userId = (await getExecutor(executor))?.user_id;
  if (!userId) throw new Error(`Executor ${executor} is not tracked`);
  const acct = await getConfidentialAccount(userId);
  if (!acct) throw new Error('No confidential account');
  await updateExecutor(executor, { status: 'exiting' });

  const fee = await exitFeeBps(executor, state);
  const prepared = await relayerCall(ROUTER, 'exec_prepare_exit', { executor, fee_bps: fee }, 150);
  const ready = extractExecutorEvents(prepared).find(ev => ev.event === 'exit_ready');
  if (!ready) throw new Error(`prepare_exit: ${failureOf(prepared) || 'no exit amount'}`);
  const amount = BigInt(ready.data.amount || 0);
  await updateExecutor(executor, { event: ready, tx_hash: prepared?.transaction?.hash });
  if (amount === 0n) {
    await updateExecutor(executor, { status: 'exited' });
    return;
  }

  // Rounded returns send a round amount now; the remainder follows on the worker's next pass
  const send = acct.round_returns ? roundedReturn(amount) : amount;
  // Refunds of the return go back to the executor, which can exit again
  const quote = await quoteShield(acct.private_account_id, send, executor);
  const sent = await relayerCall(ROUTER, 'exec_exit_to_intents', { executor, deposit_address: quote.depositAddress, amount: send.toString() }, 150);
  const events = extractExecutorEvents(sent);
  const exited = events.find(ev => ev.event === 'exited');
  const partial = events.find(ev => ev.event === 'exit_partial');
  const txHash = sent?.transaction?.hash;
  await insertConfidentialMove({
    user_id: userId, kind: 'return', executor_account_id: executor, deposit_address: quote.depositAddress,
    amount: send.toString(), destination: acct.private_account_id, tx_hash: txHash,
  });
  if (txHash) void notifyDeposit(quote.depositAddress, txHash);
  await updateExecutor(executor, {
    status: exited ? 'exited' : 'exiting', returned_amount: send.toString(), event: exited ?? partial ?? { event: 'exit_failed' },
    tx_hash: txHash, last_error: exited || partial ? null : failureOf(sent) || 'exit failed',
  });
}

const ROUND_STEP = ONE_NEAR / 10n;

/** The first part of a rounded return: whole 0.1 NEAR steps (amounts under 0.2 NEAR go in one piece) */
export function roundedReturn(amount: bigint): bigint {
  if (amount < 2n * ROUND_STEP) return amount;
  return amount - (amount % ROUND_STEP);
}

/** Delete an exited executor once its close delay has passed (anyone may call finish_close) */
async function finishClose(e: ConfidentialExecutorRecord): Promise<void> {
  const outcome = await relayerCall(e.account_id, 'finish_close', {}, 150);
  const closed = extractExecutorEvents(outcome).find(ev => ev.event === 'closed');
  await updateExecutor(e.account_id, closed
    ? { status: 'closed', event: closed, tx_hash: outcome?.transaction?.hash, last_error: null }
    : { last_error: failureOf(outcome) || 'close not ready', tx_hash: outcome?.transaction?.hash });
}

// ── Private balance in and out ────────────────────────────────────────────────

/** Deposit NEAR from the user's RacerBot wallet into their private balance (~19 s to settle) */
export async function depositFromWallet(user: UserRecord, amount: bigint): Promise<{ depositAddress: string; txHash: string }> {
  if (isExternalWallet(user)) throw new Error('Approve the deposit in your wallet');
  const acct = await ensureConfidentialAccount(user);
  const quote = await quoteShield(acct.private_account_id, amount, user.subaccount_id);
  const near = getNear();
  await near.addKey(user.subaccount_id, KeyPair.fromString(decrypt(user.scoped_key_encrypted, MASTER_KEY) as any));
  // Wrap, register the one-time deposit address, send: one transaction to wrap.near
  const outcome = await near.signAndSendTransactionAll(user.subaccount_id, 'wrap.near', [
    transactions.functionCall('near_deposit', {}, 10n * TGAS, amount),
    transactions.functionCall('storage_deposit', { account_id: quote.depositAddress, registration_only: true }, 10n * TGAS, 1_250_000_000_000_000_000_000n),
    transactions.functionCall('ft_transfer', { receiver_id: quote.depositAddress, amount: amount.toString() }, 15n * TGAS, 1n),
  ]);
  const err = failureOf(outcome);
  if (err) throw new Error(`Deposit failed: ${err}`);
  const txHash = outcome.transaction.hash;
  await insertConfidentialMove({ user_id: user.id, kind: 'deposit', deposit_address: quote.depositAddress, amount: amount.toString(), destination: acct.private_account_id, tx_hash: txHash });
  void notifyDeposit(quote.depositAddress, txHash);
  return { depositAddress: quote.depositAddress, txHash };
}

/** Signed in with their own NEAR wallet: RacerBot holds no key for it, so the user signs deposits themselves */
export const isExternalWallet = (user: UserRecord): boolean => !hasManagedWallet(user);

export interface WalletDeposit {
  depositAddress: string;
  amount: string;
  /** One transaction to wrap.near for the user's wallet to sign: wrap, register the address, send */
  transaction: { receiverId: string; actions: { methodName: string; args: object; gas: string; deposit: string }[] };
}

/** Deposit from an external wallet: RacerBot quotes, the user's wallet signs, refunds go back to that wallet */
export async function quoteWalletDeposit(user: UserRecord, amount: bigint): Promise<WalletDeposit> {
  const acct = await ensureConfidentialAccount(user);
  const quote = await quoteShield(acct.private_account_id, amount, user.subaccount_id);
  const to = quote.depositAddress;
  await insertConfidentialMove({ user_id: user.id, kind: 'deposit', deposit_address: to, amount: amount.toString(), destination: acct.private_account_id });
  return {
    depositAddress: to,
    amount: amount.toString(),
    transaction: {
      receiverId: 'wrap.near',
      actions: [
        { methodName: 'near_deposit', args: {}, gas: (10n * TGAS).toString(), deposit: amount.toString() },
        { methodName: 'storage_deposit', args: { account_id: to, registration_only: true }, gas: (10n * TGAS).toString(), deposit: '1250000000000000000000' },
        { methodName: 'ft_transfer', args: { receiver_id: to, amount: amount.toString() }, gas: (15n * TGAS).toString(), deposit: '1' },
      ],
    },
  };
}

/** The wallet's transaction hash for a quoted deposit: lets 1Click pick it up straight away */
export async function submitWalletDeposit(user: UserRecord, depositAddress: string, txHash: string): Promise<void> {
  const move = await getUserConfidentialMove(user.id, depositAddress);
  if (!move || move.kind !== 'deposit') throw new Error('No deposit was quoted for that address');
  await updateConfidentialMove(move.id, { tx_hash: txHash });
  void notifyDeposit(depositAddress, txHash);
}

/** RacerBot's fee on deposits from other chains, the same as public multi-chain deposits */
const CROSSCHAIN_FEE = {
  recipient: process.env.RACER_FEE_RECIPIENT || process.env.TREASURY_ACCOUNT_ID || 'racerbottreasury.near',
  fee: parseInt(process.env.RACER_FEE_BPS || '100', 10),
};

/**
 * Deposit from another chain (SOL, BTC, USDC on Base...) straight into the private balance as NEAR.
 * Nothing touches a public NEAR wallet on the way in; refunds return to the private balance.
 */
export async function quoteCrossChainDeposit(user: UserRecord, originAsset: string, amountRaw: string): Promise<MoveQuote> {
  const acct = await ensureConfidentialAccount(user);
  const quote = await quoteShieldFromAsset(acct.private_account_id, originAsset, amountRaw, [CROSSCHAIN_FEE]);
  await insertConfidentialMove({
    user_id: user.id, kind: 'deposit', deposit_address: quote.depositAddress,
    amount: quote.amountOut || '0', destination: acct.private_account_id,
  });
  return quote;
}

/** Withdraw from the private balance to any NEAR account (~12 s) */
export async function withdrawPrivate(user: UserRecord, amount: bigint, destination?: string): Promise<{ depositAddress: string; intentHash: string }> {
  const acct = await getConfidentialAccount(user.id);
  if (!acct) throw new Error('No private balance');
  const to = destination || acct.payout_address;
  const move = await unshield(keysOf(acct), amount, to);
  await insertConfidentialMove({ user_id: user.id, kind: 'withdraw', deposit_address: move.depositAddress, amount: amount.toString(), destination: to, intent_hash: move.intentHash });
  return { depositAddress: move.depositAddress, intentHash: move.intentHash };
}

// ── Background worker ─────────────────────────────────────────────────────────

async function workerTick(): Promise<void> {
  // 1. Settle private-balance moves; a funded executor becomes ready
  for (const m of await listOpenConfidentialMoves(50)) {
    const s = await getMoveStatus(m.deposit_address).catch(() => null);
    if (!s || s.status === m.status) continue;
    await updateConfidentialMove(m.id, { status: s.status, details: s.details });
    if (m.kind === 'refill' && m.executor_account_id) {
      if (s.status === 'SUCCESS') await updateExecutor(m.executor_account_id, { status: 'ready' });
      else if (['REFUNDED', 'FAILED', 'INCOMPLETE_DEPOSIT'].includes(s.status)) {
        await updateExecutor(m.executor_account_id, { status: 'failed', last_error: `funding ${s.status}` });
      }
    }
    if (m.kind === 'return' && m.executor_account_id && ['REFUNDED', 'FAILED', 'INCOMPLETE_DEPOSIT'].includes(s.status)) {
      // The NEAR came back to the executor: exit again
      await updateExecutor(m.executor_account_id, { status: 'exiting', last_error: `return ${s.status}` });
    }
    // New money in the private balance (a deposit, or a closed position) can fund the ready pool
    if (s.status === 'SUCCESS' && (m.kind === 'deposit' || m.kind === 'return')) {
      const acct = await getConfidentialAccount(m.user_id).catch(() => null);
      if (acct) void refillPool(acct).catch(err => logger.warn(`Refill after ${m.kind}: ${err?.message}`));
    }
  }
  if (!EXECUTORS_ENABLED) return;
  // 2. Delete executors whose close delay has passed
  for (const e of await listExecutorsByStatus(['exited'], CLOSE_DELAY_MS / 1000, 20)) {
    await finishClose(e).catch(err => logger.warn(`finish_close ${e.account_id}: ${err?.message}`));
  }
  // 3. Retry exits that stalled, and retire ready executors idle too long
  for (const e of await listExecutorsByStatus(['exiting'], 120, 10)) {
    await closeExecutor(e.account_id).catch(err => logger.warn(`exit retry ${e.account_id}: ${err?.message}`));
  }
  for (const e of await listExecutorsByStatus(['ready'], STALE_READY_MS / 1000, 10)) {
    await closeExecutor(e.account_id).catch(err => logger.warn(`stale exit ${e.account_id}: ${err?.message}`));
  }
  // 4. Executors whose setup failed: return anything they hold and delete them, so RacerBot's deposit comes back
  for (const e of await listExecutorsByStatus(['failed'], 600, 10)) {
    await closeExecutor(e.account_id).catch(err => logger.warn(`cleanup ${e.account_id}: ${err?.message}`));
  }
}

export function startConfidentialWorker(intervalMs = 15_000): NodeJS.Timeout | null {
  if (!EXECUTORS_ENABLED) {
    logger.info('Confidential executors disabled (CONFIDENTIAL_EXECUTORS_ENABLED is not true); running private-balance move reconciler only');
  }
  let running = false;
  return setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await workerTick();
    } catch (e: any) {
      logger.warn(`Confidential worker tick failed: ${e?.message}`);
    } finally {
      running = false;
    }
  }, intervalMs);
}

export { chooseSizes as _chooseSizesForTest, intearHopsFromMessage as _intearHopsForTest };
