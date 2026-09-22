-- Migration 1: Create all tables

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    telegram_id BIGINT UNIQUE NOT NULL,
    subaccount_id TEXT UNIQUE NOT NULL,
    scoped_key_encrypted TEXT NOT NULL,
    default_buy_pct NUMERIC,
    default_sell_pct NUMERIC,
    fee_tier TEXT DEFAULT 'standard',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE positions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    token_address TEXT NOT NULL,
    quantity_held NUMERIC NOT NULL,
    avg_entry_price NUMERIC NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    opened_at TIMESTAMPTZ DEFAULT NOW(),
    closed_at TIMESTAMPTZ
);

CREATE INDEX idx_positions_user_status ON positions(user_id, status);

CREATE TABLE fills (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    position_id UUID REFERENCES positions(id) ON DELETE CASCADE,
    side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
    token_address TEXT NOT NULL,
    amount NUMERIC NOT NULL,
    price NUMERIC NOT NULL,
    fee_paid NUMERIC NOT NULL,
    venue TEXT NOT NULL CHECK (venue IN ('rhea', 'shardsmarket')),
    tx_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_fills_position ON fills(position_id);

CREATE TABLE triggers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    position_id UUID REFERENCES positions(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('stop_loss', 'take_profit', 'market_cap')),
    target_value NUMERIC NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_triggers_status_type ON triggers(status, type);

CREATE TABLE token_cache (
    token_address TEXT PRIMARY KEY,
    name TEXT,
    symbol TEXT,
    decimals INT,
    pool_address TEXT,
    venue TEXT,
    last_price NUMERIC,
    last_liquidity NUMERIC,
    updated_at TIMESTAMPTZ
);

CREATE TABLE fee_ledger (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    fill_id UUID REFERENCES fills(id) ON DELETE CASCADE,
    amount NUMERIC NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create a function for atomic weighted average position update
CREATE OR REPLACE FUNCTION update_position_fill(
    p_position_id UUID,
    p_side TEXT,
    p_amount NUMERIC,
    p_price NUMERIC,
    p_fee NUMERIC
) RETURNS VOID AS $$
DECLARE
    v_position RECORD;
    v_new_qty NUMERIC;
    v_new_avg NUMERIC;
    v_realized NUMERIC;
    v_total_cost NUMERIC;
BEGIN
    SELECT * INTO v_position FROM positions WHERE id = p_position_id AND status = 'open';

    IF NOT FOUND THEN
        INSERT INTO positions (id, user_id, token_address, quantity_held, avg_entry_price, status, opened_at)
        VALUES (p_position_id, (SELECT user_id FROM fills WHERE id = p_position_id LIMIT 1), p_position_id, p_amount, p_price, 'open', NOW());
        RETURN;
    END IF;

    IF p_side = 'buy' THEN
        v_total_cost := v_position.avg_entry_price * v_position.quantity_held + (p_price + p_fee) * p_amount;
        v_new_qty := v_position.quantity_held + p_amount;
        v_new_avg := v_total_cost / v_new_qty;

        UPDATE positions SET
            quantity_held = v_new_qty,
            avg_entry_price = v_new_avg
        WHERE id = p_position_id;

    ELSIF p_side = 'sell' THEN
        v_realized := (p_price - v_position.avg_entry_price) * p_amount - p_fee * p_amount;
        v_new_qty := v_position.quantity_held - p_amount;

        IF v_new_qty <= 0 THEN
            UPDATE positions SET
                quantity_held = 0,
                status = 'closed',
                closed_at = NOW()
            WHERE id = p_position_id;
        ELSE
            UPDATE positions SET
                quantity_held = v_new_qty
            WHERE id = p_position_id;
        END IF;
    END IF;
END;
$$ LANGUAGE plpgsql;