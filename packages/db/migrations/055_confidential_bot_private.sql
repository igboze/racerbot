-- Migration 055: Telegram bot private mode (bot buys run from private executors)

ALTER TABLE confidential_accounts
    ADD COLUMN IF NOT EXISTS bot_private BOOLEAN NOT NULL DEFAULT FALSE;
