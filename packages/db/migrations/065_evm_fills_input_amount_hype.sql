-- Migration 065: HyperEVM and Elysium (Kleos) fills stored input_amount in wei,
-- while PnL cards and volume read it as HYPE. Convert those rows to HYPE.
-- No real trade moves a billion HYPE, and the smallest buy (0.001 HYPE) is 1e15 wei,
-- so 1e9 separates the two units; rows already in HYPE are left alone.
UPDATE fills
SET input_amount = input_amount / 1e18
WHERE chain IN ('hyperevm', 'elysium')
  AND input_amount >= 1e9;
