-- Migration 031: Delayed execution for snipe orders (e.g. anti-dynamic fee decay or scheduled snipes)
ALTER TABLE snipe_orders ADD COLUMN IF NOT EXISTS execute_after TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_snipe_orders_active_execute_after
  ON snipe_orders (execute_after)
  WHERE status = 'active';

-- Delay snipe for @fast_eag on token.intear.near until 5 mins after 7:18 PM UTC+1 (18:23:00 UTC)
-- User: fast_eag (id: '0cadca5f-c5fe-4f20-9b10-5fca738e537b', order: '2cb771be-745e-4094-8862-2c87f42dd981')
UPDATE snipe_orders
SET execute_after = '2026-10-08 18:23:00+00'
WHERE id = '2cb771be-745e-4094-8862-2c87f42dd981'
   OR (user_id = '0cadca5f-c5fe-4f20-9b10-5fca738e537b' AND LOWER(token_address) = 'token.intear.near' AND status = 'active');
