import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.KEY_ENCRYPTION_MASTER_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

// Bookkeeping that never finishes: the trade result must not wait for it
const never = () => new Promise<never>(() => { });
const db = vi.hoisted(() => ({
  recordFee: vi.fn(),
  distributeTradeFeeRewards: vi.fn(),
  awardPointsForTradeFill: vi.fn(),
  getUserById: vi.fn(),
  getOpenPositions: vi.fn(),
  createPosition: vi.fn(),
  createFill: vi.fn(),
  getPositionById: vi.fn(),
}));

vi.mock('@racerbot/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@racerbot/shared')>();
  return {
    ...actual,
    getNear: () => ({ getTokenMetadata: async () => ({ decimals: 18, name: 'Gta', symbol: 'GTA' }) }),
  };
});
vi.mock('@racerbot/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@racerbot/db')>();
  return { ...actual, ...db };
});

const { SwapExecutor } = await import('./executor.js');

const redisStub: any = { publish: vi.fn(async () => 1), get: vi.fn(async () => null), set: vi.fn(async () => {}) };
const executor: any = new SwapExecutor(redisStub, {} as any);
const event: any = { type: 'execute_swap', user_id: 'u1', notify_user: false };

beforeEach(() => {
  vi.clearAllMocks();
  db.recordFee.mockImplementation(never);
  db.distributeTradeFeeRewards.mockImplementation(never);
  db.awardPointsForTradeFill.mockImplementation(never);
  db.getUserById.mockImplementation(never);
  db.getOpenPositions.mockResolvedValue([{ id: 'pos-1', token_address: 'gta.nearlytrade.near', quantity_held: '10000000000000000000', avg_entry_price: '0.5', opened_at: new Date() }]);
  db.createPosition.mockResolvedValue({ id: 'pos-new' });
  db.createFill.mockResolvedValue({ fillId: 'f1', inserted: true });
});

/** Settles within the time limit, or rejects saying it was still waiting (recordFill is private, so `any`) */
const within = (p: Promise<any>, ms = 1000): Promise<any> =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`still waiting after ${ms}ms`)), ms))]);

describe('recordFill returns once the fill is saved', () => {
  it('for a buy, without waiting for the fee ledger, referrals, points or alerts', async () => {
    const res = await within(executor.recordFill(
      'u1', 'wrap.near', 'gta.nearlytrade.near', (10n * 10n ** 24n).toString(), (20n * 10n ** 18n).toString(),
      (15n * 10n ** 22n).toString(), 'nearlytrade', 'TXBUY', event,
    ));
    expect(res).toMatchObject({ positionId: 'pos-1', tokenSymbol: 'GTA', tokenQty: '20', nearSpent: 10 });
    expect(db.createFill).toHaveBeenCalledWith(expect.objectContaining({ side: 'buy', tx_hash: 'TXBUY' }));
    // Still started, just not awaited
    expect(db.recordFee).toHaveBeenCalledWith('f1', '0.15');
  });

  it('for a sell, without waiting for the PnL card or bookkeeping', async () => {
    const res = await within(executor.recordFill(
      'u1', 'gta.nearlytrade.near', 'wrap.near', (5n * 10n ** 18n).toString(), (3n * 10n ** 24n).toString(),
      (45n * 10n ** 21n).toString(), 'nearlytrade', 'TXSELL', event,
    ));
    expect(res).toMatchObject({ positionId: 'pos-1', nearReceived: 3, sellPercent: 50 });
    expect(db.createFill).toHaveBeenCalledWith(expect.objectContaining({ side: 'sell', tx_hash: 'TXSELL' }));
    expect(db.recordFee).toHaveBeenCalled();
  });

  it('keeps going when bookkeeping fails', async () => {
    db.recordFee.mockRejectedValue(new Error('ledger down'));
    const res = await within(executor.recordFill(
      'u1', 'wrap.near', 'gta.nearlytrade.near', (1n * 10n ** 24n).toString(), (2n * 10n ** 18n).toString(),
      '0', 'nearlytrade', 'TXBUY2', event,
    ));
    expect(res?.positionId).toBe('pos-1');
  });
});
