import 'dotenv/config';
import {
  getNear,
  clearAccessKeyCache,
  withAccountLock,
  createRedis,
  CHANNELS,
  decrypt,
  computePnL,
  formatHoldDuration,
  calculateMinOutAdj,
  calculateMinAmountOut,
  NEAR_USDC_CONTRACT,
  NEAR_USDC_DECIMALS,
  NEAR_USDC_REF_POOL_ID,
  parseMemeCookingId,
  getNearUsdPrice,
  getSuiUsdPrice,
  getSuiBalance,
  getSuiTokenSupply,
  checkTokenSafety,
  publishActivityEvent,
  isSolanaToken,
  getSolanaBalance,
  getSolanaTokenInfo,
  solToLamports,
  lamportsToSol,
  SOL_MINT,
  SOLANA_MIN_RESERVE_LAMPORTS,
  type SwapEvent,
  type AutoBuySignal,
  type NotifyUserEvent,
  type BuyAlertEvent,
  type RedisClient,
  type MultiRpcNear,
  intearRegisteredCache,
  distributeTradeFeeRewards,
} from '@racerbot/shared';

export { calculateMinOutAdj };

import {
  getDb,
  getUserById,
  createFill,
  getOpenPositions,
  getPositionById,
  getFillsByPosition,
  createPosition,
  getTokenCache,
  recordFee,
  recordTradeAttempt,
  updateTradeAttempt,
  getReferralByReferredUser,
  activateReferral,
  addReferralReward,
  getTokenReferral,
  addTokenReferralReward,
  awardPointsForTradeFill,
  markSnipeTriggerFilled,
  markSnipeTriggerFailed,
  markSnipeOrderResult,
  getActiveWallet,
  syncUserActiveWallet,
} from '@racerbot/db';
import { KeyPair, transactions, utils } from 'near-api-js';
import { isTradableVenue, TradeError, isValidEvmAddress } from '@racerbot/shared';
import { PARENT_ACCOUNT, TREASURY_ACCOUNT_ID, MAIN_WALLET_PRIVATE_KEY } from './config.js';
import { determineSwapOutcome } from './tradeResult.js';

import { executeSuiSwap } from './suiExecutor.js';
import { executeStarknetSwap } from './starknetExecutor.js';
import { executeSolanaSwap } from './solanaExecutor.js';
import { executeEvmSwap } from './evmExecutor.js';

// ── Gas limits for swaps ──────────────────────────────────────────────────────
// ft_transfer_call splits prepaid gas across multiple contracts: the token contract
// reserves ~35-45 Tgas for ft_resolve_transfer callback, leaving the remainder for
// the DEX (e.g. Ref DCL). Multi-hop swaps (e.g. token -> QTC -> wNEAR) burn ~25 Tgas
// and must attach 30+ Tgas to downstream ft_transfer calls. 180 Tgas ensures all hops
// and cross-contract promises complete without exceeding prepaid gas.
export const DEFAULT_SWAP_GAS = BigInt('180000000000000'); // 180 Tgas
export const DEFAULT_TRANSFER_GAS = BigInt('10000000000000'); // 10 Tgas
export const DEFAULT_WRAP_DEPOSIT_GAS = BigInt('10000000000000'); // 10 Tgas

const MASTER_KEY = process.env.KEY_ENCRYPTION_MASTER_KEY!;
const REDIS_URL = process.env.REDIS_URL!;
const RPC_URLS = (process.env.RPC_PROVIDERS ?? '')
  .split(',')
  .map(u => u.trim())
  .filter(Boolean); // getNear() falls back to DEFAULT_RPC_URLS when empty

// ── Warm key store ────────────────────────────────────────────────────────────
// Pre-loaded on startup from encrypted DB records — no DB query in hot path

const warmKeys = new Map<string, { keyPair: KeyPair; subaccountId: string }>();


// ── Services ─────────────────────────────────────────────────────────────────

const near = getNear(RPC_URLS);
const redis = createRedis(REDIS_URL);

// ── Key pre-warming ────────────────────────────────────────────────────────────

/** Load ALL user scoped keys into memory at startup. */
export async function warmAllKeys(): Promise<void> {
  const db = await getDb();
  const result = await db.query('SELECT id, subaccount_id, scoped_key_encrypted FROM users');
  let loaded = 0;

  for (const row of result.rows) {
    try {
      const keyStr = decrypt(row.scoped_key_encrypted, MASTER_KEY);
      const keyPair = KeyPair.fromString(keyStr as any);
      warmKeys.set(row.id, { keyPair, subaccountId: row.subaccount_id });
      await near.addKey(row.subaccount_id, keyPair);
      loaded++;
    } catch (err) {
      console.error(`[EXECUTOR] Failed to warm key for user ${row.id}:`, (err as Error).message);
    }
  }
  if (result.rows.length > 0 && loaded === 0) {
    console.error(`[EXECUTOR] 🚨 CRITICAL: 0 of ${result.rows.length} user keys could be decrypted! KEY_ENCRYPTION_MASTER_KEY is likely incorrect or mismatched with the database.`);
  } else {
    console.log(`[EXECUTOR] Pre-warmed ${loaded} user keys`);
  }
  if (PARENT_ACCOUNT && MAIN_WALLET_PRIVATE_KEY) {
    try {
      const parentKp = KeyPair.fromString(MAIN_WALLET_PRIVATE_KEY as any);
      await near.addKey(PARENT_ACCOUNT, parentKp);
      console.log(`[EXECUTOR] Pre-warmed parent account key for ${PARENT_ACCOUNT}`);
    } catch (err: any) {
      console.warn(`[EXECUTOR] Could not warm parent account key: ${err?.message}`);
    }
  }
}

/** Pre-warm storage deposit on NEAR for all tokens with active snipe orders. */
export async function preWarmActiveSnipeStorage(): Promise<void> {
  try {
    const db = await getDb();
    const rows = await db.query(
      `SELECT DISTINCT s.token_address, u.subaccount_id 
       FROM snipe_orders s 
       JOIN users u ON s.user_id = u.id 
       WHERE s.snipe_type = 'token' AND s.status = 'active' AND s.token_address IS NOT NULL`
    );
    for (const row of rows.rows) {
      if (row.token_address && row.subaccount_id) {
        near.ensureStorageDeposit(row.subaccount_id, row.token_address).catch((err: any) => {
          console.warn(`[EXECUTOR] Pre-warm storage for ${row.token_address} (${row.subaccount_id}):`, err?.message);
        });
      }
    }
  } catch (err) {
    console.warn('[EXECUTOR] preWarmActiveSnipeStorage warning:', (err as Error).message);
  }
}

/** Add a newly onboarded user's key to the warm store without restart. */
export async function addUserKey(userId: string, subaccountId: string, encryptedKey: string): Promise<void> {
  let keyStr: string;
  try {
    keyStr = decrypt(encryptedKey, MASTER_KEY);
  } catch (err: any) {
    throw new Error('Wallet trading key authentication failed. Please run /rotatekey to refresh your trading key.');
  }
  const keyPair = KeyPair.fromString(keyStr as any);
  warmKeys.set(userId, { keyPair, subaccountId });
  await near.addKey(subaccountId, keyPair);
}

// ── Ref Finance Storage & Token Whitelist Registration Cache ──────────────────
//
// Per-ACCOUNT and per-TOKEN confirmation sets. The old code used one global
// boolean for storage (the first account to trade marked Ref storage "checked"
// for the whole process — every later user skipped the check and could be
// refunded by Ref) and cached token registration even when register_tokens
// failed. An id lands in a set only after the on-chain state proves it.
export class RefRegistrationTracker {
  private readonly storageConfirmedAccounts = new Set<string>();
  private readonly confirmedTokens = new Set<string>();

  isStorageConfirmed(accountId: string): boolean {
    return this.storageConfirmedAccounts.has(accountId);
  }
  confirmStorage(accountId: string): void {
    this.storageConfirmedAccounts.add(accountId);
  }

  isTokenConfirmed(tokenAddress: string): boolean {
    return this.confirmedTokens.has(tokenAddress);
  }
  confirmToken(tokenAddress: string): void {
    this.confirmedTokens.add(tokenAddress);
  }
}

export const refTracker = new RefRegistrationTracker();

/**
 * Ensure the account has storage deposited on Ref Finance (v2.ref-finance.near).
 * Ref requires a storage deposit to track internal balances; an unregistered
 * account's swap succeeds on-chain but is REFUNDED — silent failure.
 *
 * - Per-account: every distinct account is checked/registered once.
 * - Deposit amount: real storage_balance_bounds minimum from the contract,
 *   falling back to 0.1 NEAR only when the view call fails.
 * - On deposit failure: throws with a plain user-actionable message. The
 *   failure is never cached as success.
 */
export async function ensureRefStorage(accountId?: string): Promise<void> {
  if (!accountId) return;
  if (refTracker.isStorageConfirmed(accountId)) return;

  const hasKey = await near.hasKey(accountId);
  if (!hasKey) return;

  const storage = await near.view<any>('v2.ref-finance.near', 'storage_balance_of', { account_id: accountId }).catch(() => null);
  if (storage && storage.total && storage.total !== '0') {
    refTracker.confirmStorage(accountId);
    return;
  }

  // Read the real minimum deposit from the contract; fall back to 0.1 NEAR.
  const FALLBACK_DEPOSIT_YOCTO = BigInt('100000000000000000000000');
  const bounds = await near.view<any>('v2.ref-finance.near', 'storage_balance_bounds', {}).catch(() => null);
  let deposit = FALLBACK_DEPOSIT_YOCTO;
  if (bounds?.min && BigInt(bounds.min) > 0n) {
    deposit = BigInt(bounds.min);
  }
  const depositNear = (Number(deposit) / 1e24).toFixed(2);

  console.log(`[EXECUTOR] Account ${accountId} not registered on Ref Finance. Performing storage_deposit (${depositNear} NEAR)...`);
  clearAccessKeyCache(accountId);

  const attemptRefDeposit = async (windowMs: number): Promise<'ok' | 'already' | 'never_seen' | Error> => {
    try {
      await near.signAndSendTransactionAll(accountId, 'v2.ref-finance.near', [
        transactions.functionCall(
          'storage_deposit',
          { account_id: accountId, registration_only: false },
          BigInt('30000000000000'),
          deposit
        ),
      ], windowMs);
      return 'ok';
    } catch (err: any) {
      const msg = (err?.message ?? String(err)).toLowerCase();
      if (msg.includes('already registered') || msg.includes('storage already deposited')) return 'already';
      if (err?.neverSeen) return 'never_seen';
      return err instanceof Error ? err : new Error(String(err));
    }
  };

  let result = await attemptRefDeposit(45_000);

  if (result === 'ok' || result === 'already') {
    clearAccessKeyCache(accountId);
    refTracker.confirmStorage(accountId);
    return;
  }

  if (result === 'never_seen') {
    // tx may have landed after our polling window — re-read chain state before giving up
    console.warn(`[EXECUTOR] Ref storage_deposit neverSeen for ${accountId} — re-reading chain state`);
    await new Promise(r => setTimeout(r, 2_000));
    const recheck = await near.view<any>('v2.ref-finance.near', 'storage_balance_of', { account_id: accountId }).catch(() => null);
    if (recheck && recheck.total && recheck.total !== '0') {
      refTracker.confirmStorage(accountId);
      return;
    }
    // Still not registered — retry with fresh 45s window
    result = await attemptRefDeposit(45_000);
    if (result === 'ok' || result === 'already') {
      refTracker.confirmStorage(accountId);
      return;
    }
    if (result === 'never_seen') {
      await new Promise(r => setTimeout(r, 2_000));
      const finalCheck = await near.view<any>('v2.ref-finance.near', 'storage_balance_of', { account_id: accountId }).catch(() => null);
      if (finalCheck && finalCheck.total && finalCheck.total !== '0') {
        refTracker.confirmStorage(accountId);
        return;
      }
      throw new Error(`Could not register your wallet on Ref Finance — NEAR network is congested. Please retry in a moment.`);
    }
  }

  // result is an Error
  console.error(`[EXECUTOR] Ref storage_deposit failed for ${accountId}:`, (result as Error).message);
  throw new Error(`Could not register your wallet on Ref Finance. Add at least ${depositNear} NEAR and retry.`);
}

/**
 * Ensure TREASURY_ACCOUNT_ID is registered with storage deposit on wrap.near
 * so fee transfers in buy orders never revert with "account is not registered".
 */
export async function ensureTreasuryStorage(): Promise<void> {
  if (!TREASURY_ACCOUNT_ID) return;
  try {
    const isRegistered = await near.checkStorageRegistered(TREASURY_ACCOUNT_ID, 'wrap.near').catch(() => false);
    if (!isRegistered) {
      console.log(`[EXECUTOR] Treasury ${TREASURY_ACCOUNT_ID} not registered on wrap.near. Registering via ${PARENT_ACCOUNT}...`);
      await near.signAndSendTransactionAll(PARENT_ACCOUNT, 'wrap.near', [
        transactions.functionCall(
          'storage_deposit',
          { account_id: TREASURY_ACCOUNT_ID, registration_only: true },
          BigInt('30000000000000'),
          BigInt('1250000000000000000000') // 0.00125 NEAR
        )
      ], 30_000);
      console.log(`[EXECUTOR] Successfully registered treasury ${TREASURY_ACCOUNT_ID} on wrap.near`);
    }
  } catch (err: any) {
    console.warn(`[EXECUTOR] Failed to ensure treasury storage: ${err?.message}`);
  }
}

/**
 * Check if a token is whitelisted on Ref Finance before trading.
 * If the token is not on Ref's global whitelist AND not in the user's account whitelist on Ref,
 * registers the token via register_tokens on v2.ref-finance.near to prevent E407: account not in pool whitelist panics.
 */
export async function ensureRefTokenRegistered(tokenAddress: string, accountId?: string): Promise<void> {
  if (!accountId || !tokenAddress || tokenAddress === 'wrap.near' || tokenAddress === 'near') return;

  const cacheKey = `${accountId}:${tokenAddress}`;
  if (refTracker.isTokenConfirmed(cacheKey)) return;

  const hasKey = await near.hasKey(accountId);
  if (!hasKey) return;

  // 1. Check if token is globally whitelisted on Ref Finance
  const globalWhitelisted: string[] = await near.getWhitelistedTokens().catch(() => []);
  if (Array.isArray(globalWhitelisted) && globalWhitelisted.includes(tokenAddress)) {
    refTracker.confirmToken(cacheKey);
    return;
  }

  // 2. Check if account has registered this token in Ref Finance internal storage
  const userTokens: string[] = await near.view<string[]>('v2.ref-finance.near', 'get_user_whitelisted_tokens', { account_id: accountId }).catch(() => []);
  if (Array.isArray(userTokens) && userTokens.includes(tokenAddress)) {
    refTracker.confirmToken(cacheKey);
    return;
  }

  // 3. Register token on v2.ref-finance.near
  console.log(`[EXECUTOR] Token ${tokenAddress} is not whitelisted on Ref Finance for ${accountId}. Registering token via register_tokens...`);
  try {
    const depositYocto = BigInt('1000000000000000000000'); // 0.001 NEAR deposit
    await near.signAndSendTransactionAll(accountId, 'v2.ref-finance.near', [
      transactions.functionCall(
        'register_tokens',
        { token_ids: [tokenAddress] },
        BigInt('30000000000000'),
        depositYocto
      ),
    ], 30_000);
    refTracker.confirmToken(cacheKey);
    console.log(`[EXECUTOR] Successfully registered token ${tokenAddress} on Ref Finance for ${accountId}`);
  } catch (err: any) {
    const msg = (err?.message ?? String(err)).toLowerCase();
    if (msg.includes('already registered') || msg.includes('token already registered')) {
      refTracker.confirmToken(cacheKey);
      return;
    }
    console.warn(`[EXECUTOR] Token registration on Ref Finance failed for ${tokenAddress}:`, err?.message);
  }
}

// ── Swap execution ────────────────────────────────────────────────────────────

export class SwapExecutor {
  private activeTradeWNearState = new Map<string, { wNearBal: bigint; maxNativeDeposit?: bigint }>();

  private async refuelNearGasIfNeeded(subaccountId: string, currentNativeBalYocto: bigint): Promise<boolean> {
    const minRequiredYocto = BigInt(Math.ceil(0.025 * 1e24)); // 0.025 NEAR
    if (currentNativeBalYocto >= minRequiredYocto) return false;
    if (!PARENT_ACCOUNT || !MAIN_WALLET_PRIVATE_KEY) return false;

    try {
      const hasParent = await (this.nearClient as any).hasKey?.(PARENT_ACCOUNT).catch(() => false);
      if (!hasParent && (this.nearClient as any).addKey) {
        const parentKp = KeyPair.fromString(MAIN_WALLET_PRIVATE_KEY as any);
        await (this.nearClient as any).addKey(PARENT_ACCOUNT, parentKp);
      }
      const refuelYocto = BigInt(utils.format.parseNearAmount('0.04')!);
      const signFn = (this.nearClient as any).signAndSendTransactionAll || near.signAndSendTransactionAll;
      if (typeof signFn === 'function') {
        await signFn.call(
          this.nearClient,
          PARENT_ACCOUNT,
          subaccountId,
          [transactions.transfer(refuelYocto)],
          30_000
        );
        console.log(`[REFUEL] Successfully sent 0.04 NEAR gas refuel from ${PARENT_ACCOUNT} to ${subaccountId}`);
        return true;
      }
      return false;
    } catch (err: any) {
      console.warn(`[REFUEL] Failed to auto-refuel gas to ${subaccountId}:`, err?.message);
      return false;
    }
  }
  constructor(
    private redisClient: RedisClient = redis,
    private nearClient: MultiRpcNear = near
  ) { }

  /**
   * Helper to build atomic actions on wrap.near for buy orders.
   * Dynamically checks the user's existing wNEAR balance on-chain:
   * - If user already holds enough wNEAR, skips near_deposit entirely.
   * - If user holds partial wNEAR, only wraps the shortfall depositNeeded.
   * - Otherwise wraps the full amountInBigInt.
   * Batches near_deposit (if needed) + ft_transfer (fee to treasury) + ft_transfer_call (swap on DEX).
   *
   * The shortfall is computed against totalSpend (fee + swap) PLUS a buffer,
   * then clamped to totalSpend. Balance view calls can lag the latest block
   * (or race concurrent wallet activity), and exact-equality top-ups then
   * leave the final ft_transfer_call a few dust-yocto short — the whole tx
   * panics with "The account doesn't have enough balance" even though the
   * user holds plenty of NEAR (mainnet tx 2zciEK9b…). The clamp guarantees
   * the deposit alone can always cover the full spend, and never exceeds
   * the amount the user authorized.
   */
  private async buildWrapNearBuyActions(
    subaccountId: string,
    amountInBigInt: bigint,
    feeAmount: bigint,
    swapAmount: bigint,
    dexReceiverId: string,
    dexMsg: string,
    swapGas: bigint = DEFAULT_SWAP_GAS,
    cachedWNearBal?: bigint
  ): Promise<any[]> {
    const stateOverride = this.activeTradeWNearState.get(subaccountId);
    const effectiveCachedWNear = stateOverride !== undefined ? stateOverride.wNearBal : cachedWNearBal;
    const wNearBal = effectiveCachedWNear !== undefined
      ? effectiveCachedWNear
      : BigInt((await this.nearClient.getTokenBalance('wrap.near', subaccountId).catch(() => '0')) || '0');
    const totalSpend = amountInBigInt; // === feeAmount + swapAmount by construction
    const DEPOSIT_BUFFER = BigInt('10000000000000000000000'); // 0.01 NEAR stale-read headroom
    const shortfallWithBuffer = totalSpend + DEPOSIT_BUFFER - wNearBal;
    let depositNeeded = shortfallWithBuffer <= 0n ? 0n
      : shortfallWithBuffer > totalSpend ? totalSpend
        : shortfallWithBuffer;
    if (stateOverride?.maxNativeDeposit !== undefined && depositNeeded > stateOverride.maxNativeDeposit) {
      depositNeeded = totalSpend > wNearBal ? totalSpend - wNearBal : 0n;
      if (depositNeeded > stateOverride.maxNativeDeposit) {
        depositNeeded = stateOverride.maxNativeDeposit;
      }
    }

    // Check if account is registered for storage on wrap.near.
    // If not registered, wrap.near automatically deducts its 0.00125 NEAR storage registration fee
    // from the near_deposit attached deposit. To avoid a 0.00125 wNEAR shortfall on ft_transfer_call,
    // add this fee to depositNeeded when depositNeeded > 0.
    const WRAP_NEAR_STORAGE_FEE = BigInt('1250000000000000000000'); // 0.00125 NEAR
    const isWrapRegistered = this.nearClient.checkStorageRegistered
      ? await this.nearClient.checkStorageRegistered(subaccountId, 'wrap.near').catch(() => false)
      : true;
    if (!isWrapRegistered && depositNeeded > 0n && stateOverride?.maxNativeDeposit === undefined) {
      depositNeeded += WRAP_NEAR_STORAGE_FEE;
      this.nearClient.markStorageRegistered?.(subaccountId, 'wrap.near');
    }

    const actions: any[] = [];
    if (depositNeeded > 0n) {
      actions.push(
        transactions.functionCall(
          'near_deposit',
          {},
          BigInt('10000000000000'),
          depositNeeded
        )
      );
    }

    const effectiveSwapGas = swapGas === DEFAULT_SWAP_GAS ? BigInt('90000000000000') : swapGas;
    actions.push(
      transactions.functionCall(
        'ft_transfer',
        { receiver_id: TREASURY_ACCOUNT_ID, amount: feeAmount.toString() },
        BigInt('10000000000000'), // 10 Tgas (burns ~2.5 Tgas)
        BigInt('1')
      ),
      transactions.functionCall(
        'ft_transfer_call',
        {
          receiver_id: dexReceiverId,
          amount: swapAmount.toString(),
          msg: dexMsg,
        },
        effectiveSwapGas,
        BigInt('1')
      )
    );

    return actions;
  }

  /**
   * Execute a swap event. Uses the user's pre-warmed scoped key.
   * Broadcasts to the single pinned trade RPC (no fallback) and confirms on it.
   * Queued per account to prevent nonce conflicts from concurrent operations.
   */
  /**
   * Execute a swap event with observability: records a trade_attempts row with
   * per-stage timings, updated on success/failure. Throws propagate unchanged.
   */
  async execute(event: SwapEvent, onProgress?: (stage: string) => Promise<void> | void): Promise<{ txHash: string; success: boolean; positionId?: string; reason?: string; tokenName?: string; tokenSymbol?: string; tokenQty?: string; priceNear?: number; nearSpent?: number; usdcSpent?: number; nearReceived?: number; usdcReceived?: number; sellPercent?: number }> {
    const isBuy = event.token_in === 'wrap.near' || event.token_in === 'near';

    // Record the attempt WITHOUT blocking the trade — the DB insert overlaps
    // with the pre-trade RPC work. Awaited only when the id is needed for the
    // post-trade update.
    let attemptId: string | null = null;
    const attemptReady = recordTradeAttempt({
      user_id: event.user_id,
      side: isBuy ? 'buy' : 'sell',
      venue: event.venue,
      token_in: event.token_in,
      token_out: event.token_out,
      amount_in: event.amount_in,
      min_amount_out: event.min_amount_out,
      slippage_pct: event.slippage_pct ?? null,
    }).then((id) => { attemptId = id; }).catch((err: any) => {
      console.warn('[EXECUTOR] recordTradeAttempt failed:', err?.message);
    });

    // One overall deadline per trade. Waits can otherwise stack (storage
    // deposit + swap, or two-tx multihop buys: 2 × 40s confirms) beyond any
    // individual timeout and leave the user staring at "Processing" forever.
    // Budget: ~6s pre-sign + 2×45s storage windows + 40s swap confirm +
    // 60s confirmation re-check grace (see signAndSend) ≈ 200s worst case —
    // the 'confirming_slow' progress ping keeps the user informed at 15s.
    const TRADE_DEADLINE_MS = 210_000;
    const timings: Record<string, number> = {};
    let inner: Promise<{ txHash: string; success: boolean; positionId?: string; reason?: string; tokenName?: string; tokenSymbol?: string; tokenQty?: string; priceNear?: number; nearSpent?: number; usdcSpent?: number; nearReceived?: number; usdcReceived?: number; sellPercent?: number }>;
    try {
      inner = this.executeInner(event, timings, onProgress);
    } catch (err: any) {
      // synchronous throw path (defensive — executeInner is async)
      await attemptReady;
      if (attemptId) {
        await updateTradeAttempt(attemptId, {
          status: 'failed', tx_hash: null, error: err?.message ?? String(err),
          timings: { presign_ms: 0, sign_ms: 0, post_ms: 0 },
        }).catch(() => { /* no-op */ });
      }
      throw err;
    }

    let result: { txHash: string; success: boolean; positionId?: string; reason?: string; tokenName?: string; tokenSymbol?: string; tokenQty?: string; priceNear?: number; nearSpent?: number; usdcSpent?: number; nearReceived?: number; usdcReceived?: number; sellPercent?: number };
    let deadlineTimer: NodeJS.Timeout | null = null;
    try {
      result = await Promise.race([
        inner,
        new Promise<never>((_, reject) => {
          deadlineTimer = setTimeout(() => reject(new Error(
            'This trade is taking too long — the outcome is unknown. Check your wallet balance or look up your account on NearBlocks before retrying, to avoid a duplicate trade.'
          )), TRADE_DEADLINE_MS);
        }),
      ]);
    } catch (err: any) {
      // The inner promise keeps running in the background; swallow its
      // eventual settlement so it never surfaces as an unhandled rejection.
      inner.catch(() => { /* outcome unknown — the deadline error stands */ });
      await attemptReady;
      if (attemptId) {
        await updateTradeAttempt(attemptId, {
          status: 'failed',
          tx_hash: null,
          error: err?.message ?? String(err),
          timings: {
            presign_ms: timings.presign_ms ?? 0,
            sign_ms: timings.sign_ms ?? 0,
            post_ms: timings.post_ms ?? 0,
          },
        }).catch(() => { /* no-op */ });
      }
      throw err;
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
    }

    await attemptReady;
    if (attemptId) {
      await updateTradeAttempt(attemptId, {
        status: result.success === false ? 'failed' : 'success',
        tx_hash: result.txHash ?? null,
        error: result.success === false ? (result.reason ?? null) : null,
        timings: {
          // Click→quote (pre-sign work incl. quote and registration checks)
          presign_ms: timings.presign_ms ?? 0,
          // Quote→broadcast (lock + sign + multi-RPC broadcast)
          sign_ms: timings.sign_ms ?? 0,
          // Broadcast→confirmed on-chain + post-processing
          post_ms: timings.post_ms ?? 0,
        },
      }).catch(() => { /* no-op */ });
    }
    return result;
  }

  private async executeInner(event: SwapEvent, timings: Record<string, number>, onProgress?: (stage: string) => void): Promise<{ txHash: string; success: boolean; positionId?: string; reason?: string; tokenName?: string; tokenSymbol?: string; tokenQty?: string; priceNear?: number; nearSpent?: number; usdcSpent?: number; nearReceived?: number; usdcReceived?: number; sellPercent?: number }> {
    const t0 = Date.now();
    const { user_id, token_in, token_out, amount_in, min_amount_out, venue } = event;

    // Route Solana chain trades to SolanaExecutor (Jupiter: pump.fun curve + bonded AMMs).
    // Must run before the Starknet check below, which matches any non-NEAR address shape.
    if (event.chain === 'solana' || venue === 'pumpfun' || venue === 'pumpswap' || venue === 'jupiter') {
      const presignStart = Date.now();
      const res = await executeSolanaSwap(event, onProgress);
      timings.presign_ms = Date.now() - presignStart;
      timings.sign_ms = 0;
      timings.post_ms = 0;
      const solIsInput = token_in === 'So11111111111111111111111111111111111111112' || token_in.toLowerCase() === 'sol';
      // Fail loudly: background flows (TP/SL, DCA, limit, copy, snipe, fleet)
      // rely on a thrown error to send 'trade_failed' and re-arm triggers.
      if (!res.success) {
        throw new Error(res.reason || (solIsInput ? 'Solana buy failed' : 'Solana sell failed'));
      }
      if (event.notify_user !== false) {
        await this.notifyUser(user_id, 'solana_trade_confirmed', {
          side: solIsInput ? 'buy' : 'sell',
          tokenAddress: solIsInput ? token_out : token_in,
          tokenName: res.tokenName,
          tokenSymbol: res.tokenSymbol,
          tokenQty: res.tokenQty,
          priceSol: res.priceSol,
          solAmount: res.solAmount,
          positionId: res.positionId,
          txHash: res.txHash,
        }).catch((err: any) => console.warn('[EXECUTOR] Failed to send Solana confirmation:', err?.message));
      }
      return {
        txHash: res.txHash,
        success: res.success,
        positionId: res.positionId,
        reason: res.reason,
        tokenName: res.tokenName,
        tokenSymbol: res.tokenSymbol,
        tokenQty: res.tokenQty,
        priceNear: res.priceSol,
        nearSpent: solIsInput ? res.solAmount : undefined,
        nearReceived: solIsInput ? undefined : res.solAmount,
      };
    }

    // Route HyperEVM and Elysium chain trades directly to EvmExecutor
    const isEvmTokenIn = (token_in.length === 42 && isValidEvmAddress(token_in));
    const isEvmTokenOut = (token_out.length === 42 && isValidEvmAddress(token_out));
    const isEvmEvent =
      event.chain === 'hyperevm' ||
      event.chain === 'elysium' ||
      venue === 'hyperevm_dex' ||
      venue === 'elysium_dex' ||
      venue === 'market_lab' ||
      venue === 'corepad' ||
      token_in.toUpperCase() === 'HYPE' ||
      token_out.toUpperCase() === 'HYPE' ||
      ((isEvmTokenIn || isEvmTokenOut) && event.chain !== 'starknet');

    if (isEvmEvent) {
      const presignStart = Date.now();
      const evmChain = (event.chain === 'elysium' || event.token_out?.toLowerCase().endsWith('.elysium') ? 'elysium' : 'hyperevm');
      const res = await executeEvmSwap({ ...event, chain: evmChain }, onProgress);
      timings.presign_ms = Date.now() - presignStart;
      timings.sign_ms = 0;
      timings.post_ms = 0;

      const hypeIsInput = token_in.toUpperCase() === 'HYPE' || token_in === 'native' || token_in === '0x0000000000000000000000000000000000000000';
      if (!res.success) {
        throw new Error(res.reason || (hypeIsInput ? 'EVM buy failed' : 'EVM sell failed'));
      }

      return {
        txHash: res.txHash,
        success: res.success,
        positionId: res.positionId,
        reason: res.reason,
        tokenName: res.tokenName,
        tokenSymbol: res.tokenSymbol,
        tokenQty: res.tokenQty,
        priceNear: res.priceHype,
        nearSpent: hypeIsInput ? res.hypeSpentOrReceived : undefined,
        nearReceived: hypeIsInput ? undefined : res.hypeSpentOrReceived,
      };
    }

    // Route Starknet chain trades directly to StarknetExecutor
    if (
      !isEvmEvent &&
      event.chain !== 'hyperevm' &&
      event.chain !== 'elysium' &&
      event.chain === 'starknet' ||
      venue === 'avnu' ||
      venue === 'ekubo' ||
      venue === 'launchy' ||
      venue === 'unruggable' ||
      venue === 'jediswap' ||
      venue === 'stark_dex' ||
      token_in.toLowerCase() === 'strk' ||
      token_out.toLowerCase() === 'strk' ||
      (token_in.startsWith('0x') && !token_in.includes('::') && event.chain !== 'sui') ||
      (token_out.startsWith('0x') && !token_out.includes('::') && event.chain !== 'sui')
    ) {
      const presignStart = Date.now();
      const res = await executeStarknetSwap(event, onProgress);
      timings.presign_ms = Date.now() - presignStart;
      timings.sign_ms = 0;
      timings.post_ms = 0;

      return {
        txHash: res.txHash,
        success: res.success,
        positionId: res.positionId,
        reason: res.reason,
        tokenName: res.tokenName,
        tokenSymbol: res.tokenSymbol,
        tokenQty: res.tokenQty,
        priceNear: res.price,
        nearSpent: res.spent,
      };
    }

    // Route SUI chain trades directly to SuiExecutor
    if (
      event.chain === 'sui' ||
      venue === 'suipump' ||
      venue === 'cetus' ||
      venue === 'turbos' ||
      venue === 'deepbook' ||
      venue === 'sui_dex' ||
      token_in === 'sui' ||
      token_in === '0x2::sui::SUI' ||
      token_in === 'SUI' ||
      token_in.includes('::') ||
      token_out.includes('::')
    ) {
      const presignStart = Date.now();
      const res = await executeSuiSwap(event, onProgress);
      timings.presign_ms = Date.now() - presignStart;
      timings.sign_ms = 0;
      timings.post_ms = 0;

      // Broadcast buy alert if successful SUI buy
      const isSuiBuy = event.token_in === 'sui' || event.token_in === '0x2::sui::SUI' || event.token_in === 'SUI';
      if (res.success && isSuiBuy && res.txHash) {
        try {
          const suiUsdRate = await getSuiUsdPrice().catch(() => 2.0);
          const suiSpent = res.suiSpent ?? 0;
          const spentUsd = suiSpent * suiUsdRate;
          const userRec = await getUserById(user_id);
          const buyerAddress = userRec?.sui_address || user_id;
          const tokenName = res.tokenName ?? event.token_out;
          const tokenSymbol = res.tokenSymbol ?? 'TOKEN';

          // Compute market cap from total supply × price
          let marketCapUsd: number | undefined;
          try {
            if ((res.priceSui ?? 0) > 0) {
              const supplyResult = await getSuiTokenSupply(event.token_out).catch(() => null);
              if (supplyResult != null) {
                // getSuiTokenSupply returns raw integer supply in smallest units (MIST-equivalent)
                const totalSupplyHuman = Number(supplyResult) / 1e9;
                marketCapUsd = Math.round(totalSupplyHuman * (res.priceSui ?? 0) * suiUsdRate);
              }
            }
          } catch { /* non-fatal */ }

          // Fetch buyer's SUI balance so groups can gauge whale size
          let buyerSuiBalance: number | undefined;
          try {
            const suiBal = await getSuiBalance(buyerAddress).catch(() => null);
            if (suiBal != null) {
              // getSuiBalance returns SuiBalanceResult; extract total balance in MIST
              const mistBalance = typeof suiBal === 'object' ? (suiBal as any).totalBalance ?? (suiBal as any).balance : suiBal;
              buyerSuiBalance = parseFloat(String(mistBalance)) / 1e9; // convert MIST to SUI
            }
          } catch { /* non-fatal */ }

          const buyAlert: BuyAlertEvent = {
            type: 'buy_alert',
            chain: 'sui',
            token_address: event.token_out,
            token_name: tokenName,
            token_symbol: tokenSymbol,
            buyer_address: buyerAddress,
            spent_amount_native: `${suiSpent.toFixed(2)} SUI`,
            spent_usd: Math.round(spentUsd * 100) / 100,
            tokens_received: `${res.tokenQty ?? '0'} ${tokenSymbol}`,
            price_usd: (res.priceSui ?? 0) * suiUsdRate,
            market_cap_usd: marketCapUsd,
            buyer_sui_balance: buyerSuiBalance,
            tx_hash: res.txHash,
            timestamp: Date.now(),
          };
          await (this.redisClient ?? redis).publish(CHANNELS.BUY_ALERT, JSON.stringify(buyAlert));
        } catch (alertErr: any) {
          console.warn('[EXECUTOR] Failed to publish SUI buy alert:', alertErr?.message);
        }
      }

      return {
        txHash: res.txHash,
        success: res.success,
        positionId: res.positionId,
        reason: res.reason,
        tokenName: res.tokenName,
        tokenSymbol: res.tokenSymbol,
        tokenQty: res.tokenQty,
        priceNear: res.priceSui,
        nearSpent: res.suiSpent,
      };
    }

    // Pre-flight health gate. min(2, configured) providers required; if none
    // are healthy the gate resets circuit breakers and lets the attempt through
    // (see MultiRpcNear.checkTradeProviders) — a failed attempt beats a blocked
    // one. Only a completely unconfigured provider list throws here.
    try {
      near.checkTradeProviders();
    } catch (err: any) {
      console.error('[EXECUTOR] Pre-flight health check failed:', err.message);
      throw new Error(`Cannot execute trade: ${err.message}`);
    }

    const user = await getUserById(user_id);
    if (!user) throw new Error(`User ${user_id} not found`);

    const activeWallet = await getActiveWallet(user_id, 'near').catch(() => null);
    let subaccountToUse = activeWallet?.address || user.subaccount_id;
    let keyEncToUse = activeWallet?.encrypted_private_key || user.scoped_key_encrypted;

    // Safety guard against orphaned/empty activeWallet desync:
    // If activeWallet address is different from user.subaccount_id and activeWallet is not an imported wallet,
    // verify which account has the funds before executing to avoid "Insufficient balance" when user has funds in subaccount_id.
    if (activeWallet && !activeWallet.is_imported && user.subaccount_id && activeWallet.address !== user.subaccount_id) {
      const [activeBalStr, subaccountBalStr, activeUsdcBalStr, subaccountUsdcBalStr] = await Promise.all([
        this.nearClient.getNearBalance?.(activeWallet.address).catch(() => '0') ?? '0',
        this.nearClient.getNearBalance?.(user.subaccount_id).catch(() => '0') ?? '0',
        this.nearClient.getTokenBalance?.(NEAR_USDC_CONTRACT, activeWallet.address).catch(() => '0') ?? '0',
        this.nearClient.getTokenBalance?.(NEAR_USDC_CONTRACT, user.subaccount_id).catch(() => '0') ?? '0',
      ]);
      const activeBal = BigInt(activeBalStr || '0');
      const subaccountBal = BigInt(subaccountBalStr || '0');
      const activeUsdc = BigInt(activeUsdcBalStr || '0');
      const subaccountUsdc = BigInt(subaccountUsdcBalStr || '0');
      if ((subaccountBal > activeBal && activeUsdc === 0n) || (subaccountUsdc > activeUsdc)) {
        console.warn(`[EXECUTOR] Wallet desync for user ${user_id}: activeWallet=${activeWallet.address} (${activeBalStr} yocto) vs subaccount_id=${user.subaccount_id} (${subaccountBalStr} yocto). Auto-switching to funded subaccount.`);
        subaccountToUse = user.subaccount_id;
        keyEncToUse = user.scoped_key_encrypted;
        syncUserActiveWallet(user_id, 'near', user.subaccount_id, user.scoped_key_encrypted).catch(() => { });
      }
    }

    let warm = warmKeys.get(user_id);
    if (!warm || warm.subaccountId !== subaccountToUse) {
      await addUserKey(user_id, subaccountToUse, keyEncToUse);
      warm = warmKeys.get(user_id);
      if (!warm) throw new Error(`Failed to load trading key for user ${user_id}`);
    }

    const { subaccountId } = warm;
    this.activeTradeWNearState.delete(subaccountId);

    // Resolve the user's slippage preference (event field wins, then user record).
    const userSlippage = event.slippage_pct ?? user.slippage_pct ?? 2;

    // Pre-flight balance check: verify the account has sufficient native balance before burning gas or broadcasting
    const isBuyPath = token_in === 'wrap.near' || token_in === 'near';
    const isUsdcOnlyMode = (event.trade_currency ?? (user as any).near_trade_currency) === 'usdc';
    let usdcReceivedHuman: number | undefined = undefined;
    let knownWNearBal: bigint = 0n;
    let usdcToSwapRaw: bigint = 0n;
    let nearShortfallFromUsdcYocto: bigint = 0n;
    let maxNativeDepositYocto: bigint | undefined = undefined;
    let usdcSpentHuman: number | undefined = undefined;
    let capturedNativeBalStr: string | null = null;
    if (isBuyPath) {
      // Balance and honeypot safety audit are fetched concurrently
      const [nativeBalStr, wNearBalStr, usdcBalStr, safety] = await Promise.all([
        this.nearClient.getNearBalance?.(subaccountId).catch(() => null) ?? null,
        this.nearClient.getTokenBalance('wrap.near', subaccountId).catch(() => '0'),
        this.nearClient.getTokenBalance?.(NEAR_USDC_CONTRACT, subaccountId).catch(() => '0') ?? '0',
        checkTokenSafety(token_out).catch(() => null),
      ]);
      capturedNativeBalStr = nativeBalStr;

      if (safety?.isHoneypot || safety?.isDrained) {
        const title = safety?.isDrained ? 'a DRAINED / RUGGED POOL' : 'a MALICIOUS HONEYPOT';
        const dangerReason = safety.reasons[0] || (safety?.isDrained ? 'Pool liquidity has been drained or pulled' : `Backdoor method: ${safety?.dangerousMethods.join(', ')}`);
        throw new Error(
          `🚨 ORDER BLOCKED FOR YOUR PROTECTION:\n\n` +
          `This token (\`${token_out}\`) was identified as ${title}.\n` +
          `• ${dangerReason}\n\n` +
          `🛡️ RacerBot has blocked this transaction to prevent loss of funds.`
        );
      }

      knownWNearBal = BigInt(wNearBalStr || '0');
      if (nativeBalStr !== null && nativeBalStr !== undefined) {
        const nativeBal = BigInt(nativeBalStr);
        const wNearBal = knownWNearBal;
        const amountInBigInt = BigInt(amount_in);
        // Required native NEAR if existing wNEAR balance does not cover amount_in
        const nearNeededForSwap = amountInBigInt > wNearBal ? amountInBigInt - wNearBal : 0n;

        // Minimal reserve in NEAR remaining after swap to cover gas, account storage, and future trades
        // Keep at least 0.05 NEAR, allowing users to safely cover 0.0315-0.045 NEAR network gas reserve + storage
        const nearUsd = await getNearUsdPrice().catch(() => 0);
        const effectiveNearUsd = nearUsd > 0 ? nearUsd : 5.16;
        const minReserveNear = nearNeededForSwap > 0n ? 0.05 : 0.035;
        const minReserveYocto = BigInt(Math.ceil(minReserveNear * 1e24));
        const totalNearRequired = nearNeededForSwap + minReserveYocto;

        if (isUsdcOnlyMode) {
          const usdcBal = BigInt(usdcBalStr || '0');
          const minGasYocto = BigInt(Math.ceil(0.025 * 1e24));
          const usdcHuman = Number(usdcBal) / Math.pow(10, NEAR_USDC_DECIMALS);
          const usdcMaxNearYocto = usdcBal > 0n && effectiveNearUsd > 0
            ? BigInt(Math.floor((usdcHuman / effectiveNearUsd) * 1e24))
            : 0n;
          let effectiveNativeBal = nativeBal;
          if (effectiveNativeBal < minGasYocto && usdcBal > 0n) {
            const refueled = await this.refuelNearGasIfNeeded(subaccountId, effectiveNativeBal).catch(() => false);
            if (refueled) {
              effectiveNativeBal += BigInt(Math.ceil(0.04 * 1e24));
            }
          }
          if (effectiveNativeBal < minGasYocto) {
            throw new Error(
              `Insufficient NEAR for network gas. Even in USDC-Only mode, your wallet must hold at least 0.025 NEAR (~${(0.025 * effectiveNearUsd).toFixed(2)}) for gas. Current balance: ${(Number(effectiveNativeBal) / 1e24).toFixed(4)} NEAR.`
            );
          }
          if (usdcBal > 0n && (usdcMaxNearYocto * 102n) / 100n >= amountInBigInt) {
            const shortfallNearHuman = Number(amountInBigInt) / 1e24;
            const neededUsdcRaw = BigInt(
              Math.max(1, Math.ceil(shortfallNearHuman * effectiveNearUsd * 1.015 * Math.pow(10, NEAR_USDC_DECIMALS)))
            );
            usdcToSwapRaw = neededUsdcRaw > usdcBal ? usdcBal : neededUsdcRaw;
            nearShortfallFromUsdcYocto = amountInBigInt;
            maxNativeDepositYocto = 0n;
            knownWNearBal = 0n;
            usdcSpentHuman = Number(usdcToSwapRaw) / Math.pow(10, NEAR_USDC_DECIMALS);
          } else {
            const reqUsd = ((Number(amountInBigInt) / 1e24) * effectiveNearUsd).toFixed(2);
            throw new Error(
              `Insufficient USDC balance (USDC-Only Mode is active). You have ${usdcHuman.toFixed(2)} USDC (~${(Number(usdcMaxNearYocto) / 1e24).toFixed(4)} NEAR), which is less than the requested ~${reqUsd} USDC (${(Number(amountInBigInt) / 1e24).toFixed(4)} NEAR). Deposit more USDC or switch to NEAR mode in ⚙️ Settings.`
            );
          }
        } else if (nativeBal < totalNearRequired) {
          const usdcBal = BigInt(usdcBalStr || '0');
          const minGasYocto = BigInt(Math.ceil(0.025 * 1e24));
          const wrapReserveYocto = BigInt(Math.ceil(0.05 * 1e24));
          let effectiveNativeBal = nativeBal;
          if (effectiveNativeBal < minGasYocto && usdcBal > 0n) {
            const refueled = await this.refuelNearGasIfNeeded(subaccountId, effectiveNativeBal).catch(() => false);
            if (refueled) {
              effectiveNativeBal += BigInt(Math.ceil(0.04 * 1e24));
            }
          }
          const spendableNativeYocto = effectiveNativeBal > wrapReserveYocto ? effectiveNativeBal - wrapReserveYocto : 0n;
          const availableNearYocto = spendableNativeYocto + wNearBal;
          const shortfallYocto = amountInBigInt > availableNearYocto ? amountInBigInt - availableNearYocto : 0n;
          const usdcHuman = Number(usdcBal) / Math.pow(10, NEAR_USDC_DECIMALS);
          const usdcMaxNearYocto = usdcBal > 0n && effectiveNearUsd > 0
            ? BigInt(Math.floor((usdcHuman / effectiveNearUsd) * 1e24))
            : 0n;
          if (effectiveNativeBal >= minGasYocto && usdcBal > 0n && shortfallYocto > 0n && availableNearYocto + usdcMaxNearYocto >= amountInBigInt) {
            const shortfallNearHuman = Number(shortfallYocto) / 1e24;
            const neededUsdcRaw = BigInt(
              Math.max(1, Math.ceil(shortfallNearHuman * effectiveNearUsd * 1.015 * Math.pow(10, NEAR_USDC_DECIMALS)))
            );
            usdcToSwapRaw = neededUsdcRaw > usdcBal ? usdcBal : neededUsdcRaw;
            nearShortfallFromUsdcYocto = shortfallYocto;
            maxNativeDepositYocto = spendableNativeYocto;
            usdcSpentHuman = Number(usdcToSwapRaw) / Math.pow(10, NEAR_USDC_DECIMALS);
          } else {
            const availableNear = (Number(effectiveNativeBal) / 1e24).toFixed(4);
            const availableUsd = (Number(effectiveNativeBal) / 1e24 * effectiveNearUsd).toFixed(2);
            const remainingNearYocto = effectiveNativeBal > nearNeededForSwap ? effectiveNativeBal - nearNeededForSwap : 0n;
            const remainingNear = (Number(remainingNearYocto) / 1e24).toFixed(4);
            const remainingUsd = (Number(remainingNearYocto) / 1e24 * effectiveNearUsd).toFixed(2);
            const requiredReserveNearStr = (0.03).toFixed(4);

            throw new Error(
              `Insufficient balance after swap. Your wallet must keep a minimal reserve of ${requiredReserveNearStr} NEAR (~$${(0.03 * effectiveNearUsd).toFixed(2)}) to cover gas and account storage. You have $${availableUsd} (${availableNear} NEAR), and would only have $${remainingUsd} (${remainingNear} NEAR) left after this swap. Please reduce your buy amount or deposit more NEAR.`
            );
          }
        }
      }
    } else {
      const [tokenBalStr, nativeBalStr] = await Promise.all([
        this.nearClient.getTokenBalance(token_in, subaccountId).catch(() => null),
        this.nearClient.getNearBalance?.(subaccountId).catch(() => null) ?? null,
      ]);

      if (tokenBalStr !== null && tokenBalStr !== undefined) {
        const tokenBal = BigInt(tokenBalStr);
        const amountInBigInt = BigInt(amount_in);
        if (tokenBal < amountInBigInt) {
          const tokenMeta = await this.nearClient.getTokenMetadata(token_in).catch(() => ({ symbol: 'tokens', decimals: 24 }));
          const decimals = tokenMeta.decimals || 24;
          const available = (Number(tokenBal) / Math.pow(10, decimals)).toFixed(4);
          const required = (Number(amountInBigInt) / Math.pow(10, decimals)).toFixed(4);
          throw new Error(
            `Insufficient token balance. You have ${available} ${tokenMeta.symbol || 'tokens'} available, but tried to sell ${required}.`
          );
        }
      }

      if (nativeBalStr !== null && nativeBalStr !== undefined) {
        const nativeBal = BigInt(nativeBalStr);
        const MIN_SELL_GAS_RESERVE = BigInt('10000000000000000000000'); // 0.01 NEAR
        if (nativeBal < MIN_SELL_GAS_RESERVE) {
          const availableNear = (Number(nativeBal) / 1e24).toFixed(4);
          throw new Error(
            `Insufficient NEAR for gas fees. Your wallet only has ${availableNear} NEAR. Need at least 0.0100 NEAR to cover transaction gas.`
          );
        }
      }

      // User already holds the token and wNEAR is baseline: pre-mark storage to eliminate view calls
      this.nearClient.markStorageRegistered?.(subaccountId, token_in);
      this.nearClient.markStorageRegistered?.(subaccountId, 'wrap.near');
    }

    // Helper to sign and send with distributed per-account lock.
    // Records stage timings: presign (everything before signing incl. quote),
    // sign (lock + sign + broadcast), post (on-chain confirmation + fill).
    // Emits UI progress stages so the user sees movement instead of a frozen
    // "Processing…" message; 'confirming_slow' fires if on-chain confirmation
    // exceeds 15s (RPC/indexer congestion) to reassure the user.
    //
    // FIX 3: the output-token balance read (fired in parallel with the quote)
    // is awaited BEFORE signing so the pre-balance snapshot always predates
    // the swap — success is later measured as the balance increase.
    let capturedPreOutBalance: string | null = null;
    const signAndSend = async (receiverId: string, actions: transactions.Action[], waitForMs?: number, isSecondary = false) => {
      timings.presign_ms = Date.now() - t0;
      if (!isSecondary) {
        timings.signStart = Date.now();
        onProgress?.('signing');
        capturedPreOutBalance = await preOutBalanceP;
      }
      const slowTimer = !isSecondary ? setTimeout(() => onProgress?.('confirming_slow'), 15_000) : null;
      console.log(`[EXECUTOR:SIGN] Requesting lock & signing for subaccount=${subaccountId}, receiver=${receiverId}`);
      try {
        const outcome = await withAccountLock(
          this.redisClient,
          subaccountId,
          () => this.nearClient.signAndSendTransactionAll(
            subaccountId,
            receiverId,
            actions,
            waitForMs,
            isSecondary ? undefined : () => onProgress?.('submitted')
          ),
          {
            // Must outlive the whole sign+broadcast+confirm window (40s
            // default + rebroadcast rescue + overhead). The old 30s TTL
            // expired mid-flight, letting a retry sign with the same key
            // while the first tx could still land — a nonce/double-spend race.
            ttlMs: 95_000,
            onContended: (accId) => {
              console.warn(`[EXECUTOR:SIGN] Contention on ${accId}, clearing access key cache`);
              this.nearClient.clearAccessKeyCache?.(accId);
              clearAccessKeyCache(accId);
            },
          }
        );
        console.log(`[EXECUTOR:SIGN] Transaction completed for subaccount=${subaccountId}, hash=${outcome?.transaction?.hash}`);
        const perf = (outcome as any)?.__perf;
        if (perf) {
          timings.sign_ms = perf.broadcastMs ?? (Date.now() - (timings.signStart ?? t0));
          timings.confirm_ms = Math.max(0, (perf.confirmMs ?? 0) - (perf.broadcastMs ?? 0));
        } else {
          timings.sign_ms = Date.now() - (timings.signStart ?? t0);
          timings.confirm_ms = 0;
        }
        return outcome;
      } catch (err: any) {
        // Confirmation timeout is NOT a trade failure. The tx was already
        // broadcast (broadcast_tx_async succeeded before the poll), so it may
        // land on-chain regardless of whether the pinned RPC ever reports it.
        // Re-check on-chain for a grace window before giving up: if the tx
        // landed, process it exactly like a normally-confirmed trade so the
        // fill is recorded instead of falsely reporting failure.
        const isNeverSeen =
          (err as any)?.neverSeen === true ||
          /never reached the NEAR network/i.test(err?.message ?? '');

        if (isNeverSeen) {
          console.warn(`[EXECUTOR:SIGN] Transaction ${err?.txHash ?? 'unknown'} never reached the NEAR network — skipping grace window.`);
          throw err;
        }

        const isNotConfirmed =
          (err instanceof TradeError && err.code === 'NOT_CONFIRMED') ||
          /not confirmed within/.test(err?.message ?? '');
        const timedOutHash: string | null =
          err?.txHash ??
          (/Transaction\s+([A-Za-z0-9]{40,50})\s+not confirmed/.exec(err?.message ?? '')?.[1] || null);

        if (isNotConfirmed && timedOutHash) {
          onProgress?.('confirming_slow');
          // DCL/NEP-141 swaps can produce a long chain of cross-contract
          // receipts (wrap → DEX → token tax/transfer → callbacks). The tx in
          // this path is already submitted, so keep reconciling long enough to
          // record a late real fill instead of falsely telling the user it is
          // unknown. The outer 210s trade deadline still bounds this wait.
          const graceMs = 120_000;
          console.warn(`[EXECUTOR:SIGN] Confirmation timed out for tx=${timedOutHash}; re-checking on-chain for up to ${graceMs}ms`);
          const recovered = await this.nearClient.waitForOutcome(timedOutHash, subaccountId, graceMs).catch(() => null);
          if (recovered) {
            console.log(`[EXECUTOR:SIGN] Re-check confirmed tx=${timedOutHash} for subaccount=${subaccountId}; processing as a fill`);
            timings.sign_ms = Date.now() - (timings.signStart ?? t0);
            timings.confirm_ms = 0;
            return recovered;
          }
          // Still unknown after the grace window — report UNKNOWN, not failed.
          // The user must check the wallet/NearBlocks before retrying; a blind
          // retry can duplicate a trade that lands late.
          throw new TradeError(
            `Transaction was submitted but its outcome is unknown (tx ${timedOutHash}) — the RPC never confirmed it within the grace window. ` +
            'Check your wallet balance or look up the tx on NearBlocks before retrying, to avoid a duplicate trade.',
            { code: 'NOT_CONFIRMED', txHash: timedOutHash }
          );
        }

        console.error(`[EXECUTOR:SIGN] Failed for subaccount=${subaccountId}:`, err?.message);
        throw err;
      } finally {
        if (slowTimer) clearTimeout(slowTimer);
      }
    };

    // Storage-registration wrapper — emits a progress stage so a one-time
    // storage_deposit transaction doesn't look like a frozen swap.
    const ensureStorage = (tokenAddress: string) => {
      onProgress?.('storage');
      return near.ensureStorageDeposit(subaccountId, tokenAddress);
    };

    // Use near-api-js to build, sign, and broadcast the FunctionCall transaction
    await this.nearClient.getAccount(subaccountId);

    let dclPoolId = (event as any).dcl_pool_id ?? null;
    if (dclPoolId && (!dclPoolId.includes('|') && !dclPoolId.includes('>'))) {
      dclPoolId = null;
    }
    let preloadedNtState: any = null;
    if ((venue === 'nearlytrade' || venue === 'rhea' || venue === 'ref' || venue === 'onetokenhub' || venue === 'nearpad' || venue === 'shoremarkets' || venue === 'kelytra' || venue === 'nearpumpfun' || venue === 'qlyphs') && !dclPoolId) {
      const tokenTarget = token_in === 'wrap.near' || token_in === 'near' ? token_out : token_in;
      const dbCache = await getTokenCache(tokenTarget).catch(() => null);
      dclPoolId = dbCache?.dcl_pool_id ?? null;
      if (dclPoolId && (!dclPoolId.includes('|') && !dclPoolId.includes('>'))) {
        dclPoolId = null;
      }
      if (!dclPoolId) {
        if (venue === 'nearlytrade') {
          preloadedNtState = await near.getNearlytradeTokenState(tokenTarget).catch(() => null);
          dclPoolId = preloadedNtState?.dclPoolId ?? null;
        } else if (venue === 'rhea' || venue === 'ref') {
          // Zombie-pool guard: only hunt for a DCL pool when NO simple pool is
          // known. Otherwise an unrelated thin DCL pool sitting far off the
          // market price (e.g. JAMBO's |10000 pool, priced ~10× the real AMM
          // pool with <3 NEAR of quote depth) would override the correct
          // simple-pool route and the user would massively overpay.
          const pinnedSimplePool = (event as any).pool_id ?? dbCache?.rhea_pool_id ?? null;
          if (pinnedSimplePool === null || pinnedSimplePool === undefined) {
            dclPoolId = await near.findDclPoolId(token_in, token_out).catch(() => null);
          }
        } else if (venue === 'onetokenhub') {
          const hubState = await near.getOneTokenHubState(tokenTarget).catch(() => null);
          dclPoolId = hubState?.dclPoolId ?? null;
        } else if (venue === 'nearpad') {
          const padState = await near.getNEARpadState(tokenTarget).catch(() => null);
          dclPoolId = padState?.dclPoolId ?? (await near.findDclPoolId(token_in, token_out).catch(() => null));
        } else if (venue === 'shoremarkets') {
          const smState = await near.getShoremarketsTokenState(tokenTarget).catch(() => null);
          dclPoolId = smState?.dclPoolId ?? (await near.findDclPoolId(token_in, token_out).catch(() => null));
        } else if (venue === 'kelytra') {
          const ktState = await near.getKelytraTokenState(tokenTarget).catch(() => null);
          dclPoolId = ktState?.dclPoolId ?? (await near.findDclPoolId(token_in, token_out).catch(() => null));
        } else if (venue === 'nearpumpfun') {
          dclPoolId = null;
        }
      }
    }

    // 1.5% fee = 150 bps
    let amountInBigInt = BigInt(amount_in);
    let feeAmount = (amountInBigInt * 150n) / 10000n;
    let swapAmount = amountInBigInt - feeAmount;

    if (isBuyPath && swapAmount <= 0n) {
      throw new Error(`Amount too small after fee: ${amount_in}`);
    }

    // The 1.5% fee is skimmed from the INPUT on buy paths, but min_amount_out
    // is computed against the FULL input upstream. Rescale it to the amount
    // actually swapped — otherwise every buy carries a hidden 1.5% slippage
    // deficit (buys structurally fail at slippage < 1.5% and pass with only
    // ~0.5% margin at the 2% default). AMM output is concave in input, so
    // proportional scaling is conservative: it can never demand more than the
    // pool gives. Sell paths must NOT be rescaled: the fee there is taken from
    // the OUTPUT after the swap, so rescaling would silently lower the user's
    // price floor by 1.5%.
    let minOutAdj = isBuyPath ? calculateMinOutAdj(min_amount_out, amountInBigInt) : min_amount_out;

    // FIX 3: fire the output-token balance read NOW so it overlaps with the
    // pre-flight quote — it adds no wall-clock time, and the awaited snapshot
    // inside signAndSend always predates the swap.
    const outTokenForBalance = isBuyPath ? token_out : 'wrap.near';
    const preOutBalanceP: Promise<string | null> = near
      .getTokenBalance(outTokenForBalance, subaccountId)
      .catch(() => null);

    // Pre-flight price check: re-quote against current on-chain state before
    // burning gas. If the pool can no longer satisfy the user's min_amount_out
    // (price moved between the upstream quote and now), fail fast with an exact
    // reason instead of submitting a transaction that must revert on-chain.
    // Never executes at a price worse than the user agreed to.
    //
    // SPEED: when the event carries a fresh quote (quoted_at < 2s old, set by
    // executeBuyHelper/sellAtTarget right after computeMinAmountOut), skip the
    // second quote entirely. Events without quoted_at (triggers, auto-buy)
    // keep the full re-quote. NearlyTrade is excluded: its two-transaction
    // multihop paths read minHop1AmountOut from the fresh quote for hop-1
    // slippage protection, and skipping would weaken slippage.
    //
    // The NearlyTrade Rhea-pool lookup runs CONCURRENTLY with the pre-flight
    // quote — they are independent RPC reads and previously ran in sequence,
    onProgress?.('quote');

    const quotedAt = (event as any).quoted_at as number | undefined;
    const isMultihop = (event as any).is_multihop === true;
    const quoteFresh = !isMultihop
      && typeof quotedAt === 'number'
      && Date.now() - quotedAt < 12_000;
    const freshQuote = quoteFresh
      ? null
      : await near.computeMinAmountOut(
        venue as any,
        token_in,
        token_out,
        (isBuyPath ? swapAmount : amountInBigInt).toString(),
        userSlippage,
        (event as any).pool_id ?? null,
        dclPoolId
      ).catch(() => null);
    if (freshQuote && BigInt(freshQuote.expectedOutput) < BigInt(minOutAdj)) {
      if ((event as any).trigger_type === 'stop_loss') {
        console.log(`[EXECUTOR] Stop-loss price slipped below initial quote; updating min_amount_out to fresh quote ${freshQuote.minAmountOut} to prioritize exit`);
        minOutAdj = freshQuote.minAmountOut;
      } else {
        throw new Error(
          'Price moved beyond your slippage setting before execution. No transaction was sent — no funds spent. ' +
          'Retry now for a fresh quote, or increase slippage in Settings.'
        );
      }
    }

    // Pre-broadcast budget: all view calls (quote + storage checks + pool lookup)
    // must complete within 12 000 ms of the trade start. If they stack beyond this,
    // throw now — no transaction has been sent, so the user can safely retry.
    const PRE_BROADCAST_BUDGET_MS = 12_000;
    const preBroadcastElapsed = Date.now() - t0;
    if (preBroadcastElapsed > PRE_BROADCAST_BUDGET_MS) {
      throw new Error(
        `Pre-broadcast setup took too long (${preBroadcastElapsed} ms). ` +
        'No transaction was sent — no funds were spent. Please retry.'
      );
    }

    let result: any;

    const isGlobalBuy = token_in === 'wrap.near' || token_in === 'near';
    if (isGlobalBuy && token_out && token_out !== 'near' && token_out !== 'wrap.near') {
      const isRefVenue =
        venue === 'rhea' ||
        venue === 'ref' ||
        venue === 'memecooking' ||
        venue === 'gaypad' ||
        venue === 'kelytra' ||
        venue === 'nearpumpfun';

      // ── SPEED OPTIMIZATION: Parallelize pre-swap registrations and quote checks ──
      const viewFn = this.nearClient.view ? this.nearClient.view.bind(this.nearClient) : near.view.bind(near);
      const usdcPoolId = NEAR_USDC_REF_POOL_ID;
      const usdcQuotePromise = usdcToSwapRaw > 0n
        ? viewFn<string>('v2.ref-finance.near', 'get_return', {
            pool_id: usdcPoolId,
            token_in: NEAR_USDC_CONTRACT,
            amount_in: usdcToSwapRaw.toString(),
            token_out: 'wrap.near',
          }).catch(() => null)
        : Promise.resolve(null);

      await Promise.all([
        ensureStorage(token_out).catch((err: any) => {
          console.warn(`[EXECUTOR] Global pre-swap ensureStorage warning for ${token_out}:`, err?.message);
        }),
        isRefVenue ? ensureRefStorage(subaccountId).catch(() => {}) : Promise.resolve(),
        isRefVenue ? ensureRefTokenRegistered(token_out, subaccountId).catch(() => {}) : Promise.resolve(),
        usdcToSwapRaw > 0n ? (
          (this.nearClient.ensureStorageDeposit
            ? this.nearClient.ensureStorageDeposit(subaccountId, 'wrap.near')
            : near.ensureStorageDeposit(subaccountId, 'wrap.near'))
            .then(() => this.nearClient.markStorageRegistered?.(subaccountId, 'wrap.near'))
            .catch((storageErr: any) => console.warn(`[EXECUTOR] wrap.near storage warning:`, storageErr?.message))
        ) : Promise.resolve(),
        usdcToSwapRaw > 0n ? ensureRefTokenRegistered(NEAR_USDC_CONTRACT, subaccountId).catch(() => {}) : Promise.resolve(),
      ]);

      if (usdcToSwapRaw > 0n) {
        console.log(
          `[EXECUTOR] Converting ${usdcSpentHuman?.toFixed(2)} USDC (${usdcToSwapRaw} raw) -> wrap.near for ${subaccountId} ` +
          `(shortfall=${(Number(nearShortfallFromUsdcYocto) / 1e24).toFixed(4)} NEAR, maxNativeDeposit=${maxNativeDepositYocto !== undefined ? (Number(maxNativeDepositYocto) / 1e24).toFixed(4) : 'unlimited'} NEAR)`
        );

        let expectedWNearFromUsdc = nearShortfallFromUsdcYocto;
        let minWNearFromUsdc = '1';
        const quoteRet = await usdcQuotePromise;
        if (typeof quoteRet === 'string' && /^\d+$/.test(quoteRet) && BigInt(quoteRet) > 0n) {
          expectedWNearFromUsdc = BigInt(quoteRet);
          minWNearFromUsdc = calculateMinAmountOut(expectedWNearFromUsdc, Math.max(userSlippage, 2));
        }

        const preUsdcWNearStr = knownWNearBal.toString();
        // ft_transfer_call on the USDC contract fires 3 cross-contract calls:
        //   1. USDC.ft_transfer_call → 2. Ref.ft_on_transfer (swap) → 3. USDC.ft_resolve_transfer
        // Ref Finance recommends ≥100 Tgas for single-hop swaps routed through ft_transfer_call.
        // 50 Tgas was too tight causing "ran out of gas" on busy blocks or when Ref is under load.
        const USDC_SWAP_GAS = BigInt('100000000000000'); // 100 Tgas (safe for USDC→wNEAR single-hop)
        const usdcSwapActions = [
          transactions.functionCall(
            'ft_transfer_call',
            {
              receiver_id: 'v2.ref-finance.near',
              amount: usdcToSwapRaw.toString(),
              msg: JSON.stringify({
                force: 0,
                actions: [
                  {
                    pool_id: usdcPoolId,
                    token_in: NEAR_USDC_CONTRACT,
                    token_out: 'wrap.near',
                    amount_in: usdcToSwapRaw.toString(),
                    min_amount_out: minWNearFromUsdc,
                  },
                ],
                referral_id: null,
              }),
            },
            USDC_SWAP_GAS,
            BigInt('1')
          ),
        ];
        const usdcSwapOutcome = await signAndSend(NEAR_USDC_CONTRACT, usdcSwapActions, undefined, true);

        // First parse outcome directly from on-chain receipt logs to avoid extra RPC roundtrip
        let usdcCheck = determineSwapOutcome({
          result: usdcSwapOutcome,
          subaccountId,
          isBuy: false,
          tokenOut: 'wrap.near',
          preBalance: preUsdcWNearStr,
          postBalance: null,
        });

        let postUsdcWNearStr: string | null = null;
        if (!usdcCheck.ok || !usdcCheck.netAmountOut) {
          postUsdcWNearStr = await (
            this.nearClient.getTokenBalanceOnTradeRpc
              ? this.nearClient.getTokenBalanceOnTradeRpc('wrap.near', subaccountId)
              : this.nearClient.getTokenBalance('wrap.near', subaccountId)
          ).catch(() => null);

          usdcCheck = determineSwapOutcome({
            result: usdcSwapOutcome,
            subaccountId,
            isBuy: false,
            tokenOut: 'wrap.near',
            preBalance: preUsdcWNearStr,
            postBalance: postUsdcWNearStr,
          });
        }

        if (!usdcCheck.ok) {
          throw new Error(`USDC -> NEAR conversion failed: ${usdcCheck.reason}`);
        }
        // Fast refund guard: If user's initial native balance was already >= 0.22 NEAR,
        // it is guaranteed to still hold >= 0.12 NEAR even after the 0.10 NEAR gas reservation (100 Tgas).
        // In that case, skip polling completely (0ms latency).

        const nativeBalBeforeSwap = capturedNativeBalStr !== null ? BigInt(capturedNativeBalStr) : 0n;
        const alreadyHasSufficientGas = nativeBalBeforeSwap >= BigInt(Math.ceil(0.05 * 1e24));
        if (!alreadyHasSufficientGas && this.nearClient.getNearBalance) {
          const minGasFloorYocto = BigInt(Math.ceil(0.015 * 1e24)); // 0.015 NEAR is sufficient for the second hop
          for (let refundAttempt = 0; refundAttempt < 6; refundAttempt++) {
            const curBalStr = await (
              (this.nearClient as any).getNearBalanceOnTradeRpc
                ? (this.nearClient as any).getNearBalanceOnTradeRpc(subaccountId)
                : this.nearClient.getNearBalance(subaccountId)
            ).catch(() => null);
            if (curBalStr !== null && BigInt(curBalStr) >= minGasFloorYocto) {
              break;
            }
            await new Promise((r) => setTimeout(r, 200));
          }
        }

        if (usdcCheck.netAmountOut && BigInt(usdcCheck.netAmountOut) > 0n) {
          knownWNearBal = isUsdcOnlyMode ? BigInt(usdcCheck.netAmountOut) : knownWNearBal + BigInt(usdcCheck.netAmountOut);
        } else if (postUsdcWNearStr !== null && BigInt(postUsdcWNearStr) > BigInt(preUsdcWNearStr)) {
          knownWNearBal = isUsdcOnlyMode ? BigInt(postUsdcWNearStr) - BigInt(preUsdcWNearStr) : BigInt(postUsdcWNearStr);
        } else {
          knownWNearBal = knownWNearBal + expectedWNearFromUsdc;
        }

        // Re-check native NEAR after storage registrations and USDC swap if native deposit is needed
        if (!isUsdcOnlyMode && maxNativeDepositYocto !== undefined && maxNativeDepositYocto > 0n && this.nearClient.getNearBalance) {
          const postUsdcNativeStr = await (
            (this.nearClient as any).getNearBalanceOnTradeRpc
              ? (this.nearClient as any).getNearBalanceOnTradeRpc(subaccountId)
              : this.nearClient.getNearBalance(subaccountId)
          ).catch(() => null);
          if (postUsdcNativeStr !== null) {
            const postNative = BigInt(postUsdcNativeStr);
            const minGasAfterStorage = BigInt(Math.ceil(0.035 * 1e24));
            const clampedMax = postNative > minGasAfterStorage ? postNative - minGasAfterStorage : 0n;
            if (clampedMax < maxNativeDepositYocto) {
              maxNativeDepositYocto = clampedMax;
            }
          }
        }

        if (maxNativeDepositYocto !== undefined && maxNativeDepositYocto + knownWNearBal < amountInBigInt) {
          const prevAmountIn = amountInBigInt;
          amountInBigInt = maxNativeDepositYocto + knownWNearBal;
          feeAmount = (amountInBigInt * 150n) / 10000n;
          swapAmount = amountInBigInt - feeAmount;
          if (prevAmountIn > 0n && BigInt(minOutAdj || '0') > 0n) {
            const scaledMin = (BigInt(minOutAdj) * amountInBigInt) / prevAmountIn;
            minOutAdj = (scaledMin > 0n ? scaledMin : 1n).toString();
          }
        }

        this.activeTradeWNearState.set(subaccountId, {
          wNearBal: knownWNearBal,
          maxNativeDeposit: maxNativeDepositYocto,
        });

          if (venue === 'intear' && maxNativeDepositYocto !== undefined && amountInBigInt > maxNativeDepositYocto) {
            const unwrapNeeded = amountInBigInt - maxNativeDepositYocto;
            const unwrapAmt = unwrapNeeded <= knownWNearBal ? unwrapNeeded : knownWNearBal;
            if (unwrapAmt > 0n) {
              await signAndSend('wrap.near', [
                transactions.functionCall(
                  'near_withdraw',
                  { amount: unwrapAmt.toString() },
                  BigInt('30000000000000'),
                  BigInt('1')
                ),
              ], 30_000, true);
              knownWNearBal -= unwrapAmt;
              maxNativeDepositYocto += unwrapAmt;
              this.activeTradeWNearState.set(subaccountId, {
                wNearBal: knownWNearBal,
                maxNativeDeposit: maxNativeDepositYocto,
              });
            }
          }
        }
      }

      if (venue === 'nearlytrade') {
        // Resolve the route (direct wNEAR pair or multihop via a non-NEAR quote asset).
        const ntState = preloadedNtState ?? await near.getNearlytradeTokenState(
          token_in === 'wrap.near' || token_in === 'near' ? token_out : token_in
        );
        console.log(
          `[EXECUTOR] NearlyTrade route: token=${token_in === 'wrap.near' || token_in === 'near' ? token_out : token_in}` +
          ` pool=${ntState.pool_id} quote=${ntState.quote} quoteIsNear=${ntState.quoteIsNear} live=${ntState.live}`
        );

        const isBuy = token_in === 'wrap.near' || token_in === 'near';

        if (isBuy) {
          // Ensure storage for token_out (and the quote asset when non-NEAR).
          // Do NOT call ensureStorage('wrap.near') on buy: near_deposit inside
          // buildWrapNearBuyActions registers wrap.near storage atomically, so
          // a separate storage_deposit tx is redundant and causes a neverSeen
          // timeout for new users whose wrap.near account doesn't exist yet.
          await ensureStorage(token_out);

          // Also ensure storage for the quote asset when it's non-NEAR (so hop1 output can land)
          if (!ntState.quoteIsNear) {
            await ensureStorage(ntState.quote);
          }

          if (ntState.quoteIsNear) {
            // ── Direct path: wNEAR → launch token via NearlyTrade DCL (or Rhea if explicitly specified) ──
            const effectiveDclPoolId = dclPoolId || ntState.dclPoolId;
            const explicitRheaPoolId = typeof (event as any).pool_id === 'number' ? (event as any).pool_id : null;

            if (effectiveDclPoolId) {
              // Verify the pool is actually wNEAR-paired
              const poolTokens = effectiveDclPoolId.split('|').slice(0, 2);
              const nonTokenSide = poolTokens.find((t: string) => t !== token_out);
              if (!poolTokens.includes('wrap.near') && !poolTokens.includes('near')) {
                throw new Error(
                  `Token ${token_out} is in a DCL pool paired with ${nonTokenSide}, not NEAR/wNEAR.`
                );
              }
              console.log(`[EXECUTOR] NearlyTrade route=direct-dcl pool=${effectiveDclPoolId}`);
              const actions = await this.buildWrapNearBuyActions(
                subaccountId,
                amountInBigInt,
                feeAmount,
                swapAmount,
                'dclv2.ref-labs.near',
                JSON.stringify({
                  Swap: {
                    pool_ids: [effectiveDclPoolId],
                    output_token: token_out,
                    min_output_amount: minOutAdj,
                    swap_out_recipient: subaccountId,
                  },
                }),
                DEFAULT_SWAP_GAS,
                knownWNearBal
              );
              result = await signAndSend('wrap.near', actions);
            } else if (explicitRheaPoolId) {
              console.log(`[EXECUTOR] NearlyTrade route=direct-rhea pool=${explicitRheaPoolId}`);
              const actions = await this.buildWrapNearBuyActions(
                subaccountId,
                amountInBigInt,
                feeAmount,
                swapAmount,
                'v2.ref-finance.near',
                JSON.stringify({
                  actions: [
                    {
                      pool_id: explicitRheaPoolId,
                      token_in: 'wrap.near',
                      token_out,
                      amount_in: swapAmount.toString(),
                      min_amount_out: minOutAdj,
                      min_output_amount: minOutAdj,
                    },
                  ],
                }),
                undefined,
                knownWNearBal
              );
              result = await signAndSend('wrap.near', actions);
            } else {
              throw new Error(
                `Token ${token_out} is not yet tradable. It's still in the launchpad/bonding phase. Wait for it to bond and create a pool on Rhea or NearlyTrade DCL.`
              );
            }
          } else {
            const route = await near.planNearlytradeRoute(token_out);
            if (route.kind !== 'multihop') throw new Error('Expected multihop route');

            if (route.hop1.type === 'dcl') {
              // Native atomic 2-pool DCL swap: wrap.near -> quote -> token_out in 1 single transaction
              const poolIds = [route.hop1.poolId, route.launchPoolId];
              console.log(
                `[EXECUTOR] NearlyTrade route=atomic-dcl-buy pools=${poolIds.join(' -> ')} minOut=${minOutAdj}`
              );
              const actions = await this.buildWrapNearBuyActions(
                subaccountId,
                amountInBigInt,
                feeAmount,
                swapAmount,
                'dclv2.ref-labs.near',
                JSON.stringify({
                  Swap: {
                    pool_ids: poolIds,
                    output_token: token_out,
                    min_output_amount: minOutAdj,
                    swap_out_recipient: subaccountId,
                  },
                }),
                DEFAULT_SWAP_GAS,
                knownWNearBal
              );
              result = await signAndSend('wrap.near', actions);
            } else {
              // Fallback: Two-transaction path: wNEAR → quote (v2 AMM) → launch token (DCL)
              const minHop1: string = (freshQuote as any)?.minHop1AmountOut ?? '1';

              console.log(
                `[EXECUTOR] NearlyTrade route=two-tx-buy hop1=${route.hop1.type}:${route.hop1.poolId}` +
                ` launchPool=${route.launchPoolId} quote=${route.quote} minHop1=${minHop1} minOut=${minOutAdj}`
              );

              // Ensure quote storage and Ref Finance registration before step 1
              await ensureStorage(route.quote);
              await ensureRefStorage(subaccountId);
              await ensureRefTokenRegistered(route.quote, subaccountId);

              // Tx 1: wNEAR → quote via Ref v2
              let tx1Result: any;
              const tx1Actions = await this.buildWrapNearBuyActions(
                subaccountId,
                amountInBigInt,
                feeAmount,
                swapAmount,
                'v2.ref-finance.near',
                JSON.stringify({
                  actions: [
                    {
                      pool_id: Number(route.hop1.poolId),
                      token_in: 'wrap.near',
                      token_out: route.quote,
                      amount_in: swapAmount.toString(),
                      min_amount_out: minHop1,
                    },
                  ],
                })
              );
              tx1Result = await signAndSend('wrap.near', tx1Actions);

              console.log(`[EXECUTOR] NearlyTrade hop1 tx submitted: txHash=${tx1Result?.transaction?.hash}`);

              // Read how much quote we actually received in the wallet
              let quoteBal = await near.getTokenBalance(route.quote, subaccountId).catch(() => '0');
              let quoteBalBigInt = BigInt(quoteBal || '0');

              // If quote tokens were retained in Ref v2 internal deposit balance, withdraw them to the wallet
              if (quoteBalBigInt <= 0n) {
                const refDeposits = (await near.view<Record<string, string>>('v2.ref-finance.near', 'get_deposits', { account_id: subaccountId }).catch(() => ({} as Record<string, string>))) as Record<string, string>;
                const refQuoteBal = refDeposits?.[route.quote] ? BigInt(refDeposits[route.quote]) : 0n;
                if (refQuoteBal > 0n) {
                  console.log(`[EXECUTOR] Withdrawing ${refQuoteBal} ${route.quote} from Ref internal deposit for ${subaccountId}...`);
                  await near.signAndSendTransactionAll(subaccountId, 'v2.ref-finance.near', [
                    transactions.functionCall(
                      'withdraw',
                      { token_id: route.quote, amount: refQuoteBal.toString(), unregister: false },
                      DEFAULT_SWAP_GAS,
                      BigInt('1')
                    ),
                  ], 30_000);
                  quoteBal = await near.getTokenBalance(route.quote, subaccountId).catch(() => '0');
                  quoteBalBigInt = BigInt(quoteBal || '0');
                }
              }

              if (quoteBalBigInt <= 0n) {
                const quoteMeta = await near.getTokenMetadata(route.quote).catch(() => ({ symbol: route.quote }));
                throw new Error(
                  `Two-transaction buy step 1 succeeded but step 2 was skipped because no ${quoteMeta.symbol} balance was detected. ` +
                  `Your wallet may now hold ${quoteMeta.symbol}. You can sell it back manually.`
                );
              }

              // Tx 2: quote → launch token via launch DCL pool
              let tx2Result: any;
              try {
                const tx2Actions = [
                  transactions.functionCall(
                    'ft_transfer_call',
                    {
                      receiver_id: 'dclv2.ref-labs.near',
                      amount: quoteBalBigInt.toString(),
                      msg: JSON.stringify({
                        Swap: {
                          pool_ids: [route.launchPoolId],
                          output_token: token_out,
                          min_output_amount: minOutAdj,
                        },
                      }),
                    },
                    DEFAULT_SWAP_GAS,
                    BigInt('1')
                  ),
                ];
                tx2Result = await signAndSend(route.quote, tx2Actions);
              } catch (tx2Err: any) {
                const quoteMeta = await near.getTokenMetadata(route.quote).catch(() => ({ symbol: route.quote }));
                // Step 2 failed — do NOT record a fill or position for the launch token.
                // Return a failure reason telling the user about the quote balance.
                const heldAmount = (Number(quoteBalBigInt) / Math.pow(10, ntState.quoteDecimals)).toFixed(6);
                throw new Error(
                  `Two-transaction buy: step 1 (wNEAR → ${quoteMeta.symbol}) succeeded, but step 2 (${quoteMeta.symbol} → ${token_out}) failed: ` +
                  `${tx2Err.message}. Your wallet now holds approximately ${heldAmount} ${quoteMeta.symbol}. You can sell it back.`
                );
              }
              result = tx2Result;
            }
          }
        } else {
          // ── Sell token on Rhea or DCL for wrap.near ────────────────────
          await ensureStorage(token_in);
          await ensureStorage('wrap.near');
          if (!ntState.quoteIsNear) {
            await ensureStorage(ntState.quote);
          }

          if (ntState.quoteIsNear) {
            // Direct sell via NearlyTrade DCL (or Rhea if explicitly specified)
            const effectiveDclPoolId = dclPoolId || ntState.dclPoolId;
            const explicitRheaPoolId = typeof (event as any).pool_id === 'number' ? (event as any).pool_id : null;

            if (effectiveDclPoolId) {
              const actions = [
                transactions.functionCall(
                  'ft_transfer_call',
                  {
                    receiver_id: 'dclv2.ref-labs.near',
                    amount: amountInBigInt.toString(),
                    msg: JSON.stringify({
                      Swap: {
                        pool_ids: [effectiveDclPoolId],
                        output_token: 'wrap.near',
                        min_output_amount: min_amount_out,
                        swap_out_recipient: subaccountId,
                      },
                    }),
                  },
                  DEFAULT_SWAP_GAS,
                  BigInt('1')
                ),
              ];
              result = await signAndSend(token_in, actions);
            } else if (explicitRheaPoolId) {
              const actions = [
                transactions.functionCall(
                  'ft_transfer_call',
                  {
                    receiver_id: 'v2.ref-finance.near',
                    amount: amountInBigInt.toString(),
                    msg: JSON.stringify({
                      actions: [
                        {
                          pool_id: explicitRheaPoolId,
                          token_in,
                          token_out: 'wrap.near',
                          amount_in: amountInBigInt.toString(),
                          min_amount_out: min_amount_out,
                        },
                      ],
                    }),
                  },
                  DEFAULT_SWAP_GAS,
                  BigInt('1')
                ),
              ];
              result = await signAndSend(token_in, actions);
            } else {
              throw new Error(
                `Token ${token_in} is not yet tradable. It's still in the launchpad/bonding phase. Wait for it to bond and create a pool on Rhea or NearlyTrade DCL.`
              );
            }
          } else {
            const route = await near.planNearlytradeRoute(token_in);
            if (route.kind !== 'multihop') throw new Error('Expected multihop route');

            if (route.hop1.type === 'dcl') {
              // Native atomic 2-pool DCL swap: token_in -> quote -> wrap.near in 1 single transaction
              const poolIds = [route.launchPoolId, route.hop1.poolId];
              console.log(
                `[EXECUTOR] NearlyTrade route=atomic-dcl-sell pools=${poolIds.join(' -> ')} minOut=${min_amount_out}`
              );
              const actions = [
                transactions.functionCall(
                  'ft_transfer_call',
                  {
                    receiver_id: 'dclv2.ref-labs.near',
                    amount: amountInBigInt.toString(),
                    msg: JSON.stringify({
                      Swap: {
                        pool_ids: poolIds,
                        output_token: 'wrap.near',
                        min_output_amount: min_amount_out,
                        swap_out_recipient: subaccountId,
                      },
                    }),
                  },
                  DEFAULT_SWAP_GAS,
                  BigInt('1')
                ),
              ];
              result = await signAndSend(token_in, actions);
            } else {
              // Fallback: Two-transaction sell: launch token (DCL) → quote → wNEAR (Ref v2 AMM)
              const minHop1: string = (freshQuote as any)?.minHop1AmountOut ?? '1';

              console.log(
                `[EXECUTOR] NearlyTrade route=two-tx-sell hop1=${route.hop1.type}:${route.hop1.poolId}` +
                ` launchPool=${route.launchPoolId} quote=${route.quote} minHop1=${minHop1} minOut=${min_amount_out}`
              );

              // Ensure storage for quote and wrap.near on wallet, and Ref storage/registration
              await ensureStorage(route.quote);
              await ensureStorage('wrap.near');
              await ensureRefStorage(subaccountId);
              await ensureRefTokenRegistered(route.quote, subaccountId);
              await ensureRefTokenRegistered('wrap.near', subaccountId);

              // Tx 1: launch token → quote via launch DCL pool
              const tx1Actions = [
                transactions.functionCall(
                  'ft_transfer_call',
                  {
                    receiver_id: 'dclv2.ref-labs.near',
                    amount: amountInBigInt.toString(),
                    msg: JSON.stringify({
                      Swap: {
                        pool_ids: [route.launchPoolId],
                        output_token: route.quote,
                        min_output_amount: minHop1,
                      },
                    }),
                  },
                  DEFAULT_SWAP_GAS,
                  BigInt('1')
                ),
              ];
              await signAndSend(token_in, tx1Actions);

              // Read quote balance and forward to Ref for wNEAR
              let quoteBal = await near.getTokenBalance(route.quote, subaccountId).catch(() => '0');
              let quoteBalBigInt = BigInt(quoteBal || '0');
              if (quoteBalBigInt <= 0n) {
                throw new Error(
                  `Two-transaction sell: step 1 (${token_in} → ${route.quote}) succeeded but no ${route.quote} balance detected. Cannot complete step 2.`
                );
              }

              // Re-quote hop 2 with actual quoteBalBigInt received
              const hop2Quote = await near.computeMinAmountOut(
                'ref',
                route.quote,
                'wrap.near',
                quoteBalBigInt.toString(),
                userSlippage,
                Number(route.hop1.poolId)
              ).catch(() => null);
              const minTx2 = hop2Quote ? hop2Quote.minAmountOut : '1';

              const tx2Actions = [
                transactions.functionCall(
                  'ft_transfer_call',
                  {
                    receiver_id: 'v2.ref-finance.near',
                    amount: quoteBalBigInt.toString(),
                    msg: JSON.stringify({
                      actions: [
                        {
                          pool_id: Number(route.hop1.poolId),
                          token_in: route.quote,
                          token_out: 'wrap.near',
                          amount_in: quoteBalBigInt.toString(),
                          min_amount_out: minTx2,
                        },
                      ],
                    }),
                  },
                  DEFAULT_SWAP_GAS,
                  BigInt('1')
                ),
              ];
              try {
                result = await signAndSend(route.quote, tx2Actions);

                // If wNEAR landed in Ref internal deposits, withdraw it to user's wallet
                const refDeposits = (await near.view<Record<string, string>>('v2.ref-finance.near', 'get_deposits', { account_id: subaccountId }).catch(() => ({} as Record<string, string>))) as Record<string, string>;
                const refWnearBal = refDeposits?.['wrap.near'] ? BigInt(refDeposits['wrap.near']) : 0n;
                if (refWnearBal > 0n) {
                  console.log(`[EXECUTOR] Withdrawing ${refWnearBal} wrap.near from Ref internal deposit for ${subaccountId}...`);
                  await near.signAndSendTransactionAll(subaccountId, 'v2.ref-finance.near', [
                    transactions.functionCall(
                      'withdraw',
                      { token_id: 'wrap.near', amount: refWnearBal.toString(), unregister: false },
                      DEFAULT_SWAP_GAS,
                      BigInt('1')
                    ),
                  ], 30_000).catch((e: any) => console.warn('[EXECUTOR] Ref withdraw wrap.near non-fatal:', e?.message));
                }
              } catch (tx2Err: any) {
                const quoteMeta = await near.getTokenMetadata(route.quote).catch(() => ({ symbol: route.quote }));
                const heldAmount = (Number(quoteBalBigInt) / Math.pow(10, ntState.quoteDecimals)).toFixed(4);
                throw new Error(
                  `Two-transaction sell: step 1 (${token_in} → ${quoteMeta.symbol}) succeeded, but step 2 (${quoteMeta.symbol} → NEAR) failed: ` +
                  `${tx2Err.message}. Your wallet holds ${heldAmount} ${quoteMeta.symbol}.`
                );
              }
            }
          }
        }
      } else if (venue === 'rhea' || venue === 'ref' || venue === 'qlyphs') {
        const isBuyTarget = token_in === 'wrap.near' || token_in === 'near';
        const targetTokenQ = isBuyTarget ? token_out : token_in;
        const pinnedSimplePool = (event as any).pool_id ?? (event as any).rhea_pool_id ?? null;

        if (!dclPoolId && (pinnedSimplePool === null || pinnedSimplePool === undefined)) {
          const rhea = await near.findRheaPoolForToken(targetTokenQ).catch(() => null);
          if (rhea && rhea.isDcl && typeof rhea.poolId === 'string') {
            dclPoolId = rhea.poolId;
            if (rhea.intermediateToken) {
              (event as any).intermediate_token = rhea.intermediateToken;
              (event as any).intermediate_pool_id = rhea.intermediatePoolId;
            }
          }
        }

        // Cross-pool guard: a DCL pool chosen upstream (or hunted above) can
        // sit far off the market price with near-zero depth — slippage settings
        // only protect WITHIN a pool, never against trading the WRONG pool.
        // When a simple AMM pool also exists for this pair, quote both with the
        // real swap amount and route through whichever pays out more.
        if (dclPoolId) {
          let simplePoolId: number | null = pinnedSimplePool;
          if (simplePoolId === null || simplePoolId === undefined) {
            simplePoolId = await near.findRheaPoolId('wrap.near', targetTokenQ, true).catch(() => null);
          }
          if (typeof simplePoolId === 'number' && simplePoolId >= 0) {
            const quoteAmount = (isBuyTarget ? swapAmount : amountInBigInt).toString();
            const inTok = isBuyTarget ? 'wrap.near' : token_in;
            const outTok = isBuyTarget ? token_out : 'wrap.near';
            const quotePoolIds = dclPoolId.includes('>')
              ? (isBuyTarget ? dclPoolId.split('>') : dclPoolId.split('>').reverse())
              : (dclPoolId.includes(',')
                ? (isBuyTarget ? dclPoolId.split(',') : dclPoolId.split(',').reverse())
                : [dclPoolId]);
            const [dclOut, simpleOut] = await Promise.all([
              near.view<any>('dclv2.ref-labs.near', 'quote', {
                pool_ids: quotePoolIds,
                input_token: inTok,
                output_token: outTok,
                input_amount: quoteAmount,
              }).then(q => BigInt(q?.amount || '0')).catch(() => 0n),
              near.view<any>('v2.ref-finance.near', 'get_return', {
                pool_id: simplePoolId,
                token_in: inTok,
                amount_in: quoteAmount,
                token_out: outTok,
              }).then(r => BigInt(r || '0')).catch(() => 0n),
            ]);
            if (simpleOut > 0n && simpleOut > dclOut) {
              console.log(
                `[EXECUTOR] DCL pool ${dclPoolId} pays less than simple pool ${simplePoolId} ` +
                `(${dclOut} < ${simpleOut}) — rerouting via simple pool to protect user funds.`
              );
              dclPoolId = null;
              (event as any).pool_id = simplePoolId;
            }
          }
        }
        if (dclPoolId) {
          // Execute Ref DCL swap on dclv2.ref-labs.near
          const isBuy = token_in === 'wrap.near' || token_in === 'near';
          const interToken = (event as any).intermediate_token as string | undefined;
          const interPoolId = (event as any).intermediate_pool_id as number | undefined;

          if (isBuy && interToken && interPoolId) {
            // Two-step DCL buy: wNEAR -> intermediateToken (via Ref AMM simple pool), then intermediateToken -> token_out (via Ref DCL)
            await ensureStorage(interToken);
            const buyActions = await this.buildWrapNearBuyActions(
              subaccountId,
              amountInBigInt,
              feeAmount,
              swapAmount,
              'v2.ref-finance.near',
              JSON.stringify({
                actions: [
                  {
                    pool_id: interPoolId,
                    token_in: 'wrap.near',
                    token_out: interToken,
                    amount_in: swapAmount.toString(),
                    min_amount_out: '0',
                  },
                ],
              }),
              DEFAULT_SWAP_GAS,
              knownWNearBal
            );
            await signAndSend('wrap.near', buyActions);

            const interBal = await near.getTokenBalance(interToken, subaccountId).catch(() => '0');
            const interBalBI = BigInt(interBal || '0');
            if (interBalBI <= 0n) {
              throw new Error(`Step 1 (${token_in} → ${interToken}) succeeded but no balance received for step 2.`);
            }
            await ensureStorage(token_out);
            const tx2Actions = [
              transactions.functionCall(
                'ft_transfer_call',
                {
                  receiver_id: 'dclv2.ref-labs.near',
                  amount: interBalBI.toString(),
                  msg: JSON.stringify({
                    Swap: {
                      pool_ids: [dclPoolId],
                      output_token: token_out,
                      min_output_amount: minOutAdj,
                    },
                  }),
                },
                DEFAULT_SWAP_GAS,
                BigInt('1')
              ),
            ];
            result = await signAndSend(interToken, tx2Actions);
          } else if (!isBuy && interToken && interPoolId) {
            // Two-step DCL sell: token_in -> intermediateToken (via Ref DCL), then intermediateToken -> wrap.near (via Ref AMM simple pool)
            await Promise.all([
              ensureStorage(token_in),
              ensureStorage(interToken),
              ensureStorage('wrap.near'),
            ]);
            const tx1Actions = [
              transactions.functionCall(
                'ft_transfer_call',
                {
                  receiver_id: 'dclv2.ref-labs.near',
                  amount: amountInBigInt.toString(),
                  msg: JSON.stringify({
                    Swap: {
                      pool_ids: [dclPoolId],
                      output_token: interToken,
                      min_output_amount: '0',
                    },
                  }),
                },
                DEFAULT_SWAP_GAS,
                BigInt('1')
              ),
            ];
            await signAndSend(token_in, tx1Actions);

            const interBal = await near.getTokenBalance(interToken, subaccountId).catch(() => '0');
            const interBalBI = BigInt(interBal || '0');
            if (interBalBI <= 0n) {
              throw new Error(`Step 1 (${token_in} → ${interToken}) succeeded but no balance received for step 2.`);
            }
            const tx2Actions = [
              transactions.functionCall(
                'ft_transfer_call',
                {
                  receiver_id: 'v2.ref-finance.near',
                  amount: interBalBI.toString(),
                  msg: JSON.stringify({
                    actions: [
                      {
                        pool_id: interPoolId,
                        token_in: interToken,
                        token_out: 'wrap.near',
                        amount_in: interBalBI.toString(),
                        min_amount_out: min_amount_out,
                      },
                    ],
                  }),
                },
                DEFAULT_SWAP_GAS,
                BigInt('1')
              ),
            ];
            result = await signAndSend(interToken, tx2Actions);
          } else if (isBuy) {
            // Direct DCL buy
            const buyPoolIds = dclPoolId.includes('>')
              ? dclPoolId.split('>')
              : (dclPoolId.includes(',') ? dclPoolId.split(',') : [dclPoolId]);
            const [, actions] = await Promise.all([
              ensureStorage(token_out),
              this.buildWrapNearBuyActions(
                subaccountId,
                amountInBigInt,
                feeAmount,
                swapAmount,
                'dclv2.ref-labs.near',
                JSON.stringify({
                  Swap: {
                    pool_ids: buyPoolIds,
                    output_token: token_out,
                    min_output_amount: minOutAdj,
                    swap_out_recipient: subaccountId,
                  },
                }),
                DEFAULT_SWAP_GAS,
                knownWNearBal
              ),
            ]);

            result = await signAndSend('wrap.near', actions);
          } else {
            // Direct DCL sell
            const sellPoolIds = dclPoolId.includes('>')
              ? dclPoolId.split('>').reverse()
              : (dclPoolId.includes(',') ? dclPoolId.split(',').reverse() : [dclPoolId]);
            await Promise.all([
              ensureStorage(token_in),
              ensureStorage('wrap.near'),
            ]);

            const actions = [
              transactions.functionCall(
                'ft_transfer_call',
                {
                  receiver_id: 'dclv2.ref-labs.near',
                  amount: amountInBigInt.toString(),
                  msg: JSON.stringify({
                    Swap: {
                      pool_ids: sellPoolIds,
                      output_token: 'wrap.near',
                      min_output_amount: min_amount_out,
                      swap_out_recipient: subaccountId,
                    },
                  }),
                },
                DEFAULT_SWAP_GAS,
                BigInt('1')
              ),
            ];

            result = await signAndSend(token_in, actions);
          }
        } else {
          // ── Rhea/Ref non-DCL branch ────────────────────────────────────────
          // SPEED: the independent pre-trade work — Rhea pool resolution, Ref
          // storage registration, token whitelist registration, sell-side
          // storage checks and the wNEAR read inside buildWrapNearBuyActions —
          // all runs in ONE Promise.all instead of sequential awaits. Cache
          // hits return instantly; nothing is skipped on a miss.
          const isBuy = token_in === 'wrap.near' || token_in === 'near';
          const targetToken = isBuy ? token_out : token_in;
          let intermediateToken = (event as any).intermediate_token as string | undefined;
          let intermediatePoolId = (event as any).intermediate_pool_id as number | undefined;

          const preWork = await Promise.all([
            (async (): Promise<number | null> => {
              let rheaPoolId = (event as any).pool_id ?? (event as any).rhea_pool_id;
              if (rheaPoolId === null || rheaPoolId === undefined) {
                try {
                  rheaPoolId = await near.findRheaPoolId(token_in, token_out);
                } catch {
                  const rhea = await near.findRheaPoolForToken(targetToken).catch(() => null);
                  if (rhea && typeof rhea.poolId === 'number') rheaPoolId = rhea.poolId;
                }
              }
              return typeof rheaPoolId === 'number' ? rheaPoolId : null;
            })(),
            ensureRefStorage(subaccountId),
            ensureRefTokenRegistered(targetToken, subaccountId),
            !isBuy ? ensureStorage(token_in) : Promise.resolve(),
            !isBuy ? ensureStorage('wrap.near') : Promise.resolve(),
          ]);

          const rheaPoolId = preWork[0];

          // Intermediate-hop discovery depends on the pool resolution above;
          // it only runs when neither a direct pool nor the intermediate hop was pinned.
          const rheaState = (rheaPoolId || intermediateToken)
            ? null
            : await near.findRheaPoolForToken(targetToken).catch(() => null);

          intermediateToken = intermediateToken || rheaState?.intermediateToken;
          intermediatePoolId = intermediatePoolId || rheaState?.intermediatePoolId;
          if (intermediateToken && isBuy) {
            await ensureStorage(intermediateToken);
          }

          if (rheaPoolId === null || rheaPoolId === undefined) {
            throw new Error(`No active Rhea liquidity pool found for token ${targetToken}.`);
          }

          if (isBuy) {
            const rheaActions = (intermediateToken && intermediatePoolId)
              ? [
                {
                  pool_id: intermediatePoolId,
                  token_in: 'wrap.near',
                  token_out: intermediateToken,
                  amount_in: swapAmount.toString(),
                  min_amount_out: '0',
                },
                {
                  pool_id: rheaPoolId,
                  token_in: intermediateToken,
                  token_out,
                  min_amount_out: minOutAdj,
                },
              ]
              : [
                {
                  pool_id: rheaPoolId,
                  token_in: 'wrap.near',
                  token_out,
                  amount_in: swapAmount.toString(),
                  min_amount_out: minOutAdj,
                  min_output_amount: minOutAdj,
                },
              ];

            const [, actions] = await Promise.all([
              intermediateToken
                ? Promise.all([
                  ensureStorage(token_out),
                  ensureStorage(intermediateToken),
                ])
                : ensureStorage(token_out),
              this.buildWrapNearBuyActions(
                subaccountId,
                amountInBigInt,
                feeAmount,
                swapAmount,
                'v2.ref-finance.near',
                JSON.stringify({ force: 0, actions: rheaActions, referral_id: null }),
                DEFAULT_SWAP_GAS,
                knownWNearBal
              ),
            ]);

            result = await signAndSend('wrap.near', actions);
          } else {
            if (rheaPoolId === null || rheaPoolId === undefined) {
              throw new Error(
                `No Rhea pool found for token pair ${token_in} / wrap.near.`
              );
            }

            await ensureStorage('wrap.near');
            if (intermediateToken) {
              await ensureStorage(intermediateToken);
            }

            const rheaActions = (intermediateToken && intermediatePoolId)
              ? [
                {
                  pool_id: rheaPoolId,
                  token_in,
                  token_out: intermediateToken,
                  amount_in: amountInBigInt.toString(),
                  min_amount_out: '0',
                },
                {
                  pool_id: intermediatePoolId,
                  token_in: intermediateToken,
                  token_out: 'wrap.near',
                  min_amount_out: min_amount_out,
                },
              ]
              : [
                {
                  pool_id: rheaPoolId,
                  token_in,
                  token_out: 'wrap.near',
                  amount_in: amountInBigInt.toString(),
                  min_amount_out: min_amount_out,
                },
              ];

            const actions = [
              transactions.functionCall(
                'ft_transfer_call',
                {
                  receiver_id: 'v2.ref-finance.near',
                  amount: amountInBigInt.toString(),
                  msg: JSON.stringify({ force: 0, actions: rheaActions, referral_id: null }),
                },
                DEFAULT_SWAP_GAS,
                BigInt('1')
              ),
            ];

            result = await signAndSend(token_in, actions);
          }
        }
      } else if (venue === 'intear') {
        const isBuy = token_in === 'wrap.near' || token_in === 'near';
        const targetToken = isBuy ? token_out : token_in;
        const pinnedPoolId = (event as any).pool_id ?? (event as any).rhea_pool_id ?? null;
        const intearState = await near.getIntearTokenState(targetToken).catch(() => null);
        const poolId = (typeof pinnedPoolId === 'number' && pinnedPoolId >= 0)
          ? pinnedPoolId
          : (intearState?.poolId ?? (await near.findIntearPoolId(targetToken).catch(() => null)));
        if (poolId === null || poolId === undefined || typeof poolId !== 'number' || poolId < 0) {
          throw new Error(`No Intear pool found for token ${targetToken}.`);
        }
        const poolBuf = Buffer.alloc(4);
        poolBuf.writeUInt32LE(poolId, 0);
        const poolMsg = poolBuf.toString('base64');

        const pairedAsset = intearState?.pairedAsset ?? 'near';
        const isPairedWithIntear = pairedAsset === 'token.intear.near';

        if (isBuy) {
          await ensureStorage(token_out);

          let operations: any[];
          if (isPairedWithIntear) {
            const intearNearPoolId = (await near.findIntearPoolId('token.intear.near').catch(() => 274)) || 274;
            const intearNearBuf = Buffer.alloc(4);
            intearNearBuf.writeUInt32LE(intearNearPoolId, 0);
            const intearPoolMsg = intearNearBuf.toString('base64');

            operations = [
              {
                SwapSimple: {
                  dex_id: 'slimedragon.near/xyk',
                  asset_in: 'near',
                  asset_out: 'nep141:token.intear.near',
                  amount: { Amount: { ExactIn: swapAmount.toString() } },
                  constraint: null,
                  message: intearPoolMsg,
                },
              },
              {
                SwapSimple: {
                  dex_id: 'slimedragon.near/xyk',
                  asset_in: 'nep141:token.intear.near',
                  asset_out: `nep141:${token_out}`,
                  amount: 'OutputOfLastIn',
                  constraint: minOutAdj && BigInt(minOutAdj) > 0n ? minOutAdj : null,
                  message: poolMsg,
                },
              },
              {
                Withdraw: {
                  asset_id: `nep141:${token_out}`,
                  amount: { Full: { at_least: minOutAdj && BigInt(minOutAdj) > 0n ? minOutAdj : null } },
                  to: null,
                  rescue_address: null,
                },
              },
            ];
          } else {
            operations = [
              {
                SwapSimple: {
                  dex_id: 'slimedragon.near/xyk',
                  asset_in: 'near',
                  asset_out: `nep141:${token_out}`,
                  amount: { Amount: { ExactIn: swapAmount.toString() } },
                  constraint: minOutAdj && BigInt(minOutAdj) > 0n ? minOutAdj : null,
                  message: poolMsg,
                },
              },
              {
                Withdraw: {
                  asset_id: `nep141:${token_out}`,
                  amount: { Full: { at_least: minOutAdj && BigInt(minOutAdj) > 0n ? minOutAdj : null } },
                  to: null,
                  rescue_address: null,
                },
              },
            ];
          }

          // Buy on dex.intear.near
          // dex.intear.near requires the receiving account to have the output asset registered in internal balances
          // for rescue address validation during Withdraw. Batch storage_deposit + register_assets atomically if not yet registered.
          const actions: transactions.Action[] = [];
          const cacheKey = `${subaccountId}:nep141:${token_out}`;
          const isRegisteredOnIntear = intearRegisteredCache.has(cacheKey) || (await near.areIntearAssetsRegistered(subaccountId, [token_out]).catch(() => false));

          if (!isRegisteredOnIntear) {
            const storageBal = await near.getIntearStorageBalance(subaccountId).catch(() => null);
            const available = BigInt(storageBal?.available ?? '0');
            // Minimum deposit on dex.intear.near is 0.005 NEAR (5e21 yocto). Each registered asset costs ~0.001 NEAR.
            if (available < BigInt('2000000000000000000000')) {
              actions.push(
                transactions.functionCall(
                  'storage_deposit',
                  { account_id: subaccountId },
                  BigInt('20000000000000'), // 20 Tgas
                  BigInt('5000000000000000000000') // 0.005 NEAR
                )
              );
            }
            actions.push(
              transactions.functionCall(
                'register_assets',
                { asset_ids: [`nep141:${token_out}`] },
                BigInt('20000000000000'), // 20 Tgas
                BigInt('1') // 1 yocto
              )
            );
          }

          actions.push(
            transactions.functionCall(
              'deposit_near',
              {
                operations: {
                  referrer: 'dex-aggregator.intear.near',
                  operations,
                },
              },
              DEFAULT_SWAP_GAS,
              swapAmount
            )
          );

          result = await signAndSend('dex.intear.near', actions);
          near.markIntearAssetRegistered(subaccountId, token_out);

          if (feeAmount > 0n) {
            try {
              await signAndSend(TREASURY_ACCOUNT_ID, [transactions.transfer(feeAmount)], 10_000, true);
            } catch (err: any) {
              console.warn('[EXECUTOR] Intear fee transfer error:', err?.message);
            }
          }
        } else {
          // Sell token on dex.intear.near
          // Ensure subaccount has 'near' registered on dex.intear.near so Withdraw of 'near' never fails
          await near.ensureIntearAssetRegistered(subaccountId, 'near');
          let operations: any[];
          if (isPairedWithIntear) {
            const intearNearPoolId = (await near.findIntearPoolId('token.intear.near').catch(() => 274)) || 274;
            const intearNearBuf = Buffer.alloc(4);
            intearNearBuf.writeUInt32LE(intearNearPoolId, 0);
            const intearPoolMsg = intearNearBuf.toString('base64');

            operations = [
              {
                SwapSimple: {
                  dex_id: 'slimedragon.near/xyk',
                  asset_in: `nep141:${token_in}`,
                  asset_out: 'nep141:token.intear.near',
                  amount: { Amount: { ExactIn: amountInBigInt.toString() } },
                  constraint: null,
                  message: poolMsg,
                },
              },
              {
                SwapSimple: {
                  dex_id: 'slimedragon.near/xyk',
                  asset_in: 'nep141:token.intear.near',
                  asset_out: 'near',
                  amount: 'OutputOfLastIn',
                  constraint: min_amount_out && BigInt(min_amount_out) > 0n ? min_amount_out : null,
                  message: intearPoolMsg,
                },
              },
              {
                Withdraw: {
                  asset_id: 'near',
                  amount: { Full: { at_least: min_amount_out && BigInt(min_amount_out) > 0n ? min_amount_out : null } },
                  to: null,
                  rescue_address: null,
                },
              },
            ];
          } else {
            operations = [
              {
                SwapSimple: {
                  dex_id: 'slimedragon.near/xyk',
                  asset_in: `nep141:${token_in}`,
                  asset_out: 'near',
                  amount: { Amount: { ExactIn: amountInBigInt.toString() } },
                  constraint: min_amount_out && BigInt(min_amount_out) > 0n ? min_amount_out : null,
                  message: poolMsg,
                },
              },
              {
                Withdraw: {
                  asset_id: 'near',
                  amount: { Full: { at_least: min_amount_out && BigInt(min_amount_out) > 0n ? min_amount_out : null } },
                  to: null,
                  rescue_address: null,
                },
              },
            ];
          }

          const actions = [
            transactions.functionCall(
              'ft_transfer_call',
              {
                receiver_id: 'dex.intear.near',
                amount: amountInBigInt.toString(),
                msg: JSON.stringify({
                  referrer: 'dex-aggregator.intear.near',
                  operations,
                }),
              },
              DEFAULT_SWAP_GAS,
              BigInt('1')
            ),
          ];

          result = await signAndSend(token_in, actions);
        }
      } else if (venue === 'onetokenhub') {
        // OneTokenHub: DCL on dclv2.ref-labs.near with the launch's pool_id
        if (!dclPoolId) {
          const tokenTarget = token_in === 'wrap.near' || token_in === 'near' ? token_out : token_in;
          const hubState = await near.getOneTokenHubState(tokenTarget);
          dclPoolId = hubState.dclPoolId;
        }
        if (!dclPoolId) {
          throw new Error(`No DCL pool found for OneTokenHub token`);
        }

        const isBuy = token_in === 'wrap.near' || token_in === 'near';
        if (isBuy) {
          await ensureStorage(token_out);

          const actions = await this.buildWrapNearBuyActions(
            subaccountId,
            amountInBigInt,
            feeAmount,
            swapAmount,
            'dclv2.ref-labs.near',
            JSON.stringify({
              Swap: {
                pool_ids: [dclPoolId],
                output_token: token_out,
                min_output_amount: minOutAdj,
              },
            })
          );

          result = await signAndSend('wrap.near', actions);
        } else {
          // Sell OneTokenHub token for the paired quote token
          await ensureStorage(token_out);

          const actions = [
            transactions.functionCall(
              'ft_transfer_call',
              {
                receiver_id: 'dclv2.ref-labs.near',
                amount: amountInBigInt.toString(),
                msg: JSON.stringify({
                  Swap: {
                    pool_ids: [dclPoolId],
                    output_token: token_out,
                    min_output_amount: min_amount_out,
                  },
                }),
              },
              DEFAULT_SWAP_GAS,
              BigInt('1')
            ),
          ];

          result = await signAndSend(token_in, actions);
        }
      } else if (venue === 'nearpad') {
        // NEARpad: swaps execute on Ref DCL (dclv2.ref-labs.near)
        if (!dclPoolId) {
          const tokenTarget = token_in === 'wrap.near' || token_in === 'near' ? token_out : token_in;
          const padState = await near.getNEARpadState(tokenTarget).catch(() => null);
          dclPoolId = padState?.dclPoolId ?? (await near.findDclPoolId('wrap.near', tokenTarget).catch(() => null));
        }

        if (dclPoolId) {
          const isBuy = token_in === 'wrap.near' || token_in === 'near';
          if (isBuy) {
            await ensureStorage(token_out);

            const actions = await this.buildWrapNearBuyActions(
              subaccountId,
              amountInBigInt,
              feeAmount,
              swapAmount,
              'dclv2.ref-labs.near',
              JSON.stringify({
                Swap: {
                  pool_ids: [dclPoolId],
                  output_token: token_out,
                  min_output_amount: minOutAdj,
                },
              })
            );

            result = await signAndSend('wrap.near', actions);
          } else {
            // Sell NEARpad token
            await ensureStorage(token_in);
            await ensureStorage('wrap.near');

            const actions = [
              transactions.functionCall(
                'ft_transfer_call',
                {
                  receiver_id: 'dclv2.ref-labs.near',
                  amount: amountInBigInt.toString(),
                  msg: JSON.stringify({
                    Swap: {
                      pool_ids: [dclPoolId],
                      output_token: 'wrap.near',
                      min_output_amount: min_amount_out,
                    },
                  }),
                },
                DEFAULT_SWAP_GAS,
                BigInt('1')
              ),
            ];

            result = await signAndSend(token_in, actions);
          }
        } else {
          throw new Error('DCL pool not found for NEARpad token');
        }
      } else if (venue === 'shoremarkets') {
        const smState = await near.getShoremarketsTokenState(
          token_in === 'wrap.near' || token_in === 'near' ? token_out : token_in
        );
        console.log(
          `[EXECUTOR] ShoreMarkets route: token=${token_in === 'wrap.near' || token_in === 'near' ? token_out : token_in}` +
          ` pool=${smState.pool_id} quote=${smState.quote} quoteIsNear=${smState.quoteIsNear} live=${smState.live}`
        );

        const isBuy = token_in === 'wrap.near' || token_in === 'near';

        if (isBuy) {
          await ensureStorage(token_out);

          const route = await near.planShoremarketsRoute(token_out);

          if (smState.quoteIsNear || route.kind === 'direct') {
            const effectiveDclPoolId = dclPoolId || smState.dclPoolId;
            if (!effectiveDclPoolId) {
              throw new Error(`DCL pool not found for ShoreMarkets token ${token_out}`);
            }
            console.log(`[EXECUTOR] ShoreMarkets route=direct-dcl pool=${effectiveDclPoolId}`);
            const actions = await this.buildWrapNearBuyActions(
              subaccountId,
              amountInBigInt,
              feeAmount,
              swapAmount,
              'dclv2.ref-labs.near',
              JSON.stringify({
                Swap: {
                  pool_ids: [effectiveDclPoolId],
                  output_token: token_out,
                  min_output_amount: minOutAdj,
                },
              }),
              undefined,
              knownWNearBal
            );
            result = await signAndSend('wrap.near', actions);
          } else if (route.hop1.type === 'dcl') {
            // Native atomic 2-pool DCL swap: wrap.near -> quote -> token_out in 1 single transaction
            const poolIds = [route.hop1.poolId, route.launchPoolId];
            console.log(
              `[EXECUTOR] ShoreMarkets route=atomic-dcl-buy pools=${poolIds.join(' -> ')} minOut=${minOutAdj}`
            );
            const actions = await this.buildWrapNearBuyActions(
              subaccountId,
              amountInBigInt,
              feeAmount,
              swapAmount,
              'dclv2.ref-labs.near',
              JSON.stringify({
                Swap: {
                  pool_ids: poolIds,
                  output_token: token_out,
                  min_output_amount: minOutAdj,
                },
              }),
              DEFAULT_SWAP_GAS,
              knownWNearBal
            );
            result = await signAndSend('wrap.near', actions);
          } else {
            await ensureStorage(smState.quote);
            await ensureRefStorage(subaccountId);
            await ensureRefTokenRegistered(route.quote, subaccountId);
            const minHop1: string = (freshQuote as any)?.minHop1AmountOut ?? '1';

            console.log(
              `[EXECUTOR] ShoreMarkets route=two-tx-buy hop1=${route.hop1.type}:${route.hop1.poolId}` +
              ` launchPool=${route.launchPoolId} quote=${route.quote} minHop1=${minHop1} minOut=${minOutAdj}`
            );

            // Tx 1: wNEAR -> quote
            const tx1Actions = await this.buildWrapNearBuyActions(
              subaccountId,
              amountInBigInt,
              feeAmount,
              swapAmount,
              'v2.ref-finance.near',
              JSON.stringify({
                actions: [
                  {
                    pool_id: Number(route.hop1.poolId),
                    token_in: 'wrap.near',
                    token_out: route.quote,
                    amount_in: swapAmount.toString(),
                    min_amount_out: minHop1,
                  },
                ],
              })
            );
            const tx1Result = await signAndSend('wrap.near', tx1Actions);

            console.log(`[EXECUTOR] ShoreMarkets hop1 tx submitted: txHash=${tx1Result?.transaction?.hash}`);

            let quoteBal = await near.getTokenBalance(route.quote, subaccountId).catch(() => '0');
            let quoteBalBigInt = BigInt(quoteBal || '0');

            // If quote tokens were retained in Ref v2 internal deposit balance, withdraw them to the wallet
            if (quoteBalBigInt <= 0n) {
              const refDeposits = (await near.view<Record<string, string>>('v2.ref-finance.near', 'get_deposits', { account_id: subaccountId }).catch(() => ({} as Record<string, string>))) as Record<string, string>;
              const refQuoteBal = refDeposits?.[route.quote] ? BigInt(refDeposits[route.quote]) : 0n;
              if (refQuoteBal > 0n) {
                console.log(`[EXECUTOR] Withdrawing ${refQuoteBal} ${route.quote} from Ref internal deposit for ${subaccountId}...`);
                await near.signAndSendTransactionAll(subaccountId, 'v2.ref-finance.near', [
                  transactions.functionCall(
                    'withdraw',
                    { token_id: route.quote, amount: refQuoteBal.toString(), unregister: false },
                    DEFAULT_SWAP_GAS,
                    BigInt('1')
                  ),
                ], 30_000);
                quoteBal = await near.getTokenBalance(route.quote, subaccountId).catch(() => '0');
                quoteBalBigInt = BigInt(quoteBal || '0');
              }
            }

            if (quoteBalBigInt <= 0n) {
              const quoteMeta = await near.getTokenMetadata(route.quote).catch(() => ({ symbol: route.quote }));
              throw new Error(
                `Two-transaction buy step 1 succeeded but step 2 was skipped because no ${quoteMeta.symbol} balance was detected. ` +
                `Your wallet may now hold ${quoteMeta.symbol}. You can sell it back manually.`
              );
            }

            // Tx 2: quote -> launch token
            let tx2Result: any;
            try {
              const tx2Actions = [
                transactions.functionCall(
                  'ft_transfer_call',
                  {
                    receiver_id: 'dclv2.ref-labs.near',
                    amount: quoteBalBigInt.toString(),
                    msg: JSON.stringify({
                      Swap: {
                        pool_ids: [route.launchPoolId],
                        output_token: token_out,
                        min_output_amount: minOutAdj,
                      },
                    }),
                  },
                  DEFAULT_SWAP_GAS,
                  BigInt('1')
                ),
              ];
              tx2Result = await signAndSend(route.quote, tx2Actions);
            } catch (tx2Err: any) {
              const quoteMeta = await near.getTokenMetadata(route.quote).catch(() => ({ symbol: route.quote }));
              const heldAmount = (Number(quoteBalBigInt) / Math.pow(10, smState.quoteDecimals)).toFixed(6);
              throw new Error(
                `Two-transaction buy: step 1 (wNEAR → ${quoteMeta.symbol}) succeeded, but step 2 (${quoteMeta.symbol} → ${token_out}) failed: ` +
                `${tx2Err.message}. Your wallet now holds approximately ${heldAmount} ${quoteMeta.symbol}. You can sell it back.`
              );
            }
            result = tx2Result;
          }
        } else {
          // Sell ShoreMarkets token
          await ensureStorage(token_in);
          await ensureStorage('wrap.near');

          const route = await near.planShoremarketsRoute(token_in);

          if (smState.quoteIsNear || route.kind === 'direct') {
            const effectiveDclPoolId = dclPoolId || smState.dclPoolId;
            if (!effectiveDclPoolId) {
              throw new Error(`DCL pool not found for ShoreMarkets token ${token_in}`);
            }
            console.log(`[EXECUTOR] ShoreMarkets route=direct-dcl-sell pool=${effectiveDclPoolId}`);
            const actions = [
              transactions.functionCall(
                'ft_transfer_call',
                {
                  receiver_id: 'dclv2.ref-labs.near',
                  amount: amountInBigInt.toString(),
                  msg: JSON.stringify({
                    Swap: {
                      pool_ids: [effectiveDclPoolId],
                      output_token: 'wrap.near',
                      min_output_amount: min_amount_out,
                    },
                  }),
                },
                DEFAULT_SWAP_GAS,
                BigInt('1')
              ),
            ];
            result = await signAndSend(token_in, actions);
          } else if (route.hop1.type === 'dcl') {
            // Native atomic 2-pool DCL swap: token_in -> quote -> wrap.near in 1 single transaction
            const poolIds = [route.launchPoolId, route.hop1.poolId];
            console.log(
              `[EXECUTOR] ShoreMarkets route=atomic-dcl-sell pools=${poolIds.join(' -> ')} minOut=${min_amount_out}`
            );
            const actions = [
              transactions.functionCall(
                'ft_transfer_call',
                {
                  receiver_id: 'dclv2.ref-labs.near',
                  amount: amountInBigInt.toString(),
                  msg: JSON.stringify({
                    Swap: {
                      pool_ids: poolIds,
                      output_token: 'wrap.near',
                      min_output_amount: min_amount_out,
                    },
                  }),
                },
                DEFAULT_SWAP_GAS,
                BigInt('1')
              ),
            ];
            result = await signAndSend(token_in, actions);
          } else {
            await ensureStorage(smState.quote);
            const minHop1: string = (freshQuote as any)?.minHop1AmountOut ?? '1';

            console.log(
              `[EXECUTOR] ShoreMarkets route=two-tx-sell hop1=${route.hop1.type}:${route.hop1.poolId}` +
              ` launchPool=${route.launchPoolId} quote=${route.quote} minHop1=${minHop1} minOut=${min_amount_out}`
            );

            // Ensure storage for quote and wrap.near on wallet, and Ref storage/registration
            await ensureStorage(smState.quote);
            await ensureStorage('wrap.near');
            await ensureRefStorage(subaccountId);
            await ensureRefTokenRegistered(route.quote, subaccountId);
            await ensureRefTokenRegistered('wrap.near', subaccountId);

            // Tx 1: token -> quote
            const tx1Actions = [
              transactions.functionCall(
                'ft_transfer_call',
                {
                  receiver_id: 'dclv2.ref-labs.near',
                  amount: amountInBigInt.toString(),
                  msg: JSON.stringify({
                    Swap: {
                      pool_ids: [route.launchPoolId],
                      output_token: route.quote,
                      min_output_amount: minHop1,
                    },
                  }),
                },
                DEFAULT_SWAP_GAS,
                BigInt('1')
              ),
            ];
            await signAndSend(token_in, tx1Actions);

            let quoteBal = await near.getTokenBalance(route.quote, subaccountId).catch(() => '0');
            let quoteBalBigInt = BigInt(quoteBal || '0');
            if (quoteBalBigInt <= 0n) {
              throw new Error(
                `Two-transaction sell: step 1 (${token_in} → ${route.quote}) succeeded but no ${route.quote} balance detected. Cannot complete step 2.`
              );
            }

            // Tx 2: quote -> wNEAR
            const tx2Actions = [
              transactions.functionCall(
                'ft_transfer_call',
                {
                  receiver_id: 'v2.ref-finance.near',
                  amount: quoteBalBigInt.toString(),
                  msg: JSON.stringify({
                    actions: [
                      {
                        pool_id: Number(route.hop1.poolId),
                        token_in: route.quote,
                        token_out: 'wrap.near',
                        amount_in: quoteBalBigInt.toString(),
                        min_amount_out: min_amount_out,
                      },
                    ],
                  }),
                },
                DEFAULT_SWAP_GAS,
                BigInt('1')
              ),
            ];
            const tx2Result = await signAndSend(route.quote, tx2Actions);

            // If wNEAR landed in Ref internal deposits, withdraw it to user's wallet
            const refDeposits = (await near.view<Record<string, string>>('v2.ref-finance.near', 'get_deposits', { account_id: subaccountId }).catch(() => ({} as Record<string, string>))) as Record<string, string>;
            const refWnearBal = refDeposits?.['wrap.near'] ? BigInt(refDeposits['wrap.near']) : 0n;
            if (refWnearBal > 0n) {
              console.log(`[EXECUTOR] Withdrawing ${refWnearBal} wrap.near from Ref internal deposit for ${subaccountId}...`);
              await near.signAndSendTransactionAll(subaccountId, 'v2.ref-finance.near', [
                transactions.functionCall(
                  'withdraw',
                  { token_id: 'wrap.near', amount: refWnearBal.toString(), unregister: false },
                  DEFAULT_SWAP_GAS,
                  BigInt('1')
                ),
              ], 30_000).catch((e: any) => console.warn('[EXECUTOR] Ref withdraw wrap.near non-fatal:', e?.message));
            }

            result = tx2Result;
          }
        }
      } else if (venue === 'gaypad') {
        const isBuy = token_in === 'wrap.near' || token_in === 'near';
        const targetToken = isBuy ? token_out : token_in;
        // First check if token is on Rhea (Rule 1)
        const rhea = await near.findRheaPoolForToken(targetToken).catch(() => null);
        if (rhea && typeof rhea.poolId === 'number') {
          const rheaPoolId = rhea.poolId;
          const isMultiHopJambo = rhea.intermediateToken === 'jambo-1679.meme-cooking.near';
          if (isBuy) {
            await ensureStorage(token_out);
            const rheaActions = isMultiHopJambo
              ? [
                { pool_id: 6518, token_in: 'wrap.near', token_out: 'jambo-1679.meme-cooking.near', amount_in: swapAmount.toString(), min_amount_out: '0' },
                { pool_id: rheaPoolId, token_in: 'jambo-1679.meme-cooking.near', token_out, min_amount_out: minOutAdj },
              ]
              : [
                { pool_id: rheaPoolId, token_in: 'wrap.near', token_out, amount_in: swapAmount.toString(), min_amount_out: minOutAdj, min_output_amount: minOutAdj },
              ];
            const actions = await this.buildWrapNearBuyActions(
              subaccountId, amountInBigInt, feeAmount, swapAmount,
              'v2.ref-finance.near', JSON.stringify({ actions: rheaActions }), DEFAULT_SWAP_GAS
            );
            result = await signAndSend('wrap.near', actions);
          } else {
            await ensureStorage('wrap.near');
            const rheaActions = isMultiHopJambo
              ? [
                { pool_id: rheaPoolId, token_in, token_out: 'jambo-1679.meme-cooking.near', amount_in: amountInBigInt.toString(), min_amount_out: '0' },
                { pool_id: 6518, token_in: 'jambo-1679.meme-cooking.near', token_out: 'wrap.near', min_amount_out: min_amount_out },
              ]
              : [
                { pool_id: rheaPoolId, token_in, token_out: 'wrap.near', amount_in: amountInBigInt.toString(), min_amount_out: min_amount_out, min_output_amount: min_amount_out },
              ];
            const actions = [
              transactions.functionCall(
                'ft_transfer_call',
                { receiver_id: 'v2.ref-finance.near', amount: amountInBigInt.toString(), msg: JSON.stringify({ actions: rheaActions }) },
                DEFAULT_SWAP_GAS, BigInt('1')
              ),
            ];
            result = await signAndSend(token_in, actions);
          }
        } else {
          // Pre-bonded on Gaypad
          if (isBuy) {
            await ensureStorage(token_out);
            await ensureStorage('jambo-1679.meme-cooking.near');
            // Swap wrap.near -> jambo on Ref, then jambo -> gaypad
            const buyActions = await this.buildWrapNearBuyActions(
              subaccountId, amountInBigInt, feeAmount, swapAmount,
              'v2.ref-finance.near',
              JSON.stringify({
                actions: [
                  { pool_id: 6518, token_in: 'wrap.near', token_out: 'jambo-1679.meme-cooking.near', amount_in: swapAmount.toString(), min_amount_out: '0' },
                ],
              }),
              DEFAULT_SWAP_GAS
            );
            result = await signAndSend('wrap.near', buyActions);
            // Transfer jambo to gaypad.j1-racing.near
            const jamboBal = await near.view<string>('jambo-1679.meme-cooking.near', 'ft_balance_of', { account_id: subaccountId }).catch(() => '0');
            if (BigInt(jamboBal || '0') > 0n) {
              const gpAction = [
                transactions.functionCall(
                  'ft_transfer_call',
                  {
                    receiver_id: 'gaypad.j1-racing.near',
                    amount: jamboBal,
                    msg: JSON.stringify({ token: token_out, min_swap_amount: minOutAdj }),
                  },
                  DEFAULT_SWAP_GAS,
                  BigInt('1')
                ),
              ];
              result = await signAndSend('jambo-1679.meme-cooking.near', gpAction);
            }
          } else {
            await ensureStorage('jambo-1679.meme-cooking.near');
            await ensureStorage('wrap.near');
            // Sell token on gaypad for jambo
            const gpAction = [
              transactions.functionCall(
                'ft_transfer_call',
                {
                  receiver_id: 'gaypad.j1-racing.near',
                  amount: amountInBigInt.toString(),
                  msg: JSON.stringify({ token: 'jambo-1679.meme-cooking.near', min_swap_amount: '0' }),
                },
                DEFAULT_SWAP_GAS,
                BigInt('1')
              ),
            ];
            result = await signAndSend(token_in, gpAction);
            // Then swap jambo to wrap.near via Ref 6518
            const jamboBal = await near.view<string>('jambo-1679.meme-cooking.near', 'ft_balance_of', { account_id: subaccountId }).catch(() => '0');
            if (BigInt(jamboBal || '0') > 0n) {
              const sellJamboAction = [
                transactions.functionCall(
                  'ft_transfer_call',
                  {
                    receiver_id: 'v2.ref-finance.near',
                    amount: jamboBal,
                    msg: JSON.stringify({
                      actions: [
                        { pool_id: 6518, token_in: 'jambo-1679.meme-cooking.near', token_out: 'wrap.near', min_amount_out: min_amount_out },
                      ],
                    }),
                  },
                  DEFAULT_SWAP_GAS,
                  BigInt('1')
                ),
              ];
              result = await signAndSend('jambo-1679.meme-cooking.near', sellJamboAction);
            }
          }
        }
      } else if (venue === 'kelytra') {
        const isBuy = token_in === 'wrap.near' || token_in === 'near';
        const targetToken = isBuy ? token_out : token_in;
        // First check if token has graduated / bonded to Rhea
        const rhea = await near.findRheaPoolForToken(targetToken).catch(() => null);
        if (rhea && typeof rhea.poolId === 'number') {
          const rheaPoolId = rhea.poolId;
          if (isBuy) {
            await ensureStorage(token_out);
            const rheaActions = [
              { pool_id: rheaPoolId, token_in: 'wrap.near', token_out, amount_in: swapAmount.toString(), min_amount_out: minOutAdj, min_output_amount: minOutAdj },
            ];
            const actions = await this.buildWrapNearBuyActions(
              subaccountId, amountInBigInt, feeAmount, swapAmount,
              'v2.ref-finance.near', JSON.stringify({ actions: rheaActions }), DEFAULT_SWAP_GAS
            );
            result = await signAndSend('wrap.near', actions);
          } else {
            await ensureStorage('wrap.near');
            const rheaActions = [
              { pool_id: rheaPoolId, token_in, token_out: 'wrap.near', amount_in: amountInBigInt.toString(), min_amount_out: min_amount_out, min_output_amount: min_amount_out },
            ];
            const actions = [
              transactions.functionCall(
                'ft_transfer_call',
                { receiver_id: 'v2.ref-finance.near', amount: amountInBigInt.toString(), msg: JSON.stringify({ actions: rheaActions }) },
                DEFAULT_SWAP_GAS, BigInt('1')
              ),
            ];
            result = await signAndSend(token_in, actions);
          }
        } else {
          // Pre-bonded on Kelytra bonding curve (exchange.kelytradevs.near)
          const KELYTRA_EXCHANGE = 'exchange.kelytradevs.near';
          const ktState = await near.getKelytraTokenState(targetToken);
          const marketId = ktState.launchId;

          if (isBuy) {
            await ensureStorage(token_out);
            const [regWrap, regToken] = await Promise.all([
              near.view<any>(KELYTRA_EXCHANGE, 'get_balance', { account_id: subaccountId, token_id: 'wrap.near' }).catch(() => null),
              near.view<any>(KELYTRA_EXCHANGE, 'get_balance', { account_id: subaccountId, token_id: token_out }).catch(() => null),
            ]);
            if (!regWrap) {
              await signAndSend(KELYTRA_EXCHANGE, [
                transactions.functionCall('register_balance', { token_id: 'wrap.near', account_id: subaccountId }, BigInt('30000000000000'), BigInt('20000000000000000000000'))
              ]);
            }
            if (!regToken) {
              await signAndSend(KELYTRA_EXCHANGE, [
                transactions.functionCall('register_balance', { token_id: token_out, account_id: subaccountId }, BigInt('30000000000000'), BigInt('20000000000000000000000'))
              ]);
            }

            const buyActions = await this.buildWrapNearBuyActions(
              subaccountId, amountInBigInt, feeAmount, swapAmount,
              KELYTRA_EXCHANGE, 'deposit', DEFAULT_SWAP_GAS
            );
            await signAndSend('wrap.near', buyActions);

            const swapAction = [
              transactions.functionCall(
                'terminal_swap',
                {
                  kind: 'curve',
                  market_id: marketId,
                  direction: true,
                  max_input: swapAmount.toString(),
                  min_out: minOutAdj,
                  deadline: String((Date.now() + 120_000) * 1_000_000),
                },
                BigInt('150000000000000'),
                BigInt('1')
              ),
            ];
            result = await signAndSend(KELYTRA_EXCHANGE, swapAction);

            const outBal = await near.view<any>(KELYTRA_EXCHANGE, 'get_balance', { account_id: subaccountId, token_id: token_out }).catch(() => null);
            const availableOut = outBal?.available || '0';
            if (BigInt(availableOut) > 0n) {
              await signAndSend(KELYTRA_EXCHANGE, [
                transactions.functionCall(
                  'withdraw',
                  { amount: availableOut, token_id: token_out },
                  BigInt('80000000000000'),
                  BigInt('1')
                ),
              ]);
            }
          } else {
            await ensureStorage('wrap.near');
            const [regToken, regWrap] = await Promise.all([
              near.view<any>(KELYTRA_EXCHANGE, 'get_balance', { account_id: subaccountId, token_id: token_in }).catch(() => null),
              near.view<any>(KELYTRA_EXCHANGE, 'get_balance', { account_id: subaccountId, token_id: 'wrap.near' }).catch(() => null),
            ]);
            if (!regToken) {
              await signAndSend(KELYTRA_EXCHANGE, [
                transactions.functionCall('register_balance', { token_id: token_in, account_id: subaccountId }, BigInt('30000000000000'), BigInt('20000000000000000000000'))
              ]);
            }
            if (!regWrap) {
              await signAndSend(KELYTRA_EXCHANGE, [
                transactions.functionCall('register_balance', { token_id: 'wrap.near', account_id: subaccountId }, BigInt('30000000000000'), BigInt('20000000000000000000000'))
              ]);
            }

            const depositAction = [
              transactions.functionCall(
                'ft_transfer_call',
                { receiver_id: KELYTRA_EXCHANGE, amount: amountInBigInt.toString(), msg: 'deposit' },
                BigInt('150000000000000'),
                BigInt('1')
              ),
            ];
            await signAndSend(token_in, depositAction);

            const swapAction = [
              transactions.functionCall(
                'terminal_swap',
                {
                  kind: 'curve',
                  market_id: marketId,
                  direction: false,
                  max_input: amountInBigInt.toString(),
                  min_out: min_amount_out,
                  deadline: String((Date.now() + 120_000) * 1_000_000),
                },
                BigInt('150000000000000'),
                BigInt('1')
              ),
            ];
            result = await signAndSend(KELYTRA_EXCHANGE, swapAction);

            const wrapBal = await near.view<any>(KELYTRA_EXCHANGE, 'get_balance', { account_id: subaccountId, token_id: 'wrap.near' }).catch(() => null);
            const availableWrap = wrapBal?.available || '0';
            if (BigInt(availableWrap) > 0n) {
              await signAndSend(KELYTRA_EXCHANGE, [
                transactions.functionCall(
                  'withdraw',
                  { amount: availableWrap, token_id: 'wrap.near' },
                  BigInt('80000000000000'),
                  BigInt('1')
                ),
              ]);
            }
          }
        }
      } else if (venue === 'nearpumpfun') {
        const isBuy = token_in === 'wrap.near' || token_in === 'near';
        const targetToken = isBuy ? token_out : token_in;

        const rhea = await near.findRheaPoolForToken(targetToken).catch(() => null);
        if (rhea && typeof rhea.poolId === 'number') {
          const rheaPoolId = rhea.poolId;
          if (isBuy) {
            await ensureStorage(token_out);
            const rheaActions = [
              { pool_id: rheaPoolId, token_in: 'wrap.near', token_out, amount_in: swapAmount.toString(), min_amount_out: minOutAdj, min_output_amount: minOutAdj },
            ];
            const actions = await this.buildWrapNearBuyActions(
              subaccountId, amountInBigInt, feeAmount, swapAmount,
              'v2.ref-finance.near', JSON.stringify({ actions: rheaActions }), DEFAULT_SWAP_GAS
            );
            result = await signAndSend('wrap.near', actions);
          } else {
            await ensureStorage('wrap.near');
            const rheaActions = [
              { pool_id: rheaPoolId, token_in, token_out: 'wrap.near', amount_in: amountInBigInt.toString(), min_amount_out: min_amount_out, min_output_amount: min_amount_out },
            ];
            const actions = [
              transactions.functionCall(
                'ft_transfer_call',
                { receiver_id: 'v2.ref-finance.near', amount: amountInBigInt.toString(), msg: JSON.stringify({ actions: rheaActions }) },
                DEFAULT_SWAP_GAS, BigInt('1')
              ),
            ];
            result = await signAndSend(token_in, actions);
          }
        } else {
          const deadlineSec = Math.floor(Date.now() / 1000) + 120;
          if (isBuy) {
            await ensureStorage(token_out);
            if (usdcToSwapRaw > 0n && maxNativeDepositYocto !== undefined && amountInBigInt > maxNativeDepositYocto && knownWNearBal > 0n) {
              const unwrapNeeded = amountInBigInt - maxNativeDepositYocto;
              const unwrapAmt = unwrapNeeded <= knownWNearBal ? unwrapNeeded : knownWNearBal;
              if (unwrapAmt > 0n) {
                await signAndSend('wrap.near', [
                  transactions.functionCall('near_withdraw', { amount: unwrapAmt.toString() }, BigInt('30000000000000'), BigInt('1')),
                ], 30_000, true);
                knownWNearBal -= unwrapAmt;
                maxNativeDepositYocto += unwrapAmt;
                this.activeTradeWNearState.set(subaccountId, { wNearBal: knownWNearBal, maxNativeDeposit: maxNativeDepositYocto });
              }
            }
            const buyActions = [
              transactions.functionCall(
                'buy',
                { min_tokens_out: minOutAdj || '0', deadline_sec: deadlineSec },
                DEFAULT_SWAP_GAS,
                swapAmount
              )
            ];
            result = await signAndSend(token_out, buyActions);
            if (feeAmount > 0n) {
              try {
                await signAndSend(TREASURY_ACCOUNT_ID, [transactions.transfer(feeAmount)], 10_000, true);
              } catch (err: any) {
                console.warn('[EXECUTOR] NearPumpFun fee transfer error:', err?.message);
              }
            }
          } else {
            const sellActions = [
              transactions.functionCall(
                'sell',
                { tokens_in: amountInBigInt.toString(), min_near_out: min_amount_out || '0', deadline_sec: deadlineSec },
                DEFAULT_SWAP_GAS,
                BigInt('1')
              )
            ];
            result = await signAndSend(token_in, sellActions);
          }
        }
      } else if (venue === 'memecooking') {
        const isBuy = token_in === 'wrap.near' || token_in === 'near';
        const targetToken = isBuy ? token_out : token_in;

        const memeId = parseMemeCookingId(targetToken);

        // Check if token is pre-bonded (active auction) or bonded (DEX pool)
        let isPrebonded = false;
        if (memeId !== null) {
          try {
            const meme = await near.view<any>('meme-cooking.near', 'get_meme', { meme_id: memeId }).catch(() => null);
            if (meme) {
              isPrebonded = true;
            }
          } catch { /* no-op */ }
        }

        if (isPrebonded) {
          if (isBuy) {
            const actions = await this.buildWrapNearBuyActions(
              subaccountId,
              amountInBigInt,
              feeAmount,
              swapAmount,
              'meme-cooking.near',
              JSON.stringify({ Deposit: { meme_id: memeId } }),
              DEFAULT_SWAP_GAS
            );

            result = await signAndSend('wrap.near', actions);
          } else {
            const actions = [
              transactions.functionCall(
                'withdraw',
                {
                  meme_id: memeId,
                  amount: amountInBigInt.toString(),
                },
                BigInt('150000000000000'),
                BigInt('0')
              ),
            ];

            result = await signAndSend('meme-cooking.near', actions);
          }
        } else {
          // Bonded phase — trade on Rhea Finance / Ref Finance AMM simple pool or DCL pool
          let rheaPoolId: number | null = (event as any).pool_id ?? null;
          if (!rheaPoolId) {
            try {
              rheaPoolId = await near.findRheaPoolId('wrap.near', targetToken).catch(() => null);
              if (!rheaPoolId && !dclPoolId) {
                dclPoolId = await near.findDclPoolId(token_in, token_out).catch(() => null);
              }
            } catch { /* no-op */ }
          }

          if (rheaPoolId) {
            if (isBuy) {
              const [, actions] = await Promise.all([
                ensureStorage(token_out),
                this.buildWrapNearBuyActions(
                  subaccountId,
                  amountInBigInt,
                  feeAmount,
                  swapAmount,
                  'v2.ref-finance.near',
                  JSON.stringify({
                    actions: [
                      {
                        pool_id: rheaPoolId,
                        token_in: 'wrap.near',
                        token_out,
                        amount_in: swapAmount.toString(),
                        min_amount_out: minOutAdj,
                        min_output_amount: minOutAdj,
                      },
                    ],
                  })
                ),
              ]);

              result = await signAndSend('wrap.near', actions);
            } else {
              const actions = [
                transactions.functionCall(
                  'ft_transfer_call',
                  {
                    receiver_id: 'v2.ref-finance.near',
                    amount: amountInBigInt.toString(),
                    msg: JSON.stringify({
                      actions: [
                        {
                          pool_id: rheaPoolId,
                          token_in,
                          token_out: 'wrap.near',
                          min_amount_out: min_amount_out,
                          min_output_amount: min_amount_out,
                        },
                      ],
                    }),
                  },
                  DEFAULT_SWAP_GAS,
                  BigInt('1')
                ),
              ];

              result = await signAndSend(token_in, actions);
            }
          } else if (dclPoolId) {
            if (isBuy) {
              await ensureStorage(token_out);
              // dclv2.ref-labs.near expects the Swap action wrapper — the same
              // schema the rhea/ref DCL branch uses. The previous flat
              // {pool_id, token_in, token_out} format was rejected by the
              // contract, so bonded Meme.Cooking DCL trades always reverted.
              const actions = await this.buildWrapNearBuyActions(
                subaccountId,
                amountInBigInt,
                feeAmount,
                swapAmount,
                'dclv2.ref-labs.near',
                JSON.stringify({
                  Swap: {
                    pool_ids: [dclPoolId],
                    output_token: token_out,
                    min_output_amount: minOutAdj,
                  },
                })
              );

              result = await signAndSend('wrap.near', actions);
            } else {
              const actions = [
                transactions.functionCall(
                  'ft_transfer_call',
                  {
                    receiver_id: 'dclv2.ref-labs.near',
                    amount: amountInBigInt.toString(),
                    msg: JSON.stringify({
                      Swap: {
                        pool_ids: [dclPoolId],
                        output_token: 'wrap.near',
                        min_output_amount: min_amount_out,
                      },
                    }),
                  },
                  DEFAULT_SWAP_GAS,
                  BigInt('1')
                ),
              ];

              result = await signAndSend(token_in, actions);
            }
          } else {
            throw new Error(`No Rhea or DCL pool found for bonded Meme.Cooking token ${targetToken}.`);
          }
        }
      } else {
        // Shardsmarket
        const isBuy = token_in === 'wrap.near' || token_in === 'near';
        if (isBuy) {
          await ensureStorage(token_out);

          const actions = await this.buildWrapNearBuyActions(
            subaccountId,
            amountInBigInt,
            feeAmount,
            swapAmount,
            token_out,
            JSON.stringify({ min_amount_out: minOutAdj }),
            DEFAULT_SWAP_GAS
          );

          result = await signAndSend('wrap.near', actions);
        } else {
          const actions = [
            transactions.functionCall(
              'ft_transfer_call',
              {
                receiver_id: token_in,
                amount: amountInBigInt.toString(),
                msg: JSON.stringify({ min_amount_out: min_amount_out }),
              },
              DEFAULT_SWAP_GAS,
              BigInt('1')
            ),
          ];

          result = await signAndSend(token_in, actions);
        }
      }

      const txHash = result.transaction.hash;
      console.log(`[EXECUTOR] Direct swap submitted: user=${user_id} venue=${venue} txHash=${txHash}`);

      const isBuy = token_in === 'wrap.near' || token_in === 'near';

      // FIX 3: determine the REAL received amount. The balance delta of the
      // output token (read before signing and again now) is authoritative;
      // parsed receipt logs are a fallback when balance reads are unavailable.
      // The old code fell back to min_amount_out — recording fills for tokens
      // the user never received — and never happens again.
      //
      // FIX 4: the post-trade read goes to the SAME pinned trade RPC that
      // confirmed the transaction, retried briefly. The hedged read RPCs can
      // lag a block behind and return the pre-swap balance, which made
      // successful on-chain swaps look like refunds (delta = 0 → "swap
      // produced no tokens" for a trade the user actually received).
      let postOutBalance: string | null = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        postOutBalance = await near.getTokenBalanceOnTradeRpc(outTokenForBalance, subaccountId).catch(() => null);
        if (postOutBalance !== null) {
          // With a pre-balance to compare against, keep polling until the
          // increase is visible (or the retry budget runs out). Without one,
          // a single read is all we can do — the receipt logs will decide.
          if (capturedPreOutBalance === null || BigInt(postOutBalance) > BigInt(capturedPreOutBalance)) {
            break;
          }
        }
        if (attempt < 3) await new Promise((r) => setTimeout(r, 300));
      }
      const swapOutcome = determineSwapOutcome({
        result,
        subaccountId,
        isBuy,
        tokenOut: token_out,
        preBalance: capturedPreOutBalance,
        postBalance: postOutBalance,
      });

      if (!swapOutcome.ok) {
        const failReason = swapOutcome.reason ?? 'Transaction failed or slippage breach';
        if (swapOutcome.detail) {
          console.warn(`[EXECUTOR] Failure detail txHash=${txHash}:`, swapOutcome.detail);
        }

        // Slippage-breach retry: re-quote with +2pp slippage and try once more.
        // The failed transaction reverted on-chain, so no funds moved; this only
        // rescues trades caught by fast price movement between quote and execution.
        const isSlippageBreach = failReason.startsWith('Slippage too high') || failReason.includes('refunded your input') || failReason.includes('Price moved beyond your slippage setting');
        if (isSlippageBreach && !(event as any).__slippage_retry) {
          const bumpedSlippage = userSlippage + 2;
          const bumpedQuote = await near.computeMinAmountOut(
            venue as any,
            token_in,
            token_out,
            (isBuyPath ? swapAmount : amountInBigInt).toString(),
            bumpedSlippage,
            (event as any).pool_id ?? null,
            dclPoolId
          ).catch(() => null);
          if (bumpedQuote) {
            console.log(`[EXECUTOR] Retrying with ${bumpedSlippage}% slippage (user setting ${userSlippage}%) user=${user_id}`);
            const retryEvent = {
              ...event,
              min_amount_out: bumpedQuote.minAmountOut,
              slippage_pct: bumpedSlippage,
              __slippage_retry: true,
            } as SwapEvent;
            const retryResult = await this.execute(retryEvent).catch(() => null);
            if (retryResult && retryResult.success) {
              return { ...retryResult, reason: `Executed with ${bumpedSlippage}% slippage after price moved.` };
            }
            console.warn(`[EXECUTOR] Slippage-bump retry also failed user=${user_id}`);
          }
        }

        // Storage registration self-healing retry: if the transaction reverted on-chain
        // due to missing storage registration, explicitly register storage and retry trade once
        const isRegistrationFailure =
          failReason.includes('registered with this token contract') ||
          failReason.includes('not registered') ||
          failReason.includes('account is not registered') ||
          failReason.includes('storage deposit');
        if (isRegistrationFailure && !(event as any).__storage_retry) {
          console.log(`[EXECUTOR] Swap reverted on-chain due to missing storage registration. Forcing storage_deposit and retrying trade... user=${user_id}`);
          try {
            if (token_out && token_out !== 'near' && token_out !== 'wrap.near') {
              await near.ensureStorageDeposit(subaccountId, token_out);
            }
            if (
              venue === 'rhea' ||
              venue === 'ref' ||
              venue === 'memecooking' ||
              venue === 'gaypad' ||
              venue === 'kelytra' ||
              venue === 'nearpumpfun'
            ) {
              await ensureRefStorage(subaccountId);
              await ensureRefTokenRegistered(token_out, subaccountId);
            }
            const retryEvent = {
              ...event,
              __storage_retry: true,
            } as SwapEvent;
            const retryResult = await this.execute(retryEvent).catch(() => null);
            if (retryResult && retryResult.success) {
              return { ...retryResult, reason: 'Executed successfully after automatic wallet token registration.' };
            }
          } catch (regErr: any) {
            console.warn(`[EXECUTOR] Automatic storage registration retry failed: ${regErr?.message}`);
          }
        }

        if ((event as any).trigger_id) {
          try {
            const db = await getDb();
            await db.query("UPDATE triggers SET status = 'active' WHERE id = $1", [(event as any).trigger_id]);
            console.log(`[EXECUTOR] Re-armed failed trigger ${(event as any).trigger_id} so it can retry`);
          } catch (rearmErr: any) {
            console.warn('[EXECUTOR] Failed to re-arm trigger:', rearmErr.message);
          }
        }

        console.warn(`[EXECUTOR] Trade failed: txHash=${txHash} reason=${failReason}`);
        await this.notifyUser(user_id, 'trade_failed' as any, {
          txHash,
          reason: failReason,
          token: token_out !== 'near' && token_out !== 'wrap.near' ? token_out : token_in,
          is_sell: token_in !== 'near' && token_in !== 'wrap.near',
          trigger_id: (event as any).trigger_id,
        });
        return { txHash, success: false, reason: failReason };
      }

      const netAmountOut = swapOutcome.netAmountOut!;
      let onChainFeeYocto = feeAmount.toString();

      // Fast sell settlement:
      // When the sell outputs wNEAR (Ref/Rhea/NearlyTrade/etc.), we collect the 1.5% fee
      // directly in wNEAR and skip the slow auto-unwrap transaction entirely!
      // This makes sell execution 2-4 seconds faster.
      // Users can unwrap wNEAR anytime in /wallet or via /unwrap, or use it directly on their next buy.
      if (!isBuy && (venue === 'nearlytrade' || venue === 'rhea' || venue === 'ref' || venue === 'onetokenhub' || venue === 'nearpad' || venue === 'gaypad' || venue === 'memecooking' || venue === 'shoremarkets' || venue === 'kelytra' || venue === 'nearpumpfun' || venue === 'intear') && BigInt(netAmountOut) > 0n) {
        let sellFeeBps = 150n;
        try {
          const nearUsdPrice = await getNearUsdPrice().catch(() => 4.5);
          const proceedsNear = Number(BigInt(netAmountOut)) / 1e24;
          const proceedsUsd = proceedsNear * nearUsdPrice;
          if (proceedsUsd > 200) {
            sellFeeBps = 200n; // 2% fee for sells above $200
          }
        } catch {
          sellFeeBps = 150n;
        }
        const sellFeeNear = (BigInt(netAmountOut) * sellFeeBps) / 10000n;
        let effectiveSellFeeNear = sellFeeNear;
        if (isUsdcOnlyMode) {
          onChainFeeYocto = sellFeeNear.toString();
          const netAfterFeeYocto = BigInt(netAmountOut) > sellFeeNear ? BigInt(netAmountOut) - sellFeeNear : 0n;
          if (netAfterFeeYocto > 0n) {
            try {
              await ensureStorage(NEAR_USDC_CONTRACT).catch((e: any) => console.warn('[EXECUTOR] ensureStorage(USDC) on sell:', e?.message));
              await ensureRefStorage(subaccountId).catch((e: any) => console.warn('[EXECUTOR] ensureRefStorage on USDC sell:', e?.message));
              await ensureRefTokenRegistered(NEAR_USDC_CONTRACT, subaccountId).catch((e: any) => console.warn('[EXECUTOR] ensureRefTokenRegistered(USDC) on sell:', e?.message));

              let paidNativeOnSell = venue === 'intear' || (venue === 'nearpumpfun' && capturedPreOutBalance !== null && postOutBalance !== null && BigInt(postOutBalance) === BigInt(capturedPreOutBalance));
              effectiveSellFeeNear = sellFeeNear;
              let effectiveNetAfterFeeYocto = netAfterFeeYocto;
              let nativeDepositOnSellYocto = BigInt(netAmountOut);
              if (paidNativeOnSell) {
                const currNativeStr = await Promise.resolve(
                  (this.nearClient as any).getNearBalanceOnTradeRpc
                    ? (this.nearClient as any).getNearBalanceOnTradeRpc(subaccountId)
                    : this.nearClient.getNearBalance?.(subaccountId) ?? null
                ).catch(() => null);
                if (currNativeStr !== null) {
                  const currNative = BigInt(currNativeStr);
                  const minGasReserve = BigInt(Math.ceil(0.035 * 1e24));
                  const maxWrap = currNative > minGasReserve ? currNative - minGasReserve : 0n;
                  if (maxWrap < nativeDepositOnSellYocto) {
                    nativeDepositOnSellYocto = maxWrap;
                    effectiveSellFeeNear = (nativeDepositOnSellYocto * sellFeeBps) / 10000n;
                    effectiveNetAfterFeeYocto = nativeDepositOnSellYocto - effectiveSellFeeNear;
                  }
                }
              } else {
                const availWNearStr = postOutBalance ?? (await this.nearClient.getTokenBalance('wrap.near', subaccountId).catch(() => null));
                if (availWNearStr !== null && BigInt(availWNearStr) > 0n && BigInt(availWNearStr) < BigInt(netAmountOut)) {
                  const availWNear = BigInt(availWNearStr);
                  effectiveSellFeeNear = (availWNear * sellFeeBps) / 10000n;
                  effectiveNetAfterFeeYocto = availWNear - effectiveSellFeeNear;
                }
              }
              onChainFeeYocto = effectiveSellFeeNear.toString();
              
              let expectedUsdcRaw = 0n;
              let minUsdcOut = '1';
              try {
                const viewFn = this.nearClient.view ? this.nearClient.view.bind(this.nearClient) : near.view.bind(near);
                const ret = await viewFn<string>('v2.ref-finance.near', 'get_return', {
                  pool_id: NEAR_USDC_REF_POOL_ID,
                  token_in: 'wrap.near',
                  amount_in: effectiveNetAfterFeeYocto.toString(),
                  token_out: NEAR_USDC_CONTRACT,
                });
                if (ret && BigInt(ret) > 0n) {
                  expectedUsdcRaw = BigInt(ret);
                  minUsdcOut = calculateMinAmountOut(expectedUsdcRaw, Math.max(userSlippage, 2));
                }
              } catch { /* fallback to minUsdcOut = '1' */ }

              const preUsdcBalStr = await this.nearClient.getTokenBalance?.(NEAR_USDC_CONTRACT, subaccountId).catch(() => '0') ?? '0';
              const usdcSettleActions: any[] = [];
              if (paidNativeOnSell) {
                usdcSettleActions.push(
                  transactions.functionCall('near_deposit', {}, BigInt('10000000000000'), nativeDepositOnSellYocto)
                );
              }
              if (sellFeeNear > 0n) {
                usdcSettleActions.push(
                  transactions.functionCall(
                    'ft_transfer',
                    { receiver_id: TREASURY_ACCOUNT_ID, amount: effectiveSellFeeNear.toString() },
                    BigInt('20000000000000'),
                    BigInt('1')
                  )
                );
              }
              usdcSettleActions.push(
                transactions.functionCall(
                  'ft_transfer_call',
                  {
                    receiver_id: 'v2.ref-finance.near',
                    amount: effectiveNetAfterFeeYocto.toString(),
                    msg: JSON.stringify({
                      force: 0,
                      actions: [
                        {
                          pool_id: NEAR_USDC_REF_POOL_ID,
                          token_in: 'wrap.near',
                          token_out: NEAR_USDC_CONTRACT,
                          amount_in: effectiveNetAfterFeeYocto.toString(),
                          min_amount_out: minUsdcOut,
                        },
                      ],
                      referral_id: null,
                    }),
                  },
                  DEFAULT_SWAP_GAS,
                  BigInt('1')
                )
              );
              const usdcSettleOutcome = await signAndSend('wrap.near', usdcSettleActions, undefined, true);
              const postUsdcBalStr = await (
                this.nearClient.getTokenBalanceOnTradeRpc
                  ? this.nearClient.getTokenBalanceOnTradeRpc(NEAR_USDC_CONTRACT, subaccountId)
                  : this.nearClient.getTokenBalance(NEAR_USDC_CONTRACT, subaccountId)
              ).catch(() => null);
              const usdcOutCheck = determineSwapOutcome({
                result: usdcSettleOutcome,
                subaccountId,
                isBuy: true,
                tokenOut: NEAR_USDC_CONTRACT,
                preBalance: preUsdcBalStr,
                postBalance: postUsdcBalStr,
              });
              if (postUsdcBalStr !== null && BigInt(postUsdcBalStr) > BigInt(preUsdcBalStr || '0')) {
                const deltaUsdc = BigInt(postUsdcBalStr) - BigInt(preUsdcBalStr || '0');
                usdcReceivedHuman = Number(deltaUsdc) / Math.pow(10, NEAR_USDC_DECIMALS);
              } else if (usdcOutCheck.ok && usdcOutCheck.netAmountOut && BigInt(usdcOutCheck.netAmountOut) > 0n) {
                usdcReceivedHuman = Number(BigInt(usdcOutCheck.netAmountOut)) / Math.pow(10, NEAR_USDC_DECIMALS);
              } else if (usdcOutCheck.ok && expectedUsdcRaw > 0n) {
                usdcReceivedHuman = Number(expectedUsdcRaw) / Math.pow(10, NEAR_USDC_DECIMALS);
              }
              console.log(`[EXECUTOR] Settled sell proceeds into ${usdcReceivedHuman?.toFixed(2)} USDC for ${subaccountId}`);
            } catch (usdcSettleErr: any) {
              console.warn(`[EXECUTOR] USDC sell settlement fallback warning for ${subaccountId} (proceeds remain in wNEAR):`, usdcSettleErr?.message);
            }
          }
        } else if (sellFeeNear > 0n) {
          onChainFeeYocto = sellFeeNear.toString();

          // SPEED OPTIMIZATION:
          // Dispatch the secondary treasury fee transfer in the background without blocking
          // the fill confirmation and user response! This eliminates 5.0s of post-signing latency
          // so sell trades confirm and return in ~5.5s instead of ~11.0s.
          const dispatchFee = async () => {
            try {
              // Query current balances to determine whether to pay via native NEAR or wNEAR
              const [currNativeBalStr, currWNearBalStr] = await Promise.all([
                this.nearClient.getNearBalance?.(subaccountId).catch(() => '0') ?? '0',
                this.nearClient.getTokenBalance('wrap.near', subaccountId).catch(() => '0'),
              ]);
              const currNativeBal = BigInt(currNativeBalStr || '0');
              const currWNearBal = BigInt(currWNearBalStr || '0');

              let paidNativeNear = venue === 'nearpumpfun' || venue === 'intear' || venue === 'kelytra';
              if (capturedPreOutBalance !== null && postOutBalance !== null) {
                const wNearDelta = BigInt(postOutBalance) - BigInt(capturedPreOutBalance);
                if (wNearDelta === 0n) {
                  paidNativeNear = true;
                }
              }
              if (currWNearBal < sellFeeNear && currNativeBal >= sellFeeNear) {
                paidNativeNear = true;
              }

              if (paidNativeNear) {
                try {
                  await signAndSend(TREASURY_ACCOUNT_ID, [transactions.transfer(sellFeeNear)], 10_000, true);
                  console.log(`[EXECUTOR] Sell fee ${sellFeeNear} native NEAR sent to treasury for ${subaccountId}`);
                } catch (nativeErr: any) {
                  console.warn(`[EXECUTOR] Native sell fee failed for ${subaccountId}, attempting wNEAR fallback:`, nativeErr?.message);
                  if (currWNearBal >= sellFeeNear) {
                    try {
                      await signAndSend('wrap.near', [
                        transactions.functionCall(
                          'ft_transfer',
                          { receiver_id: TREASURY_ACCOUNT_ID, amount: effectiveSellFeeNear.toString() },
                          BigInt('20000000000000'),
                          BigInt('1')
                        ),
                      ], 10_000, true);
                      console.log(`[EXECUTOR] Sell fee ${sellFeeNear} wNEAR fallback sent to treasury for ${subaccountId}`);
                    } catch (wNearErr: any) {
                      console.error(`[EXECUTOR] SELL FEE TRANSFER FAILED (both native and wNEAR) for ${subaccountId}:`, wNearErr?.message);
                    }
                  }
                }
              } else {
                try {
                  await signAndSend('wrap.near', [
                    transactions.functionCall(
                      'ft_transfer',
                      { receiver_id: TREASURY_ACCOUNT_ID, amount: effectiveSellFeeNear.toString() },
                      BigInt('20000000000000'),
                      BigInt('1')
                    ),
                  ], 10_000, true);
                  console.log(`[EXECUTOR] Sell fee ${sellFeeNear} wNEAR sent to treasury for ${subaccountId}`);
                } catch (wNearErr: any) {
                  console.warn(`[EXECUTOR] wNEAR sell fee failed for ${subaccountId}, attempting native NEAR fallback:`, wNearErr?.message);
                  try {
                    await signAndSend(TREASURY_ACCOUNT_ID, [transactions.transfer(sellFeeNear)], 10_000, true);
                    console.log(`[EXECUTOR] Sell fee ${sellFeeNear} native NEAR fallback sent to treasury for ${subaccountId}`);
                  } catch (nativeErr: any) {
                    console.error(`[EXECUTOR] SELL FEE TRANSFER FAILED (both wNEAR and native) for ${subaccountId}:`, nativeErr?.message);
                  }
                }
              }
            } catch (feeErr: any) {
              console.error(`[EXECUTOR] Background sell fee dispatch error for ${subaccountId}:`, feeErr?.message);
            }
          };

          dispatchFee().catch(err => console.error(`[EXECUTOR] Uncaught background sell fee error for ${subaccountId}:`, err?.message));
        }
      }

      // Record the fill and update position with real on-chain output
      const fillData = await this.recordFill(
        user_id,
        token_in,
        token_out,
        isGlobalBuy ? amountInBigInt.toString() : amount_in,
        netAmountOut,
        onChainFeeYocto,
        venue,
        txHash,
        event
      ).catch(err => {
        console.error('[EXECUTOR] recordFill error:', err.message);
        return undefined;
      });

      timings.post_ms = Date.now() - (timings.signStart ?? t0) - (timings.sign_ms ?? 0);
      this.activeTradeWNearState.delete(subaccountId);

      return { txHash, success: true, positionId: fillData?.positionId, tokenName: fillData?.tokenName, tokenSymbol: fillData?.tokenSymbol, tokenQty: fillData?.tokenQty, priceNear: fillData?.priceNear, nearSpent: fillData?.nearSpent, usdcSpent: usdcSpentHuman, nearReceived: fillData?.nearReceived, usdcReceived: usdcReceivedHuman, sellPercent: fillData?.sellPercent };
    }

  /**
   * Auto-buy flow: rug check first, then execute.
   * Fail closed — any rug check exception = skip the buy.
   */
  async autoBuy(signal: AutoBuySignal): Promise < { success: boolean; reason?: string } > {
      const { user_id, token_address, amount_near, venue } = signal;

      // Fail closed on unknown/unsupported venue — never guess a swap path
      if(!isTradableVenue(venue)) {
      return { success: false, reason: `unsupported_venue:${venue}` };
    }

    // ── Targeted-snipe bookkeeping (present only on snipe-originated signals) ──
    const snipeOrderId = signal.snipe_order_id;
    const snipeTriggerId = signal.snipe_trigger_id;
    const finalizeSnipe = async (
      success: boolean,
      opts: { error?: string; permanent?: boolean; txHash?: string | null } = {}
    ): Promise<void> => {
      if (!snipeOrderId) return;
      try {
        let triggerAttempts = 1;
        if (snipeTriggerId) {
          if (success) {
            await markSnipeTriggerFilled(snipeTriggerId, opts.txHash ?? null);
          } else {
            const failRes = await markSnipeTriggerFailed(snipeTriggerId, opts.error ?? 'unknown');
            triggerAttempts = failRes.attempts;
          }
        }
        // Token orders are one-shot: resolve them on success or on a PERMANENT
        // failure (rug, bad amount, account error, or max retry attempts reached).
        // Transient failures keep the order armed so a later detection retries.
        // Deployer orders always stay armed for the dev's next launch.
        if (success) {
          await markSnipeOrderResult(snipeOrderId, true);
        } else if (opts.permanent || triggerAttempts >= 5) {
          await markSnipeOrderResult(snipeOrderId, false, opts.error);
        }
      } catch (err) {
        console.warn('[EXECUTOR] Snipe finalize failed:', (err as Error).message);
      }
    };

    // Solana snipes and auto-buys use their own path (Jupiter routes every launch phase).
    if (signal.chain === 'solana' || isSolanaToken(token_address)) {
      return this.autoBuySolana(signal, finalizeSnipe);
    }

    // PRIORITY PATH: rug checks, pool resolution and the user lookup are
    // independent reads — run them concurrently so the snipe fires with the
    // lowest possible latency after the detector signal.
    const [rugResult, poolIds, user] = await Promise.all([
      this.rugCheck(token_address)
        .catch((err) => ({ safe: false, reason: `check_failed: ${(err as Error).message}` }) as { safe: boolean; reason?: string }),
      this.resolveAutoBuyPoolIds(token_address, venue),
      getUserById(user_id).catch(() => null),
    ]);

    if (!rugResult.safe) {
      if (rugResult.reason?.startsWith('honeypot_backdoor:')) {
        console.warn(`[EXECUTOR] 🚨 Hard-blocking honeypot token ${token_address}: ${rugResult.reason}`);
        await this.notifyUser(user_id, 'auto_buy_skipped', { token: token_address, reason: rugResult.reason });
        await finalizeSnipe(false, { error: `honeypot_blocked: ${rugResult.reason}`, permanent: true });
        return { success: false, reason: rugResult.reason };
      }
      if (snipeOrderId) {
        // Targeted snipe: user explicitly chose this target. Do not permanently cancel the order
        // if rugCheck was triggered by an RPC read failure — log and proceed with the snipe.
        console.warn(`[EXECUTOR] Rug check flag for targeted snipe ${token_address}: ${rugResult.reason} — proceeding as user explicitly targeted this token`);
      } else {
        console.log(`[EXECUTOR] Auto-buy skipped for ${token_address}: ${rugResult.reason}`);
        await this.notifyUser(user_id, 'auto_buy_skipped', { token: token_address, reason: rugResult.reason });
        await finalizeSnipe(false, { error: `rug_check: ${rugResult.reason}`, permanent: true });
        return { success: false, reason: rugResult.reason };
      }
    }
    if (poolIds.blocked) {
      // Transient for targeted snipes — the pool may not be live yet; the
      // order stays armed and retries on the next detection (attempt-capped).
      await finalizeSnipe(false, { error: poolIds.blocked });
      return { success: false, reason: poolIds.blocked };
    }
    const { rheaPoolId, dclPoolId } = poolIds;

    // Dynamic slippage calculation: for targeted snipes on new pools, default to at least 15% slippage
    // so initial launch volatility doesn't fail the buy, unless user configured higher.
    const userSlippage = user?.slippage_pct ?? 2;
    const slippagePct = snipeOrderId ? Math.max(userSlippage, 15) : userSlippage;

    const activeWallet = await getActiveWallet(user_id, 'near').catch(() => null);
    let subaccountToCheck = activeWallet?.address || user?.subaccount_id;
    if (activeWallet && !activeWallet.is_imported && user?.subaccount_id && activeWallet.address !== user.subaccount_id) {
      const [activeBalStr, subaccountBalStr, activeUsdcBalStr] = await Promise.all([
        this.nearClient.getNearBalance?.(activeWallet.address).catch(() => '0') ?? '0',
        this.nearClient.getNearBalance?.(user.subaccount_id).catch(() => '0') ?? '0',
        this.nearClient.getTokenBalance?.(NEAR_USDC_CONTRACT, activeWallet.address).catch(() => '0') ?? '0',
      ]);
      if (BigInt(subaccountBalStr || '0') > BigInt(activeBalStr || '0') && BigInt(activeUsdcBalStr || '0') === 0n) {
        subaccountToCheck = user.subaccount_id;
        syncUserActiveWallet(user_id, 'near', user.subaccount_id, user.scoped_key_encrypted).catch(() => { });
      }
    }
    if (!user || !subaccountToCheck) {
      await finalizeSnipe(false, { error: 'user_wallet_not_found', permanent: true });
      return { success: false, reason: 'user_wallet_not_found' };
    }

    // Pre-flight Market Cap ceiling guard (for general auto-buys, skips if token cap exceeds limit)
    if (!snipeOrderId) {
      const maxMcap = user?.auto_buy_max_market_cap_usd != null
        ? parseFloat(user.auto_buy_max_market_cap_usd.toString())
        : 100000;
      if (maxMcap > 0) {
        try {
          const dbCache = await getTokenCache(token_address).catch(() => null);
          const decimals = dbCache?.decimals ?? 18;
          const spot = await this.nearClient.getVenueSpotPrice(
            venue,
            token_address,
            decimals,
            rheaPoolId,
            dclPoolId
          ).catch(() => null);
          if (spot && spot.price > 0 && dbCache?.total_supply) {
            const supply = parseFloat(dbCache.total_supply) / Math.pow(10, decimals);
            const nearUsd = await getNearUsdPrice().catch(() => 0);
            const mcapUsd = spot.price * supply * (nearUsd > 0 ? nearUsd : 5.16);
            if (mcapUsd > maxMcap) {
              const reason = `Token market cap ($${Math.round(mcapUsd).toLocaleString()}) exceeds your max auto-buy limit ($${Math.round(maxMcap).toLocaleString()})`;
              console.log(`[EXECUTOR] Auto-buy skipped for user ${user_id} on ${token_address}: ${reason}`);
              await this.notifyUser(user_id, 'auto_buy_skipped', { token: token_address, reason });
              return { success: false, reason };
            }
          }
        } catch { /* non-fatal pre-flight check */ }
      }
    }

    // Pre-flight balance check: Ensure user actually has spendable balance before executing
    const [nativeBalStr, wNearBalStr, usdcBalStr, autoBuyNearUsd] = await Promise.all([
      this.nearClient.getNearBalance?.(subaccountToCheck).catch(() => '0') ?? '0',
      this.nearClient.getTokenBalance('wrap.near', subaccountToCheck).catch(() => '0'),
      this.nearClient.getTokenBalance?.(NEAR_USDC_CONTRACT, subaccountToCheck).catch(() => '0') ?? '0',
      getNearUsdPrice().catch(() => 5.0),
    ]);

    const nativeBal = BigInt(nativeBalStr || '0');
    const wNearBal = BigInt(wNearBalStr || '0');
    const MIN_RESERVE_YOCTO = 40000000000000000000000n; // 0.04 NEAR reserve (covers gas reserve + storage)
    const availableNative = nativeBal > MIN_RESERVE_YOCTO ? nativeBal - MIN_RESERVE_YOCTO : 0n;
    const usdcBalAuto = BigInt(usdcBalStr || '0');
    const effNearUsdAuto = autoBuyNearUsd > 0 ? autoBuyNearUsd : 5.0;
    const usdcNearYoctoAuto = usdcBalAuto > 0n
      ? BigInt(Math.floor(((Number(usdcBalAuto) / Math.pow(10, NEAR_USDC_DECIMALS)) / effNearUsdAuto) * 0.985 * 1e24))
      : 0n;
    const isUsdcMode = (signal.trade_currency ?? (user as any)?.near_trade_currency) === 'usdc';
    const totalSpendableYocto = isUsdcMode
      ? usdcNearYoctoAuto
      : availableNative + wNearBal + usdcNearYoctoAuto;
    const MIN_SPEND_YOCTO = 10000000000000000000000n; // 0.01 NEAR minimum trade size

    // Must have at least 0.035 native NEAR to pay for gas even if paying with wNEAR / USDC
    if (nativeBal < 35000000000000000000000n || totalSpendableYocto < MIN_SPEND_YOCTO) {
      const availNear = (Number(nativeBal) / 1e24).toFixed(4);
      const reason = isUsdcMode
        ? `Insufficient USDC balance or NEAR for gas. Wallet has ${(Number(usdcBalAuto) / Math.pow(10, NEAR_USDC_DECIMALS)).toFixed(2)} USDC and ${availNear} NEAR (must keep at least 0.04 NEAR for gas reserve).`
        : `Insufficient balance. Wallet has ${availNear} NEAR (must keep at least 0.04 NEAR for gas and storage reserve).`;
      if (snipeOrderId) {
        await finalizeSnipe(false, { error: reason, permanent: true });
        await this.notifyUser(user_id, 'auto_buy_skipped', { token: token_address, reason });
      } else {
        console.warn(`[EXECUTOR] Auto-buy skipped for user ${user_id}: ${reason}`);
      }
      return { success: false, reason };
    }

    let finalInYocto: bigint;
    if (isUsdcMode) {
      const usdcAmt = parseFloat(amount_near);
      if (isNaN(usdcAmt) || usdcAmt <= 0) {
        await finalizeSnipe(false, { error: 'invalid_amount', permanent: true });
        return { success: false, reason: 'invalid_amount' };
      }
      const targetNearAmount = usdcAmt / effNearUsdAuto;
      finalInYocto = BigInt(Math.floor(targetNearAmount * 1e24));
    } else {
      const inYocto = utils.format.parseNearAmount(amount_near) ?? '0';
      finalInYocto = BigInt(inYocto);
    }
    if (finalInYocto <= 0n) {
      await finalizeSnipe(false, { error: 'invalid_amount', permanent: true });
      return { success: false, reason: 'invalid_amount' };
    }

    // Clamp buy amount to available balance so trade succeeds instead of failing on insufficient funds
    if (finalInYocto > totalSpendableYocto) {
      console.log(`[EXECUTOR] Auto-buy user ${user_id} requested ${amount_near} ${isUsdcMode ? 'USDC' : 'NEAR'}, but spendable balance is ${(Number(totalSpendableYocto) / 1e24).toFixed(4)} NEAR. Clamping buy amount.`);
      finalInYocto = totalSpendableYocto;
    }

    // FIX Bug 2: Compute minAmountOut against the SWAP amount (98.5% after 1.5% fee).
    // The executor skims the fee before calling the DEX, so quoting against the full
    // inYocto produces a minAmountOut the DEX can never hit — silently failing every trade.
    const feeYocto = (finalInYocto * 150n) / 10000n;
    const swapYocto = (finalInYocto - feeYocto).toString();

    try {
      const { minAmountOut } = await near.computeMinAmountOut(
        venue as any,
        'wrap.near',
        token_address,
        swapYocto,       // ← post-fee amount that actually reaches the DEX
        slippagePct,
        rheaPoolId,
        dclPoolId
      );

      const swapEvent: SwapEvent = {
        type: 'execute_swap',
        user_id,
        token_in: 'wrap.near',
        token_out: token_address,
        amount_in: finalInYocto.toString(),
        min_amount_out: minAmountOut,
        venue,
        slippage_pct: slippagePct,
        is_snipe: true,
        trade_currency: isUsdcMode ? 'usdc' : 'near',
        timestamp: Date.now(),
      };
      if (rheaPoolId !== null) {
        (swapEvent as any).pool_id = rheaPoolId;
      }
      if (dclPoolId !== null) {
        (swapEvent as any).dcl_pool_id = dclPoolId;
      }
      // PRIORITY: the quote we just computed is fresh — stamp it so execute()
      // skips its redundant pre-flight re-quote (saves a full RPC round-trip).
      (swapEvent as any).quoted_at = Date.now();

      const r = await this.execute(swapEvent);
      const isFatal = !r.success && /insufficient balance|invalid amount|invalid account/i.test(r.reason ?? '');
      await finalizeSnipe(r.success, r.success
        ? { txHash: (r as any).txHash ?? null }
        : { error: r.reason ?? 'execute_returned_failure', permanent: isFatal });
      return { success: r.success, reason: r.reason };
    } catch (err: any) {
      const isFatal = /insufficient balance|invalid amount|invalid account/i.test(err?.message ?? '');
      await finalizeSnipe(false, { error: err.message ?? 'execute_error', permanent: isFatal });
      return { success: false, reason: err.message };
    }
  }

  /**
   * Solana auto-buy / snipe. amount_near carries the SOL amount for Solana
   * signals. Blocks tokens with an active freeze authority (sell can be frozen),
   * clamps to the spendable balance and keeps a small SOL reserve for fees.
   */
  private async autoBuySolana(
    signal: AutoBuySignal,
    finalizeSnipe: (success: boolean, opts?: { error?: string; permanent?: boolean; txHash?: string | null }) => Promise<void>,
  ): Promise<{ success: boolean; reason?: string }> {
    const { user_id, token_address, amount_near } = signal;
    const isSnipe = !!signal.snipe_order_id;

    const [user, safety, info] = await Promise.all([
      getUserById(user_id).catch(() => null),
      checkTokenSafety(token_address).catch(() => null),
      getSolanaTokenInfo(token_address).catch(() => null),
    ]);
    if (!user?.solana_address) {
      await finalizeSnipe(false, { error: 'solana_wallet_not_found', permanent: true });
      return { success: false, reason: 'solana_wallet_not_found' };
    }
    if (safety?.isHoneypot) {
      const reason = `honeypot_backdoor: ${safety.reasons?.[0] || 'freeze authority is active'}`;
      await this.notifyUser(user_id, 'auto_buy_skipped', { token: token_address, reason });
      await finalizeSnipe(false, { error: reason, permanent: true });
      return { success: false, reason };
    }

    const wanted = solToLamports(Number(amount_near));
    if (wanted <= 0n) {
      await finalizeSnipe(false, { error: 'invalid_amount', permanent: true });
      return { success: false, reason: 'invalid_amount' };
    }
    const bal = await getSolanaBalance(user.solana_address, true).catch(() => null);
    const spendable = bal ? (bal.lamports > SOLANA_MIN_RESERVE_LAMPORTS ? bal.lamports - SOLANA_MIN_RESERVE_LAMPORTS : 0n) : wanted;
    const amount = wanted > spendable ? spendable : wanted;
    if (amount < 1_000_000n) {
      const reason = `Insufficient balance. Wallet has ${bal ? lamportsToSol(bal.lamports).toFixed(4) : '0'} SOL (keep at least 0.005 SOL for fees).`;
      await this.notifyUser(user_id, 'auto_buy_skipped', { token: token_address, reason });
      await finalizeSnipe(false, { error: reason, permanent: true });
      return { success: false, reason };
    }

    // New launches move fast: snipes default to at least 15% slippage, like NEAR.
    const userSlippage = Number(user.slippage_pct ?? 2);
    const slippagePct = isSnipe || info?.bondingPhase === 'prebonded' ? Math.max(userSlippage, 15) : Math.max(userSlippage, 2);

    const swapEvent: SwapEvent = {
      type: 'execute_swap',
      chain: 'solana',
      user_id,
      token_in: SOL_MINT,
      token_out: token_address,
      amount_in: amount.toString(),
      min_amount_out: '1',
      venue: 'jupiter',
      slippage_pct: slippagePct,
      is_snipe: isSnipe,
      timestamp: Date.now(),
    };

    try {
      const r = await this.execute(swapEvent);
      await finalizeSnipe(r.success, r.success ? { txHash: r.txHash ?? null } : { error: r.reason ?? 'execute_returned_failure' });
      return { success: r.success, reason: r.reason };
    } catch (err: any) {
      const msg = err?.message ?? 'execute_error';
      const isFatal = /insufficient sol|insufficient balance|invalid amount|wallet not set up/i.test(msg);
      await finalizeSnipe(false, { error: msg, permanent: isFatal });
      throw err; // index.ts sends the trade_failed notice
    }
  }

  /**
   * Resolve executable pool ids for an auto-buy without doing a full quote.
   * Runs concurrently with rugCheck so a snipe fires with minimal latency.
   * Returns `blocked` with a reason when the token has no usable NEAR route.
   */
  private async resolveAutoBuyPoolIds(
    tokenAddress: string,
    venue: AutoBuySignal['venue']
  ): Promise<{ rheaPoolId: number | null; dclPoolId: string | null; blocked?: string }> {
    let rheaPoolId: number | null = null;
    let dclPoolId: string | null = null;

    if (venue === 'nearlytrade') {
      const ntState = await near.getNearlytradeTokenState(tokenAddress).catch(() => null);
      if (!ntState || ntState.priceUnavailable) {
        return { rheaPoolId, dclPoolId, blocked: 'nearlytrade_no_near_route_to_quote' };
      }
      if (ntState.phase === 'prebonded' && !ntState.live) {
        return { rheaPoolId, dclPoolId, blocked: 'nearlytrade_prebonded_excluded_from_autobuy' };
      }
      dclPoolId = ntState.dclPoolId;
    } else if (venue === 'rhea' || venue === 'ref') {
      const dbCache = await getTokenCache(tokenAddress).catch(() => null);
      dclPoolId = dbCache?.dcl_pool_id ?? null;
      if (!dclPoolId) {
        dclPoolId = await near.findDclPoolId('wrap.near', tokenAddress).catch(() => null);
      }
      if (!dclPoolId) {
        rheaPoolId = dbCache?.rhea_pool_id ?? (await near.findRheaPoolId('wrap.near', tokenAddress).catch(() => null));
      }
      if (!dclPoolId && (rheaPoolId === null || rheaPoolId === undefined)) {
        const rheaState = await near.findRheaPoolForToken(tokenAddress, true).catch(() => null);
        if (rheaState) {
          if (rheaState.isDcl) dclPoolId = String(rheaState.poolId);
          else if (typeof rheaState.poolId === 'number') rheaPoolId = rheaState.poolId;
        }
      }
    } else if (venue === 'onetokenhub') {
      const hubState = await near.getOneTokenHubState(tokenAddress).catch(() => null);
      dclPoolId = hubState?.dclPoolId ?? null;
    } else if (venue === 'nearpad') {
      const padState = await near.getNEARpadState(tokenAddress).catch(() => null);
      dclPoolId = padState?.dclPoolId ?? null;
    } else if (venue === 'shoremarkets') {
      const smState = await near.getShoremarketsTokenState(tokenAddress).catch(() => null);
      if (!smState || smState.priceUnavailable) {
        return { rheaPoolId, dclPoolId, blocked: 'shoremarkets_no_near_route_to_quote' };
      }
      dclPoolId = smState.dclPoolId;
    } else if (venue === 'kelytra') {
      const ktState = await near.getKelytraTokenState(tokenAddress).catch(() => null);
      if (!ktState) {
        return { rheaPoolId, dclPoolId, blocked: 'kelytra_token_not_found' };
      }
      if (ktState.phase === 'bonded') {
        const rhea = await near.findRheaPoolForToken(tokenAddress, true).catch(() => null);
        if (rhea) {
          if (rhea.isDcl) dclPoolId = String(rhea.poolId);
          else if (typeof rhea.poolId === 'number') rheaPoolId = rhea.poolId;
        }
      }
      // Prebonded on Kelytra is traded directly on exchange.kelytradevs.near
      return { rheaPoolId, dclPoolId };
    } else if (venue === 'nearpumpfun') {
      const npState = await near.getNearpumpfunTokenState(tokenAddress).catch(() => null);
      if (!npState) {
        return { rheaPoolId, dclPoolId, blocked: 'nearpumpfun_token_not_found' };
      }
      if (npState.phase === 'bonded') {
        const rhea = await near.findRheaPoolForToken(tokenAddress, true).catch(() => null);
        if (rhea) {
          if (rhea.isDcl) dclPoolId = String(rhea.poolId);
          else if (typeof rhea.poolId === 'number') rheaPoolId = rhea.poolId;
        }
      }
      return { rheaPoolId, dclPoolId };
    } else if (venue === 'intear') {
      const dbCache = await getTokenCache(tokenAddress).catch(() => null);
      if (dbCache && dbCache.venue === 'intear' && dbCache.dcl_pool_id) {
        const id = parseInt(dbCache.dcl_pool_id, 10);
        if (!isNaN(id) && id >= 0) rheaPoolId = id;
      }
      if (rheaPoolId === null) {
        rheaPoolId = await near.findIntearPoolId(tokenAddress).catch(() => null);
      }
      if (rheaPoolId !== null && rheaPoolId !== undefined && rheaPoolId >= 0) {
        return { rheaPoolId, dclPoolId: null };
      }
      return { rheaPoolId: null, dclPoolId: null, blocked: 'intear_no_pool_found' };
    }

    if (!rheaPoolId && !dclPoolId) {
      return { rheaPoolId, dclPoolId, blocked: 'no_executable_pool' };
    }
    return { rheaPoolId, dclPoolId };
  }

  // ── Rug / honeypot checks ─────────────────────────────────────────────────

  /**
   * Fast pre-trade sanity checks for auto-buy.
   *
   * NOTE: there is deliberately NO hard liquidity floor here. Liquidity gating
   * is the user's own auto_buy_min_liquidity_near setting, enforced by the
   * detector at signal time. A protocol-side floor blocked every real new
   * launch (bonding curves start with only a few NEAR of liquidity), which is
   * why snipes silently never executed.
   *
   * All reads run in parallel for latency. Fail-closed: if metadata or total
   * supply cannot be read, the token is treated as unsafe.
   */
  private async rugCheck(tokenAddress: string): Promise<{ safe: boolean; reason?: string }> {
    const HOLDER_CONCENTRATION_THRESHOLD = 0.8; // fail if contract holds > 80% of supply

    // Metadata read has no catch — a throw must fail the check (fail-closed).
    const [meta, totalSupplyStr, contractBalance, safety] = await Promise.all([
      near.getTokenMetadata(tokenAddress),
      near.getTokenTotalSupply(tokenAddress).catch(() => null),
      near.getTokenBalance(tokenAddress, tokenAddress).catch(() => null),
      checkTokenSafety(tokenAddress).catch(() => null),
    ]);

    if (safety?.isHoneypot || safety?.isDrained) {
      const dangerReason = safety.reasons[0] || (safety?.isDrained ? 'drained_pool' : `backdoor_methods:${safety.dangerousMethods.join(',')}`);
      return { safe: false, reason: safety?.isDrained ? `drained_pool:${dangerReason}` : `honeypot_backdoor:${dangerReason}` };
    }

    if (!meta?.name || !meta?.symbol) {
      return { safe: false, reason: 'no_metadata' };
    }

    if (!totalSupplyStr) {
      return { safe: false, reason: 'total_supply_check_failed' };
    }

    // Contract holding > 80% of its own supply = never distributed (rug signal).
    const totalSupply = parseFloat(totalSupplyStr);
    if (contractBalance !== null && totalSupply > 0) {
      const contractHolding = parseFloat(contractBalance) / totalSupply;
      if (contractHolding > HOLDER_CONCENTRATION_THRESHOLD) {
        return { safe: false, reason: `contract_holds_${(contractHolding * 100).toFixed(0)}pct` };
      }
    }

    return { safe: true };
  }

  // ── Fill recording ────────────────────────────────────────────────────────

  private async recordFill(
    userId: string,
    tokenIn: string,
    tokenOut: string,
    amountIn: string,
    netAmountOut: string,
    onChainFeeYocto: string,
    venue: string,
    txHash: string,
    _event: SwapEvent,
  ): Promise<{ positionId?: string; tokenName?: string; tokenSymbol?: string; tokenQty?: string; priceNear?: number; nearSpent?: number; nearReceived?: number; sellPercent?: number } | undefined> {
    // Determine buy vs sell direction
    const isBuy = tokenIn === 'wrap.near' || tokenIn === 'near';
    const tokenAddress = isBuy ? tokenOut : tokenIn;

    const meta = await near.getTokenMetadata(tokenAddress).catch(() => ({ decimals: 18 }));
    const decimals = meta?.decimals ?? 18;

    let tokenQty: string;
    let priceNear: number;
    let feePaidNear: number;
    let nearSpent = 0;
    let nearReceived = 0;

    if (isBuy) {
      // For buys: netAmountOut is the actual on-chain token units received
      tokenQty = netAmountOut;
      nearSpent = parseFloat(utils.format.formatNearAmount(amountIn));
      const tokensReceived = parseFloat(netAmountOut) / Math.pow(10, decimals);

      // Fee read directly from on-chain receipt logs
      const parsedFeeNear = parseFloat(utils.format.formatNearAmount(onChainFeeYocto));
      if (!isNaN(parsedFeeNear) && parsedFeeNear > 0) {
        feePaidNear = parsedFeeNear;
      } else {
        feePaidNear = nearSpent * 0.015;
      }

      // Pure DEX execution price (the actual token purchase price on the pool)
      const netNearSwapped = Math.max(0, nearSpent - feePaidNear);
      priceNear = tokensReceived > 0 ? (netNearSwapped / tokensReceived) : 0;
    } else {
      // For sells: amountIn is the token units sold, netAmountOut is yoctoNEAR received
      tokenQty = amountIn;
      nearReceived = parseFloat(utils.format.formatNearAmount(netAmountOut));
      const tokensSold = parseFloat(amountIn) / Math.pow(10, decimals);
      priceNear = tokensSold > 0 ? (nearReceived / tokensSold) : 0;
      feePaidNear = parseFloat(utils.format.formatNearAmount(onChainFeeYocto));
    }

    // Find or create position
    const positions = await getOpenPositions(userId);
    let position = positions.find(p => p.token_address === tokenAddress);
    let sellPercent: number | undefined;
    if (!isBuy && position) {
      const positionQuantity = BigInt(position.quantity_held.split('.')[0] || '0');
      const soldQuantity = BigInt(amountIn.split('.')[0] || '0');
      if (positionQuantity > 0n && soldQuantity > 0n) {
        sellPercent = Math.min(100, Number((soldQuantity * 10000n) / positionQuantity) / 100);
      }
    }

    if (isBuy) {
      if (!position) {
        position = await createPosition({
          user_id: userId,
          token_address: tokenAddress,
          quantity_held: '0',
          avg_entry_price: '0',
        });
      }

      const fillResult = await createFill({
        user_id: userId,
        position_id: position.id,
        side: 'buy',
        token_address: tokenAddress,
        amount: tokenQty,
        price: priceNear.toString(),
        fee_paid: feePaidNear.toString(),
        input_amount: nearSpent.toString(),
        venue,
        tx_hash: txHash,
      });

      // Record fee in ledger and handle referral rewards (only if fill was inserted)
      if (fillResult.inserted) {
        await recordFee(fillResult.fillId, feePaidNear.toString());

        await distributeTradeFeeRewards({
          userId,
          chain: 'near',
          feeAmount: feePaidNear.toString(),
          tokenAddress,
        }).catch((err) => console.warn('[EXECUTOR] Fee distribution error:', err?.message));

        // Season 1 points — idempotent, and must never fail or delay the trade
        try {
          const qtyHumanPts = parseFloat(tokenQty) / Math.pow(10, decimals);
          await awardPointsForTradeFill(userId, fillResult.fillId, txHash, qtyHumanPts * priceNear, new Date());
        } catch (err: any) {
          console.warn('[POINTS] Failed to award points for buy fill:', err.message);
        }

        // NEAR Builders Activity event publication (non-blocking)
        try {
          const userRec = await getUserById(userId);
          const actor = userRec?.subaccount_id;
          if (actor && actor.includes('.')) {
            const isSnipe = _event.is_snipe === true;
            const eventType = isSnipe ? 'snipe.executed' : 'trade.buy';
            const idempotencyKey = isSnipe ? `snipe:${txHash}` : `trade:buy:${txHash}`;
            publishActivityEvent({
              eventType,
              actor,
              idempotencyKey,
              payload: {
                tokenAddress,
                tokenSymbol: (meta as any)?.symbol ?? tokenAddress.slice(0, 8),
                amountNear: nearSpent,
                tokenQty,
                venue,
                txHash,
              },
            }).catch(() => { });
          }
        } catch (err: any) {
          console.warn('[ACTIVITY] Error publishing buy event:', err?.message || err);
        }

        // Broadcast buy alert for Telegram groups tracking this token
        try {
          const nearUsdRate = await getNearUsdPrice().catch(() => 0);
          const effectiveRate = nearUsdRate > 0 ? nearUsdRate : 5.16;
          const spentUsd = nearSpent * effectiveRate;
          const userRec = await getUserById(userId);
          // subaccount_id is the on-chain NEAR address; fall back to 'unknown' (not UUID) for display
          const buyerAddress = userRec?.subaccount_id || 'unknown';
          const tokenName = (meta as any)?.name ?? tokenAddress;
          const tokenSymbol = (meta as any)?.symbol ?? tokenAddress.slice(0, 8);
          const tokensRecvHuman = (parseFloat(tokenQty) / Math.pow(10, decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 });

          // Compute market cap: price × total supply.
          // ft_metadata() does NOT include total_supply — must call ft_total_supply() separately.
          let marketCapUsd: number | undefined;
          try {
            const totalSupplyRaw = await this.nearClient.getTokenTotalSupply(tokenAddress).catch(() => null);
            if (totalSupplyRaw && priceNear > 0) {
              const totalSupplyHuman = parseFloat(totalSupplyRaw) / Math.pow(10, decimals);
              marketCapUsd = Math.round(totalSupplyHuman * priceNear * nearUsdRate);
            }
          } catch { /* non-fatal */ }

          // Fetch buyer's NEAR balance so groups can gauge whale size.
          // Use already-imported static utils (no dynamic import needed — near-api-js is already imported).
          let buyerNearBalance: number | undefined;
          if (buyerAddress && buyerAddress !== 'unknown') {
            try {
              const rawBal = await this.nearClient.getNearBalance(buyerAddress).catch(() => null);
              if (rawBal) {
                buyerNearBalance = parseFloat(utils.format.formatNearAmount(rawBal, 4));
              }
            } catch { /* non-fatal */ }
          }

          const buyAlert: BuyAlertEvent = {
            type: 'buy_alert',
            chain: 'near',
            token_address: tokenAddress,
            token_name: tokenName,
            token_symbol: tokenSymbol,
            buyer_address: buyerAddress,
            spent_amount_native: `${nearSpent.toFixed(2)} NEAR`,
            spent_usd: Math.round(spentUsd * 100) / 100,
            tokens_received: `${tokensRecvHuman} ${tokenSymbol}`,
            price_usd: priceNear * nearUsdRate,
            market_cap_usd: marketCapUsd,
            buyer_near_balance: buyerNearBalance,
            tx_hash: txHash,
            timestamp: Date.now(),
          };
          await (this.redisClient ?? redis).publish(CHANNELS.BUY_ALERT, JSON.stringify(buyAlert));
        } catch (alertErr: any) {
          console.warn('[EXECUTOR] Failed to publish NEAR buy alert:', alertErr?.message);
        }

        // Instant buy confirmation — use only data already computed above, no new RPC calls.
        // Skipped for API-initiated manual trades (notify_user === false): the
        // API sends its own success message, publishing here would duplicate it.
        if (_event.notify_user !== false) {
          try {
            const nearSpentHuman = parseFloat(utils.format.formatNearAmount(amountIn));
            const tokenQtyHuman = (parseFloat(tokenQty) / Math.pow(10, decimals)).toString();
            await this.notifyUser(userId, 'trade_confirmed', {
              tokenName: (meta as any)?.name ?? tokenAddress,
              tokenSymbol: (meta as any)?.symbol ?? tokenAddress.slice(0, 8),
              tokenQty: tokenQtyHuman,
              priceNear: priceNear,
              nearSpent: nearSpentHuman,
              feePaidNear,
              positionId: position.id,
              txHash,
            });
          } catch (err: any) {
            console.warn('[EXECUTOR] Failed to send trade_confirmed notification:', err.message);
          }
        }
      }

    } else {
      if (!position) {
        position = await createPosition({
          user_id: userId,
          token_address: tokenAddress,
          quantity_held: tokenQty,
          avg_entry_price: priceNear.toString(),
        });
      }

      const fillResult = await createFill({
        user_id: userId,
        position_id: position.id,
        side: 'sell',
        token_address: tokenAddress,
        amount: tokenQty,
        price: priceNear.toString(),
        fee_paid: feePaidNear.toString(),
        input_amount: nearReceived.toString(),
        venue,
        tx_hash: txHash,
      });

      // Record fee in ledger and handle referral rewards (only if fill was inserted)
      if (fillResult.inserted) {
        await recordFee(fillResult.fillId, feePaidNear.toString());

        await distributeTradeFeeRewards({
          userId,
          chain: 'near',
          feeAmount: feePaidNear.toString(),
          tokenAddress,
        }).catch((err) => console.warn('[EXECUTOR] Fee distribution error:', err?.message));

        // Season 1 points — idempotent, and must never fail or delay the trade
        try {
          const qtyHumanPts = parseFloat(tokenQty) / Math.pow(10, decimals);
          await awardPointsForTradeFill(userId, fillResult.fillId, txHash, qtyHumanPts * priceNear, new Date());
        } catch (err: any) {
          console.warn('[POINTS] Failed to award points for sell fill:', err.message);
        }

        // NEAR Builders Activity event publication (non-blocking)
        try {
          const userRec = await getUserById(userId);
          const actor = userRec?.subaccount_id;
          if (actor && actor.includes('.')) {
            publishActivityEvent({
              eventType: 'trade.sell',
              actor,
              idempotencyKey: `trade:sell:${txHash}`,
              payload: {
                tokenAddress,
                tokenSymbol: (meta as any)?.symbol ?? tokenAddress.slice(0, 8),
                amountNear: nearReceived,
                tokenQty,
                venue,
                txHash,
              },
            }).catch(() => { });
          }
        } catch (err: any) {
          console.warn('[ACTIVITY] Error publishing sell event:', err?.message || err);
        }

        // Notify user with PNL card summary and link (exact on-chain math)
        try {
          const updatedPos = await getPositionById(position.id);
          const avgEntry = parseFloat(position.avg_entry_price);
          const sellPrice = priceNear;
          const qty = parseFloat(tokenQty) / Math.pow(10, decimals);
          const costBasis = qty * avgEntry;
          const netProceeds = nearReceived - feePaidNear;
          const netPnlNear = netProceeds - costBasis;
          const pnlPct = costBasis > 0 ? (netPnlNear / costBasis) * 100 : 0;
          const duration = formatHoldDuration(position.opened_at, Date.now());

          await this.notifyUser(userId, 'pnl_card', {
            tokenName: (meta as any)?.name || tokenAddress,
            tokenTicker: (meta as any)?.symbol || tokenAddress.slice(0, 8),
            tokenSymbol: (meta as any)?.symbol || tokenAddress.slice(0, 8),
            entryPrice: avgEntry,
            exitPrice: sellPrice,
            currentPrice: sellPrice,
            quantity: qty,
            positionSize: qty,
            realizedPnlNear: netPnlNear,
            realizedPnlPercent: pnlPct,
            profitAmount: netPnlNear,
            pnlPercent: pnlPct,
            holdDuration: duration,
            duration,
            positionId: position.id,
            status: updatedPos?.status || 'closed',
          });
        } catch (err: any) {
          console.warn('[EXECUTOR] Failed to send pnl_card notification:', err.message);
        }
      }
    }
    if (isBuy) {
      const nearSpentHuman = parseFloat(utils.format.formatNearAmount(amountIn));
      const tokenQtyHuman = (parseFloat(tokenQty) / Math.pow(10, decimals)).toString();
      return {
        positionId: position?.id,
        tokenName: (meta as any)?.name ?? tokenAddress,
        tokenSymbol: (meta as any)?.symbol ?? tokenAddress.slice(0, 8),
        tokenQty: tokenQtyHuman,
        priceNear,
        nearSpent: nearSpentHuman,
      };
    }
    const tokenQtyHuman = parseFloat(tokenQty) / Math.pow(10, decimals);
    return {
      positionId: position?.id,
      tokenName: (meta as any)?.name ?? tokenAddress,
      tokenSymbol: (meta as any)?.symbol ?? tokenAddress.slice(0, 8),
      tokenQty: tokenQtyHuman.toString(),
      priceNear,
      nearReceived,
      sellPercent,
    };
  }

  // ── Notifications ─────────────────────────────────────────────────────────

  private async notifyUser(userId: string, eventType: NotifyUserEvent['event'], data?: Record<string, unknown>): Promise<void> {
    const user = await getUserById(userId);
    if (!user) return;
    const notify: NotifyUserEvent = {
      type: 'notify_user',
      telegram_id: user.telegram_id,
      event: eventType,
      data,
    };
    await (this.redisClient ?? redis).publish(CHANNELS.NOTIFY_USER, JSON.stringify(notify));
  }
}
