-- Migration 063: NEAR Racer Card account links (phase 2)
-- A wallet-only web account (telegram_id = 0) linked to a Telegram RacerBot account, so their
-- NEAR activity counts toward one lifetime rank. One link per side; the Telegram side approves
-- in the bot, so a link is never made from the web alone.
CREATE TABLE IF NOT EXISTS racer_links (
    wallet_user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    telegram_user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (wallet_user_id <> telegram_user_id)
);

-- One-time codes behind the bot deep link (t.me/<bot>?start=rclink_<code>)
CREATE TABLE IF NOT EXISTS racer_link_codes (
    code TEXT PRIMARY KEY,
    wallet_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_racer_link_codes_wallet ON racer_link_codes(wallet_user_id);
