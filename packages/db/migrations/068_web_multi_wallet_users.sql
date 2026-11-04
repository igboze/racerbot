-- Migration 068: Web multi-wallet users support (EVM, Solana, NEAR)
-- Allow users registered purely via external wallets on the WebApp to have telegram_id NULL or 0
-- without colliding on the users_telegram_id_key constraint.

ALTER TABLE users ALTER COLUMN telegram_id DROP NOT NULL;

-- Replace strict unique constraint with partial unique index for positive telegram_ids
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_telegram_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_telegram_id_unique ON users(telegram_id) WHERE telegram_id IS NOT NULL AND telegram_id > 0;

-- Ensure index on solana_address and evm_address for fast lookup
CREATE INDEX IF NOT EXISTS idx_users_solana_address ON users(solana_address);
CREATE INDEX IF NOT EXISTS idx_users_evm_address ON users(evm_address);
