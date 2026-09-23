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
  let venue = cached?.venue as 'rhea' | 'shardsmarket' | 'nearlytrade' | undefined;
  if (!venue) {
    const { getTokenInfo } = await import('./wallet.js');
    const info = await getTokenInfo(position.token_address).catch(() => null);
    if (info && info.venue !== 'unknown') {
      venue = info.venue;
    }
  }
  if (!venue) return { success: false, reason: 'venue_unknown' };

  const { getUserById } = await import('@racerbot/db');
  const user = await getUserById(userId).catch(() => null);
  const slippagePct = user?.slippage_pct ? Number(user.slippage_pct) : 2.0;

  const near = (await import('@racerbot/shared')).getNear();
  const { minAmountOut } = await near.computeMinAmountOut(
    venue,
    position.token_address,
    'wrap.near',
    sellQty,
    slippagePct,
    cached?.rhea_pool_id,
    cached?.dcl_pool_id ?? undefined
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
    ...(cached?.dcl_pool_id ? { dcl_pool_id: cached.dcl_pool_id } : {}),
  } as any;

  const redis = getRedisClient();
  await redis.publish(CHANNELS.EXECUTE_SWAP, JSON.stringify(swapEvent));

  return { success: true };
}
