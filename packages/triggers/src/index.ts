import 'dotenv/config';
import { createRedis } from './redis.js';
import { getDb } from './db.js';
import { TriggerEngine } from './trigger/TriggerEngine.js';

async function main() {
  const redis = await createRedis();
  await getDb().connect();

  console.log('[TRIGGERS] Trigger engine started');

  const engine = new TriggerEngine();
  const intervalMs = parseInt(process.env.TRIGGER_INTERVAL_MS || '5000');

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

const CHANNELS = {
  TRIGGER_FIRED: 'trigger-fired',
  EXECUTE_SWAP: 'execute-swap',
};