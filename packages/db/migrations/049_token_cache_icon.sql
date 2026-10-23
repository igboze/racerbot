-- Migration 049: Add icon column to token_cache for persistent token image storage
ALTER TABLE token_cache ADD COLUMN IF NOT EXISTS icon TEXT;
