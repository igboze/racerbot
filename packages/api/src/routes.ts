import { Telegraf, Markup, Context } from 'telegraf';
import {
  getUserByTelegramId,
  getOpenPositions,
  getFillsByPosition,
  getTokenCache,
  createTrigger,
  updateUserDefaults,
  updateUserSettings,
  getDb,
  generateReferralCode,
  type UserRecord,
} from '@racerbot/db';
import {
  getTokenInfo,
  publishSwap,
  onboardUser,
  rotateUserKey,
  getUserBalances,
  unwrapUserWrapNear,
  withdrawFunds,
  syncUserTokenDeposits,
  type TokenInfoResult,
} from './wallet.js';
import { sellAtTarget } from './sellHelper.js';
import { computePnL, fuzzyMatch, decrypt, tokenLinks, getNear } from '@racerbot/shared';
import { utils as nearUtils } from 'near-api-js';
import { MASTER_KEY } from './config.js';

// ── Token cache for snipe-by-name fuzzy matching ──────────────────────────────
export const localTokenNames = new Map<string, { address: string; symbol: string }>();

// ── Rate limiting for /export command (1 export per 5 minutes per user) ───────
const lastExportTime = new Map<number, number>();
const EXPORT_COOLDOWN_MS = 5 * 60 * 1000;

// ── User pending interactive input state ──────────────────────────────────────
interface PendingAction {
  action: 'buy_custom_near' | 'custom_slippage' | 'custom_auto_buy' | 'custom_min_liq' | 'withdraw';
  tokenAddress?: string;
  expiresAt: number;
}
const userPendingActions = new Map<number, PendingAction>();

// ── Helper: Safe Markdown string sanitization ────────────────────────────────
function sanitizeMd(str: string): string {
  return (str || '').replace(/[_*`\[]/g, ' ');
}

// ── Helper: Build Main Menu ──────────────────────────────────────────────────
// FIX 4: Use cached balance; only do a live fetch if forceRefresh=true or cache is cold.
// The `getUserBalances` function already has its own 8s TTL cache, so calling it here
// never blocks unless the cache is cold (first load after restart).
export async function buildMainMenu(telegramId: number, forceRefresh = false) {
  const user = await getUserByTelegramId(telegramId).catch(() => null);
  let subaccountText = 'Not initialized';
  let balanceText = '0.0000 NEAR';

  if (user) {
    subaccountText = `\`${user.subaccount_id}\``;
    try {
      // getUserBalances uses an 8s in-memory cache — this is fast on repeat calls.
      // Only hit the RPC when forceRefresh=true (Refresh button) or cache is cold.
      const b = await getUserBalances(telegramId, forceRefresh);
      balanceText = `\`${b.nativeNearFormatted} NEAR\` | \`${b.wrapNearFormatted} wNEAR\``;
    } catch {
      balanceText = '`0.0000 NEAR`';
    }
  }

  const text =
    `🚀 *RacerBot | High-Speed NEAR Trading*\n\n` +
    `🔑 *Account*: ${subaccountText}\n` +
    `💰 *Balance*: ${balanceText}\n\n` +
    `💡 *Instant Trading Flow*:\n` +
    `• *Paste any Token Contract Address (CA)* directly into chat to view charts, liquidity, and instant 1-click buy buttons.\n` +
    `• Or use the interactive in-chat buttons below:\n\n` +
    `📝 *Note*: 0.05 NEAR is reserved for account storage and is not spendable.`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('💳 Wallet', 'menu_wallet'),
      Markup.button.callback('⚙️ Settings', 'menu_settings'),
    ],
    [
      Markup.button.callback('📊 Positions', 'menu_positions'),
      Markup.button.callback('📈 PnL', 'menu_pnl'),
    ],
    [
      Markup.button.callback('🎯 Snipe Rules', 'menu_settings'),
      Markup.button.callback('🔄 Refresh', 'menu_home'),
    ],
    [
      Markup.button.callback('🔑 Export Key', 'export_prompt'),
      Markup.button.callback('🔄 Rotate Key', 'rotate_prompt'),
    ],
    [
      Markup.button.url('💬 Community', 'https://t.me/racerbot_community'),
      Markup.button.url('📢 Updates', 'https://t.me/racertrading'),
    ],
  ]);

  return { text, keyboard };
}

// ── Helper: Build Wallet Menu ────────────────────────────────────────────────
export async function buildWalletMenu(telegramId: number, forceRefresh = false) {
  const b = await getUserBalances(telegramId, forceRefresh);
  const buttons: any[] = [
    [
      Markup.button.callback('🔄 Refresh', 'wallet_refresh'),
      Markup.button.callback('💸 Withdraw', 'wallet_withdraw_prompt'),
    ],
  ];

  if (Number(b.wrapNearFormatted) > 0.0001) {
    buttons.push([Markup.button.callback(`🔄 Unwrap ${b.wrapNearFormatted} wNEAR to NEAR`, 'wallet_unwrap')]);
  }

  buttons.push([
    Markup.button.callback('⚙️ Settings', 'menu_settings'),
    Markup.button.callback('🔙 Main Menu', 'menu_home'),
  ]);

  buttons.push([
    Markup.button.url('💬 Community', 'https://t.me/racerbot_community'),
    Markup.button.url('📢 Updates', 'https://t.me/racertrading'),
  ]);

  const text =
    `💳 *RacerBot Trading Wallet*\n\n` +
    `🔑 Account: \`${b.subaccountId}\`\n\n` +
    `💰 *Balances*:\n` +
    `• *Native NEAR*: \`${b.nativeNearFormatted} NEAR\`\n` +
    `• *Wrapped NEAR*: \`${b.wrapNearFormatted} wNEAR\`\n` +
    `• *Total*: \`${b.totalNearFormatted} NEAR\`\n\n` +
    `📥 *Deposit Address*:\n` +
    `Send native NEAR directly to:\n` +
    `\`${b.subaccountId}\`\n\n` +
    `⚡ *Instant Execution*:\n` +
    `Deposited NEAR is immediately ready for manual and automated sniping.\n\n` +
    `📝 *Note*: 0.05 NEAR is reserved for account storage and is not spendable.`;

  return { text, keyboard: Markup.inlineKeyboard(buttons) };
}

// ── Helper: Build Token Details Card with In-Chat Buttons ───────────────────
export async function buildTokenCard(tokenAddress: string, telegramId?: number) {
  // Fetch token info, balance, and user settings in parallel to minimize latency
  const [info, balances, user] = await Promise.allSettled([
    getTokenInfo(tokenAddress),
    telegramId ? getUserBalances(telegramId).catch(() => null) : Promise.resolve(null),
    telegramId ? getUserByTelegramId(telegramId).catch(() => null) : Promise.resolve(null),
  ]);

  if (info.status === 'rejected') {
    throw info.reason;
  }

  const tokenInfo = info.value;
  const b = balances.status === 'fulfilled' ? balances.value : null;
  const userRecord = user.status === 'fulfilled' ? user.value : null;
  const defaultBuyPct = userRecord?.default_buy_pct ? Number(userRecord.default_buy_pct) : 10;

  const balanceText = b
    ? `💳 *Wallet Balance*: \`${b.nativeNearFormatted} NEAR\` | \`${b.wrapNearFormatted} wNEAR\`\n\n`
    : '';

  // -- Venue label --
  let venueText = `💧 *Venue*: Unknown`;
  if (tokenInfo.venue === 'nearlytrade') {
    const phaseStr = tokenInfo.bonding_phase === 'bonded' ? 'Bonded (DEX)' : 'Bonding Curve';
    const progressStr =
      tokenInfo.bonding_progress_pct !== null && tokenInfo.bonding_progress_pct !== undefined
        ? ` — ${tokenInfo.bonding_progress_pct.toFixed(1)}% bonded`
        : '';
    venueText = `💧 *Venue*: NearlyTrade (${phaseStr}${progressStr})`;
  } else if (tokenInfo.venue === 'rhea') {
    venueText = `💧 *Venue*: Rhea Finance (AMM)`;
  } else if (tokenInfo.venue === 'shardsmarket') {
    venueText = `💧 *Venue*: Shardsmarket (AMM)`;
  } else if (tokenInfo.venue === 'memecooking') {
    venueText = `💧 *Venue*: Meme.Cooking Launchpad`;
  } else if (tokenInfo.venue === 'intear') {
    venueText = `💧 *Venue*: Intear Launchpad (XYK)`;
  } else if (tokenInfo.venue === 'onetokenhub') {
    venueText = `💧 *Venue*: OneTokenHub (Ref DCL)`;
  }

  const safeSymbol = sanitizeMd(tokenInfo.symbol || 'TOKEN');
  const safeName = sanitizeMd(tokenInfo.name || 'Token');

  // ── Deep links: DexScreener chart, NearBlocks explorer, venue launchpad ──
  const linkRows = (() => {
    const links = tokenLinks(tokenInfo.venue, tokenInfo.address);
    const rows: any[] = [];
    if (links.length > 0) rows.push(links.slice(0, 2).map(l => Markup.button.url(l.label, l.url)));
    if (links.length > 2) rows.push(links.slice(2).map(l => Markup.button.url(l.label, l.url)));
    return rows;
  })();

  // -- Price formatting (NEAR + USD) --
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
  const priceStr = priceUsdStr ? `${priceNearStr} NEAR (~${priceUsdStr})` : `${priceNearStr} NEAR`;

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
  const liqStr = liqUsdStr ? `${liqNearStr} NEAR (${liqUsdStr})` : `${liqNearStr} NEAR`;

  // -- Market cap formatting (prefer USD) --
  let mcapStr = 'N/A';
  const mcUsdVal = (tokenInfo as any).market_cap_usd as number | undefined;
  const mcNearVal = tokenInfo.market_cap;
  if (mcUsdVal && mcUsdVal > 0) {
    const mcUsdFormatted = mcUsdVal >= 1_000_000_000
      ? `$${(mcUsdVal / 1_000_000_000).toFixed(2)}B`
      : mcUsdVal >= 1_000_000
      ? `$${(mcUsdVal / 1_000_000).toFixed(2)}M`
      : mcUsdVal >= 1_000
      ? `$${(mcUsdVal / 1_000).toFixed(2)}K`
      : `$${mcUsdVal.toFixed(2)}`;

    let mcNearFormatted = '';
    if (mcNearVal >= 1_000_000) mcNearFormatted = `${(mcNearVal / 1_000_000).toFixed(2)}M NEAR`;
    else if (mcNearVal >= 1_000) mcNearFormatted = `${(mcNearVal / 1_000).toFixed(2)}K NEAR`;
    else if (mcNearVal > 0) mcNearFormatted = `${mcNearVal.toFixed(0)} NEAR`;

    mcapStr = mcNearFormatted ? `${mcUsdFormatted} (${mcNearFormatted})` : mcUsdFormatted;
  } else if (mcNearVal > 0) {
    if (mcNearVal >= 1_000_000) mcapStr = `${(mcNearVal / 1_000_000).toFixed(2)}M NEAR`;
    else if (mcNearVal >= 1_000) mcapStr = `${(mcNearVal / 1_000).toFixed(2)}K NEAR`;
    else mcapStr = `${mcNearVal.toFixed(2)} NEAR`;
  }

  // -- Supply formatting --
  const supplyHuman = parseFloat(tokenInfo.total_supply) / Math.pow(10, tokenInfo.decimals);
  const supplyStr = supplyHuman > 1e9
    ? `${(supplyHuman / 1e9).toFixed(2)}B`
    : supplyHuman > 1e6
    ? `${(supplyHuman / 1e6).toFixed(2)}M`
    : supplyHuman.toFixed(2);

  // -- NEAR/USD rate footnote --
  const nearUsdRate = (tokenInfo as any).near_usd as number | undefined;
  const nearUsdFooter = nearUsdRate && nearUsdRate > 0
    ? `\n_1 NEAR ≈ $${nearUsdRate.toFixed(2)} USD_\n`
    : '\n';

  let text =
    `🪙 *${safeName}* (\`${safeSymbol}\`)\n\n` +
    `📝 *CA*: \`${tokenInfo.address}\`\n` +
    `${venueText}\n` +
    `💰 *Price*: \`${priceStr}\`\n` +
    `💧 *Liquidity*: \`${liqStr}\`\n` +
    `📊 *Market Cap*: \`${mcapStr}\`\n` +
    `📦 *Supply*: \`${supplyStr}\` | Decimals: \`${tokenInfo.decimals}\`` +
    nearUsdFooter +
    balanceText;

  // ── Buttons depend on whether trading is supported ──
  let keyboard;
  if (tokenInfo.tradeable) {
    text += `⚡ *Choose Buy Amount (Fixed or % of Balance)*:`;
    keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('⚡ 0.5 N', `buy_fixed:${tokenInfo.address}:0.5`),
        Markup.button.callback('⚡ 1 N', `buy_fixed:${tokenInfo.address}:1`),
        Markup.button.callback('⚡ 2 N', `buy_fixed:${tokenInfo.address}:2`),
        Markup.button.callback('⚡ 5 N', `buy_fixed:${tokenInfo.address}:5`),
      ],
      [
        Markup.button.callback(`${defaultBuyPct === 10 ? '✓ ' : ''}Buy 10%`, `buy_pct:${tokenInfo.address}:10`),
        Markup.button.callback(`${defaultBuyPct === 25 ? '✓ ' : ''}Buy 25%`, `buy_pct:${tokenInfo.address}:25`),
        Markup.button.callback(`${defaultBuyPct === 50 ? '✓ ' : ''}Buy 50%`, `buy_pct:${tokenInfo.address}:50`),
        Markup.button.callback(`${defaultBuyPct === 100 ? '✓ ' : ''}Buy 100%`, `buy_pct:${tokenInfo.address}:100`),
      ],
      [
        Markup.button.callback('✏️ Buy X NEAR', `buy_custom_prompt:${tokenInfo.address}`),
        Markup.button.callback('🔄 Refresh', `token_refresh:${tokenInfo.address}`),
      ],
      ...linkRows,
      [
        Markup.button.callback('⚙️ Settings', 'menu_settings'),
        Markup.button.callback('🔙 Main Menu', 'menu_home'),
      ],
      [
        Markup.button.url('💬 Community', 'https://t.me/racerbot_community'),
        Markup.button.url('📢 Updates', 'https://t.me/racertrading'),
      ],
    ]);
  } else {
    // Non-tradeable venue — info only
    const venueNote = tokenInfo.venue === 'memecooking'
      ? '⚠️ Meme.Cooking tokens are not yet directly tradeable via RacerBot. Trade on https://meme.cooking'
      : '⚠️ This token was detected but its trading venue is not supported. Paste the CA into a supported DEX.';
    text += venueNote;
    keyboard = Markup.inlineKeyboard([
      ...linkRows,
      [
        Markup.button.callback('🔄 Refresh', `token_refresh:${tokenInfo.address}`),
        Markup.button.callback('🔙 Main Menu', 'menu_home'),
      ],
      [
        Markup.button.url('💬 Community', 'https://t.me/racerbot_community'),
        Markup.button.url('📢 Updates', 'https://t.me/racertrading'),
      ],
    ]);
  }

  return { text, keyboard, info: tokenInfo };
}

// ── Helper: Build Settings Dashboard with Checkmark Indicators ──────────────
export function buildSettingsDashboard(user: UserRecord) {
  const autoBuy = user.auto_buy_enabled;
  const slip = user.slippage_pct ? Number(user.slippage_pct) : 2.0;
  const autoAmt = user.auto_buy_amount_near ? Number(user.auto_buy_amount_near) : 1;
  const minLiq = user.auto_buy_min_liquidity_near ? Number(user.auto_buy_min_liquidity_near) : 0;
  const buyPct = user.default_buy_pct ? Number(user.default_buy_pct) : 10;
  const sellPct = user.default_sell_pct ? Number(user.default_sell_pct) : 100;

  const text =
    `⚙️ *Trading & Snipe Settings*\n\n` +
    `Configure your trading defaults and automated sniping rules below. Tap any button to toggle or update instantly:\n\n` +
    `• *Auto-Buy New Launches*: ${autoBuy ? '🟢 *Enabled*' : '🔴 *Disabled*'}\n` +
    `• *Auto-Buy Amount*: \`${autoAmt} NEAR\`\n` +
    `• *Min Pool Liquidity*: \`${minLiq} NEAR\`\n` +
    `• *Slippage Tolerance*: \`${slip}%\`\n` +
    `• *Default Manual Buy*: \`${buyPct}%\`\n` +
    `• *Default Manual Sell*: \`${sellPct}%\``;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(
        autoBuy ? '🟢 Auto-Buy: ON (Tap to Disable)' : '🔴 Auto-Buy: OFF (Tap to Enable)',
        'set:toggle_auto_buy'
      ),
    ],
    [
      Markup.button.callback(`${slip === 0.5 ? '✓ ' : ''}0.5%`, 'set:slippage:0.5'),
      Markup.button.callback(`${slip === 1 ? '✓ ' : ''}1%`, 'set:slippage:1'),
      Markup.button.callback(`${slip === 2 ? '✓ ' : ''}2%`, 'set:slippage:2'),
      Markup.button.callback(`${slip === 5 ? '✓ ' : ''}5%`, 'set:slippage:5'),
      Markup.button.callback(`${slip === 10 ? '✓ ' : ''}10%`, 'set:slippage:10'),
    ],
    [
      Markup.button.callback(`Auto: ${autoAmt === 0.5 ? '✓ ' : ''}0.5N`, 'set:auto_amt:0.5'),
      Markup.button.callback(`${autoAmt === 1 ? '✓ ' : ''}1N`, 'set:auto_amt:1'),
      Markup.button.callback(`${autoAmt === 2 ? '✓ ' : ''}2N`, 'set:auto_amt:2'),
      Markup.button.callback(`${autoAmt === 5 ? '✓ ' : ''}5N`, 'set:auto_amt:5'),
    ],
    [
      Markup.button.callback(`Min Liq: ${minLiq === 0 ? '✓ ' : ''}0N`, 'set:min_liq:0'),
      Markup.button.callback(`${minLiq === 10 ? '✓ ' : ''}10N`, 'set:min_liq:10'),
      Markup.button.callback(`${minLiq === 50 ? '✓ ' : ''}50N`, 'set:min_liq:50'),
      Markup.button.callback(`${minLiq === 500 ? '✓ ' : ''}500N`, 'set:min_liq:500'),
    ],
    [
      Markup.button.callback(`Buy: ${buyPct === 10 ? '✓ ' : ''}10%`, 'set:buy_pct:10'),
      Markup.button.callback(`${buyPct === 25 ? '✓ ' : ''}25%`, 'set:buy_pct:25'),
      Markup.button.callback(`${buyPct === 50 ? '✓ ' : ''}50%`, 'set:buy_pct:50'),
      Markup.button.callback(`${buyPct === 100 ? '✓ ' : ''}100%`, 'set:buy_pct:100'),
    ],
    [
      Markup.button.callback(`Sell: ${sellPct === 25 ? '✓ ' : ''}25%`, 'set:sell_pct:25'),
      Markup.button.callback(`${sellPct === 50 ? '✓ ' : ''}50%`, 'set:sell_pct:50'),
      Markup.button.callback(`${sellPct === 75 ? '✓ ' : ''}75%`, 'set:sell_pct:75'),
      Markup.button.callback(`${sellPct === 100 ? '✓ ' : ''}100%`, 'set:sell_pct:100'),
    ],
    [
      Markup.button.callback('✏️ Custom Slippage', 'prompt:custom_slippage'),
      Markup.button.callback('✏️ Custom Auto-Buy', 'prompt:custom_auto_buy'),
      Markup.button.callback('✏️ Custom Min Liq', 'prompt:custom_min_liq'),
    ],
    [
      Markup.button.callback('🔙 Back to Main Menu', 'menu_home'),
    ],
    [
      Markup.button.url('💬 Community', 'https://t.me/racerbot_community'),
      Markup.button.url('📢 Updates', 'https://t.me/racertrading'),
    ],
  ]);

  return { text, keyboard };
}

// ── User-Friendly Error Messages ────────────────────────────────────────
function getUserFriendlyError(error: Error | string): string {
  const errorMsg = typeof error === 'string' ? error : error.message;
  
  // Map technical errors to user-friendly messages
  const errorMap: Record<string, string> = {
    'Failed to fetch wallet balance': 'Unable to check your wallet balance. Please try again.',
    'Insufficient balance': 'You don\'t have enough NEAR for this trade. Please deposit more NEAR.',
    'Minimum buy amount': 'The amount is too small. Minimum is 0.001 NEAR.',
    'Token is on': 'This token is not yet supported for trading.',
    'Could not determine DEX venue': 'Unable to trade this token. Please verify the contract address.',
    'Available balance': 'Your available balance is too low for this trade.',
    'Failed to queue swap': 'Unable to process your buy order. Please try again.',
    'Failed to execute sell': 'Unable to process your sell order. Please try again.',
    'Failed to create trigger': 'Unable to set up your trigger. Please try again.',
    'positionId is required': 'Position ID is missing. Please try again.',
    'percentage is required': 'Percentage is missing. Please try again.',
    'percentage must be between 0 and 100': 'Percentage must be between 0 and 100.',
    'type is required': 'Trigger type is missing. Please try again.',
    'targetValue must be positive': 'Target value must be greater than 0.',
    'Invalid trigger type': 'Invalid trigger type. Use stop_loss or take_profit.',
    'Insufficient liquidity': 'Not enough liquidity available for this trade.',
    'Token not found': 'Unable to find this token. Please verify the address.',
    'RPC timeout': 'Network is slow. Please try again.',
    'Parse error': 'Transaction confirmation issue. Please try again.',
    'Transaction not confirmed': 'Transaction is taking longer than expected. Check explorer for status.',
    'near deposit': 'Failed to wrap NEAR. Please try again.',
    'ft_transfer': 'Failed to process transfer. Please try again.',
    'fee skim': 'Failed to process fee. Please try again.',
    'pool_id': 'Unable to find trading pool. Please try again.',
    'dcl_pool_id': 'Unable to find DCL pool. Please try again.',
    'Invalid swap params': 'Invalid trade parameters. Please try again.',
    'Unauthorized': 'Authentication required. Please run /start.',
    'Forbidden': 'You don\'t have permission for this action.',
    'User not found': 'Wallet not found. Please run /start first.',
    'Account setup failed': 'Unable to set up your wallet. Please try running /start again.',
    'Scoped key already registered': 'Key already exists. Try a different action.',
    'Key must be scoped': 'Invalid key format. Please use the proper key format.',
    'Could not verify access key': 'Unable to verify your key. Please try again.',
    'Token lookup failed': 'Unable to fetch token information. Please try again.',
    'Auth lookup failed': 'Authentication check failed. Please run /start again.',
    'Too many requests': 'You\'re doing this too fast. Please wait a moment.',
    'buy failed': 'Trade failed. Please try again.',
    'sell failed': 'Sell failed. Please try again.',
    'snipe failed': 'Auto-buy failed. Please try again.',
    'withdrawal failed': 'Withdrawal failed. Please try again.',
    'unwrap failed': 'Unwrap failed. Please try again.',
    'rotate key failed': 'Key rotation failed. Please try again.',
  };

  // Check for known errors
  for (const [key, message] of Object.entries(errorMap)) {
    if (errorMsg.toLowerCase().includes(key.toLowerCase())) {
      return message;
    }
  }

  // Default generic message
  return 'Something went wrong. Please try again or contact support if the issue persists.';
}

// ── Core Helper: Execute Buy for User ────────────────────────────────────────
async function executeBuyHelper(
  telegramId: number,
  tokenAddress: string,
  amountNear: number
): Promise<{ success: boolean; amountNear: number; tokenAddress: string; message: string }> {
  const user = await getUserByTelegramId(telegramId);
  if (!user) {
    throw new Error('Please run /start to set up your trading wallet first.');
  }

  if (amountNear < 0.001) {
    throw new Error('Minimum buy amount is 0.001 NEAR.');
  }

  // FIX 3: Reuse the cached balance instead of a direct RPC hit.
  // getUserBalances has its own 8s in-memory cache in wallet.ts.
  // The balance returned is already spendable (storage reserve subtracted).
  let balanceNear = 0;
  try {
    const balances = await getUserBalances(telegramId);
    balanceNear = parseFloat(balances.nativeNearFormatted);
  } catch (err: any) {
    throw new Error(`Failed to fetch wallet balance: ${err.message}`);
  }

  // Check balance including 0.005 NEAR gas reserve for transaction fees
  if (balanceNear < amountNear + 0.005) {
    throw new Error(`Insufficient balance. You have ${balanceNear.toFixed(4)} NEAR available. Need at least ${(amountNear + 0.005).toFixed(4)} NEAR (including gas reserve). Fees are deducted from your swap amount.`);
  }

  // Always use fresh data from getTokenInfo to avoid stale cache issues
  // (tokenInfoCache may have dcl_pool_id = null if RPC was down when first fetched)
  const info = await getTokenInfo(tokenAddress).catch(() => null);
  if (!info || !['rhea', 'shardsmarket', 'nearlytrade', 'intear', 'onetokenhub'].includes(info.venue)) {
    if (info && !info.tradeable) {
      const venueName = info.venue === 'memecooking' ? 'Meme.Cooking' : info.venue;
      throw new Error(`Token is on ${venueName} which is not yet supported for direct trading via RacerBot.`);
    }
    throw new Error('Could not determine DEX venue for token. Please verify the contract address.');
  }
  const venue = info.venue as 'rhea' | 'shardsmarket' | 'nearlytrade' | 'intear' | 'onetokenhub';
  const effectiveDclPoolId = info.dcl_pool_id ?? undefined;
  const effectiveRheaPoolId = info.rhea_pool_id ?? undefined;

  const near = getNear();
  const slippagePct = user.slippage_pct ? Number(user.slippage_pct) : 2.0;
  const amountInYocto = nearUtils.format.parseNearAmount(amountNear.toString()) ?? '0';
  const { minAmountOut } = await near.computeMinAmountOut(
    venue,
    'wrap.near',
    tokenAddress,
    amountInYocto,
    slippagePct,
    effectiveRheaPoolId,
    effectiveDclPoolId
  );

  const swapResult = await publishSwap({
    user_id: user.id,
    token_in: 'wrap.near',
    token_out: tokenAddress,
    amount_in: amountInYocto,
    min_amount_out: minAmountOut,
    venue,
    dcl_pool_id: effectiveDclPoolId,
  });

  const txInfo = swapResult.txHash
    ? `\n\n🔗 Explorer: [View on NearBlocks](https://nearblocks.io/txns/${swapResult.txHash})`
    : `\n\nYou will receive a notification once confirmed.`;

  return {
    success: true,
    amountNear,
    tokenAddress,
    message: `⚡ Buy order submitted for ${amountNear.toFixed(4)} NEAR of \`${tokenAddress}\` (Slippage: ${slippagePct}%).${txInfo}`,
  };
}

// ── Core Helper: Execute Percentage Buy for User ─────────────────────────────
// FIX 3 (continued): Use the cached getUserBalances rather than a raw RPC balance call.
async function executeBuyPctHelper(telegramId: number, tokenAddress: string, pct: number) {
  const user = await getUserByTelegramId(telegramId);
  if (!user) throw new Error('Please run /start to set up your wallet first.');

  // getUserBalances has an 8s TTL cache — avoids a live RPC call on every button tap.
  // The balance returned is already spendable (storage reserve subtracted).
  const balances = await getUserBalances(telegramId);
  const balanceNear = parseFloat(balances.nativeNearFormatted);

  // Retain 0.005 NEAR reserve for gas (fees are deducted from swap amount)
  const usableBalance = Math.max(0, balanceNear - 0.005);
  const amountNear = (usableBalance * pct) / 100;
  if (amountNear < 0.005) {
    throw new Error(`Available balance (${usableBalance.toFixed(4)} NEAR after 0.005 gas reserve) is too low to buy.`);
  }
  return executeBuyHelper(telegramId, tokenAddress, Number(amountNear.toFixed(4)));
}

export function setupRoutes(bot: Telegraf): void {

  // ── /start — custodial onboarding with in-chat menu buttons ────────────────
  bot.command('start', async (ctx) => {
    const telegramId = ctx.from!.id;
    const args = ctx.message!.text!.split(' ').slice(1);
    const referralCode = args[0] || undefined;
    const username = ctx.from!.username || undefined;

    try {
      const result = await onboardUser(telegramId, referralCode, username);
      const menu = await buildMainMenu(telegramId);

      if (result.isExisting) {
        await ctx.reply(menu.text, { parse_mode: 'Markdown', ...menu.keyboard });
        return;
      }

      // Freshly created account: show full private key security notice + in-chat buttons
      const keyMessage = await ctx.reply(
        `🚀 *Welcome to RacerBot!*\n\n` +
        `Your dedicated NEAR trading wallet is ready:\n` +
        `🔑 Account: \`${result.subaccountId}\`\n\n` +
        `⚠️ *YOUR PRIVATE KEY (EXPORT)*:\n` +
        `\`${result.privateKey}\`\n\n` +
        `*Important Security Notice*:\n` +
        `• This string is your real full-access private key. Anyone with this key controls your account.\n` +
        `• Save this private key in a safe place. You can import it into MyNearWallet, Meteor Wallet, or NEAR CLI.\n` +
        `• If you ever suspect your key was compromised, use /rotatekey immediately to generate a new key on-chain.\n` +
        `• You can retrieve this key later with /export.\n\n` +
        `💡 *How to Trade*:\n` +
        `Paste any token contract address (e.g. \`token.near\`) directly into this chat to view stats and execute 1-click buys!\n\n` +
        `🔗 *Join Our Community*:\n` +
        `💬 [Community Group](https://t.me/racerbot_community) - Get help and connect with traders\n` +
        `📢 [Updates Channel](https://t.me/racertrading) - Announcements and news`,
        { parse_mode: 'Markdown', ...menu.keyboard }
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
      console.error('[API] Onboarding error for telegramId:', telegramId, err);
      await ctx.reply(`❌ ${getUserFriendlyError(err)}\n\nPlease try running /start again.`);
    }
  });

  // ── /menu — Open main menu ────────────────────────────────────────────────
  bot.command('menu', async (ctx) => {
    const telegramId = ctx.from!.id;
    try {
      const menu = await buildMainMenu(telegramId);
      await ctx.reply(menu.text, { parse_mode: 'Markdown', ...menu.keyboard });
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
    }
  });

  // ── Main Menu Actions ─────────────────────────────────────────────────────
  bot.action('menu_home', async (ctx) => {
    const telegramId = ctx.from!.id;
    try {
      // forceRefresh=true so the Refresh button always shows the latest balance
      const menu = await buildMainMenu(telegramId, true);
      await ctx.answerCbQuery('Main Menu').catch(() => {});
      await ctx.editMessageText(menu.text, { parse_mode: 'Markdown', ...menu.keyboard }).catch(() => {});
    } catch {
      await ctx.answerCbQuery().catch(() => {});
    }
  });

  bot.action('menu_wallet', async (ctx) => {
    const telegramId = ctx.from!.id;
    try {
      const wallet = await buildWalletMenu(telegramId);
      await ctx.answerCbQuery().catch(() => {});
      await ctx.editMessageText(wallet.text, { parse_mode: 'Markdown', ...wallet.keyboard }).catch(() => {});
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => {});
    }
  });

  bot.action('menu_settings', async (ctx) => {
    const telegramId = ctx.from!.id;
    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await ctx.answerCbQuery('Please run /start first.').catch(() => {});
      return;
    }
    const dash = buildSettingsDashboard(user);
    await ctx.answerCbQuery().catch(() => {});
    await ctx.editMessageText(dash.text, { parse_mode: 'Markdown', ...dash.keyboard }).catch(() => {});
  });

  // ── menu_positions — FIX 1 & 2: Parallel token fetches, no duplicate calls ──
  bot.action('menu_positions', async (ctx) => {
    const telegramId = ctx.from!.id;
    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await ctx.answerCbQuery('Please run /start first.').catch(() => {});
      return;
    }

    // Auto-detect and sync external token deposits to calculate PNL from deposit point
    await syncUserTokenDeposits(user.id, user.subaccount_id).catch(() => {});

    const positions = await getOpenPositions(user.id).catch(() => []);
    if (positions.length === 0) {
      await ctx.answerCbQuery('No open positions.').catch(() => {});
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Refresh', 'menu_positions')],
        [Markup.button.callback('🔙 Main Menu', 'menu_home')],
        [
          Markup.button.url('💬 Community', 'https://t.me/racerbot_community'),
          Markup.button.url('📢 Updates', 'https://t.me/racertrading'),
        ],
      ]);
      await ctx.editMessageText('📊 *Open Positions*\n\n📭 You currently have no open positions.\n\nPaste a token CA into chat to start trading!', {
        parse_mode: 'Markdown',
        ...keyboard,
      }).catch(() => {});
      return;
    }

    await ctx.answerCbQuery().catch(() => {});

    // FIX 1 & 2: Fetch all token info in parallel in a SINGLE pass.
    // Reuse this same map for both the message text and the buttons — no second fetch loop.
    const infoResults = await Promise.allSettled(
      positions.map(pos => getTokenInfo(pos.token_address))
    );
    const infoMap = new Map<string, TokenInfoResult | null>();
    positions.forEach((pos, i) => {
      const r = infoResults[i];
      infoMap.set(pos.token_address, r.status === 'fulfilled' ? r.value : null);
    });

    let msg = `📊 *Open Positions (${positions.length})*\n\n`;
    for (const pos of positions) {
      const info = infoMap.get(pos.token_address);
      const symbol = info?.symbol ? sanitizeMd(info.symbol) : '???';
      const currentPrice = info ? parseFloat(info.price) : 0;
      const pnlPct = currentPrice > 0 && parseFloat(pos.avg_entry_price) > 0
        ? ((currentPrice - parseFloat(pos.avg_entry_price)) / parseFloat(pos.avg_entry_price) * 100).toFixed(1)
        : 'N/A';
      const emoji = parseFloat(pnlPct) >= 0 ? '🟢' : '🔴';

      msg += `${emoji} *${symbol}*\n`;
      msg += `  Holding: \`${pos.quantity_held}\`\n`;
      msg += `  Entry: \`${parseFloat(pos.avg_entry_price).toFixed(8)} NEAR\`\n`;
      msg += `  Current: \`${currentPrice.toFixed(8)} NEAR\`\n`;
      msg += `  PNL: \`${pnlPct}%\`\n`;
      msg += `  CA: \`${pos.token_address}\`\n\n`;
    }

    // FIX 2: Reuse the already-fetched infoMap — no second getTokenInfo() loop.
    const defaultSellPct = user.default_sell_pct ? Number(user.default_sell_pct) : 100;
    const buttons: any[] = [];
    for (const pos of positions.slice(0, 3)) {
      const info = infoMap.get(pos.token_address);
      const sym = info?.symbol ? sanitizeMd(info.symbol) : 'Token';
      const row: any[] = [];
      if (defaultSellPct < 100) {
        row.push(Markup.button.callback(`⚡ Sell ${defaultSellPct}% ${sym}`, `sell:${pos.id}:${defaultSellPct}`));
      }
      row.push(Markup.button.callback(`Sell 100% ${sym}`, `sell:${pos.id}:100`));
      buttons.push(row);
    }
    buttons.push([
      Markup.button.callback('🔄 Refresh', 'menu_positions'),
      Markup.button.callback('🔙 Main Menu', 'menu_home'),
    ]);
    buttons.push([
      Markup.button.url('💬 Community', 'https://t.me/racerbot_community'),
      Markup.button.url('📢 Updates', 'https://t.me/racertrading'),
    ]);

    await ctx.editMessageText(msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }).catch(() => {});
  });

  // ── menu_pnl — FIX 1: Parallel token fetches for closed positions ──────────
  bot.action('menu_pnl', async (ctx) => {
    const telegramId = ctx.from!.id;
    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await ctx.answerCbQuery('Please run /start first.').catch(() => {});
      return;
    }

    // Auto-detect and sync external token deposits to calculate PNL from deposit point
    await syncUserTokenDeposits(user.id, user.subaccount_id).catch(() => {});

    const [positions, db] = await Promise.all([
      getOpenPositions(user.id).catch(() => []),
      getDb(),
    ]);
    const closedResult = await db.query(
      'SELECT * FROM positions WHERE user_id = $1 AND status = $2 ORDER BY closed_at DESC LIMIT 10',
      [user.id, 'closed']
    );

    // FIX 1: Fetch all fills and token info for closed positions in parallel.
    const [fillsResults, tokenInfoResults] = await Promise.all([
      Promise.allSettled(closedResult.rows.map((pos: any) => getFillsByPosition(pos.id))),
      Promise.allSettled(closedResult.rows.map((pos: any) => getTokenInfo(pos.token_address))),
    ]);

    let msg = `📊 *PNL Summary*\n\n`;
    msg += `🟢 Open positions: ${positions.length}\n`;
    msg += `✅ Closed positions (last 10): ${closedResult.rows.length}\n\n`;

    let totalRealizedNear = 0;
    for (let i = 0; i < closedResult.rows.length; i++) {
      const pos = closedResult.rows[i];
      const fillResult = fillsResults[i];
      const fills = fillResult.status === 'fulfilled' ? fillResult.value : [];
      const buys = fills.filter((f: any) => f.side === 'buy');
      const sells = fills.filter((f: any) => f.side === 'sell');

      if (buys.length && sells.length) {
        const avgEntry = parseFloat(pos.avg_entry_price);
        const lastSell = sells[sells.length - 1];
        const sellPrice = parseFloat(lastSell.price);
        const qty = parseFloat(lastSell.amount);
        const buyFee = parseFloat(buys[0]?.fee_paid ?? '0') / (parseFloat(buys[0]?.amount ?? '1'));
        const sellFee = parseFloat(lastSell.fee_paid) / qty;

        const pnl = computePnL(avgEntry, sellPrice, qty, buyFee, sellFee);
        totalRealizedNear += pnl.netNear;

        const tiResult = tokenInfoResults[i];
        const tokenInfo = tiResult.status === 'fulfilled' ? tiResult.value : null;
        const symbol = tokenInfo?.symbol ? sanitizeMd(tokenInfo.symbol) : pos.token_address.slice(0, 8);
        const emoji = pnl.pnlPercent >= 0 ? '🟢' : '🔴';
        msg += `${emoji} *${symbol}*: \`${pnl.netNear.toFixed(4)} NEAR\` (${pnl.pnlPercent >= 0 ? '+' : ''}${pnl.pnlPercent.toFixed(2)}%)\n`;
      }
    }

    msg += `\n💰 *Total Realized: ${totalRealizedNear.toFixed(4)} NEAR*`;
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🔄 Refresh', 'menu_pnl')],
      [Markup.button.callback('🔙 Main Menu', 'menu_home')],
      [
        Markup.button.url('💬 Community', 'https://t.me/racerbot_community'),
        Markup.button.url('📢 Updates', 'https://t.me/racertrading'),
      ],
    ]);
    await ctx.answerCbQuery().catch(() => {});
    await ctx.editMessageText(msg, { parse_mode: 'Markdown', ...keyboard }).catch(() => {});
  });

  // ── /wallet & /balance ────────────────────────────────────────────────────
  const handleWallet = async (ctx: Context) => {
    const telegramId = ctx.from!.id;
    try {
      const wallet = await buildWalletMenu(telegramId);
      await ctx.reply(wallet.text, { parse_mode: 'Markdown', ...wallet.keyboard });
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
    }
  };

  bot.command('wallet', handleWallet);
  bot.command('balance', handleWallet);

  bot.action('wallet_refresh', async (ctx) => {
    const telegramId = ctx.from!.id;
    try {
      const wallet = await buildWalletMenu(telegramId, true);
      await ctx.answerCbQuery('Wallet refreshed.').catch(() => {});
      await ctx.editMessageText(wallet.text, { parse_mode: 'Markdown', ...wallet.keyboard }).catch(() => {});
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => {});
    }
  });

  bot.action('wallet_unwrap', async (ctx) => {
    const telegramId = ctx.from!.id;
    await ctx.answerCbQuery('Unwrapping wrap.near...').catch(() => {});
    try {
      const res = await unwrapUserWrapNear(telegramId);
      await ctx.reply(`✅ Successfully unwrapped ${res.unwrappedAmount} wNEAR into native NEAR!`);
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
    }
  });

  bot.command('unwrap', async (ctx) => {
    const telegramId = ctx.from!.id;
    try {
      const res = await unwrapUserWrapNear(telegramId);
      if (res.unwrappedAmount === '0') {
        await ctx.reply('You do not have any wrap.near balance to unwrap.');
      } else {
        await ctx.reply(`✅ Successfully unwrapped ${res.unwrappedAmount} wNEAR into native NEAR!`);
      }
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
    }
  });

  bot.action('wallet_withdraw_prompt', async (ctx) => {
    const telegramId = ctx.from!.id;
    userPendingActions.set(telegramId, {
      action: 'withdraw',
      expiresAt: Date.now() + 180000,
    });
    await ctx.answerCbQuery().catch(() => {});
    await ctx.reply(
      `💸 *Withdraw NEAR*\n\n` +
      `Reply with the recipient address and amount, for example:\n` +
      `• \`mywallet.near 1.5\`\n` +
      `• \`mywallet.near all\`\n\n` +
      `_Type /cancel to abort withdrawal._`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── /withdraw <destination> [amount] ──────────────────────────────────────
  bot.command('withdraw', async (ctx) => {
    const telegramId = ctx.from!.id;
    const args = ctx.message!.text!.split(' ').slice(1).filter(Boolean);

    if (args.length === 0) {
      userPendingActions.set(telegramId, {
        action: 'withdraw',
        expiresAt: Date.now() + 180000,
      });
      await ctx.reply(
        `💸 *Withdraw NEAR*\n\n` +
        `Usage: \`/withdraw <destination_address> [amount]\`\n\n` +
        `Or reply directly now with:\n` +
        `\`mywallet.near 1.5\` or \`mywallet.near all\``,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const destination = args[0].trim();
    const amountArg = args[1]?.toLowerCase();
    const amountNear: number | 'all' = amountArg === 'all' || !amountArg ? 'all' : parseFloat(amountArg);

    if (typeof amountNear === 'number' && (isNaN(amountNear) || amountNear <= 0)) {
      await ctx.reply('❌ Invalid amount. Please specify a positive number or "all".');
      return;
    }

    await ctx.reply(`⏳ Processing withdrawal to \`${destination}\`...`, { parse_mode: 'Markdown' });

    try {
      const result = await withdrawFunds(telegramId, destination, amountNear);
      await ctx.reply(
        `✅ *Withdrawal Successful!*\n\n` +
        `💸 Amount: \`${result.amountWithdrawn} NEAR\`\n` +
        `📬 Destination: \`${result.destination}\`\n\n` +
        `🔗 Explorer: [View on NearBlocks](https://nearblocks.io/txns/${result.txHash})`,
        { parse_mode: 'Markdown' }
      );
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
    }
  });

  // ── /settings & /filters — Interactive Settings Dashboard ─────────────────
  const handleSettings = async (ctx: Context) => {
    const telegramId = ctx.from!.id;
    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await ctx.reply('Please run /start first.');
      return;
    }
    const dash = buildSettingsDashboard(user);
    await ctx.reply(dash.text, { parse_mode: 'Markdown', ...dash.keyboard });
  };

  bot.command('settings', handleSettings);
  bot.command('filters', handleSettings);

  // Settings Dashboard Button Actions
  bot.action('set:toggle_auto_buy', async (ctx) => {
    const telegramId = ctx.from!.id;
    const user = await getUserByTelegramId(telegramId);
    if (!user) return;
    const newStatus = !user.auto_buy_enabled;
    const updated = await updateUserSettings(user.id, { auto_buy_enabled: newStatus });
    await ctx.answerCbQuery(`Auto-buy ${newStatus ? 'enabled' : 'disabled'}`).catch(() => {});
    const dash = buildSettingsDashboard(updated);
    await ctx.editMessageText(dash.text, { parse_mode: 'Markdown', ...dash.keyboard }).catch(() => {});
  });

  bot.action(/^set:slippage:([0-9.]+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const slip = parseFloat(ctx.match![1]);
    const user = await getUserByTelegramId(telegramId);
    if (!user) return;
    const updated = await updateUserSettings(user.id, { slippage_pct: slip });
    await ctx.answerCbQuery(`Slippage set to ${slip}%`).catch(() => {});
    const dash = buildSettingsDashboard(updated);
    await ctx.editMessageText(dash.text, { parse_mode: 'Markdown', ...dash.keyboard }).catch(() => {});
  });

  bot.action(/^set:auto_amt:([0-9.]+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const amt = parseFloat(ctx.match![1]);
    const user = await getUserByTelegramId(telegramId);
    if (!user) return;
    const updated = await updateUserSettings(user.id, { auto_buy_amount_near: amt });
    await ctx.answerCbQuery(`Auto-buy amount set to ${amt} NEAR`).catch(() => {});
    const dash = buildSettingsDashboard(updated);
    await ctx.editMessageText(dash.text, { parse_mode: 'Markdown', ...dash.keyboard }).catch(() => {});
  });

  bot.action(/^set:min_liq:([0-9.]+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const liq = parseFloat(ctx.match![1]);
    const user = await getUserByTelegramId(telegramId);
    if (!user) return;
    const updated = await updateUserSettings(user.id, { auto_buy_min_liquidity_near: liq });
    await ctx.answerCbQuery(`Min liquidity set to ${liq} NEAR`).catch(() => {});
    const dash = buildSettingsDashboard(updated);
    await ctx.editMessageText(dash.text, { parse_mode: 'Markdown', ...dash.keyboard }).catch(() => {});
  });

  bot.action(/^set:buy_pct:(\d+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const pct = parseInt(ctx.match![1]);
    const user = await getUserByTelegramId(telegramId);
    if (!user) return;
    const updated = await updateUserSettings(user.id, { default_buy_pct: pct });
    await ctx.answerCbQuery(`Default buy set to ${pct}%`).catch(() => {});
    const dash = buildSettingsDashboard(updated);
    await ctx.editMessageText(dash.text, { parse_mode: 'Markdown', ...dash.keyboard }).catch(() => {});
  });

  bot.action(/^set:sell_pct:(\d+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const pct = parseInt(ctx.match![1]);
    const user = await getUserByTelegramId(telegramId);
    if (!user) return;
    const updated = await updateUserSettings(user.id, { default_sell_pct: pct });
    await ctx.answerCbQuery(`Default sell set to ${pct}%`).catch(() => {});
    const dash = buildSettingsDashboard(updated);
    await ctx.editMessageText(dash.text, { parse_mode: 'Markdown', ...dash.keyboard }).catch(() => {});
  });

  bot.action('prompt:custom_slippage', async (ctx) => {
    const telegramId = ctx.from!.id;
    userPendingActions.set(telegramId, {
      action: 'custom_slippage',
      expiresAt: Date.now() + 120000,
    });
    await ctx.answerCbQuery().catch(() => {});
    await ctx.reply('✏️ *Enter Slippage Tolerance*\n\nReply with your desired slippage percentage (e.g. `2.5`):', { parse_mode: 'Markdown' });
  });

  bot.action('prompt:custom_auto_buy', async (ctx) => {
    const telegramId = ctx.from!.id;
    userPendingActions.set(telegramId, {
      action: 'custom_auto_buy',
      expiresAt: Date.now() + 120000,
    });
    await ctx.answerCbQuery().catch(() => {});
    await ctx.reply('✏️ *Enter Auto-Buy Amount*\n\nReply with the NEAR amount per auto-buy (e.g. `0.25`):', { parse_mode: 'Markdown' });
  });

  bot.action('prompt:custom_min_liq', async (ctx) => {
    const telegramId = ctx.from!.id;
    userPendingActions.set(telegramId, {
      action: 'custom_min_liq',
      expiresAt: Date.now() + 120000,
    });
    await ctx.answerCbQuery().catch(() => {});
    await ctx.reply('✏️ *Enter Min Pool Liquidity*\n\nReply with the minimum pool liquidity in NEAR (e.g. `200` or `500`):', { parse_mode: 'Markdown' });
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
      await ctx.reply(card.text, { parse_mode: 'Markdown', ...card.keyboard });
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`, { parse_mode: 'Markdown' });
    }
  });

  // Refresh token card
  bot.action(/^token_refresh:(.+)$/, async (ctx) => {
    const tokenAddress = ctx.match![1];
    const telegramId = ctx.from!.id;
    try {
      const card = await buildTokenCard(tokenAddress, telegramId);
      await ctx.answerCbQuery('Token refreshed.').catch(() => {});
      await ctx.editMessageText(card.text, { parse_mode: 'Markdown', ...card.keyboard }).catch(() => {});
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => {});
    }
  });

  // ── 1-Click Buy Inline Handlers ───────────────────────────────────────────
  // Fixed NEAR amount buy: buy_fixed:<token>:<amount>
  bot.action(/^buy_fixed:(.+):([0-9.]+)$/, async (ctx) => {
    const tokenAddress = ctx.match![1];
    const amountNear = parseFloat(ctx.match![2]);
    const telegramId = ctx.from!.id;

    await ctx.answerCbQuery(`⚡ Sending buy order for ${amountNear} NEAR...`).catch(() => {});
    try {
      const res = await executeBuyHelper(telegramId, tokenAddress, amountNear);
      await ctx.reply(`✅ ${res.message}`, { parse_mode: 'Markdown' });
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
    }
  });

  // Percentage buy: buy_pct:<token>:<pct> or legacy buy:<token>:<pct>
  bot.action(/^(?:buy_pct|buy):(.+):(\d+)$/, async (ctx) => {
    const tokenAddress = ctx.match![1];
    const pct = parseInt(ctx.match![2]);
    const telegramId = ctx.from!.id;

    await ctx.answerCbQuery(`⚡ Sending buy order for ${pct}% of balance...`).catch(() => {});
    try {
      const res = await executeBuyPctHelper(telegramId, tokenAddress, pct);
      await ctx.reply(`✅ ${res.message}`, { parse_mode: 'Markdown' });
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
    }
  });

  // Custom buy prompt button
  bot.action(/^buy_custom_prompt:(.+)$/, async (ctx) => {
    const tokenAddress = ctx.match![1];
    const telegramId = ctx.from!.id;
    userPendingActions.set(telegramId, {
      action: 'buy_custom_near',
      tokenAddress,
      expiresAt: Date.now() + 180000,
    });
    await ctx.answerCbQuery().catch(() => {});
    await ctx.reply(
      `✏️ *Custom Buy Amount*\n\n` +
      `Token: \`${tokenAddress}\`\n\n` +
      `Reply with the amount in NEAR you want to buy (e.g. \`2.5\`):\n` +
      `_Type /cancel to abort._`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── /buy <token_ca> [amount_near] ─────────────────────────────────────────
  bot.command('buy', async (ctx) => {
    const telegramId = ctx.from!.id;
    const args = ctx.message!.text!.split(' ').slice(1);
    if (!args[0]) {
      await ctx.reply('Usage: /buy <token_ca> [amount_near]\nExample: /buy token.near 5\n\nOr paste the token address directly for 1-click buy buttons.');
      return;
    }

    const tokenAddress = args[0].trim();
    const amountNear = parseFloat(args[1] ?? '0');

    if (amountNear <= 0) {
      try {
        const card = await buildTokenCard(tokenAddress, telegramId);
        await ctx.reply(card.text, { parse_mode: 'Markdown', ...card.keyboard });
      } catch {
        await ctx.reply('Specify amount in NEAR: /buy <token_ca> <amount_near>');
      }
      return;
    }

    await ctx.reply(`⚡ Sending buy order for ${amountNear} NEAR of \`${tokenAddress}\`...`, { parse_mode: 'Markdown' });
    try {
      const res = await executeBuyHelper(telegramId, tokenAddress, amountNear);
      await ctx.reply(`✅ ${res.message}`, { parse_mode: 'Markdown' });
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
    }
  });

  // ── /sell — Quick-sell open positions ─────────────────────────────────────
  // FIX 1: Parallel token info fetch across all open positions.
  bot.command('sell', async (ctx) => {
    const telegramId = ctx.from!.id;
    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) { await ctx.reply('Use /start first.'); return; }

    const positions = await getOpenPositions(user.id).catch(() => []);
    if (positions.length === 0) {
      await ctx.reply('📭 No open positions.');
      return;
    }

    // FIX 1: All token info in parallel, one round-trip for all positions.
    const infoResults = await Promise.allSettled(
      positions.map(pos => getTokenInfo(pos.token_address))
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
          Markup.button.callback('Sell 25%', `sell:${pos.id}:25`),
          Markup.button.callback('Sell 50%', `sell:${pos.id}:50`),
          Markup.button.callback('Sell 75%', `sell:${pos.id}:75`),
          Markup.button.callback('Sell 100%', `sell:${pos.id}:100`),
        ],
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
  });

  // Sell inline button handler
  bot.action(/^sell:([^:]+):(\d+)$/, async (ctx) => {
    const positionId = ctx.match![1];
    const pct = parseInt(ctx.match![2]);
    const telegramId = ctx.from!.id;
    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) { await ctx.answerCbQuery('Wallet not found.').catch(() => {}); return; }

    await sellAtTarget(user.id, positionId, pct);

    await ctx.answerCbQuery(`✅ Sell order sent (${pct}%)`).catch(() => {});
    await ctx.editMessageText(`⚡ Sell order sent: ${pct}% of position.\n\nYou'll be notified on confirmation.`).catch(() => {});
  });

  // ── /positions & /pnl ─────────────────────────────────────────────────────
  // FIX 1 & 2: Parallel token fetches + single-pass info reuse for buttons.
  bot.command('positions', async (ctx) => {
    const telegramId = ctx.from!.id;
    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) { await ctx.reply('Use /start first.'); return; }

    const positions = await getOpenPositions(user.id).catch(() => []);
    if (positions.length === 0) {
      await ctx.reply('📭 No open positions.');
      return;
    }

    // FIX 1 & 2: Single parallel fetch; reuse results for both text and buttons.
    const infoResults = await Promise.allSettled(
      positions.map(pos => getTokenInfo(pos.token_address))
    );
    const infoMap = new Map<string, TokenInfoResult | null>();
    positions.forEach((pos, i) => {
      const r = infoResults[i];
      infoMap.set(pos.token_address, r.status === 'fulfilled' ? r.value : null);
    });

    let msg = `📊 *Open Positions (${positions.length})*\n\n`;
    for (const pos of positions) {
      const info = infoMap.get(pos.token_address);
      const symbol = info?.symbol ? sanitizeMd(info.symbol) : '???';
      const currentPrice = info ? parseFloat(info.price) : 0;
      const pnlPct = currentPrice > 0 && parseFloat(pos.avg_entry_price) > 0
        ? ((currentPrice - parseFloat(pos.avg_entry_price)) / parseFloat(pos.avg_entry_price) * 100).toFixed(1)
        : 'N/A';
      const emoji = parseFloat(pnlPct) >= 0 ? '🟢' : '🔴';

      msg += `${emoji} *${symbol}*\n`;
      msg += `  Holding: \`${pos.quantity_held}\`\n`;
      msg += `  Entry: \`${parseFloat(pos.avg_entry_price).toFixed(8)} NEAR\`\n`;
      msg += `  Current: \`${currentPrice.toFixed(8)} NEAR\`\n`;
      msg += `  PNL: \`${pnlPct}%\`\n`;
      msg += `  CA: \`${pos.token_address}\`\n\n`;
    }

    // FIX 2: Reuse infoMap — no second getTokenInfo() loop.
    const buttons: any[] = [];
    for (const pos of positions.slice(0, 3)) {
      const info = infoMap.get(pos.token_address);
      const sym = info?.symbol ? sanitizeMd(info.symbol) : 'Token';
      buttons.push([
        Markup.button.callback(`Sell 50% ${sym}`, `sell:${pos.id}:50`),
        Markup.button.callback(`Sell 100% ${sym}`, `sell:${pos.id}:100`),
      ]);
    }
    buttons.push([
      Markup.button.callback('🔄 Refresh', 'menu_positions'),
      Markup.button.callback('🔙 Main Menu', 'menu_home'),
    ]);

    await ctx.reply(msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
  });

  // FIX 1: Parallel fills + token info fetches for /pnl command.
  bot.command('pnl', async (ctx) => {
    const telegramId = ctx.from!.id;
    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) { await ctx.reply('Use /start first.'); return; }

    const [positions, db] = await Promise.all([
      getOpenPositions(user.id).catch(() => []),
      getDb(),
    ]);
    const closedResult = await db.query(
      'SELECT * FROM positions WHERE user_id = $1 AND status = $2 ORDER BY closed_at DESC LIMIT 10',
      [user.id, 'closed']
    );

    // FIX 1: Fetch all fills and token info in parallel.
    const [fillsResults, tokenInfoResults] = await Promise.all([
      Promise.allSettled(closedResult.rows.map((pos: any) => getFillsByPosition(pos.id))),
      Promise.allSettled(closedResult.rows.map((pos: any) => getTokenInfo(pos.token_address))),
    ]);

    let msg = `📊 *PNL Summary*\n\n`;
    msg += `🟢 Open positions: ${positions.length}\n`;
    msg += `✅ Closed positions (last 10): ${closedResult.rows.length}\n\n`;

    let totalRealizedNear = 0;
    for (let i = 0; i < closedResult.rows.length; i++) {
      const pos = closedResult.rows[i];
      const fillResult = fillsResults[i];
      const fills = fillResult.status === 'fulfilled' ? fillResult.value : [];
      const buys = fills.filter((f: any) => f.side === 'buy');
      const sells = fills.filter((f: any) => f.side === 'sell');

      if (buys.length && sells.length) {
        const avgEntry = parseFloat(pos.avg_entry_price);
        const lastSell = sells[sells.length - 1];
        const sellPrice = parseFloat(lastSell.price);
        const qty = parseFloat(lastSell.amount);
        const buyFee = parseFloat(buys[0]?.fee_paid ?? '0') / (parseFloat(buys[0]?.amount ?? '1'));
        const sellFee = parseFloat(lastSell.fee_paid) / qty;

        const pnl = computePnL(avgEntry, sellPrice, qty, buyFee, sellFee);
        totalRealizedNear += pnl.netNear;

        const tiResult = tokenInfoResults[i];
        const tokenInfo = tiResult.status === 'fulfilled' ? tiResult.value : null;
        const symbol = tokenInfo?.symbol ? sanitizeMd(tokenInfo.symbol) : pos.token_address.slice(0, 8);
        const emoji = pnl.pnlPercent >= 0 ? '🟢' : '🔴';
        msg += `${emoji} *${symbol}*: \`${pnl.netNear.toFixed(4)} NEAR\` (${pnl.pnlPercent >= 0 ? '+' : ''}${pnl.pnlPercent.toFixed(2)}%)\n`;
      }
    }

    msg += `\n💰 *Total Realized: ${totalRealizedNear.toFixed(4)} NEAR*`;
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🔄 Refresh', 'menu_pnl')],
      [Markup.button.callback('🔙 Main Menu', 'menu_home')],
      [
        Markup.button.url('💬 Community', 'https://t.me/racerbot_community'),
        Markup.button.url('📢 Updates', 'https://t.me/racertrading'),
      ],
    ]);
    await ctx.reply(msg, { parse_mode: 'Markdown', ...keyboard });
  });

  // ── /snipe <token_ca|name> ────────────────────────────────────────────────
  bot.command('snipe', async (ctx) => {
    const telegramId = ctx.from!.id;
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
      await ctx.reply(`⚡ Sniping \`${query}\` with ${amountNear} NEAR...`, { parse_mode: 'Markdown' });
      try {
        const res = await executeBuyHelper(telegramId, query, amountNear);
        await ctx.reply(`✅ ${res.message}`, { parse_mode: 'Markdown' });
      } catch (err: any) {
        await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
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
  });

  bot.action(/^snipe_confirm:([^:]+):(.+)$/, async (ctx) => {
    const tokenAddress = ctx.match![1];
    const amountNear = parseFloat(ctx.match![2]);
    const telegramId = ctx.from!.id;

    await ctx.answerCbQuery('Sending snipe order...').catch(() => {});
    try {
      const res = await executeBuyHelper(telegramId, tokenAddress, amountNear);
      await ctx.editMessageText(`✅ ${res.message}`, { parse_mode: 'Markdown' }).catch(() => {});
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
      `⚠️ *Export Private Key*\n\n` +
      `You are requesting to view your raw private key for account \`${user.subaccount_id}\`.\n\n` +
      `Anyone who sees this key will have full control over your funds.\n\n` +
      `Are you sure you want to display your private key?`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('⚠️ Yes, show my private key', 'export_confirm'),
            Markup.button.callback('Cancel', 'export_cancel'),
          ],
        ]),
      }
    );
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
    console.log(`[AUDIT] Private key exported for user_id=${user.id}, telegram_id=${telegramId}`);

    try {
      const rawPrivateKey = decrypt(user.scoped_key_encrypted, MASTER_KEY);
      await ctx.answerCbQuery('Key decrypted.').catch(() => {});

      const keyMessage = await ctx.reply(
        `🔑 *Private Key for Account* \`${user.subaccount_id}\`:\n\n` +
        `\`${rawPrivateKey}\`\n\n` +
        `*Import Instructions*:\n` +
        `Paste this string into MyNearWallet, Meteor Wallet, or near-cli via "Import Private Key" to control your account outside RacerBot.`,
        { parse_mode: 'Markdown' }
      );

      await ctx.reply(
        `🛡️ *Security Reminder*:\n` +
        `• Anyone with this private key has full control of your account.\n` +
        `• Save this private key in a safe place or import it into your preferred NEAR wallet.\n` +
        `• If you suspect this key was exposed or you want to move away, withdraw your funds and/or run /rotatekey immediately.`,
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
        `✅ *Trading Key Rotated Successfully!*\n\n` +
        `Account: \`${res.subaccountId}\`\n\n` +
        `⚠️ *NEW PRIVATE KEY*:\n` +
        `\`${res.newPrivateKey}\`\n\n` +
        `*Notice*:\n` +
        `• The old key has been removed from your account on-chain.\n` +
        `• Save this new key securely.`,
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
  bot.command('referral', async (ctx) => {
    const telegramId = ctx.from!.id;
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

    const referralLink = `https://t.me/racertradingbot?start=${user.referral_code}`;

    // Get referral stats
    const db = await getDb();
    const referralsResult = await db.query(
      'SELECT * FROM referrals WHERE referrer_id = $1',
      [user.id]
    );
    const referrals = referralsResult.rows;

    const activeReferrals = referrals.filter((r: any) => r.status === 'active' || r.status === 'completed').length;
    const totalEarnings = referrals.reduce((sum: number, r: any) => sum + parseFloat(r.total_fees_earned || 0), 0);

    await ctx.reply(
      `🎁 *Referral Program*\n\n` +
      `Your referral link:\n` +
      `\`${referralLink}\`\n\n` +
      `📊 *Your Stats*:\n` +
      `• Total referrals: ${referrals.length}\n` +
      `• Active referrals: ${activeReferrals}\n` +
      `• Total earnings: ${totalEarnings.toFixed(4)} NEAR\n\n` +
      `💰 *Rewards*:\n` +
      `• Earn 30% of fees from every user you refer\n` +
      `• Rewards are automatically credited to your account\n` +
      `• Share your link and earn while your friends trade!`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── /stoploss & /takeprofit ───────────────────────────────────────────────
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

    await createTrigger({
      user_id: user.id,
      position_id: position.id,
      type: 'stop_loss',
      target_value: pct.toString(),
    });

    await ctx.reply(`✅ Stop loss set at -${pct}% for \`${tokenCA}\``, { parse_mode: 'Markdown' });
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

    await createTrigger({
      user_id: user.id,
      position_id: position.id,
      type: 'take_profit',
      target_value: pct.toString(),
    });

    await ctx.reply(`✅ Take profit set at +${pct}% for \`${tokenCA}\``, { parse_mode: 'Markdown' });
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

      if (pending.action === 'buy_custom_near' && pending.tokenAddress) {
        const amt = parseFloat(rawText);
        if (isNaN(amt) || amt <= 0) {
          await ctx.reply('❌ Invalid amount. Buy cancelled.');
          return;
        }
        await ctx.reply(`⚡ Sending buy order for ${amt} NEAR of \`${pending.tokenAddress}\`...`, { parse_mode: 'Markdown' });
        try {
           const res = await executeBuyHelper(telegramId, pending.tokenAddress, amt);
           await ctx.reply(`✅ ${res.message}`, { parse_mode: 'Markdown' });
         } catch (err: any) {
           console.warn(`[BUY] Buy failed for ${pending.tokenAddress}:`, err?.message || err);
           await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
         }
        return; // Always return after handling custom buy
      }

      if (pending.action === 'custom_slippage') {
        const slip = parseFloat(rawText);
        if (isNaN(slip) || slip < 0.1 || slip > 50) {
          await ctx.reply('❌ Invalid slippage. Must be a number between 0.1% and 50%.');
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
          const dash = buildSettingsDashboard(updated);
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
          const dash = buildSettingsDashboard(updated);
          await ctx.reply(dash.text, { parse_mode: 'Markdown', ...dash.keyboard });
        }
        return;
      }

      if (pending.action === 'withdraw') {
        const parts = rawText.split(' ').filter(Boolean);
        const dest = parts[0];
        const amtArg = parts[1]?.toLowerCase();
        const amt: number | 'all' = amtArg === 'all' || !amtArg ? 'all' : parseFloat(amtArg);
        if (typeof amt === 'number' && (isNaN(amt) || amt <= 0)) {
          await ctx.reply('❌ Invalid amount. Must be a positive number or "all".');
          return;
        }
        await ctx.reply(`⏳ Processing withdrawal to \`${dest}\`...`, { parse_mode: 'Markdown' });
        try {
          const result = await withdrawFunds(telegramId, dest, amt);
          await ctx.reply(
            `✅ *Withdrawal Successful!*\n\n` +
            `💸 Amount: \`${result.amountWithdrawn} NEAR\`\n` +
            `📬 Destination: \`${result.destination}\`\n\n` +
            `🔗 Explorer: [View on NearBlocks](https://nearblocks.io/txns/${result.txHash})`,
            { parse_mode: 'Markdown' }
          );
        } catch (err: any) {
          await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
        }
        return;
      }
    }

    // 2. Direct Token Contract Address Detection (Upon pasting a token address)
    // NEAR accounts can have subdomains like: token.factory.near, axm.meme-cooking.near etc.
    // Match any string ending in .near, .tg, or .testnet
    const nearCaRegex = /(?:^|\s)([a-zA-Z0-9_\-]+(?:\.[a-zA-Z0-9_\-]+)*\.(?:near|tg|testnet))(?:\s|$)/i;
    const caMatch = nearCaRegex.exec(rawText) ||
      (rawText.length === 64 && /^[0-9a-fA-F]{64}$/.test(rawText.trim()) ? ['', rawText.trim()] : null);
    const potentialCA = caMatch ? caMatch[1] || caMatch[0] : null;

    if (potentialCA) {
      const loadingMsg = await ctx.reply('🔍 Looking up token...').catch(() => null);
      try {
        const card = await buildTokenCard(potentialCA.trim(), telegramId);
        await ctx.reply(card.text, { parse_mode: 'Markdown', ...card.keyboard });
        return;
      } catch (err: any) {
        console.warn(`[API] Token lookup failed for ${potentialCA}:`, err.message);
        await ctx.reply(
          `❌ *Token not found*: \`${potentialCA}\`\n\n` +
          `This could mean:\n` +
          `• The contract address is incorrect\n` +
          `• The token is on an unsupported chain or venue\n` +
          `• The RPC request timed out — please try again\n\n` +
          `Error: ${err.message?.slice(0, 100) || 'Unknown error'}`,
          { parse_mode: 'Markdown' }
        );
        return;
      } finally {
        if (loadingMsg) {
          ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});
        }
      }
    }

    // 3. Local token name fuzzy match
    const tokenEntry = localTokenNames.get(rawText.toLowerCase());
    if (tokenEntry) {
      try {
        const card = await buildTokenCard(tokenEntry.address, telegramId);
        await ctx.reply(card.text, { parse_mode: 'Markdown', ...card.keyboard });
        return;
      } catch {}
    }

    // 4. Default helpful guide with Main Menu button
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('💳 Open Wallet', 'menu_wallet'),
        Markup.button.callback('⚙️ Settings', 'menu_settings'),
      ],
      [
        Markup.button.callback('🔙 Main Menu', 'menu_home'),
      ],
    ]);

    await ctx.reply(
      `💡 *Paste any NEAR token address* (e.g. \`wrap.near\`) directly into this chat to view price, liquidity, and 1-click buy buttons!\n\n` +
      `Or use the menu below:`,
      { parse_mode: 'Markdown', ...keyboard }
    );
  });
}