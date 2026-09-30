-- Migration 15: RacerBot Points (Season 1 → $RACER airdrop)
--
-- Append-only ledger: every point is traceable to the fill / referral / day
-- that earned it. The (user_id, action, ref_id) unique constraint makes all
-- awards idempotent — safe for live hooks, backfills and retries alike.

CREATE TABLE IF NOT EXISTS points_ledger (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    action TEXT NOT NULL,           -- trade | first_trade | daily_active | referral_qualified | referral_welcome | referral_override
    points NUMERIC NOT NULL,
    ref_id TEXT NOT NULL DEFAULT '', -- fill id, referral id, daily:YYYY-MM-DD, ovr:<fillId>, 'first'
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (user_id, action, ref_id)
);

CREATE INDEX IF NOT EXISTS idx_points_ledger_user ON points_ledger(user_id);
CREATE INDEX IF NOT EXISTS idx_points_ledger_action ON points_ledger(action);
