import { describe, it, expect, vi, beforeEach } from 'vitest';

const query = vi.fn();
const createPosition = vi.fn();
const notifyTokenDeposit = vi.fn();

vi.mock('@racerbot/db', () => ({
  getDb: async () => ({ query }),
  createPosition: (...args: any[]) => createPosition(...args),
  getOpenPositions: vi.fn(async () => []),
  getUserById: vi.fn(),
}));
vi.mock('./notify.js', () => ({ notifyTokenDeposit: (...args: any[]) => notifyTokenDeposit(...args) }));

const { trackEvmHolding } = await import('./evmHoldings.js');

const user = { id: 'u1', telegram_id: 42, evm_address: '0x000000000000000000000000000000000000bEEF' } as any;
const COIN = '0xbb7444bf4599536e915a7fcce172133e331bf715';

describe('trackEvmHolding', () => {
  beforeEach(() => {
    query.mockReset().mockResolvedValue({ rows: [] });
    createPosition.mockReset().mockResolvedValue({ id: 'pos-1' });
    notifyTokenDeposit.mockReset().mockResolvedValue(undefined);
  });

  it('tracks a held coin in human units at the current price, as an external deposit', async () => {
    const id = await trackEvmHolding({ user, chain: 'elysium', token: COIN, balanceRaw: 1_279_021n * 10n ** 18n, decimals: 18, priceHype: 4e-7, symbol: 'BLOS', notify: true });
    expect(id).toBe('pos-1');
    expect(createPosition).toHaveBeenCalledWith(expect.objectContaining({
      user_id: 'u1', chain: 'elysium', quantity_held: '1279021.0', avg_entry_price: '4e-7',
      token_address: '0xbb7444bF4599536e915A7fcCe172133E331bf715',
    }));
    expect(query.mock.calls.some(([sql]) => sql.includes('is_external_deposit = TRUE'))).toBe(true);
    expect(notifyTokenDeposit).toHaveBeenCalledWith(42, expect.objectContaining({ tokenSymbol: 'BLOS', chain: 'elysium', positionId: 'pos-1' }));
  });

  it('does not revive a coin the user sold or closed in the last 15 minutes', async () => {
    query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    expect(await trackEvmHolding({ user, chain: 'elysium', token: COIN, balanceRaw: 10n ** 18n, decimals: 18, priceHype: 0 })).toBeNull();
    expect(createPosition).not.toHaveBeenCalled();
  });

  it('ignores an empty balance', async () => {
    expect(await trackEvmHolding({ user, chain: 'hyperevm', token: COIN, balanceRaw: 0n, decimals: 18, priceHype: 0 })).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
});
