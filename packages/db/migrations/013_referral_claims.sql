-- Migration 13: Referral reward claims (treasury payouts to referrers)

-- Tracks each on-chain payout of accrued referral rewards.
-- Claimable balance = SUM(referrals.total_fees_earned) - SUM(referral_claims.amount_near)
CREATE TABLE IF NOT EXISTS referral_claims (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    referrer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount_near NUMERIC NOT NULL,
    tx_hash TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_referral_claims_referrer ON referral_claims(referrer_id);
