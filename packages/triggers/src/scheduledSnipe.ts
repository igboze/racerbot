import 'dotenv/config';
import {
  createRedis,
  CHANNELS,
  createLogger,
  getNear,
  isIntearToken,
  type AutoBuySignal,
} from '@racerbot/shared';
import {
  getDistinctActiveSnipeTokens,
  getActiveTokenSnipes,
  recordSnipeTrigger,
  getTokenCache,
} from '@racerbot/db';

const logger = createLogger('triggers:snipe');
const REDIS_URL = process.env.REDIS_URL!;
const redis = createRedis(REDIS_URL);
const snipeNegativeCache = new Map<string, number>();
const SNIPE_NEGATIVE_TTL_MS = 3_000;

async function checkSnipeSignals(
  tokenAddress: string,
  venue: 'rhea' | 'ref' | 'shardsmarket' | 'nearlytrade' | 'intear' | 'memecooking' | 'onetokenhub' | 'gaypad' | 'nearpad' | 'shoremarkets' | 'kelytra'
): Promise<void> {
  try {
    const tokenOrders = await getActiveTokenSnipes(tokenAddress).catch(() => []);
    for (const order of tokenOrders) {
      const triggerId = await recordSnipeTrigger(order.id, tokenAddress, venue).catch(() => null);
      if (!triggerId) continue;

      const signal: AutoBuySignal = {
        type: 'auto_buy_signal',
        user_id: order.user_id,
        token_address: tokenAddress,
        amount_near: order.amount_near.toString(),
        venue,
        timestamp: Date.now(),
        snipe_order_id: order.id,
        snipe_trigger_id: triggerId,
        snipe_type: order.snipe_type,
      };
      await redis.publish(CHANNELS.AUTO_BUY_SIGNAL, JSON.stringify(signal));
      logger.info(`[TRIGGERS:SNIPE] Snipe order ${order.id} fired for ${tokenAddress} (user ${order.user_id})`);
    }
  } catch (err: any) {
    logger.error('Snipe signal dispatch error', err);
  }
}

export async function runScheduledSnipeEngine(): Promise<void> {
  const near = getNear();
  logger.info('Scheduled Snipe Watchdog Engine started.');

  while (true) {
    try {
      const activeTokens = await getDistinctActiveSnipeTokens().catch(() => []);
      if (activeTokens.length > 0) {
        const now = Date.now();
        await Promise.all(
          activeTokens.map(async (tokenAddress) => {
            const lastNegative = snipeNegativeCache.get(tokenAddress);
            if (lastNegative && now - lastNegative < SNIPE_NEGATIVE_TTL_MS) return;

            try {
              // Priority 1: Native Intear token probe (Authoritative DEX source for Intear tokens)
              if (isIntearToken(tokenAddress)) {
                const intearPoolId = await near.findIntearPoolId(tokenAddress).catch(() => null);
                if (typeof intearPoolId === 'number' && intearPoolId >= 0) {
                  const st = await near.getIntearTokenState(tokenAddress).catch(() => null);
                  if (st && (st.liquidityNear > 0 || (st.price > 0 && BigInt(st.reserveNear) > 0n))) {
                    snipeNegativeCache.delete(tokenAddress);
                    await checkSnipeSignals(tokenAddress, 'intear');
                    return;
                  }
                }
              }

              // Priority 2: Native token launchpads
              if (tokenAddress.endsWith('.nearlytrade.near')) {
                const nt = await near.getNearlytradeTokenState(tokenAddress).catch(() => null);
                if (nt && nt.live && nt.price > 0 && nt.liquidityNear > 0) {
                  snipeNegativeCache.delete(tokenAddress);
                  await checkSnipeSignals(tokenAddress, 'nearlytrade');
                  return;
                }
              }

              if (tokenAddress.endsWith('.onetokenhub.near')) {
                const hub = await near.getOneTokenHubState(tokenAddress).catch(() => null);
                if (hub && hub.price > 0 && hub.liquidityNear > 0) {
                  snipeNegativeCache.delete(tokenAddress);
                  await checkSnipeSignals(tokenAddress, 'onetokenhub');
                  return;
                }
              }

              if (tokenAddress.endsWith('.nearpadfamily.near') || tokenAddress.endsWith('.nearpad.near')) {
                const pad = await near.getNEARpadState(tokenAddress).catch(() => null);
                if (pad && pad.price > 0 && pad.liquidityNear > 0) {
                  snipeNegativeCache.delete(tokenAddress);
                  await checkSnipeSignals(tokenAddress, 'nearpad');
                  return;
                }
              }

              // Fast path: cached venue from DB (if not already handled above)
              const dbCache = await getTokenCache(tokenAddress).catch(() => null);
              if (dbCache && dbCache.venue) {
                if (dbCache.venue === 'intear') {
                  const intearPoolId = dbCache.dcl_pool_id ? parseInt(dbCache.dcl_pool_id, 10) : await near.findIntearPoolId(tokenAddress).catch(() => null);
                  if (typeof intearPoolId === 'number' && intearPoolId >= 0) {
                    const st = await near.getIntearTokenState(tokenAddress).catch(() => null);
                    if (st && (st.liquidityNear > 0 || (st.price > 0 && BigInt(st.reserveNear) > 0n))) {
                      snipeNegativeCache.delete(tokenAddress);
                      await checkSnipeSignals(tokenAddress, 'intear');
                      return;
                    }
                  }
                } else if (dbCache.venue === 'nearlytrade') {
                  const nt = await near.getNearlytradeTokenState(tokenAddress).catch(() => null);
                  if (nt && nt.live && nt.price > 0 && nt.liquidityNear > 0) {
                    snipeNegativeCache.delete(tokenAddress);
                    await checkSnipeSignals(tokenAddress, 'nearlytrade');
                    return;
                  }
                } else if (dbCache.venue === 'rhea' || dbCache.venue === 'ref') {
                  const rheaPool = await near.findRheaPoolForToken(tokenAddress, false).catch(() => null);
                  if (rheaPool && rheaPool.poolId !== null && rheaPool.poolId !== undefined && rheaPool.price > 0 && rheaPool.liquidityNear > 0) {
                    snipeNegativeCache.delete(tokenAddress);
                    await checkSnipeSignals(tokenAddress, 'rhea');
                    return;
                  }
                }
              }

              // Standard DEX probes (Ref DCL & Simple Pools)
              const dclPoolId = await near.findDclPoolId('wrap.near', tokenAddress).catch(() => null);
              if (dclPoolId) {
                const st = await near.getDclPoolState(dclPoolId, 'wrap.near').catch(() => null);
                if (st && st.price > 0 && st.liquidityNear > 0) {
                  snipeNegativeCache.delete(tokenAddress);
                  await checkSnipeSignals(tokenAddress, 'rhea');
                  return;
                }
              }

              const rheaPoolId = await near.findRheaPoolId('wrap.near', tokenAddress).catch(() => null);
              if (typeof rheaPoolId === 'number') {
                const res = await near.getRheaPoolReserves(rheaPoolId, 'wrap.near', tokenAddress).catch(() => null);
                if (res && parseFloat(res.reserveIn) / 1e24 > 0) {
                  snipeNegativeCache.delete(tokenAddress);
                  await checkSnipeSignals(tokenAddress, 'rhea');
                  return;
                }
              }

              const rheaPool = await near.findRheaPoolForToken(tokenAddress, false).catch(() => null);
              if (rheaPool && rheaPool.poolId !== null && rheaPool.poolId !== undefined && rheaPool.price > 0 && rheaPool.liquidityNear > 0) {
                snipeNegativeCache.delete(tokenAddress);
                await checkSnipeSignals(tokenAddress, 'rhea');
                return;
              }

              snipeNegativeCache.set(tokenAddress, Date.now());
            } catch {
              // Ignore single target failure
            }
          })
        );
      }
    } catch (err: any) {
      logger.error('Scheduled snipe engine tick error', err);
    }

    await new Promise((r) => setTimeout(r, 2_500));
  }
}
