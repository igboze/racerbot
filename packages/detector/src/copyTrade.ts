/**
 * Copy Trading & Wallet Tracker Detector
 *
 * Watches the block stream for swap transactions made by any wallet
 * that RacerBot users are actively copying or tracking. When a match is found it:
 *  1. Determines if the transaction is a BUY or a SELL on supported DEXes
 *  2. For Tracker-only followers: sends instant real-time Telegram alerts with 1-click manual buy/sell buttons
 *  3. For Auto-Copy followers:
 *     - BUY: checks daily budget, slippage, and dispatches EXECUTE_SWAP
 *     - SELL: checks open position holdings and dispatches EXECUTE_SWAP if copy_sells is enabled
 *  4. Records the copy fill in DB (idempotent - source_tx_hash deduplicates)
 *  5. Awards Season 1 points to the copier (+ leader bonus if leader is a user)
 *  6. Handles group-link 5% fee rewards via the token_referrals system
 */

import {
  createRedis,
  CHANNELS,
  createLogger,
  getNear,
  isTradableVenue,
  getVenueInfo,
  isLaunchpadVenue,
  type SwapEvent,
} from '@racerbot/shared';
import {
  getAllActiveCopyTargetWallets,
  getCopyTargetFollowersByWallet,
  recordCopyTradeFill,
  updateCopyTradeFillResult,
  getCopyTradeDailySpend,
  getTokenCache,
  getUserById,
  getUserBySubaccount,
  getOpenPositions,
  getDb,
  listUserExecutors,
  type CopyTradeTargetRecord,
} from '@racerbot/db';

import { flushFlows, observeReceipt } from './copyTradeFlow.js';

const logger = createLogger('copy-detector');

export const LAUNCHPAD_CONTRACTS = new Set<string>([
  'nearlytrade.near',
  'meme-cooking.near',
  'launch.intear.near',
  'launch-v2.intear.near',
  'dex.intear.near',
  'launchpad.justhoot.near',
  'v2-launchpad.justhoot.near',
  'pad.onetokenhub.near',
  'nearpadfamily.near',
  'nearpumpfun.near',
  'factory.shardsmarket.near',
  'gaypad.j1-racing.near',
  'launch.shoremarkets.near',
  'exchange.kelytradevs.near',
  'qlyphs.near',
]);

export const NON_TRADER_CONTRACTS = new Set<string>([
  'dclv2.ref-labs.near',
  'v2.ref-finance.near',
  'ref-finance-101.near',
  'aggregatedex.near',
  'wrap.near',
  'near',
  'dex.intear.near',
  'launch.intear.near',
  'launch-v2.intear.near',
  'intents.near',
  'nearlytrade.near',
  'meme-cooking.near',
  'launchpad.justhoot.near',
  'v2-launchpad.justhoot.near',
  'pad.onetokenhub.near',
  'nearpadfamily.near',
  'nearpumpfun.near',
  'factory.shardsmarket.near',
  'gaypad.j1-racing.near',
  'launch.shoremarkets.near',
  'exchange.kelytradevs.near',
  'qlyphs.near',
  'token.rhealab.near',
  'racerbot.near',
  'racerbotrouter.near',
  'system',
]);

export function isNonTraderContract(accountId: string): boolean {
  const lower = (accountId || '').trim().toLowerCase();
  if (!lower) return true;
  if (NON_TRADER_CONTRACTS.has(lower) || LAUNCHPAD_CONTRACTS.has(lower)) return true;
  if (
    lower.endsWith('.launchpad.justhoot.near') ||
    lower.endsWith('.v2-launchpad.justhoot.near') ||
    lower.endsWith('.nearlytrade.near') ||
    lower.endsWith('.meme-cooking.near') ||
    lower.endsWith('.nearpumpfun.near') ||
    lower.endsWith('.shardsmarket.near') ||
    lower.endsWith('.launch.shoremarkets.near') ||
    lower.endsWith('.tkn.near') ||
    lower.endsWith('.factory.bridge.near')
  ) {
    return true;
  }
  return false;
}

export function inferVenueFromToken(tokenAddress: string, defaultVenue = 'rhea'): string {
  const lower = tokenAddress.toLowerCase().trim();
  if (lower.endsWith('.nearlytrade.near')) return 'nearlytrade';
  if (lower.endsWith('.meme-cooking.near')) return 'memecooking';
  if (lower.includes('intear.near')) return 'intear';
  if (lower.includes('justhoot.near')) return 'rhea';
  if (lower.endsWith('.pad.onetokenhub.near')) return 'onetokenhub';
  if (lower.endsWith('.nearpadfamily.near')) return 'nearpad';
  if (lower.endsWith('.nearpumpfun.near')) return 'nearpumpfun';
  if (lower.endsWith('.shardsmarket.near')) return 'shardsmarket';
  if (lower.endsWith('.launch.shoremarkets.near')) return 'shoremarkets';
  if (lower.endsWith('.gaypad.j1-racing.near')) return 'gaypad';
  if (lower.endsWith('.kelytra.near')) return 'kelytra';
  return defaultVenue;
}

export function extractTokenFromLaunchpadArgs(receiverId: string, args: Record<string, unknown>): string | null {
  if (receiverId === 'meme-cooking.near') {
    const memeId = (args as any)?.meme_id ?? (args as any)?.id ?? (args as any)?.Deposit?.meme_id;
    if (memeId !== undefined && memeId !== null) {
      return `${memeId}.meme-cooking.near`;
    }
  }
  const cand =
    (args as any)?.token_id ??
    (args as any)?.token ??
    (args as any)?.token_address ??
    (args as any)?.account_id ??
    (args as any)?.token_account_id;
  if (typeof cand === 'string' && cand.length > 0) return cand;
  return null;
}

const REDIS_URL = process.env.REDIS_URL!;
const redis = createRedis(REDIS_URL);

// In-memory set of tracked wallets (refreshed every 60s)
// The detector reads this set on every block - DB must not be hit in the hot path.
let trackedWallets = new Set<string>();
let alphaCallerWallets = new Map<string, string>(); // normalized wallet -> trader_id
const WALLET_REFRESH_MS = 60_000;

/** Transactions the instant (message-based) path already copied; the balance path skips them */
const handledTxs = new Map<string, number>();
const recentCopyTriggers = new Map<string, number>();
const HANDLED_TTL_MS = 5 * 60_000;
const RECENT_TRIGGER_TTL_MS = 4_500;

export function isTrackedWallet(wallet: string): boolean {
  const normalized = wallet.trim().toLowerCase();
  if (isNonTraderContract(normalized)) return false;
  return trackedWallets.has(normalized);
}

/**
 * Feed every receipt execution outcome here (cheap: returns at once unless a tracked wallet signed it).
 * Trades no venue parser recognised are found from the wallet's balance changes a few seconds later.
 */
export function observeCopyFlow(item: unknown): void {
  observeReceipt(item, isTrackedWallet);
}

function flushCopyFlows(): void {
  const now = Date.now();
  for (const [tx, at] of handledTxs) if (now - at > HANDLED_TTL_MS) handledTxs.delete(tx);
  for (const [k, at] of recentCopyTriggers) if (now - at > RECENT_TRIGGER_TTL_MS) recentCopyTriggers.delete(k);
  for (const { wallet, txHash, swap } of flushFlows(now)) {
    if (handledTxs.has(txHash)) continue;
    const walletDedupKey = `flow:${wallet}:${swap.side}:${swap.tokenAddress.toLowerCase()}`;
    const lastTrig = recentCopyTriggers.get(walletDedupKey);
    if (lastTrig && now - lastTrig < RECENT_TRIGGER_TTL_MS) continue;
    handledTxs.set(txHash, now);
    recentCopyTriggers.set(walletDedupKey, now);
    logger.info('Copy-trade event detected from balance changes', { signer: wallet, side: swap.side, token: swap.tokenAddress, txHash });
    dispatchCopyTrade(wallet, swap, txHash).catch(err => logger.error('Copy-trade dispatch failed', err as Error, { txHash }));
  }
}

export async function initCopyTradeDetector(): Promise<void> {
  handledTxs.clear();
  recentCopyTriggers.clear();
  await refreshTrackedWallets();
  setInterval(refreshTrackedWallets, WALLET_REFRESH_MS);
  setInterval(flushCopyFlows, 2_000);
  try {
    const subRedis = createRedis(REDIS_URL);
    await subRedis.subscribe('racerbot:refresh_tracked_wallets', async () => {
      await refreshTrackedWallets().catch(() => {});
    });
  } catch (err) {
    logger.warn('Failed to subscribe to tracked wallet refresh channel (fallback to 60s interval)', err as Error);
  }
  logger.info('Copy-trade detector initialized', { watching: trackedWallets.size });
}

async function refreshTrackedWallets(): Promise<void> {
  try {
    const wallets = await getAllActiveCopyTargetWallets();
    const nextTracked = new Set(
      wallets
        .map((w) => w.trim().toLowerCase())
        .filter((w) => !isNonTraderContract(w))
    );
    const nextAlphaCallers = new Map<string, string>();
    try {
      const db = await getDb();
      const callerRows = await db.query(
        `SELECT t.id AS trader_id,
                LOWER(TRIM(COALESCE(NULLIF(t.payout_wallet_address, ''), u.subaccount_id))) AS wallet
         FROM racer_alpha_traders t
         LEFT JOIN users u ON u.id::text = t.user_id
         WHERE t.is_active = TRUE AND t.user_id <> 'system_alpha'`
      );
      for (const r of callerRows.rows) {
        const w = (r.wallet || '').trim().toLowerCase();
        if (w && !isNonTraderContract(w)) {
          nextTracked.add(w);
          nextAlphaCallers.set(w, r.trader_id);
        }
      }
    } catch {
      // non-fatal if racer_alpha_traders is not yet migrated
    }
    trackedWallets = nextTracked;
    alphaCallerWallets = nextAlphaCallers;
  } catch (err) {
    logger.error('Failed to refresh tracked copy-trade wallets', err as Error);
  }
}

const INTEAR_DEX = 'dex.intear.near';
const NEARPUMPFUN_SUFFIX = '.nearpumpfun.near';

/** Intear asset id ("near" or "nep141:<token>") as a token address ("near" stays "near") */
function intearAsset(asset: unknown): string | null {
  if (typeof asset !== 'string' || !asset) return null;
  return asset === 'near' ? 'near' : asset.replace(/^nep141:/, '');
}

/**
 * First input and final output of an Intear operations message: `{operations: [...]}`, the plain
 * array form, or `deposit_near`'s `{operations: {operations: [...]}}`. Multi-hop routes (through
 * token.intear.near) resolve to the token actually bought or sold.
 */
export function intearRoute(message: unknown): { tokenIn: string; tokenOut: string } | null {
  let m: any = message;
  if (typeof m === 'string') {
    try { m = JSON.parse(m); } catch { return null; }
  }
  const ops = Array.isArray(m) ? m : Array.isArray(m?.operations) ? m.operations : Array.isArray(m?.operations?.operations) ? m.operations.operations : null;
  if (!ops) return null;
  const swaps = ops.map((o: any) => o?.SwapSimple ?? o?.Swap).filter(Boolean);
  if (swaps.length === 0) return null;
  const tokenIn = intearAsset(swaps[0].asset_in);
  const tokenOut = intearAsset(swaps[swaps.length - 1].asset_out);
  return tokenIn && tokenOut ? { tokenIn, tokenOut } : null;
}

export interface DetectedSwap {
  side: 'buy' | 'sell';
  tokenAddress: string;
  tokenIn: string;
  tokenOut: string;
  amountIn?: string;
  soldTokenIn?: string;
  dclPoolId?: string;
}

const QUOTE_ASSETS = new Set<string>([
  'wrap.near',
  'near',
  '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', // native USDC
  'a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near', // USDC.e
  'usdt.tether-token.near', // native USDT
  'dac17f958d2ee523a2206206994597c13d831ec7.factory.bridge.near', // USDT.e
  'prl.omft.near',
  'qtc.omft.near',
  'token.rhealab.near',
  'token.intear.near',
]);

export function isQuoteAsset(addr?: string | null): boolean {
  if (!addr) return false;
  return QUOTE_ASSETS.has(addr.trim().toLowerCase());
}

/**
 * Called by the detector hot-path for every block's receipt_execution_outcome.
 * Returns immediately if the signer is not a tracked wallet.
 */
export async function checkCopyTradeReceipt(
  signerAccountId: string,
  receiverAccountId: string,
  txHash: string,
  actions: Array<{ methodName: string; args: Record<string, unknown> }>,
  predecessorId?: string
): Promise<void> {
  const normalizedSigner = (signerAccountId || '').trim().toLowerCase();
  if (isNonTraderContract(normalizedSigner)) return;
  // Fast O(1) check - skip untracked wallets immediately
  if (!trackedWallets.has(normalizedSigner)) return;
  // Skip if another receipt from the same transaction was already handled
  if (txHash && handledTxs.has(txHash)) return;

  const swap = extractSwapDetails(receiverAccountId, actions, predecessorId);
  if (!swap || !swap.tokenAddress) return;

  const now = Date.now();
  if (txHash) {
    handledTxs.set(txHash, now);
  }
  // Mark flow dedup key so flushCopyFlows skips this swap if balance observer also saw it with another receipt_id
  recentCopyTriggers.set(`flow:${normalizedSigner}:${swap.side}:${swap.tokenAddress.toLowerCase()}`, now);
  if (swap.soldTokenIn) {
    recentCopyTriggers.set(`flow:${normalizedSigner}:sell:${swap.soldTokenIn.toLowerCase()}`, now);
  }
  logger.info('Copy-trade event detected', {
    signer: normalizedSigner,
    side: swap.side,
    token: swap.tokenAddress,
    soldTokenIn: swap.soldTokenIn,
    txHash,
  });
  await dispatchCopyTrade(normalizedSigner, swap, txHash);
}

/** Copy or alert a detected trade for every follower of `normalizedSigner` */
async function dispatchCopyTrade(normalizedSigner: string, swap: DetectedSwap, txHash: string): Promise<void> {
  const signerAccountId = normalizedSigner;
  const now = Date.now();
  const tokenKey = swap.tokenAddress.toLowerCase();

  // If this was a TokenA -> TokenB rotation, also dispatch a copy-SELL for TokenA so followers holding TokenA exit it
  if (
    swap.side === 'buy' &&
    swap.soldTokenIn &&
    !isQuoteAsset(swap.soldTokenIn) &&
    swap.soldTokenIn.toLowerCase() !== tokenKey
  ) {
    const soldSwap: DetectedSwap = {
      side: 'sell',
      tokenAddress: swap.soldTokenIn,
      tokenIn: swap.soldTokenIn,
      tokenOut: 'wrap.near',
      amountIn: swap.amountIn,
    };
    dispatchCopyTrade(normalizedSigner, soldSwap, `${txHash}:sell`).catch((err) =>
      logger.error('Copy-trade token-rotation sell dispatch error', err as Error, { txHash, soldToken: swap.soldTokenIn })
    );
  }

  // 1. If signer is a registered RacerAlpha Caller, notify API to record signal & trigger Alpha Caller auto-copies
  const alphaTraderId = alphaCallerWallets.get(normalizedSigner);
  if (alphaTraderId) {
    const alphaDedupKey = `alpha:${alphaTraderId}:${swap.side}:${tokenKey}`;
    const lastAlpha = recentCopyTriggers.get(alphaDedupKey);
    if (!lastAlpha || now - lastAlpha >= RECENT_TRIGGER_TTL_MS) {
      recentCopyTriggers.set(alphaDedupKey, now);
      let amountNear = 1.0;
      if (swap.side === 'buy' && swap.amountIn && /^\d+$/.test(swap.amountIn)) {
        try {
          const nearFloat = Number(BigInt(swap.amountIn) / 10n ** 18n) / 1e6;
          if (nearFloat > 0 && nearFloat < 1_000_000) amountNear = nearFloat;
        } catch {}
      }
      const tokenCache = await getTokenCache(swap.tokenAddress).catch(() => null);
      const venue = tokenCache?.venue || inferVenueFromToken(swap.tokenAddress);
      const tokenSymbol = tokenCache?.symbol || (swap.tokenAddress.split('.')[0] || swap.tokenAddress).toUpperCase();
      await redis.publish(CHANNELS.NOTIFY_USER, JSON.stringify({
        type: 'notify_user',
        telegram_id: 0,
        event: 'alpha_caller_onchain_trade',
        data: {
          trader_id: alphaTraderId,
          leader_wallet: normalizedSigner,
          token_address: swap.tokenAddress,
          token_symbol: tokenSymbol,
          token_name: tokenCache?.name || tokenSymbol,
          side: swap.side.toUpperCase(),
          amount_near: amountNear,
          venue,
          tx_hash: txHash.replace(/:sell$/, ''),
        },
      })).catch(() => {});
    }
  }

  // 2. Load direct wallet copy followers
  const followers = await getCopyTargetFollowersByWallet(normalizedSigner).catch(() => []);
  if (followers.length === 0) return;

  // Process each follower in parallel, independently - one failure must not block others
  await Promise.all(
    followers.map(async (target) => {
      const targetDedupKey = `target:${target.id}:${swap.side}:${tokenKey}`;
      const lastTargetTrig = recentCopyTriggers.get(targetDedupKey);
      if (lastTargetTrig && now - lastTargetTrig < RECENT_TRIGGER_TTL_MS) return;
      recentCopyTriggers.set(targetDedupKey, now);
      try {
        if (target.track_only) {
          // Wallet Tracker mode: Send alert with quick actions without auto-buying/selling
          await handleTrackerAlert(target, signerAccountId, swap, txHash.replace(/:sell$/, ''));
        } else if (swap.side === 'buy') {
          // Auto-Copy BUY
          await executeCopyBuy(target, signerAccountId, swap.tokenAddress, txHash, swap.dclPoolId);
        } else if (swap.side === 'sell') {
          // Auto-Copy SELL (if enabled)
          if (target.copy_sells) {
            await executeCopySell(target, signerAccountId, swap.tokenAddress, txHash, swap.dclPoolId);
          }
        }
      } catch (err) {
        logger.error('Copy-trade execution error', err as Error, {
          copyTargetId: target.id,
          follower: target.user_id,
          side: swap.side,
        });
      }
    })
  );
}

/**
 * Handle Wallet Tracker alert (monitor-only without automatic execution)
 */
async function handleTrackerAlert(
  target: CopyTradeTargetRecord,
  leaderWallet: string,
  swap: DetectedSwap,
  sourceTxHash: string
): Promise<void> {
  // Idempotent audit record
  const fill = await recordCopyTradeFill({
    copy_target_id: target.id,
    user_id: target.user_id,
    source_tx_hash: sourceTxHash,
    token_address: swap.tokenAddress,
    side: swap.side,
  });
  if (!fill) return; // duplicate - already handled

  const tokenCache = await getTokenCache(swap.tokenAddress).catch(() => null);
  const venue = tokenCache?.venue || inferVenueFromToken(swap.tokenAddress);
  const venueInfo = getVenueInfo(venue);
  const venueLabel = venueInfo?.label || (isLaunchpadVenue(venue) ? venue : 'DEX');
  const isLaunchpad = isLaunchpadVenue(venue) || (venue !== 'rhea' && venue !== 'ref');
  const venueBadge = isLaunchpad ? `\n🏪 *Launchpad*: ${venueLabel} (Unbonded Curve)` : `\n🏛 *Venue*: ${venueLabel}`;

  const tokenSymbol = tokenCache?.symbol || (swap.tokenAddress.split('.')[0] || swap.tokenAddress).toUpperCase();
  const nearBlocks = `https://nearblocks.io/txns/${sourceTxHash}`;

  const isBuy = swap.side === 'buy';
  const actionEmoji = isBuy ? '🟢' : '🔴';
  const actionText = isBuy ? 'BOUGHT' : 'SOLD';

  const notifyMsg =
    `🎯 *Wallet Tracker Alert*\n\n` +
    `👤 *Tracked Wallet*: \`${leaderWallet}\`\n` +
    `${actionEmoji} *Action*: ${actionText} *${tokenSymbol}*` +
    `${venueBadge}\n` +
    `🪙 *Token Address*: \`${swap.tokenAddress}\`\n` +
    `🔗 [View Tx on NearBlocks](${nearBlocks})\n\n` +
    `_Tap below to take action or view the token:_\n`;

  const inlineKeyboard = isBuy
    ? [
        [
          { text: '⚡ Buy 0.5 N', callback_data: `buy_fixed:${swap.tokenAddress}:0.5` },
          { text: '⚡ Buy 1 N', callback_data: `buy_fixed:${swap.tokenAddress}:1` },
          { text: '⚡ Buy 2 N', callback_data: `buy_fixed:${swap.tokenAddress}:2` },
        ],
        [
          { text: '📊 View Token Card', callback_data: `token_refresh:${swap.tokenAddress}` },
          { text: '📈 Chart', url: `https://dexscreener.com/near/${swap.tokenAddress}` },
        ],
      ]
    : [
        [
          { text: '📊 View Token & Holdings', callback_data: `token_refresh:${swap.tokenAddress}` },
          { text: '📈 Chart', url: `https://dexscreener.com/near/${swap.tokenAddress}` },
        ],
      ];

  await updateCopyTradeFillResult(fill.id, 'filled', { amount_near: 0 });

  const followerUser = await getUserById(target.user_id).catch(() => null);
  const telegramId = followerUser?.telegram_id ?? 0;

  await redis.publish(CHANNELS.NOTIFY_USER, JSON.stringify({
    type: 'notify_user',
    telegram_id: telegramId,
    event: 'wallet_tracker_alert',
    data: {
      user_id: target.user_id,
      telegram_id: telegramId,
      copy_target_id: target.id,
      leader_wallet: leaderWallet,
      token_address: swap.tokenAddress,
      token_symbol: tokenSymbol,
      side: swap.side,
      source_tx_hash: sourceTxHash,
      message: notifyMsg,
      reply_markup: { inline_keyboard: inlineKeyboard },
    },
  }));
}

async function resolveCopyTradePools(
  tokenAddress: string,
  venue: string,
  tokenCache: any,
  hintDclPoolId?: string
): Promise<{ dclPoolId?: string; rheaPoolId?: number }> {
  const near = getNear();
  const lower = tokenAddress.toLowerCase();
  let dclPoolId: string | undefined = hintDclPoolId || tokenCache?.dcl_pool_id || undefined;
  const rawRhea = tokenCache?.rhea_pool_id;
  let rheaPoolId: number | undefined =
    rawRhea != null && rawRhea !== '' && !Number.isNaN(Number(rawRhea)) ? Number(rawRhea) : undefined;

  const isJustHoot = lower.endsWith('.launchpad.justhoot.near') || lower.endsWith('.v2-launchpad.justhoot.near');
  if (!dclPoolId) {
    if (venue === 'nearlytrade' || lower.endsWith('.nearlytrade.near')) {
      const ntState = await near.getNearlytradeTokenState(tokenAddress).catch(() => null);
      if (ntState?.dclPoolId) dclPoolId = ntState.dclPoolId;
    } else if (venue === 'shoremarkets' || lower.endsWith('.launch.shoremarkets.near')) {
      const smState = await near.getShoremarketsTokenState(tokenAddress).catch(() => null);
      if (smState?.dclPoolId) dclPoolId = smState.dclPoolId;
    } else if (isJustHoot || (!rheaPoolId && (venue === 'rhea' || venue === 'ref'))) {
      const foundDcl = await near.findDclPoolId('wrap.near', tokenAddress).catch(() => null);
      if (foundDcl) dclPoolId = foundDcl;
    }
  }

  // Clear zombie simple pool IDs when a graduated DCL launchpad pool is present
  if (dclPoolId && (venue === 'nearlytrade' || venue === 'shoremarkets' || isJustHoot)) {
    rheaPoolId = undefined;
  }

  return { dclPoolId, rheaPoolId };
}

async function executeCopyBuy(
  target: CopyTradeTargetRecord,
  leaderWallet: string,
  tokenAddress: string,
  sourceTxHash: string,
  hintDclPoolId?: string
): Promise<void> {
  const cleanSourceTxHash = sourceTxHash.replace(/:sell$/, '');
  // 1. Idempotent fill record - returns null if already processed
  const fill = await recordCopyTradeFill({
    copy_target_id: target.id,
    user_id: target.user_id,
    source_tx_hash: cleanSourceTxHash,
    token_address: tokenAddress,
    side: 'buy',
  });
  if (!fill) return; // duplicate - already handled

  try {
    // 2. Daily budget cap check
    if (target.max_daily_budget_near !== null) {
      const today = new Date().toISOString().slice(0, 10);
      const spent = await getCopyTradeDailySpend(target.id, today);
      if (spent + target.buy_amount_near > target.max_daily_budget_near) {
        await updateCopyTradeFillResult(fill.id, 'skipped', {
          skip_reason: `Daily budget cap reached (${spent.toFixed(2)}/${target.max_daily_budget_near} NEAR)`,
        });
        logger.info('Copy-trade skipped: daily budget cap', { copyTargetId: target.id });
        return;
      }
    }

    // 3. Check token is tradeable (supports bonded DEXes and unbonded launchpad tokens)
    const tokenCache = await getTokenCache(tokenAddress).catch(() => null);
    const venue = tokenCache?.venue || inferVenueFromToken(tokenAddress);
    if (!isTradableVenue(venue)) {
      await updateCopyTradeFillResult(fill.id, 'skipped', {
        skip_reason: `Token venue '${venue}' is not tradeable`,
      });
      return;
    }

    // 4. Fetch user + slippage preference
    const user = await getUserById(target.user_id).catch(() => null);
    if (!user) {
      await updateCopyTradeFillResult(fill.id, 'failed', { skip_reason: 'User not found' });
      return;
    }
    const slippagePct = target.max_slippage_pct;

    // 4b. Check if WebApp user should execute via Confidential Executor Pool (when they have ready executors
    // and either an external connected wallet or insufficient balance on their direct subaccount)
    const isNearChain = tokenCache?.chain !== 'sui' && venue !== 'suipump' && !tokenAddress.includes('::');
    if (isNearChain) {
      const readyExecutors = await listUserExecutors(target.user_id, ['ready']).catch(() => []);
      if (readyExecutors.length > 0) {
        const isExternalWallet = !user.scoped_key_encrypted || user.scoped_key_encrypted === 'EXTERNAL_CONNECTED_WALLET';
        const subBalNear = parseFloat(String(user.last_near_balance || '0'));
        if (isExternalWallet || subBalNear < target.buy_amount_near + 0.05) {
          await updateCopyTradeFillResult(fill.id, 'pending', { amount_near: target.buy_amount_near });
          await redis.publish(CHANNELS.NOTIFY_USER, JSON.stringify({
            type: 'notify_user',
            telegram_id: user.telegram_id ?? 0,
            event: 'confidential_copy_trade',
            data: {
              fill_id: fill.id,
              user_id: target.user_id,
              copy_target_id: target.id,
              leader_wallet: leaderWallet,
              token_address: tokenAddress,
              token_symbol: tokenCache?.symbol || tokenAddress.split('.')[0].toUpperCase(),
              venue,
              side: 'buy',
              amount_near: target.buy_amount_near,
              slippage_pct: slippagePct,
              source_tx_hash: cleanSourceTxHash,
            },
          }));
          return;
        }
      }
    }

    // 5. Build swap
    let swapEvent: any;
    if (tokenCache?.chain === 'sui' || venue === 'suipump' || tokenAddress.includes('::')) {
      const amountInMist = BigInt(Math.round(target.buy_amount_near * 1e9)).toString();
      swapEvent = {
        type: 'execute_swap',
        chain: 'sui',
        user_id: target.user_id,
        token_in: 'sui',
        token_out: tokenAddress,
        amount_in: amountInMist,
        min_amount_out: '1',
        venue: 'suipump',
        slippage_pct: slippagePct,
        timestamp: Date.now(),
      };
    } else {
      const near = getNear();
      const { dclPoolId: effectiveDclPoolId, rheaPoolId: effectiveRheaPoolId } = await resolveCopyTradePools(
        tokenAddress,
        venue,
        tokenCache,
        hintDclPoolId
      );
      const amountInYocto = (BigInt(Math.round(target.buy_amount_near * 1e6)) * 10n ** 18n).toString();
      let minAmountOut = '1';
      try {
        const quote = await near.computeMinAmountOut(
          venue as any,
          'wrap.near',
          tokenAddress,
          amountInYocto,
          slippagePct,
          effectiveRheaPoolId,
          effectiveDclPoolId
        );
        if (quote?.minAmountOut) {
          minAmountOut = quote.minAmountOut;
        }
      } catch (quoteErr) {
        logger.warn('computeMinAmountOut fallback to 1 for unbonded launchpad token', {
          token: tokenAddress,
          venue,
          err: (quoteErr as Error).message,
        });
      }

      swapEvent = {
        type: 'execute_swap',
        user_id: target.user_id,
        token_in: 'wrap.near',
        token_out: tokenAddress,
        amount_in: amountInYocto,
        min_amount_out: minAmountOut,
        venue,
        timestamp: Date.now(),
        ...(effectiveDclPoolId ? { dcl_pool_id: effectiveDclPoolId } : {}),
        ...(effectiveRheaPoolId != null ? { pool_id: effectiveRheaPoolId } : {}),
      } as SwapEvent;
    }

    // 6. The executor settles the fill from the real outcome: 'filled' plus Season 1 points and the
    // share-link referral reward only when the swap succeeds, 'failed' otherwise.
    const leaderUser = await getUserBySubaccount(leaderWallet).catch(() => null);
    swapEvent.copy = {
      fill_id: fill.id,
      copier_user_id: target.user_id,
      token_address: tokenAddress,
      points_volume_near: target.buy_amount_near,
      leader_user_id: leaderUser?.id ?? null,
      referrer_id: target.referrer_id ?? null,
    };
    // Pending fills count toward the daily budget, so a burst of copies cannot overspend
    await updateCopyTradeFillResult(fill.id, 'pending', { amount_near: target.buy_amount_near });
    await redis.publish(CHANNELS.EXECUTE_SWAP, JSON.stringify(swapEvent));

    // 9. Notify copier
    const tokenSymbol = tokenCache?.symbol || tokenAddress.split('.')[0].toUpperCase();
    const nearBlocks = `https://nearblocks.io/txns/${cleanSourceTxHash}`;
    const notifyMsg =
      `🏎️ *Copy Trade Sent (BUY)*\n\n` +
      `🎯 *Copied*: \`${leaderWallet}\`\n` +
      `🪙 *Token*: ${tokenSymbol}\n` +
      `💰 *Buying*: ${target.buy_amount_near.toFixed(2)} NEAR worth\n` +
      `🏆 *Season 1*: +${Math.round(target.buy_amount_near * 1.5 + 25)} pts once the buy settles\n` +
      `🔗 [Source Tx on NearBlocks](${nearBlocks})\n\n` +
      `_You'll get a confirmation with the amount received, or a message if the trade fails._`;

    await redis.publish(CHANNELS.NOTIFY_USER, JSON.stringify({
      type: 'notify_user',
      telegram_id: 0,
      event: 'copy_trade_filled',
      data: {
        user_id: target.user_id,
        copy_target_id: target.id,
        leader_wallet: leaderWallet,
        token_address: tokenAddress,
        token_symbol: tokenSymbol,
        amount_near: target.buy_amount_near,
        source_tx_hash: cleanSourceTxHash,
        message: notifyMsg,
      },
    }));

  } catch (err) {
    await updateCopyTradeFillResult(fill.id, 'failed', {
      skip_reason: (err as Error).message.slice(0, 200),
    }).catch(() => {});
    throw err;
  }
}

/**
 * Executes a proportional or full SELL when a copied target sells.
 */
async function executeCopySell(
  target: CopyTradeTargetRecord,
  leaderWallet: string,
  tokenAddress: string,
  sourceTxHash: string,
  hintDclPoolId?: string
): Promise<void> {
  const cleanSourceTxHash = sourceTxHash.replace(/:sell$/, '');
  // 1. Idempotent fill record - returns null if already processed
  const fill = await recordCopyTradeFill({
    copy_target_id: target.id,
    user_id: target.user_id,
    source_tx_hash: cleanSourceTxHash,
    token_address: tokenAddress,
    side: 'sell',
  });
  if (!fill) return;

  try {
    // 2. Check if copier holds an open position (in standard positions OR Confidential Executor Pool)
    const positions = await getOpenPositions(target.user_id).catch(() => []);
    const pos = positions.find(
      p => p.token_address.toLowerCase() === tokenAddress.toLowerCase() && p.status === 'open'
    );

    if (!pos || !pos.quantity_held || BigInt(pos.quantity_held) <= 0n) {
      const openExecutors = await listUserExecutors(target.user_id, ['open']).catch(() => []);
      const hasConfPosition = openExecutors.some(
        e => (e.token || '').toLowerCase() === tokenAddress.toLowerCase()
      );
      if (hasConfPosition) {
        const tokenCache = await getTokenCache(tokenAddress).catch(() => null);
        const venue = tokenCache?.venue || inferVenueFromToken(tokenAddress);
        await redis.publish(CHANNELS.NOTIFY_USER, JSON.stringify({
          type: 'notify_user',
          telegram_id: 0,
          event: 'confidential_copy_trade',
          data: {
            fill_id: fill.id,
            user_id: target.user_id,
            copy_target_id: target.id,
            leader_wallet: leaderWallet,
            token_address: tokenAddress,
            token_symbol: tokenCache?.symbol || tokenAddress.split('.')[0].toUpperCase(),
            venue,
            side: 'sell',
            slippage_pct: target.max_slippage_pct,
            source_tx_hash: cleanSourceTxHash,
          },
        }));
        return;
      }

      await updateCopyTradeFillResult(fill.id, 'skipped', {
        skip_reason: 'User holds no open position in token',
      });
      logger.info('Copy-sell skipped: user has no position', { copyTargetId: target.id, token: tokenAddress });
      return;
    }

    // 3. Check token is tradeable (supports bonded DEXes and unbonded launchpad tokens)
    const tokenCache = await getTokenCache(tokenAddress).catch(() => null);
    const venue = tokenCache?.venue || inferVenueFromToken(tokenAddress);
    if (!isTradableVenue(venue)) {
      await updateCopyTradeFillResult(fill.id, 'skipped', {
        skip_reason: `Token venue '${venue}' is not tradeable`,
      });
      return;
    }

    // 4. Build swap event to sell copier's holding
    let swapEvent: any;
    if (tokenCache?.chain === 'sui' || venue === 'suipump' || tokenAddress.includes('::')) {
      swapEvent = {
        type: 'execute_swap',
        chain: 'sui',
        user_id: target.user_id,
        token_in: tokenAddress,
        token_out: 'sui',
        amount_in: pos.quantity_held,
        min_amount_out: '1',
        venue: 'suipump',
        slippage_pct: target.max_slippage_pct,
        timestamp: Date.now(),
      };
    } else {
      const { dclPoolId: effectiveDclPoolId, rheaPoolId: effectiveRheaPoolId } = await resolveCopyTradePools(
        tokenAddress,
        venue,
        tokenCache,
        hintDclPoolId
      );
      swapEvent = {
        type: 'execute_swap',
        user_id: target.user_id,
        token_in: tokenAddress,
        token_out: 'wrap.near',
        amount_in: pos.quantity_held,
        min_amount_out: '1',
        venue,
        slippage_pct: target.max_slippage_pct,
        timestamp: Date.now(),
        ...(effectiveDclPoolId ? { dcl_pool_id: effectiveDclPoolId } : {}),
        ...(effectiveRheaPoolId != null ? { pool_id: effectiveRheaPoolId } : {}),
      } as SwapEvent;
    }

    swapEvent.copy = { fill_id: fill.id, copier_user_id: target.user_id, token_address: tokenAddress, points_volume_near: 0 };
    await redis.publish(CHANNELS.EXECUTE_SWAP, JSON.stringify(swapEvent));

    const tokenSymbol = tokenCache?.symbol || tokenAddress.split('.')[0].toUpperCase();
    const nearBlocks = `https://nearblocks.io/txns/${cleanSourceTxHash}`;
    const notifyMsg =
      `🏎️ *Copy Trade Sent (SELL)*\n\n` +
      `🎯 *Copied*: \`${leaderWallet}\`\n` +
      `🪙 *Token*: ${tokenSymbol}\n` +
      `🔴 *Action*: Selling 100% of holdings\n` +
      `🔗 [Source Tx on NearBlocks](${nearBlocks})\n\n` +
      `_You'll get a confirmation once the sell settles, or a message if it fails._`;

    await redis.publish(CHANNELS.NOTIFY_USER, JSON.stringify({
      type: 'notify_user',
      telegram_id: 0,
      event: 'copy_trade_filled',
      data: {
        user_id: target.user_id,
        copy_target_id: target.id,
        leader_wallet: leaderWallet,
        token_address: tokenAddress,
        token_symbol: tokenSymbol,
        source_tx_hash: cleanSourceTxHash,
        message: notifyMsg,
      },
    }));
  } catch (err) {
    await updateCopyTradeFillResult(fill.id, 'failed', {
      skip_reason: (err as Error).message.slice(0, 200),
    }).catch(() => {});
    throw err;
  }
}

const DEX_PAYOUT_SOURCES = new Set<string>([
  'dclv2.ref-labs.near',
  'v2.ref-finance.near',
  'ref-finance-101.near',
  'dex.intear.near',
]);

/**
 * Heuristic token & side extractor from swap receipt actions.
 * Correctly detects both BUY and SELL transactions on Ref Finance, Rhea, Aggregatedex, Shards, Jump, and Intear.
 */
export function extractSwapDetails(
  receiverId: string,
  actions: Array<{ methodName: string; args: Record<string, unknown> }>,
  predecessorId?: string
): DetectedSwap | null {
  const isWrapNear = (addr?: string | null) =>
    addr === 'wrap.near' || addr === 'near';

  for (const action of actions) {
    const args = action.args as any;

    // ── Aggregatedex callback_swap: contains decoded swap_request { token_in, msgs: [{ contract_id, amount, msg }] } ──
    if (receiverId === 'aggregatedex.near' && action.methodName === 'callback_swap') {
      const swapReq = args?.swap_request;
      const reqTokenIn: string = swapReq?.token_in ?? '';
      const msgs: any[] = Array.isArray(swapReq?.msgs) ? swapReq.msgs : [];
      if (reqTokenIn && msgs.length > 0) {
        const firstMsg = msgs[0];
        const lastMsg = msgs[msgs.length - 1];
        const syntheticActions = [
          {
            methodName: 'ft_transfer_call',
            args: {
              receiver_id: lastMsg?.contract_id || firstMsg?.contract_id || 'dclv2.ref-labs.near',
              amount: firstMsg?.amount,
              msg: lastMsg?.msg || firstMsg?.msg,
            },
          },
        ];
        const extracted = extractSwapDetails(reqTokenIn, syntheticActions, predecessorId);
        if (extracted) return extracted;
      }
    }

    // ── NearPumpFun: each token contract is its own bonding curve (buy with NEAR, sell for NEAR) ──
    if (receiverId.endsWith(NEARPUMPFUN_SUFFIX) && (action.methodName === 'buy' || action.methodName === 'sell')) {
      const isBuy = action.methodName === 'buy';
      return {
        side: isBuy ? 'buy' : 'sell',
        tokenAddress: receiverId,
        tokenIn: isBuy ? 'wrap.near' : receiverId,
        tokenOut: isBuy ? receiverId : 'wrap.near',
        amountIn: (isBuy ? undefined : args?.tokens_in) as string | undefined,
      };
    }

    // ── Intear: native NEAR in through deposit_near, routed by its operations ──
    if (receiverId === INTEAR_DEX && action.methodName === 'deposit_near') {
      const route = intearRoute(args?.operations);
      if (route && isWrapNear(route.tokenIn) && !isWrapNear(route.tokenOut)) {
        return { side: 'buy', tokenAddress: route.tokenOut, tokenIn: 'wrap.near', tokenOut: route.tokenOut };
      }
    }

    // ── A. Direct Launchpad Contract Actions (NearlyTrade, Meme.Cooking, Intear, JustHoot, OneTokenHub, NEARpad, etc.) ──
    if (LAUNCHPAD_CONTRACTS.has(receiverId)) {
      const buyMethods = new Set(['buy', 'buy_token', 'launch_buy', 'deposit_and_buy', 'deposit']);
      const sellMethods = new Set(['sell', 'sell_token', 'withdraw', 'claim']);

      if (buyMethods.has(action.methodName)) {
        const token = extractTokenFromLaunchpadArgs(receiverId, args);
        if (token) {
          return {
            side: 'buy',
            tokenAddress: token,
            tokenIn: 'wrap.near',
            tokenOut: token,
            amountIn: args?.amount as string | undefined,
          };
        }
      }

      if (sellMethods.has(action.methodName)) {
        const token = extractTokenFromLaunchpadArgs(receiverId, args);
        if (token) {
          return {
            side: 'sell',
            tokenAddress: token,
            tokenIn: token,
            tokenOut: 'wrap.near',
            amountIn: args?.amount as string | undefined,
          };
        }
      }
    }

    // ── B. NEP-141 Token Transfers: ft_transfer_call & ft_on_transfer ──
    const isFtTransferCall = action.methodName === 'ft_transfer_call';
    const isFtOnTransfer = action.methodName === 'ft_on_transfer';

    if (isFtTransferCall || isFtOnTransfer) {
      const tokenTransferred = isFtTransferCall ? receiverId : (predecessorId || '');
      const targetReceiver = isFtTransferCall ? ((args?.receiver_id as string) ?? '') : receiverId;
      const msg = args?.msg;
      let tokenIn = tokenTransferred;
      let tokenOut: string | null = null;
      let amountIn = args?.amount as string | undefined;

      // Ignore DEX-to-aggregator payout receipts (e.g. dclv2.ref-labs.near paying bought tokens to aggregatedex.near with client_echo)
      if (isFtTransferCall && predecessorId && DEX_PAYOUT_SOURCES.has(predecessorId.toLowerCase()) && targetReceiver === 'aggregatedex.near') {
        continue;
      }
      if (isFtOnTransfer && targetReceiver === 'aggregatedex.near') {
        const senderId = String(args?.sender_id ?? '').toLowerCase();
        if (DEX_PAYOUT_SOURCES.has(senderId)) {
          continue;
        }
      }

      // Intear swaps: the operations name the real input and output (any route)
      if (targetReceiver === INTEAR_DEX) {
        const route = intearRoute(msg);
        if (route) {
          if (isQuoteAsset(route.tokenIn) && !isQuoteAsset(route.tokenOut)) {
            return { side: 'buy', tokenAddress: route.tokenOut, tokenIn: 'wrap.near', tokenOut: route.tokenOut, amountIn };
          }
          if (!isQuoteAsset(route.tokenIn) && isQuoteAsset(route.tokenOut)) {
            return { side: 'sell', tokenAddress: route.tokenIn, tokenIn: route.tokenIn, tokenOut: 'wrap.near', amountIn };
          }
          if (!isQuoteAsset(route.tokenIn) && !isQuoteAsset(route.tokenOut) && route.tokenIn !== route.tokenOut) {
            return {
              side: 'buy',
              tokenAddress: route.tokenOut,
              tokenIn: route.tokenIn,
              tokenOut: route.tokenOut,
              amountIn,
              soldTokenIn: route.tokenIn,
            };
          }
          return null;
        }
      }

      // 1. Target receiver is a Launchpad contract (NearlyTrade, Meme.Cooking, Intear, JustHoot, etc.)
      if (LAUNCHPAD_CONTRACTS.has(targetReceiver)) {
        if (isQuoteAsset(tokenTransferred)) {
          // BUYing unbonded launchpad token with wrap.near / quote asset
          let launchpadToken: string | null = null;
          if (typeof msg === 'string') {
            try {
              const parsed = JSON.parse(msg);
              launchpadToken =
                extractTokenFromLaunchpadArgs(targetReceiver, parsed) ??
                extractTokenFromLaunchpadArgs(targetReceiver, parsed?.Deposit ?? parsed?.buy ?? parsed?.swap ?? {});
            } catch {
              if (targetReceiver === 'meme-cooking.near' && /^\d+$/.test(msg.trim())) {
                launchpadToken = `${msg.trim()}.meme-cooking.near`;
              } else if (msg.includes('.near')) {
                launchpadToken = msg.trim();
              }
            }
          }
          if (launchpadToken) {
            return {
              side: 'buy',
              tokenAddress: launchpadToken,
              tokenIn: 'wrap.near',
              tokenOut: launchpadToken,
              amountIn,
            };
          }
        } else {
          // SELLING unbonded launchpad token into the launchpad contract
          return {
            side: 'sell',
            tokenAddress: tokenTransferred,
            tokenIn: tokenTransferred,
            tokenOut: 'wrap.near',
            amountIn,
          };
        }
      }

      // 2. Standard AMM / DEX parsed messages (Ref Finance, Rhea DEX, JumpDeFi, DCL)
      let isParsedJson = false;
      let isClientEchoPayout = false;
      let isMultiHopSwap = false;
      let detectedDclPoolId: string | undefined;
      if (typeof msg === 'string') {
        try {
          const parsed = JSON.parse(msg);
          isParsedJson = Boolean(parsed && typeof parsed === 'object');
          // Detect aggregatedex / DCL client_echo payout messages (e.g. {"user":"...","receive_user":"...","swap_fee":{"fee_token":"wrap.near"}})
          if (
            isParsedJson &&
            (parsed.receive_user || parsed.swap_fee) &&
            !parsed.actions &&
            !parsed.Swap &&
            !parsed.SwapByOutput &&
            !parsed.swap &&
            !parsed.dcl_actions
          ) {
            isClientEchoPayout = true;
          }

          // Standard Ref/Rhea actions array: { actions: [{ token_in, token_out, ... }] }
          const refActions = parsed?.actions ?? parsed?.Swap?.actions ?? parsed?.dcl_actions ?? [];
          if (Array.isArray(refActions) && refActions.length > 0) {
            tokenIn = refActions[0]?.token_in || tokenTransferred;
            tokenOut = refActions[refActions.length - 1]?.token_out || null;
            if (refActions[0]?.amount_in) amountIn = refActions[0].amount_in;
            if (refActions.length > 1) {
              isMultiHopSwap = true;
            }
          } else if (parsed?.Swap?.output_token || parsed?.SwapByOutput?.output_token) {
            // Ref DCL (dclv2.ref-labs.near): {"Swap":{"pool_ids":[...],"output_token":"..."}}
            tokenOut = parsed.Swap?.output_token || parsed.SwapByOutput?.output_token;
            const poolIds: unknown[] = parsed.Swap?.pool_ids ?? parsed.SwapByOutput?.pool_ids ?? [];
            if (Array.isArray(poolIds) && poolIds.length > 0) {
              if (poolIds.length > 1) {
                isMultiHopSwap = true;
              }
              // Extract DCL pool ID if a pool pairs wrap.near with the target token
              for (const p of poolIds) {
                if (typeof p === 'string' && p.includes('wrap.near')) {
                  if (tokenOut && !isQuoteAsset(tokenOut) && p.includes(tokenOut)) {
                    detectedDclPoolId = p;
                  } else if (tokenIn && !isQuoteAsset(tokenIn) && p.includes(tokenIn) && !detectedDclPoolId) {
                    detectedDclPoolId = p;
                  }
                }
              }
            }
          } else if (parsed?.swap?.token_out || parsed?.swap?.output_token) {
            tokenOut = parsed.swap?.token_out || parsed.swap?.output_token;
            if (parsed.swap?.token_in) tokenIn = parsed.swap.token_in;
          } else if (parsed?.output_token) {
            tokenOut = parsed.output_token;
          } else if (parsed?.token_out) {
            tokenOut = parsed.token_out;
          } else if (parsed?.DclSwap?.token_out || parsed?.dcl_swap?.token_out) {
            tokenOut = parsed.DclSwap?.token_out || parsed.dcl_swap?.token_out;
            if (parsed.DclSwap?.token_in || parsed.dcl_swap?.token_in) {
              tokenIn = parsed.DclSwap?.token_in || parsed.dcl_swap?.token_in;
            }
          }
        } catch { /* ignore JSON parse error */ }
      }

      if (isClientEchoPayout) {
        continue;
      }

      // 3. BUY: Quote Asset (wrap.near / USDC / USDT / PRL / QTC) -> Token
      if (isQuoteAsset(tokenIn) && tokenOut && !isQuoteAsset(tokenOut)) {
        return {
          side: 'buy',
          tokenAddress: tokenOut,
          tokenIn: isWrapNear(tokenIn) ? tokenIn : 'wrap.near',
          tokenOut,
          amountIn,
          ...(detectedDclPoolId ? { dclPoolId: detectedDclPoolId } : {}),
        };
      }

      // 4. SELL: Token -> Quote Asset (wrap.near / USDC / USDT / PRL / QTC)
      if (!isQuoteAsset(tokenIn) && tokenIn && tokenOut && isQuoteAsset(tokenOut)) {
        return {
          side: 'sell',
          tokenAddress: tokenIn,
          tokenIn,
          tokenOut: 'wrap.near',
          amountIn,
          ...(detectedDclPoolId ? { dclPoolId: detectedDclPoolId } : {}),
        };
      }

      // 4b. TokenA -> TokenB swap (single or multi-hop, e.g. TokenA -> wrap.near -> TokenB or TokenA -> PRL -> USDC -> wrap.near -> TokenB)
      if ((isMultiHopSwap || (tokenIn && tokenOut)) && tokenIn && !isQuoteAsset(tokenIn) && tokenOut && !isQuoteAsset(tokenOut) && tokenIn !== tokenOut) {
        return {
          side: 'buy',
          tokenAddress: tokenOut,
          tokenIn: 'wrap.near',
          tokenOut,
          amountIn,
          soldTokenIn: tokenIn,
          ...(detectedDclPoolId ? { dclPoolId: detectedDclPoolId } : {}),
        };
      }

      // 5. Transferred non-quote token with swap message leading to wrap.near
      // Only use raw string msg.includes('wrap.near') fallback when msg is not structured JSON with a non-NEAR tokenOut
      if (
        !isQuoteAsset(tokenTransferred) &&
        (isQuoteAsset(tokenOut) || (!isParsedJson && !tokenOut && typeof msg === 'string' && msg.includes('wrap.near')))
      ) {
        return {
          side: 'sell',
          tokenAddress: tokenTransferred,
          tokenIn: tokenTransferred,
          tokenOut: 'wrap.near',
          amountIn,
          ...(detectedDclPoolId ? { dclPoolId: detectedDclPoolId } : {}),
        };
      }

      // 6. Transferred quote asset with token_out specified
      if (isQuoteAsset(tokenTransferred) && tokenOut && !isQuoteAsset(tokenOut)) {
        return {
          side: 'buy',
          tokenAddress: tokenOut,
          tokenIn: 'wrap.near',
          tokenOut,
          amountIn,
          ...(detectedDclPoolId ? { dclPoolId: detectedDclPoolId } : {}),
        };
      }
    }

    // ── C. Direct Swap Function (ShardsMarket, NearlyTrade, Rhea, Intear) ──
    if (action.methodName === 'swap') {
      const tokenIn = args?.token_in ?? args?.input_token ?? null;
      const tokenOut = args?.token_out ?? args?.output_token ?? null;

      if (isQuoteAsset(tokenIn) && tokenOut && !isQuoteAsset(tokenOut)) {
        return {
          side: 'buy',
          tokenAddress: tokenOut,
          tokenIn: 'wrap.near',
          tokenOut,
          amountIn: args?.amount_in ?? args?.amount,
        };
      }

      if (!isQuoteAsset(tokenIn) && tokenIn && isQuoteAsset(tokenOut)) {
        return {
          side: 'sell',
          tokenAddress: tokenIn,
          tokenIn,
          tokenOut: 'wrap.near',
          amountIn: args?.amount_in ?? args?.amount,
        };
      }

      if (!isQuoteAsset(tokenIn) && tokenIn && tokenOut && !isQuoteAsset(tokenOut) && tokenIn !== tokenOut) {
        return {
          side: 'buy',
          tokenAddress: tokenOut,
          tokenIn: 'wrap.near',
          tokenOut,
          amountIn: args?.amount_in ?? args?.amount,
          soldTokenIn: tokenIn,
        };
      }
    }
  }

  return null;
}
