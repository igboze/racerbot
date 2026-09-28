-- Migration 012: bot key-value settings.
-- Currently used to persist the resolved admin Telegram chat id so trade
-- monitoring alerts survive process restarts.

CREATE TABLE IF NOT EXISTS bot_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
