import { Telegraf, Markup, Context } from 'telegraf';
import {
  getUserByTelegramId,
  getUserById,
  getUserByReferralCode,
  getOpenPositions,
  getFillsByPosition,
  getPositionById,
  createTrigger,
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
  cancelSnipeOrder,
  recordSnipeTrigger,
  markSnipeTriggerFilled,
  markSnipeTriggerFailed,
  markSnipeOrderResult,
  MAX_ACTIVE_SNIPE_ORDERS_PER_USER,
  type UserRecord,
} from '@racerbot/db';
import {
  getTokenInfo,
  publishSwap,
  onboardUser,
  rotateUserKey,
  getUserBalances,
  getTradeSpendableNear,
  getRefStorageDepositNeeded,
  unwrapUserWrapNear,
  withdrawFunds,
  syncUserTokenDeposits,
  getNearUsdPrice,
  payReferralReward,
  type TokenInfoResult,
} from './wallet.js';
import { sellAtTarget } from './sellHelper.js';
import { computePnL, fuzzyMatch, decrypt, tokenLinks, getNear } from '@racerbot/shared';
import { inFlightKey, tryAcquireInFlight, releaseInFlight } from './inflight.js';
import { generatePNLCard } from './pnlCardGenerator.js';
import { utils as nearUtils } from 'near-api-js';
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
  action: 'buy_custom_near' | 'custom_slippage' | 'custom_auto_buy' | 'custom_min_liq' | 'withdraw' | 'import_token'
    | 'snipe_token_ca' | 'snipe_token_amount' | 'snipe_dev_addr' | 'snipe_dev_amount';
  tokenAddress?: string;
  deployerAddress?: string;
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
    const rheaLike = ['rhea', 'ref', 'nearlytrade', 'onetokenhub', 'nearpad', 'gaypad', 'memecooking'].includes(venue);

    const jobs: Promise<unknown>[] = [
      near.checkStorageRegistered(user.subaccount_id, tokenAddress).catch(() => false),
    ];
    if (rheaLike) {
      jobs.push(
        near.findRheaPoolForToken(tokenAddress).catch(() => null),
        near.findDclPoolId('wrap.near', tokenAddress).catch(() => null),
        near.getWhitelistedTokens().catch(() => []),
      );
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
      balanceText = `\`${b.nativeNearFormatted} NEAR\` (\`${b.nativeNearUsd}\`) | \`${b.wrapNearFormatted} wNEAR\` (\`${b.wrapNearUsd}\`)`;
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
      cb('💳 Wallet', 'menu_wallet', 'primary'),
      cb('💼 Holdings', 'menu_holdings', 'primary'),
    ],
    [
      cb('🏆 Points', 'menu_points', 'success'),
      cb('📈 PnL', 'menu_pnl', 'primary'),
    ],
    [
      cb('🎯 Snipe Rules', 'menu_snipe', 'primary'),
      cb('⚙️ Settings', 'menu_settings', 'primary'),
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
    : 'Season ended — snapshot taken';

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
    `⭐ *Your points*: \`${fmt(s.effectivePoints)}\`${s.earlyBird ? ` (base \`${fmt(s.basePoints)}\` × 1.25 🐣 Early Bird)` : ''}\n` +
    `🎖 *Rank*: \`#${s.rank}\` of ${fmt(Math.max(s.totalUsers, 1))}\n` +
    `⏳ *Snapshot*: Oct 15, 23:59 UTC (${timeLeft})\n\n` +
    (bdLines.length > 0 ? `📊 *Breakdown*\n${bdLines.join('\n')}\n\n` : '') +
    (lbLines.length > 0 ? `🏅 *Top Racers*\n${lbLines.join('\n')}\n\n` : '') +
    `*How to earn*\n` +
    `📈 1.5 pts per 1 NEAR traded (buys & sells)\n` +
    `👥 500 pts per qualified referral + 5% of their trading points\n` +
    `🔥 25 pts every day you trade — streaks boost up to ×2\n\n` +
    `_Points convert to $RACER pro-rata at TGE. Points are not tokens and carry no promise of value._`;

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
    cb('💼 Holdings', 'menu_holdings', 'primary'),
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
    `💳 *RacerBot Trading Wallet*\n\n` +
    `🔑 Account: \`${b.subaccountId}\`\n\n` +
    `💰 *Balances*:\n` +
    `• *Native NEAR*: \`${b.nativeNearFormatted} NEAR\` (\`${b.nativeNearUsd}\`)\n` +
    `• *Wrapped NEAR*: \`${b.wrapNearFormatted} wNEAR\` (\`${b.wrapNearUsd}\`)\n` +
    `• *Total*: \`${b.totalNearFormatted} NEAR\` (\`${b.totalNearUsd}\`)\n\n` +
    `📥 *Deposit Address*:\n` +
    `Send native NEAR directly to:\n` +
    `\`${b.subaccountId}\`\n\n` +
    `⚡ *Instant Execution*:\n` +
    `Deposited NEAR is immediately ready for manual and automated sniping.\n\n` +
    `📝 *Note*: 0.05 NEAR is reserved for account storage and is not spendable.`;

  return { text, keyboard: Markup.inlineKeyboard(buttons) };
}

// ── Helper: Build Token Details Card with In-Chat Buttons ───────────────────
export async function buildTokenCard(tokenAddress: string, telegramId?: number): Promise<{ text: string; keyboard: any; pnlCardImage?: Buffer }> {
  // Fetch token info, balance, and user settings in parallel
  const [info, balances, user] = await Promise.allSettled([
    getTokenInfo(tokenAddress, true),
    telegramId ? getUserBalances(telegramId).catch(() => null) : Promise.resolve(null),
    telegramId ? getUserByTelegramId(telegramId).catch(() => null) : Promise.resolve(null),
  ]);

  if (info.status === 'rejected') {
    throw info.reason;
  }

  const tokenInfo = info.value;
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
    venueText = `💧 *Venue*: Gaypad Launchpad`;
  } else if (tokenInfo.tradeable) {
    venueText = `💧 *Venue*: NEAR Protocol DEX`;
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

  let pnlCardImage: Buffer | null = null;

  // If user holds the token, add holdings info and PNL card
  if (holdsToken && userPosition) {
    const entryPrice = parseFloat(userPosition.avg_entry_price) || 0;
    const pnlPct = priceNum > 0 && entryPrice > 0
      ? ((priceNum - entryPrice) / entryPrice * 100).toFixed(1)
      : 'N/A';
    const emoji = parseFloat(pnlPct) >= 0 ? '🟢' : '🔴';
    const pnlDisplay = pnlPct === 'N/A' ? 'N/A' : `${parseFloat(pnlPct) >= 0 ? '+' : ''}${pnlPct}%`;

    const formattedQty = formatHoldingQuantity(userPosition.quantity_held, tokenInfo.decimals);
    text += `\n💼 *Your Holdings*:\n`;
    text += `  Quantity: \`${formattedQty}\`\n`;
    text += `  Entry Price: \`${entryPrice.toFixed(8)} NEAR\`\n`;
    text += `  Current PNL: ${emoji} \`${pnlDisplay}\`\n\n`;

    // Generate PNL card with image (image will be sent by the calling handler)
    try {
      const pnlCard = await generatePNLCard(userPosition.id);
      if (pnlCard.image) {
        pnlCardImage = pnlCard.image;
      } else {
        // Fallback to text only
        text += `${pnlCard.text}\n\n`;
      }
    } catch (err: any) {
      console.error('Failed to generate PNL card:', err);
      // Continue without PNL card if generation fails
    }
  }

  // ── Buttons depend on whether trading is supported and if user holds token ──
  let shareButtonRow: any[] = [];
  if (userRecord) {
    try {
      const shareCode = await getOrCreateTokenShare(userRecord.id, tokenAddress);
      const shareDeepLink = `https://t.me/racertradingbot?start=${shareCode}`;
      const sym = tokenInfo.symbol || 'TOKEN';
      const shareText = `Trade $${sym} on RacerBot 🏎\n⚡ Instant 1-click execution on NEAR DEXs`;
      const tgShareUrl = `https://t.me/share/url?url=${encodeURIComponent(shareDeepLink)}&text=${encodeURIComponent(shareText)}`;
      shareButtonRow = [[Markup.button.url('📤 Share Token (Earn 5% Fees)', tgShareUrl)]];
    } catch (err: any) {
      console.warn('[buildTokenCard] Failed to generate share link:', err?.message);
    }
  }

  let keyboard;

  if (tokenInfo.tradeable) {
    if (holdsToken && userPosition) {
      // User holds token - show BOTH BUY and SELL options with Green / Red color coding
      text += `⚡ *Manage Position* (Buy More or Sell):\n`;
      const defaultBuyPct = userRecord?.default_buy_pct ? Number(userRecord.default_buy_pct) : 10;
      keyboard = Markup.inlineKeyboard([
        // Quick-buy fixed amounts (green)
        [
          cb('1 N', `buy_fixed:${tokenInfo.address}:1`, 'success'),
          cb('5 N', `buy_fixed:${tokenInfo.address}:5`, 'success'),
          cb('10 N', `buy_fixed:${tokenInfo.address}:10`, 'success'),
        ],
        // Custom amount — full width
        [cb('🟢 Buy X NEAR', `buy_custom_prompt:${tokenInfo.address}`, 'success')],
        // Buy % of balance (green)
        [
          cb(`${defaultBuyPct === 10 ? '✓ ' : ''}10%`, `buy_pct:${tokenInfo.address}:10`, 'success'),
          cb(`${defaultBuyPct === 50 ? '✓ ' : ''}50%`, `buy_pct:${tokenInfo.address}:50`, 'success'),
          cb(`${defaultBuyPct === 100 ? '✓ ' : ''}100%`, `buy_pct:${tokenInfo.address}:100`, 'success'),
        ],
        // Sell % (red)
        [
          cb('25%', `sell:${userPosition.id}:25`, 'danger'),
          cb('50%', `sell:${userPosition.id}:50`, 'danger'),
          cb('100%', `sell:${userPosition.id}:100`, 'danger'),
        ],
        [cb('🔴 Sell Initial', `sell_initial:${userPosition.id}`, 'danger')],
        ...linkRows,
        ...shareButtonRow,
        [
          cb('🔄 Refresh', `token_refresh:${tokenInfo.address}`, 'primary'),
          cb('⚙️ Settings', 'menu_settings', 'primary'),
          cb('🔙 Back', 'menu_home', 'primary'),
        ],
        [
          Markup.button.url('💬 Community', 'https://t.me/racerbot_community'),
          Markup.button.url('📢 Updates', 'https://t.me/racertrading'),
          Markup.button.url('𝕏 X', 'https://x.com/racertradingbot'),
        ],
      ]);
    } else {
      // User doesn't hold token - show BUY options (Green 🟢)
      text += `⚡ *Choose Buy Amount* (Fixed or % of Balance):\n`;
      keyboard = Markup.inlineKeyboard([
        [
          cb('1 N', `buy_fixed:${tokenInfo.address}:1`, 'success'),
          cb('5 N', `buy_fixed:${tokenInfo.address}:5`, 'success'),
          cb('10 N', `buy_fixed:${tokenInfo.address}:10`, 'success'),
        ],
        [cb('🟢 Buy X NEAR', `buy_custom_prompt:${tokenInfo.address}`, 'success')],
        [
          cb(`${defaultBuyPct === 10 ? '✓ ' : ''}10%`, `buy_pct:${tokenInfo.address}:10`, 'success'),
          cb(`${defaultBuyPct === 50 ? '✓ ' : ''}50%`, `buy_pct:${tokenInfo.address}:50`, 'success'),
          cb(`${defaultBuyPct === 100 ? '✓ ' : ''}100%`, `buy_pct:${tokenInfo.address}:100`, 'success'),
        ],
        ...linkRows,
        ...shareButtonRow,
        [
          cb('🔄 Refresh', `token_refresh:${tokenInfo.address}`, 'primary'),
          cb('⚙️ Settings', 'menu_settings', 'primary'),
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
    const venueNote = '⚠️ This token was detected but its trading venue is not supported. Paste the CA into a supported DEX.';
    text += venueNote;
    keyboard = Markup.inlineKeyboard([
      ...linkRows,
      ...shareButtonRow,
      [
        Markup.button.callback('🔄 Refresh', `token_refresh:${tokenInfo.address}`),
        Markup.button.callback('🔙 Back', 'menu_home'),
      ],
      [
        Markup.button.url('💬 Community', 'https://t.me/racerbot_community'),
        Markup.button.url('📢 Updates', 'https://t.me/racertrading'),
        Markup.button.url('𝕏 X', 'https://x.com/racertradingbot'),
      ],
    ]);
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
        cb('🔴 Sell Initial', `sell_initial:${positionId}`, 'danger'),
        cb('🟢 Buy More', `buy_custom_prompt:${position.token_address}`, 'success'),
      ]);
    }

    if (user) {
      try {
        const shareCode = await getOrCreateTokenShare(user.id, position.token_address);
        const shareDeepLink = `https://t.me/racertradingbot?start=${shareCode}`;
        const sym = (pnlCard as any).tokenTicker || 'TOKEN';
        const shareText = `Trade $${sym} on RacerBot 🏎\n⚡ Instant 1-click execution on NEAR DEXs`;
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
    `Configure your manual trading defaults below. Snipe automation lives in 🎯 Snipe Rules.\n\n` +
    `• *Slippage Tolerance*: \`${slip}%\`\n` +
    `• *Default Manual Buy*: \`${buyPct}%\`\n` +
    `• *Default Manual Sell*: \`${sellPct}%\`\n` +
    `• *Net Worth on PNL Card*: ${showNetWorth ? '🟢 *Shown*' : '🔴 *Hidden*'}`;

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

// ── Helper: Build Snipe Rules Dashboard ─────────────────────────────────────
export function buildSnipeDashboard(user: UserRecord) {
  const autoBuy = user.auto_buy_enabled;
  const autoAmt = user.auto_buy_amount_near ? Number(user.auto_buy_amount_near) : 1;
  const minLiq = user.auto_buy_min_liquidity_near ? Number(user.auto_buy_min_liquidity_near) : 0;

  const text =
    `🎯 *Snipe Rules*\n\n` +
    `Automatically buy new token launches the moment they appear. Configure your rules below:\n\n` +
    `• *Auto-Buy New Launches*: ${autoBuy ? '🟢 *Enabled*' : '🔴 *Disabled*'}\n` +
    `• *Auto-Buy Amount*: \`${autoAmt} NEAR\`\n` +
    `• *Min Pool Liquidity*: \`${minLiq} NEAR\`\n\n` +
    `*Targeted Snipes* (custom amount each):\n` +
    `• 🎯 *Token CA* — snipe one specific token, now or the moment it launches\n` +
    `• 👤 *Deployer* — snipe EVERY token a chosen wallet launches`;

  const keyboard = Markup.inlineKeyboard([
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
      cb('📋 My Snipe Orders', 'snipe_orders', 'primary'),
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
      cb('✏️ Custom Auto-Buy', 'prompt:custom_auto_buy', 'primary'),
      cb('✏️ Custom Min Liq', 'prompt:custom_min_liq', 'primary'),
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

// ── User-Friendly Error Messages ────────────────────────────────────────
function getUserFriendlyError(error: Error | string): string {
  const errorMsg = typeof error === 'string' ? error : (error.message || String(error));
  console.error('[USER_ERROR]', errorMsg);
  const r = errorMsg.toLowerCase();

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
  if (r.includes('available balance') && r.includes('too low'))
    return errorMsg.slice(0, 280);
  if (r.includes('insufficient near') || r.includes('not enough near'))
    return errorMsg.slice(0, 280);
  if (r.includes('insufficient token balance'))
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
  tokenAddress: string,
  amountNear: number,
  onProgress?: (stage: string) => void
): Promise<{ success: boolean; amountNear: number; tokenAddress: string; message: string; positionId?: string; tokenName?: string; tokenSymbol?: string; tokenQty?: string; priceNear?: number; nearSpent?: number }> {
  const user = await getUserByTelegramId(telegramId);
  if (!user) {
    throw new Error('Please run /start to set up your trading wallet first.');
  }

  if (amountNear < 0.001) {
    throw new Error('Minimum buy amount is 0.001 NEAR.');
  }

  // Hot path: resolve only the token route needed for a quote. The executor
  // performs the authoritative native/wNEAR balance check immediately before
  // signing, so duplicating balance and Ref-storage RPC reads here only delays
  // broadcast without improving safety.
  const info = await getTokenInfo(tokenAddress, false).catch(() => null);
  if (!info || !['rhea', 'ref', 'shardsmarket', 'nearlytrade', 'intear', 'onetokenhub', 'nearpad', 'gaypad', 'memecooking'].includes(info.venue)) {
    if (info && !info.tradeable) {
      const venueName = info.venue === 'memecooking' ? 'Meme.Cooking' : info.venue;
      throw new Error(`Token is on ${venueName} which is not yet supported for direct trading via RacerBot.`);
    }
    throw new Error('Could not determine DEX venue for token. Please verify the contract address.');
  }
  const venue = info.venue as 'rhea' | 'ref' | 'shardsmarket' | 'nearlytrade' | 'intear' | 'onetokenhub' | 'nearpad' | 'gaypad' | 'memecooking';
  const effectiveDclPoolId = info.dcl_pool_id ?? undefined;
  const effectiveRheaPoolId = info.rhea_pool_id ?? undefined;

  if (info.bonding_phase === 'prebonded' && !effectiveRheaPoolId && !effectiveDclPoolId) {
    // NearlyTrade: tokens can be tradable even while still in the bonding range
    // (step=Done, pool Running), so only block when there's truly no pool yet.
    if (venue !== 'nearlytrade') {
      throw new Error('Token is still in its bonding curve phase — wait for it to bond before buying.');
    }
    // For nearlytrade, let the executor resolve whether the pool is live.
  }

  const near = getNear();
  const slippagePct = user.slippage_pct ? Number(user.slippage_pct) : 2.0;
  const amountInYocto = nearUtils.format.parseNearAmount(amountNear.toString()) ?? '0';

  // FIX: computeMinAmountOut must use the SWAP amount (98.5% after 1.5% fee),
  // not the full input. The executor skims the fee before calling the DEX, so
  // quoting against the full amount results in a minAmountOut that the DEX can
  // never satisfy — causing every trade to appear as a slippage breach.
  const amountInBigInt = BigInt(amountInYocto);
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
  // Start the short executor quote-freshness window only once the live quote
  // is available, never while waiting for the quote RPC itself.
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
    quoted_at: quoteCompletedAt, // executor skips its second quote while < 2s old
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

  // Position baseline at entry (t=0): position value is initialized at entry price, PnL starts at +0.0%
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
// FIX 3 (continued): Use the cached getUserBalances rather than a raw RPC balance call.
async function executeBuyPctHelper(telegramId: number, tokenAddress: string, pct: number, onProgress?: (stage: string) => void) {
  const user = await getUserByTelegramId(telegramId);
  if (!user) throw new Error('Please run /start to set up your wallet first.');

  // Lightweight trade balance: spendable native NEAR only, no USD feed (5s TTL).
  // balanceNear is ALREADY net of the 0.05 NEAR gas/storage reserve.
  const balanceNear = await getTradeSpendableNear(telegramId);

  const usableBalance = balanceNear;
  const amountNear = (usableBalance * pct) / 100;
  if (amountNear < 0.005) {
    throw new Error(`Available balance (${usableBalance.toFixed(4)} NEAR after gas/storage reserve) is too low to buy.`);
  }
  return executeBuyHelper(telegramId, tokenAddress, Number(amountNear.toFixed(4)), onProgress);
}

async function buildBuySuccessKeyboard(telegramId: number, tokenAddress: string, tokenSymbol?: string) {
  const rows: any[] = [];
  try {
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
  rows.push([Markup.button.callback('🔄 Refresh Token Card', `token_refresh:${tokenAddress}`)]);
  return Markup.inlineKeyboard(rows).reply_markup;
}

export function setupRoutes(bot: Telegraf): void {

  // ── /start — custodial onboarding with in-chat menu buttons ────────────────
  bot.command('start', async (ctx) => {
    const telegramId = ctx.from!.id;
    const args = ctx.message!.text!.split(' ').slice(1);
    const payload = args[0] || undefined;
    const username = ctx.from!.username || undefined;

    try {
      // ── Token share deep link: /start t_XXXXXXXX ─────────────────────────────
      // When a user taps a token share link, the payload starts with "t_".
      // We onboard them normally (registering any account referral in the payload
      // only if it is NOT a token-share code), then record the token referral and
      // immediately surface the token card.
      const isTokenShare = payload?.startsWith('t_') ?? false;

      // For standard referral codes we pass the code to onboardUser; for token-share
      // codes we pass undefined so no account-level referral is (mis)attributed.
      const accountReferralCode = isTokenShare ? undefined : payload;

      const result = await onboardUser(telegramId, accountReferralCode, username);

      if (isTokenShare && payload) {
        // Look up the token share record
        const shareRecord = await getTokenShareByCode(payload).catch(() => null);

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

      if (result.isExisting) {
        await ctx.reply(menu.text, { parse_mode: 'Markdown', ...menu.keyboard });
        return;
      }

      // Freshly created account: show dedicated NEAR trading wallet address + onboarding guide (no raw private key)
      await ctx.reply(
        `🚀 *Welcome to RacerBot!*\n\n` +
        `Your dedicated NEAR high-speed trading wallet is ready:\n\n` +
        `🔑 *Wallet Address* (tap to copy):\n` +
        `\`${result.subaccountId}\`\n\n` +
        `📥 *Deposit NEAR to Start*:\n` +
        `Send native NEAR directly to your address above to start trading instantly.\n\n` +
        `🛡️ *Private Key & Security*:\n` +
        `• Your wallet is non-custodial and protected on-chain.\n` +
        `• For your privacy, private keys are hidden in public chat.\n` +
        `• You can export your private key anytime under *⚙️ Settings* or by tapping *🔑 Export Key* below.\n\n` +
        `💡 *How to Trade*:\n` +
        `Paste any Token Contract Address (e.g. \`token.near\`) directly into this chat to view stats, charts, and execute instant 1-click buys!\n\n` +
        `📝 *Note*: 0.05 NEAR is reserved for account storage and is not spendable.\n\n` +
        `🔗 *Join Our Community*:\n` +
        `💬 [Community Group](https://t.me/racerbot_community) - Connect with traders\n` +
        `📢 [Updates Channel](https://t.me/racertrading) - Announcements\n` +
        `𝕏 [X / Twitter](https://x.com/racertradingbot) - Follow updates`,
        { parse_mode: 'Markdown', ...menu.keyboard }
      );

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
      const menu = await buildMainMenu(telegramId, false);
      await ctx.answerCbQuery('Main Menu').catch(() => {});
      await ctx.editMessageText(menu.text, { parse_mode: 'Markdown', ...menu.keyboard }).catch(async () => {
        await ctx.reply(menu.text, { parse_mode: 'Markdown', ...menu.keyboard }).catch(() => {});
      });
    } catch {
      await ctx.answerCbQuery().catch(() => {});
    }
  });

  bot.action(['menu_refresh', 'menu_home_refresh'], async (ctx) => {
    const telegramId = ctx.from!.id;
    await ctx.answerCbQuery('🔄 Refreshing balance...').catch(() => {});
    try {
      const menu = await buildMainMenu(telegramId, true);
      await ctx.reply(menu.text, { parse_mode: 'Markdown', ...menu.keyboard });
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => {});
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
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
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
      const dash = buildSnipeDashboard(user);
      await ctx.answerCbQuery().catch(() => {});
      await ctx.editMessageText(dash.text, { parse_mode: 'Markdown', ...dash.keyboard }).catch(() => {});
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
    }
  });

  // ── Targeted snipes: by token contract address / by deployer wallet ───────

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
      `🎯 *Snipe by Token Contract*\n\n` +
      `Reply with the token contract address (CA), e.g. \`token.nearlytrade.near\`\n\n` +
      `• Already tradable → the buy executes *immediately*\n` +
      `• Not launched/bonded yet → the snipe stays *armed* and fires the moment a pool goes live\n\n` +
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
      `Reply with the NEAR wallet address whose launches you want to snipe, e.g. \`someuser.near\`\n\n` +
      `Every new token that wallet launches will be auto-bought — until you cancel the order.\n\n` +
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
        `📋 *Snipe Orders*\n\nNo orders yet. Set one up with 🎯 Snipe Token CA or 👤 Snipe by Dev.`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[cb('🔙 Back to Snipe Rules', 'menu_snipe', 'primary')]] } }
      );
      return;
    }
    const statusEmoji: Record<string, string> = { active: '🟢', filled: '✅', cancelled: '⚪', failed: '🔴' };
    const lines = orders.map((o) => {
      const target = o.snipe_type === 'token' ? `🪙 \`${o.token_address}\`` : `👤 \`${o.deployer_address}\``;
      const extra = o.snipe_type === 'deployer' && o.trigger_count > 0 ? ` · fired ${o.trigger_count}×` : '';
      const err = o.status === 'failed' && o.last_error ? ` · _${o.last_error.slice(0, 60)}_` : '';
      return `${statusEmoji[o.status] ?? '•'} ${target} — *${o.amount_near} NEAR*${extra}${err}`;
    });
    const buttons: any[] = orders
      .filter((o) => o.status === 'active')
      .map((o) => [
        cb(
          `❌ Cancel ${o.snipe_type === 'token' ? o.token_address : 'dev ' + o.deployer_address}`.slice(0, 60),
          `snipe_order_cancel:${o.id}`,
          'danger'
        ),
      ]);
    buttons.push([cb('🔙 Back to Snipe Rules', 'menu_snipe', 'primary')]);
    await ctx.reply(`📋 *Snipe Orders*\n\n` + lines.join('\n'), {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons },
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
    if (ok) {
      await ctx.editMessageText('✅ Snipe order cancelled.').catch(() => {});
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
    const positions = await getOpenPositions(user.id).catch(() => []);

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

    if (positions.length === 0) {
      const emptyMsg =
        '💼 *Holdings*\n\n' +
        `👛 Wallet: \`${user.subaccount_id}\`\n\n` +
        '📭 You currently have no token holdings in your wallet.\n\n' +
        'Deposit tokens to your wallet address or paste a token CA into chat to start trading!';
      return { msg: emptyMsg, keyboard: emptyKeyboard };
    }

    // Fetch all token info in parallel; forceRefresh pulls live pool prices
    const infoResults = await Promise.allSettled(
      positions.map(pos => getTokenInfo(pos.token_address, forceRefresh))
    );
      const infoMap = new Map<string, TokenInfoResult | null>();
      positions.forEach((pos, i) => {
        const r = infoResults[i];
        infoMap.set(pos.token_address, r.status === 'fulfilled' ? r.value : null);
      });

      // 4. Baseline entry price for newly detected tokens or unbaselined tokens so PNL calculation starts from here
      for (const pos of positions) {
        const info = infoMap.get(pos.token_address);
        const currentPrice = info ? parseFloat(info.price) : 0;
        const entryPrice = parseFloat(pos.avg_entry_price) || 0;
        if (entryPrice <= 0 && currentPrice > 0) {
          pos.avg_entry_price = currentPrice.toString();
          updatePosition({
            position_id: pos.id,
            avg_entry_price: currentPrice.toString(),
          }).catch(() => {});
        }
      }

      let totalPortfolioValueNear = 0;
      let nearUsd = 4.3; // Default fallback
      const buttons: any[] = [];

      const MAX_DISPLAY_HOLDINGS = 20;
      const displayedPositions = positions.slice(0, MAX_DISPLAY_HOLDINGS);
      const remainingCount = positions.length - displayedPositions.length;

      for (const pos of displayedPositions) {
        const info = infoMap.get(pos.token_address);
        const rawSymbol = info?.symbol || (pos.token_address.length > 14 ? pos.token_address.slice(0, 12) + '...' : pos.token_address);
        const displayLabel = sanitizeMd(rawSymbol);
        const currentPrice = info ? parseFloat(info.price) : 0;
        const decimals = info?.decimals ?? 18;
        if (info?.near_usd) nearUsd = info.near_usd;

        let humanQuantity = 0;
        try {
          const rawBig = BigInt((pos.quantity_held || '0').split('.')[0]);
          humanQuantity = Number(rawBig) / Math.pow(10, decimals);
        } catch {
          humanQuantity = parseFloat(pos.quantity_held) || 0;
        }

        const tokenValue = currentPrice * humanQuantity;
        totalPortfolioValueNear += tokenValue;

        const entryPrice = parseFloat(pos.avg_entry_price) || 0;
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

      // Add remaining positions value to total portfolio
      for (const pos of positions.slice(MAX_DISPLAY_HOLDINGS)) {
        const info = infoMap.get(pos.token_address);
        const currentPrice = info ? parseFloat(info.price) : 0;
        const decimals = info?.decimals ?? 18;
        try {
          const rawBig = BigInt((pos.quantity_held || '0').split('.')[0]);
          totalPortfolioValueNear += currentPrice * (Number(rawBig) / Math.pow(10, decimals));
        } catch { /* no-op */ }
      }

      const totalUsd = totalPortfolioValueNear * nearUsd;
      const totalUsdDisplay = totalUsd >= 1000 ? `$${(totalUsd / 1000).toFixed(2)}K` : `$${totalUsd.toFixed(2)}`;

      const overflowNote = remainingCount > 0
        ? `_... and ${remainingCount} more token(s) held in your wallet._\n\n`
        : '';

      const msg =
        `💼 *Holdings (${positions.length})*\n` +
        `👛 Wallet: \`${user.subaccount_id}\`\n` +
        `💰 Total: \`${totalPortfolioValueNear.toFixed(4)} NEAR\` (\`${totalUsdDisplay}\`)\n\n` +
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

      // 1. Instant paint from DB + cached prices
      const view = await buildHoldingsView(user, false);
      let paintedChatId: number | undefined;
      let paintedMessageId: number | undefined;

      const replyPaint = async () => {
        const sent = await ctx.reply(view.msg, { parse_mode: 'Markdown', ...view.keyboard }).catch(() => null);
        paintedChatId = (sent as any)?.chat?.id ?? (ctx.chat as any)?.id;
        paintedMessageId = (sent as any)?.message_id;
      };

      if (isRefresh) {
        await replyPaint();
      } else {
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
            paintedChatId = cbMsg.chat?.id ?? cbMsg.chat_id;
            paintedMessageId = cbMsg.message_id;
          }
        } else {
          await replyPaint();
        }
      }

      // 2. Background reconcile (detached — never blocks the user's paint)
      (async () => {
        try {
          await syncUserTokenDeposits(user.id, user.subaccount_id).catch((err) => {
            console.warn(`[HOLDINGS] Wallet scan error for ${user.subaccount_id}:`, err?.message || err);
          });
          const fresh = await buildHoldingsView(user, true);
          if (fingerprintOf(fresh) === fingerprintOf(view)) return;
          if (paintedChatId && paintedMessageId) {
            await ctx.telegram
              .editMessageText(paintedChatId, paintedMessageId, undefined, fresh.msg, { parse_mode: 'Markdown', ...fresh.keyboard })
              .catch(() => {});
          }
        } catch (err: any) {
          console.warn('[HOLDINGS] Background reconcile error:', err?.message || err);
        }
      })();
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => {});
    }
  }

  // ── menu_holdings — Token list with name/logo and % change ────────────────
  bot.action('menu_holdings', async (ctx) => {
    await handleHoldings(ctx, false);
  });

  bot.action(['refresh_holdings', 'menu_holdings_refresh'], async (ctx) => {
    await (ctx as any).answerCbQuery?.('🔄 Refreshing holdings...').catch(() => {});
    await handleHoldings(ctx, true);
  });

  bot.command('holdings', async (ctx) => {
    await handleHoldings(ctx, false);
  });

  // ── import_token_prompt — Prompt user to paste token CA ───────────────────────
  bot.action('import_token_prompt', async (ctx) => {
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
    );
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

       const [info, fills] = await Promise.all([
         getTokenInfo(position.token_address, true).catch(() => null),
         getFillsByPosition(positionId).catch(() => []),
      ]);

      const symbol = info?.symbol ? sanitizeMd(info.symbol) : '???';
      const currentPrice = info ? parseFloat(info.price) : 0;
      let entryPrice = parseFloat(position.avg_entry_price) || 0;
      if (entryPrice <= 0 && currentPrice > 0) {
        entryPrice = currentPrice;
        position.avg_entry_price = currentPrice.toString();
        updatePosition({
          position_id: position.id,
          avg_entry_price: currentPrice.toString(),
        }).catch(() => {});
      }

      const pnlPct = currentPrice > 0 && entryPrice > 0
        ? ((currentPrice - entryPrice) / entryPrice * 100).toFixed(1)
        : 'N/A';
      const emoji = parseFloat(pnlPct) >= 0 ? '🟢' : '🔴';
      const pnlDisplay = pnlPct === 'N/A' ? 'N/A' : `${parseFloat(pnlPct) >= 0 ? '+' : ''}${pnlPct}%`;

      const nearUsdRate = info?.near_usd || 4.3;

      const formatDualPrice = (priceNear: number) => {
        if (priceNear <= 0) return '`0.00000000 NEAR` ($0.00)';
        const nearStr = priceNear >= 1 ? priceNear.toFixed(4) : priceNear >= 0.0001 ? priceNear.toFixed(6) : priceNear.toFixed(8);
        const usdVal = priceNear * nearUsdRate;
        const usdStr = usdVal >= 1 ? `$${usdVal.toFixed(2)}` : usdVal >= 0.0001 ? `$${usdVal.toFixed(6)}` : `$${usdVal.toFixed(8)}`;
        return `\`${nearStr} NEAR\` (\`${usdStr}\`)`;
      };

      const formatDualValue = (nearVal: number) => {
        const usdVal = nearVal * nearUsdRate;
        const usdStr = usdVal >= 1000 ? `$${(usdVal / 1000).toFixed(2)}K` : `$${usdVal.toFixed(2)}`;
        return `\`${nearVal.toFixed(4)} NEAR\` (\`${usdStr}\`)`;
      };

      const decimals = info?.decimals ?? 18;
      let marketCapDisplay = 'N/A';
      let mcNear = info?.market_cap || 0;
      if (mcNear <= 0 && info?.total_supply && info.total_supply !== '0' && currentPrice > 0) {
        try {
          const rawSupply = BigInt(String(info.total_supply).split('.')[0]);
          const humanSupply = Number(rawSupply) / Math.pow(10, decimals);
          if (humanSupply > 0) {
            mcNear = humanSupply * currentPrice;
          }
        } catch { /* no-op */ }
      }
      if (mcNear > 0) {
        const mcUsd = info?.market_cap_usd || (mcNear * nearUsdRate);
        const mcUsdStr = mcUsd >= 1e6 ? `$${(mcUsd / 1e6).toFixed(2)}M` : mcUsd >= 1e3 ? `$${(mcUsd / 1e3).toFixed(2)}K` : `$${mcUsd.toFixed(2)}`;
        const mcNearStr = mcNear >= 1e6 ? `${(mcNear / 1e6).toFixed(2)}M NEAR` : mcNear >= 1e3 ? `${(mcNear / 1e3).toFixed(2)}K NEAR` : `${mcNear.toFixed(2)} NEAR`;
        marketCapDisplay = `${mcUsdStr} (${mcNearStr})`;
      }

      // Calculate initial investment across all buy fills, or fallback to position entry * qty
      // Fills store raw on-chain token units; prices are NEAR per whole token.
      const toHuman = (rawStr: string): number => {
        const val = parseFloat(rawStr || '0');
        if (val > 1e10 && decimals > 0) return val / Math.pow(10, decimals);
        return val;
      };
      const buys = fills.filter(f => f.side === 'buy');
      let initialInvestment = 0;
      for (const buy of buys) {
        if (buy.tx_hash?.startsWith('deposit_')) continue;
        const amount = toHuman(buy.amount);
        const price = parseFloat(buy.price);
        const fee = parseFloat(buy.fee_paid || '0');
        initialInvestment += (amount * price) + fee;
      }

      let humanQuantity = 0;
      try {
        const rawBig = BigInt((position.quantity_held || '0').split('.')[0]);
        humanQuantity = Number(rawBig) / Math.pow(10, decimals);
      } catch {
        humanQuantity = parseFloat(position.quantity_held || '0');
      }

      if (initialInvestment === 0 && humanQuantity > 0) {
        initialInvestment = humanQuantity * entryPrice;
      }

      const holdingValueNear = humanQuantity * currentPrice;
      const formattedQty = formatHoldingQuantity(position.quantity_held, decimals);

      let msg = `📊 *${symbol} Details*\n\n`;
      msg += `💰 *Price Info*:\n`;
      msg += `  Entry: ${formatDualPrice(entryPrice)}\n`;
      msg += `  Current: ${formatDualPrice(currentPrice)}\n`;
      msg += `  Change: ${emoji} \`${pnlDisplay}\`\n\n`;
      msg += `📈 *Market Cap*: \`${marketCapDisplay}\`\n\n`;
      msg += `💼 *Position*:\n`;
      msg += `  Holding: \`${formattedQty}\` (${formatDualValue(holdingValueNear)})\n`;
      if (showNetWorth) {
        msg += `  Initial Investment: ${formatDualValue(initialInvestment)}\n`;
      }
      msg += `\n`;
      msg += `🔗 *Contract Address*:\n`;
      msg += `  \`${position.token_address}\`\n`;

      // Build keyboard buttons first (needed for both text and image paths)
      const buttons: any[] = [];

      // Sell percentage buttons (Red 🔴)
      buttons.push([
        cb('25%', `sell:${positionId}:25`, 'danger'),
        cb('50%', `sell:${positionId}:50`, 'danger'),
        cb('100%', `sell:${positionId}:100`, 'danger'),
      ]);

      // Buy buttons (Green 🟢)
      buttons.push([
        cb('1 N', `buy_fixed:${position.token_address}:1`, 'success'),
        cb('5 N', `buy_fixed:${position.token_address}:5`, 'success'),
        cb('10 N', `buy_fixed:${position.token_address}:10`, 'success'),
      ]);
      buttons.push([cb('🟢 Buy X NEAR', `buy_custom_prompt:${position.token_address}`, 'success')]);

      // Sell Initial button
      if (initialInvestment > 0) {
        buttons.push([cb('🔴 Sell Initial', `sell_initial:${positionId}`, 'danger')]);
      }

      // External explorer & chart links
      const linkRows = (() => {
        const links = tokenLinks(info?.venue || 'nearlytrade', position.token_address);
        const rows: any[] = [];
        if (links.length > 0) rows.push(links.slice(0, 2).map(l => Markup.button.url(l.label, l.url)));
        if (links.length > 2) rows.push(links.slice(2).map(l => Markup.button.url(l.label, l.url)));
        return rows;
      })();
      buttons.push(...linkRows);

      // Share Token (Earn 5% Fees)
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

      // Navigation buttons
      buttons.push([
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

      // Generate PNL card with image
      let pnlCardImage: Buffer | null = null;
      try {
        const pnlCard = await generatePNLCard(positionId, showNetWorth);
        if (pnlCard.image) {
          pnlCardImage = pnlCard.image;
        } else {
          // Fallback to text only
          msg += `\n${pnlCard.text}`;
        }
      } catch (err: any) {
        console.error('Failed to generate PNL card:', err);
        // Continue without PNL card if generation fails
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
      await ctx.reply('Error loading token details. Please try again.').catch(() => {});
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
    if (!tryAcquireInFlight(guardKey)) {
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
        const tokenInfo = await getTokenInfo(livePosition.token_address, true).catch(() => null);
        const currentPrice = tokenInfo ? parseFloat(tokenInfo.price) : 0;
        const decimals = tokenInfo?.decimals ?? 18;
        // Fills store raw on-chain token units; prices are NEAR per whole token.
        const toHuman = (rawStr: string): number => {
          const val = parseFloat(rawStr || '0');
          if (val > 1e10 && decimals > 0) return val / Math.pow(10, decimals);
          return val;
        };

        // Calculate total initial investment across ALL buy fills (not just first)
        // Include fees paid to get accurate total NEAR invested
        let totalInitialInvestment = 0;
        for (const buy of buys) {
          const amount = toHuman(buy.amount);
          const price = parseFloat(buy.price);
          const fee = parseFloat(buy.fee_paid || '0');
          totalInitialInvestment += (amount * price) + fee;
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
        releaseInFlight(guardKey);
      }
    })().catch((err: any) => {
      releaseInFlight(guardKey);
      console.error('[SELL_INITIAL] Unhandled detached error:', err?.message || err);
      ctx.reply('Error processing sell. Please try again.').catch(() => {});
    });
  });

  // ── menu_positions — Redirect to holdings for backwards compatibility ───────
  bot.action('menu_positions', async (ctx) => {
    await handleHoldings(ctx, true);
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
        const rawAmt = parseFloat(s.amount || '0');
        const decimals = info?.decimals ?? (rawAmt > 1e25 ? 24 : 18);
        const humanQty = rawAmt > 1e10 ? rawAmt / Math.pow(10, decimals) : rawAmt;
        const sellPrice = parseFloat(s.price || '0');
        const sellFee = parseFloat(s.fee_paid || '0');
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
          const sym = info?.symbol ? sanitizeMd(info.symbol) : t.token.split('.')[0].toUpperCase();
          msg += `${tEmoji} *$${sym}*: \`${t.netPnl >= 0 ? '+' : ''}${t.netPnl.toFixed(4)} N\` (\`${tPct >= 0 ? '+' : ''}${tPct.toFixed(1)}%\`) [${t.count} trade${t.count > 1 ? 's' : ''}]\n`;
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
        await ctx.editMessageText(msg, { parse_mode: 'Markdown', ...keyboard }).catch(async () => {
          await ctx.reply(msg, { parse_mode: 'Markdown', ...keyboard });
        });
      } else {
        await ctx.reply(msg, { parse_mode: 'Markdown', ...keyboard });
      }
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
    }
  };

  bot.action(/^pnl_tf:(24h|7d|30d|all)$/, async (ctx) => {
    const tf = ctx.match![1] as PnlTimeframe;
    await ctx.answerCbQuery().catch(() => {});
    await handlePnl(ctx, tf);
  });

  bot.action(['menu_pnl', 'refresh_pnl'], async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await handlePnl(ctx, '24h');
  });

  bot.command('pnl', async (ctx) => {
    await handlePnl(ctx, '24h');
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
      await ctx.answerCbQuery('🔄 Refreshing wallet...').catch(() => {});
      const wallet = await buildWalletMenu(telegramId, true);
      await ctx.reply(wallet.text, { parse_mode: 'Markdown', ...wallet.keyboard });
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => {});
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
    const telegramId = ctx.from!.id;
    const user = await getUserByTelegramId(telegramId);
    if (!user) return;
    const newStatus = !user.auto_buy_enabled;
    const updated = await updateUserSettings(user.id, { auto_buy_enabled: newStatus });
    await ctx.answerCbQuery(`Auto-buy ${newStatus ? 'enabled' : 'disabled'}`).catch(() => {});
    const dash = buildSnipeDashboard(updated);
    await ctx.editMessageText(dash.text, { parse_mode: 'Markdown', ...dash.keyboard }).catch(() => {});
  });

  bot.action('set:toggle_show_net_worth', async (ctx) => {
    const telegramId = ctx.from!.id;
    const user = await getUserByTelegramId(telegramId);
    if (!user) return;
    const current = user.show_net_worth_on_card !== false;
    const updated = await updateUserSettings(user.id, { show_net_worth_on_card: !current });
    await ctx.answerCbQuery(`Net worth on cards ${!current ? 'shown' : 'hidden'}`).catch(() => {});
    const dash = buildSettingsDashboard(updated);
    await ctx.editMessageText(dash.text, { parse_mode: 'Markdown', ...dash.keyboard }).catch(() => {});
  });

  bot.action(/^toggle_pnl_nw:([^:]+):([01])$/, async (ctx) => {
    const positionId = ctx.match![1];
    const showNw = ctx.match![2] === '1';
    await ctx.answerCbQuery(showNw ? 'Showing net worth...' : 'Hiding net worth...').catch(() => {});
    await ctx.deleteMessage().catch(() => {});
    await sendPnlCardMessage(ctx, positionId, undefined, showNw);
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
    const dash = buildSnipeDashboard(updated);
    await ctx.editMessageText(dash.text, { parse_mode: 'Markdown', ...dash.keyboard }).catch(() => {});
  });

  bot.action(/^set:min_liq:([0-9.]+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const liq = parseFloat(ctx.match![1]);
    const user = await getUserByTelegramId(telegramId);
    if (!user) return;
    const updated = await updateUserSettings(user.id, { auto_buy_min_liquidity_near: liq });
    await ctx.answerCbQuery(`Min liquidity set to ${liq} NEAR`).catch(() => {});
    const dash = buildSnipeDashboard(updated);
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
      await sendTokenCard(ctx, card);
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
    }
  });

  // Refresh token card — instantly sends a new text message of the updated information
  bot.action(/^token_refresh:(.+)$/, async (ctx) => {
    const tokenAddress = ctx.match![1];
    const telegramId = ctx.from!.id;
    try {
      await ctx.answerCbQuery('🔄 Refreshed!').catch(() => {});
      const card = await buildTokenCard(tokenAddress, telegramId);
      await sendTokenCard(ctx, card);
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => {});
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
    const tokenAddress = ctx.match![1];
    const amountNear = parseFloat(ctx.match![2]);
    const telegramId = ctx.from!.id;
    console.log(`[BUY_FIXED] Click: user=${telegramId}, token=${tokenAddress}, amount=${amountNear} NEAR`);

    // In-flight guard: reject a duplicate tap while a trade for this token is running.
    const guardKey = inFlightKey(telegramId, tokenAddress, 'buy');
    if (!tryAcquireInFlight(guardKey)) {
      console.warn(`[BUY_FIXED] Duplicate tap rejected: guardKey=${guardKey}`);
      await ctx.answerCbQuery('A trade for this token is already in progress.').catch(() => {});
      return;
    }
    await ctx.answerCbQuery(`⚡ Processing buy order for ${amountNear} NEAR...`).catch(() => {});

    (async () => {
      const procMsg = await ctx.reply(`⏳ *Processing Buy Order...*\n\nExchanging \`${amountNear} NEAR\` for \`${tokenAddress}\`...\n_Executing swap on DEX..._`, { parse_mode: 'Markdown' }).catch(() => null);
      const onStage = makeStageEditor(ctx, procMsg, 'Processing Buy Order');
      try {
        console.log(`[BUY_FIXED] Starting executeBuyHelper: user=${telegramId}, token=${tokenAddress}, amount=${amountNear}`);
        const res = await executeBuyHelper(telegramId, tokenAddress, amountNear, onStage);
        console.log(`[BUY_FIXED] Success: user=${telegramId}, token=${tokenAddress}, pos=${res.positionId}`);
        if (procMsg) await ctx.deleteMessage(procMsg.message_id).catch(() => {});

        await ctx.reply(res.message, {
          parse_mode: 'Markdown',
          reply_markup: await buildBuySuccessKeyboard(telegramId, tokenAddress, res.tokenSymbol),
        });
      } catch (err: any) {
        console.error(`[BUY_FIXED] Failed: user=${telegramId}, token=${tokenAddress}, error=${err?.message}`, err);
        if (procMsg) await ctx.deleteMessage(procMsg.message_id).catch(() => {});
        await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => {});
      } finally {
        releaseInFlight(guardKey);
      }
    })().catch((err: any) => {
      // Last-resort net: the body above always sends a final message; if it
      // itself crashed (e.g. Telegram API down), still release the guard.
      releaseInFlight(guardKey);
      console.error('[BUY] Unhandled detached buy error:', err?.message || err);
    });
  });

  // Percentage buy: buy_pct:<token>:<pct> or legacy buy:<token>:<pct>
  // Same detached + in-flight-guard structure as buy_fixed.
  bot.action(/^(?:buy_pct|buy):(.+):(\d+)$/, async (ctx) => {
    const tokenAddress = ctx.match![1];
    const pct = parseInt(ctx.match![2]);
    const telegramId = ctx.from!.id;
    console.log(`[BUY_PCT] Click: user=${telegramId}, token=${tokenAddress}, pct=${pct}%`);

    const guardKey = inFlightKey(telegramId, tokenAddress, 'buy');
    if (!tryAcquireInFlight(guardKey)) {
      console.warn(`[BUY_PCT] Duplicate tap rejected: guardKey=${guardKey}`);
      await ctx.answerCbQuery('A trade for this token is already in progress.').catch(() => {});
      return;
    }
    await ctx.answerCbQuery(`⚡ Processing buy order for ${pct}% of balance...`).catch(() => {});

    (async () => {
      const procMsg = await ctx.reply(`⏳ *Processing Buy Order (${pct}%)...*\n\nExchanging NEAR for \`${tokenAddress}\`...\n_Executing swap on DEX..._`, { parse_mode: 'Markdown' }).catch(() => null);
      const onStage = makeStageEditor(ctx, procMsg, `Processing Buy Order (${pct}%)`);
      try {
        console.log(`[BUY_PCT] Starting executeBuyPctHelper: user=${telegramId}, token=${tokenAddress}, pct=${pct}%`);
        const res = await executeBuyPctHelper(telegramId, tokenAddress, pct, onStage);
        console.log(`[BUY_PCT] Success: user=${telegramId}, token=${tokenAddress}, pos=${res.positionId}`);
        if (procMsg) await ctx.deleteMessage(procMsg.message_id).catch(() => {});

        await ctx.reply(res.message, {
          parse_mode: 'Markdown',
          reply_markup: await buildBuySuccessKeyboard(telegramId, tokenAddress, res.tokenSymbol),
        });
      } catch (err: any) {
        console.error(`[BUY_PCT] Failed: user=${telegramId}, token=${tokenAddress}, error=${err?.message}`, err);
        if (procMsg) await ctx.deleteMessage(procMsg.message_id).catch(() => {});
        await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => {});
      } finally {
        releaseInFlight(guardKey);
      }
    })().catch((err: any) => {
      releaseInFlight(guardKey);
      console.error('[BUY] Unhandled detached pct-buy error:', err?.message || err);
    });
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
        prewarmTradePath(telegramId, tokenAddress).catch(() => {});
        await sendTokenCard(ctx, card);
      } catch {
        await ctx.reply('Specify amount in NEAR: /buy <token_ca> <amount_near>');
      }
      return;
    }

    const guardKey = inFlightKey(telegramId, tokenAddress, 'buy');
    if (!tryAcquireInFlight(guardKey)) {
      await ctx.answerCbQuery('A trade for this token is already in progress.').catch(() => {});
      return;
    }

    (async () => {
      const procMsg = await ctx.reply(`⏳ *Processing Buy Order...*\n\nExchanging \`${amountNear} NEAR\` for \`${tokenAddress}\`...\n_Executing swap on DEX..._`, { parse_mode: 'Markdown' }).catch(() => null);
      const onStage = makeStageEditor(ctx, procMsg, 'Processing Buy Order');
      try {
        const res = await executeBuyHelper(telegramId, tokenAddress, amountNear, onStage);
        if (procMsg) await ctx.deleteMessage(procMsg.message_id).catch(() => {});

        await ctx.reply(res.message, {
          parse_mode: 'Markdown',
          reply_markup: await buildBuySuccessKeyboard(telegramId, tokenAddress, res.tokenSymbol),
        });
      } catch (err: any) {
        if (procMsg) await ctx.deleteMessage(procMsg.message_id).catch(() => {});
        await ctx.reply(`❌ ${getUserFriendlyError(err)}`).catch(() => {});
      } finally {
        releaseInFlight(guardKey);
      }
    })().catch((err: any) => {
      releaseInFlight(guardKey);
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
        positions.map(pos => getTokenInfo(pos.token_address, true))
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
    if (!tryAcquireInFlight(guardKey)) {
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
        releaseInFlight(guardKey);
      }

      if (result.success) {
        await sendPnlCardMessage(ctx, positionId, `✅ *Sell Order Executed!* (${pct}%)`).catch(() => {});
      } else {
        await ctx.reply(`❌ Sell failed: ${result.reason || 'Unknown error'}`).catch(() => {});
      }
    })().catch((err: any) => {
      releaseInFlight(guardKey);
      console.error('[SELL] Unhandled detached sell error:', err?.message || err);
      ctx.reply('❌ Sell failed unexpectedly. Please check /positions and retry.').catch(() => {});
    });
  });

  // ── /positions & /pnl ─────────────────────────────────────────────────────
  bot.command('positions', async (ctx) => {
    await handleHoldings(ctx, false);
  });



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
        await ctx.reply(`⚡ Sniping \`${query}\` with ${amountNear} NEAR...`, { parse_mode: 'Markdown' });
        try {
          const res = await executeBuyHelper(telegramId, query, amountNear);
          await ctx.reply(res.message, {
            parse_mode: 'Markdown',
            reply_markup: await buildBuySuccessKeyboard(telegramId, query, res.tokenSymbol),
          });
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
        reply_markup: await buildBuySuccessKeyboard(telegramId, tokenAddress, res.tokenSymbol),
      });
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
    console.log(`[AUDIT] Private key exported for user_id=${user.id}, telegram_id=${telegramId}`);

    try {
      const rawPrivateKey = decrypt(user.scoped_key_encrypted, MASTER_KEY);
      await ctx.answerCbQuery('Key decrypted.').catch(() => {});

      const keyMessage = await ctx.reply(
        `🔑 <b>Private Key for Account</b> <code>${user.subaccount_id}</code>:\n\n` +
        `<tg-spoiler><code>${rawPrivateKey}</code></tg-spoiler>\n\n` +
        `👆 <i>Tap the covered box above to uncover and copy your private key.</i>\n\n` +
        `<b>Import Instructions</b>:\n` +
        `Paste this string into MyNearWallet, Meteor Wallet, or near-cli via "Import Private Key" to control your account outside RacerBot.\n\n` +
        `⚠️ <i>This message will automatically delete in 2 minutes for security.</i>`,
        { parse_mode: 'HTML' }
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

    const text =
      `🎁 *Referral Program*\n\n` +
      `Your referral link:\n` +
      `\`${referralLink}\`\n\n` +
      `📊 *Global Referrals* (account sign-ups):\n` +
      `• Total referrals: ${referrals.length}\n` +
      `• Active referrals: ${activeReferrals}\n` +
      `• Earnings: \`${globalEarnings.toFixed(4)} NEAR\` (30% fee share)\n\n` +
      `📤 *Token Share Links*:\n` +
      `• Traders via your links: ${tokenShareCount}\n` +
      `• Earnings: \`${tokenShareEarnings.toFixed(4)} NEAR\` (5% fee share)\n\n` +
      `💰 *Combined Totals*:\n` +
      `• Total earned: \`${totalEarnings.toFixed(4)} NEAR\`\n` +
      `• Already claimed: \`${totalClaimed.toFixed(4)} NEAR\`\n` +
      `• Claimable: \`${claimableNear.toFixed(4)} NEAR\` (~$${claimableUsd.toFixed(2)})\n\n` +
      `💡 *How to earn more*:\n` +
      `• Earn *30%* of fees from every user you refer with your referral link\n` +
      `• Earn *5%* of fees when someone trades via your *📤 Share Token* links\n` +
      `• Claim once your rewards reach $${REFERRAL_CLAIM_MIN_USD} — paid straight to your RacerBot wallet`;

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
    if (!tryAcquireInFlight(guardKey)) {
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
      releaseInFlight(guardKey);
    }
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
        const tokenAddress = pending.tokenAddress;
        const guardKey = inFlightKey(telegramId, tokenAddress, 'buy');
        if (!tryAcquireInFlight(guardKey)) {
          await ctx.reply('⏳ A trade for this token is already in progress.');
          return;
        }

        (async () => {
          const procMsg = await ctx.reply(`⏳ *Processing Buy Order...*\n\nExchanging \`${amt} NEAR\` for \`${tokenAddress}\`...\n_Executing swap on DEX..._`, { parse_mode: 'Markdown' }).catch(() => null);
          const onStage = makeStageEditor(ctx, procMsg, 'Processing Buy Order');
          try {
            const res = await executeBuyHelper(telegramId, tokenAddress, amt, onStage);
            if (procMsg) await ctx.deleteMessage(procMsg.message_id).catch(() => {});

            await ctx.reply(res.message, {
              parse_mode: 'Markdown',
              reply_markup: await buildBuySuccessKeyboard(telegramId, tokenAddress, res.tokenSymbol),
            });
          } catch (err: any) {
            console.warn(`[BUY] Buy failed for ${tokenAddress}:`, err?.message || err);
            if (procMsg) await ctx.deleteMessage(procMsg.message_id).catch(() => {});
            try {
              await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
            } catch {
              console.error(`[BUY] Failed to send error message for ${tokenAddress}:`, err?.message || err);
            }
          } finally {
            releaseInFlight(guardKey);
          }
        })().catch((err: any) => {
          releaseInFlight(guardKey);
          console.error('[BUY] Unhandled detached custom-buy error:', err?.message || err);
        });
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
          const dash = buildSnipeDashboard(updated);
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
          const dash = buildSnipeDashboard(updated);
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
        const order = await createSnipeOrder({
          user_id: user.id,
          snipe_type: 'token',
          token_address: tokenAddress,
          amount_near: amt,
        });

        // Already tradable → fire immediately through the normal buy path.
        // Not tradable yet → the order stays armed; the detector fires it the
        // moment the token launches / bonds.
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
              reply_markup: await buildBuySuccessKeyboard(telegramId, tokenAddress, res.tokenSymbol),
            });
          } catch (err: any) {
            if (procMsg) await ctx.deleteMessage(procMsg.message_id).catch(() => {});
            if (triggerId) await markSnipeTriggerFailed(triggerId, err?.message ?? 'buy_failed').catch(() => {});
            await markSnipeOrderResult(order.id, false, err?.message ?? 'buy_failed').catch(() => {});
            await ctx.reply(`❌ Snipe failed: ${getUserFriendlyError(err)}`);
          }
        } else {
          await ctx.reply(
            `🎯 *Snipe Armed!*\n\n` +
            `🪙 Token: \`${tokenAddress}\`\n` +
            `💰 Amount: \`${amt} NEAR\`\n\n` +
            `The token is not tradable yet — your snipe fires automatically the moment a pool goes live. No need to watch the chart.\n` +
            `Manage it in 🎯 Snipe Rules → 📋 My Snipe Orders.`,
            { parse_mode: 'Markdown' }
          );
        }
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
        await createSnipeOrder({
          user_id: user.id,
          snipe_type: 'deployer',
          deployer_address: pending.deployerAddress,
          amount_near: amt,
        });
        await ctx.reply(
          `👤 *Deployer Snipe Armed!*\n\n` +
          `🧑‍💻 Deployer: \`${pending.deployerAddress}\`\n` +
          `💰 Amount per launch: \`${amt} NEAR\`\n\n` +
          `Every new token launched by this wallet will be auto-bought the moment it's detected — until you cancel in 🎯 Snipe Rules → 📋 My Snipe Orders.`,
          { parse_mode: 'Markdown' }
        );
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
    }

    // 2. Direct Token Contract Address Detection (Upon pasting a token address)
    // Match any string ending in .near, .tg, or .testnet, or 64-char hex addresses
    const nearCaRegex = /(?:^|\s)([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*\.(?:near|tg|testnet))(?:\s|$)/i;
    const hex64Regex = /(?:^|\s)([0-9a-fA-F]{64})(?:\s|$)/;
    const caMatch = nearCaRegex.exec(rawText) || hex64Regex.exec(rawText);
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
          `• The contract address is incorrect\n` +
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
      `💡 *Paste any NEAR token address* (e.g. \`wrap.near\`) directly into this chat to view price, liquidity, and 1-click buy buttons!\n\n` +
      `Or use the menu below:`,
      { parse_mode: 'Markdown', ...keyboard }
    );
  });
}
