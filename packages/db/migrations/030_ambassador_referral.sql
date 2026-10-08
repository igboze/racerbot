-- Migration 030: Add ambassador status and referral fee percent to users
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_fee_pct NUMERIC DEFAULT 30;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_ambassador BOOLEAN DEFAULT false;

-- Upgrade user @Kulesh_0ff (telegram_id: 640040783, subaccount: kulesh_off.tg) to Ambassador user with 45% referral fee
UPDATE users
SET referral_fee_pct = 45,
    is_ambassador = true,
    fee_tier = 'ambassador'
WHERE telegram_id = 640040783
   OR subaccount_id = 'kulesh_off.tg'
   OR LOWER(username) = 'kulesh_0ff'
   OR id = 'e9b97a47-dad1-4a47-8b2d-80ecbfd669ad';
