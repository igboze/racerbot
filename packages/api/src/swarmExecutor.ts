/**
 * Swarm executor: runs an approved swarm plan's tranches on their schedule.
 *
 * Buy plans buy and sell plans sell, from the user's RacerBot wallet (or the
 * confidential executors when those are switched on). Resuming a paused swarm
 * runs only the tranches that have not run, and progress updates for a
 * session are applied one at a time so tranches never overwrite each other.
 */

import { createLogger } from '@racerbot/shared';
import {
  getAiSwarmSessionById,
  getOpenPositions,
  listAiSwarmSessionsByStatus,
  updateAiSwarmSession,
  getUserById,
  type AiSwarmSessionRecord,
} from '@racerbot/db';
import { executeBuyHelper } from './routes.js';
import { sellAtTarget } from './sellHelper.js';

const logger = createLogger('swarm-executor');

// In-memory active swarm session timers
const activeSwarmTimers = new Map<string, NodeJS.Timeout[]>();

/**
 * Per-user queue: every tranche signs with the same wallet key, so two running at once would collide on
 * the nonce. A tranche whose time comes while another of the user's tranches is running waits for it.
 */
const userTradeLocks = new Map<string, Promise<unknown>>();
function withUserTradeLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = userTradeLocks.get(userId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const settled = next.catch(() => undefined);
  userTradeLocks.set(userId, settled);
  void settled.then(() => { if (userTradeLocks.get(userId) === settled) userTradeLocks.delete(userId); });
  return next;
}

/** Per-session queue: read-modify-write of execution_state happens one at a time. */
const sessionLocks = new Map<string, Promise<unknown>>();
function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = sessionLocks.get(sessionId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const settled = next.catch(() => undefined);
  sessionLocks.set(sessionId, settled);
  void settled.then(() => { if (sessionLocks.get(sessionId) === settled) sessionLocks.delete(sessionId); });
  return next;
}

export interface SwarmExecutionStatus {
  sessionId: string;
  status: AiSwarmSessionRecord['status'];
  completedTranches: number;
  totalTranches: number;
  progressPct: number;
  filledNear: number;
  tokensAcquired: string;
  activeDrones: number;
  tranches: any[];
  executionLog: any[];
}

/**
 * Gets real-time status of a swarm session.
 */
export async function getSwarmSessionStatus(sessionId: string): Promise<SwarmExecutionStatus | null> {
  const session = await getAiSwarmSessionById(sessionId);
  if (!session) return null;

  const plan = session.plan_json || {};
  const state = session.execution_state || {};
  const tranches = state.tranche_status || plan.tranches || [];
  const completed = state.completed_tranches ?? state.completedDrones ?? 0;
  const total = tranches.length || plan.drone_count || 1;
  const progressPct = Math.min(100, Math.round((completed / total) * 100));

  return {
    sessionId: session.id,
    status: session.status,
    completedTranches: completed,
    totalTranches: total,
    progressPct,
    filledNear: parseFloat(state.filled_amount_near || '0'),
    tokensAcquired: state.tokens_acquired || '0',
    activeDrones: session.status === 'executing' ? Math.max(0, total - completed) : 0,
    tranches,
    executionLog: Array.isArray(state.executionLog) ? state.executionLog : [],
  };
}

const DONE = new Set(['filled', 'failed']);

/**
 * Launches an approved swarm, or resumes a paused one. On resume, filled and
 * failed tranches are kept as they are and only the rest are scheduled, with
 * their original spacing counted from now.
 */
export async function launchSwarmSession(sessionId: string): Promise<boolean> {
  const session = await getAiSwarmSessionById(sessionId);
  if (!session) {
    throw new Error('Swarm session not found');
  }

  if (session.status !== 'review' && session.status !== 'paused' && session.status !== 'created') {
    throw new Error(`Cannot launch swarm in status '${session.status}'`);
  }

  const user = await getUserById(session.user_id);
  if (!user) {
    throw new Error('User not found');
  }

  const plan = session.plan_json || {};
  const planTranches: any[] = plan.tranches || [];
  if (planTranches.length === 0) {
    throw new Error('Swarm plan contains no execution tranches');
  }

  const resuming = session.status === 'paused' && Array.isArray(session.execution_state?.tranche_status);
  const prevState = session.execution_state || {};
  const trancheStatus: any[] = resuming
    ? prevState.tranche_status.map((t: any) => (DONE.has(t.status) ? t : { ...t, status: 'pending' }))
    : planTranches.map((t: any) => ({ ...t, status: 'pending' }));
  const todo = trancheStatus.map((t, i) => ({ t, i })).filter(({ t }) => !DONE.has(t.status));
  if (todo.length === 0) {
    await updateAiSwarmSession(sessionId, { status: 'completed', completed_at: new Date() });
    return true;
  }

  await updateAiSwarmSession(sessionId, {
    status: 'executing',
    execution_state: resuming
      ? { ...prevState, tranche_status: trancheStatus }
      : {
        completed_tranches: 0,
        total_tranches: trancheStatus.length,
        filled_amount_near: 0,
        tokens_acquired: '0',
        tranche_status: trancheStatus,
        triggered_positions: [],
      },
  });

  const timers: NodeJS.Timeout[] = [];
  activeSwarmTimers.set(sessionId, timers);

  // Keep the plan's spacing, starting the first remaining tranche now
  const firstDelay = todo[0].t.delaySec || 0;
  for (const { t, i } of todo) {
    const delayMs = Math.max(0, ((t.delaySec || 0) - firstDelay) * 1000);
    const timer = setTimeout(() => {
      executeTranche(sessionId, user.id, t, i).catch(err => {
        logger.error(`Error executing tranche ${i} in swarm ${sessionId}:`, err);
      });
    }, delayMs);
    timers.push(timer);
  }

  return true;
}

interface TrancheOutcome {
  ok: boolean;
  txHash: string | null;
  error: string | null;
  nearAmount: number;
  tokenQty: string;
  positionId: string | null;
}

/** Whole thousandths of a NEAR to yoctoNEAR, without float error. */
function nearToYocto(near: number): bigint {
  return BigInt(Math.round(near * 1000)) * 10n ** 21n;
}

async function runBuy(userId: string, session: AiSwarmSessionRecord, tranche: any): Promise<TrancheOutcome> {
  if (tranche.isConfidential) {
    const { EXECUTORS_ENABLED, confidentialBuy } = await import('./executorPool.js');
    const user = await getUserById(userId);
    if (EXECUTORS_ENABLED && user) {
      const res = await confidentialBuy({
        user, tokenAddress: session.token_address, venue: tranche.venue, amountYocto: nearToYocto(Number(tranche.amountNear) || 0),
        slippagePct: tranche.maxSlippagePct,
      });
      if (res.success) {
        const openPos = await getOpenPositions(userId).catch(() => []);
        const matchedPos = openPos.find(p => p.token_address === session.token_address && (p.chain || 'near') === 'near');
        return {
          ok: true, txHash: res.txHashes[0] || null, error: null,
          nearAmount: Number(tranche.amountNear) || 0, tokenQty: '0', positionId: matchedPos?.id || null,
        };
      }
      logger.warn(`Confidential buy failed (${res.reason}); falling back to standard wallet execution`);
    } else {
      logger.warn('Confidential executors unavailable; falling back to standard wallet execution');
    }
  }
  const slippagePct = Number(tranche.maxSlippagePct) > 0 ? Number(tranche.maxSlippagePct) : undefined;
  const res = await executeBuyHelper(userId, session.token_address, tranche.amountNear, undefined, { slippagePct });
  let positionId = res?.positionId || null;
  if (res?.success && !positionId) {
    const openPos = await getOpenPositions(userId).catch(() => []);
    positionId = openPos.find(p => p.token_address === session.token_address && (p.chain || 'near') === 'near')?.id || null;
  }
  return {
    ok: Boolean(res?.success),
    txHash: res?.txHash || null,
    error: res?.success ? null : (res?.message || 'Swap did not complete'),
    nearAmount: res?.success ? Number(tranche.amountNear) || 0 : 0,
    tokenQty: res?.tokenQty || '0',
    positionId,
  };
}

/**
 * A sell tranche sells its share of the position as it was when the swarm
 * started: tranche i of n with share s sells s / (100 − s·i) of what is left.
 */
export function sellPctOfRemaining(sharePct: number, trancheIndex: number): number {
  const left = 100 - sharePct * trancheIndex;
  if (!(sharePct > 0) || left <= 0) return 0;
  return Math.min(100, (sharePct / left) * 100);
}

async function runSell(userId: string, session: AiSwarmSessionRecord, tranche: any, trancheIndex: number): Promise<TrancheOutcome> {
  const empty = { txHash: null, nearAmount: 0, tokenQty: '0', positionId: null };
  const pct = sellPctOfRemaining(Number(tranche.sellPct) || 0, trancheIndex);
  if (!(pct > 0)) return { ok: false, error: 'Nothing left to sell for this tranche', ...empty };
  if (tranche.isConfidential) {
    const { EXECUTORS_ENABLED, confidentialSell } = await import('./executorPool.js');
    const user = await getUserById(userId);
    if (EXECUTORS_ENABLED && user) {
      const res = await confidentialSell({ user, tokenAddress: session.token_address, venue: tranche.venue, percent: pct, slippagePct: tranche.maxSlippagePct });
      if (res.success) {
        return { ok: true, error: null, ...empty, txHash: res.txHashes[0] || null };
      }
      logger.warn(`Confidential sell failed (${res.reason}); falling back to standard wallet execution`);
    } else {
      logger.warn('Confidential executors unavailable; falling back to standard wallet execution');
    }
  }
  const position = (await getOpenPositions(userId))
    .find(p => p.token_address === session.token_address && (p.chain || 'near') === 'near');
  if (!position) return { ok: false, error: 'No open position in this token to sell', ...empty };
  const res = await sellAtTarget(userId, position.id, parseFloat(pct.toFixed(2)), undefined, { slippagePct: tranche.maxSlippagePct });
  return {
    ok: Boolean(res?.success),
    txHash: null,
    error: res?.success ? null : (res?.reason || 'Sell did not complete'),
    nearAmount: res?.success ? Number(res.nearReceived) || 0 : 0,
    tokenQty: '0',
    positionId: position.id,
  };
}

/**
 * Executes one tranche, then records the result and arms all ordered exit triggers.
 */
async function executeTranche(
  sessionId: string,
  userId: string,
  tranche: any,
  trancheIndex: number
): Promise<void> {
  const session = await getAiSwarmSessionById(sessionId);
  if (!session || session.status !== 'executing') {
    return; // Swarm was paused, aborted or completed
  }
  const isSell = session.plan_json?.action === 'sell';

  await withSessionLock(sessionId, async () => {
    const cur = await getAiSwarmSessionById(sessionId);
    const state = cur?.execution_state || {};
    const list = state.tranche_status || [];
    if (list[trancheIndex]) {
      list[trancheIndex].status = 'dispatching';
      await updateAiSwarmSession(sessionId, { execution_state: { ...state, tranche_status: list } });
    }
  });

  let outcome: TrancheOutcome;
  try {
    outcome = await withUserTradeLock(userId, async () => {
      // The swarm may have been paused or aborted while this tranche waited its turn
      const live = await getAiSwarmSessionById(sessionId);
      if (!live || live.status !== 'executing') {
        return { ok: false, txHash: null, error: 'Swarm was paused or stopped before this tranche ran', nearAmount: 0, tokenQty: '0', positionId: null };
      }
      return isSell ? runSell(userId, session, tranche, trancheIndex) : runBuy(userId, session, tranche);
    });
  } catch (err: any) {
    outcome = { ok: false, txHash: null, error: err?.message || 'Transaction failed', nearAmount: 0, tokenQty: '0', positionId: null };
    logger.warn(`Tranche ${trancheIndex} failed for ${session.token_address}: ${outcome.error}`);
  }

  await withSessionLock(sessionId, async () => {
    const updated = await getAiSwarmSessionById(sessionId);
    if (!updated) return;
    const curState = updated.execution_state || {};
    const curTranches = curState.tranche_status || [];

    if (curTranches[trancheIndex]) {
      curTranches[trancheIndex].status = outcome.ok ? 'filled' : 'failed';
      curTranches[trancheIndex].txHash = outcome.txHash;
      if (outcome.error) curTranches[trancheIndex].error = outcome.error;
    }

    // Arm all ordered exit triggers once per position in the exact sequence specified by the user
    const triggered: string[] = Array.isArray(curState.triggered_positions) ? curState.triggered_positions : [];
    const rawTriggerList: any[] = Array.isArray(updated.plan_json?.exitTriggers) && updated.plan_json.exitTriggers.length > 0
      ? updated.plan_json.exitTriggers
      : Array.isArray(updated.plan_json?.exit_triggers) && updated.plan_json.exit_triggers.length > 0
        ? updated.plan_json.exit_triggers
        : (updated.plan_json?.exitTrigger || updated.plan_json?.exit_trigger)
          ? [updated.plan_json?.exitTrigger || updated.plan_json?.exit_trigger]
          : [];

    const orderedTriggers = [...rawTriggerList]
      .filter(Boolean)
      .sort((a, b) => (Number(a?.order) || 0) - (Number(b?.order) || 0));

    const extraLogs: any[] = [];
    const nowStr = new Date().toLocaleTimeString('en-US', { hour12: false });

    if (!isSell && outcome.ok && orderedTriggers.length > 0 && outcome.positionId && !triggered.includes(outcome.positionId)) {
      try {
        const { createTrigger } = await import('@racerbot/db');
        for (let idx = 0; idx < orderedTriggers.length; idx++) {
          const trig = orderedTriggers[idx];
          const targetVal = trig.targetValue ?? trig.target_value;
          const sellPctVal = trig.sellPct ?? trig.sell_pct ?? 100;
          await createTrigger({
            user_id: updated.user_id,
            position_id: outcome.positionId,
            type: trig.type || 'market_cap',
            target_value: targetVal,
            sell_pct: sellPctVal,
          });
          extraLogs.push({
            time: nowStr,
            status: 'success',
            message: `Trigger #${idx + 1} armed: Sell ${sellPctVal}% @ ${trig.targetDisplay || targetVal}`,
          });
        }
        triggered.push(outcome.positionId);
      } catch (trigErr: any) {
        logger.warn(`Failed to add exit trigger(s) for position ${outcome.positionId}:`, trigErr?.message || trigErr);
      }
    }

    const completed = curTranches.filter((t: any) => DONE.has(t.status)).length;
    const filledAmt = parseFloat(curState.filled_amount_near || '0') + outcome.nearAmount;
    const isFinished = completed >= curTranches.length;
    const verb = isSell ? 'sold' : 'filled';
    const logEntry = outcome.ok
      ? {
        time: nowStr,
        status: 'success',
        message: `Tranche ${trancheIndex + 1} ${verb}${isSell ? '' : ` ${Number(tranche.amountNear).toFixed(2)} NEAR`}${outcome.txHash ? ` [${outcome.txHash.slice(0, 10)}…]` : ''}`,
        txHash: outcome.txHash,
      }
      : {
        time: nowStr,
        status: 'failed',
        message: `Tranche ${trancheIndex + 1} failed: ${(outcome.error || 'Execution error').slice(0, 70)}`,
      };
    const prevLogs = Array.isArray(curState.executionLog) ? curState.executionLog : [];
    const curLogs = [...prevLogs, logEntry, ...extraLogs];

    // A swarm paused or aborted meanwhile keeps that status
    const keepStatus = updated.status !== 'executing';
    await updateAiSwarmSession(sessionId, {
      ...(keepStatus ? {} : { status: isFinished ? 'completed' : 'executing', completed_at: isFinished ? new Date() : null }),
      execution_state: {
        ...curState,
        completed_tranches: completed,
        completedDrones: completed,
        filled_amount_near: parseFloat(filledAmt.toFixed(3)),
        tranche_status: curTranches,
        triggered_positions: triggered,
        executionLog: curLogs,
      },
    });

    if (isFinished) {
      activeSwarmTimers.delete(sessionId);
      logger.info(`Swarm session ${sessionId} completed: ${completed}/${curTranches.length} tranches`);
    }
  });
}

/**
 * Pauses an executing swarm session.
 */
export async function pauseSwarmSession(sessionId: string): Promise<boolean> {
  const timers = activeSwarmTimers.get(sessionId);
  if (timers) {
    timers.forEach(t => clearTimeout(t));
    activeSwarmTimers.delete(sessionId);
  }
  await updateAiSwarmSession(sessionId, { status: 'paused' });
  return true;
}

/**
 * Aborts an active or paused swarm session and cancels pending tranches.
 */
export async function abortSwarmSession(sessionId: string): Promise<boolean> {
  const timers = activeSwarmTimers.get(sessionId);
  if (timers) {
    timers.forEach(t => clearTimeout(t));
    activeSwarmTimers.delete(sessionId);
  }
  await updateAiSwarmSession(sessionId, { status: 'aborted' });
  return true;
}

/**
 * After a restart, tranche timers are gone. Swarms that were executing become
 * paused, so the user can resume them (only the tranches that never ran) or
 * abort, instead of being stuck as "executing" forever.
 */
export async function recoverInterruptedSwarms(): Promise<number> {
  const stuck = await listAiSwarmSessionsByStatus('executing');
  for (const s of stuck) {
    const state = s.execution_state || {};
    const list = (state.tranche_status || []).map((t: any) => (t.status === 'dispatching' ? { ...t, status: 'failed', error: 'Interrupted by a restart; check your wallet before resuming' } : t));
    const log = Array.isArray(state.executionLog) ? state.executionLog : [];
    await updateAiSwarmSession(s.id, {
      status: 'paused',
      execution_state: {
        ...state,
        tranche_status: list,
        executionLog: [...log, { time: new Date().toLocaleTimeString('en-US', { hour12: false }), status: 'failed', message: 'Paused: the server restarted. Resume to run the remaining tranches.' }],
      },
    });
  }
  if (stuck.length) logger.warn(`Paused ${stuck.length} swarm session(s) interrupted by a restart`);
  return stuck.length;
}
