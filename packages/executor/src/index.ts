import 'dotenv/config';
import { createRedis } from './redis.js';
import { getDb } from './db.js';
import { SwapExecutor } from './executor/SwapExecutor.js';

const executor = new SwapExecutor();

async function main() {
  const redis = await createRedis();
  await getDb().connect();

  console.log('[EXECUTOR] Warm signing service started');

  const redisSub = redis.subscribe(CHANNELS.EXECUTE_SWAP, async (message: string) => {
    const event = JSON.parse(message);
    await executor.execute(event);
  });

  process.on('SIGINT', async () => {
    await redisSub.unsubscribe();
    await redis.disconnect();
    await getDb().disconnect();
    process.exit(0);
  });
}

main().catch(console.error);

const CHANNELS = {
  EXECUTE_SWAP: 'execute-swap',
  TRIGGER_FIRED: 'trigger-fired',
  AUTO_BUY_SIGNAL: 'auto-buy-signal',
};