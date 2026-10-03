-- Migration 022: Drop venue check constraint on fills table to support all Sui & NEAR DEXes
-- (e.g. Bluefin, Cetus, Turbos, Aftermath, DeepBook, FlowX, Kriya, Rhea, Ref, etc.)

ALTER TABLE fills DROP CONSTRAINT IF EXISTS fills_venue_check;
