import 'dotenv/config';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { getDb, createUser, createPosition, createTrigger, getPositionsByIds } from '@racerbot/db';
import { CHANNELS, getNear } from '@racerbot/shared';
import { TriggerEngine, localPriceCache, triggerRedis } from './trigger.js';

describe('triggers: firing idempotency', () => {
  const telegramId = Math.floor(200000000 + Math.random() * 800000000);
  let userId: string;
  let positionId: string;
  let triggerId: string;
  const tokenAddress = `tok-${Date.now()}.near`;

  beforeAll(async () => {
    const db = await getDb();
    // 1. Create test user
    const user = await createUser({
      telegram_id: telegramId,
      subaccount_id: `test-${telegramId}.racerbot.near`,
      scoped_key_encrypted: 'dummy_encrypted_key',
    });
    userId = user.id;

    // 2. Setup token cache with tradable venue
    await db.query(
      `INSERT INTO token_cache (token_address, name, symbol, decimals, venue, rhea_pool_id, last_price, last_liquidity, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (token_address) DO UPDATE SET venue = EXCLUDED.venue, rhea_pool_id = EXCLUDED.rhea_pool_id`,
      [tokenAddress, 'Test Token', 'TEST', 18, 'rhea', 123, 1.0, 1000],
    );

    // 3. Create open position with avg_entry_price = 1.0 NEAR
    const pos = await createPosition({
      user_id: userId,
      token_address: tokenAddress,
      quantity_held: '100000000000000000000',
      avg_entry_price: '1.0',
    });
    positionId = pos.id;

    // 4. Create stop_loss trigger targeting 10% drop
    const trig = await createTrigger({
      user_id: userId,
      position_id: positionId,
      type: 'stop_loss',
      target_value: '10', // 10% drop
    });
    triggerId = trig.id;
  });

  afterAll(async () => {
    const db = await getDb();
    if (userId) {
      await db.query('DELETE FROM users WHERE id = $1', [userId]);
    }
    await db.query('DELETE FROM token_cache WHERE token_address = $1', [tokenAddress]);
  });

  it('fires sell execution exactly once when threshold is crossed across immediate successive ticks', async () => {
    const engine = new TriggerEngine();

    // Mock external network boundaries: NEAR computeMinAmountOut & Redis publish
    const near = getNear();
    const computeSpy = vi.spyOn(near, 'computeMinAmountOut').mockResolvedValue({
      minAmountOut: '90000000000000000000',
      priceImpactPct: 0.1,
    } as any);

    const publishSpy = vi.spyOn(triggerRedis, 'publish').mockResolvedValue(1);

    // Simulate price dropping to 0.85 (a 15% drop, crossing the 10% stop-loss threshold)
    localPriceCache.set(tokenAddress, {
      price: 0.85,
      marketCap: 85000,
      ts: Date.now(),
    });

    // Call evaluation in immediate succession (simulating two overlapping polling ticks)
    await engine.checkAllTriggers();
    await engine.checkAllTriggers();

    // Verify swap execution was published exactly once
    const swapPublishes = publishSpy.mock.calls.filter((call) => call[0] === CHANNELS.EXECUTE_SWAP);
    expect(swapPublishes.length).toBe(1);

    // Verify the trigger status was marked 'fired' in DB
    const db = await getDb();
    const trigRow = await db.query('SELECT status FROM triggers WHERE id = $1', [triggerId]);
    expect(trigRow.rows[0]?.status).toBe('fired');

    computeSpy.mockRestore();
    publishSpy.mockRestore();
  });
});

describe('triggers: batched position fetch & evaluation', () => {
  const telegramId = Math.floor(200000000 + Math.random() * 800000000);
  let userId: string;
  const tokens = [`batch-a-${Date.now()}.near`, `batch-b-${Date.now()}.near`];
  const positionIds: string[] = [];
  const triggerIds: string[] = [];

  beforeAll(async () => {
    const db = await getDb();
    const user = await createUser({
      telegram_id: telegramId,
      subaccount_id: `test-${telegramId}.racerbot.near`,
      scoped_key_encrypted: 'dummy_encrypted_key',
    });
    userId = user.id;

    for (const token of tokens) {
      await db.query(
        `INSERT INTO token_cache (token_address, name, symbol, decimals, venue, rhea_pool_id, last_price, last_liquidity, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (token_address) DO UPDATE SET venue = EXCLUDED.venue, rhea_pool_id = EXCLUDED.rhea_pool_id`,
        [token, 'Batch Token', 'BATCH', 18, 'rhea', 123, 1.0, 1000],
      );
      const pos = await createPosition({
        user_id: userId,
        token_address: token,
        quantity_held: '100000000000000000000',
        avg_entry_price: '1.0',
      });
      positionIds.push(pos.id);
    }
  });

  afterAll(async () => {
    const db = await getDb();
    if (userId) {
      await db.query('DELETE FROM triggers WHERE user_id = $1', [userId]);
      await db.query('DELETE FROM positions WHERE user_id = $1', [userId]);
      await db.query('DELETE FROM users WHERE id = $1', [userId]);
    }
    for (const token of tokens) {
      await db.query('DELETE FROM token_cache WHERE token_address = $1', [token]);
      localPriceCache.delete(token);
    }
  });

  it('getPositionsByIds returns all matching positions in one call', async () => {
    const positions = await getPositionsByIds([...positionIds, '00000000-0000-0000-0000-000000000000']);
    const foundIds = positions.map(p => p.id);
    expect(foundIds).toContain(positionIds[0]);
    expect(foundIds).toContain(positionIds[1]);
    expect(positions).toHaveLength(2);

    expect(await getPositionsByIds([])).toEqual([]);
  });

  it('checkAllTriggers evaluates triggers across multiple positions in one batch and fires all crossed thresholds', async () => {
    const engine = new TriggerEngine();

    // Two stop-loss triggers per token (4 total across 2 positions)
    for (let i = 0; i < 2; i++) {
      for (const posId of positionIds) {
        const trig = await createTrigger({
          user_id: userId,
          position_id: posId,
          type: 'stop_loss',
          target_value: '10',
        });
        triggerIds.push(trig.id);
      }
    }

    const near = getNear();
    const computeSpy = vi.spyOn(near, 'computeMinAmountOut').mockResolvedValue({
      minAmountOut: '90000000000000000000',
      priceImpactPct: 0.1,
    } as any);
    const publishSpy = vi.spyOn(triggerRedis, 'publish').mockResolvedValue(1);

    // Fresh cached prices at 0.85 — a 15% drop crossing every 10% stop-loss
    for (const token of tokens) {
      localPriceCache.set(token, { price: 0.85, marketCap: 85000, ts: Date.now() });
    }

    await engine.checkAllTriggers();

    const swapPublishes = publishSpy.mock.calls.filter((call) => {
      if (call[0] !== CHANNELS.EXECUTE_SWAP) return false;
      const event = JSON.parse(call[1] as string);
      return tokens.includes(event.token_in);
    });
    expect(swapPublishes).toHaveLength(4);

    const db = await getDb();
    const trigRows = await db.query('SELECT status FROM triggers WHERE id = ANY($1)', [triggerIds]);
    expect(trigRows.rows.every((r: any) => r.status === 'fired')).toBe(true);

    computeSpy.mockRestore();
    publishSpy.mockRestore();
  });

  it('refreshes a stale price once per unique token per cycle, not once per trigger', async () => {
    const engine = new TriggerEngine();
    const token = tokens[0];

    // New active triggers on the same position (same token)
    const freshTriggerIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const trig = await createTrigger({
        user_id: userId,
        position_id: positionIds[0],
        type: 'stop_loss',
        target_value: '10',
      });
      freshTriggerIds.push(trig.id);
    }

    const near = getNear();
    const spotSpy = vi.spyOn(near, 'getVenueSpotPrice').mockResolvedValue({
      price: 0.85,
    } as any);
    const computeSpy = vi.spyOn(near, 'computeMinAmountOut').mockResolvedValue({
      minAmountOut: '90000000000000000000',
      priceImpactPct: 0.1,
    } as any);
    const publishSpy = vi.spyOn(triggerRedis, 'publish').mockResolvedValue(1);

    // Stale cached price forces the refresh path in checkAllTriggers
    localPriceCache.set(token, { price: 1.0, marketCap: 100000, ts: Date.now() - 120_000 });

    await engine.checkAllTriggers();

    // Two triggers share one token → exactly one live pool refresh this cycle
    expect(spotSpy).toHaveBeenCalledTimes(1);

    // …and both triggers still fire off the refreshed price
    const swapPublishes = publishSpy.mock.calls.filter((call) => {
      if (call[0] !== CHANNELS.EXECUTE_SWAP) return false;
      const event = JSON.parse(call[1] as string);
      return event.token_in === token;
    });
    expect(swapPublishes).toHaveLength(2);

    const db = await getDb();
    const trigRows = await db.query('SELECT status FROM triggers WHERE id = ANY($1)', [freshTriggerIds]);
    expect(trigRows.rows.every((r: any) => r.status === 'fired')).toBe(true);

    spotSpy.mockRestore();
    computeSpy.mockRestore();
    publishSpy.mockRestore();
  });
});
