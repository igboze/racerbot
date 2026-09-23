import 'dotenv/config';
import { createRedis, CHANNELS, type SwapEvent, type AutoBuySignal } from '@racerbot/shared';
import { getDb } from '@racerbot/db';
import { SwapExecutor, warmAllKeys } from './executor.js';
import { PARENT_ACCOUNT } from './config.js';

const REDIS_URL = process.env.REDIS_URL!;
const executor = new SwapExecutor();
const redis = createRedis(REDIS_URL);

async function main(): Promise<void> {
  console.log('[EXECUTOR] Starting warm signing service...');
  console.log('[EXECUTOR] Parent account:', PARENT_ACCOUNT);

  // Connect DB
  await getDb();

  // Pre-warm ALL user scoped keys into memory before accepting events
  await warmAllKeys();

  // Subscribe to swap execution events from API and triggers
  await redis.subscribe(CHANNELS.EXECUTE_SWAP, async (message: string) => {
    let event: SwapEvent;
    try {
      event = JSON.parse(message);
    } catch {
      console.error('[EXECUTOR] Bad swap event JSON');
      return;
    }
    console.log(`[EXECUTOR] Swap event: user=${event.user_id} token=${event.token_out}`);
    await executor.execute(event).catch(err => {
      console.error('[EXECUTOR] Swap failed:', err.message);
    });
  });

  // Subscribe to auto-buy signals from detector
  await redis.subscribe(CHANNELS.AUTO_BUY_SIGNAL, async (message: string) => {
    let signal: AutoBuySignal;
    try {
      signal = JSON.parse(message);
    } catch {
      console.error('[EXECUTOR] Bad auto-buy signal JSON');
      return;
    }
    console.log(`[EXECUTOR] Auto-buy signal: user=${signal.user_id} token=${signal.token_address}`);
    await executor.autoBuy(signal).catch(err => {
      console.error('[EXECUTOR] Auto-buy failed:', err.message);
    });
  });

  console.log('[EXECUTOR] Ready — listening for swap events');

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

main().catch(err => {
  console.error('[EXECUTOR] Fatal:', err);
  process.exit(1);
});

export { addUserKey, warmAllKeys, SwapExecutor } from './executor.js';