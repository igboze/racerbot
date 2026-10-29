-- Migration 053: trade receipts for Racer router (racerbotrouter.near) intents
-- Stores the router's own events per trade so receipts show exactly what happened on-chain.

ALTER TABLE racer_vault_intents
    ADD COLUMN IF NOT EXISTS events JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS payout_token TEXT,
    ADD COLUMN IF NOT EXISTS payout_amount NUMERIC(38, 0),
    ADD COLUMN IF NOT EXISTS refunded_amount NUMERIC(38, 0),
    ADD COLUMN IF NOT EXISTS consumed_amount NUMERIC(38, 0),
    ADD COLUMN IF NOT EXISTS checked_at TIMESTAMPTZ;

-- The background re-check scans unresolved trades
CREATE INDEX IF NOT EXISTS idx_vault_intents_pending ON racer_vault_intents(status, created_at) WHERE status = 'PENDING';
