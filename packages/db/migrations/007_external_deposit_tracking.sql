-- Migration 7: Add external deposit tracking to positions table

ALTER TABLE positions ADD COLUMN IF NOT EXISTS is_external_deposit BOOLEAN DEFAULT FALSE;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS external_deposit_detected_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_positions_external_deposit ON positions(is_external_deposit);
