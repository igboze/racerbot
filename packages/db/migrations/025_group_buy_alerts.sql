-- Migration 25: Group Buy Alerts Bot for Telegram Groups

CREATE TABLE IF NOT EXISTS group_buy_alerts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    chat_id BIGINT NOT NULL,
    chat_title TEXT,
    admin_id BIGINT NOT NULL,
    token_address TEXT NOT NULL,
    chain VARCHAR(10) NOT NULL DEFAULT 'near', -- 'near' | 'sui'
    min_buy_usd NUMERIC(10, 2) NOT NULL DEFAULT 5.00,
    emoji TEXT NOT NULL DEFAULT '🏎️',
    emoji_step_usd NUMERIC(10, 2) NOT NULL DEFAULT 5.00,
    media_file_id TEXT, -- Telegram file_id (GIF/animation/photo)
    media_type VARCHAR(20) NOT NULL DEFAULT 'default', -- 'animation' | 'photo' | 'default' | 'none'
    whale_threshold_usd NUMERIC(10, 2) NOT NULL DEFAULT 200.00,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_group_token UNIQUE (chat_id, token_address)
);

CREATE INDEX IF NOT EXISTS idx_group_buy_alerts_token ON group_buy_alerts (token_address, is_active);
CREATE INDEX IF NOT EXISTS idx_group_buy_alerts_chat ON group_buy_alerts (chat_id);
