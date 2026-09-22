export const MASTER_KEY: string = process.env.KEY_ENCRYPTION_MASTER_KEY || '';
export const ROUTER_CONTRACT_ID: string = process.env.ROUTER_CONTRACT_ID || 'router.racerbot.near';
export const TREASURY_ACCOUNT_ID: string = process.env.TREASURY_ACCOUNT_ID || 'treasury.racerbot.near';
export const PARENT_ACCOUNT: string = process.env.RACERBOT_PARENT_ACCOUNT || 'racerbot.near';
export const TRIGGER_INTERVAL_MS: number = parseInt(process.env.TRIGGER_INTERVAL_MS || '5000');
export const RPC_PROVIDERS: string[] = (process.env.RPC_PROVIDERS || '').split(',').filter(Boolean);
export const DEFAULT_ALLOWANCE = 0.5; // N