-- Migration 032: RaceDrops — Social group drops & viral referral onboarding

CREATE TABLE IF NOT EXISTS race_drops (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    creator_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    creator_telegram_id BIGINT NOT NULL,
    creator_name TEXT,
    chain VARCHAR(10) NOT NULL DEFAULT 'near', -- 'near' | 'sui'
    token_address TEXT NOT NULL,
    token_symbol VARCHAR(32) NOT NULL,
    decimals INT NOT NULL DEFAULT 18,
    amount_per_user NUMERIC,
    total_amount NUMERIC NOT NULL,
    remaining_amount NUMERIC NOT NULL,
    total_claims INT NOT NULL,
    claims_count INT NOT NULL DEFAULT 0,
    split_mode VARCHAR(20) NOT NULL DEFAULT 'equal', -- 'equal' | 'lucky'
    message_text TEXT,
    group_chat_id BIGINT,
    group_message_id BIGINT,
    status VARCHAR(20) NOT NULL DEFAULT 'active', -- 'active' | 'completed' | 'expired' | 'cancelled'
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE race_drops ADD COLUMN IF NOT EXISTS creator_name TEXT;
ALTER TABLE race_drops ADD COLUMN IF NOT EXISTS amount_per_user NUMERIC;

CREATE INDEX IF NOT EXISTS idx_race_drops_creator ON race_drops(creator_id);
CREATE INDEX IF NOT EXISTS idx_race_drops_status ON race_drops(status);
CREATE INDEX IF NOT EXISTS idx_race_drops_group ON race_drops(group_chat_id, group_message_id);

CREATE TABLE IF NOT EXISTS race_drop_claims (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    drop_id UUID NOT NULL REFERENCES race_drops(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    telegram_id BIGINT NOT NULL,
    claim_amount NUMERIC NOT NULL,
    is_new_user BOOLEAN NOT NULL DEFAULT FALSE,
    tx_hash TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_drop_claim_user UNIQUE (drop_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_race_drop_claims_drop ON race_drop_claims(drop_id);
CREATE INDEX IF NOT EXISTS idx_race_drop_claims_user ON race_drop_claims(user_id);
