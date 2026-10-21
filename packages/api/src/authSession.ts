import crypto from 'crypto';
import { createLogger, createRedis, encrypt, isValidNearAccountId, type RedisClient } from '@racerbot/shared';
import {
  getUserByTelegramId,
  getUserById,
  createUserWallet,
  getUserWallets,
  syncUserActiveWallet,
  type UserRecord,
  type UserWalletRecord,
} from '@racerbot/db';
import { REDIS_URL, MASTER_KEY, PUBLIC_URL, TELEGRAM_BOT_TOKEN } from './config.js';
import { getBotInstance } from './notify.js';
import { createSubaccount } from './wallet.js';

const logger = createLogger('auth-session');

export interface AuthSessionData {
  sessionId: string;
  status: 'pending' | 'linked' | 'expired';
  createdAt: number;
  userId?: string;
  telegramId?: number;
  username?: string;
  firstName?: string;
  authToken?: string;
  linkedAt?: number;
}

// In-memory fallback if Redis is temporarily unreachable
const inMemorySessions = new Map<string, AuthSessionData>();
const inMemoryTokens = new Map<string, { userId: string; telegramId: number; expiresAt: number }>();
const inMemoryWalletChallenges = new Map<string, WalletAuthChallenge>();

interface WalletAuthChallenge {
  accountId: string;
  message: string;
  nonce: string;
  recipient: string;
  expiresAt: number;
}

export interface WalletAuthProof {
  challengeId: string;
  accountId: string;
  message: string;
  nonce: string;
  recipient: string;
  publicKey: string;
  signature: string;
}

const WALLET_CHALLENGE_TTL_SECONDS = 300;
const WALLET_AUTH_RECIPIENT = process.env.WALLET_AUTH_RECIPIENT ||
  (PUBLIC_URL ? new URL(PUBLIC_URL).host : 'racerbot.trade');

let _authRedis: RedisClient | null = null;
function getAuthRedis(): RedisClient | null {
  if (!_authRedis && REDIS_URL) {
    try {
      _authRedis = createRedis(REDIS_URL);
    } catch (err: any) {
      logger.warn('Failed to initialize Redis for auth sessions, using memory fallback:', err?.message);
      _authRedis = null;
    }
  }
  return _authRedis;
}

const SESSION_TTL_SECONDS = 600; // 10 minutes
const TOKEN_TTL_SECONDS = 30 * 24 * 3600; // 30 days

/**
 * 1. Create a new auth session requested by the WebApp
 */
export async function createAuthSession(): Promise<{ sessionId: string; deepLink: string }> {
  const sessionId = 'sess_' + crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  const sessionData: AuthSessionData = {
    sessionId,
    status: 'pending',
    createdAt: now,
  };

  const redis = getAuthRedis();
  if (redis) {
    await redis.set(`auth:session:${sessionId}`, JSON.stringify(sessionData), SESSION_TTL_SECONDS);
  } else {
    inMemorySessions.set(sessionId, sessionData);
  }

  const botUsername = process.env.BOT_USERNAME || 'racertradingbot';
  const deepLink = `https://t.me/${botUsername}?start=auth_${sessionId}`;

  return { sessionId, deepLink };
}

/**
 * 2. Link a Telegram user to a pending auth session when they click /start auth_<sessionId>
 */
export async function linkAuthSession(
  sessionId: string,
  telegramUser: { id: number; username?: string; first_name?: string }
): Promise<{ success: boolean; session?: AuthSessionData; user?: UserRecord; reason?: string }> {
  const redis = getAuthRedis();
  let sessionData: AuthSessionData | null = null;

  if (redis) {
    const raw = await redis.get(`auth:session:${sessionId}`);
    if (raw) {
      try {
        sessionData = JSON.parse(raw);
      } catch {}
    }
  } else {
    sessionData = inMemorySessions.get(sessionId) || null;
  }

  if (!sessionData) {
    return { success: false, reason: 'Session not found or expired' };
  }

  if (sessionData.status === 'linked') {
    return { success: true, session: sessionData };
  }

  // Ensure user exists in Postgres
  let user = await getUserByTelegramId(telegramUser.id);
  if (!user) {
    const created = await createSubaccount(telegramUser.id, telegramUser.username);
    user = await getUserById(created.userId);
  }

  if (!user) {
    return { success: false, reason: 'Failed to find or create user profile' };
  }

  // Generate long-lived WebApp auth token (bearer token)
  const authToken = 'racer_tok_' + crypto.randomBytes(24).toString('hex');

  sessionData.status = 'linked';
  sessionData.userId = user.id;
  sessionData.telegramId = telegramUser.id;
  sessionData.username = telegramUser.username;
  sessionData.firstName = telegramUser.first_name;
  sessionData.authToken = authToken;
  sessionData.linkedAt = Date.now();

  const tokenPayload = {
    userId: user.id,
    telegramId: telegramUser.id,
    expiresAt: Date.now() + TOKEN_TTL_SECONDS * 1000,
  };

  if (redis) {
    await redis.set(`auth:session:${sessionId}`, JSON.stringify(sessionData), SESSION_TTL_SECONDS);
    await redis.set(`auth:token:${authToken}`, JSON.stringify(tokenPayload), TOKEN_TTL_SECONDS);
  } else {
    inMemorySessions.set(sessionId, sessionData);
    inMemoryTokens.set(authToken, tokenPayload);
  }

  return { success: true, session: sessionData, user };
}

/**
 * 3. Query the status of an auth session (polled by WebApp)
 */
export async function getAuthSession(sessionId: string): Promise<AuthSessionData | null> {
  const redis = getAuthRedis();
  if (redis) {
    const raw = await redis.get(`auth:session:${sessionId}`);
    if (raw) {
      try {
        return JSON.parse(raw);
      } catch {}
    }
    return null;
  }
  return inMemorySessions.get(sessionId) || null;
}

/**
 * 4. Verify an auth token sent in the Authorization: Bearer header
 */
export async function verifyAuthToken(token: string): Promise<{ userId: string; telegramId: number } | null> {
  if (!token) return null;
  const redis = getAuthRedis();

  if (redis) {
    try {
      const raw = await redis.get(`auth:token:${token}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.expiresAt && Date.now() <= parsed.expiresAt) {
          return { userId: parsed.userId, telegramId: parsed.telegramId };
        }
      }
    } catch (err: any) {
      logger.warn('Redis auth token lookup failed; checking process-local session:', err?.message);
    }
  }

  const mem = inMemoryTokens.get(token);
  if (mem) {
    if (Date.now() > mem.expiresAt) {
      inMemoryTokens.delete(token);
      return null;
    }
    return { userId: mem.userId, telegramId: mem.telegramId };
  }

  return null;
}

export async function createWalletAuthChallenge(accountIdInput: string): Promise<{
  challengeId: string;
  accountId: string;
  message: string;
  nonce: string;
  recipient: string;
}> {
  const accountId = accountIdInput.trim().toLowerCase();
  if (!isValidNearAccountId(accountId)) {
    throw new Error('Enter a valid NEAR account ID.');
  }

  const challengeId = crypto.randomBytes(24).toString('hex');
  const nonce = crypto.randomBytes(32).toString('base64');
  const message = `Sign in to RacerBot\nAccount: ${accountId}\nChallenge: ${crypto.randomBytes(16).toString('hex')}`;
  const challenge: WalletAuthChallenge = {
    accountId,
    message,
    nonce,
    recipient: WALLET_AUTH_RECIPIENT,
    expiresAt: Date.now() + WALLET_CHALLENGE_TTL_SECONDS * 1000,
  };

  const redis = getAuthRedis();
  if (redis) {
    await redis.set(`auth:wallet-challenge:${challengeId}`, JSON.stringify(challenge), WALLET_CHALLENGE_TTL_SECONDS);
  } else {
    inMemoryWalletChallenges.set(challengeId, challenge);
  }

  return { challengeId, accountId, message, nonce, recipient: challenge.recipient };
}

async function consumeWalletAuthChallenge(challengeId: string): Promise<WalletAuthChallenge | null> {
  const redis = getAuthRedis();
  if (redis) {
    const result = await redis.eval(
      "local value = redis.call('GET', KEYS[1]); if value then redis.call('DEL', KEYS[1]); end; return value",
      1,
      `auth:wallet-challenge:${challengeId}`
    );
    if (typeof result !== 'string') return null;
    return JSON.parse(result) as WalletAuthChallenge;
  }

  const challenge = inMemoryWalletChallenges.get(challengeId) || null;
  inMemoryWalletChallenges.delete(challengeId);
  return challenge;
}

export async function verifyWalletAuthProof(proof: WalletAuthProof): Promise<void> {
  if (!proof || typeof proof.challengeId !== 'string' || !/^[a-f0-9]{48}$/.test(proof.challengeId)) {
    throw new Error('Wallet authentication challenge is invalid or expired.');
  }

  const challenge = await consumeWalletAuthChallenge(proof.challengeId);
  if (!challenge || Date.now() > challenge.expiresAt) {
    throw new Error('Wallet authentication challenge is invalid or expired. Please reconnect.');
  }

  const accountId = proof.accountId.trim().toLowerCase();
  const nonce = Buffer.from(proof.nonce || '', 'base64');
  const expectedNonce = Buffer.from(challenge.nonce, 'base64');
  if (
    accountId !== challenge.accountId ||
    proof.message !== challenge.message ||
    proof.recipient !== challenge.recipient ||
    nonce.length !== 32 ||
    !crypto.timingSafeEqual(nonce, expectedNonce) ||
    !proof.publicKey ||
    !proof.signature
  ) {
    throw new Error('Wallet authentication proof does not match the issued challenge.');
  }

  const { verifySignature, verifyFullKeyBelongsToUser } = await import('@near-wallet-selector/core');
  const validSignature = verifySignature({
    publicKey: proof.publicKey,
    signature: proof.signature,
    message: challenge.message,
    nonce,
    recipient: challenge.recipient,
  });
  if (!validSignature) {
    throw new Error('The NEAR wallet signature is invalid.');
  }

  const ownsAccountKey = await verifyFullKeyBelongsToUser({
    publicKey: proof.publicKey,
    accountId,
    network: {
      networkId: 'mainnet',
      nodeUrl: process.env.NEAR_RPC_URL || 'https://rpc.mainnet.near.org',
      helperUrl: 'https://helper.mainnet.near.org',
      explorerUrl: 'https://nearblocks.io',
      indexerUrl: 'https://api.nearblocks.io',
    },
  });
  if (!ownsAccountKey) {
    throw new Error('The signing key is not a full-access key for this NEAR account.');
  }
}

/**
 * 4b. Authenticate or auto-provision a user directly via NEAR Wallet Selector
 */
export async function authenticateWalletUser(params: {
  accountId: string;
  walletName?: string;
  proof: WalletAuthProof;
}): Promise<{
  success: boolean;
  authToken?: string;
  user?: { id: string; telegramId: number; username: string; subaccountId: string; address: string };
  reason?: string;
}> {
  try {
    const accountId = (params.accountId || '').trim().toLowerCase();
    if (!isValidNearAccountId(accountId) || params.proof.accountId.trim().toLowerCase() !== accountId) {
      return { success: false, reason: 'A valid signed NEAR account proof is required.' };
    }
    await verifyWalletAuthProof(params.proof);

    const walletName = params.walletName || 'NEAR Wallet Selector';
    const db = await import('@racerbot/db').then(m => m.getDb()).catch(() => null);
    if (!db) {
      return { success: false, reason: 'Wallet login requires the account database. Please try again.' };
    }

    const userResult = await db.query(
      `SELECT u.* FROM users u
       LEFT JOIN user_wallets w ON u.id = w.user_id AND w.chain = 'near'
       WHERE LOWER(u.subaccount_id) = $1 OR LOWER(w.address) = $1
       LIMIT 1`,
      [accountId]
    );
    const user = userResult.rows[0];
    if (!user) {
      return {
        success: false,
        reason: 'Connect your Telegram-managed RacerBot account first, then link this NEAR wallet.',
      };
    }

    const authToken = 'racer_tok_wallet_' + crypto.randomBytes(20).toString('hex');
    const tokenPayload = {
      userId: user.id,
      telegramId: Number(user.telegram_id || 9900000001),
      expiresAt: Date.now() + TOKEN_TTL_SECONDS * 1000,
    };

    const redis = getAuthRedis();
    if (redis) {
      await redis.set(`auth:token:${authToken}`, JSON.stringify(tokenPayload), TOKEN_TTL_SECONDS);
    } else {
      inMemoryTokens.set(authToken, tokenPayload);
    }

    return {
      success: true,
      authToken,
      user: {
        id: user.id,
        telegramId: Number(user.telegram_id || 9900000001),
        username: user.username || accountId,
        subaccountId: user.subaccount_id || accountId,
        address: accountId,
      },
    };
  } catch (err: any) {
    logger.error('Failed to authenticate wallet user:', err);
    return { success: false, reason: err?.message || 'Wallet login failed' };
  }
}

/**
 * 5. Link an external wallet connected via NEAR Wallet Selector (Meteor, HERE, MyNearWallet, etc.)
 */
export async function linkSelectorWallet(params: {
  userId: string;
  telegramId: number;
  accountId: string;
  walletName?: string;
  proof: WalletAuthProof;
}): Promise<{ success: boolean; wallet?: UserWalletRecord; reason?: string }> {
  try {
    const accountId = params.accountId.trim().toLowerCase();
    if (!isValidNearAccountId(accountId) || params.proof.accountId.trim().toLowerCase() !== accountId) {
      return { success: false, reason: 'A valid signed NEAR account proof is required.' };
    }
    await verifyWalletAuthProof(params.proof);

    const chain = 'near';
    const walletName = (params.walletName || 'NEAR Wallet').trim().slice(0, 30);

    const existing = await getUserWallets(params.userId, chain);
    const alreadyLinked = existing.find(wallet => wallet.address.toLowerCase() === accountId);
    if (alreadyLinked) {
      return { success: true, wallet: alreadyLinked };
    }

    const wallet = await createUserWallet({
      userId: params.userId,
      chain,
      address: accountId,
      name: walletName,
      encryptedPrivateKey: 'EXTERNAL_CONNECTED_WALLET',
      isImported: true,
      isActive: false,
    });

    // Notify the user directly in Telegram
    try {
      const bot = getBotInstance();
      if (bot && params.telegramId) {
        bot.telegram.sendMessage(
          params.telegramId,
          `🔗 <b>New Wallet Linked from WebApp!</b>\n\n` +
          `💳 <b>Account</b>: <code>${accountId}</code>\n` +
          `🏷️ <b>Provider</b>: <b>${walletName}</b>\n` +
          `⚡ <b>Status</b>: Linked external wallet\n\n` +
          `<i>Your RacerBot trading account remains unchanged; this connection does not export or store your wallet keys.</i>`,
          { parse_mode: 'HTML' }
        ).catch((err: any) => logger.warn('Failed to send wallet link notification to Telegram:', err?.message));
      }
    } catch {}

    return { success: true, wallet };
  } catch (err: any) {
    logger.error('Failed to link selector wallet:', err);
    return { success: false, reason: err?.message || 'Failed to link wallet' };
  }
}

// ── Telegram Username Verification & Safety Handshake ────────────────────────

export interface TelegramVerificationRequest {
  requestId: string;
  userId: string;
  telegramId: number;
  username: string;
  subaccountId?: string;
  code: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  authToken?: string;
  createdAt: number;
  expiresAt: number;
}

const inMemoryVerifications = new Map<string, TelegramVerificationRequest>();

/**
 * 6. Initiate a safe Telegram username verification request.
 * Checks the DB for the user, creates a 6-digit code, and pings their DM.
 */
export async function requestTelegramVerification(usernameInput: string): Promise<{
  success: boolean;
  requestId?: string;
  maskedHandle?: string;
  reason?: string;
}> {
  try {
    const raw = (usernameInput || '').trim().replace(/^@/, '');
    if (!raw) {
      return { success: false, reason: 'Please enter a valid Telegram username.' };
    }

    const db = await import('@racerbot/db').then(m => m.getDb()).catch(() => null);
    let user: any = null;

    if (db) {
      const isDigits = /^\d+$/.test(raw);
      const res = await db.query(
        `SELECT * FROM users WHERE LOWER(username) = LOWER($1) ${isDigits ? 'OR telegram_id = $2' : ''} LIMIT 1`,
        isDigits ? [raw, parseInt(raw, 10)] : [raw]
      ).catch(() => ({ rows: [] }));

      if (res.rows.length > 0) {
        user = res.rows[0];
      }
    }

    // Fallback search in memory or demo profiles
    if (!user && (raw.toLowerCase() === 'cryptoracer_pro' || raw.toLowerCase() === 'alex' || raw === '182749219')) {
      user = {
        id: 'u-local-tester',
        telegram_id: 182749219,
        username: 'cryptoracer_pro',
        subaccount_id: 'alex.racerbot.near',
      };
    }

    if (!user || !user.telegram_id) {
      return {
        success: false,
        reason: `No RacerBot account found for @${raw}. Please start @racertradingbot in Telegram first so your wallet is created safely.`,
      };
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const requestId = 'vreq_' + crypto.randomBytes(12).toString('hex');
    const now = Date.now();
    const expiresAt = now + 5 * 60 * 1000; // 5 minutes

    const vreq: TelegramVerificationRequest = {
      requestId,
      userId: user.id,
      telegramId: Number(user.telegram_id),
      username: user.username || raw,
      subaccountId: user.subaccount_id,
      code,
      status: 'pending',
      createdAt: now,
      expiresAt,
    };

    inMemoryVerifications.set(requestId, vreq);
    const redis = getAuthRedis();
    if (redis) {
      await redis.set(`auth:vreq:${requestId}`, JSON.stringify(vreq), 300).catch(() => {});
    }

    // Trigger Telegram Bot Security DM
    try {
      const bot = getBotInstance();
      if (bot && user.telegram_id) {
        await bot.telegram.sendMessage(
          Number(user.telegram_id),
          `🔐 <b>RacerBot WebApp Connection Request</b>\n\n` +
          `A browser session is requesting to connect your account: <b>@${user.username || raw}</b>\n\n` +
          `🔢 <b>Your 6-Digit Verification Code:</b>\n` +
          `👉 <code>${code}</code> 👈\n\n` +
          `<i>Enter this code in your browser, or tap Approve below.</i>\n\n` +
          `⚠️ <i>If you did not request this, tap Reject to protect your account. Never share your verification code.</i>`,
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '✅ Approve Connection', callback_data: `tgauth_approve:${requestId}` },
                  { text: '⛔ Reject / Deny', callback_data: `tgauth_deny:${requestId}` },
                ],
              ],
            },
          }
        ).catch((err: any) => logger.warn('Failed to dispatch verification DM:', err?.message));
      }
    } catch (err: any) {
      logger.warn('Error triggering bot verification:', err?.message);
    }

    return {
      success: true,
      requestId,
      maskedHandle: `@${user.username || raw}`,
    };
  } catch (err: any) {
    logger.error('Failed to request Telegram verification:', err);
    return { success: false, reason: err?.message || 'Verification service error' };
  }
}

/**
 * 7. Verify the 6-digit code entered on the WebApp
 */
export async function verifyTelegramCode(requestId: string, codeInput: string): Promise<{
  success: boolean;
  authToken?: string;
  user?: any;
  reason?: string;
}> {
  const vreq = await getTelegramVerification(requestId);
  if (!vreq) {
    return { success: false, reason: 'Verification request not found or expired.' };
  }

  if (vreq.status === 'approved' && vreq.authToken) {
    return {
      success: true,
      authToken: vreq.authToken,
      user: { id: vreq.userId, telegramId: vreq.telegramId, username: vreq.username, subaccountId: vreq.subaccountId },
    };
  }

  if (vreq.status === 'rejected') {
    return { success: false, reason: 'This connection request was rejected in Telegram.' };
  }

  if (Date.now() > vreq.expiresAt) {
    vreq.status = 'expired';
    return { success: false, reason: 'Verification code has expired. Please request a new one.' };
  }

  if (vreq.code !== (codeInput || '').trim()) {
    return { success: false, reason: 'Invalid 6-digit code. Please check your Telegram DM.' };
  }

  // Generate auth token
  const authToken = 'racer_tok_' + crypto.randomBytes(24).toString('hex');
  vreq.status = 'approved';
  vreq.authToken = authToken;

  const tokenPayload = {
    userId: vreq.userId,
    telegramId: vreq.telegramId,
    expiresAt: Date.now() + TOKEN_TTL_SECONDS * 1000,
  };

  const redis = getAuthRedis();
  if (redis) {
    await redis.set(`auth:token:${authToken}`, JSON.stringify(tokenPayload), TOKEN_TTL_SECONDS).catch(() => {});
    await redis.set(`auth:vreq:${requestId}`, JSON.stringify(vreq), 300).catch(() => {});
  }
  inMemoryTokens.set(authToken, tokenPayload);
  inMemoryVerifications.set(requestId, vreq);

  // Notify user in Telegram that connection was successful
  try {
    const bot = getBotInstance();
    if (bot && vreq.telegramId) {
      bot.telegram.sendMessage(
        vreq.telegramId,
        `✅ <b>WebApp Connection Approved!</b>\n\n` +
        `Your Telegram account is now securely linked to the RacerBot WebApp.\n` +
        `You can now execute trades and view your confidential alpha keys on the web.`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }
  } catch {}

  return {
    success: true,
    authToken,
    user: { id: vreq.userId, telegramId: vreq.telegramId, username: vreq.username, subaccountId: vreq.subaccountId },
  };
}

/**
 * 8. Approve verification via Telegram inline button click
 */
export async function approveTelegramVerification(requestId: string, telegramId: number): Promise<boolean> {
  const vreq = await getTelegramVerification(requestId);
  if (!vreq) return false;
  if (vreq.telegramId !== telegramId) return false;

  const authToken = 'racer_tok_' + crypto.randomBytes(24).toString('hex');
  vreq.status = 'approved';
  vreq.authToken = authToken;

  const tokenPayload = {
    userId: vreq.userId,
    telegramId: vreq.telegramId,
    expiresAt: Date.now() + TOKEN_TTL_SECONDS * 1000,
  };

  const redis = getAuthRedis();
  if (redis) {
    await redis.set(`auth:token:${authToken}`, JSON.stringify(tokenPayload), TOKEN_TTL_SECONDS).catch(() => {});
    await redis.set(`auth:vreq:${requestId}`, JSON.stringify(vreq), 300).catch(() => {});
  }
  inMemoryTokens.set(authToken, tokenPayload);
  inMemoryVerifications.set(requestId, vreq);
  return true;
}

/**
 * 9. Reject verification via Telegram inline button click
 */
export async function denyTelegramVerification(requestId: string, telegramId: number): Promise<boolean> {
  const vreq = await getTelegramVerification(requestId);
  if (!vreq) return false;
  if (vreq.telegramId !== telegramId) return false;

  vreq.status = 'rejected';
  const redis = getAuthRedis();
  if (redis) {
    await redis.set(`auth:vreq:${requestId}`, JSON.stringify(vreq), 60).catch(() => {});
  }
  inMemoryVerifications.set(requestId, vreq);
  return true;
}

/**
 * 10. Query the verification status (for webapp polling)
 */
export async function getTelegramVerification(requestId: string): Promise<TelegramVerificationRequest | null> {
  const redis = getAuthRedis();
  if (redis) {
    const raw = await redis.get(`auth:vreq:${requestId}`).catch(() => null);
    if (raw) {
      try {
        return JSON.parse(raw);
      } catch {}
    }
  }
  return inMemoryVerifications.get(requestId) || null;
}
