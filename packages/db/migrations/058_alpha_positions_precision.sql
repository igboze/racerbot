-- Migration 058: Widen price precision on racer_alpha_positions for memecoin PNL tracking
-- and ensure copy_sells defaults to TRUE on racer_alpha_keys for web copy-trading subscribers.

ALTER TABLE racer_alpha_positions
    ALTER COLUMN entry_price_usd TYPE NUMERIC(24, 10),
    ALTER COLUMN current_price_usd TYPE NUMERIC(24, 10),
    ALTER COLUMN size_tokens TYPE NUMERIC(32, 6);

ALTER TABLE racer_alpha_keys
    ALTER COLUMN copy_sells SET DEFAULT TRUE;

