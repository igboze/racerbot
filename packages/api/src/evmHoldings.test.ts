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
// Elysium reads: Multicall3 balances and ERC-20 decimals
const chainCall = vi.fn();
vi.mock('@racerbot/shared', async (importActual) => {
  const actual = await importActual<typeof import('@racerbot/shared')>();
  return { ...actual, getEvmProvider: () => ({ call: (tx: any) => chainCall(tx), getNetwork: async () => ({ chainId: 99901n }) }) };
});

const { trackEvmHolding, reopenWronglyClosedEvmPositions } = await import('./evmHoldings.js');
const { ethers } = await import('ethers');

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

describe('reopenWronglyClosedEvmPositions', () => {
  const AE = '0x236F08aeC319E8eEE7FFcbA687f331E6d5180E4C';
  const mc = new ethers.Interface(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[] returnData)']);
  const erc20 = new ethers.Interface(['function decimals() view returns (uint8)']);
  beforeEach(() => {
    query.mockReset();
    chainCall.mockReset().mockImplementation(async (tx: any) => {
      if (tx.data.startsWith(erc20.getFunction('decimals')!.selector)) return erc20.encodeFunctionResult('decimals', [18]);
      const balance = ethers.toBeHex(423_000n * 10n ** 18n, 32);
      return mc.encodeFunctionResult('aggregate3', [[[true, balance]]]);
    });
  });

  it('reopens an Elysium bag the old holdings list closed as dust, at the real wallet balance', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'pos-ae', chain: 'elysium', token_address: AE }] }).mockResolvedValue({ rows: [] });
    expect(await reopenWronglyClosedEvmPositions(user)).toBe(1);
    const [sql, params] = query.mock.calls[1];
    expect(sql).toContain("SET status = 'open'");
    expect(params).toEqual(['pos-ae', '423000.0']);
  });

  it('leaves a position closed when the wallet no longer holds the coin', async () => {
    chainCall.mockImplementation(async () => mc.encodeFunctionResult('aggregate3', [[[true, ethers.toBeHex(0n, 32)]]]));
    query.mockResolvedValueOnce({ rows: [{ id: 'pos-ae', chain: 'elysium', token_address: AE }] });
    expect(await reopenWronglyClosedEvmPositions(user)).toBe(0);
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('EVM holding amounts', () => {
  it('shows a stored EVM quantity as whole tokens, never divided by 10^18', async () => {
    const { formatHoldingQuantity } = await import('./routes.js');
    expect(formatHoldingQuantity('423000.123', 18, 'elysium')).toBe('423,000.12');
    expect(formatHoldingQuantity('0.5', 18, 'hyperevm')).toBe('0.5000');
    // NEAR keeps raw units
    expect(formatHoldingQuantity('5000000000000000000000000', 24, 'near')).toBe('5.00');
  });

  it('reads stored EVM amounts as they are', async () => {
    const { evmStoredAmount, isEvmChainName } = await import('@racerbot/shared');
    expect(evmStoredAmount('423000.5')).toBe(423000.5);
    expect(evmStoredAmount(null)).toBe(0);
    expect(isEvmChainName('elysium')).toBe(true);
    expect(isEvmChainName('starknet')).toBe(false);
  });
});

