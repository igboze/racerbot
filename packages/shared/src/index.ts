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
  getPlatformFeeBps,
  getPlatformFeeRatio,
  fuzzyMatch,
  retryWithBackoff,
  sleep,
  getNearUsdPrice,
  isValidNearAccountId,
  parseTokenUnits,
  formatTokenUnits,
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
  isIntearToken,
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
  BuyAlertEvent,
} from './redis.js';

// NEAR multi-RPC connection & FastNEAR helpers
export {
  MultiRpcNear,
  getNear,
  getFreeNear,
  clearAccessKeyCache,
  DEFAULT_RPC_URLS,
  getFastnearAccountTokens,
  getFastnearPublicKeyAccounts,
  getRefIndexerPools,
  intearRegisteredCache,
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

// Starknet Protocol Integration
export {
  STARKNET_DECIMALS,
  FRI_PER_STRK,
  STRK_TOKEN_ADDRESS,
  ETH_TOKEN_ADDRESS,
  OZ_ACCOUNT_CLASS_HASH,
  TYPO_OZ_ACCOUNT_CLASS_HASH,
  UDC_ADDRESS,
  STARKNET_FEE_BPS,
  STARKNET_BPS_DENOMINATOR,
  DEFAULT_STARKNET_TREASURY_ADDRESS,
  getStarknetTreasuryAddress,
  getStarknetProvider,
  getStarknetReadProvider,
  rotateStarknetRpc,
  invalidateStarknetBalanceCache,
  computeStarknetAccountAddress,
  generateStarknetWallet,
  getStarknetAccount,
  getStarknetBalance,
  getStarknetTokenBalance,
  formatTokenBalance,
  getStarknetTokenMetadata,
  getStarknetAVNUQuote,
  detectStarknetLaunchpad,
  getLaunchyQuote,
  LAUNCHY_OFFICIAL_URL,
  LAUNCHY_TOKEN_ADDRESS,
  LAUNCHY_FACTORY_V6,
  LAUNCHY_FACTORY_V2,
  LAUNCHY_SWAPPER_V3,
  ZEC_TOKEN_ADDRESS,
  STRKBTC_TOKEN_ADDRESS,
  LAUNCHY_POOL_FEE_PCT,
  LAUNCHY_CREATOR_FEE_SHARE_PCT,
  LAUNCHY_PLATFORM_FEE_SHARE_PCT,
  LAUNCHY_EKUBO_FEE_SHARE_PCT,
  LAUNCHY_CREATION_FEE_EST_USD,
  LAUNCHY_PROTECTION_MAX_BUY_PCT,
  LAUNCHY_PROTECTION_WINDOW_SEC,
  normalizeStarknetAddress,
  isSameStarknetAddress,
  UNRUGGABLE_FACTORY_ADDRESS,
  USDC_TOKEN_ADDRESS,
  USDC_BRIDGED_TOKEN_ADDRESS,
  USDT_TOKEN_ADDRESS,
} from './starknet.js';

export type {
  GeneratedStarknetWallet,
  StarknetNativeBalances,
  StarknetTokenMetadata,
  StarknetQuoteParams,
  StarknetLaunchpadInfo,
  StarknetLaunchpadPoolKey,
  LaunchyQuoteResult,
} from './starknet.js';

// Anti-Honeypot & Token Safety
export {
  checkTokenSafety,
  isCoreToken,
  isAuditedLaunchpadToken,
  VERIFIED_CORE_TOKENS,
  VERIFIED_LAUNCHPAD_SUFFIXES,
} from './safety.js';
export type {
  TokenSafetyReport,
} from './safety.js';

// NEAR Builders Activity
export {
  publishActivityEvent,
} from './activity.js';
export type {
  ActivityEventType,
  ActivityEventParams,
} from './activity.js';


