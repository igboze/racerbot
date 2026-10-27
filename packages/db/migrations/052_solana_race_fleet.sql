-- Migration 52: Solana RaceFleet wallets
-- Additive and backward compatible: every existing fleet wallet becomes chain 'near'.

ALTER TABLE race_fleet_wallets ADD COLUMN IF NOT EXISTS chain TEXT NOT NULL DEFAULT 'near';

-- A fleet can now hold one wallet per index on EACH chain (NEAR W1..Wn and Solana W1..Wn).
ALTER TABLE race_fleet_wallets DROP CONSTRAINT IF EXISTS unique_fleet_wallet_index;
CREATE UNIQUE INDEX IF NOT EXISTS uq_race_fleet_wallet_chain_index
  ON race_fleet_wallets (fleet_id, chain, wallet_index);

CREATE INDEX IF NOT EXISTS idx_race_fleet_wallets_fleet_chain
  ON race_fleet_wallets (fleet_id, chain) WHERE is_active = TRUE;
