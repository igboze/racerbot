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
  getTokenReferral,
  recordTokenReferral,
  addTokenReferralReward,
  awardPointsForCopyTrade,
  type CopyTradeTargetRecord,
} from '@racerbot/db';

const logger = createLogger('copy-detector');
const REDIS_URL = process.env.REDIS_URL!;
const redis = createRedis(REDIS_URL);

// In-memory set of tracked wallets (refreshed every 60s)
// The detector reads this set on every block - DB must not be hit in the hot path.
let trackedWallets = new Set<string>();
const WALLET_REFRESH_MS = 60_000;

export async function initCopyTradeDetector(): Promise<void> {
  await refreshTrackedWallets();
  setInterval(refreshTrackedWallets, WALLET_REFRESH_MS);
  logger.info('Copy-trade detector initialized', { watching: trackedWallets.size });
}

async function refreshTrackedWallets(): Promise<void> {
  try {
    const wallets = await getAllActiveCopyTargetWallets();
    trackedWallets = new Set(wallets);
  } catch (err) {
    logger.error('Failed to refresh tracked copy-trade wallets', err as Error);
  }
}

export interface DetectedSwap {
  side: 'buy' | 'sell';
  tokenAddress: string;
  tokenIn: string;
  tokenOut: string;
  amountIn?: string;
}

/**
 * Called by the detector hot-path for every block's receipt_execution_outcome.
 * Returns immediately if the signer is not a tracked wallet.
 */
export async function checkCopyTradeReceipt(
  signerAccountId: string,
  receiverAccountId: string,
  txHash: string,
  actions: Array<{ methodName: string; args: Record<string, unknown> }>
): Promise<void> {
  // Fast O(1) check - skip untracked wallets immediately
  if (!trackedWallets.has(signerAccountId)) return;

  const swap = extractSwapDetails(receiverAccountId, actions);
  if (!swap || !swap.tokenAddress) return;

  logger.info('Copy-trade event detected', {
    signer: signerAccountId,
    side: swap.side,
    token: swap.tokenAddress,
    txHash,
  });

  // Load followers (with DB cache-hit courtesy of the in-memory set above)
  const followers = await getCopyTargetFollowersByWallet(signerAccountId).catch(() => []);
  if (followers.length === 0) return;

  // Process each follower in parallel, independently - one failure must not block others
  await Promise.all(
    followers.map(async (target) => {
      try {
        if (target.track_only) {
          // Wallet Tracker mode: Send alert with quick actions without auto-buying/selling
          await handleTrackerAlert(target, signerAccountId, swap, txHash);
        } else if (swap.side === 'buy') {
          // Auto-Copy BUY
          await executeCopyBuy(target, signerAccountId, swap.tokenAddress, txHash);
        } else if (swap.side === 'sell') {
          // Auto-Copy SELL (if enabled)
          if (target.copy_sells) {
            await executeCopySell(target, signerAccountId, swap.tokenAddress, txHash);
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
  const tokenSymbol = tokenCache?.symbol || swap.tokenAddress.slice(0, 12);
  const nearBlocks = `https://nearblocks.io/txns/${sourceTxHash}`;

  const isBuy = swap.side === 'buy';
  const actionEmoji = isBuy ? '🟢' : '🔴';
  const actionText = isBuy ? 'BOUGHT' : 'SOLD';

  const notifyMsg =
    `👀 *Wallet Tracker Alert*\n\n` +
    `🎯 *Tracked Wallet*: \`${leaderWallet}\`\n` +
    `${actionEmoji} *Action*: ${actionText} *${tokenSymbol}*\n` +
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
          { text: '📊 View Token Card', callback_data: `token_${swap.tokenAddress}` },
          { text: '📈 Chart', url: `https://dexscreener.com/near/${swap.tokenAddress}` },
        ],
      ]
    : [
        [
          { text: '📊 View Token & Holdings', callback_data: `token_${swap.tokenAddress}` },
          { text: '📈 Chart', url: `https://dexscreener.com/near/${swap.tokenAddress}` },
        ],
      ];

  await updateCopyTradeFillResult(fill.id, 'filled', { amount_near: 0 });

  await redis.publish(CHANNELS.NOTIFY_USER, JSON.stringify({
    type: 'notify_user',
    telegram_id: 0,
    event: 'wallet_tracker_alert',
    data: {
      user_id: target.user_id,
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

async function executeCopyBuy(
  target: CopyTradeTargetRecord,
  leaderWallet: string,
  tokenAddress: string,
  sourceTxHash: string
): Promise<void> {
  // 1. Idempotent fill record - returns null if already processed
  const fill = await recordCopyTradeFill({
    copy_target_id: target.id,
    user_id: target.user_id,
    source_tx_hash: sourceTxHash,
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

    // 3. Check token is tradeable
    const tokenCache = await getTokenCache(tokenAddress).catch(() => null);
    if (!tokenCache || !isTradableVenue(tokenCache.venue)) {
      await updateCopyTradeFillResult(fill.id, 'skipped', {
        skip_reason: 'Token not tradeable on any supported venue',
      });
      return;
    }
    const venue = tokenCache.venue!;

    // 4. Fetch user + slippage preference
    const user = await getUserById(target.user_id).catch(() => null);
    if (!user) {
      await updateCopyTradeFillResult(fill.id, 'failed', { skip_reason: 'User not found' });
      return;
    }
    const slippagePct = target.max_slippage_pct;

    // 5. Build swap
    let swapEvent: any;
    if (tokenCache.chain === 'sui' || venue === 'suipump' || tokenAddress.includes('::')) {
      const amountInMist = BigInt(Math.floor(target.buy_amount_near * 1e9)).toString();
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
        notify_user: false,
      };
    } else {
      const near = getNear();
      const amountInYocto = BigInt(Math.floor(target.buy_amount_near * 1e24)).toString();
      const { minAmountOut } = await near.computeMinAmountOut(
        venue as any,
        'wrap.near',
        tokenAddress,
        amountInYocto,
        slippagePct,
        tokenCache.rhea_pool_id ?? undefined,
        tokenCache.dcl_pool_id ?? undefined
      );

      swapEvent = {
        type: 'execute_swap',
        user_id: target.user_id,
        token_in: 'wrap.near',
        token_out: tokenAddress,
        amount_in: amountInYocto,
        min_amount_out: minAmountOut,
        venue,
        timestamp: Date.now(),
        notify_user: false,
        ...(tokenCache.dcl_pool_id ? { dcl_pool_id: tokenCache.dcl_pool_id } : {}),
        ...(tokenCache.rhea_pool_id != null ? { pool_id: tokenCache.rhea_pool_id } : {}),
      } as SwapEvent;
    }

    await redis.publish(CHANNELS.EXECUTE_SWAP, JSON.stringify(swapEvent));

    // 6. Mark fill as sent
    await updateCopyTradeFillResult(fill.id, 'filled', {
      amount_near: target.buy_amount_near,
    });

    // 7. Season 1 Points: award copier + potential leader bonus
    const leaderUser = await getUserBySubaccount(leaderWallet).catch(() => null);
    await awardPointsForCopyTrade(
      target.user_id,
      fill.id,
      target.buy_amount_near,
      leaderUser?.id ?? undefined
    ).catch(() => {});

    // 8. Group-link 5% fee reward
    const botFeePct = 0.015;
    const copyFeeReward = target.buy_amount_near * botFeePct * 0.05;
    if (target.referrer_id && target.referrer_id !== target.user_id) {
      const ref = await recordTokenReferral(target.user_id, tokenAddress, target.referrer_id).catch(() => null);
      if (ref) {
        await addTokenReferralReward(ref.id, copyFeeReward).catch(() => {});
      }
    } else {
      const tokenReferral = await getTokenReferral(target.user_id, tokenAddress).catch(() => null);
      if (tokenReferral) {
        await addTokenReferralReward(tokenReferral.id, copyFeeReward).catch(() => {});
      }
    }

    // 9. Notify copier
    const tokenSymbol = tokenCache.symbol || tokenAddress.slice(0, 12);
    const nearBlocks = `https://nearblocks.io/txns/${sourceTxHash}`;
    const notifyMsg =
      `🏎️ *Copy Trade Executed (BUY)!*\n\n` +
      `🎯 *Copied*: \`${leaderWallet}\`\n` +
      `🪙 *Token*: ${tokenSymbol}\n` +
      `💰 *Bought*: ${target.buy_amount_near.toFixed(2)} NEAR worth\n` +
      `🏆 *Season 1*: +${Math.round(target.buy_amount_near * 1.5 + 25)} pts earned\n` +
      `🔗 [Source Tx on NearBlocks](${nearBlocks})\n\n` +
      `_Use [Holdings] or [Token Card] to manage your position._`;

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
        source_tx_hash: sourceTxHash,
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
  sourceTxHash: string
): Promise<void> {
  // 1. Idempotent fill record - returns null if already processed
  const fill = await recordCopyTradeFill({
    copy_target_id: target.id,
    user_id: target.user_id,
    source_tx_hash: sourceTxHash,
    token_address: tokenAddress,
    side: 'sell',
  });
  if (!fill) return;

  try {
    // 2. Check if copier holds an open position
    const positions = await getOpenPositions(target.user_id).catch(() => []);
    const pos = positions.find(
      p => p.token_address.toLowerCase() === tokenAddress.toLowerCase() && p.status === 'open'
    );

    if (!pos || !pos.quantity_held || BigInt(pos.quantity_held) <= 0n) {
      await updateCopyTradeFillResult(fill.id, 'skipped', {
        skip_reason: 'User holds no open position in token',
      });
      logger.info('Copy-sell skipped: user has no position', { copyTargetId: target.id, token: tokenAddress });
      return;
    }

    // 3. Check token is tradeable
    const tokenCache = await getTokenCache(tokenAddress).catch(() => null);
    if (!tokenCache || !isTradableVenue(tokenCache.venue)) {
      await updateCopyTradeFillResult(fill.id, 'skipped', {
        skip_reason: 'Token not tradeable on any supported venue',
      });
      return;
    }
    const venue = tokenCache.venue!;

    // 4. Build swap event to sell copier's holding
    let swapEvent: any;
    if (tokenCache.chain === 'sui' || venue === 'suipump' || tokenAddress.includes('::')) {
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
        notify_user: false,
      };
    } else {
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
        notify_user: false,
        ...(tokenCache.dcl_pool_id ? { dcl_pool_id: tokenCache.dcl_pool_id } : {}),
        ...(tokenCache.rhea_pool_id != null ? { pool_id: tokenCache.rhea_pool_id } : {}),
      } as SwapEvent;
    }

    await redis.publish(CHANNELS.EXECUTE_SWAP, JSON.stringify(swapEvent));

    await updateCopyTradeFillResult(fill.id, 'filled', { amount_near: 0 });

    const tokenSymbol = tokenCache.symbol || tokenAddress.slice(0, 12);
    const nearBlocks = `https://nearblocks.io/txns/${sourceTxHash}`;
    const notifyMsg =
      `🏎️ *Copy Trade Executed (SELL)!*\n\n` +
      `🎯 *Copied*: \`${leaderWallet}\`\n` +
      `🪙 *Token*: ${tokenSymbol}\n` +
      `🔴 *Action*: Sold 100% of holdings\n` +
      `🔗 [Source Tx on NearBlocks](${nearBlocks})\n\n` +
      `_Your position has been exited in accordance with leader activity._`;

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
        source_tx_hash: sourceTxHash,
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
 * Heuristic token & side extractor from swap receipt actions.
 * Correctly detects both BUY and SELL transactions on Ref Finance, Rhea, Shards, Jump, and Intear.
 */
export function extractSwapDetails(
  receiverId: string,
  actions: Array<{ methodName: string; args: Record<string, unknown> }>
): DetectedSwap | null {
  const isWrapNear = (addr?: string | null) =>
    addr === 'wrap.near' || addr === 'near';

  for (const action of actions) {
    const args = action.args as any;

    // Ref Finance, Rhea, JumpDeFi: ft_transfer_call
    if (action.methodName === 'ft_transfer_call') {
      const tokenTransferred = receiverId;
      const msg = args?.msg;
      let tokenIn = tokenTransferred;
      let tokenOut: string | null = null;
      let amountIn = args?.amount as string | undefined;

      if (typeof msg === 'string') {
        try {
          const parsed = JSON.parse(msg);
          // Standard Ref/Rhea actions array: { actions: [{ token_in, token_out, ... }] }
          const refActions = parsed?.actions ?? parsed?.Swap?.actions ?? [];
          if (Array.isArray(refActions) && refActions.length > 0) {
            tokenIn = refActions[0]?.token_in || tokenTransferred;
            tokenOut = refActions[refActions.length - 1]?.token_out || null;
            if (refActions[0]?.amount_in) amountIn = refActions[0].amount_in;
          } else if (parsed?.swap?.token_out || parsed?.swap?.output_token) {
            tokenOut = parsed.swap?.token_out || parsed.swap?.output_token;
            if (parsed.swap?.token_in) tokenIn = parsed.swap.token_in;
          } else if (parsed?.output_token) {
            tokenOut = parsed.output_token;
          }
        } catch { /* ignore JSON parse error */ }
      }

      // 1. BUY: wrap.near -> Token
      if (isWrapNear(tokenIn) && tokenOut && !isWrapNear(tokenOut)) {
        return {
          side: 'buy',
          tokenAddress: tokenOut,
          tokenIn,
          tokenOut,
          amountIn,
        };
      }

      // 2. SELL: Token -> wrap.near
      if (!isWrapNear(tokenIn) && tokenOut && isWrapNear(tokenOut)) {
        return {
          side: 'sell',
          tokenAddress: tokenIn,
          tokenIn,
          tokenOut,
          amountIn,
        };
      }

      // 3. Transferred non-wrap.near token with swap message leading to wrap.near
      if (!isWrapNear(tokenTransferred) && (isWrapNear(tokenOut) || (typeof msg === 'string' && msg.includes('wrap.near')))) {
        return {
          side: 'sell',
          tokenAddress: tokenTransferred,
          tokenIn: tokenTransferred,
          tokenOut: 'wrap.near',
          amountIn,
        };
      }

      // 4. Transferred wrap.near with token_out specified
      if (isWrapNear(tokenTransferred) && tokenOut && !isWrapNear(tokenOut)) {
        return {
          side: 'buy',
          tokenAddress: tokenOut,
          tokenIn: 'wrap.near',
          tokenOut,
          amountIn,
        };
      }
    }

    // Direct swap function (Shardsmarket, NearlyTrade, Rhea, Intear)
    if (action.methodName === 'swap') {
      const tokenIn = args?.token_in ?? args?.input_token ?? null;
      const tokenOut = args?.token_out ?? args?.output_token ?? null;

      if (isWrapNear(tokenIn) && tokenOut && !isWrapNear(tokenOut)) {
        return {
          side: 'buy',
          tokenAddress: tokenOut,
          tokenIn: tokenIn || 'wrap.near',
          tokenOut,
          amountIn: args?.amount_in ?? args?.amount,
        };
      }

      if (!isWrapNear(tokenIn) && tokenIn && isWrapNear(tokenOut)) {
        return {
          side: 'sell',
          tokenAddress: tokenIn,
          tokenIn,
          tokenOut: tokenOut || 'wrap.near',
          amountIn: args?.amount_in ?? args?.amount,
        };
      }
    }
  }

  return null;
}