-- Migration 040: RaceFleet Fills & Independent PnL Tracking
-- Isolates multi-wallet fleet execution records and PnL completely from the personal trading account.

CREATE TABLE IF NOT EXISTS race_fleet_fills (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    fleet_id UUID NOT NULL REFERENCES race_fleets(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    wallet_account_id TEXT,
    side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
    token_address TEXT NOT NULL,
    amount NUMERIC NOT NULL,
    price NUMERIC NOT NULL,
    fee_paid NUMERIC NOT NULL DEFAULT 0,
    venue TEXT NOT NULL DEFAULT 'ref',
    tx_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_race_fleet_fills_fleet_token ON race_fleet_fills (fleet_id, token_address);
CREATE INDEX IF NOT EXISTS idx_race_fleet_fills_user ON race_fleet_fills (user_id);
CREATE INDEX IF NOT EXISTS idx_race_fleet_fills_created ON race_fleet_fills (fleet_id, created_at DESC);
