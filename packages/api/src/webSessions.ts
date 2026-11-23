/**
 * Web app sign-in sessions: one place that issues, checks, lists and ends them.
 *
 * - A session lasts 7 days and renews while it is used, up to 30 days after sign-in.
 * - Each account keeps a list of its sessions, so the owner can see every browser signed in
 *   (the bot's "Web sessions" screen) and log any or all of them out.
 * - The owner gets a Telegram message for every new sign-in, with where it came from and a
 *   button to log it out at once.
 * - Sessions issued before this list existed carry no sign-in time and are no longer accepted,
 *   which logs every browser out once (Nov 2026: a script was going after users' accounts).
 */
import crypto from 'crypto';
import { createLogger, createRedis, type RedisClient } from '@racerbot/shared';
import { REDIS_URL } from './config.js';
import { clientIp } from './abuseShield.js';

const logger = createLogger('web-sessions');

export const WEB_SESSION_TTL_SECONDS = 7 * 24 * 3600;
/** A session never lives longer than this after its sign-in, however often it is used */
export const WEB_SESSION_MAX_AGE_SECONDS = 30 * 24 * 3600;
/** Renew the stored expiry at most this often (each renewal is a Redis write) */
const RENEW_EVERY_MS = 60 * 60 * 1000;

/** miniapp: signed in by Telegram's own initData inside the user's Telegram (the bot's mini app) */
export type WebSessionMethod = 'telegram' | 'code' | 'wallet' | 'miniapp';

export interface WebSessionOrigin {
  ip?: string;
  userAgent?: string;
}

export interface WebSessionPayload {
  userId: string;
  telegramId: number;
  /** Short public id of the session (a hash of the token): what lists and log-out buttons use */
  sid: string;
  method: WebSessionMethod;
  ip?: string;
  userAgent?: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

export type WebSessionInfo = Omit<WebSessionPayload, 'userId' | 'telegramId'>;

let redis: RedisClient | null = null;
function store(): RedisClient | null {
  if (!redis && REDIS_URL) {
    try {
      redis = createRedis(REDIS_URL);
    } catch (err: any) {
      logger.warn(`Redis unavailable for web sessions, using memory: ${err?.message}`);
    }
  }
  return redis;
}

const memTokens = new Map<string, WebSessionPayload>();
/** userId -> sid -> token */
const memIndex = new Map<string, Map<string, string>>();

const tokenKey = (token: string) => `auth:token:${token}`;
const indexKey = (userId: string) => `auth:user_sessions:${userId}`;
export const sessionIdOf = (token: string) => crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);

const clip = (s: string | undefined, n: number) => (s ? String(s).replace(/[\u0000-\u001f]/g, '').slice(0, n) : undefined);

async function writeToken(token: string, p: WebSessionPayload): Promise<void> {
  memTokens.set(token, p);
  const r = store();
  const ttl = Math.max(1, Math.ceil((p.expiresAt - Date.now()) / 1000));
  if (r) await r.set(tokenKey(token), JSON.stringify(p), ttl).catch(() => {});
}

async function readIndex(userId: string): Promise<Map<string, string>> {
  const r = store();
  if (r) {
    const all = await r.hgetall(indexKey(userId)).catch(() => null);
    if (all) return new Map(Object.entries(all));
  }
  return new Map(memIndex.get(userId) ?? []);
}

async function writeIndex(userId: string, index: Map<string, string>): Promise<void> {
  memIndex.set(userId, new Map(index));
  const r = store();
  if (!r) return;
  // No HDEL on the client: rewrite the hash
  await r.del(indexKey(userId)).catch(() => {});
  if (index.size > 0) await r.hset(indexKey(userId), Object.fromEntries(index)).catch(() => {});
}

/** Starts a web session for a user who has just proved who they are */
export async function issueWebSession(params: {
  userId: string;
  telegramId: number;
  method: WebSessionMethod;
  origin?: WebSessionOrigin;
  prefix?: string;
}): Promise<{ token: string; session: WebSessionPayload }> {
  const token = (params.prefix ?? 'racer_tok_') + crypto.randomBytes(24).toString('hex');
  const now = Date.now();
  const session: WebSessionPayload = {
    userId: params.userId,
    telegramId: Number(params.telegramId) || 0,
    sid: sessionIdOf(token),
    method: params.method,
    ip: clip(params.origin?.ip, 64),
    userAgent: clip(params.origin?.userAgent, 160),
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + WEB_SESSION_TTL_SECONDS * 1000,
  };
  await writeToken(token, session);
  const index = await readIndex(params.userId);
  index.set(session.sid, token);
  await writeIndex(params.userId, index);
  logger.info(`[AUTH] Web session ${session.sid} started for user ${params.userId} via ${params.method} from ${session.ip || '?'}`);
  return { token, session };
}

async function readToken(token: string): Promise<WebSessionPayload | null> {
  const r = store();
  if (r) {
    const raw = await r.get(tokenKey(token)).catch(() => null);
    if (raw) {
      try { return JSON.parse(raw); } catch { return null; }
    }
  }
  return memTokens.get(token) ?? null;
}

/** The session behind a token, renewing it while in use; null if unknown, expired or logged out */
export async function verifyWebSession(token: string): Promise<WebSessionPayload | null> {
  if (!token || typeof token !== 'string') return null;
  const p = await readToken(token);
  if (!p) return null;
  const now = Date.now();
  // Issued before sessions were tracked (no sign-in time, not in the owner's list): no longer valid
  if (!p.createdAt || !p.sid) return null;
  if (now > p.expiresAt || now > p.createdAt + WEB_SESSION_MAX_AGE_SECONDS * 1000) {
    await endToken(token, p);
    return null;
  }
  if (now - p.lastSeenAt > RENEW_EVERY_MS) {
    const renewed = {
      ...p,
      lastSeenAt: now,
      expiresAt: Math.min(now + WEB_SESSION_TTL_SECONDS * 1000, p.createdAt + WEB_SESSION_MAX_AGE_SECONDS * 1000),
    };
    await writeToken(token, renewed);
    return renewed;
  }
  return p;
}

async function endToken(token: string, p?: WebSessionPayload | null): Promise<void> {
  memTokens.delete(token);
  const r = store();
  if (r) await r.del(tokenKey(token)).catch(() => {});
  if (p?.userId && p.sid) {
    const index = await readIndex(p.userId);
    if (index.delete(p.sid)) await writeIndex(p.userId, index);
  }
}

/** The account's signed-in browsers, newest first (expired ones are dropped from the list) */
export async function listWebSessions(userId: string): Promise<WebSessionInfo[]> {
  const index = await readIndex(userId);
  const out: WebSessionInfo[] = [];
  let changed = false;
  for (const [sid, token] of index) {
    const p = await readToken(token);
    if (!p || Date.now() > p.expiresAt || p.userId !== userId) {
      index.delete(sid);
      changed = true;
      continue;
    }
    const { userId: _u, telegramId: _t, ...info } = p;
    out.push(info);
  }
  if (changed) await writeIndex(userId, index);
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/** Logs one browser out; false if that session is not this user's (or already gone) */
export async function revokeWebSession(userId: string, sid: string): Promise<boolean> {
  const index = await readIndex(userId);
  const token = index.get(sid);
  if (!token) return false;
  await endToken(token, { ...(await readToken(token)), userId, sid } as WebSessionPayload);
  return true;
}

/** Logs every browser out of this account; returns how many were signed in */
export async function revokeAllWebSessions(userId: string): Promise<number> {
  const index = await readIndex(userId);
  for (const token of index.values()) {
    memTokens.delete(token);
    const r = store();
    if (r) await r.del(tokenKey(token)).catch(() => {});
  }
  await writeIndex(userId, new Map());
  return index.size;
}

/** "Chrome on Windows"-style label for a user agent, for messages and lists */
export function describeDevice(userAgent?: string): string {
  const ua = userAgent || '';
  if (!ua) return 'unknown device';
  if (/python|curl|wget|httpclient|okhttp|axios|node-fetch|go-http|java\//i.test(ua)) return `a script (${clip(ua, 40)})`;
  const browser = /edg\//i.test(ua) ? 'Edge' : /opr\//i.test(ua) ? 'Opera' : /chrome\//i.test(ua) ? 'Chrome'
    : /firefox\//i.test(ua) ? 'Firefox' : /safari\//i.test(ua) ? 'Safari' : 'a browser';
  const os = /iphone|ipad/i.test(ua) ? 'iOS' : /android/i.test(ua) ? 'Android' : /windows/i.test(ua) ? 'Windows'
    : /mac os/i.test(ua) ? 'macOS' : /linux/i.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

/** The client's IP (Railway's X-Real-IP) and browser, for sign-in alerts and the sessions list */
export function requestOrigin(req: any): WebSessionOrigin {
  return { ip: clientIp(req), userAgent: String(req?.headers?.['user-agent'] || '') || undefined };
}
