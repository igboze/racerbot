-- Migration 067: copy profit share for confidential (executor) copies, and retries.
-- Copied cost basis is kept per route, so wallet and executor holdings are pro-rated apart.
ALTER TABLE racer_alpha_copy_positions ADD COLUMN IF NOT EXISTS route TEXT NOT NULL DEFAULT 'wallet';
ALTER TABLE racer_alpha_copy_positions DROP CONSTRAINT IF EXISTS racer_alpha_copy_positions_pkey;
ALTER TABLE racer_alpha_copy_positions ADD PRIMARY KEY (user_id, trader_id, token_address, route);

-- What a retry needs to send a charge again, and how often it has been tried
ALTER TABLE racer_alpha_copy_fees ADD COLUMN IF NOT EXISTS route TEXT NOT NULL DEFAULT 'wallet';
ALTER TABLE racer_alpha_copy_fees ADD COLUMN IF NOT EXISTS payout_account TEXT;
ALTER TABLE racer_alpha_copy_fees ADD COLUMN IF NOT EXISTS telegram_id BIGINT;
ALTER TABLE racer_alpha_copy_fees ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;
ALTER TABLE racer_alpha_copy_fees ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_racer_alpha_copy_fees_retry ON racer_alpha_copy_fees (status, last_attempt_at);
