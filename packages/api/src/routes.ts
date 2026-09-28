import { Telegraf, Markup, Context } from 'telegraf';
import {
  getUserByTelegramId,
  getOpenPositions,
  getFillsByPosition,
  getPositionById,
  createTrigger,
  updateUserSettings,
  updatePosition,
  createPosition,
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
  getTradeSpendableNear,
  getRefStorageDepositNeeded,
  unwrapUserWrapNear,
  withdrawFunds,
  syncUserTokenDeposits,
  type TokenInfoResult,
} from './wallet.js';
import { sellAtTarget } from './sellHelper.js';
import { computePnL, fuzzyMatch, decrypt, tokenLinks, getNear } from '@racerbot/shared';
import { inFlightKey, tryAcquireInFlight, releaseInFlight } from './inflight.js';
import { generatePNLCard } from './pnlCardGenerator.js';
import { utils as nearUtils } from 'near-api-js';
import { MASTER_KEY, RPC_PROVIDERS } from './config.js';

const near = getNear(RPC_PROVIDERS.length > 0 ? RPC_PROVIDERS : ['https://rpc.mainnet.fastnear.com']);

// ── Token cache for snipe-by-name fuzzy matching ──────────────────────────────
export const localTokenNames = new Map<string, { address: string; symbol: string }>();

// ── Rate limiting for /export command (1 export per 5 minutes per user) ───────
const lastExportTime = new Map<number, number>();
const EXPORT_COOLDOWN_MS = 5 * 60 * 1000;

// ── User pending interactive input state ──────────────────────────────────────
interface PendingAction {
  action: 'buy_custom_near' | 'custom_slippage' | 'custom_auto_buy' | 'custom_min_liq' | 'withdraw' | 'import_token';
  tokenAddress?: string;
  expiresAt: number;
}
const userPendingActions = new Map<number, PendingAction>();

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
      Markup.button.callback('💳 Wallet', 'menu_wallet'),
      Markup.button.callback('⚙️ Settings', 'menu_settings'),
    ],
    [
      Markup.button.callback('� Holdings', 'menu_holdings'),
      Markup.button.callback('📈 PnL', 'menu_pnl'),
    ],
    [
      Markup.button.callback('🎯 Snipe Rules', 'menu_settings'),
      Markup.button.callback('🔄 Refresh', 'menu_refresh'),
    ],
    [
      Markup.button.callback('🔑 Export Key', 'export_prompt'),
      Markup.button.callback('🔄 Rotate Key', 'rotate_prompt'),
    ],
    [
      Markup.button.url('💬 Community', 'https://t.me/racerbot_community'),
      Markup.button.url('📢 Updates', 'https://t.me/racertrading'),
      Markup.button.url('𝕏 X', 'https://x.com/racertradingbot'),
    ],
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
      Markup.button.callback('🔄 Refresh', 'wallet_refresh'),
      Markup.button.callback('💸 Withdraw', 'wallet_withdraw_prompt'),
    ],
  ];

  if (Number(b.wrapNearFormatted) > 0.0001) {
    buttons.push([Markup.button.callback(`🔄 Unwrap ${b.wrapNearFormatted} wNEAR to NEAR`, 'wallet_unwrap')]);
  }

  buttons.push([
    Markup.button.callback('💼 Holdings', 'menu_holdings'),
    Markup.button.callback('⚙️ Settings', 'menu_settings'),
    Markup.button.callback('🔙 Main Menu', 'menu_home'),
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
  const userRecord = user.status === 'fulfilled' ? user.value : null;
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
  let keyboard;

  if (tokenInfo.tradeable) {
    if (holdsToken && userPosition) {
      // User holds token - show BOTH BUY and SELL options with Green / Red color coding
      text += `⚡ *Manage Position* (Buy More or Sell):\n`;
      const defaultBuyPct = userRecord?.default_buy_pct ? Number(userRecord.default_buy_pct) : 10;
      keyboard = Markup.inlineKeyboard([
        // BUY Options (Green 🟢)
        [
          Markup.button.callback('🟢 0.5 N', `buy_fixed:${tokenInfo.address}:0.5`),
          Markup.button.callback('🟢 1 N', `buy_fixed:${tokenInfo.address}:1`),
          Markup.button.callback('🟢 2 N', `buy_fixed:${tokenInfo.address}:2`),
          Markup.button.callback('🟢 5 N', `buy_fixed:${tokenInfo.address}:5`),
        ],
        [
          Markup.button.callback(`${defaultBuyPct === 10 ? '✓ ' : ''}🟢 Buy 10%`, `buy_pct:${tokenInfo.address}:10`),
          Markup.button.callback(`${defaultBuyPct === 25 ? '✓ ' : ''}🟢 Buy 25%`, `buy_pct:${tokenInfo.address}:25`),
          Markup.button.callback(`${defaultBuyPct === 50 ? '✓ ' : ''}🟢 Buy 50%`, `buy_pct:${tokenInfo.address}:50`),
          Markup.button.callback(`${defaultBuyPct === 100 ? '✓ ' : ''}🟢 Buy 100%`, `buy_pct:${tokenInfo.address}:100`),
        ],
        // SELL Options (Red 🔴)
        [
          Markup.button.callback('🔴 Sell 25%', `sell:${userPosition.id}:25`),
          Markup.button.callback('🔴 Sell 50%', `sell:${userPosition.id}:50`),
          Markup.button.callback('🔴 Sell 75%', `sell:${userPosition.id}:75`),
          Markup.button.callback('🔴 Sell 100%', `sell:${userPosition.id}:100`),
        ],
        // Quick Action Row
        [
          Markup.button.callback('🟢 Buy X NEAR', `buy_custom_prompt:${tokenInfo.address}`),
          Markup.button.callback('🔴 Sell Initial', `sell_initial:${userPosition.id}`),
          Markup.button.callback('🔄 Refresh', `token_refresh:${tokenInfo.address}`),
        ],
        ...linkRows,
        [
          Markup.button.callback('⚙️ Settings', 'menu_settings'),
          Markup.button.callback('🔙 Back', 'menu_home'),
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
          Markup.button.callback('🟢 0.5 N', `buy_fixed:${tokenInfo.address}:0.5`),
          Markup.button.callback('🟢 1 N', `buy_fixed:${tokenInfo.address}:1`),
          Markup.button.callback('🟢 2 N', `buy_fixed:${tokenInfo.address}:2`),
          Markup.button.callback('🟢 5 N', `buy_fixed:${tokenInfo.address}:5`),
        ],
        [
          Markup.button.callback(`${defaultBuyPct === 10 ? '✓ ' : ''}🟢 Buy 10%`, `buy_pct:${tokenInfo.address}:10`),
          Markup.button.callback(`${defaultBuyPct === 25 ? '✓ ' : ''}🟢 Buy 25%`, `buy_pct:${tokenInfo.address}:25`),
          Markup.button.callback(`${defaultBuyPct === 50 ? '✓ ' : ''}🟢 Buy 50%`, `buy_pct:${tokenInfo.address}:50`),
          Markup.button.callback(`${defaultBuyPct === 100 ? '✓ ' : ''}🟢 Buy 100%`, `buy_pct:${tokenInfo.address}:100`),
        ],
        [
          Markup.button.callback('🟢 Buy X NEAR', `buy_custom_prompt:${tokenInfo.address}`),
          Markup.button.callback('🔄 Refresh', `token_refresh:${tokenInfo.address}`),
        ],
        ...linkRows,
        [
          Markup.button.callback('⚙️ Settings', 'menu_settings'),
          Markup.button.callback('🔙 Back', 'menu_home'),
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
        Markup.button.callback('🔴 Sell 25%', `sell:${positionId}:25`),
        Markup.button.callback('🔴 Sell 50%', `sell:${positionId}:50`),
      ]);
      buttons.push([
        Markup.button.callback('🔴 Sell 75%', `sell:${positionId}:75`),
        Markup.button.callback('🔴 Sell 100%', `sell:${positionId}:100`),
      ]);
      buttons.push([
        Markup.button.callback('🔴 Sell Initial', `sell_initial:${positionId}`),
        Markup.button.callback('🟢 Buy More', `buy_custom_prompt:${position.token_address}`),
      ]);
    }

    buttons.push([
      Markup.button.callback(
        showNetWorth ? '🙈 Hide Net Worth' : '👁 Show Net Worth',
        `toggle_pnl_nw:${positionId}:${showNetWorth ? 0 : 1}`
      ),
      Markup.button.callback('🔄 Refresh PnL', `token_detail:${positionId}${showNetWorthOverride !== undefined ? `:${showNetWorth ? 1 : 0}` : ''}`),
    ]);
    buttons.push([
      Markup.button.callback('💼 Holdings', 'menu_holdings'),
      Markup.button.callback('🏠 Main Menu', 'menu_home'),
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
  const autoBuy = user.auto_buy_enabled;
  const slip = user.slippage_pct ? Number(user.slippage_pct) : 2.0;
  const autoAmt = user.auto_buy_amount_near ? Number(user.auto_buy_amount_near) : 1;
  const minLiq = user.auto_buy_min_liquidity_near ? Number(user.auto_buy_min_liquidity_near) : 0;
  const buyPct = user.default_buy_pct ? Number(user.default_buy_pct) : 10;
  const sellPct = user.default_sell_pct ? Number(user.default_sell_pct) : 100;
  const showNetWorth = user.show_net_worth_on_card !== false;

  const text =
    `⚙️ *Trading & Snipe Settings*\n\n` +
    `Configure your trading defaults and automated sniping rules below. Tap any button to toggle or update instantly:\n\n` +
    `• *Auto-Buy New Launches*: ${autoBuy ? '🟢 *Enabled*' : '🔴 *Disabled*'}\n` +
    `• *Auto-Buy Amount*: \`${autoAmt} NEAR\`\n` +
    `• *Min Pool Liquidity*: \`${minLiq} NEAR\`\n` +
    `• *Slippage Tolerance*: \`${slip}%\`\n` +
    `• *Default Manual Buy*: \`${buyPct}%\`\n` +
    `• *Default Manual Sell*: \`${sellPct}%\`\n` +
    `• *Net Worth on PNL Card*: ${showNetWorth ? '🟢 *Shown*' : '🔴 *Hidden*'}`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(
        autoBuy ? '🟢 Auto-Buy: ON (Tap to Disable)' : '🔴 Auto-Buy: OFF (Tap to Enable)',
        'set:toggle_auto_buy'
      ),
    ],
    [
      Markup.button.callback(
        showNetWorth ? '👁 Net Worth on Card: SHOWN (Tap to Hide)' : '🙈 Net Worth on Card: HIDDEN (Tap to Show)',
        'set:toggle_show_net_worth'
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
      Markup.button.callback(`🟢 Buy: ${buyPct === 10 ? '✓ ' : ''}10%`, 'set:buy_pct:10'),
      Markup.button.callback(`${buyPct === 25 ? '✓ ' : ''}25%`, 'set:buy_pct:25'),
      Markup.button.callback(`${buyPct === 50 ? '✓ ' : ''}50%`, 'set:buy_pct:50'),
      Markup.button.callback(`${buyPct === 100 ? '✓ ' : ''}100%`, 'set:buy_pct:100'),
    ],
    [
      Markup.button.callback(`🔴 Sell: ${sellPct === 25 ? '✓ ' : ''}25%`, 'set:sell_pct:25'),
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

  // ── Wallet / balance ────────────────────────────────────────────────
  if (r.includes('insufficient balance') || (r.includes('insufficient') && r.includes('balanc')))
    return errorMsg.slice(0, 280); // pass through — already human-readable from executeBuyHelper
  if (r.includes('minimum buy amount') || r.includes('minimum is 0.001'))
    return 'The amount is too small. Minimum is 0.001 NEAR.';
  if (r.includes('available balance') && r.includes('too low'))
    return errorMsg.slice(0, 280);
  if (r.includes('failed to fetch wallet balance'))
    return 'Unable to check your wallet balance. Please try again.';

  // ── Auth & Trading Key ───────────────────────────────────────────────
  if (
    r.includes('unsupported state') ||
    r.includes('unable to authenticate data') ||
    r.includes('wallet key') ||
    r.includes('key authentication failed')
  ) {
    return 'Wallet trading key authentication failed. Please run /rotatekey to refresh your key.';
  }
  if (r.includes('please run /start') || r.includes('user not found') || r.includes('wallet not found'))
    return 'Wallet not found. Please run /start first.';
  if (r.includes('unauthorized') || r.includes('forbidden'))
    return 'Authentication required. Please run /start.';

  // ── Venue / pool discovery ───────────────────────────────────────────
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
    r.includes('failed to fetch pool reserves')
  ) {
    return 'No active liquidity pool found for this token on DEX. It may not be tradeable yet.';
  }
  if (r.includes('prebonded') || r.includes('not yet bonded') || r.includes('bonding curve phase') || r.includes('bonding phase'))
    return 'Token is still in its bonding curve phase — wait for it to bond before buying.';
  if (r.includes('not paired with near') || r.includes('paired with'))
    return errorMsg.slice(0, 280);

  // ── Swap failure on-chain ────────────────────────────────────────────
  if (r.includes('no transaction was sent'))
    return 'Price moved beyond your slippage setting in the seconds before execution. The trade was NOT sent — no funds spent. Retry for a fresh quote, or increase slippage in ⚙️ Settings.';
  if (r.includes('swap failed'))
    return errorMsg.slice(0, 280);

  // ── Pending / slow confirmation (do NOT advise immediate blind retry) ───
  if (r.includes('not confirmed within') || r.includes('taking too long') || r.includes('outcome is unknown')) {
    return 'Transaction was submitted but confirmation is taking longer than usual. Please check your wallet balance or NearBlocks before retrying to avoid duplicate trades.';
  }

  // ── Distributed Lock Contention & Timeout ──────────────────────────────
  if (r.includes('another transaction is already in progress') || r.includes('wallet lock') || r.includes('contention')) {
    return 'Another transaction is already in progress for this wallet — please wait a moment and try again.';
  }

  // ── NEAR Protocol / RPC errors ───────────────────────────────────────
  if (r.includes('slippage') || r.includes('min_amount_out') || r.includes('less than minimum'))
    return 'Slippage too high — price moved against you. Try increasing slippage in ⚙️ Settings, then retry.';
  if (r.includes('notenoughallowance') || r.includes('not enough allowance'))
    return 'Key allowance exhausted. Please contact support to reset your trading key.';
  if (r.includes('all near rpc broadcast failed'))
    return 'All NEAR RPC nodes rejected the transaction. Please retry in a moment.';
  if (r.includes('signing timed out'))
    return 'Transaction signing timed out. Please retry.';
  if (r.includes('timeout') || r.includes('timed out'))
    return 'Network timeout — NEAR RPC is slow right now. Please retry.';
  if (r.includes('exceeded the prepaid gas'))
    return 'Transaction exceeded prepaid gas. Please retry.';
  if (r.includes('expired') || r.includes('nonce'))
    return 'Transaction expired due to network latency. Please retry.';
  if (r.includes('panic') || r.includes('wasm execution failed') || r.includes('executionerror') || r.includes('smart_contract_panic'))
    return `Contract error: ${sanitizeMd(errorMsg.replace(/.*FunctionCallError.*ExecutionError":"([^"]+)".*$/, '$1').slice(0, 180))}`;

  // ── Misc known patterns ───────────────────────────────────────────────
  if (r.includes('too many requests') || r.includes('rate limit'))
    return 'You\'re doing this too fast. Please wait a moment.';
  if (r.includes('token not found') || r.includes('token lookup failed'))
    return 'Unable to find this token. Please verify the contract address.';
  if (r.includes('insufficient liquidity'))
    return 'Not enough liquidity in the pool for this trade size.';

  // ── Pass through clean sanitized error message ───────────────────────
  console.error('[UNHANDLED_ERROR]', errorMsg);
  const clean = errorMsg.split('\n')[0].replace(/ed25519:[a-zA-Z0-9]+/g, '***').trim();
  if (clean.length > 0 && clean.length < 250) {
    return sanitizeMd(clean);
  }
  return 'Trading operation could not be completed. Please check your balance/settings and try again.';
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
  confirming_slow:
    '⛓ Still confirming on-chain — NEAR validators are busy right now.\n\n' +
    'Your funds are safe: wNEAR only leaves your wallet when the swap executes. ' +
    'Keep waiting, I\'ll confirm the moment it lands…',
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

  // SPEED: lightweight trade balance — spendable native NEAR only, no USD
  // price feed, no wNEAR read (5s TTL cache).
  let balanceNear = 0;
  try {
    balanceNear = await getTradeSpendableNear(telegramId);
  } catch (err: any) {
    throw new Error(`Failed to fetch wallet balance: ${err.message}`);
  }

  // FIX 2: when the user's Ref Finance storage is not yet registered, the
  // one-time deposit must be included in the insufficient-balance check so
  // the user gets a clear message BEFORE any transaction is attempted
  // (the on-chain deposit sends real NEAR; the old 0.025 reserve did not
  // cover the 0.1 NEAR deposit).
  const refDepositNeeded = await getRefStorageDepositNeeded(user.subaccount_id);
  const refDepositNear = Number(refDepositNeeded) / 1e24;
  const reserveNear = 0.025 + refDepositNear;

  // Check balance including gas reserve and the one-time Ref storage deposit
  if (balanceNear < amountNear + reserveNear) {
    const refLine = refDepositNear > 0
      ? ` This includes a one-time ${refDepositNear.toFixed(2)} NEAR Ref Finance registration deposit for your wallet.`
      : '';
    throw new Error(`Insufficient balance. You have ${balanceNear.toFixed(4)} NEAR available. Need at least ${(amountNear + reserveNear).toFixed(4)} NEAR (including gas & storage reserve).${refLine} Fees are deducted from your swap amount.`);
  }

  // Use cached token info to execute immediately without redundant RPC round-trips
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
    quoted_at: quoteStartedAt, // executor skips its second quote while < 2s old
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

  // PNL snapshot at entry: position value vs amount spent. At t=0 the delta
  // is the entry cost (fee + token tax) — shown honestly instead of a link.
  const valueNear = tokenQtyHuman * entryPrice;
  const pnlNear = valueNear - amountNear;
  const pnlPct = amountNear > 0 ? (pnlNear / amountNear) * 100 : 0;
  const pnlEmoji = pnlNear >= 0 ? '📈' : '📉';
  const pnlSign = pnlNear >= 0 ? '+' : '';

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
      `${pnlEmoji} PnL: \`${pnlSign}${pnlPct.toFixed(1)}%\` (\`${pnlSign}${pnlNear.toFixed(4)} NEAR\`)`,
  };
}

// ── Core Helper: Execute Percentage Buy for User ─────────────────────────────
// FIX 3 (continued): Use the cached getUserBalances rather than a raw RPC balance call.
async function executeBuyPctHelper(telegramId: number, tokenAddress: string, pct: number, onProgress?: (stage: string) => void) {
  const user = await getUserByTelegramId(telegramId);
  if (!user) throw new Error('Please run /start to set up your wallet first.');

  // Lightweight trade balance: spendable native NEAR only, no USD feed (5s TTL).
  const balanceNear = await getTradeSpendableNear(telegramId);

  // Retain 0.025 NEAR reserve for gas and token storage deposit
  const usableBalance = Math.max(0, balanceNear - 0.025);
  const amountNear = (usableBalance * pct) / 100;
  if (amountNear < 0.005) {
    throw new Error(`Available balance (${usableBalance.toFixed(4)} NEAR after 0.025 gas/storage reserve) is too low to buy.`);
  }
  return executeBuyHelper(telegramId, tokenAddress, Number(amountNear.toFixed(4)), onProgress);
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
        `📢 [Updates Channel](https://t.me/racertrading) - Announcements and news\n` +
        `𝕏 [X/Twitter](https://x.com/racertradingbot) - Follow for updates`,
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

  // ── Helper: Render & Display Holdings with Live Wallet Scan & PNL Baseline ───
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
        await (ctx as any).answerCbQuery(isRefresh ? '🔄 Refreshing & scanning wallet...' : '💼 Scanning wallet...').catch(() => {});
      }

      // 1. Scan user's wallet address immediately to catch all tokens inside
      await syncUserTokenDeposits(user.id, user.subaccount_id).catch((err) => {
        console.warn(`[HOLDINGS] Wallet scan error for ${user.subaccount_id}:`, err?.message || err);
      });

      // 2. Fetch all open positions (including newly synced wallet deposits)
      const positions = await getOpenPositions(user.id).catch(() => []);

        const emptyKeyboard = Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Refresh', 'refresh_holdings')],
          [Markup.button.callback('🔙 Back', 'menu_home')],
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

          if (isRefresh) {
            await ctx.reply(emptyMsg, { parse_mode: 'Markdown', ...emptyKeyboard }).catch(() => {});
          } else {
            const canEdit = typeof (ctx as any).editMessageText === 'function';
            if (canEdit) {
              await (ctx as any).editMessageText(emptyMsg, { parse_mode: 'Markdown', ...emptyKeyboard }).catch(async () => {
                await ctx.reply(emptyMsg, { parse_mode: 'Markdown', ...emptyKeyboard }).catch(() => {});
              });
            } else {
              await ctx.reply(emptyMsg, { parse_mode: 'Markdown', ...emptyKeyboard }).catch(() => {});
            }
          }
          return;
        }

      // 3. Fetch all token info in parallel with forceRefresh for live prices
      const infoResults = await Promise.allSettled(
        positions.map(pos => getTokenInfo(pos.token_address, true))
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
        let emoji = '🟢';

        if (currentPrice > 0 && entryPrice > 0) {
          const pnlPctNum = ((currentPrice - entryPrice) / entryPrice) * 100;
          // Profit tiers: 🔥 500%+, 🚀 100%+, 🟢 profit, 🔴 loss
          if (pnlPctNum >= 500) emoji = '🔥';
          else if (pnlPctNum >= 100) emoji = '🚀';
          else emoji = pnlPctNum >= 0 ? '🟢' : '🔴';
          pnlDisplay = `${pnlPctNum >= 0 ? '+' : ''}${pnlPctNum.toFixed(1)}%`;
        } else if (currentPrice > 0 && entryPrice <= 0) {
          pnlDisplay = '+0.0%';
          emoji = '🟢';
        } else {
          pnlDisplay = 'N/A';
          emoji = '⚪';
        }

        // Buttons-only list: per-token details render when the user taps the
        // token button (token_detail:<id>) — keeps the holdings view scannable.
        buttons.push([Markup.button.callback(`${emoji} ${displayLabel} (${pnlDisplay})`, `token_detail:${pos.id}`)]);
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

      if (isRefresh) {
        // Instantly send a new text of the updated information
        await ctx.reply(msg, { parse_mode: 'Markdown', ...keyboard }).catch(() => {});
      } else {
        const canEditMsg = typeof (ctx as any).editMessageText === 'function';
        if (canEditMsg) {
          await (ctx as any).editMessageText(msg, { parse_mode: 'Markdown', ...keyboard }).catch(async (err: any) => {
            if (err?.message?.includes('message is not modified')) {
              return;
            }
            await ctx.reply(msg, { parse_mode: 'Markdown', ...keyboard }).catch(() => {});
          });
        } else {
          await ctx.reply(msg, { parse_mode: 'Markdown', ...keyboard }).catch(() => {});
        }
      }
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
      const buys = fills.filter(f => f.side === 'buy');
      let initialInvestment = 0;
      for (const buy of buys) {
        if (buy.tx_hash?.startsWith('deposit_')) continue;
        const amount = parseFloat(buy.amount);
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
      const sellRow1: any[] = [];
      sellRow1.push(Markup.button.callback('🔴 Sell 25%', `sell:${positionId}:25`));
      sellRow1.push(Markup.button.callback('🔴 Sell 50%', `sell:${positionId}:50`));
      buttons.push(sellRow1);

      const sellRow2: any[] = [];
      sellRow2.push(Markup.button.callback('🔴 Sell 75%', `sell:${positionId}:75`));
      sellRow2.push(Markup.button.callback('🔴 Sell 100%', `sell:${positionId}:100`));
      buttons.push(sellRow2);

      // Buy buttons (Green 🟢)
      buttons.push([
        Markup.button.callback('🟢 Buy 0.5N', `buy_fixed:${position.token_address}:0.5`),
        Markup.button.callback('🟢 Buy 1N', `buy_fixed:${position.token_address}:1`),
        Markup.button.callback('🟢 Buy 2N', `buy_fixed:${position.token_address}:2`),
        Markup.button.callback('🟢 Buy X N', `buy_custom_prompt:${position.token_address}`),
      ]);

      // Sell Initial button
      if (initialInvestment > 0) {
        buttons.push([Markup.button.callback('🔴 Sell Initial', `sell_initial:${positionId}`)]);
      }

      // Navigation buttons
      buttons.push([
        Markup.button.callback(
          showNetWorth ? '🙈 Hide Net Worth' : '👁 Show Net Worth',
          `token_detail:${positionId}:${showNetWorth ? 0 : 1}`
        ),
        Markup.button.callback('🔄 Refresh', `token_detail:${positionId}${nwParam !== undefined ? `:${nwParam}` : ''}`),
      ]);
      buttons.push([
        Markup.button.callback('🔙 Back to Holdings', 'menu_holdings'),
        Markup.button.callback('🏠 Main Menu', 'menu_home'),
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

        // Calculate total initial investment across ALL buy fills (not just first)
        // Include fees paid to get accurate total NEAR invested
        let totalInitialInvestment = 0;
        for (const buy of buys) {
          const amount = parseFloat(buy.amount);
          const price = parseFloat(buy.price);
          const fee = parseFloat(buy.fee_paid || '0');
          totalInitialInvestment += (amount * price) + fee;
        }

        // Fetch current market price from token info (not avg_entry_price)
        const tokenInfo = await getTokenInfo(livePosition.token_address, true).catch(() => null);
        const currentPrice = tokenInfo ? parseFloat(tokenInfo.price) : 0;

        if (currentPrice === 0) {
          if (procMsg) await ctx.deleteMessage(procMsg.message_id).catch(() => {});
          await ctx.reply('Cannot calculate sell amount - current price is 0.').catch(() => {});
          return;
        }

        const currentHeld = parseFloat(livePosition.quantity_held);
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
  const handlePnl = async (ctx: Context) => {
    const telegramId = ctx.from!.id;
    try {
      const user = await getUserByTelegramId(telegramId).catch(() => null);
      if (!user) { await ctx.reply('Use /start first.'); return; }

      // NOTE: External deposit sync now runs in background only, not blocking menu load
      setImmediate(() => syncUserTokenDeposits(user.id, user.subaccount_id).catch(() => {}));

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
        Promise.allSettled(closedResult.rows.map((pos: any) => getTokenInfo(pos.token_address, true))),
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
          Markup.button.url('𝕏 X', 'https://x.com/racertradingbot'),
        ],
      ]);
      await ctx.reply(msg, { parse_mode: 'Markdown', ...keyboard });
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
    }
  };

  bot.action(['menu_pnl', 'refresh_pnl'], async (ctx) => {
    await ctx.answerCbQuery('🔄 Updated PnL!').catch(() => {});
    await handlePnl(ctx);
  });

  bot.command('pnl', handlePnl);

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
    const dash = buildSettingsDashboard(updated);
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
          reply_markup: { inline_keyboard: [[Markup.button.callback('🔄 Refresh Token Card', `token_refresh:${tokenAddress}`)]] },
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
          reply_markup: { inline_keyboard: [[Markup.button.callback('🔄 Refresh Token Card', `token_refresh:${tokenAddress}`)]] },
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
          reply_markup: { inline_keyboard: [[Markup.button.callback('🔄 Refresh Token Card', `token_refresh:${tokenAddress}`)]] },
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
            Markup.button.callback('🔴 Sell 25%', `sell:${pos.id}:25`),
            Markup.button.callback('🔴 Sell 50%', `sell:${pos.id}:50`),
            Markup.button.callback('🔴 Sell 75%', `sell:${pos.id}:75`),
            Markup.button.callback('🔴 Sell 100%', `sell:${pos.id}:100`),
          ],
          [
            Markup.button.callback('🟢 Buy More', `buy_custom_prompt:${pos.token_address}`),
            Markup.button.callback('🔄 Refresh', 'menu_positions'),
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
            reply_markup: { inline_keyboard: [[Markup.button.callback('🔄 Refresh Token Card', `token_refresh:${query}`)]] },
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
        reply_markup: { inline_keyboard: [[Markup.button.callback('🔄 Refresh Token Card', `token_refresh:${tokenAddress}`)]] },
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
    } catch (err: any) {
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
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
              reply_markup: { inline_keyboard: [[Markup.button.callback('🔄 Refresh Token Card', `token_refresh:${tokenAddress}`)]] },
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

        // Step 2: Query user's real on-chain balance via ft_balance_of
        let balanceRaw = '0';
        try {
          balanceRaw = await near.getTokenBalance(tokenCA, user.subaccount_id);
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
        Markup.button.callback('💳 Open Wallet', 'menu_wallet'),
        Markup.button.callback('⚙️ Settings', 'menu_settings'),
      ],
      [
        Markup.button.callback('🔙 Back', 'menu_home'),
      ],
    ]);

    await ctx.reply(
      `💡 *Paste any NEAR token address* (e.g. \`wrap.near\`) directly into this chat to view price, liquidity, and 1-click buy buttons!\n\n` +
      `Or use the menu below:`,
      { parse_mode: 'Markdown', ...keyboard }
    );
  });
}