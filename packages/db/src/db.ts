import { Pool } from 'pg';
import { randomUUID } from 'crypto';

// ── Local type definitions (not imported from shared — avoids circular deps) ──

export interface UserRecord {
  id: string;
  telegram_id: number;
  subaccount_id: string;
  scoped_key_encrypted: string;
  default_buy_pct: number | null;
  default_sell_pct: number | null;
  fee_tier: string;
  auto_buy_enabled: boolean;
  auto_buy_amount_near: number;
  auto_buy_min_liquidity_near: number;
  slippage_pct: number;
  referred_by: string | null;
  referral_code: string | null;
  username: string | null;
  created_at: Date;
}

export interface PositionRecord {
  id: string;
  user_id: string;
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
  side: string;
  token_address: string;
  amount: string;
  price: string;
  fee_paid: string;
  venue: string;
  tx_hash: string;
  created_at: Date;
}

export interface TriggerRecord {
  id: string;
  user_id: string;
  position_id: string;
  type: string;
  target_value: string;
  status: string;
  created_at: Date;
}

export interface TokenCacheRecord {
  token_address: string;
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
}

export interface CreateUserParams {
  telegram_id: number;
  subaccount_id: string;
  scoped_key_encrypted: string;
  default_buy_pct?: number;
  default_sell_pct?: number;
}

export interface CreatePositionParams {
  user_id: string;
  token_address: string;
  quantity_held: string;
  avg_entry_price: string;
}

export interface CreateFillParams {
  user_id: string;
  position_id: string;
  side: string;
  token_address: string;
  amount: string;
  price: string;
  fee_paid: string;
  venue: string;
  tx_hash: string;
}

export interface CreateTriggerParams {
  user_id: string;
  position_id: string;
  type: string;
  target_value: string;
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
  pool.on('connect', () => console.log('[DB] Connected to Postgres'));

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
    `INSERT INTO users (id, telegram_id, subaccount_id, scoped_key_encrypted, default_buy_pct, default_sell_pct, fee_tier)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (telegram_id) DO UPDATE SET subaccount_id = EXCLUDED.subaccount_id, scoped_key_encrypted = EXCLUDED.scoped_key_encrypted
     RETURNING *`,
    [id, params.telegram_id, params.subaccount_id, params.scoped_key_encrypted, params.default_buy_pct || null, params.default_sell_pct || null, 'standard']
  );
  return rowToUser(result.rows[0]);
}

export async function getUserByTelegramId(telegramId: number): Promise<UserRecord | null> {
  const db = await getDb();
  const result = await db.query('SELECT * FROM users WHERE telegram_id = $1', [telegramId]);
  if (result.rows.length === 0) return null;
  return rowToUser(result.rows[0]);
}

export async function getUserById(id: string): Promise<UserRecord | null> {
  const db = await getDb();
  const result = await db.query('SELECT * FROM users WHERE id = $1', [id]);
  if (result.rows.length === 0) return null;
  return rowToUser(result.rows[0]);
}

export async function getUserBySubaccount(subaccountId: string): Promise<UserRecord | null> {
  const db = await getDb();
  const result = await db.query('SELECT * FROM users WHERE subaccount_id = $1', [subaccountId]);
  if (result.rows.length === 0) return null;
  return rowToUser(result.rows[0]);
}

export async function updateUserScopedKey(userId: string, encryptedKey: string): Promise<void> {
  const db = await getDb();
  await db.query('UPDATE users SET scoped_key_encrypted = $1 WHERE id = $2', [encryptedKey, userId]);
}

export async function updateUserDefaults(userId: string, buyPct?: number, sellPct?: number): Promise<void> {
  const db = await getDb();
  await db.query('UPDATE users SET default_buy_pct = $1, default_sell_pct = $2 WHERE id = $3', [buyPct, sellPct, userId]);
}

export interface UpdateUserSettingsParams {
  auto_buy_enabled?: boolean;
  auto_buy_amount_near?: number;
  auto_buy_min_liquidity_near?: number;
  slippage_pct?: number;
  default_buy_pct?: number;
  default_sell_pct?: number;
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

  if (setParts.length === 0) {
    const u = await getUserById(userId);
    return u!;
  }

  values.push(userId);
  const result = await db.query(
    `UPDATE users SET ${setParts.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  return rowToUser(result.rows[0]);
}

export async function createPosition(params: CreatePositionParams): Promise<PositionRecord> {
  const db = await getDb();
  const id = generateId();
  await db.query(
    'INSERT INTO positions (id, user_id, token_address, quantity_held, avg_entry_price, status, opened_at) VALUES ($1, $2, $3, $4, $5, $6, NOW())',
    [id, params.user_id, params.token_address, params.quantity_held, params.avg_entry_price, 'open']
  );
  return { ...params, id, status: 'open', opened_at: new Date(), closed_at: null };
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

  try {
    await client.query('BEGIN');

    const insertResult = await client.query(
      `INSERT INTO fills (id, user_id, position_id, side, token_address, amount, price, fee_paid, venue, tx_hash, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
       ON CONFLICT (tx_hash) DO NOTHING
       RETURNING id`,
      [id, params.user_id, params.position_id, params.side, params.token_address, params.amount, params.price, params.fee_paid, params.venue, params.tx_hash]
    );

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
      fill: { ...params, id, created_at: new Date() },
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
  await db.query(
    'INSERT INTO triggers (id, user_id, position_id, type, target_value, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, NOW())',
    [id, params.user_id, params.position_id, params.type, params.target_value, 'active']
  );
  return { ...params, id, status: 'active', created_at: new Date() };
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

export async function getTokenCache(address: string): Promise<TokenCacheRecord | null> {
  const db = await getDb();
  const result = await db.query('SELECT * FROM token_cache WHERE token_address = $1', [address]);
  if (result.rows.length === 0) return null;
  return rowToTokenCache(result.rows[0]);
}

export async function upsertTokenCache(record: TokenCacheRecord): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO token_cache (token_address, name, symbol, decimals, total_supply, pool_address, venue, rhea_pool_id, bonding_phase, bonding_progress_pct, dcl_pool_id, last_price, last_liquidity, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
     ON CONFLICT (token_address) DO UPDATE SET 
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
       updated_at = NOW()`,
    [
      record.token_address,
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
    ]
  );
}

export async function recordFee(fillId: string, amount: string): Promise<void> {
  const db = await getDb();
  const id = generateId();
  await db.query('INSERT INTO fee_ledger (id, fill_id, amount, created_at) VALUES ($1, $2, $3, NOW())', [id, fillId, amount]);
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
  const result = await db.query('SELECT * FROM users WHERE referral_code = $1', [referralCode]);
  if (result.rows.length === 0) return null;
  return rowToUser(result.rows[0]);
}

export async function createReferral(referrerId: string, referredUserId: string): Promise<ReferralRecord> {
  const db = await getDb();
  const id = generateId();
  await db.query(
    'INSERT INTO referrals (id, referrer_id, referred_user_id, status, created_at) VALUES ($1, $2, $3, $4, NOW())',
    [id, referrerId, referredUserId, 'pending']
  );
  return {
    id,
    referrer_id: referrerId,
    referred_user_id: referredUserId,
    status: 'pending',
    total_fees_earned: 0,
    created_at: new Date(),
    completed_at: null,
  };
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
  const result = await db.query('SELECT * FROM referrals WHERE referred_user_id = $1', [referredUserId]);
  if (result.rows.length === 0) return null;
  return rowToReferral(result.rows[0]);
}

export async function getTotalReferralEarnings(referrerId: string): Promise<number> {
  const db = await getDb();
  const result = await db.query(
    'SELECT COALESCE(SUM(total_fees_earned), 0) as total FROM referrals WHERE referrer_id = $1',
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
    default_buy_pct: row.default_buy_pct != null ? parseFloat(row.default_buy_pct) : null,
    default_sell_pct: row.default_sell_pct != null ? parseFloat(row.default_sell_pct) : null,
    fee_tier: row.fee_tier,
    auto_buy_enabled: Boolean(row.auto_buy_enabled),
    auto_buy_amount_near: row.auto_buy_amount_near != null ? parseFloat(row.auto_buy_amount_near) : 1,
    auto_buy_min_liquidity_near: row.auto_buy_min_liquidity_near != null ? parseFloat(row.auto_buy_min_liquidity_near) : 500,
    slippage_pct: row.slippage_pct != null ? parseFloat(row.slippage_pct) : 2,
    referred_by: row.referred_by,
    referral_code: row.referral_code,
    username: row.username,
    created_at: row.created_at,
  };
}

function rowToPosition(row: any): PositionRecord {
  return {
    id: row.id,
    user_id: row.user_id,
    token_address: row.token_address,
    quantity_held: row.quantity_held,
    avg_entry_price: row.avg_entry_price,
    status: row.status,
    opened_at: row.opened_at,
    closed_at: row.closed_at,
    is_external_deposit: row.is_external_deposit,
    external_deposit_detected_at: row.external_deposit_detected_at,
  };
}

function rowToFill(row: any): FillRecord {
  return { id: row.id, user_id: row.user_id, position_id: row.position_id, side: row.side, token_address: row.token_address, amount: row.amount, price: row.price, fee_paid: row.fee_paid, venue: row.venue, tx_hash: row.tx_hash, created_at: row.created_at };
}

function rowToTrigger(row: any): TriggerRecord {
  return { id: row.id, user_id: row.user_id, position_id: row.position_id, type: row.type, target_value: row.target_value, status: row.status, created_at: row.created_at };
}

function rowToTokenCache(row: any): TokenCacheRecord {
  return { 
    token_address: row.token_address, 
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
    updated_at: row.updated_at 
  };
}

function generateId(): string {
  return randomUUID();
}