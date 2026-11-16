/**
 * The signer's rules for money leaving user wallets. They are checked inside the signer,
 * so a compromised API cannot skip them:
 * - a kill switch (SIGNER_PAUSED=true) that refuses every withdrawal
 * - a per-user limit on withdrawals per hour
 * - a circuit breaker: when withdrawals across ALL users spike (the shape of a mass drain),
 *   the signer pauses itself and alerts the admins until someone restarts it or clears it
 */
import { getDb } from '@racerbot/db';
import type { MoneyOutOp } from '../moneyOut.js';

const num = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export const POLICY = {
  perUserPerHour: () => num('SIGNER_MAX_WITHDRAWALS_PER_USER_PER_HOUR', 10),
  globalWindowMinutes: () => num('SIGNER_GLOBAL_WINDOW_MINUTES', 10),
  globalMaxInWindow: () => num('SIGNER_GLOBAL_MAX_WITHDRAWALS', 60),
};

let tripped: { at: number; reason: string } | null = null;

/** The circuit breaker state, for /health and the refusal message */
export function breakerState() {
  return tripped;
}

/** Clears a tripped circuit breaker (admin endpoint) */
export function resetBreaker(): void {
  tripped = null;
}

export interface PolicyDecision {
  allowed: boolean;
  reason?: string;
  /** Set when this request tripped the circuit breaker: the admins must hear about it */
  trippedNow?: boolean;
}

/** The pure decision, from counts already read: kept apart so it is easy to test */
export function decide(p: {
  paused: boolean;
  breakerTripped: boolean;
  userCountLastHour: number;
  globalCountInWindow: number;
}): PolicyDecision {
  if (p.paused) return { allowed: false, reason: 'Withdrawals are paused for maintenance. Your funds are safe; try again later.' };
  if (p.breakerTripped) return { allowed: false, reason: 'Withdrawals are paused while we check unusual activity. Your funds are safe; try again later.' };
  if (p.userCountLastHour >= POLICY.perUserPerHour()) {
    return { allowed: false, reason: `You reached the limit of ${POLICY.perUserPerHour()} withdrawals per hour. Try again later.` };
  }
  if (p.globalCountInWindow >= POLICY.globalMaxInWindow()) {
    return { allowed: false, reason: 'Withdrawals are paused while we check unusual activity. Your funds are safe; try again later.', trippedNow: true };
  }
  return { allowed: true };
}

/** Checks the rules for one request and records it in the audit log; returns the audit row id */
export async function checkAndRecord(userId: string, op: MoneyOutOp, destination: string | null): Promise<PolicyDecision & { auditId?: number }> {
  const db = await getDb();
  const counts = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE user_id = $1::uuid AND created_at > NOW() - INTERVAL '1 hour' AND decision = 'allowed') AS user_hour,
       COUNT(*) FILTER (WHERE created_at > NOW() - make_interval(mins => $2::int) AND decision = 'allowed') AS global_window
     FROM signer_audit
     WHERE created_at > NOW() - GREATEST(INTERVAL '1 hour', make_interval(mins => $2::int))`,
    [userId, POLICY.globalWindowMinutes()]
  );
  const decision = decide({
    paused: process.env.SIGNER_PAUSED === 'true',
    breakerTripped: tripped !== null,
    userCountLastHour: Number(counts.rows[0]?.user_hour || 0),
    globalCountInWindow: Number(counts.rows[0]?.global_window || 0),
  });
  if (decision.trippedNow) tripped = { at: Date.now(), reason: `${POLICY.globalMaxInWindow()} withdrawals within ${POLICY.globalWindowMinutes()} minutes` };

  const row = await db.query(
    `INSERT INTO signer_audit (user_id, op, destination, decision, status, reason)
     VALUES ($1::uuid, $2::text, $3::text, $4::text, $5::text, $6::text)
     RETURNING id`,
    [userId, op, destination, decision.allowed ? 'allowed' : 'refused', decision.allowed ? 'pending' : 'refused', decision.reason ?? null]
  );
  return { ...decision, auditId: Number(row.rows[0]?.id) };
}

/** Records how an allowed request ended */
export async function finishAudit(auditId: number | undefined, status: 'done' | 'failed', detail: { txHash?: string; reason?: string }): Promise<void> {
  if (!auditId) return;
  const db = await getDb();
  await db.query(
    `UPDATE signer_audit SET status = $2::text, tx_hash = $3::text, reason = COALESCE($4::text, reason), finished_at = NOW() WHERE id = $1`,
    [auditId, status, detail.txHash ?? null, detail.reason ?? null]
  ).catch(() => undefined);
}
