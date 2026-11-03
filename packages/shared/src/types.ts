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
  buys_count?: number | null;
  sells_count?: number | null;
  trades_timeframe?: string | null;
  total_txns?: number | null;
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
  | 'shoremarkets'
  | 'kelytra'
  | 'nearpumpfun'
  | 'qlyphs'
  | 'suipump'
  | 'cetus'
  | 'turbos'
  | 'deepbook'
  | 'bluefin'
  | 'flowx'
  | 'aftermath'
  | 'kriya'
  | 'momentum'
  | 'sui_dex'
  | 'avnu'
  | 'ekubo'
  | 'launchy'
  | 'unruggable'
  | 'jediswap'
  | 'stark_dex'
  | 'pumpfun'
  | 'pumpswap'
  | 'jupiter'
  | 'hyperevm_dex'
  | 'elysium_dex'
  | 'market_lab'
  | 'corepad'
  | 'kleos'
  | 'ronspad'
  | 'intents';

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
  'shoremarkets',
  'kelytra',
  'nearpumpfun',
  'qlyphs',
  'suipump',
  'cetus',
  'turbos',
  'deepbook',
  'bluefin',
  'flowx',
  'aftermath',
  'kriya',
  'momentum',
  'sui_dex',
  'avnu',
  'ekubo',
  'launchy',
  'unruggable',
  'jediswap',
  'stark_dex',
  'pumpfun',
  'pumpswap',
  'jupiter',
  'hyperevm_dex',
  'elysium_dex',
  'market_lab',
  'corepad',
];

export function isTradableVenue(v: unknown): v is VenueName {
  return typeof v === 'string' && (TRADABLE_VENUES as readonly string[]).includes(v);
}

export type SupportedChain = 'near' | 'sui' | 'starknet' | 'solana' | 'hyperevm' | 'elysium';

export interface SwapRequest {
  user_id: string;
  chain?: SupportedChain;
  token_in: string;
  token_out: string;
  amount_in: string;
  min_amount_out: string;
  venue: VenueName;
  timestamp: number;
  dcl_pool_id?: string;
  pool_id?: number | null;
  intermediate_token?: string | null;
  gas_token?: 'STRK' | 'ETH';
}

export interface TriggerConfig {
  type: 'stop_loss' | 'take_profit' | 'market_cap';
  target_value: number;
  percentage?: number;
}