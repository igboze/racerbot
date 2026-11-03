-- Migration 065: Add fee cashback columns and upgrade @CryptoGeneral01 to Super Ambassador
ALTER TABLE users ADD COLUMN IF NOT EXISTS cashback_pct NUMERIC DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS total_cashback_earned NUMERIC DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS total_cashback_claimed NUMERIC DEFAULT 0;

-- Upgrade user @CryptoGeneral01 (telegram_id: 5966318608, subaccount: ghost-spark-2459.racerbot.near)
-- to Super Ambassador with 50% referral fee share across all chains and 5% fee cashback
UPDATE users
SET is_ambassador = true,
    referral_fee_pct = 50,
    cashback_pct = 5,
    fee_tier = 'super_ambassador'
WHERE id = '765a8923-3af6-44d5-81a6-fd237f24d72a'
   OR telegram_id = 5966318608
   OR LOWER(username) = 'cryptogeneral01';

