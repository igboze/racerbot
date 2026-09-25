import { Router } from 'express';
import { getTokenInfo, publishSwap } from '../wallet.js';
import {
  getOpenPositions,
  getFillsByPosition,
  createTrigger,
  getUserByTelegramId,
  createUser,
  updateUserScopedKey,
  getPositionById,
  getUserById,
  getTokenCache,
  getDb,
} from '@racerbot/db';
import { sellAtTarget } from '../sellHelper.js';
import { computePnL, getNear, encrypt, isTradableVenue, createLogger } from '@racerbot/shared';
import { KeyPair } from 'near-api-js';
import {
  ensureTelegramInitData,
  ensureTelegramUser,
  isValidAccountId,
  perUserRateLimit,
} from '../middleware.js';
import {
  ROUTER_CONTRACT_ID,
  RACERBOT_PARENT_ACCOUNT,
  MAIN_WALLET_PRIVATE_KEY,
  MASTER_KEY
} from '../config.js';

const logger = createLogger('api-routes');

const router = Router();

// ── Health & Config (public — used by Docker HEALTHCHECK / dashboards) ───────

router.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: Date.now() });
});

router.get('/config', (_req, res) => {
  res.json({
    routerContractId: ROUTER_CONTRACT_ID,
    parentAccount: RACERBOT_PARENT_ACCOUNT,
  });
});

// ── Onboarding (Telegram initData proof of identity) ─────────────────────────

router.post('/onboard', ensureTelegramInitData, async (req, res) => {
  try {
    const initData = (req as any).telegramInitData;
    const userId = (req as any).userId;
    const username = initData?.user?.username;

    const { onboardUser } = await import('../wallet.js');
    const result = await onboardUser(userId, undefined, username);

    res.json({ success: true, ...result });
  } catch (err: any) {
    logger.error('Onboarding failed', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Trading (swaps via executor) ─────────────────────────────────────────────

router.post('/swap', ensureTelegramUser, perUserRateLimit(60000, 30), async (req, res) => {
  try {
    const userId = (req as any).userId;
    const tokenAddress = req.body.tokenAddress;
    const amountNear = req.body.amountNear;
    const slippagePct = req.body.slippagePct;

    if (!tokenAddress || !amountNear) {
      res.status(400).json({ error: 'Missing required fields: tokenAddress, amountNear' });
      return;
    }

    // Convert amountNear to yoctoNEAR
    const amountYocto = (BigInt(Math.floor(amountNear * 1e6)) * 1000000000000000000n).toString();
    
    const result = await publishSwap({
      user_id: userId,
      token_in: 'near',
      token_out: tokenAddress,
      amount_in: amountYocto,
      min_amount_out: '0',
      venue: 'rhea',
    });
    res.json({ success: true, ...result });
  } catch (err: any) {
    logger.error('Swap failed', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Sell (percentage-based via executor) ─────────────────────────────────────

router.post('/sell', ensureTelegramUser, perUserRateLimit(60000, 30), async (req, res) => {
  try {
    const userId = (req as any).userId;
    const positionId = req.body.positionId;
    const percentage = req.body.percentage;

    if (!positionId || !percentage) {
      res.status(400).json({ error: 'Missing required fields: positionId, percentage' });
      return;
    }

    const result = await sellAtTarget(userId, positionId, percentage);
    res.json(result);
  } catch (err: any) {
    logger.error('Sell failed', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Token Info (cached) ─────────────────────────────────────────────────────

router.get('/token/:address', async (req, res) => {
  try {
    const info = await getTokenInfo(req.params.address);
    res.json({ success: true, info });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Triggers (create, list, delete) ─────────────────────────────────────────

router.post('/triggers', ensureTelegramUser, perUserRateLimit(60000, 10), async (req, res) => {
  try {
    const userId = (req as any).userId;
    const positionId = req.body.positionId;
    const type = req.body.type;
    const targetValue = req.body.targetValue;

    if (!positionId || !type || targetValue === undefined) {
      res.status(400).json({ error: 'Missing required fields' });
      return;
    }

    const trigger = await createTrigger({ user_id: userId, position_id: positionId, type, target_value: targetValue });
    logger.info('Trigger created', { userId, positionId, type, targetValue });
    res.json(trigger);
  } catch (err: any) {
    logger.error('Trigger creation failed', err);
    res.status(500).json({ error: 'Failed to create trigger' });
  }
});

export default router;