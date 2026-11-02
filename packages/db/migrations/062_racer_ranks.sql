-- Migration 062: NEAR Racer Card lifetime ranks
-- best_key: highest rank ever reached (Rookie I = 1 … Legend III = 21); never lowered.
-- announced_key: highest rank the user was told about; raised by one atomic claim per rank-up.
CREATE TABLE IF NOT EXISTS racer_ranks (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    best_key SMALLINT NOT NULL DEFAULT 0,
    announced_key SMALLINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Racer Card reads one user's NEAR fills on /card and after each trade.
CREATE INDEX IF NOT EXISTS idx_fills_user_created ON fills(user_id, created_at);
