-- 016: Lower the auto-buy (snipe) minimum-liquidity default from 500 → 10 NEAR.
--
-- Why: 500 NEAR was the shipped column default (002_auto_buy.sql), not a
-- deliberate user choice. Bonding-curve launches start with only a few NEAR
-- of liquidity, so a 500 NEAR gate silently filtered out every real launch
-- and snipes never fired. 10 NEAR still screens out dust pools while letting
-- genuine new launches through.

ALTER TABLE users
  ALTER COLUMN auto_buy_min_liquidity_near SET DEFAULT 10;

-- Only rewrite rows still sitting on the old shipped default; any user who
-- deliberately picked a value keeps it.
UPDATE users
  SET auto_buy_min_liquidity_near = 10
  WHERE auto_buy_min_liquidity_near = 500;
