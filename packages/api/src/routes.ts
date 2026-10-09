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
  updateCopyTradeTargetStatus,
  // DCA Orders
  createDcaOrder,
  getDcaOrdersByUser,
  updateDcaOrderStatus,
  // Limit Orders
  createLimitOrder,
  getLimitOrdersByUser,
  cancelLimitOrder,
  getUserWallets,
  getActiveWallet,
  type UserRecord,
  type UserWalletRecord,
  type LimitOrderRecord,
  type PositionRecord,
} from '@racerbot/db';
import {
  getTokenInfo,
  getFastTokenRoute,
  publishSwap,
  onboardUser,
  rotateUserKey,
  getUserBalances,
  getTradeSpendableNear,
  getTradeSpendableSui,
  getRefStorageDepositNeeded,
  unwrapUserWrapNear,
  withdrawFunds,
  withdrawSuiFunds,
  withdrawTokenFunds,
  syncUserTokenDeposits,
  getNearUsdPrice,
  payReferralReward,
  prewarmStorageDeposit,
  isSuiToken,
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
  type TokenInfoResult,
} from './wallet.js';
import { sellAtTarget } from './sellHelper.js';
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
  getSuiUsdPrice,
  checkTokenSafety,
  restoreSuiKeypairFromSecret,
  isValidSuiAddress,
} from '@racerbot/shared';
export { getShortTokenKey, resolveTokenAddressFromKey };
import { inFlightKey, tryAcquireInFlight, releaseInFlight } from './inflight.js';
import { generatePNLCard } from './pnlCardGenerator.js';
import { generateTokenInfoCardImage } from './tokenInfoCardImageGenerator.js';
import { toTokenInfoCardData } from './tokenInfoCardData.js';
import { handleBuyBotCommand, handleTestAlertCommand, handleBuyAlertAction, handleBuyAlertMediaUpload, buildAlertSettingsCard, escapeHtml } from './buyAlerts.js';
import { utils as nearUtils } from 'near-api-js';
import crypto from 'crypto';
import { MASTER_KEY, RPC_PROVIDERS } from './config.js';

const near = getNear(RPC_PROVIDERS.length > 0 ? RPC_PROVIDERS : ['https://rpc.mainnet.fastnear.com']);

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
  action: 'buy_custom_near' | 'custom_slippage' | 'custom_auto_buy' | 'custom_min_liq' | 'custom_max_mcap' | 'withdraw' | 'import_token'
    | 'snipe_token_ca' | 'snipe_token_amount' | 'snipe_custom_time' | 'snipe_dev_addr' | 'snipe_dev_amount'
    | 'sell_custom_tokens'
    // Stop Loss & Take Profit custom input
    | 'set_sl_custom' | 'set_tp_custom'
    // Copy Trading wizard
    | 'copy_wallet' | 'copy_amount' | 'copy_daily_budget'
    // DCA wizard
    | 'dca_token' | 'dca_amount' | 'dca_interval' | 'dca_orders' | 'dca_price_guard'
    // Multi-Wallet Management
    | 'import_near_key' | 'import_near_name' | 'rename_near_wallet'
    | 'import_sui_key' | 'import_sui_name' | 'rename_sui_wallet'
    // Buy Alert group setup
    | 'set_group_token'
    // Limit Order wizard
    | 'lo_amount' | 'lo_target_value';
  tokenAddress?: string;
  positionId?: string;
  deployerAddress?: string;
  chatId?: string | number;
  chatTitle?: string;
  // Multi-wallet state
  importNearPrivateKey?: string;
  importNearAccountId?: string;
  renameWalletId?: string;
  importSuiPrivateKey?: string;
  renameSuiWalletId?: string;
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
export async function buildMainMenu(telegramId: number, forceRefresh = false) {
  const user = await getUserByTelegramId(telegramId).catch(() => null);
  let subaccount = 'Not initialized';
  let suiAddress = '';
  let nearBalFormatted = '0';
  let nearUsdFormatted = '$0';
  let suiBalFormatted = '0';
  let suiUsdFormatted = '$0';
  let totalUsdNum = 0;

  if (user) {
    subaccount = user.subaccount_id;
    try {
      const b = await getUserBalances(telegramId, forceRefresh);
      nearBalFormatted = b.totalNearFormatted;
      suiAddress = b.suiAddress || '';
      suiBalFormatted = b.suiBalanceFormatted || '0';

      const nearTotalUsdNum = parseFloat(b.totalNearFormatted || '0') * (b.nearUsd || 4.3);
      const suiTotalUsdNum = parseFloat(b.suiBalanceFormatted || '0') * (b.suiUsd || 2.0);
      totalUsdNum = nearTotalUsdNum + suiTotalUsdNum;

      nearUsdFormatted = nearTotalUsdNum >= 1000 ? `$${(nearTotalUsdNum / 1000).toFixed(2)}K` : `$${nearTotalUsdNum.toFixed(2)}`;
      suiUsdFormatted = suiTotalUsdNum >= 1000 ? `$${(suiTotalUsdNum / 1000).toFixed(2)}K` : `$${suiTotalUsdNum.toFixed(2)}`;
    } catch {
      nearBalFormatted = '0';
    }
  }

  const totalUsdStr = totalUsdNum >= 1000 ? `$${(totalUsdNum / 1000).toFixed(2)}K` : `$${totalUsdNum.toFixed(2)}`;

  const text =
    `<b>RacerBot #1 🏎 V2.0</b>\n` +
    `The Ultimate Fast Trading Partner\n\n` +
    `💼 <b>W1</b> ⭐\n\n` +
    `⬛ NEAR: <b>${nearBalFormatted}</b> Ⓝ (${nearUsdFormatted})\n` +
    `🔷 SUI: <b>${suiBalFormatted}</b> 💧 (${suiUsdFormatted})\n\n` +
    `Total: <b>${totalUsdStr}</b>\n\n` +
    `<u>NEAR</u>: <code>${subaccount}</code>\n` +
    (suiAddress ? `<u>SUI</u>: <code>${suiAddress}</code>` : '');

  const keyboard = Markup.inlineKeyboard([
    [
      cb('🎒 Your Bags', 'menu_holdings', 'primary'),
      cb('💳 Wallet', 'menu_wallet', 'primary'),
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
      cb('🏆 Points', 'menu_points', 'success'),
      cb('⚙️ Settings', 'menu_settings', 'primary'),
    ],
    [
      cb('📢 Buy Alerts', 'menu_buyalerts', 'success'),
    ],
    [
      cb('🔄 Refresh', 'menu_refresh', 'primary'),
    ],
    [
      cb('🔑 Export Key', 'export_prompt'),
      cb('🔄 Rotate Key', 'rotate_prompt'),
    ],
    [
      Markup.button.url('💬 Community', 'https://t.me/racerbot_community'),
      Markup.button.url('📢 Updates', 'https://t.me/racertrading'),
      Markup.button.url('𝕏 X', 'https://x.com/racertradingbot'),
    ],
  ]);

  return { text, keyboard };
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
    if (human >= 1_000_000) return `${(human / 1_000_000).toFixed(2)}M`;
    if (human >= 1_000) return human.toLocaleString('en-US', { maximumFractionDigits: 2 });
    if (human >= 1) return human.toFixed(2);
    if (human >= 0.0001) return human.toFixed(4);
    return human.toExponential(2);
  } catch {
    const num = parseFloat(quantityHeld);
    return isNaN(num) ? '0' : (num >= 1000 ? num.toLocaleString('en-US') : num.toFixed(4));
  }
}

// ── Helper: Build Wallet Menu ────────────────────────────────────────────────
export async function buildWalletMenu(telegramId: number, forceRefresh = false) {
  const b = await getUserBalances(telegramId, forceRefresh);
  const nearTotalUsdNum = parseFloat(b.totalNearFormatted || '0') * (b.nearUsd || 4.3);
  const suiTotalUsdNum = parseFloat(b.suiBalanceFormatted || '0') * (b.suiUsd || 2.0);
  const totalUsdNum = nearTotalUsdNum + suiTotalUsdNum;
  const totalUsdStr = totalUsdNum >= 1000 ? `$${(totalUsdNum / 1000).toFixed(2)}K` : `$${totalUsdNum.toFixed(2)}`;

  const user = await getUserByTelegramId(telegramId);
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
      cb('🔄 Refresh', 'wallet_refresh', 'primary'),
      cb('💸 Withdraw', 'wallet_withdraw_prompt', 'primary'),
    ],
  ];

  if (Number(b.wrapNearFormatted) > 0.0001) {
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
    cb('🔙 Menu', 'menu_home', 'primary'),
  ]);

  buttons.push([
    Markup.button.url('💬 Community', 'https://t.me/racerbot_community'),
    Markup.button.url('📢 Updates', 'https://t.me/racertrading'),
    Markup.button.url('𝕏 X', 'https://x.com/racertradingbot'),
  ]);

  const text =
    `<b>${walletDisplayName}</b> 💼 ⭐\n\n` +
    `⬛ NEAR: <b>${b.totalNearFormatted}</b> Ⓝ (${b.totalNearUsd})\n` +
    `• Native: ${b.nativeNearFormatted} Ⓝ | Wrapped: ${b.wrapNearFormatted} wNEAR\n\n` +
    `🔷 SUI: <b>${b.suiBalanceFormatted || '0.0000'}</b> 💧 (${b.suiBalanceUsd || '$0.00'})\n\n` +
    `Total: <b>${totalUsdStr}</b>\n\n` +
    `<u>NEAR</u>: <code>${b.subaccountId}</code>\n` +
    (b.suiAddress ? `<u>SUI</u>: <code>${b.suiAddress}</code>` : '');

  return { text, keyboard: Markup.inlineKeyboard(buttons) };
}

// ── Helper: Build Wallets Management Menu ────────────────────────────────────
export async function buildWalletsManagementMenu(telegramId: number) {
  const user = await getUserByTelegramId(telegramId);
  if (!user) throw new Error('User not found. Run /start first.');

  const [nearWallets, suiWallets] = await Promise.all([
    getUserWallets(user.id, 'near').catch(() => []),
    getUserWallets(user.id, 'sui').catch(() => []),
  ]);

  let text = `💼 <b>Multi-Chain Wallets</b>\n\n`;
  text += `Switch active wallet per chain,\nor import an existing private key:\n\n`;

  const buttons: any[] = [];

  // 1. NEAR Wallets Section
  text += `⬛ <b>NEAR Wallets</b>\n`;
  for (let i = 0; i < nearWallets.length; i++) {
    const w = nearWallets[i];
    const isActive = w.is_active;
    const statusIcon = isActive ? '🟢' : '⚪';
    const activeLabel = isActive ? ' <b>[Active]</b>' : '';
    const importedLabel = w.is_imported ? ' 📥' : '';

    text += `${i + 1}. ${statusIcon} <b>${w.name}</b>${importedLabel}${activeLabel}\n`;
    text += `   <code>${w.address}</code>\n\n`;

    const row: any[] = [];
    if (!isActive) {
      row.push(cb(`⚡ Use ${w.name}`, `wallet_switch:${w.id}`, 'primary'));
    }
    row.push(cb(`✏️ Rename`, `wallet_rename_prompt:${w.id}`, 'primary'));
    if (w.is_imported && !isActive) {
      row.push(cb(`🗑️ Delete`, `wallet_delete_confirm:${w.id}`, 'primary'));
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
    const activeLabel = isActive ? ' <b>[Active]</b>' : '';
    const importedLabel = w.is_imported ? ' 📥' : '';

    text += `${i + 1}. ${statusIcon} <b>${w.name}</b>${importedLabel}${activeLabel}\n`;
    text += `   <code>${w.address}</code>\n\n`;

    const row: any[] = [];
    if (!isActive) {
      row.push(cb(`⚡ Use ${w.name}`, `wallet_switch_sui:${w.id}`, 'primary'));
    }
    row.push(cb(`✏️ Rename`, `wallet_rename_sui_prompt:${w.id}`, 'primary'));
    if (w.is_imported && !isActive) {
      row.push(cb(`🗑️ Delete`, `wallet_delete_sui_confirm:${w.id}`, 'primary'));
    }
    if (row.length > 0) {
      buttons.push(row);
    }
  }

  // Import buttons row
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
    cb('🔙 Back to Wallet', 'wallet_refresh', 'primary'),
  ]);

  return { text, keyboard: Markup.inlineKeyboard(buttons) };
}

// ── Helper: Build Token Details Card with In-Chat Buttons ───────────────────
export async function buildTokenCard(tokenAddress: string, telegramId?: number, forceRefresh = false): Promise<{ text: string; keyboard: any; pnlCardImage?: Buffer }> {
  // Fetch token info, balance, user settings, and honeypot safety audit in parallel
  const [info, balances, user, safetyRes] = await Promise.allSettled([
    getTokenInfo(tokenAddress, forceRefresh),
    telegramId ? getUserBalances(telegramId).catch(() => null) : Promise.resolve(null),
    telegramId ? getUserByTelegramId(telegramId).catch(() => null) : Promise.resolve(null),
    checkTokenSafety(tokenAddress).catch(() => null),
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
      await onboardUser(telegramId);
      userRecord = await getUserByTelegramId(telegramId).catch(() => null);
    } catch (err: any) {
      console.warn('[buildTokenCard] Auto-onboard user failed:', err?.message);
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

  const isSui = tokenInfo.chain === 'sui' || tokenInfo.venue === 'suipump';
  const nativeUnit = isSui ? 'SUI' : 'NEAR';
  const unitBtn = isSui ? 'SUI' : 'N';

  const balanceText = isSui
    ? (b ? `💳 *SUI Wallet Balance*: \`${b.suiBalanceFormatted || '0.0000'} SUI\` (\`${b.suiBalanceUsd || '$0.00'}\`)\n\n` : '')
    : (b ? `💳 *Wallet Balance*: \`${b.nativeNearFormatted} NEAR\` | \`${b.wrapNearFormatted} wNEAR\`\n\n` : '');

  // -- Venue label --
  let venueText = `💧 *Venue*: Unknown`;
  if (tokenInfo.venue === 'suipump') {
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
  } else if (tokenInfo.tradeable) {
    venueText = `💧 *Venue*: NEAR Protocol DEX`;
  }

  const safeSymbol = sanitizeMd(tokenInfo.symbol || 'TOKEN');
  const safeName = sanitizeMd(tokenInfo.name || 'Token');

  // ── Deep links ───────────────────────────────────────────────────────────
  const linkRows = (() => {
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
  let priceNearStr = '0.00';
  if (priceNum > 0) {
    if (priceNum >= 1) priceNearStr = priceNum.toFixed(4);
    else if (priceNum >= 0.0001) priceNearStr = priceNum.toFixed(6);
    else if (priceNum >= 0.00000001) priceNearStr = priceNum.toFixed(8);
    else priceNearStr = priceNum.toExponential(4);
  }

  const priceUsdNum = parseFloat((tokenInfo as any).price_usd || '0');
  let priceUsdStr = '';
  if (priceUsdNum > 0) {
    if (priceUsdNum >= 1) priceUsdStr = '$' + priceUsdNum.toFixed(2);
    else if (priceUsdNum >= 0.0001) priceUsdStr = '$' + priceUsdNum.toFixed(6);
    else if (priceUsdNum >= 0.00000001) priceUsdStr = '$' + priceUsdNum.toFixed(8);
    else priceUsdStr = '$' + priceUsdNum.toExponential(4);
  }
  const priceStr = priceUsdStr ? `${priceNearStr} ${nativeUnit} (~${priceUsdStr})` : `${priceNearStr} ${nativeUnit}`;

  // -- Liquidity formatting --
  const liqNum = parseFloat(tokenInfo.liquidity || '0');
  let liqNearStr = '0.00';
  if (liqNum >= 1000) liqNearStr = `${(liqNum / 1000).toFixed(2)}K`;
  else if (liqNum > 0) liqNearStr = liqNum.toFixed(2);

  const liqUsdRaw = parseFloat((tokenInfo as any).liquidity_usd || '0');
  let liqUsdStr = '';
  if (liqUsdRaw >= 1_000_000) liqUsdStr = `~$${(liqUsdRaw / 1_000_000).toFixed(2)}M`;
  else if (liqUsdRaw >= 1_000) liqUsdStr = `~$${(liqUsdRaw / 1_000).toFixed(1)}K`;
  else if (liqUsdRaw > 0) liqUsdStr = `~$${liqUsdRaw.toFixed(0)}`;
  const liqStr = liqUsdStr ? `${liqNearStr} ${nativeUnit} (${liqUsdStr})` : `${liqNearStr} ${nativeUnit}`;

  // -- Market cap formatting --
  let mcapStr = 'N/A';
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

    mcapStr = mcNearFormatted ? `${mcUsdFormatted} (${mcNearFormatted})` : mcUsdFormatted;
  } else if (mcNearVal > 0) {
    if (mcNearVal >= 1_000_000) mcapStr = `${(mcNearVal / 1_000_000).toFixed(2)}M ${nativeUnit}`;
    else if (mcNearVal >= 1_000) mcapStr = `${(mcNearVal / 1_000).toFixed(2)}K ${nativeUnit}`;
    else mcapStr = `${mcNearVal.toFixed(2)} ${nativeUnit}`;
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
  const rateFooter = isSui
    ? (tokenInfo.sui_usd ? `\n_1 SUI ≈ $${tokenInfo.sui_usd.toFixed(2)} USD_\n` : '\n')
    : (nearUsdRate && nearUsdRate > 0 ? `\n_1 NEAR ≈ $${nearUsdRate.toFixed(2)} USD_\n` : '\n');

  let safetyBanner = '';
  if (safety?.isDrained) {
    safetyBanner =
      `> 🚨 *CRITICAL DRAINED POOL WARNING*\n` +
      `> 🔴 *Risk*: Liquidity Drained / Rugged\n` +
      `> • _${safety.reasons[0] || 'Pool liquidity has been pulled.'}_\n` +
      `> 🚫 *Buying is blocked by RacerBot to protect your wallet.*\n\n`;
  } else if (safety?.isHoneypot) {
    const dangerText = safety.reasons[0] || 'Unauthorized balance confiscation backdoor found.';
    safetyBanner =
      `> 🚨 *CRITICAL HONEYPOT WARNING*\n` +
      `> 🔴 *Risk*: Malicious Contract Detected\n` +
      `> • _${dangerText}_\n` +
      `> 🚫 *Buying is blocked by RacerBot to protect your wallet.*\n\n`;
  } else if (safety?.isUnlockedRheaPool) {
    safetyBanner =
      `> ⚠️ *HIGH RISK: UNLOCKED LIQUIDITY (RHEA AMM)*\n` +
      `> • *Launchpad*: ❌ None (Custom Standalone Token)\n` +
      `> • *Liquidity*: 🔴 100% Unlocked (Creator holds LP shares)\n` +
      `> • *Warning*: Creator can pull all pool NEAR at any second.\n\n`;
  } else if (safety) {
    const hpStatus = '🟢 PASSED';
    const contractType = safety.isAuditedLaunchpad
      ? `🛡️ Audited Launchpad (${safety.launchpadName || 'Verified'})`
      : 'Standalone NEP-141';

    let extraWarning = '';
    const liqUsd = parseFloat((tokenInfo as any).liquidity_usd || '0');
    if (liqUsd > 0 && liqUsd < 20) {
      extraWarning = `> • *Liquidity*: ⚠️ Ultra-low (~$${liqUsd.toFixed(2)} USD)\n`;
    }

    safetyBanner =
      `> 🛡️ *Security Analysis*:\n` +
      `> • *Honeypot*: ${hpStatus}\n` +
      `> • *Contract*: ${contractType}\n` +
      extraWarning +
      `\n`;
  }

  // Mobile-optimized compact stats block (smaller monospace font, perfectly aligned key-value pairs)
  const priceCol = priceNearStr ? `${priceNearStr} ${nativeUnit}` : '0.00';
  const usdCol = priceUsdStr ? ` (${priceUsdStr})` : '';
  const mcapCol = mcUsdFormatted ? mcUsdFormatted : (mcNearFormatted ? `${mcNearFormatted}` : 'N/A');
  const liqCol = `${liqNearStr} ${nativeUnit}${liqUsdStr ? ` (${liqUsdStr})` : ''}`;
  const supplyCol = `${supplyStr} (${tokenInfo.decimals} dec)`;

  let statsBlock = '```\n';
  statsBlock += `Price    : ${priceCol}${usdCol}\n`;
  if (tokenInfo.paired_symbol && tokenInfo.paired_symbol !== 'NEAR' && tokenInfo.paired_symbol !== 'wNEAR') {
    statsBlock += `Pair     : ${safeSymbol} / ${tokenInfo.paired_symbol}\n`;
  }
  statsBlock += `MarketCap: ${mcapCol}\n`;
  if (tokenInfo.paired_symbol && tokenInfo.paired_symbol !== 'NEAR' && tokenInfo.paired_symbol !== 'wNEAR' && tokenInfo.liquidity_in_paired) {
    statsBlock += `Liquidity: ${tokenInfo.liquidity_in_paired} ${tokenInfo.paired_symbol} (~${liqCol})\n`;
  } else {
    statsBlock += `Liquidity: ${liqCol}\n`;
  }
  statsBlock += `Supply   : ${supplyCol}\n`;
  const buyTax = tokenInfo.buy_tax_pct !== undefined ? `${tokenInfo.buy_tax_pct.toFixed(1)}%` : '0.3%';
  const sellTax = tokenInfo.sell_tax_pct !== undefined ? `${tokenInfo.sell_tax_pct.toFixed(1)}%` : '0.3%';
  statsBlock += `DEX Tax  : Buy ${buyTax} / Sell ${sellTax}\n`;
  if (tokenInfo.holders_count) {
    statsBlock += `Holders  : ${tokenInfo.holders_count.toLocaleString('en-US')}\n`;
  }
  const buys = tokenInfo.buys_count;
  const sells = tokenInfo.sells_count;
  const timeframe = (tokenInfo as any).trades_timeframe === 'Curve' ? 'Curve' : '24h';
  if (buys !== undefined && buys !== null && sells !== undefined && sells !== null) {
    statsBlock += `Trades   : ${buys}B / ${sells}S (${timeframe})\n`;
  } else if (buys !== undefined && buys !== null) {
    statsBlock += `Trades   : ${buys} buys (${timeframe})\n`;
  }
  if ((tokenInfo as any).total_txns) {
    statsBlock += `TotalTxn : ${Number((tokenInfo as any).total_txns).toLocaleString('en-US')}\n`;
  }
  statsBlock += '```\n';

  let text =
    safetyBanner +
    `🪙 *${safeName}* (\`${safeSymbol}\`)\n` +
    `📝 \`${tokenInfo.address}\`\n` +
    `${venueText}\n\n` +
    statsBlock +
    rateFooter +
    balanceText;

  let pnlCardImage: Buffer | null = null;

  // If user holds the token, add holdings info
  if (holdsToken && userPosition) {
    const entryPrice = parseFloat(userPosition.avg_entry_price) || 0;
    const pnlPct = priceNum > 0 && entryPrice > 0
      ? ((priceNum - entryPrice) / entryPrice * 100).toFixed(1)
      : 'N/A';
    const emoji = parseFloat(pnlPct) >= 0 ? '🟢' : '🔴';
    const pnlDisplay = pnlPct === 'N/A' ? 'N/A' : `${parseFloat(pnlPct) >= 0 ? '+' : ''}${pnlPct}%`;

    const formattedQty = formatHoldingQuantity(userPosition.quantity_held, tokenInfo.decimals);
    text += `💼 *Your Position*:\n` +
      '```\n' +
      `Holding  : ${formattedQty} ${safeSymbol}\n` +
      `Entry Px : ${entryPrice.toFixed(8)} ${nativeUnit}\n` +
      `PNL      : ${emoji} ${pnlDisplay}\n` +
      '```\n\n';

    try {
        const pnlCard = await generatePNLCard(userPosition.id);
        if (pnlCard.image) {
          pnlCardImage = pnlCard.image;
        } else {
          text += `${pnlCard.text}\n\n`;
        }
      } catch (err: any) {
        console.error('Failed to generate PNL card:', err);
      }
  }

  // ── Buttons ──
  let shareButtonRow: any[] = [];
  if (userRecord) {
    try {
      const shareCode = await getOrCreateTokenShare(userRecord.id, tokenAddress);
      const shareDeepLink = `https://t.me/racertradingbot?start=${shareCode}`;
      const sym = tokenInfo.symbol || 'TOKEN';
      const shareText = `Trade $${sym} on RacerBot 🏎\n⚡ Fast 1-click execution on NEAR & SUI`;
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
        ...linkRows,
        ...shareButtonRow,
        [
          cb('🔄 Refresh', `token_refresh:${shortKey}`, 'primary'),
          cb('🔙 Back', 'menu_home', 'primary'),
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
          cb('🔙 Back', 'menu_home', 'primary'),
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

    if (holdsToken && userPosition) {
      text += `⚡ *Manage Position* (Buy More or Sell):\n`;
      const defaultBuyPct = userRecord?.default_buy_pct ? Number(userRecord.default_buy_pct) : 10;
      keyboard = Markup.inlineKeyboard([
        ...unlockedRiskRow,
        // Quick-buy fixed amounts (green)
        [
          cb(`1 ${unitBtn}`, `buy_fixed:${shortKey}:1`, 'success'),
          cb(`5 ${unitBtn}`, `buy_fixed:${shortKey}:5`, 'success'),
          cb(`10 ${unitBtn}`, `buy_fixed:${shortKey}:10`, 'success'),
        ],
        // Custom amount
        [cb(`🟢 Buy X ${nativeUnit}`, `buy_custom_prompt:${shortKey}`, 'success')],
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
          ...(!isSui ? [cb('🔁 DCA Order', `dca_token:${shortKey}`, 'primary')] : []),
          ...(!isSui ? [cb('🎯 Limit Order', `lo_start:${shortKey}`, 'primary')] : []),
        ],
        [
          cb('🔄 Refresh', `token_refresh:${shortKey}`, 'primary'),
          cb('🔙 Back', 'menu_home', 'primary'),
        ],
        [
          Markup.button.url('💬 Community', 'https://t.me/racerbot_community'),
          Markup.button.url('📢 Updates', 'https://t.me/racertrading'),
          Markup.button.url('𝕏 X', 'https://x.com/racertradingbot'),
        ],
      ]);
    } else {
      text += `⚡ *Choose Buy Amount* (Fixed or % of Balance):\n`;
      const defaultBuyPct = userRecord?.default_buy_pct ? Number(userRecord.default_buy_pct) : 10;
      keyboard = Markup.inlineKeyboard([
        ...unlockedRiskRow,
        [
          cb(`1 ${unitBtn}`, `buy_fixed:${shortKey}:1`, 'success'),
          cb(`5 ${unitBtn}`, `buy_fixed:${shortKey}:5`, 'success'),
          cb(`10 ${unitBtn}`, `buy_fixed:${shortKey}:10`, 'success'),
        ],
        [cb(`🟢 Buy X ${nativeUnit}`, `buy_custom_prompt:${shortKey}`, 'success')],
        [
          cb(`${defaultBuyPct === 10 ? '✓ ' : ''}10%`, `buy_pct:${shortKey}:10`, 'success'),
          cb(`${defaultBuyPct === 50 ? '✓ ' : ''}50%`, `buy_pct:${shortKey}:50`, 'success'),
          cb(`${defaultBuyPct === 100 ? '✓ ' : ''}100%`, `buy_pct:${shortKey}:100`, 'success'),
        ],
        ...linkRows,
        ...shareButtonRow,
        [
          ...(!isSui ? [cb('🔁 DCA Order', `dca_token:${shortKey}`, 'primary')] : []),
          ...(!isSui ? [cb('🎯 Limit Order', `lo_start:${shortKey}`, 'primary')] : []),
        ],
        [
          cb('🔄 Refresh', `token_refresh:${shortKey}`, 'primary'),
          cb('🔙 Back', 'menu_home', 'primary'),
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
      text += `⏳ *Status*: Pool registered on ${tokenInfo.venue === 'intear' ? 'Intear Launchpad' : 'DEX'} — *Awaiting Initial Liquidity*.\n` +
        `🎯 *Set a Snipe to buy automatically the moment liquidity is added!*\n\n`;
      keyboard = Markup.inlineKeyboard([
        [cb('🎯 Snipe Token', `snipe_token_quick:${shortKey}`, 'success')],
        ...linkRows,
        ...shareButtonRow,
        [
          Markup.button.callback('🔄 Refresh', `token_refresh:${shortKey}`),
          Markup.button.callback('🔙 Back', 'menu_home'),
        ],
        [
          Markup.button.url('💬 Community', 'https://t.me/racerbot_community'),
          Markup.button.url('📢 Updates', 'https://t.me/racertrading'),
          Markup.button.url('𝕏 X', 'https://x.com/racertradingbot'),
        ],
      ]);
    } else {
      const venueNote = '⚠️ This token was detected but its trading venue is not supported. Paste the CA into a supported DEX.';
      text += venueNote;
      keyboard = Markup.inlineKeyboard([
        ...linkRows,
        ...shareButtonRow,
        [
          Markup.button.callback('🔄 Refresh', `token_refresh:${shortKey}`),
          Markup.button.callback('🔙 Back', 'menu_home'),
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
  const isSui = isSuiToken(tokenAddress) || tokenAddress.startsWith('0x');
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
    : (isSui
        ? '💧 *Sui Move Standard Coin*\n  • Native Sui coin with Move bytecode safety.'
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

  let liqVerdict = `💧 *Liquidity Depth*: \`${liqNear.toFixed(2)} ${isSui ? 'SUI' : 'NEAR'}\` (~$${liqUsd.toFixed(2)})`;
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
    `⛓️ *Chain*: ${isSui ? '💧 SUI' : '⬛ NEAR Protocol'}\n\n` +
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
        await ctx.reply(headerMsg, { parse_mode: 'Markdown' }).catch(() => {});
      }
      return;
    }

    const user = await getUserByTelegramId(ctx.from!.id).catch(() => null);
    const showNetWorth = showNetWorthOverride !== undefined
      ? showNetWorthOverride
      : (user ? user.show_net_worth_on_card !== false : true);

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
      await ctx.reply(fullText.replace(/[*_`]/g, ''), keyboard).catch(() => {});
    });
  } catch (err: any) {
    console.error('[PNL_CARD] Error sending PNL card message:', err);
    if (headerMsg) {
      await ctx.reply(headerMsg, { parse_mode: 'Markdown' }).catch(() => {});
    }
  }
}

// ── Helper: Build Settings Dashboard with Checkmark Indicators ──────────────
export function buildSettingsDashboard(user: UserRecord) {
  const slip = user.slippage_pct ? Number(user.slippage_pct) : 2.0;
  const buyPct = user.default_buy_pct ? Number(user.default_buy_pct) : 10;
  const sellPct = user.default_sell_pct ? Number(user.default_sell_pct) : 100;
  const showNetWorth = user.show_net_worth_on_card !== false;

  const text =
    `⚙️ *Trading Settings*\n\n` +
    `• *Slippage*: \`${slip}%\`\n` +
    `• *Default Buy*: \`${buyPct}%\`\n` +
    `• *Default Sell*: \`${sellPct}%\`\n` +
    `• *Net Worth on PnL*: ${showNetWorth ? '🟢 Shown' : '🔴 Hidden'}`;

  const keyboard = Markup.inlineKeyboard([
    [
      cb(
        showNetWorth ? '👁 Net Worth: Shown' : '🙈 Net Worth: Hidden',
        'set:toggle_show_net_worth',
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
      cb('✏️ Custom Slippage', 'prompt:custom_slippage', 'primary'),
    ],
    [
      cb('🔑 Export Private Key', 'export_prompt', 'primary'),
      cb('🔄 Rotate Key', 'rotate_prompt', 'primary'),
    ],
    [
      cb('🔙 Back to Main Menu', 'menu_home', 'primary'),
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
  const autoBuy = user.auto_buy_enabled;
  const autoAmt = user.auto_buy_amount_near ? Number(user.auto_buy_amount_near) : 1;
  const minLiq = user.auto_buy_min_liquidity_near ? Number(user.auto_buy_min_liquidity_near) : 0;
  const maxMcap = user.auto_buy_max_market_cap_usd != null ? Number(user.auto_buy_max_market_cap_usd) : 100000;
  const maxMcapStr = maxMcap > 0 ? (maxMcap >= 1000 ? `$${Math.round(maxMcap / 1000)}K` : `$${maxMcap}`) : 'No Limit';
  const activeOrders = await getSnipeOrdersByUser(user.id)
    .catch(() => [])
    .then((orders) => orders.filter((o) => o.status === 'active'));

  let activeText = '';
  if (activeOrders.length > 0) {
    activeText =
      `\n\n🎯 *Active Snipe Orders (${activeOrders.length})*:\n` +
      activeOrders
        .map((o) => {
          const target = o.snipe_type === 'token' ? `🪙 \`${o.token_address}\`` : `👤 \`${o.deployer_address}\``;
          const timing = o.execute_after && new Date(o.execute_after) > new Date()
            ? ` (⏰ ${formatUtcTime(new Date(o.execute_after))})`
            : '';
          return `• 🟢 ${target} — *${o.amount_near} NEAR*${timing}`;
        })
        .join('\n');
  }

  const text =
    `🎯 *Snipe Rules*\n\n` +
    `• *Auto-Buy Launches*: ${autoBuy ? '🟢 Enabled' : '🔴 Disabled'}\n` +
    `• *Auto-Buy Amount*: \`${autoAmt} NEAR\`\n` +
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

  const keyboard = Markup.inlineKeyboard([
    ...cancelButtons,
    [
      cb(
        autoBuy ? '🟢 Auto-Buy: ON' : '🔴 Auto-Buy: OFF',
        'set:toggle_auto_buy',
        autoBuy ? 'success' : 'danger'
      ),
    ],
    [
      cb('🎯 Snipe Token CA', 'snipe_token_start', 'success'),
      cb('👤 Snipe by Dev', 'snipe_dev_start', 'success'),
    ],
    [
      cb(`📋 My Snipe Orders (${activeOrders.length})`, 'snipe_orders', 'primary'),
    ],
    [
      cb(`Auto: ${autoAmt === 0.5 ? '✓ ' : ''}0.5N`, 'set:auto_amt:0.5', 'primary'),
      cb(`${autoAmt === 1 ? '✓ ' : ''}1N`, 'set:auto_amt:1', 'primary'),
      cb(`${autoAmt === 2 ? '✓ ' : ''}2N`, 'set:auto_amt:2', 'primary'),
      cb(`${autoAmt === 5 ? '✓ ' : ''}5N`, 'set:auto_amt:5', 'primary'),
    ],
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
      cb('✏️ Custom Auto-Buy', 'prompt:custom_auto_buy', 'primary'),
      cb('✏️ Custom Min Liq', 'prompt:custom_min_liq', 'primary'),
      cb('✏️ Custom Max Mcap', 'prompt:custom_max_mcap', 'primary'),
    ],
    [
      cb('🔙 Back to Main Menu', 'menu_home', 'primary'),
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

// ── Helper: Build Copy Trading Dashboard ─────────────────────────────────────
export async function buildCopyTradingDashboard(user: UserRecord) {
  const targets = await getCopyTradeTargetsByUser(user.id).catch(() => []);
  const activeTargets = targets.filter(t => t.status === 'active');
  const pausedTargets = targets.filter(t => t.status === 'paused');

  let text =
    `👥 *Copy Trading*\n\n` +
    `Mirror any wallet's trades in real-time.\n\n` +
    `• *Active*: ${activeTargets.length} | *Paused*: ${pausedTargets.length}\n\n`;

  if (targets.length === 0) {
    text +=
      `_No targets added yet._\n\n` +
      `Tap *➕ Add Target Wallet* to start.\n\n` +
      `🏆 *Season 1*: +25 pts per fill\n` +
      `+ 1.5 pts per NEAR volume copied!`;
  } else {
    text += `*Your Target Wallets:*\n`;
    for (const t of targets.slice(0, 10)) {
      const statusIcon = t.status === 'active' ? '🟢' : t.status === 'paused' ? '⏸️' : '⏹️';
      const budgetText = t.max_daily_budget_near ? ` | Cap: ${t.max_daily_budget_near}N/day` : '';
      text += `\n${statusIcon} \`${t.target_wallet}\`\n`;
      text += `   💰 ${t.buy_amount_near} NEAR per buy | Sells: ${t.copy_sells ? '✅' : '❌'}${budgetText}\n`;
    }
    if (targets.length > 10) {
      text += `\n_...and ${targets.length - 10} more targets_\n`;
    }
    text += `\n🏆 *Season 1*: +25 pts per fill + 1.5 pts per volume copied!`;
  }

  const buttons: any[] = [];
  buttons.push([cb('➕ Add Target Wallet', 'copy_add', 'success')]);

  for (const t of targets.slice(0, 5)) {
    const isPaused = t.status === 'paused';
    const shortWallet = t.target_wallet.length > 16 ? t.target_wallet.slice(0, 14) + '…' : t.target_wallet;
    buttons.push([
      cb(
        `${isPaused ? '▶️ Resume' : '⏸ Pause'} ${shortWallet}`,
        `copy_toggle:${t.id}`,
        isPaused ? 'success' : 'primary'
      ),
      cb('🗑 Stop', `copy_stop:${t.id}`, 'danger'),
      cb('📤 Share', `copy_share:${t.id}`, 'primary'),
    ]);
  }

  buttons.push([cb('🔄 Refresh', 'menu_copy', 'primary'), cb('🔙 Back to Main Menu', 'menu_home', 'primary')]);
  return { text, keyboard: Markup.inlineKeyboard(buttons) };
}

// ── Helper: Build DCA Dashboard ──────────────────────────────────────────────
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
      text += `   💵 ${o.amount_per_order} ${o.side === 'buy' ? 'NEAR' : 'tokens'} every ${formatDcaInterval(o.interval_seconds)} (${progressText})\n`;
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
function getUserFriendlyError(error: Error | string): string {
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
  if (r.includes("doesn't have enough balance") || r.includes('does not have enough balance') || r.includes('not enough balance'))
    return 'Insufficient NEAR balance — your wallet does not have enough NEAR. Please deposit more NEAR and retry.';
  if (r.includes('insufficient near for gas') || (r.includes('insufficient') && r.includes('gas')))
    return errorMsg.slice(0, 280);
  if (r.includes('minimum buy amount') || r.includes('minimum is 0.001'))
    return 'The amount is too small. Minimum is 0.001 NEAR.';
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
  if (r.includes('err_token') || r.includes('not_enough') || r.includes('drained') || (r.includes('wrap.near') && r.includes('enough')))
    return 'DEX pool has insufficient liquidity (pool is empty or drained). There is not enough wNEAR in the pool to complete your trade.';
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
async function executeBuyHelper(
  telegramId: number,
  rawTokenAddress: string,
  amountNear: number,
  onProgress?: (stage: string) => void
): Promise<{ success: boolean; amountNear: number; tokenAddress: string; message: string; positionId?: string; tokenName?: string; tokenSymbol?: string; tokenQty?: string; priceNear?: number; nearSpent?: number }> {
  const tokenAddress = resolveTokenAddressFromKey(rawTokenAddress);
  const user = await getUserByTelegramId(telegramId);
  if (!user) {
    throw new Error('Please run /start to set up your trading wallet first.');
  }

  if (amountNear < 0.001) {
    throw new Error('Minimum buy amount is 0.001 NEAR.');
  }

  const isSuiHint = isSuiToken(tokenAddress) || rawTokenAddress.includes('::');

  // Parallel pre-flight: resolve fast route, wallet balances, USD prices, and honeypot safety audit all in one parallel round-trip!
  const [info, nearBalRes, suiBalRes, nearUsdVal, suiUsdVal, safetyRes] = await Promise.all([
    getFastTokenRoute(tokenAddress).catch(() => null),
    !isSuiHint && user.subaccount_id
      ? Promise.all([
          near.getNearBalance(user.subaccount_id).catch(() => null),
          near.getTokenBalance('wrap.near', user.subaccount_id).catch(() => '0'),
        ])
      : Promise.resolve([null, '0'] as [string | null, string]),
    isSuiHint || user.sui_address
      ? getSuiBalance(user.sui_address || '').catch(() => ({ mist: 0n, formatted: '0' }))
      : Promise.resolve({ mist: 0n, formatted: '0' }),
    !isSuiHint ? getNearUsdPrice().catch(() => 0) : Promise.resolve(0),
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

  const amountInYocto = nearUtils.format.parseNearAmount(amountNear.toString()) ?? '0';
  const amountInBigInt = BigInt(amountInYocto);

  // Pre-flight balance check: verify wallet retains at least $2.00 in NEAR after swap
  const [nativeBalYoctoStr, wNearBalStr] = nearBalRes;

  if (nativeBalYoctoStr !== null && nativeBalYoctoStr !== undefined) {
    const nativeBal = BigInt(nativeBalYoctoStr);
    const wNearBal = BigInt(wNearBalStr || '0');
    const nearNeededForSwap = amountInBigInt > wNearBal ? amountInBigInt - wNearBal : 0n;

    const effectiveNearUsd = nearUsdVal > 0 ? nearUsdVal : 5.16;
    const minReserveNear = nearNeededForSwap > 0n ? 0.05 : 0.035;
    const minReserveYocto = BigInt(Math.ceil(minReserveNear * 1e24));
    const totalNearRequired = nearNeededForSwap + minReserveYocto;

    if (nativeBal < totalNearRequired) {
      const availNear = (Number(nativeBal) / 1e24).toFixed(4);
      const availUsd = (Number(nativeBal) / 1e24 * effectiveNearUsd).toFixed(2);
      const remainingNearYocto = nativeBal > nearNeededForSwap ? nativeBal - nearNeededForSwap : 0n;
      const remainingNear = (Number(remainingNearYocto) / 1e24).toFixed(4);
      const remainingUsd = (Number(remainingNearYocto) / 1e24 * effectiveNearUsd).toFixed(2);
      const requiredReserveNearStr = minReserveNear.toFixed(4);

      throw new Error(
        `Insufficient balance after swap. Your wallet must keep a minimal reserve of ${requiredReserveNearStr} NEAR (~$${(minReserveNear * effectiveNearUsd).toFixed(2)}) to cover gas and account storage. You have $${availUsd} (${availNear} NEAR), and would only have $${remainingUsd} (${remainingNear} NEAR) left after this swap. Please reduce your buy amount or deposit more NEAR.`
      );
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
    message:
      `✅ *Buy Confirmed!*\n\n` +
      `🪙 *${sanitizeMd(tokenName)}* (${sanitizeMd(tokenSym)})\n` +
      `📦 Received: \`${tokenQtyDisplay} ${sanitizeMd(tokenSym)}\`\n` +
      `💸 Spent: \`${amountNear.toFixed(4)} NEAR\`\n` +
      `💵 Entry: \`${priceDisplay}\`\n\n` +
      `📊 *Position*\n` +
      `💰 Value: \`${valueNear.toFixed(4)} NEAR\`\n` +
      `${pnlEmoji} PnL: \`${pnlDisplay}\``,
  };
}

// ── Core Helper: Execute Percentage Buy for User ─────────────────────────────
async function executeBuyPctHelper(telegramId: number, rawTokenAddress: string, pct: number, onProgress?: (stage: string) => void) {
  const tokenAddress = resolveTokenAddressFromKey(rawTokenAddress);
  const user = await getUserByTelegramId(telegramId);
  if (!user) throw new Error('Please run /start to set up your wallet first.');

  const info = await getTokenInfo(tokenAddress, false).catch(() => null);
  if (info?.chain === 'sui' || info?.venue === 'suipump' || isSuiToken(tokenAddress)) {
    const balanceSui = await getTradeSpendableSui(telegramId);
    const amountSui = (balanceSui * pct) / 100;
    if (amountSui < 0.01) {
      throw new Error(`Available balance (${balanceSui.toFixed(4)} SUI after gas reserve) is too low to buy.`);
    }
    return executeBuyHelper(telegramId, tokenAddress, Number(amountSui.toFixed(4)), onProgress);
  }

  const balanceNear = await getTradeSpendableNear(telegramId);
  const usableBalance = balanceNear;
  const amountNear = (usableBalance * pct) / 100;
  if (amountNear < 0.005) {
    throw new Error(`Available balance (${usableBalance.toFixed(4)} NEAR after gas/storage reserve) is too low to buy.`);
  }
  return executeBuyHelper(telegramId, tokenAddress, Number(amountNear.toFixed(4)), onProgress);
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
      const shareText = `Trade $${sym} on RacerBot 🏎\n⚡ Instant 1-click execution on NEAR DEXs`;
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


export function setupRoutes(bot: Telegraf): void {

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

      // ── Deep links: Token share (/start t_XXXX), Copy Trade (/start copy_wallet), or Quick Buy (/start buy_token_amount) ──
      let rawPayload = payload || '';
      let refCode: string | undefined = undefined;

      if (rawPayload.includes('_ref_')) {
        const parts = rawPayload.split('_ref_');
        rawPayload = parts[0];
        refCode = parts[1];
      } else if (rawPayload.startsWith('ref_')) {
        refCode = rawPayload.slice(4);
      }

      const isTokenShare = rawPayload.startsWith('t_');
      const isCopyShare = rawPayload.startsWith('copy_');
      const isBuyParam = rawPayload.startsWith('buy_');
      const isTokenParam = rawPayload.startsWith('token_') || rawPayload.startsWith('tkn_');
      const isBuyAlertCfg = rawPayload.startsWith('cfg_');
      const isGroupSetup = rawPayload.startsWith('setup_group_') || rawPayload.startsWith('setup_');
      const isSetMedia = rawPayload.startsWith('setmedia_') || rawPayload.startsWith('banner_');

      // For standard referral codes we pass the code to onboardUser; for token-share or copy-share
      // codes we pass undefined unless refCode was explicitly passed.
      const accountReferralCode = refCode || ((isTokenShare || isCopyShare || isBuyParam || isTokenParam || isBuyAlertCfg || isGroupSetup || isSetMedia) ? undefined : (rawPayload || undefined));

      const result = await onboardUser(telegramId, accountReferralCode, username);

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

      // 1. Quick Buy Deep Link (/start buy_token_near_1 or buy_token_near)
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

        const tokenAddress = decodeTelegramAccountId(tokenRaw);
        if (tokenAddress && isValidNearAccountId(tokenAddress)) {
          try {
            const card = await buildTokenCard(tokenAddress, telegramId);
            prewarmTradePath(telegramId, tokenAddress).catch(() => {});
            await sendTokenCard(ctx, card);

            if (quickBuyAmount) {
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

      // 2. Direct Token Details Deep Link (/start token_pearpe_tkn_near)
      if (isTokenParam && rawPayload) {
        const tokenRaw = rawPayload.startsWith('token_') ? rawPayload.slice(6) : rawPayload.slice(4);
        const tokenAddress = decodeTelegramAccountId(tokenRaw);
        if (tokenAddress && isValidNearAccountId(tokenAddress)) {
          try {
            const card = await buildTokenCard(tokenAddress, telegramId);
            prewarmTradePath(telegramId, tokenAddress).catch(() => {});
            await sendTokenCard(ctx, card);
            return;
          } catch (cardErr: any) {
            console.warn('[/start] Token lookup failed:', cardErr?.message);
          }
        }
      }

      // 3. Copy Trading Deep Link (/start copy_wallet_near)
      if (isCopyShare && rawPayload) {
        const rawTarget = rawPayload.slice(5);
        const targetWallet = decodeTelegramAccountId(rawTarget);

        if (targetWallet && isValidNearAccountId(targetWallet)) {
          userPendingActions.set(telegramId, {
            action: 'copy_amount',
            copyWallet: targetWallet,
            expiresAt: Date.now() + 5 * 60_000,
          });
          await ctx.reply(
            `👥 *Copy Trading Invitation*\n\n` +
            `You opened an invitation to mirror trades from:\n🎯 \`${targetWallet}\`\n\n` +
            `💰 *How much NEAR should I spend each time this wallet buys?*\n\n` +
            `Reply with a number (e.g. \`1\` or \`2.5\` NEAR per swap):`,
            {
              parse_mode: 'Markdown',
              ...Markup.inlineKeyboard([[cb('🔙 Cancel', 'menu_copy', 'primary')]]),
            }
          );
          return;
        }
      }

      // 4. Token Share Referral Code (/start t_XXXX)
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
            prewarmTradePath(telegramId, shareRecord.token_address).catch(() => {});
            await sendTokenCard(ctx, card);
          } catch (cardErr: any) {
            // Token may be invalid/delisted — fall through to main menu
            console.warn('[/start] Token share card failed:', cardErr?.message);
            const menu = await buildMainMenu(telegramId);
            await ctx.reply(
              `⚠️ This share link points to a token that is no longer available.\n\n` + menu.text,
              { parse_mode: 'Markdown', ...menu.keyboard }
            );
          }
          return;
        }
        // Unknown token share code — fall through to normal start
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

  // ── Main Menu Actions ─────────────────────────────────────────────────────
  bot.action('menu_home', async (ctx) => {
    const telegramId = ctx.from!.id;
    try {
      const menu = await buildMainMenu(telegramId, false);
      await ctx.answerCbQuery('Main Menu').catch(() => {});
      await ctx.editMessageText(menu.text, { parse_mode: 'HTML', ...menu.keyboard }).catch(async () => {
        await ctx.reply(menu.text, { parse_mode: 'HTML', ...menu.keyboard }).catch(() => {});
      });
    } catch {
      await ctx.answerCbQuery().catch(() => {});
    }
  });

  // ── Buy Alerts Panel ──────────────────────────────────────────────────────
  bot.action('menu_buyalerts', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
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
      [cb('🔙 Menu', 'menu_home', 'primary')],
    ]);

    await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(async () => {
      await ctx.reply(text, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
    });
  });

  bot.action(['menu_refresh', 'menu_home_refresh'], async (ctx) => {
    const telegramId = ctx.from!.id;
    await ctx.answerCbQuery('🔄 Refreshing balance...').catch(() => {});
    try {
      const menu = await buildMainMenu(telegramId, true);
      const canEdit = typeof (ctx as any).editMessageText === 'function';
      if (canEdit) {
        await (ctx as any).editMessageText(menu.text, { parse_mode: 'HTML', ...menu.keyboard }).catch(async (err: any) => {
          if (err?.message?.includes('message is not modified')) return;
          await ctx.reply(menu.text, { parse_mode: 'HTML', ...menu.keyboard }).catch(() => {});
        });
      } else {
        await ctx.reply(menu.text, { parse_mode: 'HTML', ...menu.keyboard }).catch(() => {});
      }
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => {});
    }
  });

  bot.action('menu_wallet', async (ctx) => {
    const telegramId = ctx.from!.id;
    try {
      const wallet = await buildWalletMenu(telegramId);
      await ctx.answerCbQuery().catch(() => {});
      await ctx.editMessageText(wallet.text, { parse_mode: 'HTML', ...wallet.keyboard }).catch(() => {});
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => {});
    }
  });

  bot.action('menu_settings', async (ctx) => {
    const telegramId = ctx.from!.id;
    try {
      const user = await getUserByTelegramId(telegramId);
      if (!user) {
        await ctx.answerCbQuery('Please run /start first.').catch(() => {});
        return;
      }
      const dash = buildSettingsDashboard(user);
      await ctx.answerCbQuery().catch(() => {});
      await ctx.editMessageText(dash.text, { parse_mode: 'Markdown', ...dash.keyboard }).catch(() => {});
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => {});
    }
  });

  bot.action('menu_snipe', async (ctx) => {
    const telegramId = ctx.from!.id;
    try {
      const user = await getUserByTelegramId(telegramId);
      if (!user) {
        await ctx.answerCbQuery('Please run /start first.').catch(() => {});
        return;
      }
      const dash = await buildSnipeDashboard(user);
      await ctx.answerCbQuery().catch(() => {});
      await ctx.editMessageText(dash.text, { parse_mode: 'Markdown', ...dash.keyboard }).catch(() => {});
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => {});
    }
  });

  // ── Copy Trading Actions ──────────────────────────────────────────────────

  bot.action('menu_copy', async (ctx) => {
    const telegramId = ctx.from!.id;
    try {
      const user = await getUserByTelegramId(telegramId);
      if (!user) {
        await ctx.answerCbQuery('Please run /start first.').catch(() => {});
        return;
      }
      const dash = await buildCopyTradingDashboard(user);
      await ctx.answerCbQuery().catch(() => {});
      await ctx.editMessageText(dash.text, { parse_mode: 'Markdown', ...dash.keyboard }).catch(async () => {
        await ctx.reply(dash.text, { parse_mode: 'Markdown', ...dash.keyboard }).catch(() => {});
      });
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => {});
    }
  });

  bot.action('copy_add', async (ctx) => {
    const telegramId = ctx.from!.id;
    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) {
      await ctx.answerCbQuery('Please run /start first.').catch(() => {});
      return;
    }
    userPendingActions.set(telegramId, {
      action: 'copy_wallet',
      expiresAt: Date.now() + 5 * 60_000,
    });
    await ctx.answerCbQuery().catch(() => {});
    await ctx.reply(
      `👥 *Add Copy Trading Target*\n\n` +
      `Enter the NEAR wallet address to copy:\n` +
      `_e.g. \`trader.near\` or a 64-char hex_\n\n` +
      `RacerBot will mirror all buys/sells\n` +
      `from this wallet on Rhea, Ref & Shards.`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[cb('🔙 Cancel', 'menu_copy', 'primary')]]),
      }
    );
  });

  bot.action(/^copy_toggle:(.+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const targetId = (ctx as any).match[1];
    try {
      const user = await getUserByTelegramId(telegramId);
      if (!user) { await ctx.answerCbQuery('Run /start first.').catch(() => {}); return; }
      const targets = await getCopyTradeTargetsByUser(user.id);
      const target = targets.find(t => t.id === targetId);
      if (!target) { await ctx.answerCbQuery('Target not found.').catch(() => {}); return; }
      const nextStatus = target.status === 'paused' ? 'active' : 'paused';
      await updateCopyTradeTargetStatus(targetId, nextStatus);
      await ctx.answerCbQuery(`Target ${nextStatus === 'active' ? 'resumed' : 'paused'}`).catch(() => {});
      const dash = await buildCopyTradingDashboard(user);
      await ctx.editMessageText(dash.text, { parse_mode: 'Markdown', ...dash.keyboard }).catch(() => {});
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => {});
    }
  });

  bot.action(/^copy_stop:(.+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const targetId = (ctx as any).match[1];
    try {
      const user = await getUserByTelegramId(telegramId);
      if (!user) { await ctx.answerCbQuery('Run /start first.').catch(() => {}); return; }
      await updateCopyTradeTargetStatus(targetId, 'stopped');
      await ctx.answerCbQuery('Target stopped').catch(() => {});
      const dash = await buildCopyTradingDashboard(user);
      await ctx.editMessageText(dash.text, { parse_mode: 'Markdown', ...dash.keyboard }).catch(() => {});
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => {});
    }
  });

  bot.action(/^copy_share:(.+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const targetId = (ctx as any).match[1];
    try {
      const user = await getUserByTelegramId(telegramId);
      if (!user) { await ctx.answerCbQuery('Run /start first.').catch(() => {}); return; }
      const targets = await getCopyTradeTargetsByUser(user.id);
      const target = targets.find(t => t.id === targetId);
      if (!target) { await ctx.answerCbQuery('Target not found.').catch(() => {}); return; }
      const shareDeepLink = `https://t.me/racertradingbot?start=copy_${target.target_wallet}_${user.id}`;
      const shareText = `Copy trades from ${target.target_wallet} on RacerBot 🏎\n⚡ Automated instant execution on NEAR & SUI`;
      const tgShareUrl = `https://t.me/share/url?url=${encodeURIComponent(shareDeepLink)}&text=${encodeURIComponent(shareText)}`;
      await ctx.answerCbQuery().catch(() => {});
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
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => {});
    }
  });

  // ── DCA Orders Actions ────────────────────────────────────────────────────

  bot.action('menu_dca', async (ctx) => {
    const telegramId = ctx.from!.id;
    try {
      const user = await getUserByTelegramId(telegramId);
      if (!user) {
        await ctx.answerCbQuery('Please run /start first.').catch(() => {});
        return;
      }
      const dash = await buildDcaDashboard(user);
      await ctx.answerCbQuery().catch(() => {});
      await ctx.editMessageText(dash.text, { parse_mode: 'Markdown', ...dash.keyboard }).catch(async () => {
        await ctx.reply(dash.text, { parse_mode: 'Markdown', ...dash.keyboard }).catch(() => {});
      });
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
    }
  });

  bot.action('dca_start', async (ctx) => {
    const telegramId = ctx.from!.id;
    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) {
      await ctx.answerCbQuery('Please run /start first.').catch(() => {});
      return;
    }
    userPendingActions.set(telegramId, {
      action: 'dca_token',
      expiresAt: Date.now() + 5 * 60_000,
    });
    await ctx.answerCbQuery().catch(() => {});
    await ctx.reply(
      `🔁 *DCA Order Setup (Step 1/3)*\n\n` +
      `Enter the token Contract Address (CA):\n` +
      `_e.g. \`wrap.near\` or \`token.near\`_`,
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
    await ctx.answerCbQuery().catch(() => {});
    await ctx.reply(
      `🪙 *DCA Strategy for \`${tokenCA}\`*\n\n` +
      `Choose a direction:`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [cb('🟢 Accumulate (Buy with NEAR)', `dca_choose_side:buy:${shortKey}`, 'success')],
          [cb('🔴 De-Risk (Sell to NEAR)', `dca_choose_side:sell:${shortKey}`, 'danger')],
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
    await ctx.answerCbQuery().catch(() => {});
    const promptMsg = side === 'buy'
      ? `💰 *How much NEAR should be spent on each order?*\n\nReply with a number (e.g. \`1\` or \`5\`):`
      : `💰 *How many tokens should be sold on each order?*\n\nReply with raw token quantity (e.g. \`1000\`):`;
    await ctx.reply(promptMsg, { parse_mode: 'Markdown' });
  });

  bot.action(/^dca_int_(\d+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const intervalSecs = parseInt((ctx as any).match[1], 10);
    const pending = userPendingActions.get(telegramId);
    if (!pending || pending.action !== 'dca_interval') {
      await ctx.answerCbQuery('Session expired. Please restart DCA setup.').catch(() => {});
      return;
    }
    userPendingActions.set(telegramId, {
      ...pending,
      action: 'dca_orders',
      dcaInterval: intervalSecs,
      expiresAt: Date.now() + 5 * 60_000,
    });
    await ctx.answerCbQuery(`Interval: ${formatDcaInterval(intervalSecs)}`).catch(() => {});
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
      if (!user) { await ctx.answerCbQuery('Run /start first.').catch(() => {}); return; }
      const orders = await getDcaOrdersByUser(user.id);
      const order = orders.find(o => o.id === orderId);
      if (!order) { await ctx.answerCbQuery('Order not found.').catch(() => {}); return; }
      const nextStatus = order.status === 'paused' ? 'active' : 'paused';
      await updateDcaOrderStatus(orderId, nextStatus);
      await ctx.answerCbQuery(`DCA order ${nextStatus === 'active' ? 'resumed' : 'paused'}`).catch(() => {});
      const dash = await buildDcaDashboard(user);
      await ctx.editMessageText(dash.text, { parse_mode: 'Markdown', ...dash.keyboard }).catch(() => {});
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => {});
    }
  });

  bot.action(/^dca_del:(.+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const orderId = (ctx as any).match[1];
    try {
      const user = await getUserByTelegramId(telegramId);
      if (!user) { await ctx.answerCbQuery('Run /start first.').catch(() => {}); return; }
      await updateDcaOrderStatus(orderId, 'cancelled');
      await ctx.answerCbQuery('DCA order cancelled').catch(() => {});
      const dash = await buildDcaDashboard(user);
      await ctx.editMessageText(dash.text, { parse_mode: 'Markdown', ...dash.keyboard }).catch(() => {});
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => {});
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
    return `${side} • ${token}\n` +
      `  Condition: ${cond} ${dir} ${o.target_value}\n` +
      `  Amount: ${o.amount_input} NEAR • Expires: ${expiry}\n` +
      `  Status: ${o.status}`;
  }

  // Step 1: entry point from the token card button
  bot.action(/^lo_start:(.+)$/, async (ctx) => {
    const rawKey = (ctx as any).match[1];
    const tokenCA = resolveTokenAddressFromKey(rawKey);
    const shortKey = getShortTokenKey(tokenCA);
    await ctx.answerCbQuery().catch(() => {});
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
    await ctx.answerCbQuery().catch(() => {});
    await ctx.reply(
      `✅ Direction: ${side === 'buy' ? '🟢 Buy' : '🔴 Sell'}\n\n` +
      `📐 *Choose the trigger condition:*`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [cb('💲 Price (NEAR per token)', `lo_cond:price:${shortKey}`, 'primary')],
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
      await ctx.answerCbQuery('Session expired. Start again.').catch(() => {});
      return;
    }
    userPendingActions.set(telegramId, {
      ...pending,
      loConditionType: condType,
      expiresAt: Date.now() + 5 * 60_000,
    });
    await ctx.answerCbQuery().catch(() => {});

    const dip = pending.loSide === 'buy' ? 'drops to' : 'rises to';
    const condLabels: Record<string, string> = {
      price: 'Reply with the *price in NEAR* per token.\n_e.g._ `0.0005` _means trigger when price ' + dip + ' 0.0005 NEAR_',
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
      await ctx.answerCbQuery('Session expired. Start again.').catch(() => {});
      return;
    }
    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) { await ctx.answerCbQuery('Run /start first.').catch(() => {}); return; }

    const expiryDurations: Record<string, number | null> = {
      '24h': 24 * 60 * 60 * 1000,
      '3d': 3 * 24 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000,
      'gtc': null,
    };
    const durationMs = expiryDurations[expiryKey];
    const expiresAt = durationMs !== null ? new Date(Date.now() + durationMs) : null;

    // Determine condition direction from side + condition type
    let triggerCondition: 'lte' | 'gte' = 'lte';
    if (pending.loSide === 'sell') triggerCondition = 'gte';
    if (pending.loConditionType === 'percent_change') {
      triggerCondition = pending.loTargetValue! < 0 ? 'lte' : 'gte';
    }

    const targetType: 'mcap' | 'price' | 'percent_offset' =
      pending.loConditionType === 'market_cap' ? 'mcap' :
      pending.loConditionType === 'percent_change' ? 'percent_offset' : 'price';

    try {
      await ctx.answerCbQuery('Creating limit order...').catch(() => {});
      const order = await createLimitOrder({
        user_id: user.id,
        token_address: pending.loTokenAddress!,
        chain: 'near',
        side: pending.loSide!,
        target_type: targetType,
        trigger_condition: triggerCondition,
        target_value: pending.loTargetValue!,
        amount_input: pending.loAmount!,
        expires_at: expiresAt,
      });
      userPendingActions.delete(telegramId);

      const expiryLabel = expiryKey === 'gtc' ? '🔁 GTC (Never expires)' : `${expiryKey === '24h' ? '24 Hours' : expiryKey === '3d' ? '3 Days' : '7 Days'}`;
      const condLabel = order.target_type === 'price' ? 'Price' : order.target_type === 'mcap' ? 'Market Cap' : '% Offset';
      const dirLabel = order.trigger_condition === 'lte' ? '≤' : '≥';

      await ctx.reply(
        `✅ *Limit Order Created!*\n\n` +
        `🪙 *Token*: \`${order.token_address}\`\n` +
        `📊 *Direction*: ${order.side === 'buy' ? '🟢 Buy' : '🔴 Sell'}\n` +
        `📐 *Trigger*: ${condLabel} ${dirLabel} \`${order.target_value}\`\n` +
        `💰 *Amount*: \`${order.amount_input} NEAR\`\n` +
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
      await ctx.answerCbQuery('').catch(() => {});
      await ctx.reply(`❌ Failed to create limit order: ${getUserFriendlyError(err)}`);
    }
  });

  // List active limit orders for a token (or all if no shortKey context)
  async function renderUserLimitOrders(ctx: any, telegramId: number) {
    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) {
      if (typeof ctx.answerCbQuery === 'function') await ctx.answerCbQuery('Run /start first.').catch(() => {});
      else await ctx.reply('Run /start first.').catch(() => {});
      return;
    }
    if (typeof ctx.answerCbQuery === 'function') await ctx.answerCbQuery().catch(() => {});

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
      text += `${i + 1}. ${side} \`${token}\`\n   ${cond} ${dir} \`${o.target_value}\` • \`${o.amount_input} NEAR\` • ${expiry}\n\n`;
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
    if (!user) { await ctx.answerCbQuery('Run /start first.').catch(() => {}); return; }
    try {
      await cancelLimitOrder(orderId, user.id);
      await ctx.answerCbQuery('✅ Limit order cancelled.').catch(() => {});
      const orders = await getLimitOrdersByUser(user.id).catch(() => [] as LimitOrderRecord[]);
      const active = orders.filter(o => o.status === 'active');
      if (active.length === 0) {
        await ctx.editMessageText('📋 *Your Limit Orders*\n\nNo active limit orders.', {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[cb('🔙 Back', 'menu_home', 'primary')]]).reply_markup,
        } as any).catch(() => {});
      } else {
        await ctx.answerCbQuery('Order cancelled — refresh list.').catch(() => {});
      }
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => {});
    }
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
      await ctx.reply('Use /start to set up your wallet first.').catch(() => {});
      return;
    }
    const activeCount = await countActiveSnipeOrders(user.id).catch(() => 0);
    if (activeCount >= MAX_ACTIVE_SNIPE_ORDERS_PER_USER) {
      await ctx.reply(`❌ You already have ${MAX_ACTIVE_SNIPE_ORDERS_PER_USER} active snipe orders. Cancel one in 🎯 Snipe Rules → 📋 My Snipe Orders.`).catch(() => {});
      return;
    }

    const order = await createSnipeOrder({
      user_id: user.id,
      snipe_type: 'token',
      token_address: tokenAddress,
      amount_near: amt,
      execute_after: executeAfter,
    });

    if (user) {
      prewarmStorageDeposit(user, tokenAddress).catch(() => {});
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
        `💰 Amount: \`${amt} NEAR\`\n` +
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
      ).catch(() => {});
      return;
    }

    // Standard immediate snipe:
    const info = await getTokenInfo(tokenAddress, false).catch(() => null);
    if (info?.tradeable) {
      const triggerId = await recordSnipeTrigger(order.id, tokenAddress, info.venue ?? '').catch(() => null);
      const procMsg = await ctx.reply(
        `⏳ *Snipe Executing...*\n\n\`${tokenAddress}\` is live — buying with \`${amt} NEAR\` now...`,
        { parse_mode: 'Markdown' }
      ).catch(() => null);
      const onStage = makeStageEditor(ctx, procMsg, 'Snipe Executing');
      try {
        const res = await executeBuyHelper(telegramId, tokenAddress, amt, onStage);
        if (procMsg) await ctx.deleteMessage(procMsg.message_id).catch(() => {});
        if (triggerId) await markSnipeTriggerFilled(triggerId, null).catch(() => {});
        await markSnipeOrderResult(order.id, true).catch(() => {});
        await ctx.reply(res.message, {
          parse_mode: 'Markdown',
          reply_markup: await buildBuySuccessKeyboard(telegramId, tokenAddress, res.tokenSymbol, res.positionId),
        }).catch(() => {});
        if (res.positionId) {
          await sendPostBuySlTpPrompt(ctx, res.positionId, tokenAddress, res.tokenSymbol).catch(() => {});
        }
      } catch (err: any) {
        if (procMsg) await ctx.deleteMessage(procMsg.message_id).catch(() => {});
        if (triggerId) await markSnipeTriggerFailed(triggerId, err?.message ?? 'buy_failed').catch(() => {});
        const msg = err?.message ?? '';
        const isAwaitingLiq = /no liquidity|not yet tradable|reserves.*positive|bonding phase/i.test(msg);
        if (isAwaitingLiq) {
          await ctx.reply(
            `🎯 *Snipe Armed!*\n\n` +
            `🪙 Token: \`${tokenAddress}\`\n` +
            `💰 Amount: \`${amt} NEAR\`\n\n` +
            `Pool is registered but awaiting liquidity — your snipe order is armed and will fire automatically the instant liquidity appears!`,
            { parse_mode: 'Markdown' }
          ).catch(() => {});
        } else {
          await markSnipeOrderResult(order.id, false, err?.message ?? 'buy_failed').catch(() => {});
          await ctx.reply(`❌ Snipe failed: ${getUserFriendlyError(err)}`).catch(() => {});
        }
      }
    } else {
      await ctx.reply(
        `🎯 *Snipe Armed!*\n\n` +
        `🪙 Token: \`${tokenAddress}\`\n` +
        `💰 Amount: \`${amt} NEAR\`\n\n` +
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
      ).catch(() => {});
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
      await ctx.answerCbQuery('Session expired. Please start over.').catch(() => {});
      return;
    }
    await ctx.answerCbQuery().catch(() => {});
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
      await ctx.answerCbQuery('Session expired. Please start over.').catch(() => {});
      return;
    }
    await ctx.answerCbQuery().catch(() => {});
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
      await ctx.answerCbQuery('Session expired. Please start over.').catch(() => {});
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
    await ctx.answerCbQuery().catch(() => {});
    const currentUtc = formatUtcTime();
    await ctx.reply(
      `🕒 *Enter Scheduled Time (UTC)*\n\n` +
      `🪙 Token: \`${tokenAddress}\`\n` +
      `💰 Amount: \`${finalAmt} NEAR\`\n` +
      `Current Time: \`${currentUtc}\`\n\n` +
      `Reply with the exact time in UTC when you want the snipe to trigger.\n\n` +
      `*Accepted formats:*\n` +
      `• \`19:23\` or \`7:23 PM\` (today in UTC)\n` +
      `• \`+10m\` or \`15 mins\` (delay from now)\n` +
      `• \`2026-10-08 19:23\` (specific UTC date & time)\n\n` +
      `Type /cancel to abort.`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  });

  bot.action('snipe_time:cancel', async (ctx) => {
    const telegramId = ctx.from!.id;
    userPendingActions.delete(telegramId);
    snipeSetupCache.delete(telegramId);
    await ctx.answerCbQuery('Cancelled.').catch(() => {});
    await ctx.editMessageText('❌ Snipe order setup cancelled.').catch(async () => {
      await ctx.reply('❌ Snipe order setup cancelled.').catch(() => {});
    });
  });

  bot.action('snipe_token_start', async (ctx) => {
    const telegramId = ctx.from!.id;
    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) {
      await ctx.answerCbQuery('Please run /start first.').catch(() => {});
      return;
    }
    const activeCount = await countActiveSnipeOrders(user.id).catch(() => 0);
    if (activeCount >= MAX_ACTIVE_SNIPE_ORDERS_PER_USER) {
      await ctx.answerCbQuery(`Max ${MAX_ACTIVE_SNIPE_ORDERS_PER_USER} active snipe orders — cancel one first.`).catch(() => {});
      return;
    }
    userPendingActions.set(telegramId, { action: 'snipe_token_ca', expiresAt: Date.now() + 120_000 });
    await ctx.answerCbQuery().catch(() => {});
    await ctx.reply(
      `🎯 *Snipe by Token CA*\n\n` +
      `Reply with the token contract address:\n` +
      `_e.g. \`token.nearlytrade.near\`_\n\n` +
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
      await ctx.answerCbQuery('Please run /start first.').catch(() => {});
      return;
    }
    const activeCount = await countActiveSnipeOrders(user.id).catch(() => 0);
    if (activeCount >= MAX_ACTIVE_SNIPE_ORDERS_PER_USER) {
      await ctx.answerCbQuery(`Max ${MAX_ACTIVE_SNIPE_ORDERS_PER_USER} active snipe orders — cancel one first.`).catch(() => {});
      return;
    }
    userPendingActions.set(telegramId, { action: 'snipe_token_amount', tokenAddress, expiresAt: Date.now() + 120_000 });
    await ctx.answerCbQuery().catch(() => {});
    const meta = await near.getTokenMetadata(tokenAddress).catch(() => null);
    const sym = meta?.symbol || tokenAddress;
    await ctx.reply(
      `🎯 *Snipe ${sanitizeMd(sym)}*\n\n` +
      `Contract: \`${tokenAddress}\`\n\n` +
      `Reply with the amount in NEAR to snipe (e.g. \`2.5\`):\n` +
      `Type /cancel to abort.`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.action('snipe_dev_start', async (ctx) => {
    const telegramId = ctx.from!.id;
    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) {
      await ctx.answerCbQuery('Please run /start first.').catch(() => {});
      return;
    }
    const activeCount = await countActiveSnipeOrders(user.id).catch(() => 0);
    if (activeCount >= MAX_ACTIVE_SNIPE_ORDERS_PER_USER) {
      await ctx.answerCbQuery(`Max ${MAX_ACTIVE_SNIPE_ORDERS_PER_USER} active snipe orders — cancel one first.`).catch(() => {});
      return;
    }
    userPendingActions.set(telegramId, { action: 'snipe_dev_addr', expiresAt: Date.now() + 120_000 });
    await ctx.answerCbQuery().catch(() => {});
    await ctx.reply(
      `👤 *Snipe by Deployer*\n\n` +
      `Reply with the dev's NEAR wallet address:\n` +
      `_e.g. \`someuser.near\`_\n\n` +
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
      await ctx.answerCbQuery('Please run /start first.').catch(() => {});
      return;
    }
    const orders = await getSnipeOrdersByUser(user.id).catch(() => []);
    await ctx.answerCbQuery().catch(() => {});
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
      return `${statusEmoji[o.status] ?? '•'} ${target} — *${o.amount_near} NEAR*${timing}${extra}${err}`;
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
      await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }).catch(() => {});
    });
  });

  bot.action(/^snipe_order_view:(.+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const orderId = ctx.match![1];
    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) {
      await ctx.answerCbQuery('Please run /start first.').catch(() => {});
      return;
    }
    const o = await getSnipeOrderById(orderId, user.id).catch(() => null);
    await ctx.answerCbQuery().catch(() => {});
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

    const text =
      `🎯 *Snipe Order Details*\n\n` +
      `• *Status*: ${statusText[o.status] ?? o.status}\n` +
      `• *${targetLabel}*: \`${targetVal}\`\n` +
      `• *Amount*: \`${o.amount_near} NEAR\`\n` +
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
      await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }).catch(() => {});
    });
  });

  bot.action(/^snipe_order_cancel:(.+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const orderId = ctx.match![1];
    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) {
      await ctx.answerCbQuery('Please run /start first.').catch(() => {});
      return;
    }
    const ok = await cancelSnipeOrder(orderId, user.id).catch(() => false);
    await ctx.answerCbQuery(ok ? 'Snipe order cancelled.' : 'Order not found or already closed.').catch(() => {});
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
        }).catch(() => {});
      });
    }
  });

  bot.action(/^snipe_order_delete:(.+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const orderId = ctx.match![1];
    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) {
      await ctx.answerCbQuery('Please run /start first.').catch(() => {});
      return;
    }
    const ok = await deleteSnipeOrder(orderId, user.id).catch(() => false);
    await ctx.answerCbQuery(ok ? 'Order removed.' : 'Order not found.').catch(() => {});
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
        }).catch(() => {});
      });
    }
  });

  bot.action(['menu_points', 'menu_points_refresh'], async (ctx) => {
    const telegramId = ctx.from!.id;
    try {
      const view = await buildPointsView(telegramId);
      await ctx.answerCbQuery().catch(() => {});
      await ctx.editMessageText(view.text, { parse_mode: 'Markdown', ...view.keyboard }).catch(async () => {
        await ctx.reply(view.text, { parse_mode: 'Markdown', ...view.keyboard }).catch(() => {});
      });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => {});
    }
  });

  // ── Helper: Build Holdings view (text + keyboard) ─────────────────────────
  // forceRefresh=false renders from cache (instant paint); forceRefresh=true
  // pulls live pool prices (background reconcile pass).
  async function buildHoldingsView(user: UserRecord, forceRefresh: boolean) {
    // Fetch all open positions (including previously synced wallet deposits)
    let positions: PositionRecord[] = await getOpenPositions(user.id).catch(() => []);

    const emptyKeyboard = Markup.inlineKeyboard([
      [cb('🔄 Refresh', 'refresh_holdings', 'primary')],
      [cb('🔙 Back', 'menu_home', 'primary')],
      [Markup.button.callback('➕ Import Token', 'import_token_prompt')],
      [
        Markup.button.url('💬 Community', 'https://t.me/racerbot_community'),
        Markup.button.url('📢 Updates', 'https://t.me/racertrading'),
        Markup.button.url('𝕏 X', 'https://x.com/racertradingbot'),
      ],
    ]);

    // Live on-chain balance reconciliation:
    // If a user sent out or sold tokens externally via another wallet, detect the 0 or dust balance,
    // mark the position closed in DB immediately, and clear it from active holdings.
    if (positions.length > 0) {
      const balanceChecks = await Promise.allSettled(
        positions.map(async (pos) => {
          const isSuiPos = pos.chain === 'sui' || isSuiToken(pos.token_address);
          if (isSuiPos) {
            if (!user.sui_address) return { isZero: false, rawBal: pos.quantity_held, verified: false };
            try {
              const bal = await Promise.race([
                getSuiTokenBalance(user.sui_address, pos.token_address),
                new Promise<{ raw: bigint; uiAmount: number }>((_, reject) =>
                  setTimeout(() => reject(new Error('timeout')), 3000)
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
                  setTimeout(() => reject(new Error('timeout')), 3000)
                ),
              ]);
              const clean = String(rawBal || '0').replace(/["'\s]/g, '').split('.')[0] || '0';
              let rawBig = 0n;
              try { rawBig = BigInt(clean); } catch { rawBig = 0n; }
              const isZero = rawBig === 0n;
              return { isZero, rawBal: clean, verified: true };
            } catch (err: any) {
              const msg = err?.message || '';
              if (msg.includes('not registered') || msg.includes('does not exist')) {
                return { isZero: true, rawBal: '0', verified: true };
              }
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
          if (isZero) {
            await updatePosition({
              position_id: pos.id,
              status: 'closed',
              closed_at: new Date(),
            }).catch(() => {});
            console.log(`[HOLDINGS] Cleared externally transferred/zero balance token ${pos.token_address} (user ${user.id})`);
            continue; // Dropped from active holdings!
          } else if (rawBal && rawBal !== pos.quantity_held) {
            pos.quantity_held = rawBal;
            updatePosition({
              position_id: pos.id,
              quantity_held: rawBal,
            }).catch(() => {});
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

    // Fetch all token info in parallel; forceRefresh pulls live pool prices with 5s fallback
    const infoResults = await Promise.allSettled(
      positions.map(pos =>
        Promise.race([
          getTokenInfo(pos.token_address, forceRefresh),
          new Promise<TokenInfoResult | null>((resolve) =>
            setTimeout(() => resolve(getTokenInfo(pos.token_address, false).catch(() => null)), 5000)
          ),
        ])
      )
    );
    const infoMap = new Map<string, TokenInfoResult | null>();
    positions.forEach((pos, i) => {
      const r = infoResults[i];
      infoMap.set(pos.token_address, r.status === 'fulfilled' ? r.value : null);
    });

    // Fetch fills in parallel to calculate exact cost basis and heal entry prices
    const fillsResults = await Promise.allSettled(
      positions.map(pos => getFillsByPosition(pos.id).catch(() => []))
    );

      let totalPortfolioValueUsd = 0;
      const buttons: any[] = [];

      const MAX_DISPLAY_HOLDINGS = 20;
      const displayedPositions = positions.slice(0, MAX_DISPLAY_HOLDINGS);
      const remainingCount = positions.length - displayedPositions.length;

      for (let idx = 0; idx < displayedPositions.length; idx++) {
        const pos = displayedPositions[idx];
        const info = infoMap.get(pos.token_address);
        const rawSymbol = info?.symbol || (pos.token_address.length > 14 ? pos.token_address.slice(0, 12) + '...' : pos.token_address);
        const displayLabel = sanitizeMd(rawSymbol);
        const currentPrice = info ? parseFloat(info.price) : 0;
        const isSuiPos = pos.chain === 'sui' || isSuiToken(pos.token_address);
        const decimals = info?.decimals ?? (isSuiPos ? 6 : 18);
        const nativeUsdRate = isSuiPos ? (info?.sui_usd || 2.0) : (info?.near_usd || 4.3);

        let humanQuantity = 0;
        try {
          const rawBig = BigInt((pos.quantity_held || '0').split('.')[0]);
          humanQuantity = Number(rawBig) / Math.pow(10, decimals);
        } catch {
          humanQuantity = parseFloat(pos.quantity_held) || 0;
        }

        if (humanQuantity < 0.000001) {
          await updatePosition({
            position_id: pos.id,
            status: 'closed',
            closed_at: new Date(),
          }).catch(() => {});
          console.log(`[HOLDINGS] Cleared dust/zero token ${pos.token_address} (user ${user.id})`);
          continue;
        }

        const tokenPriceUsd = info?.price_usd ? parseFloat(info.price_usd) : (currentPrice * nativeUsdRate);
        const tokenValueUsd = humanQuantity * tokenPriceUsd;
        totalPortfolioValueUsd += tokenValueUsd;
        const fillsResult = fillsResults[idx];
        const fills = fillsResult && fillsResult.status === 'fulfilled' ? fillsResult.value : [];
        const buys = fills.filter((f: any) => f.side === 'buy' && !f.tx_hash?.startsWith('deposit_'));

        let totalBuyTokensHuman = 0;
        let totalBuyCostNative = 0;

        for (const buy of buys) {
          const val = parseFloat(buy.amount || '0');
          let amount = val;
          const rawAmtStr = String(buy.amount || '');
          if (decimals > 0 && (buy.input_amount != null || !rawAmtStr.includes('.') || val > 1e10)) {
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

        // Heal corrupted or uninitialized entry price from actual buy fills
        if (totalBuyTokensHuman > 0 && totalBuyCostNative > 0) {
          const fillAvgEntry = totalBuyCostNative / totalBuyTokensHuman;
          if (
            entryPrice <= 0 ||
            entryPrice > 1e6 || // Corrupted atomic price
            (currentPrice > 0 && entryPrice > currentPrice * 10 && fillAvgEntry <= currentPrice * 10) ||
            Math.abs(entryPrice - fillAvgEntry) / fillAvgEntry > 0.5
          ) {
            entryPrice = fillAvgEntry;
            pos.avg_entry_price = fillAvgEntry.toString();
            updatePosition({
              position_id: pos.id,
              avg_entry_price: fillAvgEntry.toString(),
            }).catch(() => {});
          }
        } else if ((entryPrice <= 0 || entryPrice > 1e6) && currentPrice > 0) {
          entryPrice = currentPrice;
          pos.avg_entry_price = currentPrice.toString();
          updatePosition({
            position_id: pos.id,
            avg_entry_price: currentPrice.toString(),
          }).catch(() => {});
        }

        let pnlDisplay = '+0.0%';
        let emoji = '⚪';
        let pnlStyle: BtnStyle | undefined = undefined; // undefined = default grey button

        if (currentPrice > 0 && entryPrice > 0) {
          const pnlPctNum = ((currentPrice - entryPrice) / entryPrice) * 100;
          // Profit tiers: 🔥 500%+, 🚀 100%+, 🟢 profit, 🔴 loss, ⚪ flat
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

        // Buttons-only list: per-token details render when the user taps the
        // token button (token_detail:<id>) — keeps the holdings view scannable.
        // Button color follows PNL: green profit, red loss, grey flat/unknown.
        const rawLabel = `${emoji} ${displayLabel} (${pnlDisplay})`;
        const cappedLabel = rawLabel.length > 28 ? `${rawLabel.slice(0, 27)}…` : rawLabel;
        buttons.push([cb(cappedLabel, `token_detail:${pos.id}`, pnlStyle)]);
      }

      // Add remaining positions value to total portfolio USD
      for (const pos of positions.slice(MAX_DISPLAY_HOLDINGS)) {
        const info = infoMap.get(pos.token_address);
        const currentPrice = info ? parseFloat(info.price) : 0;
        const isSuiPos = pos.chain === 'sui' || isSuiToken(pos.token_address);
        const decimals = info?.decimals ?? (isSuiPos ? 6 : 18);
        const nativeUsdRate = isSuiPos ? (info?.sui_usd || 2.0) : (info?.near_usd || 4.3);
        const tokenPriceUsd = info?.price_usd ? parseFloat(info.price_usd) : (currentPrice * nativeUsdRate);
        try {
          const rawBig = BigInt((pos.quantity_held || '0').split('.')[0]);
          totalPortfolioValueUsd += tokenPriceUsd * (Number(rawBig) / Math.pow(10, decimals));
        } catch { /* no-op */ }
      }

      const totalUsdDisplay = totalPortfolioValueUsd >= 1000 ? `$${(totalPortfolioValueUsd / 1000).toFixed(2)}K` : `$${totalPortfolioValueUsd.toFixed(2)}`;

      const overflowNote = remainingCount > 0
        ? `_... and ${remainingCount} more token(s) held in your wallet._\n\n`
        : '';

      const msg =
        `💼 *Holdings (${positions.length})*\n` +
        `💰 Total: \`${totalUsdDisplay}\`\n\n` +
        overflowNote +
        `_Tap a token below to view details & trade._`;

      buttons.push([
        Markup.button.callback('🔄 Refresh', 'refresh_holdings'),
        Markup.button.callback('🔙 Back', 'menu_home'),
        Markup.button.callback('➕ Import Token', 'import_token_prompt'),
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
  // 1. Paint immediately from DB + cached prices (no waiting on wallet scan).
  // 2. In the background, scan the wallet for deposits/sales, refresh prices,
  //    and patch the painted message only if something actually changed.
  async function handleHoldings(ctx: Context, isRefresh = false) {
    const telegramId = ctx.from!.id;
    try {
      const user = await getUserByTelegramId(telegramId);
      if (!user) {
        if (typeof (ctx as any).answerCbQuery === 'function') {
          await (ctx as any).answerCbQuery('Please run /start first.').catch(() => {});
        } else {
          await ctx.reply('Please run /start first.').catch(() => {});
        }
        return;
      }

      if (typeof (ctx as any).answerCbQuery === 'function') {
        await (ctx as any).answerCbQuery(isRefresh ? '🔄 Refreshing & scanning wallet...' : '💼 Loading holdings...').catch(() => {});
      }

      const fingerprintOf = (v: { msg: string; keyboard: any }) =>
        v.msg + '|' + JSON.stringify(
          (v.keyboard?.reply_markup?.inline_keyboard ?? []).map((row: any[]) => row.map((b: any) => b.text))
        );

      if (isRefresh) {
        if (typeof (ctx as any).answerCbQuery === 'function') {
          await (ctx as any).answerCbQuery('🔄 Refreshing holdings...').catch(() => {});
        }
        // Run live wallet deposit scan bounded to 4.5s so RPC latency never delays the user view
        await Promise.race([
          syncUserTokenDeposits(user.id, user.subaccount_id, true),
          new Promise((resolve) => setTimeout(resolve, 4500)),
        ]).catch((err) => {
          console.warn(`[HOLDINGS] Wallet scan error for ${user.subaccount_id}:`, err?.message || err);
        });

        // Bounded view build (max 6s) with fallback to cached DB view
        const view = await Promise.race([
          buildHoldingsView(user, true),
          new Promise<any>((resolve) => setTimeout(() => resolve(buildHoldingsView(user, false)), 6000)),
        ]);

        const canEditMsg = typeof (ctx as any).editMessageText === 'function';
        if (canEditMsg) {
          await (ctx as any).editMessageText(view.msg, { parse_mode: 'Markdown', ...view.keyboard })
            .catch(async (err: any) => {
              if (err?.message?.includes('message is not modified')) return;
              await ctx.reply(view.msg, { parse_mode: 'Markdown', ...view.keyboard }).catch(() => {});
            });
        } else {
          await ctx.reply(view.msg, { parse_mode: 'Markdown', ...view.keyboard }).catch(() => {});
        }
        return;
      }

      // 1. Instant paint from DB + cached prices for initial view
      const view = await buildHoldingsView(user, false);
      let paintedChatId: number | undefined;
      let paintedMessageId: number | undefined;

      const replyPaint = async () => {
        const sent = await ctx.reply(view.msg, { parse_mode: 'Markdown', ...view.keyboard }).catch(() => null);
        paintedChatId = (sent as any)?.chat?.id ?? (ctx.chat as any)?.id;
        paintedMessageId = (sent as any)?.message_id;
      };

      const canEditMsg = typeof (ctx as any).editMessageText === 'function';
      const cbMsg = (ctx as any).callbackQuery?.message;
      if (canEditMsg) {
        let edited = false;
        await (ctx as any).editMessageText(view.msg, { parse_mode: 'Markdown', ...view.keyboard })
          .then(() => { edited = true; })
          .catch(async (err: any) => {
            if (err?.message?.includes('message is not modified')) { edited = true; return; }
            await replyPaint();
          });
        if (edited && cbMsg) {
          paintedChatId = cbMsg.chat?.id ?? cbMsg.chat_id ?? ctx.chat?.id;
          paintedMessageId = cbMsg.message_id;
        }
      } else {
        await replyPaint();
      }

      // 2. Background wallet deposit sync (detached — does not trigger heavy token discovery scans)
      (async () => {
        try {
          await syncUserTokenDeposits(user.id, user.subaccount_id).catch((err) => {
            console.warn(`[HOLDINGS] Wallet scan error for ${user.subaccount_id}:`, err?.message || err);
          });
        } catch (err: any) {
          console.warn('[HOLDINGS] Background deposit sync error:', err?.message || err);
        }
      })();
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => {});
    }
  }

  // ── menu_holdings — Token list with name/logo and % change ────────────────
  bot.action('menu_holdings', async (ctx) => {
    try {
      await handleHoldings(ctx, false);
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => {});
    }
  });

  bot.action(['refresh_holdings', 'menu_holdings_refresh'], async (ctx) => {
    try {
      await (ctx as any).answerCbQuery?.('🔄 Refreshing holdings...').catch(() => {});
      await handleHoldings(ctx, true);
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => {});
    }
  });

  bot.command(['holdings', 'bags', 'positions'], async (ctx) => {
    try {
      await handleHoldings(ctx, true);
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => {});
    }
  });

  // ── import_token_prompt — Prompt user to paste token CA ───────────────────────
  bot.action('import_token_prompt', async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const telegramId = ctx.from!.id;
      userPendingActions.set(telegramId, {
        action: 'import_token',
        expiresAt: Date.now() + 2 * 60 * 1000, // 2 minutes expiry
      });
      await ctx.reply(
        '📝 *Import Token*\n\n' +
        'Please paste the token contract address (CA) you want to import.\n\n' +
        'Example: `token.near` or `nearfi-e29a8e.nearpadfamily.near`\n\n' +
        '_Send the address within 2 minutes to import it into your holdings._',
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => {});
    }
  });

  // ── token_detail — Individual token detail modal with PNL card ────────────────
  bot.action(/^token_detail:([^:]+)(?::([01]))?$/, async (ctx) => {
    const positionId = ctx.match![1];
    const nwParam    = ctx.match![2];
    const telegramId = ctx.from!.id;
    try {
      const user = await getUserByTelegramId(telegramId);
      if (!user) {
        await ctx.answerCbQuery('Please run /start first.').catch(() => {});
        return;
      }

      const showNetWorth = nwParam !== undefined
        ? nwParam === '1'
        : (user.show_net_worth_on_card !== false);

      await ctx.answerCbQuery().catch(() => {});
      const positions = await getOpenPositions(user.id).catch(() => []);
      const position = positions.find(p => p.id === positionId);
      if (!position) {
        await ctx.reply('Position not found. Please try again.').catch(() => {});
        return;
      }

      const isSuiPos = position.chain === 'sui' || isSuiToken(position.token_address);
      // Live on-chain balance check: if user transferred this token out via another wallet,
      // close position in DB immediately and inform user.
      let onChainZero = false;
      let liveRawBal: string | null = null;
      if (isSuiPos) {
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
        }).catch(() => {});
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
        ).catch(() => {});
        return;
      }

      if (liveRawBal && liveRawBal !== position.quantity_held) {
        position.quantity_held = liveRawBal;
        updatePosition({
          position_id: position.id,
          quantity_held: liveRawBal,
        }).catch(() => {});
      }

       const [info, fills, triggers] = await Promise.all([
         getTokenInfo(position.token_address, false).catch(() => null),
         getFillsByPosition(positionId).catch(() => []),
         getTriggersByPosition(positionId).catch(() => []),
      ]);

      const slTrigger = triggers.find(t => t.type === 'stop_loss');
      const tpTrigger = triggers.find(t => t.type === 'take_profit');
      const slDisplay = slTrigger ? `-${slTrigger.target_value}%` : 'None';
      const tpDisplay = tpTrigger ? `+${tpTrigger.target_value}%` : 'None';

      const symbol = info?.symbol ? sanitizeMd(info.symbol) : '???';
      const currentPrice = info ? parseFloat(info.price) : 0;
      const nativeUnit = isSuiPos ? 'SUI' : 'NEAR';
      const liveNativeUsd = isSuiPos ? await getSuiUsdPrice().catch(() => 2.0) : await getNearUsdPrice().catch(() => 5.16);
      const usdRate = isSuiPos ? (info?.sui_usd || liveNativeUsd) : (info?.near_usd || liveNativeUsd);

      const decimals = info?.decimals ?? (isSuiPos ? 6 : 18);
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
        humanQuantity = Number(rawBig) / Math.pow(10, decimals);
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
          }).catch(() => {});
        }
      } else if (entryPrice <= 0 && currentPrice > 0) {
        entryPrice = currentPrice;
        position.avg_entry_price = currentPrice.toString();
        updatePosition({
          position_id: position.id,
          avg_entry_price: currentPrice.toString(),
        }).catch(() => {});
      }

      const externalTokens = (position.is_external_deposit && humanQuantity > totalBuyTokensHuman)
        ? (humanQuantity - totalBuyTokensHuman)
        : 0;
      if (externalTokens > 0) {
        initialInvestment += externalTokens * entryPrice;
      } else if (initialInvestment === 0 && humanQuantity > 0) {
        initialInvestment = humanQuantity * entryPrice;
      }

      const pnlPct = currentPrice > 0 && entryPrice > 0
        ? ((currentPrice - entryPrice) / entryPrice * 100).toFixed(1)
        : 'N/A';
      const emoji = parseFloat(pnlPct) >= 0 ? '🟢' : '🔴';
      const pnlDisplay = pnlPct === 'N/A' ? 'N/A' : `${parseFloat(pnlPct) >= 0 ? '+' : ''}${pnlPct}%`;

      const holdingValueNative = humanQuantity * currentPrice;
      const holdingValueUsd = holdingValueNative * usdRate;
      const initialInvestedUsd = initialInvestment * usdRate;
      const pnlUsd = holdingValueUsd - initialInvestedUsd;
      const pnlUsdStr = Math.abs(pnlUsd) >= 0.01 ? `${pnlUsd >= 0 ? '+$' : '-$'}${Math.abs(pnlUsd).toFixed(2)}` : '';

      const formattedQty = formatHoldingQuantity(position.quantity_held, decimals);

      const fmtPrice = (p: number) => {
        if (p <= 0) return '`$0.00`';
        const usd = p * usdRate;
        const usdStr = usd >= 1 ? `$${usd.toFixed(2)}` : usd >= 0.0001 ? `$${usd.toFixed(6)}` : `$${usd.toFixed(8)}`;
        const natStr = p >= 1 ? `${p.toFixed(2)} ${nativeUnit}` : p >= 0.0001 ? `${p.toFixed(6)} ${nativeUnit}` : `${p.toFixed(8)} ${nativeUnit}`;
        return `\`${usdStr}\` (${natStr})`;
      };

      const fmtVal = (valNative: number) => {
        const usd = valNative * usdRate;
        const usdStr = usd >= 1000 ? `$${(usd / 1000).toFixed(2)}K` : `$${usd.toFixed(2)}`;
        const natStr = valNative >= 1000 ? `${(valNative / 1000).toFixed(2)}K ${nativeUnit}` : `${valNative.toFixed(4)} ${nativeUnit}`;
        return `\`${usdStr}\` (${natStr})`;
      };

      const fmtMcap = () => {
        const effectiveMcUsd = mcUsd > 0 ? mcUsd : (mcNative > 0 ? mcNative * usdRate : 0);
        const effectiveMcNative = mcNative > 0 ? mcNative : (effectiveMcUsd > 0 && usdRate > 0 ? effectiveMcUsd / usdRate : 0);
        if (effectiveMcUsd <= 0 && effectiveMcNative <= 0) return '`N/A`';

        const mcUsdStr = effectiveMcUsd >= 1e6 ? `$${(effectiveMcUsd / 1e6).toFixed(2)}M` : effectiveMcUsd >= 1e3 ? `$${(effectiveMcUsd / 1e3).toFixed(2)}K` : `$${effectiveMcUsd.toFixed(2)}`;
        const mcNatStr = effectiveMcNative >= 1e6 ? `${(effectiveMcNative / 1e6).toFixed(2)}M ${nativeUnit}` : effectiveMcNative >= 1e3 ? `${(effectiveMcNative / 1e3).toFixed(2)}K ${nativeUnit}` : `${effectiveMcNative.toFixed(2)} ${nativeUnit}`;
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
      const unitBtn = isSuiPos ? 'SUI' : 'N';

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
      buttons.push([
        cb(`1 ${unitBtn}`, `buy_fixed:${shortKey}:1`, 'success'),
        cb(`5 ${unitBtn}`, `buy_fixed:${shortKey}:5`, 'success'),
        cb(`10 ${unitBtn}`, `buy_fixed:${shortKey}:10`, 'success'),
      ]);
      buttons.push([cb(`🟢 Buy X ${nativeUnit}`, `buy_custom_prompt:${shortKey}`, 'success')]);

      // Sell Custom & Initial buttons
      const sellSpecialRow: any[] = [cb('🔴 Sell X Tokens', `sell_custom_prompt:${positionId}`, 'danger')];
      if (initialInvestment > 0) {
        sellSpecialRow.push(cb('🔴 Sell Initial', `sell_initial:${positionId}`, 'danger'));
      }
      buttons.push(sellSpecialRow);

      if (!isSuiPos) {
        buttons.push([
          cb('🔁 DCA Order', `dca_token:${shortKey}`, 'primary'),
          cb('🎯 Limit Order', `lo_start:${shortKey}`, 'primary'),
        ]);
      }

      // External explorer & chart links
      const linkRows = (() => {
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
          const shareCode = await getOrCreateTokenShare(user.id, position.token_address);
          const shareDeepLink = `https://t.me/racertradingbot?start=${shareCode}`;
          const sym = symbol !== '???' ? symbol : 'TOKEN';
          const shareText = `Trade $${sym} on RacerBot 🏎\n⚡ Instant 1-click execution on NEAR DEXs`;
          const tgShareUrl = `https://t.me/share/url?url=${encodeURIComponent(shareDeepLink)}&text=${encodeURIComponent(shareText)}`;
          buttons.push([Markup.button.url('📤 Share Token (Earn 5% Fees)', tgShareUrl)]);
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

      // Generate PNL card with image for all chains (NEAR + SUI)
      let pnlCardImage: Buffer | null = null;
      try {
        const pnlCard = await generatePNLCard(positionId, showNetWorth);
        if (pnlCard.image) {
          pnlCardImage = pnlCard.image;
        } else {
          msg += `\n${pnlCard.text}`;
        }
      } catch (err: any) {
        console.error('Failed to generate PNL card:', err);
      }

      // If image was generated, send it as a new message with caption and keyboard
      if (pnlCardImage) {
        await ctx.replyWithPhoto(
          { source: pnlCardImage },
          {
            caption: msg,
            parse_mode: 'Markdown',
            reply_markup: Markup.inlineKeyboard(buttons).reply_markup
          }
        ).catch(() => {
          // Fallback to text if image send fails
          ctx.editMessageText(msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }).catch(() => {});
        });
        // Delete the original message to avoid clutter
        await ctx.deleteMessage().catch(() => {});
        return;
      }

      await ctx.editMessageText(msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }).catch(() => {});
    } catch (err: any) {
      console.error('[token_detail] Error loading token details:', err?.message || err);
      await ctx.reply('Error loading token details. Please try again.').catch(() => {});
    }
  });

  // ── sell_custom_prompt — Prompt user for exact token amount to sell ─────────
  bot.action(/^sell_custom_prompt:(.+)$/, async (ctx) => {
    try {
      const positionId = ctx.match![1];
      const telegramId = ctx.from!.id;

      const user = await getUserByTelegramId(telegramId).catch(() => null);
      if (!user) {
        await ctx.answerCbQuery('Please run /start first.').catch(() => {});
        return;
      }
      const position = await getPositionById(positionId).catch(() => null);
      if (!position || position.user_id !== user.id) {
        await ctx.answerCbQuery('Position not found.').catch(() => {});
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

      await ctx.answerCbQuery().catch(() => {});
      await ctx.reply(
        `💸 *Sell Custom Amount of $${sym}*\n\n` +
        `💼 *Your Current Balance*: \`${formattedQty} ${sym}\`\n\n` +
        `Reply with the exact number of tokens you want to sell (e.g. \`50000\` or \`100\`):\n\n` +
        `_Type /cancel to abort._`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[cb('🔙 Cancel', `token_refresh:${shortKey}`, 'primary')]])
        }
      ).catch(() => {});
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => {});
    }
  });

  // ── sell_initial — Sell exact initial investment amount ───────────────────
  bot.action(/^sell_initial:(.+)$/, async (ctx) => {
    const positionId = ctx.match![1];
    const telegramId = ctx.from!.id;

    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) {
      await ctx.answerCbQuery('Please run /start first.').catch(() => {});
      return;
    }
    const position = await getPositionById(positionId).catch(() => null);
    if (!position || position.user_id !== user.id) {
      await ctx.answerCbQuery('Position not found.').catch(() => {});
      return;
    }
    const tokenAddress = position.token_address;

    const guardKey = inFlightKey(telegramId, tokenAddress, 'sell');
    if (!(await tryAcquireInFlight(guardKey))) {
      await ctx.answerCbQuery('A trade for this token is already in progress.').catch(() => {});
      return;
    }
    await ctx.answerCbQuery('⚡ Processing sell initial order...').catch(() => {});

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
          if (procMsg) await ctx.deleteMessage(procMsg.message_id).catch(() => {});
          await ctx.reply('No buy history found for this position.').catch(() => {});
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
          if (procMsg) await ctx.deleteMessage(procMsg.message_id).catch(() => {});
          await ctx.reply('Cannot calculate sell amount - current price is 0.').catch(() => {});
          return;
        }

        const currentHeld = toHuman(livePosition.quantity_held);
        if (currentHeld === 0) {
          if (procMsg) await ctx.deleteMessage(procMsg.message_id).catch(() => {});
          await ctx.reply('No tokens held in this position.').catch(() => {});
          return;
        }

        // Calculate percentage needed to sell to recover initial investment
        const currentValue = currentHeld * currentPrice;
        const sellPercentage = (totalInitialInvestment / currentValue) * 100;
        const adjustedPercentage = Math.min(100, Math.max(1, sellPercentage));

        const result = await sellAtTarget(user.id, positionId, adjustedPercentage, onStage);

        if (procMsg) await ctx.deleteMessage(procMsg.message_id).catch(() => {});

        if (result.success) {
          await sendPnlCardMessage(
            ctx,
            positionId,
            `✅ *Sold initial investment of \`${totalInitialInvestment.toFixed(4)} NEAR\` worth of tokens (\`${adjustedPercentage.toFixed(1)}%\`).*`
          ).catch(() => {});
        } else {
          await ctx.reply(`❌ Sell failed: ${result.reason || 'Unknown error'}`).catch(() => {});
        }
      } catch (err: any) {
        if (procMsg) await ctx.deleteMessage(procMsg.message_id).catch(() => {});
        console.error('[SELL_INITIAL] Error:', err);
        await ctx.reply('Error processing sell. Please try again.').catch(() => {});
      } finally {
        await releaseInFlight(guardKey);
      }
    })().catch(async (err: any) => {
      await releaseInFlight(guardKey);
      console.error('[SELL_INITIAL] Unhandled detached error:', err?.message || err);
      ctx.reply('Error processing sell. Please try again.').catch(() => {});
    });
  });

  // ── menu_positions — Redirect to holdings for backwards compatibility ───────
  bot.action('menu_positions', async (ctx) => {
    try {
      await (ctx as any).answerCbQuery?.('🔄 Refreshing holdings...').catch(() => {});
      await handleHoldings(ctx, true);
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => {});
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
      setImmediate(() => syncUserTokenDeposits(user.id, user.subaccount_id).catch(() => {}));

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
          } catch {}
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
        msg += `${pnlEmoji} *${netRealizedPnl >= 0 ? '+' : ''}${netRealizedPnl.toFixed(4)} NEAR* (\`${usdSign}$${usdVal.toFixed(2)} USD\`)\n`;
        msg += `📈 *Exact Return*: \`${pctSign}${netPnlPct.toFixed(2)}%\` (${statusWord})\n\n`;

        msg += `🎯 *Trade Performance*:\n`;
        msg += `• *Wins*: \`${wins}\` | *Losses*: \`${losses}\`\n`;
        msg += `• *Win Rate*: \`${winRate.toFixed(1)}%\`\n`;
        msg += `• *Total Volume*: \`${totalRevenue.toFixed(2)} NEAR\` (${totalTrades} sell${totalTrades > 1 ? 's' : ''})\n\n`;

        msg += `🪙 *Token Breakdown*:\n`;
        const sortedTokens = Object.values(tokenGroups).sort((a, b) => b.netPnl - a.netPnl);
        for (const t of sortedTokens.slice(0, 8)) {
          const tPct = t.cost > 0 ? (t.netPnl / t.cost) * 100 : 0;
          const tEmoji = t.netPnl >= 0 ? '🟢' : '🔴';
          const info = tokenInfoMap.get(t.token);
          const rawSym = info?.symbol || t.token.split('.')[0].toUpperCase();
          const sym = sanitizeMd(rawSym);
          msg += `${tEmoji} *$${sym}*: \`${t.netPnl >= 0 ? '+' : ''}${t.netPnl.toFixed(4)} N\` (\`${tPct >= 0 ? '+' : ''}${tPct.toFixed(1)}%\`) (${t.count} trade${t.count > 1 ? 's' : ''})\n`;
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
            await ctx.reply(msg.replace(/[*_`]/g, ''), keyboard).catch(() => {});
          });
        });
      } else {
        await ctx.reply(msg, { parse_mode: 'Markdown', ...keyboard }).catch(async () => {
          await ctx.reply(msg.replace(/[*_`]/g, ''), keyboard).catch(() => {});
        });
      }
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => {});
    }
  };

  bot.action(/^pnl_tf:(24h|7d|30d|all)$/, async (ctx) => {
    try {
      const tf = ctx.match![1] as PnlTimeframe;
      await ctx.answerCbQuery().catch(() => {});
      await handlePnl(ctx, tf);
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => {});
    }
  });

  bot.action(['menu_pnl', 'refresh_pnl'], async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      await handlePnl(ctx, '24h');
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => {});
    }
  });

  bot.command('pnl', async (ctx) => {
    try {
      await handlePnl(ctx, '24h');
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => {});
    }
  });

  // ── /wallet & /balance ────────────────────────────────────────────────────
  const handleWallet = async (ctx: Context) => {
    const telegramId = ctx.from!.id;
    try {
      const wallet = await buildWalletMenu(telegramId);
      await ctx.reply(wallet.text, { parse_mode: 'HTML', ...wallet.keyboard }).catch(() => {});
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => {});
    }
  };

  bot.command('wallet', handleWallet);
  bot.command('balance', handleWallet);

  // ── /wallets — Multi-Wallet Management (Option A) ─────────────────────────
  const handleWallets = async (ctx: Context) => {
    const telegramId = ctx.from!.id;
    try {
      const menu = await buildWalletsManagementMenu(telegramId);
      const canEdit = typeof (ctx as any).editMessageText === 'function';
      if (canEdit && ctx.callbackQuery) {
        await (ctx as any).editMessageText(menu.text, { parse_mode: 'HTML', ...menu.keyboard }).catch(async (err: any) => {
          if (err?.message?.includes('message is not modified')) return;
          await ctx.reply(menu.text, { parse_mode: 'HTML', ...menu.keyboard }).catch(() => {});
        });
      } else {
        await ctx.reply(menu.text, { parse_mode: 'HTML', ...menu.keyboard }).catch(() => {});
      }
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => {});
    }
  };

  bot.command('wallets', handleWallets);
  bot.action('wallets_menu', async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      await handleWallets(ctx);
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => {});
    }
  });

  bot.action(/^wallet_switch:(.+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const walletId = ctx.match![1];
    try {
      const switched = await switchActiveNearWallet(telegramId, walletId);
      await ctx.answerCbQuery(`⚡ Switched active wallet to ${switched.name}!`).catch(() => {});
      const menu = await buildWalletsManagementMenu(telegramId);
      const canEdit = typeof (ctx as any).editMessageText === 'function';
      if (canEdit) {
        await (ctx as any).editMessageText(menu.text, { parse_mode: 'HTML', ...menu.keyboard }).catch(async () => {
          await ctx.reply(menu.text, { parse_mode: 'HTML', ...menu.keyboard }).catch(() => {});
        });
      } else {
        await ctx.reply(menu.text, { parse_mode: 'HTML', ...menu.keyboard }).catch(() => {});
      }
    } catch (err: any) {
      await ctx.answerCbQuery(`❌ ${err.message}`).catch(() => {});
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => {});
    }
  });

  bot.action('wallet_import_prompt', async (ctx) => {
    const telegramId = ctx.from!.id;
    userPendingActions.set(telegramId, {
      action: 'import_near_key',
      expiresAt: Date.now() + 180000,
    });
    await ctx.answerCbQuery().catch(() => {});
    await ctx.reply(
      `📥 <b>Import NEAR Wallet</b>\n\n` +
      `Please reply with your NEAR account private key (e.g. <code>ed25519:...</code> or base58 string).\n\n` +
      `<i>Tip: You can also specify an account ID alongside the key:</i>\n` +
      `<code>myaccount.near ed25519:...</code>\n\n` +
      `🔒 <i>Your message containing the key will be deleted automatically for security.</i>\n\n` +
      `_Send /cancel to abort._`,
      { parse_mode: 'HTML' }
    );
  });

  bot.action(/^wallet_rename_prompt:(.+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const walletId = ctx.match![1];
    userPendingActions.set(telegramId, {
      action: 'rename_near_wallet',
      renameWalletId: walletId,
      expiresAt: Date.now() + 180000,
    });
    await ctx.answerCbQuery().catch(() => {});
    await ctx.reply(
      `✏️ <b>Rename Wallet</b>\n\n` +
      `Please reply with the new name for this wallet (e.g. <i>Sniper</i>, <i>Main</i>, <i>Degen</i>):\n\n` +
      `_Send /cancel to abort._`,
      { parse_mode: 'HTML' }
    );
  });

  bot.action(/^wallet_delete_confirm:(.+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const walletId = ctx.match![1];
    try {
      const res = await deleteUserNearWallet(telegramId, walletId);
      await ctx.answerCbQuery('Wallet deleted.').catch(() => {});
      let msg = `🗑️ Wallet deleted successfully.`;
      if (res.fallbackWallet) {
        msg += ` Active wallet switched to <b>${res.fallbackWallet.name}</b>.`;
      }
      await ctx.reply(msg, { parse_mode: 'HTML' });
      const menu = await buildWalletsManagementMenu(telegramId);
      await ctx.reply(menu.text, { parse_mode: 'HTML', ...menu.keyboard });
    } catch (err: any) {
      await ctx.answerCbQuery(`❌ ${err.message}`).catch(() => {});
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
    }
  });

  bot.action(/^wallet_switch_sui:(.+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const walletId = ctx.match![1];
    try {
      const switched = await switchActiveSuiWallet(telegramId, walletId);
      await ctx.answerCbQuery(`⚡ Switched active SUI wallet to ${switched.name}!`).catch(() => {});
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
      await ctx.answerCbQuery(`❌ ${err.message}`).catch(() => {});
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
    }
  });

  bot.action('wallet_import_sui_prompt', async (ctx) => {
    const telegramId = ctx.from!.id;
    userPendingActions.set(telegramId, {
      action: 'import_sui_key',
      expiresAt: Date.now() + 180000,
    });
    await ctx.answerCbQuery().catch(() => {});
    await ctx.reply(
      `📥 <b>Import SUI Wallet</b>\n\n` +
      `Please reply with your SUI private key.\n\n` +
      `Supported formats:\n` +
      `• Standard Bech32 (<code>suiprivkey1...</code>)\n` +
      `• 32-byte or 64-byte Hex (with or without <code>0x</code>)\n` +
      `• Base64 or Base58\n\n` +
      `🔒 <i>Your message containing the key will be deleted automatically for security.</i>\n\n` +
      `_Send /cancel to abort._`,
      { parse_mode: 'HTML' }
    );
  });

  bot.action(/^wallet_rename_sui_prompt:(.+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const walletId = ctx.match![1];
    userPendingActions.set(telegramId, {
      action: 'rename_sui_wallet',
      renameSuiWalletId: walletId,
      expiresAt: Date.now() + 180000,
    });
    await ctx.answerCbQuery().catch(() => {});
    await ctx.reply(
      `✏️ <b>Rename SUI Wallet</b>\n\n` +
      `Please reply with the new name for this wallet (e.g. <i>Sui Whale</i>, <i>Sniper</i>, <i>Degen</i>):\n\n` +
      `_Send /cancel to abort._`,
      { parse_mode: 'HTML' }
    );
  });

  bot.action(/^wallet_delete_sui_confirm:(.+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const walletId = ctx.match![1];
    try {
      const res = await deleteUserSuiWallet(telegramId, walletId);
      await ctx.answerCbQuery('Wallet deleted.').catch(() => {});
      let msg = `🗑️ SUI wallet deleted successfully.`;
      if (res.fallbackWallet) {
        msg += ` Active SUI wallet switched to <b>${res.fallbackWallet.name}</b>.`;
      }
      await ctx.reply(msg, { parse_mode: 'HTML' });
      const menu = await buildWalletsManagementMenu(telegramId);
      await ctx.reply(menu.text, { parse_mode: 'HTML', ...menu.keyboard });
    } catch (err: any) {
      await ctx.answerCbQuery(`❌ ${err.message}`).catch(() => {});
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
    }
  });

  bot.action(/^wallet_pick_acc:(.+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const chosenAccount = ctx.match![1];
    const pending = userPendingActions.get(telegramId);
    if (!pending || !pending.importNearPrivateKey) {
      await ctx.answerCbQuery('Session expired. Please try importing again.').catch(() => {});
      return;
    }
    userPendingActions.set(telegramId, {
      action: 'import_near_name',
      importNearPrivateKey: pending.importNearPrivateKey,
      importNearAccountId: chosenAccount,
      expiresAt: Date.now() + 180000,
    });
    await ctx.answerCbQuery().catch(() => {});
    await ctx.reply(
      `✅ Selected account: <code>${chosenAccount}</code>\n\n` +
      `Please reply with a nickname for this wallet (e.g. <i>Sniper</i>, <i>Main</i>, <i>Degen</i>):\n\n` +
      `_Send /cancel to abort._`,
      { parse_mode: 'HTML' }
    );
  });

  bot.action('wallet_refresh', async (ctx) => {
    const telegramId = ctx.from!.id;
    try {
      await ctx.answerCbQuery('🔄 Refreshing wallet...').catch(() => {});
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
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => {});
    }
  });

  bot.action('wallet_unwrap', async (ctx) => {
    const telegramId = ctx.from!.id;
    await ctx.answerCbQuery('Unwrapping wNEAR...').catch(() => {});
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
      if (second.includes('.tkn.near') || (!second.includes('.') && !isValidSuiAddress(second))) {
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
    await ctx.answerCbQuery().catch(() => {});
    await ctx.reply(
      `💸 *Withdraw & Send Funds (NEAR, SUI & Tokens)*\n\n` +
      `Reply with the recipient address, amount, and optional token, for example:\n` +
      `• *NEAR*: \`mywallet.near 1.5\` or \`mywallet.near all\`\n` +
      `• *Token*: \`mywallet.near 100 LONK\` or \`mywallet.near all blackdragon.tkn.near\`\n` +
      `• *SUI*: \`0x1234...abcd 1.0\` or \`0x1234...abcd all\`\n\n` +
      `_Or tap below to choose a token from your bags to send:_`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [cb('🎒 Send Token from Bags', 'wallet_withdraw_tokens_list', 'primary')],
          [cb('🔙 Back to Wallet', 'wallet_refresh', 'primary')],
        ]),
      }
    );
  });

  bot.action('wallet_withdraw_tokens_list', async (ctx) => {
    const telegramId = ctx.from!.id;
    await ctx.answerCbQuery().catch(() => {});
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
    await ctx.answerCbQuery().catch(() => {});
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
        `💸 *Withdraw & Send Funds (NEAR, SUI & Tokens)*\n\n` +
        `*Usage:*\n` +
        `• Native NEAR: \`/send <destination> <amount>\`\n` +
        `• Token: \`/send <destination> <amount> <token>\`\n` +
        `• Native SUI: \`/send <sui_address> <amount>\`\n\n` +
        `*Examples:*\n` +
        `• \`/send mywallet.near 1.5\`\n` +
        `• \`/send mywallet.near 500 LONK\`\n` +
        `• \`/send mywallet.near all blackdragon.tkn.near\`\n` +
        `• \`/send 0x1234...abcd 1.0\`\n\n` +
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
      const isSuiDest = isValidSuiAddress(destination) && !destination.endsWith('.near');
      const isExplicitToken = tokenArg && tokenArg.toLowerCase() !== 'near' && tokenArg.toLowerCase() !== 'sui';

      if (isExplicitToken) {
        const result = await withdrawTokenFunds(telegramId, tokenArg, destination, amountNum);
        const explorerUrl = result.chain === 'sui'
          ? `https://suiscan.xyz/mainnet/tx/${result.txHash}`
          : `https://nearblocks.io/txns/${result.txHash}`;
        const explorerName = result.chain === 'sui' ? 'Suiscan' : 'NearBlocks';

        await ctx.reply(
          `✅ *Token Transfer Successful!*\n\n` +
          `💸 Amount: \`${result.amountWithdrawn} ${result.symbol}\`\n` +
          `📬 Destination: \`${result.destination}\`\n` +
          `🪙 Contract: \`${result.tokenAddress}\`\n\n` +
          `🔗 Explorer: [View on ${explorerName}](${explorerUrl})`,
          { parse_mode: 'Markdown' }
        );
      } else if (isSuiDest) {
        const result = await withdrawSuiFunds(telegramId, destination, amountNum);
        await ctx.reply(
          `✅ *SUI Withdrawal Successful!*\n\n` +
          `💸 Amount: \`${result.amountWithdrawn} SUI\`\n` +
          `📬 Destination: \`${result.destination}\`\n\n` +
          `🔗 Explorer: [View on Suiscan](https://suiscan.xyz/mainnet/tx/${result.txHash})`,
          { parse_mode: 'Markdown' }
        );
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

  // Settings Dashboard Button Actions
  bot.action('set:toggle_auto_buy', async (ctx) => {
    try {
      const telegramId = ctx.from!.id;
      const user = await getUserByTelegramId(telegramId);
      if (!user) return;
      const newStatus = !user.auto_buy_enabled;
      const updated = await updateUserSettings(user.id, { auto_buy_enabled: newStatus });
      await ctx.answerCbQuery(`Auto-buy ${newStatus ? 'enabled' : 'disabled'}`).catch(() => {});
      const dash = await buildSnipeDashboard(updated);
      await ctx.editMessageText(dash.text, { parse_mode: 'Markdown', ...dash.keyboard }).catch(() => {});
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => {});
    }
  });

  bot.action('set:toggle_show_net_worth', async (ctx) => {
    try {
      const telegramId = ctx.from!.id;
      const user = await getUserByTelegramId(telegramId);
      if (!user) return;
      const current = user.show_net_worth_on_card !== false;
      const updated = await updateUserSettings(user.id, { show_net_worth_on_card: !current });
      await ctx.answerCbQuery(`Net worth on cards ${!current ? 'shown' : 'hidden'}`).catch(() => {});
      const dash = buildSettingsDashboard(updated);
      await ctx.editMessageText(dash.text, { parse_mode: 'Markdown', ...dash.keyboard }).catch(() => {});
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => {});
    }
  });

  bot.action(/^toggle_pnl_nw:([^:]+):([01])$/, async (ctx) => {
    try {
      const positionId = ctx.match![1];
      const showNw = ctx.match![2] === '1';
      await ctx.answerCbQuery(showNw ? 'Showing net worth...' : 'Hiding net worth...').catch(() => {});
      await ctx.deleteMessage().catch(() => {});
      await sendPnlCardMessage(ctx, positionId, undefined, showNw);
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => {});
    }
  });

  bot.action(/^set:slippage:([0-9.]+)$/, async (ctx) => {
    try {
      const telegramId = ctx.from!.id;
      const slip = parseFloat(ctx.match![1]);
      const user = await getUserByTelegramId(telegramId);
      if (!user) return;
      const updated = await updateUserSettings(user.id, { slippage_pct: slip });
      await ctx.answerCbQuery(`Slippage set to ${slip}%`).catch(() => {});
      const dash = buildSettingsDashboard(updated);
      await ctx.editMessageText(dash.text, { parse_mode: 'Markdown', ...dash.keyboard }).catch(() => {});
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => {});
    }
  });

  bot.action(/^set:auto_amt:([0-9.]+)$/, async (ctx) => {
    try {
      const telegramId = ctx.from!.id;
      const amt = parseFloat(ctx.match![1]);
      const user = await getUserByTelegramId(telegramId);
      if (!user) return;
      const updated = await updateUserSettings(user.id, { auto_buy_amount_near: amt });
      await ctx.answerCbQuery(`Auto-buy amount set to ${amt} NEAR`).catch(() => {});
      const dash = await buildSnipeDashboard(updated);
      await ctx.editMessageText(dash.text, { parse_mode: 'Markdown', ...dash.keyboard }).catch(() => {});
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => {});
    }
  });

  bot.action(/^set:min_liq:([0-9.]+)$/, async (ctx) => {
    try {
      const telegramId = ctx.from!.id;
      const liq = parseFloat(ctx.match![1]);
      const user = await getUserByTelegramId(telegramId);
      if (!user) return;
      const updated = await updateUserSettings(user.id, { auto_buy_min_liquidity_near: liq });
      await ctx.answerCbQuery(`Min liquidity set to ${liq} NEAR`).catch(() => {});
      const dash = await buildSnipeDashboard(updated);
      await ctx.editMessageText(dash.text, { parse_mode: 'Markdown', ...dash.keyboard }).catch(() => {});
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => {});
    }
  });

  bot.action(/^set:buy_pct:(\d+)$/, async (ctx) => {
    try {
      const telegramId = ctx.from!.id;
      const pct = parseInt(ctx.match![1]);
      const user = await getUserByTelegramId(telegramId);
      if (!user) return;
      const updated = await updateUserSettings(user.id, { default_buy_pct: pct });
      await ctx.answerCbQuery(`Default buy set to ${pct}%`).catch(() => {});
      const dash = buildSettingsDashboard(updated);
      await ctx.editMessageText(dash.text, { parse_mode: 'Markdown', ...dash.keyboard }).catch(() => {});
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => {});
    }
  });

  bot.action(/^set:sell_pct:(\d+)$/, async (ctx) => {
    try {
      const telegramId = ctx.from!.id;
      const pct = parseInt(ctx.match![1]);
      const user = await getUserByTelegramId(telegramId);
      if (!user) return;
      const updated = await updateUserSettings(user.id, { default_sell_pct: pct });
      await ctx.answerCbQuery(`Default sell set to ${pct}%`).catch(() => {});
      const dash = buildSettingsDashboard(updated);
      await ctx.editMessageText(dash.text, { parse_mode: 'Markdown', ...dash.keyboard }).catch(() => {});
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => {});
    }
  });

  bot.action('prompt:custom_slippage', async (ctx) => {
    try {
      const telegramId = ctx.from!.id;
      userPendingActions.set(telegramId, {
        action: 'custom_slippage',
        expiresAt: Date.now() + 120000,
      });
      await ctx.answerCbQuery().catch(() => {});
      await ctx.reply('✏️ *Enter Slippage Tolerance*\n\nReply with your desired slippage percentage (e.g. `2.5` or up to `100`):', { parse_mode: 'Markdown' }).catch(() => {});
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => {});
    }
  });

  bot.action('prompt:custom_auto_buy', async (ctx) => {
    try {
      const telegramId = ctx.from!.id;
      userPendingActions.set(telegramId, {
        action: 'custom_auto_buy',
        expiresAt: Date.now() + 120000,
      });
      await ctx.answerCbQuery().catch(() => {});
      await ctx.reply('✏️ *Enter Auto-Buy Amount*\n\nReply with the NEAR amount per auto-buy (e.g. `0.25`):', { parse_mode: 'Markdown' }).catch(() => {});
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => {});
    }
  });

  bot.action('prompt:custom_min_liq', async (ctx) => {
    try {
      const telegramId = ctx.from!.id;
      userPendingActions.set(telegramId, {
        action: 'custom_min_liq',
        expiresAt: Date.now() + 120000,
      });
      await ctx.answerCbQuery().catch(() => {});
      await ctx.reply('✏️ *Enter Min Pool Liquidity*\n\nReply with the minimum pool liquidity in NEAR (e.g. `200` or `500`):', { parse_mode: 'Markdown' }).catch(() => {});
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => {});
    }
  });

  bot.action(/^set:max_mcap:(\d+)$/, async (ctx) => {
    try {
      const telegramId = ctx.from!.id;
      const mcap = parseFloat(ctx.match![1]);
      const user = await getUserByTelegramId(telegramId);
      if (!user) return;
      const updated = await updateUserSettings(user.id, { auto_buy_max_market_cap_usd: mcap });
      await ctx.answerCbQuery(`Max market cap set to ${mcap > 0 ? '$' + mcap.toLocaleString() : 'No Limit'}`).catch(() => {});
      const dash = await buildSnipeDashboard(updated);
      await ctx.editMessageText(dash.text, { parse_mode: 'Markdown', ...dash.keyboard }).catch(() => {});
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => {});
    }
  });

  bot.action('prompt:custom_max_mcap', async (ctx) => {
    try {
      const telegramId = ctx.from!.id;
      userPendingActions.set(telegramId, {
        action: 'custom_max_mcap',
        expiresAt: Date.now() + 120000,
      });
      await ctx.answerCbQuery().catch(() => {});
      await ctx.reply('✏️ *Enter Max Market Cap ($ USD)*\n\nReply with your maximum token market cap in USD (e.g. `50000` for $50k, or `0` for no limit):', { parse_mode: 'Markdown' }).catch(() => {});
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => {});
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
      await ctx.answerCbQuery('🔄 Refreshing token...').catch(() => {});
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
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => {});
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
    await ctx.answerCbQuery('🔍 Running deep security audit...').catch(() => {});
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
      await ctx.reply(`❌ Security audit failed: ${getUserFriendlyError(err)}`).catch(() => {});
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
      const amountVal = parseFloat(ctx.match![2]);
      const telegramId = ctx.from!.id;
      const isSui = isSuiToken(tokenAddress);
      const unit = isSui ? 'SUI' : 'NEAR';
      console.log(`[BUY_FIXED] Click: user=${telegramId}, token=${tokenAddress}, amount=${amountVal} ${unit}`);

      // In-flight guard: reject a duplicate tap while a trade for this token is running.
      const guardKey = inFlightKey(telegramId, tokenAddress, 'buy');
      if (!(await tryAcquireInFlight(guardKey))) {
        console.warn(`[BUY_FIXED] Duplicate tap rejected: guardKey=${guardKey}`);
        await ctx.answerCbQuery('A trade for this token is already in progress.').catch(() => {});
        return;
      }
      await ctx.answerCbQuery(`⚡ Processing buy order for ${amountVal} ${unit}...`).catch(() => {});

      (async () => {
        const procMsg = await ctx.reply(`⏳ *Processing Buy Order...*\n\nExchanging \`${amountVal} ${unit}\` for \`${tokenAddress}\`...\n_Executing swap on DEX..._`, { parse_mode: 'Markdown' }).catch(() => null);
        const onStage = makeStageEditor(ctx, procMsg, 'Processing Buy Order');
        try {
          console.log(`[BUY_FIXED] Starting executeBuyHelper: user=${telegramId}, token=${tokenAddress}, amount=${amountVal} ${unit}`);
          const res = await executeBuyHelper(telegramId, tokenAddress, amountVal, onStage);
          console.log(`[BUY_FIXED] Success: user=${telegramId}, token=${tokenAddress}, pos=${res.positionId}`);
          if (procMsg) await ctx.deleteMessage(procMsg.message_id).catch(() => {});

          await ctx.reply(res.message, {
            parse_mode: 'Markdown',
            reply_markup: await buildBuySuccessKeyboard(telegramId, tokenAddress, res.tokenSymbol, res.positionId),
          }).catch(async () => {
            await ctx.reply(res.message.replace(/[*_`]/g, ''), {
              reply_markup: await buildBuySuccessKeyboard(telegramId, tokenAddress, res.tokenSymbol, res.positionId),
            }).catch(() => {});
          });
          if (res.positionId) {
            await sendPostBuySlTpPrompt(ctx, res.positionId, tokenAddress, res.tokenSymbol).catch(() => {});
          }
        } catch (err: any) {
          console.error(`[BUY_FIXED] Failed: user=${telegramId}, token=${tokenAddress}, error=${err?.message}`, err);
          if (procMsg) await ctx.deleteMessage(procMsg.message_id).catch(() => {});
          await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => {});
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
      await ctx.answerCbQuery(getUserFriendlyError(outerErr)).catch(() => {});
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
      const isSui = isSuiToken(tokenAddress);
      const unit = isSui ? 'SUI' : 'NEAR';
      console.log(`[BUY_PCT] Click: user=${telegramId}, token=${tokenAddress}, pct=${pct}%`);

      const guardKey = inFlightKey(telegramId, tokenAddress, 'buy');
      if (!(await tryAcquireInFlight(guardKey))) {
        console.warn(`[BUY_PCT] Duplicate tap rejected: guardKey=${guardKey}`);
        await ctx.answerCbQuery('A trade for this token is already in progress.').catch(() => {});
        return;
      }
      await ctx.answerCbQuery(`⚡ Processing buy order for ${pct}% of balance...`).catch(() => {});

      (async () => {
        const procMsg = await ctx.reply(`⏳ *Processing Buy Order (${pct}%)...*\n\nExchanging ${unit} for \`${tokenAddress}\`...\n_Executing swap on DEX..._`, { parse_mode: 'Markdown' }).catch(() => null);
        const onStage = makeStageEditor(ctx, procMsg, `Processing Buy Order (${pct}%)`);
        try {
          console.log(`[BUY_PCT] Starting executeBuyPctHelper: user=${telegramId}, token=${tokenAddress}, pct=${pct}%`);
          const res = await executeBuyPctHelper(telegramId, tokenAddress, pct, onStage);
          console.log(`[BUY_PCT] Success: user=${telegramId}, token=${tokenAddress}, pos=${res.positionId}`);
          if (procMsg) await ctx.deleteMessage(procMsg.message_id).catch(() => {});

          await ctx.reply(res.message, {
            parse_mode: 'Markdown',
            reply_markup: await buildBuySuccessKeyboard(telegramId, tokenAddress, res.tokenSymbol, res.positionId),
          }).catch(async () => {
            await ctx.reply(res.message.replace(/[*_`]/g, ''), {
              reply_markup: await buildBuySuccessKeyboard(telegramId, tokenAddress, res.tokenSymbol, res.positionId),
            }).catch(() => {});
          });
          if (res.positionId) {
            await sendPostBuySlTpPrompt(ctx, res.positionId, tokenAddress, res.tokenSymbol).catch(() => {});
          }
        } catch (err: any) {
          console.error(`[BUY_PCT] Failed: user=${telegramId}, token=${tokenAddress}, error=${err?.message}`, err);
          if (procMsg) await ctx.deleteMessage(procMsg.message_id).catch(() => {});
          await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => {});
        } finally {
          await releaseInFlight(guardKey);
        }
      })().catch(async (err: any) => {
        await releaseInFlight(guardKey);
        console.error('[BUY] Unhandled detached pct-buy error:', err?.message || err);
      });
    } catch (outerErr: any) {
      console.error('[BUY_PCT] Outer handler error:', outerErr);
      await ctx.answerCbQuery(getUserFriendlyError(outerErr)).catch(() => {});
    }
  });

  // Custom buy prompt button
  bot.action(/^buy_custom_prompt:(.+)$/, async (ctx) => {
    try {
      const rawTokenParam = ctx.match![1];
      const tokenAddress = resolveTokenAddressFromKey(rawTokenParam);
      const telegramId = ctx.from!.id;
      const isSui = isSuiToken(tokenAddress);
      const unit = isSui ? 'SUI' : 'NEAR';
      userPendingActions.set(telegramId, {
        action: 'buy_custom_near',
        tokenAddress,
        expiresAt: Date.now() + 180000,
      });
      await ctx.answerCbQuery().catch(() => {});
      await ctx.reply(
        `✏️ *Custom Buy Amount*\n\n` +
        `Token: \`${tokenAddress}\`\n\n` +
        `Reply with the amount in ${unit} you want to buy (e.g. \`2.5\`):\n` +
        `_Type /cancel to abort._`,
        { parse_mode: 'Markdown' }
      ).catch(async () => {
        await ctx.reply(
          `Custom Buy Amount\n\nToken: ${tokenAddress}\n\nReply with the amount in ${unit} you want to buy (e.g. 2.5):\nType /cancel to abort.`
        ).catch(() => {});
      });
    } catch (outerErr: any) {
      console.error('[BUY_CUSTOM_PROMPT] Outer handler error:', outerErr);
      await ctx.answerCbQuery(getUserFriendlyError(outerErr)).catch(() => {});
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
    const isSui = isSuiToken(tokenAddress);
    const unit = isSui ? 'SUI' : 'NEAR';
    const amountVal = parseFloat(args[1] ?? '0');

    if (amountVal <= 0) {
      try {
        const card = await buildTokenCard(tokenAddress, telegramId);
        prewarmTradePath(telegramId, tokenAddress).catch(() => {});
        await sendTokenCard(ctx, card);
      } catch {
        await ctx.reply(`Specify amount in ${unit}: /buy <token_ca> <amount>`);
      }
      return;
    }

    const guardKey = inFlightKey(telegramId, tokenAddress, 'buy');
    if (!(await tryAcquireInFlight(guardKey))) {
      await ctx.answerCbQuery('A trade for this token is already in progress.').catch(() => {});
      return;
    }

    (async () => {
      const procMsg = await ctx.reply(`⏳ *Processing Buy Order...*\n\nExchanging \`${amountVal} ${unit}\` for \`${tokenAddress}\`...\n_Executing swap on DEX..._`, { parse_mode: 'Markdown' }).catch(() => null);
      const onStage = makeStageEditor(ctx, procMsg, 'Processing Buy Order');
      try {
        const res = await executeBuyHelper(telegramId, tokenAddress, amountVal, onStage);
        if (procMsg) await ctx.deleteMessage(procMsg.message_id).catch(() => {});

        await ctx.reply(res.message, {
          parse_mode: 'Markdown',
          reply_markup: await buildBuySuccessKeyboard(telegramId, tokenAddress, res.tokenSymbol, res.positionId),
        });
        if (res.positionId) {
          await sendPostBuySlTpPrompt(ctx, res.positionId, tokenAddress, res.tokenSymbol);
        }
      } catch (err: any) {
        if (procMsg) await ctx.deleteMessage(procMsg.message_id).catch(() => {});
        await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => {});
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

        await ctx.reply(
          `📊 *${tokenLabel}*\n` +
          `📦 Holding: \`${pos.quantity_held}\`\n` +
          `📥 Avg Entry: \`${parseFloat(pos.avg_entry_price).toFixed(8)} NEAR\`\n` +
          `💰 Current: \`${currentPrice.toFixed(8)} NEAR\`\n` +
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
      if (!user) { await ctx.answerCbQuery('Wallet not found.').catch(() => {}); return; }

      const position = await getPositionById(positionId).catch(() => null);
      if (!position || position.user_id !== user.id) {
        await ctx.answerCbQuery('Position not found.').catch(() => {});
        return;
      }
      const tokenAddress = position.token_address;

      const guardKey = inFlightKey(telegramId, tokenAddress, 'sell');
      if (!(await tryAcquireInFlight(guardKey))) {
        await ctx.answerCbQuery('A trade for this token is already in progress.').catch(() => {});
        return;
      }
      await ctx.answerCbQuery(`⚡ Processing sell order (${pct}%)...`).catch(() => {});

      (async () => {
        const procMsg = await ctx.reply(`⏳ *Processing Sell Order (${pct}%)...*\n\nSelling position on DEX...\n_Executing swap on DEX..._`, { parse_mode: 'Markdown' }).catch(() => null);
        const onStage = makeStageEditor(ctx, procMsg, `Processing Sell Order (${pct}%)`);

        let result: { success: boolean; reason?: string } = { success: false, reason: 'Unknown error' };
        try {
          console.log(`[SELL] Starting sellAtTarget: user=${user.id}, positionId=${positionId}, pct=${pct}%, token=${tokenAddress}`);
          result = await sellAtTarget(user.id, positionId, pct, onStage);
          console.log(`[SELL] sellAtTarget completed: user=${user.id}, success=${result.success}, reason=${result.reason || 'ok'}`);
        } catch (err: any) {
          console.error(`[SELL] sellAtTarget threw: user=${user.id}, error=${err?.message}`, err);
          result = { success: false, reason: err.message || 'Swap execution failed' };
        } finally {
          if (procMsg) await ctx.deleteMessage(procMsg.message_id).catch(() => {});
          await releaseInFlight(guardKey);
        }

        if (result.success) {
          await sendPnlCardMessage(ctx, positionId, `✅ *Sell Order Executed!* (${pct}%)`).catch(() => {});
        } else {
          await ctx.reply(`❌ Sell failed: ${result.reason || 'Unknown error'}`).catch(() => {});
        }
      })().catch(async (err: any) => {
        await releaseInFlight(guardKey);
        console.error('[SELL] Unhandled detached sell error:', err?.message || err);
        ctx.reply('❌ Sell failed unexpectedly. Please check /positions and retry.').catch(() => {});
      });
    } catch (outerErr: any) {
      console.error('[SELL] Outer handler error:', outerErr);
      await ctx.answerCbQuery(getUserFriendlyError(outerErr)).catch(() => {});
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
      const amountNear = parseFloat(args[1] ?? user.auto_buy_amount_near?.toString() ?? '1');

      if (amountNear <= 0) {
        await ctx.reply('Specify amount: /snipe <token> <amount_near>');
        return;
      }

      const isCA = query.includes('.near') || query.length === 64;

      if (isCA) {
        const info = await getTokenInfo(query, false).catch(() => null);
        if (info?.tradeable) {
          await ctx.reply(`⚡ Sniping \`${query}\` with ${amountNear} NEAR...`, { parse_mode: 'Markdown' });
          try {
            const res = await executeBuyHelper(telegramId, query, amountNear);
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
              }).catch(() => null);
              if (order) {
                prewarmStorageDeposit(user, query).catch(() => {});
                await ctx.reply(
                  `🎯 *Snipe Armed!*\n\n` +
                  `🪙 Token: \`${query}\`\n` +
                  `💰 Amount: \`${amountNear} NEAR\`\n\n` +
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
          });
          prewarmStorageDeposit(user, query).catch(() => {});
          await ctx.reply(
            `🎯 *Snipe Armed!*\n\n` +
            `🪙 Token: \`${query}\`\n` +
            `💰 Amount: \`${amountNear} NEAR\`\n\n` +
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
          `Found: *${match}* (${sanitizeMd(tokenData.symbol)})\nCA: \`${tokenData.address}\`\n\nSnipe ${amountNear} NEAR?`,
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

    await ctx.answerCbQuery('Processing snipe order...').catch(() => {});
    const snipeMsgId = (ctx.callbackQuery as any)?.message?.message_id ?? null;
    await ctx.editMessageText(`⏳ *Processing Snipe Order...*\n\nExchanging \`${amountNear} NEAR\` for \`${tokenAddress}\`...\n_Executing swap on DEX..._`, { parse_mode: 'Markdown' }).catch(() => {});
    const onStage = makeStageEditor(ctx, snipeMsgId ? { message_id: snipeMsgId } : null, 'Processing Snipe Order');
    try {
      const res = await executeBuyHelper(telegramId, tokenAddress, amountNear, onStage);
      await ctx.deleteMessage().catch(() => {});

      await ctx.reply(res.message, {
        parse_mode: 'Markdown',
        reply_markup: await buildBuySuccessKeyboard(telegramId, tokenAddress, res.tokenSymbol, res.positionId),
      });
      if (res.positionId) {
        await sendPostBuySlTpPrompt(ctx, res.positionId, tokenAddress, res.tokenSymbol);
      }
    } catch (err: any) {
      await ctx.editMessageText(`❌ ${getUserFriendlyError(err)}`).catch(() => {});
    }
  });

  bot.action('snipe_cancel', async (ctx) => {
    await ctx.answerCbQuery('Cancelled.').catch(() => {});
    await ctx.editMessageText('Snipe cancelled.').catch(() => {});
  });

  // ── /export & /rotatekey ──────────────────────────────────────────────────
  const handleExportPrompt = async (ctx: Context) => {
    const telegramId = ctx.from!.id;
    try {
      const user = await getUserByTelegramId(telegramId).catch(() => null);
      if (!user) {
        await ctx.reply('Use /start to set up your wallet first.');
        return;
      }

      const last = lastExportTime.get(telegramId);
      if (last && Date.now() - last < EXPORT_COOLDOWN_MS) {
        const remainingSec = Math.ceil((EXPORT_COOLDOWN_MS - (Date.now() - last)) / 1000);
        await ctx.reply(`⏳ Export is on cooldown. Please wait ${remainingSec}s before requesting again.`);
        return;
      }

      await ctx.reply(
        `⚠️ *Export Private Keys*\n\n` +
        `This will reveal private keys for *NEAR* (\`${user.subaccount_id}\`)${user.sui_address ? ` and *SUI* (\`${user.sui_address}\`)` : ''}.\n\n` +
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
    await ctx.answerCbQuery('Export cancelled.').catch(() => {});
    await ctx.editMessageText('Export cancelled.').catch(() => {});
  });

  bot.action('export_confirm', async (ctx) => {
    const telegramId = ctx.from!.id;
    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) {
      await ctx.answerCbQuery('Wallet not found.').catch(() => {});
      return;
    }

    const last = lastExportTime.get(telegramId);
    if (last && Date.now() - last < EXPORT_COOLDOWN_MS) {
      const remainingSec = Math.ceil((EXPORT_COOLDOWN_MS - (Date.now() - last)) / 1000);
      await ctx.answerCbQuery(`Cooldown active. Wait ${remainingSec}s.`).catch(() => {});
      await ctx.editMessageText(`⏳ Export is on cooldown. Please wait ${remainingSec}s before requesting again.`).catch(() => {});
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
        } catch {}
      }

      await ctx.answerCbQuery('Keys decrypted.').catch(() => {});

      let keyHtml =
        `🔑 <b>NEAR Private Key</b>${nearName} (<code>${user.subaccount_id}</code>):\n` +
        `<tg-spoiler><code>${rawNearKey}</code></tg-spoiler>\n\n`;

      if (user.sui_address && rawSuiKey) {
        keyHtml +=
          `🔷 <b>SUI Private Key</b>${suiName} (<code>${user.sui_address}</code>):\n` +
          `<tg-spoiler><code>${rawSuiKey}</code></tg-spoiler>\n\n`;
      }

      keyHtml +=
        `👆 <i>Tap the covered boxes above to uncover and copy your keys.</i>\n\n` +
        `⚠️ <i>This message will automatically delete in 2 minutes for security.</i>`;

      const keyMessage = await ctx.reply(keyHtml, { parse_mode: 'HTML' });

      await ctx.reply(
        `🛡️ *Security Reminder*:\n` +
        `• Keep your private keys confidential.\n` +
        `• Import into MyNearWallet/Meteor (NEAR) or Sui Wallet (SUI) to manage outside RacerBot.`,
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
    await ctx.answerCbQuery('Cancelled.').catch(() => {});
    await ctx.editMessageText('Key rotation cancelled.').catch(() => {});
  });

  bot.action('rotate_confirm', async (ctx) => {
    const telegramId = ctx.from!.id;
    await ctx.answerCbQuery('Rotating key on-chain...').catch(() => {});
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
        await ctx.answerCbQuery('Please run /start first.').catch(() => {});
        return;
      }
      if (!user.referral_code) {
        const username = ctx.from!.username || 'user';
        const code = await generateReferralCode(user.id, username);
        user.referral_code = code;
      }
      const view = await buildReferralView(user);
      await ctx.answerCbQuery('🔄 Updated!').catch(() => {});
      await ctx.editMessageText(view.text, { parse_mode: 'Markdown', ...view.keyboard }).catch((err: any) => {
        if (!err?.message?.includes('message is not modified')) {
          ctx.reply(view.text, { parse_mode: 'Markdown', ...view.keyboard }).catch(() => {});
        }
      });
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => {});
    }
  });

  // ── referral_claim — Pay accrued rewards from treasury ($10 minimum) ───────
  bot.action('referral_claim', async (ctx) => {
    const telegramId = ctx.from!.id;
    const guardKey = `referral_claim:${telegramId}`;
    if (!(await tryAcquireInFlight(guardKey))) {
      await ctx.answerCbQuery('Claim already in progress — please wait.').catch(() => {});
      return;
    }
    try {
      const user = await getUserByTelegramId(telegramId).catch(() => null);
      if (!user) {
        await ctx.answerCbQuery('Please run /start first.').catch(() => {});
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
        await ctx.answerCbQuery('No rewards to claim yet — share your link to start earning!').catch(() => {});
        return;
      }

      const nearUsd = await getNearUsdPrice();
      const claimableUsd = claimableNear * nearUsd;
      if (claimableUsd < REFERRAL_CLAIM_MIN_USD) {
        await ctx.answerCbQuery(
          `Minimum claim is $${REFERRAL_CLAIM_MIN_USD} — you have $${claimableUsd.toFixed(2)} (${claimableNear.toFixed(4)} NEAR).`
        ).catch(() => {});
        return;
      }

      await ctx.answerCbQuery('💸 Processing your claim...').catch(() => {});

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
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => {});
    } finally {
      await releaseInFlight(guardKey);
    }
  });

  // ── /audit & /scan & /honeypot: Deep Contract Safety & Honeypot Analysis ──
  bot.command(['audit', 'scan', 'honeypot'], async (ctx) => {
    const rawText = ctx.message.text.trim();
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
      if (loading) await ctx.deleteMessage(loading.message_id).catch(() => {});
      await ctx.reply(card.text, { parse_mode: 'Markdown', ...card.keyboard });
    } catch (err: any) {
      if (loading) await ctx.deleteMessage(loading.message_id).catch(() => {});
      await ctx.reply(`❌ Security audit failed: ${getUserFriendlyError(err)}`).catch(() => {});
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
      await ctx.answerCbQuery().catch(() => {});
      await ctx.deleteMessage().catch(async () => {
        await ctx.editMessageText('🛡️ _SL/TP setup skipped. You can always set them from /positions anytime._', { parse_mode: 'Markdown' }).catch(() => {});
      });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => {});
    }
  });

  // SL/TP Combined Hub Menu
  bot.action(/^sl_tp_menu:([^:]+)$/, async (ctx) => {
    try {
      const positionId = ctx.match![1];
      const telegramId = ctx.from!.id;
      await ctx.answerCbQuery().catch(() => {});

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
        }).catch(() => {});
      });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => {});
    }
  });

  // Stop Loss prompt with preset level buttons
  bot.action(/^sl_prompt:([^:]+)$/, async (ctx) => {
    try {
      const positionId = ctx.match![1];
      const telegramId = ctx.from!.id;
      await ctx.answerCbQuery().catch(() => {});

      const user = await getUserByTelegramId(telegramId).catch(() => null);
      if (!user) return;

      const position = await getPositionById(positionId).catch(() => null);
      if (!position || position.user_id !== user.id) {
        await ctx.reply('Position not found.').catch(() => {});
        return;
      }

      const [info, triggers] = await Promise.all([
        getTokenInfo(position.token_address, false).catch(() => null),
        getTriggersByPosition(positionId).catch(() => []),
      ]);

      const symbol = info?.symbol ? sanitizeMd(info.symbol) : 'Token';
      const isSuiPos = position.chain === 'sui' || isSuiToken(position.token_address);
      const nativeUnit = isSuiPos ? 'SUI' : 'NEAR';
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
        }).catch(() => {});
      });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => {});
    }
  });

  // Take Profit prompt with preset target buttons
  bot.action(/^tp_prompt:([^:]+)$/, async (ctx) => {
    try {
      const positionId = ctx.match![1];
      const telegramId = ctx.from!.id;
      await ctx.answerCbQuery().catch(() => {});

      const user = await getUserByTelegramId(telegramId).catch(() => null);
      if (!user) return;

      const position = await getPositionById(positionId).catch(() => null);
      if (!position || position.user_id !== user.id) {
        await ctx.reply('Position not found.').catch(() => {});
        return;
      }

      const [info, triggers] = await Promise.all([
        getTokenInfo(position.token_address, false).catch(() => null),
        getTriggersByPosition(positionId).catch(() => []),
      ]);

    const symbol = info?.symbol ? sanitizeMd(info.symbol) : 'Token';
    const isSuiPos = position.chain === 'sui' || isSuiToken(position.token_address);
    const nativeUnit = isSuiPos ? 'SUI' : 'NEAR';
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
      }).catch(() => {});
    });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => {});
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
      await ctx.answerCbQuery().catch(() => {});

      const user = await getUserByTelegramId(telegramId).catch(() => null);
      if (!user) return;

      const position = await getPositionById(positionId).catch(() => null);
      if (!position || position.user_id !== user.id) {
        await ctx.reply('Position not found.').catch(() => {});
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
          }).catch(() => {});
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
      const isSuiPos = position.chain === 'sui' || isSuiToken(position.token_address);
      const nativeUnit = isSuiPos ? 'SUI' : 'NEAR';
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
        }).catch(() => {});
      });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => {});
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
      await ctx.answerCbQuery().catch(() => {});

      const user = await getUserByTelegramId(telegramId).catch(() => null);
      if (!user) return;

      const position = await getPositionById(positionId).catch(() => null);
      if (!position || position.user_id !== user.id) {
        await ctx.reply('Position not found.').catch(() => {});
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
          }).catch(() => {});
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
      const isSuiPos = position.chain === 'sui' || isSuiToken(position.token_address);
      const nativeUnit = isSuiPos ? 'SUI' : 'NEAR';
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
        }).catch(() => {});
      });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => {});
    }
  });

  // Action: Cancel Stop Loss
  bot.action(/^cancel_sl:([^:]+)$/, async (ctx) => {
    try {
      const positionId = ctx.match![1];
      const telegramId = ctx.from!.id;
      await ctx.answerCbQuery('Stop Loss cancelled.').catch(() => {});

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
        }).catch(() => {});
      });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => {});
    }
  });

  // Action: Cancel Take Profit
  bot.action(/^cancel_tp:([^:]+)$/, async (ctx) => {
    try {
      const positionId = ctx.match![1];
      const telegramId = ctx.from!.id;
      await ctx.answerCbQuery('Take Profit cancelled.').catch(() => {});

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
        }).catch(() => {});
      });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => {});
    }
  });

  // Action: Prompt Custom Stop Loss
  bot.action(/^sl_custom_prompt:([^:]+)$/, async (ctx) => {
    try {
      const positionId = ctx.match![1];
      const telegramId = ctx.from!.id;
      await ctx.answerCbQuery().catch(() => {});

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
        ).catch(() => {});
      });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => {});
    }
  });

  // Action: Prompt Custom Take Profit
  bot.action(/^tp_custom_prompt:([^:]+)$/, async (ctx) => {
    try {
      const positionId = ctx.match![1];
      const telegramId = ctx.from!.id;
      await ctx.answerCbQuery().catch(() => {});

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
        ).catch(() => {});
      });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => {});
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
    const rawText = ctx.message.text.trim();
    if (rawText.startsWith('/')) return; // Handled by command dispatch

    const telegramId = ctx.from.id;

    // 1. Process active pending user prompt (e.g. custom buy, custom slippage, withdraw)
    const pending = userPendingActions.get(telegramId);
    if (pending && Date.now() < pending.expiresAt) {
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
        await ctx.deleteMessage().catch(() => {});

        const parts = rawText.split(/\s+/).filter(Boolean);
        let explicitAccount: string | undefined;
        let keyString = rawText;

        if (parts.length >= 2) {
          explicitAccount = parts[0].toLowerCase();
          keyString = parts[1];
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

        try {
          const res = await importNearWallet(
            telegramId,
            pending.importNearPrivateKey,
            walletName,
            pending.importNearAccountId
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
        await ctx.deleteMessage().catch(() => {});

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

        try {
          const res = await importSuiWallet(
            telegramId,
            pending.importSuiPrivateKey,
            walletName
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

      if (pending.action === 'buy_custom_near' && pending.tokenAddress) {
        const amt = parseFloat(rawText);
        if (isNaN(amt) || amt <= 0) {
          await ctx.reply('❌ Invalid amount. Buy cancelled.');
          return;
        }
        const tokenAddress = pending.tokenAddress;
        const isSui = isSuiToken(tokenAddress);
        const unit = isSui ? 'SUI' : 'NEAR';
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
            if (procMsg) await ctx.deleteMessage(procMsg.message_id).catch(() => {});

            await ctx.reply(res.message, {
              parse_mode: 'Markdown',
              reply_markup: await buildBuySuccessKeyboard(telegramId, tokenAddress, res.tokenSymbol, res.positionId),
            });
            if (res.positionId) {
              await sendPostBuySlTpPrompt(ctx, res.positionId, tokenAddress, res.tokenSymbol);
            }
          } catch (err: any) {
            console.warn(`[BUY] Buy failed for ${tokenAddress}:`, err?.message || err);
            if (procMsg) await ctx.deleteMessage(procMsg.message_id).catch(() => {});
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
            if (procMsg) await ctx.deleteMessage(procMsg.message_id).catch(() => {});
            if (result.success) {
              await sendPnlCardMessage(
                ctx,
                positionId,
                `✅ *Successfully sold \`${tokensToSell.toLocaleString()} ${sym}\` (\`${percentage.toFixed(1)}%\`)!*`
              ).catch(() => {});
            } else {
              await ctx.reply(`❌ Sell failed: ${result.reason || 'Unknown error'}`).catch(() => {});
            }
          } catch (err: any) {
            if (procMsg) await ctx.deleteMessage(procMsg.message_id).catch(() => {});
            console.error('[SELL_CUSTOM] Error:', err);
            await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => {});
          } finally {
            await releaseInFlight(guardKey);
          }
        })().catch(async (err: any) => {
          await releaseInFlight(guardKey);
          console.error('[SELL_CUSTOM] Unhandled detached error:', err?.message || err);
        });
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
        if (isNaN(amt) || amt <= 0) {
          await ctx.reply('❌ Invalid amount. Must be a positive number in NEAR.');
          return;
        }
        const user = await getUserByTelegramId(telegramId);
        if (user) {
          const updated = await updateUserSettings(user.id, { auto_buy_amount_near: amt });
          await ctx.reply(`✅ Auto-buy amount updated to ${amt} NEAR!`);
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
        const ca = rawText.toLowerCase();
        if (!isValidNearAccountId(ca)) {
          await ctx.reply('❌ That does not look like a valid NEAR contract address. Try again (e.g. `token.nearlytrade.near`) or /cancel.', { parse_mode: 'Markdown' });
          userPendingActions.set(telegramId, { action: 'snipe_token_ca', expiresAt: Date.now() + 120_000 });
          return;
        }
        const meta = await near.getTokenMetadata(ca).catch(() => null);
        if (!meta?.name && !meta?.symbol) {
          await ctx.reply('❌ No token found at that contract address on-chain. Check the CA and try again, or /cancel.');
          userPendingActions.set(telegramId, { action: 'snipe_token_ca', expiresAt: Date.now() + 120_000 });
          return;
        }
        userPendingActions.set(telegramId, { action: 'snipe_token_amount', tokenAddress: ca, expiresAt: Date.now() + 120_000 });
        await ctx.reply(
          `🪙 Token found: *${meta.name}* (${meta.symbol})\n\nReply with the amount in NEAR to snipe (e.g. \`2.5\`):\nType /cancel to abort.`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      if (pending.action === 'snipe_token_amount' && pending.tokenAddress) {
        const amt = parseFloat(rawText);
        if (isNaN(amt) || amt <= 0) {
          await ctx.reply('❌ Invalid amount. Must be a positive number in NEAR. Snipe setup cancelled.');
          return;
        }
        const user = await getUserByTelegramId(telegramId);
        if (!user) {
          await ctx.reply('Use /start to set up your wallet first.');
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
          `💰 Amount: \`${amt} NEAR\`\n` +
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

      if (pending.action === 'snipe_dev_addr') {
        const dev = rawText.toLowerCase();
        if (!isValidNearAccountId(dev)) {
          await ctx.reply('❌ Invalid NEAR wallet address. Try again (e.g. `someuser.near`) or /cancel.', { parse_mode: 'Markdown' });
          userPendingActions.set(telegramId, { action: 'snipe_dev_addr', expiresAt: Date.now() + 120_000 });
          return;
        }
        userPendingActions.set(telegramId, { action: 'snipe_dev_amount', deployerAddress: dev, expiresAt: Date.now() + 120_000 });
        await ctx.reply(
          `👤 Deployer: \`${dev}\`\n\nReply with the amount in NEAR to snipe *every* new token this wallet launches (e.g. \`1.5\`):\nType /cancel to abort.`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      if (pending.action === 'snipe_dev_amount' && pending.deployerAddress) {
        const amt = parseFloat(rawText);
        if (isNaN(amt) || amt <= 0) {
          await ctx.reply('❌ Invalid amount. Must be a positive number in NEAR. Snipe setup cancelled.');
          return;
        }
        const user = await getUserByTelegramId(telegramId);
        if (!user) {
          await ctx.reply('Use /start to set up your wallet first.');
          return;
        }
        const activeCount = await countActiveSnipeOrders(user.id).catch(() => 0);
        if (activeCount >= MAX_ACTIVE_SNIPE_ORDERS_PER_USER) {
          await ctx.reply(`❌ You already have ${MAX_ACTIVE_SNIPE_ORDERS_PER_USER} active snipe orders. Cancel one in 🎯 Snipe Rules → 📋 My Snipe Orders.`);
          return;
        }
        const order = await createSnipeOrder({
          user_id: user.id,
          snipe_type: 'deployer',
          deployer_address: pending.deployerAddress,
          amount_near: amt,
        });
        await ctx.reply(
          `👤 *Deployer Snipe Armed!*\n\n` +
          `🧑‍💻 Deployer: \`${pending.deployerAddress}\`\n` +
          `💰 Amount per launch: \`${amt} NEAR\`\n\n` +
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

        const isExplicitToken = tokenToUse && tokenToUse.toLowerCase() !== 'near' && tokenToUse.toLowerCase() !== 'sui';
        const targetDesc = isExplicitToken ? `token \`${tokenToUse}\`` : 'funds';
        await ctx.reply(`⏳ Processing transfer of ${targetDesc} to \`${dest}\`...`, { parse_mode: 'Markdown' });

        try {
          const isSuiDest = isValidSuiAddress(dest) && !dest.endsWith('.near');
          if (isExplicitToken) {
            const result = await withdrawTokenFunds(telegramId, tokenToUse, dest, amt);
            const explorerUrl = result.chain === 'sui'
              ? `https://suiscan.xyz/mainnet/tx/${result.txHash}`
              : `https://nearblocks.io/txns/${result.txHash}`;
            const explorerName = result.chain === 'sui' ? 'Suiscan' : 'NearBlocks';

            await ctx.reply(
              `✅ *Token Transfer Successful!*\n\n` +
              `💸 Amount: \`${result.amountWithdrawn} ${result.symbol}\`\n` +
              `📬 Destination: \`${result.destination}\`\n` +
              `🪙 Contract: \`${result.tokenAddress}\`\n\n` +
              `🔗 Explorer: [View on ${explorerName}](${explorerUrl})`,
              { parse_mode: 'Markdown' }
            );
          } else if (isSuiDest) {
            const result = await withdrawSuiFunds(telegramId, dest, amt);
            await ctx.reply(
              `✅ *SUI Withdrawal Successful!*\n\n` +
              `💸 Amount: \`${result.amountWithdrawn} SUI\`\n` +
              `📬 Destination: \`${result.destination}\`\n\n` +
              `🔗 Explorer: [View on Suiscan](https://suiscan.xyz/mainnet/tx/${result.txHash})`,
              { parse_mode: 'Markdown' }
            );
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

        const validatingMsg = await ctx.reply(`🔍 *Validating Token contract:* \`${tokenCA}\`...`, { parse_mode: 'Markdown' }).catch(() => null);

        // Step 1: Validate NEP-141 contract via ft_metadata
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
            `Address \`${tokenCA}\` does not appear to be a valid NEP-141 contract.\n\n` +
            `_Details: ${sanitizeMd(err.message || 'Metadata query failed')}_`,
            { parse_mode: 'Markdown' }
          );
          return;
        }

        // Step 2: Query user's real on-chain balance via ft_balance_of (pinned
        // trade RPC — hedged read RPCs can lag a block and return stale balances)
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

        // Step 3: Fetch current price for baseline cost basis
        let currentPrice = 0;
        let tokenInfo: any = null;
        try {
          tokenInfo = await getTokenInfo(tokenCA);
          currentPrice = tokenInfo?.price || 0;
        } catch {
          // If price lookup fails, currentPrice remains 0
        }

        const decimals = metadata.decimals ?? 18;
        const humanBalance = (Number(balanceBigInt) / Math.pow(10, decimals)).toLocaleString(undefined, {
          maximumFractionDigits: 4,
        });

        // Step 4: Check if position already exists for this user and token
        const existingPositions = await getOpenPositions(user.id).catch(() => []);
        const existing = existingPositions.find(p => p.token_address === tokenCA);

        if (existing) {
          // Update quantity_held without touching avg_entry_price
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

        // Step 5: Create new position with quantity_held and current price baseline
        await createPosition({
          user_id: user.id,
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
        const tokenCA = rawText.trim().toLowerCase();
        if (!isValidNearAccountId(tokenCA)) {
          await ctx.reply('❌ Invalid contract address. Please enter a valid NEAR token address (e.g. `wrap.near` or `token.near`).');
          return;
        }
        userPendingActions.delete(telegramId);
        await ctx.reply(
          `🪙 *DCA Strategy for \`${tokenCA}\`*\n\n` +
          `Choose whether to accumulate (buy with NEAR) or take-profit / de-risk (sell to NEAR):`,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [cb('🟢 Accumulate (Buy with NEAR)', `dca_choose_side:buy:${tokenCA}`, 'success')],
              [cb('🔴 De-Risk (Sell to NEAR)', `dca_choose_side:sell:${tokenCA}`, 'danger')],
              [cb('🔙 Cancel', 'menu_dca', 'primary')],
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
        userPendingActions.set(telegramId, {
          action: 'copy_amount',
          copyWallet: wallet,
          copyReferrerId: pending.copyReferrerId,
          expiresAt: Date.now() + 5 * 60_000,
        });
        await ctx.reply(
          `✅ Target wallet: \`${wallet}\`\n\n💰 *How much NEAR should I spend each time this wallet buys?*\n\n` +
          `Reply with a number (e.g. \`2\`):`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      if (pending.action === 'copy_amount') {
        const amt = parseFloat(rawText);
        if (isNaN(amt) || amt < 0.1 || amt > 10000) {
          await ctx.reply('❌ Invalid amount. Must be between 0.1 and 10,000 NEAR.');
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
          `✅ Buy amount: \`${amt} NEAR\` per trade\n\n🛡️ *Set a daily spending cap* (optional safety limit).\n\n` +
          `Reply with max NEAR per day (e.g. \`20\`), or \`skip\` for unlimited:`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      if (pending.action === 'copy_daily_budget') {
        const isSkip = rawText.trim().toLowerCase() === 'skip';
        const budget = isSkip ? null : parseFloat(rawText);
        if (!isSkip && (isNaN(budget!) || budget! < 0.1)) {
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
          `💰 *Buy Amount*: \`${target.buy_amount_near} NEAR\` per trade\n` +
          `🛡️ *Daily Cap*: ${budget !== null ? `\`${budget} NEAR\`` : 'Unlimited'}\n` +
          `📊 *Sell Mirroring*: ✅ On\n\n` +
          `RacerBot will now automatically copy every swap this wallet makes on NEAR DEXes. You'll get a DM for every fill.\n\n` +
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
        await ctx.reply(
          `✅ Amount per order: \`${amt} ${pending.dcaSide === 'buy' ? 'NEAR' : 'tokens'}\`\n\n` +
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
        await ctx.reply(
          `🔁 *DCA Order Created!*\n\n` +
          `🪙 *Token*: \`${order.token_address}\`\n` +
          `📊 *Mode*: ${order.side === 'buy' ? '🟢 Accumulate (Buy with NEAR)' : '🔴 De-Risk (Sell to NEAR)'}\n` +
          `💵 *Amount per tick*: \`${order.amount_per_order} ${order.side === 'buy' ? 'NEAR' : 'tokens'}\`\n` +
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
        const val = parseFloat(rawText.replace(/[$,]/g, ''));
        if (isNaN(val) || val <= 0) {
          await ctx.reply('❌ Invalid value. Enter a positive number (e.g. `0.001` for price, `50000` for market cap, or `25` for +25%).');
          return;
        }
        userPendingActions.set(telegramId, {
          ...pending,
          action: 'lo_amount',
          loTargetValue: val,
          expiresAt: Date.now() + 5 * 60_000,
        });
        const condLabel = pending.loConditionType === 'price' ? 'Price' : pending.loConditionType === 'market_cap' ? 'Market Cap' : '% Change';
        await ctx.reply(
          `✅ Target ${condLabel}: \`${val}\`\n\n` +
          `💰 *How much NEAR ${pending.loSide === 'buy' ? 'to spend' : 'worth of tokens to sell'}?*\n\n` +
          `Reply with a number (e.g. \`5\` for 5 NEAR):`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // ── Limit Order wizard: amount input ─────────────────────────────────
      if (pending.action === 'lo_amount') {
        const amt = parseFloat(rawText);
        if (isNaN(amt) || amt < 0.01) {
          await ctx.reply('❌ Invalid amount. Must be ≥ 0.01 NEAR.');
          return;
        }
        userPendingActions.set(telegramId, {
          ...pending,
          loAmount: amt,
          expiresAt: Date.now() + 5 * 60_000,
        });
        const shortKey = getShortTokenKey(pending.loTokenAddress!);
        await ctx.reply(
          `✅ Amount: \`${amt} NEAR\`\n\n` +
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
    }

    // 1.5. Implicit Withdrawal Format Detection (<destination> <amount|all>)
    const withdrawParts = rawText.trim().split(/\s+/);
    if (withdrawParts.length === 2) {
      const possibleDest = withdrawParts[0];
      const possibleAmtStr = withdrawParts[1].toLowerCase();
      const isNearDest = isValidNearAccountId(possibleDest);
      const isSuiDest = isValidSuiAddress(possibleDest) && !possibleDest.endsWith('.near');
      const isAmtValid = possibleAmtStr === 'all' || (!isNaN(parseFloat(possibleAmtStr)) && parseFloat(possibleAmtStr) > 0);

      if ((isNearDest || isSuiDest) && isAmtValid) {
        const amt: number | 'all' = possibleAmtStr === 'all' ? 'all' : parseFloat(possibleAmtStr);
        await ctx.reply(`⏳ Processing withdrawal to \`${possibleDest}\`...`, { parse_mode: 'Markdown' });
        try {
          if (isSuiDest) {
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

    // 2. Direct Token Contract Address / SuiPump Link Detection
    const suiPumpMatch = /suipump\.org\/token\/(0x[0-9a-fA-F]{64})/i.exec(rawText);
    const suiTypeMatch = /(?:^|\s)(0x[0-9a-fA-F]{64}(?:::[\w]+::[\w]+)?)(?:\s|$)/.exec(rawText);
    const nearCaRegex = /(?:^|\s)([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*\.(?:near|tg|testnet))(?:\s|$)/i;
    const hex64Regex = /(?:^|\s)([0-9a-fA-F]{64})(?:\s|$)/;
    const caMatch = suiPumpMatch || suiTypeMatch || nearCaRegex.exec(rawText) || hex64Regex.exec(rawText);
    const potentialCA = caMatch ? (caMatch[1] || caMatch[0]).trim() : null;

    if (potentialCA) {
      const loadingMsg = await ctx.reply('🔍 Looking up token...').catch(() => null);
      let card;
      try {
        card = await buildTokenCard(potentialCA.trim(), telegramId);
      } catch (err: any) {
        console.warn(`[API] Token lookup failed for ${potentialCA}:`, err.message);
        if (loadingMsg) await ctx.deleteMessage(loadingMsg.message_id).catch(() => {});
        await ctx.reply(
          `❌ Token not found: ${sanitizeMd(potentialCA)}\n\n` +
          `This could mean:\n` +
          `• The contract address or URL is incorrect\n` +
          `• The token is on an unsupported chain or venue\n` +
          `• The RPC request timed out — please try again\n\n` +
          `Error: ${sanitizeMd(err.message?.slice(0, 100) || 'Unknown error')}`
        );
        return;
      }

      // SPEED: prewarm the trade path (storage / Ref registration / pool-id
      // caches) while the user reads the card. Never blocks the card.
      prewarmTradePath(telegramId, potentialCA.trim()).catch(() => {});

      if (loadingMsg) await ctx.deleteMessage(loadingMsg.message_id).catch(() => {});
      await sendTokenCard(ctx, card);
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
