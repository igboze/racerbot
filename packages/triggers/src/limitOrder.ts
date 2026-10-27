import 'dotenv/config';
import {
  createRedis,
  CHANNELS,
  createLogger,
  getNear,
  isTradableVenue,
  isSolanaToken,
  getSolanaTokenInfo,
  getSolanaPricesUsd,
  getSolUsdPrice,
  getSolanaBalanceFreeOnly,
  getSolanaTokenBalance,
  lamportsToSol,
  solToLamports,
  solanaUiToRaw,
  SOL_MINT,
  SOLANA_MIN_RESERVE_LAMPORTS,
  type SwapEvent,
} from '@racerbot/shared';
import {
  getDb,
  getActiveLimitOrders,
  lockLimitOrderForExecution,
  markLimitOrderFilled,
  markLimitOrderFailed,
  expirePastDueLimitOrders,
  getTokenCache,
  getUserById,
  getActiveRaceFleetOrders,
  updateRaceFleetOrderStatus,
  getRaceFleetById,
  getRaceFleetWallets,
  type LimitOrderRecord,
  type RaceFleetOrderRecord,
} from '@racerbot/db';
import { localPriceCache, refreshTokenPrice } from './trigger.js';
import { refreshSolanaMarkets, getSolanaMarket } from './solanaMarket.js';

const logger = createLogger('limit_orders');
const REDIS_URL = process.env.REDIS_URL!;
const redis = createRedis(REDIS_URL);

const POLL_INTERVAL_MS = 4000;
const PRICE_STALENESS_MS = 60_000;

export async function runLimitOrderEngine(): Promise<void> {
  logger.info('Starting limit order engine...', { pollInterval: POLL_INTERVAL_MS });

  let stopped = false;
  const shutdown = async () => {
    stopped = true;
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  while (!stopped) {
    const start = Date.now();
    try {
      // 1. Auto-expire orders whose expiry date has passed
      await expirePastDueLimitOrders().catch((err) => {
        logger.warn('Failed to expire past due limit orders', err);
      });

      // 2. Fetch all active limit orders
      const activeOrders = await getActiveLimitOrders();
      const fleetOrdersPrefetch = await getActiveRaceFleetOrders().catch(() => []);
      await refreshSolanaMarkets([
        ...activeOrders.map((o) => o.token_address),
        ...fleetOrdersPrefetch.map((o) => o.token_address),
      ]).catch((err) => logger.warn('Solana market refresh failed', { error: err?.message }));

      if (activeOrders.length > 0) {
        // Evaluate active orders
        for (const order of activeOrders) {
          try {
            await evaluateLimitOrder(order);
          } catch (err: any) {
            logger.error(`Error evaluating limit order ${order.id}:`, err);
          }
        }
      }

      // 3. Evaluate active RaceFleet orders
      const fleetOrders = fleetOrdersPrefetch;
      for (const fOrder of fleetOrders) {
        try {
          await evaluateFleetOrder(fOrder);
        } catch (err: any) {
          logger.error(`Error evaluating fleet order ${fOrder.id}:`, err);
        }
      }
    } catch (loopErr: any) {
      logger.error('Limit order loop error:', loopErr);
    }

    const elapsed = Date.now() - start;
    const remaining = Math.max(500, POLL_INTERVAL_MS - elapsed);
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
}

/** Price (native per token) and market cap for an order's token. Solana mcap is USD. */
async function getOrderMarket(tokenAddress: string): Promise<{ price: number; mcap: number } | null> {
  if (isSolanaToken(tokenAddress)) {
    let m = getSolanaMarket(tokenAddress);
    if (!m) {
      await refreshSolanaMarkets([tokenAddress], true).catch(() => {});
      m = getSolanaMarket(tokenAddress);
    }
    return m && m.priceSol > 0 ? { price: m.priceSol, mcap: m.mcapUsd } : null;
  }
  let cached = localPriceCache.get(tokenAddress);
  if (!cached || Date.now() - cached.ts > PRICE_STALENESS_MS) {
    await refreshTokenPrice(tokenAddress);
    cached = localPriceCache.get(tokenAddress);
  }
  if (!cached || !cached.price || cached.price <= 0) return null;
  return { price: cached.price, mcap: cached.marketCap || 0 };
}

export async function evaluateLimitOrder(order: LimitOrderRecord): Promise<void> {
  const market = await getOrderMarket(order.token_address);
  if (!market) {
    return; // Cannot evaluate without price
  }

  const currentPrice = market.price;
  const currentMcap = market.mcap;
  const target = Number(order.target_value);

  let isTriggered = false;

  if (order.target_type === 'mcap') {
    if (order.trigger_condition === 'lte') {
      isTriggered = currentMcap > 0 && currentMcap <= target;
    } else {
      isTriggered = currentMcap >= target;
    }
  } else if (order.target_type === 'percent_offset') {
    // Percentage offset from reference price (e.g. +50 for +50% TP, -20 for -20% SL)
    const refPrice = order.reference_price ? Number(order.reference_price) : 0;
    if (refPrice > 0) {
      const targetPrice = refPrice * (1 + target / 100);
      if (order.trigger_condition === 'lte') {
        isTriggered = currentPrice <= targetPrice;
      } else {
        isTriggered = currentPrice >= targetPrice;
      }
    } else {
      // Fallback if reference_price was not stored: compare target directly
      if (order.trigger_condition === 'lte') {
        isTriggered = currentPrice <= target;
      } else {
        isTriggered = currentPrice >= target;
      }
    }
  } else {
    // Price-based
    if (order.trigger_condition === 'lte') {
      isTriggered = currentPrice <= target;
    } else {
      isTriggered = currentPrice >= target;
    }
  }

  if (!isTriggered) return;

  // Atomic lock to ensure exactly-once execution across multi-instance
  const lockedOrder = await lockLimitOrderForExecution(order.id);
  if (!lockedOrder) {
    return; // Already being executed or cancelled
  }

  logger.info(`🎯 Limit order triggered! [${order.side.toUpperCase()}] ${order.token_address}`, {
    orderId: order.id,
    currentPrice,
    currentMcap,
    targetValue: target,
    condition: order.trigger_condition,
  });

  await executeLimitOrder(lockedOrder, currentPrice, currentMcap);
}

/** Sends a limit-order notification (fill or failure) to the user. */
async function notifyLimit(user: { id: string; telegram_id: number }, event: 'limit_order_fill' | 'limit_order_failed', data: Record<string, unknown>): Promise<void> {
  await redis.publish(CHANNELS.NOTIFY_USER, JSON.stringify({
    type: 'notify_user',
    telegram_id: user.telegram_id,
    event,
    data: { user_id: user.id, ...data },
  }));
}

/**
 * Solana limit order execution. amount_input is SOL for both sides (buy: SOL
 * to spend; sell: SOL worth of tokens to sell, capped at the balance), or
 * sell_pct of holdings when set.
 */
async function executeSolanaLimitOrder(order: LimitOrderRecord, user: any, currentPrice: number, currentMcap: number): Promise<void> {
  const owner: string | null = user.solana_address || null;
  const info = await getSolanaTokenInfo(order.token_address).catch(() => null);
  const symbol = info?.symbol || order.token_address.slice(0, 8);
  if (!owner) {
    await markLimitOrderFailed(order.id, 'Solana wallet not set up');
    await notifyLimit(user, 'limit_order_failed', { order_id: order.id, symbol, side: order.side, reason: 'Solana wallet not set up. Send /start.' });
    return;
  }
  const slippagePct = Math.max(
    Number(order.max_slippage_pct) || 3,
    info?.bondingPhase === 'prebonded' ? 5 : 2,
    order.side === 'sell' && order.trigger_condition === 'lte' ? 10 : 0,
  );

  let amountIn: bigint;
  if (order.side === 'buy') {
    amountIn = solToLamports(Number(order.amount_input));
    const bal = await getSolanaBalanceFreeOnly(owner);
    if (bal !== null && bal < amountIn + SOLANA_MIN_RESERVE_LAMPORTS) {
      const reason = `Insufficient balance: needed ${(Number(order.amount_input) + 0.005).toFixed(3)} SOL, had ${lamportsToSol(bal).toFixed(3)} SOL`;
      await markLimitOrderFailed(order.id, reason);
      await notifyLimit(user, 'limit_order_failed', { order_id: order.id, symbol, side: 'buy', reason });
      return;
    }
  } else {
    const bal = await getSolanaTokenBalance(owner, order.token_address, true).catch(() => null);
    const raw = bal?.raw ?? 0n;
    if (raw <= 0n) {
      const reason = `No ${symbol} balance in wallet to sell`;
      await markLimitOrderFailed(order.id, reason);
      await notifyLimit(user, 'limit_order_failed', { order_id: order.id, symbol, side: 'sell', reason });
      return;
    }
    amountIn = raw;
    if (order.sell_pct && order.sell_pct > 0 && order.sell_pct < 100) {
      amountIn = (raw * BigInt(Math.round(order.sell_pct * 100))) / 10000n;
    } else if (!order.sell_pct && order.amount_input > 0 && currentPrice > 0) {
      const decimals = info?.decimals ?? bal?.decimals ?? 6;
      const wanted = solanaUiToRaw(Number(order.amount_input) / currentPrice, decimals);
      if (wanted > 0n && wanted < raw) amountIn = wanted;
    }
    if (amountIn <= 0n) {
      await markLimitOrderFailed(order.id, 'Sell quantity computed to 0');
      return;
    }
  }

  const swapEvent: SwapEvent = {
    type: 'execute_swap',
    chain: 'solana',
    user_id: order.user_id,
    token_in: order.side === 'buy' ? SOL_MINT : order.token_address,
    token_out: order.side === 'buy' ? order.token_address : SOL_MINT,
    amount_in: amountIn.toString(),
    min_amount_out: '1',
    venue: 'jupiter',
    slippage_pct: slippagePct,
    timestamp: Date.now(),
    notify_user: true,
  } as SwapEvent;

  await redis.publish(CHANNELS.EXECUTE_SWAP, JSON.stringify(swapEvent));
  await markLimitOrderFilled(order.id, 'submitted', currentPrice);
  await notifyLimit(user, 'limit_order_fill', {
    order_id: order.id,
    symbol,
    side: order.side,
    ...(order.side === 'buy' ? { amount_input: order.amount_input } : { sell_pct: order.sell_pct }),
    current_price: currentPrice,
    current_mcap: currentMcap,
    unit: 'SOL',
  });
}

export async function executeLimitOrder(order: LimitOrderRecord, currentPrice: number, currentMcap: number): Promise<void> {
  if (isSolanaToken(order.token_address)) {
    const solUser = await getUserById(order.user_id).catch(() => null);
    if (!solUser) {
      await markLimitOrderFailed(order.id, 'User account not found');
      return;
    }
    await executeSolanaLimitOrder(order, solUser, currentPrice, currentMcap);
    return;
  }
  const near = getNear();

  const user = await getUserById(order.user_id).catch(() => null);
  if (!user) {
    await markLimitOrderFailed(order.id, 'User account not found');
    return;
  }

  const tokenCache = await getTokenCache(order.token_address).catch(() => null);
  if (!tokenCache) {
    await markLimitOrderFailed(order.id, 'Token not found in cache');
    return;
  }

  const venueRaw = tokenCache.venue as string | undefined;
  if (!isTradableVenue(venueRaw)) {
    await markLimitOrderFailed(order.id, `Non-tradable venue: ${venueRaw ?? 'unknown'}`);
    return;
  }
  const venue = venueRaw || 'ref';
  const userSlip = user.slippage_pct ? Number(user.slippage_pct) : 0;
  const defaultSlip = order.side === 'sell' && order.trigger_condition === 'lte' ? 5.0 : 3.0;
  const slippagePct = order.max_slippage_pct || (userSlip > 0 ? userSlip : defaultSlip);
  const symbol = tokenCache.symbol || order.token_address.slice(0, 10);

  // Soft balance check before dispatching
  if (order.side === 'buy') {
    // Check NEAR balance in user's subaccount
    try {
      const balanceYocto = await near.getNearBalance(user.subaccount_id);
      const balanceNear = Number(BigInt(balanceYocto || '0') / 10n ** 20n) / 10_000;
      const requiredNear = order.amount_input + 0.05; // 0.05 NEAR buffer for gas/storage

      if (balanceNear < requiredNear) {
        const reason = `Insufficient balance: needed ${requiredNear.toFixed(2)} NEAR, had ${balanceNear.toFixed(2)} NEAR`;
        logger.warn(`Limit buy failed for user ${user.id}: ${reason}`);
        await markLimitOrderFailed(order.id, reason);

        // Notify user of low balance
        await redis.publish(CHANNELS.NOTIFY_USER, JSON.stringify({
          type: 'notify_user',
          telegram_id: user.telegram_id,
          event: 'limit_order_failed',
          data: {
            user_id: user.id,
            order_id: order.id,
            symbol,
            side: 'buy',
            reason,
          },
        }));
        return;
      }
    } catch (err: any) {
      logger.warn(`Could not verify balance for ${user.subaccount_id}:`, err?.message);
    }

    // Build Buy SwapEvent (wrap.near -> token)
    const amountInYocto = BigInt(Math.floor(order.amount_input * 1e24)).toString();
    const { minAmountOut } = await near.computeMinAmountOut(
      venue as any,
      'wrap.near',
      order.token_address,
      amountInYocto,
      slippagePct,
      tokenCache.rhea_pool_id ?? undefined,
      tokenCache.dcl_pool_id ?? undefined
    );

    const swapEvent: SwapEvent = {
      type: 'execute_swap',
      user_id: order.user_id,
      token_in: 'wrap.near',
      token_out: order.token_address,
      amount_in: amountInYocto,
      min_amount_out: minAmountOut,
      venue,
      timestamp: Date.now(),
      notify_user: true,
      ...(tokenCache.dcl_pool_id ? { dcl_pool_id: tokenCache.dcl_pool_id } : {}),
      ...(tokenCache.rhea_pool_id != null ? { pool_id: tokenCache.rhea_pool_id } : {}),
    } as SwapEvent;

    // Dispatch to executor
    await redis.publish(CHANNELS.EXECUTE_SWAP, JSON.stringify(swapEvent));
    await markLimitOrderFilled(order.id, 'submitted', currentPrice);

    // Notify user of triggered fill
    await redis.publish(CHANNELS.NOTIFY_USER, JSON.stringify({
      type: 'notify_user',
      telegram_id: user.telegram_id,
      event: 'limit_order_fill',
      data: {
        user_id: user.id,
        order_id: order.id,
        symbol,
        side: 'buy',
        amount_input: order.amount_input,
        current_price: currentPrice,
        current_mcap: currentMcap,
      },
    }));

  } else {
    // Sell side: Check token balance
    let userTokenBal = '0';
    try {
      userTokenBal = await near.getTokenBalance(order.token_address, user.subaccount_id);
    } catch (err: any) {
      logger.warn(`Could not verify token balance for ${user.subaccount_id}:`, err?.message);
    }

    const rawBalBigInt = BigInt(userTokenBal || '0');
    if (rawBalBigInt <= 0n) {
      const reason = `No ${symbol} balance in wallet to sell`;
      logger.warn(`Limit sell failed for user ${user.id}: ${reason}`);
      await markLimitOrderFailed(order.id, reason);

      await redis.publish(CHANNELS.NOTIFY_USER, JSON.stringify({
        type: 'notify_user',
        telegram_id: user.telegram_id,
        event: 'limit_order_failed',
        data: {
          user_id: user.id,
          order_id: order.id,
          symbol,
          side: 'sell',
          reason,
        },
      }));
      return;
    }

    // Determine sell quantity: percentage of holdings or NEAR worth
    let sellQtyRaw = rawBalBigInt;
    if (order.sell_pct && order.sell_pct > 0 && order.sell_pct <= 100) {
      sellQtyRaw = (rawBalBigInt * BigInt(Math.floor(order.sell_pct))) / 100n;
    } else if (order.amount_input > 0) {
      // order.amount_input represents the target value in NEAR to sell
      // Convert NEAR amount to token quantity: tokens = amount_near / currentPrice
      const tokenDecimals = tokenCache.decimals ?? 18;
      if (currentPrice > 0) {
        const tokensToSell = order.amount_input / currentPrice;
        const factor = 10 ** Math.min(tokenDecimals, 12);
        const tokensScaled = BigInt(Math.floor(tokensToSell * factor));
        const remainingDecimals = tokenDecimals - Math.min(tokenDecimals, 12);
        const calculatedRaw = tokensScaled * (10n ** BigInt(remainingDecimals));

        if (calculatedRaw > 0n && calculatedRaw < rawBalBigInt) {
          sellQtyRaw = calculatedRaw;
        } else {
          sellQtyRaw = rawBalBigInt;
        }
      } else {
        sellQtyRaw = rawBalBigInt;
      }
    }

    if (sellQtyRaw <= 0n) {
      await markLimitOrderFailed(order.id, 'Sell quantity computed to 0');
      return;
    }

    // Build Sell SwapEvent (token -> wrap.near)
    const { minAmountOut } = await near.computeMinAmountOut(
      venue as any,
      order.token_address,
      'wrap.near',
      sellQtyRaw.toString(),
      slippagePct,
      tokenCache.rhea_pool_id ?? undefined,
      tokenCache.dcl_pool_id ?? undefined
    );

    const swapEvent: SwapEvent = {
      type: 'execute_swap',
      user_id: order.user_id,
      token_in: order.token_address,
      token_out: 'wrap.near',
      amount_in: sellQtyRaw.toString(),
      min_amount_out: minAmountOut,
      venue,
      timestamp: Date.now(),
      notify_user: true,
      ...(tokenCache.dcl_pool_id ? { dcl_pool_id: tokenCache.dcl_pool_id } : {}),
      ...(tokenCache.rhea_pool_id != null ? { pool_id: tokenCache.rhea_pool_id } : {}),
    } as SwapEvent;

    // Dispatch to executor
    await redis.publish(CHANNELS.EXECUTE_SWAP, JSON.stringify(swapEvent));
    await markLimitOrderFilled(order.id, 'submitted', currentPrice);

    // Notify user
    await redis.publish(CHANNELS.NOTIFY_USER, JSON.stringify({
      type: 'notify_user',
      telegram_id: user.telegram_id,
      event: 'limit_order_fill',
      data: {
        user_id: user.id,
        order_id: order.id,
        symbol,
        side: 'sell',
        sell_pct: order.sell_pct,
        current_price: currentPrice,
        current_mcap: currentMcap,
      },
    }));
  }
}

async function evaluateFleetOrder(order: RaceFleetOrderRecord): Promise<void> {
  const market = await getOrderMarket(order.token_address);
  if (!market) {
    return;
  }

  const currentPrice = market.price;
  const currentMcap = market.mcap;
  let isTriggered = false;
  let triggerReason = '';

  if (order.order_type === 'limit_buy') {
    const target = order.target_value ?? 0;
    if (order.target_type === 'mcap') {
      isTriggered = order.trigger_condition === 'lte' ? currentMcap <= target : currentMcap >= target;
    } else {
      isTriggered = order.trigger_condition === 'lte' ? currentPrice <= target : currentPrice >= target;
    }
    triggerReason = `Target ${order.target_type === 'mcap' ? 'Market Cap' : 'Price'} reached`;
  } else if (order.order_type === 'limit_sell') {
    const target = order.target_value ?? 0;
    if (order.target_type === 'mcap') {
      isTriggered = order.trigger_condition === 'gte' ? currentMcap >= target : currentMcap <= target;
    } else {
      isTriggered = order.trigger_condition === 'gte' ? currentPrice >= target : currentPrice <= target;
    }
    triggerReason = `Target ${order.target_type === 'mcap' ? 'Market Cap' : 'Price'} reached`;
  } else if (order.order_type === 'tp_sl') {
    // TP / SL monitoring
    const tp = order.tp_percent ?? 50.0;
    const sl = order.sl_percent ?? 15.0;
    // Check if target condition crossed
    if (order.target_value && order.target_value > 0) {
      const pnlPct = ((currentPrice - order.target_value) / order.target_value) * 100;
      if (pnlPct >= tp) {
        isTriggered = true;
        triggerReason = `🎯 Take Profit triggered (+${pnlPct.toFixed(1)}%)`;
      } else if (pnlPct <= -sl) {
        isTriggered = true;
        triggerReason = `🔴 Stop Loss triggered (${pnlPct.toFixed(1)}%)`;
      }
    }
  }

  if (!isTriggered) return;

  // Mark order executing to prevent duplicate triggers
  await updateRaceFleetOrderStatus(order.id, 'executing');

  const user = await getUserById(order.user_id).catch(() => null);
  const fleet = await getRaceFleetById(order.fleet_id).catch(() => null);
  if (!user || !fleet) return;

  logger.info(`🏎️ RaceFleet Order Triggered: ${order.order_type} for token ${order.token_address}`, {
    orderId: order.id,
    currentPrice,
    currentMcap,
    reason: triggerReason,
  });

  // Notify user via Telegram
  await redis.publish(CHANNELS.NOTIFY_USER, JSON.stringify({
    type: 'notify_user',
    telegram_id: user.telegram_id,
    event: 'fleet_order_triggered',
    data: {
      order_id: order.id,
      fleet_id: order.fleet_id,
      fleet_tag: fleet.fleet_tag,
      token_address: order.token_address,
      order_type: order.order_type,
      amount_per_wallet: order.amount_per_wallet,
      sell_pct: order.sell_pct,
      reason: triggerReason,
      current_price: currentPrice,
      current_mcap: currentMcap,
    },
  }));

  // Mark filled with summary
  await updateRaceFleetOrderStatus(order.id, 'filled', undefined, {
    filledAt: new Date().toISOString(),
    fillPrice: currentPrice,
    fillMcap: currentMcap,
    reason: triggerReason,
  });
}

