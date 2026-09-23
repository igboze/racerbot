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

export interface SwapRequest {
  user_id: string;
  token_in: string;
  token_out: string;
  amount_in: string;
  min_amount_out: string;
  venue: 'rhea' | 'shardsmarket' | 'nearlytrade';
  timestamp: number;
}

export interface TriggerConfig {
  type: 'stop_loss' | 'take_profit' | 'market_cap';
  target_value: number;
  percentage?: number;
}

export interface PnLCard {
  tokenName: string;
  tokenTicker: string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  realizedPnlNear: number;
  realizedPnlPercent: number;
  holdDuration: string;
}