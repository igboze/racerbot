-- Migration 14: token_cache.total_supply
--
-- upsertTokenCache() has always INSERTed a total_supply column, but the live
-- token_cache table (created in 001_init.sql) never had it. Every upsert
-- silently failed (callers .catch(() => {})), leaving token_cache EMPTY:
-- no DB price fallback, no metadata cache, and every getTokenInfo() forced
-- onto live RPC — intermittent RPC flakes then rendered zero/garbage prices
-- on PNL cards and holdings.

ALTER TABLE token_cache ADD COLUMN IF NOT EXISTS total_supply TEXT;
