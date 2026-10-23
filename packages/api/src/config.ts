import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

let curr = process.cwd();
for (let i = 0; i < 5; i++) {
  const p = path.join(curr, '.env');
  if (fs.existsSync(p)) {
    dotenv.config({ path: p });
  }
  curr = path.dirname(curr);
}

export const MASTER_KEY: string = process.env.KEY_ENCRYPTION_MASTER_KEY || '';
export const ROUTER_CONTRACT_ID: string = process.env.ROUTER_CONTRACT_ID || 'router.racerbot.near';
export const TREASURY_ACCOUNT_ID: string = process.env.TREASURY_ACCOUNT_ID || 'racerbottreasury.near';
export const PARENT_ACCOUNT: string = process.env.RACERBOT_PARENT_ACCOUNT || 'racerbot.near';
export const RACERBOT_PARENT_ACCOUNT = PARENT_ACCOUNT;
export const MAIN_WALLET_PRIVATE_KEY: string = process.env.MAIN_WALLET_PRIVATE_KEY || '';
export const TELEGRAM_BOT_TOKEN: string = process.env.TELEGRAM_BOT_TOKEN || '';
const ACTIVE_PAID_FASTNEAR_KEY = '***REMOVED***';
const DEPRECATED_FASTNEAR_KEY = '***REMOVED***';
export const RPC_PROVIDERS: string[] = (process.env.RPC_PROVIDERS || '')
  .split(',')
  .map(s => s.trim().replace(DEPRECATED_FASTNEAR_KEY, ACTIVE_PAID_FASTNEAR_KEY))
  .filter(Boolean);
export const DEFAULT_ALLOWANCE = 0.5;
export const DATABASE_URL: string = process.env.DATABASE_URL || 'postgres://localhost:5432/racerbot';
export const REDIS_URL: string = process.env.REDIS_URL || 'redis://localhost:6379';
export const PUBLIC_URL: string = process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '');
export const TELEGRAM_WEBHOOK_SECRET: string = process.env.TELEGRAM_WEBHOOK_SECRET || '';

// ── Admin monitoring ─────────────────────────────────────────────────────────
// Comma-separated Telegram usernames (with or without @) allowed to run admin
// commands and receive monitoring alerts, e.g. ADMIN_USERNAMES=israel_igboze
export const ADMIN_USERNAMES: string[] = (process.env.ADMIN_USERNAMES || '')
  .split(',')
  .map((s) => s.trim().replace(/^@/, '').toLowerCase())
  .filter(Boolean);
// Optional hard override: a numeric Telegram user id that is always admin.
export const ADMIN_TELEGRAM_ID: string = (process.env.ADMIN_TELEGRAM_ID || '').trim();
export const MONITOR_INTERVAL_MS: number = parseInt(process.env.MONITOR_INTERVAL_MS || '300000');