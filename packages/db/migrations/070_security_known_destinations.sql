-- Migration 070: addresses each user has already sent funds to, so a security
-- alert can flag the first send to a new address (the usual sign of a takeover).
CREATE TABLE IF NOT EXISTS security_known_destinations (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chain TEXT NOT NULL,
  address TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, chain, address)
);
