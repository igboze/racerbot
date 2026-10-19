-- Migration 042: RacerAlpha Confidential Social Trading & Viewing Key Marketplace

CREATE TABLE IF NOT EXISTS racer_alpha_traders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    telegram_id BIGINT,
    handle VARCHAR(50) NOT NULL UNIQUE,
    display_name VARCHAR(100) NOT NULL,
    bio TEXT,
    avatar_url TEXT,
    key_price_near NUMERIC(10, 2) NOT NULL DEFAULT 2.00,
    max_keys INT NOT NULL DEFAULT 100,
    keys_sold INT NOT NULL DEFAULT 0,
    verified_pnl_pct NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
    win_rate_pct NUMERIC(5, 2) NOT NULL DEFAULT 0.00,
    total_trades INT NOT NULL DEFAULT 0,
    winning_trades INT NOT NULL DEFAULT 0,
    total_volume_near NUMERIC(16, 4) NOT NULL DEFAULT 0,
    total_revenue_near NUMERIC(16, 4) NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    viewing_salt TEXT NOT NULL DEFAULT md5(random()::text),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alpha_traders_pnl ON racer_alpha_traders(verified_pnl_pct DESC);
CREATE INDEX IF NOT EXISTS idx_alpha_traders_user ON racer_alpha_traders(user_id);
CREATE INDEX IF NOT EXISTS idx_alpha_traders_active ON racer_alpha_traders(is_active);

CREATE TABLE IF NOT EXISTS racer_alpha_keys (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    trader_id UUID NOT NULL REFERENCES racer_alpha_traders(id) ON DELETE CASCADE,
    buyer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    buyer_telegram_id BIGINT,
    price_paid_near NUMERIC(10, 2) NOT NULL,
    key_token TEXT NOT NULL UNIQUE,
    auto_copy_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    auto_copy_amount_near NUMERIC(10, 2) NOT NULL DEFAULT 1.00,
    expires_at TIMESTAMPTZ, -- null = permanent key, date = subscription
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_trader_buyer UNIQUE (trader_id, buyer_user_id)
);

CREATE INDEX IF NOT EXISTS idx_alpha_keys_buyer ON racer_alpha_keys(buyer_user_id);
CREATE INDEX IF NOT EXISTS idx_alpha_keys_trader ON racer_alpha_keys(trader_id);

CREATE TABLE IF NOT EXISTS racer_alpha_signals (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    trader_id UUID NOT NULL REFERENCES racer_alpha_traders(id) ON DELETE CASCADE,
    token_address TEXT NOT NULL,
    token_symbol VARCHAR(30) NOT NULL,
    token_name VARCHAR(100) NOT NULL,
    side VARCHAR(10) NOT NULL, -- 'BUY' | 'SELL'
    price_near NUMERIC(24, 8) NOT NULL,
    market_cap_usd NUMERIC(16, 2) NOT NULL DEFAULT 0,
    amount_near NUMERIC(16, 4) NOT NULL,
    pnl_pct NUMERIC(10, 2),
    tx_hash TEXT,
    venue VARCHAR(50) DEFAULT 'near_intents_confidential',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alpha_signals_trader ON racer_alpha_signals(trader_id, created_at DESC);
