// Core utilities
export {
  generateId,
  formatNearAmount,
  parseNearAmount,
  weightedAverage,
  computePnL,
  computeMarketCap,
  fuzzyMatch,
  retryWithBackoff,
  sleep,
} from './utils.js';

// Cryptography — never log output of these
export {
  encrypt,
  decrypt,
  generateScopedAccessKey,
  validateScopedKey,
  generateSeedPhrase,
  mnemonicToBytes,
} from './crypto.js';

// Redis pub/sub and event types
export {
  createRedis,
  CHANNELS,
} from './redis.js';

export type {
  RedisClient,
  TokenDetectedEvent,
  PoolCreatedEvent,
  TriggerEvent,
  SwapEvent,
  AutoBuySignal,
  PriceUpdateEvent,
  NotifyUserEvent,
} from './redis.js';

// NEAR multi-RPC connection & FastNEAR helpers
export {
  MultiRpcNear,
  getNear,
  getFastnearAccountTokens,
  getFastnearPublicKeyAccounts,
} from './near.js';
export type { NearConfig, TokenMetadata, PoolReserves } from './near.js';

// RPC provider management
export {
  createProvider,
  rotateProvider,
  markProviderError,
  markProviderSuccess,
  getRpcProvider,
} from './rpc.js';
export type { RPCProvider } from './rpc.js';

// Shared types
export type {
  UserConfig,
  TokenInfo,
  SwapRequest,
  TriggerConfig,
  PnLCard,
} from './types.js';

// Master key — accessed per-service from env, NOT exported as a constant
// Use process.env.KEY_ENCRYPTION_MASTER_KEY in each service