-- Add show_net_worth_on_card preference to users
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS show_net_worth_on_card BOOLEAN NOT NULL DEFAULT TRUE;
