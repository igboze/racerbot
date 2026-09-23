import { createRedis, CHANNELS, type SwapEvent } from '@racerbot/shared';
import { getPositionById, getTokenCache } from '@racerbot/db';

const REDIS_URL = process.env.REDIS_URL!;

let redisClient: ReturnType<typeof createRedis> | null = null;
function getRedisClient() {
  if (!redisClient) {
    redisClient = createRedis(REDIS_URL);
  }
  return redisClient;
}

/**
 * Sell a percentage of a position by publishing EXECUTE_SWAP to Redis.
 * Called from both the Telegram bot sell buttons and REST API.
 */
export async function sellAtTarget(userId: string, positionId: string, percentage: number): Promise<{ success: boolean; reason?: string }> {
  const position = await getPositionById(positionId);
  if (!position) return { success: false, reason: 'position_not_found' };
  if (position.status === 'closed') return { success: false, reason: 'position_already_closed' };
  if (position.user_id !== userId) return { success: false, reason: 'not_your_position' };

  const rawQty = BigInt(position.quantity_held.split('.')[0] || '0');
  if (rawQty <= 0n) return { success: false, reason: 'zero_quantity' };

  const sellQty = percentage === 100
    ? rawQty.toString()
    : ((rawQty * BigInt(Math.floor(percentage))) / 100n).toString();

  if (sellQty === '0') return { success: false, reason: 'zero_quantity' };

  const cached = await getTokenCache(position.token_address).catch(() => null);
  const venue = (cached?.venue as 'rhea' | 'shardsmarket') ?? 'shardsmarket';

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

  const redis = getRedisClient();
  await redis.publish(CHANNELS.EXECUTE_SWAP, JSON.stringify(swapEvent));

  return { success: true };
}
