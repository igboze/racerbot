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
