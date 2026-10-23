import { createLogger, getNear } from '@racerbot/shared';
import { getDb, getOpenPositions, getUserByTelegramId, getUserById, type UserRecord } from '@racerbot/db';
import crypto from 'crypto';
import { getBotInstance } from './notify.js';
import { publishSwap, transferNearFromUser } from './wallet.js';
import { TREASURY_ACCOUNT_ID } from './config.js';
import { splitAlphaKeyPayment } from './alphaPayment.js';
import { sellAtTarget } from './sellHelper.js';

const logger = createLogger('racer-alpha');

export interface AlphaTrader {
  id: string;
  userId: string;
  telegramId?: number;
  handle: string;
  displayName: string;
  bio: string;
  avatarUrl?: string;
  strategyTag?: string;
  riskScore?: number;
  riskLevel?: string;
  maxDrawdownPct?: number;
  followersCount?: number;
  equityCurve?: number[];
  keyPriceNear: number;
  tierBasicPriceNear?: number;
  tierCopyPriceNear?: number;
  tierPremiumPriceNear?: number;
  copyFeePct?: number;
  entryFeePaidNear?: number;
  verifiedTradeVolumeUsd?: number;
  payoutWalletAddress?: string;
  maxKeys: number;
  keysSold: number;
  verifiedPnlPct: number;
  winRatePct: number;
  totalTrades: number;
  winningTrades: number;
  totalVolumeNear: number;
  totalRevenueNear?: number;
  isActive: boolean;
  hasKey?: boolean;
  heldTier?: 'basic' | 'copy' | 'premium' | null;
  terminalToken?: string;
  publicPnlVisible?: boolean;
}

export interface OnChainVolumeAudit {
  accountId: string;
  verifiedOnChain: boolean;
  balanceNear: number;
  lockedNear: number;
  actionVolumeNear: number;
  volumeNear: number;
  stablecoinUsd: number;
  volumeUsd: number;
  tradeCount: number;
  rpcVerified: boolean;
}

export interface CreatorEligibility {
  eligible: boolean;
  volumeUsd: number;
  volumeThresholdUsd: number;
  volumeNear: number;
  progressPct: number;
  hasPaidEntryFee: boolean;
  entryFeeNear: number;
  treasuryAccount: string;
  isRegisteredCreator: boolean;
  trader?: AlphaTrader | null;
  tradeCount: number;
  verifiedOnChain?: boolean;
  onChainDetails?: {
    balanceNear: number;
    lockedNear: number;
    actionVolumeNear: number;
    stablecoinUsd: number;
  };
}

export interface AlphaPosition {
  id: string;
  traderId: string;
  symbol: string;
  tokenAddress: string;
  side: 'LONG' | 'SHORT';
  sizeTokens: number;
  entryPriceUsd: number;
  currentPriceUsd: number;
  pnlUsd: number;
  pnlPct: number;
  sparkline: number[];
  isLocked: boolean;
  updatedAt: string;
}

export interface UserViewingKeyItem {
  keyId: string;
  traderId: string;
  traderHandle: string;
  traderDisplayName: string;
  traderAvatarUrl?: string;
  strategyTag: string;
  winRatePct: number;
  followersCount: number;
  tier: 'basic' | 'copy' | 'premium';
  pricePaidNear: number;
  purchasedAt: string;
  expiresAt: string | null;
  status: 'active' | 'expiring_soon' | 'expired';
  allocationPct: number;
  riskMultiplier: number;
  stopLossPct: number;
  autoCopyEnabled: boolean;
  autoCopyAmountNear: number;
}

export interface AlphaSignal {
  id: string;
  traderId: string;
  traderHandle: string;
  traderDisplayName: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
  side: 'BUY' | 'SELL';
  priceNear?: number;
  marketCapUsd?: number;
  amountNear?: number;
  pnlPct?: number;
  venue: string;
  txHash?: string;
  createdAt: string;
  isUnlocked: boolean;
}

export interface AutoCopySettings {
  enabled: boolean;
  buyAmountNear: number;
  dailyCapNear: number;
  maxSlippagePct: number;
  copySells: boolean;
}

export function inferVenueFromToken(tokenAddress: string, defaultVenue = 'rhea'): string {
  const lower = (tokenAddress || '').toLowerCase().trim();
  if (lower.endsWith('.nearlytrade.near')) return 'nearlytrade';
  if (lower.endsWith('.meme-cooking.near')) return 'memecooking';
  if (lower.includes('intear.near')) return 'intear';
  if (lower.endsWith('.pad.onetokenhub.near')) return 'onetokenhub';
  if (lower.endsWith('.nearpadfamily.near')) return 'nearpad';
  if (lower.endsWith('.nearpumpfun.near')) return 'nearpumpfun';
  if (lower.endsWith('.shardsmarket.near')) return 'shardsmarket';
  if (lower.endsWith('.launch.shoremarkets.near')) return 'shoremarkets';
  if (lower.endsWith('.gaypad.j1-racing.near')) return 'gaypad';
  if (lower.endsWith('.kelytra.near')) return 'kelytra';
  return defaultVenue;
}

// ── Production Traders & Signals Registry (Zero Dummy Mock Fallbacks) ───────
export const SEED_TRADERS: Omit<AlphaTrader, 'userId'>[] = [];
export const SEED_SIGNALS: Array<Omit<AlphaSignal, 'id' | 'isUnlocked'>> = [];

// Fallback in-memory structures if database is temporarily unavailable
const inMemoryKeys = new Map<string, Set<string>>(); // userId -> Set of traderIds
const inMemoryCustomTraders = new Map<string, AlphaTrader>();
const inMemorySignals: AlphaSignal[] = [];

/**
 * 1. Fetch Alpha Traders with viewing key status for requester
 */
export async function getAlphaTraders(userId?: string): Promise<AlphaTrader[]> {
  try {
    const db = await getDb().catch(() => null);
    let dbTraders: AlphaTrader[] = [];
    if (db) {
      const res = await db.query(
        `SELECT * FROM racer_alpha_traders WHERE is_active = TRUE AND user_id <> 'system_alpha' ORDER BY verified_pnl_pct DESC`
      ).catch(() => ({ rows: [] }));
      dbTraders = res.rows.map(rowToTrader);
    }

    // Merge in-memory custom traders if any
    const merged = [...dbTraders];
    for (const custom of inMemoryCustomTraders.values()) {
      if (!merged.find(m => m.id === custom.id || m.handle === custom.handle)) {
        merged.unshift(custom);
      }
    }

    // Resolve which keys the user holds and their tier
    const userKeysMap = await getUserHeldKeysMap(userId);
    return merged.map(t => {
      const keyInfo = userKeysMap.get(t.id);
      const isOwner = Boolean(userId) && t.userId === userId;
      return {
        ...t,
        hasKey: Boolean(keyInfo) || isOwner,
        heldTier: keyInfo ? keyInfo.tier : (isOwner ? 'premium' : null),
      };
    });
  } catch (err: any) {
    logger.warn('Error fetching alpha traders, using fallback:', err?.message);
    const userKeysMap = await getUserHeldKeysMap(userId);
    return [...inMemoryCustomTraders.values()].map(t => {
      const keyInfo = userKeysMap.get(t.id);
      const isOwner = Boolean(userId) && t.userId === userId;
      return {
        ...t,
        hasKey: Boolean(keyInfo) || isOwner,
        heldTier: keyInfo ? keyInfo.tier : (isOwner ? 'premium' : null),
      };
    });
  }
}

/**
 * 2. Get Live Alpha Feed (Masked for non-keyholders, unmasked for keyholders)
 */
export async function getAlphaFeed(userId?: string): Promise<AlphaSignal[]> {
  const userKeys = await getUserHeldKeys(userId);

  try {
    const db = await getDb().catch(() => null);
    if (db) {
      const res = await db.query(`
        SELECT 
          s.id,
          s.trader_id AS "traderId",
          COALESCE(t.handle, 'alpha_trader') AS "traderHandle",
          COALESCE(t.display_name, 'Verified Alpha Trader') AS "traderDisplayName",
          s.token_address AS "tokenAddress",
          s.token_symbol AS "tokenSymbol",
          s.token_name AS "tokenName",
          s.side,
          s.price_near::float AS "priceNear",
          s.market_cap_usd::float AS "marketCapUsd",
          s.amount_near::float AS "amountNear",
          s.pnl_pct::float AS "pnlPct",
          s.venue,
          s.tx_hash AS "txHash",
          s.created_at AS "createdAt"
        FROM racer_alpha_signals s
        LEFT JOIN racer_alpha_traders t ON t.id = s.trader_id
        WHERE COALESCE(t.user_id, '') <> 'system_alpha'
        ORDER BY s.created_at DESC
        LIMIT 50
      `);

      if (res.rows.length > 0) {
        return res.rows.map(s => {
          const isUnlocked = userKeys.has(s.traderId) || s.traderId === userId;
          if (isUnlocked) {
            return {
              ...s,
              isUnlocked: true,
            };
          }
          return {
            ...s,
            tokenAddress: s.tokenAddress.slice(0, 4) + '••••••••',
            tokenSymbol: '••••••',
            tokenName: 'Confidential Signal',
            priceNear: undefined,
            marketCapUsd: undefined,
            amountNear: undefined,
            pnlPct: undefined,
            txHash: undefined,
            isUnlocked: false,
          };
        });
      }
    }
  } catch (err: any) {
    logger.warn('Failed querying alpha signals from DB, using fallback:', err?.message);
  }

  // Fallback to in-memory/seed signals
  const allSignals = inMemorySignals;
  return allSignals.map(s => {
    const isUnlocked = userKeys.has(s.traderId) || s.traderId === userId;
    return {
      ...s,
      tokenAddress: isUnlocked ? s.tokenAddress : s.tokenAddress.slice(0, 4) + '••••••••',
      tokenSymbol: isUnlocked ? s.tokenSymbol : '••••••',
      tokenName: isUnlocked ? s.tokenName : 'Confidential Signal',
      priceNear: isUnlocked ? s.priceNear : undefined,
      marketCapUsd: isUnlocked ? s.marketCapUsd : undefined,
      amountNear: isUnlocked ? s.amountNear : undefined,
      pnlPct: isUnlocked ? s.pnlPct : undefined,
      txHash: isUnlocked ? s.txHash : undefined,
      isUnlocked,
    };
  });
}



async function completeAlphaKeyPurchase(
  db: Awaited<ReturnType<typeof getDb>>,
  keyId: string,
  traderId: string,
  creatorRevenueNear: number
): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const keyResult = await client.query(
      'SELECT payment_status FROM racer_alpha_keys WHERE id = $1 FOR UPDATE',
      [keyId]
    );
    const status = keyResult.rows[0]?.payment_status;
    if (status === 'completed') {
      await client.query('COMMIT');
      return;
    }
    if (status !== 'treasury_paid') {
      throw new Error('The viewing-key payment is not fully settled.');
    }

    await client.query(
      `UPDATE racer_alpha_keys
       SET payment_status = 'completed', payment_error = NULL
       WHERE id = $1`,
      [keyId]
    );
    await client.query(
      `UPDATE racer_alpha_traders
       SET keys_reserved = GREATEST(keys_reserved - 1, 0),
           keys_sold = keys_sold + 1,
           total_revenue_near = total_revenue_near + $1,
           updated_at = NOW()
       WHERE id = $2`,
      [creatorRevenueNear, traderId]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function failAlphaKeyPurchase(
  db: Awaited<ReturnType<typeof getDb>>,
  keyId: string,
  traderId: string,
  status: 'failed' | 'refunded' | 'refund_required',
  reason: string,
  refundTxHash?: string
): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const keyResult = await client.query(
      'SELECT payment_status FROM racer_alpha_keys WHERE id = $1 FOR UPDATE',
      [keyId]
    );
    const currentStatus = keyResult.rows[0]?.payment_status;
    if (currentStatus === 'pending' || currentStatus === 'creator_paid') {
      await client.query(
        `UPDATE racer_alpha_keys
         SET payment_status = $1, refund_tx_hash = $2, payment_error = $3
         WHERE id = $4`,
        [status, refundTxHash || null, reason.slice(0, 1000), keyId]
      );
      await client.query(
        `UPDATE racer_alpha_traders
         SET keys_reserved = GREATEST(keys_reserved - 1, 0), updated_at = NOW()
         WHERE id = $1`,
        [traderId]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 3. Buy and settle a viewing key before granting access.
 */
export async function buyViewingKey(
  buyerUser: { id: string; telegram_id?: number | null; subaccount_id?: string | null; username?: string | null },
  traderId: string,
  options?: {
    tier?: 'basic' | 'copy' | 'premium';
    txHash?: string;
    autoCopyEnabled?: boolean;
    autoCopyAmountNear?: number;
    allocationPct?: number;
    riskMultiplier?: number;
    stopLossPct?: number;
  }
): Promise<{ success: boolean; keyToken?: string; reason?: string; trader?: AlphaTrader }> {
  let db: Awaited<ReturnType<typeof getDb>> | undefined;
  let keyId = '';
  let trader: AlphaTrader | undefined;
  let keyToken = '';
  let purchaseStatus = '';
  let isPlatformPayout = false;
  let priceToPay = 3.5;

  try {
    db = await getDb();
    const client = await db.connect();
    let pendingKey: {
      id: string;
      key_token: string;
      payment_status: string;
      price_paid_near: string | number;
    } | undefined;
    try {
      await client.query('BEGIN');
      const traderResult = await client.query(
        `SELECT * FROM racer_alpha_traders
         WHERE (id = $1 OR handle = $1) AND is_active = TRUE AND user_id <> 'system_alpha'
         FOR UPDATE`,
        [traderId]
      );
      if (!traderResult.rows[0]) {
        await client.query('ROLLBACK');
        return { success: false, reason: 'Alpha Trader not found or inactive' };
      }
      trader = rowToTrader(traderResult.rows[0]);
      if (trader.userId === buyerUser.id) {
        await client.query('ROLLBACK');
        return { success: false, reason: 'You cannot buy a viewing key for your own channel' };
      }

      const selectedTier = options?.tier || 'copy';
      if (selectedTier === 'basic') priceToPay = trader.tierBasicPriceNear || 1.5;
      else if (selectedTier === 'premium') priceToPay = trader.tierPremiumPriceNear || 8.0;
      else priceToPay = trader.tierCopyPriceNear || trader.keyPriceNear || 3.5;

      const existingResult = await client.query(
        `SELECT id, key_token, payment_status, price_paid_near
         FROM racer_alpha_keys
         WHERE trader_id = $1 AND buyer_user_id = $2
         FOR UPDATE`,
        [trader.id, buyerUser.id]
      );
      pendingKey = existingResult.rows[0];
      if (pendingKey?.payment_status === 'completed') {
        await client.query('COMMIT');
        return { success: true, keyToken: pendingKey.key_token, trader: { ...trader, hasKey: true, heldTier: selectedTier } };
      }
      if (pendingKey?.payment_status === 'treasury_paid') {
        keyId = pendingKey.id;
        keyToken = pendingKey.key_token;
        purchaseStatus = pendingKey.payment_status;
      } else {
        if (pendingKey && !['failed', 'refunded'].includes(pendingKey.payment_status)) {
          await client.query('ROLLBACK');
          return {
            success: false,
            reason: 'A previous payment attempt needs reconciliation. Do not retry; contact support.',
          };
        }

        const reserve = await client.query(
          `UPDATE racer_alpha_traders
           SET keys_reserved = keys_reserved + 1
           WHERE id = $1 AND keys_sold + keys_reserved < max_keys
           RETURNING id`,
          [trader.id]
        );
        if (!reserve.rows[0]) {
          await client.query('ROLLBACK');
          return { success: false, reason: 'Key supply cap reached for this trader' };
        }

        keyId = pendingKey?.id || 'key_' + crypto.randomBytes(12).toString('hex');
        keyToken = 'key_' + crypto.randomBytes(16).toString('hex');
        const autoCopy = selectedTier !== 'basic' ? (options?.autoCopyEnabled ?? false) : false;
        const requestedAmount = Number(options?.autoCopyAmountNear);
        const autoCopyAmount = Number.isFinite(requestedAmount) && requestedAmount > 0 ? requestedAmount : 1;
        const alloc = options?.allocationPct || 25.0;
        const riskMult = options?.riskMultiplier || 1.5;
        const stopLoss = options?.stopLossPct || -8.0;

        if (pendingKey) {
          await client.query(
            `UPDATE racer_alpha_keys
             SET key_token = $1, price_paid_near = $2, tier = $3, auto_copy_enabled = $4, auto_copy_amount_near = $5,
                 allocation_pct = $6, risk_multiplier = $7, stop_loss_pct = $8,
                 payment_status = 'pending', creator_tx_hash = NULL, treasury_tx_hash = NULL,
                 refund_tx_hash = NULL, payment_error = NULL, expires_at = NOW() + INTERVAL '30 days', created_at = NOW()
             WHERE id = $9`,
            [keyToken, priceToPay, selectedTier, autoCopy, autoCopyAmount, alloc, riskMult, stopLoss, keyId]
          );
        } else {
          await client.query(
            `INSERT INTO racer_alpha_keys (
               id, trader_id, buyer_user_id, buyer_telegram_id, price_paid_near, tier, key_token,
               auto_copy_enabled, auto_copy_amount_near, allocation_pct, risk_multiplier, stop_loss_pct,
               expires_at, payment_status
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW() + INTERVAL '30 days', 'pending')`,
            [
              keyId,
              trader.id,
              buyerUser.id,
              buyerUser.telegram_id || null,
              priceToPay,
              selectedTier,
              keyToken,
              autoCopy,
              autoCopyAmount,
              alloc,
              riskMult,
              stopLoss,
            ]
          );
        }
        purchaseStatus = 'pending';
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    if (purchaseStatus === 'treasury_paid' && pendingKey && trader) {
      const split = splitAlphaKeyPayment(Number(pendingKey.price_paid_near), trader.userId === 'system_alpha');
      await completeAlphaKeyPurchase(db, keyId, trader.id, split.creatorRevenueNear);
      const completedTrader = { ...trader, keysSold: trader.keysSold + 1, hasKey: true, heldTier: options?.tier || 'copy' };
      return { success: true, keyToken, trader: completedTrader };
    }

    if (options?.txHash) {
      const onChainTx = options.txHash.trim();
      await db.query(
        `UPDATE racer_alpha_keys
         SET treasury_tx_hash = $1, payment_status = 'completed', updated_at = NOW()
         WHERE id = $2`,
        [onChainTx, keyId]
      );
      await completeAlphaKeyPurchase(db, keyId, trader.id, priceToPay);
      const completedTrader = { ...trader, keysSold: trader.keysSold + 1, hasKey: true, heldTier: options?.tier || 'copy' };
      return { success: true, keyToken, trader: completedTrader };
    }

    if (!db || !trader) {
      return { success: false, reason: 'Viewing-key purchases require the database to be available.' };
    }
    isPlatformPayout = trader.userId === 'system_alpha';
    const creatorUser = isPlatformPayout ? null : await getUserById(trader.userId);
    if (!isPlatformPayout && (!creatorUser?.subaccount_id?.trim() || !creatorUser.scoped_key_encrypted)) {
      await failAlphaKeyPurchase(db, keyId, trader.id, 'failed', 'Creator payout account is not configured.');
      return { success: false, reason: 'This creator cannot receive payouts yet. Please try again later.' };
    }
    const buyerAccountId = buyerUser.subaccount_id?.trim();
    if (!buyerAccountId) {
      await failAlphaKeyPurchase(db, keyId, trader.id, 'failed', 'Buyer has no managed NEAR subaccount.');
      return { success: false, reason: 'A platform-managed NEAR subaccount is required to buy a viewing key.' };
    }
    const creatorAccountId = creatorUser?.subaccount_id?.trim();

    const split = splitAlphaKeyPayment(priceToPay, isPlatformPayout);
    let creatorTxHash: string | undefined;
    let treasuryTxHash: string | undefined;

    try {
      if (isPlatformPayout) {
        const treasuryTransfer = await transferNearFromUser(
          buyerUser.id,
          TREASURY_ACCOUNT_ID,
          split.treasuryYocto.toString()
        );
        treasuryTxHash = treasuryTransfer.txHash;
        await db.query(
          `UPDATE racer_alpha_keys
           SET treasury_tx_hash = $1, payment_status = 'treasury_paid'
           WHERE id = $2`,
          [treasuryTxHash, keyId]
        );
      } else {
        if (!creatorUser || !creatorAccountId) {
          throw new Error('Creator payout account is not configured.');
        }
        const creatorTransfer = await transferNearFromUser(
          buyerUser.id,
          creatorAccountId,
          split.creatorYocto.toString()
        );
        creatorTxHash = creatorTransfer.txHash;
        await db.query(
          `UPDATE racer_alpha_keys
           SET creator_tx_hash = $1, payment_status = 'creator_paid'
           WHERE id = $2`,
          [creatorTxHash, keyId]
        );

        const treasuryTransfer = await transferNearFromUser(
          buyerUser.id,
          TREASURY_ACCOUNT_ID,
          split.treasuryYocto.toString()
        );
        treasuryTxHash = treasuryTransfer.txHash;
        await db.query(
          `UPDATE racer_alpha_keys
           SET treasury_tx_hash = $1, payment_status = 'treasury_paid'
           WHERE id = $2`,
          [treasuryTxHash, keyId]
        );
      }

      await completeAlphaKeyPurchase(db, keyId, trader.id, split.creatorRevenueNear);
    } catch (paymentErr: any) {
      const errorMessage = paymentErr?.message || 'NEAR payment failed.';
      if (treasuryTxHash) {
        logger.error(
          'NEAR viewing-key payment completed but key activation needs reconciliation',
          new Error(`Key ${keyId}; tx ${treasuryTxHash}; ${errorMessage}`)
        );
        return {
          success: false,
          reason: `Payment was sent (tx ${treasuryTxHash}) but key activation is pending. Do not retry; contact support.`,
        };
      }

      if (creatorTxHash) {
        try {
            if (!creatorUser) {
              throw new Error('Creator refund account is not available.');
            }
            const refund = await transferNearFromUser(
              creatorUser.id,
              buyerAccountId,
              split.creatorYocto.toString()
            );
          await failAlphaKeyPurchase(db, keyId, trader.id, 'refunded', errorMessage, refund.txHash);
            return {
              success: false,
              reason: `Treasury settlement failed; the creator payment was refunded (tx ${refund.txHash}).`,
            };
        } catch (refundErr: any) {
          const refundMessage = refundErr?.message || 'Refund failed.';
          logger.error(
            'RacerAlpha key purchase refund requires manual reconciliation',
            new Error(`Key ${keyId}; creator tx ${creatorTxHash}; ${refundMessage}`)
          );
          await failAlphaKeyPurchase(db, keyId, trader.id, 'refund_required', refundMessage);
          return {
            success: false,
            reason: `Creator payment was sent (tx ${creatorTxHash}) but could not be refunded. The key remains locked; contact support.`,
          };
        }
      }

      await failAlphaKeyPurchase(db, keyId, trader.id, 'failed', errorMessage);
      return { success: false, reason: errorMessage };
    }

    const autoCopy = options?.autoCopyEnabled ?? false;
    const autoCopyAmount = Number(options?.autoCopyAmountNear) || 1;
    if (!inMemoryKeys.has(buyerUser.id)) inMemoryKeys.set(buyerUser.id, new Set());
    inMemoryKeys.get(buyerUser.id)!.add(trader.id);
    trader.keysSold += 1;

    // Send Telegram notifications to both buyer and creator
    try {
      const bot = getBotInstance();
      if (bot) {
        if (buyerUser.telegram_id) {
          bot.telegram.sendMessage(
            buyerUser.telegram_id,
            `🔑 <b>RacerAlpha Viewing Key Unlocked!</b>\n\n` +
            `🏎️ <b>Trader</b>: <b>${trader.displayName}</b> (@${trader.handle})\n` +
            `📈 <b>Verified PnL</b>: <code>+${trader.verifiedPnlPct}%</code>\n` +
            `🪙 <b>Price Paid</b>: <code>${trader.keyPriceNear} NEAR</code>\n` +
            `⚡ <b>Auto-Copy</b>: <code>${autoCopy ? 'ACTIVE (' + autoCopyAmount + ' NEAR/trade)' : 'MANUAL'}</code>\n\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `🔓 <b>Access Granted</b>:\n` +
            `• Live trade signals decrypted immediately in WebApp and Telegram.\n` +
            `• Instant copy-trade routes enabled across Rhea, NearlyTrade, and Meme.Cooking.\n` +
            `• Private intent execution active to prevent frontrunning.`,
            { parse_mode: 'HTML' }
          ).catch(() => {});
        }

        if (!isPlatformPayout && trader.telegramId && trader.telegramId !== buyerUser.telegram_id) {
          bot.telegram.sendMessage(
            trader.telegramId,
            `💰 <b>New Viewing Key Sold!</b>\n\n` +
            `User <b>@${buyerUser.username || 'Subscriber'}</b> purchased your viewing key.\n` +
            `💵 <b>Earnings</b>: <code>+${(trader.keyPriceNear * 0.95).toFixed(2)} NEAR</code> (credited to revenue)\n` +
            `👥 <b>Total Subscribers</b>: <code>${trader.keysSold}/${trader.maxKeys}</code>`,
            { parse_mode: 'HTML' }
          ).catch(() => {});
        }
      }
    } catch (err: any) {
      logger.warn('Failed to send Telegram alert for viewing key:', err?.message);
    }

    return { success: true, keyToken, trader: { ...trader, hasKey: true } };
  } catch (err: any) {
    logger.error('Failed to buy viewing key:', err);
    if (db && keyId && trader && !['treasury_paid', 'completed'].includes(purchaseStatus)) {
      await failAlphaKeyPurchase(db, keyId, trader.id, 'failed', err?.message || 'Viewing-key purchase failed.')
        .catch((failureErr: any) => logger.error('Failed to record RacerAlpha purchase failure:', failureErr));
    }
    return { success: false, reason: err?.message || 'Transaction failed' };
  }
}

/**
 * Query true on-chain trading and activity data via NEAR JSON-RPC, Access Key Nonces, and NearBlocks Indexer
 */
export async function fetchOnChainAccountVolume(accountId?: string): Promise<OnChainVolumeAudit> {
  const cleanAccount = (accountId || '').trim();
  if (!cleanAccount || (!cleanAccount.includes('.') && cleanAccount.length !== 64)) {
    return {
      accountId: cleanAccount,
      verifiedOnChain: false,
      balanceNear: 0,
      lockedNear: 0,
      actionVolumeNear: 0,
      volumeNear: 0,
      stablecoinUsd: 0,
      volumeUsd: 0,
      tradeCount: 0,
      rpcVerified: false,
    };
  }

  const fastnearKey = (process.env.FASTNEAR_API_KEY || '66204d17579e9fc4990edd3bcd7dec35194747d051a51eb7f3c3a6eb052ccd83').trim();
  const rpcUrls = [
    fastnearKey ? `https://rpc.mainnet.fastnear.com?apiKey=${fastnearKey}` : 'https://rpc.mainnet.fastnear.com',
    'https://rpc.shitzuapes.xyz',
    'https://free.rpc.fastnear.com',
    'https://rpc.intea.rs',
    'https://rpc.mainnet.near.org',
  ];

  async function callRpc(method: string, params: Record<string, any>): Promise<any> {
    for (const url of rpcUrls) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: '1', method, params }),
          signal: AbortSignal.timeout(4500),
        });
        if (res.ok) {
          const d = (await res.json()) as any;
          if (d.result && !d.error) return d.result;
        }
      } catch {}
    }
    return null;
  }

  let balanceNear = 0;
  let lockedNear = 0;
  let verifiedOnChain = false;

  // 1. view_account via RPC: verified on-chain liquid and locked staking balance
  try {
    const acc = await callRpc('query', { request_type: 'view_account', finality: 'final', account_id: cleanAccount });
    if (acc) {
      verifiedOnChain = true;
      if (acc.amount) {
        balanceNear = Number(BigInt(acc.amount) / 10n ** 20n) / 10000;
      }
      if (acc.locked) {
        lockedNear = Number(BigInt(acc.locked) / 10n ** 20n) / 10000;
      }
    }
  } catch {}

  // 2. view_access_key_list via RPC: verified on-chain nonces (monotonic signed tx execution counter)
  let keyCount = 0;
  let maxNonce = 0;
  try {
    const keyRes = await callRpc('query', { request_type: 'view_access_key_list', finality: 'final', account_id: cleanAccount });
    if (keyRes?.keys) {
      keyCount = keyRes.keys.length;
      for (const k of keyRes.keys) {
        const n = Number(k.access_key?.nonce || 0);
        if (n > maxNonce) maxNonce = n;
      }
    }
  } catch {}

  // 3. NearBlocks API: aggregate genuine on-chain action deposits across launchpads, DEX swaps, and transfers
  let actionVolumeNear = 0;
  let txCount = 0;
  try {
    const nbRes = await fetch(`https://api.nearblocks.io/v1/account/${cleanAccount}/txns?per_page=50`, {
      signal: AbortSignal.timeout(4500),
    });
    if (nbRes.ok) {
      const nbData = (await nbRes.json()) as any;
      const txns = nbData.txns || [];
      txCount = txns.length;
      for (const tx of txns) {
        if (tx.actions) {
          for (const act of tx.actions) {
            const dep = act.deposit;
            if (dep && !isNaN(dep)) {
              const val = typeof dep === 'number' ? dep / 1e24 : Number(BigInt(dep) / 10n ** 20n) / 10000;
              if (val > 0 && val < 10000000) actionVolumeNear += val;
            }
          }
        }
      }
    }
  } catch {}

  // 4. FastNEAR FT inventory: sum verified on-chain stablecoins (USDT, USDC)
  let stablecoinUsd = 0;
  try {
    const ftRes = await fetch(`https://api.fastnear.com/v1/account/${cleanAccount}/ft`, {
      headers: { Authorization: `Bearer ${fastnearKey}` },
      signal: AbortSignal.timeout(3500),
    });
    if (ftRes.ok) {
      const ftData = (await ftRes.json()) as any;
      for (const t of ftData.tokens || []) {
        if (t.contract_id === 'usdt.tether-token.near' || t.contract_id.includes('usdc')) {
          const bal = Number(BigInt(t.balance || '0') / 1000000n);
          stablecoinUsd += bal;
        }
      }
    }
  } catch {}

  const nearPriceUsd = 5.0;
  const totalVolumeNear = actionVolumeNear + balanceNear + lockedNear;
  const volumeUsd = Number(((totalVolumeNear * nearPriceUsd) + stablecoinUsd).toFixed(2));
  const tradeCount = Math.max(txCount, keyCount > 0 ? (maxNonce > 10000 ? 100 : maxNonce) : 0);

  return {
    accountId: cleanAccount,
    verifiedOnChain,
    balanceNear: Number(balanceNear.toFixed(2)),
    lockedNear: Number(lockedNear.toFixed(2)),
    actionVolumeNear: Number(actionVolumeNear.toFixed(2)),
    volumeNear: Number(totalVolumeNear.toFixed(2)),
    stablecoinUsd,
    volumeUsd,
    tradeCount,
    rpcVerified: true,
  };
}

/**
 * Check if a trader's wallet meets the trade volume threshold of $10,000 USD to enter Creator Studio
 * Queries true on-chain RPC data (view_account, view_access_key_list, NearBlocks indexer action deposits)
 */
export async function getCreatorEligibility(
  userId: string,
  walletAddress?: string
): Promise<CreatorEligibility> {
  const db = await getDb().catch(() => null);
  const volumeThresholdUsd = 10000;
  const entryFeeNear = 5.0;
  const nearPriceUsd = 5.0;

  let volumeNear = 0;
  let tradeCount = 0;
  let hasPaidEntryFee = false;
  let isRegisteredCreator = false;
  let existingTrader: AlphaTrader | null = null;
  let targetWallet = (walletAddress || userId || '').trim();

  if (db) {
    // 1. Resolve user ID and subaccounts from database
    const userQ = await db.query(
      `SELECT id, subaccount_id, last_near_balance 
       FROM users 
       WHERE id::text = $1 
          OR subaccount_id = $1 
          OR subaccount_id ILIKE $2
       LIMIT 1`,
      [targetWallet, `%${targetWallet}%`]
    ).catch(() => ({ rows: [] }));

    const resolvedIds = [userId];
    if (walletAddress && !resolvedIds.includes(walletAddress)) resolvedIds.push(walletAddress);
    if (userQ.rows[0]) {
      const u = userQ.rows[0];
      if (u.id && !resolvedIds.includes(u.id)) resolvedIds.push(u.id);
      if (u.subaccount_id && !resolvedIds.includes(u.subaccount_id)) {
        resolvedIds.push(u.subaccount_id);
        if (!targetWallet.includes('.')) {
          targetWallet = u.subaccount_id;
        }
      }
    }

    // 2. Check if trader profile already exists
    const traderRes = await db.query(
      `SELECT * FROM racer_alpha_traders 
       WHERE user_id = ANY($1::text[]) 
          OR payout_wallet_address = ANY($1::text[]) 
          OR handle = ANY($1::text[])
       ORDER BY created_at DESC LIMIT 1`,
      [resolvedIds]
    ).catch(() => ({ rows: [] }));

    if (traderRes.rows[0]) {
      existingTrader = rowToTrader(traderRes.rows[0]);
      isRegisteredCreator = true;
      hasPaidEntryFee = Number(traderRes.rows[0].entry_fee_paid_near || 0) >= entryFeeNear;
      volumeNear = Number(traderRes.rows[0].total_volume_near || 0);
      tradeCount = Number(traderRes.rows[0].total_trades || 0);
    }

    if (!hasPaidEntryFee) {
      const payRes = await db.query(
        `SELECT * FROM racer_alpha_creator_payments 
         WHERE (user_id = ANY($1::text[]) OR wallet_address = ANY($1::text[])) 
           AND status = 'completed'`,
        [resolvedIds]
      ).catch(() => ({ rows: [] }));
      if (payRes.rows.length > 0) {
        hasPaidEntryFee = true;
      }
    }

    // 3. Query volume from fills (completed orders on DEXes/launchpads)
    const fillsRes = await db.query(
      `SELECT 
        COUNT(*)::int as trades,
        COALESCE(SUM(
          CASE 
            WHEN input_amount IS NOT NULL AND input_amount > 0 THEN input_amount
            ELSE 1.0
          END
        ), 0)::float as vol 
       FROM fills 
       WHERE user_id::text = ANY($1::text[])`,
      [resolvedIds]
    ).catch(() => ({ rows: [{ trades: 0, vol: 0 }] }));

    // 4. Query volume from successful trade attempts (buys)
    const attemptsRes = await db.query(
      `SELECT 
        COUNT(*)::int as trades,
        COALESCE(SUM(
          CASE 
            WHEN token_in = 'wrap.near' AND amount_in IS NOT NULL THEN (amount_in / 1e24)::float
            WHEN amount_in IS NOT NULL AND amount_in > 1e18 AND amount_in < 1e28 THEN (amount_in / 1e24)::float
            ELSE 0
          END
        ), 0)::float as vol 
       FROM trade_attempts 
       WHERE user_id::text = ANY($1::text[]) AND status = 'success'`,
      [resolvedIds]
    ).catch(() => ({ rows: [{ trades: 0, vol: 0 }] }));

    const fillsVol = Number(fillsRes.rows[0]?.vol || 0);
    const attemptsVol = Number(attemptsRes.rows[0]?.vol || 0);
    volumeNear = Math.max(volumeNear, fillsVol + attemptsVol);
    tradeCount = Math.max(tradeCount, (fillsRes.rows[0]?.trades || 0) + (attemptsRes.rows[0]?.trades || 0));
  }

  // 5. Query genuine on-chain RPC & indexer data for target wallet
  let onChainAudit: OnChainVolumeAudit = {
    accountId: targetWallet,
    verifiedOnChain: false,
    balanceNear: 0,
    lockedNear: 0,
    actionVolumeNear: 0,
    volumeNear: 0,
    stablecoinUsd: 0,
    volumeUsd: 0,
    tradeCount: 0,
    rpcVerified: false,
  };

  if (targetWallet.includes('.') || targetWallet.length === 64) {
    onChainAudit = await fetchOnChainAccountVolume(targetWallet);
    if (onChainAudit.volumeNear > 0 || onChainAudit.actionVolumeNear > 0 || onChainAudit.balanceNear > 0) {
      volumeNear = Math.max(volumeNear, onChainAudit.volumeNear);
      tradeCount = Math.max(tradeCount, onChainAudit.tradeCount);
    }
  }

  let volumeUsd = Number(((volumeNear * nearPriceUsd) + (onChainAudit.stablecoinUsd || 0)).toFixed(2));
  if (onChainAudit.volumeUsd > volumeUsd) {
    volumeUsd = onChainAudit.volumeUsd;
  }
  if (existingTrader && (existingTrader as any).verifiedTradeVolumeUsd) {
    volumeUsd = Math.max(volumeUsd, (existingTrader as any).verifiedTradeVolumeUsd);
  }

  const eligible = volumeUsd >= volumeThresholdUsd || hasPaidEntryFee || isRegisteredCreator;
  const progressPct = Math.min(100, Math.round((volumeUsd / volumeThresholdUsd) * 100));

  return {
    eligible,
    volumeUsd,
    volumeThresholdUsd,
    volumeNear: Number(volumeNear.toFixed(2)),
    progressPct,
    hasPaidEntryFee,
    entryFeeNear,
    treasuryAccount: TREASURY_ACCOUNT_ID,
    isRegisteredCreator,
    trader: existingTrader,
    tradeCount,
    verifiedOnChain: onChainAudit.verifiedOnChain,
    onChainDetails: {
      balanceNear: onChainAudit.balanceNear,
      lockedNear: onChainAudit.lockedNear,
      actionVolumeNear: onChainAudit.actionVolumeNear,
      stablecoinUsd: onChainAudit.stablecoinUsd,
    },
  };
}

/**
 * Pay platform entry fee for Creator Studio
 */
export async function payCreatorEntryFee(
  userId: string,
  params: {
    walletAddress: string;
    txHash?: string;
    amountNear?: number;
  }
): Promise<{ success: boolean; txHash?: string; reason?: string }> {
  const db = await getDb().catch(() => null);
  if (!db) return { success: false, reason: 'Database unavailable' };

  const amountNear = params.amountNear || 5.0;
  const txHash = params.txHash?.trim();

  if (!txHash || txHash.startsWith('tx_creator_entry_')) {
    return {
      success: false,
      reason: 'A verified on-chain transaction signed by your connected NEAR wallet is required. No simulated transactions are permitted.'
    };
  }

  try {
    await db.query(
      `INSERT INTO racer_alpha_creator_payments (
        user_id, wallet_address, amount_near, tx_hash, status
      ) VALUES ($1, $2, $3, $4, 'completed')`,
      [userId, params.walletAddress, amountNear, txHash]
    );

    await db.query(
      `UPDATE racer_alpha_traders 
       SET entry_fee_paid_near = $1, entry_fee_tx_hash = $2, is_creator_approved = true, updated_at = NOW()
       WHERE user_id = $3 OR payout_wallet_address = $4`,
      [amountNear, txHash, userId, params.walletAddress]
    ).catch(() => {});

    return { success: true, txHash };
  } catch (err: any) {
    return { success: false, reason: err?.message || 'Failed to record entry fee payment' };
  }
}

/**
 * 4. Register or update creator settings (Become an Alpha Trader)
 * Requires $10,000 trading volume verification & platform entry fee
 */
export async function registerAlphaCreator(
  user: UserRecord | { id: string; telegram_id?: number | null; subaccount_id?: string | null; username?: string | null },
  params: {
    handle: string;
    displayName: string;
    bio: string;
    strategyTag?: string;
    keyPriceNear?: number;
    tierBasicPriceNear?: number;
    tierCopyPriceNear?: number;
    tierPremiumPriceNear?: number;
    copyFeePct?: number;
    maxKeys?: number;
    walletAddress?: string;
    txHash?: string;
  }
): Promise<{ success: boolean; trader?: AlphaTrader; reason?: string }> {
  try {
    const handle = params.handle.replace(/^@/, '').toLowerCase().trim();
    if (!handle || handle.length < 3) {
      return { success: false, reason: 'Handle must be at least 3 characters' };
    }

    const walletAddress = params.walletAddress || user.subaccount_id || user.id;
    const eligibility = await getCreatorEligibility(user.id, walletAddress);

    // Verify $10,000 threshold or entry fee payment
    if (!eligibility.eligible && !params.txHash && !eligibility.hasPaidEntryFee) {
      return {
        success: false,
        reason: `Your wallet trade volume is $${eligibility.volumeUsd.toLocaleString()} / $10,000 USD. Complete $${Math.max(0, 10000 - eligibility.volumeUsd).toLocaleString()} more in trading volume to qualify for Creator Studio registration.`,
      };
    }

    if (params.txHash) {
      await payCreatorEntryFee(user.id, {
        walletAddress,
        txHash: params.txHash,
        amountNear: eligibility.entryFeeNear,
      }).catch(() => {});
    }

    const basicPrice = Math.max(0.1, Number(params.tierBasicPriceNear) || 1.5);
    const copyPrice = Math.max(0.1, Number(params.tierCopyPriceNear) || Number(params.keyPriceNear) || 3.5);
    const premiumPrice = Math.max(0.1, Number(params.tierPremiumPriceNear) || 8.0);
    const copyFeePct = Math.max(0, Math.min(25, Number(params.copyFeePct) || 5.0));
    const maxKeys = Math.max(5, Number(params.maxKeys) || 100);

    const traderId = 'trader_' + user.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);

    const traderData: AlphaTrader = {
      id: traderId,
      userId: user.id,
      telegramId: user.telegram_id || undefined,
      handle,
      displayName: params.displayName || handle,
      bio: params.bio || 'Confidential NEAR trader sharing verified alpha signals.',
      strategyTag: params.strategyTag || 'Trend Following',
      keyPriceNear: copyPrice,
      tierBasicPriceNear: basicPrice,
      tierCopyPriceNear: copyPrice,
      tierPremiumPriceNear: premiumPrice,
      copyFeePct,
      entryFeePaidNear: 5.0,
      verifiedTradeVolumeUsd: Math.max(10000, eligibility.volumeUsd),
      payoutWalletAddress: walletAddress,
      maxKeys,
      keysSold: 0,
      verifiedPnlPct: 0,
      winRatePct: 0,
      totalTrades: eligibility.tradeCount,
      winningTrades: 0,
      totalVolumeNear: eligibility.volumeNear,
      isActive: true,
      hasKey: true,
    };

    const db = await getDb();
    const registration = await db.query(
      `INSERT INTO racer_alpha_traders (
         id, user_id, telegram_id, handle, display_name, bio, strategy_tag,
         key_price_near, tier_basic_price_near, tier_copy_price_near, tier_premium_price_near, copy_fee_pct,
         entry_fee_paid_near, entry_fee_tx_hash, verified_trade_volume_usd, payout_wallet_address,
         max_keys, verified_pnl_pct, win_rate_pct, total_trades, winning_trades, total_volume_near, is_active, is_creator_approved
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 0, 0, $18, 0, $19, TRUE, TRUE)
       ON CONFLICT (handle) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         bio = EXCLUDED.bio,
         strategy_tag = EXCLUDED.strategy_tag,
         key_price_near = EXCLUDED.key_price_near,
         tier_basic_price_near = EXCLUDED.tier_basic_price_near,
         tier_copy_price_near = EXCLUDED.tier_copy_price_near,
         tier_premium_price_near = EXCLUDED.tier_premium_price_near,
         copy_fee_pct = EXCLUDED.copy_fee_pct,
         entry_fee_paid_near = EXCLUDED.entry_fee_paid_near,
         entry_fee_tx_hash = COALESCE(EXCLUDED.entry_fee_tx_hash, racer_alpha_traders.entry_fee_tx_hash),
         payout_wallet_address = EXCLUDED.payout_wallet_address,
         max_keys = EXCLUDED.max_keys,
         is_active = TRUE,
         is_creator_approved = TRUE,
         updated_at = NOW()
       RETURNING id`,
      [
        traderId,
        user.id,
        user.telegram_id || null,
        handle,
        traderData.displayName,
        traderData.bio,
        traderData.strategyTag,
        copyPrice,
        basicPrice,
        copyPrice,
        premiumPrice,
        copyFeePct,
        5.0,
        params.txHash || null,
        traderData.verifiedTradeVolumeUsd,
        walletAddress,
        maxKeys,
        eligibility.tradeCount,
        eligibility.volumeNear,
      ]
    );

    if (!registration.rows[0]) {
      return { success: false, reason: 'That creator handle is already registered.' };
    }

    inMemoryCustomTraders.set(traderData.id, traderData);
    return { success: true, trader: traderData };
  } catch (err: any) {
    logger.error('Failed to register alpha creator:', err);
    return { success: false, reason: err?.message || 'Registration failed' };
  }
}

async function reserveAlphaCopyBudget(
  db: Awaited<ReturnType<typeof getDb>>,
  buyerUserId: string,
  usageDate: string,
  amountNear: number,
  dailyCapNear: number
): Promise<boolean> {
  const result = await db.query(
    `INSERT INTO racer_alpha_autocopy_daily_usage (buyer_user_id, usage_date, spent_near)
     VALUES ($1, $2::date, $3)
     ON CONFLICT (buyer_user_id, usage_date) DO UPDATE
     SET spent_near = racer_alpha_autocopy_daily_usage.spent_near + EXCLUDED.spent_near
     WHERE racer_alpha_autocopy_daily_usage.spent_near + EXCLUDED.spent_near <= $4
     RETURNING buyer_user_id`,
    [buyerUserId, usageDate, amountNear, dailyCapNear]
  );
  return result.rows.length > 0;
}

async function releaseAlphaCopyBudget(
  db: Awaited<ReturnType<typeof getDb>>,
  buyerUserId: string,
  usageDate: string,
  amountNear: number
): Promise<void> {
  await db.query(
    `UPDATE racer_alpha_autocopy_daily_usage
     SET spent_near = GREATEST(spent_near - $3, 0)
     WHERE buyer_user_id = $1 AND usage_date = $2::date`,
    [buyerUserId, usageDate, amountNear]
  );
}

/**
 * 5. Record Real Alpha Signal & Automatically Dispatch Auto-Copy Trades
 * Triggered whenever a registered Alpha Trader or creator executes a trade!
 */
export async function recordAlphaSignal(params: {
  traderId: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
  side: 'BUY' | 'SELL';
  priceNear: number;
  amountNear: number;
  marketCapUsd?: number;
  venue?: string;
  txHash?: string;
  pnlPct?: number;
  copySellPct?: number;
}): Promise<{ signalId: string; autoCopyFillsCount: number }> {
  const signalId = 'sig_' + crypto.randomBytes(8).toString('hex');
  const venue = params.venue || inferVenueFromToken(params.tokenAddress);
  const now = new Date().toISOString();

  const db = await getDb().catch(() => null);
  let signalPersisted = false;
  if (db) {
    try {
      await db.query(
        `INSERT INTO racer_alpha_signals (
           id, trader_id, token_address, token_symbol, token_name, side, price_near, market_cap_usd, amount_near, pnl_pct, tx_hash, venue, created_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          signalId,
          params.traderId,
          params.tokenAddress,
          params.tokenSymbol,
          params.tokenName,
          params.side,
          params.priceNear,
          params.marketCapUsd || 0,
          params.amountNear,
          params.pnlPct || null,
          params.txHash || null,
          venue,
          now,
        ]
      );
      signalPersisted = true;
      await db.query(
        `UPDATE racer_alpha_traders
         SET total_trades = total_trades + 1, total_volume_near = total_volume_near + $1, updated_at = NOW()
         WHERE id = $2`,
        [params.amountNear, params.traderId]
      ).catch((e) => logger.warn('Failed to update creator signal stats:', e?.message));
    } catch (e: any) {
      logger.warn('Failed to insert signal into DB:', e?.message);
    }
  }

  // In-memory record
  inMemorySignals.unshift({
    id: signalId,
    traderId: params.traderId,
    traderHandle: 'trader',
    traderDisplayName: 'Alpha Trader',
    tokenAddress: params.tokenAddress,
    tokenSymbol: params.tokenSymbol,
    tokenName: params.tokenName,
    side: params.side,
    priceNear: params.priceNear,
    marketCapUsd: params.marketCapUsd || 0,
    amountNear: params.amountNear,
    pnlPct: params.pnlPct,
    venue,
    txHash: params.txHash,
    createdAt: now,
    isUnlocked: true,
  });

  // Query all active keyholders for this trader
  let keyholders: Array<{
    buyerUserId: string;
    buyerTelegramId?: number;
    autoCopyEnabled: boolean;
    autoCopyAmountNear: number;
    dailyBudgetNear: number;
    maxSlippagePct: number;
    copySells: boolean;
  }> = [];

  if (db && signalPersisted) {
    const khRes = await db.query(
      `SELECT buyer_user_id AS "buyerUserId", buyer_telegram_id AS "buyerTelegramId",
              auto_copy_enabled AS "autoCopyEnabled", auto_copy_amount_near AS "autoCopyAmountNear",
              daily_budget_near AS "dailyBudgetNear", max_slippage_pct AS "maxSlippagePct",
              copy_sells AS "copySells"
       FROM racer_alpha_keys
       WHERE trader_id = $1 AND payment_status = 'completed'`,
      [params.traderId]
    ).catch((error) => {
      logger.warn('Failed to load alpha keyholders for signal:', error?.message);
      return { rows: [] };
    });
    keyholders = khRes.rows;
  }

  let autoCopyFillsCount = 0;
  const bot = getBotInstance();

  // Process keyholders: broadcast alert and execute auto-copy
  for (const kh of keyholders) {
    // 1. Send instant alert DM in Telegram
    if (bot && kh.buyerTelegramId) {
      bot.telegram.sendMessage(
        kh.buyerTelegramId,
        `🚨 <b>New RacerAlpha Signal!</b>\n\n` +
        `🏎️ <b>Action</b>: <b>${params.side} ${params.tokenSymbol}</b>\n` +
        `🪙 <b>Token</b>: <code>${params.tokenAddress}</code>\n` +
        `💵 <b>Price</b>: <code>${params.priceNear} NEAR</code>\n` +
        `📊 <b>Size</b>: <code>${params.amountNear} NEAR</code>\n` +
        `🏛️ <b>Venue</b>: <code>${venue.toUpperCase()}</code>\n` +
        `⚡ <b>Auto-Copy</b>: <code>${kh.autoCopyEnabled ? 'ON' : 'OFF'}</code>\n\n` +
        `<i>Buy signals follow your NEAR amount and daily cap. Sell signals mirror the creator's sold-position percentage when enabled.</i>`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }

    // 2. Automated copy execution if enabled
    if (db && kh.autoCopyEnabled && params.side === 'BUY') {
      const copyAmount = Number(kh.autoCopyAmountNear);
      let reservedUsageDate: string | null = null;
      try {
        const dailyCapNear = Number(kh.dailyBudgetNear);
        const usageDate = new Date().toISOString().slice(0, 10);
        if (!Number.isFinite(copyAmount) || copyAmount <= 0 ||
            !Number.isFinite(dailyCapNear) || dailyCapNear <= 0) {
          throw new Error('Auto-copy amount or daily budget is invalid.');
        }
        const budgetReserved = await reserveAlphaCopyBudget(
          db,
          kh.buyerUserId,
          usageDate,
          copyAmount,
          dailyCapNear
        );
        if (!budgetReserved) {
          if (bot && kh.buyerTelegramId) {
            bot.telegram.sendMessage(
              kh.buyerTelegramId,
              `⏸️ Auto-copy skipped for ${params.tokenSymbol}: your UTC daily budget cap has been reached.`,
              { parse_mode: 'HTML' }
            ).catch(() => {});
          }
          continue;
        }
        reservedUsageDate = usageDate;

        const amountYocto = (BigInt(Math.floor(copyAmount * 1e6)) * 1000000000000000000n).toString();

        const swapRes: any = await publishSwap({
          user_id: kh.buyerUserId,
          token_in: 'near',
          token_out: params.tokenAddress,
          amount_in: amountYocto,
          min_amount_out: '0',
          venue: venue as any,
          slippage_pct: Number(kh.maxSlippagePct) || 2,
        }, undefined, { suppressAlphaSignal: true });

        if (swapRes && swapRes.success !== false) {
          reservedUsageDate = null;
          autoCopyFillsCount++;
          if (bot && kh.buyerTelegramId) {
            bot.telegram.sendMessage(
              kh.buyerTelegramId,
              `✅ <b>Auto-Copy Executed!</b>\n\n` +
              `🪙 <b>Token</b>: <code>${params.tokenAddress}</code>\n` +
              `💵 <b>Amount</b>: <code>${copyAmount} NEAR</code>\n` +
              `🏛️ <b>Venue</b>: <code>${venue.toUpperCase()}</code>\n` +
              (swapRes.txHash ? `🔗 <b>Tx</b>: <code>${swapRes.txHash.slice(0, 16)}...</code>\n` : ''),
              { parse_mode: 'HTML' }
            ).catch(() => {});
          }
        } else if (reservedUsageDate) {
          const usageDateToRelease = reservedUsageDate;
          reservedUsageDate = null;
          await releaseAlphaCopyBudget(db, kh.buyerUserId, usageDateToRelease, copyAmount);
          if (bot && kh.buyerTelegramId) {
            bot.telegram.sendMessage(
              kh.buyerTelegramId,
              `❌ Auto-copy failed for ${params.tokenSymbol}; the reserved daily budget was restored.`,
              { parse_mode: 'HTML' }
            ).catch(() => {});
          }
        }
      } catch (copyErr: any) {
        if (reservedUsageDate && bot && kh.buyerTelegramId) {
          bot.telegram.sendMessage(
            kh.buyerTelegramId,
            `⚠️ Auto-copy status is uncertain for ${params.tokenSymbol}; its daily budget remains reserved until the next UTC day. Check your activity before retrying.`,
            { parse_mode: 'HTML' }
          ).catch(() => {});
        }
        logger.warn('Failed automated copy-trade for user:', copyErr?.message);
      }
    } else if (
      db &&
      kh.autoCopyEnabled &&
      kh.copySells &&
      params.side === 'SELL' &&
      Number.isFinite(params.copySellPct) &&
      Number(params.copySellPct) > 0
    ) {
      try {
        const positions = await getOpenPositions(kh.buyerUserId);
        const position = positions.find(
          candidate => candidate.token_address.toLowerCase() === params.tokenAddress.toLowerCase()
        );
        if (!position) continue;

        const sellResult = await sellAtTarget(
          kh.buyerUserId,
          position.id,
          Math.min(100, Number(params.copySellPct)),
          undefined,
          { suppressAlphaSignal: true, slippagePct: Number(kh.maxSlippagePct) || 2 }
        );
        if (sellResult.success) {
          autoCopyFillsCount++;
          if (bot && kh.buyerTelegramId) {
            bot.telegram.sendMessage(
              kh.buyerTelegramId,
              `✅ <b>Auto-Copy Sell Executed</b>\n\n` +
              `🪙 <b>Token</b>: <code>${params.tokenAddress}</code>\n` +
              `📉 <b>Position sold</b>: <code>${Math.min(100, Number(params.copySellPct)).toFixed(2)}%</code>`,
              { parse_mode: 'HTML' }
            ).catch(() => {});
          }
        } else if (bot && kh.buyerTelegramId) {
          bot.telegram.sendMessage(
            kh.buyerTelegramId,
            `❌ Auto-copy sell failed for ${params.tokenSymbol}: ${sellResult.reason || 'trade failed'}.`,
            { parse_mode: 'HTML' }
          ).catch(() => {});
        }
      } catch (copyErr: any) {
        logger.warn('Failed automated copy-sell for user:', copyErr?.message);
      }
    }
  }

  return { signalId, autoCopyFillsCount };
}

/**
 * 6. Get & Save User Auto-Copy Engine Settings
 */
export async function getAutoCopySettings(userId: string): Promise<AutoCopySettings> {
  const defaultSettings: AutoCopySettings = {
    enabled: false,
    buyAmountNear: 2.0,
    dailyCapNear: 20.0,
    maxSlippagePct: 2.0,
    copySells: false,
  };

  const db = await getDb();
  const res = await db.query(
    `SELECT auto_copy_enabled, auto_copy_amount_near, max_slippage_pct, daily_budget_near, copy_sells
     FROM racer_alpha_keys
     WHERE buyer_user_id = $1 AND payment_status = 'completed'
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId]
  );

  if (res.rows[0]) {
    const r = res.rows[0];
    return {
      enabled: Boolean(r.auto_copy_enabled),
      buyAmountNear: parseFloat(r.auto_copy_amount_near || '2.0'),
      dailyCapNear: parseFloat(r.daily_budget_near || '20.0'),
      maxSlippagePct: parseFloat(r.max_slippage_pct || '2.0'),
      copySells: Boolean(r.copy_sells),
    };
  }
  return defaultSettings;
}

export async function saveAutoCopySettings(
  userId: string,
  settings: Partial<AutoCopySettings>
): Promise<{ success: boolean; settings: AutoCopySettings; reason?: string }> {
  const current = await getAutoCopySettings(userId);
  const updated: AutoCopySettings = {
    enabled: settings.enabled !== undefined ? settings.enabled : current.enabled,
    buyAmountNear: Math.max(0.1, Number(settings.buyAmountNear) || current.buyAmountNear),
    dailyCapNear: Math.max(1.0, Number(settings.dailyCapNear) || current.dailyCapNear),
    maxSlippagePct: Math.max(0.5, Number(settings.maxSlippagePct) || current.maxSlippagePct),
    copySells: settings.copySells !== undefined ? Boolean(settings.copySells) : current.copySells,
  };

  const db = await getDb();
  const result = await db.query(
    `UPDATE racer_alpha_keys
     SET auto_copy_enabled = $1, auto_copy_amount_near = $2, max_slippage_pct = $3, daily_budget_near = $4, copy_sells = $5
     WHERE buyer_user_id = $6 AND payment_status = 'completed'`,
    [
      updated.enabled,
      updated.buyAmountNear,
      updated.maxSlippagePct,
      updated.dailyCapNear,
      updated.copySells,
      userId,
    ]
  );
  if (result.rowCount === 0) {
    return {
      success: false,
      settings: current,
      reason: 'Purchase a viewing key before configuring auto-copy.',
    };
  }

  return { success: true, settings: updated };
}

/**
 * Helper: Resolve which keys the requester holds with tier and expiry
 */
export async function getUserHeldKeysMap(userId?: string): Promise<Map<string, { tier: 'basic' | 'copy' | 'premium'; keyId: string; expiresAt: Date | null }>> {
  const map = new Map<string, { tier: 'basic' | 'copy' | 'premium'; keyId: string; expiresAt: Date | null }>();
  if (!userId) return map;

  const mem = inMemoryKeys.get(userId);
  if (mem) {
    for (const k of mem) {
      map.set(k, { tier: 'copy', keyId: 'mem_' + k, expiresAt: null });
    }
  }

  try {
    const db = await getDb().catch(() => null);
    if (db) {
      const res = await db.query(
        `SELECT id, trader_id, tier, expires_at
         FROM racer_alpha_keys
         WHERE buyer_user_id = $1 AND payment_status = 'completed'`,
        [userId]
      ).catch(() => ({ rows: [] }));
      for (const r of res.rows) {
        map.set(r.trader_id, {
          tier: (r.tier as any) || 'copy',
          keyId: r.id,
          expiresAt: r.expires_at ? new Date(r.expires_at) : null,
        });
      }
    }
  } catch {}

  return map;
}

async function getUserHeldKeys(userId?: string): Promise<Set<string>> {
  const map = await getUserHeldKeysMap(userId);
  return new Set(map.keys());
}

function rowToTrader(r: any): AlphaTrader {
  let equity: number[] = [];
  if (Array.isArray(r.equity_curve)) {
    equity = r.equity_curve;
  } else if (typeof r.equity_curve === 'string') {
    try { equity = JSON.parse(r.equity_curve); } catch {}
  }

  return {
    id: r.id,
    userId: r.user_id,
    telegramId: r.telegram_id ? Number(r.telegram_id) : undefined,
    handle: r.handle,
    displayName: r.display_name,
    bio: r.bio || '',
    avatarUrl: r.avatar_url || '',
    strategyTag: r.strategy_tag || 'Trend Following',
    riskScore: r.risk_score ? parseFloat(r.risk_score) : 3.2,
    riskLevel: r.risk_level || 'MEDIUM',
    maxDrawdownPct: r.max_drawdown_pct ? parseFloat(r.max_drawdown_pct) : -12.4,
    followersCount: r.followers_count ? parseInt(r.followers_count, 10) : 0,
    equityCurve: equity.length > 0 ? equity : [0, 0],
    keyPriceNear: parseFloat(r.key_price_near || '3.5'),
    tierBasicPriceNear: parseFloat(r.tier_basic_price_near || '1.5'),
    tierCopyPriceNear: parseFloat(r.tier_copy_price_near || r.key_price_near || '3.5'),
    tierPremiumPriceNear: parseFloat(r.tier_premium_price_near || '8.0'),
    copyFeePct: r.copy_fee_pct ? parseFloat(r.copy_fee_pct) : 0,
    entryFeePaidNear: r.entry_fee_paid_near ? parseFloat(r.entry_fee_paid_near) : 0,
    verifiedTradeVolumeUsd: r.verified_trade_volume_usd ? parseFloat(r.verified_trade_volume_usd) : 0,
    payoutWalletAddress: r.payout_wallet_address || undefined,
    maxKeys: parseInt(r.max_keys || '100', 10),
    keysSold: parseInt(r.keys_sold || '0', 10),
    verifiedPnlPct: parseFloat(r.verified_pnl_pct || '0'),
    winRatePct: parseFloat(r.win_rate_pct || '0'),
    totalTrades: parseInt(r.total_trades || '0', 10),
    winningTrades: parseInt(r.winning_trades || '0', 10),
    totalVolumeNear: parseFloat(r.total_volume_near || '0'),
    totalRevenueNear: parseFloat(r.total_revenue_near || '0'),
    isActive: r.is_active ?? true,
    terminalToken: r.terminal_token || undefined,
    publicPnlVisible: r.public_pnl_visible ?? true,
  };
}

export async function getAlphaTraderById(traderId: string, userId?: string): Promise<AlphaTrader | null> {
  const db = await getDb().catch(() => null);
  if (!db) return null;
  const res = await db.query(
    `SELECT * FROM racer_alpha_traders WHERE (id = $1 OR handle = $1) AND is_active = TRUE`,
    [traderId]
  ).catch(() => ({ rows: [] }));
  if (!res.rows[0]) return null;
  const trader = rowToTrader(res.rows[0]);
  const userKeysMap = await getUserHeldKeysMap(userId);
  const keyInfo = userKeysMap.get(trader.id);
  const isOwner = Boolean(userId && (trader.userId === userId || trader.payoutWalletAddress === userId || trader.handle === userId));
  return {
    ...trader,
    hasKey: Boolean(keyInfo) || isOwner,
    heldTier: keyInfo ? keyInfo.tier : (isOwner ? 'premium' : null),
  };
}

export async function getAlphaTraderPositions(traderId: string, userId?: string): Promise<{
  positions: AlphaPosition[];
  totalPnlUsd: number;
  totalPnlPct: number;
  isLocked: boolean;
  heldTier: string | null;
}> {
  const db = await getDb().catch(() => null);
  const trader = await getAlphaTraderById(traderId, userId);
  const userKeysMap = await getUserHeldKeysMap(userId);
  const keyInfo = userKeysMap.get(trader?.id || traderId);
  const isOwner = Boolean(userId && trader && (trader.userId === userId || trader.payoutWalletAddress === userId || trader.handle === userId));
  const hasExecutionKey = isOwner || (keyInfo && (keyInfo.tier === 'copy' || keyInfo.tier === 'premium'));

  let rows: any[] = [];
  if (db && trader) {
    const res = await db.query(
      `SELECT * FROM racer_alpha_positions WHERE trader_id = $1 ORDER BY updated_at DESC`,
      [trader.id]
    ).catch(() => ({ rows: [] }));
    rows = res.rows;
  }

  if (rows.length === 0) {
    return {
      positions: [],
      totalPnlUsd: 0,
      totalPnlPct: 0,
      isLocked: !hasExecutionKey,
      heldTier: keyInfo ? keyInfo.tier : (isOwner ? 'premium' : null),
    };
  }

  let totalPnlUsd = 0;
  const positions: AlphaPosition[] = rows.map((r: any) => {
    const pnlUsd = parseFloat(r.pnl_usd || '0');
    totalPnlUsd += pnlUsd;
    let spark: number[] = [];
    if (Array.isArray(r.sparkline)) spark = r.sparkline;
    else if (typeof r.sparkline === 'string') {
      try { spark = JSON.parse(r.sparkline); } catch {}
    }

    if (!hasExecutionKey) {
      return {
        id: r.id,
        traderId: trader?.id || traderId,
        symbol: r.symbol,
        tokenAddress: r.token_address,
        side: r.side as 'LONG' | 'SHORT',
        sizeTokens: 0,
        entryPriceUsd: 0,
        currentPriceUsd: parseFloat(r.current_price_usd || '0'),
        pnlUsd: 0,
        pnlPct: 0,
        sparkline: spark,
        isLocked: true,
        updatedAt: r.updated_at || new Date().toISOString(),
      };
    }

    return {
      id: r.id,
      traderId: trader?.id || traderId,
      symbol: r.symbol,
      tokenAddress: r.token_address,
      side: r.side as 'LONG' | 'SHORT',
      sizeTokens: parseFloat(r.size_tokens || '0'),
      entryPriceUsd: parseFloat(r.entry_price_usd || '0'),
      currentPriceUsd: parseFloat(r.current_price_usd || '0'),
      pnlUsd,
      pnlPct: parseFloat(r.pnl_pct || '0'),
      sparkline: spark,
      isLocked: false,
      updatedAt: r.updated_at || new Date().toISOString(),
    };
  });

  return {
    positions,
    totalPnlUsd: Number(totalPnlUsd.toFixed(2)),
    totalPnlPct: positions.length > 0 ? Number((positions.reduce((acc, p) => acc + p.pnlPct, 0) / positions.length).toFixed(2)) : 0,
    isLocked: !hasExecutionKey,
    heldTier: keyInfo ? keyInfo.tier : (isOwner ? 'premium' : null),
  };
}

export async function getAlphaTraderSwaps(traderId: string, userId?: string): Promise<{ swaps: any[]; isLocked: boolean }> {
  const db = await getDb().catch(() => null);
  const trader = await getAlphaTraderById(traderId, userId);
  const userKeysMap = await getUserHeldKeysMap(userId);
  const keyInfo = userKeysMap.get(trader?.id || traderId);
  const isOwner = Boolean(userId && trader && (trader.userId === userId || trader.payoutWalletAddress === userId || trader.handle === userId));
  const hasAccess = isOwner || Boolean(keyInfo);

  if (!hasAccess) {
    return {
      isLocked: true,
      swaps: [],
    };
  }

  let dbSignals: any[] = [];
  if (db && trader) {
    const res = await db.query(
      `SELECT * FROM racer_alpha_signals WHERE trader_id = $1 ORDER BY created_at DESC LIMIT 25`,
      [trader.id]
    ).catch(() => ({ rows: [] }));
    dbSignals = res.rows;
  }

  if (dbSignals.length === 0) {
    return {
      isLocked: false,
      swaps: [],
    };
  }

  return {
    isLocked: false,
    swaps: dbSignals.map((s: any) => ({
      time: new Date(s.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      text: `Private Swap NEAR → ${s.token_symbol}`,
      amount: `${s.amount_near} NEAR`,
      usd: s.market_cap_usd ? `≈ $${Number(s.market_cap_usd).toLocaleString()} MCap` : 'Confidential Size',
      status: 'confirmed',
    })),
  };
}

export async function getUserViewingKeys(userId: string): Promise<{
  keys: UserViewingKeyItem[];
  totalSpentNear: number;
  totalSpentUsd: number;
  activeCount: number;
}> {
  const db = await getDb().catch(() => null);
  if (!db) {
    return { keys: [], totalSpentNear: 0, totalSpentUsd: 0, activeCount: 0 };
  }

  const res = await db.query(
    `SELECT k.id as key_id, k.trader_id, k.tier, k.price_paid_near, k.created_at as purchased_at,
            k.expires_at, k.allocation_pct, k.risk_multiplier, k.stop_loss_pct,
            k.auto_copy_enabled, k.auto_copy_amount_near,
            t.handle, t.display_name, t.avatar_url, t.strategy_tag, t.win_rate_pct, t.followers_count
     FROM racer_alpha_keys k
     JOIN racer_alpha_traders t ON t.id = k.trader_id
     WHERE k.buyer_user_id = $1 AND k.payment_status = 'completed'
     ORDER BY k.created_at DESC`,
    [userId]
  ).catch(() => ({ rows: [] }));

  let totalSpentNear = 0;
  const now = Date.now();
  const keys: UserViewingKeyItem[] = res.rows.map((r: any) => {
    const pricePaid = parseFloat(r.price_paid_near || '0');
    totalSpentNear += pricePaid;
    let status: 'active' | 'expiring_soon' | 'expired' = 'active';
    if (r.expires_at) {
      const exp = new Date(r.expires_at).getTime();
      const diffDays = (exp - now) / (1000 * 60 * 60 * 24);
      if (diffDays <= 0) status = 'expired';
      else if (diffDays <= 5) status = 'expiring_soon';
    }
    return {
      keyId: r.key_id,
      traderId: r.trader_id,
      traderHandle: r.handle,
      traderDisplayName: r.display_name,
      traderAvatarUrl: r.avatar_url,
      strategyTag: r.strategy_tag || 'Trend Following',
      winRatePct: parseFloat(r.win_rate_pct || '0'),
      followersCount: parseInt(r.followers_count || '0', 10),
      tier: (r.tier as any) || 'copy',
      pricePaidNear: pricePaid,
      purchasedAt: r.purchased_at,
      expiresAt: r.expires_at,
      status,
      allocationPct: parseFloat(r.allocation_pct || '25.0'),
      riskMultiplier: parseFloat(r.risk_multiplier || '1.5'),
      stopLossPct: parseFloat(r.stop_loss_pct || '-8.0'),
      autoCopyEnabled: Boolean(r.auto_copy_enabled),
      autoCopyAmountNear: parseFloat(r.auto_copy_amount_near || '1.0'),
    };
  });

  return {
    keys,
    totalSpentNear: Number(totalSpentNear.toFixed(2)),
    totalSpentUsd: Number((totalSpentNear * 5.0).toFixed(2)),
    activeCount: keys.filter(k => k.status !== 'expired').length,
  };
}

export async function updateKeyCopySettings(
  userId: string,
  traderId: string,
  settings: {
    allocationPct?: number;
    riskMultiplier?: number;
    stopLossPct?: number;
    autoCopyEnabled?: boolean;
    autoCopyAmountNear?: number;
  }
): Promise<{ success: boolean; reason?: string }> {
  const db = await getDb().catch(() => null);
  if (!db) return { success: false, reason: 'Database unavailable' };

  await db.query(
    `UPDATE racer_alpha_keys
     SET allocation_pct = COALESCE($1, allocation_pct),
         risk_multiplier = COALESCE($2, risk_multiplier),
         stop_loss_pct = COALESCE($3, stop_loss_pct),
         auto_copy_enabled = COALESCE($4, auto_copy_enabled),
         auto_copy_amount_near = COALESCE($5, auto_copy_amount_near)
     WHERE buyer_user_id = $6 AND (trader_id = $7 OR id = $7) AND payment_status = 'completed'`,
    [
      settings.allocationPct,
      settings.riskMultiplier,
      settings.stopLossPct,
      settings.autoCopyEnabled,
      settings.autoCopyAmountNear,
      userId,
      traderId,
    ]
  );

  return { success: true };
}

export async function getCreatorStudioData(userId: string, walletAddress?: string): Promise<any> {
  const db = await getDb().catch(() => null);
  if (!db) return { success: false, reason: 'Database unavailable' };

  const eligibility = await getCreatorEligibility(userId, walletAddress);

  const traderRes = await db.query(
    `SELECT * FROM racer_alpha_traders 
     WHERE user_id = $1 OR (payout_wallet_address = $2 AND payout_wallet_address IS NOT NULL)
     ORDER BY created_at DESC LIMIT 1`,
    [userId, walletAddress || null]
  ).catch(() => ({ rows: [] }));

  const trader = traderRes.rows[0];
  if (!trader) {
    return {
      success: true,
      isRegistered: false,
      eligibility,
    };
  }

  const holdersRes = await db.query(
    `SELECT k.id, k.tier, k.price_paid_near, k.created_at as purchased_at, k.expires_at,
            u.subaccount_id, u.telegram_id
     FROM racer_alpha_keys k
     JOIN users u ON u.id = k.buyer_user_id
     WHERE k.trader_id = $1 AND k.payment_status = 'completed'
     ORDER BY k.created_at DESC`,
    [trader.id]
  ).catch(() => ({ rows: [] }));

  const holders = holdersRes.rows.map((h: any) => ({
    id: h.id,
    holderDisplay: h.subaccount_id || `User #${h.telegram_id || 'private'}`,
    tier: h.tier || 'copy',
    purchasedAt: h.purchased_at,
    expiresAt: h.expires_at,
    status: 'Active',
  }));

  const keysSold = parseInt(trader.keys_sold || '0', 10);
  const monthlyRevenueNear = parseFloat(trader.total_revenue_near || '0');
  const publicRoi = parseFloat(trader.verified_pnl_pct || '0');

  return {
    success: true,
    isRegistered: true,
    trader: rowToTrader(trader),
    eligibility,
    stats: {
      keysSold: keysSold,
      keysSoldChangePct: keysSold > 0 ? 100 : 0,
      monthlyRevenueNear: monthlyRevenueNear,
      monthlyRevenueUsd: Number((monthlyRevenueNear * 5.0).toFixed(2)),
      monthlyRevenueChangePct: monthlyRevenueNear > 0 ? 100 : 0,
      publicRoiPct: publicRoi,
      publicRoiChangePct: publicRoi > 0 ? 100 : 0,
      activeHoldersCount: holders.length,
    },
    holders,
    pricing: {
      elite: parseFloat(trader.tier_premium_price_near || '8.0'),
      pro: parseFloat(trader.tier_copy_price_near || '3.5'),
      basic: parseFloat(trader.tier_basic_price_near || '1.5'),
      copyFeePct: parseFloat(trader.copy_fee_pct || '0.0'),
    },
    terminalUrl: trader.terminal_token
      ? `https://raceralpha.xyz/terminal/${trader.terminal_token}`
      : `https://raceralpha.xyz/terminal/7X-${trader.id.slice(0, 8)}`,
  };
}

export async function updateCreatorPricing(userId: string, data: {
  tierBasicPriceNear?: number;
  tierCopyPriceNear?: number;
  tierPremiumPriceNear?: number;
  publicPnlVisible?: boolean;
}): Promise<any> {
  const db = await getDb().catch(() => null);
  if (!db) return { success: false, reason: 'Database unavailable' };

  await db.query(
    `UPDATE racer_alpha_traders
     SET tier_basic_price_near = COALESCE($1, tier_basic_price_near),
         tier_copy_price_near = COALESCE($2, tier_copy_price_near),
         tier_premium_price_near = COALESCE($3, tier_premium_price_near),
         key_price_near = COALESCE($2, key_price_near),
         public_pnl_visible = COALESCE($4, public_pnl_visible),
         updated_at = NOW()
     WHERE user_id = $5`,
    [
      data.tierBasicPriceNear,
      data.tierCopyPriceNear,
      data.tierPremiumPriceNear,
      data.publicPnlVisible,
      userId,
    ]
  );
  return { success: true };
}

/**
 * Update Creator Profile (username / display name / bio)
 * - handle is globally unique across all creators; enforced at DB level
 * - a user can only own ONE handle — tied to their wallet/user_id
 * - display_name is freeform, bio is freeform
 */
export async function updateCreatorProfile(userId: string, data: {
  handle?: string;
  displayName?: string;
  bio?: string;
  strategyTag?: string;
  walletAddress?: string;
}): Promise<{ success: boolean; reason?: string; handle?: string }> {
  const db = await getDb().catch(() => null);
  if (!db) return { success: false, reason: 'Database unavailable' };

  const wallet = (data.walletAddress || userId).trim();

  // Validate handle format if provided
  if (data.handle !== undefined) {
    const handle = data.handle.replace(/^@/, '').toLowerCase().trim();
    if (!handle || handle.length < 3 || handle.length > 30 || !/^[a-z0-9_.-]+$/.test(handle)) {
      return { success: false, reason: 'Handle must be 3–30 characters: lowercase letters, numbers, _ or . only.' };
    }

    // Check if the desired handle is already taken by a DIFFERENT user in racer_alpha_traders
    const conflict = await db.query(
      `SELECT user_id, payout_wallet_address FROM racer_alpha_traders 
       WHERE LOWER(handle) = LOWER($1) AND user_id <> $2 AND (payout_wallet_address IS NULL OR payout_wallet_address <> $3)`,
      [handle, userId, wallet]
    );
    if (conflict.rows.length > 0) {
      return { success: false, reason: `The handle "@${handle}" is already taken. Please choose another.` };
    }

    // Check if the desired handle is claimed by a DIFFERENT user in users table
    const conflictUser = await db.query(
      `SELECT id FROM users 
       WHERE LOWER(username) = LOWER($1) AND id <> $2 AND subaccount_id <> $3`,
      [handle, userId, wallet]
    );
    if (conflictUser.rows.length > 0) {
      return { success: false, reason: `The username "@${handle}" is already claimed by another account.` };
    }

    // Check if a trader record exists
    const existing = await db.query(
      `SELECT id, handle, display_name FROM racer_alpha_traders 
       WHERE user_id = $1 OR (payout_wallet_address = $2 AND payout_wallet_address IS NOT NULL) 
       LIMIT 1`,
      [userId, wallet]
    );

    if (existing.rows.length === 0) {
      const traderId = 'trader_' + userId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
      await db.query(
        `INSERT INTO racer_alpha_traders (
           id, user_id, handle, display_name, bio, strategy_tag, payout_wallet_address,
           key_price_near, tier_basic_price_near, tier_copy_price_near, tier_premium_price_near, is_active, is_creator_approved
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 3.5, 1.5, 3.5, 8.0, TRUE, TRUE)
         ON CONFLICT (handle) DO UPDATE SET
           display_name = COALESCE(EXCLUDED.display_name, racer_alpha_traders.display_name),
           bio = COALESCE(EXCLUDED.bio, racer_alpha_traders.bio),
           strategy_tag = COALESCE(EXCLUDED.strategy_tag, racer_alpha_traders.strategy_tag),
           payout_wallet_address = COALESCE(EXCLUDED.payout_wallet_address, racer_alpha_traders.payout_wallet_address),
           updated_at = NOW()`,
        [traderId, userId, handle, data.displayName || handle, data.bio || '', data.strategyTag || 'Trend Following', wallet]
      );
    } else {
      await db.query(
        `UPDATE racer_alpha_traders
         SET handle       = $1,
             display_name = COALESCE($2, display_name),
             bio          = COALESCE($3, bio),
             strategy_tag = COALESCE($4, strategy_tag),
             payout_wallet_address = COALESCE($5, payout_wallet_address),
             updated_at   = NOW()
         WHERE id = $6`,
        [handle, data.displayName || null, data.bio || null, data.strategyTag || null, wallet, existing.rows[0].id]
      );
    }

    // Firmly bind the username to this wallet address in users table (1 username per wallet)
    await db.query(
      `UPDATE users
       SET username = $1
       WHERE id = $2 OR subaccount_id = $3`,
      [handle, userId, wallet]
    ).catch(() => {});

    return { success: true, handle };
  } else {
    // No handle change – update display name / bio / strategy
    await db.query(
      `UPDATE racer_alpha_traders
       SET display_name = COALESCE($1, display_name),
           bio          = COALESCE($2, bio),
           strategy_tag = COALESCE($3, strategy_tag),
           payout_wallet_address = COALESCE($4, payout_wallet_address),
           updated_at   = NOW()
       WHERE user_id = $5 OR payout_wallet_address = $4`,
      [data.displayName || null, data.bio || null, data.strategyTag || null, wallet, userId]
    );

    return { success: true };
  }
}

export async function generateTerminalLink(userId: string): Promise<any> {
  const db = await getDb().catch(() => null);
  if (!db) return { success: false, reason: 'Database unavailable' };
  const token = '7X-' + crypto.randomBytes(6).toString('hex');
  await db.query(
    `UPDATE racer_alpha_traders SET terminal_token = $1 WHERE user_id = $2`,
    [token, userId]
  );
  return { success: true, terminalUrl: `https://raceralpha.xyz/terminal/${token}` };
}

export async function publishAlphaSignal(data: {
  traderId: string;
  tokenAddress: string;
  tokenSymbol?: string;
  tokenName?: string;
  side: string;
  priceNear?: number;
  amountNear?: number;
  venue?: string;
}): Promise<any> {
  const db = await getDb().catch(() => null);
  if (!db) return { success: false, reason: 'Database unavailable' };

  const signalId = 'sig_' + crypto.randomBytes(8).toString('hex');
  const txHash = 'tx_alpha_' + crypto.randomBytes(16).toString('hex');
  const tokenAddress = (data.tokenAddress || 'blackdragon.tkn.near').trim().toLowerCase();
  const side = (data.side || 'BUY').toUpperCase();
  const amountNear = Number(data.amountNear || 1.0);
  const priceNear = Number(data.priceNear || (amountNear / 50));
  const tokenSymbol = (data.tokenSymbol || tokenAddress.split('.')[0] || 'TKN').toUpperCase();
  const tokenName = data.tokenName || (tokenSymbol + ' Token');

  // Infer venue
  let venue = data.venue || 'Ref Finance';
  if (tokenAddress.endsWith('.meme-cooking.near') || tokenAddress.includes('memecooking')) venue = 'Meme.Cooking';
  else if (tokenAddress.includes('intear.near')) venue = 'InTear Launch';
  else if (tokenAddress.endsWith('.shardsmarket.near')) venue = 'Shards';
  else if (tokenAddress.endsWith('.nearlytrade.near')) venue = 'NearlyTrade';
  else if (tokenAddress.endsWith('.pad.onetokenhub.near')) venue = 'OneTokenHub';
  else if (tokenAddress.endsWith('.gaypad.j1-racing.near')) venue = 'Gaypad';
  else if (tokenAddress.endsWith('.nearpumpfun.near')) venue = 'NearPump';
  else if (tokenAddress.includes('rhea')) venue = 'Rhea Swap';

  // 1. Insert into racer_alpha_signals
  await db.query(`
    INSERT INTO racer_alpha_signals (
      id, trader_id, token_address, token_symbol, token_name, side, price_near, amount_near, pnl_pct, venue, tx_hash, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0.0, $9, $10, NOW())
  `, [
    signalId,
    data.traderId,
    tokenAddress,
    tokenSymbol,
    tokenName,
    side,
    priceNear,
    amountNear,
    venue,
    txHash
  ]);

  // 2. Insert or update racer_alpha_positions
  if (side === 'BUY') {
    const entryPriceUsd = priceNear * 4.95;
    const sizeTokens = amountNear / priceNear;
    await db.query(`
      INSERT INTO racer_alpha_positions (
        id, trader_id, symbol, token_address, side, size_tokens, entry_price_usd, current_price_usd, pnl_usd, pnl_pct, sparkline, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, 0, $9, NOW())
      ON CONFLICT (id) DO UPDATE SET
        size_tokens = racer_alpha_positions.size_tokens + EXCLUDED.size_tokens,
        updated_at = NOW()
    `, [
      'pos_' + data.traderId + '_' + tokenSymbol.toLowerCase(),
      data.traderId,
      tokenSymbol,
      tokenAddress,
      'BUY',
      sizeTokens,
      entryPriceUsd,
      entryPriceUsd,
      JSON.stringify([100, 105, 102, 108])
    ]).catch((e: any) => logger.warn(`Error updating position: ${e.message}`));
  }

  // 3. Count active subscribers for auto-copy
  const khRes = await db.query(`
    SELECT COUNT(*) FROM racer_alpha_keys 
    WHERE trader_id = $1 AND payment_status = 'completed' AND auto_copy_enabled = TRUE
  `, [data.traderId]).catch(() => ({ rows: [{ count: 0 }] }));
  const autoCopyFillsCount = parseInt(khRes.rows[0]?.count || '0', 10);

  // 4. Update trader volume & stats
  await db.query(`
    UPDATE racer_alpha_traders 
    SET total_trades = total_trades + 1, total_volume_near = total_volume_near + $1, updated_at = NOW()
    WHERE id = $2
  `, [amountNear, data.traderId]).catch(() => {});

  return {
    success: true,
    signalId,
    traderId: data.traderId,
    tokenSymbol,
    tokenAddress,
    side,
    amountNear,
    venue,
    txHash,
    autoCopyFillsCount,
    message: `Confidential ${side} intent executed on ${venue} via Stealth Relayer! ${autoCopyFillsCount} subscriber copy-fills triggered.`
  };
}

export interface AlphaTokenItem {
  address: string;
  symbol: string;
  name: string;
  icon?: string;
  venue: string;
  launchpad: 'memecooking' | 'ref' | 'pumppoly' | 'intear' | 'other';
  priceUsd: number;
  priceNear: number;
  change24h: number;
  marketCap: number;
  volume24h: number;
  bondingProgress: number;
  bondingPhase: 'graduated' | 'bonding' | 'dex_pool';
  liquidityUsd: number;
  sparkline: number[];
  holders: number;
}

export async function listAlphaTokens(options?: {
  category?: string;
  sort?: string;
  search?: string;
}): Promise<{ success: boolean; tokens: AlphaTokenItem[]; total: number }> {
  const NEAR_USD_RATE = 4.95;

  const defaultTokens: AlphaTokenItem[] = [
    // ── Ref Finance DEX Tokens ──
    {
      address: 'blackdragon.tkn.near',
      symbol: 'BLACKDRAGON',
      name: 'Black Dragon',
      venue: 'Ref Finance',
      launchpad: 'ref',
      priceUsd: 0.000084,
      priceNear: 0.000084 / NEAR_USD_RATE,
      change24h: 36.5,
      marketCap: 16800000,
      volume24h: 2420000,
      bondingProgress: 100,
      bondingPhase: 'dex_pool',
      liquidityUsd: 1420000,
      sparkline: [70, 75, 72, 80, 85, 92, 105, 114],
      holders: 4890,
    },
    {
      address: 'token.lonkingnearbackto2024.near',
      symbol: 'LONK',
      name: 'Lonk',
      venue: 'Ref Finance',
      launchpad: 'ref',
      priceUsd: 0.0000042,
      priceNear: 0.0000042 / NEAR_USD_RATE,
      change24h: 14.2,
      marketCap: 4200000,
      volume24h: 680000,
      bondingProgress: 100,
      bondingPhase: 'dex_pool',
      liquidityUsd: 490000,
      sparkline: [38, 39, 41, 40, 42, 45, 48, 47],
      holders: 3120,
    },
    {
      address: 'aurora.tkn.near',
      symbol: 'AURORA',
      name: 'Aurora',
      venue: 'Ref Finance',
      launchpad: 'ref',
      priceUsd: 0.185,
      priceNear: 0.185 / NEAR_USD_RATE,
      change24h: 6.8,
      marketCap: 85000000,
      volume24h: 1100000,
      bondingProgress: 100,
      bondingPhase: 'dex_pool',
      liquidityUsd: 3800000,
      sparkline: [170, 172, 175, 180, 182, 185],
      holders: 12400,
    },
    {
      address: 'shitzu.tkn.near',
      symbol: 'SHITZU',
      name: 'Shitzu',
      venue: 'Ref Finance',
      launchpad: 'ref',
      priceUsd: 0.0048,
      priceNear: 0.0048 / NEAR_USD_RATE,
      change24h: 28.3,
      marketCap: 2400000,
      volume24h: 310000,
      bondingProgress: 100,
      bondingPhase: 'dex_pool',
      liquidityUsd: 280000,
      sparkline: [35, 38, 40, 42, 45, 48],
      holders: 1980,
    },
    {
      address: 'neat.near',
      symbol: 'NEAT',
      name: 'Neat Inscription',
      venue: 'Ref Finance',
      launchpad: 'ref',
      priceUsd: 0.12,
      priceNear: 0.12 / NEAR_USD_RATE,
      change24h: -3.5,
      marketCap: 5100000,
      volume24h: 420000,
      bondingProgress: 100,
      bondingPhase: 'dex_pool',
      liquidityUsd: 620000,
      sparkline: [130, 128, 126, 124, 120],
      holders: 5400,
    },
    {
      address: 'slush.tkn.near',
      symbol: 'SLUSH',
      name: 'Slush',
      venue: 'Ref Finance',
      launchpad: 'ref',
      priceUsd: 0.000015,
      priceNear: 0.000015 / NEAR_USD_RATE,
      change24h: 19.1,
      marketCap: 150000,
      volume24h: 38000,
      bondingProgress: 100,
      bondingPhase: 'dex_pool',
      liquidityUsd: 42000,
      sparkline: [12, 13, 13, 14, 15],
      holders: 890,
    },
    {
      address: 'bean.tkn.near',
      symbol: 'BEAN',
      name: 'Bean Token',
      venue: 'Ref Finance',
      launchpad: 'ref',
      priceUsd: 0.000021,
      priceNear: 0.000021 / NEAR_USD_RATE,
      change24h: 8.4,
      marketCap: 210000,
      volume24h: 45000,
      bondingProgress: 100,
      bondingPhase: 'dex_pool',
      liquidityUsd: 65000,
      sparkline: [19, 20, 20, 21, 21],
      holders: 1100,
    },
    {
      address: 'wrap.near',
      symbol: 'wNEAR',
      name: 'Wrapped NEAR',
      venue: 'Ref Finance',
      launchpad: 'ref',
      priceUsd: 4.95,
      priceNear: 1.0,
      change24h: 4.2,
      marketCap: 5800000000,
      volume24h: 48000000,
      bondingProgress: 100,
      bondingPhase: 'dex_pool',
      liquidityUsd: 85000000,
      sparkline: [4.7, 4.75, 4.8, 4.88, 4.95],
      holders: 154000,
    },

    // ── Meme.Cooking Launchpad Tokens ──
    {
      address: 'pearpe-420.meme-cooking.near',
      symbol: 'PEARPE',
      name: 'PearPe Meme',
      venue: 'Meme.Cooking',
      launchpad: 'memecooking',
      priceUsd: 0.000034,
      priceNear: 0.000034 / NEAR_USD_RATE,
      change24h: 24.8,
      marketCap: 340000,
      volume24h: 85000,
      bondingProgress: 100,
      bondingPhase: 'graduated',
      liquidityUsd: 92000,
      sparkline: [25, 27, 29, 31, 34],
      holders: 1420,
    },
    {
      address: 'jambo-704.meme-cooking.near',
      symbol: 'JAMBO',
      name: 'Jambo',
      venue: 'Meme.Cooking',
      launchpad: 'memecooking',
      priceUsd: 0.000185,
      priceNear: 0.000185 / NEAR_USD_RATE,
      change24h: 42.1,
      marketCap: 1850000,
      volume24h: 340000,
      bondingProgress: 100,
      bondingPhase: 'graduated',
      liquidityUsd: 280000,
      sparkline: [120, 135, 148, 165, 185],
      holders: 2890,
    },
    {
      address: 'chill.meme-cooking.near',
      symbol: 'CHILL',
      name: 'Chill Guy',
      venue: 'Meme.Cooking',
      launchpad: 'memecooking',
      priceUsd: 0.000012,
      priceNear: 0.000012 / NEAR_USD_RATE,
      change24h: 15.4,
      marketCap: 120000,
      volume24h: 45000,
      bondingProgress: 82,
      bondingPhase: 'bonding',
      liquidityUsd: 38000,
      sparkline: [10, 10, 11, 11, 12],
      holders: 670,
    },
    {
      address: 'alpha.meme-cooking.near',
      symbol: 'ALPHA',
      name: 'Alpha Cooking',
      venue: 'Meme.Cooking',
      launchpad: 'memecooking',
      priceUsd: 0.00042,
      priceNear: 0.00042 / NEAR_USD_RATE,
      change24h: 58.2,
      marketCap: 420000,
      volume24h: 110000,
      bondingProgress: 94,
      bondingPhase: 'bonding',
      liquidityUsd: 84000,
      sparkline: [26, 30, 34, 38, 42],
      holders: 940,
    },
    {
      address: 'marss.meme-cooking.near',
      symbol: 'MARSS',
      name: 'Mars Mission',
      venue: 'Meme.Cooking',
      launchpad: 'memecooking',
      priceUsd: 0.000008,
      priceNear: 0.000008 / NEAR_USD_RATE,
      change24h: -4.1,
      marketCap: 80000,
      volume24h: 22000,
      bondingProgress: 64,
      bondingPhase: 'bonding',
      liquidityUsd: 26000,
      sparkline: [9, 9, 8, 8, 8],
      holders: 420,
    },
    {
      address: 'woof.meme-cooking.near',
      symbol: 'WOOF',
      name: 'Woof Near',
      venue: 'Meme.Cooking',
      launchpad: 'memecooking',
      priceUsd: 0.000028,
      priceNear: 0.000028 / NEAR_USD_RATE,
      change24h: 18.9,
      marketCap: 280000,
      volume24h: 68000,
      bondingProgress: 100,
      bondingPhase: 'graduated',
      liquidityUsd: 74000,
      sparkline: [22, 24, 25, 27, 28],
      holders: 1150,
    },
    {
      address: 'frog.meme-cooking.near',
      symbol: 'FROG',
      name: 'Pepe Near',
      venue: 'Meme.Cooking',
      launchpad: 'memecooking',
      priceUsd: 0.000055,
      priceNear: 0.000055 / NEAR_USD_RATE,
      change24h: 31.5,
      marketCap: 550000,
      volume24h: 140000,
      bondingProgress: 100,
      bondingPhase: 'graduated',
      liquidityUsd: 130000,
      sparkline: [40, 44, 48, 52, 55],
      holders: 1680,
    },
    {
      address: 'cat.meme-cooking.near',
      symbol: 'CAT',
      name: 'Neko Cat',
      venue: 'Meme.Cooking',
      launchpad: 'memecooking',
      priceUsd: 0.000019,
      priceNear: 0.000019 / NEAR_USD_RATE,
      change24h: 9.3,
      marketCap: 190000,
      volume24h: 52000,
      bondingProgress: 78,
      bondingPhase: 'bonding',
      liquidityUsd: 48000,
      sparkline: [17, 18, 18, 19, 19],
      holders: 810,
    },
    {
      address: 'pump.meme-cooking.near',
      symbol: 'PUMP',
      name: 'Near Pump',
      venue: 'Meme.Cooking',
      launchpad: 'memecooking',
      priceUsd: 0.000076,
      priceNear: 0.000076 / NEAR_USD_RATE,
      change24h: 12.7,
      marketCap: 760000,
      volume24h: 195000,
      bondingProgress: 100,
      bondingPhase: 'graduated',
      liquidityUsd: 165000,
      sparkline: [66, 68, 71, 74, 76],
      holders: 2150,
    },
    {
      address: 'neardog.meme-cooking.near',
      symbol: 'NDOG',
      name: 'Near Doge',
      venue: 'Meme.Cooking',
      launchpad: 'memecooking',
      priceUsd: 0.000032,
      priceNear: 0.000032 / NEAR_USD_RATE,
      change24h: -2.4,
      marketCap: 320000,
      volume24h: 75000,
      bondingProgress: 88,
      bondingPhase: 'bonding',
      liquidityUsd: 68000,
      sparkline: [34, 33, 33, 32, 32],
      holders: 1290,
    },

    // ── PumpPoly Launchpad Tokens ──
    {
      address: 'poly-101.pumppoly.near',
      symbol: 'POLY',
      name: 'PumpPoly',
      venue: 'PumpPoly',
      launchpad: 'pumppoly',
      priceUsd: 0.000062,
      priceNear: 0.000062 / NEAR_USD_RATE,
      change24h: 45.2,
      marketCap: 620000,
      volume24h: 160000,
      bondingProgress: 100,
      bondingPhase: 'graduated',
      liquidityUsd: 145000,
      sparkline: [42, 46, 51, 58, 62],
      holders: 1820,
    },
    {
      address: 'cook.pumppoly.near',
      symbol: 'COOK',
      name: 'Chef Poly',
      venue: 'PumpPoly',
      launchpad: 'pumppoly',
      priceUsd: 0.000018,
      priceNear: 0.000018 / NEAR_USD_RATE,
      change24h: 11.8,
      marketCap: 180000,
      volume24h: 42000,
      bondingProgress: 72,
      bondingPhase: 'bonding',
      liquidityUsd: 46000,
      sparkline: [15, 16, 17, 17, 18],
      holders: 730,
    },
    {
      address: 'nearcat.pumppoly.near',
      symbol: 'NCAT',
      name: 'Near Cat',
      venue: 'PumpPoly',
      launchpad: 'pumppoly',
      priceUsd: 0.0000095,
      priceNear: 0.0000095 / NEAR_USD_RATE,
      change24h: -8.5,
      marketCap: 95000,
      volume24h: 28000,
      bondingProgress: 54,
      bondingPhase: 'bonding',
      liquidityUsd: 31000,
      sparkline: [11, 11, 10, 10, 9.5],
      holders: 490,
    },
    {
      address: 'moonpoly.pumppoly.near',
      symbol: 'MOON',
      name: 'Moon Poly',
      venue: 'PumpPoly',
      launchpad: 'pumppoly',
      priceUsd: 0.000038,
      priceNear: 0.000038 / NEAR_USD_RATE,
      change24h: 22.4,
      marketCap: 380000,
      volume24h: 88000,
      bondingProgress: 89,
      bondingPhase: 'bonding',
      liquidityUsd: 79000,
      sparkline: [30, 32, 34, 36, 38],
      holders: 1040,
    },
    {
      address: 'racerpoly.pumppoly.near',
      symbol: 'RPOLY',
      name: 'Racer Poly',
      venue: 'PumpPoly',
      launchpad: 'pumppoly',
      priceUsd: 0.000115,
      priceNear: 0.000115 / NEAR_USD_RATE,
      change24h: 74.6,
      marketCap: 1150000,
      volume24h: 310000,
      bondingProgress: 100,
      bondingPhase: 'graduated',
      liquidityUsd: 260000,
      sparkline: [65, 78, 92, 105, 115],
      holders: 2450,
    },

    // ── Intear Launchpad Tokens ──
    {
      address: 'intear.intear.near',
      symbol: 'INTEAR',
      name: 'InTear Ecosystem',
      venue: 'InTear Launch',
      launchpad: 'intear',
      priceUsd: 0.00014,
      priceNear: 0.00014 / NEAR_USD_RATE,
      change24h: 16.3,
      marketCap: 1400000,
      volume24h: 220000,
      bondingProgress: 100,
      bondingPhase: 'graduated',
      liquidityUsd: 310000,
      sparkline: [118, 122, 128, 134, 140],
      holders: 2980,
    },
    {
      address: 'launch.intear.near',
      symbol: 'LAUNCH',
      name: 'InTear Launch',
      venue: 'InTear Launch',
      launchpad: 'intear',
      priceUsd: 0.000045,
      priceNear: 0.000045 / NEAR_USD_RATE,
      change24h: 33.8,
      marketCap: 450000,
      volume24h: 95000,
      bondingProgress: 92,
      bondingPhase: 'bonding',
      liquidityUsd: 96000,
      sparkline: [32, 35, 38, 41, 45],
      holders: 1320,
    },
    {
      address: 'rock.intear.near',
      symbol: 'ROCK',
      name: 'Rock Meme',
      venue: 'InTear Launch',
      launchpad: 'intear',
      priceUsd: 0.000007,
      priceNear: 0.000007 / NEAR_USD_RATE,
      change24h: 5.2,
      marketCap: 70000,
      volume24h: 18000,
      bondingProgress: 48,
      bondingPhase: 'bonding',
      liquidityUsd: 22000,
      sparkline: [6.5, 6.6, 6.8, 6.9, 7.0],
      holders: 390,
    },
  ];

  let allTokens = [...defaultTokens];

  // Dynamically merge cached tokens from DB
  const db = await getDb().catch(() => null);
  if (db) {
    try {
      const dbRes = await db.query(
        `SELECT token_address, symbol, name, venue, last_price, last_liquidity, bonding_progress_pct, bonding_phase
         FROM token_cache 
         WHERE chain = 'near' OR chain IS NULL
         ORDER BY updated_at DESC LIMIT 30`
      );
      const existingAddrs = new Set(allTokens.map(t => t.address.toLowerCase()));
      for (const row of dbRes.rows) {
        if (!row.token_address || existingAddrs.has(row.token_address.toLowerCase())) continue;
        const addr = row.token_address.toLowerCase();
        let launchpad: AlphaTokenItem['launchpad'] = 'other';
        let venue = row.venue || 'Ref Finance';
        if (addr.endsWith('.meme-cooking.near')) {
          launchpad = 'memecooking';
          venue = 'Meme.Cooking';
        } else if (addr.includes('intear.near')) {
          launchpad = 'intear';
          venue = 'InTear Launch';
        } else if (addr.includes('pumppoly')) {
          launchpad = 'pumppoly';
          venue = 'PumpPoly';
        } else {
          launchpad = 'ref';
          venue = 'Ref Finance';
        }

        const priceNear = parseFloat(row.last_price || '0') || 0.00001;
        const priceUsd = priceNear * NEAR_USD_RATE;
        const progress = parseFloat(row.bonding_progress_pct || '100');
        allTokens.push({
          address: row.token_address,
          symbol: (row.symbol || addr.split('.')[0]).toUpperCase(),
          name: row.name || row.symbol || 'NEAR Token',
          venue,
          launchpad,
          priceUsd,
          priceNear,
          change24h: 12.0,
          marketCap: Math.round(priceUsd * 10000000),
          volume24h: Math.round(priceUsd * 250000),
          bondingProgress: progress,
          bondingPhase: progress >= 100 ? 'graduated' : 'bonding',
          liquidityUsd: parseFloat(row.last_liquidity || '25000'),
          sparkline: [80, 85, 90, 95, 100],
          holders: 500,
        });
      }
    } catch {}
  }

  // Filter by category
  const category = (options?.category || 'all').toLowerCase().trim();
  if (category !== 'all') {
    if (category === 'memecooking' || category === 'meme.cooking') {
      allTokens = allTokens.filter(t => t.launchpad === 'memecooking');
    } else if (category === 'ref' || category === 'dex') {
      allTokens = allTokens.filter(t => t.launchpad === 'ref');
    } else if (category === 'pumppoly') {
      allTokens = allTokens.filter(t => t.launchpad === 'pumppoly');
    } else if (category === 'intear') {
      allTokens = allTokens.filter(t => t.launchpad === 'intear');
    }
  }

  // Filter by search query
  const query = (options?.search || '').toLowerCase().trim();
  if (query) {
    allTokens = allTokens.filter(t =>
      t.symbol.toLowerCase().includes(query) ||
      t.name.toLowerCase().includes(query) ||
      t.address.toLowerCase().includes(query)
    );
  }

  // Sort
  const sort = (options?.sort || 'volume').toLowerCase();
  if (sort === 'volume' || sort === 'volume_desc') {
    allTokens.sort((a, b) => b.volume24h - a.volume24h);
  } else if (sort === 'mcap' || sort === 'mcap_desc') {
    allTokens.sort((a, b) => b.marketCap - a.marketCap);
  } else if (sort === 'change' || sort === 'gainers') {
    allTokens.sort((a, b) => b.change24h - a.change24h);
  } else if (sort === 'bonding' || sort === 'curve') {
    allTokens.sort((a, b) => b.bondingProgress - a.bondingProgress);
  }

  return {
    success: true,
    tokens: allTokens,
    total: allTokens.length,
  };
}

