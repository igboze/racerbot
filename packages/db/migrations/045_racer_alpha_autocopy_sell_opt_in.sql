ALTER TABLE racer_alpha_keys
    ALTER COLUMN copy_sells SET DEFAULT FALSE;

UPDATE racer_alpha_keys
SET copy_sells = FALSE
WHERE copy_sells IS DISTINCT FROM FALSE;
