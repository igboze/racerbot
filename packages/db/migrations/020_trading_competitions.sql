-- ── 020: Trading Competitions ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trading_competitions (
  id VARCHAR(64) PRIMARY KEY,
  token_address VARCHAR(128) NOT NULL,
  token_symbol VARCHAR(32) NOT NULL,
  token_name VARCHAR(128) NOT NULL,
  target_market_cap_usd NUMERIC(18, 4) NOT NULL DEFAULT 30000,
  status VARCHAR(32) NOT NULL DEFAULT 'pending', -- 'pending', 'active', 'completed'
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_competitions_token ON trading_competitions(token_address);

-- Seed KOOKDOG competition
INSERT INTO trading_competitions (id, token_address, token_symbol, token_name, target_market_cap_usd, status)
VALUES ('kookdog', 'kookdog-42db38.launchpad.justhoot.near', 'KOOKDOG', 'Kook Dog', 30000, 'pending')
ON CONFLICT (id) DO NOTHING;
