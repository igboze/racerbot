import 'dotenv/config';
import { createRedis, CHANNELS, isTradableVenue, getNear, type PriceUpdateEvent, type SwapEvent } from '@racerbot/shared';
import { getDb, getActiveTriggers, getPositionById, getTokenCache, markTriggerFired, updatePosition } from '@racerbot/db';

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
    const near = getNear();
    const cache = await getTokenCache(tokenAddress);
    const venue = cache?.venue;
    if (!venue || venue === 'memecooking') return false;
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

    for (const trigger of activeTriggers) {
      try {
        await this.evaluateTrigger(trigger);
      } catch (err) {
        console.error(`[TRIGGERS] Error evaluating trigger ${trigger.id}:`, (err as Error).message);
      }
    }
  }

  private async evaluateTrigger(trigger: any): Promise<void> {
    const position = await getPositionById(trigger.position_id);
    if (!position || position.status === 'closed') return;

    let cached = localPriceCache.get(position.token_address);

    // Staleness guard: never evaluate a stop-loss against old data.
    if (!cached || Date.now() - cached.ts > PRICE_STALENESS_MS) {
      const refreshed = await refreshTokenPrice(position.token_address);
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
        // Fire if price dropped below entry × (1 - target%)
        triggered = currentPrice <= entryPrice * (1 - targetValue / 100);
        break;

      case 'take_profit':
        // Fire if price rose above entry × (1 + target%)
        triggered = currentPrice >= entryPrice * (1 + targetValue / 100);
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

    // Determine sell side — determine venue from token cache
    const db = await getDb();
    const tokenRow = await db.query(
      'SELECT venue, rhea_pool_id, dcl_pool_id FROM token_cache WHERE token_address = $1',
      [position.token_address]
    ).then(r => r.rows[0]).catch(() => null);

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
      venue,
      position.token_address,
      'wrap.near',
      position.quantity_held,
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
      amount_in: position.quantity_held,
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
    'SELECT venue, rhea_pool_id, dcl_pool_id FROM token_cache WHERE token_address = $1',
    [position.token_address]
  ).then(r => r.rows[0]).catch(() => null);

  const venue = tokenRow?.venue as 'rhea' | 'shardsmarket' | 'nearlytrade' | undefined;
  if (!venue) return { success: false };

  const userRow = await db.query('SELECT slippage_pct FROM users WHERE id = $1', [userId])
    .then(r => r.rows[0]).catch(() => null);
  const slippagePct = userRow?.slippage_pct ? Number(userRow.slippage_pct) : 2.0;

  const near = getNear();
  const { minAmountOut } = await near.computeMinAmountOut(
    venue,
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