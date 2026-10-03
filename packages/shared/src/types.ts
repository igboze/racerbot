export interface UserConfig {
  telegramId: number;
  subaccountId: string;
  defaultBuyPct: number;
  defaultSellPct: number;
  feeTier: string;
}

export interface TokenInfo {
  name: string;
  symbol: string;
  decimals: number;
  total_supply: string;
  price: string;
  liquidity: string;
  marketCap: number;
  holders_count?: number | null;
  holders_count_exact?: boolean;
  buys_count?: number | null;
  sells_count?: number | null;
}

export type VenueName =
  | 'rhea'
  | 'ref'
  | 'shardsmarket'
  | 'nearlytrade'
  | 'intear'
  | 'memecooking'
  | 'onetokenhub'
  | 'gaypad'
  | 'nearpad'
  | 'suipump'
  | 'cetus'
  | 'turbos'
  | 'deepbook'
  | 'sui_dex';

export const TRADABLE_VENUES: readonly VenueName[] = [
  'rhea',
  'ref',
  'shardsmarket',
  'nearlytrade',
  'intear',
  'memecooking',
  'onetokenhub',
  'gaypad',
  'nearpad',
  'suipump',
  'cetus',
  'turbos',
  'deepbook',
  'sui_dex',
];

export function isTradableVenue(v: unknown): v is VenueName {
  return typeof v === 'string' && (TRADABLE_VENUES as readonly string[]).includes(v);
}

export interface SwapRequest {
  user_id: string;
  chain?: 'near' | 'sui';
  token_in: string;
  token_out: string;
  amount_in: string;
  min_amount_out: string;
  venue: VenueName;
  timestamp: number;
  dcl_pool_id?: string;
  pool_id?: number | null;
  intermediate_token?: string | null;
}

export interface TriggerConfig {
  type: 'stop_loss' | 'take_profit' | 'market_cap';
  target_value: number;
  percentage?: number;
}