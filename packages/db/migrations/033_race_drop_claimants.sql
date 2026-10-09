-- Migration 033: RaceDrop claimant names & multi-group message tracking

ALTER TABLE race_drop_claims ADD COLUMN IF NOT EXISTS claimant_name TEXT;

-- Backfill claimant_name from users table where missing
UPDATE race_drop_claims c
SET claimant_name = COALESCE('@' || u.username, 'User #' || c.telegram_id)
FROM users u
WHERE c.user_id = u.id AND c.claimant_name IS NULL;

-- Table to track all groups where a RaceDrop message is posted for live updating
CREATE TABLE IF NOT EXISTS race_drop_group_messages (
    drop_id UUID NOT NULL REFERENCES race_drops(id) ON DELETE CASCADE,
    chat_id BIGINT NOT NULL,
    message_id BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (drop_id, chat_id)
);

CREATE INDEX IF NOT EXISTS idx_race_drop_group_messages_drop ON race_drop_group_messages(drop_id);
