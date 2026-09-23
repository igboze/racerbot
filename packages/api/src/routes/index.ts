import { Router } from 'express';
import { getTokenInfo, publishSwap } from '../wallet.js';
import { 
  getOpenPositions, 
  getFillsByPosition, 
  createTrigger, 
  getUserByTelegramId, 
  createUser, 
  updateUserScopedKey 
} from '@racerbot/db';
import { sellAtTarget } from '../sellHelper.js';
import { computePnL, getNear, encrypt } from '@racerbot/shared';
import { KeyPair } from 'near-api-js';
import { validateTelegramInitData } from '../middleware.js';
import { 
  ROUTER_CONTRACT_ID, 
  RACERBOT_PARENT_ACCOUNT, 
  MAIN_WALLET_PRIVATE_KEY, 
  MASTER_KEY 
} from '../config.js';

const router = Router();

// ── Health & Config ───────────────────────────────────────────────────────────

router.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: Date.now() });
});

router.get('/config', (_req, res) => {
  res.json({
    routerContractId: ROUTER_CONTRACT_ID,
    parentAccount: RACERBOT_PARENT_ACCOUNT,
  });
});

// ── Non-Custodial Onboarding ──────────────────────────────────────────────────

router.post('/onboard', async (req, res) => {
  try {
    const authHeader = req.headers.authorization ?? '';
    const initData = authHeader.startsWith('tma ') ? authHeader.slice(4) : '';
    const validation = validateTelegramInitData(initData);
    
    const telegramId = validation.userId ?? req.body.telegramId;
    if (!telegramId) {
      res.status(401).json({ error: 'Unauthorized: valid Telegram initData required' });
      return;
    }

    const { publicKey } = req.body;
    if (!publicKey) {
      res.status(400).json({ error: 'publicKey required' });
      return;
    }

    // Idempotency check: return 409 if user already exists
    const existing = await getUserByTelegramId(telegramId).catch(() => null);
    if (existing) {
      res.status(409).json({ error: 'User already exists', subaccountId: existing.subaccount_id });
      return;
    }

    const subaccountId = `${telegramId}.${RACERBOT_PARENT_ACCOUNT}`;
    const near = getNear();

    // Create subaccount on NEAR using parent account full-access key
    if (MAIN_WALLET_PRIVATE_KEY) {
      const parentKeyPair = KeyPair.fromString(MAIN_WALLET_PRIVATE_KEY as any);
      await near.addKey(RACERBOT_PARENT_ACCOUNT, parentKeyPair);
      await near.createSubaccount(RACERBOT_PARENT_ACCOUNT, subaccountId, publicKey, '0.05');
    }

    // Insert user record in DB only after on-chain creation succeeds
    await createUser({
      telegram_id: telegramId,
      subaccount_id: subaccountId,
      scoped_key_encrypted: '',
    });

    res.json({ success: true, subaccountId });
  } catch (err: any) {
    console.error('[API] /onboard error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/onboard/scoped-key', async (req, res) => {
  try {
    const authHeader = req.headers.authorization ?? '';
    const initData = authHeader.startsWith('tma ') ? authHeader.slice(4) : '';
    const validation = validateTelegramInitData(initData);

    const telegramId = validation.userId ?? req.body.telegramId;
    if (!telegramId) {
      res.status(401).json({ error: 'Unauthorized: valid Telegram initData required' });
      return;
    }

    const { subaccountId, publicKey, secretKey } = req.body;
    if (!subaccountId || !publicKey || !secretKey) {
      res.status(400).json({ error: 'subaccountId, publicKey, secretKey required' });
      return;
    }

    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) {
      res.status(404).json({ error: 'User not found. Complete /onboard first' });
      return;
    }

    // Guard against overwriting existing key (409)
    if (user.scoped_key_encrypted && user.scoped_key_encrypted.length > 0) {
      res.status(409).json({ error: 'Scoped key already registered' });
      return;
    }

    // Validate on-chain that this key is a FunctionCall scoped key restricted to ROUTER_CONTRACT_ID
    const near = getNear();
    try {
      const accessKey = await near.viewAccessKey(subaccountId, publicKey);
      if (!accessKey || accessKey.permission === 'FullAccess') {
        res.status(400).json({ error: 'Key must not be full-access; must be FunctionCall scoped' });
        return;
      }
      const fn = accessKey.permission.FunctionCall;
      if (!fn || fn.receiver_id !== ROUTER_CONTRACT_ID) {
        res.status(400).json({ error: `Key must be scoped to ${ROUTER_CONTRACT_ID}` });
        return;
      }
    } catch (err: any) {
      console.warn('[API] viewAccessKey warning:', err.message);
    }

    const encryptedKey = encrypt(secretKey, MASTER_KEY);
    await updateUserScopedKey(user.id, encryptedKey);

    // Warm key in executor immediately without restarting if available
    try {
      // @ts-ignore
      const executorMod = await import('@racerbot/executor').catch(() => null);
      if (executorMod?.addUserKey) {
        await executorMod.addUserKey(user.id, subaccountId, encryptedKey);
      }
    } catch (err: any) {
      console.warn('[API] Could not warm key in executor directly:', err.message);
    }

    res.json({ success: true, subaccountId });
  } catch (err: any) {
    console.error('[API] /onboard/scoped-key error:', err.message);
    res.status(500).json({ error: err.message });
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
    let finalMinOut = minAmountOut;
    if (!finalMinOut) {
      const near = (await import('@racerbot/shared')).getNear();
      const { getUserById, getTokenCache } = await import('@racerbot/db');
      const user = await getUserById(userId).catch(() => null);
      const slippagePct = user?.slippage_pct ? Number(user.slippage_pct) : 2.0;
      const targetToken = tokenIn === 'wrap.near' ? tokenOut : tokenIn;
      const cached = await getTokenCache(targetToken).catch(() => null);
      const selectedVenue = venue ?? (cached?.venue as 'rhea' | 'shardsmarket' | 'nearlytrade' | undefined);
      if (!selectedVenue) {
        res.status(400).json({ error: 'Could not determine venue for token' });
        return;
      }
      const computed = await near.computeMinAmountOut(
        selectedVenue,
        tokenIn,
        tokenOut,
        amountIn,
        slippagePct,
        cached?.rhea_pool_id,
        cached?.dcl_pool_id ?? undefined
      );
      finalMinOut = computed.minAmountOut;
    }

    const { getTokenCache } = await import('@racerbot/db');
    const targetToken = tokenIn === 'wrap.near' ? tokenOut : tokenIn;
    const cachedRow = await getTokenCache(targetToken).catch(() => null);
    const resolvedVenue = venue ?? (cachedRow?.venue as 'rhea' | 'shardsmarket' | 'nearlytrade' | undefined);
    if (!resolvedVenue) {
      res.status(400).json({ error: 'Could not determine venue for token' });
      return;
    }

    await publishSwap({
      user_id: userId,
      token_in: tokenIn,
      token_out: tokenOut,
      amount_in: amountIn,
      min_amount_out: finalMinOut,
      venue: resolvedVenue,
      dcl_pool_id: cachedRow?.dcl_pool_id ?? undefined,
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