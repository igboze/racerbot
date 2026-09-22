import 'dotenv/config';
import { RedisClient, getRedis, CHANNELS, TokenDetectedEvent, PoolCreatedEvent } from '@racerbot/shared';
import { getDb } from '@racerbot/db';

async function main() {
  const redis = await getRedis();
  await getDb().connect();

  console.log('[DETECTOR] Starting block watcher...');

  const rpcProviders = process.env.RPC_PROVIDERS!.split(',');
  const lastBlockKey = 'detector:last_block';

  while (true) {
    try {
      const provider = rpcProviders[Math.floor(Math.random() * rpcProviders.length)];
      const lastBlock = await redis.get(lastBlockKey);
      const currentBlock = await rpcFetch(provider, '/latest', lastBlock);

      if (currentBlock > (parseInt(lastBlock || '0'))) {
        const events = await scanBlockForEvents(provider, currentBlock);
        for (const event of events) {
          if (event.type === 'token_detected') {
            await redis.publish(CHANNELS.NEW_TOKENS, JSON.stringify(event));
            await cacheToken(event as TokenDetectedEvent);
          } else if (event.type === 'pool_created') {
            await redis.publish(CHANNELS.POOL_CREATED, JSON.stringify(event as PoolCreatedEvent));
          }
        }
        await redis.set(lastBlockKey, currentBlock.toString(), 86400);
      }
    } catch (err) {
      console.error('[DETECTOR] Error:', err);
    }
    await sleep(3000);
  }
}

async function rpcFetch(provider: string, path: string, lastBlock?: string) {
  // Implementation for RPC calls using multi-provider strategy
  const url = provider + path;
  const resp = await fetch(url);
  return resp.json();
}

async function scanBlockForEvents(provider: string, blockNumber: number) {
  // Scan block for pool creation and token detection events
  return [];
}

async function cacheToken(event: TokenDetectedEvent) {
  // Cache token info in memory and DB
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

main().catch(console.error);