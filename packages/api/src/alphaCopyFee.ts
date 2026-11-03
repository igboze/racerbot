/**
 * Racer Alpha copy profit share: a creator sets a percentage (0-25%) of the profit
 * their followers make on copied trades. Auto-copy records what each copied buy cost
 * and how many tokens it added; when a copied sell closes some of them at a profit,
 * that share of the profit is sent to the creator: from the follower's wallet for
 * wallet copies, from their private balance for confidential (executor) copies.
 *
 * Only copied tokens count. When the follower also holds the token from their own
 * buys, the sell is split pro rata. Anything that cannot be measured (no balance
 * change, no proceeds) charges nothing, so a follower is never overcharged.
 * A charge that fails is retried by a background job.
 */
import crypto from 'crypto';
import { createLogger } from '@racerbot/shared';
import { getDb, getUserById } from '@racerbot/db';
import { transferNearFromUser, unwrapUserWrapNear } from './wallet.js';

type Db = Awaited<ReturnType<typeof getDb>>;
const logger = createLogger('alpha-copy-fee');

export const MAX_COPY_FEE_PCT = 25;
/** Below this the transfer's gas is not worth it */
export const MIN_COPY_FEE_NEAR = 0.001;
/** Where a copy trade ran: the follower's trading wallet or their confidential executors */
export type CopyRoute = 'wallet' | 'confidential';

const RETRY_EVERY_MS = 10 * 60_000;
const RETRY_GAP_MINUTES = 30;
const MAX_ATTEMPTS = 20;
const RETRY_WINDOW_DAYS = 30;

export interface CopyProfitShare {
  copiedSoldRaw: bigint;
  costPortionNear: number;
  profitNear: number;
  feeNear: number;
}

function ratio(part: bigint, whole: bigint): number {
  return Number((part * 1_000_000_000n) / whole) / 1e9;
}

/** The creator's share of one copied sell, and how much copied cost basis it used up */
export function computeCopyProfitShare(p: {
  costNear: number;
  copiedQtyRaw: bigint;
  balanceBeforeRaw: bigint;
  soldRaw: bigint;
  proceedsNear: number;
  feePct: number;
}): CopyProfitShare {
  const none: CopyProfitShare = { copiedSoldRaw: 0n, costPortionNear: 0, profitNear: 0, feeNear: 0 };
  if (p.copiedQtyRaw <= 0n || p.balanceBeforeRaw <= 0n || p.soldRaw <= 0n || !(p.proceedsNear > 0)) return none;

  // Copied tokens still held (some may have been sent out), sold pro rata with the rest
  const held = p.copiedQtyRaw < p.balanceBeforeRaw ? p.copiedQtyRaw : p.balanceBeforeRaw;
  let copiedSold = (p.soldRaw * held) / p.balanceBeforeRaw;
  if (copiedSold > p.copiedQtyRaw) copiedSold = p.copiedQtyRaw;
  if (copiedSold <= 0n) return none;

  const costPortionNear = p.costNear * ratio(copiedSold, p.copiedQtyRaw);
  const proceedsPortionNear = p.proceedsNear * ratio(copiedSold, p.soldRaw);
  const profitNear = proceedsPortionNear - costPortionNear;
  const pct = Math.max(0, Math.min(MAX_COPY_FEE_PCT, Number(p.feePct) || 0));
  const feeNear = profitNear > 0 ? (profitNear * pct) / 100 : 0;
  return { copiedSoldRaw: copiedSold, costPortionNear, profitNear, feeNear };
}

/** The creator's profit-share settings: percentage and the NEAR account that receives it */
export async function resolveCopyFeeSettings(db: Db, traderId: string): Promise<{ feePct: number; payoutAccount: string | null }> {
  const res = await db.query(
    'SELECT copy_fee_pct, payout_wallet_address, user_id FROM racer_alpha_traders WHERE id = $1',
    [traderId]
  ).catch(() => ({ rows: [] as any[] }));
  const row = res.rows[0];
  const feePct = Number(row?.copy_fee_pct) || 0;
  if (feePct <= 0 || !row || row.user_id === 'system_alpha') return { feePct, payoutAccount: null };
  const payoutAccount = row.payout_wallet_address?.trim()
    || (await getUserById(row.user_id).catch(() => null))?.subaccount_id?.trim()
    || null;
  return { feePct, payoutAccount };
}

/** Adds a copied buy to the follower's copied cost basis for this creator, token and route */
export async function recordCopyBuy(db: Db, p: {
  userId: string;
  traderId: string;
  tokenAddress: string;
  route: CopyRoute;
  costNear: number;
  qtyRaw: bigint;
}): Promise<void> {
  if (p.qtyRaw <= 0n || !(p.costNear > 0)) return;
  await db.query(
    `INSERT INTO racer_alpha_copy_positions (user_id, trader_id, token_address, route, cost_near, qty_raw)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, trader_id, token_address, route) DO UPDATE
       SET cost_near = racer_alpha_copy_positions.cost_near + EXCLUDED.cost_near,
           qty_raw = racer_alpha_copy_positions.qty_raw + EXCLUDED.qty_raw,
           updated_at = NOW()`,
    [p.userId, p.traderId, p.tokenAddress.toLowerCase(), p.route, p.costNear, p.qtyRaw.toString()]
  );
}

interface FeeRow {
  id: string;
  user_id: string;
  trader_id: string;
  route: CopyRoute;
  fee_near: string | number;
  payout_account: string | null;
  telegram_id: string | number | null;
}

/** One attempt to send a logged profit share; marks it paid or failed */
async function collectCopyFee(db: Db, row: FeeRow): Promise<{ paid: boolean; txHash?: string; error?: string }> {
  const feeNear = Number(row.fee_near) || 0;
  const feeYocto = BigInt(Math.floor(feeNear * 1e6)) * 10n ** 18n;
  try {
    const payout = row.payout_account || (await resolveCopyFeeSettings(db, row.trader_id)).payoutAccount;
    if (!payout) throw new Error('The creator has no payout account');
    let txHash: string;
    if (row.route === 'confidential') {
      const { payFromPrivateBalance } = await import('./executorPool.js');
      txHash = (await payFromPrivateBalance(row.user_id, feeYocto, payout)).intentHash;
    } else {
      const send = () => transferNearFromUser(row.user_id, payout, feeYocto.toString());
      try {
        txHash = (await send()).txHash;
      } catch (err) {
        // NEAR sale proceeds can arrive as wNEAR: unwrap once and retry
        if (!row.telegram_id) throw err;
        await unwrapUserWrapNear(Number(row.telegram_id));
        txHash = (await send()).txHash;
      }
    }
    await db.query(
      `UPDATE racer_alpha_copy_fees
       SET status = 'paid', tx_hash = $2, payout_account = $3, error = NULL,
           attempts = attempts + 1, last_attempt_at = NOW()
       WHERE id = $1`,
      [row.id, txHash, payout]
    );
    await db.query(
      `UPDATE racer_alpha_traders SET total_revenue_near = total_revenue_near + $1, updated_at = NOW() WHERE id = $2`,
      [feeNear, row.trader_id]
    );
    return { paid: true, txHash };
  } catch (err: any) {
    const error = err?.message || 'transfer failed';
    await db.query(
      `UPDATE racer_alpha_copy_fees
       SET status = CASE WHEN attempts + 1 >= $3 THEN 'abandoned' ELSE 'failed' END,
           error = $2, attempts = attempts + 1, last_attempt_at = NOW()
       WHERE id = $1`,
      [row.id, error, MAX_ATTEMPTS]
    ).catch(() => {});
    return { paid: false, error };
  }
}

/**
 * After a copied sell: uses up the copied cost basis it sold and charges the creator's
 * profit share. Returns the fee charged (or attempted), or null when none was owed.
 */
export async function settleCopySell(db: Db, p: {
  signalId: string;
  userId: string;
  telegramId?: number;
  traderId: string;
  tokenAddress: string;
  route: CopyRoute;
  feePct: number;
  payoutAccount: string | null;
  balanceBeforeRaw: bigint;
  soldRaw: bigint;
  proceedsNear: number;
}): Promise<{ feeNear: number; profitNear: number; paid: boolean; txHash?: string; error?: string } | null> {
  const token = p.tokenAddress.toLowerCase();
  let share: CopyProfitShare;

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const res = await client.query(
      `SELECT cost_near, qty_raw FROM racer_alpha_copy_positions
       WHERE user_id = $1 AND trader_id = $2 AND token_address = $3 AND route = $4 FOR UPDATE`,
      [p.userId, p.traderId, token, p.route]
    );
    const row = res.rows[0];
    if (!row) {
      await client.query('COMMIT');
      return null;
    }
    const copiedQtyRaw = BigInt(String(row.qty_raw).split('.')[0] || '0');
    share = computeCopyProfitShare({
      costNear: Number(row.cost_near) || 0,
      copiedQtyRaw,
      balanceBeforeRaw: p.balanceBeforeRaw,
      soldRaw: p.soldRaw,
      proceedsNear: p.proceedsNear,
      feePct: p.feePct,
    });
    const qtyLeft = copiedQtyRaw - share.copiedSoldRaw;
    if (qtyLeft <= 0n) {
      await client.query(
        'DELETE FROM racer_alpha_copy_positions WHERE user_id = $1 AND trader_id = $2 AND token_address = $3 AND route = $4',
        [p.userId, p.traderId, token, p.route]
      );
    } else if (share.copiedSoldRaw > 0n) {
      await client.query(
        `UPDATE racer_alpha_copy_positions
         SET qty_raw = $5, cost_near = GREATEST(cost_near - $6, 0), updated_at = NOW()
         WHERE user_id = $1 AND trader_id = $2 AND token_address = $3 AND route = $4`,
        [p.userId, p.traderId, token, p.route, qtyLeft.toString(), share.costPortionNear]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  if (share.feeNear < MIN_COPY_FEE_NEAR || !p.payoutAccount) return null;

  const feeId = 'cfee_' + crypto.randomBytes(8).toString('hex');
  const inserted = await db.query(
    `INSERT INTO racer_alpha_copy_fees
       (id, signal_id, user_id, trader_id, token_address, route, profit_near, fee_pct, fee_near, payout_account, telegram_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'collecting')
     ON CONFLICT (signal_id, user_id) DO NOTHING
     RETURNING id`,
    [feeId, p.signalId, p.userId, p.traderId, token, p.route, share.profitNear, p.feePct, share.feeNear,
      p.payoutAccount, p.telegramId ?? null]
  );
  if (inserted.rows.length === 0) return null; // this signal already charged this follower

  const result = await collectCopyFee(db, {
    id: feeId, user_id: p.userId, trader_id: p.traderId, route: p.route,
    fee_near: share.feeNear, payout_account: p.payoutAccount, telegram_id: p.telegramId ?? null,
  });
  if (!result.paid) logger.warn(`Copy profit share ${feeId} not collected yet: ${result.error}`);
  return { feeNear: share.feeNear, profitNear: share.profitNear, ...result };
}

/**
 * Retries profit shares that could not be collected (an empty wallet, NEAR still in an executor).
 * A row left 'collecting' by a crash mid-send is never retried: it may have been paid.
 */
export async function retryFailedCopyFees(limit = 20): Promise<{ paid: number; failed: number }> {
  const db = await getDb();
  const res = await db.query(
    `SELECT id, user_id, trader_id, route, fee_near, payout_account, telegram_id
     FROM racer_alpha_copy_fees
     WHERE status = 'failed'
       AND attempts < $1
       AND created_at > NOW() - make_interval(days => $2)
       AND (last_attempt_at IS NULL OR last_attempt_at < NOW() - make_interval(mins => $3))
     ORDER BY last_attempt_at NULLS FIRST
     LIMIT $4`,
    [MAX_ATTEMPTS, RETRY_WINDOW_DAYS, RETRY_GAP_MINUTES, limit]
  );
  let paid = 0;
  let failed = 0;
  for (const row of res.rows as FeeRow[]) {
    // Claim the row first, so two instances (or a slow first attempt) can never send it twice
    const claimed = await db.query(
      `UPDATE racer_alpha_copy_fees SET status = 'collecting', last_attempt_at = NOW()
       WHERE id = $1 AND status = 'failed'
         AND (last_attempt_at IS NULL OR last_attempt_at < NOW() - make_interval(mins => $2))
       RETURNING id`,
      [row.id, RETRY_GAP_MINUTES]
    );
    if (claimed.rows.length === 0) continue;
    const r = await collectCopyFee(db, row);
    if (r.paid) paid++;
    else failed++;
  }
  if (paid || failed) logger.info(`Copy profit share retry: ${paid} collected, ${failed} still pending`);
  return { paid, failed };
}

export function startCopyFeeRetryWorker(intervalMs = RETRY_EVERY_MS): NodeJS.Timeout {
  return setInterval(() => {
    retryFailedCopyFees().catch(err => logger.warn(`Copy profit share retry failed: ${err?.message}`));
  }, intervalMs);
}
