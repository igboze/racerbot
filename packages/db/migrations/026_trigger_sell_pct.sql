-- Migration 026: Add sell_pct to triggers
-- sell_pct defines what percentage of the position to sell when the trigger fires.
-- Default 100 preserves existing behaviour (sell entire position).
ALTER TABLE triggers
  ADD COLUMN IF NOT EXISTS sell_pct NUMERIC NOT NULL DEFAULT 100
    CHECK (sell_pct > 0 AND sell_pct <= 100);
