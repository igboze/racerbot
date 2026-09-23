import 'dotenv/config';
import { createRedis, CHANNELS, type PriceUpdateEvent, type SwapEvent } from '@racerbot/shared';
import { getDb, getActiveTriggers, getPositionById, markTriggerFired, updatePosition } from '@racerbot/db';

const REDIS_URL = process.env.REDIS_URL!;
const redis = createRedis(REDIS_URL);

// ── In-memory price cache — warmed by detector price updates ──────────────────
// This is the ONLY price read path in the hot trigger loop (no RPC, no DB).
const localPriceCache = new Map<string, { price: number; marketCap: number; ts: number }>();

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

    const cached = localPriceCache.get(position.token_address);
    if (!cached) return; // No price data yet — skip, do not fire

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
    // Atomically mark trigger as fired (prevents double-fire on next poll)
    await markTriggerFired(trigger.id);

    // Determine sell side — determine venue from token cache
    const db = await getDb();
    const tokenRow = await db.query(
      'SELECT venue FROM token_cache WHERE token_address = $1',
      [position.token_address]
    ).then(r => r.rows[0]).catch(() => null);

    const venue = (tokenRow?.venue ?? 'shardsmarket') as 'rhea' | 'shardsmarket';

    // Publish to executor via Redis — DO NOT call executor directly (microservice boundary)
    const swapEvent: SwapEvent = {
      type: 'execute_swap',
      user_id: position.user_id,
      token_in: position.token_address,
      token_out: 'wrap.near',
      amount_in: position.quantity_held,
      min_amount_out: '0', // Accept any output — trigger fires when threshold already crossed
      venue,
      timestamp: Date.now(),
    };

    await redis.publish(CHANNELS.EXECUTE_SWAP, JSON.stringify(swapEvent));

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
    'SELECT venue FROM token_cache WHERE token_address = $1',
    [position.token_address]
  ).then(r => r.rows[0]).catch(() => null);

  const venue = (tokenRow?.venue ?? 'shardsmarket') as 'rhea' | 'shardsmarket';

  const swapEvent: SwapEvent = {
    type: 'execute_swap',
    user_id: userId,
    token_in: position.token_address,
    token_out: 'wrap.near',
    amount_in: sellQty,
    min_amount_out: '0',
    venue,
    timestamp: Date.now(),
  };

  await redis.publish(CHANNELS.EXECUTE_SWAP, JSON.stringify(swapEvent));
  return { success: true };
}

export { localPriceCache, redis as triggerRedis };