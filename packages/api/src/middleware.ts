import { createHmac, timingSafeEqual } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { getUserByTelegramId } from '@racerbot/db';

/** Reject initData older than this (replay window). 24h per Telegram guidance. */
const MAX_INIT_DATA_AGE_SECONDS = 24 * 60 * 60;

/**
 * Validate Telegram Web App initData HMAC.
 * Per Telegram docs: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 * - HMAC compared in constant time (no timing oracle)
 * - auth_date freshness enforced (a captured initData cannot be replayed forever)
 * - fails closed when TELEGRAM_BOT_TOKEN is not configured
 */
export function validateTelegramInitData(initData: string): { valid: boolean; userId?: number } {
  try {
    const botToken = process.env.TELEGRAM_BOT_TOKEN || '';
    if (!botToken || !initData) return { valid: false };

    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    const authDate = params.get('auth_date');
    if (!hash || !authDate) return { valid: false };

    const authTs = parseInt(authDate, 10);
    if (!Number.isFinite(authTs)) return { valid: false };
    const ageSeconds = Date.now() / 1000 - authTs;
    if (ageSeconds > MAX_INIT_DATA_AGE_SECONDS || ageSeconds < -300) {
      return { valid: false };
    }

    params.delete('hash');
    const dataCheckString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
    const computedHash = createHmac('sha256', secretKey).update(dataCheckString).digest();
    const providedHash = Buffer.from(hash, 'hex');

    if (providedHash.length !== computedHash.length || !timingSafeEqual(providedHash, computedHash)) {
      return { valid: false };
    }

    const userParam = params.get('user');
    if (!userParam) return { valid: true };
    const user = JSON.parse(userParam);
    return { valid: true, userId: user.id };
  } catch {
    return { valid: false };
  }
}

/**
 * Level 1 auth: proves the request comes from a real Telegram client
 * (valid, fresh initData). Sets req.telegramUserId. Used by onboarding
 * endpoints where no user row exists yet.
 */
export function ensureTelegramInitData(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization ?? '';
  if (authHeader.startsWith('tma ')) {
    const { valid, userId } = validateTelegramInitData(authHeader.slice(4));
    if (valid && userId) {
      (req as any).telegramUserId = userId;
      next();
      return;
    }
  }
  res.status(401).json({ error: 'Unauthorized: valid Telegram initData required' });
}

/**
 * Level 2 auth: valid initData AND an existing onboarding record.
 * Sets req.telegramUserId and req.userId (the server-side user UUID).
 * Every money-moving endpoint must derive identity from here —
 * NEVER from req.body.userId (that was an IDOR / account-takeover hole).
 */
export async function ensureTelegramUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization ?? '';
  if (!authHeader.startsWith('tma ')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { valid, userId } = validateTelegramInitData(authHeader.slice(4));
  if (!valid || !userId) {
    res.status(401).json({ error: 'Unauthorized: invalid Telegram initData' });
    return;
  }

  try {
    const user = await getUserByTelegramId(userId);
    if (!user) {
      res.status(401).json({ error: 'Unauthorized: complete /start onboarding first' });
      return;
    }
    (req as any).telegramUserId = userId;
    (req as any).userId = user.id;
    next();
  } catch (err: any) {
    // Fail closed on lookup errors — never assume authenticated
    res.status(500).json({ error: 'Auth lookup failed' });
  }
}

/** Legacy alias kept for compatibility. */
export function ensureAuthenticated(req: Request, res: Response, next: NextFunction): void {
  void ensureTelegramUser(req, res, next);
}

/**
 * Rate limiter. Keyed on req.ip (express `trust proxy` is set in index.ts)
 * with a bounded map so spoofed traffic cannot grow memory without limit.
 */
export function rateLimit(windowMs: number, maxRequests: number) {
  const windows = new Map<string, number[]>();

  return (req: Request, res: Response, next: NextFunction): void => {
    if (windows.size > 10_000) windows.clear(); // hard memory cap

    const key = req.ip ?? 'unknown';
    const now = Date.now();
    const hits = (windows.get(key) ?? []).filter(t => now - t < windowMs);

    if (hits.length >= maxRequests) {
      res.status(429).json({ error: 'Too many requests' });
      return;
    }

    hits.push(now);
    windows.set(key, hits);
    next();
  };
}

const ACCOUNT_ID_RE = /^[a-z0-9_\-]+(\.[a-z0-9_\-]+)+$/;
const UINT_RE = /^\d+$/;

export function isValidAccountId(id: unknown): id is string {
  return typeof id === 'string' && id.length <= 64 && ACCOUNT_ID_RE.test(id);
}

export function isValidUintString(v: unknown): v is string {
  return typeof v === 'string' && UINT_RE.test(v) && v !== '0';
}

export function validateSwapParams(params: any): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!isValidAccountId(params.token_in) && params.token_in !== 'near') errors.push('token_in must be a NEAR account id');
  if (!isValidAccountId(params.token_out) && params.token_out !== 'near') errors.push('token_out must be a NEAR account id');
  if (!isValidUintString(params.amount_in)) errors.push('amount_in must be a positive integer (atomic units)');
  if (
    params.venue !== undefined &&
    !['rhea', 'shardsmarket', 'nearlytrade', 'intear', 'onetokenhub'].includes(params.venue)
  ) {
    errors.push('venue must be rhea, shardsmarket, nearlytrade, intear, or onetokenhub');
  }
  return { valid: errors.length === 0, errors };
}

export function validateTriggerParams(params: any): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!['stop_loss', 'take_profit', 'market_cap'].includes(params.type)) errors.push('Invalid trigger type');
  if (!params.target_value || parseFloat(params.target_value) <= 0) errors.push('target_value must be positive');
  return { valid: errors.length === 0, errors };
}
