-- Migration 027: Add auto_buy_max_market_cap_usd to users
-- Allows users to enforce a maximum market cap ceiling (in USD) for auto-bought tokens.
-- Default is 100000 ($100k USD), preventing auto-buys on unexpectedly high market-cap tokens.
-- 0 or NULL means no upper limit.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS auto_buy_max_market_cap_usd NUMERIC DEFAULT 100000;
