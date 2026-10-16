-- Migration 039: RaceFleet - Coordinated Multi-Wallet Fleet Trading Engine
-- Supports 1-click bundle buy/sell, fleet-wide limit orders, TP/SL, volume maker, and sweeping.

CREATE TABLE IF NOT EXISTS race_fleets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT 'Alpha Fleet',
    fleet_tag TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'expired', 'paused')),
    wallet_count INT NOT NULL DEFAULT 5 CHECK (wallet_count >= 1 AND wallet_count <= 25),
    monthly_fee_near NUMERIC NOT NULL DEFAULT 2.0,
    starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    auto_renew BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_user_active_fleet UNIQUE (user_id)
);

CREATE TABLE IF NOT EXISTS race_fleet_wallets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    fleet_id UUID NOT NULL REFERENCES race_fleets(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL UNIQUE,
    wallet_index INT NOT NULL,
    encrypted_private_key TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_fleet_wallet_index UNIQUE (fleet_id, wallet_index)
);

CREATE TABLE IF NOT EXISTS race_fleet_orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    fleet_id UUID NOT NULL REFERENCES race_fleets(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_address TEXT NOT NULL,
    order_type TEXT NOT NULL
        CHECK (order_type IN ('limit_buy', 'limit_sell', 'tp_sl', 'volume_maker', 'pre_snipe')),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'executing', 'filled', 'cancelled', 'failed', 'paused')),
    amount_per_wallet NUMERIC NOT NULL DEFAULT 0,
    sell_pct NUMERIC,
    target_type TEXT CHECK (target_type IN ('mcap', 'price', 'percent_offset')),
    trigger_condition TEXT CHECK (trigger_condition IN ('lte', 'gte')),
    target_value NUMERIC,
    sl_percent NUMERIC,
    tp_percent NUMERIC,
    max_slippage_pct NUMERIC NOT NULL DEFAULT 3.0,
    volume_interval_sec INT DEFAULT 30,
    last_executed_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    fill_summary JSONB,
    failure_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for lightning fast lookups
CREATE INDEX IF NOT EXISTS idx_race_fleets_user ON race_fleets (user_id, status);
CREATE INDEX IF NOT EXISTS idx_race_fleets_expiry ON race_fleets (expires_at, status);
CREATE INDEX IF NOT EXISTS idx_race_fleet_wallets_fleet ON race_fleet_wallets (fleet_id, is_active);
CREATE INDEX IF NOT EXISTS idx_race_fleet_wallets_user ON race_fleet_wallets (user_id);
CREATE INDEX IF NOT EXISTS idx_race_fleet_orders_active ON race_fleet_orders (status, token_address) WHERE status = 'active';
