-- Migration 24: Multi-wallet management & wallet import (Option A)

CREATE TABLE IF NOT EXISTS user_wallets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chain VARCHAR(10) NOT NULL DEFAULT 'near', -- 'near' | 'sui'
    address TEXT NOT NULL,                     -- e.g. 'degen.near' or '0x...'
    name VARCHAR(50) NOT NULL DEFAULT 'Wallet 1',
    encrypted_private_key TEXT NOT NULL,
    is_imported BOOLEAN NOT NULL DEFAULT FALSE,
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT user_chain_wallet_unique UNIQUE (user_id, chain, address)
);

CREATE INDEX IF NOT EXISTS idx_user_wallets_user_chain ON user_wallets(user_id, chain);
CREATE INDEX IF NOT EXISTS idx_user_wallets_active ON user_wallets(user_id, chain, is_active);
CREATE INDEX IF NOT EXISTS idx_user_wallets_address ON user_wallets(address);

-- Ensure only one active wallet per user per chain
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_wallets_one_active_per_chain 
ON user_wallets(user_id, chain) 
WHERE is_active = TRUE;

-- Backfill existing NEAR wallets for all existing users
INSERT INTO user_wallets (user_id, chain, address, name, encrypted_private_key, is_imported, is_active)
SELECT id, 'near', subaccount_id, 'Wallet 1', scoped_key_encrypted, FALSE, TRUE
FROM users
WHERE subaccount_id IS NOT NULL AND scoped_key_encrypted IS NOT NULL
ON CONFLICT (user_id, chain, address) DO NOTHING;

-- Backfill existing SUI wallets for all existing users
INSERT INTO user_wallets (user_id, chain, address, name, encrypted_private_key, is_imported, is_active)
SELECT id, 'sui', sui_address, 'Wallet 1', sui_private_key_enc, FALSE, TRUE
FROM users
WHERE sui_address IS NOT NULL AND sui_private_key_enc IS NOT NULL
ON CONFLICT (user_id, chain, address) DO NOTHING;
