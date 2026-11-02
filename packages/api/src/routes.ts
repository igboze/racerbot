import { ethers } from 'ethers';
import { Telegraf, Markup, Context } from 'telegraf';
import {
  getUserByTelegramId,
  getUserById,
  getUserByReferralCode,
  getOpenPositions,
  getFillsByPosition,
  getPositionById,
  createTrigger,
  upsertTrigger,
  cancelTriggersByPosition,
  getTriggersByPosition,
  updateUserSettings,
  updatePosition,
  createPosition,
  getDb,
  generateReferralCode,
  getTotalReferralEarnings,
  getTotalReferralClaimed,
  createReferralClaim,
  getOrCreateTokenShare,
  getTokenShareByCode,
  recordTokenReferral,
  getPointsSummary,
  getPointsLeaderboard,
  createSnipeOrder,
  countActiveSnipeOrders,
  getSnipeOrdersByUser,
  getSnipeOrderById,
  cancelSnipeOrder,
  deleteSnipeOrder,
  recordSnipeTrigger,
  markSnipeTriggerFilled,
  markSnipeTriggerFailed,
  markSnipeOrderResult,
  MAX_ACTIVE_SNIPE_ORDERS_PER_USER,
  // Copy Trading
  createCopyTradeTarget,
  getCopyTradeTargetsByUser,
  getConfidentialAccount,
  getCopyTradeTargetById,
  updateCopyTradeTargetStatus,
  updateCopyTradeTarget,
  // DCA Orders
  createDcaOrder,
  getDcaOrdersByUser,
  updateDcaOrderStatus,
  // Limit Orders
  createLimitOrder,
  getLimitOrdersByUser,
  cancelLimitOrder,
  createUserWallet,
  getRacerDepositById,
  updateRacerDeposit,
  getUserWallets,
  getActiveWallet,
  type UserRecord,
  type UserWalletRecord,
  type LimitOrderRecord,
  type PositionRecord,
} from '@racerbot/db';
import {
  SUPPORTED_CHAINS,
  create1ClickDepositQuote,
  check1ClickDepositStatus,
  generateWalletDeepLink,
  generateQrBuffer,
  getTokensForChain,
  getTokenByKey,
  getMinimumDeposit,
  getAmountSuggestions,
  type SupportedChain,
  type OneClickToken,
} from './multichainDeposit.js';
import {
  getTokenInfo,
  getBatchTokenInfo,
  getFastTokenRoute,
  publishSwap,
  onboardUser,
  rotateUserKey,
  getUserBalances,
  getTradeSpendableNear,
  getTradeSpendableSui,
  getRefStorageDepositNeeded,
  unwrapUserWrapNear,
  recoverIntentRefund,
  withdrawFunds,
  withdrawSuiFunds,
  withdrawStarknetFunds,
  withdrawTokenFunds,
  withdrawSolanaFunds,
  syncUserTokenDeposits,
  getNearUsdPrice,
  getHypeUsdPrice,
  payReferralReward,
  isSuiToken,
  isStarknetToken,
  ensureUserAllWallets,
  ensureUserEvmWallet,
  ensureUserStarknetWallet,
  ensureUserSolanaWallet,
  resetUserStarknetWallet,
  listUserNearWallets,
  switchActiveNearWallet,
  renameUserNearWallet,
  deleteUserNearWallet,
  importNearWallet,
  validateAndParseNearKey,
  findAccountsForNearPublicKey,
  MAX_NEAR_WALLETS_PER_USER,
  listUserSuiWallets,
  switchActiveSuiWallet,
  renameUserSuiWallet,
  deleteUserSuiWallet,
  importSuiWallet,
  MAX_SUI_WALLETS_PER_USER,
  switchActiveStarknetWallet,
  renameUserStarknetWallet,
  prewarmStorageDeposit,
  invalidateBalanceCache,
  formatCryptoPrice,
  EvmTokenLookupError,
  refuelNearGasIfNeeded,
  type TokenInfoResult,
} from './wallet.js';
import { sellAtTarget } from './sellHelper.js';
import {
  handlePrivatePrompt,
  isPrivateDeposit,
  privatizeDepositPicker,
  registerPrivateActions,
  renderPrivateDepositCard,
  type PrivatePromptAction,
} from './botPrivate.js';
import { EXECUTORS_ENABLED as PRIVATE_TRADING_ENABLED, confidentialBuy } from './executorPool.js';
import { copyModeData, copyShareParam, parseCopyShareParam } from './copyLinks.js';
import {
  computePnL,
  fuzzyMatch,
  decrypt,
  tokenLinks,
  getNear,
  getShortTokenKey,
  resolveTokenAddressFromKey,
  getSuiBalance,
  getSuiTokenBalance,
  getSuiTokenMetadata,
  getSuiUsdPrice,
  getStarknetBalance,
  getStarknetTokenBalance,
  getStarknetTokenMetadata,
  checkTokenSafety,
  restoreSuiKeypairFromSecret,
  isValidSuiAddress,
  isValidStarknetAddress,
  withTimeout,
  isSolanaToken,
  isSolanaAddress,
  extractSolanaCandidate,
  resolveSolanaPairToMint,
  getSolanaBalance,
  getSolanaTokenBalance,
  getSolUsdPrice,
  getSolanaWalletHoldings,
  exportSolanaPrivateKey,
  lamportsToSol,
  getSolanaTokenInfo,
  solanaUiToRaw,
  SOL_MINT,
  NEAR_USDC_CONTRACT,
  NEAR_USDC_DECIMALS,
  isValidEvmAddress,
  getHypeBalance,
  ELYSIUM_TESTNET_EXPLORER_URL,
  ELYSIUM_MAINNET_EXPLORER_URL,
  KLEOS_TOKEN_URL,
  isKleosTradingEnabled,
  HYPEREVM_EXPLORER_URL,
  type EvmChain,
} from '@racerbot/shared';
export { getShortTokenKey, resolveTokenAddressFromKey };
import { inFlightKey, tryAcquireInFlight, releaseInFlight } from './inflight.js';
import { generatePNLCard } from './pnlCardGenerator.js';
import { generateTokenInfoCardImage } from './tokenInfoCardImageGenerator.js';
import { toTokenInfoCardData } from './tokenInfoCardData.js';
import { registerRacerCard } from './racerCard.js';
import { handleBuyBotCommand, handleTestAlertCommand, handleBuyAlertAction, handleBuyAlertMediaUpload, buildAlertSettingsCard, escapeHtml } from './buyAlerts.js';
import {
  setupRaceDropRoutes,
  handleRaceDropClaim,
  handleRaceDropGroupPost,
  getRaceDropWizardState,
  startRaceDropWizard,
  getUserAvailableBalance,
  formatDropAmount,
  handleRaceDropAmountPerUserInput,
  handleRaceDropClaimsInput,
  getBotUsername,
} from './raceDrop.js';
import {
  hasActiveRaceFleet,
  buildFleetCockpit,
  buildRaceFleetDashboard,
  buildFleetHoldingsView,
  buildFleetPromoCard,
  deployRaceFleet,
  distributeFundsToFleet,
  sweepFleetFunds,
  executeFleetBundleBuy,
  executeFleetBundleSell,
  exportFleetKeys,
  getFleetBalances,
  getFleetTokenPosition,
  type FleetTokenPosition,
  RACEFLEET_MONTHLY_FEE_NEAR,
} from './raceFleet.js';
import {
  deployRaceFleetWithSol,
  renewRaceFleetWithSol,
  distributeSolToFleet,
  sweepSolanaFleet,
  getSolanaFleetBalances,
  getFleetFeeInSol,
} from './solanaFleet.js';
import {
  createRaceFleetOrder,
  getRaceFleetByUserId,
  getRaceFleetOrdersByFleet,
  cancelRaceFleetOrder,
  renewRaceFleet,
  createAiSwarmSession,
  getAiSwarmSessionById,
  getUserActiveAiSwarmSession,
  updateAiSwarmSession,
} from '@racerbot/db';
import { planSwarmSession } from './nearAiSwarm.js';
import {
  launchSwarmSession,
  getSwarmSessionStatus,
  pauseSwarmSession,
  abortSwarmSession,
} from './swarmExecutor.js';
import { utils as nearUtils } from 'near-api-js';
import crypto from 'crypto';
import { MASTER_KEY, RPC_PROVIDERS, TREASURY_ACCOUNT_ID } from './config.js';
import { checkUserDepositNow, markUserActiveForDeposit } from './depositWatcher.js';

export function isGroupChat(ctx: { chat?: { type?: string } }): boolean {
  const type = ctx.chat?.type;
  return type === 'group' || type === 'supergroup' || type === 'channel';
}

export function isPrivateChat(ctx: { chat?: { type?: string } }): boolean {
  return ctx.chat?.type === 'private';
}

export async function replyGroupDmRedirect(
  ctx: Context,
  featureName = 'Trading and wallet details'
): Promise<void> {
  const botUsername = getBotUsername(ctx);
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.url('🏎️ Open RacerBot in DM', `https://t.me/${botUsername}?start=menu`)],
  ]);
  await ctx.reply(
    `🔒 <b>${featureName} are private.</b>\n\n` +
    `To protect your wallet balance and security, trading, wallets, and settings are strictly restricted to private DM with @${botUsername}.`,
    {
      parse_mode: 'HTML',
      ...keyboard,
    }
  ).catch(() => { });
}

const near = getNear(RPC_PROVIDERS.length > 0 ? RPC_PROVIDERS : ['https://rpc.mainnet.fastnear.com']);

/** The multi-chain deposit chain picker: a private deposit while the user started one from 🛡 Private */
function depositChainPicker(telegramId: number | undefined, cat: Parameters<typeof buildDepositChainPickerMenu>[0] = 'popular') {
  const menu = buildDepositChainPickerMenu(cat);
  return telegramId && PRIVATE_TRADING_ENABLED && isPrivateDeposit(telegramId)
    ? privatizeDepositPicker(menu)
    : withSolanaDirectDepositRow(menu);
}

/** Adds a "Deposit SOL directly" row at the top of the multichain deposit picker. */
function withSolanaDirectDepositRow<T extends { text: string; keyboard: any }>(menu: T): T {
  try {
    const rows = menu.keyboard?.reply_markup?.inline_keyboard;
    if (Array.isArray(rows)) {
      if (!rows.some((r: any[]) => r.some((b: any) => b?.callback_data === 'dep_evm_direct'))) {
        rows.unshift([cb('⚡ Deposit HYPE directly (HyperEVM & Elysium)', 'dep_evm_direct', 'success')]);
      }
      if (!rows.some((r: any[]) => r.some((b: any) => b?.callback_data === 'dep_sol_direct'))) {
        rows.unshift([cb('◎ Deposit SOL directly (Solana wallet)', 'dep_sol_direct', 'success')]);
      }
    }
  } catch { /* keep the original menu */ }
  return menu;
}

/**
 * Quick-buy buttons for Solana. NEAR presets (1/5/10) would be far larger in
 * SOL terms, so Solana uses its own list. Override with SOLANA_BUY_PRESETS="0.1,0.25,0.5,1".
 */
export const EVM_BUY_PRESETS: number[] = (() => {
  const parsed = (process.env.EVM_BUY_PRESETS || '0.1,0.5,1,5')
    .split(/[,;\s]+/)
    .map((x) => parseFloat(x))
    .filter((x) => Number.isFinite(x) && x > 0);
  return parsed.length > 0 ? parsed.slice(0, 4) : [0.1, 0.5, 1, 5];
})();

export const SOLANA_BUY_PRESETS: number[] = (() => {
  const parsed = (process.env.SOLANA_BUY_PRESETS || '0.1,0.25,0.5,1')
    .split(/[,;\s]+/)
    .map((x) => parseFloat(x))
    .filter((x) => Number.isFinite(x) && x > 0);
  return parsed.length > 0 ? parsed.slice(0, 4) : [0.1, 0.25, 0.5, 1];
})();

export function parseBuyAmounts(raw?: string | null): number[] {
  if (!raw) return [1, 5, 10];
  const parsed = raw
    .split(/[,;\s]+/)
    .map(s => parseFloat(s.trim()))
    .filter(n => !isNaN(n) && n > 0);
  return parsed.length > 0 ? parsed.slice(0, 4) : [1, 5, 10];
}

// ── Colored inline buttons (Bot API 9.4) ─────────────────────────────────────
// InlineKeyboardButton.style: 'success' (green), 'danger' (red), 'primary'
// (blue). Telegraf's Markup builder doesn't expose the field yet, but the
// Bot API server honors the raw JSON; older clients ignore it and render
// default buttons — safe graceful fallback.
type BtnStyle = 'success' | 'danger' | 'primary';
function cb(text: string, callbackData: string, style?: BtnStyle): any {
  const btn: any = { text, callback_data: callbackData };
  if (style) btn.style = style;
  return btn;
}

// ── Token cache for snipe-by-name fuzzy matching ──────────────────────────────
export const localTokenNames = new Map<string, { address: string; symbol: string }>();

// ── Rate limiting for /export command (1 export per 5 minutes per user) ───────
const lastExportTime = new Map<number, number>();
const EXPORT_COOLDOWN_MS = 5 * 60 * 1000;

// ── User pending interactive input state ──────────────────────────────────────
interface PendingAction {
  action: PrivatePromptAction | 'buy_custom_near' | 'custom_slippage' | 'custom_buy_amounts' | 'custom_auto_buy' | 'custom_min_liq' | 'custom_max_mcap' | 'withdraw' | 'import_token'
  | 'snipe_token_ca' | 'snipe_token_amount' | 'snipe_custom_time' | 'snipe_dev_addr' | 'snipe_dev_amount'
  | 'sell_custom_tokens'
  // Stop Loss & Take Profit custom input
  | 'set_sl_custom' | 'set_tp_custom'
  // Copy Trading wizard
  | 'copy_wallet' | 'copy_amount' | 'copy_daily_budget'
  // DCA wizard
  | 'dca_token' | 'dca_amount' | 'dca_interval' | 'dca_orders' | 'dca_price_guard'
  // Multi-Wallet Management
  | 'import_near_key' | 'import_near_name' | 'import_near_confirm' | 'rename_near_wallet'
  | 'import_sui_key' | 'import_sui_name' | 'import_sui_confirm' | 'rename_sui_wallet'
  | 'rename_starknet_wallet'
  // Buy Alert group setup
  | 'set_group_token'
  // Limit Order wizard
  | 'lo_amount' | 'lo_target_value'
  // RaceDrop wizard
  | 'racedrop_amount' | 'racedrop_claims' | 'racedrop_mode'
  // RaceFleet wizard
  | 'fleet_custom_buy' | 'fleet_split_buy' | 'fleet_fund_amt' | 'fleet_fund_sol_amt' | 'fleet_sell_pct' | 'fleet_lo_target_value' | 'fleet_lo_amount'
  | 'deposit_custom_token' | 'deposit_custom_amount'
  // AI Swarm wizard
  | 'swarm_custom_prompt';
  tokenAddress?: string;
  positionId?: string;
  deployerAddress?: string;
  chatId?: string | number;
  chatTitle?: string;
  // Multi-wallet state
  importNearPrivateKey?: string;
  importNearAccountId?: string;
  importNearWalletName?: string;
  renameWalletId?: string;
  importSuiPrivateKey?: string;
  importSuiWalletName?: string;
  renameSuiWalletId?: string;
  renameStarknetWalletId?: string;
  // Copy trading wizard state
  copyWallet?: string;
  copyBuyAmount?: number;
  copyReferrerId?: string;
  // DCA wizard state
  dcaTokenAddress?: string;
  dcaSide?: 'buy' | 'sell';
  dcaAmount?: number;
  dcaInterval?: number;
  // Limit Order wizard state
  loTokenAddress?: string;
  loSide?: 'buy' | 'sell';
  loConditionType?: 'price' | 'market_cap' | 'percent_change';
  loTargetValue?: number;
  loAmount?: number;
  loExpiresAt?: number | null; // null = GTC
  // Snipe timing state
  snipeAmount?: number;
  // RaceDrop wizard state
  raceDropToken?: string;
  raceDropSymbol?: string;
  raceDropChain?: 'near' | 'sui';
  raceDropAmount?: number;
  raceDropAmountPerUser?: number;
  raceDropClaims?: number;
  raceDropMode?: 'equal' | 'lucky';
  raceDropNote?: string;
  raceDropCreatorName?: string;
  // RaceFleet wizard state
  fleetTokenAddress?: string;
  fleetSide?: 'buy' | 'sell';
  fleetLoConditionType?: 'price' | 'market_cap';
  fleetLoTargetValue?: number;
  depositChainId?: string;
  depositAssetId?: string;
  depositSymbol?: string;
  depositTokenKey?: string;
  // Swarm wizard state
  swarmTokenAddress?: string;
  swarmTotalNear?: number;
  expiresAt: number;
}
const userPendingActions = new Map<number, PendingAction>();

// NEAR account id: named (sub.)account.near or a 64-char hex implicit account
const NEAR_NAMED_ACCOUNT_RE = /^(([a-z0-9]+[-_])*[a-z0-9]+\.)*([a-z0-9]+[-_])*[a-z0-9]+$/;
function isValidNearAccountId(id: string): boolean {
  if (!id || id.length < 2 || id.length > 64) return false;
  if (/^[0-9a-f]{64}$/.test(id)) return true;
  return NEAR_NAMED_ACCOUNT_RE.test(id);
}

// ── SPEED: trade-path prewarm ────────────────────────────────────────────────
// Fires (fire-and-forget) when a token card is shown: resolves pool ids,
// warms storage registration cache (read-only view check), and warms the
// whitelist cache — so the first tap on Buy reaches signing in milliseconds
// without firing speculative on-chain transactions that cause nonce collisions.
async function prewarmTradePath(telegramId: number, tokenAddress: string): Promise<void> {
  try {
    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) return;
    const info = await getTokenInfo(tokenAddress, false).catch(() => null);
    if (!info || !info.tradeable) return;

    const venue = info.venue;

    const jobs: Promise<unknown>[] = [
      near.checkStorageRegistered(user.subaccount_id, tokenAddress).catch(() => false),
      checkTokenSafety(tokenAddress).catch(() => null),
    ];

    if (venue === 'rhea' || venue === 'ref') {
      jobs.push(
        near.findRheaPoolForToken(tokenAddress).catch(() => null),
        near.findDclPoolId('wrap.near', tokenAddress).catch(() => null),
        near.getWhitelistedTokens().catch(() => []),
      );
    } else if (venue === 'nearlytrade') {
      jobs.push(near.planNearlytradeRoute(tokenAddress).catch(() => null));
    } else if (venue === 'shoremarkets') {
      jobs.push(near.planShoremarketsRoute(tokenAddress).catch(() => null));
    }
    await Promise.all(jobs);
  } catch {
    // Prewarm is best-effort — never block or error the card.
  }
}

// ── Helper: Safe Markdown string sanitization ────────────────────────────────
function sanitizeMd(str: string): string {
  // Replace special Markdown characters but keep hyphens (valid in NEAR addresses)
  return (str || '').replace(/[_*`[\](~|>#+=|{}!@&%$^\\]/g, ' ');
}

// ── Helper: Build Main Menu ──────────────────────────────────────────────────
const mainMenuCache = new Map<number, { data: { text: string; keyboard: any }; expiresAt: number }>();

// ── Chain Visibility Helpers ────────────────────────────────────────────────
export const ALL_SUPPORTED_CHAINS = [
  { id: 'near', name: 'NEAR Protocol', symbol: 'NEAR', icon: '⬛' },
  { id: 'solana', name: 'Solana', symbol: 'SOL', icon: '🟣' },
  { id: 'hyperevm', name: 'HyperEVM (Mainnet)', symbol: 'HYPE', icon: '⚡' },
  { id: 'elysium', name: 'Elysium L2 (Testnet)', symbol: 'HYPE', icon: '🏛️' },
  { id: 'sui', name: 'Sui Network', symbol: 'SUI', icon: '🔷' },
  { id: 'starknet', name: 'Starknet', symbol: 'STRK', icon: '✨' },
] as const;

export type SupportedChainId = typeof ALL_SUPPORTED_CHAINS[number]['id'];

export function isChainVisible(user: { hidden_chains?: string[] } | null | undefined, chain: string): boolean {
  if (!user || !user.hidden_chains || !Array.isArray(user.hidden_chains) || user.hidden_chains.length === 0) {
    return true;
  }
  return !user.hidden_chains.includes(chain);
}

export function getVisibleChains(user: { hidden_chains?: string[] } | null | undefined): string[] {
  const hidden = new Set(user?.hidden_chains || []);
  return ALL_SUPPORTED_CHAINS.map(c => c.id).filter(id => !hidden.has(id));
}

export function formatActiveChainsSummary(user: { hidden_chains?: string[] } | null | undefined): string {
  const visible = getVisibleChains(user);
  if (visible.length === ALL_SUPPORTED_CHAINS.length) return '🌐 All Chains';
  return visible.map(id => {
    const c = ALL_SUPPORTED_CHAINS.find(item => item.id === id);
    return c ? `${c.icon} ${c.symbol}` : id;
  }).join(' • ');
}

export function resolveTokenChain(tokenAddress: string, chainHint?: string): 'solana' | 'starknet' | 'sui' | 'hyperevm' | 'elysium' | 'near' {
  if (chainHint === 'solana' || isSolanaToken(tokenAddress)) return 'solana';
  if (chainHint === 'starknet' || isStarknetToken(tokenAddress) || (isValidStarknetAddress(tokenAddress) && !tokenAddress.endsWith('.near'))) return 'starknet';
  if (chainHint === 'sui' || isSuiToken(tokenAddress)) return 'sui';
  if (chainHint === 'elysium' || tokenAddress.toLowerCase().endsWith('.elysium')) return 'elysium';
  if (chainHint === 'hyperevm' || (isValidEvmAddress(tokenAddress) && !tokenAddress.endsWith('.near'))) return 'hyperevm';
  return (chainHint as any) || 'near';
}

export function getPositionChain(pos: { chain?: string | null; token_address: string }): 'solana' | 'starknet' | 'sui' | 'hyperevm' | 'elysium' | 'near' {
  if (pos.chain === 'solana' || isSolanaToken(pos.token_address)) return 'solana';
  if (pos.chain === 'starknet' || isStarknetToken(pos.token_address) || (isValidStarknetAddress(pos.token_address) && !pos.token_address.endsWith('.near'))) return 'starknet';
  if (pos.chain === 'sui' || isSuiToken(pos.token_address)) return 'sui';
  if (pos.chain === 'elysium' || pos.token_address.toLowerCase().endsWith('.elysium')) return 'elysium';
  if (pos.chain === 'hyperevm' || (isValidEvmAddress(pos.token_address) && !pos.token_address.endsWith('.near'))) return 'hyperevm';
  return (pos.chain as any) || 'near';
}

export function getChainNativeUnit(tokenAddressOrChain: string, user?: UserRecord | null, chainHint?: string): string {
  const chain = ['solana', 'starknet', 'sui', 'hyperevm', 'elysium', 'near'].includes(tokenAddressOrChain)
    ? tokenAddressOrChain
    : resolveTokenChain(tokenAddressOrChain, chainHint);

  switch (chain) {
    case 'solana':
      return 'SOL';
    case 'starknet':
      return 'STRK';
    case 'sui':
      return 'SUI';
    case 'hyperevm':
    case 'elysium':
      return 'HYPE';
    case 'near':
    default:
      return user?.near_trade_currency === 'usdc' ? 'USDC' : 'NEAR';
  }
}

export function getPositionNativeUnit(pos: { chain?: string | null; token_address: string }, user?: UserRecord | null): string {
  return getChainNativeUnit(pos.chain || pos.token_address, user, pos.chain || undefined);
}

export function getChainUnitBtn(tokenAddressOrChain: string, user?: UserRecord | null): string {
  const chain = resolveTokenChain(tokenAddressOrChain);
  switch (chain) {
    case 'solana':
      return 'SOL';
    case 'starknet':
      return 'STRK';
    case 'sui':
      return 'SUI';
    case 'hyperevm':
    case 'elysium':
      return 'HYPE';
    case 'near':
    default:
      return user?.near_trade_currency === 'usdc' ? 'USDC' : 'N';
  }
}

export function getPositionUnitBtn(pos: { chain?: string | null; token_address: string }, user?: UserRecord | null): string {
  const chain = getPositionChain(pos);
  switch (chain) {
    case 'solana':
      return 'SOL';
    case 'starknet':
      return 'STRK';
    case 'sui':
      return 'SUI';
    case 'hyperevm':
    case 'elysium':
      return 'HYPE';
    case 'near':
    default:
      return user?.near_trade_currency === 'usdc' ? 'USDC' : 'N';
  }
}

export function buildActiveChainsMenu(user: UserRecord) {
  const hidden = new Set(user.hidden_chains || []);

  let text =
    '🌐 *Active Chains & Visibility*\n\n' +
    'Customize which chains appear across your menus, wallet balances, and token holdings.\n' +
    'Hiding a chain keeps your wallet & funds 100% safe while giving you a clean, dedicated single-chain or customized multi-chain experience.\n\n' +
    '*Current Status:*\n';

  for (const c of ALL_SUPPORTED_CHAINS) {
    const isVis = !hidden.has(c.id);
    text += `${c.icon} *${c.name}* (${c.symbol}): ${isVis ? '🟢 *Visible*' : '🔴 *Hidden*'}\n`;
  }

  text += '\n💡 _Tip: Tap any chain below to toggle its visibility, or tap a preset for instant 1-tap single-chain mode._';

  const buttons: any[] = [
    [
      cb(
        `${!hidden.has('near') ? '🟢' : '🔴'} ⬛ NEAR`,
        'toggle_chain_vis:near',
        !hidden.has('near') ? 'success' : 'primary'
      ),
      cb(
        `${!hidden.has('solana') ? '🟢' : '🔴'} 🟣 Solana`,
        'toggle_chain_vis:solana',
        !hidden.has('solana') ? 'success' : 'primary'
      ),
    ],
    [
      cb(
        `${!hidden.has('hyperevm') ? '🟢' : '🔴'} ⚡ HyperEVM`,
        'toggle_chain_vis:hyperevm',
        !hidden.has('hyperevm') ? 'success' : 'primary'
      ),
      cb(
        `${!hidden.has('elysium') ? '🟢' : '🔴'} 🏛️ Elysium`,
        'toggle_chain_vis:elysium',
        !hidden.has('elysium') ? 'success' : 'primary'
      ),
    ],
    [
      cb(
        `${!hidden.has('sui') ? '🟢' : '🔴'} 🔷 Sui`,
        'toggle_chain_vis:sui',
        !hidden.has('sui') ? 'success' : 'primary'
      ),
      cb(
        `${!hidden.has('starknet') ? '🟢' : '🔴'} ✨ Starknet`,
        'toggle_chain_vis:starknet',
        !hidden.has('starknet') ? 'success' : 'primary'
      ),
    ],
    [
      cb('⬛ NEAR Only', 'preset_chain_vis:near', 'primary'),
      cb('🟣 Solana Only', 'preset_chain_vis:solana', 'primary'),
    ],
    [
      cb('⚡ HyperEVM Only', 'preset_chain_vis:hyperevm', 'primary'),
      cb('🌐 Show All Chains', 'preset_chain_vis:all', 'primary'),
    ],
    [
      cb('⚙️ Settings', 'menu_settings', 'primary'),
      cb('🔙 Main Menu', 'menu_home', 'primary'),
    ],
  ];

  return { text, keyboard: Markup.inlineKeyboard(buttons) };
}

export async function buildMainMenu(telegramId: number, forceRefresh = false) {
  if (!forceRefresh) {
    const cached = mainMenuCache.get(telegramId);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.data;
    }
  }

  let user = await getUserByTelegramId(telegramId).catch(() => null);
  let subaccount = 'Not initialized';
  let suiAddress = '';
  let starknetAddress = '';
  let nearBalFormatted = '0';
  let nearUsdFormatted = '$0';
  let usdcBalFormatted = '0.00';
  let suiBalFormatted = '0';
  let suiUsdFormatted = '$0';
  let strkBalFormatted = '0';
  let ethBalFormatted = '0';
  let wrapNearFormatted = '0';
  let nativeNearFormatted = '0';
  let solAddress = '';
  let solBalFormatted = '0';
  let solUsdFormatted = '$0';
  let evmAddress = '';
  let hyperevmBalFormatted = '0.0000';
  let elysiumBalFormatted = '0.0000';
  let hyperevmUsdFormatted = '$0';
  let elysiumUsdFormatted = '$0';
  let totalUsdNum = 0;

  if (user) {
    const upgraded = await ensureUserAllWallets(user).catch(() => null);
    if (upgraded) user = upgraded;
    subaccount = user.subaccount_id;
    suiAddress = user.sui_address || '';
    starknetAddress = user.starknet_address || '';
    solAddress = user.solana_address || '';
    evmAddress = user.evm_address || '';
    try {
      const b = await getUserBalances(telegramId, forceRefresh, user);
      nearBalFormatted = b.totalNearFormatted;
      wrapNearFormatted = b.wrapNearFormatted || '0';
      nativeNearFormatted = b.nativeNearFormatted || '0';
      subaccount = b.subaccountId || user.subaccount_id;
      suiAddress = b.suiAddress || user.sui_address || '';
      suiBalFormatted = b.suiBalanceFormatted || '0';
      starknetAddress = b.starknetAddress || user.starknet_address || '';
      strkBalFormatted = b.strkBalanceFormatted || '0';
      ethBalFormatted = b.ethBalanceFormatted || '0';
      solAddress = b.solanaAddress || user.solana_address || '';
      solBalFormatted = b.solBalanceFormatted || '0';
      evmAddress = b.evmAddress || user.evm_address || '';
      hyperevmBalFormatted = b.hyperevmBalanceFormatted || '0.0000';
      elysiumBalFormatted = b.elysiumBalanceFormatted || '0.0000';

      const nearVisible = isChainVisible(user, 'near');
      const suiVisible = isChainVisible(user, 'sui');
      const starknetVisible = isChainVisible(user, 'starknet');
      const solanaVisible = isChainVisible(user, 'solana');
      const hyperevmVisible = isChainVisible(user, 'hyperevm');
      const elysiumVisible = isChainVisible(user, 'elysium');

      const rawNearUsd = parseFloat(b.totalNearFormatted || '0') * (b.nearUsd || 4.3);
      const rawSuiUsd = parseFloat(b.suiBalanceFormatted || '0') * (b.suiUsd || 2.0);
      const rawStrkUsd = parseFloat(b.strkBalanceFormatted || '0') * (b.strkUsd || 0.40);
      const rawEthUsd = parseFloat(b.ethBalanceFormatted || '0') * (b.ethUsd || 2600.0);
      const rawSolUsd = (parseFloat(b.solBalanceFormatted || '0') || 0) * (b.solUsd || 0);
      const rawHypePrice = b.hypeUsd || 25.0;
      const rawHyperevmUsd = (parseFloat(hyperevmBalFormatted || '0') || 0) * rawHypePrice;
      const rawElysiumUsd = (parseFloat(elysiumBalFormatted || '0') || 0) * rawHypePrice;

      const nearTotalUsdNum = nearVisible ? rawNearUsd : 0;
      const suiTotalUsdNum = suiVisible ? rawSuiUsd : 0;
      const strkTotalUsdNum = starknetVisible ? rawStrkUsd : 0;
      const ethTotalUsdNum = starknetVisible ? rawEthUsd : 0;
      const solTotalUsdNum = solanaVisible ? rawSolUsd : 0;
      const hyperevmTotalUsdNum = hyperevmVisible ? rawHyperevmUsd : 0;
      const elysiumTotalUsdNum = elysiumVisible ? rawElysiumUsd : 0;
      const usdcNearNum = nearVisible ? (parseFloat(b.usdcNearFormatted || '0') || 0) : 0;

      totalUsdNum = nearTotalUsdNum + suiTotalUsdNum + strkTotalUsdNum + ethTotalUsdNum + solTotalUsdNum + hyperevmTotalUsdNum + elysiumTotalUsdNum + usdcNearNum;
      usdcBalFormatted = b.usdcNearFormatted || '0.00';

      nearUsdFormatted = rawNearUsd >= 1000 ? `${(rawNearUsd / 1000).toFixed(2)}K` : `${rawNearUsd.toFixed(2)}`;
      suiUsdFormatted = rawSuiUsd >= 1000 ? `${(rawSuiUsd / 1000).toFixed(2)}K` : `${rawSuiUsd.toFixed(2)}`;
      solUsdFormatted = rawSolUsd >= 1000 ? `${(rawSolUsd / 1000).toFixed(2)}K` : `${rawSolUsd.toFixed(2)}`;
      hyperevmUsdFormatted = rawHyperevmUsd >= 1000 ? `${(rawHyperevmUsd / 1000).toFixed(2)}K` : `${rawHyperevmUsd.toFixed(2)}`;
      elysiumUsdFormatted = rawElysiumUsd >= 1000 ? `${(rawElysiumUsd / 1000).toFixed(2)}K` : `${rawElysiumUsd.toFixed(2)}`;
    } catch {
      nearBalFormatted = '0';
    }
  }

  const totalUsdStr = totalUsdNum >= 1000 ? `${(totalUsdNum / 1000).toFixed(2)}K` : `${totalUsdNum.toFixed(2)}`;

  const nearVisible = isChainVisible(user, 'near');
  const suiVisible = isChainVisible(user, 'sui');
  const starknetVisible = isChainVisible(user, 'starknet');
  const solanaVisible = isChainVisible(user, 'solana');
  const hyperevmVisible = isChainVisible(user, 'hyperevm');
  const elysiumVisible = isChainVisible(user, 'elysium');

  let text = `🏎 <b>RacerBot V2.0</b> • 💼 <b>W1</b> ⭐\n`;
  if (nearVisible) {
    text += `⬛ NEAR: <b>${nearBalFormatted}</b> Ⓝ (${nearUsdFormatted}) • 💵 USDC: <b>${usdcBalFormatted}</b>\n`;
    if (Number(wrapNearFormatted) > 0.0001) {
      text += `   ↳ Native: ${nativeNearFormatted} Ⓝ | Wrapped: ${wrapNearFormatted} wNEAR\n`;
    }
  }
  if (solanaVisible && solAddress) {
    text += `🟣 SOL: <b>${solBalFormatted}</b> ◎ (${solUsdFormatted})\n`;
  }
  if (hyperevmVisible) {
    text += `⚡ HyperEVM: <b>${hyperevmBalFormatted}</b> HYPE (${hyperevmUsdFormatted})\n`;
  }
  if (elysiumVisible) {
    text += `🏛️ Elysium (Testnet): <b>${elysiumBalFormatted}</b> HYPE (${elysiumUsdFormatted})\n`;
  }
  if (suiVisible) {
    text += `🔷 SUI: <b>${suiBalFormatted}</b> 💧 (${suiUsdFormatted})\n`;
  }
  if (starknetVisible && starknetAddress) {
    text += `✨ STRK: <b>${strkBalFormatted}</b> • ETH: <b>${ethBalFormatted}</b>\n`;
  }
  text += `💰 Total: <b>${totalUsdStr}</b>\n\n`;

  if (nearVisible && subaccount) {
    text += `📍 NEAR: <code>${subaccount}</code>\n\n`;
  }
  if (solanaVisible && solAddress) {
    text += `◎ SOL: <code>${solAddress}</code>\n\n`;
  }
  if ((hyperevmVisible || elysiumVisible) && evmAddress) {
    text += `⚡ EVM (HyperEVM & Elysium Testnet):\n<code>${evmAddress}</code>\n\n`;
  }
  if (suiVisible && suiAddress) {
    text += `💧 SUI: <code>${suiAddress}</code>\n\n`;
  }
  if (starknetVisible && starknetAddress) {
    text += `✨ STRK: <code>${starknetAddress}</code>\n\n`;
  }
  text = text.trimEnd();

  const mainButtons: any[] = [
    [
      cb('📥 Deposit', 'menu_multichain_deposit', 'success'),
      cb('💳 Wallet', 'menu_wallet', 'primary'),
    ],
  ];

  if (nearVisible && Number(wrapNearFormatted) > 0.001) {
    mainButtons.push([cb(`🔄 Unwrap ${wrapNearFormatted} wNEAR`, 'wallet_unwrap', 'primary')]);
  }

  mainButtons.push(
    [
      cb('🎒 Your Bags', 'menu_holdings', 'primary'),
      cb('🔄 Refresh', 'menu_refresh', 'primary'),
    ],
    [
      cb('🎯 Snipe', 'menu_snipe', 'primary'),
      cb('👥 Copy Trade', 'menu_copy', 'success'),
    ],
    [
      cb('🔁 DCA', 'menu_dca', 'primary'),
      cb('📈 PnL', 'menu_pnl', 'primary'),
    ],
    [
      cb('🤖 AI Swarm', 'menu_swarm', 'success'),
      cb('🏎️ RaceFleet', 'racefleet_menu', 'primary'),
    ],
    [
      cb('🛡 Private', 'menu_private', 'success'),
      cb('🏆 Points', 'menu_points', 'success'),
    ],
    [
      cb('⚙️ Settings', 'menu_settings', 'primary'),
      cb('🏁 My Racer Card', 'racer_card', 'success'),
    ],
    [
      Markup.button.url('💬 Chat', 'https://t.me/racerbot_community'),
      Markup.button.url('📢 Updates', 'https://t.me/racertrading'),
      Markup.button.url('𝕏 X', 'https://x.com/racertradingbot'),
    ],
  );

  const keyboard = Markup.inlineKeyboard(mainButtons);
  const res = { text, keyboard };
  mainMenuCache.set(telegramId, { data: res, expiresAt: Date.now() + 6_000 });
  return res;
}

// ── Helper: Build Points (Season 1) view ────────────────────────────────────
export async function buildPointsView(telegramId: number) {
  const user = await getUserByTelegramId(telegramId);
  if (!user) throw new Error('Please run /start first.');

  const s = await getPointsSummary(user.id);
  const leaders = await getPointsLeaderboard(5).catch(() => []);

  const msLeft = s.seasonEnd.getTime() - Date.now();
  const timeLeft = msLeft > 0
    ? `${Math.floor(msLeft / 86_400_000)}d ${Math.floor((msLeft % 86_400_000) / 3_600_000)}h left`
    : 'Season ended';

  const fmt = (n: number) => n.toLocaleString('en-US');
  const bd = s.breakdown;
  const bdLines: string[] = [];
  if (bd.trade) bdLines.push(`📈 Trading: \`${fmt(bd.trade)}\``);
  if (bd.referral_qualified || bd.referral_override || bd.referral_welcome) {
    const refTotal = (bd.referral_qualified || 0) + (bd.referral_override || 0) + (bd.referral_welcome || 0);
    bdLines.push(`👥 Referrals: \`${fmt(refTotal)}\``);
  }
  if (bd.daily_active) bdLines.push(`🔥 Daily activity: \`${fmt(bd.daily_active)}\``);
  if (bd.first_trade) bdLines.push(`✨ First trade bonus: \`${fmt(bd.first_trade)}\``);

  const lbLines = leaders.map((l, i) => `${i + 1}. ${sanitizeMd(l.label)} — \`${fmt(l.points)}\``);

  const text =
    `🏆 *RacerBot Points — Season 1*\n\n` +
    `⭐ *Points*: \`${fmt(s.effectivePoints)}\`${s.earlyBird ? ` (base \`${fmt(s.basePoints)}\` × 1.25 🐣 Early Bird)` : ''}\n` +
    `🎖 *Rank*: \`#${s.rank}\` of ${fmt(Math.max(s.totalUsers, 1))}\n` +
    `⏳ *Snapshot*: Oct 15, 23:59 UTC (${timeLeft})\n\n` +
    (bdLines.length > 0 ? `📊 *Breakdown*\n${bdLines.join('\n')}\n\n` : '') +
    (lbLines.length > 0 ? `🏅 *Top Racers*\n${lbLines.join('\n')}\n\n` : '') +
    `*Earn Points*\n` +
    `📈 \`1.5 pts\` per 1 NEAR / SUI traded\n` +
    `👥 \`500 pts\` per referral + 5% of their volume\n` +
    `🔥 \`25 pts\` per day of trading streak\n\n` +
    `_Points convert to $RACER at TGE._`;

  const keyboard = Markup.inlineKeyboard([
    [cb('🔄 Refresh', 'menu_points_refresh', 'primary')],
    [cb('🔙 Back', 'menu_home', 'primary')],
  ]);

  return { text, keyboard };
}

export function formatHoldingQuantity(quantityHeld: string, decimals = 18): string {
  try {
    const raw = (quantityHeld || '0').split('.')[0];
    const rawBig = BigInt(raw);
    if (rawBig === 0n) return '0';
    const divisor = BigInt(10) ** BigInt(decimals);
    const whole = rawBig / divisor;
    const remainder = rawBig % divisor;
    const human = Number(whole) + Number(remainder) / Math.pow(10, decimals);
    if (human >= 1_000_000_000_000) return `${(human / 1_000_000_000_000).toFixed(2)}T`;
    if (human >= 1_000_000_000) return `${(human / 1_000_000_000).toFixed(2)}B`;
    if (human >= 1_000_000) return `${(human / 1_000_000).toFixed(2)}M`;
    if (human >= 1_000) return human.toLocaleString('en-US', { maximumFractionDigits: 2 });
    if (human >= 1) return human.toFixed(2);
    if (human >= 0.0001) return human.toFixed(4);
    if (human >= 0.000001) return human.toFixed(6);
    return human.toExponential(2);
  } catch {
    const num = parseFloat(quantityHeld);
    if (isNaN(num) || num <= 0) return '0';
    if (num >= 1_000_000_000_000) return `${(num / 1_000_000_000_000).toFixed(2)}T`;
    if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(2)}B`;
    if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
    if (num >= 1000) return num.toLocaleString('en-US', { maximumFractionDigits: 2 });
    if (num >= 1) return num.toFixed(2);
    return num.toFixed(4);
  }
}

// ── Helper: Build Wallet Menu ────────────────────────────────────────────────
const walletMenuCache = new Map<number, { data: { text: string; keyboard: any }; expiresAt: number }>();

export async function buildWalletMenu(telegramId: number, forceRefresh = false) {
  if (!forceRefresh) {
    const cached = walletMenuCache.get(telegramId);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.data;
    }
  }

  markUserActiveForDeposit(telegramId);
  checkUserDepositNow(telegramId).catch(() => { });
  let user = await getUserByTelegramId(telegramId);
  if (!user) {
    try {
      await onboardUser(telegramId);
      user = await getUserByTelegramId(telegramId);
    } catch (err: any) {
      console.warn('[buildWalletMenu] auto-onboard failed:', err?.message);
    }
  }

  const b = await getUserBalances(telegramId, forceRefresh, user);
  const nearVisible = isChainVisible(user, 'near');
  const suiVisible = isChainVisible(user, 'sui');
  const starknetVisible = isChainVisible(user, 'starknet');
  const solanaVisible = isChainVisible(user, 'solana');
  const hyperevmVisible = isChainVisible(user, 'hyperevm');
  const elysiumVisible = isChainVisible(user, 'elysium');

  const rawHypePrice = b.hypeUsd || 25.0;
  const hyperevmUsdNum = hyperevmVisible ? (parseFloat(b.hyperevmBalanceFormatted || '0') || 0) * rawHypePrice : 0;
  const elysiumUsdNum = elysiumVisible ? (parseFloat(b.elysiumBalanceFormatted || '0') || 0) * rawHypePrice : 0;

  const nearTotalUsdNum = nearVisible ? parseFloat(b.totalNearFormatted || '0') * (b.nearUsd || 4.3) : 0;
  const suiTotalUsdNum = suiVisible ? parseFloat(b.suiBalanceFormatted || '0') * (b.suiUsd || 2.0) : 0;
  const strkTotalUsdNum = starknetVisible ? parseFloat(b.strkBalanceFormatted || '0') * (b.strkUsd || 0.40) : 0;
  const ethTotalUsdNum = starknetVisible ? parseFloat(b.ethBalanceFormatted || '0') * (b.ethUsd || 2600.0) : 0;
  const solTotalUsdNum = solanaVisible ? (parseFloat(b.solBalanceFormatted || '0') || 0) * (b.solUsd || 0) : 0;
  const usdcNearNum = nearVisible ? (parseFloat(b.usdcNearFormatted || '0') || 0) : 0;
  const totalUsdNum = nearTotalUsdNum + suiTotalUsdNum + strkTotalUsdNum + ethTotalUsdNum + solTotalUsdNum + hyperevmUsdNum + elysiumUsdNum + usdcNearNum;
  const totalUsdStr = totalUsdNum >= 1000 ? `${(totalUsdNum / 1000).toFixed(2)}K` : `${totalUsdNum.toFixed(2)}`;

  const [nearWallets, suiWallets] = user
    ? await Promise.all([
      getUserWallets(user.id, 'near').catch(() => []),
      getUserWallets(user.id, 'sui').catch(() => []),
    ])
    : [[], []];
  const activeNearWallet = nearWallets.find(w => w.is_active) || nearWallets[0];
  const walletDisplayName = activeNearWallet ? activeNearWallet.name : 'Wallet 1';
  const walletsCount = (nearWallets.length + suiWallets.length) || 1;

  const buttons: any[] = [
    [
      cb('📥 Deposit', 'menu_multichain_deposit', 'success'),
      cb('💸 Withdraw', 'wallet_withdraw_prompt', 'primary'),
    ],
    [
      cb('🔄 Refresh', 'wallet_refresh', 'primary'),
      cb('🏎️ RaceDrop', 'racedrop_start', 'primary'),
    ],
  ];

  if (nearVisible && Number(b.wrapNearFormatted) > 0.0001) {
    buttons.push([cb(`🔄 Unwrap ${b.wrapNearFormatted} wNEAR`, 'wallet_unwrap', 'primary')]);
  }

  buttons.push([
    cb(`💳 Wallets (${walletsCount})`, 'wallets_menu', 'primary'),
    cb('🎒 Your Bags', 'menu_holdings', 'primary'),
  ]);

  buttons.push([
    cb('⚙️ Settings', 'menu_settings', 'primary'),
    cb('🔑 Export Key', 'export_prompt', 'primary'),
  ]);
  buttons.push([
    cb('🔙 Main Menu', 'menu_home', 'primary'),
  ]);

  buttons.push([
    Markup.button.url('💬 Community', 'https://t.me/racerbot_community'),
    Markup.button.url('📢 Updates', 'https://t.me/racertrading'),
    Markup.button.url('𝕏 X', 'https://x.com/racertradingbot'),
  ]);

  let text = `💼 <b>${escapeHtml(walletDisplayName)}</b> ⭐\n`;
  if (nearVisible) {
    text += `⬛ NEAR: <b>${b.totalNearFormatted}</b> Ⓝ (${b.totalNearUsd})\n`;
    text += `💵 USDC (NEAR): <b>${b.usdcNearFormatted || '0.00'}</b> USDC (${b.usdcNearUsd || '$0.00'})\n`;
    text += `• Spendable: <b>${b.nativeNearFormatted} Ⓝ</b> (On-chain: ${b.onChainNearFormatted || b.nativeNearFormatted} Ⓝ, 0.05 Ⓝ reserved for storage)\n`;
    if (Number(b.wrapNearFormatted) > 0.0001) {
      text += `• Wrapped: <b>${b.wrapNearFormatted} wNEAR</b>\n`;
    }
  }
  if (suiVisible) {
    text += `🔷 SUI: <b>${b.suiBalanceFormatted || '0.0000'}</b> 💧 (${b.suiBalanceUsd || '$0.00'})\n`;
  }
  if (starknetVisible && b.starknetAddress) {
    const starkUsdSum = strkTotalUsdNum + ethTotalUsdNum;
    const starkUsdStr = starkUsdSum >= 1000 ? `${(starkUsdSum / 1000).toFixed(2)}K` : `${starkUsdSum.toFixed(2)}`;
    text += `✨ STRK: <b>${b.strkBalanceFormatted || '0'}</b> • ETH: <b>${b.ethBalanceFormatted || '0'}</b> (${starkUsdStr})\n`;
  }
  if (solanaVisible && b.solanaAddress) {
    text += `🟣 SOL: <b>${b.solBalanceFormatted || '0.0000'}</b> ◎ (${b.solBalanceUsd || '$0.00'})\n`;
  }
  if (b.evmAddress) {
    text += `⚡ HyperEVM: <b>${b.hyperevmBalanceFormatted || '0.0000'}</b> HYPE • Elysium (Testnet): <b>${b.elysiumBalanceFormatted || '0.0000'}</b> HYPE\n`;
  }
  text += `💰 Total: <b>${totalUsdStr}</b>\n\n`;

  if (nearVisible) text += `📍 NEAR: <code>${escapeHtml(b.subaccountId)}</code>\n\n`;
  if (suiVisible && b.suiAddress) text += `💧 SUI: <code>${escapeHtml(b.suiAddress)}</code>\n\n`;
  if (starknetVisible && b.starknetAddress) text += `✨ STRK: <code>${escapeHtml(b.starknetAddress)}</code>\n\n`;
  if (solanaVisible && b.solanaAddress) text += `◎ SOL: <code>${escapeHtml(b.solanaAddress)}</code>\n\n`;
  if (b.evmAddress) text += `⚡ EVM (HyperEVM & Elysium Testnet): <code>${escapeHtml(b.evmAddress)}</code>\n\n`;
  text = text.trimEnd();

  const res = { text, keyboard: Markup.inlineKeyboard(buttons) };
  walletMenuCache.set(telegramId, { data: res, expiresAt: Date.now() + 6_000 });
  return res;
}

// ── Helper: Build Wallets Management Menu ────────────────────────────────────
export async function buildWalletsManagementMenu(telegramId: number) {
  let user = await getUserByTelegramId(telegramId);
  if (!user) {
    try {
      await onboardUser(telegramId);
      user = await getUserByTelegramId(telegramId);
    } catch (err: any) {
      console.warn('[buildWalletsManagementMenu] auto-onboard failed:', err?.message);
    }
  }
  if (!user) throw new Error('User not found. Run /start first.');

  const nearWallets: UserWalletRecord[] = await getUserWallets(user.id, 'near').catch(() => []);
  const suiWallets: UserWalletRecord[] = await getUserWallets(user.id, 'sui').catch(() => []);
  const starknetWallets: UserWalletRecord[] = await getUserWallets(user.id, 'starknet').catch(() => []);

  // Self-heal: ensure default active NEAR wallet is in nearWallets if missing
  if (user.subaccount_id && !nearWallets.some(w => w.address === user.subaccount_id)) {
    if (user.scoped_key_encrypted) {
      try {
        const created = await createUserWallet({
          userId: user.id,
          chain: 'near',
          address: user.subaccount_id,
          name: nearWallets.length === 0 ? 'Wallet 1' : `Wallet ${nearWallets.length + 1}`,
          encryptedPrivateKey: user.scoped_key_encrypted,
          isImported: false,
          isActive: nearWallets.length === 0 || !nearWallets.some(w => w.is_active),
        });
        nearWallets.push(created);
      } catch {
        nearWallets.push({
          id: 'default_near',
          user_id: user.id,
          chain: 'near',
          address: user.subaccount_id,
          name: 'Wallet 1',
          encrypted_private_key: user.scoped_key_encrypted,
          is_imported: false,
          is_active: true,
          created_at: new Date(),
        });
      }
    } else {
      nearWallets.push({
        id: 'default_near',
        user_id: user.id,
        chain: 'near',
        address: user.subaccount_id,
        name: 'Wallet 1',
        encrypted_private_key: '',
        is_imported: false,
        is_active: true,
        created_at: new Date(),
      });
    }
  }

  // Self-heal: ensure default active SUI wallet is in suiWallets if missing
  if (user.sui_address && !suiWallets.some(w => w.address === user.sui_address)) {
    if (user.sui_private_key_enc) {
      try {
        const created = await createUserWallet({
          userId: user.id,
          chain: 'sui',
          address: user.sui_address,
          name: suiWallets.length === 0 ? 'Wallet 1' : `Wallet ${suiWallets.length + 1}`,
          encryptedPrivateKey: user.sui_private_key_enc,
          isImported: false,
          isActive: suiWallets.length === 0 || !suiWallets.some(w => w.is_active),
        });
        suiWallets.push(created);
      } catch {
        suiWallets.push({
          id: 'default_sui',
          user_id: user.id,
          chain: 'sui',
          address: user.sui_address,
          name: 'Wallet 1',
          encrypted_private_key: user.sui_private_key_enc,
          is_imported: false,
          is_active: true,
          created_at: new Date(),
        });
      }
    } else {
      suiWallets.push({
        id: 'default_sui',
        user_id: user.id,
        chain: 'sui',
        address: user.sui_address,
        name: 'Wallet 1',
        encrypted_private_key: '',
        is_imported: false,
        is_active: true,
        created_at: new Date(),
      });
    }
  }

  // Self-heal: ensure default active Starknet wallet is in starknetWallets if missing
  if (user.starknet_address && !starknetWallets.some(w => w.address === user.starknet_address)) {
    if (user.starknet_private_key_enc) {
      try {
        const created = await createUserWallet({
          userId: user.id,
          chain: 'starknet',
          address: user.starknet_address,
          name: starknetWallets.length === 0 ? 'Wallet 1' : `Wallet ${starknetWallets.length + 1}`,
          encryptedPrivateKey: user.starknet_private_key_enc,
          isImported: false,
          isActive: starknetWallets.length === 0 || !starknetWallets.some(w => w.is_active),
        });
        starknetWallets.push(created);
      } catch {
        starknetWallets.push({
          id: 'default_starknet',
          user_id: user.id,
          chain: 'starknet',
          address: user.starknet_address,
          name: 'Wallet 1',
          encrypted_private_key: user.starknet_private_key_enc,
          is_imported: false,
          is_active: true,
          created_at: new Date(),
        });
      }
    } else {
      starknetWallets.push({
        id: 'default_starknet',
        user_id: user.id,
        chain: 'starknet',
        address: user.starknet_address,
        name: 'Wallet 1',
        encrypted_private_key: '',
        is_imported: false,
        is_active: true,
        created_at: new Date(),
      });
    }
  }

  let text = `💼 <b>Multi-Chain Wallets</b>\n\n`;
  text += `Switch active wallet per chain,\nor import an existing private key:\n\n`;

  const buttons: any[] = [];

  // 1. NEAR Wallets Section
  text += `⬛ <b>NEAR Wallets</b>\n`;
  for (let i = 0; i < nearWallets.length; i++) {
    const w = nearWallets[i];
    const isActive = w.is_active;
    const statusIcon = isActive ? '🟢' : '⚪';
    const activeLabel = isActive ? ' <b>[Active Trading Wallet]</b>' : '';
    const importedLabel = w.is_imported ? ' 📥' : '';

    if (isActive) {
      text += `${i + 1}. ${statusIcon} <b>⭐ ${escapeHtml(w.name)}</b>${importedLabel}${activeLabel}\n`;
    } else {
      text += `${i + 1}. ${statusIcon} <b>${escapeHtml(w.name)}</b>${importedLabel}${activeLabel}\n`;
    }
    text += `   <code>${escapeHtml(w.address)}</code>\n\n`;

    const row: any[] = [];
    if (w.id && !w.id.startsWith('default_')) {
      if (isActive) {
        row.push(cb(`✓ Active`, `w_sw_near:${w.id}`, 'success'));
      } else {
        row.push(cb(`⚡ Set Active`, `w_sw_near:${w.id}`, 'primary'));
      }
    }
    if (w.id && !w.id.startsWith('default_')) {
      row.push(cb(`✏️ Rename`, `w_ren_near:${w.id}`, 'primary'));
    }
    if (w.is_imported && !isActive && w.id && !w.id.startsWith('default_')) {
      row.push(cb(`🗑️ Delete`, `w_del_near:${w.id}`, 'primary'));
    }
    if (row.length > 0) {
      buttons.push(row);
    }
  }

  // 2. SUI Wallets Section
  text += `🔷 <b>SUI Wallets</b>\n`;
  for (let i = 0; i < suiWallets.length; i++) {
    const w = suiWallets[i];
    const isActive = w.is_active;
    const statusIcon = isActive ? '🟢' : '⚪';
    const activeLabel = isActive ? ' <b>[Active Trading Wallet]</b>' : '';
    const importedLabel = w.is_imported ? ' 📥' : '';

    if (isActive) {
      text += `${i + 1}. ${statusIcon} <b>⭐ ${escapeHtml(w.name)}</b>${importedLabel}${activeLabel}\n`;
    } else {
      text += `${i + 1}. ${statusIcon} <b>${escapeHtml(w.name)}</b>${importedLabel}${activeLabel}\n`;
    }
    text += `   <code>${escapeHtml(w.address)}</code>\n\n`;

    const row: any[] = [];
    if (w.id && !w.id.startsWith('default_')) {
      if (isActive) {
        row.push(cb(`✓ Active`, `w_sw_sui:${w.id}`, 'success'));
      } else {
        row.push(cb(`⚡ Set Active`, `w_sw_sui:${w.id}`, 'primary'));
      }
    }
    if (w.id && !w.id.startsWith('default_')) {
      row.push(cb(`✏️ Rename`, `w_ren_sui:${w.id}`, 'primary'));
    }
    if (w.is_imported && !isActive && w.id && !w.id.startsWith('default_')) {
      row.push(cb(`🗑️ Delete`, `w_del_sui:${w.id}`, 'primary'));
    }
    if (row.length > 0) {
      buttons.push(row);
    }
  }

  // 3. Starknet Wallets Section
  text += `⚡ <b>Starknet Wallets</b>\n`;
  for (let i = 0; i < starknetWallets.length; i++) {
    const w = starknetWallets[i];
    const isActive = w.is_active;
    const statusIcon = isActive ? '🟢' : '⚪';
    const activeLabel = isActive ? ' <b>[Active Trading Wallet]</b>' : '';
    const importedLabel = w.is_imported ? ' 📥' : '';

    if (isActive) {
      text += `${i + 1}. ${statusIcon} <b>⭐ ${escapeHtml(w.name)}</b>${importedLabel}${activeLabel}\n`;
    } else {
      text += `${i + 1}. ${statusIcon} <b>${escapeHtml(w.name)}</b>${importedLabel}${activeLabel}\n`;
    }
    text += `   <code>${escapeHtml(w.address)}</code>\n\n`;

    const row: any[] = [];
    if (w.id && !w.id.startsWith('default_')) {
      if (isActive) {
        row.push(cb(`✓ Active`, `w_sw_sn:${w.id}`, 'success'));
      } else {
        row.push(cb(`⚡ Set Active`, `w_sw_sn:${w.id}`, 'primary'));
      }
    }
    if (w.id && !w.id.startsWith('default_')) {
      row.push(cb(`✏️ Rename`, `w_ren_sn:${w.id}`, 'primary'));
    }
    if (row.length > 0) {
      buttons.push(row);
    }
  }

  // Import / action buttons row
  const actionRow: any[] = [];
  if (nearWallets.length < MAX_NEAR_WALLETS_PER_USER) {
    actionRow.push(cb('📥 Import NEAR', 'wallet_import_prompt', 'primary'));
  }
  if (suiWallets.length < MAX_SUI_WALLETS_PER_USER) {
    actionRow.push(cb('📥 Import SUI', 'wallet_import_sui_prompt', 'primary'));
  }
  if (actionRow.length > 0) {
    buttons.push(actionRow);
  }

  buttons.push([
    cb('🔄 New Starknet Wallet', 'wallet_new_starknet', 'primary'),
  ]);

  buttons.push([
    cb('🔙 Back to Wallet', 'wallet_refresh', 'primary'),
  ]);

  return { text, keyboard: Markup.inlineKeyboard(buttons) };
}

// ── Helper: Build Token Details Card with In-Chat Buttons ───────────────────

export async function extractEvmCandidate(text: string): Promise<string | null> {
  if (!text) return null;
  const trimmed = text.trim();

  // 1. DexScreener link (hyperevm or elysium)
  const dexscreenerMatch = /(?:dexscreener\.com\/(?:hyperevm|elysium)\/)(0x[0-9a-fA-F]{40})/i.exec(trimmed);
  if (dexscreenerMatch) {
    const matchedAddr = dexscreenerMatch[1];
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/pairs/hyperevm/${matchedAddr}`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const data: any = await res.json();
        const pair = data?.pair || (Array.isArray(data?.pairs) ? data.pairs[0] : null);
        const baseAddr = pair?.baseToken?.address;
        if (baseAddr && isValidEvmAddress(baseAddr)) {
          return baseAddr;
        }
      }
    } catch { /* fallback to matchedAddr */ }
    return matchedAddr;
  }

  // 2. Hypurrscan / Purr.fun / Elysium / Hyperliquid explorer links
  const explorerMatch = /(?:hypurrscan\.io|purr\.fun|elysium\.kinetiq\.xyz|hyperliquid\.xyz)\/(?:token|address|pool)\/(0x[0-9a-fA-F]{40})/i.exec(trimmed);
  if (explorerMatch) {
    return explorerMatch[1];
  }

  // 3. Direct EVM address (40 hex characters prefixed with 0x)
  const directEvmMatch = /(?:^|[\s/])(0x[0-9a-fA-F]{40})(?:[\s/?#]|$)/i.exec(trimmed);
  if (directEvmMatch && isValidEvmAddress(directEvmMatch[1])) {
    return directEvmMatch[1];
  }

  return null;
}

export async function buildTokenCard(tokenAddress: string, telegramId?: number, forceRefresh = false): Promise<{ text: string; keyboard: any; pnlCardImage?: Buffer }> {
  // Fetch token info, balance, user settings, and honeypot safety audit in parallel
  const [info, balances, user, safetyRes] = await Promise.allSettled([
    getTokenInfo(tokenAddress, forceRefresh),
    telegramId ? getUserBalances(telegramId).catch(() => null) : Promise.resolve(null),
    telegramId ? getUserByTelegramId(telegramId).catch(() => null) : Promise.resolve(null),
    withTimeout(checkTokenSafety(tokenAddress), 3500, 'safety check timeout').catch(() => null),
  ]);

  if (info.status === 'rejected') {
    throw info.reason;
  }

  const tokenInfo = info.value;
  const safety = safetyRes.status === 'fulfilled' ? safetyRes.value : null;
  const b = balances.status === 'fulfilled' ? balances.value : null;
  let userRecord = user.status === 'fulfilled' ? user.value : null;

  // If user tapped a token card without ever running /start, auto-onboard them so
  // their user record exists, wallet subaccount is ready, and token share links can be generated
  if (!userRecord && telegramId) {
    try {
      await withTimeout(onboardUser(telegramId), 3000, 'auto-onboard timeout');
      userRecord = await getUserByTelegramId(telegramId).catch(() => null);
    } catch (err: any) {
      console.warn('[buildTokenCard] Auto-onboard user failed or timed out:', err?.message);
    }
  }

  const defaultBuyPct = userRecord?.default_buy_pct ? Number(userRecord.default_buy_pct) : 10;

  // Fetch positions only if we have a user
  let userPositions: any[] = [];
  if (userRecord) {
    try {
      userPositions = await getOpenPositions(userRecord.id).catch(() => []);
    } catch {
      userPositions = [];
    }
  }

  // Check if user holds this token
  const userPosition = userPositions.find(p => p.token_address === tokenAddress);
  const holdsToken = !!userPosition;

  const isSolana = tokenInfo.chain === 'solana';
  const isStarknet = !isSolana && (tokenInfo.chain === 'starknet' || isStarknetToken(tokenAddress));
  const isSui = !isSolana && !isStarknet && (tokenInfo.chain === 'sui' || tokenInfo.venue === 'suipump' || isSuiToken(tokenAddress));
  const isEvm = !isSolana && !isStarknet && !isSui && (tokenInfo.chain === 'hyperevm' || tokenInfo.chain === 'elysium' || isValidEvmAddress(tokenAddress));
  const isHyperEvm = isEvm && tokenInfo.chain !== 'elysium' && !tokenAddress.toLowerCase().endsWith('.elysium');
  const isElysium = isEvm && !isHyperEvm;
  // Kleos coins live on Elysium mainnet (99901); every other Elysium token here is on the Kinetiq testnet
  const isKleos = isElysium && tokenInfo.venue === 'kleos';
  // Kleos buys are paid from HyperEVM HYPE and sale proceeds land on Elysium mainnet, so the card shows both
  const kleosWallet = isKleos ? (b?.evmAddress || userRecord?.evm_address) : null;
  const kleosElysiumBal = kleosWallet ? await getHypeBalance(kleosWallet, 'elysium', false).catch(() => null) : null;
  const isNearUsdcMode = !isSolana && !isStarknet && !isSui && userRecord?.near_trade_currency === 'usdc';
  const nativeUnit = isSolana ? 'SOL' : isStarknet ? 'STRK' : (isSui ? 'SUI' : (isEvm ? 'HYPE' : (isNearUsdcMode ? 'USDC' : 'NEAR')));
  const unitBtn = isSolana ? 'SOL' : isStarknet ? 'STRK' : (isSui ? 'SUI' : (isEvm ? 'HYPE' : (isNearUsdcMode ? 'USDC' : 'N')));
  const nearModeBuyPresets = isNearUsdcMode && !userRecord?.custom_buy_amounts ? [5, 15, 50] : parseBuyAmounts(userRecord?.custom_buy_amounts);

  // Check if user has an active RaceFleet and whether it holds this target token
  let fleet: any = null;
  let fleetPosition: FleetTokenPosition | null = null;
  if (userRecord && !isSui && !isStarknet && !isEvm) {
    try {
      fleet = await getRaceFleetByUserId(userRecord.id).catch(() => null);
      if (fleet && fleet.status === 'active') {
        fleetPosition = await getFleetTokenPosition(fleet.id, tokenAddress).catch(() => null);
      }
    } catch (err: any) {
      console.warn('[buildTokenCard] fleet lookup failed:', err?.message);
    }
  }
  const fleetHoldsToken = Boolean(fleetPosition && fleetPosition.totalBalanceHuman > 0.000001);

  const balanceText = isSolana
    ? (b ? `💳 *SOL Wallet Balance*: \`${b.solBalanceFormatted || '0.0000'} SOL\` (\`${b.solBalanceUsd || '$0.00'}\`)\n\n` : '')
    : isStarknet
      ? (b ? `💳 *Starknet Wallet Balance*: \`${b.strkBalanceFormatted || '0.0000'} STRK\` | \`${b.ethBalanceFormatted || '0.0000'} ETH\`\n\n` : '')
      : (isSui
        ? (b ? `💳 *SUI Wallet Balance*: \`${b.suiBalanceFormatted || '0.0000'} SUI\` (\`${b.suiBalanceUsd || '$0.00'}\`)\n\n` : '')
        : (isKleos
          ? (b ? `💳 *HYPE*: HyperEVM \`${b.hyperevmBalanceFormatted || '0.0000'}\` • Elysium \`${kleosElysiumBal ? Number(kleosElysiumBal.formatted).toFixed(4) : '0.0000'}\`\n\n` : '')
          : isEvm
          ? (b ? `💳 *${isHyperEvm ? 'HyperEVM' : 'Elysium'} HYPE Balance*: \`${isHyperEvm ? (b.hyperevmBalanceFormatted || '0.0000') : (b.elysiumBalanceFormatted || '0.0000')} HYPE\`\n\n` : '')
          : (b ? `💳 *Wallet Balance*: \`${b.nativeNearFormatted} NEAR\` | \`${b.wrapNearFormatted} wNEAR\` | \`${b.usdcNearFormatted || '0.00'} USDC\`\n⚡ *Trade Mode*: ${isNearUsdcMode ? '💵 *USDC Only* (Buy & Sell in USDC)' : '⬛ *NEAR + USDC* (Auto-combines USDC)'}\n\n` : '')));

  // -- Venue label --
  let venueText = `💧 *Venue*: Unknown`;
  if (isSolana) {
    if (tokenInfo.venue === 'pumpfun') {
      const pct = tokenInfo.bonding_progress_pct;
      venueText = `💧 *Venue*: pump.fun (Bonding Curve${pct !== null && pct !== undefined ? ` — ${pct.toFixed(1)}% bonded` : ''})`;
    } else if (tokenInfo.venue === 'pumpswap') {
      venueText = `💧 *Venue*: PumpSwap (Bonded)`;
    } else {
      venueText = `💧 *Venue*: Solana DEX (Jupiter)`;
    }
  } else if (isStarknet) {
    if (tokenInfo.venue === 'launchy') {
      const phaseStr = tokenInfo.bonding_phase === 'bonded' ? 'Bonded (Ekubo DEX)' : 'Bonding Curve';
      const progressStr =
        tokenInfo.bonding_progress_pct !== null && tokenInfo.bonding_progress_pct !== undefined
          ? ` — ${tokenInfo.bonding_progress_pct.toFixed(1)}% bonded`
          : '';
      venueText = `💧 *Venue*: Launchy (${phaseStr}${progressStr})`;
    } else if (tokenInfo.venue === 'unruggable') {
      const phaseStr = tokenInfo.bonding_phase === 'bonded' ? 'Bonded (Ekubo DEX)' : 'Bonding Curve';
      const progressStr =
        tokenInfo.bonding_progress_pct !== null && tokenInfo.bonding_progress_pct !== undefined
          ? ` — ${tokenInfo.bonding_progress_pct.toFixed(1)}% bonded`
          : '';
      venueText = `💧 *Venue*: Unruggable Meme (${phaseStr}${progressStr})`;
    } else if (tokenInfo.venue === 'ekubo') {
      venueText = `💧 *Venue*: Ekubo DEX`;
    } else {
      venueText = `💧 *Venue*: AVNU Aggregator (Starknet)`;
    }
  } else if (tokenInfo.venue === 'suipump') {
    const phaseStr = tokenInfo.bonding_phase === 'bonded' ? 'Bonded (DEX)' : 'Bonding Curve';
    const progressStr =
      tokenInfo.bonding_progress_pct !== null && tokenInfo.bonding_progress_pct !== undefined
        ? ` — ${tokenInfo.bonding_progress_pct.toFixed(1)}% bonded`
        : '';
    venueText = `💧 *Venue*: SuiPump (${phaseStr}${progressStr})`;
  } else if (tokenInfo.venue === 'nearlytrade') {
    const pairTag = tokenInfo.paired_symbol && tokenInfo.paired_symbol !== 'NEAR' && tokenInfo.paired_symbol !== 'wNEAR'
      ? ` • ${tokenInfo.paired_symbol} Pair`
      : '';
    venueText = `💧 *Venue*: NearlyTrade (Ref DCL${pairTag})`;
  } else if (tokenInfo.venue === 'rhea' || tokenInfo.venue === 'ref') {
    venueText = tokenInfo.dcl_pool_id
      ? `💧 *Venue*: Ref Finance / Rhea (DCL)`
      : `💧 *Venue*: Rhea / Ref Finance (AMM)`;
  } else if (tokenInfo.venue === 'shardsmarket') {
    venueText = `💧 *Venue*: Shardsmarket (AMM)`;
  } else if (tokenInfo.venue === 'memecooking') {
    venueText = `💧 *Venue*: Meme.Cooking Launchpad`;
  } else if (tokenInfo.venue === 'intear') {
    venueText = `💧 *Venue*: Intear Launchpad (XYK)`;
  } else if (tokenInfo.venue === 'onetokenhub') {
    venueText = `💧 *Venue*: OneTokenHub (Ref DCL)`;
  } else if (tokenInfo.venue === 'nearpad') {
    venueText = tokenInfo.dcl_pool_id
      ? `💧 *Venue*: NEARpad (Ref DCL)`
      : `💧 *Venue*: NEARpad Launchpad`;
  } else if (tokenInfo.venue === 'gaypad') {
    const phaseStr = tokenInfo.bonding_phase === 'bonded' ? 'Bonded (DEX)' : 'Bonding Curve';
    const progressStr =
      tokenInfo.bonding_progress_pct !== null && tokenInfo.bonding_progress_pct !== undefined
        ? ` — ${tokenInfo.bonding_progress_pct.toFixed(1)}% bonded`
        : '';
    venueText = `💧 *Venue*: Gaypad Launchpad (${phaseStr}${progressStr})`;
  } else if (tokenInfo.venue === 'kelytra') {
    const phaseStr = tokenInfo.bonding_phase === 'bonded' ? 'Bonded (DEX)' : 'Bonding Curve';
    const progressStr =
      tokenInfo.bonding_progress_pct !== null && tokenInfo.bonding_progress_pct !== undefined
        ? ` — ${tokenInfo.bonding_progress_pct.toFixed(1)}% bonded`
        : '';
    venueText = `💧 *Venue*: Kelytra (${phaseStr}${progressStr})`;
  } else if (tokenInfo.venue === 'shoremarkets') {
    venueText = tokenInfo.dcl_pool_id
      ? `💧 *Venue*: ShoreMarkets (Ref DCL)`
      : `💧 *Venue*: ShoreMarkets Launchpad`;
  } else if (isSui) {
    const suiVenueMap: Record<string, string> = {
      bluefin: 'Bluefin',
      cetus: 'Cetus',
      turbos: 'Turbos Finance',
      flowx: 'FlowX Finance',
      aftermath: 'Aftermath Finance',
      deepbook: 'DeepBook',
      kriya: 'Kriya DEX',
      momentum: 'Momentum DEX',
      suipump: 'SuiPump',
    };
    const vKey = (tokenInfo.venue || '').toLowerCase();
    const vDisplayName = suiVenueMap[vKey] || (vKey && vKey !== 'sui_dex' && vKey !== 'unknown' ? vKey.charAt(0).toUpperCase() + vKey.slice(1) : null);
    venueText = vDisplayName ? `💧 *Venue*: ${vDisplayName} (Sui DEX)` : `💧 *Venue*: Sui DEX Router (Aftermath)`;
  } else if (isHyperEvm) {
    venueText = `⚡ *Venue*: HyperEVM DEX (Mainnet)`;
  } else if (isKleos) {
    venueText = `🏛️ *Venue*: Kleos (Elysium mainnet)`;
  } else if (isElysium) {
    venueText = `🏛️ *Venue*: Elysium L2 (Testnet - Mainnet soon)`;
  } else if (tokenInfo.tradeable) {
    venueText = `💧 *Venue*: NEAR Protocol DEX`;
  }

  const safeSymbol = sanitizeMd(tokenInfo.symbol || 'TOKEN');
  const safeName = sanitizeMd(tokenInfo.name || 'Token');

  // ── Deep links ───────────────────────────────────────────────────────────
  const linkRows = (() => {
    if (isEvm) {
      const rows: any[] = [];
      if (isHyperEvm) {
        rows.push([
          Markup.button.url('🔍 HypurrScan', `https://hypurrscan.io/token/${tokenInfo.address}`),
          Markup.button.url('📈 DexScreener', `https://dexscreener.com/hyperevm/${tokenInfo.address}`),
        ]);
      } else if (isKleos) {
        rows.push([Markup.button.url('🏛️ View on Kleos', `${KLEOS_TOKEN_URL}/${tokenInfo.address}`)]);
      } else {
        rows.push([
          Markup.button.url('🔍 Elysium Explorer', `https://elysium.kinetiq.xyz/testnet-explorer/token/${tokenInfo.address}`),
        ]);
      }
      rows.push([cb('🛡️ Deep Security & Honeypot Audit', `audit:${getShortTokenKey(tokenInfo.address)}`, 'primary')]);
      return rows;
    }
    if (isSolana) {
      const rows: any[] = [];
      if (tokenInfo.launchpad === 'pump.fun') {
        rows.push([Markup.button.url('💊 View on pump.fun', `https://pump.fun/coin/${tokenInfo.address}`)]);
      }
      rows.push([
        Markup.button.url('🔍 Solscan', `https://solscan.io/token/${tokenInfo.address}`),
        Markup.button.url('📈 DexScreener', `https://dexscreener.com/solana/${tokenInfo.address}`),
      ]);
      rows.push([cb('🛡️ Deep Security & Honeypot Audit', `audit:${getShortTokenKey(tokenInfo.address)}`, 'primary')]);
      return rows;
    }
    if (isStarknet) {
      const rows: any[] = [];
      rows.push([
        Markup.button.url('🔍 Starkscan', `https://starkscan.co/token/${tokenInfo.address}`),
        Markup.button.url('📈 DexScreener', `https://dexscreener.com/starknet/${tokenInfo.address}`),
      ]);
      rows.push([cb('🛡️ Deep Security & Honeypot Audit', `audit:${getShortTokenKey(tokenInfo.address)}`, 'primary')]);
      return rows;
    }
    if (isSui) {
      const rows: any[] = [];
      if (tokenInfo.sui_curve_address) {
        rows.push([Markup.button.url('💧 View on SuiPump', `https://suipump.org/token/${tokenInfo.sui_curve_address}`)]);
      }
      rows.push([
        Markup.button.url('🔍 Suiscan', `https://suiscan.xyz/mainnet/coin/${tokenInfo.sui_coin_type || tokenInfo.address}/txs`),
        Markup.button.url('📈 DexScreener', `https://dexscreener.com/sui/${tokenInfo.address}`),
      ]);
      rows.push([cb('🛡️ Deep Security & Honeypot Audit', `audit:${getShortTokenKey(tokenInfo.address)}`, 'primary')]);
      return rows;
    }
    const links = tokenLinks(tokenInfo.venue, tokenInfo.address, tokenInfo.symbol || undefined, tokenInfo.name || undefined);
    const rows: any[] = [];
    if (links.length > 0) rows.push([Markup.button.url(links[0].label, links[0].url)]);
    if (links.length > 1) rows.push(links.slice(1, 3).map(l => Markup.button.url(l.label, l.url)));
    if (links.length > 3) rows.push(links.slice(3).map(l => Markup.button.url(l.label, l.url)));
    rows.push([cb('🛡️ Deep Security & Honeypot Audit', `audit:${getShortTokenKey(tokenInfo.address)}`, 'primary')]);
    return rows;
  })();

  // -- Price formatting --
  const priceNum = parseFloat(tokenInfo.price || '0');
  const priceNearStr = formatCryptoPrice(priceNum, '');

  const priceUsdNum = parseFloat((tokenInfo as any).price_usd || '0');
  const priceUsdStr = priceUsdNum > 0
    ? formatCryptoPrice(priceUsdNum, '$')
    : (priceNum > 0 && tokenInfo.near_usd ? formatCryptoPrice(priceNum * tokenInfo.near_usd, '$') : '');

  // -- Liquidity formatting --
  const liqNum = parseFloat(tokenInfo.liquidity || '0');
  let liqNearStr = '0.00';
  if (liqNum >= 1000) liqNearStr = `${(liqNum / 1000).toFixed(2)}K`;
  else if (liqNum > 0) liqNearStr = liqNum.toFixed(2);

  const liqUsdRaw = parseFloat((tokenInfo as any).liquidity_usd || '0');
  let liqUsdStr = '';
  if (liqUsdRaw >= 1_000_000) liqUsdStr = `$${(liqUsdRaw / 1_000_000).toFixed(2)}M`;
  else if (liqUsdRaw >= 1_000) liqUsdStr = `$${(liqUsdRaw / 1_000).toFixed(1)}K`;
  else if (liqUsdRaw > 0) liqUsdStr = `$${liqUsdRaw.toFixed(0)}`;

  // -- Market cap formatting --
  let mcUsdFormatted = '';
  let mcNearFormatted = '';
  const mcUsdVal = (tokenInfo as any).market_cap_usd as number | undefined;
  const mcNearVal = tokenInfo.market_cap;
  if (mcUsdVal && mcUsdVal > 0) {
    mcUsdFormatted = mcUsdVal >= 1_000_000_000
      ? `$${(mcUsdVal / 1_000_000_000).toFixed(2)}B`
      : mcUsdVal >= 1_000_000
        ? `$${(mcUsdVal / 1_000_000).toFixed(2)}M`
        : mcUsdVal >= 1_000
          ? `$${(mcUsdVal / 1_000).toFixed(2)}K`
          : `$${mcUsdVal.toFixed(2)}`;

    if (mcNearVal >= 1_000_000) mcNearFormatted = `${(mcNearVal / 1_000_000).toFixed(2)}M ${nativeUnit}`;
    else if (mcNearVal >= 1_000) mcNearFormatted = `${(mcNearVal / 1_000).toFixed(2)}K ${nativeUnit}`;
    else if (mcNearVal > 0) mcNearFormatted = `${mcNearVal.toFixed(0)} ${nativeUnit}`;
  } else if (mcNearVal > 0) {
    if (mcNearVal >= 1_000_000) mcNearFormatted = `${(mcNearVal / 1_000_000).toFixed(2)}M ${nativeUnit}`;
    else if (mcNearVal >= 1_000) mcNearFormatted = `${(mcNearVal / 1_000).toFixed(2)}K ${nativeUnit}`;
    else mcNearFormatted = `${mcNearVal.toFixed(2)} ${nativeUnit}`;
  }

  // -- Supply formatting --
  const supplyHuman = parseFloat(tokenInfo.total_supply) / Math.pow(10, tokenInfo.decimals);
  const supplyStr = supplyHuman >= 1e9
    ? `${(supplyHuman / 1e9).toFixed(2)}B`
    : supplyHuman >= 1e6
      ? `${(supplyHuman / 1e6).toFixed(2)}M`
      : supplyHuman >= 1e3
        ? `${(supplyHuman / 1e3).toFixed(2)}K`
        : supplyHuman.toFixed(2);

  // -- Rate footnote --
  const nearUsdRate = (tokenInfo as any).near_usd as number | undefined;
  const strkUsdRate = (tokenInfo as any).strk_usd as number | undefined;
  const solUsdRate = (tokenInfo as any).sol_usd as number | undefined;
  // EVM token info carries the HYPE price in near_usd; hype_usd is not filled in anywhere yet
  const hypeUsdRate = ((tokenInfo as any).hype_usd ?? (isEvm ? nearUsdRate : undefined)) as number | undefined;
  const rateFooter = isSolana
    ? (solUsdRate && solUsdRate > 0 ? `_1 SOL ≈ $${solUsdRate.toFixed(2)}_\n` : '')
    : isStarknet
      ? (strkUsdRate && strkUsdRate > 0 ? `_1 STRK ≈ $${strkUsdRate.toFixed(2)}_\n` : '')
      : isSui
        ? (tokenInfo.sui_usd ? `_1 SUI ≈ $${tokenInfo.sui_usd.toFixed(2)}_\n` : '')
        : isEvm
          ? (hypeUsdRate && hypeUsdRate > 0 ? `_1 HYPE ≈ $${hypeUsdRate.toFixed(2)}_\n` : '')
          : (nearUsdRate && nearUsdRate > 0 ? `_1 NEAR ≈ $${nearUsdRate.toFixed(2)}_\n` : '');

  let safetyBanner = '';
  if (safety?.isDrained) {
    safetyBanner = `🚨 *WARNING*: Pool drained/rugged. Buying blocked.\n\n`;
  } else if (safety?.isHoneypot) {
    const dangerText = safety.reasons[0] || 'Malicious backdoor detected.';
    safetyBanner = `🚨 *HONEYPOT*: ${dangerText} (Buying blocked)\n\n`;
  } else if (isSolana && safety && safety.reasons.length > 0) {
    safetyBanner = `⚠️ *RISK*: ${sanitizeMd(safety.reasons.join(' '))}\n\n`;
  } else if (safety?.isUnlockedRheaPool) {
    safetyBanner = `⚠️ *HIGH RISK*: Unlocked Liquidity (Creator holds LP)\n\n`;
  } else if (safety?.unlockedLiquidityPct !== undefined && safety.unlockedLiquidityPct > 0) {
    const unlocked = safety.unlockedLiquidityPct;
    safetyBanner = `⚠️ *AUDIT*: 🔴 ${unlocked.toFixed(0)}% Unlocked Liquidity\n\n`;
  } else if (safety && !isKleos) {
    // The safety audit is NEAR-specific; it says nothing about a Kleos coin, so the card shows no verdict for one
    const contractType = safety.isAuditedLaunchpad
      ? `🛡️ Audited (${safety.launchpadName || 'Verified'})`
      : (isSolana ? 'SPL token' : isEvm ? 'ERC-20' : 'NEP-141');
    safetyBanner = `🛡️ *Security*: 🟢 Passed • ${contractType}\n`;
  }

  // Thin liquidity warning for trades under $1,000 liquidity
  const isLowLiquidity = (liqUsdRaw > 0 && liqUsdRaw < 1000) || (liqNum > 0 && liqNum * (tokenInfo.near_usd || 1) < 1000);
  if (isLowLiquidity && !safety?.isHoneypot && !safety?.isDrained) {
    safetyBanner += `⚠️ *Low Liquidity* (${liqUsdStr || `${liqUsdRaw.toFixed(0)}`}) — High slippage risk!\n\n`;
  }

  if (isKleos && tokenInfo.tradeable) {
    safetyBanner += `🏛️ Trades settle on Elysium in about 1–5 min. Sale proceeds stay on Elysium; moving HYPE back to HyperEVM takes ~6 days.\n\n`;
  } else if (isKleos) {
    // The bottom line says it can't be traded here; one mention is enough
  } else if (isElysium) {
    safetyBanner += `🟡 *Elysium Testnet*: Deployed on Elysium Testnet (Chain ID 99801). Elysium Mainnet will be live soon!\n\n`;
  }

  // Mobile-optimized ultra-compact stats block (dense 4-line monospace under 28 chars wide)
  const priceCol = priceNearStr ? `${priceNearStr} ${nativeUnit}` : '0.00';
  const usdCol = priceUsdStr ? ` (${priceUsdStr})` : '';
  const mcapCol = mcUsdFormatted || mcNearFormatted || 'N/A';
  const liqShort = liqUsdStr || `${liqNearStr} ${nativeUnit}`;
  const buyTax = tokenInfo.buy_tax_pct !== undefined ? `${tokenInfo.buy_tax_pct.toFixed(1)}%` : '0.3%';
  const sellTax = tokenInfo.sell_tax_pct !== undefined ? `${tokenInfo.sell_tax_pct.toFixed(1)}%` : '0.3%';
  const timeframe = (tokenInfo as any).trades_timeframe === 'Curve' ? 'Curve' : '24h';
  const buys = tokenInfo.buys_count;
  const sells = tokenInfo.sells_count;

  let statsBlock = '```\n';
  statsBlock += `Price : ${priceCol}${usdCol}\n`;
  statsBlock += `MCap  : ${mcapCol.padEnd(8)} Liq: ${liqShort}\n`;
  statsBlock += `Tax   : ${buyTax}/${sellTax}   Sup: ${supplyStr}\n`;
  if (buys !== undefined && sells !== undefined) {
    statsBlock += `Vol   : ${buys}B/${sells}S (${timeframe})${tokenInfo.holders_count ? ` • ${tokenInfo.holders_count}H` : ''}\n`;
  } else if (tokenInfo.holders_count) {
    statsBlock += `Holders: ${tokenInfo.holders_count.toLocaleString('en-US')}\n`;
  }
  statsBlock += '```\n';

  const userSlippage = userRecord?.slippage_pct != null ? `${userRecord.slippage_pct}%` : '1.0%';
  const slippageLine = `⚙️ *Slippage*: \`${userSlippage}\`\n`;

  let text =
    safetyBanner +
    `🪙 *${safeName}* (\`${safeSymbol}\`) • ${venueText.replace('💧 *Venue*: ', '').replace('💧 Venue: ', '').replace('*Venue*: ', '')}\n` +
    `📝 \`${tokenInfo.address}\`\n` +
    statsBlock +
    slippageLine +
    rateFooter +
    balanceText;

  let pnlCardImage: Buffer | null = null;

  // Personal Position
  if (holdsToken && userPosition) {
    let entryPrice = parseFloat(userPosition.avg_entry_price) || 0;
    let pnlPct = priceNum > 0 && entryPrice > 0
      ? ((priceNum - entryPrice) / entryPrice * 100).toFixed(2)
      : 'N/A';
    let emoji = pnlPct !== 'N/A' && parseFloat(pnlPct) >= 0 ? '🟢' : '🔴';
    let pnlDisplay = pnlPct === 'N/A' ? 'N/A' : `${parseFloat(pnlPct) >= 0 ? '+' : ''}${pnlPct}%`;

    try {
      const pnlCard = await generatePNLCard(userPosition.id);
      if (pnlCard?.data) {
        entryPrice = pnlCard.data.entryPrice;
        emoji = pnlCard.data.isProfit ? '🟢' : '🔴';
        const pSign = pnlCard.data.isProfit ? '+' : '';
        pnlDisplay = `${pSign}${Math.abs(pnlCard.data.pnlPercent).toFixed(2)}%`;
      }
      if (pnlCard?.image) {
        pnlCardImage = pnlCard.image;
      } else if (pnlCard?.text) {
        text += `${pnlCard.text}\n\n`;
      }
    } catch (err: any) {
      console.error('Failed to generate PNL card:', err);
    }

    const formattedQty = formatHoldingQuantity(userPosition.quantity_held, tokenInfo.decimals);
    text += `💼 *Holding*: ${formattedQty} ${safeSymbol} (${emoji} *${pnlDisplay}*) • Entry: ${formatCryptoPrice(entryPrice, '', nativeUnit).trim()}\n`;
  }

  // RaceFleet Position
  if (fleetHoldsToken && fleetPosition) {
    const fleetFormattedQty = formatHoldingQuantity(fleetPosition.totalBalanceRaw.toString(), tokenInfo.decimals);
    text += `🏎️ *Fleet*: ${fleetFormattedQty} ${safeSymbol} (${fleetPosition.emoji} *${fleetPosition.pnlDisplay}*)\n`;
  }

  // ── Buttons ──
  let shareButtonRow: any[] = [];
  if (userRecord) {
    try {
      const shareCode = await getOrCreateTokenShare(userRecord.id, tokenAddress);
      const shareDeepLink = `https://t.me/racertradingbot?start=${shareCode}`;
      const sym = tokenInfo.symbol || 'TOKEN';
      const cardChainName = isSolana ? 'Solana' : isStarknet ? 'Starknet' : isSui ? 'SUI' : isEvm ? (isHyperEvm ? 'HyperEVM' : 'Elysium') : 'NEAR';
      const shareText = `Trade $${sym} on RacerBot 🏎\n⚡ Fast 1-click execution on ${cardChainName}`;
      const tgShareUrl = `https://t.me/share/url?url=${encodeURIComponent(shareDeepLink)}&text=${encodeURIComponent(shareText)}`;
      shareButtonRow = [[Markup.button.url('📤 Share Token (Earn 5% Fees)', tgShareUrl)]];
    } catch (err: any) {
      console.warn('[buildTokenCard] Failed to generate share link:', err?.message);
    }
  }

  let keyboard;
  const shortKey = getShortTokenKey(tokenInfo.address);
  const isBlocked = safety?.isHoneypot || safety?.isDrained;

  if (isBlocked) {
    const blockedBtn = [Markup.button.callback(
      safety?.isDrained ? '🚨 Buy Blocked (Drained Liquidity)' : '🚨 Buy Blocked (Honeypot Backdoor)',
      safety?.isDrained ? 'noop_drained' : 'noop_honeypot'
    )];
    const fleetExitRow = (!isSui && !isStarknet && fleetHoldsToken)
      ? [cb('🔴 Fleet SELL', `fleet_sell_prompt:${shortKey}`, 'danger')]
      : [];
    if (holdsToken && userPosition) {
      text += `⚡ *Exit Position* (Sell Only):\n`;
      keyboard = Markup.inlineKeyboard([
        blockedBtn,
        [
          cb('25%', `sell:${userPosition.id}:25`, 'danger'),
          cb('50%', `sell:${userPosition.id}:50`, 'danger'),
          cb('100%', `sell:${userPosition.id}:100`, 'danger'),
        ],
        [
          cb('🔴 Sell X Tokens', `sell_custom_prompt:${userPosition.id}`, 'danger'),
          cb('🔴 Sell Initial', `sell_initial:${userPosition.id}`, 'danger'),
        ],
        ...(fleetExitRow.length > 0 ? [fleetExitRow] : []),
        ...linkRows,
        ...shareButtonRow,
        [
          cb('🔄 Refresh', `token_refresh:${shortKey}`, 'primary'),
          cb('🔙 Back to Main Menu', 'menu_home', 'primary'),
        ],
        [
          Markup.button.url('💬 Community', 'https://t.me/racerbot_community'),
          Markup.button.url('📢 Updates', 'https://t.me/racertrading'),
          Markup.button.url('𝕏 X', 'https://x.com/racertradingbot'),
        ],
      ]);
    } else if (fleetHoldsToken) {
      text += `⚡ *Exit Fleet Position* (Sell Only):\n`;
      keyboard = Markup.inlineKeyboard([
        blockedBtn,
        ...(fleetExitRow.length > 0 ? [fleetExitRow] : []),
        ...linkRows,
        ...shareButtonRow,
        [
          cb('🔄 Refresh', `token_refresh:${shortKey}`, 'primary'),
          cb('🔙 Back to Main Menu', 'menu_home', 'primary'),
        ],
        [
          Markup.button.url('💬 Community', 'https://t.me/racerbot_community'),
          Markup.button.url('📢 Updates', 'https://t.me/racertrading'),
          Markup.button.url('𝕏 X', 'https://x.com/racertradingbot'),
        ],
      ]);
    } else {
      keyboard = Markup.inlineKeyboard([
        blockedBtn,
        ...linkRows,
        ...shareButtonRow,
        [
          cb('🔄 Refresh', `token_refresh:${shortKey}`, 'primary'),
          cb('🔙 Back to Main Menu', 'menu_home', 'primary'),
        ],
        [
          Markup.button.url('💬 Community', 'https://t.me/racerbot_community'),
          Markup.button.url('📢 Updates', 'https://t.me/racertrading'),
          Markup.button.url('𝕏 X', 'https://x.com/racertradingbot'),
        ],
      ]);
    }
  } else if (tokenInfo.tradeable) {
    const unlockedRiskRow = safety?.isUnlockedRheaPool
      ? [[Markup.button.callback('⚠️ Unlocked Liquidity (High Rug Risk)', 'noop_unlocked_risk')]]
      : [];

    const fleetActionRows: any[] = [];
    if (!isSui && !isStarknet && !isEvm) {
      if (fleetHoldsToken && fleetPosition) {
        fleetActionRows.push([
          cb(`🏎️ RaceFleet Cockpit (${fleetPosition.emoji} ${fleetPosition.pnlDisplay})`, `fleet_cockpit:${shortKey}`, 'success'),
        ]);
        fleetActionRows.push([
          cb('🟢 Fleet BUY', `fleet_buy_prompt:${shortKey}`, 'success'),
          cb('🔴 Fleet SELL', `fleet_sell_prompt:${shortKey}`, 'danger'),
        ]);
      } else {
        fleetActionRows.push([
          cb('🟢 Fleet BUY (Beta)', `fleet_buy_prompt:${shortKey}`, 'success'),
          cb('🏎️ Fleet Cockpit', `fleet_cockpit:${shortKey}`, 'primary'),
        ]);
      }
    }

    const defaultBuyPct = userRecord?.default_buy_pct ? Number(userRecord.default_buy_pct) : 10;
    const nearCurrencyToggleRow = !isSolana && !isStarknet && !isSui && !isEvm
      ? [[cb(isNearUsdcMode ? '💵 Mode: USDC Only (Tap for NEAR)' : '⬛ Mode: NEAR + USDC (Tap for USDC Only)', `toggle_token_currency:${shortKey}`, isNearUsdcMode ? 'success' : 'primary')]]
      : [];

    if (holdsToken && userPosition) {
      text += isEvm ? `⚡ *Manage Position*:\n` : `⚡ *Manage Position* (Personal & Fleet):\n`;
      keyboard = Markup.inlineKeyboard([
        ...unlockedRiskRow,
        // Quick-buy fixed amounts (green)
        ...nearCurrencyToggleRow,
        (isSolana ? SOLANA_BUY_PRESETS : (isEvm ? EVM_BUY_PRESETS : nearModeBuyPresets)).map(amt => cb(`${amt} ${unitBtn}`, `buy_fixed:${shortKey}:${amt}`, 'success')),
        // Custom amount
        [cb(`🟢 Buy X ${nativeUnit}`, `buy_custom_prompt:${shortKey}`, 'success')],
        ...fleetActionRows,
        // Buy % of balance (green)
        [
          cb(`${defaultBuyPct === 10 ? '✓ ' : ''}10%`, `buy_pct:${shortKey}:10`, 'success'),
          cb(`${defaultBuyPct === 50 ? '✓ ' : ''}50%`, `buy_pct:${shortKey}:50`, 'success'),
          cb(`${defaultBuyPct === 100 ? '✓ ' : ''}100%`, `buy_pct:${shortKey}:100`, 'success'),
        ],
        // Sell % (red)
        [
          cb('25%', `sell:${userPosition.id}:25`, 'danger'),
          cb('50%', `sell:${userPosition.id}:50`, 'danger'),
          cb('100%', `sell:${userPosition.id}:100`, 'danger'),
        ],
        [
          cb('🔴 Sell X Tokens', `sell_custom_prompt:${userPosition.id}`, 'danger'),
          cb('🔴 Sell Initial', `sell_initial:${userPosition.id}`, 'danger'),
        ],
        ...linkRows,
        ...shareButtonRow,
        [
          ...(!isSui && !isEvm && !isStarknet ? [cb('🔁 DCA Order', `dca_token:${shortKey}`, 'primary')] : []),
          ...(!isSui && !isEvm && !isStarknet ? [cb('🎯 Limit Order', `lo_start:${shortKey}`, 'primary')] : []),
        ],
        [
          cb('🔄 Refresh', `token_refresh:${shortKey}`, 'primary'),
          cb('🔙 Back to Main Menu', 'menu_home', 'primary'),
        ],
        [
          Markup.button.url('💬 Community', 'https://t.me/racerbot_community'),
          Markup.button.url('📢 Updates', 'https://t.me/racertrading'),
          Markup.button.url('𝕏 X', 'https://x.com/racertradingbot'),
        ],
      ]);
    } else if (fleetHoldsToken && fleetPosition) {
      text += `⚡ *Manage RaceFleet Position*:\n`;
      keyboard = Markup.inlineKeyboard([
        ...unlockedRiskRow,
        ...fleetActionRows,
        // Quick-buy fixed amounts for personal account
        ...nearCurrencyToggleRow,
        (isSolana ? SOLANA_BUY_PRESETS : (isEvm ? EVM_BUY_PRESETS : nearModeBuyPresets)).map(amt => cb(`${amt} ${unitBtn}`, `buy_fixed:${shortKey}:${amt}`, 'success')),
        [cb(`🟢 Buy X ${nativeUnit}`, `buy_custom_prompt:${shortKey}`, 'success')],
        [
          cb(`${defaultBuyPct === 10 ? '✓ ' : ''}10%`, `buy_pct:${shortKey}:10`, 'success'),
          cb(`${defaultBuyPct === 50 ? '✓ ' : ''}50%`, `buy_pct:${shortKey}:50`, 'success'),
          cb(`${defaultBuyPct === 100 ? '✓ ' : ''}100%`, `buy_pct:${shortKey}:100`, 'success'),
        ],
        ...linkRows,
        ...shareButtonRow,
        [
          ...(!isSui && !isEvm && !isStarknet ? [cb('🔁 DCA Order', `dca_token:${shortKey}`, 'primary')] : []),
          ...(!isSui && !isEvm && !isStarknet ? [cb('🎯 Limit Order', `lo_start:${shortKey}`, 'primary')] : []),
        ],
        [
          cb('🔄 Refresh', `token_refresh:${shortKey}`, 'primary'),
          cb('🔙 Back to Main Menu', 'menu_home', 'primary'),
        ],
        [
          Markup.button.url('💬 Community', 'https://t.me/racerbot_community'),
          Markup.button.url('📢 Updates', 'https://t.me/racertrading'),
          Markup.button.url('𝕏 X', 'https://x.com/racertradingbot'),
        ],
      ]);
    } else {
      text += isKleos
        ? `⚡ *Buy with HYPE*: a fixed amount, or a % of your HYPE:\n`
        : isEvm
          ? `⚡ *Buy with HYPE*: a fixed amount, or a % of your ${isHyperEvm ? 'HyperEVM' : 'Elysium'} HYPE:\n`
          : `⚡ *Choose Buy Amount* (Fixed or % of Balance):\n`;
      keyboard = Markup.inlineKeyboard([
        ...unlockedRiskRow,
        ...nearCurrencyToggleRow,
        (isSolana ? SOLANA_BUY_PRESETS : (isEvm ? EVM_BUY_PRESETS : nearModeBuyPresets)).map(amt => cb(`${amt} ${unitBtn}`, `buy_fixed:${shortKey}:${amt}`, 'success')),
        [cb(`🟢 Buy X ${nativeUnit}`, `buy_custom_prompt:${shortKey}`, 'success')],
        ...fleetActionRows,
        [
          cb(`${defaultBuyPct === 10 ? '✓ ' : ''}10%`, `buy_pct:${shortKey}:10`, 'success'),
          cb(`${defaultBuyPct === 50 ? '✓ ' : ''}50%`, `buy_pct:${shortKey}:50`, 'success'),
          cb(`${defaultBuyPct === 100 ? '✓ ' : ''}100%`, `buy_pct:${shortKey}:100`, 'success'),
        ],
        ...linkRows,
        ...shareButtonRow,
        [
          ...(!isSui && !isEvm && !isStarknet ? [cb('🔁 DCA Order', `dca_token:${shortKey}`, 'primary')] : []),
          ...(!isSui && !isEvm && !isStarknet ? [cb('🎯 Limit Order', `lo_start:${shortKey}`, 'primary')] : []),
        ],
        [
          cb('🔄 Refresh', `token_refresh:${shortKey}`, 'primary'),
          cb('🔙 Back to Main Menu', 'menu_home', 'primary'),
        ],
        [
          Markup.button.url('💬 Community', 'https://t.me/racerbot_community'),
          Markup.button.url('📢 Updates', 'https://t.me/racertrading'),
          Markup.button.url('𝕏 X', 'https://x.com/racertradingbot'),
        ],
      ]);
    }
  } else {
    const isAwaitingLiquidity =
      tokenInfo.venue === 'intear' ||
      tokenInfo.venue === 'nearlytrade' ||
      tokenInfo.venue === 'rhea' ||
      tokenInfo.venue === 'ref' ||
      Boolean(tokenInfo.dcl_pool_id);

    if (isAwaitingLiquidity) {
      text += `⏳ *Status*: Awaiting Initial Liquidity on DEX.\n🎯 *Set a Snipe to buy automatically on pool creation!*\n\n`;
      keyboard = Markup.inlineKeyboard([
        [cb('🎯 Snipe Token', `snipe_token_quick:${shortKey}`, 'success')],
        ...(!isSui && !isStarknet ? [[cb('🏎️ Pre-Snipe with Fleet', `fleet_cockpit:${shortKey}`, 'success')]] : []),
        ...linkRows,
        ...shareButtonRow,
        [
          Markup.button.callback('🔄 Refresh', `token_refresh:${shortKey}`),
          Markup.button.callback('🔙 Back to Main Menu', 'menu_home'),
        ],
        [
          Markup.button.url('💬 Community', 'https://t.me/racerbot_community'),
          Markup.button.url('📢 Updates', 'https://t.me/racertrading'),
          Markup.button.url('𝕏 X', 'https://x.com/racertradingbot'),
        ],
      ]);
    } else {
      text += isKleos
        ? '🏛️ RacerBot can’t trade Kleos coins yet. Tap *View on Kleos* to trade there.'
        : '⚠️ Trading venue is not directly supported.';
      keyboard = Markup.inlineKeyboard([
        ...linkRows,
        ...shareButtonRow,
        [
          Markup.button.callback('🔄 Refresh', `token_refresh:${shortKey}`),
          Markup.button.callback('🔙 Back to Main Menu', 'menu_home'),
        ],
        [
          Markup.button.url('💬 Community', 'https://t.me/racerbot_community'),
          Markup.button.url('📢 Updates', 'https://t.me/racertrading'),
          Markup.button.url('𝕏 X', 'https://x.com/racertradingbot'),
        ],
      ]);
    }
  }

  return { text, keyboard, pnlCardImage: pnlCardImage || undefined };
}

/**
 * Safely send a token card to Telegram.
 * Handles photo or text rendering, and gracefully falls back to plain text if Telegram Markdown entity parsing fails.
 */
export async function sendTokenCard(ctx: any, card: { text: string; keyboard: any; pnlCardImage?: Buffer }) {
  if (card.pnlCardImage) {
    try {
      await ctx.replyWithPhoto(
        { source: card.pnlCardImage },
        {
          caption: card.text,
          parse_mode: 'Markdown',
          reply_markup: card.keyboard.reply_markup,
        }
      );
      return;
    } catch (err: any) {
      console.warn('[API] replyWithPhoto Markdown failed, retrying plain caption:', err.message);
      try {
        await ctx.replyWithPhoto(
          { source: card.pnlCardImage },
          {
            caption: card.text.replace(/[*_`]/g, ''),
            reply_markup: card.keyboard.reply_markup,
          }
        );
        return;
      } catch {
        // Fallback to text message
      }
    }
  }

  try {
    await ctx.reply(card.text, { parse_mode: 'Markdown', ...card.keyboard });
  } catch (err: any) {
    console.warn('[API] ctx.reply Markdown failed, retrying plain text:', err.message);
    await ctx.reply(card.text.replace(/[*_`]/g, ''), card.keyboard);
  }
}

/**
 * Deliver the position "details" view for a tapped holding.
 *
 * Previous behaviour swallowed every send error (`.catch(() => {})`), so any
 * Telegram rejection (Markdown entity error, caption over 1024 chars, editing
 * a photo message as text) left the user tapping a button that "did nothing".
 * This tries each rendering in order and always ends with something visible.
 */
export async function deliverTokenDetail(
  ctx: any,
  msg: string,
  buttons: any[],
  image: Buffer | null,
): Promise<void> {
  const markup = Markup.inlineKeyboard(buttons);
  const plain = msg.replace(/[*_`]/g, '');
  const cbMsg = ctx.callbackQuery?.message;
  const sourceIsPhoto = !!cbMsg?.photo;

  // 1. Photo card (Telegram caption limit is 1024 chars).
  if (image && msg.length <= 1024) {
    for (const opts of [
      { caption: msg, parse_mode: 'Markdown' as const, reply_markup: markup.reply_markup },
      { caption: plain, reply_markup: markup.reply_markup },
    ]) {
      try {
        await ctx.replyWithPhoto({ source: image }, opts);
        await ctx.deleteMessage().catch(() => { });
        return;
      } catch (err: any) {
        console.warn('[token_detail] Photo send failed:', err?.description || err?.message);
      }
    }
  }

  // 2. Edit the tapped message in place (only possible for text messages).
  if (!sourceIsPhoto && typeof ctx.editMessageText === 'function') {
    try {
      await ctx.editMessageText(msg, { parse_mode: 'Markdown', ...markup });
      return;
    } catch (err: any) {
      const desc = String(err?.description || err?.message || '');
      if (desc.includes('message is not modified')) return;
      console.warn('[token_detail] Edit failed, sending new message:', desc);
    }
  }

  // 3. New message, Markdown then plain text.
  try {
    await ctx.reply(msg, { parse_mode: 'Markdown', ...markup });
    return;
  } catch (err: any) {
    console.warn('[token_detail] Markdown reply failed:', err?.description || err?.message);
  }
  try {
    await ctx.reply(plain, markup);
  } catch (err: any) {
    console.error('[token_detail] Plain reply failed:', err?.description || err?.message);
    // Last resort: keep only callback buttons, in case a URL button
    // (e.g. a launchpad link Telegram considers invalid) is what was rejected.
    const callbackOnly = buttons
      .map((row: any[]) => (Array.isArray(row) ? row.filter((b: any) => b && !b.url) : []))
      .filter((row: any[]) => row.length > 0);
    await ctx.reply(plain, Markup.inlineKeyboard(callbackOnly)).catch(() => ctx.reply(plain).catch(() => { }));
  }
}

/**
 * Build a rich, comprehensive Deep Contract & Honeypot Audit card.
 */
export async function buildDeepAuditCard(tokenAddress: string): Promise<{ text: string; keyboard: any }> {
  const [infoRes, safetyRes] = await Promise.allSettled([
    getTokenInfo(tokenAddress, true),
    checkTokenSafety(tokenAddress, true),
  ]);

  const tokenInfo = infoRes.status === 'fulfilled' ? infoRes.value : null;
  const safety = safetyRes.status === 'fulfilled' ? safetyRes.value : null;

  const safeSymbol = sanitizeMd(tokenInfo?.symbol || 'TOKEN');
  const safeName = sanitizeMd(tokenInfo?.name || 'Token');
  const tokenChain = resolveTokenChain(tokenAddress);
  const isSol = tokenChain === 'solana';
  const isStk = tokenChain === 'starknet';
  const isSuiTok = tokenChain === 'sui';
  const isEvmTok = tokenChain === 'hyperevm' || tokenChain === 'elysium';
  const chainDisplayName = isSol ? '🟣 Solana' : isStk ? '⚡ Starknet' : isSuiTok ? '💧 SUI' : tokenChain === 'elysium' ? '🏛️ Elysium' : isEvmTok ? '⚡ HyperEVM' : '⬛ NEAR Protocol';
  const chainUnit = getChainNativeUnit(tokenChain);
  const shortKey = getShortTokenKey(tokenAddress);

  let hpVerdict = '🟢 *PASSED — SAFE TO TRADE*';
  if (safety?.isDrained) {
    hpVerdict = '🔴 *CRITICAL DRAINED POOL WARNING* (Liquidity pulled/drained)';
  } else if (safety?.isHoneypot) {
    hpVerdict = '🔴 *CRITICAL HONEYPOT WARNING* (Backdoor detected)';
  } else if (safety?.isUnlockedRheaPool) {
    hpVerdict = '⚠️ *HIGH RISK: UNLOCKED LIQUIDITY* (Creator can pull pool at any time)';
  }

  const backdoorVerdict = safety?.dangerousMethods && safety.dangerousMethods.length > 0
    ? `🔴 *DANGEROUS BACKDOOR DETECTED*:\n  • Backdoors: \`${safety.dangerousMethods.join(', ')}\`\n  • Risk: Contract owner can confiscate, freeze, or burn user tokens.`
    : '🟢 *0 Backdoors Found*\n  • Scanned 15 dangerous method signatures\n  • No drain, confiscate, admin-burn, or freeze functions.';

  const standardVerdict = safety?.isAuditedLaunchpad
    ? `🛡️ *Audited Factory Token* (${safety.launchpadName || 'Verified'})\n  • Deployed from immutable launchpad factory bytecode.`
    : (isSol
      ? '🟣 *SPL Token Standard*\n  • Native Solana Program token.'
      : isStk
      ? '⚡ *Starknet ERC-20 Standard*\n  • Cairo smart contract on Starknet.'
      : isSuiTok
      ? '💧 *Sui Move Standard Coin*\n  • Native Sui coin with Move bytecode safety.'
      : isEvmTok
      ? '⚡ *ERC-20 Standard*\n  • Standard EVM smart contract token.'
      : '📜 *Standard NEP-141 Verified*\n  • Implements ft_transfer, ft_transfer_call, ft_balance_of.');

  let lockVerdict = '';
  if (safety?.isAuditedLaunchpad) {
    lockVerdict = '🔒 *Liquidity Lock*: 🟢 *100% Locked / Burned* (Audited Launchpad)';
  } else if (safety?.isUnlockedRheaPool) {
    lockVerdict = '🔓 *Liquidity Lock*: 🔴 *100% UNLOCKED* (Deployer holds LP shares)';
  } else {
    lockVerdict = '💧 *Liquidity Lock*: ⚪ Standard DEX Pool';
  }

  const liqUsd = parseFloat((tokenInfo as any)?.liquidity_usd || '0');
  const liqNear = parseFloat(tokenInfo?.liquidity || '0');

  let liqVerdict = `💧 *Liquidity Depth*: \`${liqNear.toFixed(2)} ${chainUnit}\` (~$${liqUsd.toFixed(2)})`;
  if (liqUsd > 0 && liqUsd < 50) {
    liqVerdict += `\n⚠️ *Warning*: Ultra-low pool liquidity. High slippage / price volatility expected.`;
  }

  const exportedList = safety?.allExportedMethods && safety.allExportedMethods.length > 0
    ? `\n\n🧩 *Exported Contract Methods (${safety.allExportedMethods.length})*:\n\`${safety.allExportedMethods.slice(0, 16).join(', ')}${safety.allExportedMethods.length > 16 ? '...' : ''}\``
    : '';

  const text =
    `🛡️ *RacerBot Deep Contract & Security Audit*\n\n` +
    `🪙 *Token*: *${safeName}* (\`${safeSymbol}\`)\n` +
    `📝 \`${tokenAddress}\`\n` +
    `⛓️ *Chain*: ${chainDisplayName}\n\n` +
    `> 🎯 *Honeypot Verdict*:\n> ${hpVerdict}\n\n` +
    `> 🔍 *Backdoor Analysis*:\n> ${backdoorVerdict}\n\n` +
    `> 📋 *Contract Standard*:\n> ${standardVerdict}\n\n` +
    `> ${lockVerdict}\n\n` +
    `> ${liqVerdict}` +
    exportedList +
    `\n\n` +
    `_🛡️ Verified in real-time by RacerBot WASM Anti-Honeypot Shield_`;

  const keyboard = Markup.inlineKeyboard([
    ...((safety?.isHoneypot || safety?.isDrained) ? [] : [[cb('⚡ Trade Token', `token_refresh:${shortKey}`, 'success')]]),
    [
      cb('🔙 Back to Token Card', `token_refresh:${shortKey}`, 'primary'),
      cb('💳 Open Wallet', 'menu_wallet', 'primary'),
    ],
  ]);

  return { text, keyboard };
}

/**
 * Safely send a PNL card (photo + caption or markdown text) for a position to Telegram.
 */
export async function sendPnlCardMessage(
  ctx: Context,
  positionId: string,
  headerMsg?: string,
  showNetWorthOverride?: boolean
) {
  try {
    const position = await getPositionById(positionId);
    if (!position) {
      if (headerMsg) {
        await ctx.reply(headerMsg, { parse_mode: 'Markdown' }).catch(() => { });
      }
      return;
    }

    const user = await getUserByTelegramId(ctx.from!.id).catch(() => null);
    const showNetWorth = showNetWorthOverride !== undefined
      ? showNetWorthOverride
      : Boolean(user?.show_net_worth_on_card);

    const pnlCard = await generatePNLCard(positionId, showNetWorth);
    let fullText = pnlCard.text;
    if (headerMsg) {
      fullText = `${headerMsg}\n\n${fullText}`;
    }

    const buttons: any[] = [];
    const quantityHeldNum = parseFloat(position.quantity_held || '0');

    if (position.status === 'open' && quantityHeldNum > 0) {
      buttons.push([
        cb('25%', `sell:${positionId}:25`, 'danger'),
        cb('50%', `sell:${positionId}:50`, 'danger'),
        cb('100%', `sell:${positionId}:100`, 'danger'),
      ]);
      buttons.push([
        cb('🔴 Sell X Tokens', `sell_custom_prompt:${positionId}`, 'danger'),
        cb('🔴 Sell Initial', `sell_initial:${positionId}`, 'danger'),
      ]);
      buttons.push([
        cb('🟢 Buy More', `buy_custom_prompt:${position.token_address}`, 'success'),
      ]);
    }

    if (user) {
      try {
        const shareCode = await getOrCreateTokenShare(user.id, position.token_address);
        const shareDeepLink = `https://t.me/racertradingbot?start=${shareCode}`;
        const sym = (pnlCard as any).tokenTicker || 'TOKEN';
        const shareText = `Trade $${sym} on RacerBot 🏎\n⚡ Fast 1-click execution on NEAR & SUI`;
        const tgShareUrl = `https://t.me/share/url?url=${encodeURIComponent(shareDeepLink)}&text=${encodeURIComponent(shareText)}`;
        buttons.push([Markup.button.url('📤 Share Token (Earn 5% Fees)', tgShareUrl)]);
      } catch (err: any) {
        console.warn('[sendPnlCardMessage] Failed to generate share link:', err?.message);
      }
    }

    buttons.push([
      cb(
        showNetWorth ? '🙈 Hide NW' : '👁 Show NW',
        `toggle_pnl_nw:${positionId}:${showNetWorth ? 0 : 1}`,
        'primary'
      ),
      cb('🔄 Refresh', `token_detail:${positionId}${showNetWorthOverride !== undefined ? `:${showNetWorth ? 1 : 0}` : ''}`, 'primary'),
    ]);
    buttons.push([
      cb('💼 Holdings', 'menu_holdings', 'primary'),
      cb('🏠 Menu', 'menu_home', 'primary'),
    ]);

    const keyboard = Markup.inlineKeyboard(buttons);

    if (pnlCard.image) {
      try {
        await ctx.replyWithPhoto(
          { source: pnlCard.image },
          {
            caption: fullText,
            parse_mode: 'Markdown',
            reply_markup: keyboard.reply_markup,
          }
        );
        return;
      } catch (err: any) {
        console.warn('[PNL_CARD] replyWithPhoto failed, falling back to text:', err.message);
      }
    }

    await ctx.reply(fullText, { parse_mode: 'Markdown', ...keyboard }).catch(async () => {
      await ctx.reply(fullText.replace(/[*_`]/g, ''), keyboard).catch(() => { });
    });
  } catch (err: any) {
    console.error('[PNL_CARD] Error sending PNL card message:', err);
    if (headerMsg) {
      await ctx.reply(headerMsg, { parse_mode: 'Markdown' }).catch(() => { });
    }
  }
}

// ── Helper: Build Settings Dashboard with Checkmark Indicators ──────────────
export function buildSettingsDashboard(user: UserRecord) {
  const slip = user.slippage_pct ? Number(user.slippage_pct) : 2.0;
  const buyPct = user.default_buy_pct ? Number(user.default_buy_pct) : 10;
  const sellPct = user.default_sell_pct ? Number(user.default_sell_pct) : 100;
  const showNetWorth = Boolean(user.show_net_worth_on_card);
  const buyAmounts = parseBuyAmounts(user.custom_buy_amounts);
  const buyAmountsStr = buyAmounts.join(', ');

  const activeChainsSummary = formatActiveChainsSummary(user);

  const text =
    `⚙️ *Trading Settings*\n\n` +
    `• *Active Chains*: \`${activeChainsSummary}\`\n` +
    `• *Slippage*: \`${slip}%\`\n` +
    `• *Default Buy*: \`${buyPct}%\`\n` +
    `• *Default Sell*: \`${sellPct}%\`\n` +
    `• *Quick Buy Buttons*: \`${buyAmountsStr}\`\n` +
    `• *Net Worth on PnL*: ${showNetWorth ? '🟢 Shown' : '🔴 Hidden'}\n` +
    `• *NEAR Trade Mode*: ${user.near_trade_currency === 'usdc' ? '💵 USDC Only (Buy & Sell in USDC)' : '⬛ NEAR (Auto-combines USDC)'}`;

  const keyboard = Markup.inlineKeyboard([
    [
      cb('🌐 Active Chains / Visibility', 'menu_active_chains', 'primary'),
      cb(
        showNetWorth ? '👁 Net Worth: Shown' : '🙈 Net Worth: Hidden',
        'set:toggle_show_net_worth',
        'primary'
      ),
    ],
    [
      cb(
        user.near_trade_currency === 'usdc' ? '💵 NEAR Mode: USDC Only (Tap for NEAR)' : '⬛ NEAR Mode: NEAR + USDC (Tap for USDC Only)',
        'set:toggle_near_currency',
        'primary'
      ),
    ],
    [
      cb(`${slip === 0.5 ? '✓ ' : ''}0.5%`, 'set:slippage:0.5', 'primary'),
      cb(`${slip === 1 ? '✓ ' : ''}1%`, 'set:slippage:1', 'primary'),
      cb(`${slip === 2 ? '✓ ' : ''}2%`, 'set:slippage:2', 'primary'),
      cb(`${slip === 5 ? '✓ ' : ''}5%`, 'set:slippage:5', 'primary'),
      cb(`${slip === 10 ? '✓ ' : ''}10%`, 'set:slippage:10', 'primary'),
    ],
    [
      cb(`🟢 Buy: ${buyPct === 10 ? '✓ ' : ''}10%`, 'set:buy_pct:10', 'success'),
      cb(`${buyPct === 50 ? '✓ ' : ''}50%`, 'set:buy_pct:50', 'success'),
      cb(`${buyPct === 100 ? '✓ ' : ''}100%`, 'set:buy_pct:100', 'success'),
    ],
    [
      cb(`🔴 Sell: ${sellPct === 25 ? '✓ ' : ''}25%`, 'set:sell_pct:25', 'danger'),
      cb(`${sellPct === 50 ? '✓ ' : ''}50%`, 'set:sell_pct:50', 'danger'),
      cb(`${sellPct === 100 ? '✓ ' : ''}100%`, 'set:sell_pct:100', 'danger'),
    ],
    [
      cb(`${buyAmountsStr === '0.5, 1, 2' ? '✓ ' : ''}0.5, 1, 2`, 'set:buy_amounts:0.5,1,2', 'primary'),
      cb(`${buyAmountsStr === '1, 5, 10' ? '✓ ' : ''}1, 5, 10`, 'set:buy_amounts:1,5,10', 'primary'),
      cb(`${buyAmountsStr === '10, 25, 50' ? '✓ ' : ''}10, 25, 50`, 'set:buy_amounts:10,25,50', 'primary'),
    ],
    [
      cb('💰 Custom Buys', 'prompt:custom_buy_amounts', 'success'),
      cb('✏️ Slippage', 'prompt:custom_slippage', 'primary'),
    ],
    [
      cb('📢 Buy Alerts', 'menu_buyalerts', 'primary'),
      cb('🎁 RaceDrop', 'racedrop_start', 'primary'),
    ],
    [
      cb('💳 Wallets', 'wallets_menu', 'primary'),
      cb('🔑 Export Key', 'export_prompt', 'primary'),
    ],
    [
      cb('🔄 Rotate Key', 'rotate_prompt', 'primary'),
      cb('🔙 Main Menu', 'menu_home', 'primary'),
    ],
    [
      Markup.button.url('💬 Community', 'https://t.me/racerbot_community'),
      Markup.button.url('📢 Updates', 'https://t.me/racertrading'),
      Markup.button.url('𝕏 X', 'https://x.com/racertradingbot'),
    ],
  ]);

  return { text, keyboard };
}

function formatUtcTime(d: Date = new Date()): string {
  const hours = String(d.getUTCHours()).padStart(2, '0');
  const minutes = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hours}:${minutes} UTC`;
}

function formatUtcDateTime(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hours = String(d.getUTCHours()).padStart(2, '0');
  const minutes = String(d.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hours}:${minutes} UTC`;
}

// ── Helper: Build Snipe Rules Dashboard ─────────────────────────────────────
export async function buildSnipeDashboard(user: UserRecord) {
  const isUsdcMode = user.near_trade_currency === 'usdc';
  const currencyLabel = isUsdcMode ? 'USDC' : 'NEAR';
  const autoBuy = user.auto_buy_enabled;
  const autoAmt = user.auto_buy_amount_near ? Number(user.auto_buy_amount_near) : (isUsdcMode ? 10 : 1);
  const minLiq = user.auto_buy_min_liquidity_near ? Number(user.auto_buy_min_liquidity_near) : 0;
  const maxMcap = user.auto_buy_max_market_cap_usd != null ? Number(user.auto_buy_max_market_cap_usd) : 100000;
  const maxMcapStr = maxMcap > 0 ? (maxMcap >= 1000 ? `$${Math.round(maxMcap / 1000)}K` : `$${maxMcap}`) : 'No Limit';
  const activeOrders = await getSnipeOrdersByUser(user.id)
    .catch(() => [])
    .then((orders) => orders.filter((o) => o.status === 'active'));

  let activeText = '';
  if (activeOrders.length > 0) {
    activeText =
      `\n🎯 *Active Orders (${activeOrders.length})*:\n` +
      activeOrders
        .map((o) => {
          const target = o.snipe_type === 'token' ? `🪙 \`${o.token_address}\`` : `👤 \`${o.deployer_address}\``;
          const timing = o.execute_after && new Date(o.execute_after) > new Date()
            ? ` (⏰ ${formatUtcTime(new Date(o.execute_after))})`
            : '';
          const unit = o.trade_currency ? o.trade_currency.toUpperCase() : snipeUnit(o.token_address || o.deployer_address || '', user);
          return `• 🟢 ${target} — *${o.amount_near} ${unit}*${timing}`;
        })
        .join('\n');
  }

  const text =
    `🎯 *Snipe Rules*\n\n` +
    `• *Trading Currency*: ${isUsdcMode ? '💵 USDC Only (Ref Finance routing)' : '⬛ NEAR'}\n` +
    `• *Auto-Buy Launches*: ${autoBuy ? '🟢 Enabled' : '🔴 Disabled'}\n` +
    `• *Auto-Buy Amount*: \`${autoAmt} ${currencyLabel}\`\n` +
    `• *Min Liquidity*: \`${minLiq} NEAR\`\n` +
    `• *Max Market Cap*: \`${maxMcapStr}\`${activeText}\n\n` +
    `*Targeted Snipes*:\n` +
    `• 🎯 Snipe a specific token CA\n` +
    `• 👤 Snipe all launches by a dev wallet`;

  const cancelButtons: any[] = activeOrders.map((o) => [
    cb(
      `❌ Cancel ${o.snipe_type === 'token' ? o.token_address : 'dev ' + o.deployer_address}`.slice(0, 60),
      `snipe_order_cancel:${o.id}`,
      'danger'
    ),
  ]);

  const presetButtons = isUsdcMode
    ? [
        cb(`Auto: ${autoAmt === 5 ? '✓ ' : ''}$5`, 'set:auto_amt:5', 'primary'),
        cb(`${autoAmt === 10 ? '✓ ' : ''}$10`, 'set:auto_amt:10', 'primary'),
        cb(`${autoAmt === 25 ? '✓ ' : ''}$25`, 'set:auto_amt:25', 'primary'),
        cb(`${autoAmt === 50 ? '✓ ' : ''}$50`, 'set:auto_amt:50', 'primary'),
      ]
    : [
        cb(`Auto: ${autoAmt === 0.5 ? '✓ ' : ''}0.5N`, 'set:auto_amt:0.5', 'primary'),
        cb(`${autoAmt === 1 ? '✓ ' : ''}1N`, 'set:auto_amt:1', 'primary'),
        cb(`${autoAmt === 2 ? '✓ ' : ''}2N`, 'set:auto_amt:2', 'primary'),
        cb(`${autoAmt === 5 ? '✓ ' : ''}5N`, 'set:auto_amt:5', 'primary'),
      ];

  const keyboard = Markup.inlineKeyboard([
    ...cancelButtons,
    [
      cb(
        autoBuy ? 'Auto-Buy: 🟢 ON' : 'Auto-Buy: 🔴 OFF',
        'set:toggle_auto_buy',
        autoBuy ? 'success' : 'danger'
      ),
      cb(`📋 Orders (${activeOrders.length})`, 'snipe_orders', 'primary'),
    ],
    [
      cb('🎯 Snipe Token CA', 'snipe_token_start', 'success'),
      cb('👤 Snipe Dev', 'snipe_dev_start', 'success'),
    ],
    presetButtons,
    [
      cb(`Min Liq: ${minLiq === 0 ? '✓ ' : ''}0N`, 'set:min_liq:0', 'primary'),
      cb(`${minLiq === 10 ? '✓ ' : ''}10N`, 'set:min_liq:10', 'primary'),
      cb(`${minLiq === 50 ? '✓ ' : ''}50N`, 'set:min_liq:50', 'primary'),
      cb(`${minLiq === 500 ? '✓ ' : ''}500N`, 'set:min_liq:500', 'primary'),
    ],
    [
      cb(`Max Mcap: ${maxMcap === 25000 ? '✓ ' : ''}$25K`, 'set:max_mcap:25000', 'primary'),
      cb(`${maxMcap === 50000 ? '✓ ' : ''}$50K`, 'set:max_mcap:50000', 'primary'),
      cb(`${maxMcap === 100000 ? '✓ ' : ''}$100K`, 'set:max_mcap:100000', 'primary'),
      cb(`${maxMcap === 0 ? '✓ ' : ''}No Limit`, 'set:max_mcap:0', 'primary'),
    ],
    [
      cb(`✏️ Custom Auto-Buy (${currencyLabel})`, 'prompt:custom_auto_buy', 'primary'),
      cb('✏️ Custom Min Liq', 'prompt:custom_min_liq', 'primary'),
      cb('✏️ Custom Max Mcap', 'prompt:custom_max_mcap', 'primary'),
    ],
    [
      cb('🔙 Main Menu', 'menu_home', 'primary'),
    ],
    [
      Markup.button.url('💬 Community', 'https://t.me/racerbot_community'),
      Markup.button.url('📢 Updates', 'https://t.me/racertrading'),
      Markup.button.url('𝕏 X', 'https://x.com/racertradingbot'),
    ],
  ]);

  return { text, keyboard };
}

// ── Helper: Format DCA Interval ──────────────────────────────────────────────
export function formatDcaInterval(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} hr${seconds >= 7200 ? 's' : ''}`;
  return `${Math.round(seconds / 86400)} day${seconds >= 172800 ? 's' : ''}`;
}

export const MAX_COPY_TARGETS_PER_USER = 25;

// ── Helper: Build Copy Trading Dashboard ─────────────────────────────────────
export async function buildCopyTradingDashboard(user: UserRecord) {
  const targets = await getCopyTradeTargetsByUser(user.id).catch(() => []);
  const activeTargets = targets.filter(t => t.status === 'active');
  const pausedTargets = targets.filter(t => t.status === 'paused');
  const trackOnlyCount = targets.filter(t => t.track_only).length;
  const autoCopyCount = targets.filter(t => !t.track_only).length;

  let text =
    `👥 *Copy Trading & Wallet Tracker*\n\n` +
    `Mirror trades automatically or track wallet activities in real-time.\n\n` +
    `• *Active*: ${activeTargets.length} | *Paused*: ${pausedTargets.length}\n` +
    `• *Auto-Copy*: ${autoCopyCount} | *Tracker Only*: ${trackOnlyCount}\n` +
    `• *Capacity*: ${activeTargets.length}/${MAX_COPY_TARGETS_PER_USER} wallets\n\n`;

  if (targets.length === 0) {
    text +=
      `_No targets added yet._\n\n` +
      `Tap *➕ Add Target Wallet* to start.\n\n` +
      `🏆 *Season 1*: +25 pts per fill\n` +
      `+ 1.5 pts per NEAR volume copied!`;
  } else {
    text += `*Your Tracked & Copied Wallets:*\n`;
    for (const t of targets.slice(0, 15)) {
      const statusIcon = t.status === 'active' ? '🟢' : t.status === 'paused' ? '⏸️' : '⏹️';
      const cUnit = snipeUnit(t.target_wallet);
      const cShort = cUnit === 'SOL' ? ' SOL' : 'N';
      const modeTag = t.track_only ? '[👀 TRACKER]' : `[⚡ ${t.buy_amount_near}${cShort} COPY]`;
      const budgetText = t.max_daily_budget_near ? ` | Cap: ${t.max_daily_budget_near}${cShort}/day` : '';
      const sellText = t.track_only ? '' : ` | Sells: ${t.copy_sells ? '✅' : '❌'}`;
      text += `\n${statusIcon} \`${t.target_wallet}\` \`${modeTag}\`${cUnit === 'SOL' ? ' ◎' : ''}\n`;
      text += `   ${t.track_only ? '🔔 Alerts only (No auto-buy)' : `💰 ${t.buy_amount_near} ${cUnit} per buy${sellText}${budgetText}`}\n`;
    }
    if (targets.length > 15) {
      text += `\n_...and ${targets.length - 15} more targets_\n`;
    }
    text += `\n🏆 *Season 1*: +25 pts per fill + 1.5 pts per volume copied!`;
  }

  const buttons: any[] = [];
  buttons.push([cb('➕ Add Target Wallet', 'copy_add', 'success')]);

  for (const t of targets.slice(0, 10)) {
    const isPaused = t.status === 'paused';
    const shortWallet = t.target_wallet.length > 14 ? t.target_wallet.slice(0, 12) + '…' : t.target_wallet;
    const modeSwitchLabel = t.track_only ? '⚡ Auto-Copy' : '👀 Track';
    buttons.push([
      cb(
        `${isPaused ? '▶️' : '⏸️'} ${shortWallet}`,
        `copy_toggle:${t.id}`,
        isPaused ? 'success' : 'primary'
      ),
      cb(modeSwitchLabel, `copy_mode_toggle:${t.id}`, 'primary'),
      cb('🗑️', `copy_stop:${t.id}`, 'danger'),
      cb('📤', `copy_share:${t.id}`, 'primary'),
    ]);
  }

  buttons.push([cb('🔄 Refresh', 'menu_copy', 'primary'), cb('🔙 Back to Main Menu', 'menu_home', 'primary')]);
  return { text, keyboard: Markup.inlineKeyboard(buttons) };
}

// ── Helper: Build DCA Dashboard ──────────────────────────────────────────────
/** Native unit for a snipe / copy target: SOL for Solana, STRK for Starknet, SUI for Sui, HYPE for EVM, USDC if user trades in USDC, NEAR otherwise. */
function snipeUnit(addr: string, user?: UserRecord | null): string {
  if (isSolanaAddress(addr) || isSolanaToken(addr)) return 'SOL';
  if (isStarknetToken(addr) || isValidStarknetAddress(addr)) return 'STRK';
  if (isSuiToken(addr)) return 'SUI';
  if (isValidEvmAddress(addr) && !addr.endsWith('.near')) return 'HYPE';
  if (user?.near_trade_currency === 'usdc') return 'USDC';
  return 'NEAR';
}

export async function buildDcaDashboard(user: UserRecord) {
  const orders = await getDcaOrdersByUser(user.id).catch(() => []);
  const activeOrders = orders.filter(o => o.status === 'active');

  let text =
    `🔁 *DCA Orders*\n\n` +
    `Automate recurring buys or sells.\n\n` +
    `• *Active*: ${activeOrders.length} | *Total*: ${orders.length}\n\n`;

  if (orders.length === 0) {
    text +=
      `_No DCA orders set up._\n\n` +
      `Tap *➕ New DCA Order* to schedule\nautomated recurring trades.`;
  } else {
    text += `*Your Schedules:*\n`;
    for (const o of orders.slice(0, 8)) {
      const statusIcon = o.status === 'active' ? '🟢' : o.status === 'paused' ? '⏸️' : o.status === 'completed' ? '✅' : '❌';
      const sideText = o.side === 'buy' ? '🟢 Buy' : '🔴 Sell';
      const tokenDisplay = o.token_address.length > 20 ? o.token_address.slice(0, 10) + '…' + o.token_address.slice(-6) : o.token_address;
      const progressText = o.total_orders === 0 ? `${o.executed_orders} fills (∞)` : `${o.executed_orders}/${o.total_orders}`;
      text += `\n${statusIcon} ${sideText} \`${tokenDisplay}\`\n`;
      const dcaNative = getChainNativeUnit(o.token_address, user);
      text += `   💵 ${o.amount_per_order} ${o.side === 'buy' ? dcaNative : 'tokens'} every ${formatDcaInterval(o.interval_seconds)} (${progressText})\n`;
      if (o.last_error) {
        text += `   ⚠️ _Last tick note_: \`${o.last_error.slice(0, 40)}\`\n`;
      }
    }
  }

  const buttons: any[] = [];
  buttons.push([cb('➕ New DCA Order', 'dca_start', 'success')]);

  for (const o of orders.slice(0, 4)) {
    if (o.status === 'active' || o.status === 'paused') {
      const isPaused = o.status === 'paused';
      const tokenShort = o.token_address.length > 12 ? o.token_address.slice(0, 10) + '…' : o.token_address;
      buttons.push([
        cb(`${isPaused ? '▶️ Resume' : '⏸ Pause'} ${tokenShort}`, `dca_toggle:${o.id}`, isPaused ? 'success' : 'primary'),
        cb('🗑 Cancel', `dca_del:${o.id}`, 'danger'),
      ]);
    }
  }

  buttons.push([cb('🔄 Refresh', 'menu_dca', 'primary'), cb('🔙 Back to Main Menu', 'menu_home', 'primary')]);
  return { text, keyboard: Markup.inlineKeyboard(buttons) };
}

// ── User-Friendly Error Messages ────────────────────────────────────────
export function getUserFriendlyError(error: Error | string): string {
  const errorMsg = typeof error === 'string' ? error : (error.message || String(error));
  console.error('[USER_ERROR]', errorMsg);
  const r = errorMsg.toLowerCase();
  // ── Honeypot / Malicious Backdoor block ──────────────────────────────────
  if (r.includes('order blocked for your protection') || r.includes('malicious honeypot')) {
    return errorMsg;
  }

  // ── Wallet not set up ────────────────────────────────────────────────────
  if (r.includes('please run /start') || r.includes('user not found') || r.includes('wallet not found'))
    return 'Wallet not found. Please run /start first.';
  if (r.includes('unauthorized') || r.includes('forbidden'))
    return 'Authentication required. Please run /start.';

  // ── RaceDrop Duplicate Claim ──────────────────────────────────────────────
  if (
    r.includes('uq_drop_claim_user') ||
    r.includes('uq drop claim user') ||
    r.includes('you have already claimed this racedrop') ||
    (r.includes('duplicate key') && r.includes('race_drop'))
  ) {
    return '⚠️ You have already claimed this RaceDrop! Your tokens are already in your wallet.';
  }

  // ── Auth & Trading Key ───────────────────────────────────────────────────
  if (
    r.includes('unsupported state') ||
    r.includes('unable to authenticate data') ||
    r.includes('wallet key') ||
    r.includes('key authentication failed')
  ) {
    return 'Wallet trading key authentication failed. Please run /rotatekey to refresh your key.';
  }
  if (
    r.includes('notenoughallowance') ||
    r.includes('not enough allowance') ||
    r.includes('lacking access key') ||
    r.includes('allowance exhausted')
  ) {
    return 'Key allowance exhausted. Please run /rotatekey to reset your trading key.';
  }

  // ── Balance errors (check BEFORE generic timeouts — stale balance cache can
  //    let a trade reach the executor where it fails on-chain; that error must
  //    not be swallowed into the generic "confirmation taking longer" message) ─
  if (r.includes('insufficient balance') || (r.includes('insufficient') && r.includes('balanc')))
    return errorMsg.slice(0, 280); // already human-readable from executeBuyHelper / executor
  if (r.includes('not_enough_balance') || r.includes('notenoughbalance'))
    return errorMsg.slice(0, 280);
  if (r.includes('available balance') && r.includes('too low'))
    return errorMsg.slice(0, 280);
  if (r.includes('insufficient near') || r.includes('not enough near'))
    return errorMsg.slice(0, 280);
  if (r.includes('insufficient token balance') || r.includes('you have 0'))
    return errorMsg.slice(0, 280);
  if (r.includes('amount exceeds') || r.includes('recipient is not registered') || r.includes('invalid destination'))
    return errorMsg.slice(0, 280);
  if (r.includes("doesn't have enough balance") || r.includes('does not have enough balance') || r.includes('not enough balance')) {
    if (r.includes('sol') || r.includes('hype') || r.includes('sui') || r.includes('strk') || r.includes('usdc') || r.includes('near')) {
      return errorMsg.slice(0, 280);
    }
    return 'Insufficient balance — your wallet does not have enough funds. Please deposit and retry.';
  }
  if (r.includes('insufficient near for gas') || (r.includes('insufficient') && r.includes('gas')))
    return errorMsg.slice(0, 280);
  if (r.includes('minimum buy amount') || r.includes('minimum is 0.001'))
    return errorMsg.slice(0, 280);
  if (r.includes('failed to fetch wallet balance'))
    return 'Unable to check your wallet balance right now. Please try again in a moment.';

  // ── Venue / pool discovery ───────────────────────────────────────────────
  if (r.includes('could not determine dex venue') || r.includes('could not determine venue'))
    return 'Unable to find a trading pool for this token. Paste the exact contract address.';
  if (r.includes('token is on') && (r.includes('not yet supported') || r.includes('not supported')))
    return errorMsg.slice(0, 280);
  if (
    r.includes('no pool') ||
    r.includes('pool not found') ||
    r.includes('no dcl pool') ||
    r.includes('no liquidity pool') ||
    r.includes('no active rhea') ||
    r.includes('missing field pool_id') ||
    r.includes('failed to fetch pool reserves') ||
    r.includes('no active pool') ||
    r.includes('pool_not_found')
  ) {
    return 'No active liquidity pool found for this token on DEX. It may not be tradeable yet.';
  }
  if (r.includes('err_token') || r.includes('not_enough') || r.includes('drained') || (r.includes('wrap.near') && r.includes('enough'))) {
    if (r.includes('sol') || r.includes('hype') || r.includes('sui') || r.includes('strk')) {
      return 'DEX pool has insufficient liquidity to complete your trade.';
    }
    return 'DEX pool has insufficient liquidity (pool is empty or drained).';
  }
  if (r.includes('insufficient liquidity') || r.includes('not enough liquidity'))
    return 'Not enough liquidity in the pool for this trade size. Try a smaller amount.';
  if (r.includes('prebonded') || r.includes('not yet bonded') || r.includes('bonding curve phase') || r.includes('bonding phase'))
    return 'Token is still in its bonding curve phase — wait for it to bond before buying.';
  if (r.includes('not paired with near') || r.includes('paired with'))
    return errorMsg.slice(0, 280);

  // ── Swap failure on-chain ────────────────────────────────────────────────
  if (r.includes('no transaction was sent'))
    return 'Price moved beyond your slippage setting before execution. The trade was NOT sent — no funds spent. Retry for a fresh quote, or increase slippage in ⚙️ Settings.';
  if (r.includes('slippage') || r.includes('min_amount_out') || r.includes('less than minimum'))
    return 'Slippage too high — price moved against you. Try increasing slippage in ⚙️ Settings, then retry.';
  if (r.includes('swap produced no') || r.includes('dex refunded'))
    return errorMsg.slice(0, 280);
  if (r.includes('swap failed'))
    return errorMsg.slice(0, 280);

  // ── Token storage / registration ─────────────────────────────────────────
  if (r.includes('e407') || r.includes('not in pool whitelist') || r.includes('whitelist'))
    return 'This pool is restricted to DEX solvers (Ref DCL E407). RacerBot automatically re-routes through public liquidity pools.';
  if (r.includes('not registered') || r.includes('account is not registered'))
    return 'Your wallet needs to be registered with this token. This is usually done automatically — please retry.';

  // ── Gas ──────────────────────────────────────────────────────────────────
  if (r.includes('exceeded the prepaid gas') || r.includes('gas exceeded'))
    return 'Transaction exceeded prepaid gas. Please retry.';

  // ── Contract panics that contain balance info ─────────────────────────────
  if (r.includes('contract error: insufficient') || r.includes('insufficient balance on-chain'))
    return errorMsg.slice(0, 280);
  if (r.includes('contract error:') || r.includes('smart_contract_panic'))
    return `Contract error: ${sanitizeMd(errorMsg.replace(/.*FunctionCallError.*ExecutionError\":\"([^"]+)\".*$/, '$1').slice(0, 180))}`;
  if ((r.includes('panic') || r.includes('wasm execution failed') || r.includes('executionerror')))
    return `Contract error: ${sanitizeMd(errorMsg.replace(/.*FunctionCallError.*ExecutionError\":\"([^"]+)\".*$/, '$1').slice(0, 180))}`;

  // ── Storage registration timeouts ────────────────────────────────────────
  if (r.includes('storage registration') && (r.includes('timed out') || r.includes('congested'))) {
    return '⏳ Wallet registration timed out — the NEAR network is congested. No funds were spent. Please retry in a moment.';
  }
  if (r.includes('ref finance') && r.includes('congested')) {
    return '⏳ Ref Finance registration timed out — the NEAR network is congested. No funds were spent. Please retry in a moment.';
  }
  if (r.includes('storage') && r.includes('never reached the near network')) {
    return '⏳ Wallet storage registration timed out — the NEAR network is congested. No funds were spent. Please retry in a moment.';
  }
  if (r.includes('never reached the near network')) {
    return 'Your transaction never reached the NEAR network \u2014 it was NOT executed and no funds were spent. The network is congested right now; it is safe to retry in a moment.';
  }

  // ── Pending / slow confirmation ───────────────────────────────────────────────
  // Fires AFTER all specific errors so balance/pool errors never reach this.
  if (r.includes('not confirmed within') || r.includes('taking too long') || r.includes('outcome is unknown')) {
    return '\u23f3 Transaction was submitted but confirmation is taking longer than usual. Please check your wallet balance or NearBlocks before retrying to avoid duplicate trades.';
  }

  // ── Distributed Lock Contention ──────────────────────────────────────────────
  if (r.includes('another transaction is already in progress') || r.includes('wallet lock') || r.includes('contention')) {
    return 'Another transaction is already in progress for this wallet \u2014 please wait a moment and try again.';
  }

  // ── NEAR RPC errors ───────────────────────────────────────────────────
  if (r.includes('all near rpc broadcast failed'))
    return 'All NEAR RPC nodes rejected the transaction. Please retry in a moment.';
  if (r.includes('signing timed out'))
    return 'Transaction signing timed out. Please retry.';
  if (r.includes('timeout') || r.includes('timed out'))
    return 'Network timeout \u2014 NEAR RPC is slow right now. Please retry.';
  if (r.includes('expired') || r.includes('nonce'))
    return 'Transaction expired due to network latency. Please retry.';

  // ── Misc known patterns ────────────────────────────────────────────────
  if (r.includes('too many requests') || r.includes('rate limit'))
    return 'You\'re doing this too fast. Please wait a moment.';
  if (r.includes('token not found') || r.includes('token lookup failed'))
    return 'Unable to find this token. Please verify the contract address.';

  // ── Pass through clean sanitized error message ──────────────────────────────
  console.error('[UNHANDLED_ERROR]', errorMsg);
  const clean = errorMsg.split('\n')[0].replace(/ed25519:[a-zA-Z0-9]+/g, '***').trim();
  if (clean.length > 0 && clean.length < 250) {
    return sanitizeMd(clean);
  }
  return 'Trading operation could not be completed. Please check your balance and settings, then retry.';
}

// ── Live stage progress on the "Processing order…" message ───────────────────
// Telegram inline/text messages can't animate, so instead of one frozen
// message for the whole pipeline, we edit it as the trade moves through
// stages: fetching a fresh pool quote, one-time storage registration,
// signing/broadcasting, and a slow-confirmation reassurance after 15s.
const ORDER_STAGE_LINES: Record<string, string> = {
  quote: '🔎 Checking current pool price…',
  storage: '📦 Registering token storage (one-time, fast)…',
  signing: '✍️ Signing & broadcasting your transaction…',
  submitted: '🚀 *Trade submitted to NEAR.*\n\nWaiting for on-chain execution and final confirmation…',
  confirming_slow:
    '⏳ *Trade was submitted, but confirmation is taking longer than usual.*\n\n' +
    'The RPC is still waiting for the on-chain result. Do not retry yet: I\'ll confirm the outcome as soon as it arrives.',
  // Starknet Live Stages
  routing_starknet: '⚡ Routing trade via AVNU & Ekubo…',
  deploying_account: '🛡️ Deploying your Starknet Account contract (one-time setup)…',
  executing_swap: '✍️ Signing & submitting swap to Starknet sequencer…',
  confirming_tx: '🚀 Trade submitted to Starknet! Awaiting block confirmation…',
  // Solana Live Stages
  routing_solana: '⚡ Routing trade via Jupiter (pump.fun curve, PumpSwap, Raydium, Meteora)…',
  checking_balance: '💳 Checking your wallet balance…',
  fetching_quote: '📊 Finding the best route…',
  checking_token_balance: '💳 Checking your token balance…',
  signing_and_broadcasting: '✍️ Signing & broadcasting to Solana…',
  confirming: '🚀 Submitted to Solana! Awaiting confirmation…',
  recording_position: '📒 Recording your position…',
  updating_position: '📒 Updating your position…',
};

function makeStageEditor(ctx: Context, procMsg: { message_id: number } | null, orderLabel: string) {
  let currentStage = '';
  return async (stage: string): Promise<void> => {
    if (!procMsg || !ctx.chat || stage === currentStage) return;
    const line = ORDER_STAGE_LINES[stage];
    if (!line) return;
    currentStage = stage;
    await ctx.telegram
      .editMessageText(ctx.chat.id, procMsg.message_id, undefined, `⏳ *${orderLabel}*\n\n${line}`, { parse_mode: 'Markdown' })
      .catch(() => { /* message may be deleted or unchanged — non-fatal */ });
  };
}

// ── Core Helper: Execute Buy for User ────────────────────────────────────────
export async function executeBuyHelper(
  userIdOrTelegramId: number | string,
  rawTokenAddress: string,
  amountNear: number,
  onProgress?: (stage: string) => void
): Promise<{ success: boolean; amountNear: number; tokenAddress: string; message: string; positionId?: string; tokenName?: string; tokenSymbol?: string; tokenQty?: string; priceNear?: number; nearSpent?: number; txHash?: string }> {
  const tokenAddress = resolveTokenAddressFromKey(rawTokenAddress);
  const user = typeof userIdOrTelegramId === 'string'
    ? await getUserById(userIdOrTelegramId)
    : await getUserByTelegramId(userIdOrTelegramId);
  if (!user) {
    throw new Error('Please run /start or connect your trading wallet first.');
  }

  if (amountNear < 0.001) {
    const buyUnit = getChainNativeUnit(tokenAddress, user);
    throw new Error(`Minimum buy amount is 0.001 ${buyUnit}.`);
  }

  const isSuiHint = isSuiToken(tokenAddress) || rawTokenAddress.includes('::');
  const isSolanaHint = isSolanaToken(tokenAddress);
  const isStarknetHint = !isSolanaHint && isStarknetToken(tokenAddress);

  const activeNearWallet = !isSuiHint && !isStarknetHint && !isSolanaHint ? await getActiveWallet(user.id, 'near').catch(() => null) : null;
  const nearAccountToUse = activeNearWallet?.address || user.subaccount_id;
  const activeSuiWallet = isSuiHint || user.sui_address ? await getActiveWallet(user.id, 'sui').catch(() => null) : null;
  const suiAddrToUse = activeSuiWallet?.address || user.sui_address || '';

  // Parallel pre-flight: resolve fast route, wallet balances, USD prices, and honeypot safety audit all in one parallel round-trip!
  const [info, nearBalRes, suiBalRes, nearUsdVal, suiUsdVal, safetyRes] = await Promise.all([
    getFastTokenRoute(tokenAddress).catch(() => null),
    !isSuiHint && !isStarknetHint && !isSolanaHint && nearAccountToUse
      ? Promise.all([
        near.getNearBalance(nearAccountToUse).catch(() => null),
        near.getTokenBalance('wrap.near', nearAccountToUse).catch(() => '0'),
        near.getTokenBalance(NEAR_USDC_CONTRACT, nearAccountToUse).catch(() => '0'),
      ])
      : Promise.resolve([null, '0', '0'] as [string | null, string, string]),
    suiAddrToUse
      ? getSuiBalance(suiAddrToUse).catch(() => ({ mist: 0n, formatted: '0' }))
      : Promise.resolve({ mist: 0n, formatted: '0' }),
    !isSuiHint && !isStarknetHint && !isSolanaHint ? getNearUsdPrice().catch(() => 0) : Promise.resolve(0),
    isSuiHint ? getSuiUsdPrice().catch(() => 0) : Promise.resolve(0),
    checkTokenSafety(tokenAddress).catch(() => null),
  ]);

  if (safetyRes?.isHoneypot) {
    const reasonText = safetyRes.reasons[0] || `Backdoor method detected: ${safetyRes.dangerousMethods.join(', ')}`;
    throw new Error(
      `🚨 ORDER BLOCKED FOR YOUR PROTECTION:\n\n` +
      `This token (\`${tokenAddress}\`) was identified as a MALICIOUS HONEYPOT.\n` +
      `• ${reasonText}\n\n` +
      `🛡️ RacerBot has blocked this transaction to prevent loss of funds.`
    );
  }

  if (!info) {
    throw new Error('Could not resolve token details. Please verify the address.');
  }

  const slippagePct = user.slippage_pct ? Number(user.slippage_pct) : 2.0;

  // ── HyperEVM & Elysium Trading Path ──────────────────────────────────────
  // Kleos coins live on Elysium mainnet (99901); other Elysium tokens here are on the Kinetiq testnet
  const isKleos = info.venue === 'kleos';
  if (isKleos && !isKleosTradingEnabled()) {
    throw new Error('This coin is on Kleos (Elysium mainnet), which RacerBot cannot trade yet. You can buy it on thekleos.xyz.');
  }
  if (info.chain === 'hyperevm' || info.chain === 'elysium' || (isValidEvmAddress(tokenAddress) && !isStarknetHint && !tokenAddress.endsWith('.near'))) {
    const chain: EvmChain = (info.chain === 'elysium' || tokenAddress.toLowerCase().endsWith('.elysium')) ? 'elysium' : 'hyperevm';
    const evmUser = user.evm_address ? user : await ensureUserEvmWallet(user);
    if (!evmUser.evm_address) {
      throw new Error('Your EVM wallet is not ready yet. Please send /start and try again.');
    }

    const isTestnet = chain === 'elysium' ? !isKleos : (process.env.HYPEREVM_TESTNET === 'true');
    const amountHype = amountNear;
    const amountInWei = ethers.parseEther(String(amountHype));
    const HYPE_GAS_RESERVE = ethers.parseEther('0.002');
    // A Kleos buy can be paid from HyperEVM or Elysium HYPE; the executor checks both
    const userBal = isKleos ? null : await getHypeBalance(evmUser.evm_address, chain, isTestnet);

    if (userBal && userBal.raw < amountInWei + HYPE_GAS_RESERVE) {
      if (userBal.raw <= HYPE_GAS_RESERVE) {
        throw new Error(
          `Your EVM wallet (\`${evmUser.evm_address}\`) has insufficient HYPE for gas.\n\nPlease deposit HYPE to trade on ${chain === 'elysium' ? 'Elysium' : 'HyperEVM'}.`
        );
      }
      throw new Error(
        `Insufficient HYPE balance for ${amountHype} HYPE purchase + network gas.\n` +
        `Available: ${userBal.formatted} HYPE`
      );
    }

    const swapResult = await publishSwap({
      user_id: user.id,
      chain,
      token_in: 'HYPE',
      token_out: tokenAddress,
      amount_in: String(amountHype),
      min_amount_out: '1',
      venue: isKleos ? 'kleos' : `${chain}_dex` as any,
      slippage_pct: slippagePct,
    }, onProgress);

    if (swapResult.success === false) {
      throw new Error(swapResult.reason || `${chain} swap failed on-chain.`);
    }

    const tokenSym = swapResult.tokenSymbol || info.symbol || 'TOKEN';
    const tokenName = swapResult.tokenName || info.name || tokenSym;
    const tokenQtyHuman = Number(swapResult.tokenQty ?? 0);
    const tokenQtyDisplay = tokenQtyHuman >= 1_000_000
      ? `${(tokenQtyHuman / 1_000_000).toFixed(3)}M`
      : tokenQtyHuman >= 1_000
        ? `${(tokenQtyHuman / 1_000).toFixed(2)}K`
        : tokenQtyHuman.toFixed(4);

    const baseExplorer = isKleos ? ELYSIUM_MAINNET_EXPLORER_URL : chain === 'elysium' ? ELYSIUM_TESTNET_EXPLORER_URL : HYPEREVM_EXPLORER_URL;

    return {
      success: true,
      amountNear: amountHype,
      tokenAddress,
      tokenName,
      tokenSymbol: tokenSym,
      tokenQty: swapResult.tokenQty,
      priceNear: swapResult.priceNear,
      nearSpent: amountHype,
      positionId: swapResult.positionId,
      txHash: swapResult.txHash,
      message:
        `🚀 *Buy Confirmed!* (${isKleos ? 'Kleos' : chain === 'elysium' ? 'Elysium' : 'HyperEVM'})\n\n` +
        `Bought: *${tokenQtyDisplay} ${tokenSym}*\n` +
        `Spent: *${amountHype} HYPE*\n` +
        `Tx Hash: \`${swapResult.txHash}\`\n` +
        `🔗 [View on Explorer](${baseExplorer}/tx/${swapResult.txHash})`,
    };
  }

  // ── Solana Trading Path (pump.fun curve + bonded AMMs via Jupiter) ─────────
  if (info.chain === 'solana' || isSolanaHint) {
    const solUser = user.solana_address ? user : await ensureUserSolanaWallet(user);
    if (!solUser.solana_address) {
      throw new Error('Your Solana wallet is not ready yet. Please send /start and try again.');
    }
    const lamports = BigInt(Math.floor(amountNear * 1e9));
    const solSlippage = Math.max(slippagePct, info.bonding_phase === 'prebonded' ? 5 : 2);
    const swapResult = await publishSwap({
      user_id: user.id,
      chain: 'solana',
      token_in: 'So11111111111111111111111111111111111111112',
      token_out: tokenAddress,
      amount_in: lamports.toString(),
      min_amount_out: '1',
      venue: (info.venue as any) || 'jupiter',
      slippage_pct: solSlippage,
    }, onProgress);

    if (swapResult.success === false) {
      throw new Error(swapResult.reason || 'Solana swap failed.');
    }

    const tokenSym = swapResult.tokenSymbol || info.symbol || 'TOKEN';
    const tokenName = swapResult.tokenName || info.name || tokenSym;
    const qty = Number(swapResult.tokenQty ?? 0);
    const qtyDisplay = qty >= 1_000_000 ? `${(qty / 1_000_000).toFixed(3)}M` : qty >= 1_000 ? `${(qty / 1_000).toFixed(2)}K` : qty.toFixed(4);
    const entry = swapResult.priceNear && swapResult.priceNear > 0 ? swapResult.priceNear : parseFloat(info.price) || 0;
    return {
      success: true,
      amountNear,
      tokenAddress,
      positionId: swapResult.positionId,
      tokenName,
      tokenSymbol: tokenSym,
      tokenQty: swapResult.tokenQty,
      priceNear: swapResult.priceNear,
      nearSpent: swapResult.nearSpent,
      message:
        `✅ *Buy Confirmed on Solana!*\n\n` +
        `🪙 *${sanitizeMd(tokenName)}* (${sanitizeMd(tokenSym)})\n` +
        `📦 Received: \`${qtyDisplay} ${sanitizeMd(tokenSym)}\`\n` +
        `💸 Spent: \`${amountNear.toFixed(4)} SOL\`\n` +
        `💵 Entry: \`${entry > 0 ? entry.toExponential(4) : '—'} SOL\`\n` +
        `🔗 [View on Solscan](https://solscan.io/tx/${swapResult.txHash})`,
    };
  }

  // ── Starknet Trading Path ──────────────────────────────────────────────────
  if (info.chain === 'starknet' || info.venue === 'avnu' || info.venue === 'ekubo' || info.venue === 'launchy' || info.venue === 'unruggable' || isStarknetHint) {
    if (!user.starknet_address) {
      await ensureUserStarknetWallet(user);
    }
    const userStarknetAddr = user.starknet_address!;
    const userBal = await getStarknetBalance(userStarknetAddr);
    let amountInWei = BigInt(Math.floor(amountNear * 1e18));

    // Support both STRK and ETH input tokens seamlessly depending on user's wallet funds
    const hasEnoughStrk = userBal.strk >= amountInWei;
    const hasEnoughEth = userBal.eth >= amountInWei;

    if (!hasEnoughStrk && !hasEnoughEth) {
      if (userBal.strk === 0n && userBal.eth === 0n) {
        throw new Error(
          `Your Starknet wallet (\`${userStarknetAddr}\`) has 0 balance.\n\nPlease deposit STRK or ETH to trade.`
        );
      }
      throw new Error(
        `Insufficient balance for ${amountNear} purchase.\n` +
        `Available: ${userBal.strkFormatted} STRK | ${userBal.ethFormatted} ETH`
      );
    }

    const useEth = !hasEnoughStrk && hasEnoughEth;
    const tokenIn = useEth ? 'eth' : 'strk';
    const tokenInSymbol = useEth ? 'ETH' : 'STRK';

    // Auto-reserve gas to prevent out-of-gas errors during deployment or multicall execution
    const STRK_GAS_RESERVE = 50_000_000_000_000_000n; // 0.05 STRK
    const ETH_GAS_RESERVE = 100_000_000_000_000n;     // 0.0001 ETH

    if (!useEth) {
      // Paying swap in STRK. If user has < 0.0001 ETH, gas is paid in STRK.
      if (userBal.eth < ETH_GAS_RESERVE) {
        if (amountInWei + STRK_GAS_RESERVE > userBal.strk) {
          if (userBal.strk > STRK_GAS_RESERVE) {
            amountInWei = userBal.strk - STRK_GAS_RESERVE;
          } else {
            throw new Error('Insufficient STRK to cover gas fees. Please leave at least 0.05 STRK in your wallet.');
          }
        }
      }
    } else {
      // Paying swap in ETH. If user has < 0.05 STRK, gas is paid in ETH.
      if (userBal.strk < STRK_GAS_RESERVE) {
        if (amountInWei + ETH_GAS_RESERVE > userBal.eth) {
          if (userBal.eth > ETH_GAS_RESERVE) {
            amountInWei = userBal.eth - ETH_GAS_RESERVE;
          } else {
            throw new Error('Insufficient ETH to cover gas fees. Please leave at least 0.0001 ETH in your wallet.');
          }
        }
      }
    }

    const swapResult = await publishSwap({
      user_id: user.id,
      chain: 'starknet',
      token_in: tokenIn,
      token_out: tokenAddress,
      amount_in: amountInWei.toString(),
      min_amount_out: '1',
      venue: (info.venue as any) || 'avnu',
      slippage_pct: slippagePct,
    }, onProgress);

    if (swapResult.success === false) {
      throw new Error(swapResult.reason || 'Starknet swap failed on-chain.');
    }

    const tokenSym = swapResult.tokenSymbol || info.symbol || 'TOKEN';
    const tokenName = swapResult.tokenName || info.name || tokenSym;
    const tokenQtyHuman = Number(swapResult.tokenQty ?? 0);
    const tokenQtyDisplay = tokenQtyHuman >= 1_000_000
      ? `${(tokenQtyHuman / 1_000_000).toFixed(3)}M`
      : tokenQtyHuman >= 1_000
        ? `${(tokenQtyHuman / 1_000).toFixed(2)}K`
        : tokenQtyHuman.toFixed(4);

    return {
      success: true,
      amountNear,
      tokenAddress,
      tokenName,
      tokenSymbol: tokenSym,
      tokenQty: swapResult.tokenQty,
      priceNear: swapResult.priceNear,
      nearSpent: amountNear,
      positionId: swapResult.positionId,
      message:
        `🚀 *Buy Confirmed!* (Starknet)\n\n` +
        `Bought: *${tokenQtyDisplay} ${tokenSym}*\n` +
        `Spent: *${amountNear} ${tokenInSymbol}*\n` +
        `Tx Hash: \`${swapResult.txHash}\``,
    };
  }

  // ── SUI / SuiPump Trading Path ──────────────────────────────────────────────
  if (info.chain === 'sui' || info.venue === 'suipump' || isSuiToken(tokenAddress)) {
    if (!user.sui_address) {
      throw new Error('Please run /start to set up your Sui wallet first.');
    }
    const userSuiBal = suiBalRes;
    const effectiveSuiUsd = suiUsdVal > 0 ? suiUsdVal : 2.0;
    const minReserveSui = 0.01;
    const amountInMistBigInt = BigInt(Math.floor(amountNear * 1e9));
    const minReserveMist = BigInt(Math.ceil(minReserveSui * 1e9));

    if (userSuiBal.mist < amountInMistBigInt + minReserveMist) {
      const availSui = (Number(userSuiBal.mist) / 1e9).toFixed(4);
      const availUsd = (Number(userSuiBal.mist) / 1e9 * effectiveSuiUsd).toFixed(2);
      const remainingMist = userSuiBal.mist > amountInMistBigInt ? userSuiBal.mist - amountInMistBigInt : 0n;
      const remainingSui = (Number(remainingMist) / 1e9).toFixed(4);
      const remainingUsd = (Number(remainingMist) / 1e9 * effectiveSuiUsd).toFixed(2);
      const requiredReserveSuiStr = minReserveSui.toFixed(4);

      throw new Error(
        `Insufficient balance after swap. Your wallet must keep a minimal reserve of ${requiredReserveSuiStr} SUI (~$${(minReserveSui * effectiveSuiUsd).toFixed(2)}) to cover transaction gas. You have $${availUsd} (${availSui} SUI), and would only have $${remainingUsd} (${remainingSui} SUI) left after this swap. Please reduce your buy amount or deposit more SUI.`
      );
    }

    const amountInMist = amountInMistBigInt.toString();
    const swapResult = await publishSwap({
      user_id: user.id,
      chain: 'sui',
      token_in: 'sui',
      token_out: tokenAddress,
      amount_in: amountInMist,
      min_amount_out: '1',
      venue: 'suipump',
      slippage_pct: slippagePct,
    }, onProgress);

    if (swapResult.success === false) {
      throw new Error(swapResult.reason || 'Sui swap failed on-chain.');
    }

    const tokenSym = swapResult.tokenSymbol || info.symbol || 'TOKEN';
    const tokenName = swapResult.tokenName || info.name || tokenSym;
    const tokenQtyHuman = Number(swapResult.tokenQty ?? 0);
    const tokenQtyDisplay = (() => {
      const qty = tokenQtyHuman;
      if (qty >= 1_000_000) return `${(qty / 1_000_000).toFixed(3)}M`;
      if (qty >= 1_000) return qty.toLocaleString('en-US', { maximumFractionDigits: 2 });
      if (qty >= 0.0001) return qty.toFixed(4);
      return qty > 0 ? qty.toExponential(3) : '—';
    })();
    const entryPrice = swapResult.priceNear && swapResult.priceNear > 0 ? swapResult.priceNear : (parseFloat(info.price) || 0);
    const priceDisplay = entryPrice > 0 ? `${entryPrice.toFixed(8)} SUI` : '—';
    const valueSui = tokenQtyHuman * entryPrice;

    return {
      success: true,
      amountNear,
      tokenAddress,
      positionId: swapResult.positionId,
      tokenName: swapResult.tokenName,
      tokenSymbol: swapResult.tokenSymbol,
      tokenQty: swapResult.tokenQty,
      priceNear: swapResult.priceNear,
      nearSpent: swapResult.nearSpent,
      message:
        `✅ *Buy Confirmed on Sui!*\n\n` +
        `🪙 *${sanitizeMd(tokenName)}* (${sanitizeMd(tokenSym)})\n` +
        `📦 Received: \`${tokenQtyDisplay} ${sanitizeMd(tokenSym)}\`\n` +
        `💸 Spent: \`${amountNear.toFixed(4)} SUI\`\n` +
        `💵 Entry: \`${priceDisplay}\`\n\n` +
        `📊 *Position*\n` +
        `💰 Value: \`${valueSui.toFixed(4)} SUI\`\n` +
        `📈 PnL: \`+0.0%\``,
    };
  }

  if (!['rhea', 'ref', 'shardsmarket', 'nearlytrade', 'intear', 'onetokenhub', 'nearpad', 'gaypad', 'memecooking', 'shoremarkets', 'kelytra', 'nearpumpfun'].includes(info.venue)) {
    if (info && !info.tradeable) {
      const venueName = info.venue === 'memecooking' ? 'Meme.Cooking' : info.venue;
      throw new Error(`Token is on ${venueName} which is not yet supported for direct trading via RacerBot.`);
    }
    throw new Error('Could not determine DEX venue for token. Please verify the contract address.');
  }
  const venue = info.venue as 'rhea' | 'ref' | 'shardsmarket' | 'nearlytrade' | 'intear' | 'onetokenhub' | 'nearpad' | 'gaypad' | 'memecooking' | 'shoremarkets' | 'kelytra' | 'nearpumpfun';
  const effectiveDclPoolId = info.dcl_pool_id ?? undefined;
  const effectiveRheaPoolId = ((venue === 'nearlytrade' || venue === 'shoremarkets') && effectiveDclPoolId) ? undefined : (info.rhea_pool_id ?? undefined);

  if (info.bonding_phase === 'prebonded' && !effectiveRheaPoolId && !effectiveDclPoolId) {
    if (venue !== 'nearlytrade' && venue !== 'shoremarkets' && venue !== 'gaypad' && venue !== 'kelytra' && venue !== 'nearpumpfun') {
      throw new Error('Token is still in its bonding curve phase — wait for it to bond before buying.');
    }
  }

  // Private mode: the buy runs from a pre-funded executor, so this wallet never appears in the trade
  if (PRIVATE_TRADING_ENABLED) {
    const privateAcct = await getConfidentialAccount(user.id).catch(() => null);
    if (privateAcct?.bot_private) {
      onProgress?.('submitting');
      const res = await confidentialBuy({
        user, tokenAddress, venue, amountYocto: BigInt(Math.round(amountNear * 1e6)) * 10n ** 18n,
        slippagePct, poolId: effectiveRheaPoolId ?? undefined, dclPoolId: effectiveDclPoolId,
      });
      if (!res.success) throw new Error(res.reason || 'Private buy failed. Nothing was spent.');
      const symbol = (info as any).symbol || tokenAddress.split('.')[0].toUpperCase();
      return {
        success: true,
        amountNear,
        tokenAddress,
        tokenSymbol: symbol,
        txHash: res.txHashes?.[0],
        message:
          `✅ *Private Buy Confirmed!*\n\n` +
          `🪙 *${sanitizeMd(symbol)}*\n` +
          `💸 Spent: \`${amountNear} NEAR\` from your private pool\n` +
          `🛡 Held in ${res.executors.length} private executor${res.executors.length === 1 ? '' : 's'}: your wallet never appeared in the trade.\n\n` +
          `_Manage it from 🛡 Private in the main menu._`,
      };
    }
  }

  const amountInYocto = nearUtils.format.parseNearAmount(amountNear.toString()) ?? '0';
  const amountInBigInt = BigInt(amountInYocto);

  // Pre-flight balance check: verify wallet retains at least $2.00 in NEAR after swap
  const [nativeBalYoctoStr, wNearBalStr, usdcBalStr] = nearBalRes;
  let usdcUsedFormatted = '';
  let nearPortionFormatted = '';

  if (nativeBalYoctoStr !== null && nativeBalYoctoStr !== undefined) {
    const nativeBal = BigInt(nativeBalYoctoStr);
    const wNearBal = BigInt(wNearBalStr || '0');
    const nearNeededForSwap = amountInBigInt > wNearBal ? amountInBigInt - wNearBal : 0n;

    const effectiveNearUsd = nearUsdVal > 0 ? nearUsdVal : 5.16;
    const minReserveNear = nearNeededForSwap > 0n ? 0.05 : 0.035;
    const minReserveYocto = BigInt(Math.ceil(minReserveNear * 1e24));
    const totalNearRequired = nearNeededForSwap + minReserveYocto;
    const isUsdcOnlyBuy = user.near_trade_currency === 'usdc';

    if (isUsdcOnlyBuy) {
      const usdcRaw = BigInt(usdcBalStr || '0');
      const minGasYocto = BigInt(Math.ceil(0.025 * 1e24));
      const usdcHuman = Number(usdcRaw) / Math.pow(10, NEAR_USDC_DECIMALS);
      const usdcMaxNear = effectiveNearUsd > 0 ? usdcHuman / effectiveNearUsd : 0;
      const usdcMaxNearYocto = BigInt(Math.floor(usdcMaxNear * 1e24));
      let effectiveNativeBal = nativeBal;
      if (effectiveNativeBal < minGasYocto && usdcRaw > 0n && user.subaccount_id) {
        const refueled = await refuelNearGasIfNeeded(user.subaccount_id, effectiveNativeBal).catch(() => false);
        if (refueled) {
          effectiveNativeBal += BigInt(Math.ceil(0.04 * 1e24));
        }
      }
      if (effectiveNativeBal < minGasYocto) {
        throw new Error(`Insufficient NEAR for gas. USDC-Only mode still requires at least 0.025 NEAR (~$0.12) in your wallet for network gas & storage. You currently have ${(Number(effectiveNativeBal) / 1e24).toFixed(4)} NEAR.`);
      }
      if (usdcRaw <= 0n || (usdcMaxNearYocto * 102n) / 100n < amountInBigInt) {
        const neededUsdc = ((Number(amountInBigInt) / 1e24) * effectiveNearUsd).toFixed(2);
        throw new Error(`Insufficient USDC balance (USDC-Only Mode is active). You requested ~${neededUsdc} USDC, but your wallet has ${usdcHuman.toFixed(2)} USDC. Deposit more USDC or switch to NEAR + USDC mode.`);
      }
      const usdcNeeded = Math.min(usdcHuman, ((Number(amountInBigInt) / 1e24) * effectiveNearUsd) / 0.985);
      usdcUsedFormatted = usdcNeeded.toFixed(2);
      nearPortionFormatted = '';
    } else if (nativeBal < totalNearRequired) {
      const usdcRaw = BigInt(usdcBalStr || '0');
      const minGasYocto = BigInt(Math.ceil(0.025 * 1e24));
      let effectiveNativeBal = nativeBal;
      if (effectiveNativeBal < minGasYocto && usdcRaw > 0n && user.subaccount_id) {
        const refueled = await refuelNearGasIfNeeded(user.subaccount_id, effectiveNativeBal).catch(() => false);
        if (refueled) {
          effectiveNativeBal += BigInt(Math.ceil(0.04 * 1e24));
        }
      }
      const spendableNativeYocto = effectiveNativeBal > BigInt(Math.ceil(0.05 * 1e24)) ? effectiveNativeBal - BigInt(Math.ceil(0.05 * 1e24)) : 0n;
      const usdcHuman = Number(usdcRaw) / Math.pow(10, NEAR_USDC_DECIMALS);
      const usdcMaxNear = effectiveNearUsd > 0 ? usdcHuman / effectiveNearUsd : 0;
      const usdcMaxNearYocto = BigInt(Math.floor(usdcMaxNear * 1e24));
      const totalCombinedNearYocto = spendableNativeYocto + wNearBal + usdcMaxNearYocto;

      if (effectiveNativeBal >= minGasYocto && usdcRaw > 0n && totalCombinedNearYocto >= amountInBigInt) {
        const directNearPortionYocto = spendableNativeYocto + wNearBal;
        const shortfallYocto = amountInBigInt > directNearPortionYocto ? amountInBigInt - directNearPortionYocto : 0n;
        const shortfallNear = Number(shortfallYocto) / 1e24;
        const usdcNeeded = Math.min(usdcHuman, (shortfallNear * effectiveNearUsd) / 0.985);
        usdcUsedFormatted = usdcNeeded.toFixed(2);
        const nearPortion = Number(directNearPortionYocto) / 1e24;
        if (nearPortion >= 0.0001) {
          nearPortionFormatted = nearPortion.toFixed(4);
        }
      } else {
        const availNear = (Number(effectiveNativeBal) / 1e24).toFixed(4);
        const availUsd = (Number(effectiveNativeBal) / 1e24 * effectiveNearUsd).toFixed(2);
        const remainingNearYocto = effectiveNativeBal > nearNeededForSwap ? effectiveNativeBal - nearNeededForSwap : 0n;
        const remainingNear = (Number(remainingNearYocto) / 1e24).toFixed(4);
        const remainingUsd = (Number(remainingNearYocto) / 1e24 * effectiveNearUsd).toFixed(2);
        const requiredReserveNearStr = (0.03).toFixed(4);

        throw new Error(
          `Insufficient balance after swap. Your wallet must keep a minimal reserve of ${requiredReserveNearStr} NEAR (~${(0.03 * effectiveNearUsd).toFixed(2)}) to cover gas and account storage. You have ${availUsd} (${availNear} NEAR${usdcHuman > 0 ? ` + ${usdcHuman.toFixed(2)} USDC` : ''}), and would only have ${remainingUsd} (${remainingNear} NEAR) left after this swap. Please reduce your buy amount or deposit more NEAR/USDC.`
        );
      }
    }
  }
  const feeAmountBigInt = (amountInBigInt * 150n) / 10000n;
  const swapAmountYocto = (amountInBigInt - feeAmountBigInt).toString();

  onProgress?.('quote');
  const quoteStartedAt = Date.now();
  const { minAmountOut } = await near.computeMinAmountOut(
    venue,
    'wrap.near',
    tokenAddress,
    swapAmountYocto,   // ← post-fee amount that actually reaches the DEX
    slippagePct,
    effectiveRheaPoolId,
    effectiveDclPoolId
  );
  const quoteCompletedAt = Date.now();

  const swapResult = await publishSwap({
    user_id: user.id,
    token_in: 'wrap.near',
    token_out: tokenAddress,
    amount_in: amountInYocto,
    min_amount_out: minAmountOut,
    venue,
    dcl_pool_id: effectiveDclPoolId,
    pool_id: effectiveRheaPoolId,
    slippage_pct: slippagePct,
    quoted_at: quoteCompletedAt,
    trade_currency: user.near_trade_currency,
  }, onProgress);

  if (swapResult.success === false) {
    throw new Error(swapResult.reason || 'Swap failed on-chain. Please verify slippage settings and balance, then retry.');
  }

  const tokenSym = swapResult.tokenSymbol || tokenAddress.slice(0, 12);
  const tokenName = swapResult.tokenName || tokenSym;
  const tokenQtyHuman = Number(swapResult.tokenQty ?? 0);
  const tokenQtyDisplay = (() => {
    const qty = tokenQtyHuman;
    if (qty >= 1_000_000) return `${(qty / 1_000_000).toFixed(3)}M`;
    if (qty >= 1_000) return qty.toLocaleString('en-US', { maximumFractionDigits: 2 });
    if (qty >= 0.0001) return qty.toFixed(4);
    return qty > 0 ? qty.toExponential(3) : '—';
  })();
  const entryPrice = swapResult.priceNear && swapResult.priceNear > 0 ? swapResult.priceNear : 0;
  const priceDisplay = entryPrice > 0 ? `${entryPrice.toFixed(8)} NEAR` : '—';

  const valueNear = tokenQtyHuman * entryPrice;
  const pnlDisplay = '+0.0%';
  const pnlEmoji = '📈';

  return {
    success: true,
    amountNear,
    tokenAddress,
    positionId: swapResult.positionId,
    tokenName: swapResult.tokenName,
    tokenSymbol: swapResult.tokenSymbol,
    tokenQty: swapResult.tokenQty,
    priceNear: swapResult.priceNear,
    nearSpent: swapResult.nearSpent,
    txHash: swapResult.txHash,
    message:
      `✅ *Buy Confirmed!*\n\n` +
      `🪙 *${sanitizeMd(tokenName)}* (${sanitizeMd(tokenSym)})\n` +
      `📦 Received: \`${tokenQtyDisplay} ${sanitizeMd(tokenSym)}\`\n` +
      `💸 Spent: \`${(swapResult.usdcSpent || usdcUsedFormatted) ? (nearPortionFormatted ? `${nearPortionFormatted} NEAR + ${swapResult.usdcSpent || usdcUsedFormatted} USDC (~${amountNear.toFixed(4)} NEAR)` : `${swapResult.usdcSpent || usdcUsedFormatted} USDC (~${amountNear.toFixed(4)} NEAR)`) : `${amountNear.toFixed(4)} NEAR`}\`\n` +
      `💵 Entry: \`${priceDisplay}\`\n\n` +
      `📊 *Position*\n` +
      `💰 Value: \`${valueNear.toFixed(4)} NEAR\`\n` +
      `${pnlEmoji} PnL: \`${pnlDisplay}\``,
  };
}

// ── Core Helper: Execute Percentage Buy for User ─────────────────────────────
/**
 * HYPE a % buy of a Kleos coin can spend, mirroring how the executor pays: from HyperEVM, keeping back gas, the
 * inbox ticket and an Elysium gas top-up; or from Elysium, which needs a little HyperEVM HYPE to post the order.
 */
export function kleosSpendableHype(hyperevm: number, elysium: number): number {
  const fromHyperevm = hyperevm - 0.003;
  const fromElysium = hyperevm >= 0.0002 ? elysium - 0.0004 : 0;
  return Math.max(0, fromHyperevm, fromElysium);
}

async function executeBuyPctHelper(telegramId: number, rawTokenAddress: string, pct: number, onProgress?: (stage: string) => void) {
  const tokenAddress = resolveTokenAddressFromKey(rawTokenAddress);
  const user = await getUserByTelegramId(telegramId);
  if (!user) throw new Error('Please run /start to set up your wallet first.');

  const info = await getTokenInfo(tokenAddress, false).catch(() => null);
  if (info?.chain === 'solana' || isSolanaToken(tokenAddress)) {
    const solUser = await ensureUserSolanaWallet(user);
    const bal = await getSolanaBalance(solUser.solana_address!, true);
    // Keep 0.005 SOL for network fees and the token account rent.
    const spendable = Math.max(0, lamportsToSol(bal.lamports) - 0.005);
    const amountSol = (spendable * pct) / 100;
    if (amountSol < 0.001) {
      throw new Error(`Available balance (${spendable.toFixed(4)} SOL after fee reserve) is too low to buy.`);
    }
    return executeBuyHelper(telegramId, tokenAddress, Number(amountSol.toFixed(6)), onProgress);
  }
  if (info?.chain === 'starknet' || isStarknetToken(tokenAddress)) {
    const balances = await getUserBalances(telegramId);
    const strkBal = parseFloat(balances.strkBalanceFormatted || '0');
    const amountStrk = (strkBal * pct) / 100;
    if (amountStrk < 0.1) {
      throw new Error(`Available balance (${strkBal.toFixed(4)} STRK) is too low to buy.`);
    }
    return executeBuyHelper(telegramId, tokenAddress, Number(amountStrk.toFixed(4)), onProgress);
  }

  if (info?.chain === 'sui' || info?.venue === 'suipump' || isSuiToken(tokenAddress)) {
    const balanceSui = await getTradeSpendableSui(telegramId);
    const amountSui = (balanceSui * pct) / 100;
    if (amountSui < 0.01) {
      throw new Error(`Available balance (${balanceSui.toFixed(4)} SUI after gas reserve) is too low to buy.`);
    }
    return executeBuyHelper(telegramId, tokenAddress, Number(amountSui.toFixed(4)), onProgress);
  }

  if (info?.chain === 'hyperevm' || info?.chain === 'elysium' || (isValidEvmAddress(tokenAddress) && !tokenAddress.endsWith('.near'))) {
    const evmUser = user.evm_address ? user : await ensureUserEvmWallet(user);
    if (!evmUser.evm_address) throw new Error('Your EVM wallet is not ready yet. Please send /start and try again.');
    const chain: EvmChain = (info?.chain === 'elysium' || tokenAddress.toLowerCase().endsWith('.elysium')) ? 'elysium' : 'hyperevm';
    const isKleos = info?.venue === 'kleos';
    const isTestnet = chain === 'elysium' ? !isKleos : (process.env.HYPEREVM_TESTNET === 'true');
    let spendable: number;
    if (isKleos) {
      // Kleos buys are paid from HyperEVM HYPE, or from Elysium HYPE when the wallet already holds enough there
      const [hyperevmBal, elysiumBal] = await Promise.all([
        getHypeBalance(evmUser.evm_address, 'hyperevm', process.env.HYPEREVM_TESTNET === 'true'),
        getHypeBalance(evmUser.evm_address, 'elysium', false),
      ]);
      spendable = kleosSpendableHype(parseFloat(hyperevmBal.formatted || '0'), parseFloat(elysiumBal.formatted || '0'));
    } else {
      const userBal = await getHypeBalance(evmUser.evm_address, chain, isTestnet);
      spendable = Math.max(0, parseFloat(userBal.formatted || '0') - 0.002);
    }
    const amountHype = (spendable * pct) / 100;
    if (amountHype < 0.001) {
      throw new Error(`Available balance (${spendable.toFixed(4)} HYPE after fee reserve) is too low to buy.`);
    }
    return executeBuyHelper(telegramId, tokenAddress, Number(amountHype.toFixed(6)), onProgress);
  }

  const balanceNear = await getTradeSpendableNear(telegramId);
  const usableBalance = balanceNear;
  const amountNear = (usableBalance * pct) / 100;
  if (amountNear < 0.005) {
    throw new Error(`Available balance (${usableBalance.toFixed(4)} NEAR after gas/storage reserve) is too low to buy.`);
  }
  return executeBuyHelper(telegramId, tokenAddress, Math.floor(amountNear * 10000) / 10000, onProgress);
}

async function buildBuySuccessKeyboard(telegramId: number, tokenAddress: string, tokenSymbol?: string, positionId?: string) {
  const rows: any[] = [];
  if (positionId) {
    rows.push([
      cb('🛡️ Set SL/TP', `sl_tp_menu:${positionId}`, 'primary'),
      cb('📊 View Position', `token_detail:${positionId}`, 'primary'),
    ]);
  }
  try {
    // Bubble Map button disabled to conserve API credits
    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (user) {
      const shareCode = await getOrCreateTokenShare(user.id, tokenAddress);
      const shareDeepLink = `https://t.me/racertradingbot?start=${shareCode}`;
      const sym = tokenSymbol && tokenSymbol !== '???' ? tokenSymbol : 'TOKEN';
      const buyChain = isSolanaToken(tokenAddress) ? 'Solana' : isStarknetToken(tokenAddress) ? 'Starknet' : isSuiToken(tokenAddress) ? 'Sui' : isValidEvmAddress(tokenAddress) ? 'HyperEVM' : 'NEAR';
      const shareText = `Trade $${sym} on RacerBot 🏎\n⚡ Instant 1-click execution on ${buyChain} DEXs`;
      const tgShareUrl = `https://t.me/share/url?url=${encodeURIComponent(shareDeepLink)}&text=${encodeURIComponent(shareText)}`;
      rows.push([Markup.button.url('📤 Share Token (Earn 5% Fees)', tgShareUrl)]);
    }
  } catch (err: any) {
    console.warn('[buildBuySuccessKeyboard] Failed to generate share button:', err?.message);
  }
  rows.push([Markup.button.callback('🔄 Refresh Token Card', `token_refresh:${getShortTokenKey(tokenAddress)}`)]);
  return Markup.inlineKeyboard(rows).reply_markup;
}

async function sendPostBuySlTpPrompt(ctx: Context, positionId?: string, tokenAddress?: string, tokenSymbol?: string) {
  if (!positionId) return;
  try {
    const sym = tokenSymbol && tokenSymbol !== '???' ? tokenSymbol : 'TOKEN';
    const text =
      `🛡️ *Protect your ${sanitizeMd(sym)} position?*\n\n` +
      `Set automatic Stop Loss & Take Profit.\n` +
      `They execute automatically — even while you sleep. 🤖`;

    const keyboard = Markup.inlineKeyboard([
      [
        cb('📉 Set Stop Loss', `sl_prompt:${positionId}`, 'danger'),
        cb('📈 Set Take Profit', `tp_prompt:${positionId}`, 'success'),
      ],
      [
        cb('Skip ⏭️', 'sl_tp_dismiss'),
      ],
    ]);

    await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
  } catch (err: any) {
    console.warn('[sendPostBuySlTpPrompt] Failed to send follow-up prompt:', err?.message);
  }
}



/** What to tell the user when a 0x address did not load as a HyperEVM or Elysium token */
export function evmLookupFailureMessage(address: string, err: any): string {
  const kind = err instanceof EvmTokenLookupError ? err.kind : 'rpc';
  if (kind === 'empty') {
    return `❌ No token at this address\n\n${address}\n\n` +
      `Nothing has been deployed at this address on HyperEVM or Elysium testnet: no contract and no transactions. ` +
      `Check that you copied the token's contract address, not a wallet or pool address.\n\n` +
      `If it is a pre-launch token, its contract may not exist until the launchpad deploys it.`;
  }
  if (kind === 'wallet') {
    return `❌ This is a wallet, not a token\n\n${address}\n\n` +
      `This address has sent transactions but has no contract. Paste the token's contract address instead.`;
  }
  if (kind === 'elysium') {
    return `ℹ️ This token is on Elysium, not HyperEVM\n\n${address}\n\n` +
      `RacerBot cannot trade Elysium tokens yet.`;
  }
  return `⚠️ Could not look up this token right now\n\n${address}\n\n` +
    `HyperEVM did not answer in time. Please try again in a moment.`;
}

// ── Multichain Deposit UI Builders (NEAR Intents 1Click) ────────────────────
export function buildDepositChainPickerMenu(cat: 'popular' | 'evm' | 'alt_l1' | 'other' | 'all' = 'popular') {
  const chains = Object.values(SUPPORTED_CHAINS).filter(c => cat === 'all' || c.category === cat);

  const text =
    `📥 <b>Universal Multi-Chain Deposit (37 Chains)</b>\n\n` +
    `Deposit crypto from <b>37 blockchains</b> directly into your RacerBot NEAR account.\n` +
    `Powered by <b>NEAR Intents (1Click)</b> — funds settle in pure NEAR automatically!\n\n` +
    `• <i>100 bps Platform Fee in NEAR to Treasury</i>\n` +
    `• <i>Automatic Dual-Unwrap to native NEAR on arrival</i>\n\n` +
    `🪙 <b>Select Source Blockchain:</b>`;

  const rows: any[] = [];

  // Category filter chips
  rows.push([
    cb(cat === 'popular' ? '🔥 Popular ✨' : '🔥 Popular', 'dep_cat:popular', cat === 'popular' ? 'success' : 'primary'),
    cb(cat === 'evm' ? '⚡ EVM / L2s ✨' : '⚡ EVM / L2s', 'dep_cat:evm', cat === 'evm' ? 'success' : 'primary'),
  ]);
  rows.push([
    cb(cat === 'alt_l1' ? '🌐 Alt L1s ✨' : '🌐 Alt L1s', 'dep_cat:alt_l1', cat === 'alt_l1' ? 'success' : 'primary'),
    cb(cat === 'all' ? '📋 All (37) ✨' : '📋 All (37)', 'dep_cat:all', cat === 'all' ? 'success' : 'primary'),
  ]);

  // Chains grid (2 per row)
  for (let i = 0; i < chains.length; i += 2) {
    const r: any[] = [];
    const c1 = chains[i];
    r.push(cb(`${c1.icon} ${c1.name}`, `dep_chain:${c1.id}:0`, 'primary'));
    if (i + 1 < chains.length) {
      const c2 = chains[i + 1];
      r.push(cb(`${c2.icon} ${c2.name}`, `dep_chain:${c2.id}:0`, 'primary'));
    }
    rows.push(r);
  }

  // Navigation
  rows.push([
    cb('🔙 Back to Wallet', 'menu_wallet', 'primary'),
    cb('🏠 Main Menu', 'menu_home', 'primary'),
  ]);

  return { text, keyboard: Markup.inlineKeyboard(rows) };
}

export function buildDepositTokenPickerMenu(chainId: string, page = 0) {
  const chain = SUPPORTED_CHAINS[chainId.toLowerCase()];
  if (!chain) return buildDepositChainPickerMenu('popular');

  const tokens = getTokensForChain(chain.id);
  const pageSize = 6;
  const totalPages = Math.max(1, Math.ceil(tokens.length / pageSize));
  const currentPage = Math.max(0, Math.min(page, totalPages - 1));
  const pageTokens = tokens.slice(currentPage * pageSize, (currentPage + 1) * pageSize);

  const text =
    `📥 <b>Deposit from ${chain.icon} ${chain.name}</b>\n\n` +
    `Select the asset you want to deposit into RacerBot:\n` +
    `• Network: <b>${chain.name}</b> (<code>${chain.id.toUpperCase()}</code>)\n` +
    `• Supported Assets: <b>${tokens.length} tokens</b>\n\n` +
    `<i>Tap any token below or enter a custom contract:</i>`;

  const rows: any[] = [];

  // 2 tokens per row (symbol only, no token prices)
  for (let i = 0; i < pageTokens.length; i += 2) {
    const r: any[] = [];
    const t1 = pageTokens[i];
    r.push(cb(`💎 ${t1.symbol}`, `dep_tok:${t1.key}`, 'success'));

    if (i + 1 < pageTokens.length) {
      const t2 = pageTokens[i + 1];
      r.push(cb(`💎 ${t2.symbol}`, `dep_tok:${t2.key}`, 'success'));
    }
    rows.push(r);
  }

  // Pagination row if more than 1 page
  if (totalPages > 1) {
    const navRow: any[] = [];
    if (currentPage > 0) {
      navRow.push(cb('◀️ Prev', `dep_chain:${chain.id}:${currentPage - 1}`, 'primary'));
    }
    navRow.push(cb(`📄 ${currentPage + 1}/${totalPages}`, 'noop', 'primary'));
    if (currentPage < totalPages - 1) {
      navRow.push(cb('Next ▶️', `dep_chain:${chain.id}:${currentPage + 1}`, 'primary'));
    }
    rows.push(navRow);
  }

  // Custom token button
  rows.push([
    cb('✍️ Enter Custom Token CA / Symbol', `dep_custom_tok:${chain.id}`, 'primary'),
  ]);

  // Back button
  rows.push([
    cb('🔙 Back to Chains', 'menu_multichain_deposit', 'primary'),
  ]);

  return { text, keyboard: Markup.inlineKeyboard(rows) };
}

export function buildDepositAmountPickerMenu(tokenKey: string) {
  const token = getTokenByKey(tokenKey);
  if (!token) return buildDepositChainPickerMenu('popular');

  const chain = SUPPORTED_CHAINS[token.blockchain.toLowerCase()];
  const chainName = chain ? `${chain.icon} ${chain.name}` : token.blockchain.toUpperCase();
  const minDeposit = getMinimumDeposit(token);

  const text =
    `💰 <b>Deposit Amount: ${token.symbol}</b>\n\n` +
    `• Network: <b>${chainName}</b>\n` +
    `• ⚡ <b>Lowest Deposit:</b> <code>${minDeposit.formatted}</code>\n` +
    `• <b>1% Platform Fee</b> (settled in NEAR to Treasury)\n` +
    `• Funds convert directly to <b>NEAR</b> in your subaccount\n` +
    `• <b>Dual Auto-Unwrap</b> to native NEAR immediately on arrival!\n\n` +
    `<i>Tap a preset amount below, tap <b>✍️ Enter Custom Amount</b>, or reply with your desired number:</i>`;

  const suggestions = getAmountSuggestions(token, minDeposit.amount);

  const rows: any[] = [
    [
      cb(`${suggestions[0]} ${token.symbol}`, `dep_amt:${token.key}:${suggestions[0]}`, 'primary'),
      cb(`${suggestions[1]} ${token.symbol}`, `dep_amt:${token.key}:${suggestions[1]}`, 'primary'),
      cb(`${suggestions[2]} ${token.symbol}`, `dep_amt:${token.key}:${suggestions[2]}`, 'success'),
    ],
    [
      cb(`${suggestions[3]} ${token.symbol}`, `dep_amt:${token.key}:${suggestions[3]}`, 'primary'),
      cb(`${suggestions[4]} ${token.symbol}`, `dep_amt:${token.key}:${suggestions[4]}`, 'primary'),
      cb(`${suggestions[5]} ${token.symbol}`, `dep_amt:${token.key}:${suggestions[5]}`, 'primary'),
    ],
    [
      cb('✍️ Enter Custom Amount', `dep_custom_amt:${token.key}`, 'success'),
    ],
    [
      cb('🔙 Back to Tokens', `dep_chain:${token.blockchain}:0`, 'primary'),
    ],
  ];

  return { text, keyboard: Markup.inlineKeyboard(rows) };
}

export async function renderDepositQuoteCard(ctx: any, telegramId: number, tokenKey: string, amount: number) {
  const user = await getUserByTelegramId(telegramId);
  if (!user) {
    await ctx.reply('❌ Please run /start first to create your wallet.');
    return;
  }

  const token = getTokenByKey(tokenKey);
  if (!token) {
    await ctx.reply('❌ Selected token expired or not found. Please tap Deposit to start again.');
    return;
  }

  if (PRIVATE_TRADING_ENABLED && isPrivateDeposit(telegramId)) {
    await renderPrivateDepositCard(ctx, user, token, amount);
    return;
  }

  const chain = SUPPORTED_CHAINS[token.blockchain.toLowerCase()];
  const chainName = chain ? `${chain.icon} ${chain.name}` : token.blockchain.toUpperCase();

  const waitMsg = await ctx.reply(`⏳ Generating 1Click Solver deposit route for ${amount} ${token.symbol} from ${chainName}...`);

  try {
    const record = await create1ClickDepositQuote({
      telegramId,
      subaccountId: user.subaccount_id,
      token,
      amount,
    });

    if (waitMsg) await ctx.deleteMessage(waitMsg.message_id).catch(() => { });

    // Generate QR Code PNG
    const qrBuffer = await generateQrBuffer(record.deposit_address);
    const deepLink = generateWalletDeepLink(token.blockchain, record.deposit_address, amount);

    const estNear = record.min_destination_amount ? record.min_destination_amount.toFixed(4) : 'Auto';

    const caption =
      `📥 <b>Multi-Chain Deposit Order Created!</b>\n\n` +
      `⚡ <b>Source:</b> ${chainName} (<code>${amount} ${token.symbol}</code>)\n` +
      `🎯 <b>Recipient:</b> <code>${user.subaccount_id}</code>\n` +
      `💰 <b>Expected Output:</b> ~<b>${estNear} NEAR</b>\n` +
      `💎 <b>Platform Fee:</b> 1.00% (Settled in NEAR to Treasury)\n\n` +
      `📍 <b>Deposit Address (Tap to Copy):</b>\n` +
      `<code>${record.deposit_address}</code>\n\n` +
      `⏱️ <b>Important:</b> Send exactly <code>${amount} ${token.symbol}</code> to the address above. Ensure your wallet does not deduct transfer fees from the sent amount so the full amount arrives!`;

    const buttons: any[] = [];
    if (deepLink && (deepLink.startsWith('https://') || deepLink.startsWith('http://'))) {
      const walletLabel = token.blockchain === 'sol' ? '🟣 Open in Phantom Wallet' : '🦊 Open in Mobile Wallet';
      buttons.push([Markup.button.url(walletLabel, deepLink)]);
    }
    buttons.push([
      cb('🔄 Check Status', `dep_check:${record.deposit_id}`, 'primary'),
      cb('💳 View Wallet', 'menu_wallet', 'success'),
    ]);
    buttons.push([
      cb('📥 New Deposit', 'menu_multichain_deposit', 'primary'),
    ]);

    await ctx.replyWithPhoto({ source: qrBuffer }, {
      caption,
      parse_mode: 'HTML',
      reply_markup: Markup.inlineKeyboard(buttons).reply_markup,
    });
  } catch (err: any) {
    if (waitMsg) await ctx.deleteMessage(waitMsg.message_id).catch(() => { });
    await ctx.reply(`❌ Failed to create deposit quote: ${getUserFriendlyError(err)}`);
  }
}

export function setupRoutes(bot: Telegraf): void {
  // ── Register RaceDrop commands, actions, and wizards ───────────────────────
  setupRaceDropRoutes(bot, userPendingActions);

  // ── NEAR Racer Card: /card and the home-screen button ─────────────────────
  registerRacerCard(bot);

  // ── Critical Group Security & Privacy Guard ──────────────────────────────
  // User wallet details, balances, settings, and trading MUST NEVER appear in public groups.
  // Only claiming of RaceDrop is allowed in public groups.
  bot.use(async (ctx, next) => {
    if (!isGroupChat(ctx)) {
      return next();
    }

    // A. Callback Queries in Groups:
    if (ctx.callbackQuery) {
      const data = (ctx.callbackQuery as any).data || '';
      // Only RaceDrop claim action is allowed to execute in public groups:
      if (typeof data === 'string' && data.startsWith('racedrop_claim_exec:')) {
        return next();
      }

      // Any other button (wallet, trading, settings, pnl, etc.) is strictly blocked in groups:
      const botUsername = getBotUsername(ctx);
      await ctx.answerCbQuery(
        '🔒 Trading and wallet actions are only available in private DM with @' + botUsername,
        {
          show_alert: true,
          url: `https://t.me/${botUsername}?start=menu`,
        }
      ).catch(() => { });
      return;
    }

    // B. Text Messages in Groups:
    if (ctx.message && 'text' in ctx.message) {
      const text = ctx.message.text.trim();

      // Check if message is a command
      if (text.startsWith('/')) {
        const cmd = text.split(' ')[0].toLowerCase().split('@')[0];

        // Allowed group commands:
        // 1. RaceDrop commands (/drop, /racedrop, /redpacket):
        if (cmd === '/racedrop' || cmd === '/drop' || cmd === '/redpacket') {
          return next();
        }

        // 2. Buy Alert commands for community admins (/track, /buyalert, etc.):
        if (cmd === '/track' || cmd === '/buybot' || cmd === '/buyalert' || cmd === '/alerts' || cmd === '/testalert' || cmd === '/testbuy' || cmd === '/setbanner' || cmd === '/banner' || cmd === '/setmedia') {
          return next();
        }

        // 3. /start with drop_<id> allowed for posting a drop into the group:
        if (cmd === '/start') {
          const args = text.split(' ').slice(1);
          if (args[0]?.startsWith('drop_')) {
            return next();
          }
        }

        // ALL other commands (/wallet, /balance, /wallets, /buy, /sell, /holdings, /pnl, /settings, /start, /menu, /newstarknet, etc.):
        // Intercept and redirect to private DM so no sensitive data or trading is shown in public:
        await replyGroupDmRedirect(ctx);
        return;
      }

      // Non-command text in public groups (chat, CA pasting, etc.):
      // Check if it's a RaceDrop ID / link (e.g. drop_<uuid> or uuid):
      const isRaceDropLink = /(?:@\w+\s+)?(?:drop_|racedrop_)?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/i.test(text);
      if (isRaceDropLink) {
        return next();
      }

      // If it's NOT a RaceDrop link, completely ignore!
      // NEVER look up tokens, NEVER show wallet balances, NEVER show "Paste any CA..." guide in groups!
      return;
    }

    return next();
  });

  // ── /start — custodial onboarding with in-chat menu buttons ────────────────
  bot.command('start', async (ctx) => {
    const telegramId = ctx.from!.id;
    const args = ctx.message!.text!.split(' ').slice(1);
    const payload = args[0] || undefined;
    const username = ctx.from!.username || undefined;

    try {
      // ── Helper to decode Telegram start parameters back to NEAR account IDs ──
      const decodeTelegramAccountId = (param: string): string => {
        if (!param) return '';
        if (param.includes('.')) return param;
        if (param.endsWith('_near') || param.endsWith('_tg') || param.endsWith('_testnet')) {
          return param.replace(/_/g, '.');
        }
        return param.replace(/_/g, '.');
      };

      // ── Helper to decode token CA parameters back to contract address ──
      const decodeTokenCaParam = (param: string): string => {
        if (!param) return '';
        let cleaned = param.trim();
        cleaned = cleaned.replace(/^[-_]+/, '');
        if (cleaned.includes('--')) {
          cleaned = cleaned.replace(/--/g, '.');
        } else if (!cleaned.startsWith('0x') && (cleaned.endsWith('_near') || cleaned.endsWith('_tg') || cleaned.endsWith('_testnet'))) {
          cleaned = decodeTelegramAccountId(cleaned);
        }
        return cleaned;
      };

      // ── Deep links: Token share (/start t_XXXX), Copy Trade (/start copy_wallet), or Quick Buy (/start buy_token_amount) ──
      let rawPayload = payload || '';
      let refCode: string | undefined = undefined;
      let customTokenAddress: string | undefined = undefined;

      // Handle RaceDrop claim deep link (/start drop_<drop_id>)
      if (rawPayload.startsWith('drop_')) {
        const dropId = rawPayload.slice(5);
        const isGroup = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
        if (isGroup) {
          await handleRaceDropGroupPost(ctx, dropId);
          return;
        }
        await handleRaceDropClaim(ctx, dropId);
        return;
      }

      // Handle RaceDrop wizard deep link (/start racedrop)
      if (rawPayload === 'racedrop') {
        await startRaceDropWizard(ctx);
        return;
      }

      // Handle WebApp Telegram Handshake deep link (/start auth_<session_id>)
      if (rawPayload.startsWith('auth_')) {
        const sessionId = rawPayload.slice(5);
        const { linkAuthSession } = await import('./authSession.js');
        const linkRes = await linkAuthSession(sessionId, {
          id: telegramId,
          username: ctx.from?.username,
          first_name: ctx.from?.first_name,
        });

        if (linkRes.success) {
          await ctx.reply(
            `🏎️ <b>RacerBot WebApp Connected!</b>\n\n` +
            `✅ <b>Paired Account</b>: <code>@${ctx.from?.username || telegramId}</code>\n` +
            `💳 <b>Trading Subaccount</b>: <code>${linkRes.user?.subaccount_id || 'Ready'}</code>\n\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `⚡ <b>Unified Trading is Live</b>:\n` +
            `• Any NEAR wallet connected on the WebApp automatically syncs here.\n` +
            `• You can execute instant snipes, limit orders, and copy-trades in this chat.\n` +
            `• Visual analytics, bubble maps, and viewing keys remain open on the web.\n\n` +
            `<i>You can now return to your browser window.</i>`,
            {
              parse_mode: 'HTML',
              ...Markup.inlineKeyboard([
                [Markup.button.callback('💳 Manage Wallets', 'wallets_menu'), Markup.button.callback('🏎️ Main Menu', 'menu_home')],
              ]),
            }
          ).catch(() => { });
          return;
        } else {
          await ctx.reply(
            `⚠️ <b>Session Expired or Invalid</b>\n\n` +
            `Please return to the WebApp and tap "Connect Telegram" to generate a fresh link.`,
            { parse_mode: 'HTML' }
          ).catch(() => { });
          return;
        }
      }

      if (rawPayload.includes('_ref_')) {
        const parts = rawPayload.split('_ref_');
        rawPayload = parts[0];
        refCode = parts[1];
      } else if (rawPayload.startsWith('ref_')) {
        const rest = rawPayload.slice(4);
        if (rest.includes('_-')) {
          const idx = rest.indexOf('_-');
          refCode = rest.slice(0, idx);
          customTokenAddress = decodeTokenCaParam(rest.slice(idx + 2));
        } else if (rest.includes('_--')) {
          const idx = rest.indexOf('_--');
          refCode = rest.slice(0, idx);
          customTokenAddress = decodeTokenCaParam(rest.slice(idx + 3));
        } else if (rest.includes('--') && !rest.startsWith('0x')) {
          const firstDashDash = rest.indexOf('--');
          const lastUnderscoreBeforeDash = rest.lastIndexOf('_', firstDashDash);
          if (lastUnderscoreBeforeDash !== -1) {
            refCode = rest.slice(0, lastUnderscoreBeforeDash);
            customTokenAddress = decodeTokenCaParam(rest.slice(lastUnderscoreBeforeDash + 1));
          } else {
            refCode = rest;
          }
        } else {
          refCode = rest;
        }
      }

      const isTokenShare = rawPayload.startsWith('t_');
      // cp_<target id hex>: current copy-share links; copy_<wallet>[_<sharer id>]: older links
      const copyShare = parseCopyShareParam(rawPayload);
      const isCopyShare = copyShare !== null;
      const isBuyParam = rawPayload.startsWith('buy_');
      const isTokenParam = rawPayload.startsWith('token_') || rawPayload.startsWith('tkn_');
      const isBuyAlertCfg = rawPayload.startsWith('cfg_');
      const isGroupSetup = rawPayload.startsWith('setup_group_') || rawPayload.startsWith('setup_');
      const isSetMedia = rawPayload.startsWith('setmedia_') || rawPayload.startsWith('banner_');

      // For standard referral codes we pass the code to onboardUser; for token-share or copy-share
      // codes we pass undefined unless refCode was explicitly passed.
      const accountReferralCode = refCode || ((isTokenShare || isCopyShare || isBuyParam || isTokenParam || isBuyAlertCfg || isGroupSetup || isSetMedia || customTokenAddress) ? undefined : (rawPayload || undefined));

      const result = await onboardUser(telegramId, accountReferralCode, username);

      // Custom Token Referral Deep Link (/start ref_{refCode}_-{CA})
      if (customTokenAddress && (isValidNearAccountId(customTokenAddress) || customTokenAddress.startsWith('0x') || isSolanaAddress(customTokenAddress))) {
        if (refCode) {
          const referrer = await getUserByReferralCode(refCode).catch(() => null);
          if (referrer && referrer.id !== result.userId) {
            try {
              await recordTokenReferral(result.userId, customTokenAddress, referrer.id);
            } catch (e) {
              console.warn('[/start] recordTokenReferral failed (non-fatal):', e);
            }
          }
        }

        try {
          const card = await buildTokenCard(customTokenAddress, telegramId);
          prewarmTradePath(telegramId, customTokenAddress).catch(() => { });
          await sendTokenCard(ctx, card);
          return;
        } catch (cardErr: any) {
          console.warn('[/start] Custom token ref card failed:', cardErr?.message);
        }
      }

      // 0a. Group Buy Alert Setup in DM (/start setup_group_<chat_id> or /start setup_<chat_id>)
      if (isGroupSetup && rawPayload) {
        const targetChatId = rawPayload.replace(/^setup_group_|^setup_/, '');
        try {
          const db = await (await import('@racerbot/db')).getDb();
          const existing = await db.query('SELECT * FROM group_buy_alerts WHERE chat_id = $1 ORDER BY updated_at DESC', [targetChatId]);
          if (existing.rows.length > 0) {
            const row = existing.rows[0];
            const alertRec = {
              id: row.id,
              chat_id: row.chat_id.toString(),
              chat_title: row.chat_title || undefined,
              admin_id: row.admin_id.toString(),
              token_address: row.token_address,
              chain: row.chain || 'near',
              min_buy_usd: parseFloat(row.min_buy_usd || '5.00'),
              emoji: row.emoji || '🏎️',
              emoji_step_usd: parseFloat(row.emoji_step_usd || '5.00'),
              media_file_id: row.media_file_id || undefined,
              media_type: row.media_type || 'default',
              whale_threshold_usd: parseFloat(row.whale_threshold_usd || '200.00'),
              is_active: Boolean(row.is_active),
              created_at: new Date(row.created_at),
              updated_at: new Date(row.updated_at),
            };
            const card = buildAlertSettingsCard(alertRec as any);
            await ctx.reply(
              `🏎️ <b>RacerBot Buy Alerts Already Configured!</b>\n\n` +
              `Here are the settings for your group. You can adjust them anytime below:`,
              { parse_mode: 'HTML', ...card.keyboard }
            );
            return;
          }

          let groupTitle = 'your group';
          try {
            const chatObj: any = await ctx.telegram.getChat(targetChatId);
            if (chatObj?.title) groupTitle = chatObj.title;
          } catch { /* ignore */ }

          userPendingActions.set(telegramId, {
            action: 'set_group_token',
            chatId: targetChatId,
            chatTitle: groupTitle,
            expiresAt: Date.now() + 10 * 60_000,
          });

          await ctx.reply(
            `🏎️ <b>Set Up Buy Alerts for ${escapeHtml(groupTitle)}</b>\n\n` +
            `Please reply with the <b>token contract address</b> you want to track:\n\n` +
            `Examples:\n` +
            `• NEAR: <code>uptober.nearlytrade.near</code>\n` +
            `• NEAR: <code>blackdragon.tkn.near</code>\n` +
            `• SUI: <code>0x2::sui::SUI</code>\n\n` +
            `<i>(Or type /cancel anytime to cancel)</i>`,
            { parse_mode: 'HTML' }
          );
          return;
        } catch (e: any) {
          console.warn('[/start] Failed to initialize group setup:', e?.message);
        }
      }

      // 0b. Set Custom Media Deep Link (/start setmedia_<alert_id> or /start banner_<alert_id>)
      if (isSetMedia && rawPayload) {
        const alertId = rawPayload.replace(/^setmedia_|^banner_/, '');
        try {
          const db = await (await import('@racerbot/db')).getDb();
          const res = await db.query('SELECT * FROM group_buy_alerts WHERE id = $1', [alertId]);
          if (res.rows[0]) {
            const currentAlert = res.rows[0];
            const { buyAlertPendingActions } = await import('./buyAlerts.js');
            buyAlertPendingActions.set(telegramId, {
              adminId: telegramId,
              chatId: currentAlert.chat_id,
              alertId: currentAlert.id,
              type: 'upload_media',
              expiresAt: Date.now() + 10 * 60_000,
            });

            await ctx.reply(
              `🖼️ <b>Upload Custom Banner for ${escapeHtml(currentAlert.chat_title || 'Your Group')}</b>\n\n` +
              `Send any <b>GIF, photo, or short video</b> directly to this chat right now!\n\n` +
              `It will immediately be displayed on all live BUY alerts for your community.\n\n` +
              `<i>(Or send /cancel anytime to cancel)</i>`,
              { parse_mode: 'HTML' }
            );
            return;
          }
        } catch (err: any) {
          console.warn('[/start setmedia] Error:', err?.message);
        }
      }

      // 0c. Buy Alert Group Settings Deep Link (/start cfg_<alert_id>)
      if (isBuyAlertCfg && rawPayload) {
        const alertId = rawPayload.slice(4);
        try {
          const db = await (await import('@racerbot/db')).getDb();
          const res = await db.query('SELECT * FROM group_buy_alerts WHERE id = $1', [alertId]);
          if (res.rows[0]) {
            const row = res.rows[0];
            const alertRec = {
              id: row.id,
              chat_id: row.chat_id.toString(),
              chat_title: row.chat_title || undefined,
              admin_id: row.admin_id.toString(),
              token_address: row.token_address,
              chain: row.chain || 'near',
              min_buy_usd: parseFloat(row.min_buy_usd || '5.00'),
              emoji: row.emoji || '🏎️',
              emoji_step_usd: parseFloat(row.emoji_step_usd || '5.00'),
              media_file_id: row.media_file_id || undefined,
              media_type: row.media_type || 'default',
              whale_threshold_usd: parseFloat(row.whale_threshold_usd || '200.00'),
              is_active: Boolean(row.is_active),
              created_at: new Date(row.created_at),
              updated_at: new Date(row.updated_at),
            };
            const card = buildAlertSettingsCard(alertRec as any);
            await ctx.reply(card.text, { parse_mode: 'HTML', ...card.keyboard });
            return;
          }
        } catch (e: any) {
          console.warn('[/start] Failed to load buy alert config:', e?.message);
        }
      }

      // 1. Quick Buy Deep Link (/start buy_token_near_1 or buy_0x... or buy_token_near)
      if (isBuyParam && rawPayload) {
        const raw = rawPayload.slice(4); // strip 'buy_'
        let tokenRaw = raw;
        let quickBuyAmount: number | null = null;

        const lastIdx = raw.lastIndexOf('_');
        if (lastIdx !== -1) {
          const possibleAmt = parseFloat(raw.slice(lastIdx + 1));
          if (!isNaN(possibleAmt) && possibleAmt > 0) {
            quickBuyAmount = possibleAmt;
            tokenRaw = raw.slice(0, lastIdx);
          }
        }

        const tokenAddress = tokenRaw.startsWith('0x') || isSolanaAddress(tokenRaw) ? tokenRaw : decodeTelegramAccountId(tokenRaw);
        if (tokenAddress && (isValidNearAccountId(tokenAddress) || tokenAddress.startsWith('0x') || isSolanaAddress(tokenAddress))) {
          try {
            const card = await buildTokenCard(tokenAddress, telegramId);
            prewarmTradePath(telegramId, tokenAddress).catch(() => { });
            await sendTokenCard(ctx, card);

            if (quickBuyAmount && isValidNearAccountId(tokenAddress)) {
              const user = await getUserByTelegramId(telegramId);
              const balances = await getUserBalances(telegramId).catch(() => null);
              const spendable = balances ? parseFloat(balances.totalNearFormatted) : 0;

              if (user && spendable >= quickBuyAmount) {
                await ctx.reply(
                  `⚡ *Quick Buy Selected: ${quickBuyAmount} NEAR*\n\n` +
                  `Token: \`${tokenAddress}\`\n` +
                  `Amount: \`${quickBuyAmount} NEAR\`\n` +
                  `Spendable: \`${spendable.toFixed(2)} NEAR\`\n\n` +
                  `Tap *Confirm Buy* below to execute swap immediately on DEX:`,
                  {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                      [
                        cb(`✅ Confirm Buy ${quickBuyAmount} NEAR`, `buy_fixed:${tokenAddress}:${quickBuyAmount}`, 'success'),
                        cb('❌ Cancel', 'menu_home', 'danger'),
                      ]
                    ]),
                  }
                );
              } else if (user) {
                await ctx.reply(
                  `⚠️ *Insufficient Balance for ${quickBuyAmount} NEAR Buy*\n\n` +
                  `Your Balance: \`${spendable.toFixed(2)} NEAR\`\n\n` +
                  `Deposit native NEAR to your trading wallet:\n\`${user.subaccount_id}\``,
                  { parse_mode: 'Markdown' }
                );
              }
            }
            return;
          } catch (cardErr: any) {
            console.warn('[/start] Quick buy card failed:', cardErr?.message);
          }
        }
      }

      // 2. Direct Token Details Deep Link (/start token_0x... or /start token_pearpe_tkn_near)
      if (isTokenParam && rawPayload) {
        const tokenRaw = rawPayload.startsWith('token_') ? rawPayload.slice(6) : rawPayload.slice(4);
        const tokenAddress = tokenRaw.startsWith('0x') || isSolanaAddress(tokenRaw) ? tokenRaw : decodeTelegramAccountId(tokenRaw);
        if (tokenAddress && (isValidNearAccountId(tokenAddress) || tokenAddress.startsWith('0x') || isSolanaAddress(tokenAddress))) {
          try {
            const card = await buildTokenCard(tokenAddress, telegramId);
            prewarmTradePath(telegramId, tokenAddress).catch(() => { });
            await sendTokenCard(ctx, card);
            return;
          } catch (cardErr: any) {
            console.warn('[/start] Token lookup failed:', cardErr?.message);
          }
        }
      }

      // 3. Copy Trading Deep Link (/start cp_<target id>, or older /start copy_<wallet>[_<sharer id>])
      if (copyShare) {
        let targetWallet = '';
        let shareReferrer: string | null = null;
        if (copyShare.kind === 'target') {
          const shared = await getCopyTradeTargetById(copyShare.targetId).catch(() => null);
          if (shared) {
            targetWallet = shared.target_wallet;
            shareReferrer = shared.user_id;
          }
        } else {
          shareReferrer = copyShare.referrerId;
          targetWallet = isSolanaAddress(copyShare.rawWallet) ? copyShare.rawWallet : decodeTelegramAccountId(copyShare.rawWallet);
        }
        if (shareReferrer === result.userId) shareReferrer = null;

        if (targetWallet && (isValidNearAccountId(targetWallet) || isSolanaAddress(targetWallet))) {
          const targets = await getCopyTradeTargetsByUser(result.userId).catch(() => []);
          const activeTargets = targets.filter(t => t.status !== 'stopped');
          if (activeTargets.length >= MAX_COPY_TARGETS_PER_USER) {
            await ctx.reply(`⚠️ Maximum limit of ${MAX_COPY_TARGETS_PER_USER} targets reached. Stop an existing target before adding a new one.`);
            return;
          }
          await ctx.reply(
            `👥 *Copy Trading & Wallet Tracker Invitation*\n\n` +
            `Target wallet: \`${targetWallet}\`\n\n` +
            `Choose how you would like to follow this wallet:\n\n` +
            `• *⚡ Auto-Copy*: Mirror swaps automatically with your configured ${snipeUnit(targetWallet)} budget.\n` +
            `• *👀 Wallet Tracker*: Get real-time alerts whenever this wallet trades, with 1-click manual buy/sell buttons without auto-buying.`,
            {
              parse_mode: 'Markdown',
              ...Markup.inlineKeyboard([
                [cb('⚡ Auto-Copy (Auto Buy/Sell)', copyModeData('copy', targetWallet, shareReferrer), 'success')],
                [cb('👀 Wallet Tracker (Alerts Only)', copyModeData('track', targetWallet, shareReferrer), 'primary')],
                [cb('🔙 Menu', 'menu_copy', 'primary')],
              ]),
            }
          );
          return;
        }
      }

      // 4. Token Share Referral Code (/start t_XXXX or /start t_0x...)
      if (isTokenShare && rawPayload) {
        // Look up the token share record
        const shareRecord = await getTokenShareByCode(rawPayload).catch(() => null);

        if (shareRecord) {
          // Record token referral (no-op on self-referral or duplicate)
          try {
            await recordTokenReferral(result.userId, shareRecord.token_address, shareRecord.referrer_id);
          } catch (e) {
            console.warn('[/start] recordTokenReferral failed (non-fatal):', e);
          }

          // Show the token card directly
          try {
            const card = await buildTokenCard(shareRecord.token_address, telegramId);
            // Prewarm trade path in background
            prewarmTradePath(telegramId, shareRecord.token_address).catch(() => { });
            await sendTokenCard(ctx, card);
            return;
          } catch (cardErr: any) {
            console.warn('[/start] Token share card failed:', cardErr?.message);
          }
        }

        // Direct token key fallback (/start t_0x... or /start t_<key>)
        const tokenKey = rawPayload.slice(2);
        const resolvedAddress = tokenKey.startsWith('0x') ? tokenKey : resolveTokenAddressFromKey(tokenKey) || decodeTelegramAccountId(tokenKey);
        if (resolvedAddress && (isValidNearAccountId(resolvedAddress) || resolvedAddress.startsWith('0x'))) {
          try {
            const card = await buildTokenCard(resolvedAddress, telegramId);
            prewarmTradePath(telegramId, resolvedAddress).catch(() => { });
            await sendTokenCard(ctx, card);
            return;
          } catch (cardErr: any) {
            console.warn('[/start] Token card from key failed:', cardErr?.message);
          }
        }
      }

      // If brand new user onboarding, send a dedicated welcome card showing all provisioned wallets
      if (!result.isExisting) {
        await ctx.reply(
          `🏎️ <b>Welcome to RacerBot!</b>\n\n` +
          `Your high-speed multi-chain trading setup is complete.\n` +
          `All your native trading wallets have been automatically created:\n\n` +
          `⬛ <b>NEAR:</b> <code>${result.subaccountId}</code>\n` +
          `🟣 <b>Solana:</b> <code>${result.solanaAddress || 'Ready'}</code>\n` +
          `⚡ <b>EVM:</b> <code>${result.evmAddress || 'Ready'}</code> (HyperEVM Mainnet & Elysium Testnet)\n` +
          `🔷 <b>Sui:</b> <code>${result.suiAddress || 'Ready'}</code>\n` +
          `✨ <b>Starknet:</b> <code>${result.starknetAddress || 'Ready'}</code>\n\n` +
          `<i>Deposit funds to any address above to trade, or paste any token CA to start sniping!\n(Note: Elysium is on Testnet — Mainnet live soon!)</i>`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
      } else if (result.justUpgraded && result.evmAddress) {
        await ctx.reply(
          `⚡ <b>New Chains Unlocked: HyperEVM & Elysium!</b>\n\n` +
          `Your unified EVM wallet has been generated and linked to your account:\n` +
          `<code>${result.evmAddress}</code>\n\n` +
          `• <b>HyperEVM:</b> 🟢 Mainnet Live — trade real tokens now!\n` +
          `• <b>Elysium:</b> 🟡 Testnet Active — test launchpads now (Mainnet live soon!)\n\n` +
          `Deposit native <b>HYPE</b> to start trading!`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
      }

      const menu = await buildMainMenu(telegramId);
      await ctx.reply(menu.text, { parse_mode: 'HTML', ...menu.keyboard });
    } catch (err: any) {
      console.error('[API] Onboarding error for telegramId:', telegramId, err);
      await ctx.reply(`❌ ${getUserFriendlyError(err)}\n\nPlease try running /start again.`);
    }
  });

  // ── /menu — Open main menu ────────────────────────────────────────────────
  bot.command('menu', async (ctx) => {
    const telegramId = ctx.from!.id;
    try {
      const menu = await buildMainMenu(telegramId);
      await ctx.reply(menu.text, { parse_mode: 'HTML', ...menu.keyboard });
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
    }
  });

  // ── /alpha & /raceralpha — Confidential Social Trading & Viewing Keys ────
  bot.command(['alpha', 'raceralpha'], async (ctx) => {
    const telegramId = ctx.from!.id;
    try {
      const { getAlphaTraders } = await import('./racerAlpha.js');
      const { getUserByTelegramId } = await import('@racerbot/db');
      const user = await getUserByTelegramId(telegramId);
      const traders = await getAlphaTraders(user?.id);

      const topTraders = traders.slice(0, 3);
      const heldCount = traders.filter(t => t.hasKey).length;

      let traderListStr = '';
      topTraders.forEach((t, i) => {
        traderListStr += `<b>${i + 1}. ${t.displayName}</b> (@${t.handle})\n` +
          `   • PnL: <code>+${t.verifiedPnlPct}%</code> | Win: <code>${t.winRatePct}%</code>\n` +
          `   • Key: <code>${t.keyPriceNear} NEAR/mo</code> | Keys Sold: <code>${t.keysSold}/${t.maxKeys}</code>\n`;
      });

      const text =
        `🏎️ <b>RacerAlpha — Confidential Social Trading</b>\n` +
        `<i>Monetize & mirror alpha signals privately off-mempool across NEAR launchpads & Rhea.</i>\n\n` +
        `🏆 <b>Top Verified Traders:</b>\n` +
        traderListStr +
        `\n🔑 <b>Your Active Keys:</b> <code>${heldCount} active</code>\n` +
        `🏛️ <b>Supported Venues:</b> Rhea DEX, NearlyTrade DCL, Meme.Cooking, Shards\n` +
        `⚡ <i>All trades execute privately without mempool frontrunning.</i>`;

      await ctx.reply(text, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🏎️ Open RacerAlpha WebApp', web_app: { url: 'https://raceralpha.xyz/alpha' } }
            ],
            [
              { text: '🔑 My Unlocked Keys', callback_data: 'alpha_my_keys' },
              { text: '« Back to Menu', callback_data: 'menu_home' }
            ]
          ]
        }
      });
    } catch (err: any) {
      await ctx.reply(`❌ Failed to load RacerAlpha: ${err?.message || 'Server error'}`);
    }
  });

  bot.action('alpha_my_keys', async (ctx) => {
    const telegramId = ctx.from!.id;
    try {
      const { getAlphaTraders } = await import('./racerAlpha.js');
      const { getUserByTelegramId } = await import('@racerbot/db');
      const user = await getUserByTelegramId(telegramId);
      const traders = await getAlphaTraders(user?.id);
      const myTraders = traders.filter(t => t.hasKey);

      await ctx.answerCbQuery().catch(() => { });
      if (myTraders.length === 0) {
        await ctx.reply(
          `🔑 <b>No Active Viewing Keys</b>\n\n` +
          `You have not unlocked any Alpha Trader viewing keys yet.\n` +
          `Visit RacerAlpha to subscribe to top traders and decrypt live signals.`,
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🏎️ Explore Marketplace', web_app: { url: 'https://raceralpha.xyz/alpha' } }],
                [{ text: '« Back to Menu', callback_data: 'menu_home' }]
              ]
            }
          }
        );
        return;
      }

      let keysMsg = `🔑 <b>Your Active Viewing Keys (${myTraders.length})</b>\n\n`;
      myTraders.forEach((t, idx) => {
        keysMsg += `<b>${idx + 1}. ${t.displayName}</b> (@${t.handle})\n` +
          `   • PnL: <code>+${t.verifiedPnlPct}%</code> | Win Rate: <code>${t.winRatePct}%</code>\n` +
          `   • Status: <code>Active (Signals Decrypted)</code>\n\n`;
      });

      await ctx.reply(keysMsg, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🏎️ Open WebApp Feed', web_app: { url: 'https://raceralpha.xyz/alpha' } }],
            [{ text: '« Back', callback_data: 'menu_home' }]
          ]
        }
      });
    } catch {
      await ctx.answerCbQuery('Failed to load keys').catch(() => { });
    }
  });

  // ── WebApp Connection Approval & Denial Handlers ───────────────────────────
  bot.action(/^tgauth_approve:(.+)$/, async (ctx) => {
    const requestId = ctx.match[1];
    const telegramId = ctx.from!.id;
    try {
      const { approveTelegramVerification } = await import('./authSession.js');
      const ok = await approveTelegramVerification(requestId, telegramId);
      if (ok) {
        await ctx.answerCbQuery('✅ Connection Approved!').catch(() => { });
        await ctx.editMessageText(
          `✅ <b>WebApp Connection Approved!</b>\n\n` +
          `Your Telegram identity has been safely verified and paired with the RacerBot WebApp.\n\n` +
          `• You can return to your browser to view alpha feeds, copy-trading, and wallet balances.\n` +
          `• Your private keys remain 100% secure.`,
          { parse_mode: 'HTML' }
        ).catch(() => { });
      } else {
        await ctx.answerCbQuery('⚠️ Request expired or invalid').catch(() => { });
        await ctx.editMessageText(
          `⚠️ <b>Connection Request Expired</b>\n\n` +
          `This connection request has expired or does not match this Telegram account.`,
          { parse_mode: 'HTML' }
        ).catch(() => { });
      }
    } catch (err: any) {
      await ctx.answerCbQuery('Error processing approval').catch(() => { });
    }
  });

  bot.action(/^tgauth_deny:(.+)$/, async (ctx) => {
    const requestId = ctx.match[1];
    const telegramId = ctx.from!.id;
    try {
      const { denyTelegramVerification } = await import('./authSession.js');
      await denyTelegramVerification(requestId, telegramId);
      await ctx.answerCbQuery('⛔ Connection Rejected').catch(() => { });
      await ctx.editMessageText(
        `⛔ <b>WebApp Connection Rejected</b>\n\n` +
        `This connection attempt was blocked. No browser session or external wallet was granted access to your account.`,
        { parse_mode: 'HTML' }
      ).catch(() => { });
    } catch (err: any) {
      await ctx.answerCbQuery().catch(() => { });
    }
  });

  // ── Main Menu Actions ─────────────────────────────────────────────────────
  bot.action('menu_home', async (ctx) => {
    const telegramId = ctx.from!.id;
    userPendingActions.delete(telegramId);
    await ctx.answerCbQuery('Main Menu').catch(() => { });
    try {
      const menu = await buildMainMenu(telegramId, false);
      await ctx.editMessageText(menu.text, { parse_mode: 'HTML', ...menu.keyboard }).catch(async () => {
        await ctx.reply(menu.text, { parse_mode: 'HTML', ...menu.keyboard }).catch(() => { });
      });
    } catch {
      // handled
    }
  });

  // ── Buy Alerts Panel ──────────────────────────────────────────────────────
  bot.action('menu_buyalerts', async (ctx) => {
    await ctx.answerCbQuery().catch(() => { });
    const botUsername = ctx.botInfo?.username || 'racertradingbot';
    // ?startgroup= prompts the user to pick a group/channel from their list
    const addToGroupUrl = `https://t.me/${botUsername}?startgroup=setup_buyalerts&admin=post_messages+edit_messages+delete_messages`;
    const addToChannelUrl = `https://t.me/${botUsername}?startchannel=setup_buyalerts&admin=post_messages+edit_messages+delete_messages`;

    const text =
      `📢 <b>Group Buy Alerts</b>\n\n` +
      `Broadcast live buy alerts directly into your Telegram group or channel whenever someone buys a token you're tracking.\n\n` +
      `<b>How to set up:</b>\n` +
      `1️⃣ Tap <b>Add to Group</b> or <b>Add to Channel</b> below.\n` +
      `2️⃣ Pick your group/channel from the list.\n` +
      `3️⃣ Promote RacerBot to <b>Administrator</b> (Send Messages permission).\n` +
      `4️⃣ In your group, type:\n` +
      `   <code>/track &lt;token_contract_address&gt;</code>\n\n` +
      `<b>✨ Group perks:</b>\n` +
      `• High-energy alerts with custom GIFs & emojis\n` +
      `• 🐳 Whale detector on every alert\n` +
      `• 1-tap Buy button on every alert\n` +
      `• <b>Group admins earn 5% fee share</b> on every trade!\n\n` +
      `💡 <i>Preview a token's alert in DM first:</i>\n` +
      `<code>/buyalert &lt;token_address&gt;</code>`;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.url('➕ Add to Group', addToGroupUrl)],
      [Markup.button.url('📣 Add to Channel', addToChannelUrl)],
      [
        cb('⚙️ Settings', 'menu_settings', 'primary'),
        cb('🔙 Main Menu', 'menu_home', 'primary'),
      ],
    ]);

    await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(async () => {
      await ctx.reply(text, { parse_mode: 'HTML', ...keyboard }).catch(() => { });
    });
  });

  bot.action(['menu_refresh', 'menu_home_refresh'], async (ctx) => {
    const telegramId = ctx.from!.id;
    await ctx.answerCbQuery('🔄 Refreshing balance...').catch(() => { });
    try {
      const menu = await buildMainMenu(telegramId, true);
      const canEdit = typeof (ctx as any).editMessageText === 'function';
      if (canEdit) {
        await (ctx as any).editMessageText(menu.text, { parse_mode: 'HTML', ...menu.keyboard }).catch(async (err: any) => {
          if (err?.message?.includes('message is not modified')) return;
          await ctx.reply(menu.text, { parse_mode: 'HTML', ...menu.keyboard }).catch(() => { });
        });
      } else {
        await ctx.reply(menu.text, { parse_mode: 'HTML', ...menu.keyboard }).catch(() => { });
      }
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => { });
    }
  });


  // ── Universal 37-chain deposit routes (NEAR Intents 1Click) ───────────────
  const handleMultichainDeposit = async (ctx: Context) => {
    if (isGroupChat(ctx)) {
      await replyGroupDmRedirect(ctx, 'Multi-chain deposits');
      return;
    }
    const menu = depositChainPicker(ctx.from?.id, 'popular');
    const canEdit = typeof (ctx as any).editMessageText === 'function';
    if (canEdit && ctx.callbackQuery) {
      await (ctx as any).editMessageText(menu.text, { parse_mode: 'HTML', ...menu.keyboard }).catch(async () => {
        await ctx.reply(menu.text, { parse_mode: 'HTML', ...menu.keyboard }).catch(() => { });
      });
    } else {
      await ctx.reply(menu.text, { parse_mode: 'HTML', ...menu.keyboard }).catch(() => { });
    }
  };

  // Direct HYPE deposit: shows user's unified EVM wallet address for HyperEVM & Elysium
  bot.action('dep_evm_direct', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const telegramId = ctx.from!.id;
    try {
      let user = await getUserByTelegramId(telegramId);
      if (!user) {
        await onboardUser(telegramId);
        user = await getUserByTelegramId(telegramId);
      }
      if (!user) throw new Error('Please send /start first.');
      const evmUser = await ensureUserEvmWallet(user);
      await ctx.reply(
        `⚡ <b>Deposit HYPE (HyperEVM & Elysium)</b>\n\n` +
        `Send native <b>HYPE</b> to your unified EVM address:\n\n` +
        `<code>${escapeHtml(evmUser.evm_address || '')}</code>\n\n` +
        `• 🟢 <b>HyperEVM (Chain ID 999):</b> Mainnet live — trade real tokens now.\n` +
        `• 🟡 <b>Elysium (Chain ID 99801):</b> Testnet active — test launchpads now (Mainnet live soon!).\n` +
        `• Tap the address above to copy it.\n` +
        `• Keep at least 0.01 HYPE in your wallet for gas fees.`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.url('🔍 View on HypurrScan', `https://hypurrscan.io/address/${evmUser.evm_address}`)],
            [cb('💳 Wallet', 'menu_wallet', 'primary'), cb('🔙 Back', 'menu_multichain_deposit', 'primary')],
          ]),
        }
      ).catch(() => {});
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => {});
    }
  });

  // Direct SOL deposit: shows the user's own Solana wallet address (no bridge, no conversion).
  bot.action('dep_sol_direct', async (ctx) => {
    await ctx.answerCbQuery().catch(() => { });
    const telegramId = ctx.from!.id;
    try {
      let user = await getUserByTelegramId(telegramId);
      if (!user) {
        await onboardUser(telegramId);
        user = await getUserByTelegramId(telegramId);
      }
      if (!user) throw new Error('Please send /start first.');
      const solUser = await ensureUserSolanaWallet(user);
      markUserActiveForDeposit(telegramId);
      await ctx.reply(
        `◎ <b>Deposit SOL or Solana tokens</b>\n\n` +
        `Send SOL (or any SPL token) on the <b>Solana network</b> to your RacerBot wallet:\n\n` +
        `<code>${escapeHtml(solUser.solana_address || '')}</code>\n\n` +
        `• Tap the address to copy it.\n` +
        `• Only send on Solana. Funds sent on another network can be lost.\n` +
        `• Keep at least 0.01 SOL for network fees and token account rent.`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.url('🔍 View on Solscan', `https://solscan.io/account/${solUser.solana_address}`)],
            [cb('💳 Wallet', 'menu_wallet', 'primary'), cb('🔙 Back', 'menu_multichain_deposit', 'primary')],
          ]),
        }
      ).catch(() => { });
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => { });
    }
  });

  bot.command(['deposit', 'multichain'], handleMultichainDeposit);
  bot.action('menu_multichain_deposit', handleMultichainDeposit);

  bot.action('noop', async (ctx) => {
    await ctx.answerCbQuery().catch(() => { });
  });

  bot.action(/^dep_cat:(popular|evm|alt_l1|other|all)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => { });
    const cat = (ctx as any).match[1] as any;
    const menu = depositChainPicker(ctx.from?.id, cat);
    await (ctx as any).editMessageText(menu.text, { parse_mode: 'HTML', ...menu.keyboard }).catch(async (err: any) => {
      console.warn('[dep_cat] editMessageText fallback:', err?.message);
      await ctx.reply(menu.text, { parse_mode: 'HTML', ...menu.keyboard }).catch(() => { });
    });
  });

  bot.action(/^dep_chain:([a-zA-Z0-9_]+)(?::([0-9]+))?$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => { });
    const chainId = (ctx as any).match[1];
    const page = (ctx as any).match[2] ? parseInt((ctx as any).match[2], 10) : 0;
    const menu = buildDepositTokenPickerMenu(chainId, page);
    await (ctx as any).editMessageText(menu.text, { parse_mode: 'HTML', ...menu.keyboard }).catch(async (err: any) => {
      console.warn('[dep_chain] editMessageText fallback:', err?.message);
      await ctx.reply(menu.text, { parse_mode: 'HTML', ...menu.keyboard }).catch(() => { });
    });
  });

  bot.action(/^dep_tok:([a-zA-Z0-9_]+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => { });
    const tokenKey = (ctx as any).match[1];
    const telegramId = ctx.from!.id;

    // Set pending action immediately so user can either tap preset numbers OR reply directly with their amount
    userPendingActions.set(telegramId, {
      action: 'deposit_custom_amount',
      depositTokenKey: tokenKey,
      expiresAt: Date.now() + 10 * 60_000,
    });

    const menu = buildDepositAmountPickerMenu(tokenKey);
    await (ctx as any).editMessageText(menu.text, { parse_mode: 'HTML', ...menu.keyboard }).catch(async (err: any) => {
      console.warn('[dep_tok] editMessageText fallback:', err?.message);
      await ctx.reply(menu.text, { parse_mode: 'HTML', ...menu.keyboard }).catch(() => { });
    });
  });

  bot.action(/^dep_custom_tok:([a-zA-Z0-9_]+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const chainId = (ctx as any).match[1];
    userPendingActions.set(telegramId, {
      action: 'deposit_custom_token',
      depositChainId: chainId,
      expiresAt: Date.now() + 5 * 60_000,
    });
    await ctx.answerCbQuery().catch(() => { });
    await ctx.reply(
      `✍️ <b>Enter Custom Token for ${chainId.toUpperCase()}</b>\n\n` +
      `Please reply with the token contract address or symbol (e.g. 'USDC' or CA):\n\n` +
      `<i>Type /cancel to abort.</i>`,
      { parse_mode: 'HTML' }
    );
  });

  bot.action(/^dep_amt:([a-zA-Z0-9_]+):([0-9.]+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    await ctx.answerCbQuery().catch(() => { });
    const tokenKey = (ctx as any).match[1];
    const amt = parseFloat((ctx as any).match[2]);
    await renderDepositQuoteCard(ctx, telegramId, tokenKey, amt);
  });

  bot.action(/^dep_custom_amt:([a-zA-Z0-9_]+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const tokenKey = (ctx as any).match[1];
    const token = getTokenByKey(tokenKey);
    const minDeposit = token ? getMinimumDeposit(token) : { amount: 0.01, formatted: '0.01', example: '1.0' };

    userPendingActions.set(telegramId, {
      action: 'deposit_custom_amount',
      depositTokenKey: tokenKey,
      expiresAt: Date.now() + 10 * 60_000,
    });
    await ctx.answerCbQuery().catch(() => { });
    await ctx.reply(
      `✍️ <b>Enter Custom Amount for ${token?.symbol || 'Token'}</b>\n\n` +
      `⚡ <b>Lowest Deposit Amount:</b> <code>${minDeposit.formatted}</code>\n\n` +
      `Please reply with the number of ${token?.symbol || 'tokens'} you wish to deposit (e.g. <code>${minDeposit.example}</code>):\n\n` +
      `<i>Type /cancel to abort.</i>`,
      { parse_mode: 'HTML' }
    );
  });

  bot.action(/^dep_check:(.+)$/, async (ctx) => {
    const depositId = (ctx as any).match[1];
    await ctx.answerCbQuery('Checking deposit on-chain...').catch(() => { });
    try {
      const dep = await getRacerDepositById(depositId);
      if (!dep) {
        await ctx.reply('❌ Deposit record not found.');
        return;
      }
      const check = await check1ClickDepositStatus(dep.deposit_address);
      if (check.status === 'SUCCESS') {
        await updateRacerDeposit(dep.deposit_id, { status: 'SUCCESS', tx_hash: check.txHash, completed_at: new Date() });
        await unwrapUserWrapNear(dep.telegram_id).catch(() => { });
        await ctx.reply(
          `✅ <b>Deposit Confirmed &amp; Settled!</b>\n\n` +
          `Your funds have arrived, settled in NEAR, and have been auto-unwrapped to native NEAR.\n\n` +
          `Ready to trade immediately! 🏎️`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [cb('💳 View Wallet', 'menu_wallet', 'primary'), cb('🏎️ Trade Now', 'menu_holdings', 'success')],
            ]),
          }
        );
      } else if (check.status === 'REFUNDED') {
        await ctx.reply('⏳ Deposit was refunded by solver due to under-funding. Attempting instant recovery...');
        const rec = await recoverIntentRefund(dep.telegram_id, dep.source_asset);
        if (rec.success) {
          await updateRacerDeposit(dep.deposit_id, { status: 'SUCCESS', unwrapped: true, completed_at: new Date() });
          await ctx.reply(
            `🎉 <b>Deposit Recovered &amp; Settled!</b>\n\n` +
            `Your funds have arrived and settled as native NEAR: <b>${rec.unwrappedAmount || '3.96'} Ⓝ</b>\n\n` +
            `Ready to trade! 🏎️`,
            {
              parse_mode: 'HTML',
              ...Markup.inlineKeyboard([
                [cb('💳 View Wallet', 'menu_wallet', 'primary'), cb('🏎️ Trade Now', 'menu_holdings', 'success')],
              ]),
            }
          );
        } else {
          await ctx.reply(
            `⚠️ <b>Deposit Refunded by Solver</b>\n\n` +
            `Your transfer was slightly below the required amount (due to external wallet gas deductions).\n\n` +
            `Your tokens are safely credited on NEAR Intents.\n` +
            `Status: ${check.refundReason || 'Refunded'}`,
            {
              parse_mode: 'HTML',
              ...Markup.inlineKeyboard([
                [cb('🔄 Try Recovery Again', `dep_check:${dep.deposit_id}`, 'primary')],
                [cb('📥 New Deposit', 'menu_multichain_deposit', 'primary')],
              ]),
            }
          );
        }
      } else {
        await ctx.reply(
          `⏳ <b>Deposit Status: ${check.status}</b>\n\n` +
          `Address: <code>${dep.deposit_address}</code>\n\n` +
          `<i>Waiting for payment confirmation on ${dep.source_chain.toUpperCase()} network... Please check again in a few moments.</i>`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [cb('🔄 Check Again', `dep_check:${dep.deposit_id}`, 'primary')],
            ]),
          }
        );
      }
    } catch (err: any) {
      await ctx.reply(`❌ Failed to check status: ${getUserFriendlyError(err)}`);
    }
  });

  bot.action(['menu_wallet', 'wallet', 'open_wallet'], async (ctx) => {
    const telegramId = ctx.from!.id;
    userPendingActions.delete(telegramId);
    await ctx.answerCbQuery().catch(() => { });
    try {
      const wallet = await buildWalletMenu(telegramId);
      const canEdit = typeof (ctx as any).editMessageText === 'function';
      if (canEdit && ctx.callbackQuery) {
        await (ctx as any).editMessageText(wallet.text, { parse_mode: 'HTML', ...wallet.keyboard }).catch(async (err: any) => {
          if (err?.message?.includes('message is not modified')) return;
          await ctx.reply(wallet.text, { parse_mode: 'HTML', ...wallet.keyboard }).catch(() => { });
        });
      } else {
        await ctx.reply(wallet.text, { parse_mode: 'HTML', ...wallet.keyboard }).catch(() => { });
      }
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => { });
    }
  });

  bot.action('menu_settings', async (ctx) => {
    const telegramId = ctx.from!.id;
    userPendingActions.delete(telegramId);
    try {
      const user = await getUserByTelegramId(telegramId);
      if (!user) {
        await ctx.answerCbQuery('Please run /start first.').catch(() => { });
        return;
      }
      const dash = buildSettingsDashboard(user);
      await ctx.answerCbQuery().catch(() => { });
      await ctx.editMessageText(dash.text, { parse_mode: 'Markdown', ...dash.keyboard }).catch(() => { });
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => { });
    }
  });

  bot.action('menu_snipe', async (ctx) => {
    const telegramId = ctx.from!.id;
    try {
      const user = await getUserByTelegramId(telegramId);
      if (!user) {
        await ctx.answerCbQuery('Please run /start first.').catch(() => { });
        return;
      }
      const dash = await buildSnipeDashboard(user);
      await ctx.answerCbQuery().catch(() => { });
      await ctx.editMessageText(dash.text, { parse_mode: 'Markdown', ...dash.keyboard }).catch(() => { });
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => { });
    }
  });

  // ── Copy Trading Actions ──────────────────────────────────────────────────

  registerPrivateActions(bot, {
    setPrompt: (id, action) => userPendingActions.set(id, { action, expiresAt: Date.now() + 5 * 60_000 }),
    lookupRoute: (token) => getFastTokenRoute(token),
    openDepositPicker: (ctx) => handleMultichainDeposit(ctx),
  });

  bot.action('menu_copy', async (ctx) => {
    const telegramId = ctx.from!.id;
    try {
      const user = await getUserByTelegramId(telegramId);
      if (!user) {
        await ctx.answerCbQuery('Please run /start first.').catch(() => { });
        return;
      }
      const dash = await buildCopyTradingDashboard(user);
      await ctx.answerCbQuery().catch(() => { });
      await ctx.editMessageText(dash.text, { parse_mode: 'Markdown', ...dash.keyboard }).catch(async () => {
        await ctx.reply(dash.text, { parse_mode: 'Markdown', ...dash.keyboard }).catch(() => { });
      });
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => { });
    }
  });

  bot.action('copy_add', async (ctx) => {
    const telegramId = ctx.from!.id;
    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) {
      await ctx.answerCbQuery('Please run /start first.').catch(() => { });
      return;
    }
    const targets = await getCopyTradeTargetsByUser(user.id).catch(() => []);
    const activeTargets = targets.filter(t => t.status !== 'stopped');
    if (activeTargets.length >= MAX_COPY_TARGETS_PER_USER) {
      await ctx.answerCbQuery().catch(() => { });
      await ctx.reply(
        `⚠️ *Maximum Targets Reached*\n\n` +
        `You are currently monitoring *${activeTargets.length}/${MAX_COPY_TARGETS_PER_USER}* wallets.\n` +
        `Please stop an existing target before adding a new one.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }
    userPendingActions.set(telegramId, {
      action: 'copy_wallet',
      expiresAt: Date.now() + 5 * 60_000,
    });
    await ctx.answerCbQuery().catch(() => { });
    await ctx.reply(
      `👥 *Add Target Wallet*\n\n` +
      `Enter the wallet address to copy or track:\n` +
      `_e.g. \`trader.near\`, a 64-char hex, or a Solana wallet_\n\n` +
      `In the next step, you can choose *⚡ Auto-Copy* or *👀 Wallet Tracker* mode.`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[cb('🔙 Cancel', 'menu_copy', 'primary')]]),
      }
    );
  });

  bot.action(/^copy_mode:(copy|track):([^:]+)(?::([^:]+))?$/, async (ctx) => {
    const mode = ctx.match![1];
    // Wallet and referrer travel as short keys (t_...) to fit Telegram's 64-byte callback limit
    // (see copyModeData); an unresolved key means the bot restarted since the buttons were sent.
    const isUnresolvedKey = (key: string, resolved: string) => resolved === key && /^t_[0-9a-f]{8}.{4}$/.test(key);
    const walletKey = ctx.match![2];
    const wallet = resolveTokenAddressFromKey(walletKey);
    if (isUnresolvedKey(walletKey, wallet)) {
      await ctx.answerCbQuery('Session expired. Please add the wallet again.').catch(() => { });
      return;
    }
    const referrerKey = ctx.match![3] || '';
    const resolvedReferrer = referrerKey ? resolveTokenAddressFromKey(referrerKey) : '';
    const referrerId = resolvedReferrer && !isUnresolvedKey(referrerKey, resolvedReferrer) ? resolvedReferrer : null;
    const telegramId = ctx.from!.id;

    try {
      const user = await getUserByTelegramId(telegramId);
      if (!user) { await ctx.answerCbQuery('Run /start first.').catch(() => { }); return; }

      const targets = await getCopyTradeTargetsByUser(user.id).catch(() => []);
      const activeTargets = targets.filter(t => t.status !== 'stopped');
      if (activeTargets.length >= MAX_COPY_TARGETS_PER_USER) {
        await ctx.answerCbQuery().catch(() => { });
        await ctx.reply(`⚠️ Maximum limit of ${MAX_COPY_TARGETS_PER_USER} targets reached.`);
        return;
      }

      if (mode === 'track') {
        const target = await createCopyTradeTarget({
          user_id: user.id,
          target_wallet: wallet,
          referrer_id: referrerId,
          buy_amount_near: 0,
          copy_sells: true,
          track_only: true,
          max_slippage_pct: 5.0,
          max_daily_budget_near: null,
        });
        await ctx.answerCbQuery('👀 Wallet Tracker Activated!').catch(() => { });
        await ctx.reply(
          `👀 *Wallet Tracker Activated!*\n\n` +
          `🎯 *Target Wallet*: \`${target.target_wallet}\`\n` +
          `🔔 *Mode*: Wallet Tracker (Alerts Only — No Auto-Buy)\n\n` +
          `RacerBot will monitor all DEX buys and sells from this wallet in real time and send you instant notifications with 1-click manual buy/sell buttons.`,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [cb('👥 View Copy & Tracker List', 'menu_copy', 'primary')],
              [cb('🔙 Menu', 'menu_home', 'primary')],
            ]),
          }
        );
        return;
      }

      // Auto-copy mode: prompt for buy amount
      userPendingActions.set(telegramId, {
        action: 'copy_amount',
        copyWallet: wallet,
        copyReferrerId: referrerId ?? undefined,
        expiresAt: Date.now() + 5 * 60_000,
      });
      await ctx.answerCbQuery().catch(() => { });
      const copyIsSol = isSolanaAddress(wallet);
      if (copyIsSol && !user.solana_address) {
        await ctx.reply('❌ Your Solana wallet is not ready yet. Send /start and try again.');
        return;
      }
      await ctx.reply(
        copyIsSol
          ? `✅ Target wallet: \`${wallet}\` (Solana)\n\n💰 *How much SOL should I spend each time this wallet buys?*\n\n` +
          `Reply with a number (e.g. \`0.2\`):\n_Allowed range: 0.01 – 1,000 SOL_`
          : `✅ Target wallet: \`${wallet}\`\n\n💰 *How much NEAR should I spend each time this wallet buys?*\n\n` +
          `Reply with a number (e.g. \`2\`):\n_Allowed range: 0.1 – 10,000 NEAR_`,
        { parse_mode: 'Markdown' }
      );
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  bot.action(/^copy_mode_toggle:(.+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const targetId = (ctx as any).match[1];
    try {
      const user = await getUserByTelegramId(telegramId);
      if (!user) { await ctx.answerCbQuery('Run /start first.').catch(() => { }); return; }
      const targets = await getCopyTradeTargetsByUser(user.id);
      const target = targets.find(t => t.id === targetId);
      if (!target) { await ctx.answerCbQuery('Target not found.').catch(() => { }); return; }
      const nextTrackOnly = !target.track_only;
      await updateCopyTradeTarget(targetId, { track_only: nextTrackOnly });
      await ctx.answerCbQuery(`Switched to ${nextTrackOnly ? '👀 Wallet Tracker mode' : '⚡ Auto-Copy mode'}`).catch(() => { });
      const dash = await buildCopyTradingDashboard(user);
      await ctx.editMessageText(dash.text, { parse_mode: 'Markdown', ...dash.keyboard }).catch(() => { });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  bot.action(/^copy_toggle:(.+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const targetId = (ctx as any).match[1];
    try {
      const user = await getUserByTelegramId(telegramId);
      if (!user) { await ctx.answerCbQuery('Run /start first.').catch(() => { }); return; }
      const targets = await getCopyTradeTargetsByUser(user.id);
      const target = targets.find(t => t.id === targetId);
      if (!target) { await ctx.answerCbQuery('Target not found.').catch(() => { }); return; }
      const nextStatus = target.status === 'paused' ? 'active' : 'paused';
      await updateCopyTradeTargetStatus(targetId, nextStatus);
      await ctx.answerCbQuery(`Target ${nextStatus === 'active' ? 'resumed' : 'paused'}`).catch(() => { });
      const dash = await buildCopyTradingDashboard(user);
      await ctx.editMessageText(dash.text, { parse_mode: 'Markdown', ...dash.keyboard }).catch(() => { });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  bot.action(/^copy_stop:(.+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const targetId = (ctx as any).match[1];
    try {
      const user = await getUserByTelegramId(telegramId);
      if (!user) { await ctx.answerCbQuery('Run /start first.').catch(() => { }); return; }
      await updateCopyTradeTargetStatus(targetId, 'stopped');
      await ctx.answerCbQuery('Target stopped').catch(() => { });
      const dash = await buildCopyTradingDashboard(user);
      await ctx.editMessageText(dash.text, { parse_mode: 'Markdown', ...dash.keyboard }).catch(() => { });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  bot.action(/^copy_share:(.+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const targetId = (ctx as any).match[1];
    try {
      const user = await getUserByTelegramId(telegramId);
      if (!user) { await ctx.answerCbQuery('Run /start first.').catch(() => { }); return; }
      const targets = await getCopyTradeTargetsByUser(user.id);
      const target = targets.find(t => t.id === targetId);
      if (!target) { await ctx.answerCbQuery('Target not found.').catch(() => { }); return; }
      // The wallet itself cannot travel: Telegram start parameters allow only 64 chars of [A-Za-z0-9_-]
      const shareDeepLink = `https://t.me/racertradingbot?start=${copyShareParam(target.id)}`;
      const shareText = `Copy trades from ${target.target_wallet} on RacerBot 🏎\n⚡ Automated instant execution on NEAR & SUI`;
      const tgShareUrl = `https://t.me/share/url?url=${encodeURIComponent(shareDeepLink)}&text=${encodeURIComponent(shareText)}`;
      await ctx.answerCbQuery().catch(() => { });
      await ctx.reply(
        `📤 *Share Copy Trading Link*\n\n` +
        `Earn *5% of trading bot fees* when others copy trade via your link!\n\n` +
        `🎯 *Target*: \`${target.target_wallet}\`\n` +
        `🔗 *Link*: \`${shareDeepLink}\``,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.url('📤 Share Link (Earn 5% Fees)', tgShareUrl)],
            [cb('🔙 Back to Copy Trading', 'menu_copy', 'primary')],
          ]),
        }
      );
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  // ── DCA Orders Actions ────────────────────────────────────────────────────

  bot.action('menu_dca', async (ctx) => {
    const telegramId = ctx.from!.id;
    try {
      const user = await getUserByTelegramId(telegramId);
      if (!user) {
        await ctx.answerCbQuery('Please run /start first.').catch(() => { });
        return;
      }
      const dash = await buildDcaDashboard(user);
      await ctx.answerCbQuery().catch(() => { });
      await ctx.editMessageText(dash.text, { parse_mode: 'Markdown', ...dash.keyboard }).catch(async () => {
        await ctx.reply(dash.text, { parse_mode: 'Markdown', ...dash.keyboard }).catch(() => { });
      });
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
    }
  });

  bot.action('dca_start', async (ctx) => {
    const telegramId = ctx.from!.id;
    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) {
      await ctx.answerCbQuery('Please run /start first.').catch(() => { });
      return;
    }
    userPendingActions.set(telegramId, {
      action: 'dca_token',
      expiresAt: Date.now() + 5 * 60_000,
    });
    await ctx.answerCbQuery().catch(() => { });
    await ctx.reply(
      `🔁 *DCA Order Setup (Step 1/3)*\n\n` +
      `Enter the token Contract Address (CA):\n` +
      `_e.g. \`token.near\` on NEAR, or a Solana mint address_`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[cb('🔙 Cancel', 'menu_dca', 'primary')]]),
      }
    );
  });

  bot.action(/^dca_token:(.+)$/, async (ctx) => {
    const rawTokenParam = (ctx as any).match[1];
    const tokenCA = resolveTokenAddressFromKey(rawTokenParam);
    const shortKey = getShortTokenKey(tokenCA);
    await ctx.answerCbQuery().catch(() => { });
    const dcaNative = isSolanaToken(tokenCA) ? 'SOL' : 'NEAR';
    await ctx.reply(
      `🪙 *DCA Strategy for \`${tokenCA}\`*\n\n` +
      `Choose a direction:`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [cb(`🟢 Accumulate (Buy with ${dcaNative})`, `dca_choose_side:buy:${shortKey}`, 'success')],
          [cb(`🔴 De-Risk (Sell to ${dcaNative})`, `dca_choose_side:sell:${shortKey}`, 'danger')],
          [cb('🔙 Cancel', 'menu_dca', 'primary')],
        ]),
      }
    );
  });

  bot.action(/^dca_choose_side:(buy|sell):(.+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const side = (ctx as any).match[1] as 'buy' | 'sell';
    const rawTokenParam = (ctx as any).match[2];
    const tokenCA = resolveTokenAddressFromKey(rawTokenParam);
    userPendingActions.set(telegramId, {
      action: 'dca_amount',
      dcaSide: side,
      dcaTokenAddress: tokenCA,
      expiresAt: Date.now() + 5 * 60_000,
    });
    await ctx.answerCbQuery().catch(() => { });
    const isSolDca = isSolanaToken(tokenCA);
    const promptMsg = side === 'buy'
      ? (isSolDca
        ? `💰 *How much SOL should be spent on each order?*\n\nReply with a number (e.g. \`0.1\` or \`0.5\`):`
        : `💰 *How much NEAR should be spent on each order?*\n\nReply with a number (e.g. \`1\` or \`5\`):`)
      : (isSolDca
        ? `💰 *How many tokens should be sold on each order?*\n\nReply with the token amount (e.g. \`250000\`):`
        : `💰 *How many tokens should be sold on each order?*\n\nReply with raw token quantity (e.g. \`1000\`):`);
    await ctx.reply(promptMsg, { parse_mode: 'Markdown' });
  });

  bot.action(/^dca_int_(\d+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const intervalSecs = parseInt((ctx as any).match[1], 10);
    const pending = userPendingActions.get(telegramId);
    if (!pending || pending.action !== 'dca_interval') {
      await ctx.answerCbQuery('Session expired. Please restart DCA setup.').catch(() => { });
      return;
    }
    userPendingActions.set(telegramId, {
      ...pending,
      action: 'dca_orders',
      dcaInterval: intervalSecs,
      expiresAt: Date.now() + 5 * 60_000,
    });
    await ctx.answerCbQuery(`Interval: ${formatDcaInterval(intervalSecs)}`).catch(() => { });
    await ctx.reply(
      `⏱️ *Interval set to ${formatDcaInterval(intervalSecs)}*\n\n` +
      `🔢 *How many orders should be executed?*\n\n` +
      `Reply with the number of orders (e.g. \`10\`), or \`0\` for continuous/unlimited:`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.action(/^dca_toggle:(.+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const orderId = (ctx as any).match[1];
    try {
      const user = await getUserByTelegramId(telegramId);
      if (!user) { await ctx.answerCbQuery('Run /start first.').catch(() => { }); return; }
      const orders = await getDcaOrdersByUser(user.id);
      const order = orders.find(o => o.id === orderId);
      if (!order) { await ctx.answerCbQuery('Order not found.').catch(() => { }); return; }
      const nextStatus = order.status === 'paused' ? 'active' : 'paused';
      await updateDcaOrderStatus(orderId, nextStatus);
      await ctx.answerCbQuery(`DCA order ${nextStatus === 'active' ? 'resumed' : 'paused'}`).catch(() => { });
      const dash = await buildDcaDashboard(user);
      await ctx.editMessageText(dash.text, { parse_mode: 'Markdown', ...dash.keyboard }).catch(() => { });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  bot.action(/^dca_del:(.+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const orderId = (ctx as any).match[1];
    try {
      const user = await getUserByTelegramId(telegramId);
      if (!user) { await ctx.answerCbQuery('Run /start first.').catch(() => { }); return; }
      await updateDcaOrderStatus(orderId, 'cancelled');
      await ctx.answerCbQuery('DCA order cancelled').catch(() => { });
      const dash = await buildDcaDashboard(user);
      await ctx.editMessageText(dash.text, { parse_mode: 'Markdown', ...dash.keyboard }).catch(() => { });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  // ── LIMIT ORDERS ─────────────────────────────────────────────────────────────
  // ────────────────────────────────────────────────────────────────────────────

  // Helper: format a limit order for display
  function formatLimitOrder(o: LimitOrderRecord): string {
    const side = o.side === 'buy' ? '🟢 Buy' : '🔴 Sell';
    const condMap: Record<string, string> = { price: 'Price', mcap: 'Market Cap', percent_offset: '% Offset' };
    const cond = condMap[o.target_type] || o.target_type;
    const dir = o.trigger_condition === 'lte' ? '≤' : '≥';
    const expiry = o.expires_at ? new Date(o.expires_at).toLocaleDateString() : 'GTC';
    const token = o.token_address.length > 20 ? o.token_address.slice(0, 10) + '...' + o.token_address.slice(-6) : o.token_address;
    const targetDisplay = o.target_type === 'percent_offset'
      ? (Number(o.target_value) > 0 ? `+${o.target_value}%` : `${o.target_value}%`)
      : o.target_value;
    return `${side} • ${token}\n` +
      `  Condition: ${cond} ${dir} ${targetDisplay}\n` +
      `  Amount: ${o.amount_input} ${isSolanaToken(o.token_address) ? 'SOL' : 'NEAR'} • Expires: ${expiry}\n` +
      `  Status: ${o.status}`;
  }

  // Step 1: entry point from the token card button
  bot.action(/^lo_start:(.+)$/, async (ctx) => {
    const rawKey = (ctx as any).match[1];
    const tokenCA = resolveTokenAddressFromKey(rawKey);
    const shortKey = getShortTokenKey(tokenCA);
    await ctx.answerCbQuery().catch(() => { });
    await ctx.reply(
      `🎯 *Limit Order — ${tokenCA}*\n\n` +
      `Choose order direction:`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [cb('🟢 Buy (when price dips / breakout)', `lo_side:buy:${shortKey}`, 'success')],
          [cb('🔴 Sell (take profit / stop loss)', `lo_side:sell:${shortKey}`, 'danger')],
          [cb('📋 My Active Orders', `lo_list:${shortKey}`, 'primary')],
          [cb('🔙 Back', `token_refresh:${shortKey}`, 'primary')],
        ]),
      }
    );
  });

  // Step 2: side chosen → pick condition type
  bot.action(/^lo_side:(buy|sell):(.+)$/, async (ctx) => {
    const side = (ctx as any).match[1] as 'buy' | 'sell';
    const rawKey = (ctx as any).match[2];
    const tokenCA = resolveTokenAddressFromKey(rawKey);
    const shortKey = getShortTokenKey(tokenCA);
    const telegramId = ctx.from!.id;
    userPendingActions.set(telegramId, {
      action: 'lo_target_value',
      loTokenAddress: tokenCA,
      loSide: side,
      loConditionType: 'price', // default, overridden by next step
      expiresAt: Date.now() + 5 * 60_000,
    });
    await ctx.answerCbQuery().catch(() => { });
    await ctx.reply(
      `✅ Direction: ${side === 'buy' ? '🟢 Buy' : '🔴 Sell'}\n\n` +
      `📐 *Choose the trigger condition:*`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [cb(`💲 Price (${isSolanaToken(tokenCA) ? 'SOL' : 'NEAR'} per token)`, `lo_cond:price:${shortKey}`, 'primary')],
          [cb('📊 Market Cap (USD)', `lo_cond:market_cap:${shortKey}`, 'primary')],
          [cb('📈 % Change (from current)', `lo_cond:percent_change:${shortKey}`, 'primary')],
          [cb('🔙 Back', `lo_start:${shortKey}`, 'primary')],
        ]),
      }
    );
  });

  // Step 3: condition type chosen → ask for target value
  bot.action(/^lo_cond:(price|market_cap|percent_change):(.+)$/, async (ctx) => {
    const condType = (ctx as any).match[1] as 'price' | 'market_cap' | 'percent_change';
    const rawKey = (ctx as any).match[2];
    const tokenCA = resolveTokenAddressFromKey(rawKey);
    const telegramId = ctx.from!.id;
    const pending = userPendingActions.get(telegramId);
    if (!pending || !pending.loSide) {
      await ctx.answerCbQuery('Session expired. Start again.').catch(() => { });
      return;
    }
    userPendingActions.set(telegramId, {
      ...pending,
      loConditionType: condType,
      expiresAt: Date.now() + 5 * 60_000,
    });
    await ctx.answerCbQuery().catch(() => { });

    const dip = pending.loSide === 'buy' ? 'drops to' : 'rises to';
    const loIsSol = isSolanaToken(tokenCA);
    const condLabels: Record<string, string> = {
      price: loIsSol
        ? 'Reply with the *price in SOL* per token.\n_e.g._ `0.0000004` _means trigger when price ' + dip + ' 0.0000004 SOL_'
        : 'Reply with the *price in NEAR* per token.\n_e.g._ `0.0005` _means trigger when price ' + dip + ' 0.0005 NEAR_',
      market_cap: 'Reply with the *market cap in USD* that should trigger.\n_e.g._ `50000` _for $50k market cap_',
      percent_change: 'Reply with the *% change* from current price.\n_e.g._ `-20` _for -20% dip,_ `+50` _for +50% pump_',
    };
    await ctx.reply(
      `Condition: *${condType === 'price' ? 'Price' : condType === 'market_cap' ? 'Market Cap' : '% Change'}*\n\n` +
      `Enter the trigger value:\n\n${condLabels[condType]}`,
      { parse_mode: 'Markdown' }
    );
  });

  // Step 5: expiry chosen → create order
  bot.action(/^lo_expiry:(24h|3d|7d|gtc):(.+)$/, async (ctx) => {
    const expiryKey = (ctx as any).match[1] as '24h' | '3d' | '7d' | 'gtc';
    const rawKey = (ctx as any).match[2];
    const tokenCA = resolveTokenAddressFromKey(rawKey);
    const telegramId = ctx.from!.id;
    const pending = userPendingActions.get(telegramId);
    if (!pending || !pending.loAmount || !pending.loTargetValue || !pending.loTokenAddress) {
      await ctx.answerCbQuery('Session expired. Start again.').catch(() => { });
      return;
    }
    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) { await ctx.answerCbQuery('Run /start first.').catch(() => { }); return; }

    const expiryDurations: Record<string, number | null> = {
      '24h': 24 * 60 * 60 * 1000,
      '3d': 3 * 24 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000,
      'gtc': null,
    };
    const durationMs = expiryDurations[expiryKey];
    const expiresAt = durationMs !== null ? new Date(Date.now() + durationMs) : null;

    // Resolve current price and mcap for reference and directional determination
    const tokenInfo = await getTokenInfo(pending.loTokenAddress!, false).catch(() => null);
    const loIsSolana = isSolanaToken(pending.loTokenAddress!);
    const currentPrice = tokenInfo?.price ? parseFloat(tokenInfo.price) : 0;
    // Solana orders are evaluated against the USD market cap (what the wizard asks for).
    const currentMcap = loIsSolana
      ? Number((tokenInfo as any)?.market_cap_usd || 0)
      : (tokenInfo as any)?.market_cap ? parseFloat((tokenInfo as any).market_cap) : ((tokenInfo as any)?.marketCap ? parseFloat((tokenInfo as any).marketCap) : 0);

    // Determine condition direction from side + condition type
    let triggerCondition: 'lte' | 'gte' = 'lte';
    if (pending.loConditionType === 'percent_change') {
      // For percent change: positive (+50%) means >= target, negative (-20%) means <= target
      triggerCondition = pending.loTargetValue! < 0 ? 'lte' : 'gte';
    } else if (pending.loConditionType === 'price') {
      if (pending.loSide === 'sell') {
        // Selling: if target > currentPrice it's Take Profit (gte), if target < currentPrice it's Stop Loss (lte)
        triggerCondition = (currentPrice > 0 && pending.loTargetValue! < currentPrice) ? 'lte' : 'gte';
      } else {
        // Buying: if target < currentPrice it's Dip Buy (lte), if target > currentPrice it's Breakout Buy (gte)
        triggerCondition = (currentPrice > 0 && pending.loTargetValue! > currentPrice) ? 'gte' : 'lte';
      }
    } else if (pending.loConditionType === 'market_cap') {
      if (pending.loSide === 'sell') {
        triggerCondition = (currentMcap > 0 && pending.loTargetValue! < currentMcap) ? 'lte' : 'gte';
      } else {
        triggerCondition = (currentMcap > 0 && pending.loTargetValue! > currentMcap) ? 'gte' : 'lte';
      }
    } else {
      triggerCondition = pending.loSide === 'sell' ? 'gte' : 'lte';
    }

    const targetType: 'mcap' | 'price' | 'percent_offset' =
      pending.loConditionType === 'market_cap' ? 'mcap' :
        pending.loConditionType === 'percent_change' ? 'percent_offset' : 'price';

    try {
      await ctx.answerCbQuery('Creating limit order...').catch(() => { });
      const order = await createLimitOrder({
        user_id: user.id,
        token_address: pending.loTokenAddress!,
        chain: loIsSolana ? 'solana' : 'near',
        side: pending.loSide!,
        target_type: targetType,
        trigger_condition: triggerCondition,
        target_value: pending.loTargetValue!,
        reference_price: currentPrice > 0 ? currentPrice : null,
        reference_mcap: currentMcap > 0 ? currentMcap : null,
        amount_input: pending.loAmount!,
        expires_at: expiresAt,
      });
      userPendingActions.delete(telegramId);

      const expiryLabel = expiryKey === 'gtc' ? '🔁 GTC (Never expires)' : `${expiryKey === '24h' ? '24 Hours' : expiryKey === '3d' ? '3 Days' : '7 Days'}`;
      const condLabel = order.target_type === 'price' ? 'Price' : order.target_type === 'mcap' ? 'Market Cap' : '% Offset';
      const dirLabel = order.trigger_condition === 'lte' ? '≤' : '≥';
      const targetValDisplay = order.target_type === 'percent_offset'
        ? (Number(order.target_value) > 0 ? `+${order.target_value}%` : `${order.target_value}%`)
        : order.target_value;

      await ctx.reply(
        `✅ *Limit Order Created!*\n\n` +
        `🪙 *Token*: \`${order.token_address}\`\n` +
        `📊 *Direction*: ${order.side === 'buy' ? '🟢 Buy' : '🔴 Sell'}\n` +
        `📐 *Trigger*: ${condLabel} ${dirLabel} \`${targetValDisplay}\`\n` +
        `💰 *Amount*: \`${order.amount_input} ${loIsSolana ? 'SOL' : 'NEAR'}\`\n` +
        `⏰ *Expires*: ${expiryLabel}\n\n` +
        `RacerBot polls prices every 4 seconds. You'll get a DM when triggered.`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [cb('📋 My Limit Orders', `lo_list:${getShortTokenKey(order.token_address)}`, 'primary'), cb('🔙 Menu', 'menu_home', 'primary')],
          ]),
        }
      );
    } catch (err: any) {
      await ctx.answerCbQuery('').catch(() => { });
      await ctx.reply(`❌ Failed to create limit order: ${getUserFriendlyError(err)}`);
    }
  });

  // List active limit orders for a token (or all if no shortKey context)
  async function renderUserLimitOrders(ctx: any, telegramId: number) {
    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) {
      if (typeof ctx.answerCbQuery === 'function') await ctx.answerCbQuery('Run /start first.').catch(() => { });
      else await ctx.reply('Run /start first.').catch(() => { });
      return;
    }
    if (typeof ctx.answerCbQuery === 'function') await ctx.answerCbQuery().catch(() => { });

    const orders = await getLimitOrdersByUser(user.id).catch(() => [] as LimitOrderRecord[]);
    const active = orders.filter(o => o.status === 'active');

    if (active.length === 0) {
      await ctx.reply(
        `📋 *Your Limit Orders*\n\nNo active limit orders. Set one up from any token card!`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[cb('🔙 Back', 'menu_home', 'primary')]]),
        }
      );
      return;
    }

    let text = `📋 *Active Limit Orders* (${active.length}):\n\n`;
    const buttons: any[] = [];
    active.slice(0, 10).forEach((o, i) => {
      const side = o.side === 'buy' ? '🟢' : '🔴';
      const cond = o.target_type === 'price' ? 'Price' : o.target_type === 'mcap' ? 'MC' : '%';
      const dir = o.trigger_condition === 'lte' ? '≤' : '≥';
      const token = o.token_address.length > 20 ? o.token_address.slice(0, 8) + '…' : o.token_address;
      const expiry = o.expires_at ? new Date(o.expires_at).toLocaleDateString() : 'GTC';
      text += `${i + 1}. ${side} \`${token}\`\n   ${cond} ${dir} \`${o.target_value}\` • \`${o.amount_input} ${isSolanaToken(o.token_address) ? 'SOL' : 'NEAR'}\` • ${expiry}\n\n`;
      buttons.push([cb(`❌ Cancel #${i + 1} (${side} ${token})`, `lo_cancel:${o.id}`, 'danger')]);
    });
    buttons.push([cb('🔙 Back', 'menu_home', 'primary')]);

    await ctx.reply(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });
  }

  // List active limit orders
  bot.action(['menu_lo', 'lo_list', /^lo_list(?::(.+))?$/], async (ctx) => {
    await renderUserLimitOrders(ctx, ctx.from!.id);
  });
  bot.command(['limitorders', 'orders'], async (ctx) => {
    await renderUserLimitOrders(ctx, ctx.from!.id);
  });

  // Cancel a specific limit order
  bot.action(/^lo_cancel:(.+)$/, async (ctx) => {
    const orderId = (ctx as any).match[1];
    const telegramId = ctx.from!.id;
    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) { await ctx.answerCbQuery('Run /start first.').catch(() => { }); return; }
    try {
      await cancelLimitOrder(orderId, user.id);
      await ctx.answerCbQuery('✅ Limit order cancelled.').catch(() => { });
      const orders = await getLimitOrdersByUser(user.id).catch(() => [] as LimitOrderRecord[]);
      const active = orders.filter(o => o.status === 'active');
      if (active.length === 0) {
        await ctx.editMessageText('📋 *Your Limit Orders*\n\nNo active limit orders.', {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[cb('🔙 Back', 'menu_home', 'primary')]]).reply_markup,
        } as any).catch(() => { });
      } else {
        await ctx.answerCbQuery('Order cancelled — refresh list.').catch(() => { });
      }
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  // ── RaceFleet (Multi-Wallet Engine) Routes ─────────────────────────────────

  bot.command('fleet', async (ctx) => {
    const telegramId = ctx.from!.id;
    try {
      const dashboard = await buildRaceFleetDashboard(telegramId);
      await ctx.reply(dashboard.text, {
        parse_mode: 'HTML',
        ...dashboard.keyboard,
      });
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
    }
  });

  bot.action('racefleet_menu', async (ctx) => {
    await ctx.answerCbQuery().catch(() => { });
    const telegramId = ctx.from!.id;
    try {
      const dashboard = await buildRaceFleetDashboard(telegramId);
      await ctx.editMessageText(dashboard.text, {
        parse_mode: 'HTML',
        ...dashboard.keyboard,
      } as any).catch(async () => {
        await ctx.reply(dashboard.text, {
          parse_mode: 'HTML',
          ...dashboard.keyboard,
        });
      });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  bot.action(['fleet_holdings', 'fleet_holdings_refresh'], async (ctx) => {
    const isRefresh = (ctx as any).callbackQuery?.data === 'fleet_holdings_refresh';
    await ctx.answerCbQuery(isRefresh ? 'Refreshing Fleet Holdings & PnL...' : undefined).catch(() => { });
    const telegramId = ctx.from!.id;
    try {
      const view = await buildFleetHoldingsView(telegramId, isRefresh);
      await ctx.editMessageText(view.text, {
        parse_mode: 'HTML',
        ...view.keyboard,
      } as any).catch(async () => {
        await ctx.reply(view.text, {
          parse_mode: 'HTML',
          ...view.keyboard,
        });
      });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  bot.command('fleetholdings', async (ctx) => {
    const telegramId = ctx.from!.id;
    try {
      const view = await buildFleetHoldingsView(telegramId);
      await ctx.reply(view.text, {
        parse_mode: 'HTML',
        ...view.keyboard,
      });
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => { });
    }
  });

  bot.action(/^fleet_deploy:(\d+)$/, async (ctx) => {
    const count = parseInt((ctx as any).match[1], 10) || 10;
    const telegramId = ctx.from!.id;
    await ctx.answerCbQuery(`Deploying ${count} fleet wallets on NEAR...`).catch(() => { });
    const loadingMsg = await ctx.reply(`⏳ <b>Deploying RaceFleet (${count} Wallets)...</b>\n\n• Deducting 2 NEAR subscription fee\n• Initializing named subaccounts on NEAR mainnet\n• Generating cryptographic access keys\n\n<i>This takes ~3–5 seconds...</i>`, { parse_mode: 'HTML' });

    try {
      const res = await deployRaceFleet(telegramId, count);
      if (loadingMsg) await ctx.deleteMessage(loadingMsg.message_id).catch(() => { });

      if (res.success && res.fleet) {
        await ctx.reply(
          `🚀 <b>RaceFleet Successfully Deployed!</b>\n\n` +
          `🏷 <b>Fleet Tag</b>: <code>${res.fleet.fleet_tag}</code>\n` +
          `📦 <b>Fleet Size</b>: <b>${res.fleet.wallet_count} Named Wallets</b>\n` +
          `📅 <b>Active Until</b>: ${new Date(res.fleet.expires_at).toLocaleDateString()}\n\n` +
          `💡 <i>Next step: Tap <b>[📥 Distribute from Main]</b> to disburse NEAR into your fleet wallets so they can start bundle trading.</i>`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('📥 Distribute from Main', 'fleet_fund_prompt')],
              [Markup.button.callback('🏎️ Open Fleet Dashboard', 'racefleet_menu')],
            ]),
          }
        );
      } else {
        await ctx.reply(`❌ <b>Deployment Failed:</b>\n\n${res.reason || 'Unknown error'}`, { parse_mode: 'HTML' });
      }
    } catch (err: any) {
      if (loadingMsg) await ctx.deleteMessage(loadingMsg.message_id).catch(() => { });
      await ctx.reply(`❌ Deployment error: ${getUserFriendlyError(err)}`);
    }
  });

  bot.action(/^fleet_cockpit:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => { });
    const shortKey = (ctx as any).match[1];
    const tokenAddress = resolveTokenAddressFromKey(shortKey);
    const telegramId = ctx.from!.id;

    if (!tokenAddress) {
      return;
    }

    try {
      const cockpit = await buildFleetCockpit(telegramId, tokenAddress);
      await ctx.editMessageText(cockpit.text, {
        parse_mode: 'HTML',
        ...cockpit.keyboard,
      } as any).catch(async () => {
        await ctx.reply(cockpit.text, {
          parse_mode: 'HTML',
          ...cockpit.keyboard,
        });
      });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  bot.action(/^fleet_buy_amt:(.+):(.+)$/, async (ctx) => {
    const shortKey = (ctx as any).match[1];
    const amtStr = (ctx as any).match[2];
    const amt = parseFloat(amtStr);
    const tokenAddress = resolveTokenAddressFromKey(shortKey);
    const telegramId = ctx.from!.id;

    if (!tokenAddress || isNaN(amt) || amt <= 0) {
      await ctx.answerCbQuery('Invalid buy parameters').catch(() => { });
      return;
    }

    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) { await ctx.answerCbQuery('Run /start first.').catch(() => { }); return; }
    const fleet = await getRaceFleetByUserId(user.id);
    if (!fleet) { await ctx.answerCbQuery('No active RaceFleet').catch(() => { }); return; }

    const fUnit = snipeUnit(tokenAddress);
    await ctx.answerCbQuery(`Firing bundle buy across ${fleet.wallet_count} wallets...`).catch(() => { });
    const executingMsg = await ctx.reply(`🏎️ <b>Firing Coordinated Bundle Buy...</b>\n\nSpending <b>${amt} ${fUnit} per wallet</b> across ${fleet.wallet_count} fleet wallets.\n<i>Broadcasting parallel on-chain transactions...</i>`, { parse_mode: 'HTML' });

    try {
      const res = await executeFleetBundleBuy(fleet.id, tokenAddress, amt, 3.0);
      if (executingMsg) await ctx.deleteMessage(executingMsg.message_id).catch(() => { });

      if (res.success) {
        await ctx.reply(
          `✅ <b>RaceFleet Bundle Buy Executed!</b>\n\n` +
          `🪙 <b>Token</b>: <code>${tokenAddress}</code>\n` +
          `📦 <b>Successful Swaps</b>: <b>${res.successCount}/${fleet.wallet_count} Wallets</b>\n` +
          `💰 <b>Total Spent</b>: <b>${res.totalSpentNear} ${fUnit}</b> (~${amt} ${fUnit} / wallet)\n` +
          (res.failCount > 0 ? `⚠️ <b>Failed</b>: ${res.failCount} wallets (insufficient balance or slippage)\n\n` : '\n') +
          `<i>All transactions signed with independent keys and broadcast in parallel.</i>`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('📊 Fleet Holdings & PnL', 'fleet_holdings'), Markup.button.callback('🏎️ Back to Cockpit', `fleet_cockpit:${shortKey}`)],
              [Markup.button.callback('🔴 Fleet SELL', `fleet_sell_prompt:${shortKey}`)],
              [Markup.button.callback('🏎️ Fleet Dashboard', 'racefleet_menu'), Markup.button.callback('🔙 Main Menu', 'menu_home')],
            ]),
          }
        );
      } else {
        await ctx.reply(`❌ <b>Bundle Buy Failed:</b>\n\n${res.errors[0] || 'Unknown error'}`, { parse_mode: 'HTML' });
      }
    } catch (err: any) {
      if (executingMsg) await ctx.deleteMessage(executingMsg.message_id).catch(() => { });
      await ctx.reply(`❌ Execution error: ${getUserFriendlyError(err)}`);
    }
  });

  // ── Single Fleet BUY / Fleet SELL buttons: ask once, then every wallet fires at the same instant ──

  bot.action(/^fleet_buy_prompt:(.+)$/, async (ctx) => {
    const shortKey = (ctx as any).match[1];
    const tokenAddress = resolveTokenAddressFromKey(shortKey);
    const telegramId = ctx.from!.id;
    await ctx.answerCbQuery().catch(() => { });
    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user || !tokenAddress) return;
    const fleet = await getRaceFleetByUserId(user.id).catch(() => null);
    if (!fleet) {
      const promo = buildFleetPromoCard();
      await ctx.reply(promo.text, { parse_mode: 'HTML', ...promo.keyboard } as any).catch(() => { });
      return;
    }
    userPendingActions.set(telegramId, { action: 'fleet_custom_buy', fleetTokenAddress: tokenAddress, expiresAt: Date.now() + 180_000 });
    const isSol = isSolanaAddress(tokenAddress);
    await ctx.reply(
      `🟢 <b>Fleet BUY</b> — <code>${tokenAddress}</code>\n\n` +
      `Reply with the amount of <b>${isSol ? 'SOL' : 'NEAR'} per wallet</b> (e.g. <code>${isSol ? '0.1' : '1'}</code>).\n` +
      `All ${fleet.wallet_count} fleet wallets buy at the same moment.\n\n` +
      `<i>Type /cancel to abort.</i>`,
      { parse_mode: 'HTML' }
    ).catch(() => { });
  });

  bot.action(/^fleet_sell_prompt:(.+)$/, async (ctx) => {
    const shortKey = (ctx as any).match[1];
    const tokenAddress = resolveTokenAddressFromKey(shortKey);
    const telegramId = ctx.from!.id;
    await ctx.answerCbQuery().catch(() => { });
    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user || !tokenAddress) return;
    const fleet = await getRaceFleetByUserId(user.id).catch(() => null);
    if (!fleet) {
      await ctx.reply('❌ No RaceFleet found.').catch(() => { });
      return;
    }
    userPendingActions.set(telegramId, { action: 'fleet_sell_pct', fleetTokenAddress: tokenAddress, expiresAt: Date.now() + 180_000 });
    await ctx.reply(
      `🔴 <b>Fleet SELL</b> — <code>${tokenAddress}</code>\n\n` +
      `Reply with the <b>percent</b> of the fleet's holdings to sell (1 to 100). <code>100</code> sells everything.\n` +
      `Every fleet wallet sells at the same moment.\n\n` +
      `<i>Type /cancel to abort.</i>`,
      { parse_mode: 'HTML' }
    ).catch(() => { });
  });

  bot.action(/^fleet_custom_buy:(.+)$/, async (ctx) => {
    const shortKey = (ctx as any).match[1];
    const tokenAddress = resolveTokenAddressFromKey(shortKey);
    const telegramId = ctx.from!.id;

    if (!tokenAddress) {
      await ctx.answerCbQuery('Token address not found').catch(() => { });
      return;
    }

    userPendingActions.set(telegramId, {
      action: 'fleet_custom_buy',
      fleetTokenAddress: tokenAddress,
      expiresAt: Date.now() + 180_000,
    });

    await ctx.reply(
      `🏎️ <b>Custom Fleet Buy for</b> <code>${tokenAddress}</code>\n\n` +
      (isSolanaAddress(tokenAddress)
        ? `Reply with the amount in SOL to spend <b>per wallet</b> (e.g. <code>0.05</code> or <code>0.2</code>):\n\n`
        : `Reply with the amount in NEAR to spend <b>per wallet</b> (e.g. <code>0.75</code> or <code>3.5</code>):\n\n`) +
      `<i>Type /cancel to abort.</i>`,
      { parse_mode: 'HTML' }
    );
  });

  bot.action(/^fleet_split_buy:(.+)$/, async (ctx) => {
    const shortKey = (ctx as any).match[1];
    const tokenAddress = resolveTokenAddressFromKey(shortKey);
    const telegramId = ctx.from!.id;

    if (!tokenAddress) {
      await ctx.answerCbQuery('Token address not found').catch(() => { });
      return;
    }

    userPendingActions.set(telegramId, {
      action: 'fleet_split_buy',
      fleetTokenAddress: tokenAddress,
      expiresAt: Date.now() + 180_000,
    });

    await ctx.reply(
      `➗ <b>Split Total Budget for</b> <code>${tokenAddress}</code>\n\n` +
      `Reply with the <b>total ${snipeUnit(tokenAddress)}</b> you want to spend across your entire fleet (e.g. <code>${isSolanaAddress(tokenAddress) ? '1' : '20'}</code>):\n` +
      `<i>The bot will automatically divide it equally among all your active fleet wallets.</i>\n\n` +
      `<i>Type /cancel to abort.</i>`,
      { parse_mode: 'HTML' }
    );
  });

  bot.action(/^fleet_snipe_protect:(.+)$/, async (ctx) => {
    const shortKey = (ctx as any).match[1];
    const tokenAddress = resolveTokenAddressFromKey(shortKey);
    const telegramId = ctx.from!.id;

    if (!tokenAddress) {
      await ctx.answerCbQuery('Token not found').catch(() => { });
      return;
    }

    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) return;
    const fleet = await getRaceFleetByUserId(user.id);
    if (!fleet) return;

    const spUnit = snipeUnit(tokenAddress);
    const spAmt = spUnit === 'SOL' ? 0.1 : 1.0;
    await ctx.answerCbQuery(`Executing Protected Fleet Snipe (${spAmt} ${spUnit} each + 50% TP / 15% SL)...`).catch(() => { });
    const loadingMsg = await ctx.reply(`🏎️ <b>Executing Protected Fleet Snipe...</b>\n\n1. Buying ${spAmt} ${spUnit} per wallet across ${fleet.wallet_count} wallets\n2. Attaching automated +50% Take Profit\n3. Attaching automated -15% Stop Loss`, { parse_mode: 'HTML' });

    try {
      const buyRes = await executeFleetBundleBuy(fleet.id, tokenAddress, spAmt, 3.0);
      if (loadingMsg) await ctx.deleteMessage(loadingMsg.message_id).catch(() => { });

      if (buyRes.success) {
        // TP/SL is measured from the entry price, so it must be stored (target_value);
        // without it the trigger engine can never fire the order.
        const entryInfo = await getTokenInfo(tokenAddress, true).catch(() => null);
        const entryPrice = entryInfo?.price ? parseFloat(String(entryInfo.price)) : 0;
        await createRaceFleetOrder({
          fleet_id: fleet.id,
          user_id: user.id,
          token_address: tokenAddress,
          order_type: 'tp_sl',
          sl_percent: 15.0,
          tp_percent: 50.0,
          sell_pct: 100,
          ...(entryPrice > 0 ? { target_value: entryPrice } : {}),
        }).catch((err) => console.warn('Failed to record fleet TP/SL order:', err?.message));

        await ctx.reply(
          `🛡️ <b>Protected Fleet Position Opened!</b>\n\n` +
          `🪙 <b>Token</b>: <code>${tokenAddress}</code>\n` +
          `📦 <b>Filled</b>: <b>${buyRes.successCount}/${fleet.wallet_count} Wallets</b>\n` +
          `💰 <b>Total Spent</b>: <b>${buyRes.totalSpentNear} ${spUnit}</b>\n\n` +
          `🎯 <b>Active Protection Guard:</b>\n` +
          `• <b>Take Profit</b>: +50% (Sells 100% across fleet)\n` +
          `• <b>Stop Loss</b>: -15% (Emergency exit across fleet)\n\n` +
          `<i>RacerBot's real-time engine will trigger automatically on price crossing.</i>`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('🏎️ Fleet Cockpit', `fleet_cockpit:${shortKey}`)],
              [Markup.button.callback('🔙 Fleet Menu', 'racefleet_menu')],
            ]),
          }
        );
      } else {
        await ctx.reply(`❌ Snipe failed: ${buyRes.errors[0] || 'Unknown error'}`);
      }
    } catch (err: any) {
      if (loadingMsg) await ctx.deleteMessage(loadingMsg.message_id).catch(() => { });
      await ctx.reply(`❌ Error: ${getUserFriendlyError(err)}`);
    }
  });

  bot.action(/^fleet_sell:(.+):(\d+)$/, async (ctx) => {
    const shortKey = (ctx as any).match[1];
    const pct = parseInt((ctx as any).match[2], 10) || 100;
    const tokenAddress = resolveTokenAddressFromKey(shortKey);
    const telegramId = ctx.from!.id;

    if (!tokenAddress) {
      await ctx.answerCbQuery('Token address not found').catch(() => { });
      return;
    }

    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) return;
    const fleet = await getRaceFleetByUserId(user.id);
    if (!fleet) return;

    await ctx.answerCbQuery(`Selling ${pct}% across all ${fleet.wallet_count} fleet wallets...`).catch(() => { });
    const statusMsg = await ctx.reply(`🔴 <b>Executing Coordinated Bundle Sell (${pct}%)...</b>\n\n<i>Swapping tokens back to ${snipeUnit(tokenAddress)} in parallel...</i>`, { parse_mode: 'HTML' });

    try {
      const res = await executeFleetBundleSell(fleet.id, tokenAddress, pct, 3.0);
      if (statusMsg) await ctx.deleteMessage(statusMsg.message_id).catch(() => { });

      if (res.success) {
        await ctx.reply(
          `✅ <b>RaceFleet Bundle Sell Complete!</b>\n\n` +
          `🪙 <b>Token</b>: <code>${tokenAddress}</code>\n` +
          `📊 <b>Sold</b>: <b>${pct}%</b> across <b>${res.successCount}/${fleet.wallet_count} Wallets</b>\n\n` +
          `All proceeds returned to their respective fleet wallets.`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('📤 Sweep Funds to Main Wallet', isSolanaAddress(tokenAddress) ? 'fleet_sweep_sol' : 'fleet_sweep_prompt')],
              [Markup.button.callback('🏎️ Back to Fleet Cockpit', `fleet_cockpit:${shortKey}`)],
            ]),
          }
        );
      } else {
        await ctx.reply(`❌ Sell execution failed: ${res.errors[0] || 'No tokens available to sell'}`);
      }
    } catch (err: any) {
      if (statusMsg) await ctx.deleteMessage(statusMsg.message_id).catch(() => { });
      await ctx.reply(`❌ Execution error: ${getUserFriendlyError(err)}`);
    }
  });

  bot.action('fleet_fund_prompt', async (ctx) => {
    const telegramId = ctx.from!.id;
    userPendingActions.set(telegramId, {
      action: 'fleet_fund_amt',
      expiresAt: Date.now() + 180_000,
    });

    await ctx.reply(
      `📥 <b>Fund Your RaceFleet</b>\n\n` +
      `Reply with the total amount of NEAR from your main wallet to distribute equally to your fleet (e.g. <code>25</code>):\n\n` +
      `<i>Type /cancel to abort.</i>`,
      { parse_mode: 'HTML' }
    );
  });

  bot.action('fleet_sweep_prompt', async (ctx) => {
    const telegramId = ctx.from!.id;
    await ctx.answerCbQuery('Sweeping all fleet funds to main wallet...').catch(() => { });
    const statusMsg = await ctx.reply('⏳ <b>Sweeping all fleet balances back to main wallet...</b>', { parse_mode: 'HTML' });

    try {
      const res = await sweepFleetFunds(telegramId);
      if (statusMsg) await ctx.deleteMessage(statusMsg.message_id).catch(() => { });

      if (res.success) {
        await ctx.reply(
          `🧹 <b>RaceFleet Sweep Complete!</b>\n\n` +
          `💰 <b>Total Swept</b>: <b>${res.totalSweptNear} NEAR</b>\n` +
          `📦 <b>Wallets Swept</b>: <b>${res.successCount} wallets</b>\n\n` +
          `All funds have been safely consolidated into your primary RacerBot wallet.`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('💳 Open Main Wallet', 'menu_wallet')],
              [Markup.button.callback('🏎️ Fleet Dashboard', 'racefleet_menu')],
            ]),
          }
        );
      } else {
        await ctx.reply(`⚠️ No funds to sweep (or fleet wallets already empty).`);
      }
    } catch (err: any) {
      if (statusMsg) await ctx.deleteMessage(statusMsg.message_id).catch(() => { });
      await ctx.reply(`❌ Sweep failed: ${getUserFriendlyError(err)}`);
    }
  });

  bot.action('fleet_wallets_list', async (ctx) => {
    await ctx.answerCbQuery().catch(() => { });
    const telegramId = ctx.from!.id;
    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) return;
    const fleet = await getRaceFleetByUserId(user.id);
    if (!fleet) return;

    const balances = await getFleetBalances(fleet.id);

    let listText = `💳 <b>RaceFleet Subaccounts (${fleet.wallet_count} Wallets)</b>\n━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    for (const w of balances.wallets) {
      listText += `• <b>W${w.walletIndex}</b>: <code>${w.accountId}</code>\n  💰 <b>${w.balanceNear.toFixed(3)} NEAR</b>\n\n`;
    }
    listText += `Total: <b>${balances.totalNearFormatted} NEAR</b> (${balances.totalNearUsd})\n`;
    const solBal = await getSolanaFleetBalances(fleet).catch(() => null);
    if (solBal && solBal.wallets.length > 0) {
      listText += `\n◎ <b>Solana Fleet Wallets</b>\n`;
      for (const w of solBal.wallets) {
        listText += `• <b>W${w.walletIndex}</b>: <code>${w.address}</code>\n  💰 <b>${w.sol.toFixed(4)} SOL</b>\n\n`;
      }
      listText += `Total: <b>${solBal.totalSol.toFixed(4)} SOL</b>`;
    }

    await ctx.reply(listText, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📥 Distribute NEAR', 'fleet_fund_prompt'), Markup.button.callback('📤 Sweep NEAR', 'fleet_sweep_prompt')],
        [Markup.button.callback('📥 Distribute SOL', 'fleet_fund_sol_prompt'), Markup.button.callback('📤 Sweep SOL', 'fleet_sweep_sol')],
        [Markup.button.callback('🔙 Back to Fleet Menu', 'racefleet_menu')],
      ]),
    });
  });

  bot.action('fleet_export_keys', async (ctx) => {
    const telegramId = ctx.from!.id;
    await ctx.answerCbQuery('Decrypting fleet private keys...').catch(() => { });

    try {
      const res = await exportFleetKeys(telegramId);
      if (res.success && res.wallets) {
        let exportText = `🔑 <b>RaceFleet Private Keys Export</b>\n━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        exportText += `⚠️ <i>NEVER share these private keys with anyone. Anyone with these keys can withdraw from your fleet subaccounts.</i>\n\n`;

        // NEAR + Solana keys can exceed Telegram's 4096-char limit: send in parts.
        const parts: string[] = [];
        for (const w of res.wallets) {
          const isSol = isSolanaAddress(w.accountId);
          const entry = `${isSol ? '◎ ' : ''}Account: <code>${w.accountId}</code>\nKey: <code>${w.privateKey}</code>\n\n`;
          if (exportText.length + entry.length > 3500) {
            parts.push(exportText);
            exportText = '';
          }
          exportText += entry;
        }
        parts.push(exportText);

        for (let i = 0; i < parts.length; i++) {
          const isLast = i === parts.length - 1;
          await ctx.reply(parts[i], {
            parse_mode: 'HTML',
            ...(isLast ? Markup.inlineKeyboard([[Markup.button.callback('🔙 Back to Fleet Menu', 'racefleet_menu')]]) : {}),
          });
        }
      } else {
        await ctx.reply(`❌ Could not export keys: ${res.reason}`);
      }
    } catch (err: any) {
      await ctx.reply(`❌ Export error: ${getUserFriendlyError(err)}`);
    }
  });

  bot.action(/^fleet_lo_start:(.+)$/, async (ctx) => {
    const shortKey = (ctx as any).match[1];
    const tokenAddress = resolveTokenAddressFromKey(shortKey);
    const telegramId = ctx.from!.id;

    if (!tokenAddress) {
      await ctx.answerCbQuery('Token address not found').catch(() => { });
      return;
    }

    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) return;
    const fleet = await getRaceFleetByUserId(user.id);
    if (!fleet) return;

    await ctx.reply(
      `🎯 <b>Fleet Limit Order for</b> <code>${tokenAddress}</code>\n\n` +
      `Fleet: <code>${fleet.fleet_tag}</code> (${fleet.wallet_count} Wallets)\n\n` +
      `Choose order direction:`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('🟢 Buy Dip (Price ≤ Target)', `fleet_lo_side:${shortKey}:buy`),
            Markup.button.callback('🔴 Take Profit (Price ≥ Target)', `fleet_lo_side:${shortKey}:sell`),
          ],
          [Markup.button.callback('« Back to Cockpit', `fleet_cockpit:${shortKey}`)],
        ]),
      }
    );
  });

  bot.action(/^fleet_lo_side:(.+):(.+)$/, async (ctx) => {
    const shortKey = (ctx as any).match[1];
    const side = (ctx as any).match[2] as 'buy' | 'sell';
    const tokenAddress = resolveTokenAddressFromKey(shortKey);
    const telegramId = ctx.from!.id;

    if (!tokenAddress) return;

    await ctx.reply(
      `📐 <b>Select Target Metric for Fleet ${side === 'buy' ? 'Buy' : 'Sell'}:</b>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(isSolanaAddress(tokenAddress) ? '💲 Target Price (SOL)' : '💵 Target Price (USD)', `fleet_lo_cond:${shortKey}:${side}:price`),
            Markup.button.callback('📊 Target Market Cap (USD)', `fleet_lo_cond:${shortKey}:${side}:market_cap`),
          ],
          [Markup.button.callback('« Cancel', `fleet_cockpit:${shortKey}`)],
        ]),
      }
    );
  });

  bot.action(/^fleet_lo_cond:(.+):(.+):(.+)$/, async (ctx) => {
    const shortKey = (ctx as any).match[1];
    const side = (ctx as any).match[2] as 'buy' | 'sell';
    const condType = (ctx as any).match[3] as 'price' | 'market_cap';
    const tokenAddress = resolveTokenAddressFromKey(shortKey);
    const telegramId = ctx.from!.id;

    if (!tokenAddress) return;

    userPendingActions.set(telegramId, {
      action: 'fleet_lo_target_value',
      fleetTokenAddress: tokenAddress,
      fleetSide: side,
      fleetLoConditionType: condType,
      expiresAt: Date.now() + 180_000,
    });

    const loSol = isSolanaAddress(tokenAddress);
    const metric = condType === 'price' ? (loSol ? 'Price (SOL per token)' : 'Price ($)') : 'Market Cap ($)';
    await ctx.reply(
      `🎯 <b>Enter Target ${metric}</b>\n\n` +
      (condType === 'price' && loSol
        ? `Reply with the target price in SOL per token (e.g. <code>0.0000004</code>):\n\n`
        : `Reply with the target value in USD (e.g. <code>${condType === 'price' ? '0.0045' : '150000'}</code>):\n\n`) +
      `<i>Type /cancel to abort.</i>`,
      { parse_mode: 'HTML' }
    );
  });

  bot.action(/^fleet_volume_prompt:(.+)$/, async (ctx) => {
    const shortKey = (ctx as any).match[1];
    const tokenAddress = resolveTokenAddressFromKey(shortKey);
    const telegramId = ctx.from!.id;
    if (!tokenAddress) return;

    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) return;
    const fleet = await getRaceFleetByUserId(user.id);
    if (!fleet) {
      await ctx.answerCbQuery('No active RaceFleet found').catch(() => { });
      return;
    }

    await ctx.reply(
      `🌊 <b>RaceFleet Volume Maker [BETA]</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `The Volume Maker conducts staggered micro-buys and micro-sells across your <b>${fleet.wallet_count} fleet wallets</b> to generate volume, increase transaction counts, and trend on DEX charts.\n\n` +
      `⚡ <i>Ready to test a 1-click organic volume bump?</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(isSolanaAddress(tokenAddress) ? '⚡ Run 1-Click Volume Bump (0.02 SOL each)' : '⚡ Run 1-Click Volume Bump (0.1 N each)', `fleet_volume_bump:${shortKey}`)],
          [Markup.button.callback('« Back to Cockpit', `fleet_cockpit:${shortKey}`)],
        ]),
      }
    );
  });

  bot.action(/^fleet_volume_bump:(.+)$/, async (ctx) => {
    const shortKey = (ctx as any).match[1];
    const tokenAddress = resolveTokenAddressFromKey(shortKey);
    const telegramId = ctx.from!.id;
    if (!tokenAddress) return;

    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) return;
    const fleet = await getRaceFleetByUserId(user.id);
    if (!fleet) return;

    const vbUnit = snipeUnit(tokenAddress);
    const vbAmt = vbUnit === 'SOL' ? 0.02 : 0.1;
    await ctx.answerCbQuery('Generating volume bump...').catch(() => { });
    const msg = await ctx.reply(`🌊 <b>Running Volume Bump across ${fleet.wallet_count} wallets...</b>\n\nBuying ${vbAmt} ${vbUnit} per wallet to activate transaction count on-chain.`, { parse_mode: 'HTML' });

    try {
      const res = await executeFleetBundleBuy(fleet.id, tokenAddress, vbAmt, 3.0);
      if (msg) await ctx.deleteMessage(msg.message_id).catch(() => { });
      if (res.success) {
        await ctx.reply(
          `✅ <b>Volume Bump Complete!</b>\n\n` +
          `🪙 <b>Token</b>: <code>${tokenAddress}</code>\n` +
          `📦 <b>Swaps Executed</b>: <b>${res.successCount}/${fleet.wallet_count} Wallets</b>\n` +
          `💰 <b>Volume Generated</b>: <b>${res.totalSpentNear} ${vbUnit}</b>\n\n` +
          `<i>Transactions are recorded on-chain, boosting pair activity!</i>`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('🏎️ Back to Cockpit', `fleet_cockpit:${shortKey}`)],
            ]),
          }
        );
      } else {
        await ctx.reply(`❌ Volume bump failed: ${res.errors[0] || 'Unknown error'}`);
      }
    } catch (err: any) {
      if (msg) await ctx.deleteMessage(msg.message_id).catch(() => { });
      await ctx.reply(`❌ Error: ${getUserFriendlyError(err)}`);
    }
  });

  bot.action('fleet_orders_list', async (ctx) => {
    const telegramId = ctx.from!.id;
    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) return;
    const fleet = await getRaceFleetByUserId(user.id);
    if (!fleet) return;

    const orders = await getRaceFleetOrdersByFleet(fleet.id);
    if (orders.length === 0) {
      await ctx.reply('📋 <b>Active RaceFleet Orders</b>\n\nNo active orders currently pending.', {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'racefleet_menu')]]),
      });
      return;
    }

    let text = `📋 <b>RaceFleet Active Orders (${orders.length})</b>\n━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    for (const o of orders.slice(0, 10)) {
      const typeLabel = o.order_type === 'limit_buy' ? '🟢 Limit Buy' : o.order_type === 'limit_sell' ? '🔴 Limit Sell' : '🛡️ TP/SL';
      text += `• ${typeLabel} <code>${o.token_address}</code>\n  Trigger: <code>${o.trigger_condition || 'auto'} ${o.target_value || ''}</code> | Amt: ${o.amount_per_wallet} ${snipeUnit(o.token_address) === 'SOL' ? 'SOL' : 'N'}/wallet\n`;
    }

    await ctx.reply(text, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back to Fleet Menu', 'racefleet_menu')]]),
    });
  });

  bot.action('fleet_renew_prompt', async (ctx) => {
    const telegramId = ctx.from!.id;
    await ctx.reply(
      `🔄 <b>Renew RaceFleet Subscription</b>\n\n` +
      `Fee: <b>${RACEFLEET_MONTHLY_FEE_NEAR} NEAR</b> for an additional 30 days.\n\n` +
      `<i>The fee will be deducted directly from your main RacerBot wallet.</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Confirm & Pay 2 NEAR', 'fleet_renew_confirm')],
          [Markup.button.callback('« Cancel', 'racefleet_menu')],
        ]),
      }
    );
  });

  bot.action('fleet_renew_confirm', async (ctx) => {
    const telegramId = ctx.from!.id;
    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) return;
    const fleet = await getRaceFleetByUserId(user.id);
    if (!fleet) return;

    await ctx.answerCbQuery('Processing renewal payment...').catch(() => { });
    try {
      await withdrawFunds(telegramId, TREASURY_ACCOUNT_ID, RACEFLEET_MONTHLY_FEE_NEAR);
      const updated = await renewRaceFleet(fleet.id, 30);
      await ctx.reply(
        `🎉 <b>RaceFleet Successfully Renewed!</b>\n\n` +
        `New Expiry Date: <b>${new Date(updated.expires_at).toLocaleDateString()}</b>\n\n` +
        `All fleet operations remain fully active.`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([[Markup.button.callback('🏎️ Open Fleet Dashboard', 'racefleet_menu')]]),
        }
      );
    } catch (err: any) {
      await ctx.reply(`❌ Renewal error: ${getUserFriendlyError(err)}`);
    }
  });

  // ── RaceFleet on Solana: pay in SOL, distribute, sweep, renew ─────────────

  bot.action(/^fleet_deploy_sol:(\d+)$/, async (ctx) => {
    const count = parseInt((ctx as any).match[1], 10) || 5;
    const telegramId = ctx.from!.id;
    const feeSol = await getFleetFeeInSol().catch(() => null);
    await ctx.answerCbQuery().catch(() => { });
    if (!feeSol) {
      await ctx.reply('❌ Price feed unavailable right now. Please try again in a minute.');
      return;
    }
    await ctx.reply(
      `◎ <b>Deploy RaceFleet (pay in SOL)</b>\n\n` +
      `Fleet size: <b>${count} Solana wallets</b>\n` +
      `Subscription: <b>${feeSol} SOL</b> for 30 days (same value as ${RACEFLEET_MONTHLY_FEE_NEAR} NEAR)\n\n` +
      `<i>Paid from your main Solana wallet. Solana fleet wallets cost nothing to create.</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(`✅ Pay ${feeSol} SOL & Deploy`, `fleet_deploy_sol_ok:${count}`)],
          [Markup.button.callback('« Cancel', 'racefleet_menu')],
        ]),
      }
    );
  });

  bot.action(/^fleet_deploy_sol_ok:(\d+)$/, async (ctx) => {
    const count = parseInt((ctx as any).match[1], 10) || 5;
    const telegramId = ctx.from!.id;
    if (!(await tryAcquireInFlight(inFlightKey(telegramId, 'fleet_deploy_sol', 'buy')))) {
      await ctx.answerCbQuery('Already processing…').catch(() => { });
      return;
    }
    await ctx.answerCbQuery('Paying subscription in SOL...').catch(() => { });
    const loading = await ctx.reply('⏳ <b>Paying subscription and creating your Solana fleet wallets...</b>', { parse_mode: 'HTML' }).catch(() => null);
    try {
      const res = await deployRaceFleetWithSol(telegramId, count);
      if (loading) await ctx.deleteMessage(loading.message_id).catch(() => { });
      if (res.success && res.fleet) {
        await ctx.reply(
          `🚀 <b>RaceFleet Deployed on Solana!</b>\n\n` +
          `🏷 <b>Fleet Tag</b>: <code>${res.fleet.fleet_tag}</code>\n` +
          `◎ <b>Solana Wallets</b>: <b>${res.wallets?.length ?? count}</b>\n` +
          `💳 <b>Paid</b>: ${res.feeSol} SOL\n` +
          `📅 <b>Active Until</b>: ${new Date(res.fleet.expires_at).toLocaleDateString()}\n\n` +
          `💡 <i>Next: tap <b>[📥 Distribute SOL]</b> to fund the fleet, then open any Solana token and tap 🏎️ Fleet.</i>`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('📥 Distribute SOL', 'fleet_fund_sol_prompt')],
              [Markup.button.callback('🏎️ Open Fleet Dashboard', 'racefleet_menu')],
            ]),
          }
        );
      } else {
        await ctx.reply(`❌ <b>Deployment Failed:</b>\n\n${res.reason || 'Unknown error'}`, { parse_mode: 'HTML' });
      }
    } catch (err: any) {
      if (loading) await ctx.deleteMessage(loading.message_id).catch(() => { });
      await ctx.reply(`❌ Deployment error: ${getUserFriendlyError(err)}`);
    } finally {
      releaseInFlight(inFlightKey(telegramId, 'fleet_deploy_sol', 'buy'));
    }
  });

  bot.action('fleet_fund_sol_prompt', async (ctx) => {
    const telegramId = ctx.from!.id;
    await ctx.answerCbQuery().catch(() => { });
    userPendingActions.set(telegramId, { action: 'fleet_fund_sol_amt', expiresAt: Date.now() + 180_000 });
    await ctx.reply(
      `📥 <b>Fund Your Solana Fleet</b>\n\n` +
      `Reply with the total SOL from your main Solana wallet to split equally across your fleet (e.g. <code>1</code>).\n` +
      `<i>Each wallet needs at least 0.002 SOL, plus ~0.004 SOL beside each buy for token-account rent and fees.</i>\n\n` +
      `<i>Type /cancel to abort.</i>`,
      { parse_mode: 'HTML' }
    );
  });

  bot.action('fleet_sweep_sol', async (ctx) => {
    const telegramId = ctx.from!.id;
    if (!(await tryAcquireInFlight(inFlightKey(telegramId, 'fleet_sweep_sol', 'buy')))) {
      await ctx.answerCbQuery('Already processing…').catch(() => { });
      return;
    }
    await ctx.answerCbQuery('Sweeping Solana fleet to main wallet...').catch(() => { });
    const statusMsg = await ctx.reply('⏳ <b>Sweeping all Solana fleet SOL back to your main wallet...</b>', { parse_mode: 'HTML' }).catch(() => null);
    try {
      const res = await sweepSolanaFleet(telegramId);
      if (statusMsg) await ctx.deleteMessage(statusMsg.message_id).catch(() => { });
      if (res.success) {
        await ctx.reply(
          `🧹 <b>Solana Fleet Sweep Complete!</b>\n\n` +
          `💰 <b>Total Swept</b>: <b>${res.totalSweptSol} SOL</b>\n` +
          `📦 <b>Wallets Swept</b>: <b>${res.successCount}</b>${res.failCount ? ` (⚠️ ${res.failCount} failed, try again)` : ''}\n\n` +
          `<i>Tokens stay in the fleet wallets. Sell them first with 🔴 Dump to turn them into SOL.</i>`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('💳 Open Main Wallet', 'menu_wallet')],
              [Markup.button.callback('🏎️ Fleet Dashboard', 'racefleet_menu')],
            ]),
          }
        );
      } else {
        await ctx.reply(res.reason ? `⚠️ ${res.reason}` : '⚠️ No SOL to sweep (Solana fleet wallets are already empty).');
      }
    } catch (err: any) {
      if (statusMsg) await ctx.deleteMessage(statusMsg.message_id).catch(() => { });
      await ctx.reply(`❌ Sweep failed: ${getUserFriendlyError(err)}`);
    } finally {
      releaseInFlight(inFlightKey(telegramId, 'fleet_sweep_sol', 'buy'));
    }
  });

  bot.action('fleet_renew_sol_prompt', async (ctx) => {
    await ctx.answerCbQuery().catch(() => { });
    const feeSol = await getFleetFeeInSol().catch(() => null);
    if (!feeSol) {
      await ctx.reply('❌ Price feed unavailable right now. Please try again in a minute.');
      return;
    }
    await ctx.reply(
      `🔄 <b>Renew RaceFleet (pay in SOL)</b>\n\n` +
      `Fee: <b>${feeSol} SOL</b> (same value as ${RACEFLEET_MONTHLY_FEE_NEAR} NEAR) for 30 more days.\n\n` +
      `<i>Paid from your main Solana wallet.</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(`✅ Confirm & Pay ${feeSol} SOL`, 'fleet_renew_sol_confirm')],
          [Markup.button.callback('« Cancel', 'racefleet_menu')],
        ]),
      }
    );
  });

  bot.action('fleet_renew_sol_confirm', async (ctx) => {
    const telegramId = ctx.from!.id;
    if (!(await tryAcquireInFlight(inFlightKey(telegramId, 'fleet_renew_sol', 'buy')))) {
      await ctx.answerCbQuery('Already processing…').catch(() => { });
      return;
    }
    await ctx.answerCbQuery('Processing SOL renewal...').catch(() => { });
    try {
      const res = await renewRaceFleetWithSol(telegramId);
      if (res.success && res.expiresAt) {
        await ctx.reply(
          `🎉 <b>RaceFleet Renewed!</b>\n\nPaid: ${res.feeSol} SOL\nNew Expiry Date: <b>${new Date(res.expiresAt).toLocaleDateString()}</b>`,
          { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🏎️ Open Fleet Dashboard', 'racefleet_menu')]]) }
        );
      } else {
        await ctx.reply(`❌ Renewal failed: ${res.reason || 'Unknown error'}`);
      }
    } finally {
      releaseInFlight(inFlightKey(telegramId, 'fleet_renew_sol', 'buy'));
    }
  });

  // ── AI ShadowSwarm (NEAR AI TEE) Routes & Cockpit ─────────────────────────

  async function buildSwarmDashboard(telegramId: number) {
    const user = await getUserByTelegramId(telegramId);
    if (!user) throw new Error('Please run /start first.');

    const active = await getUserActiveAiSwarmSession(user.id);
    if (active && active.status === 'executing') {
      const state = active.execution_state || {};
      const tranches = active.plan_json?.tranches || [];
      const completed = state.completedDrones || 0;
      const total = active.drone_count || tranches.length || 1;
      const pct = Math.min(100, Math.round((completed / total) * 100));

      const filledLogs = (state.executionLog || []).slice(-4);
      const logsText = filledLogs.length > 0
        ? filledLogs.map((l: any) => `• [${l.time || 'NOW'}] ${l.message}`).join('\n')
        : '• Drones deployed, waiting for execution jitter windows...';

      const text =
        `📡 <b>Racer ShadowSwarm — Active Radar</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `Target: <b>$${escapeHtml(active.token_symbol || 'TOKEN')}</b> (<code>${escapeHtml(active.token_address)}</code>)\n` +
        `Strategy: <b>${escapeHtml((active.strategy_type || 'SWARM').toUpperCase())}</b>\n` +
        `Capital: <b>${Number(active.total_amount_near).toFixed(2)} NEAR</b> across <b>${total} Drones</b>\n` +
        `Stealth Routing: 🟢 <b>${active.stealth_mode ? 'CONFIDENTIAL TEE' : 'STANDARD'}</b>\n\n` +
        `📊 <b>Mission Progress:</b> ${completed}/${total} Drones (${pct}%)\n` +
        `[${'█'.repeat(Math.round(pct / 10))}${'░'.repeat(10 - Math.round(pct / 10))}]\n\n` +
        `<b>Telemetry Stream:</b>\n` +
        `${logsText}\n\n` +
        `🔒 <i>Intel TDX TEE verified by NEAR AI Cloud</i>`;

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('🔄 Refresh Radar', 'swarm_radar_refresh'),
          Markup.button.callback('⏸️ Pause', `swarm_pause:${active.id}`),
        ],
        [
          Markup.button.callback('🛑 Abort Mission', `swarm_abort:${active.id}`),
          Markup.button.callback('➕ New Strategy', 'swarm_new_strategy'),
        ],
        [Markup.button.callback('⬅️ Main Menu', 'menu_home')],
      ]);
      return { text, keyboard };
    }

    if (active && active.status === 'review') {
      const plan = active.plan_json || {};
      const tranches = plan.tranches || [];
      const tranchesText = tranches.slice(0, 5).map((t: any, i: number) =>
        `• Drone #${i + 1}: <b>${t.amountNear.toFixed(2)} NEAR</b> (+${t.delaySec !== undefined ? t.delaySec : (t.delayMs ? Math.round(t.delayMs / 1000) : 0)}s jitter)`
      ).join('\n') + (tranches.length > 5 ? `\n• ...and ${tranches.length - 5} more drone tranches` : '');

      const trig = plan.exitTrigger || (plan as any).exit_trigger;
      const exitInfo = trig ? `\n🎯 Exit Trigger: <b>${escapeHtml(String(trig.targetDisplay || trig.targetValue))}</b>` : '';

      const text =
        `🤖 <b>NEAR AI Swarm Plan Awaiting Authorization</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `Target: <b>${escapeHtml(active.token_symbol || 'TOKEN')}</b> (<code>${escapeHtml(active.token_address)}</code>)\n` +
        `Strategy: <b>${escapeHtml((active.strategy_type || 'SWARM').toUpperCase())}</b>\n` +
        `Capital: <b>${Number(active.total_amount_near).toFixed(2)} NEAR</b> (${active.drone_count} Drones)\n` +
        `Stealth Score: <b>${plan.stealthScore || 95}%</b> 🛡️${exitInfo}\n\n` +
        `<b>Drone Tranches:</b>\n${tranchesText}\n\n` +
        `🔒 <b>TEE Hardware Attestation:</b>\n` +
        `<code>${(active.tee_attestation?.attestationHash || '0xintel_tdx_verified').slice(0, 32)}...</code>\n\n` +
        `<i>Prompt: "${escapeHtml(active.prompt)}"</i>`;

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🚀 Authorize & Launch Swarm', `swarm_launch:${active.id}`)],
        [
          Markup.button.callback('🔄 Discard & Choose Preset', 'swarm_new_strategy'),
          Markup.button.callback('⬅️ Main Menu', 'menu_home'),
        ],
      ]);
      return { text, keyboard };
    }

    // Default: Choose preset or prompt
    const text =
      `🤖 <b>Racer ShadowSwarm [NEAR AI Cloud TEE]</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `Coordinate autonomous multi-agent drone swarms inside confidential hardware enclaves.\n\n` +
      `🔒 <b>Hardware Enclave:</b> Intel TDX TEE (api.near.ai)\n` +
      `🛡️ <b>Confidential Mode:</b> Ephemeral Sub-accounts\n` +
      `⚡ <b>MEV Resistance:</b> Jittered Tranches & Pattern Obfuscation\n\n` +
      `Select a strategy preset or enter a custom prompt:`;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('⚡ Stealth TWAP (5 Drones • $HOOT)', 'swarm_preset:stealth_accumulate')],
      [Markup.button.callback('🎯 Momentum Snipe (3 Drones • $BATMAN)', 'swarm_preset:momentum_snipe')],
      [Markup.button.callback('🛡️ Anti-MEV Dispersion (6 Drones • $SHORE)', 'swarm_preset:anti_mev')],
      [Markup.button.callback('🔍 Liquidity Depth Probe (4 Drones)', 'swarm_preset:liquidity_probe')],
      [
        Markup.button.callback('✍️ Custom Prompt', 'swarm_prompt_start'),
        Markup.button.callback('🏎️ RaceFleet WebApp', 'racefleet_menu'),
      ],
      [Markup.button.callback('⬅️ Main Menu', 'menu_home')],
    ]);
    return { text, keyboard };
  }

  bot.command(['swarm', 'aiswarm'], async (ctx) => {
    const telegramId = ctx.from!.id;
    try {
      const dashboard = await buildSwarmDashboard(telegramId);
      await ctx.reply(dashboard.text, {
        parse_mode: 'HTML',
        ...dashboard.keyboard,
      });
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
    }
  });

  bot.action('menu_swarm', async (ctx) => {
    await ctx.answerCbQuery().catch(() => { });
    const telegramId = ctx.from!.id;
    try {
      const dashboard = await buildSwarmDashboard(telegramId);
      await ctx.editMessageText(dashboard.text, {
        parse_mode: 'HTML',
        ...dashboard.keyboard,
      } as any).catch(async () => {
        await ctx.reply(dashboard.text, {
          parse_mode: 'HTML',
          ...dashboard.keyboard,
        });
      });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  bot.action('swarm_radar_refresh', async (ctx) => {
    await ctx.answerCbQuery('Refreshing Swarm Radar...').catch(() => { });
    const telegramId = ctx.from!.id;
    try {
      const dashboard = await buildSwarmDashboard(telegramId);
      await ctx.editMessageText(dashboard.text, {
        parse_mode: 'HTML',
        ...dashboard.keyboard,
      } as any).catch(() => { });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  bot.action('swarm_new_strategy', async (ctx) => {
    await ctx.answerCbQuery().catch(() => { });
    const text =
      `🤖 <b>Racer ShadowSwarm [NEAR AI Cloud TEE]</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `Coordinate autonomous multi-agent drone swarms inside confidential hardware enclaves.\n\n` +
      `Select a strategy preset or launch a custom prompt:`;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('⚡ Stealth TWAP (5 Drones • $HOOT)', 'swarm_preset:stealth_accumulate')],
      [Markup.button.callback('🎯 Momentum Snipe (3 Drones • $BATMAN)', 'swarm_preset:momentum_snipe')],
      [Markup.button.callback('🛡️ Anti-MEV Dispersion (6 Drones • $SHORE)', 'swarm_preset:anti_mev')],
      [Markup.button.callback('🔍 Liquidity Depth Probe (4 Drones)', 'swarm_preset:liquidity_probe')],
      [
        Markup.button.callback('✍️ Custom Prompt', 'swarm_prompt_start'),
        Markup.button.callback('⬅️ Swarm Dashboard', 'menu_swarm'),
      ],
    ]);

    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      ...keyboard,
    } as any).catch(async () => {
      await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
    });
  });

  bot.action(/^swarm_preset:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery('Computing AI plan via NEAR AI TEE...').catch(() => { });
    const telegramId = ctx.from!.id;
    const presetType = ctx.match[1];

    let prompt = 'Accumulate 10 NEAR of HOOT with 5 stealth drones staggered over 15 minutes to avoid front-running';
    let defaultToken = 'hoot.near';
    if (presetType === 'momentum_snipe') {
      prompt = 'Execute rapid breakout snipe on BATMAN across 3 drones within 30 seconds';
      defaultToken = 'batman.near';
    } else if (presetType === 'anti_mev') {
      prompt = 'Disperse 20 NEAR across 6 randomized subaccounts to accumulate SHORE without sandwich MEV';
      defaultToken = 'shore.near';
    } else if (presetType === 'liquidity_probe') {
      prompt = 'Probe BLACKDRAGON liquidity depth with 3 sub-1 NEAR probes before executing target tranche';
      defaultToken = 'blackdragon.tkn.near';
    }

    try {
      const user = await getUserByTelegramId(telegramId);
      if (!user) throw new Error('User not found. Run /start first.');

      const balances = await getUserBalances(telegramId).catch(() => null);
      const plan = await planSwarmSession({
        prompt,
        userBalances: balances,
        defaultTokenAddress: defaultToken,
        stealthModeOverride: true,
      });

      const session = await createAiSwarmSession({
        userId: user.id,
        prompt,
        strategyType: plan.strategy,
        tokenAddress: plan.tokenAddress,
        tokenSymbol: plan.tokenSymbol,
        totalAmountNear: plan.totalNear,
        droneCount: plan.droneCount,
        stealthMode: plan.stealthMode,
        planJson: plan,
        teeAttestation: plan.teeEnclave,
      });

      const tranches = plan.tranches || [];
      const tranchesText = tranches.slice(0, 5).map((t: any, i: number) =>
        `• Drone #${i + 1}: <b>${t.amountNear.toFixed(2)} NEAR</b> (+${t.delaySec !== undefined ? t.delaySec : (t.delayMs ? Math.round(t.delayMs / 1000) : 0)}s jitter)`
      ).join('\n') + (tranches.length > 5 ? `\n• ...and ${tranches.length - 5} more drone tranches` : '');

      const trig = plan.exitTrigger || (plan as any).exit_trigger;
      const exitInfo = trig ? `\n🎯 Exit Trigger: <b>${escapeHtml(String(trig.targetDisplay || trig.targetValue))}</b>` : '';

      const text =
        `🤖 <b>NEAR AI Execution Plan Generated</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `Strategy: <b>${escapeHtml((plan.strategyTitle || plan.strategy).toUpperCase())}</b>\n` +
        `Target: <b>${escapeHtml(plan.tokenSymbol)}</b> (<code>${escapeHtml(plan.tokenAddress)}</code>)\n` +
        `Capital: <b>${plan.totalNear.toFixed(2)} NEAR</b> (${plan.droneCount} Drones)\n` +
        `Stealth Score: <b>${plan.stealthScore}%</b> 🛡️${exitInfo}\n\n` +
        `<b>Drone Tranches:</b>\n${tranchesText}\n\n` +
        `🔒 <b>TEE Hardware Attestation:</b>\n` +
        `<code>${(plan.teeEnclave.attestationHash || plan.teeEnclave.hash).slice(0, 32)}...</code>\n` +
        `Verified Intel TDX Enclave by NEAR AI Cloud\n\n` +
        `<i>${escapeHtml(plan.analysis || plan.reasoning || '')}</i>`;

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🚀 Authorize & Launch Swarm', `swarm_launch:${session.id}`)],
        [
          Markup.button.callback('🔄 Choose Other Preset', 'swarm_new_strategy'),
          Markup.button.callback('⬅️ Main Menu', 'menu_home'),
        ],
      ]);

      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        ...keyboard,
      } as any).catch(async () => {
        await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
      });
    } catch (err: any) {
      await ctx.reply(`❌ Failed to plan swarm: ${err?.message || 'Unknown error'}`);
    }
  });

  bot.action(/^swarm_launch:(.+)$/, async (ctx) => {
    const sessionId = ctx.match[1];
    await ctx.answerCbQuery('Launching Swarm Drones...').catch(() => { });
    const telegramId = ctx.from!.id;

    try {
      const session = await getAiSwarmSessionById(sessionId);
      if (!session) throw new Error('Session not found');

      // Launch session in background
      await launchSwarmSession(sessionId);

      await ctx.reply(
        `🚀 <b>Swarm Mission Launched!</b>\n\n` +
        `Target: <b>$${escapeHtml(session.token_symbol || 'TOKEN')}</b>\n` +
        `Drones: <b>${session.drone_count} Subaccounts Active</b>\n` +
        `Mode: <b>Confidential TEE Routing</b> 🛡️\n\n` +
        `<i>Drones are now executing staggered tranches. Tap below to track real-time radar telemetry.</i>`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('📡 View Swarm Radar', 'swarm_radar_refresh')],
            [Markup.button.callback('⬅️ Main Menu', 'menu_home')],
          ]),
        }
      );
    } catch (err: any) {
      await ctx.reply(`❌ Failed to launch swarm: ${err?.message || 'Unknown error'}`);
    }
  });

  bot.action(/^swarm_pause:(.+)$/, async (ctx) => {
    const sessionId = ctx.match[1];
    await ctx.answerCbQuery('Pausing swarm...').catch(() => { });
    try {
      await pauseSwarmSession(sessionId);
      await ctx.reply(`⏸️ <b>Swarm Mission Paused</b>\nPending drone tranches held until resumed.`, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📡 Radar Telemetry', 'swarm_radar_refresh')],
          [Markup.button.callback('⬅️ Swarm Menu', 'menu_swarm')],
        ]),
      });
    } catch (err: any) {
      await ctx.reply(`❌ Failed to pause: ${err?.message || 'Unknown error'}`);
    }
  });

  bot.action(/^swarm_abort:(.+)$/, async (ctx) => {
    const sessionId = ctx.match[1];
    await ctx.answerCbQuery('Aborting swarm...').catch(() => { });
    try {
      await abortSwarmSession(sessionId);
      await ctx.reply(`🛑 <b>Swarm Mission Aborted</b>\nAll remaining drone tranches cancelled.`, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🤖 Swarm Menu', 'menu_swarm')],
          [Markup.button.callback('⬅️ Main Menu', 'menu_home')],
        ]),
      });
    } catch (err: any) {
      await ctx.reply(`❌ Failed to abort: ${err?.message || 'Unknown error'}`);
    }
  });

  bot.action('swarm_prompt_start', async (ctx) => {
    await ctx.answerCbQuery().catch(() => { });
    const telegramId = ctx.from!.id;
    userPendingActions.set(telegramId, {
      action: 'swarm_custom_prompt',
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    await ctx.reply(
      `✍️ <b>Enter Custom Swarm Strategy Prompt</b>\n\n` +
      `Describe how you want your autonomous drone swarm to trade.\n\n` +
      `<b>Examples:</b>\n` +
      `• <i>"Accumulate 15 NEAR of BATMAN with 4 drones over 10 minutes"</i>\n` +
      `• <i>"Snipe HOOT with 3 fast stealth drones using 5 NEAR"</i>\n` +
      `• <i>"Anti-MEV accumulation of 20 NEAR into SHORE"</i>\n\n` +
      `<i>Type your prompt below or tap Cancel:</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('❌ Cancel', 'menu_swarm')],
        ]),
      }
    );
  });

  // ── Targeted snipes: by token contract address / by deployer wallet ───────

  const snipeSetupCache = new Map<number, { tokenAddress: string; amt: number; expiresAt: number }>();


  function parseUtcTimeString(input: string): { date: Date | null; error?: string } {
    const raw = input.trim();
    const now = new Date();

    // 1. Relative delays: e.g. "+5m", "5m", "10m", "+15m", "in 10 mins", "+1h", "1h", "2 hours"
    const relMatch = raw.match(/^(?:\+?\s*|in\s+)?(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/i);
    if (relMatch) {
      const val = parseInt(relMatch[1], 10);
      const unit = relMatch[2].toLowerCase();
      const isHours = unit.startsWith('h');
      const delayMs = val * (isHours ? 3600_000 : 60_000);
      if (val <= 0 || delayMs > 7 * 24 * 3600_000) {
        return { date: null, error: 'Delay must be between 1 minute and 7 days.' };
      }
      return { date: new Date(now.getTime() + delayMs) };
    }

    // 2. Check for explicit timezone offset: e.g. "UTC+1", "UTC +1", "UTC-5", "+01:00", "-04"
    let clean = raw;
    let offsetMinutes = 0;
    const tzMatch = clean.match(/(?:utc)?\s*([+-])\s*(\d{1,2})(?::(\d{2}))?\s*$/i);
    if (tzMatch) {
      const sign = tzMatch[1] === '-' ? -1 : 1;
      const tzHours = parseInt(tzMatch[2], 10);
      const tzMins = tzMatch[3] ? parseInt(tzMatch[3], 10) : 0;
      // To convert time in UTC+X to UTC, subtract X hours
      offsetMinutes = sign * (tzHours * 60 + tzMins);
      clean = clean.slice(0, tzMatch.index).trim();
    } else {
      // Strip trailing "UTC"
      clean = clean.replace(/\s*utc\s*$/i, '').trim();
    }

    // 3. Full Date + Time: YYYY-MM-DD HH:MM or YYYY/MM/DD HH:MM
    const fullDateMatch = clean.match(/^(\d{4})[-/](\d{2})[-/](\d{2})[T ](\d{1,2})[:;](\d{2})(?:[:;](\d{2}))?(?:\s*(am|pm))?$/i);
    if (fullDateMatch) {
      const year = parseInt(fullDateMatch[1], 10);
      const month = parseInt(fullDateMatch[2], 10) - 1;
      const day = parseInt(fullDateMatch[3], 10);
      let hours = parseInt(fullDateMatch[4], 10);
      const minutes = parseInt(fullDateMatch[5], 10);
      const seconds = fullDateMatch[6] ? parseInt(fullDateMatch[6], 10) : 0;
      const ampm = fullDateMatch[7]?.toLowerCase();

      if (ampm === 'pm' && hours < 12) hours += 12;
      if (ampm === 'am' && hours === 12) hours = 0;

      const baseMs = Date.UTC(year, month, day, hours, minutes, seconds);
      if (isNaN(baseMs)) return { date: null, error: 'Invalid date format.' };
      const targetMs = baseMs - offsetMinutes * 60_000;
      const target = new Date(targetMs);

      if (target.getTime() <= now.getTime() - 60_000) {
        return { date: null, error: 'The specified date and time is in the past. Please enter a future UTC time.' };
      }
      return { date: target };
    }

    // 4. "Tomorrow HH:MM"
    let isTomorrow = false;
    if (/^tomorrow\s+/i.test(clean)) {
      isTomorrow = true;
      clean = clean.replace(/^tomorrow\s+/i, '').trim();
    }

    // 5. Time only: "HH:MM", "HH;MM", with optional AM/PM
    const timeMatch = clean.match(/^(\d{1,2})[:;](\d{2})(?:[:;](\d{2}))?(?:\s*(am|pm))?$/i);
    if (timeMatch) {
      let hours = parseInt(timeMatch[1], 10);
      const minutes = parseInt(timeMatch[2], 10);
      const seconds = timeMatch[3] ? parseInt(timeMatch[3], 10) : 0;
      const ampm = timeMatch[4]?.toLowerCase();

      if (ampm === 'pm' && hours < 12) hours += 12;
      if (ampm === 'am' && hours === 12) hours = 0;

      if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59 || seconds < 0 || seconds > 59) {
        return { date: null, error: 'Invalid time. Hours must be 0-23 and minutes 0-59.' };
      }

      const dayOffset = isTomorrow ? 1 : 0;
      const baseMs = Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + dayOffset,
        hours,
        minutes,
        seconds
      );
      const targetMs = baseMs - offsetMinutes * 60_000;
      let target = new Date(targetMs);

      // If target is within 60s in the past (typing latency), clamp to now + 5s
      if (target.getTime() <= now.getTime()) {
        if (now.getTime() - target.getTime() <= 60_000 && !isTomorrow) {
          target = new Date(now.getTime() + 5_000);
        } else if (!isTomorrow) {
          const currentUtc = formatUtcTime(now);
          const enteredUtc = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')} UTC`;
          return {
            date: null,
            error: `That time (${enteredUtc}) has already passed today (Current UTC: ${currentUtc}). Please enter a future UTC time or reply with a delay like \`+10m\`.`,
          };
        }
      }
      return { date: target };
    }

    return {
      date: null,
      error: 'Unrecognized format. Please reply with `HH:MM` (e.g. `19:23`), a delay like `+10m` or `15m`, or `YYYY-MM-DD HH:MM` (all in UTC).',
    };
  }

  async function completeSnipeOrderCreation(
    ctx: any,
    telegramId: number,
    tokenAddress: string,
    amt: number,
    executeAfter: Date | null
  ): Promise<void> {
    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) {
      await ctx.reply('Use /start to set up your wallet first.').catch(() => { });
      return;
    }
    const activeCount = await countActiveSnipeOrders(user.id).catch(() => 0);
    if (activeCount >= MAX_ACTIVE_SNIPE_ORDERS_PER_USER) {
      await ctx.reply(`❌ You already have ${MAX_ACTIVE_SNIPE_ORDERS_PER_USER} active snipe orders. Cancel one in 🎯 Snipe Rules → 📋 My Snipe Orders.`).catch(() => { });
      return;
    }

    const isSol = isSolanaAddress(tokenAddress);
    const tradeCurrency = isSol ? 'sol' : (user.near_trade_currency === 'usdc' ? 'usdc' : 'near');
    const unit = snipeUnit(tokenAddress, user);

    const order = await createSnipeOrder({
      user_id: user.id,
      snipe_type: 'token',
      token_address: tokenAddress,
      amount_near: amt,
      trade_currency: tradeCurrency,
      execute_after: executeAfter,
    });

    if (user && !isSol) {
      prewarmStorageDeposit(user, tokenAddress).catch(() => { });
    }

    // If a scheduled future time was chosen, do NOT fire immediately even if tradeable.
    // Order stays armed in DB until executeAfter time arrives!
    if (executeAfter && executeAfter.getTime() > Date.now()) {
      const timeStr = formatUtcDateTime(executeAfter);
      const diffMs = executeAfter.getTime() - Date.now();
      const diffMins = Math.round(diffMs / 60_000);
      const diffText = diffMins > 60 ? `in ~${(diffMins / 60).toFixed(1)}h` : `in ~${diffMins} min${diffMins === 1 ? '' : 's'}`;

      await ctx.reply(
        `🎯 *Scheduled Snipe Armed!*\n\n` +
        `🪙 Token: \`${tokenAddress}\`\n` +
        `💰 Amount: \`${amt} ${unit}\`\n` +
        `⏰ Trigger Time: \`${timeStr}\` (${diffText})\n\n` +
        `• The bot will *NOT* buy before this time, bypassing high launch dynamic fees.\n` +
        `• At the scheduled time, the bot will automatically execute your buy on the pool.\n` +
        `• Funds stay securely in your wallet until the trade triggers (no token locking needed).`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [cb('❌ Cancel Snipe Order', `snipe_order_cancel:${order.id}`, 'danger')],
              [cb('📋 My Snipe Orders', 'snipe_orders', 'primary'), cb('🎯 Snipe Rules', 'menu_snipe', 'primary')],
            ],
          },
        }
      ).catch(() => { });
      return;
    }

    // Standard immediate snipe:
    const info = await getTokenInfo(tokenAddress, false).catch(() => null);
    if (info?.tradeable) {
      const triggerId = await recordSnipeTrigger(order.id, tokenAddress, info.venue ?? '').catch(() => null);
      const procMsg = await ctx.reply(
        `⏳ *Snipe Executing...*\n\n\`${tokenAddress}\` is live — buying with \`${amt} ${unit}\` now...`,
        { parse_mode: 'Markdown' }
      ).catch(() => null);
      const onStage = makeStageEditor(ctx, procMsg, 'Snipe Executing');
      try {
        let buyAmt = amt;
        if (!isSol && user.near_trade_currency === 'usdc') {
          const nearUsdVal = await getNearUsdPrice().catch(() => 0);
          const effUsd = nearUsdVal > 0 ? nearUsdVal : 5.0;
          buyAmt = amt / effUsd;
        }
        const res = await executeBuyHelper(telegramId, tokenAddress, buyAmt, onStage);
        if (procMsg) await ctx.deleteMessage(procMsg.message_id).catch(() => { });
        if (triggerId) await markSnipeTriggerFilled(triggerId, null).catch(() => { });
        await markSnipeOrderResult(order.id, true).catch(() => { });
        await ctx.reply(res.message, {
          parse_mode: 'Markdown',
          reply_markup: await buildBuySuccessKeyboard(telegramId, tokenAddress, res.tokenSymbol, res.positionId),
        }).catch(() => { });
        if (res.positionId) {
          await sendPostBuySlTpPrompt(ctx, res.positionId, tokenAddress, res.tokenSymbol).catch(() => { });
        }
      } catch (err: any) {
        if (procMsg) await ctx.deleteMessage(procMsg.message_id).catch(() => { });
        if (triggerId) await markSnipeTriggerFailed(triggerId, err?.message ?? 'buy_failed').catch(() => { });
        const msg = err?.message ?? '';
        const isAwaitingLiq = /no liquidity|not yet tradable|reserves.*positive|bonding phase/i.test(msg);
        if (isAwaitingLiq) {
          await ctx.reply(
            `🎯 *Snipe Armed!*\n\n` +
            `🪙 Token: \`${tokenAddress}\`\n` +
            `💰 Amount: \`${amt} ${unit}\`\n\n` +
            `Pool is registered but awaiting liquidity — your snipe order is armed and will fire automatically the instant liquidity appears!`,
            { parse_mode: 'Markdown' }
          ).catch(() => { });
        } else {
          await markSnipeOrderResult(order.id, false, err?.message ?? 'buy_failed').catch(() => { });
          await ctx.reply(`❌ Snipe failed: ${getUserFriendlyError(err)}`).catch(() => { });
        }
      }
    } else {
      await ctx.reply(
        `🎯 *Snipe Armed!*\n\n` +
        `🪙 Token: \`${tokenAddress}\`\n` +
        `💰 Amount: \`${amt} ${unit}\`\n\n` +
        `The token is not tradable yet — your snipe fires automatically the moment a pool goes live. No need to watch the chart.`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [cb('❌ Cancel Snipe Order', `snipe_order_cancel:${order.id}`, 'danger')],
              [cb('📋 My Snipe Orders', 'snipe_orders', 'primary'), cb('🎯 Snipe Rules', 'menu_snipe', 'primary')],
            ],
          },
        }
      ).catch(() => { });
    }
  }

  bot.action(/^snipe_time:now:(.+)$/, async (ctx) => {
    const amt = parseFloat(ctx.match[1]);
    const telegramId = ctx.from!.id;
    const cache = snipeSetupCache.get(telegramId);
    const pending = userPendingActions.get(telegramId);
    userPendingActions.delete(telegramId);
    snipeSetupCache.delete(telegramId);
    const tokenAddress = pending?.tokenAddress || cache?.tokenAddress;
    const finalAmt = isNaN(amt) ? (pending?.snipeAmount || cache?.amt || 0) : amt;
    if (!tokenAddress || finalAmt <= 0) {
      await ctx.answerCbQuery('Session expired. Please start over.').catch(() => { });
      return;
    }
    await ctx.answerCbQuery().catch(() => { });
    await completeSnipeOrderCreation(ctx, telegramId, tokenAddress, finalAmt, null);
  });

  bot.action(/^snipe_time:delay:(\d+):(.+)$/, async (ctx) => {
    const mins = parseInt(ctx.match[1], 10);
    const amt = parseFloat(ctx.match[2]);
    const telegramId = ctx.from!.id;
    const cache = snipeSetupCache.get(telegramId);
    const pending = userPendingActions.get(telegramId);
    userPendingActions.delete(telegramId);
    snipeSetupCache.delete(telegramId);
    const tokenAddress = pending?.tokenAddress || cache?.tokenAddress;
    const finalAmt = isNaN(amt) ? (pending?.snipeAmount || cache?.amt || 0) : amt;
    if (!tokenAddress || finalAmt <= 0) {
      await ctx.answerCbQuery('Session expired. Please start over.').catch(() => { });
      return;
    }
    await ctx.answerCbQuery().catch(() => { });
    const executeAfter = new Date(Date.now() + mins * 60_000);
    await completeSnipeOrderCreation(ctx, telegramId, tokenAddress, finalAmt, executeAfter);
  });

  bot.action(/^snipe_time:custom:(.+)$/, async (ctx) => {
    const amt = parseFloat(ctx.match[1]);
    const telegramId = ctx.from!.id;
    const cache = snipeSetupCache.get(telegramId);
    const pending = userPendingActions.get(telegramId);
    const tokenAddress = pending?.tokenAddress || cache?.tokenAddress;
    const finalAmt = isNaN(amt) ? (pending?.snipeAmount || cache?.amt || 0) : amt;
    if (!tokenAddress || finalAmt <= 0) {
      await ctx.answerCbQuery('Session expired. Please start over.').catch(() => { });
      return;
    }
    userPendingActions.set(telegramId, {
      action: 'snipe_custom_time',
      tokenAddress,
      snipeAmount: finalAmt,
      expiresAt: Date.now() + 600_000,
    });
    if (cache) {
      cache.expiresAt = Date.now() + 600_000;
    }
    await ctx.answerCbQuery().catch(() => { });
    const currentUtc = formatUtcTime();
    await ctx.reply(
      `🕒 *Enter Scheduled Time (UTC)*\n\n` +
      `🪙 Token: \`${tokenAddress}\`\n` +
      `💰 Amount: \`${finalAmt} ${snipeUnit(tokenAddress)}\`\n` +
      `Current Time: \`${currentUtc}\`\n\n` +
      `Reply with the exact time in UTC when you want the snipe to trigger.\n\n` +
      `*Accepted formats:*\n` +
      `• \`19:23\` or \`7:23 PM\` (today in UTC)\n` +
      `• \`+10m\` or \`15 mins\` (delay from now)\n` +
      `• \`2026-10-08 19:23\` (specific UTC date & time)\n\n` +
      `Type /cancel to abort.`,
      { parse_mode: 'Markdown' }
    ).catch(() => { });
  });

  bot.action('snipe_time:cancel', async (ctx) => {
    const telegramId = ctx.from!.id;
    userPendingActions.delete(telegramId);
    snipeSetupCache.delete(telegramId);
    await ctx.answerCbQuery('Cancelled.').catch(() => { });
    await ctx.editMessageText('❌ Snipe order setup cancelled.').catch(async () => {
      await ctx.reply('❌ Snipe order setup cancelled.').catch(() => { });
    });
  });

  bot.action('snipe_token_start', async (ctx) => {
    const telegramId = ctx.from!.id;
    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) {
      await ctx.answerCbQuery('Please run /start first.').catch(() => { });
      return;
    }
    const activeCount = await countActiveSnipeOrders(user.id).catch(() => 0);
    if (activeCount >= MAX_ACTIVE_SNIPE_ORDERS_PER_USER) {
      await ctx.answerCbQuery(`Max ${MAX_ACTIVE_SNIPE_ORDERS_PER_USER} active snipe orders — cancel one first.`).catch(() => { });
      return;
    }
    userPendingActions.set(telegramId, { action: 'snipe_token_ca', expiresAt: Date.now() + 120_000 });
    await ctx.answerCbQuery().catch(() => { });
    await ctx.reply(
      `🎯 *Snipe by Token CA*\n\n` +
      `Reply with the token contract address:\n` +
      `_e.g. \`token.nearlytrade.near\` on NEAR, or a Solana mint_\n\n` +
      `• Already tradable → buys *immediately*\n` +
      `• Not launched yet → stays *armed* until live\n\n` +
      `Type /cancel to abort.`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.action(/^snipe_token_quick:(.+)$/, async (ctx) => {
    const shortKey = (ctx as any).match[1];
    const tokenAddress = resolveTokenAddressFromKey(shortKey);
    const telegramId = ctx.from!.id;
    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) {
      await ctx.answerCbQuery('Please run /start first.').catch(() => { });
      return;
    }
    const activeCount = await countActiveSnipeOrders(user.id).catch(() => 0);
    if (activeCount >= MAX_ACTIVE_SNIPE_ORDERS_PER_USER) {
      await ctx.answerCbQuery(`Max ${MAX_ACTIVE_SNIPE_ORDERS_PER_USER} active snipe orders — cancel one first.`).catch(() => { });
      return;
    }
    userPendingActions.set(telegramId, { action: 'snipe_token_amount', tokenAddress, expiresAt: Date.now() + 120_000 });
    await ctx.answerCbQuery().catch(() => { });
    const quickIsSol = isSolanaAddress(tokenAddress);
    const meta = quickIsSol
      ? await getSolanaTokenInfo(tokenAddress).catch(() => null)
      : await near.getTokenMetadata(tokenAddress).catch(() => null);
    const sym = meta?.symbol || tokenAddress;
    const isUsdc = !quickIsSol && user.near_trade_currency === 'usdc';
    const unit = quickIsSol ? 'SOL' : (isUsdc ? 'USDC' : 'NEAR');
    const exampleAmt = quickIsSol ? '0.25' : (isUsdc ? '10' : '2.5');
    await ctx.reply(
      `🎯 *Snipe ${sanitizeMd(sym)}*\n\n` +
      `Contract: \`${tokenAddress}\`\n\n` +
      `Reply with the amount in ${unit} to snipe (e.g. \`${exampleAmt}\`):\n` +
      `Type /cancel to abort.`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.action('snipe_dev_start', async (ctx) => {
    const telegramId = ctx.from!.id;
    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) {
      await ctx.answerCbQuery('Please run /start first.').catch(() => { });
      return;
    }
    const activeCount = await countActiveSnipeOrders(user.id).catch(() => 0);
    if (activeCount >= MAX_ACTIVE_SNIPE_ORDERS_PER_USER) {
      await ctx.answerCbQuery(`Max ${MAX_ACTIVE_SNIPE_ORDERS_PER_USER} active snipe orders — cancel one first.`).catch(() => { });
      return;
    }
    userPendingActions.set(telegramId, { action: 'snipe_dev_addr', expiresAt: Date.now() + 120_000 });
    await ctx.answerCbQuery().catch(() => { });
    await ctx.reply(
      `👤 *Snipe by Deployer*\n\n` +
      `Reply with the dev's wallet address:\n` +
      `_e.g. \`someuser.near\`, or a Solana wallet (pump.fun launches)_\n\n` +
      `Every new token from that wallet\n` +
      `will be auto-bought until you cancel.\n\n` +
      `Type /cancel to abort.`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.action('snipe_orders', async (ctx) => {
    const telegramId = ctx.from!.id;
    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) {
      await ctx.answerCbQuery('Please run /start first.').catch(() => { });
      return;
    }
    const orders = await getSnipeOrdersByUser(user.id).catch(() => []);
    await ctx.answerCbQuery().catch(() => { });
    if (orders.length === 0) {
      await ctx.reply(
        `📋 *Snipe Orders*\n\n` +
        `No orders yet.\n` +
        `Use 🎯 Snipe Token CA or 👤 Snipe by Dev to arm a snipe.`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [cb('🎯 Snipe Token CA', 'snipe_token_start', 'success'), cb('👤 Snipe by Dev', 'snipe_dev_start', 'success')],
              [cb('🔙 Back to Snipe Rules', 'menu_snipe', 'primary')],
            ],
          },
        }
      );
      return;
    }
    const statusEmoji: Record<string, string> = { active: '🟢', filled: '✅', cancelled: '⚪', failed: '🔴' };
    const lines = orders.map((o) => {
      const target = o.snipe_type === 'token' ? `🪙 \`${o.token_address}\`` : `👤 \`${o.deployer_address}\``;
      const extra = o.snipe_type === 'deployer' && o.trigger_count > 0 ? ` · fired ${o.trigger_count}×` : '';
      const timing = o.status === 'active' && o.execute_after && new Date(o.execute_after) > new Date()
        ? ` · ⏰ ${formatUtcTime(new Date(o.execute_after))}`
        : '';
      const err = o.status === 'failed' && o.last_error ? `\n   └ _${o.last_error.slice(0, 60)}_` : '';
      const unit = o.trade_currency ? o.trade_currency.toUpperCase() : snipeUnit(o.token_address || o.deployer_address || '', user);
      return `${statusEmoji[o.status] ?? '•'} ${target} — *${o.amount_near} ${unit}*${timing}${extra}${err}`;
    });

    const buttons: any[] = [];
    for (const o of orders) {
      const targetShort = (o.token_address || o.deployer_address || 'order').slice(0, 25);
      const icon = statusEmoji[o.status] ?? '•';
      if (o.status === 'active') {
        buttons.push([
          cb(`🔍 View ${icon} ${targetShort}`, `snipe_order_view:${o.id}`, 'primary'),
          cb(`❌ Cancel`, `snipe_order_cancel:${o.id}`, 'danger'),
        ]);
      } else {
        buttons.push([
          cb(`🔍 View ${icon} ${targetShort}`, `snipe_order_view:${o.id}`, 'primary'),
          cb(`🗑️ Remove`, `snipe_order_delete:${o.id}`, 'primary'),
        ]);
      }
    }
    buttons.push([
      cb('🎯 Snipe Token CA', 'snipe_token_start', 'success'),
      cb('👤 Snipe by Dev', 'snipe_dev_start', 'success'),
    ]);
    buttons.push([cb('🔙 Back to Snipe Rules', 'menu_snipe', 'primary')]);

    const text = `📋 *Snipe Orders (${orders.length})*\n\nTap any order below to view details or manage:\n\n` + lines.join('\n');
    await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }).catch(async () => {
      await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }).catch(() => { });
    });
  });

  bot.action(/^snipe_order_view:(.+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const orderId = ctx.match![1];
    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) {
      await ctx.answerCbQuery('Please run /start first.').catch(() => { });
      return;
    }
    const o = await getSnipeOrderById(orderId, user.id).catch(() => null);
    await ctx.answerCbQuery().catch(() => { });
    if (!o) {
      await ctx.reply('❌ Snipe order not found.', {
        reply_markup: { inline_keyboard: [[cb('📋 Back to Snipe Orders', 'snipe_orders', 'primary')]] },
      });
      return;
    }
    const statusText: Record<string, string> = {
      active: '🟢 Active (Waiting for Launch / Liquidity)',
      filled: '✅ Filled (Auto-Buy Completed)',
      cancelled: '⚪ Cancelled',
      failed: '🔴 Failed',
    };
    const targetLabel = o.snipe_type === 'token' ? 'Token Contract Address' : 'Deployer Wallet Address';
    const targetVal = o.snipe_type === 'token' ? o.token_address : o.deployer_address;
    const dateStr = o.created_at ? new Date(o.created_at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'N/A';
    const timingStr = o.execute_after
      ? (new Date(o.execute_after) > new Date()
        ? `⏰ Scheduled for ${formatUtcDateTime(new Date(o.execute_after))}`
        : `⏰ Triggered after ${formatUtcDateTime(new Date(o.execute_after))}`)
      : '⚡ Immediate on Liquidity';

    let errText = '';
    if (o.status === 'failed' && o.last_error) {
      errText = `\n• *Last Failure Reason*: \`${o.last_error}\``;
    }

    const orderUnit = o.trade_currency ? o.trade_currency.toUpperCase() : snipeUnit(o.token_address || o.deployer_address || '', user);
    const text =
      `🎯 *Snipe Order Details*\n\n` +
      `• *Status*: ${statusText[o.status] ?? o.status}\n` +
      `• *${targetLabel}*: \`${targetVal}\`\n` +
      `• *Amount*: \`${o.amount_near} ${orderUnit}\`\n` +
      `• *Trigger Timing*: \`${timingStr}\`\n` +
      `• *Type*: \`${o.snipe_type}\`\n` +
      `• *Created*: ${dateStr}${errText}\n\n` +
      `Use the options below to manage this order:`;

    const buttons: any[] = [];
    if (o.status === 'active') {
      buttons.push([cb('❌ Cancel Snipe Order', `snipe_order_cancel:${o.id}`, 'danger')]);
    } else {
      buttons.push([cb('🗑️ Remove Order from History', `snipe_order_delete:${o.id}`, 'danger')]);
    }
    buttons.push([
      cb('📋 Back to Snipe Orders', 'snipe_orders', 'primary'),
      cb('🎯 Back to Snipe Rules', 'menu_snipe', 'primary'),
    ]);

    await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }).catch(async () => {
      await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }).catch(() => { });
    });
  });

  bot.action(/^snipe_order_cancel:(.+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const orderId = ctx.match![1];
    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) {
      await ctx.answerCbQuery('Please run /start first.').catch(() => { });
      return;
    }
    const ok = await cancelSnipeOrder(orderId, user.id).catch(() => false);
    await ctx.answerCbQuery(ok ? 'Snipe order cancelled.' : 'Order not found or already closed.').catch(() => { });
    const buttons = [
      [cb('📋 Back to Snipe Orders', 'snipe_orders', 'primary'), cb('🎯 Snipe Rules', 'menu_snipe', 'primary')],
    ];
    if (ok) {
      await ctx.editMessageText('✅ *Snipe Order Cancelled Successfully.*\n\nYour order has been stopped and marked as cancelled.', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: buttons },
      }).catch(async () => {
        await ctx.reply('✅ *Snipe Order Cancelled Successfully.*', {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: buttons },
        }).catch(() => { });
      });
    }
  });

  bot.action(/^snipe_order_delete:(.+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const orderId = ctx.match![1];
    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) {
      await ctx.answerCbQuery('Please run /start first.').catch(() => { });
      return;
    }
    const ok = await deleteSnipeOrder(orderId, user.id).catch(() => false);
    await ctx.answerCbQuery(ok ? 'Order removed.' : 'Order not found.').catch(() => { });
    const buttons = [
      [cb('📋 Back to Snipe Orders', 'snipe_orders', 'primary'), cb('🎯 Snipe Rules', 'menu_snipe', 'primary')],
    ];
    if (ok) {
      await ctx.editMessageText('🗑️ *Order Removed from History.*', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: buttons },
      }).catch(async () => {
        await ctx.reply('🗑️ *Order Removed from History.*', {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: buttons },
        }).catch(() => { });
      });
    }
  });

  bot.action(['menu_points', 'menu_points_refresh'], async (ctx) => {
    const telegramId = ctx.from!.id;
    try {
      const view = await buildPointsView(telegramId);
      await ctx.answerCbQuery().catch(() => { });
      await ctx.editMessageText(view.text, { parse_mode: 'Markdown', ...view.keyboard }).catch(async () => {
        await ctx.reply(view.text, { parse_mode: 'Markdown', ...view.keyboard }).catch(() => { });
      });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  bot.command(['points', 'leaderboard'], async (ctx) => {
    const telegramId = ctx.from!.id;
    try {
      const view = await buildPointsView(telegramId);
      await ctx.reply(view.text, { parse_mode: 'Markdown', ...view.keyboard }).catch(() => { });
    } catch (err: any) {
      await ctx.reply(getUserFriendlyError(err)).catch(() => { });
    }
  });

  // ── Helper: Build Holdings view (text + keyboard) ─────────────────────────
  // forceRefresh=false renders from cache (instant paint); forceRefresh=true
  // pulls live pool prices (background reconcile pass).
  // ── Helper: Build Holdings view (text + keyboard) with Pagination ─────────
  // forceRefresh=false renders from cache (instant paint); forceRefresh=true
  // pulls live pool prices (background reconcile pass).
  async function buildHoldingsView(user: UserRecord, forceRefresh: boolean, page = 0) {
    // Fetch all open positions (including previously synced wallet deposits)
    let positions: PositionRecord[] = await getOpenPositions(user.id).catch(() => []);

    // Filter positions according to user's visible chains
    positions = positions.filter((pos) => {
      const chain = getPositionChain(pos);
      return isChainVisible(user, chain);
    });

    const emptyKeyboard = Markup.inlineKeyboard([
      [
        cb('🔄 Refresh', 'refresh_holdings:0', 'primary'),
        cb('➕ Import', 'import_token_prompt', 'primary'),
      ],
      [
        cb('💳 Wallet', 'menu_wallet', 'primary'),
        cb('🔙 Main Menu', 'menu_home', 'primary'),
      ],
      [
        Markup.button.url('💬 Community', 'https://t.me/racerbot_community'),
        Markup.button.url('📢 Updates', 'https://t.me/racertrading'),
        Markup.button.url('𝕏 X', 'https://x.com/racertradingbot'),
      ],
    ]);

    // Live on-chain balance reconciliation:
    // Only update quantity_held if verified by a successful RPC call.
    // NEVER close positions on timeout, error, or unverified zero!
    // ONLY run on-chain reconciliation when forceRefresh is true!
    if (forceRefresh && positions.length > 0) {
      const balanceChecks = await Promise.allSettled(
        positions.map(async (pos) => {
          // Solana positions are reconciled by syncUserTokenDeposits (one free Jupiter call per wallet).
          if (pos.chain === 'solana' || isSolanaToken(pos.token_address)) {
            return { isZero: false, rawBal: pos.quantity_held, verified: false };
          }
          const isStarknetPos = pos.chain === 'starknet' || isStarknetToken(pos.token_address);
          const isSuiPos = pos.chain === 'sui' || isSuiToken(pos.token_address);
          const isEvmPos = pos.chain === 'hyperevm' || pos.chain === 'elysium' || isValidEvmAddress(pos.token_address);
          if (isEvmPos) {
            return { isZero: false, rawBal: pos.quantity_held, verified: false };
          }
          if (isStarknetPos) {
            if (!user.starknet_address) return { isZero: false, rawBal: pos.quantity_held, verified: false };
            try {
              const bal = await Promise.race([
                getStarknetTokenBalance(user.starknet_address, pos.token_address),
                new Promise<bigint>((_, reject) =>
                  setTimeout(() => reject(new Error('timeout')), 2000)
                ),
              ]);
              const isZero = bal === 0n;
              return { isZero, rawBal: bal.toString(), verified: true };
            } catch {
              return { isZero: false, rawBal: pos.quantity_held, verified: false };
            }
          } else if (isSuiPos) {
            if (!user.sui_address) return { isZero: false, rawBal: pos.quantity_held, verified: false };
            try {
              const bal = await Promise.race([
                getSuiTokenBalance(user.sui_address, pos.token_address),
                new Promise<{ raw: bigint; uiAmount: number }>((_, reject) =>
                  setTimeout(() => reject(new Error('timeout')), 2000)
                ),
              ]);
              const isZero = bal.raw === 0n || bal.uiAmount < 0.000001;
              return { isZero, rawBal: bal.raw.toString(), verified: true };
            } catch {
              return { isZero: false, rawBal: pos.quantity_held, verified: false };
            }
          } else {
            if (!user.subaccount_id) return { isZero: false, rawBal: pos.quantity_held, verified: false };
            try {
              const rawBal = await Promise.race([
                near.getTokenBalance(pos.token_address, user.subaccount_id),
                new Promise<string>((_, reject) =>
                  setTimeout(() => reject(new Error('timeout')), 2000)
                ),
              ]);
              const clean = String(rawBal || '0').replace(/["'\s]/g, '').split('.')[0] || '0';
              let rawBig = 0n;
              try { rawBig = BigInt(clean); } catch { rawBig = 0n; }
              // Decimals-aware dust is handled later by the holdings dust filter;
              // a raw `< 1e6` cutoff here closed real low-decimal balances (USDC etc.).
              const isZero = rawBig === 0n;
              return { isZero, rawBal: clean, verified: true };
            } catch {
              // Never assume zero on error/timeout!
              return { isZero: false, rawBal: pos.quantity_held, verified: false };
            }
          }
        })
      );

      const activePositions: PositionRecord[] = [];
      for (let i = 0; i < positions.length; i++) {
        const check = balanceChecks[i];
        const pos = positions[i];
        if (check.status === 'fulfilled' && check.value.verified) {
          const { isZero, rawBal } = check.value;
          // If verified zero or dust on-chain, CLOSE the position completely!
          if (isZero) {
            await updatePosition({
              position_id: pos.id,
              status: 'closed',
              closed_at: new Date(),
              quantity_held: '0',
            }).catch(() => { });
            console.log(`[HOLDINGS] Cleared confirmed zero balance token ${pos.token_address} (user ${user.id})`);
            continue;
          } else if (rawBal && rawBal !== pos.quantity_held) {
            pos.quantity_held = rawBal;
            updatePosition({
              position_id: pos.id,
              quantity_held: rawBal,
            }).catch(() => { });
          }
        }
        activePositions.push(pos);
      }
      positions = activePositions;
    }

    if (positions.length === 0) {
      const emptyMsg =
        '💼 *Holdings (0)*\n' +
        '💰 Total: `$0.00`\n\n' +
        '📭 You currently have no token holdings in your wallet.\n\n' +
        'Deposit tokens to your wallet address or paste a token CA into chat to start trading!';
      return { msg: emptyMsg, keyboard: emptyKeyboard };
    }

    // High-speed batch load of all token info (in-memory cache + DB cache)
    const tokenAddresses = Array.from(new Set(positions.map(p => p.token_address)));
    const infoMap = await getBatchTokenInfo(tokenAddresses, forceRefresh);

    // Only query fills for positions that lack entry price (avg_entry_price <= 0)
    const positionsNeedingFills = positions.filter(p => !p.avg_entry_price || parseFloat(p.avg_entry_price) <= 0);
    const fillsMap = new Map<string, any[]>();
    if (positionsNeedingFills.length > 0) {
      await Promise.allSettled(
        positionsNeedingFills.map(async (pos) => {
          const fills = await getFillsByPosition(pos.id).catch(() => []);
          fillsMap.set(pos.id, fills);
        })
      );
    }

    // Calculate total portfolio USD across all positions
    let totalPortfolioValueUsd = 0;
    const computedPositions = positions.map((pos, idx) => {
      const info = infoMap.get(pos.token_address);
      const rawSymbol = info?.symbol || (pos.token_address.length > 14 ? pos.token_address.slice(0, 12) + '...' : pos.token_address);
      const displayLabel = sanitizeMd(rawSymbol);
      const currentPrice = info ? parseFloat(info.price) : 0;
      const posChain = getPositionChain(pos);
      const isSuiPos = posChain === 'sui';
      const isStarknetPos = posChain === 'starknet';
      const isSolanaPosH = posChain === 'solana';
      const isEvmPosH = posChain === 'hyperevm' || posChain === 'elysium';
      const decimals = info?.decimals ?? (isSolanaPosH ? 6 : isSuiPos ? 9 : 18);
      const nativeUsdRate = isSolanaPosH
        ? (info?.sol_usd || 150)
        : isStarknetPos
          ? (info?.strk_usd || 0.12)
          : isSuiPos
            ? (info?.sui_usd || 2.0)
            : isEvmPosH
              ? (info?.hype_usd || 25.0)
              : (info?.near_usd || 4.3);

      let humanQuantity = 0;
      try {
        const rawBig = BigInt((pos.quantity_held || '0').split('.')[0]);
        if (isStarknetPos && (pos.quantity_held || '').includes('.') && Number(rawBig) < 1e10) {
          humanQuantity = parseFloat(pos.quantity_held) || 0;
        } else {
          humanQuantity = Number(rawBig) / Math.pow(10, decimals);
        }
      } catch {
        humanQuantity = parseFloat(pos.quantity_held) || 0;
      }

      const parsedInfoUsd = info?.price_usd ? parseFloat(info.price_usd) : 0;
      const tokenPriceUsd = parsedInfoUsd > 0 ? parsedInfoUsd : (currentPrice * nativeUsdRate);
      const tokenValueUsd = humanQuantity * tokenPriceUsd;

      // Dust filter:
      // If quantity is negligible or value is < $0.001 while quantity is tiny (< 0.000001),
      // this is sold dust. Auto-close position in background and omit from holdings list!
      let rawBigCheck = 0n;
      try { rawBigCheck = BigInt((pos.quantity_held || '0').split('.')[0]); } catch { }
      const isDust = rawBigCheck <= 0n || humanQuantity <= 0 || (currentPrice > 0 && tokenValueUsd < 0.001 && humanQuantity < 0.000001);
      if (isDust) {
        updatePosition({
          position_id: pos.id,
          status: 'closed',
          closed_at: new Date(),
          quantity_held: '0',
        }).catch(() => { });
        return null;
      }

      totalPortfolioValueUsd += tokenValueUsd;

      const fills = fillsMap.get(pos.id) || [];
      const buys = fills.filter((f: any) => f.side === 'buy' && !f.tx_hash?.startsWith('deposit_'));

      let totalBuyTokensHuman = 0;
      let totalBuyCostNative = 0;

      for (const buy of buys) {
        const val = parseFloat(buy.amount || '0');
        let amount = val;
        const rawAmtStr = String(buy.amount || '');
        if (isStarknetPos) {
          amount = rawAmtStr.includes('.') && val < 1e10 ? val : val / Math.pow(10, decimals);
        } else if (decimals > 0 && (buy.input_amount != null || !rawAmtStr.includes('.') || val > 1e10)) {
          amount = val / Math.pow(10, decimals);
        } else if (isSuiPos && val > 1e6) {
          amount = val / Math.pow(10, decimals);
        }

        let cost = 0;
        if (buy.input_amount != null && parseFloat(buy.input_amount) > 0) {
          cost = parseFloat(buy.input_amount);
        } else {
          const p = parseFloat(buy.price || '0');
          let fee = parseFloat(buy.fee_paid || '0');
          if (isSuiPos && fee > 1e6) fee = fee / 1e9;
          else if (!isSuiPos && fee > 1e18) fee = fee / 1e24;
          cost = amount * p + fee;
        }

        if (amount > 0 && cost > 0) {
          totalBuyTokensHuman += amount;
          totalBuyCostNative += cost;
        }
      }

      let entryPrice = parseFloat(pos.avg_entry_price) || 0;
      if (totalBuyTokensHuman > 0 && totalBuyCostNative > 0) {
        const fillAvgEntry = totalBuyCostNative / totalBuyTokensHuman;
        if (
          entryPrice <= 0 ||
          entryPrice > 1e6 ||
          (currentPrice > 0 && entryPrice > currentPrice * 10 && fillAvgEntry <= currentPrice * 10) ||
          Math.abs(entryPrice - fillAvgEntry) / fillAvgEntry > 0.5
        ) {
          entryPrice = fillAvgEntry;
          pos.avg_entry_price = fillAvgEntry.toString();
          updatePosition({
            position_id: pos.id,
            avg_entry_price: fillAvgEntry.toString(),
          }).catch(() => { });
        }
      } else if ((entryPrice <= 0 || entryPrice > 1e6) && currentPrice > 0) {
        entryPrice = currentPrice;
        pos.avg_entry_price = currentPrice.toString();
        updatePosition({
          position_id: pos.id,
          avg_entry_price: currentPrice.toString(),
        }).catch(() => { });
      }

      let pnlDisplay = '+0.0%';
      let emoji = '⚪';
      let pnlStyle: BtnStyle | undefined = undefined;

      if (currentPrice > 0 && entryPrice > 0) {
        const pnlPctNum = ((currentPrice - entryPrice) / entryPrice) * 100;
        if (pnlPctNum > 0) {
          pnlStyle = 'success';
          if (pnlPctNum >= 500) emoji = '🔥';
          else if (pnlPctNum >= 100) emoji = '🚀';
          else emoji = '🟢';
        } else if (pnlPctNum < 0) {
          pnlStyle = 'danger';
          emoji = '🔴';
        } else {
          emoji = '⚪';
        }
        pnlDisplay = `${pnlPctNum >= 0 ? '+' : ''}${pnlPctNum.toFixed(1)}%`;
      } else if (currentPrice > 0 && entryPrice <= 0) {
        pnlDisplay = '+0.0%';
        emoji = '⚪';
      } else {
        pnlDisplay = 'N/A';
        emoji = '⚪';
      }

      const compactSym = displayLabel.length > 8 ? `${displayLabel.slice(0, 7)}…` : displayLabel;
      const rawLabel = `${emoji} ${compactSym} (${pnlDisplay})`;
      const cappedLabel = rawLabel.length > 20 ? `${rawLabel.slice(0, 19)}…` : rawLabel;

      const formattedQty = formatHoldingQuantity(pos.quantity_held, decimals);

      return {
        pos,
        displayLabel,
        formattedQty,
        cappedLabel,
        pnlDisplay,
        pnlStyle,
        tokenValueUsd,
        emoji,
      };
    });

    const filteredPositions = computedPositions.filter((item): item is NonNullable<typeof item> => item !== null);

    if (filteredPositions.length === 0) {
      const emptyMsg =
        '💼 *Holdings (0)*\n' +
        '💰 Total: `$0.00`\n\n' +
        '📭 You currently have no token holdings in your wallet.\n\n' +
        'Deposit tokens to your wallet address or paste a token CA into chat to start trading!';
      return { msg: emptyMsg, keyboard: emptyKeyboard };
    }

    // Pagination: 8 tokens per page (2 per row = 4 rows max for clean, non-busy screen)
    const PAGE_SIZE = 8;
    const totalPositions = filteredPositions.length;
    const totalPages = Math.max(1, Math.ceil(totalPositions / PAGE_SIZE));
    const currentPage = Math.min(Math.max(0, page), totalPages - 1);
    const startIdx = currentPage * PAGE_SIZE;
    const pageItems = filteredPositions.slice(startIdx, startIdx + PAGE_SIZE);

    const buttons: any[] = [];

    // 1. REFRESH & ACTION BAR AT THE VERY TOP — users see and tap refresh immediately!
    buttons.push([
      Markup.button.callback('🔄 Refresh', `refresh_holdings:${currentPage}`),
      Markup.button.callback('➕ Import Token', 'import_token_prompt'),
    ]);

    // 2. TOKEN HOLDINGS GRID (2 per row — slim, dual-column, not covering whole screen width per token)
    for (let i = 0; i < pageItems.length; i += 2) {
      const row: any[] = [cb(pageItems[i].cappedLabel, `token_detail:${pageItems[i].pos.id}`, pageItems[i].pnlStyle)];
      if (i + 1 < pageItems.length) {
        row.push(cb(pageItems[i + 1].cappedLabel, `token_detail:${pageItems[i + 1].pos.id}`, pageItems[i + 1].pnlStyle));
      }
      buttons.push(row);
    }

    // 3. PAGINATION (if multiple pages)
    if (totalPages > 1) {
      const navRow: any[] = [];
      if (currentPage > 0) {
        navRow.push(Markup.button.callback('◀️ Prev', `holdings_page:${currentPage - 1}`));
      }
      navRow.push(Markup.button.callback(`📄 ${currentPage + 1}/${totalPages}`, `holdings_page:${currentPage}`));
      if (currentPage < totalPages - 1) {
        navRow.push(Markup.button.callback('Next ▶️', `holdings_page:${currentPage + 1}`));
      }
      buttons.push(navRow);
    }

    const lines = pageItems.map(item => {
      const valStr = item.tokenValueUsd >= 1000
        ? `$${(item.tokenValueUsd / 1000).toFixed(2)}K`
        : item.tokenValueUsd >= 0.01
          ? `$${item.tokenValueUsd.toFixed(2)}`
          : item.tokenValueUsd > 0
            ? formatCryptoPrice(item.tokenValueUsd, '$')
            : '$0.00';
      return `${item.emoji} *${item.displayLabel}*: \`${item.formattedQty}\` • \`${valStr}\` (${item.pnlDisplay})`;
    }).join('\n');

    const totalUsdDisplay = totalPortfolioValueUsd >= 1000
      ? `$${(totalPortfolioValueUsd / 1000).toFixed(2)}K`
      : totalPortfolioValueUsd >= 0.01
        ? `$${totalPortfolioValueUsd.toFixed(2)}`
        : totalPortfolioValueUsd > 0
          ? formatCryptoPrice(totalPortfolioValueUsd, '$')
          : `$0.00`;

    const pageHeader = totalPages > 1 ? ` (Page ${currentPage + 1}/${totalPages})` : '';
    const msg =
      `💼 *Holdings (${totalPositions})*${pageHeader}\n` +
      `💰 Total: \`${totalUsdDisplay}\`\n\n` +
      `${lines}\n\n` +
      `_Tap a token below to view details & trade._`;

    // 4. NAVIGATION
    buttons.push([
      cb('💳 Wallet', 'menu_wallet', 'primary'),
      cb('🔙 Main Menu', 'menu_home', 'primary'),
    ]);
    buttons.push([
      Markup.button.url('💬 Community', 'https://t.me/racerbot_community'),
      Markup.button.url('📢 Updates', 'https://t.me/racertrading'),
      Markup.button.url('𝕏 X', 'https://x.com/racertradingbot'),
    ]);

    const keyboard = Markup.inlineKeyboard(buttons);
    return { msg, keyboard };
  }

  // ── Helper: Render & Display Holdings — instant paint + background reconcile ─
  async function handleHoldings(ctx: Context, isRefresh = false, page = 0) {
    const telegramId = ctx.from!.id;
    try {
      const user = await getUserByTelegramId(telegramId);
      if (!user) {
        if (typeof (ctx as any).answerCbQuery === 'function') {
          await (ctx as any).answerCbQuery('Please run /start first.').catch(() => { });
        } else {
          await ctx.reply('Please run /start first.').catch(() => { });
        }
        return;
      }

      if (typeof (ctx as any).answerCbQuery === 'function') {
        await (ctx as any).answerCbQuery(isRefresh ? '🔄 Refreshing...' : '💼 Loading holdings...').catch(() => { });
      }

      // 1. Build holdings view immediately (fast paint without blocking on background scans)
      const view = await buildHoldingsView(user, isRefresh, page);

      const canEditMsg = typeof (ctx as any).editMessageText === 'function';
      if (canEditMsg) {
        await (ctx as any).editMessageText(view.msg, { parse_mode: 'Markdown', ...view.keyboard })
          .catch(async (err: any) => {
            if (err?.message?.includes('message is not modified')) return;
            await ctx.reply(view.msg, { parse_mode: 'Markdown', ...view.keyboard }).catch(() => { });
          });
      } else {
        await ctx.reply(view.msg, { parse_mode: 'Markdown', ...view.keyboard }).catch(() => { });
      }

      // 2. Background wallet deposit sync (detached — does not delay rendering)
      syncUserTokenDeposits(user.id, user.subaccount_id, isRefresh).catch((err) => {
        console.warn(`[HOLDINGS] Background deposit sync error for ${user.subaccount_id}:`, err?.message || err);
      });
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => { });
    }
  }

  // ── menu_holdings — Token list with name/logo and % change ────────────────
  bot.action('menu_holdings', async (ctx) => {
    try {
      await handleHoldings(ctx, false, 0);
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  bot.action(/^holdings_page:(\d+)$/, async (ctx) => {
    try {
      const page = parseInt(ctx.match![1], 10) || 0;
      await (ctx as any).answerCbQuery?.().catch(() => { });
      await handleHoldings(ctx, false, page);
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  bot.action(/^refresh_holdings(?::(\d+))?$/, async (ctx) => {
    try {
      const page = ctx.match?.[1] ? parseInt(ctx.match[1], 10) : 0;
      await (ctx as any).answerCbQuery?.('🔄 Refreshing holdings...').catch(() => { });
      await handleHoldings(ctx, true, page);
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  bot.action('menu_holdings_refresh', async (ctx) => {
    try {
      await (ctx as any).answerCbQuery?.('🔄 Refreshing holdings...').catch(() => { });
      await handleHoldings(ctx, true, 0);
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  bot.command(['holdings', 'bags', 'positions'], async (ctx) => {
    try {
      await handleHoldings(ctx, false, 0);
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => { });
    }
  });

  // ── import_token_prompt — Prompt user to paste token CA ───────────────────────
  bot.action('import_token_prompt', async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => { });
      const telegramId = ctx.from!.id;
      userPendingActions.set(telegramId, {
        action: 'import_token',
        expiresAt: Date.now() + 2 * 60 * 1000, // 2 minutes expiry
      });
      await ctx.reply(
        '📝 *Import Token*\n\n' +
        'Please paste the token contract address (CA) you want to import.\n\n' +
        'Supported chains:\n' +
        '• *NEAR*: `token.near` or contract account ID\n' +
        '• *SUI*: `0x...::coin::COIN`\n' +
        '• *Starknet*: `0x0...`\n\n' +
        '_Send the address within 2 minutes to import it into your holdings._',
        { parse_mode: 'Markdown' }
      ).catch(() => { });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  // ── token_detail — Individual token detail modal with PNL card ────────────────
  bot.action(/^token_detail:([^:]+)(?::([01]))?$/, async (ctx) => {
    const positionId = ctx.match![1];
    const nwParam = ctx.match![2];
    const telegramId = ctx.from!.id;
    try {
      const user = await getUserByTelegramId(telegramId);
      if (!user) {
        await ctx.answerCbQuery('Please run /start first.').catch(() => { });
        return;
      }

      const showNetWorth = nwParam !== undefined
        ? nwParam === '1'
        : Boolean(user.show_net_worth_on_card);

      await ctx.answerCbQuery().catch(() => { });
      const positions = await getOpenPositions(user.id).catch(() => []);
      const position = positions.find(p => p.id === positionId);
      if (!position) {
        // The position may have been closed or re-created by a background
        // deposit sync since the holdings list was drawn. Fall back to the
        // plain token card instead of a dead end.
        const stale = await getPositionById(positionId).catch(() => null);
        if (stale && stale.user_id === user.id) {
          try {
            const card = await withTimeout(buildTokenCard(stale.token_address, telegramId), 10000, 'token card timeout');
            await sendTokenCard(ctx, card);
            return;
          } catch (cardErr: any) {
            console.warn('[token_detail] Fallback token card failed:', cardErr?.message);
          }
        }
        await ctx.reply('This token is no longer in your holdings. Tap below to refresh.', {
          ...Markup.inlineKeyboard([[cb('🎒 Refresh Holdings', 'refresh_holdings', 'primary')]]),
        }).catch(() => { });
        return;
      }

      const posChain = getPositionChain(position);
      const isSolanaPos = posChain === 'solana';
      const isStarknetPos = posChain === 'starknet';
      const isSuiPos = posChain === 'sui';
      const isEvmPos = posChain === 'hyperevm' || posChain === 'elysium';
      // Live on-chain balance check: if user transferred this token out via another wallet,
      // close position in DB immediately and inform user.
      let onChainZero = false;
      let liveRawBal: string | null = null;
      if (isSolanaPos) {
        const solUser = user.solana_address ? user : await ensureUserSolanaWallet(user).catch(() => user);
        if (solUser.solana_address) {
          try {
            const bal = await withTimeout(getSolanaTokenBalance(solUser.solana_address, position.token_address, true), 4000, 'timeout');
            if (bal.raw === 0n) {
              onChainZero = true;
            } else {
              liveRawBal = bal.raw.toString();
            }
          } catch { /* ignore network error */ }
        }
      } else if (isStarknetPos) {
        if (user.starknet_address) {
          try {
            const bal = await Promise.race([
              getStarknetTokenBalance(user.starknet_address, position.token_address),
              new Promise<bigint>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2500)),
            ]);
            if (bal === 0n || bal < 1000n) {
              onChainZero = true;
            } else {
              liveRawBal = bal.toString();
            }
          } catch { /* ignore network error */ }
        }
      } else if (isSuiPos) {
        if (user.sui_address) {
          try {
            const bal = await Promise.race([
              getSuiTokenBalance(user.sui_address, position.token_address),
              new Promise<{ raw: bigint; uiAmount: number }>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2500)),
            ]);
            if (bal.raw === 0n || bal.uiAmount < 0.000001) {
              onChainZero = true;
            } else {
              liveRawBal = bal.raw.toString();
            }
          } catch { /* ignore network error */ }
        }
      } else if (isEvmPos) {
        // EVM position: balance checked via EVM subaccount or preserved from swaps
        if (user.evm_address) {
          // Keep current held quantity unless verified zero
        }
      } else {
        if (user.subaccount_id) {
          try {
            const rawBal = await Promise.race([
              near.getTokenBalance(position.token_address, user.subaccount_id),
              new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2500)),
            ]);
            const clean = String(rawBal || '0').replace(/["'\s]/g, '').split('.')[0] || '0';
            let rawBig = 0n;
            try { rawBig = BigInt(clean); } catch { rawBig = 0n; }
            // Only a true zero closes the position here. A fixed raw threshold
            // (the old `< 1e6`) wrongly closed small balances of low-decimal
            // tokens (e.g. 0.5 USDC = 500000 raw) that were sent into the wallet.
            if (rawBig === 0n) {
              onChainZero = true;
            } else {
              liveRawBal = clean;
            }
          } catch (err: any) {
            const msg = err?.message || '';
            if (msg.includes('not registered') || msg.includes('does not exist')) {
              onChainZero = true;
            }
          }
        }
      }

      if (onChainZero) {
        await updatePosition({
          position_id: position.id,
          status: 'closed',
          closed_at: new Date(),
          quantity_held: '0',
        }).catch(() => { });
        const sym = position.token_address.length > 14 ? position.token_address.slice(0, 12) + '...' : position.token_address;
        await ctx.reply(
          `ℹ️ You no longer hold *${sanitizeMd(sym)}* in your wallet (balance is 0).\nIt has been removed from your holdings.`,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('🎒 View Holdings', 'refresh_holdings')],
              [Markup.button.callback('🔙 Main Menu', 'menu_home')],
            ]),
          }
        ).catch(() => { });
        return;
      }

      if (liveRawBal && liveRawBal !== position.quantity_held) {
        position.quantity_held = liveRawBal;
        updatePosition({
          position_id: position.id,
          quantity_held: liveRawBal,
        }).catch(() => { });
      }

      // Every network call below is time-boxed. Tokens that arrive by external
      // deposit are often uncached/unlisted, so an unbounded token discovery
      // (plus the PNL card's forced refresh) could stall the handler long past
      // the 15s middleware limit and the tap looked like it did nothing.
      const pnlCardPromise = withTimeout(generatePNLCard(positionId, showNetWorth), 9000, 'pnl card timeout')
        .catch((err: any) => {
          console.warn('[token_detail] PNL card skipped:', err?.message || err);
          return null;
        });

      const [info, fills, triggers] = await Promise.all([
        withTimeout(getTokenInfo(position.token_address, false), 6000, 'token info timeout').catch(() => null),
        getFillsByPosition(positionId).catch(() => []),
        getTriggersByPosition(positionId).catch(() => []),
      ]);

      const slTrigger = triggers.find(t => t.type === 'stop_loss');
      const tpTrigger = triggers.find(t => t.type === 'take_profit');
      const slDisplay = slTrigger ? `-${slTrigger.target_value}%` : 'None';
      const tpDisplay = tpTrigger ? `+${tpTrigger.target_value}%` : 'None';

      const symbol = info?.symbol ? sanitizeMd(info.symbol) : '???';
      let currentPrice = info ? parseFloat(info.price) : 0;
      const nativeUnit = getPositionNativeUnit(position, user);
      const liveNativeUsd = isSolanaPos
        ? (info?.sol_usd || await withTimeout(getSolUsdPrice(), 3000).catch(() => 150))
        : isStarknetPos
          ? (info?.strk_usd || 0.12)
          : isSuiPos
            ? await withTimeout(getSuiUsdPrice(), 3000).catch(() => 2.0)
            : isEvmPos
              ? await withTimeout(getHypeUsdPrice(), 3000).catch(() => 25.0)
              : await withTimeout(getNearUsdPrice(), 3000).catch(() => 5.16);
      const usdRate = isSolanaPos
        ? (info?.sol_usd || liveNativeUsd)
        : isStarknetPos
          ? (info?.strk_usd || liveNativeUsd)
          : isSuiPos
            ? (info?.sui_usd || liveNativeUsd)
            : isEvmPos
              ? (info?.hype_usd || liveNativeUsd)
              : (info?.near_usd || liveNativeUsd);

      const decimals = info?.decimals ?? (isSolanaPos ? 6 : isSuiPos ? 9 : 18);
      let mcNative = info?.market_cap || 0;
      let mcUsd = info?.market_cap_usd || 0;
      if (mcNative <= 0 && info?.total_supply && info.total_supply !== '0' && currentPrice > 0) {
        try {
          const rawSupply = BigInt(String(info.total_supply).split('.')[0]);
          let humanSupply = Number(rawSupply) / Math.pow(10, decimals);
          if (humanSupply > 0) {
            mcNative = humanSupply * currentPrice;
            if (mcUsd <= 0 && usdRate > 0) {
              mcUsd = mcNative * usdRate;
            }
          }
        } catch { /* no-op */ }
      }
      if (mcNative <= 0 && mcUsd > 0 && usdRate > 0) {
        mcNative = mcUsd / usdRate;
      }
      if (mcUsd <= 0 && mcNative > 0 && usdRate > 0) {
        mcUsd = mcNative * usdRate;
      }

      // Calculate initial investment across all buy fills, or fallback to position entry * qty
      const toHuman = (rawStr: string): number => {
        const val = parseFloat(rawStr || '0');
        if (decimals <= 0) return val;
        if (isSuiPos) {
          return rawStr.includes('.') && val < 1e6 ? val : val / Math.pow(10, decimals);
        }
        if (isStarknetPos) {
          return rawStr.includes('.') && val < 1e10 ? val : val / Math.pow(10, decimals);
        }
        if (!rawStr.includes('.') || val > 1e10) return val / Math.pow(10, decimals);
        return val;
      };
      const buys = fills.filter(f => f.side === 'buy');
      let initialInvestment = 0;
      let totalBuyTokensHuman = 0;
      let totalNetBuyCostNative = 0;

      for (const buy of buys) {
        if (buy.tx_hash?.startsWith('deposit_')) continue;
        const amount = toHuman(buy.amount);
        let fee = parseFloat(buy.fee_paid || '0');
        if (isSuiPos && fee > 1e6) fee = fee / 1e9;
        else if (!isSuiPos && fee > 1e18) fee = fee / 1e24;

        let cost: number;
        let netCost: number;
        if (buy.input_amount != null && parseFloat(buy.input_amount) > 0) {
          // On-chain source of truth: actual SUI/NEAR spent
          cost = parseFloat(buy.input_amount);
          netCost = Math.max(0, cost - fee);
        } else {
          // Legacy fills: approximate from amount*price + normalized fee
          const price = parseFloat(buy.price);
          cost = (amount * price) + fee;
          netCost = amount * price;
        }

        initialInvestment += cost;
        totalBuyTokensHuman += amount;
        totalNetBuyCostNative += netCost;
      }

      let humanQuantity = 0;
      try {
        const rawBig = BigInt((position.quantity_held || '0').split('.')[0]);
        if (isStarknetPos && (position.quantity_held || '').includes('.') && Number(rawBig) < 1e10) {
          humanQuantity = parseFloat(position.quantity_held) || 0;
        } else {
          humanQuantity = Number(rawBig) / Math.pow(10, decimals);
        }
      } catch {
        humanQuantity = parseFloat(position.quantity_held || '0');
      }

      let entryPrice = parseFloat(position.avg_entry_price) || 0;
      // Heal corrupted entryPrice: if fills give us a reliable cost basis, recompute
      if (totalBuyTokensHuman > 0 && totalNetBuyCostNative > 0) {
        const fillAvgEntry = totalNetBuyCostNative / totalBuyTokensHuman;
        // Heal if: stored entry is 0, OR 10× above current price while fills suggest a much lower value, OR diverges > 5% from fills
        if (entryPrice <= 0 || (currentPrice > 0 && entryPrice > currentPrice * 10 && fillAvgEntry <= currentPrice * 10) || Math.abs(entryPrice - fillAvgEntry) / fillAvgEntry > 0.05) {
          entryPrice = fillAvgEntry;
          position.avg_entry_price = fillAvgEntry.toString();
          updatePosition({
            position_id: position.id,
            avg_entry_price: fillAvgEntry.toString(),
          }).catch(() => { });
        }
      } else if (entryPrice <= 0 && currentPrice > 0) {
        entryPrice = currentPrice;
        position.avg_entry_price = currentPrice.toString();
        updatePosition({
          position_id: position.id,
          avg_entry_price: currentPrice.toString(),
        }).catch(() => { });
      }

      const externalTokens = (position.is_external_deposit && humanQuantity > totalBuyTokensHuman)
        ? (humanQuantity - totalBuyTokensHuman)
        : 0;
      if (externalTokens > 0) {
        initialInvestment += externalTokens * entryPrice;
      } else if (initialInvestment === 0 && humanQuantity > 0) {
        initialInvestment = humanQuantity * entryPrice;
      }

      // Generate PNL card first so text caption & card image share the exact same financial data
      let pnlCardImage: Buffer | null = null;
      let pnlCardText: string | null = null;
      let cardData: any = null;
      try {
        const pnlCard = await pnlCardPromise;
        if (pnlCard) {
          cardData = pnlCard.data;
          pnlCardImage = pnlCard.image;
          pnlCardText = pnlCard.text;
        }
      } catch (err: any) {
        console.error('Failed to generate PNL card:', err);
      }

      // Sync financial metrics with canonical PNL card data
      if (cardData) {
        entryPrice = cardData.entryPrice;
        currentPrice = cardData.currentPrice;
        initialInvestment = cardData.initialInvestment;
      }

      const pnlPct = cardData
        ? cardData.pnlPercent.toFixed(2)
        : (currentPrice > 0 && entryPrice > 0
          ? ((currentPrice - entryPrice) / entryPrice * 100).toFixed(2)
          : 'N/A');
      const emoji = cardData
        ? (cardData.isProfit ? '🟢' : '🔴')
        : (parseFloat(pnlPct) >= 0 ? '🟢' : '🔴');
      const pnlDisplay = pnlPct === 'N/A' ? 'N/A' : `${parseFloat(pnlPct) >= 0 ? '+' : ''}${pnlPct}%`;

      const holdingValueNative = cardData ? cardData.unrealizedValue : (humanQuantity * currentPrice);
      const holdingValueUsd = holdingValueNative * usdRate;
      const initialInvestedUsd = initialInvestment * usdRate;
      const pnlUsd = cardData ? (cardData.totalPnl * usdRate) : (holdingValueUsd - initialInvestedUsd);
      const pnlUsdStr = Math.abs(pnlUsd) >= 0.01 ? `${pnlUsd >= 0 ? '+$' : '-$'}${Math.abs(pnlUsd).toFixed(2)}` : '';

      const formattedQty = formatHoldingQuantity(position.quantity_held, decimals);

      const fmtPrice = (p: number) => {
        if (p <= 0) return '`$0.00`';
        const usd = p * usdRate;
        const usdStr = formatCryptoPrice(usd, '$');
        const natStr = formatCryptoPrice(p, '', nativeUnit).trim();
        return `\`${usdStr}\` (${natStr})`;
      };

      const fmtVal = (valNative: number) => {
        if (valNative <= 0) return `\`$0.00\` (0.00 ${nativeUnit})`;
        const usd = valNative * usdRate;
        const usdStr = usd >= 1000 ? `$${(usd / 1000).toFixed(2)}K` : (usd >= 0.01 ? `$${usd.toFixed(2)}` : (usd > 0 ? formatCryptoPrice(usd, '$') : '$0.00'));
        const natStr = valNative >= 1000 ? `${(valNative / 1000).toFixed(2)}K ${nativeUnit}` : (valNative >= 1 ? `${valNative.toFixed(2)} ${nativeUnit}` : (valNative > 0 ? formatCryptoPrice(valNative, '', nativeUnit).trim() : `0.00 ${nativeUnit}`));
        return `\`${usdStr}\` (${natStr})`;
      };

      const fmtMcap = () => {
        const effectiveMcUsd = mcUsd > 0 ? mcUsd : (mcNative > 0 ? mcNative * usdRate : 0);
        const effectiveMcNative = mcNative > 0 ? mcNative : (effectiveMcUsd > 0 && usdRate > 0 ? effectiveMcUsd / usdRate : 0);
        if (effectiveMcUsd <= 0 && effectiveMcNative <= 0) return '`N/A`';

        const mcUsdStr = effectiveMcUsd >= 1e9 ? `$${(effectiveMcUsd / 1e9).toFixed(2)}B` : effectiveMcUsd >= 1e6 ? `$${(effectiveMcUsd / 1e6).toFixed(2)}M` : effectiveMcUsd >= 1e3 ? `$${(effectiveMcUsd / 1e3).toFixed(2)}K` : `$${effectiveMcUsd.toFixed(2)}`;
        const mcNatStr = effectiveMcNative >= 1e9 ? `${(effectiveMcNative / 1e9).toFixed(2)}B ${nativeUnit}` : effectiveMcNative >= 1e6 ? `${(effectiveMcNative / 1e6).toFixed(2)}M ${nativeUnit}` : effectiveMcNative >= 1e3 ? `${(effectiveMcNative / 1e3).toFixed(2)}K ${nativeUnit}` : `${effectiveMcNative.toFixed(2)} ${nativeUnit}`;
        return `\`${mcUsdStr}\` (${mcNatStr})`;
      };

      const pnlLine = pnlDisplay !== 'N/A'
        ? `${emoji} *PNL*: \`${pnlDisplay}\`${pnlUsdStr ? ` (\`${pnlUsdStr}\`)` : ''}`
        : `*PNL*: \`N/A\``;

      let venueTag = '';
      if (info?.venue) {
        const vName = info.venue.charAt(0).toUpperCase() + info.venue.slice(1);
        venueTag = ` • 💧 _${vName}_`;
      }

      const buyTax = info?.buy_tax_pct !== undefined ? `${info.buy_tax_pct.toFixed(1)}%` : '0.3%';
      const sellTax = info?.sell_tax_pct !== undefined ? `${info.sell_tax_pct.toFixed(1)}%` : '0.3%';

      let msg =
        `📊 *${symbol} Details*${venueTag}\n\n` +
        `${pnlLine}\n` +
        `🛡️ *Stop Loss*: \`${slDisplay}\`  •  🎯 *Take Profit*: \`${tpDisplay}\`\n\n` +
        `💰 *Value*: ${fmtVal(holdingValueNative)}\n` +
        `📦 *Holding*: \`${formattedQty} ${symbol}\`\n` +
        `🏷️ *DEX Tax*: \`Buy ${buyTax} / Sell ${sellTax}\`\n\n` +
        `💵 *Price*: ${fmtPrice(currentPrice)}\n` +
        `📥 *Entry*: ${fmtPrice(entryPrice)}\n` +
        (showNetWorth ? `💸 *Invested*: ${fmtVal(initialInvestment)}\n` : '') +
        `📈 *Market Cap*: ${fmtMcap()}\n\n` +
        `📝 *CA*: \`${position.token_address}\``;

      // Build keyboard buttons first (needed for both text and image paths)
      const buttons: any[] = [];
      const shortKey = getShortTokenKey(position.token_address);
      const unitBtn = getPositionUnitBtn(position, user);

      // Sell percentage buttons (Red 🔴)
      buttons.push([
        cb('25%', `sell:${positionId}:25`, 'danger'),
        cb('50%', `sell:${positionId}:50`, 'danger'),
        cb('100%', `sell:${positionId}:100`, 'danger'),
      ]);

      // Stop Loss & Take Profit quick setup / edit buttons
      buttons.push([
        cb(slTrigger ? `📉 SL: -${slTrigger.target_value}%` : '📉 Set Stop Loss', `sl_prompt:${positionId}`, slTrigger ? 'danger' : undefined),
        cb(tpTrigger ? `📈 TP: +${tpTrigger.target_value}%` : '📈 Set Take Profit', `tp_prompt:${positionId}`, tpTrigger ? 'success' : undefined),
      ]);

      // Buy buttons (Green 🟢)
      const detailBuyAmounts = isSolanaPos ? SOLANA_BUY_PRESETS : isEvmPos ? EVM_BUY_PRESETS : parseBuyAmounts(user?.custom_buy_amounts);
      buttons.push(detailBuyAmounts.map(amt => cb(`${amt} ${unitBtn}`, `buy_fixed:${shortKey}:${amt}`, 'success')));

      const customTradeRow: any[] = [
        cb(`🟢 Buy X ${nativeUnit}`, `buy_custom_prompt:${shortKey}`, 'success'),
        cb('🔴 Sell X Tokens', `sell_custom_prompt:${positionId}`, 'danger'),
      ];
      if (initialInvestment > 0) {
        customTradeRow.push(cb('🔴 Sell Initial', `sell_initial:${positionId}`, 'danger'));
      }
      buttons.push(customTradeRow);

      if (!isSuiPos && !isEvmPos && !isStarknetPos) {
        buttons.push([
          cb('🔁 DCA Order', `dca_token:${shortKey}`, 'primary'),
          cb('🎯 Limit Order', `lo_start:${shortKey}`, 'primary'),
        ]);
      }

      // External explorer & chart links
      const linkRows = (() => {
        if (isEvmPos) {
          const rows: any[] = [];
          if (posChain === 'hyperevm') {
            rows.push([
              Markup.button.url('🔍 HypurrScan', `https://hypurrscan.io/token/${position.token_address}`),
              Markup.button.url('📈 DexScreener', `https://dexscreener.com/hyperevm/${position.token_address}`),
            ]);
          } else {
            rows.push([
              Markup.button.url('🔍 Elysium Explorer', `https://elysium.kinetiq.xyz/testnet-explorer/token/${position.token_address}`),
            ]);
          }
          return rows;
        }
        if (isSolanaPos) {
          const rows: any[] = [];
          if (info?.launchpad === 'pump.fun') {
            rows.push([Markup.button.url('💊 View on pump.fun', `https://pump.fun/coin/${position.token_address}`)]);
          }
          rows.push([
            Markup.button.url('🔍 Solscan', `https://solscan.io/token/${position.token_address}`),
            Markup.button.url('📈 DexScreener', `https://dexscreener.com/solana/${position.token_address}`),
          ]);
          return rows;
        }
        if (isSuiPos) {
          const rows: any[] = [];
          if (info?.sui_curve_address) {
            rows.push([Markup.button.url('💧 View on SuiPump', `https://suipump.org/token/${info.sui_curve_address}`)]);
          }
          rows.push([
            Markup.button.url('🔍 Suiscan', `https://suiscan.xyz/mainnet/coin/${info?.sui_coin_type || position.token_address}/txs`),
            Markup.button.url('📈 DexScreener', `https://dexscreener.com/sui/${position.token_address}`),
          ]);
          return rows;
        }
        const links = tokenLinks(info?.venue || 'nearlytrade', position.token_address);
        const rows: any[] = [];
        if (links.length > 0) rows.push(links.slice(0, 2).map(l => Markup.button.url(l.label, l.url)));
        if (links.length > 2) rows.push(links.slice(2).map(l => Markup.button.url(l.label, l.url)));
        return rows;
      })();
      buttons.push(...linkRows);

      // Share Token (Earn 5% Fees)
      if (!isSuiPos) {
        try {
          const shareCode = await withTimeout(getOrCreateTokenShare(user.id, position.token_address), 3000, 'share code timeout');
          const shareDeepLink = `https://t.me/racertradingbot?start=${shareCode}`;
          const sym = symbol !== '???' ? symbol : 'TOKEN';
          const chainTitle = isSolanaPos ? 'Solana' : isStarknetPos ? 'Starknet' : isSuiPos ? 'Sui' : isEvmPos ? (posChain === 'hyperevm' ? 'HyperEVM' : 'Elysium') : 'NEAR';
          const shareText = `Trade $${sym} on RacerBot 🏎\n⚡ Instant 1-click execution on ${chainTitle} DEXs`;
          const tgShareUrl = `https://t.me/share/url?url=${encodeURIComponent(shareDeepLink)}&text=${encodeURIComponent(shareText)}`;
          buttons.push([Markup.button.url('📤 Share & Earn 5%', tgShareUrl)]);
        } catch (err: any) {
          console.warn('[token_detail] Failed to generate share link:', err?.message);
        }
      }

      // Send Token & Navigation buttons
      buttons.push([
        cb('📤 Send Token', `send_token_prompt:${positionId}`, 'primary'),
        cb(
          showNetWorth ? '🙈 Hide NW' : '👁 Show NW',
          `token_detail:${positionId}:${showNetWorth ? 0 : 1}`,
          'primary'
        ),
        cb('🔄 Refresh', `token_detail:${positionId}${nwParam !== undefined ? `:${nwParam}` : ''}`, 'primary'),
      ]);
      buttons.push([
        cb('💼 Holdings', 'menu_holdings', 'primary'),
        cb('🏠 Menu', 'menu_home', 'primary'),
      ]);

      if (!pnlCardImage && pnlCardText) {
        msg += `\n${pnlCardText}`;
      }

      await deliverTokenDetail(ctx, msg, buttons, pnlCardImage);
    } catch (err: any) {
      console.error('[token_detail] Error loading token details:', err?.message || err);
      await ctx.reply('Error loading token details. Please try again.').catch(() => { });
    }
  });

  // ── sell_custom_prompt — Prompt user for exact token amount to sell ─────────
  bot.action(/^sell_custom_prompt:(.+)$/, async (ctx) => {
    try {
      const positionId = ctx.match![1];
      const telegramId = ctx.from!.id;

      const user = await getUserByTelegramId(telegramId).catch(() => null);
      if (!user) {
        await ctx.answerCbQuery('Please run /start first.').catch(() => { });
        return;
      }
      const position = await getPositionById(positionId).catch(() => null);
      if (!position || position.user_id !== user.id) {
        await ctx.answerCbQuery('Position not found.').catch(() => { });
        return;
      }

      const tokenInfo = await getTokenInfo(position.token_address, false).catch(() => null);
      const decimals = tokenInfo?.decimals ?? 18;
      const formattedQty = formatHoldingQuantity(position.quantity_held, decimals);
      const sym = sanitizeMd(tokenInfo?.symbol || 'Tokens');
      const shortKey = getShortTokenKey(position.token_address);

      userPendingActions.set(telegramId, {
        action: 'sell_custom_tokens',
        tokenAddress: position.token_address,
        deployerAddress: positionId,
        expiresAt: Date.now() + 120_000,
      });

      await ctx.answerCbQuery().catch(() => { });
      await ctx.reply(
        `💸 *Sell Custom Amount of $${sym}*\n\n` +
        `💼 *Your Current Balance*: \`${formattedQty} ${sym}\`\n\n` +
        `Reply with the exact number of tokens you want to sell (e.g. \`50000\` or \`100\`):\n\n` +
        `_Type /cancel to abort._`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[cb('🔙 Cancel', `token_refresh:${shortKey}`, 'primary')]])
        }
      ).catch(() => { });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  // ── sell_initial — Sell exact initial investment amount ───────────────────
  bot.action(/^sell_initial:(.+)$/, async (ctx) => {
    const positionId = ctx.match![1];
    const telegramId = ctx.from!.id;

    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) {
      await ctx.answerCbQuery('Please run /start first.').catch(() => { });
      return;
    }
    const position = await getPositionById(positionId).catch(() => null);
    if (!position || position.user_id !== user.id) {
      await ctx.answerCbQuery('Position not found.').catch(() => { });
      return;
    }
    const tokenAddress = position.token_address;

    const guardKey = inFlightKey(telegramId, tokenAddress, 'sell');
    if (!(await tryAcquireInFlight(guardKey))) {
      await ctx.answerCbQuery('A trade for this token is already in progress.').catch(() => { });
      return;
    }
    await ctx.answerCbQuery('⚡ Processing sell initial order...').catch(() => { });

    (async () => {
      let procMsg: any = null;
      try {
        procMsg = await ctx.reply('⏳ *Processing Sell Initial Order...*\n\nCalculating and selling initial investment...\n_Executing swap on DEX..._', { parse_mode: 'Markdown' }).catch(() => null);
        const onStage = makeStageEditor(ctx, procMsg, 'Processing Sell Initial Order');
        const positions = await getOpenPositions(user.id).catch(() => []);
        const livePosition = positions.find(p => p.id === positionId) ?? position;
        const fills = await getFillsByPosition(positionId).catch(() => []);
        const buys = fills.filter(f => f.side === 'buy');

        if (buys.length === 0) {
          if (procMsg) await ctx.deleteMessage(procMsg.message_id).catch(() => { });
          await ctx.reply('No buy history found for this position.').catch(() => { });
          return;
        }

        // Fetch current market price from token info (not avg_entry_price)
        const tokenInfo = await getTokenInfo(livePosition.token_address, false).catch(() => null);
        const currentPrice = tokenInfo ? parseFloat(tokenInfo.price) : 0;
        const isSuiPos = livePosition.chain === 'sui' || isSuiToken(livePosition.token_address);
        const decimals = tokenInfo?.decimals ?? (isSuiPos ? 6 : 18);
        // Fills store raw on-chain token units; prices are native per whole token.
        const toHuman = (rawStr: string): number => {
          const val = parseFloat(rawStr || '0');
          if (decimals <= 0) return val;
          if (isSuiPos) {
            return rawStr.includes('.') && val < 1e6 ? val : val / Math.pow(10, decimals);
          }
          if (!rawStr.includes('.') || val > 1e10) return val / Math.pow(10, decimals);
          return val;
        };

        // Calculate total initial investment across ALL buy fills (not just first)
        // Prefer input_amount as on-chain source of truth
        let totalInitialInvestment = 0;
        for (const buy of buys) {
          if (buy.input_amount != null && parseFloat(buy.input_amount) > 0) {
            totalInitialInvestment += parseFloat(buy.input_amount);
          } else {
            const amount = toHuman(buy.amount);
            const price = parseFloat(buy.price);
            let fee = parseFloat(buy.fee_paid || '0');
            if (isSuiPos && fee > 1e6) {
              fee = fee / 1e9;
            } else if (!isSuiPos && fee > 1e18) {
              fee = fee / 1e24;
            }
            totalInitialInvestment += (amount * price) + fee;
          }
        }

        if (currentPrice === 0) {
          if (procMsg) await ctx.deleteMessage(procMsg.message_id).catch(() => { });
          await ctx.reply('Cannot calculate sell amount - current price is 0.').catch(() => { });
          return;
        }

        const currentHeld = toHuman(livePosition.quantity_held);
        if (currentHeld === 0) {
          if (procMsg) await ctx.deleteMessage(procMsg.message_id).catch(() => { });
          await ctx.reply('No tokens held in this position.').catch(() => { });
          return;
        }

        // Calculate percentage needed to sell to recover initial investment
        const currentValue = currentHeld * currentPrice;
        const sellPercentage = (totalInitialInvestment / currentValue) * 100;
        const adjustedPercentage = Math.min(100, Math.max(1, sellPercentage));

        const result = await sellAtTarget(user.id, positionId, adjustedPercentage, onStage);

        if (procMsg) await ctx.deleteMessage(procMsg.message_id).catch(() => { });

        if (result.success) {
          const initUnit = getPositionNativeUnit(livePosition, user);
          await sendPnlCardMessage(
            ctx,
            positionId,
            `✅ *Sold initial investment of \`${totalInitialInvestment.toFixed(4)} ${initUnit}\` worth of tokens (\`${adjustedPercentage.toFixed(1)}%\`).*${result.usdcReceived && result.usdcReceived > 0 ? `\n💵 *Received*: \`+${result.usdcReceived.toFixed(2)} USDC\`` : ''}`
          ).catch(() => { });
        } else {
          await ctx.reply(`❌ Sell failed: ${result.reason || 'Unknown error'}`).catch(() => { });
        }
      } catch (err: any) {
        if (procMsg) await ctx.deleteMessage(procMsg.message_id).catch(() => { });
        console.error('[SELL_INITIAL] Error:', err);
        await ctx.reply('Error processing sell. Please try again.').catch(() => { });
      } finally {
        await releaseInFlight(guardKey);
      }
    })().catch(async (err: any) => {
      await releaseInFlight(guardKey);
      console.error('[SELL_INITIAL] Unhandled detached error:', err?.message || err);
      ctx.reply('Error processing sell. Please try again.').catch(() => { });
    });
  });

  // ── menu_positions — Redirect to holdings for backwards compatibility ───────
  bot.action('menu_positions', async (ctx) => {
    try {
      await (ctx as any).answerCbQuery?.('🔄 Refreshing holdings...').catch(() => { });
      await handleHoldings(ctx, true);
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  // ── menu_pnl & refresh_pnl ────────────────────────────────────────────────
  type PnlTimeframe = '24h' | '7d' | '30d' | 'all';

  // ── menu_pnl & refresh_pnl with Timeframe Selection (24h, 7d, 30d, all) ───
  const handlePnl = async (ctx: Context, timeframe: PnlTimeframe = '24h') => {
    const telegramId = ctx.from!.id;
    try {
      const user = await getUserByTelegramId(telegramId).catch(() => null);
      if (!user) { await ctx.reply('Use /start first.'); return; }

      // Background sync of external deposits
      setImmediate(() => syncUserTokenDeposits(user.id, user.subaccount_id).catch(() => { }));

      let timeFilter = '';
      let periodLabel = '24 Hours';
      if (timeframe === '24h') {
        timeFilter = "AND f.created_at >= NOW() - INTERVAL '24 hours'";
        periodLabel = '24 Hours';
      } else if (timeframe === '7d') {
        timeFilter = "AND f.created_at >= NOW() - INTERVAL '7 days'";
        periodLabel = '1 Week';
      } else if (timeframe === '30d') {
        timeFilter = "AND f.created_at >= NOW() - INTERVAL '30 days'";
        periodLabel = '1 Month';
      } else {
        periodLabel = 'All Time';
      }

      const [openPositions, db] = await Promise.all([
        getOpenPositions(user.id).catch(() => []),
        getDb(),
      ]);

      // Query all sell fills for user in this timeframe
      const sellFillsQuery = `
        SELECT 
          f.id, f.position_id, f.token_address, f.amount, f.price, f.fee_paid, f.created_at,
          p.avg_entry_price, p.status as pos_status
        FROM fills f
        LEFT JOIN positions p ON f.position_id = p.id
        WHERE f.user_id = $1 AND f.side = 'sell' ${timeFilter}
        ORDER BY f.created_at DESC
      `;
      const sellsResult = await db.query(sellFillsQuery, [user.id]);
      const sells = sellsResult.rows;

      // Parallel token info fetch for unique tokens traded
      const uniqueTokens = Array.from(new Set(sells.map((s: any) => s.token_address)));
      const tokenInfoMap = new Map<string, any>();
      await Promise.allSettled(
        uniqueTokens.map(async (tokenAddr) => {
          try {
            const info = await getTokenInfo(tokenAddr as string, false);
            if (info) tokenInfoMap.set(tokenAddr as string, info);
          } catch { }
        })
      );

      let nearUsdRate = 4.3;
      for (const info of tokenInfoMap.values()) {
        if (info?.near_usd && info.near_usd > 0) {
          nearUsdRate = info.near_usd;
          break;
        }
      }

      // Group trades by token and calculate exact PNL
      const tokenGroups: Record<string, { token: string; count: number; cost: number; revenue: number; netPnl: number }> = {};
      let totalCost = 0;
      let totalRevenue = 0;
      let wins = 0;
      let losses = 0;

      for (const s of sells) {
        const token = s.token_address;
        if (!tokenGroups[token]) {
          tokenGroups[token] = { token, count: 0, cost: 0, revenue: 0, netPnl: 0 };
        }
        const grp = tokenGroups[token];
        grp.count++;

        const info = tokenInfoMap.get(token);
        const isSuiTokenAddr = isSuiToken(token);
        const rawAmt = parseFloat(s.amount || '0');
        const decimals = info?.decimals ?? (isSuiTokenAddr ? 6 : (rawAmt > 1e25 ? 24 : 18));
        const humanQty = isSuiTokenAddr
          ? (String(s.amount || '').includes('.') && rawAmt < 1e6 ? rawAmt : rawAmt / Math.pow(10, decimals))
          : (!String(s.amount || '').includes('.') || rawAmt > 1e10 ? rawAmt / Math.pow(10, decimals) : rawAmt);
        const sellPrice = parseFloat(s.price || '0');
        let sellFee = parseFloat(s.fee_paid || '0');
        if (isSuiTokenAddr && sellFee > 1e6) sellFee = sellFee / 1e9;
        else if (!isSuiTokenAddr && sellFee > 1e18) sellFee = sellFee / 1e24;
        const entryPrice = parseFloat(s.avg_entry_price || s.price || '0');

        const tradeRevenue = (humanQty * sellPrice) - sellFee;
        const tradeCost = humanQty * entryPrice;
        const tradePnl = tradeRevenue - tradeCost;

        grp.cost += tradeCost;
        grp.revenue += tradeRevenue;
        grp.netPnl += tradePnl;

        totalCost += tradeCost;
        totalRevenue += tradeRevenue;

        if (tradePnl >= 0) wins++;
        else losses++;
      }

      const netRealizedPnl = totalRevenue - totalCost;
      const netPnlPct = totalCost > 0 ? (netRealizedPnl / totalCost) * 100 : 0;
      const totalTrades = wins + losses;
      const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
      const usdVal = Math.abs(netRealizedPnl * nearUsdRate);
      const usdSign = netRealizedPnl >= 0 ? '+' : '-';
      const pctSign = netPnlPct >= 0 ? '+' : '';
      const statusWord = netRealizedPnl >= 0 ? 'PROFIT' : 'LOSS';
      const pnlEmoji = netRealizedPnl >= 0 ? '🟢' : '🔴';

      let msg = `📊 *PNL Performance Summary*\n`;
      msg += `⏱ *Timeframe*: *${periodLabel}*\n\n`;

      if (totalTrades === 0) {
        msg += `ℹ️ _No realized trades found in the last ${periodLabel.toLowerCase()}._\n\n`;
      } else {
        msg += `💰 *Net Realized PNL*:\n`;
        msg += `${pnlEmoji} *\`${usdSign}$${usdVal.toFixed(2)} USD\`* (${netRealizedPnl >= 0 ? '+' : ''}${netRealizedPnl.toFixed(4)} net)\n`;
        msg += `📈 *Exact Return*: \`${pctSign}${netPnlPct.toFixed(2)}%\` (${statusWord})\n\n`;

        msg += `🎯 *Trade Performance*:\n`;
        msg += `• *Wins*: \`${wins}\` | *Losses*: \`${losses}\`\n`;
        msg += `• *Win Rate*: \`${winRate.toFixed(1)}%\`\n`;
        msg += `• *Total Volume*: \`$${(totalRevenue * nearUsdRate).toFixed(2)}\` (${totalTrades} trade${totalTrades > 1 ? 's' : ''})\n\n`;

        msg += `🪙 *Token Breakdown*:\n`;
        const sortedTokens = Object.values(tokenGroups).sort((a, b) => b.netPnl - a.netPnl);
        for (const t of sortedTokens.slice(0, 8)) {
          const tPct = t.cost > 0 ? (t.netPnl / t.cost) * 100 : 0;
          const tEmoji = t.netPnl >= 0 ? '🟢' : '🔴';
          const info = tokenInfoMap.get(t.token);
          const rawSym = info?.symbol || t.token.split('.')[0].toUpperCase();
          const sym = sanitizeMd(rawSym);
          const tUnit = getChainUnitBtn(t.token);
          msg += `${tEmoji} *$${sym}*: \`${t.netPnl >= 0 ? '+' : ''}${t.netPnl.toFixed(4)} ${tUnit}\` (\`${tPct >= 0 ? '+' : ''}${tPct.toFixed(1)}%\`) (${t.count} trade${t.count > 1 ? 's' : ''})\n`;
        }
        if (sortedTokens.length > 8) {
          msg += `_...and ${sortedTokens.length - 8} more tokens_\n`;
        }
        msg += `\n`;
      }

      // Open positions summary (unrealized)
      if (openPositions.length > 0) {
        msg += `💼 *Open Portfolio*:\n`;
        msg += `• Active Holdings: \`${openPositions.length}\`\n`;
        msg += `_Tap 💼 Holdings below to manage live positions._\n\n`;
      }

      msg += `_Select a timeframe below to view your stats:_`;

      const keyboard = Markup.inlineKeyboard([
        [
          cb(timeframe === '24h' ? '✓ 24 Hours' : '24 Hours', 'pnl_tf:24h', timeframe === '24h' ? 'success' : 'primary'),
          cb(timeframe === '7d' ? '✓ 1 Week' : '1 Week', 'pnl_tf:7d', timeframe === '7d' ? 'success' : 'primary'),
        ],
        [
          cb(timeframe === '30d' ? '✓ 1 Month' : '1 Month', 'pnl_tf:30d', timeframe === '30d' ? 'success' : 'primary'),
          cb(timeframe === 'all' ? '✓ All Time' : 'All Time', 'pnl_tf:all', timeframe === 'all' ? 'success' : 'primary'),
        ],
        [
          cb('🔄 Refresh', `pnl_tf:${timeframe}`, 'primary'),
          cb('💼 Holdings', 'menu_holdings', 'primary'),
        ],
        [
          cb('🏠 Main Menu', 'menu_home', 'primary'),
        ],
        [
          Markup.button.url('💬 Community', 'https://t.me/racerbot_community'),
          Markup.button.url('📢 Updates', 'https://t.me/racertrading'),
          Markup.button.url('𝕏 X', 'https://x.com/racertradingbot'),
        ],
      ]);

      if (ctx.callbackQuery) {
        await ctx.editMessageText(msg, { parse_mode: 'Markdown', ...keyboard }).catch(async (err: any) => {
          if (err?.message?.includes('message is not modified')) return;
          await ctx.reply(msg, { parse_mode: 'Markdown', ...keyboard }).catch(async () => {
            await ctx.reply(msg.replace(/[*_`]/g, ''), keyboard).catch(() => { });
          });
        });
      } else {
        await ctx.reply(msg, { parse_mode: 'Markdown', ...keyboard }).catch(async () => {
          await ctx.reply(msg.replace(/[*_`]/g, ''), keyboard).catch(() => { });
        });
      }
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => { });
    }
  };

  bot.action(/^pnl_tf:(24h|7d|30d|all)$/, async (ctx) => {
    try {
      const tf = ctx.match![1] as PnlTimeframe;
      await ctx.answerCbQuery().catch(() => { });
      await handlePnl(ctx, tf);
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  bot.action(['menu_pnl', 'refresh_pnl'], async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => { });
      await handlePnl(ctx, '24h');
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  bot.command('pnl', async (ctx) => {
    try {
      await handlePnl(ctx, '24h');
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => { });
    }
  });

  // ── /wallet & /balance ────────────────────────────────────────────────────
  const handleWallet = async (ctx: Context) => {
    if (isGroupChat(ctx)) {
      await replyGroupDmRedirect(ctx, 'Wallet details');
      return;
    }
    const telegramId = ctx.from!.id;
    try {
      const wallet = await buildWalletMenu(telegramId);
      await ctx.reply(wallet.text, { parse_mode: 'HTML', ...wallet.keyboard }).catch(() => { });
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => { });
    }
  };


  // ── /launchpads — Elysium & HyperEVM Launchpad Hub ──────────────────────
  const handleLaunchpads = async (ctx: Context) => {
    const text =
`🚀 <b>Elysium & HyperEVM Launchpads Hub</b> 🏛️

Explore active token launchpads running on HyperEVM (Mainnet) and Elysium L2 (Testnet — Mainnet live soon!):

1️⃣ <b>CorePad</b> (<code>corepad.app</code>)
• 800M tokens on constant-product curve
• 60s Launch Guard (Max 1% per address)
• Direct graduation to HyperCore HIP-1 Spot Orderbook

2️⃣ <b>BunnyPad</b> (<code>bunnypad.fun</code>)
• Instant 1-click token launch
• 100% supply paired in automated liquidity pool
• Initial MC ~$3,000

3️⃣ <b>Updraft</b> (<code>updraft-weld.vercel.app</code>)
• "One Wire, One Price" pooled round
• Zero front-running: all commits execute at uniform $T_0$ avg price
• On-chain verifiable fairness certificate

4️⃣ <b>PerpMe & Citadel</b>
• High-speed memecoin discovery
• Native AMM liquidity migration

💡 <i>Paste any Elysium or HyperEVM token contract address (0x...) to view liquidity, honeypot safety, and execute instant 1-click buys!</i>`;

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.url('🛡️ CorePad', 'https://corepad.app'),
        Markup.button.url('🐰 BunnyPad', 'https://www.bunnypad.fun'),
      ],
      [
        Markup.button.url('🌪️ Updraft', 'https://updraft-weld.vercel.app'),
        Markup.button.url('📈 PerpMe', 'https://perpme.fun/elysium'),
      ],
      [
        cb('💼 Wallet / Balance', 'menu_wallet', 'primary'),
        cb('🔙 Main Menu', 'menu_home', 'primary'),
      ],
    ]);

    if (ctx.callbackQuery && typeof (ctx as any).editMessageText === 'function') {
      await (ctx as any).editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(() => {
        ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
      });
    } else {
      await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
    }
  };

  bot.command('launchpads', handleLaunchpads);
  bot.action('launchpads_menu', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await handleLaunchpads(ctx);
  });

  bot.command('wallet', handleWallet);
  bot.command('balance', handleWallet);

  // ── /wallets — Multi-Wallet Management (Option A) ─────────────────────────
  const handleWallets = async (ctx: Context) => {
    if (isGroupChat(ctx)) {
      await replyGroupDmRedirect(ctx, 'Multi-wallet management');
      return;
    }
    const telegramId = ctx.from!.id;
    try {
      const menu = await buildWalletsManagementMenu(telegramId);
      const canEdit = typeof (ctx as any).editMessageText === 'function';
      if (canEdit && ctx.callbackQuery) {
        await (ctx as any).editMessageText(menu.text, { parse_mode: 'HTML', ...menu.keyboard }).catch(async (err: any) => {
          if (err?.message?.includes('message is not modified')) return;
          console.warn('[handleWallets] editMessageText failed, retrying with reply:', err?.message);
          await ctx.reply(menu.text, { parse_mode: 'HTML', ...menu.keyboard }).catch(async (replyErr: any) => {
            console.error('[handleWallets] HTML reply failed, falling back to plain text:', replyErr?.message);
            await ctx.reply(menu.text.replace(/<[^>]+>/g, ''), menu.keyboard).catch(() => { });
          });
        });
      } else {
        await ctx.reply(menu.text, { parse_mode: 'HTML', ...menu.keyboard }).catch(async (replyErr: any) => {
          console.error('[handleWallets] HTML reply failed, falling back to plain text:', replyErr?.message);
          await ctx.reply(menu.text.replace(/<[^>]+>/g, ''), menu.keyboard).catch(() => { });
        });
      }
    } catch (err: any) {
      console.error('[handleWallets] Critical failure:', err);
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => { });
    }
  };

  bot.command(['wallets', 'importwallet', 'import'], handleWallets);
  bot.action(['wallets_menu', 'import_wallet', 'import_wallet_menu', 'wallet_modal', 'wallets'], async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => { });
      await handleWallets(ctx);
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => { });
    }
  });

  bot.action(/^(?:w_sw_near|wallet_switch):(.+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const walletId = ctx.match![1];
    try {
      const user = await getUserByTelegramId(telegramId);
      if (!user) throw new Error('User not found. Run /start first.');

      const nearWallets = await getUserWallets(user.id, 'near');
      const currentWallet = nearWallets.find(w => w.is_active);

      // Check if already active
      if (currentWallet && currentWallet.id === walletId) {
        await ctx.answerCbQuery(`✓ ${currentWallet.name} is already active`).catch(() => { });
        return;
      }

      const switched = await switchActiveNearWallet(telegramId, walletId);
      await ctx.answerCbQuery(`⚡ Switched active wallet to ${switched.name}!`).catch(() => { });
      const menu = await buildWalletsManagementMenu(telegramId);
      const canEdit = typeof (ctx as any).editMessageText === 'function';
      if (canEdit) {
        await (ctx as any).editMessageText(menu.text, { parse_mode: 'HTML', ...menu.keyboard }).catch(async () => {
          await ctx.reply(menu.text, { parse_mode: 'HTML', ...menu.keyboard }).catch(() => { });
        });
      } else {
        await ctx.reply(menu.text, { parse_mode: 'HTML', ...menu.keyboard }).catch(() => { });
      }
    } catch (err: any) {
      await ctx.answerCbQuery(`❌ ${err.message}`).catch(() => { });
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => { });
    }
  });

  bot.action('wallet_import_prompt', async (ctx) => {
    if (isGroupChat(ctx)) {
      await replyGroupDmRedirect(ctx, 'Import NEAR wallet');
      return;
    }
    const telegramId = ctx.from!.id;
    userPendingActions.set(telegramId, {
      action: 'import_near_key',
      expiresAt: Date.now() + 180000,
    });
    await ctx.answerCbQuery().catch(() => { });
    await ctx.reply(
      `📥 <b>Import NEAR Wallet</b>\n\n` +
      `Please reply with your NEAR account private key (e.g. <code>ed25519:...</code> or base58 string).\n\n` +
      `<i>Tip: You can also specify an account ID alongside the key:</i>\n` +
      `<code>myaccount.near ed25519:...</code>\n\n` +
      `🔒 <i>Your message containing the key will be deleted automatically for security.</i>\n\n` +
      `<i>Send /cancel to abort.</i>`,
      { parse_mode: 'HTML' }
    );
  });

  bot.action('wallet_import_active_near', async (ctx) => {
    const telegramId = ctx.from!.id;
    const pending = userPendingActions.get(telegramId);
    if (!pending || pending.action !== 'import_near_confirm') {
      await ctx.answerCbQuery('❌ Session expired. Please start over.').catch(() => { });
      return;
    }

    try {
      await ctx.answerCbQuery().catch(() => { });
      const res = await importNearWallet(
        telegramId,
        pending.importNearPrivateKey!,
        pending.importNearWalletName!,
        pending.importNearAccountId,
        true // Set as active
      );

      let successMsg =
        `🎉 <b>Wallet Imported Successfully!</b>\n\n` +
        `• <b>Name:</b> ${res.wallet.name}\n` +
        `• <b>Account:</b> <code>${res.accountId}</code>\n` +
        `• <b>Status:</b> 🟢 Active (now your primary NEAR trading wallet)\n\n`;

      if (!res.isFullAccess) {
        successMsg += `⚠️ <i>Note: This key does not have FullAccess permissions on-chain. Some DEX swaps may fail if contract calls are restricted.</i>\n\n`;
      }

      successMsg += `Your balances and all future NEAR trades now use this wallet.`;

      await ctx.reply(successMsg, { parse_mode: 'HTML' });
      const walletMenu = await buildWalletMenu(telegramId, true);
      await ctx.reply(walletMenu.text, { parse_mode: 'HTML', ...walletMenu.keyboard });
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
    }
    userPendingActions.delete(telegramId);
  });

  bot.action('wallet_import_inactive_near', async (ctx) => {
    const telegramId = ctx.from!.id;
    const pending = userPendingActions.get(telegramId);
    if (!pending || pending.action !== 'import_near_confirm') {
      await ctx.answerCbQuery('❌ Session expired. Please start over.').catch(() => { });
      return;
    }

    try {
      await ctx.answerCbQuery().catch(() => { });
      const res = await importNearWallet(
        telegramId,
        pending.importNearPrivateKey!,
        pending.importNearWalletName!,
        pending.importNearAccountId,
        false // Do NOT set as active
      );

      let successMsg =
        `🎉 <b>Wallet Imported Successfully!</b>\n\n` +
        `• <b>Name:</b> ${res.wallet.name}\n` +
        `• <b>Account:</b> <code>${res.accountId}</code>\n` +
        `• <b>Status:</b> ⚪ Inactive (added to your wallet list)\n\n`;

      if (!res.isFullAccess) {
        successMsg += `⚠️ <i>Note: This key does not have FullAccess permissions on-chain. Some DEX swaps may fail if contract calls are restricted.</i>\n\n`;
      }

      successMsg += `Use the /wallets command to set this wallet as active when needed.`;

      await ctx.reply(successMsg, { parse_mode: 'HTML' });
      const menu = await buildWalletsManagementMenu(telegramId);
      await ctx.reply(menu.text, { parse_mode: 'HTML', ...menu.keyboard });
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
    }
    userPendingActions.delete(telegramId);
  });

  bot.action(/^(?:w_ren_near|wallet_rename_prompt):(.+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const walletId = ctx.match![1];
    userPendingActions.set(telegramId, {
      action: 'rename_near_wallet',
      renameWalletId: walletId,
      expiresAt: Date.now() + 180000,
    });
    await ctx.answerCbQuery().catch(() => { });
    await ctx.reply(
      `✏️ <b>Rename Wallet</b>\n\n` +
      `Please reply with the new name for this wallet (e.g. <i>Sniper</i>, <i>Main</i>, <i>Degen</i>):\n\n` +
      `_Send /cancel to abort._`,
      { parse_mode: 'HTML' }
    );
  });

  bot.action(/^(?:w_del_near|wallet_delete_confirm):(.+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const walletId = ctx.match![1];
    try {
      const res = await deleteUserNearWallet(telegramId, walletId);
      await ctx.answerCbQuery('Wallet deleted.').catch(() => { });
      let msg = `🗑️ Wallet deleted successfully.`;
      if (res.fallbackWallet) {
        msg += ` Active wallet switched to <b>${res.fallbackWallet.name}</b>.`;
      }
      await ctx.reply(msg, { parse_mode: 'HTML' });
      const menu = await buildWalletsManagementMenu(telegramId);
      await ctx.reply(menu.text, { parse_mode: 'HTML', ...menu.keyboard });
    } catch (err: any) {
      await ctx.answerCbQuery(`❌ ${err.message}`).catch(() => { });
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
    }
  });

  bot.action(/^(?:w_sw_sui|wallet_switch_sui):(.+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const walletId = ctx.match![1];
    try {
      const user = await getUserByTelegramId(telegramId);
      if (!user) throw new Error('User not found. Run /start first.');

      const suiWallets = await getUserWallets(user.id, 'sui');
      const currentWallet = suiWallets.find(w => w.is_active);

      // Check if already active
      if (currentWallet && currentWallet.id === walletId) {
        await ctx.answerCbQuery(`✓ ${currentWallet.name} is already active`).catch(() => { });
        return;
      }

      const switched = await switchActiveSuiWallet(telegramId, walletId);
      await ctx.answerCbQuery(`⚡ Switched active SUI wallet to ${switched.name}!`).catch(() => { });
      const menu = await buildWalletsManagementMenu(telegramId);
      const canEdit = typeof (ctx as any).editMessageText === 'function';
      if (canEdit) {
        await (ctx as any).editMessageText(menu.text, { parse_mode: 'HTML', ...menu.keyboard }).catch(async () => {
          await ctx.reply(menu.text, { parse_mode: 'HTML', ...menu.keyboard });
        });
      } else {
        await ctx.reply(menu.text, { parse_mode: 'HTML', ...menu.keyboard });
      }
    } catch (err: any) {
      await ctx.answerCbQuery(`❌ ${err.message}`).catch(() => { });
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
    }
  });

  bot.action('wallet_import_sui_prompt', async (ctx) => {
    if (isGroupChat(ctx)) {
      await replyGroupDmRedirect(ctx, 'Import SUI wallet');
      return;
    }
    const telegramId = ctx.from!.id;
    userPendingActions.set(telegramId, {
      action: 'import_sui_key',
      expiresAt: Date.now() + 180000,
    });
    await ctx.answerCbQuery().catch(() => { });
    await ctx.reply(
      `📥 <b>Import SUI Wallet</b>\n\n` +
      `Please reply with your SUI private key.\n\n` +
      `Supported formats:\n` +
      `• Standard Bech32 (<code>suiprivkey1...</code>)\n` +
      `• 32-byte or 64-byte Hex (with or without <code>0x</code>)\n` +
      `• Base64 or Base58\n\n` +
      `🔒 <i>Your message containing the key will be deleted automatically for security.</i>\n\n` +
      `<i>Send /cancel to abort.</i>`,
      { parse_mode: 'HTML' }
    );
  });

  bot.action('wallet_import_active_sui', async (ctx) => {
    const telegramId = ctx.from!.id;
    const pending = userPendingActions.get(telegramId);
    if (!pending || pending.action !== 'import_sui_confirm') {
      await ctx.answerCbQuery('❌ Session expired. Please start over.').catch(() => { });
      return;
    }

    try {
      await ctx.answerCbQuery().catch(() => { });
      const res = await importSuiWallet(
        telegramId,
        pending.importSuiPrivateKey!,
        pending.importSuiWalletName!,
        true // Set as active
      );

      const successMsg =
        `🎉 <b>SUI Wallet Imported Successfully!</b>\n\n` +
        `• <b>Name:</b> ${res.wallet.name}\n` +
        `• <b>Address:</b> <code>${res.address}</code>\n` +
        `• <b>Status:</b> 🟢 Active (now your primary SUI trading wallet)\n\n` +
        `Your balances and all future SUI trades now use this wallet.`;

      await ctx.reply(successMsg, { parse_mode: 'HTML' });
      const walletMenu = await buildWalletMenu(telegramId, true);
      await ctx.reply(walletMenu.text, { parse_mode: 'HTML', ...walletMenu.keyboard });
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
    }
    userPendingActions.delete(telegramId);
  });

  bot.action('wallet_import_inactive_sui', async (ctx) => {
    const telegramId = ctx.from!.id;
    const pending = userPendingActions.get(telegramId);
    if (!pending || pending.action !== 'import_sui_confirm') {
      await ctx.answerCbQuery('❌ Session expired. Please start over.').catch(() => { });
      return;
    }

    try {
      await ctx.answerCbQuery().catch(() => { });
      const res = await importSuiWallet(
        telegramId,
        pending.importSuiPrivateKey!,
        pending.importSuiWalletName!,
        false // Do NOT set as active
      );

      const successMsg =
        `🎉 <b>SUI Wallet Imported Successfully!</b>\n\n` +
        `• <b>Name:</b> ${res.wallet.name}\n` +
        `• <b>Address:</b> <code>${res.address}</code>\n` +
        `• <b>Status:</b> ⚪ Inactive (added to your wallet list)\n\n` +
        `Use the /wallets command to set this wallet as active when needed.`;

      await ctx.reply(successMsg, { parse_mode: 'HTML' });
      const menu = await buildWalletsManagementMenu(telegramId);
      await ctx.reply(menu.text, { parse_mode: 'HTML', ...menu.keyboard });
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
    }
    userPendingActions.delete(telegramId);
  });

  bot.action(/^(?:w_ren_sui|wallet_rename_sui_prompt):(.+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const walletId = ctx.match![1];
    userPendingActions.set(telegramId, {
      action: 'rename_sui_wallet',
      renameSuiWalletId: walletId,
      expiresAt: Date.now() + 180000,
    });
    await ctx.answerCbQuery().catch(() => { });
    await ctx.reply(
      `✏️ <b>Rename SUI Wallet</b>\n\n` +
      `Please reply with the new name for this wallet (e.g. <i>Sui Whale</i>, <i>Sniper</i>, <i>Degen</i>):\n\n` +
      `_Send /cancel to abort._`,
      { parse_mode: 'HTML' }
    );
  });

  bot.action(/^(?:w_del_sui|wallet_delete_sui_confirm):(.+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const walletId = ctx.match![1];
    try {
      const res = await deleteUserSuiWallet(telegramId, walletId);
      await ctx.answerCbQuery('Wallet deleted.').catch(() => { });
      let msg = `🗑️ SUI wallet deleted successfully.`;
      if (res.fallbackWallet) {
        msg += ` Active SUI wallet switched to <b>${res.fallbackWallet.name}</b>.`;
      }
      await ctx.reply(msg, { parse_mode: 'HTML' });
      const menu = await buildWalletsManagementMenu(telegramId);
      await ctx.reply(menu.text, { parse_mode: 'HTML', ...menu.keyboard });
    } catch (err: any) {
      await ctx.answerCbQuery(`❌ ${err.message}`).catch(() => { });
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
    }
  });

  const handleNewStarknet = async (ctx: Context) => {
    const telegramId = ctx.from!.id;
    try {
      const user = await getUserByTelegramId(telegramId);
      if (!user) throw new Error('User not found. Run /start first.');
      const newWallet = await resetUserStarknetWallet(user.id);
      await ctx.reply(
        `⚡ <b>New Starknet Wallet Generated!</b>\n\n` +
        `<b>Address:</b>\n<code>${newWallet.address}</code>\n\n` +
        `🛡️ <b>Standard:</b> OpenZeppelin v0.8.1 Account Abstraction\n` +
        `💰 <b>Next Step:</b> Deposit STRK or ETH to this address. Your account contract will automatically deploy on your first swap!`,
        { parse_mode: 'HTML' }
      );
      const menu = await buildWalletsManagementMenu(telegramId);
      await ctx.reply(menu.text, { parse_mode: 'HTML', ...menu.keyboard }).catch(() => { });
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => { });
    }
  };

  bot.command('newstarknet', handleNewStarknet);
  bot.action('wallet_new_starknet', async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => { });
      await handleNewStarknet(ctx);
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  bot.action(/^(?:w_sw_sn|wallet_switch_starknet):(.+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const walletId = ctx.match![1];
    try {
      const user = await getUserByTelegramId(telegramId);
      if (!user) throw new Error('User not found. Run /start first.');

      const starknetWallets = await getUserWallets(user.id, 'starknet');
      const currentWallet = starknetWallets.find(w => w.is_active);

      // Check if already active
      if (currentWallet && currentWallet.id === walletId) {
        await ctx.answerCbQuery(`✓ ${currentWallet.name} is already active`).catch(() => { });
        return;
      }

      const switched = await switchActiveStarknetWallet(telegramId, walletId);
      await ctx.answerCbQuery(`⚡ Switched active Starknet wallet to ${switched.name}!`).catch(() => { });
      const menu = await buildWalletsManagementMenu(telegramId);
      const canEdit = typeof (ctx as any).editMessageText === 'function';
      if (canEdit) {
        await (ctx as any).editMessageText(menu.text, { parse_mode: 'HTML', ...menu.keyboard }).catch(async () => {
          await ctx.reply(menu.text, { parse_mode: 'HTML', ...menu.keyboard });
        });
      } else {
        await ctx.reply(menu.text, { parse_mode: 'HTML', ...menu.keyboard });
      }
    } catch (err: any) {
      await ctx.answerCbQuery(`❌ ${err.message}`).catch(() => { });
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
    }
  });

  bot.action(/^(?:w_ren_sn|wallet_rename_starknet_prompt):(.+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const walletId = ctx.match![1];
    userPendingActions.set(telegramId, {
      action: 'rename_starknet_wallet',
      renameStarknetWalletId: walletId,
      expiresAt: Date.now() + 180000,
    });
    await ctx.answerCbQuery().catch(() => { });
    await ctx.reply(
      `✏️ <b>Rename Starknet Wallet</b>\n\n` +
      `Please reply with the new name for this wallet (e.g. <i>Starknet Main</i>, <i>Sniper</i>, <i>Degen</i>):\n\n` +
      `_Send /cancel to abort._`,
      { parse_mode: 'HTML' }
    );
  });

  bot.action(/^wallet_pick_acc:(.+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const chosenAccount = ctx.match![1];
    const pending = userPendingActions.get(telegramId);
    if (!pending || !pending.importNearPrivateKey) {
      await ctx.answerCbQuery('Session expired. Please try importing again.').catch(() => { });
      return;
    }
    userPendingActions.set(telegramId, {
      action: 'import_near_name',
      importNearPrivateKey: pending.importNearPrivateKey,
      importNearAccountId: chosenAccount,
      expiresAt: Date.now() + 180000,
    });
    await ctx.answerCbQuery().catch(() => { });
    await ctx.reply(
      `✅ Selected account: <code>${chosenAccount}</code>\n\n` +
      `Please reply with a nickname for this wallet (e.g. <i>Sniper</i>, <i>Main</i>, <i>Degen</i>):\n\n` +
      `_Send /cancel to abort._`,
      { parse_mode: 'HTML' }
    );
  });

  bot.action('wallet_refresh', async (ctx) => {
    const telegramId = ctx.from!.id;
    userPendingActions.delete(telegramId);
    try {
      await ctx.answerCbQuery('🔄 Refreshing wallet...').catch(() => { });
      const wallet = await buildWalletMenu(telegramId, true);
      const canEdit = typeof (ctx as any).editMessageText === 'function';
      if (canEdit) {
        await (ctx as any).editMessageText(wallet.text, { parse_mode: 'HTML', ...wallet.keyboard }).catch(async (err: any) => {
          if (err?.message?.includes('message is not modified')) return;
          await ctx.reply(wallet.text, { parse_mode: 'HTML', ...wallet.keyboard });
        });
      } else {
        await ctx.reply(wallet.text, { parse_mode: 'HTML', ...wallet.keyboard });
      }
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => { });
    }
  });

  bot.action('wallet_unwrap', async (ctx) => {
    const telegramId = ctx.from!.id;
    await ctx.answerCbQuery('Unwrapping wNEAR...').catch(() => { });
    try {
      const res = await unwrapUserWrapNear(telegramId);
      if (res.unwrappedAmount === '0') {
        await ctx.reply('ℹ️ You do not have any wNEAR balance to unwrap.');
      } else {
        await ctx.reply(`✅ Successfully unwrapped ${res.unwrappedAmount} wNEAR into native NEAR!`);
      }
      const wallet = await buildWalletMenu(telegramId, true);
      await ctx.reply(wallet.text, { parse_mode: 'HTML', ...wallet.keyboard });
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
    }
  });

  bot.command('unwrap', async (ctx) => {
    const telegramId = ctx.from!.id;
    try {
      const res = await unwrapUserWrapNear(telegramId);
      if (res.unwrappedAmount === '0') {
        await ctx.reply('ℹ️ You do not have any wNEAR balance to unwrap.');
      } else {
        await ctx.reply(`✅ Successfully unwrapped ${res.unwrappedAmount} wNEAR into native NEAR!`);
        const wallet = await buildWalletMenu(telegramId, true);
        await ctx.reply(wallet.text, { parse_mode: 'HTML', ...wallet.keyboard });
      }
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
    }
  });

  // Helper: parse withdrawal/send command or prompt arguments
  const parseTransferArgs = (parts: string[]): {
    destination?: string;
    amount?: number | 'all';
    token?: string;
  } => {
    if (parts.length === 0) return {};
    let destination: string | undefined;
    let amount: number | 'all' | undefined;
    let token: string | undefined;
    const remaining: string[] = [];

    for (const part of parts) {
      const lower = part.toLowerCase();
      if (amount === undefined && (lower === 'all' || (/^\d+(\.\d+)?$/.test(lower) && !isNaN(parseFloat(lower))))) {
        amount = lower === 'all' ? 'all' : parseFloat(lower);
      } else {
        remaining.push(part);
      }
    }

    if (remaining.length === 1) {
      destination = remaining[0];
    } else if (remaining.length >= 2) {
      const first = remaining[0];
      const second = remaining[1];
      if (isSolanaAddress(first) && (second.toLowerCase() === 'sol' || isSolanaToken(second))) {
        destination = first;
        token = second;
      } else if (isSolanaAddress(second) && (first.toLowerCase() === 'sol' || isSolanaToken(first))) {
        token = first;
        destination = second;
      } else if (second.includes('.tkn.near') || (!second.includes('.') && !isValidSuiAddress(second))) {
        destination = first;
        token = second;
      } else if (first.includes('.tkn.near') || (!first.includes('.') && !isValidSuiAddress(first))) {
        token = first;
        destination = second;
      } else {
        destination = first;
        token = second;
      }
    }

    return { destination, amount, token };
  };

  bot.action('wallet_withdraw_prompt', async (ctx) => {
    const telegramId = ctx.from!.id;
    userPendingActions.set(telegramId, {
      action: 'withdraw',
      expiresAt: Date.now() + 180000,
    });
    await ctx.answerCbQuery().catch(() => { });

    const b = await getUserBalances(telegramId).catch(() => null);
    let balSummary = '';
    if (b) {
      balSummary = '💳 *Available to Withdraw:*\n' +
        '• ⬛ NEAR: `' + b.nativeNearFormatted + ' Ⓝ` (Total: ' + (b.onChainNearFormatted || b.nativeNearFormatted) + ' Ⓝ, 0.05 Ⓝ reserved for storage)\n';
      if (Number(b.wrapNearFormatted || '0') > 0.0001) {
        balSummary += '  _(+ ' + b.wrapNearFormatted + ' wNEAR will auto-unwrap on withdrawal)_\n';
      }
      if (b.solBalanceFormatted && Number(b.solBalanceFormatted) > 0) {
        balSummary += '• 🟣 SOL: `' + b.solBalanceFormatted + ' SOL`\n';
      }
      if (b.suiBalanceFormatted && Number(b.suiBalanceFormatted) > 0) {
        balSummary += '• 🔷 SUI: `' + b.suiBalanceFormatted + ' SUI`\n';
      }
      if (b.strkBalanceFormatted && Number(b.strkBalanceFormatted) > 0) {
        balSummary += '• ✨ STRK: `' + b.strkBalanceFormatted + ' STRK`\n';
      }
      if (b.hyperevmBalanceFormatted && Number(b.hyperevmBalanceFormatted) > 0) {
        balSummary += '• ⚡ HYPE: `' + b.hyperevmBalanceFormatted + ' HYPE`\n';
      }
      balSummary += '\n';
    }

    await ctx.reply(
      '💸 *Withdraw & Send Funds (SOL, NEAR, SUI, Starknet & Tokens)*\n\n' +
      balSummary +
      'Reply with the recipient address, amount, and optional token, for example:\n' +
      '• *SOL*: `<solana_address> 0.5` or `<solana_address> all`\n' +
      '• *NEAR*: `mywallet.near 1.5` or `mywallet.near all`\n' +
      '• *Token*: `mywallet.near 100 LONK` or `mywallet.near all blackdragon.tkn.near`\n' +
      '• *SUI*: `0x1234...abcd 1.0 SUI` or `0x1234...abcd all SUI`\n' +
      '• *Starknet*: `0x1234...abcd 10 STRK` or `0x1234...abcd all STRK`\n\n' +
      '_Type /cancel or tap Cancel below to abort._',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [cb('🎒 Send Token from Bags', 'wallet_withdraw_tokens_list', 'primary')],
          [cb('❌ Cancel', 'withdraw_cancel', 'primary'), cb('🔙 Back to Wallet', 'wallet_refresh', 'primary')],
        ]),
      }
    );
  });

  bot.action('withdraw_cancel', async (ctx) => {
    const telegramId = ctx.from!.id;
    userPendingActions.delete(telegramId);
    await ctx.answerCbQuery('Withdrawal cancelled.').catch(() => { });
    try {
      const wallet = await buildWalletMenu(telegramId, false);
      await ctx.reply(wallet.text, { parse_mode: 'HTML', ...wallet.keyboard }).catch(() => { });
    } catch { }
  });

  bot.action('wallet_withdraw_tokens_list', async (ctx) => {
    const telegramId = ctx.from!.id;
    await ctx.answerCbQuery().catch(() => { });
    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await ctx.reply('Please run /start first.');
      return;
    }
    const positions = await getOpenPositions(user.id).catch(() => []);
    if (positions.length === 0) {
      await ctx.reply(
        '📭 *No Token Holdings*\n\n' +
        'You currently have no token holdings in your wallet to send.\n' +
        'Deposit tokens to your wallet or buy some first!',
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [cb('💸 Withdraw NEAR/SUI', 'wallet_withdraw_prompt', 'primary')],
            [cb('🔙 Back to Wallet', 'wallet_refresh', 'primary')],
          ]),
        }
      );
      return;
    }

    const btnRows: any[] = [];
    for (const pos of positions.slice(0, 15)) {
      const info = await getTokenInfo(pos.token_address, false).catch(() => null);
      const sym = info?.symbol || pos.token_address.split('.')[0].toUpperCase();
      const isSuiPos = pos.chain === 'sui' || isSuiToken(pos.token_address);
      const decimals = info?.decimals ?? (isSuiPos ? 6 : 18);
      let humanQty = '';
      try {
        const rawBig = BigInt((pos.quantity_held || '0').split('.')[0]);
        const qty = Number(rawBig) / Math.pow(10, decimals);
        humanQty = qty >= 1_000_000 ? `${(qty / 1_000_000).toFixed(2)}M` : qty.toLocaleString('en-US', { maximumFractionDigits: 2 });
      } catch {
        humanQty = pos.quantity_held;
      }
      btnRows.push([cb(`📤 Send ${sym} (${humanQty})`, `send_token_prompt:${pos.id}`, 'primary')]);
    }
    btnRows.push([
      cb('💸 Withdraw NEAR/SUI', 'wallet_withdraw_prompt', 'primary'),
      cb('🔙 Back to Wallet', 'wallet_refresh', 'primary'),
    ]);

    await ctx.reply(
      '🎒 *Select Token to Send*\n\n' +
      'Choose a token from your bags to withdraw / send:',
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard(btnRows) }
    );
  });

  bot.action(/^send_token_prompt:([^:]+)$/, async (ctx) => {
    const positionId = ctx.match![1];
    const telegramId = ctx.from!.id;
    await ctx.answerCbQuery().catch(() => { });
    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await ctx.reply('Please run /start first.');
      return;
    }
    const positions = await getOpenPositions(user.id).catch(() => []);
    const pos = positions.find((p) => p.id === positionId);
    if (!pos) {
      await ctx.reply('Position not found or already closed.');
      return;
    }

    const info = await getTokenInfo(pos.token_address, false).catch(() => null);
    const sym = info?.symbol || pos.token_address.split('.')[0].toUpperCase();
    const isSuiPos = pos.chain === 'sui' || isSuiToken(pos.token_address);
    const decimals = info?.decimals ?? (isSuiPos ? 6 : 18);
    let humanQty = '';
    try {
      const rawBig = BigInt((pos.quantity_held || '0').split('.')[0]);
      const qty = Number(rawBig) / Math.pow(10, decimals);
      humanQty = qty >= 1_000_000 ? `${(qty / 1_000_000).toFixed(2)}M` : qty.toLocaleString('en-US', { maximumFractionDigits: 4 });
    } catch {
      humanQty = pos.quantity_held;
    }

    userPendingActions.set(telegramId, {
      action: 'withdraw',
      tokenAddress: pos.token_address,
      positionId: pos.id,
      expiresAt: Date.now() + 180000,
    });

    await ctx.reply(
      `📤 *Send $${sanitizeMd(sym)}*\n\n` +
      `💰 Balance: \`${humanQty} ${sanitizeMd(sym)}\`\n` +
      `📋 Contract: \`${pos.token_address}\`\n\n` +
      `Reply with the recipient address and amount, for example:\n` +
      `• \`recipient.near 100\`\n` +
      `• \`recipient.near all\`\n\n` +
      `_Type /cancel to abort transfer._`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── /withdraw, /send, /transfer <destination> [amount] [token] ─────────────
  const handleWithdrawCommand = async (ctx: Context) => {
    const telegramId = ctx.from!.id;
    const msgText = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
    const args = msgText.split(' ').slice(1).filter(Boolean);

    if (args.length === 0) {
      userPendingActions.set(telegramId, {
        action: 'withdraw',
        expiresAt: Date.now() + 180000,
      });
      await ctx.reply(
        `💸 *Withdraw & Send Funds (SOL, NEAR, SUI, Starknet & Tokens)*\n\n` +
        `*Usage:*\n` +
        `• Native SOL: \`/send <solana_address> <amount>\`\n` +
        `• Native NEAR: \`/send <destination> <amount>\`\n` +
        `• Token: \`/send <destination> <amount> <token>\`\n` +
        `• Native SUI: \`/send <sui_address> <amount> SUI\`\n` +
        `• Native STRK: \`/send <starknet_address> <amount> STRK\`\n\n` +
        `*Examples:*\n` +
        `• \`/send <solana_address> 0.5\` or \`/send <solana_address> all\`\n` +
        `• \`/send mywallet.near 1.5\`\n` +
        `• \`/send mywallet.near 500 LONK\`\n` +
        `• \`/send 0x1234...abcd 1.0 SUI\`\n` +
        `• \`/send 0x1234...abcd 10 STRK\`\n\n` +
        `Or reply directly now with destination and amount!`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [cb('🎒 Send Token from Bags', 'wallet_withdraw_tokens_list', 'primary')],
            [cb('🔙 Back to Wallet', 'wallet_refresh', 'primary')],
          ]),
        }
      );
      return;
    }

    const parsed = parseTransferArgs(args);
    if (!parsed.destination) {
      await ctx.reply('❌ Please specify a destination recipient address.');
      return;
    }

    const destination = parsed.destination.trim();
    const amountNum: number | 'all' = parsed.amount === undefined || parsed.amount === 'all' ? 'all' : parsed.amount;
    const tokenArg = parsed.token;

    if (typeof amountNum === 'number' && (isNaN(amountNum) || amountNum <= 0)) {
      await ctx.reply('❌ Invalid amount. Please specify a positive number or "all".');
      return;
    }

    const targetDesc = tokenArg ? `token \`${tokenArg}\`` : 'funds';
    await ctx.reply(`⏳ Processing transfer of ${targetDesc} to \`${destination}\`...`, { parse_mode: 'Markdown' });

    try {
      const isSolDest = isSolanaAddress(destination);
      const isNearDest = destination.endsWith('.near') || (!isSolDest && !destination.startsWith('0x') && isValidNearAccountId(destination));
      const isSuiDest = isValidSuiAddress(destination) && !destination.endsWith('.near');
      const isStarknetDest = isValidStarknetAddress(destination) && !destination.endsWith('.near');
      const normToken = (tokenArg || '').toLowerCase();
      const isStrkOrEth = normToken === 'strk' || normToken === 'eth';
      const isSolNative = normToken === 'sol' || (!tokenArg && isSolDest);
      const isExplicitToken = tokenArg && normToken !== 'near' && normToken !== 'sui' && normToken !== 'sol' && !isStrkOrEth;

      if (isSolNative) {
        const result = await withdrawSolanaFunds(telegramId, destination, amountNum);
        await ctx.reply(
          `✅ *SOL Withdrawal Successful!*\n\n` +
          `💸 Amount: \`${result.amountWithdrawn} SOL\`\n` +
          `📬 Destination: \`${result.destination}\`\n\n` +
          `🔗 Explorer: [View on Solscan](https://solscan.io/tx/${result.txHash})`,
          { parse_mode: 'Markdown' }
        );
      } else if (isExplicitToken) {
        const result = await withdrawTokenFunds(telegramId, tokenArg, destination, amountNum);
        const explorerUrl =
          result.chain === 'solana'
            ? `https://solscan.io/tx/${result.txHash}`
            : result.chain === 'starknet'
              ? `https://voyager.online/tx/${result.txHash}`
              : result.chain === 'sui'
                ? `https://suiscan.xyz/mainnet/tx/${result.txHash}`
                : `https://nearblocks.io/txns/${result.txHash}`;
        const explorerName = result.chain === 'solana' ? 'Solscan' : result.chain === 'starknet' ? 'Voyager' : result.chain === 'sui' ? 'Suiscan' : 'NearBlocks';

        await ctx.reply(
          `✅ *Token Transfer Successful!*\n\n` +
          `💸 Amount: \`${result.amountWithdrawn} ${result.symbol}\`\n` +
          `📬 Destination: \`${result.destination}\`\n` +
          `🪙 Contract: \`${result.tokenAddress}\`\n\n` +
          `🔗 Explorer: [View on ${explorerName}](${explorerUrl})`,
          { parse_mode: 'Markdown' }
        );
      } else if (isStrkOrEth) {
        const result = await withdrawStarknetFunds(telegramId, destination, amountNum, normToken);
        await ctx.reply(
          `✅ *Starknet Transfer Successful!*\n\n` +
          `💸 Amount: \`${result.amountWithdrawn} ${result.symbol}\`\n` +
          `📬 Destination: \`${result.destination}\`\n\n` +
          `🔗 Explorer: [View on Voyager](https://voyager.online/tx/${result.txHash})`,
          { parse_mode: 'Markdown' }
        );
      } else if (normToken === 'sui') {
        const result = await withdrawSuiFunds(telegramId, destination, amountNum);
        await ctx.reply(
          `✅ *SUI Withdrawal Successful!*\n\n` +
          `💸 Amount: \`${result.amountWithdrawn} SUI\`\n` +
          `📬 Destination: \`${result.destination}\`\n\n` +
          `🔗 Explorer: [View on Suiscan](https://suiscan.xyz/mainnet/tx/${result.txHash})`,
          { parse_mode: 'Markdown' }
        );
      } else if (isStarknetDest && !isNearDest) {
        // Resolve between SUI and Starknet by checking user balances
        const user = await getUserByTelegramId(telegramId);
        const [suiBal, strkBal] = await Promise.all([
          user?.sui_address ? getSuiBalance(user.sui_address).catch(() => ({ mist: 0n })) : { mist: 0n },
          user?.starknet_address ? getStarknetBalance(user.starknet_address).catch(() => ({ strk: 0n })) : { strk: 0n },
        ]);

        if (strkBal.strk > 0n && suiBal.mist === 0n) {
          const result = await withdrawStarknetFunds(telegramId, destination, amountNum, 'strk');
          await ctx.reply(
            `✅ *Starknet Withdrawal Successful!*\n\n` +
            `💸 Amount: \`${result.amountWithdrawn} ${result.symbol}\`\n` +
            `📬 Destination: \`${result.destination}\`\n\n` +
            `🔗 Explorer: [View on Voyager](https://voyager.online/tx/${result.txHash})`,
            { parse_mode: 'Markdown' }
          );
        } else if (suiBal.mist > 0n && strkBal.strk === 0n) {
          const result = await withdrawSuiFunds(telegramId, destination, amountNum);
          await ctx.reply(
            `✅ *SUI Withdrawal Successful!*\n\n` +
            `💸 Amount: \`${result.amountWithdrawn} SUI\`\n` +
            `📬 Destination: \`${result.destination}\`\n\n` +
            `🔗 Explorer: [View on Suiscan](https://suiscan.xyz/mainnet/tx/${result.txHash})`,
            { parse_mode: 'Markdown' }
          );
        } else {
          await ctx.reply(
            `⚠️ Destination \`${destination}\` is a 0x hex address valid on both SUI and Starknet.\n` +
            `Please specify the token to transfer, for example:\n` +
            `• \`/send ${destination} ${amountNum} STRK\`\n` +
            `• \`/send ${destination} ${amountNum} SUI\``,
            { parse_mode: 'Markdown' }
          );
        }
      } else {
        const result = await withdrawFunds(telegramId, destination, amountNum);
        await ctx.reply(
          `✅ *Withdrawal Successful!*\n\n` +
          `💸 Amount: \`${result.amountWithdrawn} NEAR\`\n` +
          `📬 Destination: \`${result.destination}\`\n\n` +
          `🔗 Explorer: [View on NearBlocks](https://nearblocks.io/txns/${result.txHash})`,
          { parse_mode: 'Markdown' }
        );
      }
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
    }
  };

  bot.command(['withdraw', 'send', 'transfer'], handleWithdrawCommand);

  // ── /settings & /filters — Interactive Settings Dashboard ─────────────────
  const handleSettings = async (ctx: Context) => {
    const telegramId = ctx.from!.id;
    try {
      const user = await getUserByTelegramId(telegramId);
      if (!user) {
        await ctx.reply('Please run /start first.');
        return;
      }
      const dash = buildSettingsDashboard(user);
      await ctx.reply(dash.text, { parse_mode: 'Markdown', ...dash.keyboard });
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
    }
  };

  bot.command('settings', handleSettings);
  bot.command('filters', handleSettings);

  const handleActiveChains = async (ctx: Context) => {
    const telegramId = ctx.from!.id;
    try {
      const user = await getUserByTelegramId(telegramId);
      if (!user) {
        await ctx.reply('Please run /start first.');
        return;
      }
      const menu = buildActiveChainsMenu(user);
      await ctx.reply(menu.text, { parse_mode: 'Markdown', ...menu.keyboard });
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
    }
  };

  bot.command(['chains', 'chain', 'activechains'], handleActiveChains);

  bot.action('menu_active_chains', async (ctx) => {
    const telegramId = ctx.from!.id;
    try {
      const user = await getUserByTelegramId(telegramId);
      if (!user) {
        await ctx.answerCbQuery('Please run /start first.').catch(() => { });
        return;
      }
      const menu = buildActiveChainsMenu(user);
      await ctx.answerCbQuery().catch(() => { });
      await ctx.editMessageText(menu.text, { parse_mode: 'Markdown', ...menu.keyboard }).catch(() => { });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  bot.action(/^toggle_chain_vis:(.+)$/, async (ctx) => {
    try {
      const telegramId = ctx.from!.id;
      const user = await getUserByTelegramId(telegramId);
      if (!user) return;
      const targetChain = ctx.match[1];
      const hiddenList = Array.isArray(user.hidden_chains) ? [...user.hidden_chains] : [];
      const isCurrentlyHidden = hiddenList.includes(targetChain);

      if (!isCurrentlyHidden) {
        // Trying to hide this chain: verify at least one visible chain remains
        const visibleCount = ALL_SUPPORTED_CHAINS.filter(c => !hiddenList.includes(c.id)).length;
        if (visibleCount <= 1) {
          await ctx.answerCbQuery('⚠️ At least one chain must remain visible!', { show_alert: true }).catch(() => { });
          return;
        }
        hiddenList.push(targetChain);
      } else {
        // Unhide this chain
        const idx = hiddenList.indexOf(targetChain);
        if (idx !== -1) hiddenList.splice(idx, 1);
      }

      const updated = await updateUserSettings(user.id, { hidden_chains: hiddenList });
      mainMenuCache.delete(telegramId);
      walletMenuCache.delete(telegramId);
      invalidateBalanceCache(telegramId);

      const chainObj = ALL_SUPPORTED_CHAINS.find(c => c.id === targetChain);
      const chainName = chainObj ? chainObj.name : targetChain;
      const statusText = !isCurrentlyHidden ? `Hidden ${chainName}` : `Enabled ${chainName}`;
      await ctx.answerCbQuery(`✅ ${statusText}`).catch(() => { });

      const menu = buildActiveChainsMenu(updated);
      await ctx.editMessageText(menu.text, { parse_mode: 'Markdown', ...menu.keyboard }).catch(() => { });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  bot.action(/^preset_chain_vis:(.+)$/, async (ctx) => {
    try {
      const telegramId = ctx.from!.id;
      const user = await getUserByTelegramId(telegramId);
      if (!user) return;
      const preset = ctx.match[1];
      let newHidden: string[] = [];

      if (preset === 'near') {
        newHidden = ['solana', 'sui', 'starknet'];
      } else if (preset === 'solana') {
        newHidden = ['near', 'sui', 'starknet'];
      } else if (preset === 'sui') {
        newHidden = ['near', 'solana', 'starknet'];
      } else if (preset === 'all') {
        newHidden = [];
      } else {
        return;
      }

      const updated = await updateUserSettings(user.id, { hidden_chains: newHidden });
      mainMenuCache.delete(telegramId);
      walletMenuCache.delete(telegramId);
      invalidateBalanceCache(telegramId);

      const presetLabels = {
        near: '⬛ NEAR Only mode enabled',
        solana: '🟣 Solana Only mode enabled',
        sui: '🔷 Sui Only mode enabled',
        all: '🌐 All chains enabled',
      };
      await ctx.answerCbQuery(`✅ ${presetLabels[preset] || 'Preset applied'}`).catch(() => { });

      const menu = buildActiveChainsMenu(updated);
      await ctx.editMessageText(menu.text, { parse_mode: 'Markdown', ...menu.keyboard }).catch(() => { });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  // Settings Dashboard Button Actions
  bot.action('set:toggle_auto_buy', async (ctx) => {
    try {
      const telegramId = ctx.from!.id;
      const user = await getUserByTelegramId(telegramId);
      if (!user) return;
      const newStatus = !user.auto_buy_enabled;
      const updated = await updateUserSettings(user.id, { auto_buy_enabled: newStatus });
      await ctx.answerCbQuery(`Auto-buy ${newStatus ? 'enabled' : 'disabled'}`).catch(() => { });
      const dash = await buildSnipeDashboard(updated);
      await ctx.editMessageText(dash.text, { parse_mode: 'Markdown', ...dash.keyboard }).catch(() => { });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  bot.action('set:toggle_near_currency', async (ctx) => {
    try {
      const telegramId = ctx.from!.id;
      const user = await getUserByTelegramId(telegramId);
      if (!user) return;
      const nextMode = user.near_trade_currency === 'usdc' ? 'near' : 'usdc';
      const updated = await updateUserSettings(user.id, { near_trade_currency: nextMode });
      invalidateBalanceCache(telegramId);
      await ctx.answerCbQuery(nextMode === 'usdc' ? '💵 NEAR Mode set to USDC Only (Buy & Sell in USDC)' : '⬛ NEAR Mode set to NEAR + USDC').catch(() => { });
      const dash = buildSettingsDashboard(updated);
      await ctx.editMessageText(dash.text, { parse_mode: 'Markdown', ...dash.keyboard }).catch(() => { });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  bot.action(/^toggle_token_currency:(.+)$/, async (ctx) => {
    try {
      const rawTokenParam = ctx.match![1];
      const tokenAddress = resolveTokenAddressFromKey(rawTokenParam);
      const telegramId = ctx.from!.id;
      const user = await getUserByTelegramId(telegramId);
      if (!user) return;
      const nextMode = user.near_trade_currency === 'usdc' ? 'near' : 'usdc';
      await updateUserSettings(user.id, { near_trade_currency: nextMode });
      invalidateBalanceCache(telegramId);
      await ctx.answerCbQuery(nextMode === 'usdc' ? '💵 Switched to USDC-Only Mode (Buy & Sell in USDC)' : '⬛ Switched to NEAR + USDC Mode').catch(() => {});
      const card = await buildTokenCard(tokenAddress, telegramId);
      const cbMsg = (ctx as any).callbackQuery?.message;
      const isPhoto = !!cbMsg?.photo;
      if (isPhoto && typeof (ctx as any).editMessageCaption === 'function') {
        await (ctx as any).editMessageCaption(card.text, {
          parse_mode: 'Markdown',
          reply_markup: card.keyboard?.reply_markup,
        }).catch(async () => {
          await ctx.editMessageReplyMarkup(card.keyboard?.reply_markup).catch(() => {});
        });
      } else {
        await ctx.editMessageText(card.text, {
          parse_mode: 'Markdown',
          link_preview_options: { is_disabled: true },
          ...card.keyboard,
        }).catch(async () => {
          await ctx.editMessageReplyMarkup(card.keyboard?.reply_markup).catch(() => {});
        });
      }
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => {});
    }
  });

  bot.action('set:toggle_show_net_worth', async (ctx) => {
    try {
      const telegramId = ctx.from!.id;
      const user = await getUserByTelegramId(telegramId);
      if (!user) return;
      const current = Boolean(user.show_net_worth_on_card);
      const updated = await updateUserSettings(user.id, { show_net_worth_on_card: !current });
      await ctx.answerCbQuery(`Net worth on cards ${!current ? 'shown' : 'hidden'}`).catch(() => { });
      const dash = buildSettingsDashboard(updated);
      await ctx.editMessageText(dash.text, { parse_mode: 'Markdown', ...dash.keyboard }).catch(() => { });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  bot.action(/^toggle_pnl_nw:([^:]+):([01])$/, async (ctx) => {
    try {
      const positionId = ctx.match![1];
      const showNw = ctx.match![2] === '1';
      await ctx.answerCbQuery(showNw ? 'Showing net worth...' : 'Hiding net worth...').catch(() => { });
      await ctx.deleteMessage().catch(() => { });
      await sendPnlCardMessage(ctx, positionId, undefined, showNw);
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  bot.action(/^set:slippage:([0-9.]+)$/, async (ctx) => {
    try {
      const telegramId = ctx.from!.id;
      const slip = parseFloat(ctx.match![1]);
      const user = await getUserByTelegramId(telegramId);
      if (!user) return;
      const updated = await updateUserSettings(user.id, { slippage_pct: slip });
      await ctx.answerCbQuery(`Slippage set to ${slip}%`).catch(() => { });
      const dash = buildSettingsDashboard(updated);
      await ctx.editMessageText(dash.text, { parse_mode: 'Markdown', ...dash.keyboard }).catch(() => { });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  bot.action(/^set:auto_amt:([0-9.]+)$/, async (ctx) => {
    try {
      const telegramId = ctx.from!.id;
      const amt = parseFloat(ctx.match![1]);
      const user = await getUserByTelegramId(telegramId);
      if (!user) return;
      const updated = await updateUserSettings(user.id, { auto_buy_amount_near: amt });
      const unit = user.near_trade_currency === 'usdc' ? 'USDC' : 'NEAR';
      await ctx.answerCbQuery(`Auto-buy amount set to ${amt} ${unit}`).catch(() => { });
      const dash = await buildSnipeDashboard(updated);
      await ctx.editMessageText(dash.text, { parse_mode: 'Markdown', ...dash.keyboard }).catch(() => { });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  bot.action(/^set:min_liq:([0-9.]+)$/, async (ctx) => {
    try {
      const telegramId = ctx.from!.id;
      const liq = parseFloat(ctx.match![1]);
      const user = await getUserByTelegramId(telegramId);
      if (!user) return;
      const updated = await updateUserSettings(user.id, { auto_buy_min_liquidity_near: liq });
      await ctx.answerCbQuery(`Min liquidity set to ${liq} NEAR`).catch(() => { });
      const dash = await buildSnipeDashboard(updated);
      await ctx.editMessageText(dash.text, { parse_mode: 'Markdown', ...dash.keyboard }).catch(() => { });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  bot.action(/^set:buy_pct:(\d+)$/, async (ctx) => {
    try {
      const telegramId = ctx.from!.id;
      const pct = parseInt(ctx.match![1]);
      const user = await getUserByTelegramId(telegramId);
      if (!user) return;
      const updated = await updateUserSettings(user.id, { default_buy_pct: pct });
      await ctx.answerCbQuery(`Default buy set to ${pct}%`).catch(() => { });
      const dash = buildSettingsDashboard(updated);
      await ctx.editMessageText(dash.text, { parse_mode: 'Markdown', ...dash.keyboard }).catch(() => { });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  bot.action(/^set:sell_pct:(\d+)$/, async (ctx) => {
    try {
      const telegramId = ctx.from!.id;
      const pct = parseInt(ctx.match![1]);
      const user = await getUserByTelegramId(telegramId);
      if (!user) return;
      const updated = await updateUserSettings(user.id, { default_sell_pct: pct });
      await ctx.answerCbQuery(`Default sell set to ${pct}%`).catch(() => { });
      const dash = buildSettingsDashboard(updated);
      await ctx.editMessageText(dash.text, { parse_mode: 'Markdown', ...dash.keyboard }).catch(() => { });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  bot.action(/^set:buy_amounts:(.+)$/, async (ctx) => {
    try {
      const telegramId = ctx.from!.id;
      const rawAmounts = ctx.match![1];
      const user = await getUserByTelegramId(telegramId);
      if (!user) return;
      const cleanAmounts = parseBuyAmounts(rawAmounts).join(', ');
      const updated = await updateUserSettings(user.id, { custom_buy_amounts: cleanAmounts });
      await ctx.answerCbQuery(`Buy buttons set to ${cleanAmounts}`).catch(() => { });
      const dash = buildSettingsDashboard(updated);
      await ctx.editMessageText(dash.text, { parse_mode: 'Markdown', ...dash.keyboard }).catch(() => { });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  bot.action('prompt:custom_buy_amounts', async (ctx) => {
    try {
      const telegramId = ctx.from!.id;
      userPendingActions.set(telegramId, {
        action: 'custom_buy_amounts',
        expiresAt: Date.now() + 120000,
      });
      await ctx.answerCbQuery().catch(() => { });
      await ctx.reply(
        '💰 *Customize Quick Buy Buttons*\n\n' +
        'Reply with your preferred buy amounts separated by commas or spaces.\n\n' +
        '*Presets & Examples*:\n' +
        '• Micro: `0.2, 0.5, 1`\n' +
        '• Standard: `1, 5, 10`\n' +
        '• Pro: `10, 25, 50`\n' +
        '• Whale: `100, 250, 500`\n\n' +
        '_These amounts will immediately appear as your 1-tap buy buttons on all token trade cards._',
        { parse_mode: 'Markdown' }
      ).catch(() => { });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  bot.action('prompt:custom_slippage', async (ctx) => {
    try {
      const telegramId = ctx.from!.id;
      userPendingActions.set(telegramId, {
        action: 'custom_slippage',
        expiresAt: Date.now() + 120000,
      });
      await ctx.answerCbQuery().catch(() => { });
      await ctx.reply('✏️ *Enter Slippage Tolerance*\n\nReply with your desired slippage percentage (e.g. `2.5` or up to `100`):', { parse_mode: 'Markdown' }).catch(() => { });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  bot.action('prompt:custom_auto_buy', async (ctx) => {
    try {
      const telegramId = ctx.from!.id;
      const user = await getUserByTelegramId(telegramId).catch(() => null);
      const isUsdc = user?.near_trade_currency === 'usdc';
      const unit = isUsdc ? 'USDC' : 'NEAR';
      const exampleAmt = isUsdc ? '10' : '0.25';
      userPendingActions.set(telegramId, {
        action: 'custom_auto_buy',
        expiresAt: Date.now() + 120000,
      });
      await ctx.answerCbQuery().catch(() => { });
      await ctx.reply(`✏️ *Enter Auto-Buy Amount*\n\nReply with the ${unit} amount per auto-buy (e.g. \`${exampleAmt}\`):`, { parse_mode: 'Markdown' }).catch(() => { });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  bot.action('prompt:custom_min_liq', async (ctx) => {
    try {
      const telegramId = ctx.from!.id;
      userPendingActions.set(telegramId, {
        action: 'custom_min_liq',
        expiresAt: Date.now() + 120000,
      });
      await ctx.answerCbQuery().catch(() => { });
      await ctx.reply('✏️ *Enter Min Pool Liquidity*\n\nReply with the minimum pool liquidity in NEAR (e.g. `200` or `500`):', { parse_mode: 'Markdown' }).catch(() => { });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  bot.action(/^set:max_mcap:(\d+)$/, async (ctx) => {
    try {
      const telegramId = ctx.from!.id;
      const mcap = parseFloat(ctx.match![1]);
      const user = await getUserByTelegramId(telegramId);
      if (!user) return;
      const updated = await updateUserSettings(user.id, { auto_buy_max_market_cap_usd: mcap });
      await ctx.answerCbQuery(`Max market cap set to ${mcap > 0 ? '$' + mcap.toLocaleString() : 'No Limit'}`).catch(() => { });
      const dash = await buildSnipeDashboard(updated);
      await ctx.editMessageText(dash.text, { parse_mode: 'Markdown', ...dash.keyboard }).catch(() => { });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  bot.action('prompt:custom_max_mcap', async (ctx) => {
    try {
      const telegramId = ctx.from!.id;
      userPendingActions.set(telegramId, {
        action: 'custom_max_mcap',
        expiresAt: Date.now() + 120000,
      });
      await ctx.answerCbQuery().catch(() => { });
      await ctx.reply('✏️ *Enter Max Market Cap ($ USD)*\n\nReply with your maximum token market cap in USD (e.g. `50000` for $50k, or `0` for no limit):', { parse_mode: 'Markdown' }).catch(() => { });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  // ── /info <token_ca> — Token Details Card with in-chat buy buttons ─────────
  bot.command('info', async (ctx) => {
    const args = ctx.message!.text!.split(' ').slice(1);
    if (!args[0]) {
      await ctx.reply('Usage: /info <token_contract_address>\nExample: /info wrap.near');
      return;
    }

    const tokenAddress = args[0].trim();
    await ctx.reply('🔍 Fetching token info...');

    try {
      const card = await buildTokenCard(tokenAddress, ctx.from!.id);
      await sendTokenCard(ctx, card);
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
    }
  });

  // Refresh token card — edits message in-place for real-time updates
  bot.action(/^token_refresh:(.+)$/, async (ctx) => {
    const rawTokenParam = ctx.match![1];
    const tokenAddress = resolveTokenAddressFromKey(rawTokenParam);
    const telegramId = ctx.from!.id;
    try {
      await ctx.answerCbQuery('🔄 Refreshing token...').catch(() => { });
      const card = await buildTokenCard(tokenAddress, telegramId, true);

      const cbMsg = (ctx as any).callbackQuery?.message;
      const isPhoto = !!cbMsg?.photo;

      if (isPhoto && typeof (ctx as any).editMessageCaption === 'function' && !card.pnlCardImage) {
        await (ctx as any).editMessageCaption(card.text, {
          parse_mode: 'Markdown',
          reply_markup: card.keyboard?.reply_markup,
        }).catch(async (err: any) => {
          if (err?.message?.includes('message is not modified')) return;
          await sendTokenCard(ctx, card);
        });
      } else if (!isPhoto && typeof (ctx as any).editMessageText === 'function' && !card.pnlCardImage) {
        await (ctx as any).editMessageText(card.text, {
          parse_mode: 'Markdown',
          ...card.keyboard,
        }).catch(async (err: any) => {
          if (err?.message?.includes('message is not modified')) return;
          await sendTokenCard(ctx, card);
        });
      } else {
        await sendTokenCard(ctx, card);
      }
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => { });
    }
  });

  // Honeypot blocked button tap handler: show alert popup
  bot.action('noop_honeypot', async (ctx) => {
    await ctx.answerCbQuery(
      '🚨 BUY BLOCKED: This token contract contains a malicious backdoor function that allows unauthorized balance draining / confiscation. RacerBot has blocked trading to protect your funds.',
      { show_alert: true }
    );
  });

  // ── Deep Contract / Honeypot Audit Action ─────────────────────────────────
  bot.action(/^audit:(.+)$/, async (ctx) => {
    const rawParam = ctx.match![1];
    const tokenAddress = resolveTokenAddressFromKey(rawParam);
    await ctx.answerCbQuery('🔍 Running deep security audit...').catch(() => { });
    try {
      const card = await buildDeepAuditCard(tokenAddress);
      if (typeof (ctx as any).editMessageText === 'function') {
        await (ctx as any).editMessageText(card.text, { parse_mode: 'Markdown', ...card.keyboard }).catch(async () => {
          await ctx.reply(card.text, { parse_mode: 'Markdown', ...card.keyboard });
        });
      } else {
        await ctx.reply(card.text, { parse_mode: 'Markdown', ...card.keyboard });
      }
    } catch (err: any) {
      await ctx.reply(`❌ Security audit failed: ${getUserFriendlyError(err)}`).catch(() => { });
    }
  });

  // ── 1-Click Buy Inline Handlers ───────────────────────────────────────────
  // Fixed NEAR amount buy: buy_fixed:<token>:<amount>
  //
  // FIX 4: the handler answers the callback + posts "Processing", then runs
  // the trade DETACHED. It never awaits the trade, so the webhook response is
  // released immediately (Telegram cannot time out and resend the update) and
  // the detached body always sends a final success or error message.
  bot.action(/^buy_fixed:(.+):([0-9.]+)$/, async (ctx) => {
    try {
      const rawTokenParam = ctx.match![1];
      const tokenAddress = resolveTokenAddressFromKey(rawTokenParam);
      const rawClickedAmt = parseFloat(ctx.match![2]);
      let amountVal = rawClickedAmt;
      const telegramId = ctx.from!.id;
      const isStk = isStarknetToken(tokenAddress);
      const isSui = !isStk && isSuiToken(tokenAddress);
      const isEvmToken = !isStk && !isSui && (isValidEvmAddress(tokenAddress) && !tokenAddress.endsWith('.near'));
      const unit = isSolanaToken(tokenAddress) ? 'SOL' : isStk ? 'STRK' : (isSui ? 'SUI' : (isEvmToken ? 'HYPE' : 'NEAR'));
      let displayAmt = rawClickedAmt;
      let displayUnit = unit;
      if (unit === 'NEAR') {
        const buyUser = await getUserByTelegramId(telegramId).catch(() => null);
        if (buyUser?.near_trade_currency === 'usdc') {
          const nearUsdForFixed = (await getNearUsdPrice().catch(() => 0)) || 5.0;
          amountVal = Math.floor((rawClickedAmt / nearUsdForFixed) * 1e6) / 1e6;
          displayUnit = 'USDC';
        }
      }
      console.log(`[BUY_FIXED] Click: user=${telegramId}, token=${tokenAddress}, amount=${displayAmt} ${displayUnit} (${amountVal} ${unit})`);

      // In-flight guard: reject a duplicate tap while a trade for this token is running.
      const guardKey = inFlightKey(telegramId, tokenAddress, 'buy');
      if (!(await tryAcquireInFlight(guardKey))) {
        console.warn(`[BUY_FIXED] Duplicate tap rejected: guardKey=${guardKey}`);
        await ctx.answerCbQuery('A trade for this token is already in progress.').catch(() => {});
        return;
      }
      await ctx.answerCbQuery(`⚡ Processing buy order for ${displayAmt} ${displayUnit}...`).catch(() => {});

      (async () => {
        const procMsg = await ctx.reply(`⏳ *Processing Buy Order...*\n\nExchanging \`${displayAmt} ${displayUnit}\` for \`${tokenAddress}\`...\n_Executing swap on DEX..._`, { parse_mode: 'Markdown' }).catch(() => null);
        const onStage = makeStageEditor(ctx, procMsg, 'Processing Buy Order');
        try {
          console.log(`[BUY_FIXED] Starting executeBuyHelper: user=${telegramId}, token=${tokenAddress}, amount=${amountVal} ${unit}`);
          const res = await executeBuyHelper(telegramId, tokenAddress, amountVal, onStage);
          console.log(`[BUY_FIXED] Success: user=${telegramId}, token=${tokenAddress}, pos=${res.positionId}`);
          if (procMsg) await ctx.deleteMessage(procMsg.message_id).catch(() => { });

          await ctx.reply(res.message, {
            parse_mode: 'Markdown',
            reply_markup: await buildBuySuccessKeyboard(telegramId, tokenAddress, res.tokenSymbol, res.positionId),
          }).catch(async () => {
            await ctx.reply(res.message.replace(/[*_`]/g, ''), {
              reply_markup: await buildBuySuccessKeyboard(telegramId, tokenAddress, res.tokenSymbol, res.positionId),
            }).catch(() => { });
          });
          if (res.positionId) {
            await sendPostBuySlTpPrompt(ctx, res.positionId, tokenAddress, res.tokenSymbol).catch(() => { });
          }
        } catch (err: any) {
          console.error(`[BUY_FIXED] Failed: user=${telegramId}, token=${tokenAddress}, error=${err?.message}`, err);
          if (procMsg) await ctx.deleteMessage(procMsg.message_id).catch(() => { });
          await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => { });
        } finally {
          await releaseInFlight(guardKey);
        }
      })().catch(async (err: any) => {
        // Last-resort net: the body above always sends a final message; if it
        // itself crashed (e.g. Telegram API down), still release the guard.
        await releaseInFlight(guardKey);
        console.error('[BUY] Unhandled detached buy error:', err?.message || err);
      });
    } catch (outerErr: any) {
      console.error('[BUY_FIXED] Outer handler error:', outerErr);
      await ctx.answerCbQuery(getUserFriendlyError(outerErr)).catch(() => { });
    }
  });

  // Percentage buy: buy_pct:<token>:<pct> or legacy buy:<token>:<pct>
  // Same detached + in-flight-guard structure as buy_fixed.
  bot.action(/^(?:buy_pct|buy):(.+):(\d+)$/, async (ctx) => {
    try {
      const rawTokenParam = ctx.match![1];
      const tokenAddress = resolveTokenAddressFromKey(rawTokenParam);
      const pct = parseInt(ctx.match![2]);
      const telegramId = ctx.from!.id;
      const isStk = isStarknetToken(tokenAddress);
      const isSui = !isStk && isSuiToken(tokenAddress);
      const isEvmToken = !isStk && !isSui && (isValidEvmAddress(tokenAddress) && !tokenAddress.endsWith('.near'));
      const unit = isSolanaToken(tokenAddress) ? 'SOL' : isStk ? 'STRK' : (isSui ? 'SUI' : (isEvmToken ? 'HYPE' : 'NEAR'));
      console.log(`[BUY_PCT] Click: user=${telegramId}, token=${tokenAddress}, pct=${pct}%`);

      const guardKey = inFlightKey(telegramId, tokenAddress, 'buy');
      if (!(await tryAcquireInFlight(guardKey))) {
        console.warn(`[BUY_PCT] Duplicate tap rejected: guardKey=${guardKey}`);
        await ctx.answerCbQuery('A trade for this token is already in progress.').catch(() => { });
        return;
      }
      await ctx.answerCbQuery(`⚡ Processing buy order for ${pct}% of balance...`).catch(() => { });

      (async () => {
        const procMsg = await ctx.reply(`⏳ *Processing Buy Order (${pct}%)...*\n\nExchanging ${unit} for \`${tokenAddress}\`...\n_Executing swap on DEX..._`, { parse_mode: 'Markdown' }).catch(() => null);
        const onStage = makeStageEditor(ctx, procMsg, `Processing Buy Order (${pct}%)`);
        try {
          console.log(`[BUY_PCT] Starting executeBuyPctHelper: user=${telegramId}, token=${tokenAddress}, pct=${pct}%`);
          const res = await executeBuyPctHelper(telegramId, tokenAddress, pct, onStage);
          console.log(`[BUY_PCT] Success: user=${telegramId}, token=${tokenAddress}, pos=${res.positionId}`);
          if (procMsg) await ctx.deleteMessage(procMsg.message_id).catch(() => { });

          await ctx.reply(res.message, {
            parse_mode: 'Markdown',
            reply_markup: await buildBuySuccessKeyboard(telegramId, tokenAddress, res.tokenSymbol, res.positionId),
          }).catch(async () => {
            await ctx.reply(res.message.replace(/[*_`]/g, ''), {
              reply_markup: await buildBuySuccessKeyboard(telegramId, tokenAddress, res.tokenSymbol, res.positionId),
            }).catch(() => { });
          });
          if (res.positionId) {
            await sendPostBuySlTpPrompt(ctx, res.positionId, tokenAddress, res.tokenSymbol).catch(() => { });
          }
        } catch (err: any) {
          console.error(`[BUY_PCT] Failed: user=${telegramId}, token=${tokenAddress}, error=${err?.message}`, err);
          if (procMsg) await ctx.deleteMessage(procMsg.message_id).catch(() => { });
          await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => { });
        } finally {
          await releaseInFlight(guardKey);
        }
      })().catch(async (err: any) => {
        await releaseInFlight(guardKey);
        console.error('[BUY] Unhandled detached pct-buy error:', err?.message || err);
      });
    } catch (outerErr: any) {
      console.error('[BUY_PCT] Outer handler error:', outerErr);
      await ctx.answerCbQuery(getUserFriendlyError(outerErr)).catch(() => { });
    }
  });

  // Custom buy prompt button
  bot.action(/^buy_custom_prompt:(.+)$/, async (ctx) => {
    try {
      const rawTokenParam = ctx.match![1];
      const tokenAddress = resolveTokenAddressFromKey(rawTokenParam);
      const telegramId = ctx.from!.id;
      const user = await getUserByTelegramId(telegramId).catch(() => null);
      const unit = getChainNativeUnit(tokenAddress, user);
      userPendingActions.set(telegramId, {
        action: 'buy_custom_near',
        tokenAddress,
        expiresAt: Date.now() + 180000,
      });
      await ctx.answerCbQuery().catch(() => { });
      await ctx.reply(
        `✏️ *Custom Buy Amount*\n\n` +
        `Token: \`${tokenAddress}\`\n\n` +
        `Reply with the amount in ${unit === 'NEAR' ? 'NEAR or USDC (e.g. `2.5` or `10 USDC` or `$10`)' : `${unit} you want to buy (e.g. \`2.5\`)`}:\n` +
        `_Type /cancel to abort._`,
        { parse_mode: 'Markdown' }
      ).catch(async () => {
        await ctx.reply(
          `Custom Buy Amount\n\nToken: ${tokenAddress}\n\nReply with the amount in ${unit} you want to buy (e.g. 2.5):\nType /cancel to abort.`
        ).catch(() => { });
      });
    } catch (outerErr: any) {
      console.error('[BUY_CUSTOM_PROMPT] Outer handler error:', outerErr);
      await ctx.answerCbQuery(getUserFriendlyError(outerErr)).catch(() => { });
    }
  });

  // ── /buy <token_ca> [amount] ─────────────────────────────────────────────
  bot.command('buy', async (ctx) => {
    const telegramId = ctx.from!.id;
    const args = ctx.message!.text!.split(' ').slice(1);
    if (!args[0]) {
      await ctx.reply('Usage: /buy <token_ca> [amount]\nExample: /buy token.near 5\n\nOr paste the token address directly for 1-click buy buttons.');
      return;
    }

    const tokenAddress = args[0].trim();
    const isEvm = isValidEvmAddress(tokenAddress);
    const isStk = !isEvm && isStarknetToken(tokenAddress);
    const isSui = !isEvm && !isStk && isSuiToken(tokenAddress);
    const unit = isSolanaToken(tokenAddress) ? 'SOL' : isEvm ? 'HYPE' : isStk ? 'STRK' : (isSui ? 'SUI' : 'NEAR');
    const rawAmtStr = args.slice(1).join(' ').trim();
    const isUsdcArg = unit === 'NEAR' && (/^\$/.test(rawAmtStr) || /usdc|usd/i.test(rawAmtStr));
    const parsedNum = parseFloat(rawAmtStr.replace(/[^0-9.]/g, '') || '0');
    const nearUsdForCmd = isUsdcArg && parsedNum > 0 ? await getNearUsdPrice().catch(() => 0) : 0;
    const amountVal = isUsdcArg && nearUsdForCmd > 0 ? Number((parsedNum / nearUsdForCmd).toFixed(6)) : parsedNum;

    if (amountVal <= 0) {
      try {
        const card = await buildTokenCard(tokenAddress, telegramId);
        prewarmTradePath(telegramId, tokenAddress).catch(() => { });
        await sendTokenCard(ctx, card);
      } catch {
        await ctx.reply(`Specify amount in ${unit}: /buy <token_ca> <amount>`);
      }
      return;
    }

    const guardKey = inFlightKey(telegramId, tokenAddress, 'buy');
    if (!(await tryAcquireInFlight(guardKey))) {
      await ctx.answerCbQuery('A trade for this token is already in progress.').catch(() => { });
      return;
    }

    (async () => {
      const procMsg = await ctx.reply(`⏳ *Processing Buy Order...*\n\nExchanging \`${amountVal} ${unit}\` for \`${tokenAddress}\`...\n_Executing swap on DEX..._`, { parse_mode: 'Markdown' }).catch(() => null);
      const onStage = makeStageEditor(ctx, procMsg, 'Processing Buy Order');
      try {
        const res = await executeBuyHelper(telegramId, tokenAddress, amountVal, onStage);
        if (procMsg) await ctx.deleteMessage(procMsg.message_id).catch(() => { });

        await ctx.reply(res.message, {
          parse_mode: 'Markdown',
          reply_markup: await buildBuySuccessKeyboard(telegramId, tokenAddress, res.tokenSymbol, res.positionId),
        });
        if (res.positionId) {
          await sendPostBuySlTpPrompt(ctx, res.positionId, tokenAddress, res.tokenSymbol);
        }
      } catch (err: any) {
        if (procMsg) await ctx.deleteMessage(procMsg.message_id).catch(() => { });
        await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => { });
      } finally {
        await releaseInFlight(guardKey);
      }
    })().catch(async (err: any) => {
      await releaseInFlight(guardKey);
      console.error('[BUY] Unhandled detached /buy error:', err?.message || err);
    });
  });

  // ── /sell — Quick-sell open positions ─────────────────────────────────────
  // FIX 1: Parallel token info fetch across all open positions.
  bot.command('sell', async (ctx) => {
    const telegramId = ctx.from!.id;
    try {
      const user = await getUserByTelegramId(telegramId).catch(() => null);
      if (!user) { await ctx.reply('Use /start first.'); return; }

      const positions = await getOpenPositions(user.id).catch(() => []);
      if (positions.length === 0) {
        await ctx.reply('📭 No open positions.');
        return;
      }

      // FIX 1: All token info in parallel, one round-trip for all positions.
      const infoResults = await Promise.allSettled(
        positions.map(pos => getTokenInfo(pos.token_address, false))
      );

      for (let i = 0; i < positions.length; i++) {
        const pos = positions[i];
        const infoResult = infoResults[i];
        const tokenInfo = infoResult.status === 'fulfilled' ? (infoResult as PromiseFulfilledResult<TokenInfoResult>).value : null;
        const tokenLabel = tokenInfo
          ? `${sanitizeMd(tokenInfo.symbol)} (${pos.token_address.slice(0, 12)}...)`
          : pos.token_address.slice(0, 20) + '...';
        const currentPrice = tokenInfo ? parseFloat(tokenInfo.price) : 0;
        const pnlPct = currentPrice > 0 && parseFloat(pos.avg_entry_price) > 0
          ? ((currentPrice - parseFloat(pos.avg_entry_price)) / parseFloat(pos.avg_entry_price) * 100).toFixed(1)
          : 'N/A';

        const keyboard = Markup.inlineKeyboard([
          [
            cb('25%', `sell:${pos.id}:25`, 'danger'),
            cb('50%', `sell:${pos.id}:50`, 'danger'),
            cb('100%', `sell:${pos.id}:100`, 'danger'),
          ],
          [cb('🟢 Buy More', `buy_custom_prompt:${pos.token_address}`, 'success')],
          [cb('🔄 Refresh', 'menu_positions', 'primary')],
        ]);

        const posUnit = getPositionNativeUnit(pos, user);
        await ctx.reply(
          `📊 *${tokenLabel}*\n` +
          `📦 Holding: \`${pos.quantity_held}\`\n` +
          `📥 Avg Entry: \`${parseFloat(pos.avg_entry_price).toFixed(6)} ${posUnit}\`\n` +
          `💰 Current: \`${currentPrice.toFixed(6)} ${posUnit}\`\n` +
          `📈 PNL: \`${pnlPct}%\`\n\nChoose sell amount:`,
          { parse_mode: 'Markdown', ...keyboard }
        );
      }
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
    }
  });

  // Sell inline button handler — detached + in-flight guard.
  // The guard key resolves the position's token address up front so the key
  // stays telegramId + tokenAddress + side as everywhere else.
  bot.action(/^sell:([^:]+):(\d+)$/, async (ctx) => {
    try {
      const positionId = ctx.match![1];
      const pct = parseInt(ctx.match![2]);
      const telegramId = ctx.from!.id;
      console.log(`[SELL] Click: user=${telegramId}, positionId=${positionId}, pct=${pct}%`);
      const user = await getUserByTelegramId(telegramId).catch(() => null);
      if (!user) { await ctx.answerCbQuery('Wallet not found.').catch(() => { }); return; }

      const position = await getPositionById(positionId).catch(() => null);
      if (!position || position.user_id !== user.id) {
        await ctx.answerCbQuery('Position not found.').catch(() => { });
        return;
      }
      const tokenAddress = position.token_address;

      const guardKey = inFlightKey(telegramId, tokenAddress, 'sell');
      if (!(await tryAcquireInFlight(guardKey))) {
        await ctx.answerCbQuery('A trade for this token is already in progress.').catch(() => { });
        return;
      }
      await ctx.answerCbQuery(`⚡ Processing sell order (${pct}%)...`).catch(() => { });

      (async () => {
        const procMsg = await ctx.reply(`⏳ *Processing Sell Order (${pct}%)...*\n\nSelling position on DEX...\n_Executing swap on DEX..._`, { parse_mode: 'Markdown' }).catch(() => null);
        const onStage = makeStageEditor(ctx, procMsg, `Processing Sell Order (${pct}%)`);

        let result: { success: boolean; reason?: string; usdcReceived?: number } = { success: false, reason: 'Unknown error' };
        try {
          console.log(`[SELL] Starting sellAtTarget: user=${user.id}, positionId=${positionId}, pct=${pct}%, token=${tokenAddress}`);
          result = await sellAtTarget(user.id, positionId, pct, onStage);
          console.log(`[SELL] sellAtTarget completed: user=${user.id}, success=${result.success}, reason=${result.reason || 'ok'}`);
        } catch (err: any) {
          console.error(`[SELL] sellAtTarget threw: user=${user.id}, error=${err?.message}`, err);
          result = { success: false, reason: err.message || 'Swap execution failed' };
        } finally {
          if (procMsg) await ctx.deleteMessage(procMsg.message_id).catch(() => { });
          await releaseInFlight(guardKey);
        }

        if (result.success) {
          if (pct >= 99) {
            await updatePosition({
              position_id: positionId,
              status: 'closed',
              closed_at: new Date(),
              quantity_held: '0',
            }).catch(() => { });
          }
          const sellPctHeader = result.usdcReceived && result.usdcReceived > 0
            ? `✅ *Sell Order Executed!* (${pct}%)\n💵 *Received*: \`+${result.usdcReceived.toFixed(2)} USDC\``
            : `✅ *Sell Order Executed!* (${pct}%)`;
          await sendPnlCardMessage(ctx, positionId, sellPctHeader).catch(() => { });
        } else {
          await ctx.reply(`❌ Sell failed: ${result.reason || 'Unknown error'}`).catch(() => { });
        }
      })().catch(async (err: any) => {
        await releaseInFlight(guardKey);
        console.error('[SELL] Unhandled detached sell error:', err?.message || err);
        ctx.reply('❌ Sell failed unexpectedly. Please check /positions and retry.').catch(() => { });
      });
    } catch (outerErr: any) {
      console.error('[SELL] Outer handler error:', outerErr);
      await ctx.answerCbQuery(getUserFriendlyError(outerErr)).catch(() => { });
    }
  });

  // ── /pnl handled via /holdings & /positions ─────────────────────────────



  // ── /snipe <token_ca|name> ────────────────────────────────────────────────
  bot.command('snipe', async (ctx) => {
    const telegramId = ctx.from!.id;
    try {
      const user = await getUserByTelegramId(telegramId).catch(() => null);
      if (!user) { await ctx.reply('Use /start first.'); return; }

      const args = ctx.message!.text!.split(' ').slice(1);
      if (!args[0]) {
        await ctx.reply('Usage: /snipe <token_ca_or_name> [amount_near]\nExample: /snipe MYTOKEN.near 2');
        return;
      }

      const query = args[0].trim();
      const querySol = isSolanaAddress(query);
      // Solana: never fall back to the NEAR auto-buy amount; the user must name the SOL size.
      if (querySol && !args[1]) {
        await ctx.reply('Usage for Solana: /snipe <mint> <amount_sol>\nExample: /snipe <mint> 0.25');
        return;
      }
      const isSol = querySol;
      const isUsdc = !isSol && user.near_trade_currency === 'usdc';
      const unit = isSol ? 'SOL' : (isUsdc ? 'USDC' : 'NEAR');
      const defaultAmt = isUsdc ? (user.auto_buy_amount_near ? user.auto_buy_amount_near.toString() : '10') : (user.auto_buy_amount_near?.toString() ?? '1');
      const amountNear = parseFloat(args[1] ?? defaultAmt);
      const tradeCurrency = isSol ? 'sol' : (isUsdc ? 'usdc' : 'near');

      if (amountNear <= 0) {
        await ctx.reply(`Specify amount: /snipe <token> <amount_${unit.toLowerCase()}>`);
        return;
      }

      const isCA = querySol || query.includes('.near') || query.length === 64;

      if (isCA) {
        const info = await getTokenInfo(query, false).catch(() => null);
        if (info?.tradeable) {
          await ctx.reply(`⚡ Sniping \`${query}\` with ${amountNear} ${unit}...`, { parse_mode: 'Markdown' });
          try {
            let buyAmt = amountNear;
            if (isUsdc) {
              const nearUsdVal = await getNearUsdPrice().catch(() => 0);
              const effUsd = nearUsdVal > 0 ? nearUsdVal : 5.0;
              buyAmt = amountNear / effUsd;
            }
            const res = await executeBuyHelper(telegramId, query, buyAmt);
            await ctx.reply(res.message, {
              parse_mode: 'Markdown',
              reply_markup: await buildBuySuccessKeyboard(telegramId, query, res.tokenSymbol, res.positionId),
            });
            if (res.positionId) {
              await sendPostBuySlTpPrompt(ctx, res.positionId, query, res.tokenSymbol);
            }
          } catch (err: any) {
            const msg = err?.message ?? '';
            const isAwaitingLiq = /no liquidity|not yet tradable|reserves.*positive|bonding phase/i.test(msg);
            if (isAwaitingLiq) {
              const order = await createSnipeOrder({
                user_id: user.id,
                snipe_type: 'token',
                token_address: query,
                amount_near: amountNear,
                trade_currency: tradeCurrency,
              }).catch(() => null);
              if (order) {
                if (!querySol) prewarmStorageDeposit(user, query).catch(() => { });
                await ctx.reply(
                  `🎯 *Snipe Armed!*\n\n` +
                  `🪙 Token: \`${query}\`\n` +
                  `💰 Amount: \`${amountNear} ${unit}\`\n\n` +
                  `Pool is registered but awaiting liquidity — your snipe order is armed and will fire automatically the instant liquidity appears!`,
                  { parse_mode: 'Markdown' }
                );
              } else {
                await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
              }
            } else {
              await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
            }
          }
        } else {
          const activeCount = await countActiveSnipeOrders(user.id).catch(() => 0);
          if (activeCount >= MAX_ACTIVE_SNIPE_ORDERS_PER_USER) {
            await ctx.reply(`❌ You already have ${MAX_ACTIVE_SNIPE_ORDERS_PER_USER} active snipe orders. Cancel one in 🎯 Snipe Rules → 📋 My Snipe Orders.`);
            return;
          }
          const order = await createSnipeOrder({
            user_id: user.id,
            snipe_type: 'token',
            token_address: query,
            amount_near: amountNear,
            trade_currency: tradeCurrency,
          });
          if (!querySol) prewarmStorageDeposit(user, query).catch(() => { });
          await ctx.reply(
            `🎯 *Snipe Armed!*\n\n` +
            `🪙 Token: \`${query}\`\n` +
            `💰 Amount: \`${amountNear} ${unit}\`\n\n` +
            `The token is not tradable yet — your snipe order is armed and will fire automatically the instant liquidity appears! No need to watch the chart.`,
            {
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [
                  [cb('❌ Cancel Snipe Order', `snipe_order_cancel:${order.id}`, 'danger')],
                  [cb('📋 My Snipe Orders', 'snipe_orders', 'primary'), cb('🎯 Snipe Rules', 'menu_snipe', 'primary')],
                ],
              },
            }
          );
        }
      } else {
        const names = Array.from(localTokenNames.keys());
        const { match, score } = fuzzyMatch(query, names);

        if (!match || score < 0.5) {
          await ctx.reply(`❌ No token found matching "${query}".\n\nTry pasting the full contract address (CA) for a direct snipe.`);
          return;
        }

        const tokenData = localTokenNames.get(match)!;
        const keyboard = Markup.inlineKeyboard([
          [
            Markup.button.callback(`✅ Yes, snipe ${match}`, `snipe_confirm:${tokenData.address}:${amountNear}`),
            Markup.button.callback('❌ Cancel', 'snipe_cancel'),
          ],
        ]);

        await ctx.reply(
          `Found: *${match}* (${sanitizeMd(tokenData.symbol)})\nCA: \`${tokenData.address}\`\n\nSnipe ${amountNear} ${unit}?`,
          { parse_mode: 'Markdown', ...keyboard }
        );
      }
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
    }
  });

  bot.action(/^snipe_confirm:([^:]+):(.+)$/, async (ctx) => {
    const tokenAddress = ctx.match![1];
    const amountNear = parseFloat(ctx.match![2]);
    const telegramId = ctx.from!.id;

    await ctx.answerCbQuery('Processing snipe order...').catch(() => { });
    const user = await getUserByTelegramId(telegramId).catch(() => null);
    const isSol = isSolanaAddress(tokenAddress);
    const isUsdc = !isSol && user?.near_trade_currency === 'usdc';
    const unit = isSol ? 'SOL' : (isUsdc ? 'USDC' : 'NEAR');
    const snipeMsgId = (ctx.callbackQuery as any)?.message?.message_id ?? null;
    await ctx.editMessageText(`⏳ *Processing Snipe Order...*\n\nExchanging \`${amountNear} ${unit}\` for \`${tokenAddress}\`...\n_Executing swap on DEX..._`, { parse_mode: 'Markdown' }).catch(() => { });
    const onStage = makeStageEditor(ctx, snipeMsgId ? { message_id: snipeMsgId } : null, 'Processing Snipe Order');
    try {
      let buyAmt = amountNear;
      if (isUsdc) {
        const nearUsdVal = await getNearUsdPrice().catch(() => 0);
        const effUsd = nearUsdVal > 0 ? nearUsdVal : 5.0;
        buyAmt = amountNear / effUsd;
      }
      const res = await executeBuyHelper(telegramId, tokenAddress, buyAmt, onStage);
      await ctx.deleteMessage().catch(() => { });

      await ctx.reply(res.message, {
        parse_mode: 'Markdown',
        reply_markup: await buildBuySuccessKeyboard(telegramId, tokenAddress, res.tokenSymbol, res.positionId),
      });
      if (res.positionId) {
        await sendPostBuySlTpPrompt(ctx, res.positionId, tokenAddress, res.tokenSymbol);
      }
    } catch (err: any) {
      await ctx.editMessageText(`❌ ${getUserFriendlyError(err)}`).catch(() => { });
    }
  });

  bot.action('snipe_cancel', async (ctx) => {
    await ctx.answerCbQuery('Cancelled.').catch(() => { });
    await ctx.editMessageText('Snipe cancelled.').catch(() => { });
  });

  // ── /export & /rotatekey ──────────────────────────────────────────────────
  const handleExportPrompt = async (ctx: Context) => {
    const telegramId = ctx.from!.id;
    try {
      let user = await getUserByTelegramId(telegramId).catch(() => null);
      if (!user) {
        await ctx.reply('Use /start to set up your wallet first.');
        return;
      }
      if (!user.starknet_address || !user.starknet_private_key_enc || !user.solana_address) {
        const upgraded = await ensureUserAllWallets(user).catch(() => null);
        if (upgraded) user = upgraded;
      }

      const last = lastExportTime.get(telegramId);
      if (last && Date.now() - last < EXPORT_COOLDOWN_MS) {
        const remainingSec = Math.ceil((EXPORT_COOLDOWN_MS - (Date.now() - last)) / 1000);
        await ctx.reply(`⏳ Export is on cooldown. Please wait ${remainingSec}s before requesting again.`);
        return;
      }

      await ctx.reply(
        `⚠️ *Export Private Keys*\n\n` +
        `This will reveal private keys for *NEAR* (\`${user.subaccount_id}\`)${user.sui_address ? ` and *SUI* (\`${user.sui_address}\`)` : ''}${user.starknet_address ? ` and *Starknet* (\`${user.starknet_address}\`)` : ''}${user.solana_address ? ` and *Solana* (\`${user.solana_address}\`)` : ''}.\n\n` +
        `Anyone with these keys will have full control over your funds.\n\n` +
        `Are you sure you want to display your private keys?`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('⚠️ Yes, show my keys', 'export_confirm'),
              Markup.button.callback('Cancel', 'export_cancel'),
            ],
          ]),
        }
      );
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
    }
  };

  bot.command('export', handleExportPrompt);
  bot.action('export_prompt', handleExportPrompt);

  bot.action('export_cancel', async (ctx) => {
    await ctx.answerCbQuery('Export cancelled.').catch(() => { });
    await ctx.editMessageText('Export cancelled.').catch(() => { });
  });

  bot.action('export_confirm', async (ctx) => {
    const telegramId = ctx.from!.id;
    let user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) {
      await ctx.answerCbQuery('Wallet not found.').catch(() => { });
      return;
    }
    if (!user.starknet_address || !user.starknet_private_key_enc || !user.solana_address) {
      const upgraded = await ensureUserAllWallets(user).catch(() => null);
      if (upgraded) user = upgraded;
    }

    const last = lastExportTime.get(telegramId);
    if (last && Date.now() - last < EXPORT_COOLDOWN_MS) {
      const remainingSec = Math.ceil((EXPORT_COOLDOWN_MS - (Date.now() - last)) / 1000);
      await ctx.answerCbQuery(`Cooldown active. Wait ${remainingSec}s.`).catch(() => { });
      await ctx.editMessageText(`⏳ Export is on cooldown. Please wait ${remainingSec}s before requesting again.`).catch(() => { });
      return;
    }

    lastExportTime.set(telegramId, Date.now());
    console.log(`[AUDIT] Private keys exported for user_id=${user.id}, telegram_id=${telegramId}`);

    try {
      const [nearWallets, suiWallets] = await Promise.all([
        getUserWallets(user.id, 'near').catch(() => []),
        getUserWallets(user.id, 'sui').catch(() => []),
      ]);
      const activeNear = nearWallets.find(w => w.is_active);
      const activeSui = suiWallets.find(w => w.is_active);
      const nearName = activeNear ? ` [${activeNear.name}]` : '';
      const suiName = activeSui ? ` [${activeSui.name}]` : '';

      const rawNearKey = decrypt(user.scoped_key_encrypted, MASTER_KEY);
      let rawSuiKey = '';
      if (user.sui_private_key_enc) {
        try {
          rawSuiKey = decrypt(user.sui_private_key_enc, MASTER_KEY);
        } catch { }
      }
      let rawStarknetKey = '';
      if (user.starknet_private_key_enc) {
        try {
          rawStarknetKey = decrypt(user.starknet_private_key_enc, MASTER_KEY);
        } catch { }
      }

      let rawSolanaKey = '';
      if (user.solana_private_key_enc) {
        try {
          rawSolanaKey = exportSolanaPrivateKey(user.solana_private_key_enc, MASTER_KEY);
        } catch { }
      }

      let rawEvmKey = '';
      if (user.evm_private_key_enc) {
        try {
          rawEvmKey = decrypt(user.evm_private_key_enc, MASTER_KEY);
        } catch { }
      }

      await ctx.answerCbQuery('Keys decrypted.').catch(() => { });

      let keyHtml =
        `🔑 <b>NEAR Private Key</b>${nearName} (<code>${user.subaccount_id}</code>):\n` +
        `<tg-spoiler><code>${rawNearKey}</code></tg-spoiler>\n\n`;

      if (user.sui_address && rawSuiKey) {
        keyHtml +=
          `🔷 <b>SUI Private Key</b>${suiName} (<code>${user.sui_address}</code>):\n` +
          `<tg-spoiler><code>${rawSuiKey}</code></tg-spoiler>\n\n`;
      }

      if (user.starknet_address && rawStarknetKey) {
        keyHtml +=
          `✨ <b>Starknet Private Key</b> (<code>${user.starknet_address}</code>):\n` +
          `<tg-spoiler><code>${rawStarknetKey}</code></tg-spoiler>\n\n`;
      }

      if (user.solana_address && rawSolanaKey) {
        keyHtml +=
          `◎ <b>Solana Private Key</b> (<code>${user.solana_address}</code>):\n` +
          `<tg-spoiler><code>${rawSolanaKey}</code></tg-spoiler>\n\n`;
      }

      keyHtml +=
        `👆 <i>Tap the covered boxes above to uncover and copy your keys.</i>\n\n` +
        `⚠️ <i>This message will automatically delete in 2 minutes for security.</i>`;

      const keyMessage = await ctx.reply(keyHtml, { parse_mode: 'HTML' });

      await ctx.reply(
        `🛡️ *Security Reminder*:\n` +
        `• Keep your private keys confidential.\n` +
        `• Import into MyNearWallet/Meteor (NEAR), Sui Wallet (SUI), Argent X / Braavos (Starknet), or Phantom / Solflare (Solana) to manage outside RacerBot.`,
        { parse_mode: 'Markdown' }
      );

      // Delete private key message after 2 minutes for security
      setTimeout(async () => {
        try {
          await ctx.deleteMessage(keyMessage.message_id);
        } catch {
          // Message may already be deleted by user
        }
      }, 120000); // 2 minutes
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
    }
  });

  const handleRotatePrompt = async (ctx: Context) => {
    await ctx.reply(
      `🔄 *Rotate Trading Key*\n\n` +
      `This will generate a brand new private key on-chain for your account and permanently revoke the old one.\n\n` +
      `Do you want to proceed with key rotation?`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('🔄 Confirm Rotate Key', 'rotate_confirm'),
            Markup.button.callback('Cancel', 'rotate_cancel'),
          ],
        ]),
      }
    );
  };

  bot.command('rotatekey', handleRotatePrompt);
  bot.action('rotate_prompt', handleRotatePrompt);

  bot.action('rotate_cancel', async (ctx) => {
    await ctx.answerCbQuery('Cancelled.').catch(() => { });
    await ctx.editMessageText('Key rotation cancelled.').catch(() => { });
  });

  bot.action('rotate_confirm', async (ctx) => {
    const telegramId = ctx.from!.id;
    await ctx.answerCbQuery('Rotating key on-chain...').catch(() => { });
    await ctx.reply('🔄 Rotating your trading key on-chain. Please wait...');
    try {
      const res = await rotateUserKey(telegramId);
      const keyMessage = await ctx.reply(
        `✅ <b>Trading Key Rotated Successfully!</b>\n\n` +
        `Account: <code>${res.subaccountId}</code>\n\n` +
        `⚠️ <b>NEW PRIVATE KEY</b>:\n` +
        `<tg-spoiler><code>${res.newPrivateKey}</code></tg-spoiler>\n\n` +
        `👆 <i>Tap the covered box above to uncover and copy your new private key.</i>\n\n` +
        `<b>Notice</b>:\n` +
        `• The old key has been removed from your account on-chain.\n` +
        `• Save this new key securely.\n\n` +
        `⚠️ <i>This message will automatically delete in 2 minutes for security.</i>`,
        { parse_mode: 'HTML' }
      );

      // Delete private key message after 2 minutes for security
      setTimeout(async () => {
        try {
          await ctx.deleteMessage(keyMessage.message_id);
        } catch {
          // Message may already be deleted by user
        }
      }, 120000); // 2 minutes

    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
    }
  });

  // ── /cancel — Cancel pending input prompt ─────────────────────────────────
  bot.command('cancel', async (ctx) => {
    const telegramId = ctx.from!.id;
    if (userPendingActions.has(telegramId)) {
      userPendingActions.delete(telegramId);
      await ctx.reply('✅ Action cancelled. Type /menu for options.');
    } else {
      await ctx.reply('No active action to cancel.');
    }
  });

  // ── /referral — Show referral link and stats ───────────────────────────────
  const REFERRAL_CLAIM_MIN_USD = 10;

  const buildReferralView = async (user: UserRecord) => {
    const referralLink = `https://t.me/racertradingbot?start=${user.referral_code}`;

    const db = await getDb();
    const referralsResult = await db.query(
      'SELECT * FROM referrals WHERE referrer_id = $1',
      [user.id]
    );
    const referrals = referralsResult.rows;

    // Token share earnings (from token_referrals table)
    const tokenShareResult = await db.query(
      'SELECT COALESCE(SUM(total_fees_earned), 0) as total, COUNT(*) as cnt FROM token_referrals WHERE referrer_id = $1',
      [user.id]
    );
    const tokenShareEarnings = parseFloat(tokenShareResult.rows[0]?.total || '0');
    const tokenShareCount = parseInt(tokenShareResult.rows[0]?.cnt || '0', 10);

    const activeReferrals = referrals.filter((r: any) => r.status === 'active' || r.status === 'completed').length;
    const globalEarnings = referrals.reduce((sum: number, r: any) => sum + parseFloat(r.total_fees_earned || 0), 0);
    const totalEarnings = globalEarnings + tokenShareEarnings;
    const totalClaimed = await getTotalReferralClaimed(user.id).catch(() => 0);
    const claimableNear = Math.max(0, totalEarnings - totalClaimed);
    const nearUsd = await getNearUsdPrice().catch(() => 0);
    const claimableUsd = claimableNear * nearUsd;
    const claimReady = claimableUsd >= REFERRAL_CLAIM_MIN_USD;

    const isAmbassador = Boolean((user as any).is_ambassador || user.fee_tier === 'ambassador');
    const referralPct = (user as any).referral_fee_pct != null
      ? parseFloat(String((user as any).referral_fee_pct))
      : (isAmbassador ? 45 : 30);
    const ambassadorBadge = isAmbassador
      ? `🎖 *Ambassador Status: Active* (${referralPct}% Referral Fee Share)\n\n`
      : '';

    const text =
      `🎁 *Referral Program*\n\n` +
      ambassadorBadge +
      `Your referral link:\n` +
      `\`${referralLink}\`\n\n` +
      `📊 *Global Referrals* (account sign-ups):\n` +
      `• Total referrals: ${referrals.length}\n` +
      `• Active referrals: ${activeReferrals}\n` +
      `• Earnings: \`${globalEarnings.toFixed(4)} NEAR\` (${referralPct}% fee share)\n\n` +
      `📤 *Token Share Links*:\n` +
      `• Traders via your links: ${tokenShareCount}\n` +
      `• Earnings: \`${tokenShareEarnings.toFixed(4)} NEAR\` (5% fee share)\n\n` +
      `💰 *Combined Totals*:\n` +
      `• Total earned: \`${totalEarnings.toFixed(4)} NEAR\`\n` +
      `• Already claimed: \`${totalClaimed.toFixed(4)} NEAR\`\n` +
      `• Claimable: \`${claimableNear.toFixed(4)} NEAR\` (~${claimableUsd.toFixed(2)})\n\n` +
      `💡 *How to earn more*:\n` +
      `• Earn *${referralPct}%* of fees from every user you refer with your referral link\n` +
      `• Earn *5%* of fees when someone trades via your *📤 Share Token* links\n` +
      `• Claim once your rewards reach ${REFERRAL_CLAIM_MIN_USD} — paid straight to your RacerBot wallet`;

    const buttons: any[] = [];
    if (claimableNear > 0) {
      buttons.push([
        cb(
          claimReady ? '💰 Claim Rewards' : `🔒 Claim unlocks at $${REFERRAL_CLAIM_MIN_USD}`,
          'referral_claim',
          claimReady ? 'success' : undefined
        ),
      ]);
    }
    buttons.push([cb('🏎️ Create a RaceDrop (Group Airdrop)', 'racedrop_start', 'primary')]);
    buttons.push([cb('🔄 Refresh', 'referral_refresh', 'primary')]);
    buttons.push([cb('🔙 Back', 'menu_home', 'primary')]);

    return { text, keyboard: Markup.inlineKeyboard(buttons) };
  };

  bot.command('referral', async (ctx) => {
    const telegramId = ctx.from!.id;
    try {
      const user = await getUserByTelegramId(telegramId).catch(() => null);
      if (!user) {
        await ctx.reply('Use /start first.');
        return;
      }

      if (!user.referral_code) {
        const username = ctx.from!.username || 'user';
        const code = await generateReferralCode(user.id, username);
        user.referral_code = code;
      }

      const view = await buildReferralView(user);
      await ctx.reply(view.text, { parse_mode: 'Markdown', ...view.keyboard });
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
    }
  });

  bot.action('referral_refresh', async (ctx) => {
    const telegramId = ctx.from!.id;
    try {
      const user = await getUserByTelegramId(telegramId).catch(() => null);
      if (!user) {
        await ctx.answerCbQuery('Please run /start first.').catch(() => { });
        return;
      }
      if (!user.referral_code) {
        const username = ctx.from!.username || 'user';
        const code = await generateReferralCode(user.id, username);
        user.referral_code = code;
      }
      const view = await buildReferralView(user);
      await ctx.answerCbQuery('🔄 Updated!').catch(() => { });
      await ctx.editMessageText(view.text, { parse_mode: 'Markdown', ...view.keyboard }).catch((err: any) => {
        if (!err?.message?.includes('message is not modified')) {
          ctx.reply(view.text, { parse_mode: 'Markdown', ...view.keyboard }).catch(() => { });
        }
      });
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => { });
    }
  });

  // ── referral_claim — Pay accrued rewards from treasury ($10 minimum) ───────
  bot.action('referral_claim', async (ctx) => {
    const telegramId = ctx.from!.id;
    const guardKey = `referral_claim:${telegramId}`;
    if (!(await tryAcquireInFlight(guardKey))) {
      await ctx.answerCbQuery('Claim already in progress — please wait.').catch(() => { });
      return;
    }
    try {
      const user = await getUserByTelegramId(telegramId).catch(() => null);
      if (!user) {
        await ctx.answerCbQuery('Please run /start first.').catch(() => { });
        return;
      }

      const db = await getDb();
      const referralsResult = await db.query(
        'SELECT COALESCE(SUM(total_fees_earned), 0) as total FROM referrals WHERE referrer_id = $1',
        [user.id]
      );
      const totalEarned = parseFloat(referralsResult.rows[0]?.total || '0');
      const totalClaimed = await getTotalReferralClaimed(user.id);
      const claimableNear = Math.max(0, totalEarned - totalClaimed);

      if (claimableNear <= 0) {
        await ctx.answerCbQuery('No rewards to claim yet — share your link to start earning!').catch(() => { });
        return;
      }

      const nearUsd = await getNearUsdPrice();
      const claimableUsd = claimableNear * nearUsd;
      if (claimableUsd < REFERRAL_CLAIM_MIN_USD) {
        await ctx.answerCbQuery(
          `Minimum claim is $${REFERRAL_CLAIM_MIN_USD} — you have $${claimableUsd.toFixed(2)} (${claimableNear.toFixed(4)} NEAR).`
        ).catch(() => { });
        return;
      }

      await ctx.answerCbQuery('💸 Processing your claim...').catch(() => { });

      // Pay first, then record — a failed payout must never mark rewards claimed
      const { txHash } = await payReferralReward(user.subaccount_id, claimableNear);
      await createReferralClaim(user.id, claimableNear, txHash);

      await ctx.reply(
        `✅ *Referral Rewards Claimed!*\n\n` +
        `💰 Amount: \`${claimableNear.toFixed(4)} NEAR\` (~$${claimableUsd.toFixed(2)})\n` +
        `🧾 TX: [View on NearBlocks](https://nearblocks.io/txns/${txHash})\n\n` +
        `The rewards have landed in your RacerBot wallet. Use /wallet to check.`,
        { parse_mode: 'Markdown' }
      );
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => { });
    } finally {
      await releaseInFlight(guardKey);
    }
  });

  // ── /audit & /scan & /honeypot: Deep Contract Safety & Honeypot Analysis ──
  bot.command(['audit', 'scan', 'honeypot'], async (ctx) => {
    let rawText = ctx.message.text.trim();
    const parts = rawText.split(/\s+/).slice(1);
    const token = parts[0]?.trim();
    if (!token) {
      await ctx.reply(
        `🛡️ <b>RacerBot Deep Contract & Honeypot Audit</b>\n\n` +
        `Usage: <code>/audit &lt;token_address&gt;</code>\n\n` +
        `Examples:\n` +
        `• <code>/audit nmario.nearmario.near</code>\n` +
        `• <code>/audit lili.nearlytrade.near</code>\n` +
        `• <code>/audit 0x2::sui::SUI</code>`,
        { parse_mode: 'HTML' }
      );
      return;
    }
    const tokenAddress = resolveTokenAddressFromKey(token);
    const loading = await ctx.reply(`🔍 <i>Inspecting contract bytecode for <code>${tokenAddress}</code>...</i>`, { parse_mode: 'HTML' }).catch(() => null);
    try {
      const card = await buildDeepAuditCard(tokenAddress);
      if (loading) await ctx.deleteMessage(loading.message_id).catch(() => { });
      await ctx.reply(card.text, { parse_mode: 'Markdown', ...card.keyboard });
    } catch (err: any) {
      if (loading) await ctx.deleteMessage(loading.message_id).catch(() => { });
      await ctx.reply(`❌ Security audit failed: ${getUserFriendlyError(err)}`).catch(() => { });
    }
  });

  // ── /stoploss & /takeprofit & SL/TP Interactive Actions ─────────────────
  bot.command('stoploss', async (ctx) => {
    const telegramId = ctx.from!.id;
    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) { await ctx.reply('Use /start first.'); return; }

    const args = ctx.message!.text!.split(' ').slice(1);
    const tokenCA = args[0];
    const pct = parseFloat(args[1] ?? '');

    if (!tokenCA || isNaN(pct) || pct <= 0 || pct >= 100) {
      await ctx.reply('Usage: /stoploss <token_ca> <percent>\nExample: /stoploss mytoken.near 20 (stops at -20%)');
      return;
    }

    const positions = await getOpenPositions(user.id).catch(() => []);
    const position = positions.find(p => p.token_address === tokenCA);

    if (!position) {
      await ctx.reply(`No open position found for \`${tokenCA}\``, { parse_mode: 'Markdown' });
      return;
    }

    await upsertTrigger({
      user_id: user.id,
      position_id: position.id,
      type: 'stop_loss',
      target_value: pct.toString(),
      chain: position.chain || 'near',
    });

    await ctx.reply(`✅ Stop loss set at -${pct}% for \`${tokenCA}\``, {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([
        [cb('📈 Set Take Profit', `tp_prompt:${position.id}`, 'success'), cb('📊 View Position', `token_detail:${position.id}`, 'primary')],
      ]).reply_markup,
    });
  });

  bot.command('takeprofit', async (ctx) => {
    const telegramId = ctx.from!.id;
    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) { await ctx.reply('Use /start first.'); return; }

    const args = ctx.message!.text!.split(' ').slice(1);
    const tokenCA = args[0];
    const pct = parseFloat(args[1] ?? '');

    if (!tokenCA || isNaN(pct) || pct <= 0) {
      await ctx.reply('Usage: /takeprofit <token_ca> <percent>\nExample: /takeprofit mytoken.near 50 (takes profit at +50%)');
      return;
    }

    const positions = await getOpenPositions(user.id).catch(() => []);
    const position = positions.find(p => p.token_address === tokenCA);

    if (!position) {
      await ctx.reply(`No open position found for \`${tokenCA}\``, { parse_mode: 'Markdown' });
      return;
    }

    await upsertTrigger({
      user_id: user.id,
      position_id: position.id,
      type: 'take_profit',
      target_value: pct.toString(),
      chain: position.chain || 'near',
    });

    await ctx.reply(`✅ Take profit set at +${pct}% for \`${tokenCA}\``, {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([
        [cb('📉 Set Stop Loss', `sl_prompt:${position.id}`, 'danger'), cb('📊 View Position', `token_detail:${position.id}`, 'primary')],
      ]).reply_markup,
    });
  });

  // SL/TP Dismiss / Skip
  bot.action('sl_tp_dismiss', async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => { });
      await ctx.deleteMessage().catch(async () => {
        await ctx.editMessageText('🛡️ _SL/TP setup skipped. You can always set them from /positions anytime._', { parse_mode: 'Markdown' }).catch(() => { });
      });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  // SL/TP Combined Hub Menu
  bot.action(/^sl_tp_menu:([^:]+)$/, async (ctx) => {
    try {
      const positionId = ctx.match![1];
      const telegramId = ctx.from!.id;
      await ctx.answerCbQuery().catch(() => { });

      const user = await getUserByTelegramId(telegramId).catch(() => null);
      if (!user) return;

      const position = await getPositionById(positionId).catch(() => null);
      if (!position || position.user_id !== user.id) return;

      const [info, triggers] = await Promise.all([
        getTokenInfo(position.token_address, false).catch(() => null),
        getTriggersByPosition(positionId).catch(() => []),
      ]);

      const symbol = info?.symbol ? sanitizeMd(info.symbol) : 'Token';
      const slTrigger = triggers.find(t => t.type === 'stop_loss');
      const tpTrigger = triggers.find(t => t.type === 'take_profit');

      const slStatus = slTrigger ? `-${slTrigger.target_value}%` : 'Not set';
      const tpStatus = tpTrigger ? `+${tpTrigger.target_value}%` : 'Not set';

      const msg =
        `🛡️ *Manage Protection for ${symbol}*\n\n` +
        `📉 *Stop Loss*: \`${slStatus}\`\n` +
        `📈 *Take Profit*: \`${tpStatus}\`\n\n` +
        `Set automatic trigger orders to protect your downside or lock in gains:`;

      const buttons = [
        [
          cb(slTrigger ? `📉 Edit SL (-${slTrigger.target_value}%)` : '📉 Set Stop Loss', `sl_prompt:${positionId}`, slTrigger ? 'danger' : undefined),
          cb(tpTrigger ? `📈 Edit TP (+${tpTrigger.target_value}%)` : '📈 Set Take Profit', `tp_prompt:${positionId}`, tpTrigger ? 'success' : undefined),
        ],
        [
          cb('📊 View Position', `token_detail:${positionId}`, 'primary'),
          cb('Close ✖️', 'sl_tp_dismiss'),
        ],
      ];

      await ctx.editMessageText(msg, {
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard(buttons).reply_markup,
      }).catch(async () => {
        await ctx.reply(msg, {
          parse_mode: 'Markdown',
          reply_markup: Markup.inlineKeyboard(buttons).reply_markup,
        }).catch(() => { });
      });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  // Stop Loss prompt with preset level buttons
  bot.action(/^sl_prompt:([^:]+)$/, async (ctx) => {
    try {
      const positionId = ctx.match![1];
      const telegramId = ctx.from!.id;
      await ctx.answerCbQuery().catch(() => { });

      const user = await getUserByTelegramId(telegramId).catch(() => null);
      if (!user) return;

      const position = await getPositionById(positionId).catch(() => null);
      if (!position || position.user_id !== user.id) {
        await ctx.reply('Position not found.').catch(() => { });
        return;
      }

      const [info, triggers] = await Promise.all([
        getTokenInfo(position.token_address, false).catch(() => null),
        getTriggersByPosition(positionId).catch(() => []),
      ]);

      const symbol = info?.symbol ? sanitizeMd(info.symbol) : 'Token';
      const nativeUnit = getPositionNativeUnit(position, user);
      const entryPrice = parseFloat(position.avg_entry_price || '0');

      const slTrigger = triggers.find(t => t.type === 'stop_loss');
      const currentSlStr = slTrigger ? `\n• Current Stop Loss: \`-${slTrigger.target_value}%\`` : '';

      const priceInfoStr = entryPrice > 0
        ? `\n💵 Entry: \`${entryPrice.toFixed(6)} ${nativeUnit}\``
        : '';

      const msg =
        `📉 *Stop Loss for ${symbol}*\n` +
        priceInfoStr +
        currentSlStr + `\n\n` +
        `*Step 1 — Drop level:*\n` +
        `Select how far the price must fall from entry to trigger a sell.\n\n` +
        `*Step 2 — Sell quantity:*\n` +
        `_After selecting a drop %, tap how much of your position to sell._`;

      const buttons: any[] = [
        [
          cb('-10%', `set_sl:${positionId}:10`, 'danger'),
          cb('-20%', `set_sl:${positionId}:20`, 'danger'),
          cb('-30%', `set_sl:${positionId}:30`, 'danger'),
        ],
        [
          cb('-50%', `set_sl:${positionId}:50`, 'danger'),
          cb('✏️ Custom %', `sl_custom_prompt:${positionId}`),
        ],
      ];

      const bottomRow: any[] = [];
      if (slTrigger) {
        bottomRow.push(cb('❌ Cancel SL', `cancel_sl:${positionId}`, 'danger'));
      }
      bottomRow.push(cb('🔙 Back', `sl_tp_menu:${positionId}`, 'primary'));
      buttons.push(bottomRow);

      await ctx.editMessageText(msg, {
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard(buttons).reply_markup,
      }).catch(async () => {
        await ctx.reply(msg, {
          parse_mode: 'Markdown',
          reply_markup: Markup.inlineKeyboard(buttons).reply_markup,
        }).catch(() => { });
      });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  // Take Profit prompt with preset target buttons
  bot.action(/^tp_prompt:([^:]+)$/, async (ctx) => {
    try {
      const positionId = ctx.match![1];
      const telegramId = ctx.from!.id;
      await ctx.answerCbQuery().catch(() => { });

      const user = await getUserByTelegramId(telegramId).catch(() => null);
      if (!user) return;

      const position = await getPositionById(positionId).catch(() => null);
      if (!position || position.user_id !== user.id) {
        await ctx.reply('Position not found.').catch(() => { });
        return;
      }

      const [info, triggers] = await Promise.all([
        getTokenInfo(position.token_address, false).catch(() => null),
        getTriggersByPosition(positionId).catch(() => []),
      ]);

      const symbol = info?.symbol ? sanitizeMd(info.symbol) : 'Token';
      const nativeUnit = getPositionNativeUnit(position, user);
      const entryPrice = parseFloat(position.avg_entry_price || '0');

      const tpTrigger = triggers.find(t => t.type === 'take_profit');
      const currentTpStr = tpTrigger ? `\n• Current Take Profit: \`+${tpTrigger.target_value}%\`` : '';

      const priceInfoStr = entryPrice > 0
        ? `\n💵 Entry: \`${entryPrice.toFixed(6)} ${nativeUnit}\``
        : '';

      const msg =
        `📈 *Take Profit for ${symbol}*\n` +
        priceInfoStr +
        currentTpStr + `\n\n` +
        `*Step 1 — Profit target:*\n` +
        `Select how much the price must rise from entry to trigger a sell.\n\n` +
        `*Step 2 — Sell quantity:*\n` +
        `_After selecting a target %, tap how much of your position to sell._`;

      const buttons: any[] = [
        [
          cb('+25%', `set_tp:${positionId}:25`, 'success'),
          cb('+50%', `set_tp:${positionId}:50`, 'success'),
          cb('+100%', `set_tp:${positionId}:100`, 'success'),
        ],
        [
          cb('+200%', `set_tp:${positionId}:200`, 'success'),
          cb('+500%', `set_tp:${positionId}:500`, 'success'),
          cb('✏️ Custom %', `tp_custom_prompt:${positionId}`),
        ],
      ];

      const bottomRow: any[] = [];
      if (tpTrigger) {
        bottomRow.push(cb('❌ Cancel TP', `cancel_tp:${positionId}`, 'danger'));
      }
      bottomRow.push(cb('🔙 Back', `sl_tp_menu:${positionId}`, 'primary'));
      buttons.push(bottomRow);

      await ctx.editMessageText(msg, {
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard(buttons).reply_markup,
      }).catch(async () => {
        await ctx.reply(msg, {
          parse_mode: 'Markdown',
          reply_markup: Markup.inlineKeyboard(buttons).reply_markup,
        }).catch(() => { });
      });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  // Action: Set Stop Loss percentage (+ optional sell quantity %)
  // Format: set_sl:<positionId>:<dropPct>:<sellPct>
  bot.action(/^set_sl:([^:]+):(\d+(?:\.\d+)?)(?::(\d+(?:\.\d+)?))?$/, async (ctx) => {
    try {
      const positionId = ctx.match![1];
      const pct = parseFloat(ctx.match![2]);
      const sellPct = ctx.match![3] ? parseFloat(ctx.match![3]) : 100;
      const telegramId = ctx.from!.id;
      await ctx.answerCbQuery().catch(() => { });

      const user = await getUserByTelegramId(telegramId).catch(() => null);
      if (!user) return;

      const position = await getPositionById(positionId).catch(() => null);
      if (!position || position.user_id !== user.id) {
        await ctx.reply('Position not found.').catch(() => { });
        return;
      }

      // If a full set_sl:pos:pct:100 was clicked, show the sell-quantity picker next
      // so the user can choose how much to sell. This two-step UX avoids long button rows.
      if (ctx.match![3] === undefined) {
        // Ask sell quantity before confirming
        const info = await getTokenInfo(position.token_address, false).catch(() => null);
        const symbol = info?.symbol ? sanitizeMd(info.symbol) : 'Token';
        const sellQtyMsg =
          `📉 *Stop Loss — Sell Quantity for ${symbol}*\n\n` +
          `Drop level: \`-${pct}%\` from entry\n\n` +
          `How much of your position should be sold when this triggers?`;
        const sellQtyButtons = [
          [
            cb('25% of position', `set_sl:${positionId}:${pct}:25`, 'danger'),
            cb('50% of position', `set_sl:${positionId}:${pct}:50`, 'danger'),
          ],
          [
            cb('75% of position', `set_sl:${positionId}:${pct}:75`, 'danger'),
            cb('100% (all)', `set_sl:${positionId}:${pct}:100`, 'danger'),
          ],
          [cb('🔙 Back', `sl_prompt:${positionId}`, 'primary')],
        ];
        await ctx.editMessageText(sellQtyMsg, {
          parse_mode: 'Markdown',
          reply_markup: Markup.inlineKeyboard(sellQtyButtons).reply_markup,
        }).catch(async () => {
          await ctx.reply(sellQtyMsg, {
            parse_mode: 'Markdown',
            reply_markup: Markup.inlineKeyboard(sellQtyButtons).reply_markup,
          }).catch(() => { });
        });
        return;
      }

      await upsertTrigger({
        user_id: user.id,
        position_id: positionId,
        type: 'stop_loss',
        target_value: pct.toString(),
        sell_pct: sellPct,
        chain: position.chain || 'near',
      });

      const info = await getTokenInfo(position.token_address, false).catch(() => null);
      const symbol = info?.symbol ? sanitizeMd(info.symbol) : 'Token';
      const nativeUnit = getPositionNativeUnit(position, user);
      const entryPrice = parseFloat(position.avg_entry_price || '0');
      const slPrice = entryPrice > 0 ? entryPrice * (1 - pct / 100) : 0;
      const slPriceStr = slPrice > 0 ? `\n🛑 Triggers at: \`${slPrice.toFixed(6)} ${nativeUnit}\`` : '';
      const sellQtyStr = sellPct < 100 ? ` (sells ${sellPct}% of position)` : '';

      const msg =
        `✅ *Stop Loss Activated!*\n\n` +
        `🪙 Token: *${symbol}*\n` +
        `📉 Level: \`-${pct}%\` from entry${sellQtyStr}` +
        slPriceStr + `\n\n` +
        `If the price drops to this target, an automated market sell will execute to protect your capital.`;

      const buttons = [
        [
          cb('📈 Set Take Profit', `tp_prompt:${positionId}`, 'success'),
          cb('📊 View Position', `token_detail:${positionId}`, 'primary'),
        ],
        [
          cb('❌ Remove SL', `cancel_sl:${positionId}`, 'danger'),
          cb('🔙 Menu', `sl_tp_menu:${positionId}`),
        ],
      ];

      await ctx.editMessageText(msg, {
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard(buttons).reply_markup,
      }).catch(async () => {
        await ctx.reply(msg, {
          parse_mode: 'Markdown',
          reply_markup: Markup.inlineKeyboard(buttons).reply_markup,
        }).catch(() => { });
      });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  // Action: Set Take Profit percentage (+ optional sell quantity %)
  // Format: set_tp:<positionId>:<targetPct>:<sellPct>
  bot.action(/^set_tp:([^:]+):(\d+(?:\.\d+)?)(?::(\d+(?:\.\d+)?))?$/, async (ctx) => {
    try {
      const positionId = ctx.match![1];
      const pct = parseFloat(ctx.match![2]);
      const sellPct = ctx.match![3] ? parseFloat(ctx.match![3]) : 100;
      const telegramId = ctx.from!.id;
      await ctx.answerCbQuery().catch(() => { });

      const user = await getUserByTelegramId(telegramId).catch(() => null);
      if (!user) return;

      const position = await getPositionById(positionId).catch(() => null);
      if (!position || position.user_id !== user.id) {
        await ctx.reply('Position not found.').catch(() => { });
        return;
      }

      // If no sell_pct captured yet, show the sell-quantity picker
      if (ctx.match![3] === undefined) {
        const info = await getTokenInfo(position.token_address, false).catch(() => null);
        const symbol = info?.symbol ? sanitizeMd(info.symbol) : 'Token';
        const sellQtyMsg =
          `📈 *Take Profit — Sell Quantity for ${symbol}*\n\n` +
          `Profit target: \`+${pct}%\` from entry\n\n` +
          `How much of your position should be sold when this triggers?`;
        const sellQtyButtons = [
          [
            cb('25% of position', `set_tp:${positionId}:${pct}:25`, 'success'),
            cb('50% of position', `set_tp:${positionId}:${pct}:50`, 'success'),
          ],
          [
            cb('75% of position', `set_tp:${positionId}:${pct}:75`, 'success'),
            cb('100% (all)', `set_tp:${positionId}:${pct}:100`, 'success'),
          ],
          [cb('🔙 Back', `tp_prompt:${positionId}`, 'primary')],
        ];
        await ctx.editMessageText(sellQtyMsg, {
          parse_mode: 'Markdown',
          reply_markup: Markup.inlineKeyboard(sellQtyButtons).reply_markup,
        }).catch(async () => {
          await ctx.reply(sellQtyMsg, {
            parse_mode: 'Markdown',
            reply_markup: Markup.inlineKeyboard(sellQtyButtons).reply_markup,
          }).catch(() => { });
        });
        return;
      }

      await upsertTrigger({
        user_id: user.id,
        position_id: positionId,
        type: 'take_profit',
        target_value: pct.toString(),
        sell_pct: sellPct,
        chain: position.chain || 'near',
      });

      const info = await getTokenInfo(position.token_address, false).catch(() => null);
      const symbol = info?.symbol ? sanitizeMd(info.symbol) : 'Token';
      const nativeUnit = getPositionNativeUnit(position, user);
      const entryPrice = parseFloat(position.avg_entry_price || '0');
      const tpPrice = entryPrice > 0 ? entryPrice * (1 + pct / 100) : 0;
      const tpPriceStr = tpPrice > 0 ? `\n🎯 Triggers at: \`${tpPrice.toFixed(6)} ${nativeUnit}\`` : '';
      const sellQtyStr = sellPct < 100 ? ` (sells ${sellPct}% of position)` : '';

      const msg =
        `✅ *Take Profit Activated!*\n\n` +
        `🪙 Token: *${symbol}*\n` +
        `📈 Level: \`+${pct}%\` from entry${sellQtyStr}` +
        tpPriceStr + `\n\n` +
        `When the price rises to this target, an automated market sell will execute to lock in your profit.`;

      const buttons = [
        [
          cb('📉 Set Stop Loss', `sl_prompt:${positionId}`, 'danger'),
          cb('📊 View Position', `token_detail:${positionId}`, 'primary'),
        ],
        [
          cb('❌ Remove TP', `cancel_tp:${positionId}`, 'danger'),
          cb('🔙 Menu', `sl_tp_menu:${positionId}`),
        ],
      ];

      await ctx.editMessageText(msg, {
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard(buttons).reply_markup,
      }).catch(async () => {
        await ctx.reply(msg, {
          parse_mode: 'Markdown',
          reply_markup: Markup.inlineKeyboard(buttons).reply_markup,
        }).catch(() => { });
      });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  // Action: Cancel Stop Loss
  bot.action(/^cancel_sl:([^:]+)$/, async (ctx) => {
    try {
      const positionId = ctx.match![1];
      const telegramId = ctx.from!.id;
      await ctx.answerCbQuery('Stop Loss cancelled.').catch(() => { });

      const user = await getUserByTelegramId(telegramId).catch(() => null);
      if (!user) return;

      await cancelTriggersByPosition(positionId, 'stop_loss');

      const buttons = [
        [
          cb('📉 Set Stop Loss', `sl_prompt:${positionId}`, 'danger'),
          cb('🔙 Back to Menu', `sl_tp_menu:${positionId}`, 'primary'),
        ],
      ];
      await ctx.editMessageText('❌ *Stop Loss removed for this position.*', {
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard(buttons).reply_markup,
      }).catch(async () => {
        await ctx.reply('❌ Stop Loss removed for this position.', {
          reply_markup: Markup.inlineKeyboard(buttons).reply_markup,
        }).catch(() => { });
      });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  // Action: Cancel Take Profit
  bot.action(/^cancel_tp:([^:]+)$/, async (ctx) => {
    try {
      const positionId = ctx.match![1];
      const telegramId = ctx.from!.id;
      await ctx.answerCbQuery('Take Profit cancelled.').catch(() => { });

      const user = await getUserByTelegramId(telegramId).catch(() => null);
      if (!user) return;

      await cancelTriggersByPosition(positionId, 'take_profit');

      const buttons = [
        [
          cb('📈 Set Take Profit', `tp_prompt:${positionId}`, 'success'),
          cb('🔙 Back to Menu', `sl_tp_menu:${positionId}`, 'primary'),
        ],
      ];
      await ctx.editMessageText('❌ *Take Profit removed for this position.*', {
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard(buttons).reply_markup,
      }).catch(async () => {
        await ctx.reply('❌ Take Profit removed for this position.', {
          reply_markup: Markup.inlineKeyboard(buttons).reply_markup,
        }).catch(() => { });
      });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  // Action: Prompt Custom Stop Loss
  bot.action(/^sl_custom_prompt:([^:]+)$/, async (ctx) => {
    try {
      const positionId = ctx.match![1];
      const telegramId = ctx.from!.id;
      await ctx.answerCbQuery().catch(() => { });

      userPendingActions.set(telegramId, {
        action: 'set_sl_custom',
        positionId,
        expiresAt: Date.now() + 5 * 60_000,
      });

      await ctx.reply(
        `✏️ *Set Custom Stop Loss %*\n\n` +
        `Enter the percentage drop from entry to trigger exit.\n` +
        `Example: Type \`15\` for -15%, or \`35\` for -35%.\n\n` +
        `_Reply with a number between 1 and 99:_`,
        {
          parse_mode: 'Markdown',
          reply_markup: Markup.inlineKeyboard([
            [cb('❌ Cancel', `sl_tp_menu:${positionId}`)],
          ]).reply_markup,
        }
      ).catch(async () => {
        await ctx.reply(
          `Set Custom Stop Loss %\nEnter the percentage drop from entry to trigger exit (between 1 and 99):`,
          {
            reply_markup: Markup.inlineKeyboard([
              [cb('❌ Cancel', `sl_tp_menu:${positionId}`)],
            ]).reply_markup,
          }
        ).catch(() => { });
      });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  // Action: Prompt Custom Take Profit
  bot.action(/^tp_custom_prompt:([^:]+)$/, async (ctx) => {
    try {
      const positionId = ctx.match![1];
      const telegramId = ctx.from!.id;
      await ctx.answerCbQuery().catch(() => { });

      userPendingActions.set(telegramId, {
        action: 'set_tp_custom',
        positionId,
        expiresAt: Date.now() + 5 * 60_000,
      });

      await ctx.reply(
        `✏️ *Set Custom Take Profit %*\n\n` +
        `Enter the percentage gain from entry to take profit.\n` +
        `Example: Type \`75\` for +75%, or \`250\` for +250%.\n\n` +
        `_Reply with a number (e.g. 75, 150, 300):_`,
        {
          parse_mode: 'Markdown',
          reply_markup: Markup.inlineKeyboard([
            [cb('❌ Cancel', `sl_tp_menu:${positionId}`)],
          ]).reply_markup,
        }
      ).catch(async () => {
        await ctx.reply(
          `Set Custom Take Profit %\nEnter the percentage gain from entry to take profit (e.g. 75, 150, 300):`,
          {
            reply_markup: Markup.inlineKeyboard([
              [cb('❌ Cancel', `sl_tp_menu:${positionId}`)],
            ]).reply_markup,
          }
        ).catch(() => { });
      });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => { });
    }
  });

  // ── Telegram Group Buy Alerts (/track, /buybot, /buyalert, /testalert) ─────
  bot.command(['track', 'buybot', 'buyalert', 'alerts', 'setup', 'settings'], handleBuyBotCommand);
  bot.hears(/^\/(track|buybot|buyalert|alerts|setup|settings)(@\w+)?(\s+.*)?$/i, handleBuyBotCommand);
  bot.command(['testalert', 'testbuy'], handleTestAlertCommand);
  bot.hears(/^\/(testalert|testbuy)(@\w+)?(\s+.*)?$/i, handleTestAlertCommand);
  bot.command(['setbanner', 'banner', 'setmedia'], async (ctx) => {
    const isGroup = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
    const botUsername = ctx.botInfo?.username || 'racertradingbot';
    if (isGroup) {
      const existing = await (await import('@racerbot/db')).getGroupBuyAlertsByChat(ctx.chat!.id).catch(() => []);
      if (existing.length === 0) {
        await ctx.reply('⚠️ Please track a token first with <code>/track &lt;token_address&gt;</code>', { parse_mode: 'HTML' });
        return;
      }
      const alert = existing[0];
      const dmUploadUrl = `https://t.me/${botUsername}?start=setmedia_${alert.id}`;
      const { buyAlertPendingActions } = await import('./buyAlerts.js');
      buyAlertPendingActions.set(ctx.from!.id, {
        adminId: ctx.from!.id,
        chatId: alert.chat_id,
        alertId: alert.id,
        type: 'upload_media',
        expiresAt: Date.now() + 10 * 60_000,
      });
      await ctx.reply(
        `🖼️ <b>Upload Custom Banner for Buy Alerts</b>\n\n` +
        `Tap below to upload your GIF or photo in private DM:\n\n` +
        `<i>(Or send the GIF / photo directly into this group right now!)</i>`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.url('🖼️ Upload Banner in DM', dmUploadUrl)],
          ]),
        }
      );
      return;
    }
  });
  bot.action(/^ba_/, handleBuyAlertAction);

  // Group welcome when bot is added as administrator
  bot.on('my_chat_member', async (ctx) => {
    try {
      const newStatus = ctx.myChatMember.new_chat_member.status;
      const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      if (isGroup && (newStatus === 'administrator' || newStatus === 'member')) {
        const botUsername = ctx.botInfo?.username || 'racertradingbot';
        const setupDmUrl = `https://t.me/${botUsername}?start=setup_group_${ctx.chat.id}`;
        const inviter = ctx.myChatMember.from;
        const groupTitle = (ctx.chat as any)?.title || 'your group';

        // Proactively attempt to message the admin who added the bot in DM
        if (inviter?.id) {
          try {
            await ctx.telegram.sendMessage(
              inviter.id,
              `🏎️ <b>RacerBot Added to ${escapeHtml(groupTitle)}!</b>\n\n` +
              `To activate live BUY alerts with 1-tap trading for your community, tap below to choose which token to track:`,
              {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                  [Markup.button.url('⚙️ Set Up Buy Alerts in DM', setupDmUrl)],
                ]),
              }
            );
          } catch {
            // Inviter hasn't started DM with bot yet — fallback is the inline button in group below!
          }
        }

        await ctx.reply(
          `🏎️ <b>RacerBot Activated!</b>\n\n` +
          `Welcome to RacerBot — the lightning-fast trading & group buy alert bot.\n\n` +
          `📢 <b>To start broadcasting live BUY alerts with 1-tap trading:</b>\n` +
          `Tap the button below to set up in private DM, or run:\n` +
          `<code>/track &lt;token_contract_address&gt;</code>\n\n` +
          `✨ <b>Group Perks:</b>\n` +
          `• Live buy alerts with custom GIFs & emojis\n` +
          `• 1-tap buy button on every alert\n` +
          `• <b>Group Admins earn 5% fee share</b> on every community trade!`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.url('⚙️ Set Up Buy Alerts in DM', setupDmUrl)],
            ]),
          }
        );
      }
    } catch {
      // ignore
    }
  });

  // Listener for custom media banner uploads (animations, photos, videos, documents, stickers)
  bot.on(['animation', 'photo', 'video', 'document', 'sticker'], async (ctx, next) => {
    const handled = await handleBuyAlertMediaUpload(ctx);
    if (!handled) return next();
  });

  // ── Central Message Listener (Direct CA Pasting & Interactive Prompts) ────
  bot.on('text', async (ctx) => {
    // CRITICAL: Public groups must never process arbitrary text, prompt wizards, or token CA pastes
    if (isGroupChat(ctx)) return;

    let rawText = ctx.message.text.trim();
    if (rawText.startsWith('/')) return; // Handled by command dispatch

    const telegramId = ctx.from.id;

    // 1. Process active pending user prompt (e.g. custom buy, custom slippage, withdraw, racedrop)
    let pending = userPendingActions.get(telegramId);
    if (!pending || Date.now() >= pending.expiresAt) {
      pending = await getRaceDropWizardState(telegramId, userPendingActions);
    }

    if (pending && Date.now() < pending.expiresAt) {
      // RaceDrop Wizard: Step 1 (Amount of tokens per user)
      if (pending.action === 'racedrop_amount' && pending.raceDropToken) {
        const amountPerUser = parseFloat(rawText);
        await handleRaceDropAmountPerUserInput(ctx, telegramId, amountPerUser, userPendingActions);
        return;
      }

      // RaceDrop Wizard: Step 2 (Number of users)
      if (pending.action === 'racedrop_claims' && pending.raceDropAmountPerUser) {
        const claims = parseInt(rawText, 10);
        await handleRaceDropClaimsInput(ctx, telegramId, claims, userPendingActions);
        return;
      }

      // AI Swarm: Custom Strategy Prompt
      if (pending.action === 'swarm_custom_prompt') {
        userPendingActions.delete(telegramId);
        const prompt = rawText.trim();
        const loadingMsg = await ctx.reply(
          `🤖 <b>Computing Swarm Plan with NEAR AI Cloud...</b>\n<i>Verifying Intel TDX hardware TEE enclave at api.near.ai...</i>`,
          { parse_mode: 'HTML' }
        );

        try {
          const user = await getUserByTelegramId(telegramId);
          if (!user) throw new Error('User not found. Run /start first.');

          const balances = await getUserBalances(telegramId).catch(() => null);
          const plan = await planSwarmSession({
            prompt,
            userBalances: balances,
            stealthModeOverride: true,
          });

          const session = await createAiSwarmSession({
            userId: user.id,
            prompt,
            strategyType: plan.strategy,
            tokenAddress: plan.tokenAddress,
            tokenSymbol: plan.tokenSymbol,
            totalAmountNear: plan.totalNear,
            droneCount: plan.droneCount,
            stealthMode: plan.stealthMode,
            planJson: plan,
            teeAttestation: plan.teeEnclave,
          });

          const tranches = plan.tranches || [];
          const tranchesText = tranches.slice(0, 5).map((t: any, i: number) =>
            `• Drone #${i + 1}: <b>${t.amountNear.toFixed(2)} NEAR</b> (+${t.delaySec !== undefined ? t.delaySec : (t.delayMs ? Math.round(t.delayMs / 1000) : 0)}s jitter)`
          ).join('\n') + (tranches.length > 5 ? `\n• ...and ${tranches.length - 5} more drone tranches` : '');

          const trig = plan.exitTrigger || (plan as any).exit_trigger;
          const exitInfo = trig ? `\n🎯 Exit Trigger: <b>${escapeHtml(String(trig.targetDisplay || trig.targetValue))}</b>` : '';

          const text =
            `🤖 <b>NEAR AI Custom Execution Plan</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `Strategy: <b>${escapeHtml((plan.strategyTitle || plan.strategy).toUpperCase())}</b>\n` +
            `Target: <b>${escapeHtml(plan.tokenSymbol)}</b> (<code>${escapeHtml(plan.tokenAddress)}</code>)\n` +
            `Capital: <b>${plan.totalNear.toFixed(2)} NEAR</b> (${plan.droneCount} Drones)\n` +
            `Stealth Score: <b>${plan.stealthScore}%</b> 🛡️${exitInfo}\n\n` +
            `<b>Drone Tranches:</b>\n${tranchesText}\n\n` +
            `🔒 <b>TEE Hardware Attestation:</b>\n` +
            `<code>${(plan.teeEnclave.attestationHash || plan.teeEnclave.hash).slice(0, 32)}...</code>\n` +
            `Verified Intel TDX Enclave by NEAR AI Cloud\n\n` +
            `<i>${escapeHtml(plan.analysis || plan.reasoning || '')}</i>`;

          const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('🚀 Authorize & Launch Swarm', `swarm_launch:${session.id}`)],
            [
              Markup.button.callback('🔄 Choose Preset', 'swarm_new_strategy'),
              Markup.button.callback('⬅️ Main Menu', 'menu_home'),
            ],
          ]);

          await ctx.telegram.editMessageText(
            ctx.chat!.id,
            loadingMsg.message_id,
            undefined,
            text,
            { parse_mode: 'HTML', ...keyboard }
          ).catch(async () => {
            await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
          });
        } catch (err: any) {
          await ctx.reply(`❌ Planning failed: ${err?.message || 'Unknown error'}`);
        }
        return;
      }

      userPendingActions.delete(telegramId);

      if (pending.action === 'set_group_token' && pending.chatId) {
        const rawToken = rawText.trim();
        let tokenAddress = rawToken;
        if (tokenAddress.length <= 12 && !tokenAddress.includes('.')) {
          const resolved = resolveTokenAddressFromKey(tokenAddress);
          if (resolved) tokenAddress = resolved;
        }

        const isSui = isSuiToken(tokenAddress) || tokenAddress.startsWith('0x');
        let tokenInfo: any = null;
        try {
          tokenInfo = await getTokenInfo(tokenAddress);
        } catch { /* ignore */ }

        const sym = tokenInfo?.symbol || (isSui ? 'TOKEN' : tokenAddress.split('.')[0].toUpperCase());

        try {
          const { upsertGroupBuyAlert } = await import('@racerbot/db');
          const alert = await upsertGroupBuyAlert({
            chatId: pending.chatId,
            chatTitle: pending.chatTitle || 'Group',
            adminId: telegramId,
            tokenAddress,
            chain: isSui ? 'sui' : 'near',
            minBuyUsd: 5.0,
            emoji: (tokenAddress.toLowerCase().includes('uptober') || tokenInfo?.symbol?.toUpperCase() === 'UPTOBER') ? '🆙⬆️' : '🏎️',
            emojiStepUsd: 5.0,
            whaleThresholdUsd: 200.0,
          });

          const card = buildAlertSettingsCard(alert);
          await ctx.reply(
            `✅ <b>Buy Alerts Activated for Your Group!</b>\n\n` +
            `🪙 Tracking: <b>$${escapeHtml(sym)}</b> (<code>${escapeHtml(tokenAddress)}</code>)\n` +
            `⚡ Status: 🟢 <b>ACTIVE</b>\n\n` +
            `Live BUY alerts will now stream into <b>${escapeHtml(pending.chatTitle || 'your group')}</b> with 1-tap buy buttons! You can customize settings below:`,
            { parse_mode: 'HTML', ...card.keyboard }
          );

          // Notify the group as well!
          try {
            await ctx.telegram.sendMessage(
              pending.chatId,
              `✅ <b>RacerBot Buy Alerts Activated!</b>\n\n` +
              `🪙 Tracking: <b>$${escapeHtml(sym)}</b> (<code>${escapeHtml(tokenAddress)}</code>)\n` +
              `⚡ Status: 🟢 <b>ACTIVE</b>\n\n` +
              `🏎️ Every buy will now be broadcast here with 1-tap trading and live charts!`,
              { parse_mode: 'HTML' }
            );
          } catch { /* chat not found or bot lacks rights */ }
        } catch (err: any) {
          await ctx.reply(`❌ Failed to activate alerts: ${err?.message || err}`);
        }
        return;
      }

      if (pending.action === 'import_near_key') {
        // Delete message containing private key immediately for security!
        await ctx.deleteMessage().catch(() => { });

        const parts = rawText.split(/\s+/).filter(Boolean);
        let explicitAccount: string | undefined;
        let keyString = rawText;

        if (parts.length >= 2) {
          if (parts[0].startsWith('ed25519:') || parts[0].length >= 45) {
            keyString = parts[0];
            explicitAccount = parts[1].toLowerCase();
          } else {
            explicitAccount = parts[0].toLowerCase();
            keyString = parts[1];
          }
        }

        try {
          const keyPair = validateAndParseNearKey(keyString);
          const pubKey = keyPair.getPublicKey().toString();

          let targetAccount = explicitAccount;
          if (!targetAccount) {
            const discovered = await findAccountsForNearPublicKey(pubKey);
            if (discovered.length === 0) {
              await ctx.reply(
                `❌ No active NEAR account found associated with this private key.\n\n` +
                `• If this is a named account, try specifying the account ID alongside the key:\n` +
                `  <code>youraccount.near ed25519:...</code>\n` +
                `• If this is a new account, ensure it has received its initial deposit on-chain first.`,
                { parse_mode: 'HTML' }
              );
              return;
            }
            if (discovered.length === 1) {
              targetAccount = discovered[0];
            } else {
              userPendingActions.set(telegramId, {
                action: 'import_near_key',
                importNearPrivateKey: keyPair.toString(),
                expiresAt: Date.now() + 180000,
              });
              const buttons = discovered.map(acc => [cb(acc, `wallet_pick_acc:${acc}`, 'primary')]);
              buttons.push([cb('❌ Cancel', 'menu_home', 'primary')]);
              await ctx.reply(
                `🔍 Found multiple NEAR accounts associated with this key. Please select which account you want to import:`,
                { reply_markup: { inline_keyboard: buttons } }
              );
              return;
            }
          }

          userPendingActions.set(telegramId, {
            action: 'import_near_name',
            importNearPrivateKey: keyPair.toString(),
            importNearAccountId: targetAccount,
            expiresAt: Date.now() + 180000,
          });

          await ctx.reply(
            `✅ <b>Account Found:</b> <code>${targetAccount}</code>\n\n` +
            `Please reply with a nickname for this wallet (e.g. <i>Sniper</i>, <i>Main</i>, <i>Degen</i>):\n\n` +
            `_Send /cancel to abort._`,
            { parse_mode: 'HTML' }
          );
        } catch (err: any) {
          await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
        }
        return;
      }

      if (pending.action === 'import_near_name') {
        const walletName = rawText.trim();
        if (!pending.importNearPrivateKey) {
          await ctx.reply('❌ Import session expired. Please start over via /wallets.');
          return;
        }

        // Ask if user wants to set this wallet as active
        userPendingActions.set(telegramId, {
          action: 'import_near_confirm',
          importNearPrivateKey: pending.importNearPrivateKey,
          importNearAccountId: pending.importNearAccountId,
          importNearWalletName: walletName,
          expiresAt: Date.now() + 180000,
        });

        const buttons = [
          [cb('✅ Set as Active', 'wallet_import_active_near', 'primary')],
          [cb('➕ Add Only (Keep Current Active)', 'wallet_import_inactive_near', 'primary')],
          [cb('❌ Cancel', 'menu_home', 'primary')],
        ];

        await ctx.reply(
          `📝 <b>Wallet Name:</b> ${walletName}\n\n` +
          `Do you want to set this wallet as your <b>active trading wallet</b>?\n\n` +
          `• <b>Set as Active:</b> All future NEAR trades will use this wallet\n` +
          `• <b>Add Only:</b> Import without changing your active wallet`,
          { reply_markup: { inline_keyboard: buttons }, parse_mode: 'HTML' }
        );
        return;
      }

      if (pending.action === 'import_near_confirm') {
        // This should be handled by the action handlers below
        return;
      }

      if (pending.action === 'rename_near_wallet') {
        const newName = rawText.trim();
        if (!pending.renameWalletId) {
          await ctx.reply('❌ Rename session expired. Please start over via /wallets.');
          return;
        }

        try {
          const updated = await renameUserNearWallet(telegramId, pending.renameWalletId, newName);
          await ctx.reply(`✅ Wallet renamed to <b>${updated.name}</b>!`, { parse_mode: 'HTML' });
          const menu = await buildWalletsManagementMenu(telegramId);
          await ctx.reply(menu.text, { parse_mode: 'HTML', ...menu.keyboard });
        } catch (err: any) {
          await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
        }
        return;
      }

      if (pending.action === 'import_sui_key') {
        // Delete message containing private key immediately for security!
        await ctx.deleteMessage().catch(() => { });

        try {
          const kp = restoreSuiKeypairFromSecret(rawText);
          const suiAddr = kp.toSuiAddress();

          userPendingActions.set(telegramId, {
            action: 'import_sui_name',
            importSuiPrivateKey: rawText,
            expiresAt: Date.now() + 180000,
          });

          await ctx.reply(
            `✅ <b>Valid SUI Key!</b>\n\n` +
            `• Address: <code>${suiAddr}</code>\n\n` +
            `Please reply with a nickname for this wallet (e.g. <i>Sui Whale</i>, <i>Sniper</i>, <i>Main</i>):\n\n` +
            `_Send /cancel to abort._`,
            { parse_mode: 'HTML' }
          );
        } catch (err: any) {
          await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
        }
        return;
      }

      if (pending.action === 'import_sui_name') {
        const walletName = rawText.trim();
        if (!pending.importSuiPrivateKey) {
          await ctx.reply('❌ Import session expired. Please start over via /wallets.');
          return;
        }

        // Ask if user wants to set this wallet as active
        userPendingActions.set(telegramId, {
          action: 'import_sui_confirm',
          importSuiPrivateKey: pending.importSuiPrivateKey,
          importSuiWalletName: walletName,
          expiresAt: Date.now() + 180000,
        });

        const buttons = [
          [cb('✅ Set as Active', 'wallet_import_active_sui', 'primary')],
          [cb('➕ Add Only (Keep Current Active)', 'wallet_import_inactive_sui', 'primary')],
          [cb('❌ Cancel', 'menu_home', 'primary')],
        ];

        await ctx.reply(
          `📝 <b>Wallet Name:</b> ${walletName}\n\n` +
          `Do you want to set this wallet as your <b>active trading wallet</b>?\n\n` +
          `• <b>Set as Active:</b> All future SUI trades will use this wallet\n` +
          `• <b>Add Only:</b> Import without changing your active wallet`,
          { reply_markup: { inline_keyboard: buttons }, parse_mode: 'HTML' }
        );
        return;
      }

      if (pending.action === 'import_sui_confirm') {
        // This should be handled by the action handlers below
        return;
      }

      if (pending.action === 'rename_sui_wallet') {
        const newName = rawText.trim();
        if (!pending.renameSuiWalletId) {
          await ctx.reply('❌ Rename session expired. Please start over via /wallets.');
          return;
        }

        try {
          const updated = await renameUserSuiWallet(telegramId, pending.renameSuiWalletId, newName);
          await ctx.reply(`✅ SUI Wallet renamed to <b>${updated.name}</b>!`, { parse_mode: 'HTML' });
          const menu = await buildWalletsManagementMenu(telegramId);
          await ctx.reply(menu.text, { parse_mode: 'HTML', ...menu.keyboard });
        } catch (err: any) {
          await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
        }
        return;
      }

      if (pending.action === 'rename_starknet_wallet') {
        const newName = rawText.trim();
        if (!pending.renameStarknetWalletId) {
          await ctx.reply('❌ Rename session expired. Please start over via /wallets.');
          return;
        }

        try {
          const updated = await renameUserStarknetWallet(telegramId, pending.renameStarknetWalletId, newName);
          await ctx.reply(`✅ Starknet Wallet renamed to <b>${updated.name}</b>!`, { parse_mode: 'HTML' });
          const menu = await buildWalletsManagementMenu(telegramId);
          await ctx.reply(menu.text, { parse_mode: 'HTML', ...menu.keyboard });
        } catch (err: any) {
          await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
        }
        return;
      }

      if (pending.action === 'buy_custom_near' && pending.tokenAddress) {
        const trimmedBuyInput = rawText.trim();
        const customUser = await getUserByTelegramId(telegramId).catch(() => null);
        const tokenAddress = pending.tokenAddress;
        const buyChain = resolveTokenChain(tokenAddress);
        const isNearTokenBuy = buyChain === 'near';
        const isExplicitNearInput = /\bnear\b/i.test(trimmedBuyInput);
        const isUsdcBuyInput = isNearTokenBuy && (/^\$/.test(trimmedBuyInput) || /usdc|usd/i.test(trimmedBuyInput) || (!isExplicitNearInput && customUser?.near_trade_currency === 'usdc'));
        const parsedBuyNum = parseFloat(trimmedBuyInput.replace(/[^0-9.]/g, ''));
        const nearUsdForBuy = isUsdcBuyInput && !isNaN(parsedBuyNum) && parsedBuyNum > 0 ? ((await getNearUsdPrice().catch(() => 0)) || 5.0) : 0;
        const customAmt = isUsdcBuyInput && nearUsdForBuy > 0 ? Math.floor((parsedBuyNum / nearUsdForBuy) * 1e6) / 1e6 : parsedBuyNum;
        if (!isNaN(customAmt) && customAmt > 0) rawText = String(customAmt);
        const amt = parseFloat(rawText);
        if (isNaN(amt) || amt <= 0) {
          await ctx.reply('❌ Invalid amount. Buy cancelled.');
          return;
        }
        const unit = getChainNativeUnit(buyChain, customUser);
        const guardKey = inFlightKey(telegramId, tokenAddress, 'buy');
        if (!(await tryAcquireInFlight(guardKey))) {
          await ctx.reply('⏳ A trade for this token is already in progress.');
          return;
        }

        (async () => {
          const procMsg = await ctx.reply(`⏳ *Processing Buy Order...*\n\nExchanging \`${amt} ${unit}\` for \`${tokenAddress}\`...\n_Executing swap on DEX..._`, { parse_mode: 'Markdown' }).catch(() => null);
          const onStage = makeStageEditor(ctx, procMsg, 'Processing Buy Order');
          try {
            const res = await executeBuyHelper(telegramId, tokenAddress, amt, onStage);
            if (procMsg) await ctx.deleteMessage(procMsg.message_id).catch(() => { });

            await ctx.reply(res.message, {
              parse_mode: 'Markdown',
              reply_markup: await buildBuySuccessKeyboard(telegramId, tokenAddress, res.tokenSymbol, res.positionId),
            });
            if (res.positionId) {
              await sendPostBuySlTpPrompt(ctx, res.positionId, tokenAddress, res.tokenSymbol);
            }
          } catch (err: any) {
            console.warn(`[BUY] Buy failed for ${tokenAddress}:`, err?.message || err);
            if (procMsg) await ctx.deleteMessage(procMsg.message_id).catch(() => { });
            try {
              await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
            } catch {
              console.error(`[BUY] Failed to send error message for ${tokenAddress}:`, err?.message || err);
            }
          } finally {
            await releaseInFlight(guardKey);
          }
        })().catch(async (err: any) => {
          await releaseInFlight(guardKey);
          console.error('[BUY] Unhandled detached custom-buy error:', err?.message || err);
        });
        return;
      }

      if (pending.action === 'set_sl_custom' && pending.positionId) {
        const positionId = pending.positionId;
        const cleanText = rawText.replace(/[%-]/g, '').trim();
        const pct = parseFloat(cleanText);
        if (isNaN(pct) || pct <= 0 || pct >= 100) {
          await ctx.reply('❌ Invalid percentage. Stop loss must be between 1% and 99% (e.g. 15 for -15%).');
          return;
        }

        const user = await getUserByTelegramId(telegramId).catch(() => null);
        if (!user) return;

        const position = await getPositionById(positionId).catch(() => null);
        if (!position || position.user_id !== user.id) {
          await ctx.reply('❌ Position not found.');
          return;
        }

        const info = await getTokenInfo(position.token_address, false).catch(() => null);
        const symbol = info?.symbol ? sanitizeMd(info.symbol) : 'Token';
        const sellQtyMsg =
          `📉 *Stop Loss — Sell Quantity for ${symbol}*\n\n` +
          `Drop level: \`-${pct}%\` from entry\n\n` +
          `How much of your position should be sold when this triggers?`;
        const sellQtyButtons = [
          [
            cb('25% of position', `set_sl:${positionId}:${pct}:25`, 'danger'),
            cb('50% of position', `set_sl:${positionId}:${pct}:50`, 'danger'),
          ],
          [
            cb('75% of position', `set_sl:${positionId}:${pct}:75`, 'danger'),
            cb('100% (all)', `set_sl:${positionId}:${pct}:100`, 'danger'),
          ],
          [cb('🔙 Back', `sl_prompt:${positionId}`, 'primary')],
        ];
        await ctx.reply(sellQtyMsg, {
          parse_mode: 'Markdown',
          reply_markup: Markup.inlineKeyboard(sellQtyButtons).reply_markup,
        });
        return;
      }

      if (pending.action === 'set_tp_custom' && pending.positionId) {
        const positionId = pending.positionId;
        const cleanText = rawText.replace(/[%+]/g, '').trim();
        const pct = parseFloat(cleanText);
        if (isNaN(pct) || pct <= 0) {
          await ctx.reply('❌ Invalid percentage. Take profit must be greater than 0% (e.g. 50 for +50%, 150 for +150%).');
          return;
        }

        const user = await getUserByTelegramId(telegramId).catch(() => null);
        if (!user) return;

        const position = await getPositionById(positionId).catch(() => null);
        if (!position || position.user_id !== user.id) {
          await ctx.reply('❌ Position not found.');
          return;
        }

        const info = await getTokenInfo(position.token_address, false).catch(() => null);
        const symbol = info?.symbol ? sanitizeMd(info.symbol) : 'Token';
        const sellQtyMsg =
          `📈 *Take Profit — Sell Quantity for ${symbol}*\n\n` +
          `Profit target: \`+${pct}%\` from entry\n\n` +
          `How much of your position should be sold when this triggers?`;
        const sellQtyButtons = [
          [
            cb('25% of position', `set_tp:${positionId}:${pct}:25`, 'success'),
            cb('50% of position', `set_tp:${positionId}:${pct}:50`, 'success'),
          ],
          [
            cb('75% of position', `set_tp:${positionId}:${pct}:75`, 'success'),
            cb('100% (all)', `set_tp:${positionId}:${pct}:100`, 'success'),
          ],
          [cb('🔙 Back', `tp_prompt:${positionId}`, 'primary')],
        ];
        await ctx.reply(sellQtyMsg, {
          parse_mode: 'Markdown',
          reply_markup: Markup.inlineKeyboard(sellQtyButtons).reply_markup,
        });
        return;
      }

      if (pending.action === 'sell_custom_tokens' && pending.deployerAddress) {
        const positionId = pending.deployerAddress;
        const tokensToSell = parseFloat(rawText);
        if (isNaN(tokensToSell) || tokensToSell <= 0) {
          await ctx.reply('❌ Invalid token amount. Sell cancelled.');
          return;
        }

        const user = await getUserByTelegramId(telegramId).catch(() => null);
        if (!user) {
          await ctx.reply('Use /start to set up your wallet first.');
          return;
        }

        const livePosition = await getPositionById(positionId).catch(() => null);
        if (!livePosition || livePosition.status !== 'open') {
          await ctx.reply('❌ Position is closed or not found.');
          return;
        }

        const tokenInfo = await getTokenInfo(livePosition.token_address, false).catch(() => null);
        const decimals = tokenInfo?.decimals ?? 18;
        const rawHeld = BigInt((livePosition.quantity_held || '0').split('.')[0]);
        const totalHumanHeld = Number(rawHeld) / Math.pow(10, decimals);

        if (totalHumanHeld <= 0) {
          await ctx.reply('❌ No tokens held in this position.');
          return;
        }

        const percentage = Math.min(100, Math.max(0.1, (tokensToSell / totalHumanHeld) * 100));

        const guardKey = inFlightKey(telegramId, livePosition.token_address, 'sell');
        if (!(await tryAcquireInFlight(guardKey))) {
          await ctx.reply('⏳ A trade for this token is already in progress.');
          return;
        }

        (async () => {
          const sym = tokenInfo?.symbol || 'tokens';
          const procMsg = await ctx.reply(
            `⏳ *Processing Sell Order...*\n\nSelling \`${tokensToSell.toLocaleString()} ${sym}\` (\`${percentage.toFixed(1)}%\` of holdings)...\n_Executing swap on DEX..._`,
            { parse_mode: 'Markdown' }
          ).catch(() => null);
          const onStage = makeStageEditor(ctx, procMsg, 'Processing Sell Order');
          try {
            const result = await sellAtTarget(user.id, positionId, percentage, onStage);
            if (procMsg) await ctx.deleteMessage(procMsg.message_id).catch(() => { });
            if (result.success) {
              await sendPnlCardMessage(
                ctx,
                positionId,
                result.usdcReceived && result.usdcReceived > 0
                  ? `✅ *Successfully sold \`${tokensToSell.toLocaleString()} ${sym}\` (\`${percentage.toFixed(1)}%\`)!*\n💵 *Received*: \`+${result.usdcReceived.toFixed(2)} USDC\``
                  : `✅ *Successfully sold \`${tokensToSell.toLocaleString()} ${sym}\` (\`${percentage.toFixed(1)}%\`)!*`
              ).catch(() => { });
            } else {
              await ctx.reply(`❌ Sell failed: ${result.reason || 'Unknown error'}`).catch(() => { });
            }
          } catch (err: any) {
            if (procMsg) await ctx.deleteMessage(procMsg.message_id).catch(() => { });
            console.error('[SELL_CUSTOM] Error:', err);
            await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => { });
          } finally {
            await releaseInFlight(guardKey);
          }
        })().catch(async (err: any) => {
          await releaseInFlight(guardKey);
          console.error('[SELL_CUSTOM] Unhandled detached error:', err?.message || err);
        });
        return;
      }

      if (pending.action === 'custom_buy_amounts') {
        const parts = rawText
          .split(/[,;\s]+/)
          .map(s => parseFloat(s.trim()))
          .filter(n => !isNaN(n) && n > 0);

        if (parts.length === 0) {
          await ctx.reply('❌ Invalid buy amounts. Please enter positive numbers separated by commas (e.g. `0.5, 2, 5` or `10, 25, 50`).');
          return;
        }

        const cleanAmounts = parts.slice(0, 4);
        const amountsStr = cleanAmounts.join(', ');

        const user = await getUserByTelegramId(telegramId);
        if (user) {
          const updated = await updateUserSettings(user.id, { custom_buy_amounts: amountsStr });
          await ctx.reply(`✅ Quick Buy buttons updated to: \`${amountsStr}\`!`, { parse_mode: 'Markdown' });
          const dash = buildSettingsDashboard(updated);
          await ctx.reply(dash.text, { parse_mode: 'Markdown', ...dash.keyboard });
        }
        return;
      }

      if (pending.action === 'custom_slippage') {
        const slip = parseFloat(rawText);
        if (isNaN(slip) || slip < 0.1 || slip > 100) {
          await ctx.reply('❌ Invalid slippage. Must be a number between 0.1% and 100%.');
          return;
        }
        const user = await getUserByTelegramId(telegramId);
        if (user) {
          const updated = await updateUserSettings(user.id, { slippage_pct: slip });
          await ctx.reply(`✅ Slippage tolerance updated to ${slip}%!`);
          const dash = buildSettingsDashboard(updated);
          await ctx.reply(dash.text, { parse_mode: 'Markdown', ...dash.keyboard });
        }
        return;
      }

      if (pending.action === 'custom_auto_buy') {
        const amt = parseFloat(rawText);
        const user = await getUserByTelegramId(telegramId);
        const isUsdc = user?.near_trade_currency === 'usdc';
        const unit = isUsdc ? 'USDC' : 'NEAR';
        if (isNaN(amt) || amt <= 0) {
          await ctx.reply(`❌ Invalid amount. Must be a positive number in ${unit}.`);
          return;
        }
        if (user) {
          const updated = await updateUserSettings(user.id, { auto_buy_amount_near: amt });
          await ctx.reply(`✅ Auto-buy amount updated to ${amt} ${unit}!`);
          const dash = await buildSnipeDashboard(updated);
          await ctx.reply(dash.text, { parse_mode: 'Markdown', ...dash.keyboard });
        }
        return;
      }

      if (pending.action === 'custom_min_liq') {
        const liq = parseFloat(rawText);
        if (isNaN(liq) || liq < 0) {
          await ctx.reply('❌ Invalid liquidity. Must be a non-negative number in NEAR.');
          return;
        }
        const user = await getUserByTelegramId(telegramId);
        if (user) {
          const updated = await updateUserSettings(user.id, { auto_buy_min_liquidity_near: liq });
          await ctx.reply(`✅ Min pool liquidity updated to ${liq} NEAR!`);
          const dash = await buildSnipeDashboard(updated);
          await ctx.reply(dash.text, { parse_mode: 'Markdown', ...dash.keyboard });
        }
        return;
      }

      if (pending.action === 'custom_max_mcap') {
        const cleaned = rawText.replace(/[\$,]/g, '').trim().toLowerCase();
        let mcap = parseFloat(cleaned);
        if (cleaned.endsWith('k')) {
          mcap = parseFloat(cleaned.slice(0, -1)) * 1000;
        } else if (cleaned.endsWith('m')) {
          mcap = parseFloat(cleaned.slice(0, -1)) * 1_000_000;
        }
        if (isNaN(mcap) || mcap < 0) {
          await ctx.reply('❌ Invalid market cap. Must be a non-negative number in USD (e.g. `50000` or `50k` or `0` for no limit).');
          return;
        }
        const user = await getUserByTelegramId(telegramId);
        if (user) {
          const updated = await updateUserSettings(user.id, { auto_buy_max_market_cap_usd: mcap });
          await ctx.reply(`✅ Max market cap updated to ${mcap > 0 ? '$' + mcap.toLocaleString() : 'No Limit'}!`);
          const dash = await buildSnipeDashboard(updated);
          await ctx.reply(dash.text, { parse_mode: 'Markdown', ...dash.keyboard });
        }
        return;
      }

      // ── Targeted snipe FSM ──────────────────────────────────────────────

      if (pending.action === 'snipe_token_ca') {
        const rawCA = rawText.trim();
        const chain = resolveTokenChain(rawCA);
        const user = await getUserByTelegramId(telegramId).catch(() => null);
        const tokUnit = getChainNativeUnit(chain, user);
        let tokenName = 'Token';
        let tokenSym = 'TOKEN';
        let chainLabel = 'NEAR';

        if (chain === 'solana') {
          chainLabel = 'Solana';
          const solMeta = await getSolanaTokenInfo(rawCA).catch(() => null);
          if (solMeta) { tokenName = solMeta.name || tokenName; tokenSym = solMeta.symbol || tokenSym; }
        } else if (chain === 'hyperevm' || chain === 'elysium') {
          chainLabel = chain === 'elysium' ? 'Elysium' : 'HyperEVM';
          const info = await getTokenInfo(rawCA).catch(() => null);
          if (info) { tokenName = info.name || tokenName; tokenSym = info.symbol || tokenSym; }
        } else if (chain === 'starknet') {
          chainLabel = 'Starknet';
          const meta = await getStarknetTokenMetadata(rawCA).catch(() => null);
          if (meta) { tokenName = meta.name || tokenName; tokenSym = meta.symbol || tokenSym; }
        } else if (chain === 'sui') {
          chainLabel = 'Sui';
          const meta = await getSuiTokenMetadata(rawCA).catch(() => null);
          if (meta) { tokenName = meta.name || tokenName; tokenSym = meta.symbol || tokenSym; }
        } else {
          chainLabel = 'NEAR';
          const ca = rawCA.toLowerCase();
          if (!isValidNearAccountId(ca)) {
            await ctx.reply('❌ That does not look like a valid contract address. Check the CA and try again, or /cancel.', { parse_mode: 'Markdown' });
            userPendingActions.set(telegramId, { action: 'snipe_token_ca', expiresAt: Date.now() + 120_000 });
            return;
          }
          const meta = await near.getTokenMetadata(ca).catch(() => null);
          if (meta?.name && meta?.symbol) {
            tokenName = meta.name;
            tokenSym = meta.symbol;
          }
        }

        const exampleAmt = tokUnit === 'SOL' ? '0.25' : tokUnit === 'HYPE' ? '1.0' : tokUnit === 'STRK' ? '10' : tokUnit === 'SUI' ? '5' : tokUnit === 'USDC' ? '10' : '2.5';
        userPendingActions.set(telegramId, { action: 'snipe_token_amount', tokenAddress: rawCA, expiresAt: Date.now() + 120_000 });
        await ctx.reply(
          `🪙 Token on ${chainLabel}: *${sanitizeMd(tokenName)}* (${sanitizeMd(tokenSym)})\n\nReply with the amount in ${tokUnit} to snipe (e.g. \`${exampleAmt}\`):\nType /cancel to abort.`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      if (pending.action === 'snipe_token_amount' && pending.tokenAddress) {
        const amt = parseFloat(rawText);
        const user = await getUserByTelegramId(telegramId);
        const tokUnit = snipeUnit(pending.tokenAddress, user);
        if (isNaN(amt) || amt <= 0 || (tokUnit === 'SOL' && amt < 0.001)) {
          await ctx.reply(`❌ Invalid amount. Must be a positive number in ${tokUnit}${tokUnit === 'SOL' ? ' (min 0.001)' : ''}. Snipe setup cancelled.`);
          return;
        }
        if (!user) {
          await ctx.reply('Use /start to set up your wallet first.');
          return;
        }
        if (tokUnit === 'SOL' && !user.solana_address) {
          await ctx.reply('❌ Your Solana wallet is not ready yet. Send /start and try again.');
          return;
        }
        const activeCount = await countActiveSnipeOrders(user.id).catch(() => 0);
        if (activeCount >= MAX_ACTIVE_SNIPE_ORDERS_PER_USER) {
          await ctx.reply(`❌ You already have ${MAX_ACTIVE_SNIPE_ORDERS_PER_USER} active snipe orders. Cancel one in 🎯 Snipe Rules → 📋 My Snipe Orders.`);
          return;
        }
        const tokenAddress = pending.tokenAddress;

        // Save into cache & pending actions with TTL of 3 minutes
        snipeSetupCache.set(telegramId, {
          tokenAddress,
          amt,
          expiresAt: Date.now() + 600_000,
        });
        userPendingActions.set(telegramId, {
          action: 'snipe_custom_time',
          tokenAddress,
          snipeAmount: amt,
          expiresAt: Date.now() + 600_000,
        });

        const currentUtc = formatUtcTime();
        await ctx.reply(
          `⏱ *Select Snipe Trigger Timing*\n\n` +
          `🪙 Token: \`${tokenAddress}\`\n` +
          `💰 Amount: \`${amt} ${tokUnit}\`\n` +
          `Current Time: \`${currentUtc}\`\n\n` +
          `When should the bot execute your snipe?\n\n` +
          `• *⚡ Immediate on Liquidity*: Executes as soon as trading/liquidity is live.\n` +
          `• *⏳ Delays (+5m, +10m, +15m)*: Great for tokens with temporary high launch fees (e.g. 70% decay curve).\n` +
          `• *🕒 Custom UTC Time*: Trigger at an exact time today or a scheduled date.\n\n` +
          `_You can also reply directly with a time (e.g. \`19:25\`, \`7:25 PM\`, \`+10m\`, or \`2026-10-08 19:25\`) or pick an option below:_\n` +
          `Type /cancel to abort.`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [cb('⚡ Immediate on Liquidity', `snipe_time:now:${amt}`, 'success')],
                [
                  cb('⏳ +5m Delay', `snipe_time:delay:5:${amt}`, 'primary'),
                  cb('⏳ +10m Delay', `snipe_time:delay:10:${amt}`, 'primary'),
                  cb('⏳ +15m Delay', `snipe_time:delay:15:${amt}`, 'primary'),
                ],
                [cb('🕒 Custom UTC Time', `snipe_time:custom:${amt}`, 'primary')],
                [cb('❌ Cancel', 'snipe_time:cancel', 'danger')],
              ],
            },
          }
        );
        return;
      }

      if (pending.action === 'snipe_custom_time' && pending.tokenAddress) {
        const tokenAddress = pending.tokenAddress;
        const amt = pending.snipeAmount || snipeSetupCache.get(telegramId)?.amt || 0;
        if (amt <= 0) {
          await ctx.reply('❌ Session expired or invalid amount. Please start the snipe setup again with /menu.');
          userPendingActions.delete(telegramId);
          snipeSetupCache.delete(telegramId);
          return;
        }

        const parsed = parseUtcTimeString(rawText);
        if (!parsed.date) {
          const currentUtc = formatUtcTime();
          await ctx.reply(
            `❌ ${parsed.error ?? 'Invalid time format'}\n\n` +
            `Current Time: \`${currentUtc}\`\n\n` +
            `Please reply with a valid UTC time in the future:\n` +
            `• \`19:25\` or \`7:25 PM\` (HH:MM in UTC)\n` +
            `• \`+10m\` or \`15 mins\` (delay from now)\n` +
            `• \`2026-10-08 19:25\` (YYYY-MM-DD HH:MM in UTC)\n\n` +
            `Or type /cancel to abort.`,
            { parse_mode: 'Markdown' }
          );
          return;
        }

        userPendingActions.delete(telegramId);
        snipeSetupCache.delete(telegramId);
        await completeSnipeOrderCreation(ctx, telegramId, tokenAddress, amt, parsed.date);
        return;
      }

      if (pending.action === 'snipe_dev_addr' && isSolanaAddress(rawText.trim())) {
        const dev = rawText.trim();
        userPendingActions.set(telegramId, { action: 'snipe_dev_amount', deployerAddress: dev, expiresAt: Date.now() + 120_000 });
        await ctx.reply(
          `👤 Solana deployer: \`${dev}\`\n\n` +
          `Every new *pump.fun* coin this wallet launches will be bought.\n\n` +
          `Reply with the amount in SOL per launch (e.g. \`0.2\`):\nType /cancel to abort.`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      if (pending.action === 'snipe_dev_addr') {
        const dev = rawText.toLowerCase();
        if (!isValidNearAccountId(dev)) {
          await ctx.reply('❌ Invalid NEAR wallet address. Try again (e.g. `someuser.near`) or /cancel.', { parse_mode: 'Markdown' });
          userPendingActions.set(telegramId, { action: 'snipe_dev_addr', expiresAt: Date.now() + 120_000 });
          return;
        }
        const user = await getUserByTelegramId(telegramId).catch(() => null);
        const isUsdc = user?.near_trade_currency === 'usdc';
        const unit = isUsdc ? 'USDC' : 'NEAR';
        const exampleAmt = isUsdc ? '10' : '1.5';
        userPendingActions.set(telegramId, { action: 'snipe_dev_amount', deployerAddress: dev, expiresAt: Date.now() + 120_000 });
        await ctx.reply(
          `👤 Deployer: \`${dev}\`\n\nReply with the amount in ${unit} to snipe *every* new token this wallet launches (e.g. \`${exampleAmt}\`):\nType /cancel to abort.`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      if (pending.action === 'snipe_dev_amount' && pending.deployerAddress) {
        const user = await getUserByTelegramId(telegramId);
        if (!user) {
          await ctx.reply('Use /start to set up your wallet first.');
          return;
        }
        const amt = parseFloat(rawText);
        const isSolDev = isSolanaAddress(pending.deployerAddress);
        const devUnit = isSolDev ? 'SOL' : (user.near_trade_currency === 'usdc' ? 'USDC' : 'NEAR');
        if (isNaN(amt) || amt <= 0 || (devUnit === 'SOL' && amt < 0.001)) {
          await ctx.reply(`❌ Invalid amount. Must be a positive number in ${devUnit}. Snipe setup cancelled.`);
          return;
        }
        if (devUnit === 'SOL' && !user.solana_address) {
          await ctx.reply('❌ Your Solana wallet is not ready yet. Send /start and try again.');
          return;
        }
        const activeCount = await countActiveSnipeOrders(user.id).catch(() => 0);
        if (activeCount >= MAX_ACTIVE_SNIPE_ORDERS_PER_USER) {
          await ctx.reply(`❌ You already have ${MAX_ACTIVE_SNIPE_ORDERS_PER_USER} active snipe orders. Cancel one in 🎯 Snipe Rules → 📋 My Snipe Orders.`);
          return;
        }
        const tradeCurrency = isSolDev ? 'sol' : (user.near_trade_currency === 'usdc' ? 'usdc' : 'near');
        const order = await createSnipeOrder({
          user_id: user.id,
          snipe_type: 'deployer',
          deployer_address: pending.deployerAddress,
          amount_near: amt,
          trade_currency: tradeCurrency,
        });
        await ctx.reply(
          `👤 *Deployer Snipe Armed!*\n\n` +
          `🧑‍💻 Deployer: \`${pending.deployerAddress}\`\n` +
          `💰 Amount per launch: \`${amt} ${devUnit}\`\n\n` +
          `Every new token launched by this wallet will be auto-bought the moment it's detected.`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [cb('❌ Cancel Snipe Order', `snipe_order_cancel:${order.id}`, 'danger')],
                [cb('📋 My Snipe Orders', 'snipe_orders', 'primary'), cb('🎯 Snipe Rules', 'menu_snipe', 'primary')],
              ],
            },
          }
        );
        return;
      }

      if (pending.action === 'withdraw') {
        const parts = rawText.split(' ').filter(Boolean);
        const parsed = parseTransferArgs(parts);

        // If user was prompted for a specific token (e.g. from send_token_prompt)
        const tokenToUse = pending.tokenAddress || parsed.token;
        const dest = parsed.destination;
        const amt: number | 'all' = parsed.amount === undefined ? 'all' : parsed.amount;

        if (!dest) {
          await ctx.reply('❌ Destination address is required.\n\nExample: `recipient.near 100` or `recipient.near all`', { parse_mode: 'Markdown' });
          userPendingActions.set(telegramId, { ...pending, expiresAt: Date.now() + 180000 });
          return;
        }

        if (typeof amt === 'number' && (isNaN(amt) || amt <= 0)) {
          await ctx.reply('❌ Invalid amount. Must be a positive number or "all".\n\nExample: `mywallet.near 1.5` or `mywallet.near all`', { parse_mode: 'Markdown' });
          userPendingActions.set(telegramId, { ...pending, expiresAt: Date.now() + 180000 });
          return;
        }

        const isSolDest = isSolanaAddress(dest);
        const isNearDest = dest.endsWith('.near') || (!isSolDest && !dest.startsWith('0x') && isValidNearAccountId(dest));
        const isSuiDest = isValidSuiAddress(dest) && !dest.endsWith('.near');
        const isStarknetDest = isValidStarknetAddress(dest) && !dest.endsWith('.near');
        const normToken = (tokenToUse || '').toLowerCase();
        const isStrkOrEth = normToken === 'strk' || normToken === 'eth';
        const isSolNative = normToken === 'sol' || (!tokenToUse && isSolDest);
        const isExplicitToken = tokenToUse && normToken !== 'near' && normToken !== 'sui' && normToken !== 'sol' && !isStrkOrEth;
        const targetDesc = isSolNative ? 'SOL' : isExplicitToken ? `token \`${tokenToUse}\`` : (isStrkOrEth ? `Starknet ${normToken.toUpperCase()}` : 'funds');
        await ctx.reply(`⏳ Processing transfer of ${targetDesc} to \`${dest}\`...`, { parse_mode: 'Markdown' });

        try {
          if (isSolNative) {
            const result = await withdrawSolanaFunds(telegramId, dest, amt);
            await ctx.reply(
              `✅ *SOL Withdrawal Successful!*\n\n` +
              `💸 Amount: \`${result.amountWithdrawn} SOL\`\n` +
              `📬 Destination: \`${result.destination}\`\n\n` +
              `🔗 Explorer: [View on Solscan](https://solscan.io/tx/${result.txHash})`,
              { parse_mode: 'Markdown' }
            );
          } else if (isExplicitToken) {
            const result = await withdrawTokenFunds(telegramId, tokenToUse, dest, amt);
            const explorerUrl =
              result.chain === 'solana'
                ? `https://solscan.io/tx/${result.txHash}`
                : result.chain === 'starknet'
                ? `https://voyager.online/tx/${result.txHash}`
                : result.chain === 'sui'
                ? `https://suiscan.xyz/mainnet/tx/${result.txHash}`
                : `https://nearblocks.io/txns/${result.txHash}`;
            const explorerName = result.chain === 'solana' ? 'Solscan' : result.chain === 'starknet' ? 'Voyager' : result.chain === 'sui' ? 'Suiscan' : 'NearBlocks';

            await ctx.reply(
              `✅ *Token Transfer Successful!*\n\n` +
              `💸 Amount: \`${result.amountWithdrawn} ${result.symbol}\`\n` +
              `📬 Destination: \`${result.destination}\`\n` +
              `🪙 Contract: \`${result.tokenAddress}\`\n\n` +
              `🔗 Explorer: [View on ${explorerName}](${explorerUrl})`,
              { parse_mode: 'Markdown' }
            );
          } else if (isStrkOrEth) {
            const result = await withdrawStarknetFunds(telegramId, dest, amt, normToken);
            await ctx.reply(
              `✅ *Starknet Transfer Successful!*\n\n` +
              `💸 Amount: \`${result.amountWithdrawn} ${result.symbol}\`\n` +
              `📬 Destination: \`${result.destination}\`\n\n` +
              `🔗 Explorer: [View on Voyager](https://voyager.online/tx/${result.txHash})`,
              { parse_mode: 'Markdown' }
            );
          } else if (normToken === 'sui') {
            const result = await withdrawSuiFunds(telegramId, dest, amt);
            await ctx.reply(
              `✅ *SUI Withdrawal Successful!*\n\n` +
              `💸 Amount: \`${result.amountWithdrawn} SUI\`\n` +
              `📬 Destination: \`${result.destination}\`\n\n` +
              `🔗 Explorer: [View on Suiscan](https://suiscan.xyz/mainnet/tx/${result.txHash})`,
              { parse_mode: 'Markdown' }
            );
          } else if (isStarknetDest && !isNearDest) {
            const user = await getUserByTelegramId(telegramId);
            const [suiBal, strkBal] = await Promise.all([
              user?.sui_address ? getSuiBalance(user.sui_address).catch(() => ({ mist: 0n })) : { mist: 0n },
              user?.starknet_address ? getStarknetBalance(user.starknet_address).catch(() => ({ strk: 0n })) : { strk: 0n },
            ]);

            if (strkBal.strk > 0n && suiBal.mist === 0n) {
              const result = await withdrawStarknetFunds(telegramId, dest, amt, 'strk');
              await ctx.reply(
                `✅ *Starknet Withdrawal Successful!*\n\n` +
                `💸 Amount: \`${result.amountWithdrawn} ${result.symbol}\`\n` +
                `📬 Destination: \`${result.destination}\`\n\n` +
                `🔗 Explorer: [View on Voyager](https://voyager.online/tx/${result.txHash})`,
                { parse_mode: 'Markdown' }
              );
            } else if (suiBal.mist > 0n && strkBal.strk === 0n) {
              const result = await withdrawSuiFunds(telegramId, dest, amt);
              await ctx.reply(
                `✅ *SUI Withdrawal Successful!*\n\n` +
                `💸 Amount: \`${result.amountWithdrawn} SUI\`\n` +
                `📬 Destination: \`${result.destination}\`\n\n` +
                `🔗 Explorer: [View on Suiscan](https://suiscan.xyz/mainnet/tx/${result.txHash})`,
                { parse_mode: 'Markdown' }
              );
            } else {
              await ctx.reply(
                `⚠️ Destination \`${dest}\` is a 0x hex address valid on both SUI and Starknet.\n` +
                `Please specify the token, e.g. \`${dest} ${amt} STRK\` or \`${dest} ${amt} SUI\``,
                { parse_mode: 'Markdown' }
              );
            }
          } else {
            const result = await withdrawFunds(telegramId, dest, amt);
            await ctx.reply(
              `✅ *Withdrawal Successful!*\n\n` +
              `💸 Amount: \`${result.amountWithdrawn} NEAR\`\n` +
              `📬 Destination: \`${result.destination}\`\n\n` +
              `🔗 Explorer: [View on NearBlocks](https://nearblocks.io/txns/${result.txHash})`,
              { parse_mode: 'Markdown' }
            );
          }
        } catch (err: any) {
          await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
        }
        return;
      }

      if (pending.action === 'import_token') {
        const tokenCA = rawText.trim();
        const user = await getUserByTelegramId(telegramId).catch(() => null);
        if (!user) {
          await ctx.reply('❌ User not found. Please run /start first.');
          return;
        }

        const validatingMsg = await ctx.reply(`🔍 *Validating Token:* \`${tokenCA}\`...`, { parse_mode: 'Markdown' }).catch(() => null);

        // Chain detection:
        const isSuiTok = isSuiToken(tokenCA);
        const isStarknetTok = isStarknetToken(tokenCA) || isValidStarknetAddress(tokenCA);

        if (isSuiTok) {
          if (!user.sui_address) {
            if (validatingMsg) await ctx.deleteMessage(validatingMsg.message_id).catch(() => {});
            await ctx.reply('❌ No SUI wallet found. Please run /wallet first.');
            return;
          }
          let metadata: any;
          try {
            metadata = await getSuiTokenMetadata(tokenCA);
          } catch (err: any) {
            if (validatingMsg) await ctx.deleteMessage(validatingMsg.message_id).catch(() => {});
            await ctx.reply(`❌ *Invalid SUI Token*\n\nCould not fetch metadata for \`${tokenCA}\`.`);
            return;
          }
          let balanceRes: any;
          try {
            balanceRes = await getSuiTokenBalance(user.sui_address, tokenCA);
          } catch (err: any) {
            if (validatingMsg) await ctx.deleteMessage(validatingMsg.message_id).catch(() => {});
            await ctx.reply(`❌ *Balance Check Failed*\n\nCould not query SUI balance for \`${tokenCA}\`.`);
            return;
          }
          if (balanceRes.raw <= 0n) {
            if (validatingMsg) await ctx.deleteMessage(validatingMsg.message_id).catch(() => {});
            await ctx.reply(`⚠️ *Zero Balance*\n\nYour SUI wallet has a balance of *0 ${metadata.symbol || 'tokens'}* on-chain.`);
            return;
          }
          let currentPrice = 0;
          try {
            const tokenInfo = await getTokenInfo(tokenCA);
            currentPrice = tokenInfo?.price ? parseFloat(tokenInfo.price) : 0;
          } catch {}
          const decimals = metadata.decimals ?? 9;
          const humanBal = (Number(balanceRes.raw) / Math.pow(10, decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 });

          const existingPositions = await getOpenPositions(user.id).catch(() => []);
          const existing = existingPositions.find(p => p.token_address === tokenCA && p.chain === 'sui');
          if (existing) {
            await updatePosition({
              position_id: existing.id,
              quantity_held: balanceRes.raw.toString(),
            });
            if (validatingMsg) await ctx.deleteMessage(validatingMsg.message_id).catch(() => {});
            await ctx.reply(
              `🔄 *Position Refreshed!*\n\n` +
              `Token: *${metadata.name} (${metadata.symbol})*\n` +
              `Address: \`${tokenCA}\`\n\n` +
              `Balance refreshed to: *${humanBal} ${metadata.symbol}*`,
              {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                  [Markup.button.callback('📊 View Holdings', 'menu_holdings')],
                  [Markup.button.callback('💳 Open Wallet', 'menu_wallet')],
                ]),
              }
            );
            return;
          }

          await createPosition({
            user_id: user.id,
            chain: 'sui',
            token_address: tokenCA,
            quantity_held: balanceRes.raw.toString(),
            avg_entry_price: currentPrice.toString(),
          });
          if (validatingMsg) await ctx.deleteMessage(validatingMsg.message_id).catch(() => {});
          await ctx.reply(
            `✅ *SUI Token Successfully Imported!*\n\n` +
            `Token: *${metadata.name} (${metadata.symbol})*\n` +
            `Address: \`${tokenCA}\`\n` +
            `Balance: *${humanBal} ${metadata.symbol}*\n\n` +
            `_Token is now tracked in your holdings._`,
            {
              parse_mode: 'Markdown',
              ...Markup.inlineKeyboard([
                [Markup.button.callback('📊 View Holdings', 'menu_holdings')],
                [Markup.button.callback('💳 Open Wallet', 'menu_wallet')],
              ]),
            }
          );
          return;
        }

        if (isStarknetTok) {
          if (!user.starknet_address) {
            if (validatingMsg) await ctx.deleteMessage(validatingMsg.message_id).catch(() => {});
            await ctx.reply('❌ No Starknet wallet found. Please run /wallet first.');
            return;
          }
          let metadata: any;
          try {
            metadata = await getStarknetTokenMetadata(tokenCA);
          } catch (err: any) {
            if (validatingMsg) await ctx.deleteMessage(validatingMsg.message_id).catch(() => {});
            await ctx.reply(`❌ *Invalid Starknet Token*\n\nCould not fetch metadata for \`${tokenCA}\`.`);
            return;
          }
          let balanceRaw = 0n;
          try {
            balanceRaw = await getStarknetTokenBalance(user.starknet_address, tokenCA);
          } catch (err: any) {
            if (validatingMsg) await ctx.deleteMessage(validatingMsg.message_id).catch(() => {});
            await ctx.reply(`❌ *Balance Check Failed*\n\nCould not query Starknet balance for \`${tokenCA}\`.`);
            return;
          }
          if (balanceRaw <= 0n) {
            if (validatingMsg) await ctx.deleteMessage(validatingMsg.message_id).catch(() => {});
            await ctx.reply(`⚠️ *Zero Balance*\n\nYour Starknet wallet has a balance of *0 ${metadata.symbol || 'tokens'}* on-chain.`);
            return;
          }
          let currentPrice = 0;
          try {
            const tokenInfo = await getTokenInfo(tokenCA);
            currentPrice = tokenInfo?.price ? parseFloat(tokenInfo.price) : 0;
          } catch {}
          const decimals = metadata.decimals ?? 18;
          const humanBal = (Number(balanceRaw) / Math.pow(10, decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 });

          const existingPositions = await getOpenPositions(user.id).catch(() => []);
          const existing = existingPositions.find(p => p.token_address === tokenCA && p.chain === 'starknet');
          if (existing) {
            await updatePosition({
              position_id: existing.id,
              quantity_held: balanceRaw.toString(),
            });
            if (validatingMsg) await ctx.deleteMessage(validatingMsg.message_id).catch(() => {});
            await ctx.reply(
              `🔄 *Position Refreshed!*\n\n` +
              `Token: *${metadata.name} (${metadata.symbol})*\n` +
              `Address: \`${tokenCA}\`\n\n` +
              `Balance refreshed to: *${humanBal} ${metadata.symbol}*`,
              {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                  [Markup.button.callback('📊 View Holdings', 'menu_holdings')],
                  [Markup.button.callback('💳 Open Wallet', 'menu_wallet')],
                ]),
              }
            );
            return;
          }

          await createPosition({
            user_id: user.id,
            chain: 'starknet',
            token_address: tokenCA,
            quantity_held: balanceRaw.toString(),
            avg_entry_price: currentPrice.toString(),
          });
          if (validatingMsg) await ctx.deleteMessage(validatingMsg.message_id).catch(() => {});
          await ctx.reply(
            `✅ *Starknet Token Successfully Imported!*\n\n` +
            `Token: *${metadata.name} (${metadata.symbol})*\n` +
            `Address: \`${tokenCA}\`\n` +
            `Balance: *${humanBal} ${metadata.symbol}*\n\n` +
            `_Token is now tracked in your holdings._`,
            {
              parse_mode: 'Markdown',
              ...Markup.inlineKeyboard([
                [Markup.button.callback('📊 View Holdings', 'menu_holdings')],
                [Markup.button.callback('💳 Open Wallet', 'menu_wallet')],
              ]),
            }
          );
          return;
        }

        const isSolTok = isSolanaToken(tokenCA) || isSolanaAddress(tokenCA);
        if (isSolTok) {
          const solUser = user.solana_address ? user : await ensureUserSolanaWallet(user).catch(() => user);
          if (!solUser.solana_address) {
            if (validatingMsg) await ctx.deleteMessage(validatingMsg.message_id).catch(() => {});
            await ctx.reply('❌ No Solana wallet found. Please run /wallet first.');
            return;
          }
          const info = await getSolanaTokenInfo(tokenCA).catch(() => null);
          const bal = await getSolanaTokenBalance(solUser.solana_address, tokenCA, true).catch(() => ({ raw: 0n, uiAmount: 0 }));
          if (bal.raw <= 0n) {
            if (validatingMsg) await ctx.deleteMessage(validatingMsg.message_id).catch(() => {});
            await ctx.reply(`⚠️ *Zero Balance*\n\nYour Solana wallet has a balance of *0 ${info?.symbol || 'tokens'}* on-chain.`);
            return;
          }
          const sym = info?.symbol || 'TOKEN';
          const name = info?.name || sym;
          const currentPrice = info?.priceSol || 0;
          const existingPositions = await getOpenPositions(user.id).catch(() => []);
          const existing = existingPositions.find(p => p.token_address === tokenCA && p.chain === 'solana');
          if (existing) {
            await updatePosition({ position_id: existing.id, quantity_held: bal.raw.toString() });
            if (validatingMsg) await ctx.deleteMessage(validatingMsg.message_id).catch(() => {});
            await ctx.reply(`🔄 *Position Refreshed!*\n\nToken: *${name} (${sym})*\nBalance: *${bal.uiAmount} ${sym}*`, {
              parse_mode: 'Markdown',
              ...Markup.inlineKeyboard([[Markup.button.callback('📊 View Holdings', 'menu_holdings')], [Markup.button.callback('💳 Open Wallet', 'menu_wallet')]]),
            });
            return;
          }
          await createPosition({
            user_id: user.id,
            chain: 'solana',
            token_address: tokenCA,
            quantity_held: bal.raw.toString(),
            avg_entry_price: currentPrice.toString(),
          });
          if (validatingMsg) await ctx.deleteMessage(validatingMsg.message_id).catch(() => {});
          await ctx.reply(`✅ *Solana Token Successfully Imported!*\n\nToken: *${name} (${sym})*\nBalance: *${bal.uiAmount} ${sym}*\n\n_Token is now tracked in your holdings._`, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('📊 View Holdings', 'menu_holdings')], [Markup.button.callback('💳 Open Wallet', 'menu_wallet')]]),
          });
          return;
        }

        const isEvmTok = (isValidEvmAddress(tokenCA) && !tokenCA.endsWith('.near')) || tokenCA.toLowerCase().endsWith('.elysium');
        if (isEvmTok) {
          const evmUser = user.evm_address ? user : await ensureUserEvmWallet(user).catch(() => user);
          if (!evmUser.evm_address) {
            if (validatingMsg) await ctx.deleteMessage(validatingMsg.message_id).catch(() => {});
            await ctx.reply('❌ No EVM wallet found. Please run /wallet first.');
            return;
          }
          const info = await getTokenInfo(tokenCA).catch(() => null);
          const evmChain: EvmChain = (tokenCA.toLowerCase().endsWith('.elysium') || info?.chain === 'elysium') ? 'elysium' : 'hyperevm';
          const sym = info?.symbol || 'TOKEN';
          const name = info?.name || sym;
          const currentPrice = info?.price ? parseFloat(info.price) : 0;
          const existingPositions = await getOpenPositions(user.id).catch(() => []);
          const existing = existingPositions.find(p => p.token_address.toLowerCase() === tokenCA.toLowerCase() && (p.chain === evmChain || p.chain === 'hyperevm' || p.chain === 'elysium'));
          if (existing) {
            if (validatingMsg) await ctx.deleteMessage(validatingMsg.message_id).catch(() => {});
            await ctx.reply(`🔄 *Position Already Tracked!*\n\nToken: *${name} (${sym})*\nChain: *${evmChain === 'elysium' ? 'Elysium' : 'HyperEVM'}*`, {
              parse_mode: 'Markdown',
              ...Markup.inlineKeyboard([[Markup.button.callback('📊 View Holdings', 'menu_holdings')], [Markup.button.callback('💳 Open Wallet', 'menu_wallet')]]),
            });
            return;
          }
          await createPosition({
            user_id: user.id,
            chain: evmChain,
            token_address: tokenCA,
            quantity_held: '0',
            avg_entry_price: currentPrice.toString(),
          });
          if (validatingMsg) await ctx.deleteMessage(validatingMsg.message_id).catch(() => {});
          await ctx.reply(`✅ *${evmChain === 'elysium' ? 'Elysium' : 'HyperEVM'} Token Imported!*\n\nToken: *${name} (${sym})*\nChain: *${evmChain === 'elysium' ? 'Elysium' : 'HyperEVM'}*\n\n_Token is now tracked in your holdings._`, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('📊 View Holdings', 'menu_holdings')], [Markup.button.callback('💳 Open Wallet', 'menu_wallet')]]),
          });
          return;
        }

        // ── NEAR NEP-141 Fallback ───────────────────────────────────────────
        let metadata: any;
        try {
          metadata = await near.getTokenMetadata(tokenCA);
          if (!metadata || !metadata.symbol) {
            throw new Error('Not a valid NEP-141 token contract');
          }
        } catch (err: any) {
          if (validatingMsg) await ctx.deleteMessage(validatingMsg.message_id).catch(() => {});
          await ctx.reply(
            `❌ *Invalid Token Contract*\n\n` +
            `Address \`${tokenCA}\` does not appear to be a valid token contract.\n\n` +
            `_Details: ${sanitizeMd(err.message || 'Metadata query failed')}_`,
            { parse_mode: 'Markdown' }
          );
          return;
        }

        let balanceRaw = '0';
        try {
          balanceRaw = await near.getTokenBalanceOnTradeRpc(tokenCA, user.subaccount_id);
        } catch (err: any) {
          if (validatingMsg) await ctx.deleteMessage(validatingMsg.message_id).catch(() => {});
          await ctx.reply(
            `❌ *Balance Check Failed*\n\nCould not query balance for \`${tokenCA}\`: ${sanitizeMd(err.message)}`,
            { parse_mode: 'Markdown' }
          );
          return;
        }

        const balanceBigInt = BigInt(balanceRaw || '0');
        if (balanceBigInt <= 0n) {
          if (validatingMsg) await ctx.deleteMessage(validatingMsg.message_id).catch(() => {});
          await ctx.reply(
            `⚠️ *Zero Balance*\n\n` +
            `Your wallet (\`${user.subaccount_id}\`) has a balance of *0 ${metadata.symbol}* on-chain.\n\n` +
            `Cannot import a position with zero tokens. Please fund your wallet first or buy through the bot.`,
            { parse_mode: 'Markdown' }
          );
          return;
        }

        let currentPrice = 0;
        let tokenInfo: any = null;
        try {
          tokenInfo = await getTokenInfo(tokenCA);
          currentPrice = tokenInfo?.price || 0;
        } catch {}

        const decimals = metadata.decimals ?? 18;
        const humanBalance = (Number(balanceBigInt) / Math.pow(10, decimals)).toLocaleString(undefined, {
          maximumFractionDigits: 4,
        });

        const existingPositions = await getOpenPositions(user.id).catch(() => []);
        const existing = existingPositions.find(p => p.token_address === tokenCA && (p.chain === 'near' || !p.chain));

        if (existing) {
          await updatePosition({
            position_id: existing.id,
            quantity_held: balanceRaw,
          });

          if (validatingMsg) await ctx.deleteMessage(validatingMsg.message_id).catch(() => {});
          await ctx.reply(
            `🔄 *Position Refreshed!*\n\n` +
            `Token: *${metadata.name} (${metadata.symbol})*\n` +
            `Address: \`${tokenCA}\`\n\n` +
            `You already had an active position for this token. Balance has been refreshed to:\n` +
            `💰 *Quantity Held:* \`${humanBalance} ${metadata.symbol}\`\n` +
            `📊 *Entry Price:* Unchanged at \`${existing.avg_entry_price} NEAR\``,
            {
              parse_mode: 'Markdown',
              ...Markup.inlineKeyboard([
                [Markup.button.callback('📊 View Holdings', 'menu_holdings')],
                [Markup.button.callback('💳 Open Wallet', 'menu_wallet')],
              ]),
            }
          );
          return;
        }

        await createPosition({
          user_id: user.id,
          chain: 'near',
          token_address: tokenCA,
          quantity_held: balanceRaw,
          avg_entry_price: currentPrice.toString(),
        });

        if (validatingMsg) await ctx.deleteMessage(validatingMsg.message_id).catch(() => {});
        await ctx.reply(
          `✅ *Token Successfully Imported!*\n\n` +
          `Token: *${metadata.name} (${metadata.symbol})*\n` +
          `Address: \`${tokenCA}\`\n` +
          `Balance: *${humanBalance} ${metadata.symbol}*\n` +
          `Entry Price: *${currentPrice.toFixed(6)} NEAR*\n\n` +
          `_ℹ️ Note: Tracking started at today's price (${currentPrice.toFixed(6)} NEAR) since the original purchase happened outside RacerBot._`,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('📊 View Holdings', 'menu_holdings')],
              [Markup.button.callback('💳 Open Wallet', 'menu_wallet')],
            ]),
          }
        );
        return;
      }

      if (pending.action === 'dca_token') {
        const trimmedCA = rawText.trim();
        // Solana mints are case-sensitive base58: never lowercase them.
        const isSolDca = isSolanaAddress(trimmedCA);
        const tokenCA = isSolDca ? trimmedCA : trimmedCA.toLowerCase();
        if (!isSolDca && !isValidNearAccountId(tokenCA)) {
          await ctx.reply('❌ Invalid contract address. Please enter a NEAR token address (e.g. `token.near`) or a Solana mint address.');
          return;
        }
        if (isSolDca) {
          const solInfo = await getSolanaTokenInfo(tokenCA).catch(() => null);
          if (!solInfo) {
            await ctx.reply('❌ Token not found on Solana. Check the mint address and try again.');
            return;
          }
        }
        userPendingActions.delete(telegramId);
        const dcaNative = isSolDca ? 'SOL' : 'NEAR';
        const dcaKey = getShortTokenKey(tokenCA);
        await ctx.reply(
          `🪙 *DCA Strategy for \`${tokenCA}\`*\n\n` +
          `Choose whether to accumulate (buy with ${dcaNative}) or take-profit / de-risk (sell to ${dcaNative}):`,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [cb(`🟢 Accumulate (Buy with ${dcaNative})`, `dca_choose_side:buy:${dcaKey}`, 'success')],
              [cb(`🔴 De-Risk (Sell to ${dcaNative})`, `dca_choose_side:sell:${dcaKey}`, 'danger')],
              [cb('🔙 Cancel', 'menu_dca', 'primary')],
            ]),
          }
        );
        return;
      }

      if (pending.action === 'private_deposit' || pending.action === 'private_withdraw' || pending.action === 'private_pool') {
        userPendingActions.delete(telegramId);
        const privUser = await getUserByTelegramId(telegramId).catch(() => null);
        if (!privUser) { await ctx.reply('❌ Run /start first.'); return; }
        await handlePrivatePrompt(ctx, privUser, pending.action, rawText);
        return;
      }

      if (pending.action === 'copy_wallet' && isSolanaAddress(rawText.trim())) {
        const wallet = rawText.trim();
        userPendingActions.delete(telegramId);
        await ctx.reply(
          `🎯 *Target Wallet (Solana)*: \`${wallet}\`\n\n` +
          `Choose how you would like to follow this wallet:\n\n` +
          `• *⚡ Auto-Copy*: Mirror its buys and sells on Solana (pump.fun, PumpSwap, Raydium, Meteora, Orca and more) with your SOL budget.\n` +
          `• *👀 Wallet Tracker*: Get alerts whenever this wallet trades, with 1-click buy buttons and no auto-buying.`,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [cb('⚡ Auto-Copy (Auto Buy/Sell)', copyModeData('copy', wallet, pending.copyReferrerId), 'success')],
              [cb('👀 Wallet Tracker (Alerts Only)', copyModeData('track', wallet, pending.copyReferrerId), 'primary')],
              [cb('🔙 Cancel', 'menu_copy', 'primary')],
            ]),
          }
        );
        return;
      }

      if (pending.action === 'copy_wallet') {
        const wallet = rawText.trim().toLowerCase();
        if (!isValidNearAccountId(wallet)) {
          await ctx.reply('❌ Invalid NEAR account ID. Please enter a valid wallet like `trader.near` or a 64-char hex address.', { parse_mode: 'Markdown' });
          return;
        }
        userPendingActions.delete(telegramId);
        await ctx.reply(
          `🎯 *Target Wallet*: \`${wallet}\`\n\n` +
          `Choose how you would like to follow this wallet:\n\n` +
          `• *⚡ Auto-Copy*: Mirror swaps automatically on DEXes with your configured NEAR budget.\n` +
          `• *👀 Wallet Tracker*: Get real-time alerts whenever this wallet trades, with 1-click manual buy/sell buttons without auto-buying.`,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [cb('⚡ Auto-Copy (Auto Buy/Sell)', copyModeData('copy', wallet, pending.copyReferrerId), 'success')],
              [cb('👀 Wallet Tracker (Alerts Only)', copyModeData('track', wallet, pending.copyReferrerId), 'primary')],
              [cb('🔙 Cancel', 'menu_copy', 'primary')],
            ]),
          }
        );
        return;
      }

      if (pending.action === 'copy_amount') {
        const amt = parseFloat(rawText);
        const copyUnit = snipeUnit(pending.copyWallet || '');
        const [minAmt, maxAmt] = copyUnit === 'SOL' ? [0.01, 1000] : [0.1, 10000];
        if (isNaN(amt) || amt < minAmt || amt > maxAmt) {
          await ctx.reply(`❌ Invalid amount. Must be between ${minAmt} and ${maxAmt.toLocaleString('en-US')} ${copyUnit}.`);
          return;
        }
        userPendingActions.set(telegramId, {
          action: 'copy_daily_budget',
          copyWallet: pending.copyWallet,
          copyBuyAmount: amt,
          copyReferrerId: pending.copyReferrerId,
          expiresAt: Date.now() + 5 * 60_000,
        });
        await ctx.reply(
          `✅ Buy amount: \`${amt} ${copyUnit}\` per trade\n\n🛡️ *Set a daily spending cap* (optional safety limit).\n\n` +
          `Reply with max ${copyUnit} per day (e.g. \`${copyUnit === 'SOL' ? '2' : '20'}\`), or \`skip\` for unlimited:`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      if (pending.action === 'copy_daily_budget') {
        const isSkip = rawText.trim().toLowerCase() === 'skip';
        const budget = isSkip ? null : parseFloat(rawText);
        const budgetUnit = snipeUnit(pending.copyWallet || '');
        if (!isSkip && (isNaN(budget!) || budget! < (budgetUnit === 'SOL' ? 0.01 : 0.1))) {
          await ctx.reply('❌ Invalid budget. Must be a positive number or "skip".');
          return;
        }
        const user = await getUserByTelegramId(telegramId).catch(() => null);
        if (!user) { await ctx.reply('❌ Run /start first.'); return; }
        const target = await createCopyTradeTarget({
          user_id: user.id,
          target_wallet: pending.copyWallet!,
          referrer_id: pending.copyReferrerId ?? null,
          buy_amount_near: pending.copyBuyAmount!,
          copy_sells: true,
          max_slippage_pct: 5.0,
          max_daily_budget_near: budget,
        });
        userPendingActions.delete(telegramId);
        await ctx.reply(
          `🏎️ *Copy Trade Setup Complete!*\n\n` +
          `🎯 *Target*: \`${target.target_wallet}\`\n` +
          `💰 *Buy Amount*: \`${target.buy_amount_near} ${budgetUnit}\` per trade\n` +
          `🛡️ *Daily Cap*: ${budget !== null ? `\`${budget} ${budgetUnit}\`` : 'Unlimited'}\n` +
          `📊 *Sell Mirroring*: ✅ On${budgetUnit === 'SOL' ? ' (same % the wallet sells)' : ''}\n\n` +
          `RacerBot will now automatically copy every swap this wallet makes on ${budgetUnit === 'SOL' ? 'Solana' : 'NEAR DEXes'}. You'll get a DM for every fill.\n\n` +
          `🏆 *Season 1*: You earn +25 pts per copy fill + 1.5 pts per NEAR copied!`,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[cb('👥 View Copy Targets', 'menu_copy', 'primary'), cb('🔙 Menu', 'menu_home', 'primary')]]),
          }
        );
        return;
      }

      if (pending.action === 'dca_amount') {
        const amt = parseFloat(rawText);
        if (isNaN(amt) || amt < 0.01) {
          await ctx.reply('❌ Invalid amount. Must be > 0.01.');
          return;
        }
        userPendingActions.set(telegramId, {
          action: 'dca_interval',
          dcaTokenAddress: pending.dcaTokenAddress,
          dcaSide: pending.dcaSide,
          dcaAmount: amt,
          expiresAt: Date.now() + 5 * 60_000,
        });
        const dcaNativeAmt = isSolanaToken(pending.dcaTokenAddress || '') ? 'SOL' : 'NEAR';
        await ctx.reply(
          `✅ Amount per order: \`${amt} ${pending.dcaSide === 'buy' ? dcaNativeAmt : 'tokens'}\`\n\n` +
          `⏱️ *Choose interval between orders:*`,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [cb('15 min', 'dca_int_900'), cb('30 min', 'dca_int_1800'), cb('1 hour', 'dca_int_3600')],
              [cb('4 hours', 'dca_int_14400'), cb('12 hours', 'dca_int_43200'), cb('24 hours', 'dca_int_86400')],
            ]),
          }
        );
        return;
      }

      if (pending.action === 'dca_orders') {
        const n = parseInt(rawText);
        if (isNaN(n) || n < 0) {
          await ctx.reply('❌ Invalid number. Enter a positive integer or 0 for unlimited.');
          return;
        }
        const user = await getUserByTelegramId(telegramId).catch(() => null);
        if (!user) { await ctx.reply('❌ Run /start first.'); return; }
        const order = await createDcaOrder({
          user_id: user.id,
          token_address: pending.dcaTokenAddress!,
          side: pending.dcaSide!,
          amount_per_order: pending.dcaAmount!,
          interval_seconds: pending.dcaInterval!,
          total_orders: n,
        });
        userPendingActions.delete(telegramId);
        const intervalHuman = formatDcaInterval(order.interval_seconds);
        const totalDisplay = order.total_orders === 0 ? '∞ (unlimited)' : `${order.total_orders} orders`;
        const dcaNativeDone = isSolanaToken(order.token_address) ? 'SOL' : 'NEAR';
        await ctx.reply(
          `🔁 *DCA Order Created!*\n\n` +
          `🪙 *Token*: \`${order.token_address}\`\n` +
          `📊 *Mode*: ${order.side === 'buy' ? `🟢 Accumulate (Buy with ${dcaNativeDone})` : `🔴 De-Risk (Sell to ${dcaNativeDone})`}\n` +
          `💵 *Amount per tick*: \`${order.amount_per_order} ${order.side === 'buy' ? dcaNativeDone : 'tokens'}\`\n` +
          `⏱️ *Interval*: ${intervalHuman}\n` +
          `🔢 *Total orders*: ${totalDisplay}\n` +
          `🕐 *First execution*: in ${intervalHuman}\n\n` +
          `You'll get a DM on every fill with progress. Manage orders in 🔁 DCA Orders.`,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[cb('🔁 View DCA Orders', 'menu_dca', 'primary'), cb('🔙 Menu', 'menu_home', 'primary')]]),
          }
        );
        return;
      }

      // ── Limit Order wizard: target value input ────────────────────────────
      if (pending.action === 'lo_target_value') {
        const cleanStr = rawText.replace(/[$,%]/g, '').trim();
        const val = parseFloat(cleanStr);
        const isPercent = pending.loConditionType === 'percent_change';
        if (isNaN(val) || (!isPercent && val <= 0) || (isPercent && val === 0)) {
          await ctx.reply('❌ Invalid value. Enter a valid positive number for price or market cap, or a percentage (e.g. `+50` or `-20`).');
          return;
        }
        userPendingActions.set(telegramId, {
          ...pending,
          action: 'lo_amount',
          loTargetValue: val,
          expiresAt: Date.now() + 5 * 60_000,
        });
        const condLabel = pending.loConditionType === 'price' ? 'Price' : pending.loConditionType === 'market_cap' ? 'Market Cap' : '% Change';
        const valDisplay = isPercent ? (val > 0 ? `+${val}%` : `${val}%`) : `${val}`;
        await ctx.reply(
          `✅ Target ${condLabel}: \`${valDisplay}\`\n\n` +
          `💰 *How much ${isSolanaToken(pending.loTokenAddress || '') ? 'SOL' : 'NEAR'} ${pending.loSide === 'buy' ? 'to spend' : 'worth of tokens to sell'}?*\n\n` +
          `Reply with a number (e.g. \`${isSolanaToken(pending.loTokenAddress || '') ? '0.5' : '5'}\`):`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // ── Limit Order wizard: amount input ─────────────────────────────────
      
      if (pending.action === 'deposit_custom_token') {
        const input = rawText.trim();
        userPendingActions.delete(telegramId);
        const chainId = pending.depositChainId || 'sol';
        const chainTokens = getTokensForChain(chainId);
        let matched = chainTokens.find((t: any) => 
          t.symbol.toLowerCase() === input.toLowerCase() ||
          (t.contractAddress && t.contractAddress.toLowerCase() === input.toLowerCase()) ||
          t.assetId.toLowerCase().includes(input.toLowerCase())
        );
        if (!matched) {
          matched = chainTokens[0];
        }
        const menu = buildDepositAmountPickerMenu(matched.key);
        await ctx.reply(menu.text, { parse_mode: 'HTML', ...menu.keyboard });
        return;
      }

      if (pending.action === 'deposit_custom_amount') {
        const amt = parseFloat(rawText);
        const tokenKey = pending.depositTokenKey || '0';
        const token = getTokenByKey(tokenKey);
        const minDeposit = token ? getMinimumDeposit(token) : { amount: 0.000001, formatted: '0.000001', example: '1.0' };

        if (isNaN(amt) || amt <= 0) {
          await ctx.reply('❌ Invalid amount. Please enter a valid positive number (e.g. 10 or 0.5).');
          return;
        }

        if (amt < minDeposit.amount) {
          await ctx.reply(
            `⚠️ <b>Deposit Amount Too Low</b>\n\n` +
            `The lowest deposit amount for <b>${token?.symbol || 'this token'}</b> on NEAR Intents is <b>${minDeposit.formatted}</b>.\n\n` +
            `Please reply with at least <code>${minDeposit.amount}</code> ${token?.symbol || ''} (or type /cancel to abort):`,
            { parse_mode: 'HTML' }
          );
          // Keep pending action active so user can immediately re-enter their amount!
          return;
        }

        userPendingActions.delete(telegramId);
        await renderDepositQuoteCard(ctx, telegramId, tokenKey, amt);
        return;
      }

      if (pending.action === 'lo_amount') {
        const amt = parseFloat(rawText);
        const loUnit = isSolanaToken(pending.loTokenAddress || '') ? 'SOL' : 'NEAR';
        if (isNaN(amt) || amt < 0.01) {
          await ctx.reply(`❌ Invalid amount. Must be ≥ 0.01 ${loUnit}.`);
          return;
        }
        userPendingActions.set(telegramId, {
          ...pending,
          loAmount: amt,
          expiresAt: Date.now() + 5 * 60_000,
        });
        const shortKey = getShortTokenKey(pending.loTokenAddress!);
        await ctx.reply(
          `✅ Amount: \`${amt} ${loUnit}\`\n\n` +
          `⏰ *When should this order expire?*`,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [cb('24 Hours', `lo_expiry:24h:${shortKey}`), cb('3 Days', `lo_expiry:3d:${shortKey}`), cb('7 Days', `lo_expiry:7d:${shortKey}`)],
              [cb('🔁 GTC (Never Expires)', `lo_expiry:gtc:${shortKey}`, 'success')],
              [cb('🔙 Cancel', 'menu_home', 'primary')],
            ]),
          }
        );
        return;
      }

      if (pending.action === 'fleet_custom_buy') {
        const amt = parseFloat(rawText);
        const fcUnit = snipeUnit(pending.fleetTokenAddress || '');
        if (isNaN(amt) || amt <= 0) {
          await ctx.reply(`❌ Invalid amount. Must be a positive number in ${fcUnit}.`);
          return;
        }
        userPendingActions.delete(telegramId);
        const user = await getUserByTelegramId(telegramId).catch(() => null);
        if (!user) { await ctx.reply('❌ Run /start first.'); return; }
        const fleet = await getRaceFleetByUserId(user.id);
        if (!fleet) { await ctx.reply('❌ No active RaceFleet found.'); return; }

        const tokenAddress = pending.fleetTokenAddress!;
        const statusMsg = await ctx.reply(`🏎️ Firing all ${fleet.wallet_count} fleet wallets together: \`${amt} ${fcUnit}\` each...`, { parse_mode: 'Markdown' });
        try {
          const res = await executeFleetBundleBuy(fleet.id, tokenAddress, amt, 3.0);
          if (res.success) {
            await ctx.reply(
              `✅ *RaceFleet Bundle Buy Successful!*\n\n` +
              `📦 Executed: \`${res.successCount}/${fleet.wallet_count} Wallets\`\n` +
              `💰 Total Spent: \`${res.totalSpentNear} ${fcUnit}\` (~${amt} ${fcUnit} / wallet)\n` +
              (res.failCount > 0 ? `⚠️ Failed: \`${res.failCount} wallets\` (Low balance/slippage)\n\n` : '\n') +
              `All wallets were signed first and broadcast at the same moment.`,
              {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                  [cb('🔴 Fleet SELL', `fleet_sell_prompt:${getShortTokenKey(tokenAddress)}`, 'danger'), cb('🏎️ Fleet Cockpit', `fleet_cockpit:${getShortTokenKey(tokenAddress)}`, 'success')],
                  [cb('🔙 Fleet Menu', 'racefleet_menu', 'primary')],
                ]),
              }
            );
          } else {
            await ctx.reply(`❌ Fleet buy failed: ${res.errors[0] || 'Unknown error'}`);
          }
        } catch (err: any) {
          await ctx.reply(`❌ Fleet execution failed: ${getUserFriendlyError(err)}`);
        }
        return;
      }

      if (pending.action === 'fleet_split_buy') {
        const totalBudget = parseFloat(rawText);
        const fsUnit = snipeUnit(pending.fleetTokenAddress || '');
        if (isNaN(totalBudget) || totalBudget <= 0) {
          await ctx.reply(`❌ Invalid budget. Must be a positive number in ${fsUnit}.`);
          return;
        }
        userPendingActions.delete(telegramId);
        const user = await getUserByTelegramId(telegramId).catch(() => null);
        if (!user) { await ctx.reply('❌ Run /start first.'); return; }
        const fleet = await getRaceFleetByUserId(user.id);
        if (!fleet) { await ctx.reply('❌ No active RaceFleet found.'); return; }

        const perWallet = parseFloat((totalBudget / fleet.wallet_count).toFixed(4));
        const tokenAddress = pending.fleetTokenAddress!;
        await ctx.reply(`🏎️ Splitting \`${totalBudget} ${fsUnit}\` (\`${perWallet} ${fsUnit}\` / wallet) across ${fleet.wallet_count} wallets...`, { parse_mode: 'Markdown' });
        try {
          const res = await executeFleetBundleBuy(fleet.id, tokenAddress, perWallet, 3.0);
          if (res.success) {
            await ctx.reply(
              `✅ *RaceFleet Split Buy Successful!*\n\n` +
              `📦 Executed: \`${res.successCount}/${fleet.wallet_count} Wallets\`\n` +
              `💰 Total Spent: \`${res.totalSpentNear} ${fsUnit}\` (\`${perWallet} ${fsUnit} / wallet\`)\n\n` +
              `Coordinated parallel execution confirmed.`,
              {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                  [cb('🏎️ Fleet Cockpit', `fleet_cockpit:${getShortTokenKey(tokenAddress)}`, 'success')],
                  [cb('🔙 Fleet Menu', 'racefleet_menu', 'primary')],
                ]),
              }
            );
          } else {
            await ctx.reply(`❌ Fleet buy failed: ${res.errors[0] || 'Unknown error'}`);
          }
        } catch (err: any) {
          await ctx.reply(`❌ Fleet execution failed: ${getUserFriendlyError(err)}`);
        }
        return;
      }

      if (pending.action === 'fleet_fund_amt') {
        const totalNear = parseFloat(rawText);
        if (isNaN(totalNear) || totalNear <= 0) {
          await ctx.reply('❌ Invalid amount. Must be a positive number in NEAR.');
          return;
        }
        userPendingActions.delete(telegramId);
        await ctx.reply(`⏳ Distributing \`${totalNear} NEAR\` equally across your fleet wallets...`, { parse_mode: 'Markdown' });
        try {
          const res = await distributeFundsToFleet(telegramId, totalNear);
          if (res.success) {
            await ctx.reply(
              `✅ *Fleet Funding Complete!*\n\n` +
              `💰 Distributed: \`${totalNear} NEAR\`\n` +
              `📦 Wallets Funded: \`${res.walletCount} wallets\` (\`${res.distributedPerWallet} N / wallet\`)\n\n` +
              `Your fleet is ready to trade.`,
              {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                  [cb('🏎️ Fleet Dashboard', 'racefleet_menu', 'success')],
                ]),
              }
            );
          } else {
            await ctx.reply(`❌ Failed to fund fleet: ${res.reason}`);
          }
        } catch (err: any) {
          await ctx.reply(`❌ Error funding fleet: ${getUserFriendlyError(err)}`);
        }
        return;
      }

      if (pending.action === 'fleet_sell_pct') {
        const pct = Math.floor(parseFloat(rawText.replace('%', '')));
        if (isNaN(pct) || pct < 1 || pct > 100) {
          await ctx.reply('❌ Reply with a whole percent from 1 to 100.');
          return;
        }
        userPendingActions.delete(telegramId);
        const user = await getUserByTelegramId(telegramId).catch(() => null);
        if (!user) { await ctx.reply('❌ Run /start first.'); return; }
        const fleet = await getRaceFleetByUserId(user.id);
        if (!fleet) { await ctx.reply('❌ No RaceFleet found.'); return; }
        const tokenAddress = pending.fleetTokenAddress!;
        const shortKey = getShortTokenKey(tokenAddress);
        const unit = snipeUnit(tokenAddress);
        const statusMsg = await ctx.reply(`🔴 Selling ${pct}% from every fleet wallet at the same moment...`).catch(() => null);
        try {
          const res = await executeFleetBundleSell(fleet.id, tokenAddress, pct, 3.0);
          if (statusMsg) await ctx.deleteMessage(statusMsg.message_id).catch(() => {});
          if (res.success) {
            await ctx.reply(
              `✅ *Fleet SELL Complete*\n\n` +
              `📊 Sold: \`${pct}%\` from \`${res.successCount}\` wallets at once\n` +
              (res.failCount > 0 ? `⚠️ Not filled: \`${res.failCount}\` (${sanitizeMd(res.errors[0] || '')})\n` : '') +
              `\nProceeds stay in each fleet wallet as ${unit}.`,
              {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                  [cb('📤 Sweep to Main Wallet', unit === 'SOL' ? 'fleet_sweep_sol' : 'fleet_sweep_prompt', 'primary')],
                  [cb('🏎️ Fleet Cockpit', `fleet_cockpit:${shortKey}`, 'success')],
                ]),
              }
            );
          } else {
            await ctx.reply(`❌ Fleet sell failed: ${res.errors[0] || 'No tokens available to sell'}`);
          }
        } catch (err: any) {
          if (statusMsg) await ctx.deleteMessage(statusMsg.message_id).catch(() => {});
          await ctx.reply(`❌ Fleet sell failed: ${getUserFriendlyError(err)}`);
        }
        return;
      }

      if (pending.action === 'fleet_fund_sol_amt') {
        const totalSol = parseFloat(rawText);
        if (isNaN(totalSol) || totalSol <= 0) {
          await ctx.reply('❌ Invalid amount. Must be a positive number in SOL.');
          return;
        }
        userPendingActions.delete(telegramId);
        await ctx.reply(`⏳ Distributing \`${totalSol} SOL\` equally across your Solana fleet wallets...`, { parse_mode: 'Markdown' });
        try {
          const res = await distributeSolToFleet(telegramId, totalSol);
          if (res.success) {
            await ctx.reply(
              `✅ *Solana Fleet Funded!*\n\n` +
              `💰 Per wallet: \`${res.perWalletSol?.toFixed(4)} SOL\`\n` +
              `📦 Wallets funded: \`${res.walletCount}\`${res.failed ? ` (⚠️ ${res.failed} failed)` : ''}\n\n` +
              `Open any Solana token and tap 🏎️ Fleet to bundle trade.`,
              { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[cb('🏎️ Fleet Dashboard', 'racefleet_menu', 'success')]]) }
            );
          } else {
            await ctx.reply(`❌ Failed to fund fleet: ${res.reason}`);
          }
        } catch (err: any) {
          await ctx.reply(`❌ Error funding fleet: ${getUserFriendlyError(err)}`);
        }
        return;
      }

      if (pending.action === 'fleet_lo_target_value') {
        const val = parseFloat(rawText);
        if (isNaN(val) || val <= 0) {
          await ctx.reply('❌ Invalid target value. Must be a positive number.');
          return;
        }
        userPendingActions.set(telegramId, {
          ...pending,
          action: 'fleet_lo_amount',
          fleetLoTargetValue: val,
          expiresAt: Date.now() + 5 * 60_000,
        });
        const condLabel = pending.fleetLoConditionType === 'price' ? 'Price' : 'Market Cap';
        const flUnit = snipeUnit(pending.fleetTokenAddress || '');
        await ctx.reply(
          `✅ Target ${condLabel}: \`${val}\`\n\n` +
          (pending.fleetSide === 'sell'
            ? `💰 *Sell size*: reply with any number to confirm (the whole fleet bag is sold when triggered):`
            : `💰 *How much ${flUnit} to spend per fleet wallet when triggered?*\n\n` +
              `Reply with a number (e.g. \`${flUnit === 'SOL' ? '0.1' : '1.5'}\` ${flUnit} per wallet):`),
          { parse_mode: 'Markdown' }
        );
        return;
      }

      if (pending.action === 'fleet_lo_amount') {
        const amt = parseFloat(rawText);
        const flAmtUnit = snipeUnit(pending.fleetTokenAddress || '');
        if (isNaN(amt) || amt < 0.01) {
          await ctx.reply(`❌ Invalid amount. Must be ≥ 0.01 ${flAmtUnit}.`);
          return;
        }
        const user = await getUserByTelegramId(telegramId).catch(() => null);
        if (!user) { await ctx.reply('❌ Run /start first.'); return; }
        const fleet = await getRaceFleetByUserId(user.id);
        if (!fleet) { await ctx.reply('❌ No active RaceFleet found.'); return; }

        userPendingActions.delete(telegramId);
        const tokenAddress = pending.fleetTokenAddress!;
        const side = pending.fleetSide || 'buy';
        const targetType = pending.fleetLoConditionType === 'market_cap' ? 'mcap' : 'price';
        const triggerCondition = side === 'buy' ? 'lte' : 'gte';

        try {
          const order = await createRaceFleetOrder({
            fleet_id: fleet.id,
            user_id: user.id,
            token_address: tokenAddress,
            order_type: side === 'buy' ? 'limit_buy' : 'limit_sell',
            amount_per_wallet: amt,
            target_type: targetType,
            trigger_condition: triggerCondition,
            target_value: pending.fleetLoTargetValue!,
            max_slippage_pct: 3.0,
          });

          await ctx.reply(
            `✅ *Fleet Limit Order Created!*\n\n` +
            `🪙 *Token*: \`${order.token_address}\`\n` +
            `🏎 *Fleet*: \`${fleet.fleet_tag}\` (${fleet.wallet_count} Wallets)\n` +
            `📊 *Direction*: ${order.order_type === 'limit_buy' ? '🟢 Buy Dip' : '🔴 Take Profit'}\n` +
            `📐 *Trigger*: ${targetType === 'mcap' ? 'Market Cap' : 'Price'} ${triggerCondition === 'lte' ? '≤' : '≥'} \`${order.target_value}\`\n` +
            `💰 *Amount*: \`${order.amount_per_wallet} ${flAmtUnit} / wallet\` (Total: \`${(order.amount_per_wallet * fleet.wallet_count).toFixed(flAmtUnit === 'SOL' ? 3 : 2)} ${flAmtUnit}\`)\n\n` +
            `When triggered, all ${fleet.wallet_count} wallets will execute simultaneously.`,
            {
              parse_mode: 'Markdown',
              ...Markup.inlineKeyboard([
                [cb('🏎️ Fleet Cockpit', `fleet_cockpit:${getShortTokenKey(tokenAddress)}`, 'success')],
                [cb('🔙 Fleet Menu', 'racefleet_menu', 'primary')],
              ]),
            }
          );
        } catch (err: any) {
          await ctx.reply(`❌ Failed to create fleet limit order: ${getUserFriendlyError(err)}`);
        }
        return;
      }
    }

    // 1.5. Implicit Withdrawal Format Detection (<destination> <amount|all>)
    const withdrawParts = rawText.trim().split(/\s+/);
    if (withdrawParts.length === 2) {
      const possibleDest = withdrawParts[0];
      const possibleAmtStr = withdrawParts[1].toLowerCase();
      const isSolDest = isSolanaAddress(possibleDest);
      const isNearDest = possibleDest.endsWith('.near') || (!isSolDest && isValidNearAccountId(possibleDest));
      const isSuiDest = isValidSuiAddress(possibleDest) && !possibleDest.endsWith('.near');
      const isStarknetDest = isValidStarknetAddress(possibleDest) && !possibleDest.endsWith('.near');
      const isAmtValid = possibleAmtStr === 'all' || (!isNaN(parseFloat(possibleAmtStr)) && parseFloat(possibleAmtStr) > 0);

      if ((isNearDest || isSuiDest || isStarknetDest || isSolDest) && isAmtValid) {
        const amt: number | 'all' = possibleAmtStr === 'all' ? 'all' : parseFloat(possibleAmtStr);
        await ctx.reply(`⏳ Processing withdrawal to \`${possibleDest}\`...`, { parse_mode: 'Markdown' });
        try {
          if (isSolDest) {
            const result = await withdrawSolanaFunds(telegramId, possibleDest, amt);
            await ctx.reply(
              `✅ *SOL Withdrawal Successful!*\n\n` +
              `💸 Amount: \`${result.amountWithdrawn} SOL\`\n` +
              `📬 Destination: \`${result.destination}\`\n\n` +
              `🔗 Explorer: [View on Solscan](https://solscan.io/tx/${result.txHash})`,
              { parse_mode: 'Markdown' }
            );
          } else if (isStarknetDest && !isNearDest) {
            const user = await getUserByTelegramId(telegramId);
            const [suiBal, strkBal] = await Promise.all([
              user?.sui_address ? getSuiBalance(user.sui_address).catch(() => ({ mist: 0n })) : { mist: 0n },
              user?.starknet_address ? getStarknetBalance(user.starknet_address).catch(() => ({ strk: 0n })) : { strk: 0n },
            ]);

            if (strkBal.strk > 0n && suiBal.mist === 0n) {
              const result = await withdrawStarknetFunds(telegramId, possibleDest, amt, 'strk');
              await ctx.reply(
                `✅ *Starknet Withdrawal Successful!*\n\n` +
                `💸 Amount: \`${result.amountWithdrawn} ${result.symbol}\`\n` +
                `📬 Destination: \`${result.destination}\`\n\n` +
                `🔗 Explorer: [View on Voyager](https://voyager.online/tx/${result.txHash})`,
                { parse_mode: 'Markdown' }
              );
            } else if (suiBal.mist > 0n && strkBal.strk === 0n) {
              const result = await withdrawSuiFunds(telegramId, possibleDest, amt);
              await ctx.reply(
                `✅ *SUI Withdrawal Successful!*\n\n` +
                `💸 Amount: \`${result.amountWithdrawn} SUI\`\n` +
                `📬 Destination: \`${result.destination}\`\n\n` +
                `🔗 Explorer: [View on Suiscan](https://suiscan.xyz/mainnet/tx/${result.txHash})`,
                { parse_mode: 'Markdown' }
              );
            } else {
              await ctx.reply(
                `⚠️ Destination \`${possibleDest}\` is a 0x hex address valid on both SUI and Starknet.\n` +
                `Please specify the token, e.g. \`/send ${possibleDest} ${amt} STRK\` or \`/send ${possibleDest} ${amt} SUI\``,
                { parse_mode: 'Markdown' }
              );
            }
          } else if (isSuiDest) {
            const result = await withdrawSuiFunds(telegramId, possibleDest, amt);
            await ctx.reply(
              `✅ *SUI Withdrawal Successful!*\n\n` +
              `💸 Amount: \`${result.amountWithdrawn} SUI\`\n` +
              `📬 Destination: \`${result.destination}\`\n\n` +
              `🔗 Explorer: [View on Suiscan](https://suiscan.xyz/mainnet/tx/${result.txHash})`,
              { parse_mode: 'Markdown' }
            );
          } else {
            const result = await withdrawFunds(telegramId, possibleDest, amt);
            await ctx.reply(
              `✅ *Withdrawal Successful!*\n\n` +
              `💸 Amount: \`${result.amountWithdrawn} NEAR\`\n` +
              `📬 Destination: \`${result.destination}\`\n\n` +
              `🔗 Explorer: [View on NearBlocks](https://nearblocks.io/txns/${result.txHash})`,
              { parse_mode: 'Markdown' }
            );
          }
        } catch (err: any) {
          await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
        }
        return;
      }
    }

    // 2a. Solana mint / launchpad link detection (pump.fun, Solscan, GMGN, Birdeye, Jupiter)
    {
      const found = extractSolanaCandidate(rawText);
      const solCandidate = found?.address || '';
      if (solCandidate && !isValidNearAccountId(solCandidate)) {
        const loadingMsg = await ctx.reply('🔍 Looking up Solana token...').catch(() => null);
        try {
          // Links from DexScreener, Photon, Axiom and similar carry the pool
          // address: turn it into the token mint first. Any other address that
          // is not a known token gets the same pool lookup as a fallback.
          let mint = solCandidate;
          if (found?.maybePair) mint = (await resolveSolanaPairToMint(solCandidate)) || solCandidate;
          let card;
          try {
            card = await withTimeout(buildTokenCard(mint, telegramId), 15000, 'The token lookup timed out — please try again');
          } catch (firstErr) {
            const fromPair = mint === solCandidate && !found?.maybePair ? await resolveSolanaPairToMint(solCandidate) : null;
            if (!fromPair) throw firstErr;
            card = await withTimeout(buildTokenCard(fromPair, telegramId), 15000, 'The token lookup timed out — please try again');
          }
          if (loadingMsg) await ctx.deleteMessage(loadingMsg.message_id).catch(() => {});
          await sendTokenCard(ctx, card);
        } catch (err: any) {
          if (loadingMsg) await ctx.deleteMessage(loadingMsg.message_id).catch(() => {});
          await ctx.reply(
            `❌ Solana token not found: ${sanitizeMd(solCandidate)}\n\n` +
            `This could mean:\n` +
            `• The address is a wallet, not a token mint\n` +
            `• The token was created seconds ago and is not indexed yet. Try again in a moment\n\n` +
            `Error: ${sanitizeMd(err?.message?.slice(0, 100) || 'Unknown error')}`
          ).catch(() => {});
        }
        return;
      }
    }

    // 2b. EVM / HyperEVM / Elysium Token & Link Detection
    {
      const evmCandidate = await extractEvmCandidate(rawText);
      if (evmCandidate && isValidEvmAddress(evmCandidate)) {
        const loadingMsg = await ctx.reply('🔍 Looking up HyperEVM token...').catch(() => null);
        try {
          const card = await withTimeout(buildTokenCard(evmCandidate, telegramId), 15000, 'The token lookup timed out — please try again');
          if (loadingMsg) await ctx.deleteMessage(loadingMsg.message_id).catch(() => {});
          prewarmTradePath(telegramId, evmCandidate).catch(() => {});
          await sendTokenCard(ctx, card);
          return;
        } catch (err: any) {
          if (loadingMsg) await ctx.deleteMessage(loadingMsg.message_id).catch(() => {});
          await ctx.reply(evmLookupFailureMessage(evmCandidate, err));
          return;
        }
      }
    }

    // 2. Direct Token Contract Address / SuiPump Link Detection
    const suiPumpMatch = /suipump\.org\/token\/(0x[0-9a-fA-F]{64})/i.exec(rawText);
    const suiTypeMatch = /(?:^|\s)(0x[0-9a-fA-F]{64}(?:::[w]+::[w]+)?)(?:\s|$)/.exec(rawText);
    const evmCaRegex = /(?:^|\s)(0x[0-9a-fA-F]{40})(?:\s|$)/i;
    const nearCaRegex = /(?:^|\s)([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*\.(?:near|tg|testnet))(?:\s|$)/i;
    const hex64Regex = /(?:^|\s)([0-9a-fA-F]{64})(?:\s|$)/;
    const caMatch = suiPumpMatch || suiTypeMatch || evmCaRegex.exec(rawText) || nearCaRegex.exec(rawText) || hex64Regex.exec(rawText);
    const potentialCA = caMatch ? (caMatch[1] || caMatch[0]).trim() : null;

    if (potentialCA) {
      ctx.sendChatAction('typing').catch(() => {});
      let card;
      try {
        card = await withTimeout(
          buildTokenCard(potentialCA.trim(), telegramId),
          10000,
          'The RPC request timed out — please try again'
        );
        prewarmTradePath(telegramId, potentialCA.trim()).catch(() => {});
        await sendTokenCard(ctx, card);
      } catch (err: any) {
        console.warn(`[API] Token lookup failed for ${potentialCA}:`, err?.message || err);
        await ctx.reply(
          `❌ Token not found: ${sanitizeMd(potentialCA)}\n\n` +
          `This could mean:\n` +
          `• The contract address or URL is incorrect\n` +
          `• The token is on an unsupported chain or venue\n` +
          `• The RPC request timed out — please try again\n\n` +
          `Error: ${sanitizeMd(err?.message?.slice(0, 100) || 'Unknown error')}`
        );
      }
      return;
    }

    // 3. Local token name fuzzy match
    const tokenEntry = localTokenNames.get(rawText.toLowerCase());
    if (tokenEntry) {
      try {
        const card = await buildTokenCard(tokenEntry.address, telegramId);
        prewarmTradePath(telegramId, tokenEntry.address).catch(() => {});
        await sendTokenCard(ctx, card);
        return;
      } catch { /* no-op */ }
    }

    // 4. Default helpful guide with Main Menu button
    const keyboard = Markup.inlineKeyboard([
      [
        cb('💳 Open Wallet', 'menu_wallet', 'primary'),
        cb('⚙️ Settings', 'menu_settings', 'primary'),
      ],
      [
        cb('🔙 Back', 'menu_home', 'primary'),
      ],
    ]);

    await ctx.reply(
      `💡 *Paste any Token CA or SuiPump link* directly into this chat to trade instantly.\n\n` +
      `Or use the menu below:`,
      { parse_mode: 'Markdown', ...keyboard }
    );
  });
}
