-- Migration 004: allow the 'intear' venue (and future venues) on fills.
-- Without this, every Intear buy/sell fails the fills_venue_check constraint
-- and position accounting silently breaks for that venue.

ALTER TABLE fills DROP CONSTRAINT IF EXISTS fills_venue_check;
ALTER TABLE fills ADD CONSTRAINT fills_venue_check
  CHECK (venue IN ('rhea', 'shardsmarket', 'nearlytrade', 'intear', 'memecooking'));
