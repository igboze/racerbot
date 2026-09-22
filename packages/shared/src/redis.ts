export interface RedisClient {
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  publish: (channel: string, message: string) => Promise<number>;
  subscribe: (channel: string, handler: (message: string) => void) => Promise<void>;
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string, ttlSeconds?: number) => Promise<void>;
  del: (key: string) => Promise<void>;
  hget: (key: string, field: string) => Promise<string | null>;
  hset: (key: string, fields: Record<string, string>) => Promise<void>;
  hgetall: (key: string) => Promise<Record<string, string>>;
  sadd: (key: string, ...members: string[]) => Promise<number>;
  smembers: (key: string) => Promise<string[]>;
}

export interface MessageBus {
  publish: (channel: string, message: object) => Promise<void>;
  subscribe: (channel: string, handler: (message: object) => void) => Promise<void>;
}

export const CHANNELS = {
  NEW_TOKENS: 'new-tokens',
  POOL_CREATED: 'pool-created',
  NEW_BLOCKS: 'new-blocks',
  TRIGGER_FIRED: 'trigger-fired',
  EXECUTE_SWAP: 'execute-swap',
  TOKEN_LOOKUP: 'token-lookup',
  AUTO_BUY_SIGNAL: 'auto-buy-signal',
} as const;

export interface TokenDetectedEvent {
  type: 'token_detected';
  token_address: string;
  name: string;
  symbol: string;
  decimals: number;
  venue: 'rhea' | 'shardsmarket';
  pool_address: string;
  creator: string;
  timestamp: number;
}

export interface PoolCreatedEvent {
  type: 'pool_created';
  token_address: string;
  pool_address: string;
  venue: 'rhea' | 'shardsmarket';
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
  venue: 'rhea' | 'shardsmarket';
  timestamp: number;
}