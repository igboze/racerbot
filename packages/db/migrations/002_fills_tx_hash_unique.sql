-- Migration: fills tx_hash unique constraint, user slippage setting, and token_cache rhea_pool_id

-- 1. Enforce unique tx_hash on fills for idempotent fill recording
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_fills_tx_hash'
    ) THEN
        ALTER TABLE fills ADD CONSTRAINT uq_fills_tx_hash UNIQUE (tx_hash);
    END IF;
END $$;

-- 2. Add user configurable slippage tolerance (default 2%)
ALTER TABLE users ADD COLUMN IF NOT EXISTS slippage_pct NUMERIC NOT NULL DEFAULT 2;

-- 3. Cache discovered Rhea pool IDs
ALTER TABLE token_cache ADD COLUMN IF NOT EXISTS rhea_pool_id BIGINT;
