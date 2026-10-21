-- Migration 046: RacerAlpha Confidential Social Trading Suite Enhancements

ALTER TABLE racer_alpha_traders
    ADD COLUMN IF NOT EXISTS strategy_tag VARCHAR(50) DEFAULT 'Trend Following',
    ADD COLUMN IF NOT EXISTS risk_score NUMERIC(3, 1) DEFAULT 3.2,
    ADD COLUMN IF NOT EXISTS risk_level VARCHAR(20) DEFAULT 'MEDIUM',
    ADD COLUMN IF NOT EXISTS max_drawdown_pct NUMERIC(5, 2) DEFAULT -12.4,
    ADD COLUMN IF NOT EXISTS followers_count INT DEFAULT 450,
    ADD COLUMN IF NOT EXISTS equity_curve JSONB DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS tier_basic_price_near NUMERIC(10, 2) DEFAULT 1.50,
    ADD COLUMN IF NOT EXISTS tier_copy_price_near NUMERIC(10, 2) DEFAULT 3.50,
    ADD COLUMN IF NOT EXISTS tier_premium_price_near NUMERIC(10, 2) DEFAULT 8.00,
    ADD COLUMN IF NOT EXISTS terminal_token TEXT,
    ADD COLUMN IF NOT EXISTS public_pnl_visible BOOLEAN DEFAULT TRUE;

ALTER TABLE racer_alpha_keys
    ADD COLUMN IF NOT EXISTS tier VARCHAR(20) DEFAULT 'copy',
    ADD COLUMN IF NOT EXISTS allocation_pct NUMERIC(5, 2) DEFAULT 25.0,
    ADD COLUMN IF NOT EXISTS risk_multiplier NUMERIC(3, 1) DEFAULT 1.5,
    ADD COLUMN IF NOT EXISTS stop_loss_pct NUMERIC(5, 2) DEFAULT -8.0;

CREATE TABLE IF NOT EXISTS racer_alpha_positions (
    id TEXT PRIMARY KEY DEFAULT uuid_generate_v4()::text,
    trader_id TEXT NOT NULL,
    symbol VARCHAR(30) NOT NULL,
    token_address TEXT NOT NULL,
    side VARCHAR(10) NOT NULL DEFAULT 'LONG',
    size_tokens NUMERIC(24, 6) NOT NULL,
    entry_price_usd NUMERIC(16, 4) NOT NULL,
    current_price_usd NUMERIC(16, 4) NOT NULL,
    pnl_usd NUMERIC(16, 2) NOT NULL,
    pnl_pct NUMERIC(10, 2) NOT NULL,
    sparkline JSONB DEFAULT '[]'::jsonb,
    is_confidential BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alpha_positions_trader ON racer_alpha_positions(trader_id, updated_at DESC);
