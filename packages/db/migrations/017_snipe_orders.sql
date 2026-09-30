-- 017: Targeted snipe orders.
--
-- Two snipe modes on top of the auto-buy pipeline:
--   * 'token'    — user pre-registers a token contract address; the bot buys
--                  the moment the token is detected as tradable (one-shot).
--   * 'deployer' — user registers a NEAR wallet; EVERY new token launched by
--                  that wallet gets sniped until the order is cancelled.
--
-- snipe_triggers records one row per order×token fire. It is the dedup gate:
-- a trigger insert only succeeds when no pending/filled trigger exists for
-- that order×token pair, so a token detected twice never double-fires, while
-- a failed attempt may retry on the next detection.

CREATE TABLE IF NOT EXISTS snipe_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  snipe_type TEXT NOT NULL CHECK (snipe_type IN ('token', 'deployer')),
  token_address TEXT,
  deployer_address TEXT,
  amount_near NUMERIC NOT NULL CHECK (amount_near > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'filled', 'cancelled', 'failed')),
  last_error TEXT,
  trigger_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT snipe_orders_target_check CHECK (
    (snipe_type = 'token' AND token_address IS NOT NULL) OR
    (snipe_type = 'deployer' AND deployer_address IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_snipe_orders_active_token
  ON snipe_orders (lower(token_address)) WHERE status = 'active' AND snipe_type = 'token';
CREATE INDEX IF NOT EXISTS idx_snipe_orders_active_deployer
  ON snipe_orders (lower(deployer_address)) WHERE status = 'active' AND snipe_type = 'deployer';
CREATE INDEX IF NOT EXISTS idx_snipe_orders_user
  ON snipe_orders (user_id, status);

CREATE TABLE IF NOT EXISTS snipe_triggers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES snipe_orders(id) ON DELETE CASCADE,
  token_address TEXT NOT NULL,
  venue TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'filled', 'failed')),
  attempts INT NOT NULL DEFAULT 1,
  tx_hash TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT snipe_triggers_order_token_unique UNIQUE (order_id, token_address)
);

CREATE INDEX IF NOT EXISTS idx_snipe_triggers_order ON snipe_triggers (order_id);
