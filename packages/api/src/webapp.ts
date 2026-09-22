const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/api/onboard', async (req, res) => {
  const { telegramId } = req.body;
  try {
    const result = await (await import('./wallet.js')).onboardUser(telegramId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/swap', async (req, res) => {
  const { userId, tokenIn, tokenOut, amountIn, minAmountOut, venue } = req.body;
  try {
    await (await import('./executor.js')).executeSwap({
      user_id: userId,
      token_in: tokenIn,
      token_out: tokenOut,
      amount_in: amountIn,
      min_amount_out: minAmountOut,
      venue,
      timestamp: Date.now(),
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/token/:address', async (req, res) => {
  try {
    const info = await (await import('./wallet.js')).getTokenInfo(req.params.address);
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auto-buy', async (req, res) => {
  const { userId, tokenAddress, amount } = req.body;
  try {
    const result = await (await import('./executor.js')).autoBuy(userId, tokenAddress, amount);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/quick-sell', async (req, res) => {
  const { userId, positionId, percentage } = req.body;
  try {
    const result = await (await import('./trigger.js')).sellAtTarget(userId, positionId, percentage);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/positions/:userId', async (req, res) => {
  try {
    const positions = await (await import('./db.js')).getOpenPositions(req.params.userId);
    res.json(positions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/triggers', async (req, res) => {
  const { userId, positionId, type, targetValue } = req.body;
  try {
    await (await import('./db.js')).createTrigger({ user_id: userId, position_id: positionId, type, target_value: targetValue });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/pnl/:userId', async (req, res) => {
  try {
    const user = await (await import('./db.js')).getUserById(req.params.userId);
    // Return PNL summary
    res.json({ userId: req.params.userId, totalPnl: 0, positions: [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[WEBAPP] Server running on port ${PORT}`));

export default app;