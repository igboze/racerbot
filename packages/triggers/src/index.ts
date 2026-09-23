import 'dotenv/config';
import { createRedis, CHANNELS, type PriceUpdateEvent } from '@racerbot/shared';
import { getDb, getActiveTriggers, getPositionById } from '@racerbot/db';
import { TriggerEngine, localPriceCache, triggerRedis } from './trigger.js';
import { TRIGGER_INTERVAL_MS, PARENT_ACCOUNT } from './config.js';

async function main(): Promise<void> {
  console.log('[TRIGGERS] Starting trigger engine...');
  console.log('[TRIGGERS] Parent account:', PARENT_ACCOUNT);
  console.log('[TRIGGERS] Poll interval:', TRIGGER_INTERVAL_MS, 'ms');

  await getDb();

  const engine = new TriggerEngine();

  // Subscribe to price updates from detector — warm local cache
  // This is the only price data source in the trigger hot path
  await triggerRedis.subscribe(CHANNELS.PRICE_UPDATE, (message: string) => {
    try {
      const update: PriceUpdateEvent = JSON.parse(message);
      localPriceCache.set(update.token_address, {
        price: update.price,
        marketCap: update.market_cap,
        ts: update.timestamp,
      });
    } catch {
      // Ignore malformed messages
    }
  });

  // Seed price cache from Redis on startup (tokens detected before this process started)
  console.log('[TRIGGERS] Price cache warming from Redis...');
  try {
    const activeTriggers = await getActiveTriggers();
    const tokenSet = new Set<string>();

    await Promise.all(
      activeTriggers.map(async (trigger) => {
        try {
          const pos = await getPositionById(trigger.position_id);
          if (pos && pos.token_address) {
            tokenSet.add(pos.token_address);
          }
        } catch {
          // ignore lookup failure
        }
      })
    );

    const tokenAddresses = Array.from(tokenSet);
    console.log(`[TRIGGERS] Found ${tokenAddresses.length} distinct token(s) with active triggers.`);

    await Promise.all(
      tokenAddresses.map(async (tokenAddress) => {
        try {
          const timeoutPromise = new Promise<null>((_, reject) =>
            setTimeout(() => reject(new Error('Redis timeout')), 2000)
          );
          const cachedJson = await Promise.race([
            triggerRedis.get(`token:price:${tokenAddress}`),
            timeoutPromise,
          ]);
          if (cachedJson) {
            const update: PriceUpdateEvent = JSON.parse(cachedJson);
            localPriceCache.set(tokenAddress, {
              price: update.price,
              marketCap: update.market_cap,
              ts: update.timestamp,
            });
          }
        } catch {
          // If Redis is slow or missing, leave out as specified
        }
      })
    );
    console.log(`[TRIGGERS] Price cache warmed with ${localPriceCache.size} active token price(s).`);
  } catch (err) {
    console.warn('[TRIGGERS] Price cache warm-up error:', (err as Error).message);
  }

  // Run trigger evaluation on interval
  const interval = setInterval(async () => {
    try {
      await engine.checkAllTriggers();
    } catch (err) {
      console.error('[TRIGGERS] Check error:', (err as Error).message);
    }
  }, TRIGGER_INTERVAL_MS);

  console.log('[TRIGGERS] Ready — evaluating triggers every', TRIGGER_INTERVAL_MS, 'ms');

  process.on('SIGINT', async () => {
    clearInterval(interval);
    await triggerRedis.disconnect();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    clearInterval(interval);
    await triggerRedis.disconnect();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('[TRIGGERS] Fatal:', err);
  process.exit(1);
});