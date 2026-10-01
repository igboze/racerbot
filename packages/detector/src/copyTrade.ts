/**
 * Copy Trading Detector
 *
 * Watches the NEAR block stream for swap transactions made by any wallet
 * that RacerBot users are actively copying. When a match is found it:
 *  1. Guards against daily budget caps and slippage protection
 *  2. Publishes an AUTO_BUY_SIGNAL (buy) or EXECUTE_SWAP (sell) to the executor
 *  3. Records the copy fill in DB (idempotent — source_tx_hash deduplicates)
 *  4. Awards Season 1 points to the copier (+ leader bonus if leader is a user)
 *  5. Notifies the copier via NOTIFY_USER channel
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
  getTokenReferral,
  recordTokenReferral,
  addTokenReferralReward,
  awardPointsForCopyTrade,
  type CopyTradeTargetRecord,
} from '@racerbot/db';

const logger = createLogger('copy-detector');
const REDIS_URL = process.env.REDIS_URL!;
const redis = createRedis(REDIS_URL);

// ── In-memory set of tracked wallets (refreshed every 60s) ───────────────────
// The detector reads this set on every block — DB must not be hit in the hot path.
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
  // Fast O(1) check — skip almost everything
  if (!trackedWallets.has(signerAccountId)) return;

  // Determine if this is a DEX swap action
  const swapAction = actions.find(a =>
    ['swap', 'ft_transfer_call', 'near_deposit'].includes(a.methodName) ||
    a.args?.actions !== undefined  // Ref-style batch swap
  );
  if (!swapAction) return;

  // Extract token being bought (token_out) from the swap args
  const tokenAddress = extractSwappedToken(receiverAccountId, swapAction);
  if (!tokenAddress || tokenAddress === 'wrap.near') return;

  logger.info('Copy-trade event detected', {
    signer: signerAccountId, token: tokenAddress, txHash,
  });

  // Load followers (with DB cache-hit courtesy of the in-memory set above)
  const followers = await getCopyTargetFollowersByWallet(signerAccountId).catch(() => []);
  if (followers.length === 0) {
    // Wallet was removed since last refresh — will drop on next refresh
    return;
  }

  // Process each follower in parallel, independently — one failure must not block others
  await Promise.all(
    followers.map(target =>
      executeCopyBuy(target, signerAccountId, tokenAddress, txHash).catch(err => {
        logger.error('Copy-trade execution error', err as Error, {
          copyTargetId: target.id, follower: target.user_id,
        });
      })
    )
  );
}

async function executeCopyBuy(
  target: CopyTradeTargetRecord,
  leaderWallet: string,
  tokenAddress: string,
  sourceTxHash: string
): Promise<void> {
  // 1. Idempotent fill record — returns null if already processed
  const fill = await recordCopyTradeFill({
    copy_target_id: target.id,
    user_id: target.user_id,
    source_tx_hash: sourceTxHash,
    token_address: tokenAddress,
    side: 'buy',
  });
  if (!fill) return; // duplicate — already handled

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
        skip_reason: `Token not tradeable on any supported venue`,
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
    // Use the copy target's max_slippage_pct (user-configured for this specific copy target)
    const slippagePct = target.max_slippage_pct;

    // 5. Build swap
    const near = getNear();
    const amountInYocto = BigInt(Math.floor(target.buy_amount_near * 1e24)).toString();
    const { minAmountOut } = await near.computeMinAmountOut(
      venue,
      'wrap.near',
      tokenAddress,
      amountInYocto,
      slippagePct,
      tokenCache.rhea_pool_id ?? undefined,
      tokenCache.dcl_pool_id ?? undefined
    );

    const swapEvent: SwapEvent = {
      type: 'execute_swap',
      user_id: target.user_id,
      token_in: 'wrap.near',
      token_out: tokenAddress,
      amount_in: amountInYocto,
      min_amount_out: minAmountOut,
      venue,
      timestamp: Date.now(),
      notify_user: false, // we send our own notification below
      ...(tokenCache.dcl_pool_id ? { dcl_pool_id: tokenCache.dcl_pool_id } : {}),
      ...(tokenCache.rhea_pool_id != null ? { pool_id: tokenCache.rhea_pool_id } : {}),
    } as SwapEvent;

    await redis.publish(CHANNELS.EXECUTE_SWAP, JSON.stringify(swapEvent));

    // 6. Mark fill as sent (executor will confirm via its own notification)
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
    ).catch(() => {}); // non-fatal

    // 8. Group-link 5% fee reward (token_referrals — same mechanism as token share links)
    const botFeePct = 0.015; // 1.5% flat bot fee
    const copyFeeReward = target.buy_amount_near * botFeePct * 0.05; // 5% of bot fee
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
      `🏎️ *Copy Trade Executed!*\n\n` +
      `🎯 *Copied*: \`${leaderWallet}\`\n` +
      `🪙 *Token*: ${tokenSymbol}\n` +
      `⚡ *Bought*: ${target.buy_amount_near.toFixed(2)} NEAR worth\n` +
      `🏆 *Season 1*: +${Math.round(target.buy_amount_near * 1.5 + 25)} pts earned\n` +
      `🔗 [Source Tx ↗️](${nearBlocks})\n\n` +
      `_Use \\[Sell\\] buttons on your Holdings to exit._`;

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
 * Heuristic token extractor from swap receipt args.
 * Returns the non-NEAR token address being acquired.
 */
function extractSwappedToken(receiverId: string, action: { methodName: string; args: Record<string, unknown> }): string | null {
  const args = action.args as any;

  // Ref Finance / Rhea: ft_transfer_call to wrap.near with receiver = ref-finance
  if (action.methodName === 'ft_transfer_call') {
    const msg = args?.msg;
    if (typeof msg === 'string') {
      try {
        const parsed = JSON.parse(msg);
        // Ref-style: { actions: [{ token_in, token_out, ... }] }
        const refActions = parsed?.actions ?? [];
        if (refActions.length > 0) {
          const tokenOut = refActions[refActions.length - 1]?.token_out;
          if (tokenOut && tokenOut !== 'wrap.near') return tokenOut;
        }
      } catch { /* ignore */ }
    }
    return null;
  }

  // Shardsmarket / NearlyTrade: direct swap function
  if (action.methodName === 'swap') {
    const tokenOut = args?.token_out ?? args?.output_token ?? null;
    if (tokenOut && tokenOut !== 'wrap.near') return tokenOut as string;
  }

  // Intear-style
  if (args?.token_out && args.token_out !== 'wrap.near') {
    return args.token_out as string;
  }

  return null;
}
