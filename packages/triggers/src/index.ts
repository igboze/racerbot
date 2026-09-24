import 'dotenv/config';
import { createRedis, CHANNELS, createLogger, type PriceUpdateEvent } from '@racerbot/shared';
import { getDb, getActiveTriggers, getPositionById } from '@racerbot/db';
import { TriggerEngine, localPriceCache, triggerRedis } from './trigger.js';
import { TRIGGER_INTERVAL_MS, PARENT_ACCOUNT } from './config.js';

const logger = createLogger('triggers');

async function main(): Promise<void> {
  logger.info('Starting trigger engine...', { 
    parentAccount: PARENT_ACCOUNT, 
    pollInterval: TRIGGER_INTERVAL_MS 
  });

  await logger.time('Connected to database', () => getDb());

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
  logger.info('Price cache warming from Redis...');
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
    logger.info('Found distinct tokens with active triggers', { count: tokenAddresses.length });

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
    logger.info('Price cache warmed with active token prices', { count: localPriceCache.size });
  } catch (err) {
    logger.warn('Price cache warm-up error', (err as Error));
  }

  // Run trigger evaluation on interval
  const interval = setInterval(async () => {
    try {
      await engine.checkAllTriggers();
    } catch (err) {
      logger.error('Trigger check error', (err as Error));
    }
  }, TRIGGER_INTERVAL_MS);

  logger.info('Ready — evaluating triggers on interval', { intervalMs: TRIGGER_INTERVAL_MS });

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