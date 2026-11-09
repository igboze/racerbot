import { Router, Request, Response } from 'express';
import { createLogger } from '@racerbot/shared';
import {
  getUserByTelegramId,
  getUserById,
  createAiSwarmSession,
  getAiSwarmSessionById,
  listUserAiSwarmSessions,
} from '@racerbot/db';
import { getUserBalances } from '../wallet.js';
import { planSwarmSession } from '../nearAiSwarm.js';
import {
  launchSwarmSession,
  getSwarmSessionStatus,
  pauseSwarmSession,
  abortSwarmSession,
} from '../swarmExecutor.js';
import { verifiedUser } from './verifiedUser.js';
import { isNearTokenAddress, NEAR_ONLY_MESSAGE } from '../nearOnly.js';

const logger = createLogger('swarm-routes');

export function createSwarmRouter(): Router {
  const router = Router();

  /**
   * Cryptographically verified user resolver:
   * Only accepts verified TMA initData or valid server-issued Bearer session tokens.
   * Never accepts unauthenticated spoofable headers or fallbacks to arbitrary users.
   */
  async function resolveUser(req: Request) {
    return await verifiedUser(req);
  }

  /**
   * POST /api/swarm/plan
   * Plans a staggered swarm for the signed-in user to review. Signed-in only:
   * every plan can call the paid NEAR AI model.
   */
  router.post('/plan', async (req: Request, res: Response): Promise<void> => {
    try {
      const user = await resolveUser(req);
      if (!user) {
        res.status(401).json({ success: false, error: 'Sign in to plan a swarm' });
        return;
      }
      const prompt = String(req.body?.prompt || '').slice(0, 500);
      const defaultToken = req.body?.tokenAddress;
      const stealthMode = req.body?.stealthMode !== false;
      const totalNear = Number(req.body?.totalNear);
      if (defaultToken && !isNearTokenAddress(defaultToken)) {
        res.status(400).json({ success: false, error: NEAR_ONLY_MESSAGE });
        return;
      }

      const balances = await getUserBalances(user.telegram_id, false, user).catch(() => null);
      const plan = await planSwarmSession({
        prompt,
        userBalances: balances,
        defaultTokenAddress: defaultToken,
        stealthModeOverride: stealthMode,
        totalNear: Number.isFinite(totalNear) && totalNear > 0 ? totalNear : null,
      });
      // The prompt can name a token too: the plan's token must be a NEAR one before it is saved
      if (!isNearTokenAddress(plan.tokenAddress)) {
        res.status(400).json({ success: false, error: NEAR_ONLY_MESSAGE });
        return;
      }

      const session = await createAiSwarmSession({
        userId: user.id,
        prompt,
        strategyType: plan.strategy,
        tokenAddress: plan.tokenAddress,
        tokenSymbol: plan.tokenSymbol,
        totalAmountNear: plan.totalNear,
        droneCount: plan.droneCount,
        stealthMode: plan.stealthMode,
        planJson: plan,
        teeAttestation: {
          planner: plan.planner,
          teeWrapped: true,
          commandSteps: plan.commandSteps || [],
          exitTriggers: plan.exitTriggers || [],
        },
      });
      const sessionId = session.id;

      res.json({
        success: true,
        sessionId,
        plan,
      });
    } catch (err: any) {
      logger.error('Failed to generate swarm plan:', err);
      res.status(500).json({ success: false, error: err?.message || 'Failed to generate swarm plan' });
    }
  });

  /**
   * POST /api/swarm/launch
   * Executes an approved swarm session.
   */
  router.post('/launch', async (req: Request, res: Response): Promise<void> => {
    try {
      const sessionId = req.body?.sessionId;
      if (!sessionId) {
        res.status(400).json({ success: false, error: 'Missing sessionId' });
        return;
      }

      const user = await resolveUser(req);
      if (!user) {
        res.status(401).json({ success: false, error: 'Unauthorized: Authentication required' });
        return;
      }

      const existingSession = await getAiSwarmSessionById(sessionId);
      if (!existingSession) {
        res.status(404).json({ success: false, error: 'Swarm session not found' });
        return;
      }

      if (existingSession.user_id !== user.id) {
        res.status(403).json({ success: false, error: 'Forbidden: You do not own this swarm session' });
        return;
      }

      await launchSwarmSession(sessionId);
      const status = await getSwarmSessionStatus(sessionId);
      if (!status) {
        res.status(404).json({ success: false, error: 'Swarm session not found' });
        return;
      }

      res.json({
        success: true,
        status,
        session: {
          id: status.sessionId,
          status: status.status,
          completedDrones: status.completedTranches,
          droneCount: status.totalTranches,
          progressPct: status.progressPct,
          filledNear: status.filledNear,
          tokensAcquired: status.tokensAcquired,
          tranches: status.tranches,
          executionLog: status.executionLog,
        },
      });
    } catch (err: any) {
      logger.error('Failed to launch swarm:', err);
      res.status(500).json({ success: false, error: err?.message || 'Failed to launch swarm' });
    }
  });

  /**
   * GET /api/swarm/status/:sessionId
   * Real-time status of swarm drones and tranches.
   */
  router.get('/status/:sessionId', async (req: Request, res: Response): Promise<void> => {
    try {
      const sessionId = req.params.sessionId;
      const user = await resolveUser(req);
      if (!user) {
        res.status(401).json({ success: false, error: 'Unauthorized: Authentication required' });
        return;
      }

      const sessionRec = await getAiSwarmSessionById(sessionId);
      if (!sessionRec) {
        res.status(404).json({ success: false, error: 'Swarm session not found' });
        return;
      }

      if (sessionRec.user_id !== user.id) {
        res.status(403).json({ success: false, error: 'Forbidden: You do not own this swarm session' });
        return;
      }

      const status = await getSwarmSessionStatus(sessionId);
      if (!status) {
        res.status(404).json({ success: false, error: 'Swarm session not found' });
        return;
      }

      res.json({
        success: true,
        status,
        session: {
          id: status.sessionId,
          status: status.status,
          completedDrones: status.completedTranches,
          droneCount: status.totalTranches,
          progressPct: status.progressPct,
          filledNear: status.filledNear,
          tokensAcquired: status.tokensAcquired,
          tranches: status.tranches,
          executionLog: status.executionLog,
        },
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'Failed to fetch status' });
    }
  });

  /**
   * POST /api/swarm/pause
   */
  router.post('/pause', async (req: Request, res: Response): Promise<void> => {
    try {
      const sessionId = req.body?.sessionId;
      if (!sessionId) {
        res.status(400).json({ success: false, error: 'Missing sessionId' });
        return;
      }

      const user = await resolveUser(req);
      if (!user) {
        res.status(401).json({ success: false, error: 'Unauthorized: Authentication required' });
        return;
      }

      const sessionRec = await getAiSwarmSessionById(sessionId);
      if (!sessionRec) {
        res.status(404).json({ success: false, error: 'Swarm session not found' });
        return;
      }

      if (sessionRec.user_id !== user.id) {
        res.status(403).json({ success: false, error: 'Forbidden: You do not own this swarm session' });
        return;
      }

      await pauseSwarmSession(sessionId);
      res.json({ success: true, message: 'Swarm paused' });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'Failed to pause swarm' });
    }
  });

  /**
   * POST /api/swarm/abort
   */
  router.post('/abort', async (req: Request, res: Response): Promise<void> => {
    try {
      const sessionId = req.body?.sessionId;
      if (!sessionId) {
        res.status(400).json({ success: false, error: 'Missing sessionId' });
        return;
      }

      const user = await resolveUser(req);
      if (!user) {
        res.status(401).json({ success: false, error: 'Unauthorized: Authentication required' });
        return;
      }

      const sessionRec = await getAiSwarmSessionById(sessionId);
      if (!sessionRec) {
        res.status(404).json({ success: false, error: 'Swarm session not found' });
        return;
      }

      if (sessionRec.user_id !== user.id) {
        res.status(403).json({ success: false, error: 'Forbidden: You do not own this swarm session' });
        return;
      }

      await abortSwarmSession(sessionId);
      res.json({ success: true, message: 'Swarm aborted' });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'Failed to abort swarm' });
    }
  });

  /**
   * GET /api/swarm/sessions
   */
  router.get('/sessions', async (req: Request, res: Response): Promise<void> => {
    try {
      const user = await resolveUser(req);
      if (!user) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }
      const sessions = await listUserAiSwarmSessions(user.id);
      res.json({ success: true, sessions });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'Failed to fetch sessions' });
    }
  });

  return router;
}
