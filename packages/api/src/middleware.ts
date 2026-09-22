import { NextFunction, Request, Response } from 'express';
import { RequestWithUser } from './types.js';

export const ensureAuthenticated = (req: Request, res: Response, next: NextFunction) => {
  const sessionToken = req.headers.authorization?.replace('Bearer ', '');
  if (!sessionToken) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  // Verify session token
  next();
};

export const rateLimit = (windowMs: number, maxRequests: number) => {
  const requests = new Map<string, number[]>();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    const now = Date.now();
    const userRequests = requests.get(key) || [];
    const filtered = userRequests.filter(t => now - t < windowMs);
    if (filtered.length >= maxRequests) {
      return res.status(429).json({ error: 'Too many requests' });
    }
    filtered.push(now);
    requests.set(key, filtered);
    next();
  };
};

export function validateSwapParams(params: any): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!params.token_in || !params.token_out) errors.push('token_in and token_out are required');
  if (!params.amount_in || parseFloat(params.amount_in) <= 0) errors.push('amount_in must be positive');
  if (!params.min_amount_out || parseFloat(params.min_amount_out) < 0) errors.push('min_amount_out must be non-negative');
  if (!['rhea', 'shardsmarket'].includes(params.venue)) errors.push('Invalid venue');
  return { valid: errors.length === 0, errors };
}

export function validateTriggerParams(params: any): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!['stop_loss', 'take_profit', 'market_cap'].includes(params.type)) errors.push('Invalid trigger type');
  if (!params.target_value || parseFloat(params.target_value) <= 0) errors.push('target_value must be positive');
  return { valid: errors.length === 0, errors };
}