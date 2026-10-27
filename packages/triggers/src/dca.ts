import 'dotenv/config';
import {
  createRedis,
  CHANNELS,
  createLogger,
  getNear,
  isTradableVenue,
  getSuiPumpCurveState,
  getSuiRouterQuote,
  isSolanaToken,
  getSolanaTokenInfo,
  getSolanaBalanceFreeOnly,
  getSolanaTokenBalance,
  solanaUiToRaw,
  solToLamports,
  lamportsToSol,
  SOL_MINT,
  SOLANA_MIN_RESERVE_LAMPORTS,
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
/**
 * Solana DCA tick. Amounts are human units: buys in SOL, sells in whole
 * tokens (converted to raw base units here with the mint's decimals).
 * Price guards compare against the price in SOL per token.
 */
async function executeSolanaDcaOrder(order: DcaOrderRecord): Promise<void> {
  const info = await getSolanaTokenInfo(order.token_address).catch(() => null);
  if (!info) {
    await failDcaOrderTick(order.id, 'Token not found on Solana');
    return;
  }

  if ((order.min_price !== null || order.max_price !== null) && info.priceSol > 0) {
    const spot = info.priceSol;
    if (order.max_price !== null && order.side === 'buy' && spot > order.max_price) {
      await failDcaOrderTick(order.id, `Price guard: ${spot.toExponential(4)} SOL > max ${order.max_price}`);
      return;
    }
    if (order.min_price !== null && order.side === 'sell' && spot < order.min_price) {
      await failDcaOrderTick(order.id, `Price guard: ${spot.toExponential(4)} SOL < min ${order.min_price}`);
      return;
    }
  }

  const user = await getUserById(order.user_id).catch(() => null);
  if (!user) {
    await updateDcaOrderStatus(order.id, 'cancelled');
    return;
  }
  const owner = user.solana_address;
  if (!owner) {
    await failDcaOrderTick(order.id, 'Solana wallet not set up. Send /start.');
    return;
  }
  const userSlip = user.slippage_pct ? Number(user.slippage_pct) : 2.0;
  const slippagePct = Math.max(userSlip, info.bondingPhase === 'prebonded' ? 5 : 2);

  let amountIn: bigint;
  let amountLabel: string;
  if (order.side === 'buy') {
    amountIn = solToLamports(Number(order.amount_per_order));
    if (amountIn <= 0n) {
      await failDcaOrderTick(order.id, 'Invalid SOL amount');
      return;
    }
    // Cheap pre-check (free RPC only) so we do not announce a fill that cannot happen.
    const bal = await getSolanaBalanceFreeOnly(owner);
    if (bal !== null && bal < amountIn + SOLANA_MIN_RESERVE_LAMPORTS) {
      await failDcaOrderTick(order.id, `Insufficient SOL (${lamportsToSol(bal).toFixed(4)} SOL)`);
      return;
    }
    amountLabel = `${Number(order.amount_per_order).toFixed(3)} SOL`;
  } else {
    const wanted = solanaUiToRaw(Number(order.amount_per_order), info.decimals);
    const bal = await getSolanaTokenBalance(owner, order.token_address, true).catch(() => null);
    if (bal && bal.raw <= 0n) {
      await failDcaOrderTick(order.id, 'No tokens left to sell');
      return;
    }
    // Sell what is left when the wallet holds less than one tick.
    amountIn = bal && bal.raw < wanted ? bal.raw : wanted;
    if (amountIn <= 0n) {
      await failDcaOrderTick(order.id, 'Invalid token amount');
      return;
    }
    const human = Number(amountIn) / Math.pow(10, info.decimals);
    amountLabel = `${formatTokenAmount(human, 0)} ${info.symbol}`;
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
    notify_user: false,
  } as SwapEvent;

  await publishDcaTick(order, swapEvent, info.symbol || order.token_address.slice(0, 8), amountLabel);
}

async function executeDcaOrder(order: DcaOrderRecord): Promise<void> {
  if (isSolanaToken(order.token_address)) {
    await executeSolanaDcaOrder(order);
    return;
  }
  const near = getNear();
  const db = await getDb();

  // -- Fetch token cache (venue, pool ids, price) --
  const tokenCache = await getTokenCache(order.token_address).catch(() => null);
  if (!tokenCache) {
    await failDcaOrderTick(order.id, 'Token not found in cache');
    return;
  }

  const isSui = tokenCache.chain === 'sui' || tokenCache.venue === 'suipump' || order.token_address.includes('::');
  const venueRaw = tokenCache.venue as string | undefined;
  if (!isSui && !isTradableVenue(venueRaw)) {
    await failDcaOrderTick(order.id, `Non-tradeable venue: ${venueRaw ?? 'unknown'}`);
    return;
  }
  const venue = venueRaw || (isSui ? 'suipump' : 'ref');

  // -- Price guard (optional) --
  if (order.min_price !== null || order.max_price !== null) {
    let spotPrice: number | null = null;
    if (isSui) {
      const curve = await getSuiPumpCurveState(order.token_address).catch(() => null);
      if (curve && curve.lastPriceSui > 0) {
        spotPrice = curve.lastPriceSui;
      } else {
        const routerQuote = await getSuiRouterQuote({
          coinInType: '0x2::sui::SUI',
          coinOutType: order.token_address,
          amountIn: 1_000_000_000n,
          includeFee: false,
        }).catch(() => null);
        if (routerQuote) {
          const decimals = tokenCache.decimals ?? 9;
          if (routerQuote.spotPrice > 0) {
            spotPrice = routerQuote.spotPrice;
          } else if (routerQuote.expectedAmountOut > 0n) {
            const inHuman = Number(routerQuote.amountIn) / 1e9;
            const outHuman = Number(routerQuote.expectedAmountOut) / Math.pow(10, decimals);
            if (outHuman > 0) spotPrice = inHuman / outHuman;
          }
        }
      }
    } else {
      const spot = await near.getVenueSpotPrice(venue as any, order.token_address, tokenCache.decimals ?? 18).catch(() => null);
      if (spot) spotPrice = spot.price;
    }

    if (spotPrice !== null && spotPrice > 0) {
      if (order.max_price !== null && order.side === 'buy' && spotPrice > order.max_price) {
        logger.info('DCA buy skipped: price above max_price guard', {
          orderId: order.id, price: spotPrice, maxPrice: order.max_price,
        });
        await failDcaOrderTick(order.id, `Price guard: ${spotPrice.toFixed(8)} > max ${order.max_price}`);
        return;
      }
      if (order.min_price !== null && order.side === 'sell' && spotPrice < order.min_price) {
        logger.info('DCA sell skipped: price below min_price guard', {
          orderId: order.id, price: spotPrice, minPrice: order.min_price,
        });
        await failDcaOrderTick(order.id, `Price guard: ${spotPrice.toFixed(8)} < min ${order.min_price}`);
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

  const tokenSymbol = tokenCache.symbol || order.token_address.slice(0, 12);
  const nativeSymbol = isSui ? 'SUI' : 'NEAR';
  const amountLabel = order.side === 'buy'
    ? `${order.amount_per_order.toFixed(isSui ? 3 : 2)} ${nativeSymbol}`
    : `${formatTokenAmount(order.amount_per_order, tokenCache.decimals ?? (isSui ? 9 : 18))} ${tokenSymbol}`;
  await publishDcaTick(order, swapEvent, tokenSymbol, amountLabel);
}

/** Publishes the swap, advances the schedule and DMs the user. Shared by every chain. */
async function publishDcaTick(order: DcaOrderRecord, swapEvent: any, tokenSymbol: string, amountLabel: string): Promise<void> {
  // -- Publish swap to executor --
  await redis.publish(CHANNELS.EXECUTE_SWAP, JSON.stringify(swapEvent));

  // -- Advance DCA order in DB (increments executed_orders, computes next_run_at, auto-completes) --
  const updated = await advanceDcaOrder(order.id);

  // -- Notify user --
  const totalOrdersDisplay = order.total_orders === 0 ? '∞' : order.total_orders.toString();
  const progressBar = buildProgressBar(updated.executed_orders, order.total_orders);
  const sideLabel = order.side === 'buy' ? 'Accumulating 🟢' : 'De-Risking 🔴';

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
