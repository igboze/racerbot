import 'dotenv/config';
import { createRedis, CHANNELS, isTradableVenue, getNear, getSuiPumpCurveState, getSuiRouterQuote, type SwapEvent } from '@racerbot/shared';
import { getDb, getActiveTriggers, getPositionById, getPositionsByIds, getTokenCache, markTriggerFired, type PositionRecord } from '@racerbot/db';

const REDIS_URL = process.env.REDIS_URL!;
const redis = createRedis(REDIS_URL);

// ── In-memory price cache — warmed by detector price updates ──────────────────
// This is the ONLY price read path in the hot trigger loop (no RPC, no DB).
const localPriceCache = new Map<string, { price: number; marketCap: number; ts: number }>();

/**
 * Max age of cached price data before we force an RPC refresh. The detector
 * pushes a price refresh for every triggered token every ~15s; if it stops
 * (crash/RPC outage), acting on stale prices would silently skip stop-losses.
 */
const PRICE_STALENESS_MS = 60_000;

/**
 * Fallback price refresh straight from the venue's live pool state.
 * Returns true and updates localPriceCache on success.
 */
async function refreshTokenPrice(tokenAddress: string): Promise<boolean> {
  try {
    const cache = await getTokenCache(tokenAddress);
    if (cache?.chain === 'sui' || cache?.venue === 'suipump' || tokenAddress.includes('::')) {
      const curve = await getSuiPumpCurveState(tokenAddress).catch(() => null);
      if (curve && curve.lastPriceSui > 0) {
        const decimals = cache?.decimals ?? 6;
        const supply = parseFloat(cache?.total_supply ?? '0') / Math.pow(10, decimals);
        const marketCap = supply > 0 ? curve.lastPriceSui * supply : curve.marketCapSui;
        localPriceCache.set(tokenAddress, {
          price: curve.lastPriceSui,
          marketCap,
          ts: Date.now(),
        });
        return true;
      }

      // Fallback: If not on SuiPump or graduated, query Aftermath DEX router quote
      const routerQuote = await getSuiRouterQuote({
        coinInType: '0x2::sui::SUI',
        coinOutType: tokenAddress,
        amountIn: 1_000_000_000n, // 1 SUI
        includeFee: false,
      }).catch(() => null);

      if (routerQuote) {
        const decimals = cache?.decimals ?? 9;
        let priceSui = routerQuote.spotPrice;
        if (!priceSui || priceSui <= 0) {
          const inHuman = Number(routerQuote.amountIn) / 1e9;
          const outHuman = Number(routerQuote.expectedAmountOut) / Math.pow(10, decimals);
          if (outHuman > 0) priceSui = inHuman / outHuman;
        }

        if (priceSui > 0) {
          const supply = parseFloat(cache?.total_supply ?? '0') / Math.pow(10, decimals);
          const marketCap = supply > 0 ? priceSui * supply : 0;
          localPriceCache.set(tokenAddress, {
            price: priceSui,
            marketCap,
            ts: Date.now(),
          });
          return true;
        }
      }

      return false;
    }

    const near = getNear();
    const venue = cache?.venue as any;
    if (!venue) return false;
    const decimals = cache?.decimals ?? 18;
    const spot = await near.getVenueSpotPrice(venue, tokenAddress, decimals);
    if (!spot || !(spot.price > 0)) return false;
    const supply = parseFloat(cache?.total_supply ?? '0') / Math.pow(10, decimals);
    const marketCap = supply > 0 ? spot.price * supply : 0;
    localPriceCache.set(tokenAddress, {
      price: spot.price,
      marketCap,
      ts: Date.now(),
    });
    return true;
  } catch {
    return false;
  }
}

export class TriggerEngine {

  /**
   * Main trigger check loop.
   * All price reads come from localPriceCache — never from RPC or DB.
   * When triggered: mark in DB + publish EXECUTE_SWAP to executor via Redis.
   */
  async checkAllTriggers(): Promise<void> {
    const activeTriggers = await getActiveTriggers();
    if (activeTriggers.length === 0) return;

    // All positions in one query instead of N serial per-trigger lookups
    const positionIds = [...new Set(activeTriggers.map(t => t.position_id))];
    const positions = await getPositionsByIds(positionIds);
    const positionById = new Map(positions.map(p => [p.id, p]));

    // One stale-price refresh per unique token per cycle (deduplicated)
    const refreshedThisCycle = new Set<string>();
    const staleTokens = new Set<string>();
    for (const trigger of activeTriggers) {
      const position = positionById.get(trigger.position_id);
      if (!position || position.status === 'closed') continue;
      const cached = localPriceCache.get(position.token_address);
      if (!cached || Date.now() - cached.ts > PRICE_STALENESS_MS) {
        staleTokens.add(position.token_address);
      }
    }
    await Promise.all([...staleTokens].map(async (tokenAddress) => {
      await refreshTokenPrice(tokenAddress);
      refreshedThisCycle.add(tokenAddress);
    }));

    // Bounded-concurrency evaluation — per-trigger try/catch so one
    // failure can't reject the batch
    const CONCURRENCY = 8;
    for (let i = 0; i < activeTriggers.length; i += CONCURRENCY) {
      const chunk = activeTriggers.slice(i, i + CONCURRENCY);
      await Promise.all(chunk.map(async (trigger) => {
        try {
          await this.evaluateTrigger(trigger, positionById, refreshedThisCycle);
        } catch (err) {
          console.error(`[TRIGGERS] Error evaluating trigger ${trigger.id}:`, (err as Error).message);
        }
      }));
    }
  }

  async evaluateTrigger(
    trigger: any,
    positionById?: Map<string, PositionRecord>,
    refreshedThisCycle?: Set<string>,
  ): Promise<void> {
    const position = positionById?.get(trigger.position_id) ?? await getPositionById(trigger.position_id);
    if (!position || position.status === 'closed') return;

    let cached = localPriceCache.get(position.token_address);

    // Staleness guard: never evaluate a stop-loss against old data.
    if (!cached || Date.now() - cached.ts > PRICE_STALENESS_MS) {
      // checkAllTriggers already refreshed each stale token once this cycle;
      // only fall back to a live refresh when called outside that path.
      const refreshed = refreshedThisCycle?.has(position.token_address)
        ? false
        : await refreshTokenPrice(position.token_address);
      cached = localPriceCache.get(position.token_address);
      if (!cached) {
        console.warn(
          `[TRIGGERS] No price data for ${position.token_address} — trigger ${trigger.id} held active`
        );
        return; // Keep the trigger active; retry next poll
      }
      if (!refreshed && Date.now() - cached.ts > PRICE_STALENESS_MS) {
        console.warn(
          `[TRIGGERS] Price data stale for ${position.token_address} — trigger ${trigger.id} held active`
        );
        return;
      }
    }

    const currentPrice = cached.price;
    const currentMarketCap = cached.marketCap;
    const entryPrice = parseFloat(position.avg_entry_price);
    const targetValue = parseFloat(trigger.target_value);

    let triggered = false;

    switch (trigger.type) {
      case 'stop_loss':
      case 'take_profit':
        // Guard: if entry price is not yet settled (zero or NaN), the % calculation
        // is meaningless — any price would satisfy entryPrice*multiplier=0 and the
        // trigger would fire immediately after every buy. Hold active and retry.
        if (!entryPrice || isNaN(entryPrice) || entryPrice <= 0) {
          console.warn(
            `[TRIGGERS] Entry price not settled for position ${trigger.position_id} (got '${position.avg_entry_price}') — holding trigger ${trigger.id} active`
          );
          return;
        }
        if (trigger.type === 'stop_loss') {
          triggered = currentPrice <= entryPrice * (1 - targetValue / 100);
        } else {
          triggered = currentPrice >= entryPrice * (1 + targetValue / 100);
        }
        break;

      case 'market_cap':
        // Fire if market cap crossed target (in NEAR)
        triggered = currentMarketCap >= targetValue;
        break;
    }

    if (triggered) {
      console.log(`[TRIGGERS] Fired: type=${trigger.type} position=${trigger.position_id} price=${currentPrice}`);
      await this.fireTrigger(trigger, position, currentPrice);
    }
  }

  private async fireTrigger(trigger: any, position: any, currentPrice: number): Promise<void> {
    // Order matters: resolve venue + min_out FIRST, publish SECOND, mark fired
    // LAST. Previously the trigger was marked fired before the sell was
    // published — if venue lookup or slippage math threw, the stop-loss was
    // consumed WITHOUT ever selling (user stuck in a losing position).
    // Any failure before publish now leaves the trigger active for retry.

    // Determine the actual sell quantity respecting the trigger's sell_pct.
    // sell_pct defaults to 100 (sell everything). For partial TPs/SLs the user
    // can configure e.g. 50 to only sell half the position.
    const sellPct = typeof trigger.sell_pct === 'number' ? Math.min(100, Math.max(1, trigger.sell_pct)) : 100;
    let amountIn = position.quantity_held;
    if (sellPct < 100) {
      const rawQty = BigInt(String(position.quantity_held).split('.')[0] || '0');
      const sellQty = (rawQty * BigInt(Math.floor(sellPct))) / 100n;
      if (sellQty <= 0n) {
        console.warn(`[TRIGGER] sell_pct ${sellPct}% of ${position.quantity_held} rounds to 0 — skipping trigger ${trigger.id}`);
        return;
      }
      amountIn = sellQty.toString();
    }

    // Determine sell side — determine venue from token cache
    const db = await getDb();
    const tokenRow = await db.query(
      'SELECT venue, rhea_pool_id, dcl_pool_id, chain FROM token_cache WHERE token_address = $1',
      [position.token_address]
    ).then(r => r.rows[0]).catch(() => null);

    // Sui Chain Trigger Route
    if (position.chain === 'sui' || tokenRow?.chain === 'sui' || tokenRow?.venue === 'suipump' || position.token_address.includes('::')) {
      const slippagePct = trigger.type === 'stop_loss' ? 5.0 : 2.0;
      const swapEvent = {
        type: 'execute_swap',
        chain: 'sui',
        user_id: position.user_id,
        token_in: position.token_address,
        token_out: 'sui',
        amount_in: amountIn,
        min_amount_out: '1',
        venue: 'suipump',
        slippage_pct: slippagePct,
        timestamp: Date.now(),
      };

      await redis.publish(CHANNELS.EXECUTE_SWAP, JSON.stringify(swapEvent));
      await markTriggerFired(trigger.id);

      await redis.publish(CHANNELS.NOTIFY_USER, JSON.stringify({
        type: 'notify_user',
        telegram_id: 0,
        event: 'trigger_fired',
        data: {
          user_id: position.user_id,
          trigger_type: trigger.type,
          token_address: position.token_address,
          current_price: currentPrice,
          target_value: trigger.target_value,
          entry_price: parseFloat(position.avg_entry_price || '0'),
          quantity_held: amountIn,
          sell_pct: sellPct,
          chain: 'sui',
          position_id: position.id,
        },
      }));
      return;
    }

    const venueRaw = tokenRow?.venue as string | undefined;
    if (!isTradableVenue(venueRaw)) {
      // Do NOT mark fired — keep it active so it retries once venue is known
      console.warn(
        `[TRIGGER] Unknown/non-tradeable venue '${venueRaw}' for token ${position.token_address}, holding trigger ${trigger.id}`
      );
      return;
    }
    const venue = venueRaw;

    // Stop-loss default slippage tolerance of 5% to prioritize exit execution; take-profit uses 2%
    const slippagePct = trigger.type === 'stop_loss' ? 5.0 : 2.0;
    const near = getNear();
    const { minAmountOut } = await near.computeMinAmountOut(
      venue as any,
      position.token_address,
      'wrap.near',
      amountIn,
      slippagePct,
      tokenRow?.rhea_pool_id,
      tokenRow?.dcl_pool_id ?? undefined
    );

    // Publish to executor via Redis — DO NOT call executor directly (microservice boundary)
    const swapEvent: SwapEvent = {
      type: 'execute_swap',
      user_id: position.user_id,
      token_in: position.token_address,
      token_out: 'wrap.near',
      amount_in: amountIn,
      min_amount_out: minAmountOut,
      venue,
      timestamp: Date.now(),
      ...(tokenRow?.dcl_pool_id ? { dcl_pool_id: tokenRow.dcl_pool_id } : {}),
    } as any;

    await redis.publish(CHANNELS.EXECUTE_SWAP, JSON.stringify(swapEvent));

    // Only consume the trigger once the sell order is actually in flight
    await markTriggerFired(trigger.id);

    // Notify user via Redis → API
    await redis.publish(CHANNELS.NOTIFY_USER, JSON.stringify({
      type: 'notify_user',
      telegram_id: 0, // API service resolves telegram_id from user_id
      event: 'trigger_fired',
      data: {
        user_id: position.user_id,
        trigger_type: trigger.type,
        token_address: position.token_address,
        current_price: currentPrice,
        target_value: trigger.target_value,
        entry_price: parseFloat(position.avg_entry_price || '0'),
        quantity_held: amountIn,
        sell_pct: sellPct,
        chain: position.chain || 'near',
        position_id: position.id,
      },
    }));
  }
}

/** Sell a partial position by percentage (e.g. 50% = sell half). */
export async function sellAtTarget(userId: string, positionId: string, percentage: number): Promise<{ success: boolean }> {
  const position = await getPositionById(positionId);
  if (!position || position.status === 'closed') {
    return { success: false };
  }

  const rawQty = BigInt(position.quantity_held.split('.')[0] || '0');
  if (rawQty <= 0n) return { success: false };

  const sellQty = percentage === 100
    ? rawQty.toString()
    : ((rawQty * BigInt(Math.floor(percentage))) / 100n).toString();

  if (sellQty === '0') return { success: false };

  const db = await getDb();
  const tokenRow = await db.query(
    'SELECT venue, rhea_pool_id, dcl_pool_id, chain FROM token_cache WHERE token_address = $1',
    [position.token_address]
  ).then(r => r.rows[0]).catch(() => null);

  const userRow = await db.query('SELECT slippage_pct FROM users WHERE id = $1', [userId])
    .then(r => r.rows[0]).catch(() => null);
  const slippagePct = userRow?.slippage_pct ? Number(userRow.slippage_pct) : 2.0;

  if (position.chain === 'sui' || tokenRow?.chain === 'sui' || tokenRow?.venue === 'suipump' || position.token_address.includes('::')) {
    const swapEvent = {
      type: 'execute_swap',
      chain: 'sui',
      user_id: userId,
      token_in: position.token_address,
      token_out: 'sui',
      amount_in: sellQty,
      min_amount_out: '1',
      venue: 'suipump',
      slippage_pct: slippagePct,
      timestamp: Date.now(),
    };
    await redis.publish(CHANNELS.EXECUTE_SWAP, JSON.stringify(swapEvent));
    return { success: true };
  }

  const venueRaw = tokenRow?.venue as string | undefined;
  if (!isTradableVenue(venueRaw)) return { success: false };
  const venue = venueRaw;

  const near = getNear();
  const { minAmountOut } = await near.computeMinAmountOut(
    venue as any,
    position.token_address,
    'wrap.near',
    sellQty,
    slippagePct,
    tokenRow?.rhea_pool_id,
    tokenRow?.dcl_pool_id ?? undefined
  );

  const swapEvent: SwapEvent = {
    type: 'execute_swap',
    user_id: userId,
    token_in: position.token_address,
    token_out: 'wrap.near',
    amount_in: sellQty,
    min_amount_out: minAmountOut,
    venue,
    timestamp: Date.now(),
    ...(tokenRow?.dcl_pool_id ? { dcl_pool_id: tokenRow.dcl_pool_id } : {}),
  } as any;

  await redis.publish(CHANNELS.EXECUTE_SWAP, JSON.stringify(swapEvent));
  return { success: true };
}

export { localPriceCache, redis as triggerRedis };