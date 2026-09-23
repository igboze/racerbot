export const MASTER_KEY: string = process.env.KEY_ENCRYPTION_MASTER_KEY || '';
export const ROUTER_CONTRACT_ID: string = process.env.ROUTER_CONTRACT_ID || 'router.racerbot.near';
export const TREASURY_ACCOUNT_ID: string = process.env.TREASURY_ACCOUNT_ID || 'racerbottreasury.near';
export const PARENT_ACCOUNT: string = process.env.RACERBOT_PARENT_ACCOUNT || 'racerbot.near';
export const MAIN_WALLET_PRIVATE_KEY: string = process.env.MAIN_WALLET_PRIVATE_KEY || '';
export const TRIGGER_INTERVAL_MS: number = parseInt(process.env.TRIGGER_INTERVAL_MS || '5000');
export const RPC_PROVIDERS: string[] = (process.env.RPC_PROVIDERS || '').split(',').filter(Boolean);
export const TELEGRAM_BOT_TOKEN: string = process.env.TELEGRAM_BOT_TOKEN || '';