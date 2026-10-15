-- Set show_net_worth_on_card preference default to FALSE (hide net worth by default, show market cap)
ALTER TABLE users
  ALTER COLUMN show_net_worth_on_card SET DEFAULT FALSE;

UPDATE users
  SET show_net_worth_on_card = FALSE;
