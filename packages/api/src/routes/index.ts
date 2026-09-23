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
} from '@racerbot/db';
import { sellAtTarget } from '../sellHelper.js';
import { computePnL, getNear, encrypt, isTradableVenue } from '@racerbot/shared';
import { KeyPair } from 'near-api-js';
import {
  ensureTelegramInitData,
  ensureTelegramUser,
  validateSwapParams,
  isValidAccountId,
} from '../middleware.js';
import {
  ROUTER_CONTRACT_ID,
  RACERBOT_PARENT_ACCOUNT,
  MAIN_WALLET_PRIVATE_KEY,
  MASTER_KEY
} from '../config.js';

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
    // Identity comes ONLY from verified initData — never from req.body
    const telegramId = (req as any).telegramUserId as number;

    const { publicKey } = req.body;
    if (typeof publicKey !== 'string' || !/^(ed25519|secp256k1):[A-Za-z0-9+/=_-]+$/.test(publicKey)) {
      res.status(400).json({ error: 'publicKey required (ed25519:<base58>)' });
      return;
    }

    // Fail closed: without the parent key we cannot create the account on-chain,
    // so never create a DB-only ghost user.
    if (!MAIN_WALLET_PRIVATE_KEY) {
      res.status(503).json({ error: 'Onboarding temporarily unavailable (signing key not configured)' });
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

    const parentKeyPair = KeyPair.fromString(MAIN_WALLET_PRIVATE_KEY as any);
    await near.addKey(RACERBOT_PARENT_ACCOUNT, parentKeyPair);
    await near.createSubaccount(RACERBOT_PARENT_ACCOUNT, subaccountId, publicKey, '0.05');

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

router.post('/onboard/scoped-key', ensureTelegramInitData, async (req, res) => {
  try {
    const telegramId = (req as any).telegramUserId as number;

    const { subaccountId, publicKey, secretKey } = req.body;
    if (!subaccountId || !publicKey || !secretKey) {
      res.status(400).json({ error: 'subaccountId, publicKey, secretKey required' });
      return;
    }
    if (typeof subaccountId !== 'string' || !isValidAccountId(subaccountId)) {
      res.status(400).json({ error: 'Invalid subaccountId' });
      return;
    }

    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) {
      res.status(404).json({ error: 'User not found. Complete /onboard first' });
      return;
    }
    if (user.subaccount_id !== subaccountId) {
      res.status(403).json({ error: 'subaccountId does not match your account' });
      return;
    }

    // Guard against overwriting existing key (409)
    if (user.scoped_key_encrypted && user.scoped_key_encrypted.length > 0) {
      res.status(409).json({ error: 'Scoped key already registered' });
      return;
    }

    // The secret must actually derive the claimed public key — reject junk early
    let derivedPublicKey: string;
    try {
      derivedPublicKey = KeyPair.fromString(secretKey as any).getPublicKey().toString();
    } catch {
      res.status(400).json({ error: 'secretKey is not a valid NEAR keypair' });
      return;
    }
    if (derivedPublicKey !== publicKey) {
      res.status(400).json({ error: 'publicKey does not match secretKey' });
      return;
    }

    // Fail closed: verify ON-CHAIN that this key is a FunctionCall key scoped
    // to ROUTER_CONTRACT_ID. Any RPC/validation failure rejects the request —
    // previously this only warned and stored the key anyway.
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
      console.error('[API] viewAccessKey failed (rejecting key):', err.message);
      res.status(502).json({ error: 'Could not verify access key on-chain; try again' });
      return;
    }

    const encryptedKey = encrypt(secretKey, MASTER_KEY);
    await updateUserScopedKey(user.id, encryptedKey);

    // The executor runs as a separate process and loads new scoped keys lazily
    // from the DB on first swap — no cross-process warm needed. Do NOT import
    // @racerbot/executor here: importing it used to boot a SECOND executor
    // inside the API process, double-executing every swap.


    res.json({ success: true, subaccountId });
  } catch (err: any) {
    console.error('[API] /onboard/scoped-key error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Token info (authenticated read) ──────────────────────────────────────────

router.get('/token/:address', ensureTelegramUser, async (req, res) => {
  try {
    if (!isValidAccountId(req.params.address)) {
      res.status(400).json({ error: 'Invalid token address' });
      return;
    }
    const info = await getTokenInfo(req.params.address);
    res.json(info);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Swap ─────────────────────────────────────────────────────────────────────

router.post('/swap', ensureTelegramUser, async (req, res) => {
  // Identity + ownership are server-side; the body can never impersonate.
  const userId = (req as any).userId as string;
  const { tokenIn, tokenOut, amountIn, venue } = req.body;

  const check = validateSwapParams({
    token_in: tokenIn,
    token_out: tokenOut,
    amount_in: amountIn,
    venue,
  });
  if (!check.valid) {
    res.status(400).json({ error: 'Invalid swap params', details: check.errors });
    return;
  }

  try {
    const { getUserById, getTokenCache } = await import('@racerbot/db');
    const user = await getUserById(userId).catch(() => null);
    const slippagePct = user?.slippage_pct ? Number(user.slippage_pct) : 2.0;

    const targetToken = tokenIn === 'wrap.near' || tokenIn === 'near' ? tokenOut : tokenIn;
    const cached = await getTokenCache(targetToken).catch(() => null);

    let selectedVenue = venue ?? cached?.venue;
    if (!isTradableVenue(selectedVenue)) {
      res.status(400).json({ error: 'Could not determine a tradeable venue for token' });
      return;
    }

    // min_amount_out is ALWAYS computed server-side from live pool reserves.
    // Client-supplied min_out was an exploit: anyone could set min_out=1 and
    // grief any account with zero slippage protection.
    const near = (await import('@racerbot/shared')).getNear();
    const { minAmountOut } = await near.computeMinAmountOut(
      selectedVenue,
      tokenIn,
      tokenOut,
      amountIn,
      slippagePct,
      cached?.rhea_pool_id,
      cached?.dcl_pool_id ?? undefined
    );

    await publishSwap({
      user_id: userId,
      token_in: tokenIn,
      token_out: tokenOut,
      amount_in: amountIn,
      min_amount_out: minAmountOut,
      venue: selectedVenue,
      dcl_pool_id: cached?.dcl_pool_id ?? undefined,
    });
    res.json({ queued: true, venue: selectedVenue, min_amount_out: minAmountOut });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Positions ────────────────────────────────────────────────────────────────

router.get('/positions/:userId', ensureTelegramUser, async (req, res) => {
  try {
    if (req.params.userId !== (req as any).userId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    const positions = await getOpenPositions(req.params.userId);
    res.json(positions);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Sell ─────────────────────────────────────────────────────────────────────

router.post('/sell', ensureTelegramUser, async (req, res) => {
  const userId = (req as any).userId as string;
  const { positionId, percentage } = req.body;
  if (!positionId || !percentage) {
    res.status(400).json({ error: 'positionId, percentage required' });
    return;
  }
  const pct = parseFloat(percentage);
  if (isNaN(pct) || pct <= 0 || pct > 100) {
    res.status(400).json({ error: 'percentage must be between 0 and 100' });
    return;
  }
  try {
    // sellAtTarget verifies position.user_id === userId (ownership check)
    const result = await sellAtTarget(userId, positionId, pct);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Triggers ─────────────────────────────────────────────────────────────────

router.post('/triggers', ensureTelegramUser, async (req, res) => {
  const userId = (req as any).userId as string;
  const { positionId, type, targetValue } = req.body;
  if (!positionId || !type || !targetValue) {
    res.status(400).json({ error: 'positionId, type, targetValue required' });
    return;
  }
  if (!['stop_loss', 'take_profit', 'market_cap'].includes(type)) {
    res.status(400).json({ error: 'Invalid trigger type' });
    return;
  }
  if (parseFloat(targetValue) <= 0) {
    res.status(400).json({ error: 'targetValue must be positive' });
    return;
  }
  try {
    // Ownership check: you may only trigger sells on your own positions
    const position = await getPositionById(positionId);
    if (!position || position.user_id !== userId) {
      res.status(403).json({ error: 'Forbidden: position not found or not yours' });
      return;
    }
    const trigger = await createTrigger({ user_id: userId, position_id: positionId, type, target_value: targetValue });
    res.json(trigger);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── PNL ──────────────────────────────────────────────────────────────────────

router.get('/pnl/:userId', ensureTelegramUser, async (req, res) => {
  try {
    if (req.params.userId !== (req as any).userId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
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
