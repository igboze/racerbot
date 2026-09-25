-- Migration 8: Add performance indexes for faster queries

-- Index on token_cache.updated_at for cache expiration queries
CREATE INDEX IF NOT EXISTS idx_token_cache_updated_at ON token_cache(updated_at);

-- Index on positions.token_address for token-specific queries
CREATE INDEX IF NOT EXISTS idx_positions_token_address ON positions(token_address);

-- Index on fills.tx_hash for faster duplicate detection (though unique constraint exists)
CREATE INDEX IF NOT EXISTS idx_fills_tx_hash ON fills(tx_hash);

-- Index on fills.token_address for token-specific fill queries
CREATE INDEX IF NOT EXISTS idx_fills_token_address ON fills(token_address);

-- Index on fills.created_at for time-based queries
CREATE INDEX IF NOT EXISTS idx_fills_created_at ON fills(created_at);

-- Index on positions.opened_at for time-based position queries
CREATE INDEX IF NOT EXISTS idx_positions_opened_at ON positions(opened_at);
