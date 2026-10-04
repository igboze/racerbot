-- Migration 23: Prevent duplicate open positions per user+token
--
-- Root cause: getOpenPositions → createPosition was not atomic. Concurrent buys
-- (auto-buy + manual, or duplicate webhook from two replicas) could both find no
-- position and both INSERT one, resulting in two open rows for the same token.
-- The DB-level partial unique index is the authoritative backstop.

-- Step 1: Merge any existing duplicate open positions so the index can be created.
-- Keep the oldest (lowest opened_at) row; re-parent its fills to it, then delete dupes.
DO $$
DECLARE
  dup RECORD;
  canonical_id UUID;
BEGIN
  FOR dup IN
    SELECT user_id, token_address, chain
    FROM positions
    WHERE status = 'open'
    GROUP BY user_id, token_address, chain
    HAVING COUNT(*) > 1
  LOOP
    -- The oldest position becomes canonical
    SELECT id INTO canonical_id
    FROM positions
    WHERE user_id = dup.user_id
      AND token_address = dup.token_address
      AND chain = dup.chain
      AND status = 'open'
    ORDER BY opened_at ASC
    LIMIT 1;

    -- Re-parent fills from duplicate rows to canonical
    UPDATE fills
    SET position_id = canonical_id
    WHERE position_id IN (
      SELECT id FROM positions
      WHERE user_id = dup.user_id
        AND token_address = dup.token_address
        AND chain = dup.chain
        AND status = 'open'
        AND id <> canonical_id
    );

    -- Re-parent triggers from duplicate rows to canonical
    UPDATE triggers
    SET position_id = canonical_id
    WHERE position_id IN (
      SELECT id FROM positions
      WHERE user_id = dup.user_id
        AND token_address = dup.token_address
        AND chain = dup.chain
        AND status = 'open'
        AND id <> canonical_id
    );

    -- Remove duplicate rows (now orphaned of fills/triggers)
    DELETE FROM positions
    WHERE user_id = dup.user_id
      AND token_address = dup.token_address
      AND chain = dup.chain
      AND status = 'open'
      AND id <> canonical_id;

    -- Recompute quantity_held and avg_entry_price for the canonical position
    -- from its now-merged fill set using the same weighted-average logic.
    UPDATE positions p
    SET (quantity_held, avg_entry_price) = (
      SELECT
        COALESCE(SUM(CASE WHEN f.side = 'buy' THEN f.amount ELSE -f.amount END), 0) AS qty,
        CASE
          WHEN SUM(CASE WHEN f.side = 'buy' THEN f.amount ELSE 0 END) > 0
          THEN SUM(CASE WHEN f.side = 'buy' THEN f.price * f.amount ELSE 0 END)
               / SUM(CASE WHEN f.side = 'buy' THEN f.amount ELSE 0 END)
          ELSE p.avg_entry_price
        END AS avg_price
      FROM fills f
      WHERE f.position_id = canonical_id
    )
    WHERE id = canonical_id;
  END LOOP;
END;
$$;

-- Step 2: Add the partial unique index — enforces exactly one open position per (user, token, chain).
CREATE UNIQUE INDEX IF NOT EXISTS idx_positions_unique_open
  ON positions (user_id, token_address, chain)
  WHERE status = 'open';
