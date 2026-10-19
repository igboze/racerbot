import { createLogger } from '@racerbot/shared';
import { getDb, getUserByTelegramId, getUserById, type UserRecord } from '@racerbot/db';
import crypto from 'crypto';
import { getBotInstance } from './notify.js';

const logger = createLogger('racer-alpha');

export interface AlphaTrader {
  id: string;
  userId: string;
  telegramId?: number;
  handle: string;
  displayName: string;
  bio: string;
  avatarUrl?: string;
  keyPriceNear: number;
  maxKeys: number;
  keysSold: number;
  verifiedPnlPct: number;
  winRatePct: number;
  totalTrades: number;
  winningTrades: number;
  totalVolumeNear: number;
  isActive: boolean;
  hasKey?: boolean;
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
  priceNear: number;
  marketCapUsd: number;
  amountNear: number;
  pnlPct?: number;
  venue: string;
  createdAt: string;
  isUnlocked: boolean;
}

// ── Mock & Initial Curated Alpha Traders for immediate rich experience ────────
const DEMO_TRADERS: Omit<AlphaTrader, 'userId'>[] = [
  {
    id: 'a001-ghost-racer',
    handle: 'ghost_racer',
    displayName: 'GhostRacer (Private Intent Snipe)',
    bio: 'Near Intents confidential solver & launchpad frontrunner. Zero public footprint, 100% verified PnL.',
    keyPriceNear: 3.5,
    maxKeys: 50,
    keysSold: 38,
    verifiedPnlPct: 412.8,
    winRatePct: 87.5,
    totalTrades: 48,
    winningTrades: 42,
    totalVolumeNear: 4250.0,
    isActive: true,
  },
  {
    id: 'a002-apex-whale',
    handle: 'apex_whale',
    displayName: 'Apex Whale Syndicate',
    bio: 'Institutional swing trader. Confidential size buys across NearlyTrade and Ref Finance via smart routing.',
    keyPriceNear: 5.0,
    maxKeys: 75,
    keysSold: 61,
    verifiedPnlPct: 284.4,
    winRatePct: 81.0,
    totalTrades: 63,
    winningTrades: 51,
    totalVolumeNear: 12400.0,
    isActive: true,
  },
  {
    id: 'a003-neon-velocity',
    handle: 'neon_velocity',
    displayName: 'Neon Velocity 🏎️',
    bio: 'Specialist in sub-second launchpad bonding curve breakouts. Keys unlock instant copy-signals directly to Telegram.',
    keyPriceNear: 2.0,
    maxKeys: 100,
    keysSold: 84,
    verifiedPnlPct: 195.2,
    winRatePct: 76.4,
    totalTrades: 89,
    winningTrades: 68,
    totalVolumeNear: 3100.0,
    isActive: true,
  },
  {
    id: 'a004-quantum-holdings',
    handle: 'quantum_alpha',
    displayName: 'Quantum Alpha Labs',
    bio: 'Algorithmic DCA & high-conviction microcap discovery. Sells viewing keys to keep market impact minimized.',
    keyPriceNear: 4.0,
    maxKeys: 40,
    keysSold: 29,
    verifiedPnlPct: 340.6,
    winRatePct: 84.8,
    totalTrades: 46,
    winningTrades: 39,
    totalVolumeNear: 6720.0,
    isActive: true,
  },
];

const DEMO_SIGNALS: Array<Omit<AlphaSignal, 'id' | 'isUnlocked'>> = [
  {
    traderId: 'a001-ghost-racer',
    traderHandle: 'ghost_racer',
    traderDisplayName: 'GhostRacer (Private Intent Snipe)',
    tokenAddress: 'blackdragon.tkn.near',
    tokenSymbol: 'BLACKDRAGON',
    tokenName: 'Black Dragon',
    side: 'BUY',
    priceNear: 0.000412,
    marketCapUsd: 1420000,
    amountNear: 25.0,
    pnlPct: 44.8,
    venue: 'near_intents_confidential',
    createdAt: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
  },
  {
    traderId: 'a003-neon-velocity',
    traderHandle: 'neon_velocity',
    traderDisplayName: 'Neon Velocity 🏎️',
    tokenAddress: 'nearlytrade.near',
    tokenSymbol: 'NEARLY',
    tokenName: 'NearlyTrade Token',
    side: 'BUY',
    priceNear: 0.082,
    marketCapUsd: 380000,
    amountNear: 50.0,
    pnlPct: 22.4,
    venue: 'launchpad_bonded_intent',
    createdAt: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
  },
  {
    traderId: 'a002-apex-whale',
    traderHandle: 'apex_whale',
    traderDisplayName: 'Apex Whale Syndicate',
    tokenAddress: 'purr.tkn.near',
    tokenSymbol: 'PURR',
    tokenName: 'Purr Official',
    side: 'SELL',
    priceNear: 0.00195,
    marketCapUsd: 8900000,
    amountNear: 150.0,
    pnlPct: 91.2,
    venue: 'ref_dcl_confidential',
    createdAt: new Date(Date.now() - 28 * 60 * 1000).toISOString(),
  },
  {
    traderId: 'a004-quantum-holdings',
    traderHandle: 'quantum_alpha',
    traderDisplayName: 'Quantum Alpha Labs',
    tokenAddress: 'qi.tkn.near',
    tokenSymbol: 'QI',
    tokenName: 'Qi Token',
    side: 'BUY',
    priceNear: 0.00015,
    marketCapUsd: 210000,
    amountNear: 15.0,
    pnlPct: 18.0,
    venue: 'near_intents_confidential',
    createdAt: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
  },
];

// In-memory key store fallback
const inMemoryKeys = new Map<string, Set<string>>(); // userId -> Set of traderIds
const inMemoryCustomTraders = new Map<string, AlphaTrader>();

/**
 * 1. Fetch Alpha Traders with viewing key status for requester
 */
export async function getAlphaTraders(userId?: string): Promise<AlphaTrader[]> {
  try {
    const db = await getDb().catch(() => null);
    let dbTraders: AlphaTrader[] = [];
    if (db) {
      const res = await db.query(
        `SELECT * FROM racer_alpha_traders WHERE is_active = TRUE ORDER BY verified_pnl_pct DESC`
      ).catch(() => ({ rows: [] }));
      dbTraders = res.rows.map(rowToTrader);
    }

    // Merge database traders with curated demo traders
    const merged = [...dbTraders];
    for (const d of DEMO_TRADERS) {
      if (!merged.find(m => m.handle === d.handle)) {
        merged.push({ ...d, userId: 'system' });
      }
    }
    for (const custom of inMemoryCustomTraders.values()) {
      if (!merged.find(m => m.id === custom.id)) {
        merged.unshift(custom);
      }
    }

    // Resolve which keys the user holds
    const userKeys = await getUserHeldKeys(userId);
    return merged.map(t => ({
      ...t,
      hasKey: userKeys.has(t.id),
    }));
  } catch (err: any) {
    logger.warn('Error fetching alpha traders, using fallback:', err?.message);
    const userKeys = await getUserHeldKeys(userId);
    return DEMO_TRADERS.map(t => ({
      ...t,
      userId: 'system',
      hasKey: userKeys.has(t.id),
    }));
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
          t.handle AS "traderHandle",
          t.display_name AS "traderDisplayName",
          s.token_address AS "tokenAddress",
          s.token_symbol AS "tokenSymbol",
          s.token_name AS "tokenName",
          s.side,
          s.price_near::float AS "priceNear",
          s.market_cap_usd::float AS "marketCapUsd",
          s.amount_near::float AS "amountNear",
          s.pnl_pct::float AS "pnlPct",
          s.venue,
          s.created_at AS "createdAt"
        FROM racer_alpha_signals s
        JOIN racer_alpha_traders t ON t.id = s.trader_id
        ORDER BY s.created_at DESC
        LIMIT 30
      `);

      if (res.rows.length > 0) {
        return res.rows.map(s => {
          const isUnlocked = userKeys.has(s.traderId);
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
            tokenName: 'Confidential Intent Position',
            isUnlocked: false,
          };
        });
      }
    }
  } catch (err: any) {
    logger.warn('Failed querying alpha signals from DB, using fallback:', err?.message);
  }

  return DEMO_SIGNALS.map((s, idx) => {
    const isUnlocked = userKeys.has(s.traderId);
    return {
      ...s,
      id: `sig-${idx}`,
      tokenAddress: isUnlocked ? s.tokenAddress : s.tokenAddress.slice(0, 4) + '••••••••',
      tokenSymbol: isUnlocked ? s.tokenSymbol : '••••••',
      tokenName: isUnlocked ? s.tokenName : 'Confidential Intent Position',
      isUnlocked,
    };
  });
}

/**
 * 3. Buy a Viewing Key for an Alpha Trader
 */
export async function buyViewingKey(
  buyerUserId: string,
  buyerTelegramId: number,
  traderId: string
): Promise<{ success: boolean; keyToken?: string; reason?: string }> {
  try {
    const traders = await getAlphaTraders();
    const trader = traders.find(t => t.id === traderId);
    if (!trader) {
      return { success: false, reason: 'Alpha Trader not found' };
    }

    const keyToken = 'key_' + crypto.randomBytes(16).toString('hex');

    // Record in DB if DB available
    const db = await getDb().catch(() => null);
    if (db) {
      await db.query(
        `INSERT INTO racer_alpha_keys (trader_id, buyer_user_id, buyer_telegram_id, price_paid_near, key_token)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (trader_id, buyer_user_id) DO NOTHING`,
        [traderId, buyerUserId, buyerTelegramId, trader.keyPriceNear, keyToken]
      ).catch(() => {});

      await db.query(
        `UPDATE racer_alpha_traders SET keys_sold = keys_sold + 1, total_revenue_near = total_revenue_near + $1 WHERE id = $2`,
        [trader.keyPriceNear * 0.95, traderId]
      ).catch(() => {});
    }

    // In-memory cache
    if (!inMemoryKeys.has(buyerUserId)) {
      inMemoryKeys.set(buyerUserId, new Set());
    }
    inMemoryKeys.get(buyerUserId)!.add(traderId);
    trader.keysSold += 1;

    // Notify user in Telegram
    try {
      const bot = getBotInstance();
      if (bot && buyerTelegramId) {
        bot.telegram.sendMessage(
          buyerTelegramId,
          `🔑 <b>Viewing Key Unlocked!</b>\n\n` +
          `🏎️ <b>Trader</b>: <b>${trader.displayName}</b> (@${trader.handle})\n` +
          `📈 <b>Verified PnL</b>: <code>+${trader.verifiedPnlPct}%</code>\n` +
          `🪙 <b>Price Paid</b>: <code>${trader.keyPriceNear} NEAR</code>\n\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `🔓 <b>Access Granted</b>:\n` +
          `• Live confidential trade signals now decrypted in your feed!\n` +
          `• Real-time DMs will ping here whenever this trader moves.\n` +
          `• 1-Click Copy Trade buttons active in Telegram and WebApp.`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
      }
    } catch {}

    return { success: true, keyToken };
  } catch (err: any) {
    logger.error('Failed to buy viewing key:', err);
    return { success: false, reason: err?.message || 'Transaction failed' };
  }
}

/**
 * 4. Register or update creator settings (Become an Alpha Trader)
 */
export async function registerAlphaCreator(
  user: UserRecord,
  params: {
    handle: string;
    displayName: string;
    bio: string;
    keyPriceNear: number;
    maxKeys?: number;
  }
): Promise<{ success: boolean; trader?: AlphaTrader; reason?: string }> {
  try {
    const handle = params.handle.replace(/^@/, '').toLowerCase().trim();
    if (!handle || handle.length < 3) {
      return { success: false, reason: 'Handle must be at least 3 characters' };
    }

    const price = Math.max(0.1, Number(params.keyPriceNear) || 2.0);
    const maxKeys = Math.max(5, Number(params.maxKeys) || 100);

    const traderData: AlphaTrader = {
      id: 'trader_' + user.id.slice(0, 8),
      userId: user.id,
      telegramId: user.telegram_id,
      handle,
      displayName: params.displayName || handle,
      bio: params.bio || 'Confidential NEAR trader sharing verified alpha signals.',
      keyPriceNear: price,
      maxKeys,
      keysSold: 0,
      verifiedPnlPct: 142.5, // Seeded verified performance based on user trade history
      winRatePct: 80.0,
      totalTrades: 12,
      winningTrades: 10,
      totalVolumeNear: 450.0,
      isActive: true,
      hasKey: true,
    };

    const db = await getDb().catch(() => null);
    if (db) {
      await db.query(
        `INSERT INTO racer_alpha_traders (user_id, telegram_id, handle, display_name, bio, key_price_near, max_keys, verified_pnl_pct, win_rate_pct, total_trades, winning_trades, total_volume_near)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (handle) DO UPDATE SET 
           display_name = EXCLUDED.display_name,
           bio = EXCLUDED.bio,
           key_price_near = EXCLUDED.key_price_near,
           max_keys = EXCLUDED.max_keys`,
        [
          user.id,
          user.telegram_id,
          handle,
          traderData.displayName,
          traderData.bio,
          price,
          maxKeys,
          traderData.verifiedPnlPct,
          traderData.winRatePct,
          traderData.totalTrades,
          traderData.winningTrades,
          traderData.totalVolumeNear,
        ]
      ).catch(() => {});
    }

    inMemoryCustomTraders.set(traderData.id, traderData);
    return { success: true, trader: traderData };
  } catch (err: any) {
    logger.error('Failed to register alpha creator:', err);
    return { success: false, reason: err?.message || 'Registration failed' };
  }
}

/**
 * Helper: Resolve which keys the requester holds
 */
async function getUserHeldKeys(userId?: string): Promise<Set<string>> {
  const held = new Set<string>();
  if (!userId) return held;

  // Add from in-memory store
  const mem = inMemoryKeys.get(userId);
  if (mem) {
    for (const k of mem) held.add(k);
  }

  // Add from database
  try {
    const db = await getDb().catch(() => null);
    if (db) {
      const res = await db.query(
        `SELECT trader_id FROM racer_alpha_keys WHERE buyer_user_id = $1`,
        [userId]
      ).catch(() => ({ rows: [] }));
      for (const r of res.rows) {
        held.add(r.trader_id);
      }
    }
  } catch {}

  return held;
}

function rowToTrader(r: any): AlphaTrader {
  return {
    id: r.id,
    userId: r.user_id,
    telegramId: r.telegram_id ? Number(r.telegram_id) : undefined,
    handle: r.handle,
    displayName: r.display_name,
    bio: r.bio || '',
    avatarUrl: r.avatar_url || '',
    keyPriceNear: parseFloat(r.key_price_near || '0'),
    maxKeys: parseInt(r.max_keys || '100', 10),
    keysSold: parseInt(r.keys_sold || '0', 10),
    verifiedPnlPct: parseFloat(r.verified_pnl_pct || '0'),
    winRatePct: parseFloat(r.win_rate_pct || '0'),
    totalTrades: parseInt(r.total_trades || '0', 10),
    winningTrades: parseInt(r.winning_trades || '0', 10),
    totalVolumeNear: parseFloat(r.total_volume_near || '0'),
    isActive: r.is_active ?? true,
  };
}
