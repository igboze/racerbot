-- Migration 003: Add nearlytrade bonding phase and progress to token_cache

ALTER TABLE token_cache ADD COLUMN IF NOT EXISTS bonding_phase TEXT;
ALTER TABLE token_cache ADD COLUMN IF NOT EXISTS bonding_progress_pct NUMERIC(5,2);
ALTER TABLE token_cache ADD COLUMN IF NOT EXISTS dcl_pool_id TEXT;
