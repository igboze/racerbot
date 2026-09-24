import 'dotenv/config';
import { pathToFileURL } from 'url';
import { createRedis, CHANNELS, assertValidMasterKey, createLogger, generateCorrelationId, type SwapEvent, type AutoBuySignal } from '@racerbot/shared';
import { getDb } from '@racerbot/db';
import { SwapExecutor, warmAllKeys } from './executor.js';
import { PARENT_ACCOUNT, MASTER_KEY } from './config.js';

const REDIS_URL = process.env.REDIS_URL!;
const logger = createLogger('executor');
const executor = new SwapExecutor();
const redis = createRedis(REDIS_URL);

async function main(): Promise<void> {
  logger.info('Starting warm signing service...', { parentAccount: PARENT_ACCOUNT });

  // Fail fast — never decrypt user keys with a missing/placeholder master key
  assertValidMasterKey(MASTER_KEY);

  // One stray rejected promise must not kill the signing service
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection (kept alive)', undefined, { reason });
  });

  // Connect DB
  await logger.time('Connected to database', () => getDb());

  // Pre-warm ALL user scoped keys into memory before accepting events
  await logger.time('Warmed user keys', () => warmAllKeys());

  // Subscribe to swap execution events from API and triggers
  await redis.subscribe(CHANNELS.EXECUTE_SWAP, async (message: string) => {
    const correlationId = generateCorrelationId();
    let event: SwapEvent;
    try {
      event = JSON.parse(message);
    } catch {
      logger.error('Bad swap event JSON', undefined, { correlationId });
      return;
    }
    logger.info('Swap event received', { 
      correlationId, 
      userId: event.user_id, 
      token: event.token_out 
    });
    
    await logger.time('Swap executed', async () => {
      await executor.execute(event).catch(err => {
        logger.error('Swap failed', err, { correlationId, userId: event.user_id });
      });
    }, { correlationId, userId: event.user_id });
  });

  // Subscribe to auto-buy signals from detector
  await redis.subscribe(CHANNELS.AUTO_BUY_SIGNAL, async (message: string) => {
    const correlationId = generateCorrelationId();
    let signal: AutoBuySignal;
    try {
      signal = JSON.parse(message);
    } catch {
      logger.error('Bad auto-buy signal JSON', undefined, { correlationId });
      return;
    }
    logger.info('Auto-buy signal received', { 
      correlationId, 
      userId: signal.user_id, 
      token: signal.token_address 
    });
    
    await logger.time('Auto-buy executed', async () => {
      await executor.autoBuy(signal).catch(err => {
        logger.error('Auto-buy failed', err, { correlationId, userId: signal.user_id });
      });
    }, { correlationId, userId: signal.user_id });
  });

  logger.info('Ready — listening for swap events');

  process.on('SIGINT', async () => {
    console.log('[EXECUTOR] Shutting down...');
    await redis.disconnect();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await redis.disconnect();
    process.exit(0);
  });
}

// Run main() ONLY when this file is the process entrypoint. Importing
// @racerbot/executor (e.g. from the API for key warming) used to boot a
// second executor that subscribed to the same Redis channel and
// double-executed every swap. The executor now loads new keys lazily from
// the DB on first use, so cross-process imports are never needed.
const isDirectRun =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch(err => {
    console.error('[EXECUTOR] Fatal:', err);
    process.exit(1);
  });
}

export { addUserKey, warmAllKeys, SwapExecutor } from './executor.js';