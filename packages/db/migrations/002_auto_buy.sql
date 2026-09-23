-- Migration 2: Add auto-buy user settings

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS auto_buy_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_buy_amount_near NUMERIC DEFAULT 1,
  ADD COLUMN IF NOT EXISTS auto_buy_min_liquidity_near NUMERIC DEFAULT 500;

-- Index for fast auto-buy user lookup in detector
CREATE INDEX IF NOT EXISTS idx_users_auto_buy ON users(auto_buy_enabled) WHERE auto_buy_enabled = true;
