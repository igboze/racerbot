import { ethers } from 'ethers';
import { getNear, getSolanaTokenBalance, SOL_MINT, toTokenUnits } from '@racerbot/shared';
import { getPositionById, getUserById, updatePosition } from '@racerbot/db';
import { getTokenInfo, publishSwap } from './wallet.js';

/**
 * Sell a percentage of a position by publishing EXECUTE_SWAP to Redis.
 * Called from both the Telegram bot sell buttons and REST API.
 */
export async function sellAtTarget(
  userId: string,
  positionId: string,
  percentage: number,
  onProgress?: (stage: string) => void,
  options: { suppressAlphaSignal?: boolean; slippagePct?: number } = {}
): Promise<{ success: boolean; reason?: string; usdcReceived?: number; nearReceived?: number }> {

  if (!Number.isFinite(percentage) || percentage <= 0 || percentage > 100) {
    return { success: false, reason: 'invalid_sell_percentage' };
  }

  const position = await getPositionById(positionId);
  if (!position) return { success: false, reason: 'position_not_found' };
  if (position.status === 'closed') return { success: false, reason: 'position_already_closed' };
  if (position.user_id !== userId) return { success: false, reason: 'not_your_position' };

  // HyperEVM and Elysium positions hold human amounts ("0.5"), not raw units, so their integer part can be 0
  const isEvmPosition = position.chain === 'hyperevm' || position.chain === 'elysium';
  const rawQty = BigInt(position.quantity_held.split('.')[0] || '0');
  if (!isEvmPosition && rawQty <= 0n) return { success: false, reason: 'zero_quantity' };

  const sellPctBps = BigInt(Math.floor(percentage * 100));
  // A typed full amount can round to 99.99..%; anything short of that is a partial sell and keeps the position open
  const fullExit = percentage >= 99.99;
  const sellQty = fullExit
    ? rawQty.toString()
    : ((rawQty * sellPctBps) / 10000n).toString();

  if (sellQty === '0' && !isEvmPosition) return { success: false, reason: 'zero_quantity' };

  // Use cached token info for instant (<1ms) metadata & pool resolution
  const info = await getTokenInfo(position.token_address, false).catch(() => null);
  if (!info) return { success: false, reason: 'token_not_found' };

  const user = await getUserById(userId).catch(() => null);
  const configuredSlippage = Number(options.slippagePct);
  const slippagePct = Number.isFinite(configuredSlippage) && configuredSlippage > 0
    ? Math.min(15, configuredSlippage)
    : user?.slippage_pct ? Number(user.slippage_pct) : 2.0;

  // Solana Chain Execution Route (Jupiter: pump.fun curve and bonded AMMs)
  if (position.chain === 'solana' || info.chain === 'solana') {
    let amountIn = sellQty;
    // For full exits sell the exact on-chain balance, so no dust is left behind.
    if (fullExit && user?.solana_address) {
      const onChain = await getSolanaTokenBalance(user.solana_address, position.token_address, true).catch(() => null);
      if (onChain && onChain.raw > 0n) amountIn = onChain.raw.toString();
      if (onChain && onChain.raw === 0n) {
        await updatePosition({ position_id: positionId, status: 'closed', closed_at: new Date(), quantity_held: '0' }).catch(() => {});
        return { success: false, reason: 'zero_quantity' };
      }
    }
    const swapEvent = {
      type: 'execute_swap' as const,
      chain: 'solana' as const,
      user_id: userId,
      token_in: position.token_address,
      token_out: SOL_MINT,
      amount_in: amountIn,
      min_amount_out: '1',
      venue: ((info.venue as any) || 'jupiter'),
      timestamp: Date.now(),
      slippage_pct: Math.max(slippagePct, info.bonding_phase === 'prebonded' ? 5 : 2),
    };
    const swapResult = await publishSwap(swapEvent, onProgress, options);
    if (swapResult.success === false) {
      return { success: false, reason: swapResult.reason || 'Solana sell failed.' };
    }
    if (fullExit) {
      await updatePosition({
        position_id: positionId,
        status: 'closed',
        closed_at: new Date(),
        quantity_held: '0',
      }).catch(() => {});
    }
    return { success: true, usdcReceived: swapResult.usdcReceived, nearReceived: swapResult.nearReceived };
  }

  // HyperEVM & Elysium Chain Execution Route
  if (position.chain === 'hyperevm' || position.chain === 'elysium' || info.chain === 'hyperevm' || info.chain === 'elysium') {
    const chain = (position.chain || info.chain || 'hyperevm') as 'hyperevm' | 'elysium';
    // Take the share of the decimal holding (18 places covers every ERC-20); the executor caps it at the wallet balance
    const heldUnits = toTokenUnits(position.quantity_held, 18);
    const evmSellUnits = fullExit ? heldUnits : (heldUnits * sellPctBps) / 10000n;
    if (evmSellUnits <= 0n) return { success: false, reason: 'zero_quantity' };
    const swapEvent = {
      type: 'execute_swap' as const,
      chain,
      user_id: userId,
      token_in: position.token_address,
      token_out: 'HYPE',
      amount_in: ethers.formatUnits(evmSellUnits, 18),
      min_amount_out: '1',
      venue: info.venue === 'kleos' || info.venue === 'ronspad' ? info.venue : `${chain}_dex` as any,
      timestamp: Date.now(),
      slippage_pct: slippagePct,
    };

    const swapResult = await publishSwap(swapEvent, onProgress, options);
    if (swapResult.success === false) {
      return { success: false, reason: swapResult.reason || `${chain} sell failed on-chain.` };
    }
    if (fullExit) {
      await updatePosition({
        position_id: positionId,
        status: 'closed',
        closed_at: new Date(),
        quantity_held: '0',
      }).catch(() => {});
    }
    return { success: true, usdcReceived: swapResult.usdcReceived, nearReceived: swapResult.nearReceived };
  }

  // Starknet Chain Execution Route
  if (position.chain === 'starknet' || info.chain === 'starknet' || info.venue === 'avnu' || info.venue === 'ekubo' || info.venue === 'launchy' || info.venue === 'unruggable') {
    const swapEvent = {
      type: 'execute_swap' as const,
      chain: 'starknet' as const,
      user_id: userId,
      token_in: position.token_address,
      token_out: 'strk',
      amount_in: sellQty,
      min_amount_out: '1',
      venue: (info.venue as any) || 'avnu',
      timestamp: Date.now(),
      slippage_pct: slippagePct,
    };

    const swapResult = await publishSwap(swapEvent, onProgress, options);
    if (swapResult.success === false) {
      return { success: false, reason: swapResult.reason || 'Starknet sell failed on-chain.' };
    }
    if (fullExit) {
      await updatePosition({
        position_id: positionId,
        status: 'closed',
        closed_at: new Date(),
        quantity_held: '0',
      }).catch(() => {});
    }
    return { success: true, usdcReceived: swapResult.usdcReceived, nearReceived: swapResult.nearReceived };
  }

  // Sui Chain Execution Route
  if (position.chain === 'sui' || info.chain === 'sui' || info.venue === 'suipump') {
    const swapEvent = {
      type: 'execute_swap' as const,
      chain: 'sui' as const,
      user_id: userId,
      token_in: position.token_address,
      token_out: 'sui',
      amount_in: sellQty,
      min_amount_out: '1',
      venue: 'suipump' as const,
      timestamp: Date.now(),
      slippage_pct: slippagePct,
    };

    const swapResult = await publishSwap(swapEvent, onProgress, options);
    if (swapResult.success === false) {
      return { success: false, reason: swapResult.reason || 'Sui sell failed on-chain.' };
    }
    if (fullExit) {
      await updatePosition({
        position_id: positionId,
        status: 'closed',
        closed_at: new Date(),
        quantity_held: '0',
      }).catch(() => {});
    }
    return { success: true, usdcReceived: swapResult.usdcReceived, nearReceived: swapResult.nearReceived };
  }

  if (!['rhea', 'ref', 'shardsmarket', 'nearlytrade', 'intear', 'onetokenhub', 'nearpad', 'gaypad', 'memecooking', 'shoremarkets', 'kelytra', 'nearpumpfun'].includes(info.venue)) {
    return { success: false, reason: 'venue_unknown' };
  }
  let venue = info.venue as 'rhea' | 'ref' | 'shardsmarket' | 'nearlytrade' | 'intear' | 'onetokenhub' | 'nearpad' | 'gaypad' | 'memecooking' | 'shoremarkets' | 'kelytra' | 'nearpumpfun';
  let effectiveDclPoolId = (info.dcl_pool_id && (info.dcl_pool_id.includes('|') || info.dcl_pool_id.includes('>'))) ? info.dcl_pool_id : undefined;
  let effectiveRheaPoolId = info.rhea_pool_id ?? (info.dcl_pool_id && !info.dcl_pool_id.includes('|') ? parseInt(info.dcl_pool_id, 10) : undefined);

  const near = getNear();

  console.log(`[SELL_HELPER] sellAtTarget: user=${userId}, pos=${positionId}, pct=${percentage}%, qty=${sellQty}, token=${position.token_address}`);

  onProgress?.('quote');
  const quoteStartedAt = Date.now();
  console.log(`[SELL_HELPER] Computing minAmountOut for venue=${venue}, token=${position.token_address}, qty=${sellQty}, slippage=${slippagePct}%`);

  let bestVenue = venue;
  let minAmountOut = '0';
  let bestDclPoolId = effectiveDclPoolId;
  let bestRheaPoolId = effectiveRheaPoolId;

  // Best execution check: if both a Rhea pool and a launchpad pool (DCL or launchpad AMM) exist,
  // compare quotes in parallel to guarantee the user gets the maximum possible NEAR output!
  if (venue !== 'intear' && effectiveRheaPoolId && (venue !== 'rhea' || effectiveDclPoolId)) {
    const launchpadVenue = venue !== 'rhea'
      ? venue
      : (position.token_address.endsWith('.nearlytrade.near')
          ? 'nearlytrade'
          : (position.token_address.endsWith('.nearpumpfun.near')
              ? 'nearpumpfun'
              : (position.token_address.endsWith('.launch.shoremarkets.near') ? 'shoremarkets' : undefined)));
    if (launchpadVenue) {
      try {
        const [rheaRes, launchpadRes] = await Promise.allSettled([
          near.computeMinAmountOut('rhea', position.token_address, 'wrap.near', sellQty, slippagePct, effectiveRheaPoolId, undefined),
          near.computeMinAmountOut(launchpadVenue, position.token_address, 'wrap.near', sellQty, slippagePct, undefined, effectiveDclPoolId),
        ]);

        const rheaOut = rheaRes.status === 'fulfilled' ? BigInt(rheaRes.value.minAmountOut) : 0n;
        const launchpadOut = launchpadRes.status === 'fulfilled' ? BigInt(launchpadRes.value.minAmountOut) : 0n;

        if (rheaOut > launchpadOut && rheaOut > 0n) {
          console.log(`[SELL_HELPER] Best execution: Rhea gives ${rheaOut} yoctoNEAR vs ${launchpadVenue} ${launchpadOut} yoctoNEAR. Routing sell to Rhea.`);
          bestVenue = 'rhea';
          minAmountOut = (rheaRes as PromiseFulfilledResult<any>).value.minAmountOut;
          bestDclPoolId = undefined;
        } else if (launchpadOut > 0n) {
          console.log(`[SELL_HELPER] Best execution: ${launchpadVenue} gives ${launchpadOut} yoctoNEAR vs Rhea ${rheaOut} yoctoNEAR. Routing sell to ${launchpadVenue}.`);
          bestVenue = launchpadVenue as any;
          minAmountOut = (launchpadRes as PromiseFulfilledResult<any>).value.minAmountOut;
          bestRheaPoolId = undefined;
        }
      } catch (err: any) {
        console.warn('[SELL_HELPER] Best execution quote comparison error (falling back):', err?.message);
      }
    }
  }

  if (minAmountOut === '0') {
    const quote = await near.computeMinAmountOut(
      bestVenue,
      position.token_address,
      'wrap.near',
      sellQty,
      slippagePct,
      bestRheaPoolId,
      bestDclPoolId
    );
    minAmountOut = quote.minAmountOut;
  }
  // This timestamp must be taken after the live quote completes. Starting the
  // freshness window before an RPC call can make an already-old quote look
  // "fresh" to the executor and skip its final pre-broadcast re-quote.
  const quoteCompletedAt = Date.now();
  console.log(`[SELL_HELPER] Quote obtained: venue=${bestVenue}, minAmountOut=${minAmountOut} in ${Date.now() - quoteStartedAt}ms. Calling publishSwap...`);

  const swapEvent = {
    type: 'execute_swap' as const,
    user_id: userId,
    token_in: position.token_address,
    token_out: 'wrap.near',
    amount_in: sellQty,
    min_amount_out: minAmountOut,
    venue: bestVenue,
    timestamp: Date.now(),
    dcl_pool_id: bestDclPoolId,
    pool_id: bestRheaPoolId,
    slippage_pct: slippagePct,
    quoted_at: quoteCompletedAt, // executor skips its second quote while < 2s old
    trade_currency: user?.near_trade_currency,
  };

  const swapResult = await publishSwap(swapEvent, onProgress, options);
  console.log(`[SELL_HELPER] publishSwap result: success=${swapResult.success}, reason=${swapResult.reason || 'ok'}, tx=${swapResult.txHash}`);
  if (swapResult.success === false) {
    // Pass the executor's distilled on-chain reason through so users learn
    // WHY the sell failed (slippage / no pool / contract error), not a generic message.
    return { success: false, reason: swapResult.reason || 'Swap failed on-chain. Please verify liquidity and retry.' };
  }

  if (fullExit) {
    await updatePosition({
      position_id: positionId,
      status: 'closed',
      closed_at: new Date(),
      quantity_held: '0',
    }).catch(() => {});
  }

  return { success: true, usdcReceived: swapResult.usdcReceived, nearReceived: swapResult.nearReceived };
}
