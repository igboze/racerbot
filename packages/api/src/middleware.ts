import { createHmac } from 'crypto';
import type { Request, Response, NextFunction } from 'express';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;

/**
 * Validate Telegram Web App initData HMAC.
 * Per Telegram docs: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 * (We keep this for future Mini App integration, even though the current UI is bot-only.)
 */
export function validateTelegramInitData(initData: string): { valid: boolean; userId?: number } {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return { valid: false };

    params.delete('hash');
    const dataCheckString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secretKey = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const computedHash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (computedHash !== hash) return { valid: false };

    const userParam = params.get('user');
    if (!userParam) return { valid: true };
    const user = JSON.parse(userParam);
    return { valid: true, userId: user.id };
  } catch {
    return { valid: false };
  }
}

/**
 * Express middleware: validate Telegram initData from Authorization header.
 * Format: Authorization: tma <initData>
 */
export function ensureAuthenticated(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization ?? '';
  if (authHeader.startsWith('tma ')) {
    const initData = authHeader.slice(4);
    const { valid, userId } = validateTelegramInitData(initData);
    if (valid) {
      (req as any).telegramUserId = userId;
      next();
      return;
    }
  }
  res.status(401).json({ error: 'Unauthorized' });
}

/**
 * Rate limiter using in-process Map.
 * In production, use a Redis-backed limiter. This is a lightweight guard.
 */
export function rateLimit(windowMs: number, maxRequests: number) {
  const windows = new Map<string, number[]>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = (req.headers['x-forwarded-for'] as string) ?? req.ip ?? 'unknown';
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

export function validateSwapParams(params: any): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!params.token_in || !params.token_out) errors.push('token_in and token_out required');
  if (!params.amount_in || parseFloat(params.amount_in) <= 0) errors.push('amount_in must be positive');
  if (!['rhea', 'shardsmarket'].includes(params.venue)) errors.push('venue must be rhea or shardsmarket');
  return { valid: errors.length === 0, errors };
}

export function validateTriggerParams(params: any): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!['stop_loss', 'take_profit', 'market_cap'].includes(params.type)) errors.push('Invalid trigger type');
  if (!params.target_value || parseFloat(params.target_value) <= 0) errors.push('target_value must be positive');
  return { valid: errors.length === 0, errors };
}