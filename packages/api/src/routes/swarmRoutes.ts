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

const logger = createLogger('swarm-routes');

export function createSwarmRouter(): Router {
  const router = Router();

  /**
   * Helper to resolve user from auth header, token, or body
   */
  async function resolveUser(req: Request) {
    if ((req as any).userId) {
      const u = await getUserById((req as any).userId);
      if (u) return u;
    }

    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace(/^Bearer\s+/, '') || (req.query?.token as string) || req.body?.authToken;
    if (token) {
      try {
        const { verifyAuthToken } = await import('../authSession.js');
        const sess = await verifyAuthToken(token);
        if (sess?.userId) {
          const u = await getUserById(sess.userId);
          if (u) return u;
        }
      } catch {}
    }

    const telegramId = req.headers['x-telegram-id']
      ? parseInt(req.headers['x-telegram-id'] as string, 10)
      : (req.body?.telegramId ? parseInt(req.body.telegramId, 10) : Number(req.query?.telegramId) || null);

    if (telegramId && !isNaN(telegramId)) {
      const u = await getUserByTelegramId(telegramId);
      if (u) return u;
    }
    const userId = (req.headers['x-user-id'] as string) || req.body?.userId;
    if (userId) {
      const u = await getUserById(userId);
      if (u) return u;
    }

    const username = (req.body?.username as string) || (req.query?.username as string);
    const { getDb } = await import('@racerbot/db');
    const db = await getDb().catch(() => null);
    if (db && username) {
      const cleanUser = username.replace(/^@/, '');
      const res = await db.query('SELECT * FROM users WHERE username = $1 OR subaccount_id = $1 LIMIT 1', [cleanUser]);
      if (res.rows[0]) return res.rows[0];
    }

    // Fallback in demo/dev mode: get first active user or latest user
    if (db) {
      const res = await db.query('SELECT * FROM users ORDER BY updated_at DESC LIMIT 1');
      if (res.rows[0]) return res.rows[0];
    }
    return null;
  }

  /**
   * POST /api/swarm/plan
   * Decomposes user prompt into a multi-drone execution plan via NEAR AI TEE Cloud.
   */
  router.post('/plan', async (req: Request, res: Response): Promise<void> => {
    try {
      const user = await resolveUser(req);
      const prompt = req.body?.prompt || 'Accumulate 10 NEAR of HOOT with 3 stealth drones';
      const defaultToken = req.body?.tokenAddress;
      const stealthMode = req.body?.stealthMode !== false;

      const balances = user ? await getUserBalances(user.telegram_id).catch(() => null) : null;
      const plan = await planSwarmSession({
        prompt,
        userBalances: balances,
        defaultTokenAddress: defaultToken,
        stealthModeOverride: stealthMode,
      });

      let sessionId: string | null = null;
      if (user) {
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
          teeAttestation: plan.teeEnclave,
        });
        sessionId = session.id;
      }

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

      await launchSwarmSession(sessionId);
      const status = await getSwarmSessionStatus(sessionId);

      res.json({
        success: true,
        status,
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
      const status = await getSwarmSessionStatus(sessionId);
      if (!status) {
        res.status(404).json({ success: false, error: 'Swarm session not found' });
        return;
      }

      res.json({
        success: true,
        status,
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
