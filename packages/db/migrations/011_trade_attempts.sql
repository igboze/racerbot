-- Migration 011: trade attempt observability.
-- One row per attempted swap (before execution), updated with the outcome and
-- per-stage timings (presign / sign+confirm / post). Powers failure analysis
-- without relying on ephemeral service logs.

CREATE TABLE IF NOT EXISTS trade_attempts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
    venue TEXT NOT NULL,
    token_in TEXT NOT NULL,
    token_out TEXT NOT NULL,
    amount_in NUMERIC NOT NULL,
    min_amount_out NUMERIC,
    slippage_pct DOUBLE PRECISION,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed')),
    tx_hash TEXT,
    error TEXT,
    timings JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trade_attempts_user_created ON trade_attempts(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trade_attempts_status_created ON trade_attempts(status, created_at DESC);
