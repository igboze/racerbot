-- Migration 19: Copy Trading & DCA Orders

-- ── Copy Trading Targets ──────────────────────────────────────────────────────
-- Each row = one follower watching one target NEAR wallet.
CREATE TABLE IF NOT EXISTS copy_trade_targets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- The NEAR account being watched (can be any valid NEAR account id)
    target_wallet TEXT NOT NULL,
    -- Optional referrer who shared the copy trade link (earns 5% fees)
    referrer_id UUID REFERENCES users(id) ON DELETE SET NULL,
    -- Amount in NEAR to spend per copied buy (e.g. 2.0)
    buy_amount_near NUMERIC NOT NULL DEFAULT 1.0,
    -- When true, sell proportionally whenever the target sells
    copy_sells BOOLEAN NOT NULL DEFAULT true,
    -- Skip the copy if price impact exceeds this % (protect against front-running)
    max_slippage_pct NUMERIC NOT NULL DEFAULT 5.0,
    -- Safety cap: maximum NEAR that can be auto-spent per calendar day
    max_daily_budget_near NUMERIC,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'paused', 'stopped')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT copy_targets_user_wallet UNIQUE (user_id, target_wallet)
);

CREATE INDEX IF NOT EXISTS idx_copy_targets_user_status
    ON copy_trade_targets(user_id, status);

-- Active index for the detector hot-path: find all followers for a given wallet
CREATE INDEX IF NOT EXISTS idx_copy_targets_wallet_active
    ON copy_trade_targets(target_wallet, status)
    WHERE status = 'active';

-- ── Copy Trade Fills (audit log linking follower fill → source copy target) ───
CREATE TABLE IF NOT EXISTS copy_trade_fills (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    copy_target_id UUID NOT NULL REFERENCES copy_trade_targets(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- The on-chain tx that the source wallet made (for dedup / audit)
    source_tx_hash TEXT NOT NULL,
    token_address TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
    -- Our fill: token amount received / spent
    amount_token NUMERIC,
    -- NEAR spent (buy) or received (sell)
    amount_near NUMERIC,
    -- tx hash of OUR resulting swap (null until executor confirms)
    our_tx_hash TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'filled', 'failed', 'skipped')),
    skip_reason TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT copy_fills_dedup UNIQUE (copy_target_id, source_tx_hash, side)
);

CREATE INDEX IF NOT EXISTS idx_copy_fills_user ON copy_trade_fills(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_copy_fills_target ON copy_trade_fills(copy_target_id, created_at DESC);

-- ── DCA Orders ────────────────────────────────────────────────────────────────
-- One row per scheduled DCA order; the triggers engine evaluates these.
CREATE TABLE IF NOT EXISTS dca_orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_address TEXT NOT NULL,
    -- 'buy'  = spend NEAR to buy token on each tick
    -- 'sell' = sell token to receive NEAR on each tick
    side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
    -- How much to spend/sell per execution tick
    amount_per_order NUMERIC NOT NULL,
    -- Interval between ticks in seconds (e.g. 3600 = 1h)
    interval_seconds INT NOT NULL,
    -- Total number of scheduled orders (0 = unlimited, run until cancelled)
    total_orders INT NOT NULL DEFAULT 0,
    -- How many have successfully executed so far
    executed_orders INT NOT NULL DEFAULT 0,
    -- Timestamp of the next scheduled execution
    next_run_at TIMESTAMPTZ NOT NULL,
    -- Optional price guards (skip tick if violated)
    -- For buys:  skip if current price > max_price
    -- For sells: skip if current price < min_price
    min_price NUMERIC,
    max_price NUMERIC,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'paused', 'completed', 'cancelled')),
    -- Rich error from last failed tick (non-fatal; order stays active)
    last_error TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dca_orders_user_status
    ON dca_orders(user_id, status);

-- Hot-path index for the DCA runner: find all ticks that are due now
CREATE INDEX IF NOT EXISTS idx_dca_orders_due
    ON dca_orders(next_run_at, status)
    WHERE status = 'active';
