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
}

export type VenueName = 'rhea' | 'shardsmarket' | 'nearlytrade' | 'intear' | 'onetokenhub' | 'gaypad';

export const TRADABLE_VENUES: readonly VenueName[] = ['rhea', 'shardsmarket', 'nearlytrade', 'intear', 'onetokenhub', 'gaypad'];

export function isTradableVenue(v: unknown): v is VenueName {
  return typeof v === 'string' && (TRADABLE_VENUES as readonly string[]).includes(v);
}

export interface SwapRequest {
  user_id: string;
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

export interface PnLCard {
  tokenName?: string;
  tokenTicker?: string;
  botName?: string;
  tokenSymbol: string;
  pairSymbol?: string;
  side?: 'long' | 'short';
  entryPrice: number;
  currentPrice: number;
  exitPrice?: number;
  quantity?: number;
  realizedPnlNear?: number;
  realizedPnlPercent?: number;
  pnlPercent?: number;
  entryMcap?: number;
  currentMcap?: number;
  positionSize?: number;
  positionUnit?: string;
  profitAmount?: number;
  profitUnit?: string;
  duration?: string;
  holdDuration?: string;
  handle?: string;
  date?: string;
  tokenAddress?: string;
  positionId?: string;
}