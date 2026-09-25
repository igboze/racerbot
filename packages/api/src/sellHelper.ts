import { getNear, type SwapEvent } from '@racerbot/shared';
import { getPositionById, getTokenCache, getUserById } from '@racerbot/db';
import { getTokenInfo, publishSwap } from './wallet.js';

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
  let venue: 'rhea' | 'shardsmarket' | 'nearlytrade' | 'intear' | 'onetokenhub' | undefined = cached?.venue as any;
  let effectiveRheaPoolId = cached?.rhea_pool_id;
  let effectiveDclPoolId = cached?.dcl_pool_id ?? undefined;

  // VENUE PRIORITY LOGIC: Check Rhea first, then use detected venue
  const near = getNear();
  let hasRheaPool = false;
  try {
    if (effectiveRheaPoolId || effectiveDclPoolId) {
      hasRheaPool = true;
    } else {
      // Try to find Rhea pool dynamically
      const rheaPoolId = await near.findRheaPoolId('wrap.near', position.token_address).catch(() => null);
      if (rheaPoolId) {
        hasRheaPool = true;
        effectiveRheaPoolId = rheaPoolId;
        venue = 'rhea';
      }
    }
  } catch {
    // If Rhea check fails, continue with detected venue
  }

  if (!['rhea', 'shardsmarket', 'nearlytrade', 'intear', 'onetokenhub'].includes(venue as string)) {
    venue = undefined;
  }
  if (!venue) {
    const info = await getTokenInfo(position.token_address).catch(() => null);
    if (info && ['rhea', 'shardsmarket', 'nearlytrade', 'intear', 'onetokenhub'].includes(info.venue)) {
      venue = info.venue as 'rhea' | 'shardsmarket' | 'nearlytrade' | 'intear' | 'onetokenhub';
    }
  }
  if (!venue) return { success: false, reason: 'venue_unknown' };

  console.log(`[SELL] Token: ${position.token_address}, Detected venue: ${cached?.venue}, Has Rhea pool: ${hasRheaPool}, Final venue: ${venue}`);

  const user = await getUserById(userId).catch(() => null);
  const slippagePct = user?.slippage_pct ? Number(user.slippage_pct) : 2.0;

  const { minAmountOut } = await near.computeMinAmountOut(
    venue,
    position.token_address,
    'wrap.near',
    sellQty,
    slippagePct,
    effectiveRheaPoolId,
    effectiveDclPoolId
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
    dcl_pool_id: effectiveDclPoolId,
  } as any;

  await publishSwap(swapEvent);

  return { success: true };
}
