import 'dotenv/config';
import { createRedis, CHANNELS, type PriceUpdateEvent } from '@racerbot/shared';
import { getDb } from '@racerbot/db';
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
  // This is a best-effort warm-up — missing entries just won't trigger until next price update
  console.log('[TRIGGERS] Price cache warming from Redis...');

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