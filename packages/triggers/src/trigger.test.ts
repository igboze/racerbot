import 'dotenv/config';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { getDb, createUser, createPosition, createTrigger, getPositionById } from '@racerbot/db';
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
