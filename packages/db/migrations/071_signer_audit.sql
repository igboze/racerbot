-- Migration 071: audit log of every money-out request the signer service receives,
-- and what it decided. Also what its rate limits and circuit breaker count.
CREATE TABLE IF NOT EXISTS signer_audit (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID,
  op TEXT NOT NULL,
  destination TEXT,
  decision TEXT NOT NULL,          -- 'allowed' | 'refused'
  status TEXT NOT NULL,            -- 'pending' | 'done' | 'failed' | 'refused'
  reason TEXT,
  tx_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_signer_audit_user_time ON signer_audit (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signer_audit_time ON signer_audit (created_at DESC);
