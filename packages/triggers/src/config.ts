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
export const TRIGGER_INTERVAL_MS: number = parseInt(process.env.TRIGGER_INTERVAL_MS || '5000');
export const RPC_PROVIDERS: string[] = (process.env.RPC_PROVIDERS || '').split(',').filter(Boolean);
export const TELEGRAM_BOT_TOKEN: string = process.env.TELEGRAM_BOT_TOKEN || '';
export const PARENT_ACCOUNT: string = process.env.RACERBOT_PARENT_ACCOUNT || 'racerbot.near';
export const ROUTER_CONTRACT_ID: string = process.env.ROUTER_CONTRACT_ID || 'router.racerbot.near';