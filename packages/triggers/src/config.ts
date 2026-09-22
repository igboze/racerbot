export const MASTER_KEY: string = process.env.KEY_ENCRYPTION_MASTER_KEY || '';
export const TRIGGER_INTERVAL_MS: number = parseInt(process.env.TRIGGER_INTERVAL_MS || '5000');
export const RPC_PROVIDERS: string[] = (process.env.RPC_PROVIDERS || '').split(',').filter(Boolean);