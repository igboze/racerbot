-- Migration 047: RacerAlpha Creator Studio Production Build & $10k Trade Volume Gating

ALTER TABLE racer_alpha_traders
    ADD COLUMN IF NOT EXISTS entry_fee_paid_near NUMERIC(10, 2) DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS entry_fee_tx_hash TEXT,
    ADD COLUMN IF NOT EXISTS verified_trade_volume_usd NUMERIC(16, 2) DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS is_creator_approved BOOLEAN DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS copy_fee_pct NUMERIC(5, 2) DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS payout_wallet_address TEXT;

-- Table to log and verify creator entry fee payments
CREATE TABLE IF NOT EXISTS racer_alpha_creator_payments (
    id TEXT PRIMARY KEY DEFAULT uuid_generate_v4()::text,
    user_id TEXT NOT NULL,
    wallet_address TEXT NOT NULL,
    amount_near NUMERIC(10, 2) NOT NULL DEFAULT 5.00,
    tx_hash TEXT,
    verified_volume_usd NUMERIC(16, 2) NOT NULL DEFAULT 0.00,
    status VARCHAR(20) NOT NULL DEFAULT 'completed',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alpha_creator_payments_user ON racer_alpha_creator_payments(user_id);
CREATE INDEX IF NOT EXISTS idx_alpha_creator_payments_wallet ON racer_alpha_creator_payments(wallet_address);

-- Clean up legacy dummy / seed trader personas from alpha marketplace
DELETE FROM racer_alpha_positions 
WHERE trader_id IN (
    SELECT id FROM racer_alpha_traders 
    WHERE user_id IN ('aa7a0c99-23d2-4924-bb8b-b4608093c950', '6265e30d-2026-4196-b5e3-62e3f1469976', 'system_alpha')
);

DELETE FROM racer_alpha_signals 
WHERE trader_id IN (
    SELECT id FROM racer_alpha_traders 
    WHERE user_id IN ('aa7a0c99-23d2-4924-bb8b-b4608093c950', '6265e30d-2026-4196-b5e3-62e3f1469976', 'system_alpha')
);

DELETE FROM racer_alpha_keys 
WHERE trader_id IN (
    SELECT id FROM racer_alpha_traders 
    WHERE user_id IN ('aa7a0c99-23d2-4924-bb8b-b4608093c950', '6265e30d-2026-4196-b5e3-62e3f1469976', 'system_alpha')
);

DELETE FROM racer_alpha_traders 
WHERE user_id IN ('aa7a0c99-23d2-4924-bb8b-b4608093c950', '6265e30d-2026-4196-b5e3-62e3f1469976', 'system_alpha');
