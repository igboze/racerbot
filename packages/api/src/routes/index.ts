import { Router } from 'express';
import { getTokenInfo, onboardUser, publishSwap } from '../wallet.js';
import { getOpenPositions, getFillsByPosition, createTrigger } from '@racerbot/db';
import { sellAtTarget } from '../sellHelper.js';
import { computePnL } from '@racerbot/shared';

const router = Router();

// ── Health ────────────────────────────────────────────────────────────────────

router.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: Date.now() });
});

// ── Onboarding ────────────────────────────────────────────────────────────────

router.post('/onboard', async (req, res) => {
  const { telegramId } = req.body as { telegramId: number };
  if (!telegramId) {
    res.status(400).json({ error: 'telegramId required' });
    return;
  }
  try {
    const result = await onboardUser(telegramId);
    // WARNING: seedPhrase is returned here once — client must display and discard it
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── Token info ────────────────────────────────────────────────────────────────

router.get('/token/:address', async (req, res) => {
  try {
    const info = await getTokenInfo(req.params.address);
    res.json(info);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Swap ──────────────────────────────────────────────────────────────────────

router.post('/swap', async (req, res) => {
  const { userId, tokenIn, tokenOut, amountIn, minAmountOut, venue } = req.body;
  if (!userId || !tokenIn || !tokenOut || !amountIn) {
    res.status(400).json({ error: 'Missing required fields' });
    return;
  }
  try {
    await publishSwap({
      user_id: userId,
      token_in: tokenIn,
      token_out: tokenOut,
      amount_in: amountIn,
      min_amount_out: minAmountOut ?? '0',
      venue: venue ?? 'shardsmarket',
    });
    res.json({ queued: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Positions ─────────────────────────────────────────────────────────────────

router.get('/positions/:userId', async (req, res) => {
  try {
    const positions = await getOpenPositions(req.params.userId);
    res.json(positions);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Sell ──────────────────────────────────────────────────────────────────────

router.post('/sell', async (req, res) => {
  const { userId, positionId, percentage } = req.body;
  if (!userId || !positionId || !percentage) {
    res.status(400).json({ error: 'userId, positionId, percentage required' });
    return;
  }
  const result = await sellAtTarget(userId, positionId, parseFloat(percentage));
  res.json(result);
});

// ── Triggers ──────────────────────────────────────────────────────────────────

router.post('/triggers', async (req, res) => {
  const { userId, positionId, type, targetValue } = req.body;
  if (!userId || !positionId || !type || !targetValue) {
    res.status(400).json({ error: 'userId, positionId, type, targetValue required' });
    return;
  }
  try {
    const trigger = await createTrigger({ user_id: userId, position_id: positionId, type, target_value: targetValue });
    res.json(trigger);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── PNL ───────────────────────────────────────────────────────────────────────

router.get('/pnl/:userId', async (req, res) => {
  try {
    const db = await (await import('@racerbot/db')).getDb();
    const closedPositions = await db.query(
      'SELECT * FROM positions WHERE user_id = $1 AND status = $2',
      [req.params.userId, 'closed']
    );

    let totalRealizedNear = 0;
    const positionPnls = [];

    for (const pos of closedPositions.rows) {
      const fills = await getFillsByPosition(pos.id).catch(() => []);
      const buys = fills.filter(f => f.side === 'buy');
      const sells = fills.filter(f => f.side === 'sell');

      if (!buys.length || !sells.length) continue;

      const avgEntry = parseFloat(pos.avg_entry_price);
      for (const sell of sells) {
        const sellPrice = parseFloat(sell.price);
        const qty = parseFloat(sell.amount);
        const buyFee = parseFloat(buys[0].fee_paid) / parseFloat(buys[0].amount);
        const sellFee = parseFloat(sell.fee_paid) / qty;

        const pnl = computePnL(avgEntry, sellPrice, qty, buyFee, sellFee);
        totalRealizedNear += pnl.netNear;
        positionPnls.push({ tokenAddress: pos.token_address, ...pnl });
      }
    }

    res.json({ userId: req.params.userId, totalRealizedNear, positions: positionPnls });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;