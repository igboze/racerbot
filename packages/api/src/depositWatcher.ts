import type { Telegraf } from 'telegraf';
import { getFreeNear, getSuiBalance, getSuiUsdPrice, getStarknetBalance, createLogger } from '@racerbot/shared';
import { getDb, getUserByTelegramId, getUserById, updateUserLastBalances, type UserRecord } from '@racerbot/db';
import { getNearUsdPrice, ensureUserSuiWallet, unwrapUserWrapNear } from './wallet.js';
import { notifyDeposit, notifyTokenDeposit } from './notify.js';

const logger = createLogger('deposit-watcher');

interface UserBalanceState {
  nativeNear: number;
  wrapNear: number;
  totalNear: number;
  totalSui: number;
  totalStrk: number;
  trackedNearAddress?: string;
  trackedSuiAddress?: string;
  trackedStarknetAddress?: string;
  initialized: boolean;
}

// In-memory balance tracker for fast change detection
const userBalanceState = new Map<string, UserBalanceState>();

interface TradeCooldownInfo {
  until: number;
  chain: string;
  proceeds: number;
}

// Cooldown tracker to prevent swap sell proceeds from triggering deposit alerts
const tradeCooldownMap = new Map<string, TradeCooldownInfo>();

// Active user tracking: users active within last 30m are polled frequently; idle users are staggered
const activeUserMap = new Map<string, number>();
let idleUserIndex = 0;

let watcherInterval: NodeJS.Timeout | null = null;
let isPolling = false;

/**
 * Mark a user as active (e.g. opened wallet, deposited, traded, or tapped menu).
 * Active users get high-cadence deposit monitoring (every 6s) for 30 minutes.
 */
export function markUserActiveForDeposit(userIdOrTelegramId: string | number): void {
  const key = String(userIdOrTelegramId);
  activeUserMap.set(key, Date.now() + 30 * 60 * 1000); // 30 minutes active window
}

/**
 * Record that a user performed a DEX sell, preventing proceeds
 * from being misidentified as external incoming deposits.
 */
export function recordUserTrade(
  userIdOrTelegramId: string | number,
  chain: 'near' | 'sui' | 'starknet' = 'near',
  proceeds = 0
): void {
  const key = String(userIdOrTelegramId);
  tradeCooldownMap.set(key, {
    until: Date.now() + 30_000, // 30s cooldown is sufficient for DEX fills
    chain,
    proceeds,
  });
  markUserActiveForDeposit(key);
}

/**
 * Check recent sell proceeds for a user on a specific chain.
 * Returns 0 if not in cooldown.
 */
function getRecentSellProceeds(
  userId: string,
  telegramId: number,
  chain: 'near' | 'sui' | 'starknet'
): number {
  const now = Date.now();
  const byUid = tradeCooldownMap.get(userId);
  if (byUid && now < byUid.until && byUid.chain === chain) {
    return byUid.proceeds;
  }
  const byTid = tradeCooldownMap.get(String(telegramId));
  if (byTid && now < byTid.until && byTid.chain === chain) {
    return byTid.proceeds;
  }
  return 0;
}

/**
 * Format USD values cleanly.
 */
function formatUSD(val: number): string {
  if (val >= 1000) return `$${(val / 1000).toFixed(2)}K`;
  if (val >= 1) return `$${val.toFixed(2)}`;
  return `$${val.toFixed(4)}`;
}

/**
 * Process deposit detection for a single user.
 */
async function processUserDeposit(
  user: UserRecord,
  near: ReturnType<typeof getFreeNear>,
  nearUsd: number,
  suiUsd: number,
  strkUsd: number
): Promise<void> {
  const userId = user.id;
  const telegramId = user.telegram_id;
  const subaccount = user.subaccount_id;
  const suiAddr = user.sui_address;
  const starknetAddr = user.starknet_address;

  // 1. Fetch NEAR native + wrap balances with isolated error handling.
  let currentNativeNear: number | null = null;
  let currentWrapNear: number | null = null;

  if (subaccount) {
    try {
      const [resNative, resWrap] = await Promise.allSettled([
        near.getNearBalance(subaccount),
        near.view<string>('wrap.near', 'ft_balance_of', { account_id: subaccount }),
      ]);

      if (resNative.status === 'fulfilled' && resNative.value) {
        currentNativeNear = Number(BigInt(resNative.value) / 1000000000000000000n) / 1e6;
      }
      if (resWrap.status === 'fulfilled' && resWrap.value) {
        currentWrapNear = Number(BigInt(resWrap.value) / 1000000000000000000n) / 1e6;
      }
    } catch {
      // Ignore transient NEAR RPC error
    }
  }

  // 2. Fetch SUI balance if SUI address exists (isolated error handling)
  let currentSui: number | null = null;
  if (suiAddr) {
    try {
      const suiBal = await getSuiBalance(suiAddr).catch(() => null);
      if (suiBal) {
        currentSui = suiBal.sui;
      }
    } catch {
      // Ignore transient SUI RPC error
    }
  }

  // 3. Fetch Starknet STRK balance if Starknet address exists (isolated error handling)
  let currentStrk: number | null = null;
  if (starknetAddr) {
    try {
      const starkBal = await getStarknetBalance(starknetAddr).catch(() => null);
      if (starkBal) {
        currentStrk = Number(starkBal.strk) / 1e18;
      }
    } catch {
      // Ignore transient Starknet RPC error
    }
  }

  const stateKey = userId;
  let prev = userBalanceState.get(stateKey);

  // Detect wallet address change (e.g. user imported or switched active wallet)
  const isNearAddressChanged = Boolean(prev && subaccount && prev.trackedNearAddress && prev.trackedNearAddress !== subaccount);
  const isSuiAddressChanged = Boolean(prev && suiAddr && prev.trackedSuiAddress && prev.trackedSuiAddress !== suiAddr);
  const isStarknetAddressChanged = Boolean(prev && starknetAddr && prev.trackedStarknetAddress && prev.trackedStarknetAddress !== starknetAddr);

  if (!prev || isNearAddressChanged || isSuiAddressChanged || isStarknetAddressChanged) {
    // If the active wallet address changed, reset baseline directly to new wallet's balance — do NOT fire fake deposit alerts!
    if (isNearAddressChanged || isSuiAddressChanged || isStarknetAddressChanged) {
      prev = {
        nativeNear: currentNativeNear ?? prev?.nativeNear ?? 0,
        wrapNear: currentWrapNear ?? prev?.wrapNear ?? 0,
        totalNear: (currentNativeNear ?? prev?.nativeNear ?? 0) + (currentWrapNear ?? prev?.wrapNear ?? 0),
        totalSui: currentSui ?? prev?.totalSui ?? 0,
        totalStrk: currentStrk ?? prev?.totalStrk ?? 0,
        trackedNearAddress: subaccount ?? undefined,
        trackedSuiAddress: suiAddr ?? undefined,
        trackedStarknetAddress: starknetAddr ?? undefined,
        initialized: true,
      };
      userBalanceState.set(stateKey, prev);
      updateUserLastBalances(userId, {
        near: prev.totalNear,
        sui: prev.totalSui,
        strk: prev.totalStrk,
      }).catch(() => {});
      return;
    }

    // Check if DB already has recorded balances from earlier runs or across restarts
    if (user.last_near_balance !== null && user.last_near_balance !== undefined) {
      prev = {
        nativeNear: Number(user.last_near_balance),
        wrapNear: 0,
        totalNear: Number(user.last_near_balance),
        totalSui: Number(user.last_sui_balance ?? 0),
        totalStrk: Number(user.last_strk_balance ?? 0),
        trackedNearAddress: subaccount ?? undefined,
        trackedSuiAddress: suiAddr ?? undefined,
        trackedStarknetAddress: starknetAddr ?? undefined,
        initialized: true,
      };
      userBalanceState.set(stateKey, prev);
    } else {
      // Initial baseline establishment: record current on-chain balance and NEVER fire an alert for existing funds
      const initNat = currentNativeNear ?? 0;
      const initWrap = currentWrapNear ?? 0;
      prev = {
        nativeNear: initNat,
        wrapNear: initWrap,
        totalNear: initNat + initWrap,
        totalSui: currentSui ?? 0,
        totalStrk: currentStrk ?? 0,
        trackedNearAddress: subaccount ?? undefined,
        trackedSuiAddress: suiAddr ?? undefined,
        trackedStarknetAddress: starknetAddr ?? undefined,
        initialized: true,
      };
      userBalanceState.set(stateKey, prev);

      updateUserLastBalances(userId, {
        near: prev.totalNear,
        sui: prev.totalSui,
        strk: prev.totalStrk,
      }).catch(() => {});

      // Baseline initialized: always return and await future deposits
      return;
    }
  }

  // Preserve previous balance if current individual read failed (prevents false 0-drops and looping re-alerts)
  const resolvedNativeNear = currentNativeNear !== null ? currentNativeNear : prev.nativeNear;
  const resolvedWrapNear = currentWrapNear !== null ? currentWrapNear : prev.wrapNear;
  const currentTotalNear = resolvedNativeNear + resolvedWrapNear;

  // ── Check NEAR Deposit ──────────────────────────────────────────
  if (subaccount && (currentNativeNear !== null || currentWrapNear !== null)) {
    const nearDelta = currentTotalNear - prev.totalNear;
    const sellProceeds = getRecentSellProceeds(userId, telegramId, 'near');
    const isTradeProceeds = sellProceeds > 0 && Math.abs(nearDelta - sellProceeds) < 0.05;

    // Real balance increase threshold of at least 0.02 NEAR to filter gas refund/staking dust
    if (nearDelta >= 0.02 && !isTradeProceeds) {
      const depositAmount = sellProceeds > 0 && nearDelta > sellProceeds ? (nearDelta - sellProceeds) : nearDelta;
      if (depositAmount >= 0.02) {
        const usdVal = formatUSD(depositAmount * nearUsd);
        logger.info('NEAR deposit detected', {
          telegramId,
          amount: depositAmount.toFixed(4),
          usdVal,
        });

        // Safety Net Dual Auto-Unwrap: If user has wrapNear from multichain deposit, unwrap automatically
        if (currentWrapNear !== null && currentWrapNear >= 0.005) {
          // Record unwrap cooldown for 60 seconds so shifting from wNEAR to native NEAR doesn't trigger a secondary delta alert
          recordUserTrade(userId, 'near', currentWrapNear);
          unwrapUserWrapNear(telegramId).catch((err: any) => {
            logger.warn('Deposit watcher auto-unwrap wNEAR failed', { telegramId, error: err?.message });
          });
        }

        await notifyDeposit(telegramId, {
          chain: 'near',
          amount: depositAmount.toFixed(4),
          symbol: 'NEAR',
          address: subaccount,
          usdValue: usdVal,
        }).catch((err) => logger.warn('Failed to send NEAR deposit notify', { error: err.message }));
      }
    }
  }

  // ── Check SUI Deposit ───────────────────────────────────────────
  if (currentSui !== null && suiAddr) {
    const suiDelta = currentSui - prev.totalSui;
    const sellProceeds = getRecentSellProceeds(userId, telegramId, 'sui');
    const isTradeProceeds = sellProceeds > 0 && Math.abs(suiDelta - sellProceeds) < 0.05;

    if (suiDelta >= 0.01 && !isTradeProceeds) {
      const depositAmount = sellProceeds > 0 && suiDelta > sellProceeds ? (suiDelta - sellProceeds) : suiDelta;
      if (depositAmount >= 0.01) {
        const usdVal = formatUSD(depositAmount * suiUsd);
        logger.info('SUI deposit detected', {
          telegramId,
          amount: depositAmount.toFixed(4),
          usdVal,
        });

        await notifyDeposit(telegramId, {
          chain: 'sui',
          amount: depositAmount.toFixed(4),
          symbol: 'SUI',
          address: suiAddr,
          usdValue: usdVal,
        }).catch((err) => logger.warn('Failed to send SUI deposit notify', { error: err.message }));
      }
    }
  }

  // ── Check Starknet Deposit ──────────────────────────────────────
  if (currentStrk !== null && starknetAddr) {
    const strkDelta = currentStrk - prev.totalStrk;
    const sellProceeds = getRecentSellProceeds(userId, telegramId, 'starknet');
    const isTradeProceeds = sellProceeds > 0 && Math.abs(strkDelta - sellProceeds) < 0.1;

    if (strkDelta >= 0.1 && !isTradeProceeds) {
      const depositAmount = sellProceeds > 0 && strkDelta > sellProceeds ? (strkDelta - sellProceeds) : strkDelta;
      if (depositAmount >= 0.1) {
        const usdVal = formatUSD(depositAmount * strkUsd);
        logger.info('Starknet STRK deposit detected', {
          telegramId,
          amount: depositAmount.toFixed(4),
          usdVal,
        });

        await notifyDeposit(telegramId, {
          chain: 'starknet',
          amount: depositAmount.toFixed(4),
          symbol: 'STRK',
          address: starknetAddr,
          usdValue: usdVal,
        }).catch((err) => logger.warn('Failed to send Starknet deposit notify', { error: err.message }));
      }
    }
  }

  // Protection against RPC zero-glitches: If balance dropped to 0 from > 0.05 without a trade/withdrawal,
  // do NOT update the baseline down to 0, because the next poll will falsely interpret the real balance as a deposit!
  const isLikelyRpcZeroGlitch = currentTotalNear === 0 && prev.totalNear >= 0.05 && getRecentSellProceeds(userId, telegramId, 'near') === 0;

  // Update stored baseline (preserve previous balance if current query failed or returned a zero glitch)
  const newTotalNear = isLikelyRpcZeroGlitch ? prev.totalNear : currentTotalNear;
  const newTotalSui = currentSui ?? prev.totalSui;
  const newTotalStrk = currentStrk ?? prev.totalStrk;

  userBalanceState.set(stateKey, {
    nativeNear: isLikelyRpcZeroGlitch ? prev.nativeNear : resolvedNativeNear,
    wrapNear: isLikelyRpcZeroGlitch ? prev.wrapNear : resolvedWrapNear,
    totalNear: newTotalNear,
    totalSui: newTotalSui,
    totalStrk: newTotalStrk,
    trackedNearAddress: subaccount ?? prev.trackedNearAddress,
    trackedSuiAddress: suiAddr ?? prev.trackedSuiAddress,
    trackedStarknetAddress: starknetAddr ?? prev.trackedStarknetAddress,
    initialized: true,
  });

  // Persist balance changes to database for durability across restarts
  const balanceUpdates: { near?: number; sui?: number; strk?: number } = {};
  if (currentNativeNear !== null || currentWrapNear !== null) {
    if (newTotalNear !== prev.totalNear) balanceUpdates.near = newTotalNear;
  }
  if (currentSui !== null && newTotalSui !== prev.totalSui) {
    balanceUpdates.sui = newTotalSui;
  }
  if (currentStrk !== null && newTotalStrk !== prev.totalStrk) {
    balanceUpdates.strk = newTotalStrk;
  }

  if (Object.keys(balanceUpdates).length > 0) {
    updateUserLastBalances(userId, balanceUpdates).catch(() => {});
  }
}

/**
 * On-demand deposit check for a specific user (e.g. called from /wallet or wallet_refresh).
 */
export async function checkUserDepositNow(telegramIdOrUserId: number | string): Promise<void> {
  try {
    const user = typeof telegramIdOrUserId === 'number'
      ? await getUserByTelegramId(telegramIdOrUserId)
      : await getUserById(telegramIdOrUserId);

    if (!user) return;
    markUserActiveForDeposit(user.id);

    const near = getFreeNear();
    const [nearUsd, suiUsd] = await Promise.all([
      getNearUsdPrice().catch(() => 5.16),
      getSuiUsdPrice().catch(() => 2.0),
    ]);
    const strkUsd = 0.40;

    await processUserDeposit(user, near, nearUsd, suiUsd, strkUsd);
  } catch (err: any) {
    logger.warn('Failed on-demand user deposit check', { error: err?.message });
  }
}

/**
 * Poll balances for users using free resilient NEAR multi-RPC endpoints.
 * Active users (interacted in last 30m) are checked every tick (every 6s);
 * idle users are staggered in batches to maintain zero API credit consumption.
 */
export async function pollUserDeposits(): Promise<void> {
  if (isPolling) return;
  isPolling = true;

  try {
    const db = await getDb();
    const result = await db.query<UserRecord>(
      'SELECT id, telegram_id, subaccount_id, sui_address, starknet_address, scoped_key_encrypted, sui_private_key_enc, last_near_balance, last_sui_balance, last_strk_balance, created_at FROM users'
    );

    const allUsers = result.rows;
    if (!allUsers || allUsers.length === 0) {
      isPolling = false;
      return;
    }

    const now = Date.now();
    const activeUsers: UserRecord[] = [];
    const idleUsers: UserRecord[] = [];

    for (const u of allUsers) {
      const expUid = activeUserMap.get(u.id) || 0;
      const expTid = activeUserMap.get(String(u.telegram_id)) || 0;
      if (now < expUid || now < expTid) {
        activeUsers.push(u);
      } else {
        idleUsers.push(u);
      }
    }

    // Always poll all active users + a staggered batch of up to 40 idle users
    const MAX_IDLE_PER_TICK = 40;
    const idleBatch: UserRecord[] = [];
    if (idleUsers.length > 0) {
      const start = idleUserIndex % idleUsers.length;
      idleBatch.push(...idleUsers.slice(start, start + MAX_IDLE_PER_TICK));
      if (idleBatch.length < MAX_IDLE_PER_TICK && start + MAX_IDLE_PER_TICK > idleUsers.length) {
        // Wrap around
        idleBatch.push(...idleUsers.slice(0, MAX_IDLE_PER_TICK - idleBatch.length));
      }
      idleUserIndex = (start + MAX_IDLE_PER_TICK) % idleUsers.length;
    }

    const usersToPoll = [...activeUsers, ...idleBatch];

    // Use free FastNEAR singleton — 0 paid API key credit consumption
    const near = getFreeNear();
    const [nearUsd, suiUsd] = await Promise.all([
      getNearUsdPrice().catch(() => 5.16),
      getSuiUsdPrice().catch(() => 2.0),
    ]);
    const strkUsd = 0.40;

    // Process target users in parallel batches of 10
    const BATCH_SIZE = 10;
    for (let i = 0; i < usersToPoll.length; i += BATCH_SIZE) {
      const batch = usersToPoll.slice(i, i + BATCH_SIZE);

      await Promise.allSettled(
        batch.map(async (user) => {
          try {
            await processUserDeposit(user, near, nearUsd, suiUsd, strkUsd);
          } catch {
            // Non-fatal per-user check error
          }
        })
      );
    }
  } catch (err: any) {
    logger.error('Error in pollUserDeposits', err);
  } finally {
    isPolling = false;
  }
}

/**
 * Start the background deposit watcher polling loop (default 6s interval).
 */
export function startDepositWatcher(intervalMs = 6_000): void {
  if (watcherInterval) {
    clearInterval(watcherInterval);
  }

  logger.info('Starting deposit watcher', { intervalMs });
  
  // Run first poll after 1s to initialize user baselines
  setTimeout(() => {
    pollUserDeposits().catch(() => {});
  }, 1000);

  watcherInterval = setInterval(() => {
    pollUserDeposits().catch((err) => logger.error('Deposit watcher poll failure', err));
  }, intervalMs);
}

/**
 * Stop deposit watcher on graceful shutdown.
 */
export function stopDepositWatcher(): void {
  if (watcherInterval) {
    clearInterval(watcherInterval);
    watcherInterval = null;
    logger.info('Deposit watcher stopped');
  }
}
