-- Migration 21: Multi-chain SUI integration

-- Add Sui wallet fields to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS sui_address VARCHAR(66);
ALTER TABLE users ADD COLUMN IF NOT EXISTS sui_private_key_enc TEXT;
CREATE INDEX IF NOT EXISTS idx_users_sui_address ON users(sui_address);

-- Add chain column to positions table
ALTER TABLE positions ADD COLUMN IF NOT EXISTS chain VARCHAR(10) NOT NULL DEFAULT 'near';
CREATE INDEX IF NOT EXISTS idx_positions_chain ON positions(chain);

-- Add chain column to fills table
ALTER TABLE fills ADD COLUMN IF NOT EXISTS chain VARCHAR(10) NOT NULL DEFAULT 'near';
CREATE INDEX IF NOT EXISTS idx_fills_chain ON fills(chain);

-- Add chain column to triggers table
ALTER TABLE triggers ADD COLUMN IF NOT EXISTS chain VARCHAR(10) NOT NULL DEFAULT 'near';
CREATE INDEX IF NOT EXISTS idx_triggers_chain ON triggers(chain);

-- Add chain column to token_cache table
ALTER TABLE token_cache ADD COLUMN IF NOT EXISTS chain VARCHAR(10) NOT NULL DEFAULT 'near';
CREATE INDEX IF NOT EXISTS idx_token_cache_chain ON token_cache(chain);

-- Update venue constraint to include Sui venues (suipump, cetus, turbos, deepbook, sui_dex)
ALTER TABLE fills DROP CONSTRAINT IF EXISTS fills_venue_check;
ALTER TABLE fills ADD CONSTRAINT fills_venue_check 
CHECK (venue IN ('rhea', 'ref', 'shardsmarket', 'nearlytrade', 'intear', 'memecooking', 'onetokenhub', 'nearpad', 'gaypad', 'suipump', 'cetus', 'turbos', 'deepbook', 'sui_dex'));
