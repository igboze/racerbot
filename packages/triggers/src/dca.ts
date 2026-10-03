import 'dotenv/config';
import {
  createRedis,
  CHANNELS,
  createLogger,
  getNear,
  isTradableVenue,
  type SwapEvent,
} from '@racerbot/shared';
import {
  getDb,
  getDueDcaOrders,
  advanceDcaOrder,
  failDcaOrderTick,
  updateDcaOrderStatus,
  getTokenCache,
  getUserById,
  type DcaOrderRecord,
} from '@racerbot/db';

const logger = createLogger('dca');
const REDIS_URL = process.env.REDIS_URL!;
const redis = createRedis(REDIS_URL);

// ── DCA Execution Engine ─────────────────────────────────────────────────────

/**
 * Process one DCA order tick:
 *  1. Validate token is tradeable & price guard
 *  2. Validate user has sufficient balance
 *  3. Publish a SwapEvent to the executor via Redis
 *  4. Advance the DB record (next_run_at, executed_orders)
 *  5. Notify user via NOTIFY_USER channel
 */
async function executeDcaOrder(order: DcaOrderRecord): Promise<void> {
  const near = getNear();
  const db = await getDb();

  // -- Fetch token cache (venue, pool ids, price) --
  const tokenCache = await getTokenCache(order.token_address).catch(() => null);
  if (!tokenCache) {
    await failDcaOrderTick(order.id, 'Token not found in cache');
    return;
  }

  const venueRaw = tokenCache.venue as string | undefined;
  if (!isTradableVenue(venueRaw)) {
    await failDcaOrderTick(order.id, `Non-tradeable venue: ${venueRaw ?? 'unknown'}`);
    return;
  }
  const venue = venueRaw!;

  // -- Price guard (optional) --
  if (order.min_price !== null || order.max_price !== null) {
    const spot = await near.getVenueSpotPrice(venue, order.token_address, tokenCache.decimals ?? 18).catch(() => null);
    if (spot) {
      if (order.max_price !== null && order.side === 'buy' && spot.price > order.max_price) {
        logger.info('DCA buy skipped: price above max_price guard', {
          orderId: order.id, price: spot.price, maxPrice: order.max_price,
        });
        // Advance timer without counting as an executed order
        await failDcaOrderTick(order.id, `Price guard: ${spot.price.toFixed(8)} > max ${order.max_price}`);
        return;
      }
      if (order.min_price !== null && order.side === 'sell' && spot.price < order.min_price) {
        logger.info('DCA sell skipped: price below min_price guard', {
          orderId: order.id, price: spot.price, minPrice: order.min_price,
        });
        await failDcaOrderTick(order.id, `Price guard: ${spot.price.toFixed(8)} < min ${order.min_price}`);
        return;
      }
    }
  }

  // -- Fetch user & slippage preference --
  const user = await getUserById(order.user_id).catch(() => null);
  if (!user) {
    logger.error('DCA order references unknown user', new Error('user not found'), { orderId: order.id });
    await updateDcaOrderStatus(order.id, 'cancelled');
    return;
  }
  const slippagePct = user.slippage_pct ? Number(user.slippage_pct) : 2.0;

  let swapEvent: any;

  if (tokenCache.chain === 'sui' || venue === 'suipump' || order.token_address.includes('::')) {
    if (order.side === 'buy') {
      const amountInMist = BigInt(Math.floor(order.amount_per_order * 1e9)).toString();
      swapEvent = {
        type: 'execute_swap',
        chain: 'sui',
        user_id: order.user_id,
        token_in: 'sui',
        token_out: order.token_address,
        amount_in: amountInMist,
        min_amount_out: '1',
        venue: 'suipump',
        slippage_pct: slippagePct,
        timestamp: Date.now(),
        notify_user: false,
      };
    } else {
      const amountInRaw = BigInt(Math.floor(order.amount_per_order)).toString();
      swapEvent = {
        type: 'execute_swap',
        chain: 'sui',
        user_id: order.user_id,
        token_in: order.token_address,
        token_out: 'sui',
        amount_in: amountInRaw,
        min_amount_out: '1',
        venue: 'suipump',
        slippage_pct: slippagePct,
        timestamp: Date.now(),
        notify_user: false,
      };
    }
  } else if (order.side === 'buy') {
    // NEAR (wrap.near) → token
    const amountInYocto = BigInt(Math.floor(order.amount_per_order * 1e24)).toString();
    const { minAmountOut } = await near.computeMinAmountOut(
      venue as any,
      'wrap.near',
      order.token_address,
      amountInYocto,
      slippagePct,
      tokenCache.rhea_pool_id ?? undefined,
      tokenCache.dcl_pool_id ?? undefined
    );

    swapEvent = {
      type: 'execute_swap',
      user_id: order.user_id,
      token_in: 'wrap.near',
      token_out: order.token_address,
      amount_in: amountInYocto,
      min_amount_out: minAmountOut,
      venue,
      timestamp: Date.now(),
      notify_user: false, // we send our own DCA notification below
      ...(tokenCache.dcl_pool_id ? { dcl_pool_id: tokenCache.dcl_pool_id } : {}),
      ...(tokenCache.rhea_pool_id != null ? { pool_id: tokenCache.rhea_pool_id } : {}),
    } as SwapEvent;
  } else {
    // Token → NEAR (wrap.near)
    // For sell-DCA: amount_per_order is the raw token amount in smallest unit
    const amountInRaw = BigInt(Math.floor(order.amount_per_order)).toString();
    const { minAmountOut } = await near.computeMinAmountOut(
      venue as any,
      order.token_address,
      'wrap.near',
      amountInRaw,
      slippagePct,
      tokenCache.rhea_pool_id ?? undefined,
      tokenCache.dcl_pool_id ?? undefined
    );

    swapEvent = {
      type: 'execute_swap',
      user_id: order.user_id,
      token_in: order.token_address,
      token_out: 'wrap.near',
      amount_in: amountInRaw,
      min_amount_out: minAmountOut,
      venue,
      timestamp: Date.now(),
      notify_user: false,
      ...(tokenCache.dcl_pool_id ? { dcl_pool_id: tokenCache.dcl_pool_id } : {}),
      ...(tokenCache.rhea_pool_id != null ? { pool_id: tokenCache.rhea_pool_id } : {}),
    } as SwapEvent;
  }

  // -- Publish swap to executor --
  await redis.publish(CHANNELS.EXECUTE_SWAP, JSON.stringify(swapEvent));

  // -- Advance DCA order in DB (increments executed_orders, computes next_run_at, auto-completes) --
  const updated = await advanceDcaOrder(order.id);

  // -- Notify user --
  const tokenSymbol = tokenCache.symbol || order.token_address.slice(0, 12);
  const totalOrdersDisplay = order.total_orders === 0 ? '∞' : order.total_orders.toString();
  const progressBar = buildProgressBar(updated.executed_orders, order.total_orders);
  const sideLabel = order.side === 'buy' ? 'Accumulating 🟢' : 'De-Risking 🔴';
  const amountLabel = order.side === 'buy'
    ? `${order.amount_per_order.toFixed(2)} NEAR`
    : `${formatTokenAmount(order.amount_per_order, tokenCache.decimals ?? 18)} ${tokenSymbol}`;

  let notifyMsg =
    `🔁 *DCA Order Filled (${updated.executed_orders}/${totalOrdersDisplay})*\n\n` +
    `🪙 *Token*: ${tokenSymbol}\n` +
    `📊 *Mode*: ${sideLabel}\n` +
    `💵 *Amount*: ${amountLabel}\n`;

  if (updated.status === 'completed') {
    notifyMsg += `\n✅ *All orders complete!*\n`;
  } else {
    const nextRun = new Date(updated.next_run_at);
    const secsUntilNext = Math.max(0, Math.round((nextRun.getTime() - Date.now()) / 1000));
    notifyMsg += `⏳ *Next order*: in ${formatDuration(secsUntilNext)}\n`;
  }

  notifyMsg += `\n${progressBar}`;

  await redis.publish(CHANNELS.NOTIFY_USER, JSON.stringify({
    type: 'notify_user',
    telegram_id: 0,
    event: 'dca_fill',
    data: {
      user_id: order.user_id,
      dca_order_id: order.id,
      token_address: order.token_address,
      token_symbol: tokenSymbol,
      side: order.side,
      executed_orders: updated.executed_orders,
      total_orders: order.total_orders,
      status: updated.status,
      message: notifyMsg,
    },
  }));

  logger.info('DCA tick executed', {
    orderId: order.id, side: order.side, token: order.token_address,
    executedOrders: updated.executed_orders, status: updated.status,
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildProgressBar(done: number, total: number, length = 10): string {
  if (total === 0) return `[${done} executed (unlimited)]`;
  const pct = Math.min(done / total, 1);
  const filled = Math.round(pct * length);
  return '[' + '■'.repeat(filled) + '□'.repeat(length - filled) + `] ${done}/${total}`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

function formatTokenAmount(raw: number, decimals: number): string {
  const val = raw / Math.pow(10, decimals);
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(2)}M`;
  if (val >= 1_000) return val.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (val >= 1) return val.toFixed(2);
  return val.toExponential(2);
}

// ── Main loop ─────────────────────────────────────────────────────────────────

const DCA_POLL_INTERVAL_MS = parseInt(process.env.DCA_POLL_INTERVAL_MS || '15000'); // 15s default

export async function runDcaEngine(): Promise<void> {
  logger.info('DCA engine started', { pollIntervalMs: DCA_POLL_INTERVAL_MS });

  // Self-rescheduling loop — never overlaps
  const run = async () => {
    try {
      const dueOrders = await getDueDcaOrders();
      if (dueOrders.length > 0) {
        logger.info(`Processing ${dueOrders.length} due DCA orders`);
        // Bounded concurrency of 4 simultaneous ticks
        const CONCURRENCY = 4;
        for (let i = 0; i < dueOrders.length; i += CONCURRENCY) {
          await Promise.all(
            dueOrders.slice(i, i + CONCURRENCY).map(order =>
              executeDcaOrder(order).catch(err => {
                logger.error('DCA tick error', err as Error, { orderId: order.id });
                return failDcaOrderTick(order.id, (err as Error).message).catch(() => {});
              })
            )
          );
        }
      }
    } catch (err) {
      logger.error('DCA engine loop error', err as Error);
    }
    setTimeout(run, DCA_POLL_INTERVAL_MS);
  };

  setTimeout(run, DCA_POLL_INTERVAL_MS);
}
