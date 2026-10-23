-- Migration 050: Racer Shielded Vault & Relayer Intents Ledger
-- Tracks all off-chain and on-chain intent lifecycles for auditability and support

CREATE TABLE IF NOT EXISTS racer_vault_intents (
    id TEXT PRIMARY KEY,
    correlation_id TEXT UNIQUE NOT NULL,
    user_id TEXT,
    account_id TEXT NOT NULL,
    venue VARCHAR(30) NOT NULL,
    token_in TEXT NOT NULL,
    token_out TEXT NOT NULL,
    amount_in NUMERIC(38, 0) NOT NULL,
    amount_in_formatted NUMERIC(20, 6),
    min_amount_out NUMERIC(38, 0) NOT NULL,
    min_amount_out_formatted NUMERIC(20, 6),
    amount_out NUMERIC(38, 0),
    amount_out_formatted NUMERIC(20, 6),
    fee_bps INT DEFAULT 150,
    fee_amount NUMERIC(38, 0),
    status VARCHAR(30) NOT NULL DEFAULT 'PENDING', -- PENDING, SETTLED, FAILED, SLIPPAGE_REFUNDED, EXPIRED
    tx_hash TEXT,
    failure_reason TEXT,
    hops JSONB DEFAULT '[]'::jsonb,
    nonce BYTEA NOT NULL,
    deadline BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vault_intents_account ON racer_vault_intents(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vault_intents_correlation ON racer_vault_intents(correlation_id);
CREATE INDEX IF NOT EXISTS idx_vault_intents_status ON racer_vault_intents(status);
