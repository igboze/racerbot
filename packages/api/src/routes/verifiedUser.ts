/**
 * The signed-in user, from proof only: a session token (Telegram login, or a NEAR wallet that signed
 * a challenge) or Telegram Mini App initData. A bare wallet-address header is never enough here:
 * routes using this move money or manage wallets.
 */
import { getUserById, getUserByTelegramId, type UserRecord } from '@racerbot/db';
import { verifyAuthToken } from '../authSession.js';
import { verifyWebSession } from '../webSessions.js';
import { validateTelegramInitData } from '../middleware.js';

export async function verifiedUser(req: any): Promise<UserRecord | null> {
  const auth = String(req.headers.authorization || '');
  if (auth.startsWith('tma ')) {
    const { valid, userId } = validateTelegramInitData(auth.slice(4));
    return valid && userId ? getUserByTelegramId(userId) : null;
  }
  const token = auth.replace(/^Bearer\s+/i, '');
  const session = token ? await verifyAuthToken(token) : null;
  return session?.userId ? getUserById(session.userId) : null;
}

/**
 * The NEAR account a request merely claims (x-wallet-address header, or a
 * walletAddress field), or null. Only read-only requests may use such a claim:
 * anything that changes state needs a verified session, because a wallet
 * account can still hold money RacerBot keeps for it (the confidential private
 * balance) and settings that spend it (auto-copy).
 */
export function unprovenWalletClaim(req: any): string | null {
  if (req.method !== 'GET' && req.method !== 'HEAD') return null;
  const claim = req.headers?.['x-wallet-address'] || req.query?.walletAddress || req.body?.walletAddress;
  return typeof claim === 'string' && claim.trim() ? claim.trim() : null;
}

export const FUNDS_OUT_NEEDS_TELEGRAM =
  'For your safety, money leaves an account linked to Telegram only from the RacerBot chat (/withdraw) or its mini app, ' +
  'never from a browser alone. Open @racertradingbot to withdraw.';

/**
 * Whether this request may send money to an outside address. A browser session can trade, but if someone
 * got one (a tapped approval, a stolen token) it must not be able to empty the wallet: for accounts linked
 * to Telegram, withdrawals need the Telegram chat or the mini app (signed by Telegram inside the user's own app).
 * Accounts that only ever signed in with a wallet have no Telegram, so the web app stays their way out.
 */
export async function fundsOutAllowed(req: any, user: UserRecord | null): Promise<boolean> {
  if (!user) return false;
  if (!(Number(user.telegram_id) > 0)) return true;
  const auth = String(req.headers?.authorization || '');
  if (auth.startsWith('tma ')) return validateTelegramInitData(auth.slice(4)).valid;
  const token = auth.replace(/^Bearer\s+/i, '') || req.query?.token || req.body?.authToken;
  const session = typeof token === 'string' && token ? await verifyWebSession(token) : null;
  return session?.method === 'miniapp' && session.userId === user.id;
}
