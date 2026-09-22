import 'dotenv/config';
import { createRedis } from './redis.js';
import { getDb } from './db.js';
import { TriggerEngine } from './trigger.js';
import { TRIGGER_INTERVAL_MS, PARENT_ACCOUNT } from './config.js';

async function main() {
  const redis = await createRedis();
  await getDb().connect();
  console.log('[TRIGGERS] Trigger engine started');
  console.log('[TRIGGERS] Parent account:', PARENT_ACCOUNT);

  const engine = new TriggerEngine();
  const intervalMs = TRIGGER_INTERVAL_MS;

  setInterval(async () => {
    try {
      await engine.checkAllTriggers();
    } catch (err) {
      console.error('[TRIGGERS] Error:', err);
    }
  }, intervalMs);

  process.on('SIGINT', async () => {
    await redis.disconnect();
    await getDb().disconnect();
    process.exit(0);
  });
}

main().catch(console.error);