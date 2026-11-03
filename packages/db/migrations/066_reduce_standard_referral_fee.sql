-- Migration 066: Reduce standard user referral fee from 30% to 15%
ALTER TABLE users ALTER COLUMN referral_fee_pct SET DEFAULT 15;

UPDATE users
SET referral_fee_pct = 15
WHERE (fee_tier = 'standard' OR fee_tier IS NULL)
  AND (is_ambassador IS FALSE OR is_ambassador IS NULL)
  AND referral_fee_pct = 30;

