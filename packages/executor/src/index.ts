import { createRedis } from './redis.js';
import { getDb } from './db.js';
import { SwapExecutor } from './executor.js';
import { MAIN_WALLET_PRIVATE_KEY, PARENT_ACCOUNT } from './config.js';

const executor = new SwapExecutor();

async function main() {
  const redis = await createRedis();
  await getDb().connect();
  console.log('[EXECUTOR] Warm signing service started');
  console.log('[EXECUTOR] Parent account:', PARENT_ACCOUNT);

  const redisSub = redis.subscribe('execute-swap', async (message: string) => {
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