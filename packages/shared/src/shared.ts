// Shared utilities re-exported by each service
export { getDb } from './db.js';
export { createMultiRpc } from './rpc.js';
export { decrypt, encrypt, generateScopedAccessKey, validateScopedKey, generateSeedPhrase } from './crypto.js';
export { CHANNELS, TokenDetectedEvent, PoolCreatedEvent, TriggerEvent, SwapEvent } from './redis.js';
export { generateId, formatNearAmount, parseNearAmount, weightedAverage, computePnL, computeMarketCap, fuzzyMatch, retryWithBackoff, sleep } from './utils.js';
export { RPCProvider, createProvider, markProviderError, markProviderSuccess, rotateProvider } from './rpc.js';
export { MultiRpcProvider } from './rpc.js';

export const MASTER_KEY = process.env.KEY_ENCRYPTION_MASTER_KEY!;