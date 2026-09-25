// Core utilities
export {
  generateId,
  generateRandomAccountPrefix,
  formatNearAmount,
  parseNearAmount,
  weightedAverage,
  computePnL,
  computeMarketCap,
  calculateMinAmountOut,
  calculateExpectedOutput,
  calculateMinOutAdj,
  fuzzyMatch,
  retryWithBackoff,
  sleep,
} from './utils.js';

// Structured logging
export {
  createLogger,
  generateCorrelationId,
} from './logger.js';
export type { LogLevel, LogContext, LogEntry } from './logger.js';

// Metrics collection
export { metrics, MetricNames } from './metrics.js';

// Cryptography — never log output of these
export {
  encrypt,
  decrypt,
  validateScopedKey,
  generateScopedAccessKey,
  assertValidMasterKey,
} from './crypto.js';

// Venue / launchpad registry & public links (DexScreener, explorer, launchpads)
export {
  VENUES,
  getVenueInfo,
  dexscreenerUrl,
  nearblocksTokenUrl,
  nearblocksTxUrl,
  tokenLinks,
} from './venues.js';
export type { VenueId, VenueInfo, VenueLink } from './venues.js';

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
  VenueName,
  TriggerConfig,
  PnLCard,
} from './types.js';
export { TRADABLE_VENUES, isTradableVenue } from './types.js';

// Master key — accessed per-service from env, NOT exported as a constant
// Use process.env.KEY_ENCRYPTION_MASTER_KEY in each service