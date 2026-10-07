import 'dotenv/config';
import { CHANNELS, createLogger, type PriceUpdateEvent } from '@racerbot/shared';
import { getDb, getActiveTriggers, getPositionById } from '@racerbot/db';
import { TriggerEngine, localPriceCache, triggerRedis } from './trigger.js';
import { runDcaEngine } from './dca.js';
import { runLimitOrderEngine } from './limitOrder.js';
import { TRIGGER_INTERVAL_MS, PARENT_ACCOUNT } from './config.js';

const logger = createLogger('triggers');

async function main(): Promise<void> {
  logger.info('Starting trigger engine...', { 
    parentAccount: PARENT_ACCOUNT, 
    pollInterval: TRIGGER_INTERVAL_MS 
  });

  await logger.time('Connected to database', () => getDb());

  const engine = new TriggerEngine();

  // Start DCA engine concurrently — it has its own independent poll loop
  runDcaEngine().catch(err => logger.error('DCA engine failed to start', err));

  // Start Limit Order engine concurrently
  runLimitOrderEngine().catch(err => logger.error('Limit order engine failed to start', err));

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

  // Run trigger evaluation in a self-rescheduling loop: each run finishes
  // before the next is scheduled, so runs can never overlap or stack even
  // when a single check exceeds TRIGGER_INTERVAL_MS.
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const startedAt = Date.now();
      try {
        await engine.checkAllTriggers();
      } catch (err) {
        logger.error('Trigger check error', (err as Error));
      }
      const elapsed = Date.now() - startedAt;
      const remaining = TRIGGER_INTERVAL_MS - elapsed;
      if (remaining > 0) {
        await new Promise((resolve) => setTimeout(resolve, remaining));
      }
    }
  })();

  logger.info('Ready — evaluating triggers on interval', { intervalMs: TRIGGER_INTERVAL_MS });

  const shutdown = async () => {
    stopped = true;
    await triggerRedis.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await loop;
}

main().catch(err => {
  console.error('[TRIGGERS] Fatal:', err);
  process.exit(1);
});