-- Migration 51: Solana chain integration
-- Additive only: no existing column, row or wallet is changed.

-- 1. Solana wallet fields on users (filled for every user on their next /start or bot use)
ALTER TABLE users ADD COLUMN IF NOT EXISTS solana_address VARCHAR(44);
ALTER TABLE users ADD COLUMN IF NOT EXISTS solana_private_key_enc TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_solana_address ON users(solana_address) WHERE solana_address IS NOT NULL;

-- 2. Backfill any Solana wallets that already exist into user_wallets
INSERT INTO user_wallets (user_id, chain, address, name, encrypted_private_key, is_imported, is_active)
SELECT id, 'solana', solana_address, 'Wallet 1', solana_private_key_enc, FALSE, TRUE
FROM users
WHERE solana_address IS NOT NULL AND solana_private_key_enc IS NOT NULL
ON CONFLICT (user_id, chain, address) DO NOTHING;
