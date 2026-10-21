ALTER TABLE racer_alpha_signals
    DROP CONSTRAINT IF EXISTS racer_alpha_signals_trader_id_fkey;

ALTER TABLE racer_alpha_keys
    DROP CONSTRAINT IF EXISTS racer_alpha_keys_trader_id_fkey,
    DROP CONSTRAINT IF EXISTS racer_alpha_keys_buyer_user_id_fkey;

ALTER TABLE racer_alpha_traders
    DROP CONSTRAINT IF EXISTS racer_alpha_traders_user_id_fkey;

ALTER TABLE racer_alpha_traders
    ALTER COLUMN id DROP DEFAULT,
    ALTER COLUMN id TYPE TEXT USING id::text,
    ALTER COLUMN user_id TYPE TEXT USING user_id::text,
    ALTER COLUMN id SET DEFAULT uuid_generate_v4()::text;

ALTER TABLE racer_alpha_keys
    ALTER COLUMN id DROP DEFAULT,
    ALTER COLUMN id TYPE TEXT USING id::text,
    ALTER COLUMN trader_id TYPE TEXT USING trader_id::text,
    ALTER COLUMN buyer_user_id TYPE TEXT USING buyer_user_id::text,
    ALTER COLUMN id SET DEFAULT uuid_generate_v4()::text;

ALTER TABLE racer_alpha_signals
    ALTER COLUMN id DROP DEFAULT,
    ALTER COLUMN id TYPE TEXT USING id::text,
    ALTER COLUMN trader_id TYPE TEXT USING trader_id::text,
    ALTER COLUMN id SET DEFAULT uuid_generate_v4()::text;

ALTER TABLE racer_alpha_traders
    ADD COLUMN IF NOT EXISTS keys_reserved INT NOT NULL DEFAULT 0;

ALTER TABLE racer_alpha_keys
    ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'completed'
        CHECK (payment_status IN ('pending', 'creator_paid', 'treasury_paid', 'completed', 'failed', 'refunded', 'refund_required')),
    ADD COLUMN IF NOT EXISTS creator_tx_hash TEXT,
    ADD COLUMN IF NOT EXISTS treasury_tx_hash TEXT,
    ADD COLUMN IF NOT EXISTS refund_tx_hash TEXT,
    ADD COLUMN IF NOT EXISTS payment_error TEXT;
