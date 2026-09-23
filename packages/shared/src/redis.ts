import { createRequire } from 'module';
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Redis = require('ioredis') as typeof import('ioredis').default;

// ── Public event channel names ────────────────────────────────────────────────
export const CHANNELS = {
  NEW_TOKENS: 'new-tokens',
  POOL_CREATED: 'pool-created',
  NEW_BLOCKS: 'new-blocks',
  TRIGGER_FIRED: 'trigger-fired',
  EXECUTE_SWAP: 'execute-swap',
  TOKEN_LOOKUP: 'token-lookup',
  AUTO_BUY_SIGNAL: 'auto-buy-signal',
  PRICE_UPDATE: 'price-update',
  NOTIFY_USER: 'notify-user',
} as const;

// ── Event interfaces ──────────────────────────────────────────────────────────

export type EventVenue = 'rhea' | 'shardsmarket' | 'nearlytrade' | 'intear' | 'memecooking';

export interface TokenDetectedEvent {
  type: 'token_detected';
  token_address: string;
  name: string;
  symbol: string;
  decimals: number;
  venue: EventVenue;
  pool_address: string;
  creator: string;
  timestamp: number;
}

export interface PoolCreatedEvent {
  type: 'pool_created';
  token_address: string;
  pool_address: string;
  venue: EventVenue;
  total_supply: string;
  initial_liquidity: string;
  timestamp: number;
}

export interface TriggerEvent {
  type: 'trigger_fired';
  user_id: string;
  position_id: string;
  trigger_type: 'stop_loss' | 'take_profit' | 'market_cap';
  target_value: string;
  current_value: string;
  timestamp: number;
}

export interface SwapEvent {
  type: 'execute_swap';
  user_id: string;
  token_in: string;
  token_out: string;
  amount_in: string;
  min_amount_out: string;
  venue: 'rhea' | 'shardsmarket' | 'nearlytrade' | 'intear';
  dcl_pool_id?: string;
  timestamp?: number;
}

export interface AutoBuySignal {
  type: 'auto_buy_signal';
  user_id: string;
  token_address: string;
  amount_near: string;
  venue: 'rhea' | 'shardsmarket' | 'nearlytrade' | 'intear';
  timestamp: number;
}

export interface PriceUpdateEvent {
  type: 'price_update';
  token_address: string;
  price: number;
  liquidity: number;
  market_cap: number;
  timestamp: number;
}

export interface NotifyUserEvent {
  type: 'notify_user';
  telegram_id: number;
  event:
    | 'rug_check_failed'
    | 'trigger_fired'
    | 'allowance_low'
    | 'pnl_card'
    | 'token_not_found'
    | 'auto_buy_skipped'
    | 'trade_failed'
    | 'trade_confirmed';
  data?: Record<string, unknown>;
}

// ── Redis client abstraction ──────────────────────────────────────────────────

export interface RedisClient {
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string, handler: (message: string) => void): Promise<void>;
  unsubscribe(channel?: string): Promise<void>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  hget(key: string, field: string): Promise<string | null>;
  hset(key: string, fields: Record<string, string>): Promise<void>;
  hgetall(key: string): Promise<Record<string, string>>;
  sadd(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  disconnect(): Promise<void>;
}

/**
 * Create a Redis client backed by ioredis.
 * Separate pub and sub connections are required by Redis protocol —
 * a subscribed connection cannot issue regular commands.
 */
export function createRedis(url: string): RedisClient {
  const options = {
    lazyConnect: false,
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
    // NEVER give up: a Redis restart must not permanently kill swap/trigger
    // pub-sub (returning null ends the connection forever). Bounded backoff.
    retryStrategy(times: number) {
      return Math.min(50 * times, 2000);
    },
  };
  const pub = new Redis(url, options);
  const sub = new Redis(url, options);

  const handlers = new Map<string, (msg: string) => void>();

  sub.on('message', (channel: string, message: string) => {
    const handler = handlers.get(channel);
    if (handler) handler(message);
  });

  pub.on('error', (err: Error) => {
    // suppress repeated connection refuse noise if redis is offline locally
  });
  sub.on('error', (err: Error) => {
    // suppress repeated connection refuse noise if redis is offline locally
  });

  return {
    async publish(channel, message) {
      return pub.publish(channel, message);
    },

    async subscribe(channel, handler) {
      handlers.set(channel, handler);
      await sub.subscribe(channel);
    },

    async unsubscribe(channel?) {
      if (channel) {
        handlers.delete(channel);
        await sub.unsubscribe(channel);
      } else {
        handlers.clear();
        await sub.unsubscribe();
      }
    },

    async get(key) {
      return pub.get(key);
    },

    async set(key, value, ttlSeconds?) {
      if (ttlSeconds) {
        await pub.set(key, value, 'EX', ttlSeconds);
      } else {
        await pub.set(key, value);
      }
    },

    async del(key) {
      await pub.del(key);
    },

    async hget(key, field) {
      return pub.hget(key, field);
    },

    async hset(key, fields) {
      await pub.hset(key, fields);
    },

    async hgetall(key) {
      return pub.hgetall(key) as Promise<Record<string, string>>;
    },

    async sadd(key, ...members) {
      return pub.sadd(key, ...members);
    },

    async smembers(key) {
      return pub.smembers(key);
    },

    async disconnect() {
      await pub.quit();
      await sub.quit();
    },
  };
}