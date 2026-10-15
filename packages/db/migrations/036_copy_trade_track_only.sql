-- Migration 036: Add track_only mode to copy_trade_targets
ALTER TABLE copy_trade_targets
    ADD COLUMN IF NOT EXISTS track_only BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_copy_targets_track_only
    ON copy_trade_targets(user_id, track_only);