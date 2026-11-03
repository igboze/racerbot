/**
 * The signed-in user, from proof only: a session token (Telegram login, or a NEAR wallet that signed
 * a challenge) or Telegram Mini App initData. A bare wallet-address header is never enough here:
 * routes using this move money or manage wallets.
 */
import { getUserById, getUserByTelegramId, type UserRecord } from '@racerbot/db';
import { verifyAuthToken } from '../authSession.js';
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
