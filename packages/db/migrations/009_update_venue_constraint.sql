-- Migration 9: Update venue constraint to include all supported venues

-- Drop the old constraint
ALTER TABLE fills DROP CONSTRAINT IF EXISTS fills_venue_check;

-- Add the new constraint with all supported venues
ALTER TABLE fills ADD CONSTRAINT fills_venue_check 
CHECK (venue IN ('rhea', 'shardsmarket', 'nearlytrade', 'intear', 'onetokenhub', 'nearpad', 'gaypad'));
