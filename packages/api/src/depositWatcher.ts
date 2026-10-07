import type { Telegraf } from 'telegraf';
import { getFreeNear, getSuiBalance, getSuiUsdPrice, createLogger } from '@racerbot/shared';
import { getDb, getUserByTelegramId, getUserById, type UserRecord } from '@racerbot/db';
import { getNearUsdPrice, ensureUserSuiWallet } from './wallet.js';
import { notifyDeposit, notifyTokenDeposit } from './notify.js';

const logger = createLogger('deposit-watcher');

interface UserBalanceState {
  totalNear: number;
  totalSui: number;
  initialized: boolean;
}

// In-memory balance tracker for fast change detection
const userBalanceState = new Map<string, UserBalanceState>();

// Cooldown tracker to prevent swap sell proceeds from triggering deposit alerts
const tradeCooldownMap = new Map<string, number>();

// Active user tracking: users active within last 30m are polled frequently; idle users are staggered
const activeUserMap = new Map<string, number>();
let idleUserIndex = 0;

let watcherInterval: NodeJS.Timeout | null = null;
let isPolling = false;

/**
 * Mark a user as active (e.g. opened wallet, deposited, traded, or tapped menu).
 * Active users get high-cadence deposit polling for 30 minutes.
 */
export function markUserActiveForDeposit(userIdOrTelegramId: string | number): void {
  const key = String(userIdOrTelegramId);
  activeUserMap.set(key, Date.now() + 30 * 60 * 1000); // 30 minutes active window
}

/**
 * Record that a user performed a trade, preventing balance increases from
 * DEX sell fills being misidentified as external deposits.
 */
export function recordUserTrade(userIdOrTelegramId: string | number): void {
  const key = String(userIdOrTelegramId);
  tradeCooldownMap.set(key, Date.now() + 30_000); // 30s cooldown
  markUserActiveForDeposit(key);
}

/**
 * Check if user recently executed a trade.
 */
function isUserInTradeCooldown(userId: string, telegramId: number): boolean {
  const now = Date.now();
  const byUid = tradeCooldownMap.get(userId) || 0;
  const byTid = tradeCooldownMap.get(String(telegramId)) || 0;
  return now < byUid || now < byTid;
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
 * Poll balances for users using free FastNEAR RPC.
 * Active users (interacted in last 30m) are checked every tick;
 * idle users are staggered in small batches to preserve zero-cost RPC usage.
 */
export async function pollUserDeposits(): Promise<void> {
  if (isPolling) return;
  isPolling = true;

  try {
    const db = await getDb();
    const result = await db.query<UserRecord>(
      'SELECT id, telegram_id, subaccount_id, sui_address, scoped_key_encrypted, sui_private_key_enc FROM users'
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

    // Always poll all active users + a staggered batch of up to 10 idle users
    const MAX_IDLE_PER_TICK = 10;
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

    // Process target users in parallel batches of 10
    const BATCH_SIZE = 10;
    for (let i = 0; i < usersToPoll.length; i += BATCH_SIZE) {
      const batch = usersToPoll.slice(i, i + BATCH_SIZE);

      await Promise.allSettled(
        batch.map(async (user) => {
          const userId = user.id;
          const telegramId = user.telegram_id;
          const subaccount = user.subaccount_id;
          const suiAddr = user.sui_address;

          try {
            // 1. Fetch NEAR native + wrap balances with strict error handling.
            // If RPC errors out or times out, DO NOT assume 0 (which causes false deposit loops on next poll)!
            let nativeNearYocto: string | null = null;
            let wrapNearYocto: string | null = null;

            if (subaccount) {
              const [resNative, resWrap] = await Promise.allSettled([
                near.getNearBalance(subaccount),
                near.view<string>('wrap.near', 'ft_balance_of', { account_id: subaccount }),
              ]);
              if (resNative.status === 'fulfilled') nativeNearYocto = resNative.value;
              if (resWrap.status === 'fulfilled') wrapNearYocto = resWrap.value;

              // If either failed, skip this user this cycle to prevent phantom deposit spikes
              if (nativeNearYocto === null || wrapNearYocto === null) {
                return;
              }
            }

            const nativeNear = nativeNearYocto
              ? Number(BigInt(nativeNearYocto) / 1000000000000000000n) / 1e6
              : 0;
            const wrapNear = wrapNearYocto
              ? Number(BigInt(wrapNearYocto) / 1000000000000000000n) / 1e6
              : 0;
            const currentTotalNear = nativeNear + wrapNear;

            // 2. Fetch SUI balance if SUI address exists
            let currentSui: number | null = null;
            if (suiAddr) {
              const suiBal = await getSuiBalance(suiAddr).catch(() => null);
              if (suiBal) {
                currentSui = suiBal.sui;
              } else {
                // SUI query failed, skip this cycle to prevent phantom deposit alerts
                return;
              }
            }

            const stateKey = userId;
            const prev = userBalanceState.get(stateKey);

            if (!prev || !prev.initialized) {
              // Initialize baseline balance without firing notification
              userBalanceState.set(stateKey, {
                totalNear: currentTotalNear,
                totalSui: currentSui ?? 0,
                initialized: true,
              });
              return;
            }

            // Check trade cooldowns across in-memory map AND recent DB fills.
            // When tokens are sold on DEX, NEAR/SUI proceeds increase wallet balance.
            // We must NEVER treat trade proceeds as incoming external deposits!
            let inCooldown = isUserInTradeCooldown(userId, telegramId);
            if (!inCooldown) {
              // Check if user has any executed trades in the last 3 minutes
              const recentTrade = await db.query(
                `SELECT 1 FROM fills WHERE user_id = $1 AND executed_at > NOW() - INTERVAL '3 minutes' LIMIT 1`,
                [userId]
              ).catch(() => null);
              if (recentTrade && recentTrade.rows && recentTrade.rows.length > 0) {
                inCooldown = true;
                recordUserTrade(userId);
              }
            }

            // ── Check NEAR Deposit ──────────────────────────────────────────
            const nearDelta = currentTotalNear - prev.totalNear;
            // Threshold: deposit of at least 0.01 NEAR (filters gas change dust)
            if (nearDelta >= 0.01 && !inCooldown) {
              const usdVal = formatUSD(nearDelta * nearUsd);
              logger.info('NEAR deposit detected', {
                telegramId,
                amount: nearDelta.toFixed(4),
                usdVal,
              });

              await notifyDeposit(telegramId, {
                chain: 'near',
                amount: nearDelta.toFixed(4),
                symbol: 'NEAR',
                address: subaccount,
                usdValue: usdVal,
              }).catch((err) => logger.warn('Failed to send NEAR deposit notify', { error: err.message }));
            }

            // ── Check SUI Deposit ───────────────────────────────────────────
            if (currentSui !== null && suiAddr) {
              const suiDelta = currentSui - prev.totalSui;
              // Threshold: deposit of at least 0.01 SUI
              if (suiDelta >= 0.01 && !inCooldown) {
                const usdVal = formatUSD(suiDelta * suiUsd);
                logger.info('SUI deposit detected', {
                  telegramId,
                  amount: suiDelta.toFixed(4),
                  usdVal,
                });

                await notifyDeposit(telegramId, {
                  chain: 'sui',
                  amount: suiDelta.toFixed(4),
                  symbol: 'SUI',
                  address: suiAddr,
                  usdValue: usdVal,
                }).catch((err) => logger.warn('Failed to send SUI deposit notify', { error: err.message }));
              }
            }

            // Update stored baseline
            userBalanceState.set(stateKey, {
              totalNear: currentTotalNear,
              totalSui: currentSui ?? prev.totalSui,
              initialized: true,
            });
          } catch (err: any) {
            // Non-fatal user check error
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
 * Start the background deposit watcher polling loop (default 15s interval).
 */
export function startDepositWatcher(intervalMs = 15_000): void {
  if (watcherInterval) {
    clearInterval(watcherInterval);
  }

  logger.info('Starting deposit watcher', { intervalMs });
  
  // Run first poll after 3s to initialize user baselines
  setTimeout(() => {
    pollUserDeposits().catch(() => {});
  }, 3000);

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

