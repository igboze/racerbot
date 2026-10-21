-- Migration 048: Clear Dummy / Seed Alpha Callers for Production
-- Purges seeded test personas from racer_alpha_traders, racer_alpha_positions, racer_alpha_signals, and racer_alpha_keys

DELETE FROM racer_alpha_positions 
WHERE trader_id IN (
    SELECT id FROM racer_alpha_traders 
    WHERE handle IN ('pro_sniper', 'lunar_nexus', 'cryptowhale', 'shadow_racer', 'sol_sniper', 'whale_watcher')
       OR user_id IN ('pro_trader.near', 'lunar-nexus-9768.racerbot.near', 'cryptowhale.near', 'system_alpha')
);

DELETE FROM racer_alpha_signals 
WHERE trader_id IN (
    SELECT id FROM racer_alpha_traders 
    WHERE handle IN ('pro_sniper', 'lunar_nexus', 'cryptowhale', 'shadow_racer', 'sol_sniper', 'whale_watcher')
       OR user_id IN ('pro_trader.near', 'lunar-nexus-9768.racerbot.near', 'cryptowhale.near', 'system_alpha')
);

DELETE FROM racer_alpha_keys 
WHERE trader_id IN (
    SELECT id FROM racer_alpha_traders 
    WHERE handle IN ('pro_sniper', 'lunar_nexus', 'cryptowhale', 'shadow_racer', 'sol_sniper', 'whale_watcher')
       OR user_id IN ('pro_trader.near', 'lunar-nexus-9768.racerbot.near', 'cryptowhale.near', 'system_alpha')
);

DELETE FROM racer_alpha_traders 
WHERE handle IN ('pro_sniper', 'lunar_nexus', 'cryptowhale', 'shadow_racer', 'sol_sniper', 'whale_watcher')
   OR user_id IN ('pro_trader.near', 'lunar-nexus-9768.racerbot.near', 'cryptowhale.near', 'system_alpha');

-- Also clean any test dummy creator payments
DELETE FROM racer_alpha_creator_payments 
WHERE wallet_address IN ('pro_trader.near', 'lunar-nexus-9768.racerbot.near', 'cryptowhale.near');
