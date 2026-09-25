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
import { computePnL, formatHoldDuration, type PnLCard, getNear, encrypt, isTradableVenue, createLogger } from '@racerbot/shared';
import { KeyPair } from 'near-api-js';
import {
  ensureTelegramInitData,
  ensureTelegramUser,
  validateSwapParams,
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

router.post('/swap', ensureTelegramUser, perUserRateLimit(60000, 10), async (req, res) => {
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
    logger.warn('Invalid swap params', { userId, errors: check.errors });
    res.status(400).json({ error: 'Invalid swap params', details: check.errors });
    return;
  }

  try {
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
    const near = getNear();
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
    logger.info('Swap queued', { userId, tokenIn, tokenOut, venue: selectedVenue });
    res.json({ queued: true, venue: selectedVenue, min_amount_out: minAmountOut });
  } catch (err: any) {
    logger.error('Swap failed', err, { userId, tokenIn, tokenOut });
    res.status(500).json({ error: 'Failed to queue swap' });
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

router.post('/sell', ensureTelegramUser, perUserRateLimit(60000, 10), async (req, res) => {
  const userId = (req as any).userId as string;
  const { positionId, percentage } = req.body;
  
  if (!positionId) {
    res.status(400).json({ error: 'positionId is required' });
    return;
  }
  
  if (!percentage) {
    res.status(400).json({ error: 'percentage is required' });
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
    logger.info('Sell executed', { userId, positionId, percentage: pct });
    res.json(result);
  } catch (err: any) {
    logger.error('Sell failed', err, { userId, positionId, percentage: pct });
    res.status(500).json({ error: 'Failed to execute sell' });
  }
});

// ── Triggers ─────────────────────────────────────────────────────────────────

router.post('/triggers', ensureTelegramUser, perUserRateLimit(60000, 5), async (req, res) => {
  const userId = (req as any).userId as string;
  const { positionId, type, targetValue } = req.body;
  
  if (!positionId) {
    res.status(400).json({ error: 'positionId is required' });
    return;
  }
  
  if (!type) {
    res.status(400).json({ error: 'type is required' });
    return;
  }
  
  if (!targetValue) {
    res.status(400).json({ error: 'targetValue is required' });
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
      logger.warn('Unauthorized trigger creation attempt', { userId, positionId });
      res.status(403).json({ error: 'Forbidden: position not found or not yours' });
      return;
    }
    const trigger = await createTrigger({ user_id: userId, position_id: positionId, type, target_value: targetValue });
    logger.info('Trigger created', { userId, positionId, type, targetValue });
    res.json(trigger);
  } catch (err: any) {
    logger.error('Trigger creation failed', err, { userId, positionId, type });
    res.status(500).json({ error: 'Failed to create trigger' });
  }
});

// ── PNL ──────────────────────────────────────────────────────────────────────

export async function buildPnLCardData(positionId: string): Promise<PnLCard | null> {
  const position = await getPositionById(positionId);
  if (!position) return null;

  const [user, tokenInfo, fills] = await Promise.all([
    getUserById(position.user_id).catch(() => null),
    getTokenInfo(position.token_address).catch(() => null),
    getFillsByPosition(positionId).catch(() => []),
  ]);

  let entryPrice = parseFloat(position.avg_entry_price) || 0;
  const isClosed = position.status === 'closed';
  const decimals = tokenInfo?.decimals ?? 24;

  const buys = fills.filter(f => f.side === 'buy');
  const sells = fills.filter(f => f.side === 'sell');

  let currentPrice = tokenInfo && parseFloat(tokenInfo.price) > 0 ? parseFloat(tokenInfo.price) : entryPrice;
  if (isClosed && sells.length > 0) {
    currentPrice = parseFloat(sells[sells.length - 1].price);
  }

  // If entryPrice was missing (0) but currentPrice is known, default entryPrice to currentPrice
  if (entryPrice <= 0 && currentPrice > 0) {
    entryPrice = currentPrice;
  }

  const rawSupply = tokenInfo?.total_supply ? parseFloat(tokenInfo.total_supply) / Math.pow(10, decimals) : 0;
  const currentMcap = tokenInfo?.market_cap ?? (rawSupply > 0 ? currentPrice * rawSupply : undefined);
  const entryMcap = rawSupply > 0 && entryPrice > 0 ? entryPrice * rawSupply : currentMcap;

  let positionSize = 0;
  if (isClosed && sells.length > 0) {
    const totalSoldUnits = sells.reduce((acc, f) => acc + BigInt(f.amount || '0'), 0n);
    positionSize = parseFloat(totalSoldUnits.toString()) / Math.pow(10, decimals);
  } else if (position.quantity_held.includes('.')) {
    positionSize = parseFloat(position.quantity_held);
  } else {
    const heldUnits = BigInt(position.quantity_held.split('.')[0] || '0');
    positionSize = parseFloat(heldUnits.toString()) / Math.pow(10, decimals);
  }

  let profitAmount = 0;
  let pnlPercent = 0;

  if (isClosed && buys.length && sells.length) {
    const lastSell = sells[sells.length - 1];
    const sellPrice = parseFloat(lastSell.price);
    const qty = parseFloat(lastSell.amount);
    const buyFee = parseFloat(buys[0]?.fee_paid ?? '0') / (parseFloat(buys[0]?.amount ?? '1'));
    const sellFee = parseFloat(lastSell.fee_paid) / (qty || 1);
    const pnl = computePnL(entryPrice, sellPrice, qty, buyFee, sellFee);
    profitAmount = pnl.netNear;
    pnlPercent = pnl.pnlPercent;
  } else {
    pnlPercent = entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice) * 100 : 0;
    profitAmount = (currentPrice - entryPrice) * (positionSize || 0);
  }

  const duration = formatHoldDuration(position.opened_at, position.closed_at || Date.now());
  const tokenSymbol = tokenInfo?.symbol ? tokenInfo.symbol.toUpperCase() : position.token_address.slice(0, 8).toUpperCase();
  const dateObj = position.closed_at ? new Date(position.closed_at) : new Date(position.opened_at);
  const date = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const handle = user?.subaccount_id ?? 'racerbot.near';

  const finalPositionSize = positionSize >= 1 ? Number(positionSize.toFixed(2)) : Number(positionSize.toPrecision(4));

  return {
    botName: 'RacerBot',
    tokenSymbol,
    pairSymbol: 'NEAR',
    side: 'long',
    entryPrice,
    currentPrice,
    pnlPercent: Number(pnlPercent.toFixed(1)),
    entryMcap: entryMcap ? Math.round(entryMcap) : undefined,
    currentMcap: currentMcap ? Math.round(currentMcap) : undefined,
    positionSize: finalPositionSize,
    positionUnit: tokenSymbol,
    profitAmount: Number(profitAmount.toFixed(4)),
    profitUnit: 'NEAR',
    duration,
    handle,
    date,
    tokenAddress: position.token_address,
    positionId: position.id,
  };
}

// ── GET /api/pnl/card-data/:positionId — Fetch full card data for a position ──
router.get('/pnl/card-data/:positionId', async (req, res) => {
  try {
    const card = await buildPnLCardData(req.params.positionId);
    if (!card) {
      res.status(404).json({ error: 'Position not found' });
      return;
    }
    res.json({ success: true, card });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/pnl/cards/:userId — Fetch all cards for a user ─────────────────
router.get('/pnl/cards/:userId', async (req, res) => {
  try {
    const [openPositions, db] = await Promise.all([
      getOpenPositions(req.params.userId).catch(() => []),
      getDb(),
    ]);

    const closedResult = await db.query(
      'SELECT id FROM positions WHERE user_id = $1 AND status = $2 ORDER BY closed_at DESC LIMIT 10',
      [req.params.userId, 'closed']
    );

    const positionIds = [
      ...openPositions.map(p => p.id),
      ...closedResult.rows.map(r => r.id),
    ];

    const cardResults = await Promise.allSettled(
      positionIds.map(id => buildPnLCardData(id))
    );

    const cards: PnLCard[] = [];
    for (const r of cardResults) {
      if (r.status === 'fulfilled' && r.value) {
        cards.push(r.value);
      }
    }

    res.json({ success: true, cards });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/pnl/live/:address — Fast real-time price & mcap for cards ────────
router.get('/pnl/live/:address', async (req, res) => {
  try {
    const info = await getTokenInfo(req.params.address);
    res.json({
      success: true,
      price: parseFloat(info.price),
      marketCap: info.market_cap,
      symbol: info.symbol,
      timestamp: Date.now(),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/pnl/:userId', ensureTelegramUser, async (req, res) => {
  try {
    if (req.params.userId !== (req as any).userId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    const db = await getDb();
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
