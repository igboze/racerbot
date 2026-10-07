-- Migration 029: Limit Orders (DEX conditional orders)
-- Supports Limit Buy (dips/breakouts) and Limit Sell (take profit/stop loss) on NEAR.

CREATE TABLE IF NOT EXISTS limit_orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chain TEXT NOT NULL DEFAULT 'near',
    token_address TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),

    -- Target metrics: mcap ($), price ($), or percent_offset
    target_type TEXT NOT NULL CHECK (target_type IN ('mcap', 'price', 'percent_offset')),
    trigger_condition TEXT NOT NULL CHECK (trigger_condition IN ('lte', 'gte')),
    target_value NUMERIC NOT NULL,       -- Absolute target price in USD or target MC in USD
    reference_price NUMERIC,             -- Price at order creation (for audit/analytics)
    reference_mcap NUMERIC,              -- Market cap at order creation

    -- Order amounts
    amount_input NUMERIC NOT NULL,       -- NEAR to spend (for buy) or token raw amount / sell pct
    sell_pct NUMERIC,                    -- e.g. 50% if selling a position percentage
    max_slippage_pct NUMERIC NOT NULL DEFAULT 3.0,

    -- Expiry & Lifecycle
    expires_at TIMESTAMPTZ,              -- NULL = Good 'Til Cancelled (never expires)
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'executing', 'filled', 'cancelled', 'failed', 'expired')),

    -- Execution audit
    fill_tx_hash TEXT,
    fill_price NUMERIC,
    failure_reason TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_limit_orders_active
    ON limit_orders (status, token_address)
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_limit_orders_user
    ON limit_orders (user_id, status);

CREATE INDEX IF NOT EXISTS idx_limit_orders_expiry
    ON limit_orders (expires_at, status)
    WHERE status = 'active';
