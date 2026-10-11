-- Migration 34: Multi-chain Starknet integration

-- 1. Add Starknet wallet fields to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS starknet_address VARCHAR(66);
ALTER TABLE users ADD COLUMN IF NOT EXISTS starknet_private_key_enc TEXT;
CREATE INDEX IF NOT EXISTS idx_users_starknet_address ON users(starknet_address);

-- 2. Ensure venue check constraint is dropped (consistent with migration 022)
ALTER TABLE fills DROP CONSTRAINT IF EXISTS fills_venue_check;


-- 3. Backfill any existing Starknet wallets into user_wallets if present
INSERT INTO user_wallets (user_id, chain, address, name, encrypted_private_key, is_imported, is_active)
SELECT id, 'starknet', starknet_address, 'Wallet 1', starknet_private_key_enc, FALSE, TRUE
FROM users
WHERE starknet_address IS NOT NULL AND starknet_private_key_enc IS NOT NULL
ON CONFLICT (user_id, chain, address) DO NOTHING;
