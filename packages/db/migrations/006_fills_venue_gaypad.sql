-- Migration 006: allow the 'gaypad' venue on fills.
-- Ensures fills table check constraint permits gaypad trades.

ALTER TABLE fills DROP CONSTRAINT IF EXISTS fills_venue_check;
ALTER TABLE fills ADD CONSTRAINT fills_venue_check
  CHECK (venue IN ('rhea', 'shardsmarket', 'nearlytrade', 'intear', 'memecooking', 'onetokenhub', 'gaypad'));
