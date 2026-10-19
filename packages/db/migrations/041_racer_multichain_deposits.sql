-- Migration 041: Multi-chain deposit tracking for NEAR Intents 1Click solver
CREATE TABLE IF NOT EXISTS racer_deposits (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    deposit_id TEXT UNIQUE NOT NULL,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    telegram_id BIGINT NOT NULL,
    subaccount_id TEXT NOT NULL,
    source_chain TEXT NOT NULL,
    source_asset TEXT NOT NULL,
    source_symbol TEXT,
    source_amount NUMERIC,
    destination_chain TEXT NOT NULL DEFAULT 'near',
    destination_asset TEXT NOT NULL DEFAULT 'nep141:wrap.near',
    destination_symbol TEXT NOT NULL DEFAULT 'NEAR',
    destination_address TEXT NOT NULL,
    deposit_address TEXT NOT NULL,
    min_destination_amount NUMERIC,
    fee_amount NUMERIC DEFAULT 0,
    fee_recipient TEXT DEFAULT 'racerbottreasury.near',
    fee_bps INTEGER DEFAULT 100,
    status TEXT NOT NULL DEFAULT 'PENDING',
    quote_data JSONB,
    tx_hash TEXT,
    unwrapped BOOLEAN DEFAULT FALSE,
    unwrapped_amount NUMERIC DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_racer_deposits_telegram ON racer_deposits(telegram_id);
CREATE INDEX IF NOT EXISTS idx_racer_deposits_subaccount ON racer_deposits(subaccount_id);
CREATE INDEX IF NOT EXISTS idx_racer_deposits_status ON racer_deposits(status);
CREATE INDEX IF NOT EXISTS idx_racer_deposits_deposit_addr ON racer_deposits(deposit_address);
