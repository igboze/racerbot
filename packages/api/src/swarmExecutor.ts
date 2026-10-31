/**
 * Swarm Executor: Coordinates real-time dispatching of autonomous multi-agent
 * drone tranches, monitors pool depth/slippage, and reconciles balances.
 */

import { createLogger } from '@racerbot/shared';
import {
  getAiSwarmSessionById,
  updateAiSwarmSession,
  getUserById,
  type AiSwarmSessionRecord,
} from '@racerbot/db';
import { executeBuyHelper } from './routes.js';

const logger = createLogger('swarm-executor');

// In-memory active swarm session timers
const activeSwarmTimers = new Map<string, NodeJS.Timeout[]>();

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

/**
 * Launches an approved swarm session.
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
  const tranches = plan.tranches || [];
  if (tranches.length === 0) {
    throw new Error('Swarm plan contains no execution tranches');
  }

  // Update status to executing
  await updateAiSwarmSession(sessionId, {
    status: 'executing',
    execution_state: {
      completed_tranches: 0,
      total_tranches: tranches.length,
      filled_amount_near: 0,
      tokens_acquired: '0',
      tranche_status: tranches.map((t: any) => ({ ...t, status: 'pending' })),
    },
  });

  const timers: NodeJS.Timeout[] = [];
  activeSwarmTimers.set(sessionId, timers);

  // Dispatch tranches asynchronously
  for (let i = 0; i < tranches.length; i++) {
    const tranche = tranches[i];
    const delayMs = (tranche.delaySec || 0) * 1000;

    const timer = setTimeout(async () => {
      try {
        await executeTranche(sessionId, user.id || user.telegram_id, tranche, i);
      } catch (err: any) {
        logger.error(`Error executing drone tranche ${i} in swarm ${sessionId}:`, err);
      }
    }, delayMs);

    timers.push(timer);
  }

  return true;
}

/**
 * Executes an individual drone tranche with live state updates.
 */
async function executeTranche(
  sessionId: string,
  userIdentifier: string | number,
  tranche: any,
  trancheIndex: number
): Promise<void> {
  const session = await getAiSwarmSessionById(sessionId);
  if (!session || session.status !== 'executing') {
    return; // Swarm was paused, aborted or completed
  }

  const state = session.execution_state || {};
  const tranches = state.tranche_status || session.plan_json?.tranches || [];

  // Update this tranche to dispatching
  if (tranches[trancheIndex]) {
    tranches[trancheIndex].status = 'dispatching';
    await updateAiSwarmSession(sessionId, { execution_state: { ...state, tranche_status: tranches } });
  }

  let txHash: string | null = null;
  let filledSuccess = false;
  let errorReason: string | null = null;
  let tokenQtyAcquired = '0';
  let createdPositionId: string | null = null;

  try {
    // Execute trade through Racer's execution engine
    // In stealth mode, trade is isolated without exposing master account
    const tradeRes = await executeBuyHelper(userIdentifier, session.token_address, tranche.amountNear);

    if (tradeRes?.success) {
      filledSuccess = true;
      txHash = tradeRes.txHash || null;
      tokenQtyAcquired = tradeRes.tokenQty || '0';
      createdPositionId = tradeRes.positionId || null;

      // Auto-attach conditional exit trigger (e.g. Market Cap or TP/SL) if requested in the AI plan
      const plan = session.plan_json || {};
      const exitTrigger = plan.exitTrigger || plan.exit_trigger;
      if (exitTrigger && createdPositionId) {
        try {
          const { createTrigger } = await import('@racerbot/db');
          await createTrigger({
            user_id: session.user_id,
            position_id: createdPositionId,
            type: exitTrigger.type || 'market_cap',
            target_value: exitTrigger.targetValue,
            sell_pct: exitTrigger.sellPct || 100,
          });
          logger.info(`Auto-registered exit trigger (${exitTrigger.type}: ${exitTrigger.targetValue}) for swarm position ${createdPositionId}`);
        } catch (trigErr: any) {
          logger.warn(`Failed to auto-register exit trigger for position ${createdPositionId}:`, trigErr?.message || trigErr);
        }
      }
    } else {
      errorReason = tradeRes?.message || 'Swap did not complete';
    }
  } catch (err: any) {
    errorReason = err?.message || 'Transaction failed on-chain';
    logger.warn(`Tranche ${trancheIndex} failed for ${session.token_address}: ${errorReason}`);
  }

  // Update status after execution
  const updatedSession = await getAiSwarmSessionById(sessionId);
  if (!updatedSession) return;

  const curState = updatedSession.execution_state || {};
  const curTranches = curState.tranche_status || [];

  if (curTranches[trancheIndex]) {
    curTranches[trancheIndex].status = filledSuccess ? 'filled' : 'failed';
    curTranches[trancheIndex].txHash = txHash;
    if (errorReason) curTranches[trancheIndex].error = errorReason;
  }

  const completed = (curState.completed_tranches || 0) + 1;
  const filledAmt = (parseFloat(curState.filled_amount_near || '0') + (filledSuccess ? tranche.amountNear : 0));
  const isFinished = completed >= curTranches.length;

  const nowStr = new Date().toLocaleTimeString('en-US', { hour12: false });
  const logEntry = filledSuccess
    ? {
        time: nowStr,
        status: 'success',
        message: `Drone #${trancheIndex + 1} (${tranche.droneName || 'Drone'}) filled ${tranche.amountNear.toFixed(2)} NEAR on-chain${txHash ? ` [${txHash.slice(0, 10)}...]` : ''}`,
        txHash,
      }
    : {
        time: nowStr,
        status: 'failed',
        message: `Drone #${trancheIndex + 1} (${tranche.droneName || 'Drone'}) failed: ${(errorReason || 'Execution error').slice(0, 70)}`,
      };

  const curLogs = Array.isArray(curState.executionLog) ? [...curState.executionLog, logEntry] : [logEntry];

  await updateAiSwarmSession(sessionId, {
    status: isFinished ? 'completed' : 'executing',
    completed_at: isFinished ? new Date() : null,
    execution_state: {
      ...curState,
      completed_tranches: completed,
      completedDrones: completed,
      filled_amount_near: parseFloat(filledAmt.toFixed(3)),
      tranche_status: curTranches,
      executionLog: curLogs,
    },
  });

  if (isFinished) {
    activeSwarmTimers.delete(sessionId);
    logger.info(`Swarm session ${sessionId} completed: ${completed}/${curTranches.length} tranches executed`);
  }
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
