import type { Telegraf } from 'telegraf';
import { getNear, getSuiBalance, getSuiUsdPrice, createLogger } from '@racerbot/shared';
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

let watcherInterval: NodeJS.Timeout | null = null;
let isPolling = false;

/**
 * Record that a user performed a trade, preventing balance increases from
 * DEX sell fills being misidentified as external deposits.
 */
export function recordUserTrade(userIdOrTelegramId: string | number): void {
  const key = String(userIdOrTelegramId);
  tradeCooldownMap.set(key, Date.now() + 30_000); // 30s cooldown
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
 * Poll balances for all active users and alert on incoming NEAR / SUI deposits.
 */
export async function pollUserDeposits(): Promise<void> {
  if (isPolling) return;
  isPolling = true;

  try {
    const db = await getDb();
    const result = await db.query<UserRecord>(
      'SELECT id, telegram_id, subaccount_id, sui_address, scoped_key_encrypted, sui_private_key_enc FROM users'
    );

    const users = result.rows;
    if (!users || users.length === 0) {
      isPolling = false;
      return;
    }

    const near = getNear();
    const [nearUsd, suiUsd] = await Promise.all([
      getNearUsdPrice().catch(() => 4.9),
      getSuiUsdPrice().catch(() => 2.0),
    ]);

    // Process users in parallel batches of 10
    const BATCH_SIZE = 10;
    for (let i = 0; i < users.length; i += BATCH_SIZE) {
      const batch = users.slice(i, i + BATCH_SIZE);

      await Promise.allSettled(
        batch.map(async (user) => {
          const userId = user.id;
          const telegramId = user.telegram_id;
          const subaccount = user.subaccount_id;
          const suiAddr = user.sui_address;

          try {
            // 1. Fetch NEAR native + wrap balances
            const [nativeNearYocto, wrapNearYocto] = await Promise.all([
              near.getNearBalance(subaccount).catch(() => '0'),
              near.view<string>('wrap.near', 'ft_balance_of', { account_id: subaccount }).catch(() => '0'),
            ]);

            const nativeNear = Number(BigInt(nativeNearYocto || '0') / 1000000000000000000n) / 1e6;
            const wrapNear = Number(BigInt(wrapNearYocto || '0') / 1000000000000000000n) / 1e6;
            const currentTotalNear = nativeNear + wrapNear;

            // 2. Fetch SUI balance if SUI address exists
            let currentSui = 0;
            if (suiAddr) {
              const suiBal = await getSuiBalance(suiAddr).catch(() => null);
              if (suiBal) {
                currentSui = suiBal.sui;
              }
            }

            const stateKey = userId;
            const prev = userBalanceState.get(stateKey);

            if (!prev || !prev.initialized) {
              // Initialize baseline balance without firing notification
              userBalanceState.set(stateKey, {
                totalNear: currentTotalNear,
                totalSui: currentSui,
                initialized: true,
              });
              return;
            }

            const inCooldown = isUserInTradeCooldown(userId, telegramId);

            // ── Check NEAR Deposit ──────────────────────────────────────────
            const nearDelta = currentTotalNear - prev.totalNear;
            // Threshold: deposit of at least 0.005 NEAR
            if (nearDelta >= 0.005 && !inCooldown) {
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
            const suiDelta = currentSui - prev.totalSui;
            // Threshold: deposit of at least 0.005 SUI
            if (suiDelta >= 0.005 && suiAddr && !inCooldown) {
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

            // Update stored baseline
            userBalanceState.set(stateKey, {
              totalNear: currentTotalNear,
              totalSui: currentSui,
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
 * Start the background deposit watcher polling loop.
 */
export function startDepositWatcher(intervalMs = 12_000): void {
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
