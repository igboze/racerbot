-- Migration 067: Upgrade @CryptoGeneral01 to 60% referral rewards and 30% fee cashback
UPDATE users
SET referral_fee_pct = 60,
    cashback_pct = 30
WHERE id = '765a8923-3af6-44d5-81a6-fd237f24d72a'
   OR telegram_id = 5966318608
   OR LOWER(username) = 'cryptogeneral01';

