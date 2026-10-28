import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import zlib from 'zlib';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { getTokenInfo, publishSwap, fetchTokenHoldersCount, getNearUsdPrice } from '../wallet.js';
import {
  createTrigger,
  getCompetition,
  getCompetitionByToken,
  upsertCompetition,
  getCompetitionLeaderboard,
} from '@racerbot/db';
import { sellAtTarget } from '../sellHelper.js';
import { createLogger, formatTokenUnits } from '@racerbot/shared';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import {
  ensureTelegramInitData,
  ensureTelegramUser,
  perUserRateLimit,
} from '../middleware.js';
import {
  ROUTER_CONTRACT_ID,
  RACERBOT_PARENT_ACCOUNT,
  TREASURY_ACCOUNT_ID,
} from '../config.js';
import { executeShieldedVaultIntent } from '../racerVault.js';

const logger = createLogger('api-routes');

const router = Router();

// ── Health & Config (public — used by Docker HEALTHCHECK / dashboards) ───────

router.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: Date.now() });
});

// ── WebApp <-> Telegram Auth Session & Wallet Selector Bridge ───────────────

// 1. Create a pairing session for the WebApp
router.post('/auth/session/create', async (_req, res) => {
  try {
    const { createAuthSession } = await import('../authSession.js');
    const session = await createAuthSession();
    res.json({ success: true, ...session });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to create auth session' });
  }
});

// 2. Poll session status
router.get('/auth/session/:sessionId', async (req, res) => {
  try {
    const { getAuthSession } = await import('../authSession.js');
    const session = await getAuthSession(req.params.sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found or expired' });
      return;
    }
    res.json({ success: true, session });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to check session' });
  }
});

// 2b. Request Telegram Username Verification (Safety measure against identity/wallet hijacking)
router.post('/auth/telegram/request-verification', async (req, res) => {
  try {
    const { username } = req.body;
    const { requestTelegramVerification } = await import('../authSession.js');
    const result = await requestTelegramVerification(username);
    if (!result.success) {
      res.status(400).json({ error: result.reason });
      return;
    }
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Verification request failed' });
  }
});

// 2c. Verify 6-digit code entered on WebApp
router.post('/auth/telegram/verify-code', async (req, res) => {
  try {
    const { requestId, code } = req.body;
    if (!requestId || !code) {
      res.status(400).json({ error: 'requestId and code are required' });
      return;
    }
    const { verifyTelegramCode } = await import('../authSession.js');
    const result = await verifyTelegramCode(requestId, code);
    if (!result.success) {
      res.status(400).json({ error: result.reason });
      return;
    }
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Code verification failed' });
  }
});

// 2d. Poll verification status (WebApp polls while user checks Telegram DM)
router.get('/auth/telegram/status/:requestId', async (req, res) => {
  try {
    const { getTelegramVerification } = await import('../authSession.js');
    const vreq = await getTelegramVerification(req.params.requestId);
    if (!vreq) {
      res.status(404).json({ error: 'Verification request not found' });
      return;
    }
    res.json({
      success: true,
      status: vreq.status,
      authToken: vreq.authToken,
      user: vreq.status === 'approved' ? {
        id: vreq.userId,
        telegramId: vreq.telegramId,
        username: vreq.username,
        subaccountId: vreq.subaccountId,
      } : undefined,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Status check failed' });
  }
});

// 3. Instant Zero-Click Auth for Telegram Mini App (TMA)
router.post('/auth/tma', async (req, res) => {
  try {
    const { validateTelegramInitData } = await import('../middleware.js');
    const initData = req.body?.initData || req.headers.authorization?.replace(/^tma\s+/, '') || '';
    const { valid, userId } = validateTelegramInitData(initData);
    if (!valid || !userId) {
      res.status(401).json({ error: 'Invalid Telegram WebApp initData' });
      return;
    }

    const { getUserByTelegramId, getUserById } = await import('@racerbot/db');
    const { createSubaccount } = await import('../wallet.js');
    let user = await getUserByTelegramId(userId);
    if (!user) {
      const created = await createSubaccount(userId);
      user = await getUserById(created.userId);
    }
    if (!user) {
      res.status(500).json({ error: 'Failed to initialize user' });
      return;
    }
    const { linkAuthSession, createAuthSession } = await import('../authSession.js');
    const { sessionId } = await createAuthSession();
    const linked = await linkAuthSession(sessionId, { id: userId });
    res.json({
      success: true,
      token: linked.session?.authToken,
      user: {
        id: user.id,
        telegramId: userId,
        subaccountId: user.subaccount_id,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'TMA authentication failed' });
  }
});

// 4. Get Current Authenticated Profile & Linked Wallets
router.get('/auth/me', ensureTelegramUser, async (req, res) => {
  try {
    const userId = (req as any).userId;
    const telegramId = (req as any).telegramUserId;
    const { getUserById, getUserWallets } = await import('@racerbot/db');
    const { getUserBalances } = await import('../wallet.js');

    const [user, wallets, balances] = await Promise.all([
      getUserById(userId),
      getUserWallets(userId, 'near').catch(() => []),
      getUserBalances(telegramId, false).catch(() => null),
    ]);

    res.json({
      success: true,
      user: {
        id: user?.id,
        telegramId,
        subaccountId: user?.subaccount_id,
        suiAddress: user?.sui_address,
        starknetAddress: user?.starknet_address,
      },
      wallets: (wallets || []).map(w => ({
        id: w.id,
        address: w.address,
        name: w.name,
        isActive: w.is_active,
        isImported: w.is_imported,
      })),
      balances,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to fetch user profile' });
  }
});

// 5. Link NEAR Wallet Selector Account to Telegram User
router.post('/wallet/link-selector', ensureTelegramUser, async (req, res) => {
  try {
    const userId = (req as any).userId;
    const telegramId = (req as any).telegramUserId;
    const { accountId, walletName, proof } = req.body;

    if (!accountId || typeof accountId !== 'string') {
      res.status(400).json({ error: 'accountId is required' });
      return;
    }
    if (!proof || typeof proof !== 'object') {
      res.status(400).json({ error: 'A signed wallet proof is required' });
      return;
    }

    const { linkSelectorWallet } = await import('../authSession.js');
    const result = await linkSelectorWallet({
      userId,
      telegramId,
      accountId: accountId.trim().toLowerCase(),
      walletName: walletName || 'NEAR Wallet Selector',
      proof,
    });

    if (!result.success) {
      res.status(400).json({ error: result.reason });
      return;
    }

    res.json({
      success: true,
      wallet: {
        id: result.wallet?.id,
        address: result.wallet?.address,
        name: result.wallet?.name,
        isActive: result.wallet?.is_active,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to link wallet selector account' });
  }
});

// 5a. Create a signed wallet challenge for Wallet Selector authentication
router.post('/auth/wallet/challenge', async (req, res) => {
  try {
    const { accountId } = req.body;
    if (!accountId || typeof accountId !== 'string') {
      res.status(400).json({ error: 'accountId is required' });
      return;
    }

    const { createWalletAuthChallenge } = await import('../authSession.js');
    const challenge = await createWalletAuthChallenge(accountId);
    res.json({ success: true, ...challenge });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Failed to create wallet challenge' });
  }
});

// 5b. Authenticate or Login via NEAR Wallet Selector
router.post('/auth/wallet-login', async (req, res) => {
  try {
    const { accountId, walletName, proof } = req.body;
    if (!accountId || typeof accountId !== 'string') {
      res.status(400).json({ error: 'accountId is required' });
      return;
    }
    if (!proof || typeof proof !== 'object') {
      res.status(400).json({ error: 'A signed wallet proof is required' });
      return;
    }

    const { authenticateWalletUser } = await import('../authSession.js');
    const result = await authenticateWalletUser({
      accountId: accountId.trim(),
      walletName: walletName || 'NEAR Wallet Selector',
      proof,
    });

    if (!result.success) {
      res.status(400).json({ error: result.reason });
      return;
    }

    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Wallet login failed' });
  }
});


// ── Fast HTML delivery ────────────────────────────────────────────────────────
// The web app pages are large (raceralpha.html is ~340 KB) and were served
// with `no-store` and no compression, so every visit re-downloaded the full
// file. Pages are now gzipped once (cached per file mtime) and served with
// an ETag + `no-cache`, so browsers revalidate and get a 304 when unchanged.
// Deploys still show up immediately because the ETag changes with the file.
const htmlGzipCache = new Map<string, { mtimeMs: number; raw: Buffer; gz: Buffer; etag: string }>();

function acceptsGzip(res: import('express').Response): boolean {
  const ae = String((res as any).req?.headers?.['accept-encoding'] || '');
  return /\bgzip\b/i.test(ae);
}

export function sendStaticHtml(res: import('express').Response, file: string): void {
  try {
    const stat = fs.statSync(file);
    let entry = htmlGzipCache.get(file);
    if (!entry || entry.mtimeMs !== stat.mtimeMs) {
      const raw = fs.readFileSync(file);
      const gz = zlib.gzipSync(raw, { level: 9 });
      const etag = `"${createHash('sha1').update(raw).digest('base64url').slice(0, 20)}"`;
      entry = { mtimeMs: stat.mtimeMs, raw, gz, etag };
      htmlGzipCache.set(file, entry);
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('ETag', entry.etag);
    res.setHeader('Vary', 'Accept-Encoding');
    if ((res as any).req?.headers?.['if-none-match'] === entry.etag) {
      res.status(304).end();
      return;
    }
    if (acceptsGzip(res)) {
      res.setHeader('Content-Encoding', 'gzip');
      res.send(entry.gz);
    } else {
      res.send(entry.raw);
    }
  } catch {
    res.sendFile(file);
  }
}

/** Gzip a dynamically built HTML string when the client supports it. */
export function sendHtmlBody(res: import('express').Response, html: string): void {
  res.setHeader('Vary', 'Accept-Encoding');
  if (acceptsGzip(res)) {
    res.setHeader('Content-Encoding', 'gzip');
    res.send(zlib.gzipSync(Buffer.from(html, 'utf8'), { level: 6 }));
  } else {
    res.send(html);
  }
}

export function serveRacerAlphaHtml(res: import('express').Response): void {
  const htmlPaths = [
    path.resolve(__dirname, 'raceralpha.html'),
    path.resolve(__dirname, '..', 'raceralpha.html'),
    path.resolve(__dirname, '..', 'src', 'raceralpha.html'),
    path.resolve(__dirname, '..', '..', 'src', 'raceralpha.html'),
  ];
  const htmlFile = htmlPaths.find(p => fs.existsSync(p));
  if (!htmlFile) {
    res.status(404).send('RacerAlpha page not found');
    return;
  }
  sendStaticHtml(res, htmlFile);
}

// ── RacerAlpha Endpoints & User Resolution ────────────────────────────────

/**
 * Check a transaction hash supplied by the browser: it must exist on-chain, have succeeded,
 * and be signed by the expected account. Without this, any string was accepted as proof of a trade.
 */
async function verifyClientTx(txHash: string, signerId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(txHash)) {
    return { ok: false, reason: 'Transaction hash is not a valid NEAR transaction hash.' };
  }
  const { getNear } = await import('@racerbot/shared');
  const outcome = await getNear().waitForOutcome(txHash, signerId, 20_000).catch(() => null);
  if (!outcome) {
    return { ok: false, reason: `Transaction ${txHash} was not found for ${signerId}.` };
  }
  if (outcome.transaction?.signer_id !== signerId) {
    return { ok: false, reason: `Transaction ${txHash} was not signed by ${signerId}.` };
  }
  if (outcome.status && typeof outcome.status === 'object' && 'Failure' in outcome.status) {
    return { ok: false, reason: `Transaction ${txHash} failed on-chain.` };
  }
  return { ok: true };
}

export async function resolveAlphaUser(req: any) {
  const { getUserById, getUserByTelegramId, getDb } = await import('@racerbot/db');

  if (req.userId) {
    const u = await getUserById(req.userId);
    if (u) return u;
  }

  // 1. Bearer Token Auth
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/, '') || req.query.token || req.body?.authToken;
  if (token && typeof token === 'string') {
    try {
      const { verifyAuthToken } = await import('../authSession.js');
      const sess = await verifyAuthToken(token);
      if (sess?.userId) {
        const u = await getUserById(sess.userId);
        if (u) return u;
      }
    } catch {}
  }

  // 2. Telegram Mini App (TMA) InitData Auth
  if (authHeader.startsWith('tma ')) {
    try {
      const { validateTelegramInitData } = await import('../middleware.js');
      const { valid, userId } = validateTelegramInitData(authHeader.slice(4));
      if (valid && userId) {
        const u = await getUserByTelegramId(userId);
        if (u) return u;
      }
    } catch {}
  }

  // 3. NEAR Connect Wallet Header
  const walletHeader = req.headers['x-wallet-address'] || req.query.walletAddress || req.body?.walletAddress;
  if (walletHeader && typeof walletHeader === 'string' && walletHeader.trim()) {
    const cleanWallet = walletHeader.trim();
    try {
      const db = await getDb();
      // IMPORTANT: Only filter by subaccount_id (TEXT) — never by id (UUID) with a wallet address.
      // Passing a NEAR address to a UUID column causes Postgres to throw
      // "invalid input syntax for type uuid" which propagates as a trade error.
      const uRes = await db.query(
        `SELECT * FROM users WHERE subaccount_id = $1 LIMIT 1`,
        [cleanWallet]
      );
      if (uRes.rows[0]) {
        // If users.username is default or empty, check if racer_alpha_traders has a custom handle
        if (!uRes.rows[0].username || uRes.rows[0].username === cleanWallet) {
          const tRes = await db.query(
            `SELECT handle FROM racer_alpha_traders WHERE user_id = $1 OR payout_wallet_address = $1 LIMIT 1`,
            [cleanWallet]
          );
          if (tRes.rows[0]?.handle) {
            uRes.rows[0].username = tRes.rows[0].handle;
          }
        }
        return uRes.rows[0];
      }

      // Check if a trader record exists with a custom handle
      const tRes = await db.query(
        `SELECT handle FROM racer_alpha_traders WHERE user_id = $1 OR payout_wallet_address = $1 LIMIT 1`,
        [cleanWallet]
      );
      const customHandle = tRes.rows[0]?.handle || null;

      // Generate a proper UUID for `id` — the wallet address goes into subaccount_id (TEXT).
      // Using uuid_generate_v4() server-side is safest; ON CONFLICT on subaccount_id ensures idempotency.
      const newU = await db.query(
        `INSERT INTO users (id, subaccount_id, telegram_id, scoped_key_encrypted, username)
         VALUES (uuid_generate_v4(), $1, 0, '', $2)
         ON CONFLICT (subaccount_id) DO UPDATE SET username = COALESCE(EXCLUDED.username, users.username)
         RETURNING *`,
        [cleanWallet, customHandle]
      );
      if (newU.rows[0]) return newU.rows[0];
    } catch {}
    return {
      id: cleanWallet,
      subaccount_id: cleanWallet,
      username: null,
      telegram_id: null,
    };
  }

  return null;
}

router.get(['/alpha', '/raceralpha', '/terminal', '/console', '/trade'], (_req, res) => {
  serveRacerAlphaHtml(res);
});

router.get('/alpha/traders', async (req, res) => {
  try {
    const user = await resolveAlphaUser(req);
    const { getAlphaTraders } = await import('../racerAlpha.js');
    const traders = await getAlphaTraders(user?.id);
    res.json({ success: true, traders });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to fetch traders' });
  }
});

router.get('/alpha/feed', async (req, res) => {
  try {
    const user = await resolveAlphaUser(req);
    const { getAlphaFeed } = await import('../racerAlpha.js');
    const signals = await getAlphaFeed(user?.id);
    res.json({ success: true, signals });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to fetch signals' });
  }
});

router.get('/alpha/traders/:id', async (req, res) => {
  try {
    const user = await resolveAlphaUser(req);
    const { getAlphaTraderById } = await import('../racerAlpha.js');
    const trader = await getAlphaTraderById(req.params.id, user?.id);
    if (!trader) {
      res.status(404).json({ error: 'Trader not found' });
      return;
    }
    res.json({ success: true, trader });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to fetch trader' });
  }
});

router.get('/alpha/traders/:id/positions', async (req, res) => {
  try {
    const user = await resolveAlphaUser(req);
    const { getAlphaTraderPositions } = await import('../racerAlpha.js');
    const data = await getAlphaTraderPositions(req.params.id, user?.id);
    res.json({ success: true, positions: data.positions, totalPnlUsd: data.totalPnlUsd, totalPnlPct: data.totalPnlPct, isLocked: data.isLocked, heldTier: data.heldTier });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to fetch positions' });
  }
});

router.get('/alpha/traders/:id/swaps', async (req, res) => {
  try {
    const user = await resolveAlphaUser(req);
    const { getAlphaTraderSwaps } = await import('../racerAlpha.js');
    const data = await getAlphaTraderSwaps(req.params.id, user?.id);
    res.json({ success: true, swaps: data.swaps, isLocked: data.isLocked });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to fetch swaps' });
  }
});

router.get('/alpha/my-keys', async (req, res) => {
  try {
    const user = await resolveAlphaUser(req);
    if (!user) {
      res.json({ success: true, keys: [], totalSpentNear: 0, totalSpentUsd: 0, activeCount: 0 });
      return;
    }
    const { getUserViewingKeys } = await import('../racerAlpha.js');
    const data = await getUserViewingKeys(user.id);
    res.json({ success: true, ...data });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to fetch viewing keys' });
  }
});

router.post('/alpha/copy-settings', async (req, res) => {
  try {
    const user = await resolveAlphaUser(req);
    if (!user) {
      res.status(401).json({ error: 'Please connect your NEAR wallet or Telegram.' });
      return;
    }
    const { traderId, allocationPct, riskMultiplier, stopLossPct, autoCopyEnabled, autoCopyAmountNear } = req.body;
    if (!traderId) {
      res.status(400).json({ error: 'traderId is required' });
      return;
    }
    const { updateKeyCopySettings } = await import('../racerAlpha.js');
    const result = await updateKeyCopySettings(user.id, traderId, {
      allocationPct,
      riskMultiplier,
      stopLossPct,
      autoCopyEnabled,
      autoCopyAmountNear,
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to update copy settings' });
  }
});

router.get('/alpha/creator/eligibility', async (req, res) => {
  try {
    const user = await resolveAlphaUser(req);
    const walletAddress = req.headers['x-wallet-address'] || req.query.walletAddress || user?.subaccount_id || user?.id;
    const { getCreatorEligibility } = await import('../racerAlpha.js');
    const data = await getCreatorEligibility(user?.id || (walletAddress as string) || 'guest', walletAddress as string);
    res.json({ success: true, ...data });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to check creator eligibility' });
  }
});

router.post('/alpha/creator/pay-entry-fee', async (req, res) => {
  try {
    const user = await resolveAlphaUser(req);
    if (!user) {
      res.status(401).json({ error: 'Please connect your NEAR wallet to pay entry fee.' });
      return;
    }
    const { walletAddress, txHash, amountNear } = req.body;
    const { payCreatorEntryFee } = await import('../racerAlpha.js');
    const result = await payCreatorEntryFee(user.id, {
      walletAddress: walletAddress || user.subaccount_id || user.id,
      txHash,
      amountNear,
    });
    if (!result.success) {
      res.status(400).json({ error: result.reason });
      return;
    }
    res.json({ success: true, txHash: result.txHash });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to process entry fee payment' });
  }
});

router.get('/alpha/tokens', async (req, res) => {
  try {
    const { category, sort, search } = req.query;
    const { listAlphaTokens } = await import('../racerAlpha.js');
    const result = await listAlphaTokens({
      category: category as string,
      sort: sort as string,
      search: search as string,
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to list tokens' });
  }
});

// ── Live Single Token Detail (Real-time updates) ───────────────────────────
router.get('/alpha/token/:address', async (req, res) => {
  try {
    const address = req.params.address;
    const { getAlphaTokenDetail } = await import('../racerAlpha.js');
    const token = await getAlphaTokenDetail(address);
    if (!token) {
      res.status(404).json({ success: false, error: 'Token not found' });
      return;
    }
    res.json({ success: true, token });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to fetch token detail' });
  }
});

router.get('/alpha/creator/dashboard', async (req, res) => {
  try {
    const user = await resolveAlphaUser(req);
    if (!user) {
      res.status(401).json({ error: 'Please connect your NEAR wallet or Telegram.' });
      return;
    }
    const walletAddress = req.headers['x-wallet-address'] || user.subaccount_id;
    const { getCreatorStudioData } = await import('../racerAlpha.js');
    const data = await getCreatorStudioData(user.id, walletAddress as string);
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to fetch creator dashboard' });
  }
});

router.post('/alpha/creator/pricing', async (req, res) => {
  try {
    const user = await resolveAlphaUser(req);
    if (!user) {
      res.status(401).json({ error: 'Please connect your NEAR wallet or Telegram.' });
      return;
    }
    const { updateCreatorPricing } = await import('../racerAlpha.js');
    const result = await updateCreatorPricing(user.id, req.body);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to update pricing' });
  }
});

// ── Live On-Chain Wallet Balance Endpoint (with memory cache) ───────────────
const accountBalanceCache = new Map<string, { balance: any; timestamp: number }>();
const BALANCE_CACHE_TTL_MS = 2500;

router.get('/api/near-price', async (_req, res) => {
  const nearUsd = await getNearUsdPrice().catch(() => 0);
  res.json({ nearUsd });
});

router.get(['/api/user/balance', '/user/balance'], async (req, res) => {
  try {
    let accountId = (req.query.accountId as string)?.trim() ||
                    (req.query.walletAddress as string)?.trim() ||
                    (req.headers['x-wallet-address'] as string)?.trim();

    if (!accountId) {
      const user = await resolveAlphaUser(req);
      accountId = user?.subaccount_id || user?.id;
    }

    if (!accountId) {
      res.json({
        success: true,
        accountId: '',
        near: '0.0000',
        nearYocto: '0',
        formatted: '0.00 NEAR',
        totalNear: '0.00',
        usd: '0.00',
      });
      return;
    }

    const cacheKey = accountId.toLowerCase();
    const cached = accountBalanceCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < BALANCE_CACHE_TTL_MS) {
      res.json(cached.balance);
      return;
    }

    const { getNear } = await import('@racerbot/shared');
    const near = getNear();
    const yocto = await near.getNearBalance(accountId).catch(() => '0');
    
    // 1 NEAR = 10^24 yoctoNEAR
    const yoctoBigInt = BigInt(yocto || '0');
    const nearFloat = Number(yoctoBigInt / 1000000000000000000n) / 1e6;
    const nearFormatted = nearFloat.toFixed(4);
    const nearUsdPrice = await getNearUsdPrice().catch(() => 0);
    const nearUsd = (nearFloat * nearUsdPrice).toFixed(2);

    const result = {
      success: true,
      accountId,
      near: nearFormatted,
      nearYocto: yocto,
      formatted: `${nearFloat.toFixed(2)} NEAR`,
      totalNear: nearFormatted,
      usd: nearUsd,
      nearUsdPrice,
    };

    accountBalanceCache.set(cacheKey, { balance: result, timestamp: Date.now() });
    res.json(result);
  } catch (err: any) {
    res.json({
      success: false,
      error: err?.message || 'Failed to fetch balance',
      near: '0.0000',
      nearYocto: '0',
      formatted: '0.00 NEAR',
      totalNear: '0.00',
      usd: '0.00',
    });
  }
});

// Update Creator Profile (handle/username, display name, bio) — tied 1:1 to wallet
router.post(['/alpha/creator/profile', '/api/user/profile', '/api/user/username'], async (req, res) => {
  try {
    const user = await resolveAlphaUser(req);
    if (!user) {
      res.status(401).json({ error: 'Please connect your NEAR wallet or Telegram.' });
      return;
    }
    const { handle, displayName, bio, strategyTag } = req.body;
    if (!handle && !displayName && !bio && !strategyTag) {
      res.status(400).json({ error: 'At least one field (handle, displayName, bio, strategyTag) is required.' });
      return;
    }
    const { updateCreatorProfile } = await import('../racerAlpha.js');
    const result = await updateCreatorProfile(user.id, {
      handle,
      displayName,
      bio,
      strategyTag,
      walletAddress: user.subaccount_id || user.id,
    });
    if (!result.success) {
      res.status(400).json({ error: result.reason });
      return;
    }
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to update profile' });
  }
});

router.post('/alpha/creator/terminal-link', async (req, res) => {
  try {
    const user = await resolveAlphaUser(req);
    if (!user) {
      res.status(401).json({ error: 'Please connect your NEAR wallet or Telegram.' });
      return;
    }
    const { generateTerminalLink } = await import('../racerAlpha.js');
    const result = await generateTerminalLink(user.id);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to generate terminal link' });
  }
});

// ── Live NEP-141 / NEAR Token Balance Endpoint for Trading Console ──────────
router.get('/alpha/user/token-balance', async (req, res) => {
  try {
    const user = await resolveAlphaUser(req);
    if (!user) {
      res.status(401).json({ error: 'Please connect your NEAR wallet or Telegram.' });
      return;
    }
    const tokenAddress = (req.query.tokenAddress as string || '').trim();
    if (!tokenAddress) {
      res.status(400).json({ error: 'tokenAddress query parameter is required.' });
      return;
    }
    const { getNear, formatTokenUnits } = await import('@racerbot/shared');
    const near = getNear();
    const accountToCheck = user.subaccount_id || user.id;

    if (tokenAddress === 'near' || tokenAddress === 'wrap.near') {
      const nearBalYocto = await near.getNearBalance(accountToCheck).catch(() => '0');
      const wNearYocto = await near.getTokenBalance('wrap.near', accountToCheck).catch(() => '0');
      const totalYocto = BigInt(nearBalYocto || '0') + BigInt(wNearYocto || '0');
      const formatted = formatTokenUnits(totalYocto, 24, 4);
      res.json({
        success: true,
        balance: formatted,
        balanceRaw: totalYocto.toString(),
        decimals: 24,
        symbol: 'NEAR',
      });
      return;
    }

    const [tokenBalRaw, meta] = await Promise.all([
      near.getTokenBalance(tokenAddress, accountToCheck).catch(() => '0'),
      near.getTokenMetadata(tokenAddress).catch(() => null),
    ]);

    const decimals = meta?.decimals ?? 18;
    const symbol = meta?.symbol || tokenAddress.split('.')[0].toUpperCase();
    const rawBalBig = BigInt(tokenBalRaw || '0');
    const formatted = formatTokenUnits(rawBalBig, decimals, 4);

    res.json({
      success: true,
      balance: formatted,
      balanceRaw: rawBalBig.toString(),
      decimals,
      symbol,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to fetch token balance' });
  }
});

// ── Live Intent Solver Quote Endpoint ───────────────────────────────────────
router.post('/alpha/trade/intent-quote', async (req, res) => {
  try {
    const user = await resolveAlphaUser(req);
    const { tokenAddress, side = 'BUY', amountNear = 1, amountTokens, tokenDecimals } = req.body;
    if (!tokenAddress) {
      res.status(400).json({ error: 'tokenAddress is required' });
      return;
    }
    const { getIntentSwapQuote } = await import('../intentTrade.js');
    const recipient = user?.subaccount_id || user?.id || 'racerbot.near';
    const quote = await getIntentSwapQuote({
      tokenAddress,
      side: side.toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
      amountNear: Number(amountNear) || 1,
      amountTokens,
      tokenDecimals,
      recipientAccountId: recipient,
      dryRun: true,
    });
    res.json(quote);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to fetch intent quote' });
  }
});

// ── Private DEX Trading & Intent Execution Endpoint ────────────────────────
router.post(['/alpha/trade/execute', '/alpha/trade'], async (req, res) => {
  try {
    const user = await resolveAlphaUser(req);
    if (!user) {
      res.status(401).json({ error: 'Please connect your NEAR wallet or Telegram to trade.' });
      return;
    }

    const {
      tokenAddress,
      tokenSymbol,
      tokenName,
      side,
      amountNear,
      amountTokens,
      amountTokensRaw,
      tokenDecimals: clientDecimals,
      poolId: clientPoolId,
      dclPoolId: clientDclPoolId,
      venue: explicitVenue,
      txHash: clientTxHash,
      slippagePct,
      isPrivateTrade: rawIsPrivateTrade,
    } = req.body;

    const isPrivateTrade = rawIsPrivateTrade === true || rawIsPrivateTrade === 'true';

    if (!tokenAddress || !side) {
      res.status(400).json({ error: 'tokenAddress and side are required.' });
      return;
    }

    const { inferVenueFromToken, normalizeVenueName } = await import('../racerAlpha.js');
    const isBuy = side.toUpperCase() === 'BUY';
    const numNear = Number(amountNear) || 1.0;
    const venue = normalizeVenueName(explicitVenue, tokenAddress);
    const routingPreference = (req.body.routingPreference || 'auto').toLowerCase();

    let onChainTxHash: string | undefined = clientTxHash || undefined;
    let executionRouting: 'INTENT_SOLVER' | 'RACER_SHIELDED_VAULT' | 'AMM' = 'AMM';
    let intentMessage: string | undefined;
    let recipientAccountId: string | undefined;

    const isLaunchpadToken =
      (Boolean(venue) && !['defuse', 'intent', 'near intents (defuse)', '1click'].includes(venue.toLowerCase())) ||
      tokenAddress.includes('nearlytrade.near') ||
      tokenAddress.includes('shardsmarket.near') ||
      tokenAddress.includes('intear.near') ||
      tokenAddress.includes('memecooking') ||
      tokenAddress.includes('patata-monster');

    // 1. Phase 1a: Decentralized Private Intent Solver Execution (Defuse Solver - major multichain tokens only)
    if (!onChainTxHash && user.subaccount_id && routingPreference !== 'amm' && routingPreference !== 'vault' && !isLaunchpadToken && isBuy) {
      try {
        const { executeIntentTrade } = await import('../intentTrade.js');
        const intentResult = await executeIntentTrade({
          user,
          tokenAddress,
          tokenSymbol: tokenSymbol || tokenAddress.split('.')[0].toUpperCase(),
          side: isBuy ? 'BUY' : 'SELL',
          amountNear: numNear,
          recipientAccountId: user.subaccount_id || user.id,
        });

        if (intentResult.success && intentResult.txHash) {
          onChainTxHash = intentResult.txHash;
          executionRouting = 'INTENT_SOLVER';
          intentMessage = intentResult.message;
        } else if (intentResult.requiresClientSignature && intentResult.depositAddress) {
          res.json({
            success: false,
            requiresClientSignature: true,
            routing: 'INTENT_SOLVER',
            depositAddress: intentResult.depositAddress,
            amountNear: numNear,
            correlationId: intentResult.correlationId,
            message: 'Please confirm the intent transfer in your connected NEAR wallet.'
          });
          return;
        }
      } catch (intentErr: any) {
        logger.warn(`Intent solver execution error (${intentErr.message}), trying Shielded Router Vault`);
      }
    }

    // Calculate exact amount_in in raw integer format
    let calculatedAmountIn: string;
    if (isBuy) {
      calculatedAmountIn = (BigInt(Math.floor(numNear * 1e6)) * 1000000000000000000n).toString();
    } else {
      if (amountTokensRaw && typeof amountTokensRaw === 'string' && /^\d+$/.test(amountTokensRaw)) {
        calculatedAmountIn = amountTokensRaw;
      } else if (amountTokens !== undefined && amountTokens !== null && String(amountTokens).trim() !== '') {
        const { parseTokenUnits, getNear } = await import('@racerbot/shared');
        let decimals = Number(clientDecimals);
        if (isNaN(decimals) || decimals <= 0) {
          const near = getNear();
          const meta = await near.getTokenMetadata(tokenAddress).catch(() => null);
          decimals = meta?.decimals ?? 18;
        }
        calculatedAmountIn = parseTokenUnits(String(amountTokens), decimals).toString();
      } else {
        // fallback if someone passed amountNear instead
        calculatedAmountIn = (BigInt(Math.floor(numNear * 1e6)) * 1000000000000000000n).toString();
      }
    }

    // 2. Phase 1b: Deployed Shielded Intent Router Contract (racerbotrouter.near)
    // Supports ALL launchpads on NEAR (Ref, Rhea, NearlyTrade, Shardsmarket, Intear, MemeCooking, etc.) and native tokens
    if (!onChainTxHash && user.subaccount_id && routingPreference !== 'amm') {
      try {
        const vaultRes = await executeShieldedVaultIntent({
          user,
          tokenAddress,
          venue: venue as any,
          side: isBuy ? 'BUY' : 'SELL',
          amountNear: numNear,
          amountTokens: calculatedAmountIn,
          slippagePct: Number(slippagePct) || 2,
          poolId: clientPoolId ? Number(clientPoolId) : undefined,
          dclPoolId: clientDclPoolId ? String(clientDclPoolId) : undefined,
          tokenDecimals: Number(clientDecimals) > 0 ? Number(clientDecimals) : undefined,
        });

        if (vaultRes.success && vaultRes.txHash) {
          onChainTxHash = vaultRes.txHash;
          executionRouting = 'RACER_SHIELDED_VAULT';
          intentMessage = vaultRes.message || `Shielded atomic trade executed via Racer Router (${vaultRes.txHash})`;
          recipientAccountId = vaultRes.recipientAccountId;
        } else {
          logger.warn(`Shielded vault execution returned: ${vaultRes.reason || 'unsuccessful'}`);
          if (isPrivateTrade) {
            let reasonText = vaultRes.reason || 'Transaction could not be shielded';
            if (reasonText.includes('zero_tokens_received')) {
              reasonText = '0 tokens received from venue (liquidity temporarily unavailable or slippage limit exceeded; funds safely refunded)';
            }
            res.status(400).json({
              error: `Shielded router execution failed: ${reasonText}. Unshielded trade was blocked to protect your wallet privacy.`,
            });
            return;
          }
        }
      } catch (vaultErr: any) {
        logger.warn(`Shielded vault router execution error (${vaultErr.message})`);
        if (isPrivateTrade) {
          res.status(400).json({
            error: `Shielded router execution failed: ${vaultErr.message}. Unshielded trade was blocked to protect your wallet privacy.`,
          });
          return;
        }
      }
    }

    // 3. Phase 1c: Direct AMM Swap via Managed Subaccount (Fallback for public trades only)
    if (!onChainTxHash && user.subaccount_id && !isPrivateTrade) {
      try {
        // Pre-swap guarantee: ensure token storage deposit is registered on-chain for ALL venues
        if (user.subaccount_id) {
          try {
            const { getNear } = await import('@racerbot/shared');
            const near = getNear();
            // Register token storage for every NEP-141 token
            if (tokenAddress && tokenAddress !== 'near' && tokenAddress !== 'wrap.near') {
              await near.ensureStorageDeposit(user.subaccount_id, tokenAddress).catch((err: any) => {
                logger.warn(`Storage deposit pre-check warning for ${user.subaccount_id} on ${tokenAddress}: ${err?.message}`);
              });
            }
            // Ensure user has wrap.near storage deposit for receiving or unbundling wNEAR
            await near.ensureStorageDeposit(user.subaccount_id, 'wrap.near').catch((err: any) => {
              logger.warn(`wrap.near storage deposit warning for ${user.subaccount_id}: ${err?.message}`);
            });

            // Ref-Finance internal whitelist registration (needed for ref/rhea/memecooking/gaypad/kelytra/nearpumpfun/nearlytrade/etc)
            // Required on BOTH buy and sell so Ref can accept ft_transfer_call
            const refVenues = ['rhea', 'ref', 'memecooking', 'gaypad', 'kelytra', 'nearpumpfun', 'nearlytrade', 'onetokenhub', 'nearpad', 'shoremarkets', 'qlyphs'];
            if (refVenues.includes(venue)) {
              const { ensureRefStorage, ensureRefTokenRegistered } = await import('@racerbot/executor');
              await ensureRefStorage(user.subaccount_id).catch(() => {});
              await ensureRefTokenRegistered(tokenAddress, user.subaccount_id).catch(() => {});
            }
          } catch (preErr: any) {
            logger.warn(`Pre-swap registration warning: ${preErr?.message}`);
          }
        }

        const buildSwapArgs = () => ({
          user_id: user.id,
          token_in: isBuy ? 'near' : tokenAddress,
          token_out: isBuy ? tokenAddress : 'wrap.near',
          amount_in: calculatedAmountIn,
          min_amount_out: '0',
          venue: venue as any,
          slippage_pct: Number(slippagePct) || 2,
        });

        let swapResult = await publishSwap(buildSwapArgs(), undefined, { suppressAlphaSignal: true });

        // Self-healing retry: if swap failed due to missing storage registration, force-register then retry once
        const swapFailReason = swapResult?.reason || '';
        const isStorageFailure =
          swapFailReason.includes('registered with this token contract') ||
          swapFailReason.includes('not registered') ||
          swapFailReason.includes('account is not registered') ||
          swapFailReason.includes('storage deposit');

        if ((!swapResult || swapResult.success === false) && isStorageFailure && user.subaccount_id) {
          logger.warn(`[TRADE-ROUTE] Storage registration failure detected for ${user.subaccount_id} on ${tokenAddress}. Force-registering and retrying...`);
          try {
            const { getNear } = await import('@racerbot/shared');
            const near = getNear();
            if (tokenAddress && tokenAddress !== 'near' && tokenAddress !== 'wrap.near') {
              await near.ensureStorageDeposit(user.subaccount_id, tokenAddress).catch(() => {});
            }
            await near.ensureStorageDeposit(user.subaccount_id, 'wrap.near').catch(() => {});
            const { ensureRefStorage, ensureRefTokenRegistered } = await import('@racerbot/executor');
            await ensureRefStorage(user.subaccount_id).catch(() => {});
            await ensureRefTokenRegistered(tokenAddress, user.subaccount_id).catch(() => {});
            // Single retry after successful registration
            swapResult = await publishSwap(buildSwapArgs(), undefined, { suppressAlphaSignal: true });
            logger.info(`[TRADE-ROUTE] Storage self-heal retry result for ${user.subaccount_id}: success=${swapResult?.success}`);
          } catch (retryErr: any) {
            logger.warn(`[TRADE-ROUTE] Storage self-heal retry failed: ${retryErr?.message}`);
          }
        }

        if (swapResult && swapResult.success !== false) {
          onChainTxHash = swapResult.txHash;
          executionRouting = 'AMM';
        } else {
          res.status(400).json({ error: swapResult?.reason || 'On-chain swap failed. Please retry.' });
          return;
        }
      } catch (swapErr: any) {
        if (!clientTxHash) {
          res.status(400).json({ error: `Trade failed: ${swapErr?.message || 'wallet error'}. Please ensure your wallet is funded and try again.` });
          return;
        }
        onChainTxHash = clientTxHash;
      }
    }

    if (!onChainTxHash) {
      res.status(400).json({ error: 'A real on-chain transaction hash is required. Please sign the trade in your wallet first.' });
      return;
    }

    if (clientTxHash && onChainTxHash === clientTxHash) {
      const check = await verifyClientTx(clientTxHash, user.subaccount_id || user.id);
      if (!check.ok) {
        res.status(400).json({ error: check.reason });
        return;
      }
    }

    res.json({
      success: true,
      isPrivateTrade: true,
      txHash: onChainTxHash,
      routing: executionRouting,
      recipientAccountId: recipientAccountId || user.subaccount_id,
      message:
        intentMessage ||
        (executionRouting === 'INTENT_SOLVER'
          ? 'Private trade filled by a NEAR Intents (1Click) solver'
          : executionRouting === 'RACER_SHIELDED_VAULT'
          ? 'Atomic Shielded Trade executed via Racer Router (racerbotrouter.near)'
          : 'Private trade executed on-chain'),
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to execute private trade' });
  }
});

// ── Racer Shielded Vault Endpoints (Option B) ────────────────────────────────
router.get('/alpha/vault/balance', async (req, res) => {
  try {
    const user = await resolveAlphaUser(req);
    if (!user) {
      res.status(401).json({ error: 'Please connect your NEAR wallet or Telegram.' });
      return;
    }
    const token = (req.query.token as string) || 'near';
    const accountId = user.subaccount_id || user.id;
    const { getVaultBalance } = await import('../racerVault.js');
    const balanceYocto = await getVaultBalance(accountId, token);
    const balanceNear = Number(BigInt(balanceYocto || '0') / 10n ** 20n) / 10000;
    res.json({ success: true, accountId, token, balanceYocto, balanceNear });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to fetch vault balance' });
  }
});

router.get('/alpha/vault/intents', async (req, res) => {
  try {
    const user = await resolveAlphaUser(req);
    if (!user) {
      res.status(401).json({ error: 'Please connect your NEAR wallet or Telegram.' });
      return;
    }
    const accountId = user.subaccount_id || user.id;
    const { getUserVaultIntents } = await import('@racerbot/db');
    const intents = await getUserVaultIntents(accountId, 50);
    res.json({ success: true, intents });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to fetch vault intents' });
  }
});

router.get('/alpha/vault/intent/:correlationId', async (req, res) => {
  try {
    const { correlationId } = req.params;
    const { getVaultIntentByCorrelationId } = await import('@racerbot/db');
    const intent = await getVaultIntentByCorrelationId(correlationId);
    if (!intent) {
      res.status(404).json({ error: 'Intent not found with this correlation ID' });
      return;
    }
    res.json({ success: true, intent });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to query intent' });
  }
});

router.post('/alpha/vault/deposit', async (req, res) => {
  try {
    const user = await resolveAlphaUser(req);
    if (!user) {
      res.status(401).json({ error: 'Please connect your NEAR wallet or Telegram.' });
      return;
    }
    const numNear = Number(req.body.amountNear);
    if (!numNear || numNear <= 0) {
      res.status(400).json({ error: 'Valid amountNear required.' });
      return;
    }
    const yocto = (BigInt(Math.floor(numNear * 1e6)) * 1000000000000000000n).toString();
    const { depositNearToVault } = await import('../racerVault.js');
    const result = await depositNearToVault(user, yocto);
    if (!result.success) {
      res.status(400).json({ error: result.reason || 'Deposit failed' });
      return;
    }
    res.json({ success: true, txHash: result.txHash, amountNear: numNear });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Vault deposit error' });
  }
});

router.post(['/alpha/vault/withdraw', '/alpha/vault/refund'], async (req, res) => {
  try {
    const user = await resolveAlphaUser(req);
    if (!user || !user.subaccount_id) {
      res.status(401).json({ error: 'Please connect your NEAR wallet or Telegram.' });
      return;
    }
    const token = (req.body.token || 'near').toLowerCase();
    const { refundUserFromVault } = await import('../racerVault.js');
    const result = await refundUserFromVault(user.subaccount_id, token);
    if (!result.success) {
      res.status(400).json({ error: result.reason || 'Vault refund/withdraw failed' });
      return;
    }
    res.json({ success: true, txHash: result.txHash, token, accountId: user.subaccount_id });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Vault refund error' });
  }
});

router.get('/alpha/vault/balance', async (req, res) => {
  try {
    const user = await resolveAlphaUser(req);
    if (!user || !user.subaccount_id) {
      res.status(401).json({ error: 'Please connect your NEAR wallet or Telegram.' });
      return;
    }
    const token = ((req.query.token as string) || 'near').toLowerCase();
    const { getVaultBalance } = await import('../racerVault.js');
    const balanceYocto = await getVaultBalance(user.subaccount_id, token);
    const balanceNear = (Number(BigInt(balanceYocto) / 1000000000000000000n) / 1e6).toFixed(4);
    res.json({
      success: true,
      accountId: user.subaccount_id,
      token,
      balanceYocto,
      balanceFormatted: balanceNear,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to fetch vault balance' });
  }
});

router.post('/alpha/creator/signal', async (req, res) => {
  try {
    const user = await resolveAlphaUser(req);
    if (!user) {
      res.status(401).json({ error: 'Please connect your NEAR wallet or Telegram.' });
      return;
    }

    // If caller explicitly asked for private trade, delegate cleanly
    if (req.body.isPrivateTrade) {
      const { tokenAddress, side } = req.body;
      if (!tokenAddress || !side) {
        res.status(400).json({ error: 'tokenAddress and side are required.' });
        return;
      }
      // Execute as private trade
      req.url = '/alpha/trade/execute';
      return (router as any).handle(req, res);
    }

    const { recordAlphaSignal, inferVenueFromToken, normalizeVenueName } = await import('../racerAlpha.js');
    const { traderId, tokenAddress, tokenSymbol, tokenName, side, priceNear, amountNear, venue: explicitVenue, txHash: clientTxHash, slippagePct } = req.body;

    if (!tokenAddress || !side) {
      res.status(400).json({ error: 'tokenAddress and side are required.' });
      return;
    }

    const isBuy = side.toUpperCase() === 'BUY';
    const numNear = Number(amountNear) || 1.0;
    const venue = normalizeVenueName(explicitVenue, tokenAddress);

    // Auto-resolve or create effective trader ID if not provided
    let effectiveTraderId = traderId;
    if (traderId) {
      const db = await (await import('@racerbot/db')).getDb();
      const owned = await db.query(
        `SELECT id FROM racer_alpha_traders WHERE id = $1 AND (user_id = $2 OR payout_wallet_address = $3) LIMIT 1`,
        [traderId, user.id, user.subaccount_id || user.id]
      ).catch(() => ({ rows: [] }));
      if (!owned.rows[0]) {
        res.status(403).json({ error: 'You can only publish signals for your own creator profile.' });
        return;
      }
    }
    if (!effectiveTraderId) {
      const db = await (await import('@racerbot/db')).getDb();
      const tr = await db.query(
        `SELECT id FROM racer_alpha_traders WHERE user_id = $1 OR payout_wallet_address = $2 LIMIT 1`,
        [user.id, user.subaccount_id || user.id]
      ).catch(() => ({ rows: [] }));
      effectiveTraderId = tr.rows[0]?.id;
    }
    if (!effectiveTraderId) {
      const { updateCreatorProfile } = await import('../racerAlpha.js');
      const fallbackHandle = (user.username || ('trader_' + user.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 10))).toLowerCase();
      await updateCreatorProfile(user.id, {
        handle: fallbackHandle,
        displayName: user.username || 'Alpha Trader',
        walletAddress: user.subaccount_id || user.id,
      });
      const db = await (await import('@racerbot/db')).getDb();
      const tr = await db.query(
        `SELECT id FROM racer_alpha_traders WHERE user_id = $1 OR payout_wallet_address = $2 LIMIT 1`,
        [user.id, user.subaccount_id || user.id]
      ).catch(() => ({ rows: [] }));
      effectiveTraderId = tr.rows[0]?.id || ('trader_' + user.id.slice(0, 16));
    }

    const routingPreference = (req.body.routingPreference || 'auto').toLowerCase();
    let onChainTxHash: string | undefined = clientTxHash || undefined;
    let executionRouting: 'INTENT_SOLVER' | 'AMM' = 'AMM';
    let intentMessage: string | undefined;

    // ── Phase 1a: Decentralized Private Intent Solver Execution (Option B) ──
    if (!onChainTxHash && user.subaccount_id && routingPreference !== 'amm') {
      try {
        const { executeIntentTrade } = await import('../intentTrade.js');
        const intentResult = await executeIntentTrade({
          user,
          tokenAddress,
          tokenSymbol: tokenSymbol || tokenAddress.split('.')[0].toUpperCase(),
          side: isBuy ? 'BUY' : 'SELL',
          amountNear: numNear,
          recipientAccountId: user.subaccount_id || user.id,
        });

        if (intentResult.success && intentResult.txHash) {
          onChainTxHash = intentResult.txHash;
          executionRouting = 'INTENT_SOLVER';
          intentMessage = intentResult.message;
        } else if (intentResult.requiresClientSignature && intentResult.depositAddress) {
          // External wallet selector user — return single-use stealth deposit address for client-side signing
          res.json({
            success: false,
            requiresClientSignature: true,
            routing: 'INTENT_SOLVER',
            depositAddress: intentResult.depositAddress,
            amountNear: numNear,
            correlationId: intentResult.correlationId,
            message: 'Please confirm the intent transfer in your connected NEAR wallet.'
          });
          return;
        } else {
          logger.info(`Defuse Intent route skipped (${intentResult.reason || 'unlisted'}), falling back to Direct AMM Relayer`);
        }
      } catch (intentErr: any) {
        logger.warn(`Intent solver execution error (${intentErr.message}), falling back to direct AMM`);
      }
    }

    // ── Phase 1b: Direct AMM Swap via Managed Subaccount (Fallback or Direct AMM) ──
    if (!onChainTxHash && user.subaccount_id) {
      try {
        // Pre-swap guarantee: ensure token storage deposit is registered on-chain for ALL venues
        if (isBuy && user.subaccount_id) {
          try {
            const { getNear } = await import('@racerbot/shared');
            const near = getNear();
            if (tokenAddress && tokenAddress !== 'near' && tokenAddress !== 'wrap.near') {
              await near.ensureStorageDeposit(user.subaccount_id, tokenAddress).catch((err: any) => {
                logger.warn(`Storage deposit pre-check warning for ${user.subaccount_id} on ${tokenAddress}: ${err?.message}`);
              });
            }
            const refVenues = ['rhea', 'ref', 'memecooking', 'gaypad', 'kelytra', 'nearpumpfun', 'nearlytrade', 'onetokenhub', 'nearpad', 'shoremarkets', 'qlyphs'];
            if (refVenues.includes(venue)) {
              const { ensureRefStorage, ensureRefTokenRegistered } = await import('@racerbot/executor');
              await ensureRefStorage(user.subaccount_id).catch(() => {});
              await ensureRefTokenRegistered(tokenAddress, user.subaccount_id).catch(() => {});
            }
          } catch (preErr: any) {
            logger.warn(`Pre-swap registration warning: ${preErr?.message}`);
          }
        }

        const buildSwapArgs = () => ({
          user_id: user.id,
          token_in: isBuy ? 'near' : tokenAddress,
          token_out: isBuy ? tokenAddress : 'wrap.near',
          amount_in: isBuy
            ? (BigInt(Math.floor(numNear * 1e6)) * 1000000000000000000n).toString()
            : (req.body.amountTokens || (BigInt(Math.floor(numNear * 1e6)) * 1000000000000000000n).toString()),
          min_amount_out: '0',
          venue: venue as any,
          slippage_pct: Number(slippagePct) || 2,
        });

        let swapResult = await publishSwap(buildSwapArgs(), undefined, { suppressAlphaSignal: true });

        // Self-healing retry: if swap failed due to missing storage registration, force-register then retry once
        const swapFailReason = swapResult?.reason || '';
        const isStorageFailure =
          swapFailReason.includes('registered with this token contract') ||
          swapFailReason.includes('not registered') ||
          swapFailReason.includes('account is not registered') ||
          swapFailReason.includes('storage deposit');

        if ((!swapResult || swapResult.success === false) && isStorageFailure && isBuy && user.subaccount_id) {
          logger.warn(`[SIGNAL-ROUTE] Storage registration failure for ${user.subaccount_id} on ${tokenAddress}. Force-registering and retrying...`);
          try {
            const { getNear } = await import('@racerbot/shared');
            const near = getNear();
            if (tokenAddress && tokenAddress !== 'near' && tokenAddress !== 'wrap.near') {
              await near.ensureStorageDeposit(user.subaccount_id, tokenAddress);
            }
            const { ensureRefStorage, ensureRefTokenRegistered } = await import('@racerbot/executor');
            await ensureRefStorage(user.subaccount_id);
            await ensureRefTokenRegistered(tokenAddress, user.subaccount_id);
            swapResult = await publishSwap(buildSwapArgs(), undefined, { suppressAlphaSignal: true });
            logger.info(`[SIGNAL-ROUTE] Storage self-heal retry result: success=${swapResult?.success}`);
          } catch (retryErr: any) {
            logger.warn(`[SIGNAL-ROUTE] Storage self-heal retry failed: ${retryErr?.message}`);
          }
        }

        if (swapResult && swapResult.success !== false) {
          onChainTxHash = swapResult.txHash;
          executionRouting = 'AMM';
        } else {
          res.status(400).json({ error: swapResult?.reason || 'On-chain swap failed. Please retry.' });
          return;
        }
      } catch (swapErr: any) {
        // Subaccount not funded or unavailable — require client-side txHash
        if (!clientTxHash) {
          res.status(400).json({ error: `Trade failed: ${swapErr?.message || 'wallet error'}. Please ensure your wallet is funded and try again.` });
          return;
        }
        onChainTxHash = clientTxHash;
      }
    }

    // Require a real on-chain transaction hash — no mocks allowed
    if (!onChainTxHash) {
      res.status(400).json({ error: 'A real on-chain transaction hash is required. Please sign the trade in your wallet first.' });
      return;
    }

    if (clientTxHash && onChainTxHash === clientTxHash) {
      const signerId = user.subaccount_id || user.id;
      const check = await verifyClientTx(clientTxHash, signerId);
      if (!check.ok) {
        res.status(400).json({ error: check.reason });
        return;
      }
      const db = await (await import('@racerbot/db')).getDb();
      const reused = await db.query(`SELECT 1 FROM racer_alpha_signals WHERE tx_hash = $1 LIMIT 1`, [clientTxHash]).catch(() => ({ rows: [] }));
      if (reused.rows[0]) {
        res.status(409).json({ error: 'This transaction was already published as a signal.' });
        return;
      }
    }

    // Price: the creator's quoted price, else the live token price; 0 means unknown (never invented)
    let signalPriceNear = Number(priceNear) > 0 ? Number(priceNear) : 0;
    if (!signalPriceNear) {
      const info: any = await getTokenInfo(tokenAddress, false).catch(() => null);
      signalPriceNear = parseFloat(info?.price || '0') || 0;
    }

    // ── Phase 2: Record Encrypted Alpha Signal & Trigger Auto-Copy ──
    const effectiveVenue = executionRouting === 'INTENT_SOLVER' ? 'NEAR Intents (Defuse)' : venue;
    const result = await recordAlphaSignal({
      traderId: effectiveTraderId,
      tokenAddress,
      tokenSymbol: tokenSymbol || tokenAddress.split('.')[0].toUpperCase(),
      tokenName: tokenName || tokenSymbol || tokenAddress.split('.')[0],
      side: side.toUpperCase() as 'BUY' | 'SELL',
      priceNear: signalPriceNear,
      amountNear: numNear,
      venue: effectiveVenue,
      txHash: onChainTxHash,
    });

    res.json({
      success: true,
      txHash: onChainTxHash,
      routing: executionRouting,
      message: intentMessage || (executionRouting === 'INTENT_SOLVER' ? 'Confidential Intent executed via Defuse Solver batch auction' : undefined),
      ...result
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to dispatch signal' });
  }
});

// ── Copy Trading Settings (Requires Paid Viewing Key) ───────────────────────
router.post('/alpha/copy-settings', async (req, res) => {
  try {
    const user = await resolveAlphaUser(req);
    if (!user) {
      res.status(401).json({ error: 'Please connect your NEAR wallet or Telegram.' });
      return;
    }

    const { traderId, allocationPct, riskMultiplier, stopLossPct, autoCopyEnabled, autoCopyAmountNear } = req.body;
    if (!traderId) {
      res.status(400).json({ error: 'traderId is required to configure copy trading.' });
      return;
    }

    const { getUserHeldKeysMap, updateKeyCopySettings } = await import('../racerAlpha.js');
    const userKeysMap = await getUserHeldKeysMap(user.id);
    const keyInfo = userKeysMap.get(traderId);

    // Verify key ownership: users who are not copy trading can trade tokens freely,
    // but MUST purchase an Alpha Caller's key if they want to copy trade them.
    if (!keyInfo) {
      res.status(403).json({
        success: false,
        requiresKey: true,
        traderId,
        error: 'Paid Viewing Key Required. You must purchase a Viewing Key for this Alpha Caller to enable automated copy trading.',
      });
      return;
    }

    const result = await updateKeyCopySettings(user.id, traderId, {
      allocationPct: allocationPct !== undefined ? Number(allocationPct) : undefined,
      riskMultiplier: riskMultiplier !== undefined ? Number(riskMultiplier) : undefined,
      stopLossPct: stopLossPct !== undefined ? Number(stopLossPct) : undefined,
      autoCopyEnabled: autoCopyEnabled !== undefined ? Boolean(autoCopyEnabled) : true,
      autoCopyAmountNear: autoCopyAmountNear !== undefined ? Number(autoCopyAmountNear) : undefined,
    });

    if (!result.success) {
      res.status(400).json({ error: result.reason || 'Failed to update copy settings' });
      return;
    }

    res.json({
      success: true,
      message: 'Confidential copy settings updated successfully.',
      heldTier: keyInfo.tier,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to update copy settings' });
  }
});

router.get('/alpha/copy-settings/:traderId', async (req, res) => {
  try {
    const user = await resolveAlphaUser(req);
    if (!user) {
      res.status(401).json({ error: 'Please connect your NEAR wallet or Telegram.' });
      return;
    }
    const { traderId } = req.params;
    const { getUserHeldKeysMap } = await import('../racerAlpha.js');
    const userKeysMap = await getUserHeldKeysMap(user.id);
    const keyInfo = userKeysMap.get(traderId);

    if (!keyInfo) {
      res.json({
        success: true,
        hasKey: false,
        requiresKey: true,
        traderId,
        message: 'No active viewing key held for this caller.',
      });
      return;
    }

    const db = await (await import('@racerbot/db')).getDb();
    const rows = await db.query(
      `SELECT allocation_pct, risk_multiplier, stop_loss_pct, auto_copy_enabled, auto_copy_amount_near 
       FROM racer_alpha_keys 
       WHERE buyer_user_id = $1 AND trader_id = $2 AND payment_status = 'completed' LIMIT 1`,
      [user.id, traderId]
    ).catch(() => ({ rows: [] }));

    const r = rows.rows[0];
    res.json({
      success: true,
      hasKey: true,
      heldTier: keyInfo.tier,
      allocationPct: r?.allocation_pct ?? 25,
      riskMultiplier: r?.risk_multiplier ?? 1.5,
      stopLossPct: r?.stop_loss_pct ?? -8,
      autoCopyEnabled: r?.auto_copy_enabled ?? true,
      autoCopyAmountNear: r?.auto_copy_amount_near ?? 1.0,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to fetch copy settings' });
  }
});



router.post('/deposit/unwrap', async (req, res) => {
  try {
    const user = await resolveAlphaUser(req);
    if (!user) {
      res.status(401).json({ error: 'Please connect your NEAR wallet or Telegram.' });
      return;
    }
    const { unwrapUserWrapNear } = await import('../wallet.js');
    const result = await unwrapUserWrapNear(user.telegram_id);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to unwrap wrap.near' });
  }
});

router.post('/alpha/keys/buy', async (req, res) => {
  try {
    const user = await resolveAlphaUser(req);
    if (!user) {
      res.status(401).json({ error: 'Please connect your NEAR wallet or Telegram to purchase viewing keys.' });
      return;
    }
    const { traderId, tier, txHash, autoCopyEnabled, autoCopyAmountNear, allocationPct, riskMultiplier, stopLossPct } = req.body;
    if (!traderId) {
      res.status(400).json({ error: 'traderId is required' });
      return;
    }
    const { buyViewingKey } = await import('../racerAlpha.js');
    const result = await buyViewingKey(user, traderId, {
      tier,
      txHash,
      autoCopyEnabled,
      autoCopyAmountNear,
      allocationPct,
      riskMultiplier,
      stopLossPct,
    });
    if (!result.success) {
      res.status(400).json({ error: result.reason });
      return;
    }
    res.json({ success: true, keyToken: result.keyToken, trader: result.trader });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to buy viewing key' });
  }
});

router.post('/alpha/creator/register', async (req, res) => {
  try {
    const user = await resolveAlphaUser(req);
    if (!user) {
      res.status(401).json({ error: 'Please connect your NEAR wallet or Telegram to register as a creator.' });
      return;
    }
    const { registerAlphaCreator } = await import('../racerAlpha.js');
    const result = await registerAlphaCreator(user, req.body);
    if (!result.success) {
      res.status(400).json({ error: result.reason });
      return;
    }
    res.json({ success: true, trader: result.trader });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to register creator' });
  }
});

router.get('/alpha/autocopy/settings', async (req, res) => {
  try {
    const user = await resolveAlphaUser(req);
    if (!user) {
      res.json({
        success: true,
        settings: { enabled: false, buyAmountNear: 2.0, dailyCapNear: 20.0, maxSlippagePct: 2.0, copySells: false }
      });
      return;
    }
    const { getAutoCopySettings } = await import('../racerAlpha.js');
    const settings = await getAutoCopySettings(user.id);
    res.json({ success: true, settings });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to fetch auto-copy settings' });
  }
});

router.post('/alpha/autocopy/settings', async (req, res) => {
  try {
    const user = await resolveAlphaUser(req);
    if (!user) {
      res.status(401).json({ error: 'Please connect your wallet or Telegram to save auto-copy settings.' });
      return;
    }
    const { saveAutoCopySettings } = await import('../racerAlpha.js');
    const result = await saveAutoCopySettings(user.id, req.body);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to save auto-copy settings' });
  }
});

// ── RaceFleet WebApp Terminal Endpoints & HTML Handler ─────────────────────

export function serveFleetHtml(res: import('express').Response): void {
  const htmlPaths = [
    path.resolve(__dirname, 'fleet.html'),
    path.resolve(__dirname, '..', 'fleet.html'),
    path.resolve(__dirname, '..', 'src', 'fleet.html'),
    path.resolve(__dirname, '..', '..', 'src', 'fleet.html'),
  ];
  const htmlFile = htmlPaths.find(p => fs.existsSync(p));
  if (!htmlFile) {
    res.status(404).send('RaceFleet terminal not found');
    return;
  }
  sendStaticHtml(res, htmlFile);
}

router.get(['/fleet', '/racefleet'], (_req, res) => {
  serveFleetHtml(res);
});

async function resolveFleetUser(req: any) {
  const { getUserById, getUserByTelegramId, getDb } = await import('@racerbot/db');
  
  if (req.userId) {
    const u = await getUserById(req.userId);
    if (u) return u;
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/, '') || req.query.token || req.body?.authToken;
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

  const telegramId = Number(req.body?.telegramId || req.query?.telegramId);
  if (telegramId) {
    const u = await getUserByTelegramId(telegramId);
    if (u) return u;
  }

  const username = req.body?.username || req.query?.username;
  if (username) {
    const db = await getDb().catch(() => null);
    if (db) {
      const cleanUser = username.replace(/^@/, '');
      const res = await db.query('SELECT * FROM users WHERE username = $1 OR subaccount_id = $1 LIMIT 1', [cleanUser]);
      if (res.rows[0]) return res.rows[0];
    }
  }

  const db = await getDb().catch(() => null);
  if (db) {
    const res = await db.query('SELECT u.* FROM users u JOIN race_fleets f ON f.user_id = u.id WHERE f.status = \'active\' ORDER BY f.updated_at DESC LIMIT 1');
    if (res.rows[0]) return res.rows[0];
  }

  return null;
}

// 1. Get Fleet Status & Balances
router.get('/fleet/status', async (req, res) => {
  try {
    const user = await resolveFleetUser(req);
    if (!user) {
      res.status(404).json({ error: 'User not found. Connect Telegram or NEAR wallet.' });
      return;
    }

    const { hasActiveRaceFleet, getFleetBalances } = await import('../raceFleet.js');
    const { getRaceFleetByUserId } = await import('@racerbot/db');

    const isActive = await hasActiveRaceFleet(user.id);
    const fleet = await getRaceFleetByUserId(user.id);

    if (!isActive || !fleet) {
      res.json({
        success: true,
        hasFleet: false,
        user: {
          id: user.id,
          username: user.username,
          telegramId: user.telegram_id,
          subaccountId: user.subaccount_id,
        },
        subscriptionFeeNear: 2.0,
        minWallets: 5,
        maxWallets: 25,
      });
      return;
    }

    const refresh = req.query.refresh === 'true';
    const balances = await getFleetBalances(fleet.id, req.query.token as string || undefined, refresh);

    res.json({
      success: true,
      hasFleet: true,
      user: {
        id: user.id,
        username: user.username,
        telegramId: user.telegram_id,
        subaccountId: user.subaccount_id,
      },
      fleet: {
        id: fleet.id,
        name: fleet.name,
        fleetTag: fleet.fleet_tag,
        status: fleet.status,
        walletCount: fleet.wallet_count,
        startsAt: fleet.starts_at,
        expiresAt: fleet.expires_at,
        autoRenew: fleet.auto_renew,
      },
      balances,
    });
  } catch (err: any) {
    logger.error('Failed to get fleet status', err);
    res.status(500).json({ error: err.message || 'Failed to fetch fleet status' });
  }
});

// 2. Deploy a New Fleet (Subscription)
router.post('/fleet/deploy', async (req, res) => {
  try {
    const user = await resolveFleetUser(req);
    if (!user) {
      res.status(404).json({ error: 'User not found. Connect Telegram or NEAR wallet.' });
      return;
    }

    const { walletCount, fleetName } = req.body;
    const count = parseInt(walletCount, 10) || 10;
    const { deployRaceFleet } = await import('../raceFleet.js');

    const result = await deployRaceFleet(user.telegram_id, count, fleetName || 'Alpha Fleet');
    if (!result.success) {
      res.status(400).json({ error: result.reason || 'Deployment failed' });
      return;
    }

    res.json({
      success: true,
      fleet: result.fleet,
      wallets: result.wallets,
    });
  } catch (err: any) {
    logger.error('Failed to deploy fleet', err);
    res.status(500).json({ error: err.message || 'Fleet deployment failed' });
  }
});

// 3. 1-Click Distribute NEAR to Fleet Wallets
router.post('/fleet/distribute', async (req, res) => {
  try {
    const user = await resolveFleetUser(req);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const totalNear = parseFloat(req.body.totalNear) || 0;
    if (totalNear <= 0) {
      res.status(400).json({ error: 'Please enter a valid NEAR amount to distribute' });
      return;
    }

    const { distributeFundsToFleet } = await import('../raceFleet.js');
    const result = await distributeFundsToFleet(user.telegram_id, totalNear);

    if (!result.success) {
      res.status(400).json({ error: result.reason || 'Distribution failed' });
      return;
    }

    res.json(result);
  } catch (err: any) {
    logger.error('Failed to distribute funds to fleet', err);
    res.status(500).json({ error: err.message || 'Distribution failed' });
  }
});

// 4. 1-Click Sweep Funds from Fleet back to Main Wallet
router.post('/fleet/sweep', async (req, res) => {
  try {
    const user = await resolveFleetUser(req);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const { sweepFleetFunds } = await import('../raceFleet.js');
    const result = await sweepFleetFunds(user.telegram_id);

    if (!result.success) {
      res.status(400).json({ error: result.reason || 'Sweep failed' });
      return;
    }

    res.json(result);
  } catch (err: any) {
    logger.error('Failed to sweep fleet funds', err);
    res.status(500).json({ error: err.message || 'Sweep failed' });
  }
});

// 5. Coordinated Bundle Buy across all Fleet Wallets
router.post('/fleet/bundle-buy', async (req, res) => {
  try {
    const user = await resolveFleetUser(req);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const { getRaceFleetByUserId } = await import('@racerbot/db');
    const fleet = await getRaceFleetByUserId(user.id);
    if (!fleet) {
      res.status(400).json({ error: 'No active fleet deployed for this account' });
      return;
    }

    const { tokenAddress, amountNearPerWallet, slippagePct } = req.body;
    if (!tokenAddress) {
      res.status(400).json({ error: 'tokenAddress is required' });
      return;
    }

    const amount = parseFloat(amountNearPerWallet) || 1.0;
    const slippage = parseFloat(slippagePct) || 3.0;

    const { executeFleetBundleBuy } = await import('../raceFleet.js');
    const result = await executeFleetBundleBuy(fleet.id, tokenAddress, amount, slippage);

    res.json(result);
  } catch (err: any) {
    logger.error('Failed to execute bundle buy', err);
    res.status(500).json({ error: err.message || 'Bundle buy failed' });
  }
});

// 6. Coordinated Bundle Sell across all Fleet Wallets
router.post('/fleet/bundle-sell', async (req, res) => {
  try {
    const user = await resolveFleetUser(req);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const { getRaceFleetByUserId } = await import('@racerbot/db');
    const fleet = await getRaceFleetByUserId(user.id);
    if (!fleet) {
      res.status(400).json({ error: 'No active fleet deployed for this account' });
      return;
    }

    const { tokenAddress, sellPct, slippagePct } = req.body;
    if (!tokenAddress) {
      res.status(400).json({ error: 'tokenAddress is required' });
      return;
    }

    const pct = parseFloat(sellPct) || 100;
    const slippage = parseFloat(slippagePct) || 3.0;

    const { executeFleetBundleSell } = await import('../raceFleet.js');
    const result = await executeFleetBundleSell(fleet.id, tokenAddress, pct, slippage);

    res.json(result);
  } catch (err: any) {
    logger.error('Failed to execute bundle sell', err);
    res.status(500).json({ error: err.message || 'Bundle sell failed' });
  }
});

// 7. Fleet Holdings & Performance
router.get('/fleet/holdings', async (req, res) => {
  try {
    const user = await resolveFleetUser(req);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const { buildFleetHoldingsView } = await import('../raceFleet.js');
    const view = await buildFleetHoldingsView(user.telegram_id, req.query.refresh === 'true');

    const { getRaceFleetByUserId, getRaceFleetFills } = await import('@racerbot/db');
    const fleet = await getRaceFleetByUserId(user.id);
    let fills: any[] = [];
    if (fleet) {
      fills = await getRaceFleetFills(fleet.id).catch(() => []);
    }

    res.json({
      success: true,
      summaryText: view.text,
      fills,
    });
  } catch (err: any) {
    logger.error('Failed to get fleet holdings', err);
    res.status(500).json({ error: err.message || 'Failed to fetch fleet holdings' });
  }
});

export function serveRacerHtml(res: import('express').Response): void {
  const htmlPaths = [
    path.resolve(__dirname, 'racer.html'),
    path.resolve(__dirname, '..', 'racer.html'),
    path.resolve(__dirname, '..', 'src', 'racer.html'),
    path.resolve(__dirname, '..', '..', 'src', 'racer.html'),
  ];
  const htmlFile = htmlPaths.find(p => fs.existsSync(p));
  if (!htmlFile) {
    res.status(404).send('RACER Ecosystem page not found');
    return;
  }
  sendStaticHtml(res, htmlFile);
}


export function serveBubbleMapHtml(res: import('express').Response): void {
  const htmlPaths = [
    path.resolve(__dirname, 'bubblemap.html'),
    path.resolve(__dirname, '..', 'bubblemap.html'),
    path.resolve(__dirname, '..', 'src', 'bubblemap.html'),
    path.resolve(__dirname, '..', '..', 'src', 'bubblemap.html'),
  ];
  const htmlFile = htmlPaths.find(p => fs.existsSync(p));
  if (!htmlFile) {
    res.status(404).send('Bubble map not found');
    return;
  }
  sendStaticHtml(res, htmlFile);
}



export async function getSnapshotLeaderboard(limit = 30) {
  try {
    const { getDb } = await import('@racerbot/db');
    const db = await getDb();
    const res = await db.query(`
      SELECT 
        COALESCE(u.subaccount_id, 'racer-' || SUBSTRING(u.id::text, 1, 8) || '.near') as wallet,
        SUM(p.points::numeric) as total_points,
        COUNT(p.id) as point_events,
        MAX(p.created_at) as last_activity
      FROM points_ledger p
      JOIN users u ON p.user_id = u.id
      GROUP BY u.subaccount_id, u.id
      ORDER BY total_points DESC
      LIMIT $1
    `, [limit]);

    return res.rows.map((r: any, idx: number) => {
      let wallet = String(r.wallet || '');
      // Strict privacy protection: NEVER expose Telegram username
      if (wallet.endsWith('.tg')) {
        wallet = 'tg-' + wallet.slice(0, 3) + '***.near';
      }
      const pts = Math.round(parseFloat(r.total_points || '0'));
      let tier = 'Bronze';
      if (idx === 0) tier = 'Grandmaster';
      else if (idx < 3) tier = 'Master Whale';
      else if (idx < 10) tier = 'Diamond Elite';
      else if (pts >= 1000) tier = 'Gold Trader';
      else if (pts >= 500) tier = 'Silver';

      return {
        rank: idx + 1,
        wallet,
        points: pts,
        events: parseInt(r.point_events || '0', 10),
        last_activity: r.last_activity ? new Date(r.last_activity) : null,
        tier,
      };
    });
  } catch (err: any) {
    logger.warn('Failed to query snapshot points leaderboard', { error: err?.message });
    return [];
  }
}

export async function serveCompetitionHtml(res: import('express').Response, compIdParam = 'kookdog'): Promise<void> {
  const htmlPaths = [
    path.resolve(__dirname, 'competition.html'),
    path.resolve(__dirname, '..', 'competition.html'),
    path.resolve(__dirname, '..', 'src', 'competition.html'),
    path.resolve(__dirname, '..', '..', 'src', 'competition.html'),
  ];
  const htmlFile = htmlPaths.find(p => fs.existsSync(p));
  if (!htmlFile) {
    res.status(404).send('Competition page not found');
    return;
  }

  let html = fs.readFileSync(htmlFile, 'utf8');

  // Pre-fetch live competition data so the page renders immediately with active stats on first load.
  // Time-boxed: this runs before ANY byte is sent, so a slow RPC used to hold the whole page.
  // The page fetches live data itself, so on timeout we just skip the injection.
  const PREFETCH_BUDGET_MS = 2500;
  await Promise.race([(async () => {
  try {
    const compId = compIdParam || 'kookdog';
    const tokenAddress = (compId === 'kookdog' || compId === 'kookdog-42db38')
      ? 'kookdog-42db38.launchpad.justhoot.near'
      : compId;

    const [tokenInfo, comp, snapshotLeaderboard] = await Promise.all([
      getTokenInfo(tokenAddress, false).catch(() => null),
      getCompetition('kookdog').catch(() => null),
      getSnapshotLeaderboard(30).catch(() => []),
    ]);

    const nearUsd = tokenInfo?.near_usd || await getNearUsdPrice().catch(() => 0);
    const currentMcapUsd = tokenInfo?.market_cap_usd || 0;
    const currentMcapNear = tokenInfo?.market_cap || 0;
    const currentPriceNear = parseFloat(tokenInfo?.price || '0');
    const currentPriceUsd = parseFloat(tokenInfo?.price_usd || '0');
    const startedAt = comp?.status === 'active' ? comp.started_at : null;

    const leaderboard = await getCompetitionLeaderboard(
      tokenAddress,
      startedAt,
      nearUsd,
      tokenInfo?.decimals ?? 18,
      10
    );

    const initialData = {
      id: comp?.id || compId,
      token_address: tokenAddress,
      token_name: tokenInfo?.name || comp?.token_name || 'Kook Dog',
      token_symbol: tokenInfo?.symbol || comp?.token_symbol || 'KOOKDOG',
      status: comp?.status || (currentMcapUsd >= 29000 ? 'active' : 'pending'),
      target_market_cap_usd: comp?.target_market_cap_usd || 29000,
      current_market_cap_usd: currentMcapUsd,
      current_market_cap_near: currentMcapNear,
      current_price_near: currentPriceNear,
      current_price_usd: currentPriceUsd,
      near_usd: nearUsd,
      started_at: comp?.started_at ?? null,
      leaderboard,
      snapshot_leaderboard: snapshotLeaderboard,
    };

    html = html.replace(
      '</head>',
      `<script>window.__INITIAL_COMPETITION_DATA__ = ${JSON.stringify(initialData).replace(/</g, '\\u003c')};</script></head>`
    );
  } catch (err: any) {
    logger.warn('Failed to pre-inject competition data', { error: err?.message });
  }
  })(), new Promise<void>((resolve) => setTimeout(resolve, PREFETCH_BUDGET_MS))]);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  sendHtmlBody(res, html);
}

// ── RacerAlpha page (served as static HTML) ───────────────────────────────────
router.get(['/alpha', '/raceralpha'], (_req, res) => {
  serveRacerAlphaHtml(res);
});

// ── RACER Main Ecosystem Hub page (served as static HTML) ─────────────────────
router.get(['/ecosystem', '/hub'], (_req, res) => {
  serveRacerHtml(res);
});

// ── Bubble Map page (served as static HTML) ───────────────────────────────────
// GET /api/bubblemap?token=<address>&symbol=TOKEN&name=Token+Name
// Returns the interactive holder bubble-map HTML app.
router.get('/bubblemap', (_req, res) => {
  serveBubbleMapHtml(res);
});

// ── The Fleet page (served as static HTML) ────────────────────────────────────
// GET /fleet or /racefleet
router.get(['/fleet', '/racefleet'], (_req, res) => {
  serveFleetHtml(res);
});

// ── Trading Competition page (served as static HTML) ──────────────────────────
// GET /api/competition or /api/competition/kookdog
router.get(['/competition', '/competition/kookdog', '/leaderboard/kookdog'], (_req, res) => {
  serveCompetitionHtml(res);
});


// ── Helper to fetch competition snapshot ──────────────────────────────────────
async function fetchCompetitionSnapshot(rawId = 'kookdog') {
  const compId = rawId.toLowerCase().trim();
  const tokenAddress = (compId === 'kookdog' || compId === 'kookdog-42db38')
    ? 'kookdog-42db38.launchpad.justhoot.near'
    : compId;

  const [tokenInfo, compFromDb, snapshotLeaderboard] = await Promise.all([
    getTokenInfo(tokenAddress, true).catch(() => null),
    getCompetition('kookdog').catch(() => null),
    getSnapshotLeaderboard(30).catch(() => []),
  ]);

  const nearUsd = tokenInfo?.near_usd || await getNearUsdPrice().catch(() => 0);
  const currentMcapUsd = tokenInfo?.market_cap_usd || 0;
  const currentMcapNear = tokenInfo?.market_cap || 0;
  const currentPriceNear = parseFloat(tokenInfo?.price || '0');
  const currentPriceUsd = parseFloat(tokenInfo?.price_usd || '0');

  let comp = compFromDb;
  if (!comp) {
    comp = await upsertCompetition({
      id: compId,
      token_address: tokenAddress,
      token_symbol: tokenInfo?.symbol || 'KOOKDOG',
      token_name: tokenInfo?.name || 'Kook Dog',
      target_market_cap_usd: 29000,
      status: currentMcapUsd >= 29000 ? 'active' : 'pending',
      started_at: currentMcapUsd >= 29000 ? new Date() : null,
    }).catch(() => null);
  } else if (comp.status === 'pending' && currentMcapUsd >= comp.target_market_cap_usd) {
    comp = await upsertCompetition({
      id: comp.id,
      token_address: comp.token_address,
      token_symbol: comp.token_symbol,
      token_name: comp.token_name,
      target_market_cap_usd: comp.target_market_cap_usd,
      status: 'active',
      started_at: comp.started_at || new Date(),
    }).catch(() => comp);
  }

  const startedAt = comp?.status === 'active' ? comp.started_at : null;
  const leaderboard = await getCompetitionLeaderboard(
    tokenAddress,
    startedAt,
    nearUsd,
    tokenInfo?.decimals ?? 18,
    10
  );

  return {
    id: comp?.id || compId,
    token_address: tokenAddress,
    token_name: tokenInfo?.name || comp?.token_name || 'Kook Dog',
    token_symbol: tokenInfo?.symbol || comp?.token_symbol || 'KOOKDOG',
    status: comp?.status || (currentMcapUsd >= 29000 ? 'active' : 'pending'),
    target_market_cap_usd: comp?.target_market_cap_usd || 29000,
    current_market_cap_usd: currentMcapUsd,
    current_market_cap_near: currentMcapNear,
    current_price_near: currentPriceNear,
    current_price_usd: currentPriceUsd,
    near_usd: nearUsd,
    started_at: comp?.started_at ?? null,
    leaderboard,
    snapshot_leaderboard: snapshotLeaderboard,
  };
}

// ── Snapshot Leaderboard standalone REST API ─────────────────────────────────
router.get(['/competition-snapshots', '/competition/snapshot-leaderboard', '/competition/snapshots'], async (_req, res) => {
  try {
    const list = await getSnapshotLeaderboard(50);
    res.json({ snapshot_leaderboard: list });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Real-Time SSE Stream for Competition Leaderboard ──────────────────────────
router.get(['/competition-stream', '/competition/:id/stream', '/competition/stream'], async (req, res) => {
  const compId = req.params.id || (req.query.token as string) || (req.query.id as string) || 'kookdog';

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  // Send initial data immediately
  try {
    const initial = await fetchCompetitionSnapshot(compId);
    res.write(`data: ${JSON.stringify(initial)}\n\n`);
  } catch {}

  // Stream updates every 1.5s
  const interval = setInterval(async () => {
    try {
      const data = await fetchCompetitionSnapshot(compId);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
      res.write(`: keep-alive\n\n`);
    }
  }, 1500);

  req.on('close', () => {
    clearInterval(interval);
    res.end();
  });
});

// ── Trading Competition data REST API ─────────────────────────────────────────
router.get(['/competition', '/competition/:id'], async (req, res) => {
  try {
    const rawId = req.params.id || (req.query.token as string) || (req.query.id as string) || 'kookdog';
    const data = await fetchCompetitionSnapshot(rawId);
    res.json(data);
  } catch (err: any) {
    logger.error('Competition API error', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Cache helper for holder & transfer analytics ────────────────────────────
interface CacheEntry<T> {
  data: T;
  expires: number;
}
const dataCache = new Map<string, CacheEntry<any>>();

function getCached<T>(key: string): T | null {
  const entry = dataCache.get(key);
  if (entry && entry.expires > Date.now()) return entry.data;
  return null;
}

function setCached<T>(key: string, data: T, ttlMs = 120_000): void {
  dataCache.set(key, { data, expires: Date.now() + ttlMs });
}

// ── FastNEAR / NearBlocks holders aggregator ────────────────────────────────
async function fetchHoldersForToken(token: string): Promise<Array<{ account: string; address: string; amount: string; pct: number }>> {
  const cacheKey = `holders:${token}`;
  const cached = getCached<Array<{ account: string; address: string; amount: string; pct: number }>>(cacheKey);
  if (cached) return cached;

  let rawHolders: Array<{ account: string; amount: string }> = [];

  // 1. FastNEAR Paid API top holders (/v1/ft/:token/top)
  const fastNearKey = (process.env.FASTNEAR_API_KEY || '').trim();
  if (fastNearKey) {
    try {
      const resp = await fetch(`https://api.fastnear.com/v1/ft/${encodeURIComponent(token)}/top`, {
        headers: {
          'Authorization': `Bearer ${fastNearKey}`,
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        const data: any = await resp.json();
        const accounts = data.accounts || [];
        if (accounts.length > 0) {
          rawHolders = accounts.map((a: any) => ({
            account: a.account_id,
            amount: a.balance || '0',
          }));
        }
      }
    } catch (err: any) {
      logger.warn('FastNEAR top holders error', { token, error: err.message });
    }
  }

  // 2. NearBlocks holders fallback
  if (rawHolders.length === 0) {
    try {
      const url = `https://api.nearblocks.io/v1/fts/${encodeURIComponent(token)}/holders?page=1&per_page=100`;
      const resp = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (compatible; RacerBot/1.0; +https://racer.trade)',
        },
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        const data: any = await resp.json();
        const raw = data.holders || data.data || [];
        if (raw.length > 0) {
          rawHolders = raw.map((h: any) => ({
            account: h.account,
            amount: h.amount || '0',
          }));
        }
      }
    } catch (err: any) {
      logger.warn('NearBlocks holders fallback error', { token, error: err.message });
    }
  }

  if (rawHolders.length === 0) {
    return [];
  }

  // Calculate percentages across holders
  let totalHoldersSupply = 0n;
  for (const h of rawHolders) {
    try {
      totalHoldersSupply += BigInt(h.amount || '0');
    } catch {}
  }

  const result = rawHolders.map((h) => {
    let pct = 0;
    if (totalHoldersSupply > 0n) {
      try {
        pct = Number((BigInt(h.amount || '0') * 10000n) / totalHoldersSupply) / 100;
      } catch {}
    }
    return {
      account: h.account,
      address: h.account,
      amount: h.amount,
      pct,
    };
  });

  setCached(cacheKey, result, 120_000);
  return result;
}

// ── Token transfers aggregator (detects wallet-to-wallet movements) ─────────
async function fetchTransfersForToken(token: string): Promise<Array<{
  from: string;
  to: string;
  amount: string;
  cause: string;
  tx: string;
  timestamp: string;
}>> {
  const cacheKey = `transfers:${token}`;
  const cached = getCached<any[]>(cacheKey);
  if (cached) return cached;

  const transfers: Array<{ from: string; to: string; amount: string; cause: string; tx: string; timestamp: string }> = [];
  const seen = new Set<string>();

  const headers = {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (compatible; RacerBot/1.0; +https://racer.trade)',
  };

  // Run FT transfers and account direct actions in parallel with bounded timeouts (4s max)
  const [ftsResult, acctResult] = await Promise.allSettled([
    fetch(`https://api.nearblocks.io/v1/fts/${encodeURIComponent(token)}/txns?page=1&per_page=50`, {
      headers,
      signal: AbortSignal.timeout(4000),
    }).then(r => (r.ok ? r.json() : null)).catch(() => null),
    fetch(`https://api.nearblocks.io/v1/account/${encodeURIComponent(token)}/txns?page=1&per_page=50`, {
      headers,
      signal: AbortSignal.timeout(4000),
    }).then(r => (r.ok ? r.json() : null)).catch(() => null),
  ]);

  // 1. Process FT transfers
  if (ftsResult.status === 'fulfilled' && ftsResult.value) {
    const data = ftsResult.value as any;
    for (const t of (data.txns || [])) {
      const from = t.involved_account_id;
      const to = t.affected_account_id;
      const amount = t.delta_amount || '0';
      if (from && to && from !== to) {
        const sig = `${from}->${to}:${t.transaction_hash}`;
        if (!seen.has(sig)) {
          seen.add(sig);
          transfers.push({
            from,
            to,
            amount: amount.toString(),
            cause: t.cause || 'TRANSFER',
            tx: t.transaction_hash || '',
            timestamp: t.block_timestamp || Date.now().toString(),
          });
        }
      }
    }
  }

  // 2. Process direct action logs
  if (acctResult.status === 'fulfilled' && acctResult.value) {
    const data = acctResult.value as any;
    for (const t of (data.txns || [])) {
      for (const act of (t.actions || [])) {
        const method = act.method;
        if (method === 'ft_transfer' || method === 'ft_transfer_call' || method === 'ft_resolve_transfer') {
          try {
            const args = typeof act.args === 'string' ? JSON.parse(act.args || '{}') : (act.args || {});
            const from = args.sender_id || t.predecessor_account_id || t.signer_account_id;
            const to = args.receiver_id;
            const amount = args.amount || '0';
            if (from && to && from !== to) {
              const sig = `${from}->${to}:${t.transaction_hash}`;
              if (!seen.has(sig)) {
                seen.add(sig);
                transfers.push({
                  from,
                  to,
                  amount: amount.toString(),
                  cause: method,
                  tx: t.transaction_hash || '',
                  timestamp: t.block_timestamp || Date.now().toString(),
                });
              }
            }
          } catch {}
        }
      }
    }
  }

  setCached(cacheKey, transfers, 120_000);
  return transfers;
}

// ── Holders endpoint ────────────────────────────────────────────────────────
// GET /api/holders/:token
router.get('/holders/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const holders = await fetchHoldersForToken(token);
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json({ holders });
  } catch (err: any) {
    logger.warn('Holders endpoint error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── Sybil & Common Funder / Cross-Wallet Identity Tracing ──────────────────
export interface IdentityLink {
  from: string;
  to: string;
  type: 'common_funder' | 'historical_transfer' | 'shared_exit' | 'co_creation';
  funder?: string;
  amount?: string;
  token?: string;
  detail: string;
  tx?: string;
  timestamp?: string;
}

export interface IdentityCluster {
  id: string;
  name: string;
  reason: string;
  funder?: string;
  funderAmountNear?: string;
  wallets: string[];
  totalPct: number;
  totalSells: number;
  colorIndex: number;
  isBundler: boolean;
}

async function fetchIdentityTracesForHolders(
  token: string,
  holders: Array<{ account: string; amount: string }>,
  transfers: Array<{ from: string; to: string; amount: string; cause: string; tx: string; timestamp: string }> = []
): Promise<{
  identityLinks: IdentityLink[];
  identityClusters: IdentityCluster[];
}> {
  const cacheKey = `identity:${token}`;
  const cached = getCached<{ identityLinks: IdentityLink[]; identityClusters: IdentityCluster[] }>(cacheKey);
  if (cached) return cached;

  const identityLinks: IdentityLink[] = [];
  const holderSet = new Set(holders.map(h => h.account));
  const funderToWallets = new Map<string, Array<{ account: string; initialNear?: string; txHash?: string }>>();

  // 1. Immediate link derivation from transfers between known holders
  const seenPeerLinks = new Set<string>();
  for (const tx of transfers) {
    if (holderSet.has(tx.from) && holderSet.has(tx.to) && tx.from !== tx.to) {
      const linkKey = `${tx.from}->${tx.to}`;
      if (!seenPeerLinks.has(linkKey)) {
        seenPeerLinks.add(linkKey);
        identityLinks.push({
          from: tx.from,
          to: tx.to,
          type: 'historical_transfer',
          token: 'FT',
          amount: tx.amount,
          detail: `Direct peer transfer detected (${tx.cause})`,
          tx: tx.tx,
          timestamp: tx.timestamp,
        });
      }
    }
  }

  // 2. Light gas funder inspection for top 4 holders max with strict 2.5s timeout
  const topHolders = holders.slice(0, 4);
  const realAddresses = topHolders.filter(
    h => (h.account.includes('.') || h.account.length === 64) && !h.account.includes('ref-finance') && !h.account.includes('wrap.near')
  );

  if (realAddresses.length > 0) {
    try {
      const scannedResults = await Promise.allSettled(
        realAddresses.map(async (h) => {
          try {
            const r = await fetch(`https://api.nearblocks.io/v1/account/${encodeURIComponent(h.account)}/txns?page=1&per_page=10`, {
              headers: {
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (compatible; RacerBot/1.0; +https://racer.trade)',
              },
              signal: AbortSignal.timeout(2500),
            });
            if (r.ok) {
              const data: any = await r.json();
              return { account: h.account, txns: data.txns || [] };
            }
          } catch {}
          return { account: h.account, txns: [] };
        })
      );

      for (const res of scannedResults) {
        if (res.status === 'fulfilled' && res.value) {
          const { account, txns } = res.value;
          for (const t of txns) {
            const signer = t.signer_account_id;
            const predecessor = t.predecessor_account_id;
            const receiver = t.receiver_account_id;

            // Direct peer interactions
            if (receiver && receiver !== account && receiver !== token && holderSet.has(receiver)) {
              const linkKey = `${account}->${receiver}`;
              if (!seenPeerLinks.has(linkKey)) {
                seenPeerLinks.add(linkKey);
                identityLinks.push({
                  from: account,
                  to: receiver,
                  type: 'historical_transfer',
                  token: 'NEAR',
                  detail: `Direct inter-wallet transaction (${signer === account ? 'Outbound' : 'Inbound'})`,
                  tx: t.transaction_hash || '',
                  timestamp: t.block_timestamp || Date.now().toString(),
                });
              }
            }

            // Gas / Inbound Funder identification
            if (
              predecessor &&
              predecessor !== account &&
              predecessor !== 'system' &&
              predecessor !== token &&
              !predecessor.includes('ref-finance') &&
              !predecessor.includes('wrap.near')
            ) {
              if (!funderToWallets.has(predecessor)) {
                funderToWallets.set(predecessor, []);
              }
              const list = funderToWallets.get(predecessor)!;
              if (!list.some(x => x.account === account)) {
                list.push({ account, txHash: t.transaction_hash });
              }
            }
          }
        }
      }

      // Connect wallets that share a common funder
      for (const [funder, list] of funderToWallets.entries()) {
        if (list.length >= 2) {
          for (let i = 0; i < list.length; i++) {
            for (let j = i + 1; j < list.length; j++) {
              identityLinks.push({
                from: list[i].account,
                to: list[j].account,
                type: 'common_funder',
                funder,
                detail: `Both wallets funded with gas by ${funder}`,
                tx: list[i].txHash || list[j].txHash || '',
                timestamp: Date.now().toString(),
              });
            }
          }
        }
      }
    } catch (err: any) {
      logger.warn('Identity traces error', { error: err.message });
    }
  }

  // Calculate Identity Clusters using Union-Find
  const parent = new Map<string, string>();
  function find(i: string): string {
    if (!parent.has(i)) parent.set(i, i);
    if (parent.get(i) !== i) parent.set(i, find(parent.get(i)!));
    return parent.get(i)!;
  }
  function union(i: string, j: string) {
    const rootI = find(i);
    const rootJ = find(j);
    if (rootI !== rootJ) parent.set(rootI, rootJ);
  }

  for (const link of identityLinks) {
    union(link.from, link.to);
  }

  // Calculate total supply base
  let totalTokenSupply = 0n;
  for (const h of holders) {
    try { totalTokenSupply += BigInt(h.amount || '0'); } catch {}
  }
  if (totalTokenSupply === 0n) totalTokenSupply = 1n;

  const clusterGroups = new Map<string, string[]>();
  for (const h of holders) {
    const root = find(h.account);
    if (!clusterGroups.has(root)) clusterGroups.set(root, []);
    clusterGroups.get(root)!.push(h.account);
  }

  const identityClusters: IdentityCluster[] = [];
  let clusterIdx = 0;

  for (const [, memberWallets] of clusterGroups.entries()) {
    if (memberWallets.length > 1) {
      let clusterSupply = 0n;
      for (const w of memberWallets) {
        const found = holders.find(h => h.account === w);
        if (found) {
          try { clusterSupply += BigInt(found.amount || '0'); } catch {}
        }
      }
      const totalPct = Number((clusterSupply * 10000n) / totalTokenSupply) / 100;

      // Find representative link for reason/funder
      const repLink = identityLinks.find(l => memberWallets.includes(l.from) && memberWallets.includes(l.to));
      const funder = repLink?.funder;
      const reason = repLink?.detail || `Inter-wallet activity & common transactions detected (${memberWallets.length} wallets)`;

      identityClusters.push({
        id: `cabal_${clusterIdx + 1}`,
        name: `Sybil Entity #${clusterIdx + 1}${funder ? ' (' + funder + ')' : ''}`,
        reason,
        funder,
        funderAmountNear: repLink?.amount,
        wallets: memberWallets,
        totalPct,
        totalSells: 0,
        colorIndex: clusterIdx % 6,
        isBundler: true,
      });
      clusterIdx++;
    }
  }

  const result = { identityLinks, identityClusters };
  setCached(cacheKey, result, 120_000);
  return result;
}

// ── Combined Bubble Map Data ────────────────────────────────────────────────
// GET /api/bubblemap-data/:token
router.get('/bubblemap-data/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const [holders, txns, meta, holdersCountObj] = await Promise.all([
      fetchHoldersForToken(token).catch(() => []),
      fetchTransfersForToken(token).catch(() => []),
      getTokenInfo(token, true).catch(() => null),
      fetchTokenHoldersCount(token).catch(() => null),
    ]);

    const { identityLinks, identityClusters } = await fetchIdentityTracesForHolders(token, holders, txns).catch(() => ({
      identityLinks: [],
      identityClusters: [],
    }));

    const totalHolders = holdersCountObj?.count || (meta as any)?.holders_count || (meta as any)?.holdersCount || holders.length;

    const m = meta as any;
    const decimals = Number(m?.decimals ?? 18);
    const normalizedMeta = m ? {
      ...m,
      symbol: m.symbol || m.name || '',
      decimals,
      priceUsd: m.price_usd !== undefined ? Number(m.price_usd) : Number(m.priceUsd || 0),
      priceChange24h: m.price_24h_change !== undefined ? Number(m.price_24h_change) : Number(m.priceChange24h || 0),
      marketCap: m.market_cap_usd !== undefined ? Number(m.market_cap_usd) : Number(m.market_cap || m.marketCap || 0),
      volume24h: m.volume_24h_usd !== undefined ? Number(m.volume_24h_usd) : Number(m.volume24h || 0),
      liquidity: m.liquidity_usd !== undefined ? Number(m.liquidity_usd) : Number(m.liquidity || 0),
      holdersCount: totalHolders,
    } : null;

    const enrichedHolders = holders.map((h: any) => {
      let formattedAmount = '';
      try {
        const rawBig = BigInt(h.amount || '0');
        formattedAmount = formatTokenUnits(rawBig, decimals, 4);
      } catch {
        formattedAmount = h.amount || '0';
      }
      return {
        ...h,
        decimals,
        formattedAmount,
      };
    });

    const enrichedTxns = txns.map((t: any) => {
      let formattedAmount = '';
      try {
        const rawBig = BigInt(t.amount || '0');
        formattedAmount = formatTokenUnits(rawBig, decimals, 4);
      } catch {
        formattedAmount = t.amount || '0';
      }
      return {
        ...t,
        decimals,
        formattedAmount,
      };
    });

    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.json({
      token,
      holders: enrichedHolders,
      totalHolders,
      txns: enrichedTxns,
      identityLinks,
      identityClusters,
      meta: normalizedMeta,
    });
  } catch (err: any) {
    logger.warn('BubbleMap data error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── Single Account Token Balance (for custom wallet search) ─────────────────
// GET /api/account-balance/:token/:account
router.get('/account-balance/:token/:account', async (req, res) => {
  try {
    const { token, account } = req.params;
    const cacheKey = `acct-bal:${token}:${account}`;
    const cached = getCached<{ account: string; token: string; balance: string }>(cacheKey);
    if (cached) {
      res.json(cached);
      return;
    }

    const fastNearKey = (process.env.FASTNEAR_API_KEY || '').trim();
    if (fastNearKey) {
      try {
        const r = await fetch(`https://api.fastnear.com/v1/account/${encodeURIComponent(account)}/ft`, {
          headers: { 'Authorization': `Bearer ${fastNearKey}` },
          signal: AbortSignal.timeout(4000),
        });
        if (r.ok) {
          const d: any = await r.json();
          const match = (d.tokens || []).find((t: any) => t.contract_id === token);
          const result = { account, token, balance: match?.balance || '0' };
          setCached(cacheKey, result, 30_000);
          res.json(result);
          return;
        }
      } catch (e: any) {
        logger.warn('FastNear account ft error', { account, error: e.message });
      }
    }
    res.json({ account, token, balance: '0' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Deep Wallet Forensics & Sell Speed Analytics ─────────────────────────────
// GET /api/wallet-forensics/:account
router.get('/wallet-forensics/:account', async (req, res) => {
  try {
    const { account } = req.params;
    const currentToken = ((req.query.currentToken as string) || '').trim();
    const cacheKey = `wallet-forensics:${account}`;
    const cached = getCached<any>(cacheKey);
    if (cached) {
      res.json(cached);
      return;
    }

    const fastNearKey = (process.env.FASTNEAR_API_KEY || '').trim();
    let otherTokens: Array<{ contract_id: string; symbol: string; balance: string }> = [];
    let txns: any[] = [];

    // Parallel fetch FT balances and recent account txns with bounded timeouts
    const [ftRes, txnsRes] = await Promise.allSettled([
      fetch(`https://api.fastnear.com/v1/account/${encodeURIComponent(account)}/ft${fastNearKey ? `?api_key=${fastNearKey}` : ''}`, {
        headers: fastNearKey ? { 'Authorization': `Bearer ${fastNearKey}` } : {},
        signal: AbortSignal.timeout(4000),
      }),
      fetch(`https://api.nearblocks.io/v1/account/${encodeURIComponent(account)}/txns?page=1&per_page=40`, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (compatible; RacerBot/1.0; +https://racer.trade)',
        },
        signal: AbortSignal.timeout(4000),
      }),
    ]);

    let rawFtTokens: any[] = [];
    if (ftRes.status === 'fulfilled' && ftRes.value.ok) {
      try {
        const ftData: any = await ftRes.value.json();
        rawFtTokens = ftData.tokens || [];
      } catch {}
    }

    if (txnsRes.status === 'fulfilled' && txnsRes.value.ok) {
      try {
        const txData: any = await txnsRes.value.json();
        txns = txData.txns || [];
      } catch {}
    }

    // Analyze trading velocity and hold speed
    const tokenTimeline = new Map<string, { acquiredAt?: number; soldAt?: number; sellCount: number; buyCount: number }>();

    for (const t of txns) {
      const ts = t.block_timestamp ? Math.floor(Number(t.block_timestamp) / 1_000_000) : Date.now();
      const signer = t.signer_account_id;
      const receiver = t.receiver_account_id;

      for (const act of (t.actions || [])) {
        const method = act.method || '';
        if (signer === account && (method.includes('ft_transfer') || method === 'swap' || method.includes('sell'))) {
          const tok = receiver || t.receiver_account_id || '';
          if (!tokenTimeline.has(tok)) tokenTimeline.set(tok, { sellCount: 0, buyCount: 0 });
          const entry = tokenTimeline.get(tok)!;
          entry.sellCount++;
          if (!entry.soldAt || ts > entry.soldAt) entry.soldAt = ts;
        }
        if (receiver === account && (method.includes('ft_transfer') || method === 'swap' || method.includes('buy'))) {
          const tok = signer || t.predecessor_account_id || '';
          if (!tokenTimeline.has(tok)) tokenTimeline.set(tok, { sellCount: 0, buyCount: 0 });
          const entry = tokenTimeline.get(tok)!;
          entry.buyCount++;
          if (!entry.acquiredAt || ts < entry.acquiredAt) entry.acquiredAt = ts;
        }
      }
    }

    // Fetch current approximate block height to calculate exact block-based durations
    let currentBlockHeight = 221943000;
    try {
      const bRes = await fetch('https://rpc.mainnet.fastnear.com', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'bh', method: 'block', params: { finality: 'final' } }),
        signal: AbortSignal.timeout(1500),
      });
      if (bRes.ok) {
        const bData: any = await bRes.json();
        const h = Number(bData.result?.header?.height);
        if (h > 0) currentBlockHeight = h;
      }
    } catch {}

    const formatMinsToDuration = (diffMins: number): string => {
      if (diffMins < 60) return `${diffMins}m`;
      const hours = Math.round(diffMins / 60);
      if (hours < 24) return `${hours}h`;
      const days = Math.round(hours / 24);
      if (days < 30) return `${days}d`;
      return `${(days / 30).toFixed(1)}mo (${days}d)`;
    };

    // Calculate current target token holding duration for this wallet
    let currentTokenHoldDurationStr = '—';
    let currentTokenHoldMinutes = 0;
    if (currentToken && rawFtTokens.length > 0) {
      const curMatch = rawFtTokens.find((t: any) => t.contract_id === currentToken);
      if (curMatch) {
        const lastBlock = Number(curMatch.last_update_block_height || 0);
        const timeline = tokenTimeline.get(currentToken);
        if (timeline?.acquiredAt) {
          const diffMs = Math.max(0, Date.now() - timeline.acquiredAt);
          currentTokenHoldMinutes = Math.max(1, Math.round(diffMs / 60_000));
          currentTokenHoldDurationStr = formatMinsToDuration(currentTokenHoldMinutes);
        } else if (lastBlock > 0 && currentBlockHeight > lastBlock) {
          const diffSeconds = (currentBlockHeight - lastBlock) * 1.05;
          currentTokenHoldMinutes = Math.max(1, Math.round(diffSeconds / 60));
          currentTokenHoldDurationStr = formatMinsToDuration(currentTokenHoldMinutes);
        } else if (txns.length > 0) {
          const oldestTs = Math.floor(Number(txns[txns.length - 1].block_timestamp || 0) / 1_000_000);
          if (oldestTs > 0) {
            const diffMs = Math.max(0, Date.now() - oldestTs);
            currentTokenHoldMinutes = Math.max(1, Math.round(diffMs / 60_000));
            currentTokenHoldDurationStr = formatMinsToDuration(currentTokenHoldMinutes);
          }
        }
      }
    }

    // Calculate hold duration for other tokens currently held in portfolio
    otherTokens = rawFtTokens
      .filter((t: any) => t.contract_id !== currentToken)
      .map((t: any) => {
        const cid = t.contract_id || '';
        const sym = (cid.split('.')[0] || cid).toUpperCase();
        const timeline = tokenTimeline.get(cid);
        const lastBlock = Number(t.last_update_block_height || 0);

        let holdDurationMinutes = 0;
        let holdDurationStr = 'Recent';

        if (timeline?.acquiredAt) {
          const diffMs = Math.max(0, Date.now() - timeline.acquiredAt);
          holdDurationMinutes = Math.max(1, Math.round(diffMs / 60_000));
          holdDurationStr = formatMinsToDuration(holdDurationMinutes);
        } else if (lastBlock > 0 && currentBlockHeight > lastBlock) {
          const diffSeconds = (currentBlockHeight - lastBlock) * 1.05;
          holdDurationMinutes = Math.max(1, Math.round(diffSeconds / 60));
          holdDurationStr = formatMinsToDuration(holdDurationMinutes);
        } else if (txns.length > 0) {
          const oldestTs = Math.floor(Number(txns[txns.length - 1].block_timestamp || 0) / 1_000_000);
          if (oldestTs > 0) {
            const days = Math.max(1, Math.round((Date.now() - oldestTs) / 86_400_000));
            holdDurationMinutes = days * 1440;
            holdDurationStr = `${days}d+`;
          }
        }

        return {
          contract_id: cid,
          symbol: sym,
          balance: t.balance || '0',
          holdDurationStr,
          holdDurationMinutes,
          lastUpdateBlock: lastBlock,
        };
      });

    const durationsMs: number[] = [];
    let fastDumpCount = 0;
    let completedExits = 0;
    const pastTrades: Array<{
      token: string;
      symbol: string;
      holdDurationMinutes: number;
      holdDurationStr: string;
      holdStr: string;
      exitType: string;
      isInstantDump: boolean;
      isQuickDump: boolean;
      soldAt?: number;
      acquiredAt?: number;
    }> = [];

    for (const [tok, data] of tokenTimeline.entries()) {
      if (!tok || tok === 'system' || tok.includes('wrap.near')) continue;
      const sym = (tok.split('.')[0] || tok).toUpperCase();
      if (data.acquiredAt && data.soldAt && data.soldAt >= data.acquiredAt) {
        const diffMs = data.soldAt - data.acquiredAt;
        const diffMins = Math.max(1, Math.round(diffMs / 60_000));
        durationsMs.push(diffMs);
        completedExits++;
        const isFast = diffMins <= 30;
        if (isFast) fastDumpCount++;

        const durationStr = formatMinsToDuration(diffMins);

        pastTrades.push({
          token: tok,
          symbol: sym,
          holdDurationMinutes: diffMins,
          holdDurationStr: durationStr,
          holdStr: durationStr,
          exitType: diffMins <= 5 ? 'Instant Dump' : (diffMins <= 30 ? 'Quick Scalp' : (diffMins <= 720 ? 'Intraday Exit' : 'Swing / Long Hold')),
          isInstantDump: diffMins <= 5,
          isQuickDump: isFast,
          soldAt: data.soldAt,
          acquiredAt: data.acquiredAt,
        });
      }
    }

    let avgHoldMinutes = currentTokenHoldMinutes > 0 ? currentTokenHoldMinutes : 45;
    if (durationsMs.length > 0) {
      const avgMs = durationsMs.reduce((a, b) => a + b, 0) / durationsMs.length;
      avgHoldMinutes = Math.max(1, Math.round(avgMs / 60_000));
    } else if (currentTokenHoldMinutes > 0) {
      avgHoldMinutes = currentTokenHoldMinutes;
    }

    const avgHoldStr = formatMinsToDuration(avgHoldMinutes);

    const dumpRate30m = completedExits > 0 ? Math.round((fastDumpCount / completedExits) * 100) : (txns.length > 20 ? 15 : 35);

    let speedClassification = 'Swing Trader (Hours+)';
    let hazardLevel = 'Low';
    let hazardColor = '#34D399';
    let hazardScore = 20;

    if (avgHoldMinutes <= 5 || dumpRate30m >= 75) {
      speedClassification = '⚡ Instant Dumper (< 5 mins)';
      hazardLevel = 'Extreme Sell Hazard';
      hazardColor = '#FF6B73';
      hazardScore = 92;
    } else if (avgHoldMinutes <= 30 || dumpRate30m >= 45) {
      speedClassification = '🔥 Fast Scalper (< 30 mins)';
      hazardLevel = 'High Dump Hazard';
      hazardColor = '#F0AD4E';
      hazardScore = 70;
    } else if (avgHoldMinutes <= 360) {
      speedClassification = '⏱️ Short-Term Trader (< 6 hours)';
      hazardLevel = 'Moderate Hazard';
      hazardColor = '#A992D6';
      hazardScore = 45;
    } else {
      speedClassification = '💎 Diamond Hand / Investor (Days+)';
      hazardLevel = 'Low Sell Hazard';
      hazardColor = '#34D399';
      hazardScore = 15;
    }

    const stats = {
      speedClassification,
      hazardLevel,
      hazardColor,
      hazardScore,
      avgHoldMinutes,
      avgHoldStr,
      currentTokenHoldDurationStr,
      currentTokenHoldMinutes,
      dumpRate30m,
      completedExits,
      totalTxnsScanned: txns.length,
    };

    const payload = {
      account,
      stats,
      speedClassification,
      hazardLevel,
      hazardColor,
      hazardScore,
      avgHoldMinutes,
      avgHoldStr,
      currentTokenHoldDurationStr,
      currentTokenHoldMinutes,
      dumpRate30m,
      completedExits,
      otherTokensCount: otherTokens.length,
      otherTokens: otherTokens.slice(0, 20),
      pastTrades: pastTrades.slice(0, 15),
      totalTxnsScanned: txns.length,
    };

    setCached(cacheKey, payload, 60_000);
    res.json(payload);
  } catch (err: any) {
    logger.warn('Wallet forensics error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
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

// ── Trading (swaps via executor with 1.5% platform fee) ──────────────────────

router.post('/swap', ensureTelegramUser, perUserRateLimit(60000, 30), async (req, res) => {
  try {
    const userId = (req as any).userId;
    const tokenAddress = req.body.tokenAddress;
    const amountNear = req.body.amountNear;

    if (!tokenAddress || !amountNear) {
      res.status(400).json({ error: 'Missing required fields: tokenAddress, amountNear' });
      return;
    }

    const numNear = Number(amountNear);
    if (typeof tokenAddress !== 'string' || !tokenAddress.trim() || !Number.isFinite(numNear) || numNear <= 0) {
      res.status(400).json({ error: 'tokenAddress and a positive amountNear are required' });
      return;
    }
    const feePct = 1.5;
    const feeNear = Number((numNear * 0.015).toFixed(6));
    const netNear = Number((numNear - feeNear).toFixed(6));

    const amountYocto = (BigInt(Math.floor(numNear * 1e6)) * 1000000000000000000n).toString();
    
    const result = await publishSwap({
      user_id: userId,
      token_in: 'near',
      token_out: tokenAddress,
      amount_in: amountYocto,
      min_amount_out: '0',
      venue: req.body.venue || 'rhea',
    });

    res.json({
      success: true,
      grossAmountNear: numNear,
      feePct,
      feeNear,
      netAmountNear: netNear,
      treasury: TREASURY_ACCOUNT_ID,
      ...result,
    });
  } catch (err: any) {
    logger.error('Swap failed', err);
    res.status(500).json({ error: err.message });
  }
});

// ── RacerAlpha Copy Trade Execution across ALL Launchpads & DEXes with 1.5% Fee ──
router.post('/alpha/copy-trade', perUserRateLimit(60000, 30), async (req, res) => {
  try {
    const user = await resolveAlphaUser(req);
    if (!user) {
      res.status(401).json({ error: 'Please connect your NEAR wallet or Telegram to trade.' });
      return;
    }

    const { tokenAddress, amountNear, traderId, slippagePct, venue: explicitVenue } = req.body;
    const numNear = Number(amountNear);
    if (typeof tokenAddress !== 'string' || !tokenAddress.trim() || !Number.isFinite(numNear) || numNear <= 0 || typeof traderId !== 'string' || !traderId.trim()) {
      res.status(400).json({ error: 'tokenAddress, traderId, and a positive amountNear are required' });
      return;
    }

    const db = await (await import('@racerbot/db')).getDb();
    const access = await db.query(
      `SELECT t.user_id,
              EXISTS (
                SELECT 1 FROM racer_alpha_keys k
                WHERE k.trader_id = t.id AND k.buyer_user_id = $2 AND k.payment_status = 'completed'
              ) AS has_key
       FROM racer_alpha_traders t
       WHERE t.id = $1 AND t.is_active = TRUE AND t.user_id <> 'system_alpha'`,
      [traderId, user.id]
    );
    if (!access.rows[0]) {
      res.status(404).json({ error: 'The RacerAlpha trader was not found.' });
      return;
    }
    if (access.rows[0].user_id !== user.id && !access.rows[0].has_key) {
      res.status(403).json({ error: 'Purchase this trader’s viewing key before copying their signals.' });
      return;
    }

    const feePct = 1.5;
    const feeNear = Number((numNear * 0.015).toFixed(6));
    const netNear = Number((numNear - feeNear).toFixed(6));
    const amountYocto = (BigInt(Math.floor(numNear * 1e6)) * 1000000000000000000n).toString();

    // Dynamically infer venue across NearlyTrade, MemeCooking, Shards, Intear, and Rhea
    const { inferVenueFromToken } = await import('../racerAlpha.js');
    const venue = explicitVenue || inferVenueFromToken(tokenAddress);

    const result = await publishSwap({
      user_id: user.id,
      token_in: 'near',
      token_out: tokenAddress,
      amount_in: amountYocto,
      min_amount_out: '0',
      venue: venue as any,
      slippage_pct: Number(slippagePct) || 2,
    }, undefined, { suppressAlphaSignal: true });

    if (result.success !== false) {
      // Send confirmation to Telegram if user has linked Telegram
      if (user.telegram_id) {
        try {
          const { getBotInstance } = await import('../notify.js');
          const bot = getBotInstance();
          if (bot) {
            bot.telegram.sendMessage(
              user.telegram_id,
              `🏎️ <b>RacerAlpha Copy Trade Executed!</b>\n\n` +
              `🪙 <b>Token</b>: <code>${tokenAddress}</code>\n` +
              `🏛️ <b>Venue</b>: <code>${venue.toUpperCase()}</code>\n` +
              `💵 <b>Gross Trade</b>: <code>${numNear} NEAR</code>\n` +
              `⚡ <b>Platform Fee (1.5%)</b>: <code>${feeNear} NEAR</code>\n` +
              `🎯 <b>Net Swapped</b>: <code>${netNear} NEAR</code>\n` +
              (result.txHash ? `🔗 <b>Tx</b>: <code>${result.txHash.slice(0, 16)}...</code>\n\n` : '\n') +
              `<i>Executed through RacerBot's managed ${venue.toUpperCase()} swap route.</i>`,
              { parse_mode: 'HTML' }
            ).catch(() => {});
          }
        } catch {}
      }
    }

    res.json({
      success: result.success !== false,
      grossAmountNear: numNear,
      feePct,
      feeNear,
      netAmountNear: netNear,
      venue,
      treasury: TREASURY_ACCOUNT_ID,
      ...result,
    });
  } catch (err: any) {
    logger.error('Alpha copy trade failed', err);
    res.status(500).json({ error: err?.message || 'Trade execution failed' });
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
    const info = await getTokenInfo(req.params.address, true);
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

// ── 1Click Multi-Chain Deposit REST Endpoints ──────────────────────────────
router.get('/deposit/chains', async (_req, res) => {
  try {
    const { SUPPORTED_CHAINS } = await import('../multichainDeposit.js');
    res.json({ success: true, chains: Object.values(SUPPORTED_CHAINS) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/deposit/tokens', async (req, res) => {
  try {
    const { getTokensForChain, getMinimumDeposit } = await import('../multichainDeposit.js');
    const chainId = String(req.query.chain || 'sol').toLowerCase();
    const tokens = getTokensForChain(chainId);
    const enriched = tokens.map(t => ({
      ...t,
      minDeposit: getMinimumDeposit(t),
    }));
    res.json({ success: true, chain: chainId, tokens: enriched });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/deposit/quote', async (req, res) => {
  try {
    const { create1ClickDepositQuote, getTokensForChain } = await import('../multichainDeposit.js');
    const { chain, symbol, amount, subaccountId, telegramId } = req.body;

    if (!subaccountId || !amount) {
      res.status(400).json({ error: 'subaccountId and amount are required' });
      return;
    }

    const chainTokens = getTokensForChain((chain || 'sol').toLowerCase());
    const token = chainTokens.find(t => (t.symbol || '').toUpperCase() === (symbol || 'SOL').toUpperCase()) || chainTokens[0];

    if (!token) {
      res.status(400).json({ error: `No token found for chain: ${chain} symbol: ${symbol}` });
      return;
    }

    const record = await create1ClickDepositQuote({
      telegramId: Number(telegramId) || 9900000001,
      subaccountId,
      token,
      amount: Number(amount),
    });

    res.json({
      success: true,
      depositId: record.deposit_id,
      depositAddress: record.deposit_address,
      sourceChain: record.source_chain,
      sourceSymbol: record.source_symbol,
      sourceAmount: record.source_amount,
      minNearOut: record.min_destination_amount,
      destinationAddress: record.destination_address,
      status: record.status,
      deadlineMinutes: 30,
    });
  } catch (err: any) {
    logger.error('1Click quote generation failed', err);
    res.status(500).json({ error: err.message || 'Failed to generate 1Click quote' });
  }
});

router.get('/deposit/status', async (req, res) => {
  try {
    const { check1ClickDepositStatus } = await import('../multichainDeposit.js');
    const depositAddress = String(req.query.address || '');
    if (!depositAddress) {
      res.status(400).json({ error: 'address parameter required' });
      return;
    }
    const status = await check1ClickDepositStatus(depositAddress);
    res.json({ success: true, ...status });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;