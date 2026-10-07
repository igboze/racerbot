-- Migration 28: Add buy/sell tax and safety status to token_cache
-- Enables permanent storage of discovered DEX fees and security audit results
-- so the bot never has to re-probe 25 DCL pool fee tiers or WASM exports on every view.

ALTER TABLE token_cache ADD COLUMN IF NOT EXISTS buy_tax_pct NUMERIC;
ALTER TABLE token_cache ADD COLUMN IF NOT EXISTS sell_tax_pct NUMERIC;
ALTER TABLE token_cache ADD COLUMN IF NOT EXISTS is_safe BOOLEAN;
