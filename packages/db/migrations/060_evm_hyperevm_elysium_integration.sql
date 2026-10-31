-- Migration 60: Unified EVM (HyperEVM & Elysium Kinetiq L2) integration
-- Additive only: no existing column, row or wallet is changed.

-- 1. EVM wallet fields on users (unified for HyperEVM & Elysium on next /start or bot use)
ALTER TABLE users ADD COLUMN IF NOT EXISTS evm_address VARCHAR(42);
ALTER TABLE users ADD COLUMN IF NOT EXISTS evm_private_key_enc TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_evm_address ON users(evm_address) WHERE evm_address IS NOT NULL;

-- 2. Backfill into user_wallets for both hyperevm and elysium
INSERT INTO user_wallets (user_id, chain, address, name, encrypted_private_key, is_imported, is_active)
SELECT id, 'hyperevm', evm_address, 'HyperEVM Wallet', evm_private_key_enc, FALSE, TRUE
FROM users
WHERE evm_address IS NOT NULL AND evm_private_key_enc IS NOT NULL
ON CONFLICT (user_id, chain, address) DO NOTHING;

INSERT INTO user_wallets (user_id, chain, address, name, encrypted_private_key, is_imported, is_active)
SELECT id, 'elysium', evm_address, 'Elysium Wallet', evm_private_key_enc, FALSE, TRUE
FROM users
WHERE evm_address IS NOT NULL AND evm_private_key_enc IS NOT NULL
ON CONFLICT (user_id, chain, address) DO NOTHING;

