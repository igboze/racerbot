import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KeyPair } from 'near-api-js';

const events: string[] = [];
const createAccount = vi.fn();
const deleteAccount = vi.fn();
const withdrawFunds = vi.fn();
const upsertRaceFleet = vi.fn();
const createRaceFleetWallets = vi.fn();
let balances: Record<string, string> = {};

vi.mock('@racerbot/shared', async (importActual) => ({
  ...(await importActual<typeof import('@racerbot/shared')>()),
  getNear: () => ({ getNearBalance: async (id: string) => balances[id] ?? '0' }),
}));

vi.mock('@racerbot/db', () => ({
  getActiveWallet: async () => ({ address: 'active.near' }),
  upsertRaceFleet: (...a: any[]) => { events.push('save-fleet'); return upsertRaceFleet(...a); },
  createRaceFleetWallets: (...a: any[]) => { events.push('save-wallets'); return createRaceFleetWallets(...a); },
  getRaceFleetByUserId: async () => ({ id: 'f1', user_id: 'u1' }),
  getRaceFleetWallets: async () => [1, 2, 3].map(i => ({ account_id: `w${i}.racerbot.near`, wallet_index: i })),
  getUserByTelegramId: vi.fn(), getUserById: vi.fn(), getRaceFleetById: vi.fn(), createRaceFleetOrder: vi.fn(),
  getActiveRaceFleetOrders: vi.fn(), getRaceFleetOrdersByFleet: vi.fn(), cancelRaceFleetOrder: vi.fn(),
  updateRaceFleetOrderStatus: vi.fn(), renewRaceFleet: vi.fn(), getDb: vi.fn(), recordRaceFleetFill: vi.fn(), getRaceFleetFills: vi.fn(),
}));

vi.mock('./config.js', () => ({
  MASTER_KEY: 'k'.repeat(64),
  RACERBOT_PARENT_ACCOUNT: 'racerbot.near',
  MAIN_WALLET_PRIVATE_KEY: KeyPair.fromRandom('ed25519').toString(),
  TREASURY_ACCOUNT_ID: 'treasury.near',
}));

vi.mock('./wallet.js', () => ({
  getTokenInfo: vi.fn(),
  getUserBalances: vi.fn(),
  withdrawFunds: (...a: any[]) => withdrawFunds(...a),
  connectWithNearRpcFailover: async (_id: string, _kp: any, fn: (acct: any) => any) => fn({
    createAccount: (...a: any[]) => createAccount(...a),
    deleteAccount: (...a: any[]) => deleteAccount(...a),
  }),
}));
vi.mock('./routes.js', () => ({ getShortTokenKey: (a: string) => a }));
vi.mock('./nearFleetBundle.js', () => ({ fireNearTxsTogether: vi.fn(), nearActions: {} }));
vi.mock('./solanaFleet.js', () => ({}));

const { deployRaceFleet, distributeFundsToFleet } = await import('./raceFleet.js');

const user = { id: 'u1', subaccount_id: 'old.near', telegram_id: 1 } as any;

describe('RaceFleet deploy and funding', () => {
  beforeEach(() => {
    events.length = 0;
    balances = { 'active.near': (5n * 10n ** 24n).toString() };
    [createAccount, deleteAccount, withdrawFunds, upsertRaceFleet, createRaceFleetWallets].forEach(f => f.mockReset());
    createAccount.mockImplementation(async () => { events.push('create'); });
    withdrawFunds.mockImplementation(async (_u: any, to: string) => { events.push(`pay:${to}`); return { txHash: 'tx' }; });
    upsertRaceFleet.mockResolvedValue({ id: 'f1' });
    createRaceFleetWallets.mockImplementation(async (w: any[]) => w);
  });

  it('reads the balance of the wallet that pays, not the old account id', async () => {
    balances = { 'old.near': (5n * 10n ** 24n).toString(), 'active.near': '0' };
    const r = await deployRaceFleet(user, 2);
    expect(r.success).toBe(false);
    expect(r.reason).toMatch(/Insufficient balance/);
    expect(createAccount).not.toHaveBeenCalled();
  });

  it('creates the wallets first, then charges the fee, then saves them', async () => {
    const r = await deployRaceFleet(user, 3);
    expect(r.success).toBe(true);
    expect(events).toEqual(['create', 'create', 'create', 'pay:treasury.near', 'save-fleet', 'save-wallets']);
  });

  it('charges nothing when no wallet could be created', async () => {
    createAccount.mockRejectedValue(new Error('RPC down'));
    const r = await deployRaceFleet(user, 2);
    expect(r.success).toBe(false);
    expect(r.reason).toMatch(/nothing was charged/);
    expect(withdrawFunds).not.toHaveBeenCalled();
    expect(upsertRaceFleet).not.toHaveBeenCalled();
  });

  it('keeps the wallets that were created when others fail, and stores exactly those', async () => {
    let n = 0;
    createAccount.mockImplementation(async () => { n++; if (n === 2 || n === 3) throw new Error('nonce'); });
    const r = await deployRaceFleet(user, 3);
    expect(r.success).toBe(true);
    expect(upsertRaceFleet.mock.calls[0][0].wallet_count).toBe(2);
    expect(createRaceFleetWallets.mock.calls[0][0].map((w: any) => w.wallet_index)).toEqual([1, 2]);
  });

  it('removes the new wallets and saves nothing when the fee payment fails', async () => {
    withdrawFunds.mockRejectedValue(new Error('balance moved'));
    const r = await deployRaceFleet(user, 2);
    expect(r.success).toBe(false);
    expect(r.reason).toMatch(/no fleet was created/);
    expect(deleteAccount).toHaveBeenCalledTimes(2);
    expect(deleteAccount).toHaveBeenCalledWith('racerbot.near');
    expect(upsertRaceFleet).not.toHaveBeenCalled();
  });

  it('funds fleet wallets one at a time and counts the ones that worked', async () => {
    let active = 0;
    let maxActive = 0;
    withdrawFunds.mockImplementation(async (_u: any, to: string) => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 5));
      active--;
      if (to === 'w2.racerbot.near') throw new Error('nonce');
      return { txHash: 'tx' };
    });
    const r = await distributeFundsToFleet(user, 3);
    expect(maxActive).toBe(1);
    expect(r).toMatchObject({ success: true, walletCount: 2 });
  });
});
