import 'dotenv/config';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LimitOrderRecord } from '@racerbot/db';
import * as dbModule from '@racerbot/db';
import { localPriceCache } from './trigger.js';
import { evaluateLimitOrder } from './limitOrder.js';

describe('limitOrder: Take Profit and Stop Loss evaluation', () => {
  const tokenAddress = 'test-tp-sl.near';

  const baseOrder: LimitOrderRecord = {
    id: '11111111-2222-3333-4444-555555555555',
    user_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    chain: 'near',
    side: 'sell',
    token_address: tokenAddress,
    amount_input: 10, // 10 NEAR worth to sell
    sell_pct: null,
    target_type: 'percent_offset',
    target_value: 50, // +50% Take Profit
    trigger_condition: 'gte',
    max_slippage_pct: 1.0,
    status: 'active',
    reference_price: 1.0,
    reference_mcap: 100000,
    fill_tx_hash: null,
    fill_price: null,
    failure_reason: null,
    created_at: new Date(),
    updated_at: new Date(),
    expires_at: new Date(Date.now() + 86400000),
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(dbModule, 'markLimitOrderFailed').mockResolvedValue(undefined as any);
  });

  it('triggers Take Profit when price reaches target (+50%)', async () => {
    // Current price is 1.55 (above target of 1.0 * (1 + 0.5) = 1.50)
    localPriceCache.set(tokenAddress, {
      price: 1.55,
      marketCap: 155000,
      ts: Date.now(),
    });

    const lockSpy = vi.spyOn(dbModule, 'lockLimitOrderForExecution').mockResolvedValue(baseOrder);
    // Mock user & token cache to avoid real network
    vi.spyOn(dbModule, 'getUserById').mockResolvedValue(null);

    await evaluateLimitOrder(baseOrder);

    // Verify order was locked for execution
    expect(lockSpy).toHaveBeenCalledWith(baseOrder.id);
  });

  it('does NOT trigger Take Profit when price is below target', async () => {
    // Current price is 1.20 (below target of 1.50)
    localPriceCache.set(tokenAddress, {
      price: 1.20,
      marketCap: 120000,
      ts: Date.now(),
    });

    const lockSpy = vi.spyOn(dbModule, 'lockLimitOrderForExecution');
    await evaluateLimitOrder(baseOrder);

    expect(lockSpy).not.toHaveBeenCalled();
  });

  it('triggers Stop Loss when price drops below target (-20%)', async () => {
    const stopLossOrder: LimitOrderRecord = {
      ...baseOrder,
      id: '22222222-2222-3333-4444-555555555555',
      target_value: -20,
      trigger_condition: 'lte',
      reference_price: 1.0,
    };

    // Current price is 0.75 (below target of 1.0 * (1 - 0.20) = 0.80)
    localPriceCache.set(tokenAddress, {
      price: 0.75,
      marketCap: 75000,
      ts: Date.now(),
    });

    const lockSpy = vi.spyOn(dbModule, 'lockLimitOrderForExecution').mockResolvedValue(stopLossOrder);
    vi.spyOn(dbModule, 'getUserById').mockResolvedValue(null);

    await evaluateLimitOrder(stopLossOrder);

    expect(lockSpy).toHaveBeenCalledWith(stopLossOrder.id);
  });

  it('does NOT trigger Stop Loss when price remains above stop threshold', async () => {
    const stopLossOrder: LimitOrderRecord = {
      ...baseOrder,
      id: 'lo-sl-2',
      target_value: -20,
      trigger_condition: 'lte',
      reference_price: 1.0,
    };

    // Current price is 0.90 (above target 0.80)
    localPriceCache.set(tokenAddress, {
      price: 0.90,
      marketCap: 90000,
      ts: Date.now(),
    });

    const lockSpy = vi.spyOn(dbModule, 'lockLimitOrderForExecution');
    await evaluateLimitOrder(stopLossOrder);

    expect(lockSpy).not.toHaveBeenCalled();
  });

  it('triggers Price-based Take Profit and Stop Loss accurately', async () => {
    const priceTpOrder: LimitOrderRecord = {
      ...baseOrder,
      id: '33333333-2222-3333-4444-555555555555',
      target_type: 'price',
      target_value: 2.50,
      trigger_condition: 'gte',
    };

    // Price at 2.60
    localPriceCache.set(tokenAddress, {
      price: 2.60,
      marketCap: 260000,
      ts: Date.now(),
    });

    const lockSpy = vi.spyOn(dbModule, 'lockLimitOrderForExecution').mockResolvedValue(priceTpOrder);
    vi.spyOn(dbModule, 'getUserById').mockResolvedValue(null);

    await evaluateLimitOrder(priceTpOrder);
    expect(lockSpy).toHaveBeenCalledWith(priceTpOrder.id);
  });
});
