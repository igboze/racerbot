-- Migration 066: charge the creator's copy profit share on copied trades.
-- Cost basis of what auto-copy bought for each follower, per creator and token,
-- so a sell only shares the profit made on copied tokens.
CREATE TABLE IF NOT EXISTS racer_alpha_copy_positions (
  user_id TEXT NOT NULL,
  trader_id TEXT NOT NULL,
  token_address TEXT NOT NULL,
  cost_near NUMERIC NOT NULL DEFAULT 0,
  qty_raw NUMERIC NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, trader_id, token_address)
);

-- One row per copied sell that owed a profit share; the unique key stops a signal charging twice.
CREATE TABLE IF NOT EXISTS racer_alpha_copy_fees (
  id TEXT PRIMARY KEY,
  signal_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  trader_id TEXT NOT NULL,
  token_address TEXT NOT NULL,
  profit_near NUMERIC NOT NULL,
  fee_pct NUMERIC NOT NULL,
  fee_near NUMERIC NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  tx_hash TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (signal_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_racer_alpha_copy_fees_trader ON racer_alpha_copy_fees (trader_id, created_at DESC);
