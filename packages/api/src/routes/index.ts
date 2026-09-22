import 'dotenv/config';
import { Router } from 'express';
import { onboardUser, getTokenInfo, executeSwap, autoBuySwap } from './wallet.js';
import { getOpenPositions, getFillsByPosition } from './queries.js';

const router = Router();

router.post('/onboard', async (req, res) => {
  const { telegramId } = req.body;
  const result = await onboardUser(telegramId);
  res.json(result);
});

router.get('/token/:address', async (req, res) => {
  const info = await getTokenInfo(req.params.address);
  res.json(info);
});

router.post('/swap', async (req, res) => {
  const result = await executeSwap(req.body);
  res.json(result);
});

router.post('/auto-buy', async (req, res) => {
  const { userId, tokenAddress, amount } = req.body;
  const result = await autoBuySwap(userId, tokenAddress, amount);
  res.json(result);
});

router.get('/positions/:userId', async (req, res) => {
  const positions = await getOpenPositions(req.params.userId);
  res.json(positions);
});

export default router;