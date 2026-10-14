-- Migration 35: Wallet balance tracking for persistent deposit detection across restarts and deployments

ALTER TABLE users ADD COLUMN IF NOT EXISTS last_near_balance NUMERIC;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_sui_balance NUMERIC;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_strk_balance NUMERIC;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_balance_check_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_last_balance_check ON users(last_balance_check_at);
