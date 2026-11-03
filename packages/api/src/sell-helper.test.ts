import { describe, it, expect, vi } from 'vitest';

const publishSwapMock = vi.fn();

vi.mock('./wallet.js', () => ({
  getTokenInfo: vi.fn().mockResolvedValue({
    venue: 'rhea',
    tradeable: true,
    dcl_pool_id: undefined,
    rhea_pool_id: undefined,
  }),
  publishSwap: publishSwapMock,
}));

vi.mock('@racerbot/db', () => ({
  getPositionById: vi.fn().mockResolvedValue({
    id: 'pos-1',
    user_id: 'user-1',
    status: 'open',
    token_address: 'token.near',
    quantity_held: '1000',
  }),
  getUserById: vi.fn().mockResolvedValue({ id: 'user-1', slippage_pct: 2 }),
  updatePosition: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@racerbot/shared', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    getNear: () => ({
      computeMinAmountOut: vi.fn().mockResolvedValue({ expectedOutput: '5000', minAmountOut: '4900' }),
    }),
  };
});

const { sellAtTarget } = await import('./sellHelper.js');
const db: any = await import('@racerbot/db');

describe('sellAtTarget failure feedback', () => {
  it('passes the executor failure reason through to the caller', async () => {
    const reason = 'Slippage too high — price moved against you. Increase slippage in Settings and retry.';
    publishSwapMock.mockResolvedValue({ success: false, reason });

    const result = await sellAtTarget('user-1', 'pos-1', 50);
    expect(result.success).toBe(false);
    expect(result.reason).toBe(reason);
  });

  it('falls back to a generic message only when the executor gives no reason', async () => {
    publishSwapMock.mockResolvedValue({ success: false });

    const result = await sellAtTarget('user-1', 'pos-1', 50);
    expect(result.success).toBe(false);
    expect(result.reason).toContain('Swap failed on-chain');
  });

  it('returns success when the swap executes', async () => {
    publishSwapMock.mockResolvedValue({ success: true, txHash: 'tx-1' });

    const result = await sellAtTarget('user-1', 'pos-1', 50);
    expect(result.success).toBe(true);
  });

  it('supports fractional sell percentages without rounding down to whole percentages', async () => {
    publishSwapMock.mockResolvedValue({ success: true, txHash: 'tx-2' });

    const result = await sellAtTarget('user-1', 'pos-1', 25.5);

    expect(result.success).toBe(true);
    expect(publishSwapMock.mock.calls.at(-1)?.[0].amount_in).toBe('255');
  });

  it('rejects invalid sell percentages without submitting a swap', async () => {
    publishSwapMock.mockClear();

    const result = await sellAtTarget('user-1', 'pos-1', 101);

    expect(result).toEqual({ success: false, reason: 'invalid_sell_percentage' });
    expect(publishSwapMock).not.toHaveBeenCalled();
  });

  it('sells EVM positions from their decimal holding, even below one token', async () => {
    const evmPosition = { id: 'pos-1', user_id: 'user-1', status: 'open', chain: 'hyperevm', token_address: '0xabc', quantity_held: '0.5' };
    publishSwapMock.mockResolvedValue({ success: true, txHash: 'tx-3' });

    db.getPositionById.mockResolvedValueOnce(evmPosition);
    expect((await sellAtTarget('user-1', 'pos-1', 50)).success).toBe(true);
    expect(publishSwapMock.mock.calls.at(-1)?.[0].amount_in).toBe('0.25');

    db.getPositionById.mockResolvedValueOnce({ ...evmPosition, quantity_held: '12.345678' });
    await sellAtTarget('user-1', 'pos-1', 100);
    expect(publishSwapMock.mock.calls.at(-1)?.[0].amount_in).toBe('12.345678');
  });
});
