import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

let curr = process.cwd();
for (let i = 0; i < 5; i++) {
  const p = path.join(curr, '.env');
  if (fs.existsSync(p)) {
    dotenv.config({ path: p });
    break;
  }
  curr = path.dirname(curr);
}

// ── Local type definitions (not imported from shared — avoids circular deps) ──

export interface UserRecord {
  id: string;
  telegram_id: number;
  subaccount_id: string;
  scoped_key_encrypted: string;
  sui_address?: string | null;
  sui_private_key_enc?: string | null;
  starknet_address?: string | null;
  starknet_private_key_enc?: string | null;
  default_buy_pct: number | null;
  default_sell_pct: number | null;
  fee_tier: string;
  referral_fee_pct?: number;
  is_ambassador?: boolean;
  auto_buy_enabled: boolean;
  auto_buy_amount_near: number;
  auto_buy_min_liquidity_near: number;
  auto_buy_max_market_cap_usd?: number | null;
  slippage_pct: number;
  referred_by: string | null;
  referral_code: string | null;
  username: string | null;
  /** Whether the user's net worth (investment / unrealized value) is shown on shared PNL cards by default. */
  show_net_worth_on_card: boolean;
  /** Customizable quick buy amounts (e.g. '1, 5, 10' or '0.5, 2, 5') */
  custom_buy_amounts?: string | null;
  last_near_balance?: number | null;
  last_sui_balance?: number | null;
  last_strk_balance?: number | null;
  last_balance_check_at?: Date | null;
  created_at: Date;
}

export interface UserWalletRecord {
  id: string;
  user_id: string;
  chain: 'near' | 'sui' | 'starknet';
  address: string;
  name: string;
  encrypted_private_key: string;
  is_imported: boolean;
  is_active: boolean;
  created_at: Date;
}

export interface PositionRecord {
  id: string;
  user_id: string;
  chain?: 'near' | 'sui' | 'starknet';
  token_address: string;
  quantity_held: string;
  avg_entry_price: string;
  status: string;
  opened_at: Date;
  closed_at: Date | null;
  is_external_deposit?: boolean;
  external_deposit_detected_at?: Date | null;
}

export interface FillRecord {
  id: string;
  user_id: string;
  position_id: string;
  chain?: 'near' | 'sui' | 'starknet';
  side: string;
  token_address: string;
  amount: string;
  price: string;
  fee_paid: string;
  /** Actual native amount spent (buy) or received (sell), in human units (SUI / NEAR). Source of truth for investment calculations. */
  input_amount?: string | null;
  venue: string;
  tx_hash: string;
  created_at: Date;
}

export interface TriggerRecord {
  id: string;
  user_id: string;
  position_id: string;
  chain?: 'near' | 'sui' | 'starknet';
  type: string;
  target_value: string;
  /** Percentage of the position to sell when this trigger fires (1-100, default 100). */
  sell_pct: number;
  status: string;
  created_at: Date;
}

export interface TokenCacheRecord {
  token_address: string;
  chain?: 'near' | 'sui' | 'starknet';
  name?: string | null;
  symbol?: string | null;
  decimals?: number | null;
  total_supply?: string | null;
  pool_address?: string | null;
  venue?: string | null;
  rhea_pool_id?: number | null;
  bonding_phase?: 'prebonded' | 'bonded' | null;
  bonding_progress_pct?: number | null;
  dcl_pool_id?: string | null;
  last_price?: number | null;
  last_liquidity?: number | null;
  buy_tax_pct?: number | null;
  sell_tax_pct?: number | null;
  is_safe?: boolean | null;
  icon?: string | null;
  updated_at?: Date | null;
}

export interface ReferralRecord {
  id: string;
  referrer_id: string;
  referred_user_id: string;
  status: 'pending' | 'active' | 'completed';
  total_fees_earned: number;
  created_at: Date;
  completed_at: Date | null;
  referrer_fee_pct?: number;
  referrer_is_ambassador?: boolean;
}

export interface TokenShareRecord {
  id: string;
  code: string;
  token_address: string;
  referrer_id: string;
  created_at: Date;
}

export interface TokenReferralRecord {
  id: string;
  user_id: string;
  token_address: string;
  referrer_id: string;
  total_fees_earned: number;
  created_at: Date;
  last_trade_at: Date | null;
}

export interface CopyTradeTargetRecord {
  id: string;
  user_id: string;
  target_wallet: string;
  referrer_id?: string | null;
  buy_amount_near: number;
  copy_sells: boolean;
  max_slippage_pct: number;
  max_daily_budget_near: number | null;
  track_only: boolean;
  status: 'active' | 'paused' | 'stopped';
  created_at: Date;
  updated_at: Date;
}

export interface TradingCompetitionRecord {
  id: string;
  token_address: string;
  token_symbol: string;
  token_name: string;
  target_market_cap_usd: number;
  status: 'pending' | 'active' | 'completed';
  started_at: Date | null;
  ended_at: Date | null;
  created_at: Date;
}

export interface CompetitionLeaderboardEntry {
  rank: number;
  user_id: string;
  username: string | null;
  subaccount_id: string;
  total_volume_near: number;
  total_volume_usd: number;
  total_trades: number;
  buy_trades: number;
  sell_trades: number;
  last_trade_at: Date | null;
}

export interface CopyTradeFillRecord {
  id: string;
  copy_target_id: string;
  user_id: string;
  source_tx_hash: string;
  token_address: string;
  side: 'buy' | 'sell';
  amount_token: number | null;
  amount_near: number | null;
  our_tx_hash: string | null;
  status: 'pending' | 'filled' | 'failed' | 'skipped';
  skip_reason: string | null;
  created_at: Date;
}

export interface DcaOrderRecord {
  id: string;
  user_id: string;
  token_address: string;
  side: 'buy' | 'sell';
  amount_per_order: number;
  interval_seconds: number;
  total_orders: number;
  executed_orders: number;
  next_run_at: Date;
  min_price: number | null;
  max_price: number | null;
  status: 'active' | 'paused' | 'completed' | 'cancelled';
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface LimitOrderRecord {
  id: string;
  user_id: string;
  chain: string;
  token_address: string;
  side: 'buy' | 'sell';
  target_type: 'mcap' | 'price' | 'percent_offset';
  trigger_condition: 'lte' | 'gte';
  target_value: number;
  reference_price: number | null;
  reference_mcap: number | null;
  amount_input: number;
  sell_pct: number | null;
  max_slippage_pct: number;
  expires_at: Date | null;
  status: 'active' | 'executing' | 'filled' | 'cancelled' | 'failed' | 'expired';
  fill_tx_hash: string | null;
  fill_price: number | null;
  failure_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface RaceDropRecord {
  id: string;
  creator_id: string;
  creator_telegram_id: number;
  creator_name?: string;
  chain: 'near' | 'sui';
  token_address: string;
  token_symbol: string;
  decimals: number;
  amount_per_user?: string;
  total_amount: string;
  remaining_amount: string;
  total_claims: number;
  claims_count: number;
  split_mode: 'equal' | 'lucky';
  message_text?: string;
  group_chat_id?: number;
  group_message_id?: number;
  status: 'active' | 'completed' | 'expired' | 'cancelled';
  expires_at: Date;
  created_at: Date;
}

export interface RaceDropClaimRecord {
  id: string;
  drop_id: string;
  user_id: string;
  telegram_id: number;
  claimant_name?: string;
  claim_amount: string;
  is_new_user: boolean;
  tx_hash?: string;
  created_at: Date;
}

export interface CreateRaceDropParams {
  creator_id: string;
  creator_telegram_id: number;
  creator_name?: string;
  chain?: 'near' | 'sui';
  token_address: string;
  token_symbol: string;
  decimals?: number;
  amount_per_user?: string | number;
  total_amount: string | number;
  total_claims: number;
  split_mode?: 'equal' | 'lucky';
  message_text?: string;
  group_chat_id?: number;
  group_message_id?: number;
  expires_in_hours?: number;
}

export interface CreateLimitOrderParams {
  user_id: string;
  chain?: string;
  token_address: string;
  side: 'buy' | 'sell';
  target_type: 'mcap' | 'price' | 'percent_offset';
  trigger_condition: 'lte' | 'gte';
  target_value: number;
  reference_price?: number | null;
  reference_mcap?: number | null;
  amount_input: number;
  sell_pct?: number | null;
  max_slippage_pct?: number;
  expires_at?: Date | null;
}

export interface CreateCopyTradeTargetParams {
  user_id: string;
  target_wallet: string;
  referrer_id?: string | null;
  buy_amount_near?: number;
  copy_sells?: boolean;
  max_slippage_pct?: number;
  max_daily_budget_near?: number | null;
  track_only?: boolean;
}

export interface CreateDcaOrderParams {
  user_id: string;
  token_address: string;
  side: 'buy' | 'sell';
  amount_per_order: number;
  interval_seconds: number;
  total_orders?: number;
  min_price?: number | null;
  max_price?: number | null;
}

export interface CreateUserParams {
  telegram_id: number;
  subaccount_id: string;
  scoped_key_encrypted: string;
  sui_address?: string | null;
  sui_private_key_enc?: string | null;
  starknet_address?: string | null;
  starknet_private_key_enc?: string | null;
  default_buy_pct?: number;
  default_sell_pct?: number;
}

export interface CreatePositionParams {
  user_id: string;
  chain?: 'near' | 'sui' | 'starknet';
  token_address: string;
  quantity_held: string;
  avg_entry_price: string;
}

export interface CreateFillParams {
  user_id: string;
  position_id: string;
  chain?: 'near' | 'sui' | 'starknet';
  side: string;
  token_address: string;
  amount: string;
  price: string;
  fee_paid: string;
  /** Actual native amount spent (buy) or received (sell), in human units (SUI / NEAR). */
  input_amount?: string | null;
  venue: string;
  tx_hash: string;
}

export interface CreateTriggerParams {
  user_id: string;
  position_id: string;
  chain?: 'near' | 'sui' | 'starknet';
  type: string;
  target_value: string;
  /** Percentage of the position to sell when this trigger fires (1-100, default 100). */
  sell_pct?: number;
}

export interface UpdatePositionParams {
  position_id: string;
  quantity_held?: string;
  avg_entry_price?: string;
  status?: string;
  closed_at?: Date;
}

let pool: Pool | null = null;

export async function getDb(): Promise<Pool> {
  if (pool) return pool;

  const rawUrl = (process.env.DATABASE_URL || '').trim();
  const connectionString = rawUrl || 'postgres://localhost:5432/racerbot';

  pool = new Pool({
    connectionString,
    min: parseInt(process.env.POOL_MIN || '5'),
    max: parseInt(process.env.POOL_MAX || '20'),
    idleTimeoutMillis: parseInt(process.env.IDLE_TIMEOUT || '30000'),
    connectionTimeoutMillis: parseInt(process.env.CONN_TIMEOUT || '10000'),
  });
  pool.on('error', (err: any) => console.error('[DB] Connection pool error:', err));
  pool.on('connect', () => {
    // Connection established
  });

  return pool;
}



export async function connectDb(): Promise<void> {
  await getDb();
  console.log('[DB] Connected');
}

export async function disconnectDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export async function createUser(params: CreateUserParams): Promise<UserRecord> {
  const db = await getDb();
  const id = randomUUID();
  const result = await db.query(
    `INSERT INTO users (id, telegram_id, subaccount_id, scoped_key_encrypted, sui_address, sui_private_key_enc, starknet_address, starknet_private_key_enc, default_buy_pct, default_sell_pct, fee_tier)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (telegram_id) DO UPDATE SET 
       subaccount_id = COALESCE(users.subaccount_id, EXCLUDED.subaccount_id), 
       scoped_key_encrypted = COALESCE(users.scoped_key_encrypted, EXCLUDED.scoped_key_encrypted),
       sui_address = COALESCE(users.sui_address, EXCLUDED.sui_address),
       sui_private_key_enc = COALESCE(users.sui_private_key_enc, EXCLUDED.sui_private_key_enc),
       starknet_address = COALESCE(users.starknet_address, EXCLUDED.starknet_address),
       starknet_private_key_enc = COALESCE(users.starknet_private_key_enc, EXCLUDED.starknet_private_key_enc)
     RETURNING *`,
    [
      id,
      params.telegram_id,
      params.subaccount_id,
      params.scoped_key_encrypted,
      params.sui_address || null,
      params.sui_private_key_enc || null,
      params.starknet_address || null,
      params.starknet_private_key_enc || null,
      params.default_buy_pct || null,
      params.default_sell_pct || null,
      'standard',
    ]
  );
  const createdUser = rowToUser(result.rows[0]);

  // Ensure initial NEAR wallet is recorded in user_wallets if no active near wallet exists
  if (createdUser.subaccount_id && createdUser.scoped_key_encrypted) {
    const existingActiveNear = await db.query(
      "SELECT id FROM user_wallets WHERE user_id = $1 AND chain = 'near' AND is_active = TRUE LIMIT 1",
      [createdUser.id]
    ).catch(() => ({ rows: [] }));
    if (existingActiveNear.rows.length === 0) {
      await db.query(
        `INSERT INTO user_wallets (user_id, chain, address, name, encrypted_private_key, is_imported, is_active)
         VALUES ($1, 'near', $2, 'Wallet 1', $3, FALSE, TRUE)
         ON CONFLICT (user_id, chain, address) DO UPDATE SET is_active = TRUE`,
        [createdUser.id, createdUser.subaccount_id, createdUser.scoped_key_encrypted]
      ).catch((err: any) => console.warn('[DB] user_wallets near insert warning:', err?.message));
    }
  }

  // Ensure initial SUI wallet is recorded in user_wallets if no active sui wallet exists
  if (createdUser.sui_address && createdUser.sui_private_key_enc) {
    const existingActiveSui = await db.query(
      "SELECT id FROM user_wallets WHERE user_id = $1 AND chain = 'sui' AND is_active = TRUE LIMIT 1",
      [createdUser.id]
    ).catch(() => ({ rows: [] }));
    if (existingActiveSui.rows.length === 0) {
      await db.query(
        `INSERT INTO user_wallets (user_id, chain, address, name, encrypted_private_key, is_imported, is_active)
         VALUES ($1, 'sui', $2, 'Wallet 1', $3, FALSE, TRUE)
         ON CONFLICT (user_id, chain, address) DO UPDATE SET is_active = TRUE`,
        [createdUser.id, createdUser.sui_address, createdUser.sui_private_key_enc]
      ).catch((err: any) => console.warn('[DB] user_wallets sui insert warning:', err?.message));
    }
  }

  // Ensure initial Starknet wallet is recorded in user_wallets if no active starknet wallet exists
  if (createdUser.starknet_address && createdUser.starknet_private_key_enc) {
    const existingActiveStrk = await db.query(
      "SELECT id FROM user_wallets WHERE user_id = $1 AND chain = 'starknet' AND is_active = TRUE LIMIT 1",
      [createdUser.id]
    ).catch(() => ({ rows: [] }));
    if (existingActiveStrk.rows.length === 0) {
      await db.query(
        `INSERT INTO user_wallets (user_id, chain, address, name, encrypted_private_key, is_imported, is_active)
         VALUES ($1, 'starknet', $2, 'Wallet 1', $3, FALSE, TRUE)
         ON CONFLICT (user_id, chain, address) DO UPDATE SET is_active = TRUE`,
        [createdUser.id, createdUser.starknet_address, createdUser.starknet_private_key_enc]
      ).catch((err: any) => console.warn('[DB] user_wallets starknet insert warning:', err?.message));
    }
  }

  invalidateUserCache(undefined, params.telegram_id);
  return createdUser;
}

// ── Short-TTL user cache ────────────────────────────────────────────────────
// Every Telegram interaction re-reads the user row; a brief in-memory cache
// removes that round trip. All mutation paths below invalidate immediately,
// so cached reads never observe stale settings.
const USER_CACHE_TTL_MS = 10_000;
const USER_CACHE_MAX = 5_000;
const userCache = new Map<number, { user: UserRecord | null; expiresAt: number }>();
const userIdCache = new Map<string, { user: UserRecord | null; expiresAt: number }>();
const userIdToTelegramId = new Map<string, number>();

function invalidateUserCache(userId?: string, telegramId?: number) {
  if (telegramId !== undefined) {
    const hit = userCache.get(telegramId);
    userCache.delete(telegramId);
    if (hit?.user) userIdCache.delete(hit.user.id);
  }
  if (userId) {
    userIdCache.delete(userId);
    const tid = userIdToTelegramId.get(userId);
    if (tid !== undefined) userCache.delete(tid);
    userIdToTelegramId.delete(userId);
  }
}

export async function getUserByTelegramId(telegramId: number): Promise<UserRecord | null> {
  const hit = userCache.get(telegramId);
  if (hit && Date.now() < hit.expiresAt) {
    return hit.user ? { ...hit.user } : null;
  }
  const db = await getDb();
  const result = await db.query('SELECT * FROM users WHERE telegram_id = $1', [telegramId]);
  const user = result.rows.length === 0 ? null : rowToUser(result.rows[0]);
  if (userCache.size >= USER_CACHE_MAX) {
    const now = Date.now();
    for (const [k, v] of userCache) {
      if (now >= v.expiresAt) userCache.delete(k);
    }
  }
  userCache.set(telegramId, { user, expiresAt: Date.now() + USER_CACHE_TTL_MS });
  if (user) userIdToTelegramId.set(user.id, telegramId);
  return user ? { ...user } : null;
}

export async function getUserById(id: string): Promise<UserRecord | null> {
  if (!id) return null;

  // Guard: NEAR wallet addresses (e.g. "lunar-nexus-9768.racerbot.near") are NOT UUIDs.
  // Passing them to `WHERE id = $1` makes Postgres throw "invalid input syntax for type uuid".
  // Detect a non-UUID string by the presence of dots combined with "near" suffix and fall back
  // to subaccount_id lookup (TEXT column), which is always safe.
  const looksLikeNearAddress = /\.near$/.test(id) || /\.testnet$/.test(id);
  if (looksLikeNearAddress) {
    return getUserBySubaccount(id);
  }

  const hit = userIdCache.get(id);
  if (hit && Date.now() < hit.expiresAt) {
    return hit.user ? { ...hit.user } : null;
  }
  const db = await getDb();
  const result = await db.query('SELECT * FROM users WHERE id = $1', [id]);
  const user = result.rows.length === 0 ? null : rowToUser(result.rows[0]);
  if (userIdCache.size >= USER_CACHE_MAX) {
    const now = Date.now();
    for (const [k, v] of userIdCache) {
      if (now >= v.expiresAt) userIdCache.delete(k);
    }
  }
  userIdCache.set(id, { user, expiresAt: Date.now() + USER_CACHE_TTL_MS });
  return user ? { ...user } : null;
}

export async function getUserBySubaccount(subaccountId: string): Promise<UserRecord | null> {
  const db = await getDb();
  const result = await db.query('SELECT * FROM users WHERE subaccount_id = $1', [subaccountId]);
  if (result.rows.length === 0) return null;
  return rowToUser(result.rows[0]);
}

export async function getUserBySuiAddress(suiAddress: string): Promise<UserRecord | null> {
  const db = await getDb();
  const result = await db.query('SELECT * FROM users WHERE sui_address = $1', [suiAddress]);
  if (result.rows.length === 0) return null;
  return rowToUser(result.rows[0]);
}

export async function getUserByStarknetAddress(starknetAddress: string): Promise<UserRecord | null> {
  const db = await getDb();
  const result = await db.query('SELECT * FROM users WHERE LOWER(starknet_address) = LOWER($1)', [starknetAddress]);
  if (result.rows.length === 0) return null;
  return rowToUser(result.rows[0]);
}

export async function updateUserScopedKey(userId: string, encryptedKey: string): Promise<void> {
  const db = await getDb();
  await db.query('UPDATE users SET scoped_key_encrypted = $1 WHERE id = $2', [encryptedKey, userId]);
  invalidateUserCache(userId);
}

export async function updateUserSuiWallet(userId: string, suiAddress: string, suiPrivateKeyEnc: string): Promise<void> {
  const db = await getDb();
  await db.query('UPDATE users SET sui_address = $1, sui_private_key_enc = $2 WHERE id = $3', [suiAddress, suiPrivateKeyEnc, userId]);
  await db.query(
    `INSERT INTO user_wallets (user_id, chain, address, name, encrypted_private_key, is_imported, is_active)
     VALUES ($1, 'sui', $2, 'Wallet 1', $3, FALSE, TRUE)
     ON CONFLICT (user_id, chain, address) DO NOTHING`,
    [userId, suiAddress, suiPrivateKeyEnc]
  ).catch((err: any) => console.warn('[DB] user_wallets sui update warning:', err?.message));
  invalidateUserCache(userId);
}

export async function updateUserStarknetWallet(userId: string, starknetAddress: string, starknetPrivateKeyEnc: string): Promise<void> {
  const db = await getDb();
  await db.query('UPDATE users SET starknet_address = $1, starknet_private_key_enc = $2 WHERE id = $3', [starknetAddress, starknetPrivateKeyEnc, userId]);
  await db.query("UPDATE user_wallets SET is_active = FALSE WHERE user_id = $1 AND chain = 'starknet'", [userId]).catch(() => {});
  await db.query(
    `INSERT INTO user_wallets (user_id, chain, address, name, encrypted_private_key, is_imported, is_active)
     VALUES ($1, 'starknet', $2, 'Wallet 1', $3, FALSE, TRUE)
     ON CONFLICT (user_id, chain, address) DO UPDATE SET is_active = TRUE, encrypted_private_key = EXCLUDED.encrypted_private_key`,
    [userId, starknetAddress, starknetPrivateKeyEnc]
  ).catch((err: any) => console.warn('[DB] user_wallets starknet update warning:', err?.message));
  invalidateUserCache(userId);
}

// ── Multi-Wallet Management (Option A) ──────────────────────────────────────

function rowToUserWallet(row: any): UserWalletRecord {
  return {
    id: row.id,
    user_id: row.user_id,
    chain: row.chain,
    address: row.address,
    name: row.name,
    encrypted_private_key: row.encrypted_private_key,
    is_imported: Boolean(row.is_imported),
    is_active: Boolean(row.is_active),
    created_at: new Date(row.created_at),
  };
}

export async function getUserWallets(userId: string, chain: 'near' | 'sui' | 'starknet'): Promise<UserWalletRecord[]> {
  const db = await getDb();
  const res = await db.query(
    'SELECT * FROM user_wallets WHERE user_id = $1 AND chain = $2 ORDER BY created_at ASC',
    [userId, chain]
  );
  return res.rows.map(rowToUserWallet);
}

export async function getActiveWallet(userId: string, chain: 'near' | 'sui' | 'starknet'): Promise<UserWalletRecord | null> {
  const db = await getDb();
  const res = await db.query(
    'SELECT * FROM user_wallets WHERE user_id = $1 AND chain = $2 AND is_active = TRUE LIMIT 1',
    [userId, chain]
  );
  if (res.rows.length > 0) {
    return rowToUserWallet(res.rows[0]);
  }

  // Self-heal: If user has an address on this chain in users table, record and activate it in user_wallets
  try {
    const userRes = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (userRes.rows.length > 0) {
      const u = userRes.rows[0];
      let address: string | null = null;
      let encKey: string | null = null;
      if (chain === 'near') {
        address = u.subaccount_id;
        encKey = u.scoped_key_encrypted;
      } else if (chain === 'sui') {
        address = u.sui_address;
        encKey = u.sui_private_key_enc;
      } else if (chain === 'starknet') {
        address = u.starknet_address;
        encKey = u.starknet_private_key_enc;
      }

      if (address && encKey) {
        await db.query('UPDATE user_wallets SET is_active = FALSE WHERE user_id = $1 AND chain = $2', [userId, chain]).catch(() => {});
        const insertRes = await db.query(
          `INSERT INTO user_wallets (user_id, chain, address, name, encrypted_private_key, is_imported, is_active)
           VALUES ($1, $2, $3, 'Wallet 1', $4, FALSE, TRUE)
           ON CONFLICT (user_id, chain, address) DO UPDATE SET is_active = TRUE, encrypted_private_key = EXCLUDED.encrypted_private_key
           RETURNING *`,
          [userId, chain, address, encKey]
        );
        if (insertRes.rows.length > 0) {
          return rowToUserWallet(insertRes.rows[0]);
        }
      }
    }
  } catch (err: any) {
    console.warn(`[DB] getActiveWallet self-heal warning for user ${userId} chain ${chain}:`, err?.message);
  }

  return null;
}

export async function syncUserActiveWallet(
  userId: string,
  chain: 'near' | 'sui' | 'starknet',
  address: string,
  encryptedPrivateKey: string
): Promise<void> {
  const db = await getDb();
  await db.query(
    'UPDATE user_wallets SET is_active = FALSE WHERE user_id = $1 AND chain = $2',
    [userId, chain]
  ).catch(() => {});
  await db.query(
    `INSERT INTO user_wallets (user_id, chain, address, name, encrypted_private_key, is_imported, is_active)
     VALUES ($1, $2, $3, 'Wallet 1', $4, FALSE, TRUE)
     ON CONFLICT (user_id, chain, address) DO UPDATE SET is_active = TRUE, encrypted_private_key = EXCLUDED.encrypted_private_key`,
    [userId, chain, address, encryptedPrivateKey]
  ).catch((err: any) => console.warn('[DB] syncUserActiveWallet warning:', err?.message));

  if (chain === 'near') {
    await db.query(
      'UPDATE users SET subaccount_id = $1, scoped_key_encrypted = $2 WHERE id = $3',
      [address, encryptedPrivateKey, userId]
    ).catch(() => {});
  } else if (chain === 'sui') {
    await db.query(
      'UPDATE users SET sui_address = $1, sui_private_key_enc = $2 WHERE id = $3',
      [address, encryptedPrivateKey, userId]
    ).catch(() => {});
  } else if (chain === 'starknet') {
    await db.query(
      'UPDATE users SET starknet_address = $1, starknet_private_key_enc = $2 WHERE id = $3',
      [address, encryptedPrivateKey, userId]
    ).catch(() => {});
  }
  invalidateUserCache(userId);
}

export async function getUserWalletById(walletId: string): Promise<UserWalletRecord | null> {
  const db = await getDb();
  const res = await db.query('SELECT * FROM user_wallets WHERE id = $1', [walletId]);
  if (res.rows.length === 0) return null;
  return rowToUserWallet(res.rows[0]);
}

export interface CreateUserWalletParams {
  userId: string;
  chain: 'near' | 'sui' | 'starknet';
  address: string;
  name: string;
  encryptedPrivateKey: string;
  isImported?: boolean;
  isActive?: boolean;
}

export async function createUserWallet(params: CreateUserWalletParams): Promise<UserWalletRecord> {
  const db = await getDb();
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    if (params.isActive) {
      await client.query(
        'UPDATE user_wallets SET is_active = FALSE WHERE user_id = $1 AND chain = $2',
        [params.userId, params.chain]
      );
    }

    const res = await client.query(
      `INSERT INTO user_wallets (user_id, chain, address, name, encrypted_private_key, is_imported, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        params.userId,
        params.chain,
        params.address,
        params.name,
        params.encryptedPrivateKey,
        params.isImported ?? false,
        params.isActive ?? false,
      ]
    );

    if (params.isActive) {
      if (params.chain === 'near') {
        await client.query(
          'UPDATE users SET subaccount_id = $1, scoped_key_encrypted = $2 WHERE id = $3',
          [params.address, params.encryptedPrivateKey, params.userId]
        );
      } else if (params.chain === 'sui') {
        await client.query(
          'UPDATE users SET sui_address = $1, sui_private_key_enc = $2 WHERE id = $3',
          [params.address, params.encryptedPrivateKey, params.userId]
        );
      } else if (params.chain === 'starknet') {
        await client.query(
          'UPDATE users SET starknet_address = $1, starknet_private_key_enc = $2 WHERE id = $3',
          [params.address, params.encryptedPrivateKey, params.userId]
        );
      }
    }

    await client.query('COMMIT');
    invalidateUserCache(params.userId);
    return rowToUserWallet(res.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function setActiveWallet(userId: string, chain: 'near' | 'sui' | 'starknet', walletId: string): Promise<UserWalletRecord> {
  const db = await getDb();
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const checkRes = await client.query(
      'SELECT * FROM user_wallets WHERE id = $1 AND user_id = $2 AND chain = $3',
      [walletId, userId, chain]
    );
    if (checkRes.rows.length === 0) {
      throw new Error('Wallet not found');
    }
    const targetWallet = rowToUserWallet(checkRes.rows[0]);

    await client.query(
      'UPDATE user_wallets SET is_active = FALSE WHERE user_id = $1 AND chain = $2',
      [userId, chain]
    );

    const updateRes = await client.query(
      'UPDATE user_wallets SET is_active = TRUE WHERE id = $1 RETURNING *',
      [walletId]
    );

    if (chain === 'near') {
      await client.query(
        'UPDATE users SET subaccount_id = $1, scoped_key_encrypted = $2 WHERE id = $3',
        [targetWallet.address, targetWallet.encrypted_private_key, userId]
      );
    } else if (chain === 'sui') {
      await client.query(
        'UPDATE users SET sui_address = $1, sui_private_key_enc = $2 WHERE id = $3',
        [targetWallet.address, targetWallet.encrypted_private_key, userId]
      );
    } else if (chain === 'starknet') {
      await client.query(
        'UPDATE users SET starknet_address = $1, starknet_private_key_enc = $2 WHERE id = $3',
        [targetWallet.address, targetWallet.encrypted_private_key, userId]
      );
    }

    await client.query('COMMIT');
    invalidateUserCache(userId);
    return rowToUserWallet(updateRes.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function renameUserWallet(userId: string, walletId: string, newName: string): Promise<UserWalletRecord> {
  const db = await getDb();
  const res = await db.query(
    'UPDATE user_wallets SET name = $1 WHERE id = $2 AND user_id = $3 RETURNING *',
    [newName.trim(), walletId, userId]
  );
  if (res.rows.length === 0) {
    throw new Error('Wallet not found');
  }
  return rowToUserWallet(res.rows[0]);
}

export async function deleteUserWallet(userId: string, walletId: string): Promise<{ success: boolean; fallbackWallet?: UserWalletRecord }> {
  const db = await getDb();
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const checkRes = await client.query(
      'SELECT * FROM user_wallets WHERE id = $1 AND user_id = $2',
      [walletId, userId]
    );
    if (checkRes.rows.length === 0) {
      throw new Error('Wallet not found');
    }
    const wallet = rowToUserWallet(checkRes.rows[0]);

    if (!wallet.is_imported) {
      throw new Error('Cannot delete your primary generated wallet.');
    }

    const allWalletsRes = await client.query(
      'SELECT * FROM user_wallets WHERE user_id = $1 AND chain = $2 ORDER BY created_at ASC',
      [userId, wallet.chain]
    );
    if (allWalletsRes.rows.length <= 1) {
      throw new Error('Cannot delete the only wallet on this chain.');
    }

    await client.query('DELETE FROM user_wallets WHERE id = $1', [walletId]);

    let fallbackWallet: UserWalletRecord | undefined;
    if (wallet.is_active) {
      const remaining = allWalletsRes.rows.filter(r => r.id !== walletId);
      const nextActiveRow = remaining[0];
      const updateRes = await client.query('UPDATE user_wallets SET is_active = TRUE WHERE id = $1 RETURNING *', [nextActiveRow.id]);
      fallbackWallet = rowToUserWallet(updateRes.rows[0]);

      if (wallet.chain === 'near') {
        await client.query(
          'UPDATE users SET subaccount_id = $1, scoped_key_encrypted = $2 WHERE id = $3',
          [fallbackWallet.address, fallbackWallet.encrypted_private_key, userId]
        );
      } else if (wallet.chain === 'sui') {
        await client.query(
          'UPDATE users SET sui_address = $1, sui_private_key_enc = $2 WHERE id = $3',
          [fallbackWallet.address, fallbackWallet.encrypted_private_key, userId]
        );
      } else if (wallet.chain === 'starknet') {
        await client.query(
          'UPDATE users SET starknet_address = $1, starknet_private_key_enc = $2 WHERE id = $3',
          [fallbackWallet.address, fallbackWallet.encrypted_private_key, userId]
        );
      }
    }

    await client.query('COMMIT');
    invalidateUserCache(userId);
    return { success: true, fallbackWallet };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function updateUserDefaults(userId: string, buyPct?: number, sellPct?: number): Promise<void> {
  const db = await getDb();
  await db.query('UPDATE users SET default_buy_pct = $1, default_sell_pct = $2 WHERE id = $3', [buyPct, sellPct, userId]);
  invalidateUserCache(userId);
}

export interface UpdateUserSettingsParams {
  auto_buy_enabled?: boolean;
  auto_buy_amount_near?: number;
  auto_buy_min_liquidity_near?: number;
  auto_buy_max_market_cap_usd?: number | null;
  slippage_pct?: number;
  default_buy_pct?: number;
  default_sell_pct?: number;
  /** Whether to show the user's personal net worth (investment / value) on PNL card images by default. */
  show_net_worth_on_card?: boolean;
  custom_buy_amounts?: string;
}

export async function updateUserSettings(userId: string, params: UpdateUserSettingsParams): Promise<UserRecord> {
  const db = await getDb();
  const setParts: string[] = [];
  const values: any[] = [];
  let idx = 1;

  if (params.auto_buy_enabled !== undefined) {
    setParts.push(`auto_buy_enabled = $${idx++}`);
    values.push(params.auto_buy_enabled);
  }
  if (params.auto_buy_amount_near !== undefined) {
    setParts.push(`auto_buy_amount_near = $${idx++}`);
    values.push(params.auto_buy_amount_near);
  }
  if (params.auto_buy_min_liquidity_near !== undefined) {
    setParts.push(`auto_buy_min_liquidity_near = $${idx++}`);
    values.push(params.auto_buy_min_liquidity_near);
  }
  if (params.auto_buy_max_market_cap_usd !== undefined) {
    setParts.push(`auto_buy_max_market_cap_usd = $${idx++}`);
    values.push(params.auto_buy_max_market_cap_usd);
  }
  if (params.slippage_pct !== undefined) {
    setParts.push(`slippage_pct = $${idx++}`);
    values.push(params.slippage_pct);
  }
  if (params.default_buy_pct !== undefined) {
    setParts.push(`default_buy_pct = $${idx++}`);
    values.push(params.default_buy_pct);
  }
  if (params.default_sell_pct !== undefined) {
    setParts.push(`default_sell_pct = $${idx++}`);
    values.push(params.default_sell_pct);
  }
  if (params.show_net_worth_on_card !== undefined) {
    setParts.push(`show_net_worth_on_card = $${idx++}`);
    values.push(params.show_net_worth_on_card);
  }
  if (params.custom_buy_amounts !== undefined) {
    setParts.push(`custom_buy_amounts = $${idx++}`);
    values.push(params.custom_buy_amounts);
  }

  if (setParts.length === 0) {
    const u = await getUserById(userId);
    return u!;
  }

  values.push(userId);
  const result = await db.query(
    `UPDATE users SET ${setParts.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  invalidateUserCache(userId);
  return rowToUser(result.rows[0]);
}

export async function createPosition(params: CreatePositionParams): Promise<PositionRecord> {
  const db = await getDb();
  const id = generateId();
  const chain = params.chain || 'near';

  // Use INSERT ... ON CONFLICT DO NOTHING so that two concurrent buys for the
  // same (user, token, chain) never create duplicate open positions.
  // The partial unique index idx_positions_unique_open enforces exactly one open
  // row per user+token+chain. On conflict we fetch and return the existing row.
  try {
    const result = await db.query(
      `INSERT INTO positions (id, user_id, chain, token_address, quantity_held, avg_entry_price, status, opened_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'open', NOW())
       ON CONFLICT (user_id, token_address, chain) WHERE status = 'open'
       DO NOTHING
       RETURNING *`,
      [id, params.user_id, chain, params.token_address, params.quantity_held, params.avg_entry_price]
    );

    if (result.rows.length > 0) {
      return rowToPosition(result.rows[0]);
    }

    // Another concurrent insert won the race — fetch and return the canonical row.
    const existing = await db.query(
      `SELECT * FROM positions WHERE user_id = $1 AND token_address = $2 AND chain = $3 AND status = 'open' LIMIT 1`,
      [params.user_id, params.token_address, chain]
    );
    if (existing.rows.length > 0) {
      return rowToPosition(existing.rows[0]);
    }
  } catch (err: any) {
    if (err?.code === '42P10' || err?.message?.includes('no unique or exclusion constraint')) {
      await db.query(
        'INSERT INTO positions (id, user_id, chain, token_address, quantity_held, avg_entry_price, status, opened_at) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())',
        [id, params.user_id, chain, params.token_address, params.quantity_held, params.avg_entry_price, 'open']
      );
      return { ...params, id, chain, status: 'open', opened_at: new Date(), closed_at: null };
    }
    throw err;
  }

  return { ...params, id, chain, status: 'open', opened_at: new Date(), closed_at: null };
}

export async function getOpenPositions(userId: string): Promise<PositionRecord[]> {
  const db = await getDb();
  const result = await db.query('SELECT * FROM positions WHERE user_id = $1 AND status = $2', [userId, 'open']);
  return result.rows.map(rowToPosition);
}

export async function getPositionById(positionId: string): Promise<PositionRecord | null> {
  const db = await getDb();
  const result = await db.query('SELECT * FROM positions WHERE id = $1', [positionId]);
  if (result.rows.length === 0) return null;
  return rowToPosition(result.rows[0]);
}

export async function getPositionsByIds(positionIds: string[]): Promise<PositionRecord[]> {
  if (positionIds.length === 0) return [];
  const db = await getDb();
  const result = await db.query('SELECT * FROM positions WHERE id = ANY($1)', [positionIds]);
  return result.rows.map(rowToPosition);
}

export async function updatePosition(params: UpdatePositionParams): Promise<void> {
  const db = await getDb();
  const setParts: string[] = [];
  const values: any[] = [];
  let idx = 1;

  if (params.quantity_held !== undefined) {
    setParts.push(`quantity_held = $${idx++}`);
    values.push(params.quantity_held);
  }
  if (params.avg_entry_price !== undefined) {
    setParts.push(`avg_entry_price = $${idx++}`);
    values.push(params.avg_entry_price);
  }
  if (params.status !== undefined) {
    setParts.push(`status = $${idx++}`);
    values.push(params.status);
  }
  if (params.closed_at !== undefined) {
    setParts.push(`closed_at = $${idx++}`);
    values.push(params.closed_at);
  }

  values.push(params.position_id);
  await db.query(`UPDATE positions SET ${setParts.join(', ')} WHERE id = $${idx}`, values);
}

export async function createFill(params: CreateFillParams): Promise<{ fill: FillRecord; inserted: boolean; fillId: string }> {
  const db = await getDb();
  const id = generateId();
  const client = await db.connect();
  const chain = params.chain || 'near';

  try {
    await client.query('BEGIN');

    let insertResult;
    try {
      insertResult = await client.query(
        `INSERT INTO fills (id, user_id, position_id, chain, side, token_address, amount, price, fee_paid, input_amount, venue, tx_hash, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
         ON CONFLICT (tx_hash) DO NOTHING
         RETURNING id`,
        [id, params.user_id, params.position_id, chain, params.side, params.token_address, params.amount, params.price, params.fee_paid, params.input_amount ?? null, params.venue, params.tx_hash]
      );
    } catch (insertErr: any) {
      if (insertErr?.message?.includes('fills_venue_check') || insertErr?.message?.includes('fills venue check') || insertErr?.message?.includes('input_amount')) {
        // If input_amount column doesn't exist yet (migration pending), fall back to old schema
        await client.query('ALTER TABLE fills DROP CONSTRAINT IF EXISTS fills_venue_check').catch(() => {});
        insertResult = await client.query(
          `INSERT INTO fills (id, user_id, position_id, chain, side, token_address, amount, price, fee_paid, venue, tx_hash, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
           ON CONFLICT (tx_hash) DO NOTHING
           RETURNING id`,
          [id, params.user_id, params.position_id, chain, params.side, params.token_address, params.amount, params.price, params.fee_paid, params.venue, params.tx_hash]
        );
      } else {
        throw insertErr;
      }
    }

    const inserted = insertResult.rows.length > 0;

    if (inserted) {
      // Only update position if the fill was actually inserted
      await client.query(
        'SELECT update_position_fill($1, $2, $3, $4, $5)',
        [params.position_id, params.side, params.amount, params.price, params.fee_paid]
      );
    }

    await client.query('COMMIT');

    return {
      fill: { ...params, id, chain, created_at: new Date() },
      inserted,
      fillId: id,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getFillsByPosition(positionId: string): Promise<FillRecord[]> {
  const db = await getDb();
  const result = await db.query('SELECT * FROM fills WHERE position_id = $1 ORDER BY created_at ASC', [positionId]);
  return result.rows.map(rowToFill);
}

export async function createTrigger(params: CreateTriggerParams): Promise<TriggerRecord> {
  const db = await getDb();
  const id = generateId();
  const chain = params.chain || 'near';
  const sellPct = params.sell_pct ?? 100;
  await db.query(
    'INSERT INTO triggers (id, user_id, position_id, chain, type, target_value, sell_pct, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())',
    [id, params.user_id, params.position_id, chain, params.type, params.target_value, sellPct, 'active']
  );
  return { ...params, id, chain, sell_pct: sellPct, status: 'active', created_at: new Date() };
}

export async function getActiveTriggers(): Promise<TriggerRecord[]> {
  const db = await getDb();
  const result = await db.query('SELECT * FROM triggers WHERE status = $1', ['active']);
  return result.rows.map(rowToTrigger);
}

export async function getTriggersByPosition(positionId: string): Promise<TriggerRecord[]> {
  const db = await getDb();
  const result = await db.query('SELECT * FROM triggers WHERE position_id = $1 AND status = $2', [positionId, 'active']);
  return result.rows.map(rowToTrigger);
}

export async function markTriggerFired(triggerId: string): Promise<void> {
  const db = await getDb();
  await db.query('UPDATE triggers SET status = $1 WHERE id = $2', ['fired', triggerId]);
}

export async function cancelTriggersByPosition(
  positionId: string,
  type?: 'stop_loss' | 'take_profit' | 'market_cap'
): Promise<void> {
  const db = await getDb();
  if (type) {
    await db.query(
      'UPDATE triggers SET status = $1 WHERE position_id = $2 AND type = $3 AND status = $4',
      ['cancelled', positionId, type, 'active']
    );
  } else {
    await db.query(
      'UPDATE triggers SET status = $1 WHERE position_id = $2 AND status = $3',
      ['cancelled', positionId, 'active']
    );
  }
}

export async function upsertTrigger(params: CreateTriggerParams): Promise<TriggerRecord> {
  const db = await getDb();
  await db.query(
    'UPDATE triggers SET status = $1 WHERE position_id = $2 AND type = $3 AND status = $4',
    ['cancelled', params.position_id, params.type, 'active']
  );
  return createTrigger(params);
}

function computeShortKey(tokenAddress: string): string {
  if (!tokenAddress || typeof tokenAddress !== 'string') return '';
  const trimmed = tokenAddress.trim();
  if (trimmed.length <= 32) return trimmed;
  let hash = 0;
  for (let i = 0; i < trimmed.length; i++) {
    hash = ((hash << 5) - hash) + trimmed.charCodeAt(i);
    hash |= 0;
  }
  const hex = Math.abs(hash).toString(16).padStart(8, '0') + trimmed.slice(-4);
  return `t_${hex}`;
}

export async function findTokenAddressByShortKey(shortKey: string): Promise<string | null> {
  const db = await getDb();
  const cacheRes = await db.query('SELECT token_address FROM token_cache').catch(() => ({ rows: [] }));
  for (const row of cacheRes.rows) {
    if (row.token_address && computeShortKey(row.token_address) === shortKey) {
      return row.token_address;
    }
  }
  const posRes = await db.query('SELECT DISTINCT token_address FROM positions').catch(() => ({ rows: [] }));
  for (const row of posRes.rows) {
    if (row.token_address && computeShortKey(row.token_address) === shortKey) {
      return row.token_address;
    }
  }
  const fillRes = await db.query('SELECT DISTINCT token_address FROM fills').catch(() => ({ rows: [] }));
  for (const row of fillRes.rows) {
    if (row.token_address && computeShortKey(row.token_address) === shortKey) {
      return row.token_address;
    }
  }
  return null;
}

export async function getTokenCache(address: string): Promise<TokenCacheRecord | null> {
  const db = await getDb();
  const result = await db.query('SELECT * FROM token_cache WHERE token_address = $1', [address]);
  if (result.rows.length === 0) return null;
  return rowToTokenCache(result.rows[0]);
}

export async function upsertTokenCache(record: TokenCacheRecord): Promise<void> {
  const db = await getDb();
  const chain = record.chain || 'near';
  await db.query(
    `INSERT INTO token_cache (token_address, chain, name, symbol, decimals, total_supply, pool_address, venue, rhea_pool_id, bonding_phase, bonding_progress_pct, dcl_pool_id, last_price, last_liquidity, buy_tax_pct, sell_tax_pct, is_safe, icon, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, NOW())
     ON CONFLICT (token_address) DO UPDATE SET 
       chain = COALESCE(EXCLUDED.chain, token_cache.chain),
       name = COALESCE(EXCLUDED.name, token_cache.name), 
       symbol = COALESCE(EXCLUDED.symbol, token_cache.symbol), 
       decimals = COALESCE(EXCLUDED.decimals, token_cache.decimals), 
       total_supply = COALESCE(EXCLUDED.total_supply, token_cache.total_supply),
       pool_address = COALESCE(EXCLUDED.pool_address, token_cache.pool_address), 
       venue = COALESCE(EXCLUDED.venue, token_cache.venue), 
       rhea_pool_id = COALESCE(EXCLUDED.rhea_pool_id, token_cache.rhea_pool_id),
       bonding_phase = COALESCE(EXCLUDED.bonding_phase, token_cache.bonding_phase),
       bonding_progress_pct = COALESCE(EXCLUDED.bonding_progress_pct, token_cache.bonding_progress_pct),
       dcl_pool_id = COALESCE(EXCLUDED.dcl_pool_id, token_cache.dcl_pool_id),
       last_price = COALESCE(EXCLUDED.last_price, token_cache.last_price), 
       last_liquidity = COALESCE(EXCLUDED.last_liquidity, token_cache.last_liquidity), 
       buy_tax_pct = COALESCE(EXCLUDED.buy_tax_pct, token_cache.buy_tax_pct),
       sell_tax_pct = COALESCE(EXCLUDED.sell_tax_pct, token_cache.sell_tax_pct),
       is_safe = COALESCE(EXCLUDED.is_safe, token_cache.is_safe),
       icon = COALESCE(EXCLUDED.icon, token_cache.icon),
       updated_at = NOW()`,
    [
      record.token_address,
      chain,
      record.name ?? null,
      record.symbol ?? null,
      record.decimals ?? null,
      record.total_supply ?? null,
      record.pool_address ?? null,
      record.venue ?? null,
      record.rhea_pool_id ?? null,
      record.bonding_phase ?? null,
      record.bonding_progress_pct ?? null,
      record.dcl_pool_id ?? null,
      record.last_price ?? null,
      record.last_liquidity ?? null,
      record.buy_tax_pct ?? null,
      record.sell_tax_pct ?? null,
      record.is_safe ?? null,
      record.icon ?? null,
    ]
  );
}

export async function recordFee(fillId: string, amount: string): Promise<void> {
  const db = await getDb();
  const id = generateId();
  await db.query('INSERT INTO fee_ledger (id, fill_id, amount, created_at) VALUES ($1, $2, $3, NOW())', [id, fillId, amount]);
}

// ── Trade Attempt Observability ───────────────────────────────────────────────

export interface RecordTradeAttemptParams {
  user_id: string;
  side: 'buy' | 'sell';
  venue: string;
  token_in: string;
  token_out: string;
  amount_in: string;
  min_amount_out?: string | null;
  slippage_pct?: number | null;
}

export async function recordTradeAttempt(params: RecordTradeAttemptParams): Promise<string> {
  const db = await getDb();
  const result = await db.query(
    `INSERT INTO trade_attempts (user_id, side, venue, token_in, token_out, amount_in, min_amount_out, slippage_pct)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      params.user_id,
      params.side,
      params.venue,
      params.token_in,
      params.token_out,
      params.amount_in,
      params.min_amount_out ?? null,
      params.slippage_pct ?? null,
    ]
  );
  return result.rows[0].id as string;
}

export interface UpdateTradeAttemptParams {
  status: 'pending' | 'success' | 'failed';
  tx_hash?: string | null;
  error?: string | null;
  timings?: Record<string, number> | null;
}

export async function updateTradeAttempt(id: string, params: UpdateTradeAttemptParams): Promise<void> {
  const db = await getDb();
  // NOTE: every parameter must be referenced — Postgres rejects statements
  // with unreferenced params (42P18 "could not determine data type of
  // parameter $1"). An earlier version of this query passed id twice with
  // WHERE id = $6, so EVERY update threw and trade_attempts stayed pending.
  await db.query(
    `UPDATE trade_attempts
     SET status = $2,
         tx_hash = COALESCE($3, tx_hash),
         error = $4,
         timings = COALESCE($5, timings),
         updated_at = NOW()
     WHERE id = $1`,
    [id, params.status, params.tx_hash ?? null, params.error ?? null, params.timings ? JSON.stringify(params.timings) : null]
  );
}

// ── Bot Settings (key-value) ──────────────────────────────────────────────────

export async function setBotSetting(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO bot_settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, value]
  );
}

export async function getBotSetting(key: string): Promise<string | null> {
  const db = await getDb();
  const result = await db.query('SELECT value FROM bot_settings WHERE key = $1', [key]);
  return result.rows.length > 0 ? (result.rows[0].value as string) : null;
}

// ── Trade Attempt Queries ─────────────────────────────────────────────────────

export interface TradeAttemptRow {
  id: string;
  user_id: string;
  side: string;
  venue: string;
  token_in: string;
  token_out: string;
  amount_in: string;
  status: string;
  tx_hash: string | null;
  error: string | null;
  timings: { presign_ms?: number; sign_ms?: number; post_ms?: number } | null;
  slippage_pct: number | null;
  created_at: Date;
}

export async function getRecentTradeAttempts(windowMinutes: number, limit = 200): Promise<TradeAttemptRow[]> {
  const db = await getDb();
  const result = await db.query(
    `SELECT id, user_id, side, venue, token_in, token_out, amount_in, status, tx_hash, error, timings, slippage_pct, created_at
     FROM trade_attempts
     WHERE created_at >= NOW() - ($1 || ' minutes')::INTERVAL
     ORDER BY created_at DESC
     LIMIT $2`,
    [String(windowMinutes), limit]
  );
  return result.rows as TradeAttemptRow[];
}

// ── Referral System Functions ─────────────────────────────────────────────────

export async function generateReferralCode(userId: string, username: string): Promise<string> {
  const db = await getDb();
  // Generate a referral code based on username with random suffix
  const randomSuffix = Math.random().toString(36).substring(2, 7).toUpperCase();
  const code = `${username}-${randomSuffix}`;
  
  await db.query(
    'UPDATE users SET referral_code = $1, username = $2 WHERE id = $3',
    [code, username, userId]
  );
  return code;
}

export async function getUserByReferralCode(referralCode: string): Promise<UserRecord | null> {
  const db = await getDb();
  const trimmed = referralCode.trim();
  if (!trimmed) return null;

  // 1. Exact match on referral_code
  let result = await db.query('SELECT * FROM users WHERE referral_code = $1', [trimmed]);
  if (result.rows.length > 0) return rowToUser(result.rows[0]);

  // 2. Case-insensitive match on referral_code
  result = await db.query('SELECT * FROM users WHERE LOWER(referral_code) = LOWER($1)', [trimmed]);
  if (result.rows.length > 0) return rowToUser(result.rows[0]);

  // 3. Match on Telegram username
  result = await db.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [trimmed]);
  if (result.rows.length > 0) return rowToUser(result.rows[0]);

  // 4. Prefix match (e.g. 'nearscan' matches 'nearscandev' or 'nearscandev-KEL9Q')
  result = await db.query(
    `SELECT * FROM users 
     WHERE LOWER(referral_code) LIKE LOWER($1) || '%' 
        OR LOWER(username) LIKE LOWER($1) || '%' 
     ORDER BY CASE WHEN LOWER(username) = LOWER($1) THEN 0 ELSE 1 END, created_at ASC 
     LIMIT 1`,
    [trimmed]
  );
  if (result.rows.length > 0) return rowToUser(result.rows[0]);

  return null;
}

export async function createReferral(referrerId: string, referredUserId: string): Promise<ReferralRecord> {
  const db = await getDb();
  const id = generateId();
  const result = await db.query(
    `INSERT INTO referrals (id, referrer_id, referred_user_id, status, created_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (referrer_id, referred_user_id) DO UPDATE SET referrer_id = EXCLUDED.referrer_id
     RETURNING *`,
    [id, referrerId, referredUserId, 'pending']
  );
  return rowToReferral(result.rows[0]);
}

export async function activateReferral(referralId: string): Promise<void> {
  const db = await getDb();
  await db.query(
    'UPDATE referrals SET status = $1, completed_at = NOW() WHERE id = $2',
    ['active', referralId]
  );
}

export async function addReferralReward(referralId: string, rewardAmount: number): Promise<void> {
  const db = await getDb();
  await db.query(
    'UPDATE referrals SET total_fees_earned = total_fees_earned + $1 WHERE id = $2',
    [rewardAmount, referralId]
  );
}

export async function getReferralsByReferrer(referrerId: string): Promise<ReferralRecord[]> {
  const db = await getDb();
  const result = await db.query('SELECT * FROM referrals WHERE referrer_id = $1', [referrerId]);
  return result.rows.map(rowToReferral);
}

export async function getReferralByReferredUser(referredUserId: string): Promise<ReferralRecord | null> {
  const db = await getDb();
  const result = await db.query(
    `SELECT r.*, u.referral_fee_pct AS ref_fee_pct, u.is_ambassador AS ref_is_ambassador, u.fee_tier AS ref_fee_tier
     FROM referrals r
     LEFT JOIN users u ON u.id = r.referrer_id
     WHERE r.referred_user_id = $1`,
    [referredUserId]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  const ref = rowToReferral(row);
  const feePct = row.ref_fee_pct != null
    ? parseFloat(row.ref_fee_pct)
    : (row.ref_fee_tier === 'ambassador' || row.ref_is_ambassador ? 45 : 30);
  ref.referrer_fee_pct = feePct;
  ref.referrer_is_ambassador = Boolean(row.ref_is_ambassador || row.ref_fee_tier === 'ambassador');
  return ref;
}

export async function updateUserAmbassadorStatus(
  userId: string,
  isAmbassador: boolean,
  referralFeePct: number = 45
): Promise<void> {
  const db = await getDb();
  await db.query(
    `UPDATE users
     SET is_ambassador = $1,
         referral_fee_pct = $2,
         fee_tier = CASE WHEN $1 = true THEN 'ambassador' ELSE 'standard' END
     WHERE id = $3`,
    [isAmbassador, referralFeePct, userId]
  );
}

export async function getTotalReferralEarnings(referrerId: string): Promise<number> {
  const db = await getDb();
  const result = await db.query(
    `SELECT (
       (SELECT COALESCE(SUM(total_fees_earned), 0) FROM referrals WHERE referrer_id = $1)
       +
       (SELECT COALESCE(SUM(total_fees_earned), 0) FROM token_referrals WHERE referrer_id = $1)
     ) as total`,
    [referrerId]
  );
  return parseFloat(result.rows[0]?.total || '0');
}

// ── Token Share Links & Token-Specific Referrals ───────────────────────────

function generateShortSlug(length = 8): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export async function getOrCreateTokenShare(referrerId: string, tokenAddress: string): Promise<string> {
  const db = await getDb();
  const cleanToken = tokenAddress.trim().toLowerCase();
  const encodedCa = cleanToken.replace(/\./g, '--');

  // Fetch referrer user details to build deterministic, readable ref code
  const userRes = await db.query('SELECT referral_code, username FROM users WHERE id = $1', [referrerId]);
  const user = userRes.rows[0];
  const refCode = user?.referral_code || user?.username || referrerId;
  const targetCode = `ref_${refCode}_-${encodedCa}`;

  // Check if an existing share code already exists for this user and token
  const existing = await db.query(
    'SELECT code FROM token_shares WHERE referrer_id = $1 AND LOWER(token_address) = $2',
    [referrerId, cleanToken]
  );
  if (existing.rows.length > 0) {
    const currentCode = existing.rows[0].code;
    if (currentCode.startsWith('ref_')) {
      return currentCode;
    }
    // Update old t_ code to the new readable format
    try {
      await db.query(
        'UPDATE token_shares SET code = $1 WHERE referrer_id = $2 AND LOWER(token_address) = $3',
        [targetCode, referrerId, cleanToken]
      );
      return targetCode;
    } catch {
      return currentCode;
    }
  }

  // Create new readable token share record
  try {
    const res = await db.query(
      `INSERT INTO token_shares (id, code, token_address, referrer_id, created_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (referrer_id, token_address) DO UPDATE SET code = EXCLUDED.code
       RETURNING code`,
      [generateId(), targetCode, cleanToken, referrerId]
    );
    return res.rows[0].code;
  } catch (err: any) {
    if (err.code === '23505') {
      return targetCode;
    }
    throw err;
  }
}

export async function getTokenShareByCode(code: string): Promise<TokenShareRecord | null> {
  const db = await getDb();
  const res = await db.query('SELECT * FROM token_shares WHERE code = $1', [code.trim()]);
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  return {
    id: row.id,
    code: row.code,
    token_address: row.token_address,
    referrer_id: row.referrer_id,
    created_at: row.created_at,
  };
}

export async function recordTokenReferral(userId: string, tokenAddress: string, referrerId: string): Promise<TokenReferralRecord | null> {
  // Prevent self-referral
  if (userId === referrerId) return null;
  const db = await getDb();
  const res = await db.query(
    `INSERT INTO token_referrals (id, user_id, token_address, referrer_id, created_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (user_id, token_address) DO UPDATE SET referrer_id = EXCLUDED.referrer_id, created_at = NOW()
     RETURNING *`,
    [generateId(), userId, tokenAddress, referrerId]
  );
  const row = res.rows[0];
  return {
    id: row.id,
    user_id: row.user_id,
    token_address: row.token_address,
    referrer_id: row.referrer_id,
    total_fees_earned: parseFloat(row.total_fees_earned || '0'),
    created_at: row.created_at,
    last_trade_at: row.last_trade_at,
  };
}

export async function getTokenReferral(userId: string, tokenAddress: string): Promise<TokenReferralRecord | null> {
  const db = await getDb();
  const res = await db.query(
    'SELECT * FROM token_referrals WHERE user_id = $1 AND token_address = $2',
    [userId, tokenAddress]
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  return {
    id: row.id,
    user_id: row.user_id,
    token_address: row.token_address,
    referrer_id: row.referrer_id,
    total_fees_earned: parseFloat(row.total_fees_earned || '0'),
    created_at: row.created_at,
    last_trade_at: row.last_trade_at,
  };
}

export async function addTokenReferralReward(tokenReferralId: string, rewardAmount: number): Promise<void> {
  const db = await getDb();
  await db.query(
    'UPDATE token_referrals SET total_fees_earned = total_fees_earned + $1, last_trade_at = NOW() WHERE id = $2',
    [rewardAmount, tokenReferralId]
  );
}

// ── Referral Claims (payouts from treasury to referrers) ────────────────────

export interface ReferralClaimRecord {
  id: string;
  referrer_id: string;
  amount_near: number;
  tx_hash: string | null;
  created_at: Date;
}

export async function createReferralClaim(referrerId: string, amountNear: number, txHash: string | null): Promise<void> {
  const db = await getDb();
  await db.query(
    'INSERT INTO referral_claims (referrer_id, amount_near, tx_hash, created_at) VALUES ($1, $2, $3, NOW())',
    [referrerId, amountNear, txHash]
  );
}

export async function getTotalReferralClaimed(referrerId: string): Promise<number> {
  const db = await getDb();
  const result = await db.query(
    'SELECT COALESCE(SUM(amount_near), 0) as total FROM referral_claims WHERE referrer_id = $1',
    [referrerId]
  );
  return parseFloat(result.rows[0].total);
}

function rowToReferral(row: any): ReferralRecord {
  return {
    id: row.id,
    referrer_id: row.referrer_id,
    referred_user_id: row.referred_user_id,
    status: row.status,
    total_fees_earned: parseFloat(row.total_fees_earned),
    created_at: row.created_at,
    completed_at: row.completed_at,
  };
}

function rowToUser(row: any): UserRecord {
  return {
    id: row.id,
    telegram_id: Number(row.telegram_id),
    subaccount_id: row.subaccount_id,
    scoped_key_encrypted: row.scoped_key_encrypted,
    sui_address: row.sui_address ?? null,
    sui_private_key_enc: row.sui_private_key_enc ?? null,
    starknet_address: row.starknet_address ?? null,
    starknet_private_key_enc: row.starknet_private_key_enc ?? null,
    default_buy_pct: row.default_buy_pct != null ? parseFloat(row.default_buy_pct) : null,
    default_sell_pct: row.default_sell_pct != null ? parseFloat(row.default_sell_pct) : null,
    fee_tier: row.fee_tier,
    referral_fee_pct: row.referral_fee_pct != null
      ? parseFloat(row.referral_fee_pct)
      : (row.fee_tier === 'ambassador' || Boolean(row.is_ambassador) ? 45 : 30),
    is_ambassador: Boolean(row.is_ambassador || row.fee_tier === 'ambassador'),
    auto_buy_enabled: Boolean(row.auto_buy_enabled),
    auto_buy_amount_near: row.auto_buy_amount_near != null ? parseFloat(row.auto_buy_amount_near) : 1,
    auto_buy_min_liquidity_near: row.auto_buy_min_liquidity_near != null ? parseFloat(row.auto_buy_min_liquidity_near) : 10,
    auto_buy_max_market_cap_usd: row.auto_buy_max_market_cap_usd != null ? parseFloat(row.auto_buy_max_market_cap_usd) : 100000,
    slippage_pct: row.slippage_pct != null ? parseFloat(row.slippage_pct) : 2,
    referred_by: row.referred_by,
    referral_code: row.referral_code,
    username: row.username,
    show_net_worth_on_card: row.show_net_worth_on_card === true, // defaults false
    last_near_balance: row.last_near_balance != null ? parseFloat(row.last_near_balance) : null,
    last_sui_balance: row.last_sui_balance != null ? parseFloat(row.last_sui_balance) : null,
    last_strk_balance: row.last_strk_balance != null ? parseFloat(row.last_strk_balance) : null,
    last_balance_check_at: row.last_balance_check_at ? new Date(row.last_balance_check_at) : null,
    created_at: row.created_at,
  };
}

export async function updateUserLastBalances(
  userId: string,
  balances: { near?: number | null; sui?: number | null; strk?: number | null }
): Promise<void> {
  const db = await getDb();
  const sets: string[] = ['last_balance_check_at = NOW()'];
  const vals: any[] = [userId];
  if (balances.near !== undefined) {
    vals.push(balances.near);
    sets.push(`last_near_balance = $${vals.length}`);
  }
  if (balances.sui !== undefined) {
    vals.push(balances.sui);
    sets.push(`last_sui_balance = $${vals.length}`);
  }
  if (balances.strk !== undefined) {
    vals.push(balances.strk);
    sets.push(`last_strk_balance = $${vals.length}`);
  }
  await db.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, vals).catch((err: any) => {
    console.warn('[DB] updateUserLastBalances error:', err?.message);
  });
  invalidateUserCache(userId);
}

// ── Volume stats (admin daily update) ───────────────────────────────────────

export interface VolumeStats {
  // NEAR chain
  volume24hNear: number;
  fees24hNear: number;
  trades24h: number;
  buys24h: number;
  sells24h: number;
  activeTraders24h: number;
  volumeTotalNear: number;
  feesTotalNear: number;
  tradesTotal: number;
  // SUI chain
  volume24hSui: number;
  fees24hSui: number;
  trades24hSui: number;
  volumeTotalSui: number;
  feesTotalSui: number;
  tradesTotalSui: number;
  // Starknet chain
  volume24hStarknet: number;
  fees24hStarknet: number;
  trades24hStarknet: number;
  volumeTotalStarknet: number;
  feesTotalStarknet: number;
  tradesTotalStarknet: number;
  // Combined
  usersTotal: number;
  newUsers24h: number;
}

/**
 * Trading volume derived from fee_paid (the platform fee is exactly 1.5% of
 * volume and is always recorded in native units, unlike fill amounts whose
 * raw/human units vary across legacy rows).
 */
export async function getVolumeStats(): Promise<VolumeStats> {
  const db = await getDb();

  // NEAR fills
  const near = await db.query(
    `SELECT
       COALESCE(SUM(fee_paid::numeric) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours'), 0)::float AS fees24,
       COALESCE(SUM(fee_paid::numeric), 0)::float AS fees_total,
       COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS trades24,
       COUNT(*)::int AS trades_total
     FROM fills
     WHERE chain = 'near'
       AND side IN ('buy', 'sell')
       AND COALESCE(fee_paid::numeric, 0) > 0
       AND (tx_hash IS NULL OR tx_hash NOT LIKE 'deposit\_%')`
  );

  // SUI fills (fee_paid stored in human SUI units; safeguard against raw MIST >= 100_000)
  const sui = await db.query(
    `SELECT
       COALESCE(SUM(CASE WHEN fee_paid::numeric >= 100000 THEN fee_paid::numeric / 1e9 ELSE fee_paid::numeric END) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours'), 0)::float AS fees24,
       COALESCE(SUM(CASE WHEN fee_paid::numeric >= 100000 THEN fee_paid::numeric / 1e9 ELSE fee_paid::numeric END), 0)::float AS fees_total,
       COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS trades24,
       COUNT(*)::int AS trades_total
     FROM fills
     WHERE chain = 'sui'
       AND side IN ('buy', 'sell')
       AND COALESCE(fee_paid::numeric, 0) > 0
       AND (tx_hash IS NULL OR tx_hash NOT LIKE 'deposit\_%')`
  );

  // Starknet fills (fee_paid stored in human STRK units)
  const starknet = await db.query(
    `SELECT
       COALESCE(SUM(fee_paid::numeric) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours'), 0)::float AS fees24,
       COALESCE(SUM(fee_paid::numeric), 0)::float AS fees_total,
       COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS trades24,
       COUNT(*)::int AS trades_total
     FROM fills
     WHERE chain = 'starknet'
       AND side IN ('buy', 'sell')
       AND COALESCE(fee_paid::numeric, 0) > 0
       AND (tx_hash IS NULL OR tx_hash NOT LIKE 'deposit\_%')`
  );

  // Overall 24h trade activity across all chains
  const activity = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours' AND side = 'buy')::int AS buys24,
       COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours' AND side = 'sell')::int AS sells24,
       COUNT(DISTINCT user_id) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS traders24
     FROM fills
     WHERE side IN ('buy', 'sell')
       AND COALESCE(fee_paid::numeric, 0) > 0
       AND (tx_hash IS NULL OR tx_hash NOT LIKE 'deposit\_%')`
  );

  const u = await db.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS new24h
    FROM users
  `);

  const nr = near.rows[0];
  const sr = sui.rows[0];
  const strkr = starknet.rows[0];
  const act = activity.rows[0];
  const ur = u.rows[0];

  return {
    // NEAR
    volume24hNear:       nr.fees24 / 0.015,
    fees24hNear:         nr.fees24,
    trades24h:           nr.trades24,
    buys24h:             act.buys24,
    sells24h:            act.sells24,
    activeTraders24h:    act.traders24,
    volumeTotalNear:     nr.fees_total / 0.015,
    feesTotalNear:       nr.fees_total,
    tradesTotal:         nr.trades_total,
    // SUI
    volume24hSui:        sr.fees24 / 0.015,
    fees24hSui:          sr.fees24,
    trades24hSui:        sr.trades24,
    volumeTotalSui:      sr.fees_total / 0.015,
    feesTotalSui:        sr.fees_total,
    tradesTotalSui:      sr.trades_total,
    // Starknet
    volume24hStarknet:   strkr.fees24 / 0.015,
    fees24hStarknet:     strkr.fees24,
    trades24hStarknet:   strkr.trades24,
    volumeTotalStarknet: strkr.fees_total / 0.015,
    feesTotalStarknet:   strkr.fees_total,
    tradesTotalStarknet: strkr.trades_total,
    // Users
    usersTotal:          ur.total,
    newUsers24h:         ur.new24h,
  };
}

function rowToPosition(row: any): PositionRecord {
  return {
    id: row.id,
    user_id: row.user_id,
    chain: row.chain || 'near',
    token_address: row.token_address,
    quantity_held: row.quantity_held,
    avg_entry_price: row.avg_entry_price,
    status: row.status,
    opened_at: row.opened_at,
    closed_at: row.closed_at,
    is_external_deposit: row.is_external_deposit || false,
    external_deposit_detected_at: row.external_deposit_detected_at || null,
  };
}

function rowToFill(row: any): FillRecord {
  return { 
    id: row.id, 
    user_id: row.user_id, 
    position_id: row.position_id, 
    chain: row.chain || 'near',
    side: row.side, 
    token_address: row.token_address, 
    amount: row.amount, 
    price: row.price, 
    fee_paid: row.fee_paid, 
    input_amount: row.input_amount ?? null,
    venue: row.venue, 
    tx_hash: row.tx_hash, 
    created_at: row.created_at 
  };
}

function rowToTrigger(row: any): TriggerRecord {
  return { 
    id: row.id, 
    user_id: row.user_id, 
    position_id: row.position_id, 
    chain: row.chain || 'near',
    type: row.type, 
    target_value: row.target_value,
    sell_pct: row.sell_pct != null ? parseFloat(row.sell_pct) : 100,
    status: row.status, 
    created_at: row.created_at 
  };
}

function rowToTokenCache(row: any): TokenCacheRecord {
  return { 
    token_address: row.token_address, 
    chain: row.chain || 'near',
    name: row.name, 
    symbol: row.symbol, 
    decimals: row.decimals != null ? Number(row.decimals) : null, 
    total_supply: row.total_supply != null ? String(row.total_supply) : null,
    pool_address: row.pool_address, 
    venue: row.venue, 
    rhea_pool_id: row.rhea_pool_id != null ? Number(row.rhea_pool_id) : null,
    bonding_phase: row.bonding_phase ?? null,
    bonding_progress_pct: row.bonding_progress_pct != null ? parseFloat(row.bonding_progress_pct) : null,
    dcl_pool_id: row.dcl_pool_id ?? null,
    last_price: row.last_price != null ? parseFloat(row.last_price) : null, 
    last_liquidity: row.last_liquidity != null ? parseFloat(row.last_liquidity) : null, 
    buy_tax_pct: row.buy_tax_pct != null ? parseFloat(row.buy_tax_pct) : null,
    sell_tax_pct: row.sell_tax_pct != null ? parseFloat(row.sell_tax_pct) : null,
    is_safe: row.is_safe != null ? Boolean(row.is_safe) : null,
    icon: row.icon ?? null,
    updated_at: row.updated_at 
  };
}

function generateId(): string {
  return randomUUID();
}

// ── Targeted snipe orders ────────────────────────────────────────────────────

export interface SnipeOrderRecord {
  id: string;
  user_id: string;
  snipe_type: 'token' | 'deployer';
  token_address: string | null;
  deployer_address: string | null;
  amount_near: string;
  status: 'active' | 'filled' | 'cancelled' | 'failed';
  last_error: string | null;
  trigger_count: number;
  execute_after?: Date | null;
  created_at: Date;
  updated_at: Date;
}

function rowToSnipeOrder(row: any): SnipeOrderRecord {
  return {
    id: row.id,
    user_id: row.user_id,
    snipe_type: row.snipe_type,
    token_address: row.token_address ?? null,
    deployer_address: row.deployer_address ?? null,
    amount_near: String(row.amount_near),
    status: row.status,
    last_error: row.last_error ?? null,
    trigger_count: row.trigger_count != null ? Number(row.trigger_count) : 0,
    execute_after: row.execute_after ? new Date(row.execute_after) : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Guard against runaway order creation. */
export const MAX_ACTIVE_SNIPE_ORDERS_PER_USER = 10;

export async function createSnipeOrder(params: {
  user_id: string;
  snipe_type: 'token' | 'deployer';
  token_address?: string;
  deployer_address?: string;
  amount_near: number;
  execute_after?: Date | null;
}): Promise<SnipeOrderRecord> {
  const db = await getDb();
  const result = await db.query(
    `INSERT INTO snipe_orders (user_id, snipe_type, token_address, deployer_address, amount_near, execute_after)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      params.user_id,
      params.snipe_type,
      params.token_address ? params.token_address.toLowerCase() : null,
      params.deployer_address ? params.deployer_address.toLowerCase() : null,
      params.amount_near,
      params.execute_after ?? null,
    ]
  );
  return rowToSnipeOrder(result.rows[0]);
}

export async function countActiveSnipeOrders(userId: string): Promise<number> {
  const db = await getDb();
  const r = await db.query(
    `SELECT COUNT(*)::int AS n FROM snipe_orders WHERE user_id = $1 AND status = 'active'`,
    [userId]
  );
  return r.rows[0].n;
}

export async function getSnipeOrdersByUser(userId: string): Promise<SnipeOrderRecord[]> {
  const db = await getDb();
  const r = await db.query(
    `SELECT * FROM snipe_orders WHERE user_id = $1
     ORDER BY (status = 'active') DESC, created_at DESC LIMIT 25`,
    [userId]
  );
  return r.rows.map(rowToSnipeOrder);
}

/** Cancel only the caller's own active order. Returns false when nothing changed. */
export async function cancelSnipeOrder(orderId: string, userId: string): Promise<boolean> {
  const db = await getDb();
  const r = await db.query(
    `UPDATE snipe_orders SET status = 'cancelled', updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND status = 'active'`,
    [orderId, userId]
  );
  return (r.rowCount ?? 0) > 0;
}

export async function getSnipeOrderById(orderId: string, userId: string): Promise<SnipeOrderRecord | null> {
  const db = await getDb();
  const r = await db.query(
    `SELECT * FROM snipe_orders WHERE id = $1 AND user_id = $2`,
    [orderId, userId]
  );
  return r.rows.length > 0 ? rowToSnipeOrder(r.rows[0]) : null;
}

export async function deleteSnipeOrder(orderId: string, userId: string): Promise<boolean> {
  const db = await getDb();
  const r = await db.query(
    `DELETE FROM snipe_orders WHERE id = $1 AND user_id = $2`,
    [orderId, userId]
  );
  return (r.rowCount ?? 0) > 0;
}

/** Active one-shot token snipes watching this exact contract address. */
export async function getActiveTokenSnipes(tokenAddress: string): Promise<SnipeOrderRecord[]> {
  const db = await getDb();
  const r = await db.query(
    `SELECT * FROM snipe_orders
     WHERE snipe_type = 'token' AND status = 'active' AND lower(token_address) = lower($1)
       AND (execute_after IS NULL OR execute_after <= NOW())`,
    [tokenAddress]
  );
  return r.rows.map(rowToSnipeOrder);
}

/** Active standing deployer snipes watching this creator wallet. */
export async function getActiveDeployerSnipes(deployerAddress: string): Promise<SnipeOrderRecord[]> {
  const db = await getDb();
  const r = await db.query(
    `SELECT * FROM snipe_orders
     WHERE snipe_type = 'deployer' AND status = 'active' AND lower(deployer_address) = lower($1)
       AND (execute_after IS NULL OR execute_after <= NOW())`,
    [deployerAddress]
  );
  return r.rows.map(rowToSnipeOrder);
}

/** Distinct token addresses with currently active token snipe orders. */
export async function getDistinctActiveSnipeTokens(): Promise<string[]> {
  const db = await getDb();
  const r = await db.query(
    `SELECT DISTINCT lower(so.token_address) AS token_address FROM snipe_orders so
     WHERE so.snipe_type = 'token' AND so.status = 'active' AND so.token_address IS NOT NULL
       AND (so.execute_after IS NULL OR so.execute_after <= NOW())
       AND NOT EXISTS (
         SELECT 1 FROM snipe_triggers st
         WHERE st.order_id = so.id AND (st.status = 'filled' OR (st.status = 'failed' AND st.attempts >= 5))
       )`
  );
  return r.rows.map(row => row.token_address as string);
}

/**
 * Dedup gate: inserts a pending trigger for (order, token) and returns its id.
 * Returns null when a pending/filled trigger already exists — the snipe has
 * fired (or is firing) and must not double-fire. A FAILED trigger row is
 * re-armed (up to 5 attempts) so e.g. a token snipe that fired while the pool
 * was still prebonded retries when the token bonds / gains liquidity.
 */
export async function recordSnipeTrigger(orderId: string, tokenAddress: string, venue: string): Promise<string | null> {
  const db = await getDb();
  const result = await db.query(
    `INSERT INTO snipe_triggers (order_id, token_address, venue)
     SELECT $1, $2, $3
     WHERE NOT EXISTS (
       SELECT 1 FROM snipe_triggers
       WHERE order_id = $1 AND lower(token_address) = lower($2) 
         AND (status = 'filled' OR (status = 'pending' AND updated_at > NOW() - INTERVAL '5 minutes'))
     )
     ON CONFLICT (order_id, token_address) DO UPDATE
       SET status = 'pending', error = NULL, tx_hash = NULL, venue = EXCLUDED.venue,
           attempts = snipe_triggers.attempts + 1, updated_at = NOW()
       WHERE (snipe_triggers.status = 'failed' AND snipe_triggers.attempts < 5)
          OR (snipe_triggers.status = 'pending' AND snipe_triggers.updated_at <= NOW() - INTERVAL '5 minutes' AND snipe_triggers.attempts < 5)
     RETURNING id`,
    [orderId, tokenAddress, venue]
  );
  return result.rows.length > 0 ? result.rows[0].id : null;
}

export async function markSnipeTriggerFilled(triggerId: string, txHash: string | null): Promise<void> {
  const db = await getDb();
  await db.query(
    `UPDATE snipe_triggers SET status = 'filled', tx_hash = $2, updated_at = NOW() WHERE id = $1`,
    [triggerId, txHash]
  );
}

export async function markSnipeTriggerFailed(triggerId: string, error: string): Promise<{ attempts: number }> {
  const db = await getDb();
  const res = await db.query(
    `UPDATE snipe_triggers SET status = 'failed', error = $2, updated_at = NOW() WHERE id = $1 RETURNING attempts`,
    [triggerId, error.slice(0, 500)]
  );
  return { attempts: res.rows[0]?.attempts ?? 1 };
}

/**
 * Post-execution bookkeeping. Token orders are one-shot → 'filled' (or 'failed'
 * after a failed fire). Deployer orders stay active and only count triggers.
 */
export async function markSnipeOrderResult(orderId: string, success: boolean, error?: string): Promise<void> {
  const db = await getDb();
  if (success) {
    await db.query(
      `UPDATE snipe_orders
       SET status = CASE WHEN snipe_type = 'token' THEN 'filled' ELSE status END,
           trigger_count = trigger_count + 1,
           last_error = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [orderId]
    );
  } else {
    await db.query(
      `UPDATE snipe_orders
       SET status = CASE WHEN snipe_type = 'token' THEN 'failed' ELSE status END,
           last_error = $2,
           updated_at = NOW()
       WHERE id = $1`,
      [orderId, (error ?? 'unknown').slice(0, 500)]
    );
  }
}

// ── Copy Trading ─────────────────────────────────────────────────────────────

function rowToCopyTarget(row: any): CopyTradeTargetRecord {
  return {
    id: row.id,
    user_id: row.user_id,
    target_wallet: row.target_wallet,
    referrer_id: row.referrer_id ?? null,
    buy_amount_near: parseFloat(row.buy_amount_near),
    copy_sells: row.copy_sells,
    max_slippage_pct: parseFloat(row.max_slippage_pct),
    max_daily_budget_near: row.max_daily_budget_near != null ? parseFloat(row.max_daily_budget_near) : null,
    track_only: Boolean(row.track_only),
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function createCopyTradeTarget(params: CreateCopyTradeTargetParams): Promise<CopyTradeTargetRecord> {
  const db = await getDb();
  const res = await db.query(
    `INSERT INTO copy_trade_targets
       (id, user_id, target_wallet, referrer_id, buy_amount_near, copy_sells, max_slippage_pct, max_daily_budget_near, track_only)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (user_id, target_wallet)
       DO UPDATE SET
         referrer_id           = COALESCE(EXCLUDED.referrer_id, copy_trade_targets.referrer_id),
         buy_amount_near       = EXCLUDED.buy_amount_near,
         copy_sells            = EXCLUDED.copy_sells,
         max_slippage_pct      = EXCLUDED.max_slippage_pct,
         max_daily_budget_near = EXCLUDED.max_daily_budget_near,
         track_only            = EXCLUDED.track_only,
         status                = 'active',
         updated_at            = NOW()
     RETURNING *`,
    [
      generateId(),
      params.user_id,
      params.target_wallet.trim().toLowerCase(),
      params.referrer_id ?? null,
      params.buy_amount_near ?? 1.0,
      params.copy_sells ?? true,
      params.max_slippage_pct ?? 5.0,
      params.max_daily_budget_near ?? null,
      params.track_only ?? false,
    ]
  );
  return rowToCopyTarget(res.rows[0]);
}

export async function getCopyTradeTargetsByUser(userId: string): Promise<CopyTradeTargetRecord[]> {
  const db = await getDb();
  const res = await db.query(
    `SELECT * FROM copy_trade_targets WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId]
  );
  return res.rows.map(rowToCopyTarget);
}

/** Returns all ACTIVE copy-targets for a specific watched wallet (detector hot-path). */
export async function getCopyTargetFollowersByWallet(
  targetWallet: string
): Promise<CopyTradeTargetRecord[]> {
  const db = await getDb();
  const res = await db.query(
    `SELECT * FROM copy_trade_targets WHERE LOWER(TRIM(target_wallet)) = LOWER(TRIM($1)) AND status = 'active'`,
    [targetWallet]
  );
  return res.rows.map(rowToCopyTarget);
}

/** Returns all distinct wallets that have at least one active follower (for detector subscription). */
export async function getAllActiveCopyTargetWallets(): Promise<string[]> {
  const db = await getDb();
  const res = await db.query(
    `SELECT DISTINCT LOWER(TRIM(target_wallet)) AS target_wallet FROM copy_trade_targets WHERE status = 'active'`
  );
  return res.rows.map((r: any) => r.target_wallet as string);
}

export async function updateCopyTradeTargetStatus(
  id: string,
  status: 'active' | 'paused' | 'stopped'
): Promise<void> {
  const db = await getDb();
  await db.query(
    `UPDATE copy_trade_targets SET status = $1, updated_at = NOW() WHERE id = $2`,
    [status, id]
  );
}

export async function updateCopyTradeTarget(
  id: string,
  params: Partial<Pick<CopyTradeTargetRecord, 'buy_amount_near' | 'copy_sells' | 'max_slippage_pct' | 'max_daily_budget_near' | 'track_only'>>
): Promise<void> {
  const db = await getDb();
  const sets: string[] = ['updated_at = NOW()'];
  const vals: unknown[] = [id];
  if (params.buy_amount_near !== undefined) { vals.push(params.buy_amount_near); sets.push(`buy_amount_near = $${vals.length}`); }
  if (params.copy_sells !== undefined) { vals.push(params.copy_sells); sets.push(`copy_sells = $${vals.length}`); }
  if (params.max_slippage_pct !== undefined) { vals.push(params.max_slippage_pct); sets.push(`max_slippage_pct = $${vals.length}`); }
  if (params.max_daily_budget_near !== undefined) { vals.push(params.max_daily_budget_near); sets.push(`max_daily_budget_near = $${vals.length}`); }
  await db.query(`UPDATE copy_trade_targets SET ${sets.join(', ')} WHERE id = $1`, vals);
}

/** Idempotent fill record for a detected copy trade. Returns null if already exists (duplicate). */
export async function recordCopyTradeFill(params: {
  copy_target_id: string;
  user_id: string;
  source_tx_hash: string;
  token_address: string;
  side: 'buy' | 'sell';
}): Promise<CopyTradeFillRecord | null> {
  const db = await getDb();
  const res = await db.query(
    `INSERT INTO copy_trade_fills (id, copy_target_id, user_id, source_tx_hash, token_address, side)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (copy_target_id, source_tx_hash, side) DO NOTHING
     RETURNING *`,
    [generateId(), params.copy_target_id, params.user_id, params.source_tx_hash, params.token_address, params.side]
  );
  if (!res.rows[0]) return null;
  const r = res.rows[0];
  return {
    id: r.id,
    copy_target_id: r.copy_target_id,
    user_id: r.user_id,
    source_tx_hash: r.source_tx_hash,
    token_address: r.token_address,
    side: r.side,
    amount_token: r.amount_token != null ? parseFloat(r.amount_token) : null,
    amount_near: r.amount_near != null ? parseFloat(r.amount_near) : null,
    our_tx_hash: r.our_tx_hash,
    status: r.status,
    skip_reason: r.skip_reason,
    created_at: r.created_at,
  };
}

export async function updateCopyTradeFillResult(
  id: string,
  status: 'filled' | 'failed' | 'skipped',
  opts: { our_tx_hash?: string; amount_token?: number; amount_near?: number; skip_reason?: string } = {}
): Promise<void> {
  const db = await getDb();
  await db.query(
    `UPDATE copy_trade_fills
     SET status = $2, our_tx_hash = COALESCE($3, our_tx_hash),
         amount_token = COALESCE($4, amount_token),
         amount_near  = COALESCE($5, amount_near),
         skip_reason  = COALESCE($6, skip_reason)
     WHERE id = $1`,
    [id, status, opts.our_tx_hash ?? null, opts.amount_token ?? null, opts.amount_near ?? null, opts.skip_reason ?? null]
  );
}

export async function getRecentCopyFillsByUser(userId: string, limit = 10): Promise<CopyTradeFillRecord[]> {
  const db = await getDb();
  const res = await db.query(
    `SELECT * FROM copy_trade_fills WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  );
  return res.rows.map((r: any): CopyTradeFillRecord => ({
    id: r.id, copy_target_id: r.copy_target_id, user_id: r.user_id,
    source_tx_hash: r.source_tx_hash, token_address: r.token_address, side: r.side,
    amount_token: r.amount_token != null ? parseFloat(r.amount_token) : null,
    amount_near: r.amount_near != null ? parseFloat(r.amount_near) : null,
    our_tx_hash: r.our_tx_hash, status: r.status, skip_reason: r.skip_reason,
    created_at: r.created_at,
  }));
}

/** Sum of NEAR spent via copy-trade on a given UTC calendar date (budget cap check). */
export async function getCopyTradeDailySpend(copyTargetId: string, utcDateStr: string): Promise<number> {
  const db = await getDb();
  const res = await db.query(
    `SELECT COALESCE(SUM(amount_near), 0) AS total
     FROM copy_trade_fills
     WHERE copy_target_id = $1 AND side = 'buy' AND status = 'filled'
       AND (created_at AT TIME ZONE 'UTC')::date::text = $2`,
    [copyTargetId, utcDateStr]
  );
  return parseFloat(res.rows[0]?.total ?? '0');
}

// ── DCA Orders ────────────────────────────────────────────────────────────────

function rowToDca(row: any): DcaOrderRecord {
  return {
    id: row.id,
    user_id: row.user_id,
    token_address: row.token_address,
    side: row.side,
    amount_per_order: parseFloat(row.amount_per_order),
    interval_seconds: parseInt(row.interval_seconds, 10),
    total_orders: parseInt(row.total_orders, 10),
    executed_orders: parseInt(row.executed_orders, 10),
    next_run_at: row.next_run_at,
    min_price: row.min_price != null ? parseFloat(row.min_price) : null,
    max_price: row.max_price != null ? parseFloat(row.max_price) : null,
    status: row.status,
    last_error: row.last_error ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function createDcaOrder(params: CreateDcaOrderParams): Promise<DcaOrderRecord> {
  const db = await getDb();
  const firstRunAt = new Date(Date.now() + params.interval_seconds * 1000);
  const res = await db.query(
    `INSERT INTO dca_orders
       (id, user_id, token_address, side, amount_per_order, interval_seconds,
        total_orders, next_run_at, min_price, max_price)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      generateId(), params.user_id, params.token_address, params.side,
      params.amount_per_order, params.interval_seconds,
      params.total_orders ?? 0, firstRunAt,
      params.min_price ?? null, params.max_price ?? null,
    ]
  );
  return rowToDca(res.rows[0]);
}

export async function getDcaOrdersByUser(userId: string): Promise<DcaOrderRecord[]> {
  const db = await getDb();
  const res = await db.query(
    `SELECT * FROM dca_orders WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId]
  );
  return res.rows.map(rowToDca);
}

/** Hot-path: all ACTIVE DCA orders whose next_run_at is now or in the past. */
export async function getDueDcaOrders(): Promise<DcaOrderRecord[]> {
  const db = await getDb();
  const res = await db.query(
    `SELECT * FROM dca_orders WHERE status = 'active' AND next_run_at <= NOW()`
  );
  return res.rows.map(rowToDca);
}

/**
 * Mark one DCA tick as executed.
 * - Increments executed_orders.
 * - Advances next_run_at by interval_seconds.
 * - Marks completed when total_orders reached (0 = unlimited).
 * - Clears last_error on success.
 */
export async function advanceDcaOrder(id: string): Promise<DcaOrderRecord> {
  const db = await getDb();
  const res = await db.query(
    `UPDATE dca_orders
     SET executed_orders = executed_orders + 1,
         next_run_at = NOW() + (interval_seconds || ' seconds')::INTERVAL,
         status = CASE
           WHEN total_orders > 0 AND executed_orders + 1 >= total_orders THEN 'completed'
           ELSE status
         END,
         last_error = NULL,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id]
  );
  return rowToDca(res.rows[0]);
}

export async function failDcaOrderTick(id: string, errorMsg: string): Promise<void> {
  const db = await getDb();
  // Non-fatal: keep the order active, just advance next_run_at and log error
  await db.query(
    `UPDATE dca_orders
     SET last_error = $2,
         next_run_at = NOW() + (interval_seconds || ' seconds')::INTERVAL,
         updated_at = NOW()
     WHERE id = $1`,
    [id, errorMsg.slice(0, 500)]
  );
}

export async function updateDcaOrderStatus(
  id: string,
  status: 'active' | 'paused' | 'completed' | 'cancelled'
): Promise<void> {
  const db = await getDb();
  await db.query(
    `UPDATE dca_orders SET status = $1, updated_at = NOW() WHERE id = $2`,
    [status, id]
  );
}

export async function getDcaOrderById(id: string): Promise<DcaOrderRecord | null> {
  const db = await getDb();
  const res = await db.query(`SELECT * FROM dca_orders WHERE id = $1`, [id]);
  if (!res.rows[0]) return null;
  return rowToDca(res.rows[0]);
}

// ── Trading Competitions ───────────────────────────────────────────────────

function rowToCompetition(row: any): TradingCompetitionRecord {
  return {
    id: row.id,
    token_address: row.token_address,
    token_symbol: row.token_symbol,
    token_name: row.token_name,
    target_market_cap_usd: parseFloat(row.target_market_cap_usd || '30000'),
    status: row.status as any,
    started_at: row.started_at ? new Date(row.started_at) : null,
    ended_at: row.ended_at ? new Date(row.ended_at) : null,
    created_at: new Date(row.created_at),
  };
}

export async function getCompetition(id: string): Promise<TradingCompetitionRecord | null> {
  const db = await getDb();
  try {
    const res = await db.query('SELECT * FROM trading_competitions WHERE id = $1', [id]);
    if (!res.rows[0]) return null;
    return rowToCompetition(res.rows[0]);
  } catch {
    return null;
  }
}

export async function getCompetitionByToken(tokenAddress: string): Promise<TradingCompetitionRecord | null> {
  const db = await getDb();
  try {
    const res = await db.query('SELECT * FROM trading_competitions WHERE token_address = $1', [tokenAddress]);
    if (!res.rows[0]) return null;
    return rowToCompetition(res.rows[0]);
  } catch {
    return null;
  }
}

export async function upsertCompetition(params: {
  id: string;
  token_address: string;
  token_symbol: string;
  token_name: string;
  target_market_cap_usd?: number;
  status?: string;
  started_at?: Date | null;
  ended_at?: Date | null;
}): Promise<TradingCompetitionRecord> {
  const db = await getDb();
  const res = await db.query(
    `INSERT INTO trading_competitions (id, token_address, token_symbol, token_name, target_market_cap_usd, status, started_at, ended_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     ON CONFLICT (id) DO UPDATE SET
       token_address = EXCLUDED.token_address,
       token_symbol = EXCLUDED.token_symbol,
       token_name = EXCLUDED.token_name,
       target_market_cap_usd = COALESCE(EXCLUDED.target_market_cap_usd, trading_competitions.target_market_cap_usd),
       status = COALESCE(EXCLUDED.status, trading_competitions.status),
       started_at = COALESCE(EXCLUDED.started_at, trading_competitions.started_at),
       ended_at = COALESCE(EXCLUDED.ended_at, trading_competitions.ended_at)
     RETURNING *`,
    [
      params.id,
      params.token_address,
      params.token_symbol,
      params.token_name,
      params.target_market_cap_usd ?? 30000,
      params.status ?? 'pending',
      params.started_at ?? null,
      params.ended_at ?? null,
    ]
  );
  return rowToCompetition(res.rows[0]);
}

export async function getCompetitionLeaderboard(
  tokenAddress: string,
  startedAt: Date | null,
  nearUsdRate: number = 4.8,
  decimals: number = 18,
  limit: number = 10
): Promise<CompetitionLeaderboardEntry[]> {
  const db = await getDb();

  const query = `
    SELECT 
      u.id as user_id,
      u.username,
      u.subaccount_id,
      f.side,
      f.amount,
      f.price,
      f.fee_paid,
      f.created_at
    FROM fills f
    JOIN users u ON f.user_id = u.id
    WHERE f.token_address = $1
      AND ($2::timestamptz IS NULL OR f.created_at >= $2)
    ORDER BY f.created_at ASC
  `;

  try {
    const res = await db.query(query, [tokenAddress, startedAt]);

    const userMap = new Map<string, {
      user_id: string;
      username: string | null;
      subaccount_id: string;
      total_volume_near: number;
      total_trades: number;
      buy_trades: number;
      sell_trades: number;
      last_trade_at: Date | null;
    }>();

    for (const row of res.rows) {
      const uid = row.user_id;
      if (!userMap.has(uid)) {
        userMap.set(uid, {
          user_id: uid,
          username: row.username,
          subaccount_id: row.subaccount_id,
          total_volume_near: 0,
          total_trades: 0,
          buy_trades: 0,
          sell_trades: 0,
          last_trade_at: null,
        });
      }

      const u = userMap.get(uid)!;
      u.total_trades += 1;
      if (row.side === 'buy') u.buy_trades += 1;
      if (row.side === 'sell') u.sell_trades += 1;

      const rawAmt = parseFloat(row.amount || '0');
      const amtHuman = rawAmt > 1e12 && decimals > 0 ? rawAmt / Math.pow(10, decimals) : rawAmt;
      const priceNear = parseFloat(row.price || '0');
      const volNear = amtHuman * priceNear;
      u.total_volume_near += volNear;

      const fillTime = row.created_at ? new Date(row.created_at) : null;
      if (fillTime && (!u.last_trade_at || fillTime > u.last_trade_at)) {
        u.last_trade_at = fillTime;
      }
    }

    const sorted = Array.from(userMap.values())
      .sort((a, b) => b.total_volume_near - a.total_volume_near)
      .slice(0, limit);

    return sorted.map((item, idx) => ({
      rank: idx + 1,
      user_id: item.user_id,
      username: item.username,
      subaccount_id: item.subaccount_id,
      total_volume_near: item.total_volume_near,
      total_volume_usd: item.total_volume_near * nearUsdRate,
      total_trades: item.total_trades,
      buy_trades: item.buy_trades,
      sell_trades: item.sell_trades,
      last_trade_at: item.last_trade_at,
    }));
  } catch (err: any) {
    console.error('[COMPETITION] Leaderboard query error:', err.message);
    return [];
  }
}

// ── Telegram Group Buy Alerts ────────────────────────────────────────────────

export interface GroupBuyAlertRecord {
  id: string;
  chat_id: string;
  chat_title?: string;
  admin_id: string;
  token_address: string;
  chain: 'near' | 'sui';
  min_buy_usd: number;
  emoji: string;
  emoji_step_usd: number;
  media_file_id?: string;
  media_type: 'animation' | 'photo' | 'default' | 'none';
  whale_threshold_usd: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

function rowToGroupBuyAlert(row: any): GroupBuyAlertRecord {
  return {
    id: row.id,
    chat_id: row.chat_id.toString(),
    chat_title: row.chat_title || undefined,
    admin_id: row.admin_id.toString(),
    token_address: row.token_address,
    chain: (row.chain as any) || 'near',
    min_buy_usd: parseFloat(row.min_buy_usd || '5.00'),
    emoji: row.emoji || '🏎️',
    emoji_step_usd: parseFloat(row.emoji_step_usd || '5.00'),
    media_file_id: row.media_file_id || undefined,
    media_type: (row.media_type as any) || 'default',
    whale_threshold_usd: parseFloat(row.whale_threshold_usd || '200.00'),
    is_active: Boolean(row.is_active),
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
  };
}

export async function upsertGroupBuyAlert(params: {
  chatId: number | string;
  chatTitle?: string;
  adminId: number | string;
  tokenAddress: string;
  chain?: 'near' | 'sui';
  minBuyUsd?: number;
  emoji?: string;
  emojiStepUsd?: number;
  mediaFileId?: string;
  mediaType?: 'animation' | 'photo' | 'default' | 'none';
  whaleThresholdUsd?: number;
}): Promise<GroupBuyAlertRecord> {
  const db = await getDb();
  const res = await db.query(
    `INSERT INTO group_buy_alerts (
       chat_id, chat_title, admin_id, token_address, chain,
       min_buy_usd, emoji, emoji_step_usd, media_file_id, media_type,
       whale_threshold_usd, is_active, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, TRUE, NOW())
     ON CONFLICT (chat_id, token_address) DO UPDATE SET
       chat_title = COALESCE(EXCLUDED.chat_title, group_buy_alerts.chat_title),
       admin_id = EXCLUDED.admin_id,
       chain = EXCLUDED.chain,
       min_buy_usd = COALESCE(EXCLUDED.min_buy_usd, group_buy_alerts.min_buy_usd),
       emoji = COALESCE(EXCLUDED.emoji, group_buy_alerts.emoji),
       emoji_step_usd = COALESCE(EXCLUDED.emoji_step_usd, group_buy_alerts.emoji_step_usd),
       media_file_id = COALESCE(EXCLUDED.media_file_id, group_buy_alerts.media_file_id),
       media_type = COALESCE(EXCLUDED.media_type, group_buy_alerts.media_type),
       whale_threshold_usd = COALESCE(EXCLUDED.whale_threshold_usd, group_buy_alerts.whale_threshold_usd),
       is_active = TRUE,
       updated_at = NOW()
     RETURNING *`,
    [
      params.chatId.toString(),
      params.chatTitle || null,
      params.adminId.toString(),
      params.tokenAddress,
      params.chain || 'near',
      params.minBuyUsd ?? 5.0,
      params.emoji || '🏎️',
      params.emojiStepUsd ?? 5.0,
      params.mediaFileId || null,
      params.mediaType || 'default',
      params.whaleThresholdUsd ?? 200.0,
    ]
  );
  return rowToGroupBuyAlert(res.rows[0]);
}

export async function getGroupBuyAlert(chatId: number | string, tokenAddress: string): Promise<GroupBuyAlertRecord | null> {
  const db = await getDb();
  const res = await db.query(
    'SELECT * FROM group_buy_alerts WHERE chat_id = $1 AND token_address = $2 LIMIT 1',
    [chatId.toString(), tokenAddress]
  );
  return res.rows.length > 0 ? rowToGroupBuyAlert(res.rows[0]) : null;
}

export async function getGroupBuyAlertsByChat(chatId: number | string): Promise<GroupBuyAlertRecord[]> {
  const db = await getDb();
  const res = await db.query(
    'SELECT * FROM group_buy_alerts WHERE chat_id = $1 ORDER BY created_at DESC',
    [chatId.toString()]
  );
  return res.rows.map(rowToGroupBuyAlert);
}

export async function getGroupBuyAlertsByToken(tokenAddress: string): Promise<GroupBuyAlertRecord[]> {
  const db = await getDb();
  const res = await db.query(
    'SELECT * FROM group_buy_alerts WHERE lower(token_address) = lower($1) AND is_active = TRUE',
    [tokenAddress]
  );
  return res.rows.map(rowToGroupBuyAlert);
}

/** Distinct token addresses with currently active group buy alerts. */
export async function getDistinctActiveBuyAlertTokens(): Promise<string[]> {
  const db = await getDb();
  const res = await db.query(
    'SELECT DISTINCT lower(token_address) AS token_address FROM group_buy_alerts WHERE is_active = TRUE'
  );
  return res.rows.map(row => row.token_address as string);
}

export async function updateGroupBuyAlert(id: string, updates: Partial<GroupBuyAlertRecord>): Promise<GroupBuyAlertRecord> {
  const db = await getDb();
  const sets: string[] = [];
  const values: any[] = [];
  let idx = 1;

  if (updates.min_buy_usd !== undefined) {
    sets.push(`min_buy_usd = $${idx++}`);
    values.push(updates.min_buy_usd);
  }
  if (updates.emoji !== undefined) {
    sets.push(`emoji = $${idx++}`);
    values.push(updates.emoji);
  }
  if (updates.emoji_step_usd !== undefined) {
    sets.push(`emoji_step_usd = $${idx++}`);
    values.push(updates.emoji_step_usd);
  }
  if (updates.media_file_id !== undefined) {
    sets.push(`media_file_id = $${idx++}`);
    values.push(updates.media_file_id);
  }
  if (updates.media_type !== undefined) {
    sets.push(`media_type = $${idx++}`);
    values.push(updates.media_type);
  }
  if (updates.whale_threshold_usd !== undefined) {
    sets.push(`whale_threshold_usd = $${idx++}`);
    values.push(updates.whale_threshold_usd);
  }
  if (updates.is_active !== undefined) {
    sets.push(`is_active = $${idx++}`);
    values.push(updates.is_active);
  }

  sets.push(`updated_at = NOW()`);
  values.push(id);

  const res = await db.query(
    `UPDATE group_buy_alerts SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  if (res.rows.length === 0) {
    throw new Error('Group buy alert not found');
  }
  return rowToGroupBuyAlert(res.rows[0]);
}

export async function deleteGroupBuyAlert(chatId: number | string, tokenAddress: string): Promise<boolean> {
  const db = await getDb();
  const res = await db.query(
    'DELETE FROM group_buy_alerts WHERE chat_id = $1 AND token_address = $2',
    [chatId.toString(), tokenAddress]
  );
  return (res.rowCount ?? 0) > 0;
}

// ── Limit Orders (DEX Conditional Orders) ───────────────────────────────────

function rowToLimitOrder(row: any): LimitOrderRecord {
  return {
    id: row.id,
    user_id: row.user_id,
    chain: row.chain || 'near',
    token_address: row.token_address,
    side: row.side,
    target_type: row.target_type,
    trigger_condition: row.trigger_condition,
    target_value: parseFloat(row.target_value),
    reference_price: row.reference_price ? parseFloat(row.reference_price) : null,
    reference_mcap: row.reference_mcap ? parseFloat(row.reference_mcap) : null,
    amount_input: parseFloat(row.amount_input),
    sell_pct: row.sell_pct ? parseFloat(row.sell_pct) : null,
    max_slippage_pct: parseFloat(row.max_slippage_pct ?? '3.0'),
    expires_at: row.expires_at ? new Date(row.expires_at) : null,
    status: row.status,
    fill_tx_hash: row.fill_tx_hash || null,
    fill_price: row.fill_price ? parseFloat(row.fill_price) : null,
    failure_reason: row.failure_reason || null,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
  };
}

export async function createLimitOrder(params: CreateLimitOrderParams): Promise<LimitOrderRecord> {
  const db = await getDb();
  const res = await db.query(
    `INSERT INTO limit_orders
       (id, user_id, chain, token_address, side, target_type, trigger_condition,
        target_value, reference_price, reference_mcap, amount_input, sell_pct,
        max_slippage_pct, expires_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'active')
     RETURNING *`,
    [
      generateId(),
      params.user_id,
      params.chain || 'near',
      params.token_address,
      params.side,
      params.target_type,
      params.trigger_condition,
      params.target_value,
      params.reference_price ?? null,
      params.reference_mcap ?? null,
      params.amount_input,
      params.sell_pct ?? null,
      params.max_slippage_pct ?? 3.0,
      params.expires_at ?? null,
    ]
  );
  return rowToLimitOrder(res.rows[0]);
}

export async function getLimitOrderById(id: string): Promise<LimitOrderRecord | null> {
  const db = await getDb();
  const res = await db.query('SELECT * FROM limit_orders WHERE id = $1', [id]);
  if (!res.rows[0]) return null;
  return rowToLimitOrder(res.rows[0]);
}

export async function getActiveLimitOrders(): Promise<LimitOrderRecord[]> {
  const db = await getDb();
  const res = await db.query(
    `SELECT * FROM limit_orders 
     WHERE status = 'active' AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY created_at ASC`
  );
  return res.rows.map(rowToLimitOrder);
}

export async function getActiveLimitOrdersByToken(tokenAddress: string, userId?: string): Promise<LimitOrderRecord[]> {
  const db = await getDb();
  if (userId) {
    const res = await db.query(
      `SELECT * FROM limit_orders 
       WHERE lower(token_address) = lower($1) AND user_id = $2 AND status = 'active'
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY created_at DESC`,
      [tokenAddress, userId]
    );
    return res.rows.map(rowToLimitOrder);
  }
  const res = await db.query(
    `SELECT * FROM limit_orders 
     WHERE lower(token_address) = lower($1) AND status = 'active'
       AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY created_at ASC`,
    [tokenAddress]
  );
  return res.rows.map(rowToLimitOrder);
}

export async function getLimitOrdersByUser(userId: string, limit: number = 20): Promise<LimitOrderRecord[]> {
  const db = await getDb();
  const res = await db.query(
    `SELECT * FROM limit_orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  );
  return res.rows.map(rowToLimitOrder);
}

export async function cancelLimitOrder(id: string, userId: string): Promise<boolean> {
  const db = await getDb();
  const res = await db.query(
    `UPDATE limit_orders SET status = 'cancelled', updated_at = NOW() WHERE id = $1 AND user_id = $2 AND status = 'active'`,
    [id, userId]
  );
  return (res.rowCount ?? 0) > 0;
}

export async function lockLimitOrderForExecution(id: string): Promise<LimitOrderRecord | null> {
  const db = await getDb();
  const res = await db.query(
    `UPDATE limit_orders SET status = 'executing', updated_at = NOW() WHERE id = $1 AND status = 'active' RETURNING *`,
    [id]
  );
  if (!res.rows[0]) return null;
  return rowToLimitOrder(res.rows[0]);
}

export async function markLimitOrderFilled(id: string, fillTxHash: string, fillPrice?: number): Promise<void> {
  const db = await getDb();
  await db.query(
    `UPDATE limit_orders 
     SET status = 'filled', fill_tx_hash = $2, fill_price = $3, updated_at = NOW() 
     WHERE id = $1`,
    [id, fillTxHash, fillPrice ?? null]
  );
}

export async function markLimitOrderFailed(id: string, reason: string): Promise<void> {
  const db = await getDb();
  await db.query(
    `UPDATE limit_orders 
     SET status = 'failed', failure_reason = $2, updated_at = NOW() 
     WHERE id = $1`,
    [id, reason.slice(0, 500)]
  );
}

export async function expirePastDueLimitOrders(): Promise<number> {
  const db = await getDb();
  const res = await db.query(
    `UPDATE limit_orders 
     SET status = 'expired', updated_at = NOW() 
     WHERE status = 'active' AND expires_at <= NOW()`
  );
  return res.rowCount ?? 0;
}

// ── RaceDrops Functions ───────────────────────────────────────────────────────

function rowToRaceDrop(row: any): RaceDropRecord {
  return {
    id: row.id,
    creator_id: row.creator_id,
    creator_telegram_id: parseInt(row.creator_telegram_id, 10),
    creator_name: row.creator_name || undefined,
    chain: row.chain || 'near',
    token_address: row.token_address,
    token_symbol: row.token_symbol,
    decimals: row.decimals != null ? parseInt(row.decimals, 10) : 18,
    amount_per_user: row.amount_per_user ? row.amount_per_user.toString() : undefined,
    total_amount: row.total_amount.toString(),
    remaining_amount: row.remaining_amount.toString(),
    total_claims: parseInt(row.total_claims, 10),
    claims_count: parseInt(row.claims_count, 10),
    split_mode: row.split_mode || 'equal',
    message_text: row.message_text || undefined,
    group_chat_id: row.group_chat_id ? parseInt(row.group_chat_id, 10) : undefined,
    group_message_id: row.group_message_id ? parseInt(row.group_message_id, 10) : undefined,
    status: row.status,
    expires_at: new Date(row.expires_at),
    created_at: new Date(row.created_at),
  };
}

function rowToRaceDropClaim(row: any): RaceDropClaimRecord {
  return {
    id: row.id,
    drop_id: row.drop_id,
    user_id: row.user_id,
    telegram_id: parseInt(row.telegram_id, 10),
    claimant_name: row.claimant_name || undefined,
    claim_amount: row.claim_amount.toString(),
    is_new_user: Boolean(row.is_new_user),
    tx_hash: row.tx_hash || undefined,
    created_at: new Date(row.created_at),
  };
}

export async function createRaceDrop(params: CreateRaceDropParams): Promise<RaceDropRecord> {
  const db = await getDb();
  const hours = params.expires_in_hours ?? 48;
  const expiresAt = new Date(Date.now() + hours * 3600 * 1000);
  const totalAmountStr = params.total_amount.toString();

  const res = await db.query(
    `INSERT INTO race_drops (
      creator_id, creator_telegram_id, creator_name, chain, token_address, token_symbol, decimals,
      amount_per_user, total_amount, remaining_amount, total_claims, claims_count, split_mode,
      message_text, group_chat_id, group_message_id, status, expires_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0, $12, $13, $14, $15, 'active', $16)
    RETURNING *`,
    [
      params.creator_id,
      params.creator_telegram_id,
      params.creator_name || null,
      params.chain || 'near',
      params.token_address,
      params.token_symbol,
      params.decimals ?? 18,
      params.amount_per_user != null ? params.amount_per_user.toString() : null,
      totalAmountStr,
      totalAmountStr,
      params.total_claims,
      params.split_mode || 'equal',
      params.message_text || null,
      params.group_chat_id || null,
      params.group_message_id || null,
      expiresAt,
    ]
  );
  return rowToRaceDrop(res.rows[0]);
}

export async function getRaceDropById(id: string): Promise<RaceDropRecord | null> {
  const db = await getDb();
  const res = await db.query('SELECT * FROM race_drops WHERE id = $1', [id]);
  if (!res.rows[0]) return null;
  return rowToRaceDrop(res.rows[0]);
}

export async function getRaceDropsByUser(userId: string, limit: number = 20): Promise<RaceDropRecord[]> {
  const db = await getDb();
  const res = await db.query(
    'SELECT * FROM race_drops WHERE creator_id = $1 ORDER BY created_at DESC LIMIT $2',
    [userId, limit]
  );
  return res.rows.map(rowToRaceDrop);
}

export async function updateRaceDropGroupMessage(
  id: string,
  groupChatId: number,
  groupMessageId: number
): Promise<void> {
  const db = await getDb();
  await db.query(
    'UPDATE race_drops SET group_chat_id = $2, group_message_id = $3 WHERE id = $1',
    [id, groupChatId, groupMessageId]
  );
  await recordRaceDropGroupMessage(id, groupChatId, groupMessageId);
}

export async function recordRaceDropGroupMessage(
  dropId: string,
  chatId: number,
  messageId: number
): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO race_drop_group_messages (drop_id, chat_id, message_id, created_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (drop_id, chat_id) DO UPDATE SET message_id = $3`,
    [dropId, chatId, messageId]
  );
}

export async function getRaceDropGroupMessages(
  dropId: string
): Promise<Array<{ chat_id: number; message_id: number }>> {
  const db = await getDb();
  const res = await db.query(
    `SELECT chat_id, message_id FROM race_drop_group_messages WHERE drop_id = $1`,
    [dropId]
  );
  return res.rows.map((r) => ({
    chat_id: parseInt(r.chat_id, 10),
    message_id: parseInt(r.message_id, 10),
  }));
}

export async function hasUserClaimedDrop(dropId: string, userId: string): Promise<boolean> {
  const db = await getDb();
  const res = await db.query(
    'SELECT 1 FROM race_drop_claims WHERE drop_id = $1 AND user_id = $2 LIMIT 1',
    [dropId, userId]
  );
  return res.rows.length > 0;
}

export async function recordRaceDropClaim(params: {
  dropId: string;
  userId: string;
  telegramId: number;
  claimantName?: string;
  claimAmount: string;
  isNewUser: boolean;
  txHash?: string;
}): Promise<{ claim: RaceDropClaimRecord; drop: RaceDropRecord }> {
  const db = await getDb();
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const dropRes = await client.query('SELECT * FROM race_drops WHERE id = $1 FOR UPDATE', [params.dropId]);
    if (!dropRes.rows[0]) {
      throw new Error('RaceDrop not found.');
    }
    const currentDrop = rowToRaceDrop(dropRes.rows[0]);
    if (currentDrop.status !== 'active') {
      throw new Error(`RaceDrop is no longer active (status: ${currentDrop.status}).`);
    }
    if (new Date() > currentDrop.expires_at) {
      await client.query("UPDATE race_drops SET status = 'expired' WHERE id = $1", [params.dropId]);
      throw new Error('RaceDrop has expired.');
    }
    if (currentDrop.claims_count >= currentDrop.total_claims) {
      throw new Error('All drops have already been claimed.');
    }

    const existingClaim = await client.query(
      'SELECT id FROM race_drop_claims WHERE drop_id = $1 AND user_id = $2 LIMIT 1',
      [params.dropId, params.userId]
    );
    if (existingClaim.rows.length > 0) {
      throw new Error('You have already claimed this RaceDrop!');
    }

    const claimRes = await client.query(
      `INSERT INTO race_drop_claims (drop_id, user_id, telegram_id, claimant_name, claim_amount, is_new_user, tx_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        params.dropId,
        params.userId,
        params.telegramId,
        params.claimantName || null,
        params.claimAmount,
        params.isNewUser,
        params.txHash || null,
      ]
    );

    const newClaimsCount = currentDrop.claims_count + 1;
    const remainingNum = Math.max(0, parseFloat(currentDrop.remaining_amount) - parseFloat(params.claimAmount));
    const newStatus = (newClaimsCount >= currentDrop.total_claims || remainingNum <= 0) ? 'completed' : 'active';

    const updatedDropRes = await client.query(
      `UPDATE race_drops
       SET claims_count = $2, remaining_amount = $3, status = $4
       WHERE id = $1
       RETURNING *`,
      [params.dropId, newClaimsCount, remainingNum.toString(), newStatus]
    );

    await client.query('COMMIT');

    return {
      claim: rowToRaceDropClaim(claimRes.rows[0]),
      drop: rowToRaceDrop(updatedDropRes.rows[0]),
    };
  } catch (err: any) {
    await client.query('ROLLBACK');
    if (err?.code === '23505' || String(err?.message).includes('uq_drop_claim_user')) {
      throw new Error('You have already claimed this RaceDrop!');
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function getRaceDropClaimsByDrop(dropId: string): Promise<RaceDropClaimRecord[]> {
  const db = await getDb();
  const res = await db.query(
    'SELECT * FROM race_drop_claims WHERE drop_id = $1 ORDER BY created_at ASC',
    [dropId]
  );
  return res.rows.map(rowToRaceDropClaim);
}

export async function cancelRaceDrop(id: string, userId: string): Promise<RaceDropRecord | null> {
  const db = await getDb();
  const res = await db.query(
    "UPDATE race_drops SET status = 'cancelled' WHERE id = $1 AND creator_id = $2 AND status = 'active' RETURNING *",
    [id, userId]
  );
  if (!res.rows[0]) return null;
  return rowToRaceDrop(res.rows[0]);
}

// ── RaceFleet (Multi-Wallet Engine) ─────────────────────────────────────────

export interface RaceFleetRecord {
  id: string;
  user_id: string;
  name: string;
  fleet_tag: string;
  status: 'active' | 'expired' | 'paused';
  wallet_count: number;
  monthly_fee_near: string;
  starts_at: Date;
  expires_at: Date;
  auto_renew: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface RaceFleetWalletRecord {
  id: string;
  fleet_id: string;
  user_id: string;
  account_id: string;
  wallet_index: number;
  encrypted_private_key: string;
  is_active: boolean;
  created_at: Date;
}

export interface RaceFleetOrderRecord {
  id: string;
  fleet_id: string;
  user_id: string;
  token_address: string;
  order_type: 'limit_buy' | 'limit_sell' | 'tp_sl' | 'volume_maker' | 'pre_snipe';
  status: 'active' | 'executing' | 'filled' | 'cancelled' | 'failed' | 'paused';
  amount_per_wallet: number;
  sell_pct?: number;
  target_type?: 'mcap' | 'price' | 'percent_offset';
  trigger_condition?: 'lte' | 'gte';
  target_value?: number;
  sl_percent?: number;
  tp_percent?: number;
  max_slippage_pct: number;
  volume_interval_sec?: number;
  last_executed_at?: Date;
  expires_at?: Date;
  fill_summary?: any;
  failure_reason?: string;
  created_at: Date;
  updated_at: Date;
}

export interface CreateRaceFleetParams {
  user_id: string;
  name?: string;
  fleet_tag: string;
  wallet_count: number;
  monthly_fee_near?: number;
  duration_days?: number;
  auto_renew?: boolean;
}

export interface CreateRaceFleetWalletParams {
  fleet_id: string;
  user_id: string;
  account_id: string;
  wallet_index: number;
  encrypted_private_key: string;
}

export interface CreateRaceFleetOrderParams {
  fleet_id: string;
  user_id: string;
  token_address: string;
  order_type: 'limit_buy' | 'limit_sell' | 'tp_sl' | 'volume_maker' | 'pre_snipe';
  amount_per_wallet?: number;
  sell_pct?: number;
  target_type?: 'mcap' | 'price' | 'percent_offset';
  trigger_condition?: 'lte' | 'gte';
  target_value?: number;
  sl_percent?: number;
  tp_percent?: number;
  max_slippage_pct?: number;
  volume_interval_sec?: number;
  expires_at?: Date | null;
}

function rowToRaceFleet(row: any): RaceFleetRecord {
  return {
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    fleet_tag: row.fleet_tag,
    status: row.status,
    wallet_count: Number(row.wallet_count),
    monthly_fee_near: row.monthly_fee_near,
    starts_at: new Date(row.starts_at),
    expires_at: new Date(row.expires_at),
    auto_renew: Boolean(row.auto_renew),
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
  };
}

function rowToRaceFleetWallet(row: any): RaceFleetWalletRecord {
  return {
    id: row.id,
    fleet_id: row.fleet_id,
    user_id: row.user_id,
    account_id: row.account_id,
    wallet_index: Number(row.wallet_index),
    encrypted_private_key: row.encrypted_private_key,
    is_active: Boolean(row.is_active),
    created_at: new Date(row.created_at),
  };
}

function rowToRaceFleetOrder(row: any): RaceFleetOrderRecord {
  return {
    id: row.id,
    fleet_id: row.fleet_id,
    user_id: row.user_id,
    token_address: row.token_address,
    order_type: row.order_type,
    status: row.status,
    amount_per_wallet: parseFloat(row.amount_per_wallet) || 0,
    sell_pct: row.sell_pct != null ? parseFloat(row.sell_pct) : undefined,
    target_type: row.target_type,
    trigger_condition: row.trigger_condition,
    target_value: row.target_value != null ? parseFloat(row.target_value) : undefined,
    sl_percent: row.sl_percent != null ? parseFloat(row.sl_percent) : undefined,
    tp_percent: row.tp_percent != null ? parseFloat(row.tp_percent) : undefined,
    max_slippage_pct: parseFloat(row.max_slippage_pct) || 3.0,
    volume_interval_sec: row.volume_interval_sec != null ? Number(row.volume_interval_sec) : undefined,
    last_executed_at: row.last_executed_at ? new Date(row.last_executed_at) : undefined,
    expires_at: row.expires_at ? new Date(row.expires_at) : undefined,
    fill_summary: row.fill_summary,
    failure_reason: row.failure_reason,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
  };
}

export async function upsertRaceFleet(params: CreateRaceFleetParams): Promise<RaceFleetRecord> {
  const db = await getDb();
  const durationDays = params.duration_days ?? 30;
  const expiresAt = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000);
  const feeNear = params.monthly_fee_near ?? 2.0;

  const res = await db.query(
    `INSERT INTO race_fleets (
      user_id, name, fleet_tag, status, wallet_count, monthly_fee_near, starts_at, expires_at, auto_renew
    ) VALUES ($1, $2, $3, 'active', $4, $5, NOW(), $6, $7)
    ON CONFLICT (user_id) DO UPDATE SET
      name = EXCLUDED.name,
      fleet_tag = EXCLUDED.fleet_tag,
      status = 'active',
      wallet_count = EXCLUDED.wallet_count,
      expires_at = EXCLUDED.expires_at,
      auto_renew = EXCLUDED.auto_renew,
      updated_at = NOW()
    RETURNING *`,
    [
      params.user_id,
      params.name || 'Alpha Fleet',
      params.fleet_tag,
      params.wallet_count,
      feeNear.toString(),
      expiresAt,
      params.auto_renew ?? true,
    ]
  );
  return rowToRaceFleet(res.rows[0]);
}

export async function getRaceFleetByUserId(userId: string): Promise<RaceFleetRecord | null> {
  const db = await getDb();
  const res = await db.query('SELECT * FROM race_fleets WHERE user_id = $1', [userId]);
  if (!res.rows[0]) return null;
  return rowToRaceFleet(res.rows[0]);
}

export async function getRaceFleetById(fleetId: string): Promise<RaceFleetRecord | null> {
  const db = await getDb();
  const res = await db.query('SELECT * FROM race_fleets WHERE id = $1', [fleetId]);
  if (!res.rows[0]) return null;
  return rowToRaceFleet(res.rows[0]);
}

export async function updateRaceFleetStatus(fleetId: string, status: 'active' | 'expired' | 'paused'): Promise<void> {
  const db = await getDb();
  await db.query('UPDATE race_fleets SET status = $2, updated_at = NOW() WHERE id = $1', [fleetId, status]);
}

export async function renewRaceFleet(fleetId: string, additionalDays = 30): Promise<RaceFleetRecord> {
  const db = await getDb();
  const fleet = await getRaceFleetById(fleetId);
  if (!fleet) throw new Error('Fleet not found');

  const baseTime = fleet.expires_at.getTime() > Date.now() ? fleet.expires_at.getTime() : Date.now();
  const newExpiresAt = new Date(baseTime + additionalDays * 24 * 60 * 60 * 1000);

  const res = await db.query(
    `UPDATE race_fleets
     SET expires_at = $2, status = 'active', updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [fleetId, newExpiresAt]
  );
  return rowToRaceFleet(res.rows[0]);
}

export async function createRaceFleetWallets(wallets: CreateRaceFleetWalletParams[]): Promise<RaceFleetWalletRecord[]> {
  if (wallets.length === 0) return [];
  const db = await getDb();
  const results: RaceFleetWalletRecord[] = [];

  for (const w of wallets) {
    const res = await db.query(
      `INSERT INTO race_fleet_wallets (
        fleet_id, user_id, account_id, wallet_index, encrypted_private_key, is_active
      ) VALUES ($1, $2, $3, $4, $5, TRUE)
      ON CONFLICT (account_id) DO UPDATE SET
        encrypted_private_key = EXCLUDED.encrypted_private_key,
        is_active = TRUE
      RETURNING *`,
      [w.fleet_id, w.user_id, w.account_id, w.wallet_index, w.encrypted_private_key]
    );
    results.push(rowToRaceFleetWallet(res.rows[0]));
  }
  return results;
}

export async function getRaceFleetWallets(fleetId: string): Promise<RaceFleetWalletRecord[]> {
  const db = await getDb();
  const res = await db.query(
    'SELECT * FROM race_fleet_wallets WHERE fleet_id = $1 AND is_active = TRUE ORDER BY wallet_index ASC',
    [fleetId]
  );
  return res.rows.map(rowToRaceFleetWallet);
}

export async function getRaceFleetWalletsByUserId(userId: string): Promise<RaceFleetWalletRecord[]> {
  const db = await getDb();
  const res = await db.query(
    'SELECT * FROM race_fleet_wallets WHERE user_id = $1 AND is_active = TRUE ORDER BY wallet_index ASC',
    [userId]
  );
  return res.rows.map(rowToRaceFleetWallet);
}

export async function createRaceFleetOrder(params: CreateRaceFleetOrderParams): Promise<RaceFleetOrderRecord> {
  const db = await getDb();
  const res = await db.query(
    `INSERT INTO race_fleet_orders (
      fleet_id, user_id, token_address, order_type, status, amount_per_wallet, sell_pct,
      target_type, trigger_condition, target_value, sl_percent, tp_percent, max_slippage_pct,
      volume_interval_sec, expires_at
    ) VALUES ($1, $2, $3, $4, 'active', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    RETURNING *`,
    [
      params.fleet_id,
      params.user_id,
      params.token_address,
      params.order_type,
      params.amount_per_wallet ?? 0,
      params.sell_pct ?? null,
      params.target_type ?? null,
      params.trigger_condition ?? null,
      params.target_value ?? null,
      params.sl_percent ?? null,
      params.tp_percent ?? null,
      params.max_slippage_pct ?? 3.0,
      params.volume_interval_sec ?? 30,
      params.expires_at ?? null,
    ]
  );
  return rowToRaceFleetOrder(res.rows[0]);
}

export async function getActiveRaceFleetOrders(orderType?: string): Promise<RaceFleetOrderRecord[]> {
  const db = await getDb();
  let query = "SELECT * FROM race_fleet_orders WHERE status = 'active'";
  const values: any[] = [];
  if (orderType) {
    query += ' AND order_type = $1';
    values.push(orderType);
  }
  query += ' ORDER BY created_at ASC';
  const res = await db.query(query, values);
  return res.rows.map(rowToRaceFleetOrder);
}

export async function getRaceFleetOrdersByFleet(fleetId: string): Promise<RaceFleetOrderRecord[]> {
  const db = await getDb();
  const res = await db.query(
    'SELECT * FROM race_fleet_orders WHERE fleet_id = $1 ORDER BY created_at DESC LIMIT 50',
    [fleetId]
  );
  return res.rows.map(rowToRaceFleetOrder);
}

export async function cancelRaceFleetOrder(orderId: string, userId: string): Promise<boolean> {
  const db = await getDb();
  const res = await db.query(
    "UPDATE race_fleet_orders SET status = 'cancelled', updated_at = NOW() WHERE id = $1 AND user_id = $2 AND status = 'active' RETURNING id",
    [orderId, userId]
  );
  return (res.rowCount ?? 0) > 0;
}

export async function updateRaceFleetOrderStatus(
  orderId: string,
  status: string,
  failureReason?: string,
  fillSummary?: any
): Promise<void> {
  const db = await getDb();
  await db.query(
    `UPDATE race_fleet_orders
     SET status = $2, failure_reason = $3, fill_summary = $4, updated_at = NOW()
     WHERE id = $1`,
    [orderId, status, failureReason || null, fillSummary ? JSON.stringify(fillSummary) : null]
  );
}

// ── RaceFleet Fills & PnL ───────────────────────────────────────────────────

export interface RaceFleetFillRecord {
  id: string;
  fleet_id: string;
  user_id: string;
  wallet_account_id: string | null;
  side: 'buy' | 'sell';
  token_address: string;
  amount: string;
  price: string;
  fee_paid: string;
  venue: string;
  tx_hash: string;
  created_at: Date;
}

export interface CreateRaceFleetFillParams {
  fleet_id: string;
  user_id: string;
  wallet_account_id?: string;
  side: 'buy' | 'sell';
  token_address: string;
  amount: number | string;
  price: number | string;
  fee_paid?: number | string;
  venue?: string;
  tx_hash: string;
}

export async function recordRaceFleetFill(params: CreateRaceFleetFillParams): Promise<RaceFleetFillRecord> {
  const db = await getDb();
  const res = await db.query(
    `INSERT INTO race_fleet_fills (
      fleet_id, user_id, wallet_account_id, side, token_address, amount, price, fee_paid, venue, tx_hash
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING *`,
    [
      params.fleet_id,
      params.user_id,
      params.wallet_account_id || null,
      params.side,
      params.token_address,
      params.amount.toString(),
      params.price.toString(),
      (params.fee_paid ?? 0).toString(),
      params.venue || 'ref',
      params.tx_hash,
    ]
  );
  const row = res.rows[0];
  return {
    id: row.id,
    fleet_id: row.fleet_id,
    user_id: row.user_id,
    wallet_account_id: row.wallet_account_id,
    side: row.side,
    token_address: row.token_address,
    amount: row.amount,
    price: row.price,
    fee_paid: row.fee_paid,
    venue: row.venue,
    tx_hash: row.tx_hash,
    created_at: new Date(row.created_at),
  };
}

export async function getRaceFleetFills(fleetId: string, tokenAddress?: string): Promise<RaceFleetFillRecord[]> {
  const db = await getDb();
  let query = 'SELECT * FROM race_fleet_fills WHERE fleet_id = $1';
  const params: any[] = [fleetId];
  if (tokenAddress) {
    query += ' AND token_address = $2';
    params.push(tokenAddress);
  }
  query += ' ORDER BY created_at DESC';
  const res = await db.query(query, params);
  return res.rows.map(row => ({
    id: row.id,
    fleet_id: row.fleet_id,
    user_id: row.user_id,
    wallet_account_id: row.wallet_account_id,
    side: row.side,
    token_address: row.token_address,
    amount: row.amount,
    price: row.price,
    fee_paid: row.fee_paid,
    venue: row.venue,
    tx_hash: row.tx_hash,
    created_at: new Date(row.created_at),
  }));
}


export interface RacerDepositRecord {
  id: string;
  deposit_id: string;
  user_id?: string;
  telegram_id: number;
  subaccount_id: string;
  source_chain: string;
  source_asset: string;
  source_symbol?: string;
  source_amount?: number;
  destination_chain: string;
  destination_asset: string;
  destination_symbol: string;
  destination_address: string;
  deposit_address: string;
  min_destination_amount?: number;
  fee_amount?: number;
  fee_recipient?: string;
  fee_bps?: number;
  status: string;
  quote_data?: any;
  tx_hash?: string;
  unwrapped: boolean;
  unwrapped_amount: number;
  created_at: Date;
  updated_at: Date;
  completed_at?: Date;
}

export interface CreateRacerDepositParams {
  deposit_id: string;
  user_id?: string;
  telegram_id: number;
  subaccount_id: string;
  source_chain: string;
  source_asset: string;
  source_symbol?: string;
  source_amount?: number;
  destination_chain?: string;
  destination_asset?: string;
  destination_symbol?: string;
  destination_address: string;
  deposit_address: string;
  min_destination_amount?: number;
  fee_amount?: number;
  fee_recipient?: string;
  fee_bps?: number;
  status?: string;
  quote_data?: any;
}

export async function createRacerDeposit(params: CreateRacerDepositParams): Promise<RacerDepositRecord> {
  const db = await getDb();
  const res = await db.query(
    `INSERT INTO racer_deposits (
      deposit_id, user_id, telegram_id, subaccount_id, source_chain, source_asset,
      source_symbol, source_amount, destination_chain, destination_asset,
      destination_symbol, destination_address, deposit_address, min_destination_amount,
      fee_amount, fee_recipient, fee_bps, status, quote_data
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19
    ) RETURNING *`,
    [
      params.deposit_id,
      params.user_id || null,
      params.telegram_id,
      params.subaccount_id,
      params.source_chain,
      params.source_asset,
      params.source_symbol || null,
      params.source_amount ?? null,
      params.destination_chain || 'near',
      params.destination_asset || 'nep141:wrap.near',
      params.destination_symbol || 'NEAR',
      params.destination_address,
      params.deposit_address,
      params.min_destination_amount ?? null,
      params.fee_amount ?? 0,
      params.fee_recipient || process.env.TREASURY_ACCOUNT_ID || 'racerbottreasury.near',
      params.fee_bps ?? 100,
      params.status || 'PENDING',
      params.quote_data ? JSON.stringify(params.quote_data) : null,
    ]
  );
  return mapRacerDepositRow(res.rows[0]);
}

export async function updateRacerDeposit(
  depositId: string,
  updates: {
    status?: string;
    tx_hash?: string;
    unwrapped?: boolean;
    unwrapped_amount?: number;
    completed_at?: Date;
    quote_data?: any;
  }
): Promise<RacerDepositRecord | null> {
  const db = await getDb();
  const setClauses: string[] = ['updated_at = NOW()'];
  const values: any[] = [];
  let idx = 1;

  if (updates.status !== undefined) {
    setClauses.push(`status = $${idx++}`);
    values.push(updates.status);
  }
  if (updates.tx_hash !== undefined) {
    setClauses.push(`tx_hash = $${idx++}`);
    values.push(updates.tx_hash);
  }
  if (updates.unwrapped !== undefined) {
    setClauses.push(`unwrapped = $${idx++}`);
    values.push(updates.unwrapped);
  }
  if (updates.unwrapped_amount !== undefined) {
    setClauses.push(`unwrapped_amount = $${idx++}`);
    values.push(updates.unwrapped_amount);
  }
  if (updates.completed_at !== undefined) {
    setClauses.push(`completed_at = $${idx++}`);
    values.push(updates.completed_at);
  }
  if (updates.quote_data !== undefined) {
    setClauses.push(`quote_data = $${idx++}`);
    values.push(JSON.stringify(updates.quote_data));
  }

  values.push(depositId);
  const query = `UPDATE racer_deposits SET ${setClauses.join(', ')} WHERE deposit_id = $${idx} RETURNING *`;
  const res = await db.query(query, values);
  if (!res.rows[0]) return null;
  return mapRacerDepositRow(res.rows[0]);
}

export async function getRacerDepositById(depositId: string): Promise<RacerDepositRecord | null> {
  const db = await getDb();
  const res = await db.query(`SELECT * FROM racer_deposits WHERE deposit_id = $1`, [depositId]);
  if (!res.rows[0]) return null;
  return mapRacerDepositRow(res.rows[0]);
}

export async function getActiveRacerDeposits(): Promise<RacerDepositRecord[]> {
  const db = await getDb();
  const res = await db.query(
    `SELECT * FROM racer_deposits 
     WHERE status IN ('PENDING', 'PROCESSING', 'SUCCESS') 
       AND (status != 'SUCCESS' OR unwrapped = FALSE)
       AND created_at > NOW() - INTERVAL '48 hours'
     ORDER BY created_at DESC`
  );
  return res.rows.map(mapRacerDepositRow);
}

export async function getUserRacerDeposits(telegramId: number, limit = 10): Promise<RacerDepositRecord[]> {
  const db = await getDb();
  const res = await db.query(
    `SELECT * FROM racer_deposits WHERE telegram_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [telegramId, limit]
  );
  return res.rows.map(mapRacerDepositRow);
}

export async function getRacerDepositStats(): Promise<{ total_count: number; total_near_volume: number; completed_count: number }> {
  const db = await getDb();
  const res = await db.query(
    `SELECT 
       COUNT(*) as total_count,
       COUNT(*) FILTER (WHERE status = 'SUCCESS') as completed_count,
       COALESCE(SUM(min_destination_amount) FILTER (WHERE status = 'SUCCESS'), 0) as total_near_volume
     FROM racer_deposits`
  );
  const row = res.rows[0];
  return {
    total_count: parseInt(row.total_count, 10) || 0,
    completed_count: parseInt(row.completed_count, 10) || 0,
    total_near_volume: parseFloat(row.total_near_volume) || 0,
  };
}

function mapRacerDepositRow(row: any): RacerDepositRecord {
  return {
    id: row.id,
    deposit_id: row.deposit_id,
    user_id: row.user_id,
    telegram_id: typeof row.telegram_id === 'string' ? parseInt(row.telegram_id, 10) : Number(row.telegram_id),
    subaccount_id: row.subaccount_id,
    source_chain: row.source_chain,
    source_asset: row.source_asset,
    source_symbol: row.source_symbol,
    source_amount: row.source_amount ? parseFloat(row.source_amount) : undefined,
    destination_chain: row.destination_chain,
    destination_asset: row.destination_asset,
    destination_symbol: row.destination_symbol,
    destination_address: row.destination_address,
    deposit_address: row.deposit_address,
    min_destination_amount: row.min_destination_amount ? parseFloat(row.min_destination_amount) : undefined,
    fee_amount: row.fee_amount ? parseFloat(row.fee_amount) : 0,
    fee_recipient: row.fee_recipient,
    fee_bps: row.fee_bps ? parseInt(row.fee_bps, 10) : 100,
    status: row.status,
    quote_data: typeof row.quote_data === 'string' ? JSON.parse(row.quote_data) : row.quote_data,
    tx_hash: row.tx_hash,
    unwrapped: !!row.unwrapped,
    unwrapped_amount: row.unwrapped_amount ? parseFloat(row.unwrapped_amount) : 0,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
    completed_at: row.completed_at ? new Date(row.completed_at) : undefined,
  };
}
