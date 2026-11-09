/**
 * Confidential trading with per-position executors.
 *
 * Money lives in three places: the user's NEAR Intents private balance, ready executors (funded
 * before the click), and open positions (one executor each). A buy takes a ready executor and swaps
 * in one controller transaction; the replacement is created and funded in the background. After the
 * final sell the executor pays the fee, returns all NEAR to the private balance, then deletes itself.
 *
 * The controller (racerbot.near) signs every executor transaction, so the user's wallet never appears in a trade.
 * Off until CONFIDENTIAL_EXECUTORS_ENABLED=true (the contracts must be deployed first).
 */
import crypto from 'crypto';
import { KeyPair, transactions } from 'near-api-js';
import { Account, JsonRpcProvider, actions } from 'near-api-js-v7';
import { createLogger, decrypt, encrypt, getNear, getNearUsdPrice } from '@racerbot/shared';
import {
  claimReadyExecutors,
  createConfidentialAccount,
  expireStaleConfidentialQuotes,
  getConfidentialAccount,
  listActiveConfidentialAccounts,
  repairConfidentialPayout,
  getExecutor,
  getUserConfidentialMove,
  insertConfidentialMove,
  insertExecutor,
  listExecutorsByStatus,
  listOpenConfidentialMoves,
  listUserConfidentialMoves,
  listUserExecutors,
  markConfidentialMovesChecked,
  touchExecutors,
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
import { planVaultHops, quoteMinimumOut } from './racerVault.js';
import { encodeExecPlan, type ExecPlan, type ExecVenue } from './executorPlan.js';
import { hasManagedWallet } from './webWallet.js';
import { withInFlightGuard } from './inflight.js';

const logger = createLogger('executor-pool');

export const EXECUTORS_ENABLED = process.env.CONFIDENTIAL_EXECUTORS_ENABLED !== 'false';
/**
 * The account that creates and drives every executor (each executor is `<name>.<controller>` and only
 * accepts calls from it). There is no router contract: this account signs every executor transaction.
 */
export const EXECUTOR_CONTROLLER = process.env.EXECUTOR_CONTROLLER_ACCOUNT_ID || process.env.RACERBOT_PARENT_ACCOUNT || 'racerbot.near';
/** Hex sha256 of the deployed executor global contract (scripts/deploy-confidential.mjs prints it) */
export const EXECUTOR_CODE_HASH = (process.env.EXECUTOR_CODE_HASH || '812af58d8779a100dbcf61c94d9155f93f32bd4b2ecb00255b48d50e71888d7e').trim().toLowerCase();
const RPC_CANDIDATES = [
  process.env.NEAR_RPC_URL,
  ...(process.env.RPC_PROVIDERS || '').split(',').map(s => s.trim()),
  'https://free.rpc.fastnear.com',
  'https://rpc.mainnet.near.org',
  'https://near.drpc.org',
  'https://rpc.intea.rs',
].filter((u): u is string => Boolean(u));
let activeRpcIndex = 0;
function getNextRpcUrl(): string {
  return RPC_CANDIDATES[activeRpcIndex % RPC_CANDIDATES.length] || 'https://free.rpc.fastnear.com';
}
const RPC_URL = getNextRpcUrl();
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
/** An unpaid deposit quote is past its deadline by then (1Click refunds late payments) */
const QUOTE_EXPIRY_HOURS = 48;
/** An open executor untouched this long with no tokens was fully sold and its close was lost */
const EMPTY_OPEN_AFTER_SEC = 600;
const TGAS = 1_000_000_000_000n;

export interface ConfidentialTradeResult {
  success: boolean;
  executors: string[];
  txHashes: string[];
  amountIn: string;
  fee?: string;
  /** Sells: NEAR the executors took in (yocto), after the platform sell fee they pay on exit */
  nearOut?: string;
  reason?: string;
}

// ── Controller ────────────────────────────────────────────────────────────────

interface SignerLane {
  key: string;
  account: Account | null;
  queue: Promise<unknown>;
  pending: number;
}

/**
 * The controller's signing keys: EXECUTOR_CONTROLLER_KEYS (`ed25519:...,ed25519:...`), else the single
 * EXECUTOR_CONTROLLER_PRIVATE_KEY / RELAYER_PRIVATE_KEY. Every key belongs to the controller account, so
 * any of them can drive any executor; several keys (each with its own nonce) let split and fleet buys
 * go out together.
 */
export function parseControllerKeys(spec: string | undefined, fallbackKey: string): string[] {
  const keys = (spec || '').split(',').map(k => k.trim()).filter(k => k.startsWith('ed25519:'));
  if (keys.length > 0) return keys;
  return fallbackKey.trim().startsWith('ed25519:') ? [fallbackKey.trim()] : [];
}

const signerLanes: SignerLane[] = parseControllerKeys(
  process.env.EXECUTOR_CONTROLLER_KEYS,
  process.env.EXECUTOR_CONTROLLER_PRIVATE_KEY || process.env.RELAYER_PRIVATE_KEY || '',
).map(key => ({ key, account: null, queue: Promise.resolve(), pending: 0 }));

/** Sign one transaction to `receiver` as the controller, with the least busy key (one nonce at a time per key) */
async function controllerTx(receiver: string, txActions: any[]): Promise<any> {
  if (signerLanes.length === 0) throw new Error('Executor controller key is not configured');
  const lane = signerLanes.reduce((best, l) => (l.pending < best.pending ? l : best));
  lane.pending++;
  const run = async () => {
    let lastErr: any = null;
    const maxAttempts = Math.min(RPC_CANDIDATES.length, 3);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const currentRpc = getNextRpcUrl();
      try {
        lane.account = new Account(EXECUTOR_CONTROLLER, new JsonRpcProvider({ url: currentRpc }), lane.key as any);
        const result = await lane.account.signAndSendTransaction({ receiverId: receiver, actions: txActions, throwOnFailure: false });
        const outcomeErr = failureOf(result);
        const errStr = JSON.stringify(result || '');
        if (errStr.includes('-429') || errStr.includes('Rate limits') || errStr.includes('timed out')) {
          logger.warn(`Controller RPC ${currentRpc} rate limited or timed out; rotating to next RPC candidate`);
          activeRpcIndex++;
          lastErr = outcomeErr || 'RPC rate limit';
          continue;
        }
        return result;
      } catch (err: any) {
        logger.warn(`Controller transaction on ${currentRpc} failed (${err?.message}); rotating RPC`);
        activeRpcIndex++;
        lastErr = err;
      }
    }
    throw lastErr || new Error('All RPC candidates failed for controller transaction');
  };
  const next = lane.queue.then(run, run).finally(() => { lane.pending--; });
  lane.queue = next.catch(() => undefined);
  return next;
}

/** Call an executor method with borsh-encoded arguments */
function callExecutor(executor: string, method: string, args: Uint8Array, gasTgas: number): Promise<any> {
  return controllerTx(executor, [actions.functionCall(method, args, BigInt(gasTgas) * TGAS, 0n)]);
}

const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u128le = (n: bigint) => { const b = Buffer.alloc(16); b.writeBigUInt64LE(n & ((1n << 64n) - 1n)); b.writeBigUInt64LE(n >> 64n, 8); return b; };
const borshStr = (v: string) => { const b = Buffer.from(v, 'utf8'); return Buffer.concat([u32le(b.length), b]); };
const borshBytes = (v: Buffer) => Buffer.concat([u32le(v.length), v]);

/**
 * Whether an executor's on-chain owner is this account: its owner_hash must equal sha256(salt + payout).
 * The database maps executors to users; this proves the mapping against the chain before NEAR moves,
 * so a mix-up can never send one user's executor to another user's private balance.
 */
export function ownsExecutor(state: { owner_hash?: string } | null, acct: Pick<ConfidentialAccountRecord, 'owner_salt' | 'payout_address'>): boolean {
  const onChain = String(state?.owner_hash || '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(onChain) && onChain === ownerHash(acct.owner_salt, acct.payout_address);
}

/** Borsh arguments of the executor's `new(controller, owner_hash)` */
export function executorInitArgs(controller: string, ownerHashHex: string): Uint8Array {
  return new Uint8Array(Buffer.concat([borshStr(controller), borshBytes(Buffer.from(ownerHashHex, 'hex'))]));
}

/** Borsh arguments of `exit_to_intents(deposit_address, amount)` */
export function exitToIntentsArgs(depositAddress: string, amount: bigint): Uint8Array {
  return new Uint8Array(Buffer.concat([borshStr(depositAddress), u128le(amount)]));
}

/** Borsh arguments of `exit_to_owner(to, salt)` */
export function exitToOwnerArgs(to: string, salt: string): Uint8Array {
  return new Uint8Array(Buffer.concat([borshStr(to), borshStr(salt)]));
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
/** A NEAR account a private balance can pay out to (named, 64-hex implicit, or 0x ETH-implicit) */
export function isNearPayoutAccount(id: string | null | undefined): boolean {
  return Boolean(id) && String(id).length <= 64 && /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/i.test(String(id))
    && (String(id).includes('.') || /^[0-9a-f]{64}$/i.test(String(id)) || /^0x[0-9a-f]{40}$/i.test(String(id)));
}

export async function ensureConfidentialAccount(user: UserRecord): Promise<ConfidentialAccountRecord> {
  const existing = await getConfidentialAccount(user.id);
  if (existing) {
    // An account made for a Solana sign-in before the user had a NEAR wallet pays out there instead
    if (!isNearPayoutAccount(existing.payout_address) && isNearPayoutAccount(user.subaccount_id)) {
      return (await repairConfidentialPayout(user.id, user.subaccount_id)) || existing;
    }
    return existing;
  }
  if (!MASTER_KEY) throw new Error('Encryption master key is not configured');
  let payout = isNearPayoutAccount(user.subaccount_id) ? user.subaccount_id : null;
  if (!payout) {
    const db = await import('@racerbot/db').then(m => m.getDb()).catch(() => null);
    if (db) {
      const nearWallet = await db.query(
        "SELECT address FROM user_wallets WHERE user_id = $1 AND chain = 'near' AND is_active = TRUE ORDER BY created_at DESC LIMIT 1",
        [user.id]
      ).catch(() => ({ rows: [] }));
      if (nearWallet.rows[0]?.address && isNearPayoutAccount(nearWallet.rows[0].address)) {
        payout = nearWallet.rows[0].address;
      }
    }
  }
  if (!payout) {
    try {
      const { createWebManagedWallet } = await import('./webWallet.js');
      const managed = await createWebManagedWallet(user.id);
      if (managed?.address && isNearPayoutAccount(managed.address)) {
        payout = managed.address;
      }
    } catch {}
  }
  if (!payout) throw new Error('Private trading needs a NEAR account to pay out to');
  const keys = generatePrivateAccount();
  return createConfidentialAccount({
    user_id: user.id,
    private_account_id: keys.accountId,
    public_key: keys.publicKey,
    secret_key_encrypted: encrypt(keys.secretKey, MASTER_KEY),
    payout_address: payout,
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
  const executor = `${name}.${EXECUTOR_CONTROLLER}`;
  await insertExecutor({ account_id: executor, user_id: acct.user_id, size_yocto: size.toString() });
  try {
    if (!/^[0-9a-f]{64}$/.test(EXECUTOR_CODE_HASH)) throw new Error('EXECUTOR_CODE_HASH is not set to the deployed executor code hash');
    // One transaction, all or nothing: the subaccount, its deposit, the shared executor code, and its owner
    const created = await controllerTx(executor, [
      actions.createAccount(),
      actions.transfer(CREATION_DEPOSIT),
      actions.useGlobalContract({ codeHash: EXECUTOR_CODE_HASH }),
      actions.functionCall('new', executorInitArgs(EXECUTOR_CONTROLLER, ownerHash(acct.owner_salt, acct.payout_address)), 10n * TGAS, 0n),
    ]);
    const createErr = failureOf(created);
    if (createErr) throw new Error(`create executor: ${createErr}`);
    // Fund only an executor the chain says belongs to this user
    const createdState = await getNear().view<any>(executor, 'get_state', {});
    if (!ownsExecutor(createdState, acct)) throw new Error('owner mismatch after create: not funded');
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
    void closeExecutor(executor).catch(closeErr => logger.warn(`Immediate cleanup of ${executor} failed: ${closeErr?.message}`));
  }
}

const refilling = new Set<string>();

/** Top the ready pool back up to the user's settings, within their private balance and cap */
export async function refillPool(acct: ConfidentialAccountRecord, options: { manual?: boolean } = {}): Promise<number> {
  const isManual = options.manual === true;
  if (!EXECUTORS_ENABLED || !acct.enabled || (!isManual && !acct.auto_refill) || refilling.has(acct.user_id)) return 0;
  refilling.add(acct.user_id);
  try {
    if (!isManual) {
      // Circuit breaker: do not auto-refill in background if user experienced any failure in the last 15 minutes
      const recentFailed = await listUserExecutors(acct.user_id, ['failed']);
      const now = Date.now();
      const hasRecentFailure = recentFailed.some(e => e.updated_at && (now - new Date(e.updated_at).getTime()) < 15 * 60_000);
      if (hasRecentFailure) {
        return 0;
      }
    }

    // Circuit breaker: do not spawn executors if controller balance is critically low (< 0.05 NEAR)
    const ctrlBal = await getNear().getNearBalance(EXECUTOR_CONTROLLER).catch(() => null);
    if (ctrlBal && BigInt(ctrlBal) < 50_000_000_000_000_000_000_000n) {
      logger.warn('Controller ' + EXECUTOR_CONTROLLER + ' balance is critically low (< 0.05 NEAR); pausing executor pool refills');
      return 0;
    }

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
    if (available === 0n) {
      const moves = await listUserConfidentialMoves(acct.user_id, 50);
      let ledger = 0n;
      for (const m of moves) {
        if (m.status !== 'SUCCESS') continue;
        const amt = BigInt(m.amount || '0');
        if (m.kind === 'deposit' || m.kind === 'return') ledger += amt;
        else if (m.kind === 'withdraw' || m.kind === 'refill' || m.kind === 'copy_fee') ledger -= amt;
      }
      const settledRefills = new Set(
        moves.filter(m => m.status === 'SUCCESS' && m.kind === 'refill' && m.executor_account_id).map(m => m.executor_account_id)
      );
      const inFlight = live
        .filter(e => !settledRefills.has(e.account_id))
        .reduce((sum, e) => sum + BigInt(e.size_yocto || '0'), 0n);
      if (ledger > inFlight) available = ledger - inFlight;
    }
    const toCreate: bigint[] = [];
    for (const raw of missing) {
      const size = BigInt(raw);
      if (size < MIN_EXECUTOR_SIZE || committed + size > cap || size > available) continue;
      toCreate.push(size);
      committed += size;
      available -= size;
    }
    // Each spawn waits on the controller queue for its create, then funds in parallel
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
    // Sells go through the token's own contract (position-executor build_sell)
    case 'Shardsmarket': venue = 'Shardsmarket'; break;
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
      // The executor contract only sends to these launchpads; anything else (a pre-bonding auction) is refused
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
    if (fit) return [fit];
    // If no single executor is large enough, fall back to split across ready executors
    const picked: bigint[] = [];
    let left = amount;
    for (const s of [...sizes].reverse()) {
      if (left <= 0n) break;
      picked.push(s);
      left -= s;
    }
    return left <= 0n ? picked : null;
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
  const guard = await withInFlightGuard(`conf:${p.user.id}:${p.tokenAddress}:buy`, () => confidentialBuyLocked(p, fail));
  return guard.ran ? guard.result : fail('A private buy of this token is already running. Wait for it to finish.');
}

async function confidentialBuyLocked(p: Parameters<typeof confidentialBuy>[0], fail: (reason: string) => ConfidentialTradeResult): Promise<ConfidentialTradeResult> {
  const acct = await ensureConfidentialAccount(p.user);
  if (!acct.enabled) return fail('Confidential mode is switched off for this account');

  const ready = await listUserExecutors(acct.user_id, ['ready']);
  const sizes = chooseSizes(ready, p.amountYocto, acct.buy_mode);
  if (!sizes) {
    const totalReady = ready.reduce((s, e) => s + BigInt(e.size_yocto || '0'), 0n);
    void refillPool(acct).catch(() => undefined);
    if (p.amountYocto > totalReady) {
      const readyNear = (Number(totalReady) / 1e24).toFixed(2);
      const wantNear = (Number(p.amountYocto) / 1e24).toFixed(2);
      return fail(`No ready executor covers ${wantNear} Ⓝ (ready balance: ${readyNear} Ⓝ). Try ${readyNear} Ⓝ or lower, or wait for pool refilling.`);
    }
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
      const outcome = await callExecutor(e.account_id, 'buy', new Uint8Array(Buffer.concat([encodeExecPlan(plan), u32le(BUY_FEE_BPS)])), 300);
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
  if (ok.length) racerRankCheck(p.user.id);
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
  // A second sell of the same executors would sell twice the share asked for
  const guard = await withInFlightGuard(`conf:${p.user.id}:${p.tokenAddress}:sell`, () => confidentialSellLocked(p, fail));
  return guard.ran ? guard.result : fail('A private sell of this token is already running. Wait for it to finish.');
}

async function confidentialSellLocked(p: Parameters<typeof confidentialSell>[0], fail: (reason: string) => ConfidentialTradeResult): Promise<ConfidentialTradeResult> {
  const acct = await getConfidentialAccount(p.user.id);
  if (!acct) return fail('No confidential positions');
  const holding = (await listUserExecutors(acct.user_id, ['open'])).filter(e => e.token === p.tokenAddress);
  if (holding.length === 0) return fail('No confidential position in this token');
  const pct = Math.min(100, Math.max(1, Math.round(p.percent)));
  const near = getNear();
  let total = 0n;
  let nearOut = 0n;

  const results = await Promise.all(holding.map(async (e) => {
    try {
      const balance = BigInt(await near.getTokenBalance(p.tokenAddress, e.account_id));
      const amountIn = pct === 100 ? balance : (balance * BigInt(pct)) / 100n;
      if (amountIn <= 0n) return { ok: false, executor: e.account_id, reason: 'Nothing to sell' };
      total += amountIn;
      const valueBefore = await executorNearValue(e.account_id).catch(() => null);
      const plan = await buildPlan({
        tokenAddress: p.tokenAddress, venue: p.venue, isBuy: false, amountIn, swapAmount: amountIn,
        slippagePct: p.slippagePct ?? 2, poolId: p.poolId, dclPoolId: p.dclPoolId, correlationId: e.position_group || e.account_id,
      });
      const outcome = await callExecutor(e.account_id, 'sell', new Uint8Array(encodeExecPlan(plan)), 300);
      const sold = extractExecutorEvents(outcome).find(ev => ev.event === 'sold');
      await updateExecutor(e.account_id, { event: sold ?? { event: 'sell_failed' }, tx_hash: outcome?.transaction?.hash });
      if (!sold) return { ok: false, executor: e.account_id, hash: outcome?.transaction?.hash, reason: failureOf(outcome) || 'The exchange rejected the sell' };
      // Measured before a close can move the NEAR on; the exit fee is taken from it later
      const valueAfter = valueBefore === null ? null : await executorNearValue(e.account_id).catch(() => null);
      if (valueBefore !== null && valueAfter !== null && valueAfter > valueBefore) {
        nearOut += ((valueAfter - valueBefore) * BigInt(10_000 - SELL_FEE_BPS)) / 10_000n;
      }
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
    nearOut: nearOut.toString(),
    reason: ok.length === results.length ? undefined : results.find(r => !r.ok)?.reason,
  };
}

/** NEAR an executor holds for its owner: free native NEAR plus wNEAR (as the exit fee measures it) */
async function executorNearValue(executor: string): Promise<bigint> {
  const near = getNear();
  const [state, wnear] = await Promise.all([
    near.view<any>(executor, 'get_state', {}),
    near.getTokenBalance('wrap.near', executor),
  ]);
  return BigInt(state?.native_available || 0) + BigInt(wnear || '0');
}

/**
 * Pays an amount from the user's private balance to a NEAR account (a creator's copy profit
 * share). Throws when the private balance does not cover it yet, so the caller can retry later,
 * e.g. once a sold executor has returned its NEAR.
 */
export async function payFromPrivateBalance(userId: string, amount: bigint, destination: string): Promise<{ intentHash: string }> {
  const acct = await getConfidentialAccount(userId);
  if (!acct) throw new Error('No private balance');
  const have = await privateBalance(acct);
  if (have < amount) throw new Error('The private balance does not cover it yet');
  const move = await unshield(keysOf(acct), amount, destination);
  await insertConfidentialMove({
    user_id: userId, kind: 'copy_fee', deposit_address: move.depositAddress, amount: amount.toString(),
    destination, intent_hash: move.intentHash,
  });
  return { intentHash: move.intentHash };
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
  const [rawBalance, executors, moves] = await Promise.all([
    privateBalance(acct).catch((err) => { logger.warn(`Failed reading private balance for ${acct.user_id}: ${err?.message}`); return null; }),
    listUserExecutors(acct.user_id, ['creating', 'funding', 'ready', 'claimed', 'open', 'exiting', 'exited', 'failed']),
    listUserConfidentialMoves(acct.user_id, 50),
  ]);

  let balance = rawBalance;
  let ledger = 0n;
  for (const m of moves) {
    if (m.status !== 'SUCCESS' && !(m.kind === 'withdraw' && (m.status === 'PENDING_DEPOSIT' || m.status === 'SUCCESS'))) continue;
    const amt = BigInt(m.amount || '0');
    if (m.kind === 'deposit' || m.kind === 'return') {
      ledger += amt;
    } else if (m.kind === 'withdraw' || m.kind === 'refill' || m.kind === 'copy_fee') {
      ledger -= amt;
    }
  }
  const settledRefillExecutors = new Set(
    moves.filter(m => m.status === 'SUCCESS' && m.kind === 'refill' && m.executor_account_id).map(m => m.executor_account_id)
  );
  const inFlightUnsettled = executors
    .filter(e => ['creating', 'funding'].includes(e.status) && !settledRefillExecutors.has(e.account_id))
    .reduce((sum, e) => sum + BigInt(e.size_yocto || '0'), 0n);
  const ledgerAvailable = ledger > inFlightUnsettled ? ledger - inFlightUnsettled : 0n;

  if (balance === null) {
    if (ledgerAvailable > 0n) {
      balance = ledgerAvailable;
      logger.info(`Resolved fallback private balance from ledger moves for ${acct.user_id}: ${balance.toString()} yocto`);
    } else {
      balance = 0n;
    }
  }

  if (EXECUTORS_ENABLED && acct.enabled && acct.auto_refill && balance > 0n) {
    const readyOrCreating = executors.filter(e => ['creating', 'funding', 'ready'].includes(e.status));
    if (readyOrCreating.length < acct.pool_sizes.length) {
      void refillPool(acct).catch(err => logger.warn(`Overview pool refill for ${acct.user_id}: ${err?.message}`));
    }
  }
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
  if (!ownsExecutor(state, acct)) {
    logger.error(`Executor ${executor} is recorded for user ${userId} but its on-chain owner differs: exit refused`);
    await updateExecutor(executor, { last_error: 'owner mismatch: exit refused, needs review' });
    return;
  }
  await updateExecutor(executor, { status: 'exiting' });

  const fee = await exitFeeBps(executor, state);
  const prepared = await callExecutor(executor, 'prepare_exit', new Uint8Array(u32le(fee)), 150);
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
  let sent: any = null;
  let quote: MoveQuote | null = null;

  try {
    quote = await quoteShield(acct.private_account_id, send, executor);
    sent = await callExecutor(executor, 'exit_to_intents', exitToIntentsArgs(quote.depositAddress, send), 150);
  } catch (intentErr: any) {
    logger.warn(`exit_to_intents quote retry for ${executor} (${intentErr?.message})`);
    try {
      await new Promise(r => setTimeout(r, 1000));
      quote = await quoteShield(acct.private_account_id, send, executor);
      sent = await callExecutor(executor, 'exit_to_intents', exitToIntentsArgs(quote.depositAddress, send), 150);
    } catch (retryErr: any) {
      logger.error(`Shield to inner intent wallet ${acct.private_account_id} failed: ${retryErr?.message}`);
      // Do NOT fall back to exit_to_owner because that leaks the user's wallet publicly on-chain.
      // Leave in 'exiting' state so the worker retry loop delivers the wNEAR directly to the inner intent wallet.
      await updateExecutor(executor, { last_error: `Shield to inner intent failed: ${retryErr?.message}` });
      return;
    }
  }

  const events = extractExecutorEvents(sent);
  const exited = events.find(ev => ev.event === 'exited');
  const partial = events.find(ev => ev.event === 'exit_partial');
  const txHash = sent?.transaction?.hash;

  if (quote) {
    await insertConfidentialMove({
      user_id: userId, kind: 'return', executor_account_id: executor, deposit_address: quote.depositAddress,
      amount: send.toString(), destination: acct.private_account_id, tx_hash: txHash,
    });
    if (txHash) void notifyDeposit(quote.depositAddress, txHash);
  }

  await updateExecutor(executor, {
    status: exited ? 'exited' : 'exiting',
    returned_amount: send.toString(),
    event: exited ?? partial ?? { event: 'exit_failed' },
    tx_hash: txHash,
    last_error: exited || partial ? null : failureOf(sent) || 'exit failed',
  });
  // The sell's NEAR is known once the executor exits
  if (exited) racerRankCheck(userId);
}

/** NEAR Racer Card: confidential trades count toward the lifetime rank too. */
function racerRankCheck(userId: string): void {
  void import('./racerCard.js').then(m => m.scheduleRankUpCheck(userId)).catch(() => undefined);
}

const ROUND_STEP = ONE_NEAR / 10n;

/** The first part of a rounded return: whole 0.1 NEAR steps (amounts under 0.2 NEAR go in one piece) */
export function roundedReturn(amount: bigint): bigint {
  if (amount < 2n * ROUND_STEP) return amount;
  return amount - (amount % ROUND_STEP);
}

/** Delete an exited executor once its close delay has passed (anyone may call finish_close) */
async function finishClose(e: ConfidentialExecutorRecord): Promise<void> {
  const outcome = await callExecutor(e.account_id, 'finish_close', new Uint8Array(0), 150);
  const closed = extractExecutorEvents(outcome).find(ev => ev.event === 'closed');
  await updateExecutor(e.account_id, closed
    ? { status: 'closed', event: closed, tx_hash: outcome?.transaction?.hash, last_error: null }
    : { last_error: failureOf(outcome) || 'close not ready', tx_hash: outcome?.transaction?.hash });
}

// ── Private balance in and out ────────────────────────────────────────────────

/** Deposit address registration, storage the wallet must keep, and gas, on top of the deposit itself */
const DEPOSIT_OVERHEAD = 20_000_000_000_000_000_000_000n; // 0.02 NEAR

/** The RacerBot wallet cannot cover a deposit; `code` lets the page offer the connected wallet instead */
export class WalletNeedsNearError extends Error {
  readonly code = 'wallet_needs_near';
}

/** Deposit NEAR from the user's RacerBot wallet into their private balance (~19 s to settle) */
export async function depositFromWallet(user: UserRecord, amount: bigint): Promise<{ depositAddress: string; txHash: string }> {
  if (isExternalWallet(user)) throw new Error('Approve the deposit in your wallet');
  const near = getNear();
  // Check before quoting or signing, so a short balance gets a plain answer instead of an RPC error
  const have = BigInt((await near.getNearBalance(user.subaccount_id, 0).catch(() => '0')) || '0');
  const need = amount + DEPOSIT_OVERHEAD;
  if (have < need) {
    const fmt = (y: bigint) => (Number(y / 10n ** 18n) / 1e6).toFixed(4);
    throw new WalletNeedsNearError(have === 0n
      ? `Your RacerBot wallet (${user.subaccount_id}) has no NEAR yet. Send NEAR to it first, then deposit.`
      : `Your RacerBot wallet has ${fmt(have)} NEAR; this deposit needs ${fmt(need)} NEAR (the amount plus about 0.02 NEAR for fees). Add NEAR or deposit less.`);
  }
  const acct = await ensureConfidentialAccount(user);
  const quote = await quoteShield(acct.private_account_id, amount, user.subaccount_id);
  const txHash = await payDepositAddressFromWallet(user, amount, quote.depositAddress, 'Deposit');
  await insertConfidentialMove({ user_id: user.id, kind: 'deposit', deposit_address: quote.depositAddress, amount: amount.toString(), destination: acct.private_account_id, tx_hash: txHash });
  void notifyDeposit(quote.depositAddress, txHash);
  return { depositAddress: quote.depositAddress, txHash };
}

/**
 * Pay a 1Click deposit address `amount` wNEAR from the user's RacerBot wallet: wrap, register the
 * one-time address, send, in one transaction to wrap.near. Returns the transaction hash.
 */
export async function payDepositAddressFromWallet(user: UserRecord, amount: bigint, depositAddress: string, what: string): Promise<string> {
  const near = getNear();
  await near.addKey(user.subaccount_id, KeyPair.fromString(decrypt(user.scoped_key_encrypted, MASTER_KEY) as any));
  const outcome = await near.signAndSendTransactionAll(user.subaccount_id, 'wrap.near', [
    transactions.functionCall('near_deposit', {}, 10n * TGAS, amount),
    transactions.functionCall('storage_deposit', { account_id: depositAddress, registration_only: true }, 10n * TGAS, 1_250_000_000_000_000_000_000n),
    transactions.functionCall('ft_transfer', { receiver_id: depositAddress, amount: amount.toString() }, 15n * TGAS, 1n),
  ]);
  const err = failureOf(outcome);
  if (err) throw new Error(`${what} failed: ${err}`);
  return outcome.transaction.hash;
}

/**
 * The RacerBot wallet must hold `amount` plus about 0.02 NEAR for fees before anything is quoted or
 * signed, so a short balance gets a plain answer instead of an RPC error.
 */
export async function assertWalletCovers(user: UserRecord, amount: bigint, what: string): Promise<void> {
  const have = BigInt((await getNear().getNearBalance(user.subaccount_id, 0).catch(() => '0')) || '0');
  const need = amount + DEPOSIT_OVERHEAD;
  if (have >= need) return;
  const fmt = (y: bigint) => (Number(y / 10n ** 18n) / 1e6).toFixed(4);
  throw new WalletNeedsNearError(have === 0n
    ? `Your RacerBot wallet (${user.subaccount_id}) has no NEAR yet. Send NEAR to it first.`
    : `Your RacerBot wallet has ${fmt(have)} NEAR; this ${what} needs ${fmt(need)} NEAR (the amount plus about 0.02 NEAR for fees).`);
}

/** Signed in with their own NEAR wallet: RacerBot holds no key for it, so the user signs deposits themselves */
export const isExternalWallet = (user: UserRecord): boolean => !hasManagedWallet(user);

export interface WalletDeposit {
  depositAddress: string;
  amount: string;
  /** One transaction to wrap.near for the user's wallet to sign: wrap, register the address, send */
  transaction: { receiverId: string; actions: { methodName: string; args: object; gas: string; deposit: string }[] };
}

/**
 * Deposit from the user's connected NEAR wallet into their private balance: RacerBot quotes, that wallet
 * signs. `fromAccount` is the wallet that pays, so a refund (an expired or unsettled quote) goes back to
 * it, never to a different wallet the user did not pay from.
 */
export async function quoteWalletDeposit(user: UserRecord, amount: bigint, fromAccount: string): Promise<WalletDeposit> {
  if (!isNearPayoutAccount(fromAccount)) throw new Error('Connect the NEAR wallet you are paying from.');
  const acct = await ensureConfidentialAccount(user);
  const quote = await quoteShield(acct.private_account_id, amount, fromAccount);
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
/**
 * Send `amount` of the private balance to a NEAR account, or, with `destinationAsset` (a 1Click asset
 * on another chain), to `destination` on that chain as that asset.
 */
export async function withdrawPrivate(user: UserRecord, amount: bigint, destination?: string, destinationAsset?: string): Promise<{ depositAddress: string; intentHash: string; amountOut?: string }> {
  const acct = await getConfidentialAccount(user.id);
  if (!acct) throw new Error('No private balance');
  if (destinationAsset && !destination) throw new Error('Enter the address to send to');
  const to = destination || acct.payout_address;
  const have = await getPrivateNearBalance(keysOf(acct)).catch(() => null);
  if (have !== null && have < amount) {
    throw new Error(`Your private balance holds ${(Number(have / 10n ** 18n) / 1e6).toFixed(4)} NEAR, less than this withdrawal.`);
  }
  const move = await unshield(keysOf(acct), amount, to, destinationAsset);
  await insertConfidentialMove({
    user_id: user.id,
    kind: 'withdraw',
    deposit_address: move.depositAddress,
    amount: amount.toString(),
    destination: to,
    intent_hash: move.intentHash,
    status: 'SUCCESS',
  });
  return { depositAddress: move.depositAddress, intentHash: move.intentHash, amountOut: move.amountOut };
}

// ── Background worker ─────────────────────────────────────────────────────────

/**
 * After a full sell the close is scheduled in memory; a restart in between
 * leaves an open executor holding no tokens and the sale's NEAR. Close those so
 * the NEAR goes back to the private balance. A balance lookup that fails is
 * skipped, never read as empty.
 */
async function closeEmptyOpenExecutors(limit = 10): Promise<number> {
  const near = getNear();
  const open = await listExecutorsByStatus(['open'], EMPTY_OPEN_AFTER_SEC, limit);
  let closed = 0;
  for (const e of open) {
    if (!e.token) continue;
    const raw = await near.getTokenBalance(e.token, e.account_id).catch(() => null);
    if (raw === null || raw === undefined || BigInt(String(raw).split('.')[0] || '0') !== 0n) continue;
    logger.warn(`Executor ${e.account_id} is open with no ${e.token} left; closing it`);
    await closeExecutor(e.account_id).catch(err => logger.warn(`close empty ${e.account_id}: ${err?.message}`));
    closed++;
  }
  // The rest still hold tokens: check others first next time
  await touchExecutors(open.map(e => e.account_id)).catch(() => undefined);
  return closed;
}

async function workerTick(): Promise<void> {
  // 0. Quotes nobody paid would otherwise wait forever in front of real moves
  const expired = await expireStaleConfidentialQuotes(QUOTE_EXPIRY_HOURS).catch(() => 0);
  if (expired) logger.info(`Expired ${expired} unpaid private-balance deposit quote(s)`);

  // 1. Settle private-balance moves; a funded executor becomes ready
  const moves = await listOpenConfidentialMoves(50);
  for (const m of moves) {
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
      if (acct) void refillPool(acct, { manual: true }).catch(err => logger.warn(`Refill after ${m.kind}: ${err?.message}`));
    }
  }
  // Moves that did not change go to the back of the queue
  await markConfidentialMovesChecked(moves.map(m => m.id)).catch(() => undefined);

  // 1b. Check if any funding executors already have on-chain balance delivered
  const fundingExecutors = await listExecutorsByStatus(['funding'], 0, 20).catch(() => []);
  for (const fe of fundingExecutors) {
    try {
      const state = await getNear().view<any>(fe.account_id, 'get_state', {});
      const avail = BigInt(state?.native_available || '0');
      if (avail >= (BigInt(fe.size_yocto || '0') * 95n) / 100n) {
        logger.info(`Executor ${fe.account_id} funded on-chain (${avail} yocto); setting ready`);
        await updateExecutor(fe.account_id, { status: 'ready' });
      }
    } catch {
      // not funded yet or transient RPC error
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
  // 5. Fully sold positions whose close was lost to a restart
  await closeEmptyOpenExecutors();

  // 6. Automatically refill pools for enabled accounts
  if (EXECUTORS_ENABLED) {
    const activeAccts = await listActiveConfidentialAccounts(10).catch(() => []);
    for (const a of activeAccts) {
      void refillPool(a).catch(err => logger.warn(`Worker pool refill for ${a.user_id}: ${err?.message}`));
    }
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

export { chooseSizes as _chooseSizesForTest, intearHopsFromMessage as _intearHopsForTest, workerTick as _workerTickForTest };
