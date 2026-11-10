-- Migration 069: Racer Alpha payment fixes
--
-- 1. A viewing key remembers the creator's copy profit share when it was bought,
--    so a creator raising the share later cannot charge existing followers more.
-- 2. Keys paid straight to the treasury from a browser wallet pay the creator's
--    95% from the treasury; this tracks that payout ('paid' or 'pending').
-- 3. Turning on auto-copy used to also create a plain wallet-copy of the creator's
--    wallet, so every copied trade could run twice and keep running after the key
--    expired. Pause those duplicates while the key's own auto-copy covers them.

ALTER TABLE racer_alpha_keys
    ADD COLUMN IF NOT EXISTS copy_fee_pct NUMERIC(5, 2),
    ADD COLUMN IF NOT EXISTS creator_payout_status TEXT;

CREATE INDEX IF NOT EXISTS idx_alpha_keys_treasury_tx ON racer_alpha_keys(treasury_tx_hash) WHERE treasury_tx_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_alpha_keys_creator_payout ON racer_alpha_keys(creator_payout_status) WHERE creator_payout_status = 'pending';

-- Existing keys keep the share in force today
UPDATE racer_alpha_keys k
SET copy_fee_pct = COALESCE(t.copy_fee_pct, 0)
FROM racer_alpha_traders t
WHERE t.id = k.trader_id AND k.copy_fee_pct IS NULL;

UPDATE copy_trade_targets ct
SET status = 'paused', updated_at = NOW()
FROM racer_alpha_keys k
JOIN racer_alpha_traders t ON t.id = k.trader_id
LEFT JOIN users u ON u.id::text = t.user_id
WHERE k.buyer_user_id = ct.user_id::text
  AND k.payment_status = 'completed'
  AND k.auto_copy_enabled = TRUE
  AND (k.expires_at IS NULL OR k.expires_at > NOW())
  AND ct.status = 'active'
  AND ct.track_only = FALSE
  AND LOWER(ct.target_wallet) = LOWER(COALESCE(NULLIF(t.payout_wallet_address, ''), u.subaccount_id));
