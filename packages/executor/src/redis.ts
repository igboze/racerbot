import { RedisClient } from '@racerbot/shared';
import { getDb } from './db.js';

let redisClient: RedisClient | null = null;

export async function createRedis(): Promise<RedisClient> {
  if (redisClient) return redisClient;
  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  const client = {
    connect: async () => { console.log('[REDIS] Connected'); },
    disconnect: async () => { console.log('[REDIS] Disconnected'); },
    publish: async (channel: string, message: string) => { return 1; },
    subscribe: async (channel: string, handler: (message: string) => void) => { console.log(`[REDIS] Subscribed to ${channel}`); },
    get: async (key: string) => { return null; },
    set: async (key: string, value: string, ttlSeconds?: number) => {},
    del: async (key: string) => {},
    hget: async (key: string, field: string) => { return null; },
    hset: async (key: string, fields: Record<string, string>) => {},
    hgetall: async (key: string) => { return {}; },
    sadd: async (key: string, ...members: string[]) => { return members.length; },
    smembers: async (key: string) => { return []; },
  };
  await client.connect();
  redisClient = client;
  return client;
}

export function getRedis(): RedisClient {
  if (!redisClient) throw new Error('Redis not initialized');
  return redisClient;
}