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
  NEAR_USDC_CONTRACT,
  NEAR_USDC_DECIMALS,
  NEAR_USDC_REF_POOL_ID,
  parseTokenUnits,
  formatTokenUnits,
  withTimeout,
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
  CopyFillMeta,
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
  isValidStarknetAddress,
  UNRUGGABLE_FACTORY_ADDRESS,
  USDC_TOKEN_ADDRESS,
  USDC_NATIVE_TOKEN_ADDRESS,
  USDC_BRIDGED_TOKEN_ADDRESS,
  USDT_TOKEN_ADDRESS,
  getStrkUsdPrice,
  getEthUsdPrice,
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



// Solana chain (Jupiter routing for pump.fun bonding curves and bonded AMMs)
export {
  SOL_MINT,
  SOL_DECIMALS,
  LAMPORTS_PER_SOL_BIG,
  SOLANA_FEE_BPS,
  SOLANA_SELL_FEE_BPS_HIGH,
  SOLANA_SELL_FEE_HIGH_USD_THRESHOLD,
  SOLANA_BPS_DENOMINATOR,
  SOLANA_MIN_RESERVE_LAMPORTS,
  DEFAULT_SOLANA_DEV_FEE_WALLET,
  isSolanaAddress,
  isSolanaToken,
  lamportsToSol,
  solToLamports,
  solanaRpc,
  getSolanaPaidRpcCallCount,
  generateSolanaWallet,
  restoreSolanaKeypair,
  restoreSolanaKeypairFromSecret,
  exportSolanaPrivateKey,
  getSolUsdPrice,
  getSolanaWalletHoldings,
  invalidateSolanaBalanceCache,
  getSolanaBalance,
  getSolanaBalanceFreeOnly,
  getSolanaTokenBalance,
  getSolanaTokenBalanceOnChain,
  getSolanaTokenInfo,
  buildSolanaSwap,
  solanaSellFeeBps,
  sendAndConfirmSolanaTransaction,
  describeSolanaError,
  getSolanaTxDeltas,
  transferSol,
  SOLANA_TRANSFER_FEE_LAMPORTS,
  checkSolanaWithdrawDestination,
  extractSolanaCandidate,
  resolveSolanaPairToMint,
  transferSolanaToken,
  solscanTxUrl,
  solscanTokenUrl,
  solscanAccountUrl,
  pumpFunTokenUrl,
  solanaUiToRaw,
  getSolanaPricesUsd,
  getPumpLatestLaunches,
  getPumpLaunchesByCreator,
  isSolanaTokenTradable,
  getPumpCoinState,
  getSolanaLamportsMulti,
  sendSolToMany,
  sweepSolFromMany,
  SOLANA_RENT_EXEMPT_MIN_LAMPORTS,
  buildSolanaSwapPlan,
  compileSolanaPlan,
  remapSolanaSwapPlan,
  solanaFeeTransferIx,
  setSolanaPlanSlippage,
  getJupiterQuoteOut,
  simulateSolanaTx,
  getSolanaLatestBlockhash,
  sendAndConfirmManySolana,
} from './solana.js';
export type {
  GeneratedSolanaWallet,
  SolanaTokenHolding,
  SolanaWalletHoldings,
  SolanaBalanceResult,
  SolanaTokenInfo,
  SolanaSwapBuild,
  SolanaSendResult,
  PumpLaunch,
  SolanaSwapPlan,
  SolanaSwapParams,
} from './solana.js';
