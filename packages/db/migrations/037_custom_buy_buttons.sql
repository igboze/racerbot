-- Add custom_buy_amounts to users for customizable quick buy buttons
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS custom_buy_amounts TEXT DEFAULT '1, 5, 10';
