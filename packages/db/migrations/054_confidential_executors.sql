-- Migration 054: confidential trading with per-position executors and NEAR Intents private balances

-- One private balance account per user (an ed25519 key pair; the hex public key is the account)
CREATE TABLE IF NOT EXISTS confidential_accounts (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    private_account_id TEXT UNIQUE NOT NULL,
    public_key TEXT NOT NULL,
    secret_key_encrypted TEXT NOT NULL,
    -- Where executor payouts may go (salted hash only is stored on-chain)
    payout_address TEXT NOT NULL,
    owner_salt TEXT NOT NULL,
    -- Ready pool settings: executor sizes in yoctoNEAR (default 5 x 1 NEAR)
    pool_sizes JSONB NOT NULL DEFAULT '["1000000000000000000000000","1000000000000000000000000","1000000000000000000000000","1000000000000000000000000","1000000000000000000000000"]'::jsonb,
    auto_refill BOOLEAN NOT NULL DEFAULT TRUE,
    buy_mode VARCHAR(10) NOT NULL DEFAULT 'single',
    fleet_stagger_max_sec INTEGER NOT NULL DEFAULT 0,
    round_returns BOOLEAN NOT NULL DEFAULT FALSE,
    pool_cap_yocto NUMERIC(38, 0) NOT NULL DEFAULT 5000000000000000000000000,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per executor account (one position each)
CREATE TABLE IF NOT EXISTS confidential_executors (
    account_id TEXT PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    size_yocto NUMERIC(38, 0) NOT NULL,
    -- creating -> funding -> ready -> open -> exiting -> exited -> closed (failed: needs attention)
    status VARCHAR(12) NOT NULL DEFAULT 'creating',
    token TEXT,
    venue VARCHAR(30),
    position_group TEXT,
    amount_spent NUMERIC(38, 0),
    fee_paid NUMERIC(38, 0),
    returned_amount NUMERIC(38, 0),
    last_error TEXT,
    events JSONB NOT NULL DEFAULT '[]'::jsonb,
    tx_hashes JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    funded_at TIMESTAMPTZ,
    opened_at TIMESTAMPTZ,
    exited_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conf_exec_user_status ON confidential_executors(user_id, status);
CREATE INDEX IF NOT EXISTS idx_conf_exec_status ON confidential_executors(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_conf_exec_position ON confidential_executors(user_id, token) WHERE status = 'open';

-- Every move into or out of a private balance (deposits, refills, returns, withdrawals)
CREATE TABLE IF NOT EXISTS confidential_moves (
    id TEXT PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind VARCHAR(12) NOT NULL, -- deposit | refill | return | withdraw
    executor_account_id TEXT,
    deposit_address TEXT NOT NULL,
    amount NUMERIC(38, 0) NOT NULL,
    destination TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING_DEPOSIT',
    tx_hash TEXT,
    intent_hash TEXT,
    details JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    settled_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conf_moves_user ON confidential_moves(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conf_moves_open ON confidential_moves(status, created_at)
    WHERE status NOT IN ('SUCCESS', 'REFUNDED', 'FAILED', 'INCOMPLETE_DEPOSIT');
