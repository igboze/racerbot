/**
 * Racer Alpha copy profit share: a creator sets a percentage (0-25%) of the profit
 * their followers make on copied trades. Auto-copy records what each copied buy cost
 * and how many tokens it added; when a copied sell closes some of them at a profit,
 * that share of the profit is sent from the follower's wallet to the creator.
 *
 * Only copied tokens count. When the wallet also holds the token from the follower's
 * own buys, the sell is split pro rata. Anything that cannot be measured (no balance
 * change, no proceeds) charges nothing, so a follower is never overcharged.
 */
import crypto from 'crypto';
import { createLogger } from '@racerbot/shared';
import type { getDb } from '@racerbot/db';
import { transferNearFromUser, unwrapUserWrapNear } from './wallet.js';

type Db = Awaited<ReturnType<typeof getDb>>;
const logger = createLogger('alpha-copy-fee');

export const MAX_COPY_FEE_PCT = 25;
/** Below this the transfer's gas is not worth it */
export const MIN_COPY_FEE_NEAR = 0.001;

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

  // Copied tokens still in the wallet (some may have been sent out), sold pro rata with the rest
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

/** Adds a copied buy to the follower's copied cost basis for this creator and token */
export async function recordCopyBuy(db: Db, p: {
  userId: string;
  traderId: string;
  tokenAddress: string;
  costNear: number;
  qtyRaw: bigint;
}): Promise<void> {
  if (p.qtyRaw <= 0n || !(p.costNear > 0)) return;
  await db.query(
    `INSERT INTO racer_alpha_copy_positions (user_id, trader_id, token_address, cost_near, qty_raw)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, trader_id, token_address) DO UPDATE
       SET cost_near = racer_alpha_copy_positions.cost_near + EXCLUDED.cost_near,
           qty_raw = racer_alpha_copy_positions.qty_raw + EXCLUDED.qty_raw,
           updated_at = NOW()`,
    [p.userId, p.traderId, p.tokenAddress.toLowerCase(), p.costNear, p.qtyRaw.toString()]
  );
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
       WHERE user_id = $1 AND trader_id = $2 AND token_address = $3 FOR UPDATE`,
      [p.userId, p.traderId, token]
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
        'DELETE FROM racer_alpha_copy_positions WHERE user_id = $1 AND trader_id = $2 AND token_address = $3',
        [p.userId, p.traderId, token]
      );
    } else if (share.copiedSoldRaw > 0n) {
      await client.query(
        `UPDATE racer_alpha_copy_positions
         SET qty_raw = $4, cost_near = GREATEST(cost_near - $5, 0), updated_at = NOW()
         WHERE user_id = $1 AND trader_id = $2 AND token_address = $3`,
        [p.userId, p.traderId, token, qtyLeft.toString(), share.costPortionNear]
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
    `INSERT INTO racer_alpha_copy_fees (id, signal_id, user_id, trader_id, token_address, profit_near, fee_pct, fee_near)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (signal_id, user_id) DO NOTHING
     RETURNING id`,
    [feeId, p.signalId, p.userId, p.traderId, token, share.profitNear, p.feePct, share.feeNear]
  );
  if (inserted.rows.length === 0) return null; // this signal already charged this follower

  const feeYocto = (BigInt(Math.floor(share.feeNear * 1e6)) * 10n ** 18n).toString();
  const send = () => transferNearFromUser(p.userId, p.payoutAccount!, feeYocto);
  try {
    let transfer;
    try {
      transfer = await send();
    } catch (err) {
      // NEAR sale proceeds can arrive as wNEAR: unwrap once and retry
      if (!p.telegramId) throw err;
      await unwrapUserWrapNear(p.telegramId);
      transfer = await send();
    }
    await db.query(`UPDATE racer_alpha_copy_fees SET status = 'paid', tx_hash = $2 WHERE id = $1`, [feeId, transfer.txHash]);
    await db.query(
      `UPDATE racer_alpha_traders SET total_revenue_near = total_revenue_near + $1, updated_at = NOW() WHERE id = $2`,
      [share.feeNear, p.traderId]
    );
    return { feeNear: share.feeNear, profitNear: share.profitNear, paid: true, txHash: transfer.txHash };
  } catch (err: any) {
    const error = err?.message || 'transfer failed';
    logger.warn(`Copy profit share ${feeId} not collected: ${error}`);
    await db.query(`UPDATE racer_alpha_copy_fees SET status = 'failed', error = $2 WHERE id = $1`, [feeId, error]).catch(() => {});
    return { feeNear: share.feeNear, profitNear: share.profitNear, paid: false, error };
  }
}
