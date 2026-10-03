-- Migration: Add input_amount column to fills table
-- This stores the actual native currency spent (buy) or received (sell)
-- in human-readable units (SUI or NEAR), as the on-chain source of truth
-- for investment/PNL calculations. Avoids the ambiguous amount*price math.
ALTER TABLE fills ADD COLUMN IF NOT EXISTS input_amount NUMERIC DEFAULT NULL;
