// Core utilities
export {
  generateId,
  parseMemeCookingId,
  generateRandomAccountPrefix,
  formatNearAmount,
  parseNearAmount,
  weightedAverage,
  computePnL,
  computeMarketCap,
  formatHoldDuration,
  calculateMinAmountOut,
  calculateExpectedOutput,
  calculateMinOutAdj,
  fuzzyMatch,
  retryWithBackoff,
  sleep,
  getNearUsdPrice,
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
  bubbleMapUrl,
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
  clearAccessKeyCache,
  DEFAULT_RPC_URLS,
  getFastnearAccountTokens,
  getFastnearPublicKeyAccounts,
  getRefIndexerPools,
} from './near.js';
export type { NearConfig, TokenMetadata, PoolReserves } from './near.js';

// Distributed per-account lock
export {
  withAccountLock,
  LOCK_CONTENTION_ERROR,
} from './lock.js';
export type { LockOptions } from './lock.js';



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
} from './types.js';
export { TRADABLE_VENUES, isTradableVenue } from './types.js';

// Launchpad framework
export {
  LAUNCHPAD_CONFIGS,
  getLaunchpadConfig,
  isLaunchpadVenue,
  registerLaunchpad,
} from './launchpad.js';
export type { LaunchpadPool, LaunchpadConfig } from './launchpad.js';

// Master key — accessed per-service from env, NOT exported as a constant
// Use process.env.KEY_ENCRYPTION_MASTER_KEY in each service

// Trade errors and log redaction
export { TradeError, redactSecrets } from './errors.js';
export type { TradeErrorCode, TradeErrorOptions } from './errors.js';

// SUI Protocol Integration & SuiPump
export {
  SUI_DECIMALS,
  MIST_PER_SUI,
  SUI_CLOCK_OBJECT_ID,
  SUIPUMP_PACKAGE_ID,
  SUIPUMP_PRICE_CONFIG_OBJECT_ID,
  SUI_FEE_BPS,
  SUI_BPS_DENOMINATOR,
  DEFAULT_SUI_TREASURY_ADDRESS,
  getSuiClient,
  rotateSuiRpc,
  generateSuiWallet,
  restoreSuiKeypair,
  restoreSuiKeypairFromSecret,
  isValidSuiAddress,
  normalizeSuiAddress,
  getShortTokenKey,
  registerShortTokenKey,
  resolveTokenAddressFromKey,
  getSuiBalance,
  getSuiTokenBalance,
  getSuiTokenMetadata,
  getSuiTokenSupply,
  getSuiPumpCurveState,
  getSuiUsdPrice,
  getSuiRouterQuote,
  buildSuiRouterSwapTransaction,
  buildSuiPumpBuyTransaction,
  buildSuiPumpSellTransaction,
  executeSuiTransaction,
} from './sui.js';

export type {
  GeneratedSuiWallet,
  SuiBalanceResult,
  SuiTokenBalanceResult,
  SuiTokenMetadata,
  SuiPumpCurveState,
  SuiRouterQuoteResult,
  BuildSuiPumpBuyParams,
  BuildSuiPumpSellParams,
  ExecuteSuiTxResult,
} from './sui.js';

// Anti-Honeypot & Token Safety
export {
  checkTokenSafety,
} from './safety.js';
export type {
  TokenSafetyReport,
} from './safety.js';

