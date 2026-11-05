import { describe, it, expect, vi, beforeEach } from 'vitest';

// Never reach a real database from this test: dotenv does not override a variable that is already set
process.env.DATABASE_URL = 'postgres://conf-worker-test@127.0.0.1:1/none';
process.env.DATABASE_URL_UNPOOLED = 'postgres://conf-worker-test@127.0.0.1:1/none';
process.env.CONFIDENTIAL_EXECUTORS_ENABLED = 'true';

const db = {
  moves: [] as any[],
  open: [] as any[],
  expireStaleConfidentialQuotes: vi.fn(async () => 0),
  markConfidentialMovesChecked: vi.fn(async () => {}),
  touchExecutors: vi.fn(async () => {}),
  updateConfidentialMove: vi.fn(async () => {}),
  updateExecutor: vi.fn(async () => {}),
};
vi.mock('@racerbot/db', () => ({
  listOpenConfidentialMoves: vi.fn(async () => db.moves),
  expireStaleConfidentialQuotes: (...a: any[]) => (db.expireStaleConfidentialQuotes as any)(...a),
  markConfidentialMovesChecked: (...a: any[]) => (db.markConfidentialMovesChecked as any)(...a),
  touchExecutors: (...a: any[]) => (db.touchExecutors as any)(...a),
  updateConfidentialMove: (...a: any[]) => (db.updateConfidentialMove as any)(...a),
  updateExecutor: (...a: any[]) => (db.updateExecutor as any)(...a),
  listExecutorsByStatus: vi.fn(async (statuses: string[]) => (statuses.includes('open') ? db.open : [])),
  getConfidentialAccount: vi.fn(async () => null),
  getExecutor: vi.fn(async (id: string) => ({ account_id: id, user_id: 'u1' })),
  claimReadyExecutors: vi.fn(), createConfidentialAccount: vi.fn(), getUserConfidentialMove: vi.fn(),
  insertConfidentialMove: vi.fn(), insertExecutor: vi.fn(), listUserConfidentialMoves: vi.fn(), listUserExecutors: vi.fn(async () => []),
  listActiveConfidentialAccounts: vi.fn(async () => []),
}));
const balances: Record<string, string | Error> = {};
const view = vi.fn(async () => { throw new Error('UNKNOWN_ACCOUNT'); });
vi.mock('@racerbot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@racerbot/shared')>()),
  // Quiet logger: worker warnings would otherwise race the test runner's shutdown
  createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
  getNear: () => ({
    getTokenBalance: async (_token: string, account: string) => {
      const b = balances[account];
      if (b instanceof Error) throw b;
      return b ?? '0';
    },
    view,
  }),
}));
vi.mock('./intentsPrivate.js', () => ({
  getMoveStatus: vi.fn(async () => ({ status: 'PENDING_DEPOSIT' })),
  generatePrivateAccount: vi.fn(), getPrivateNearBalance: vi.fn(), notifyDeposit: vi.fn(), ownerHash: vi.fn(),
  quoteShield: vi.fn(), quoteShieldFromAsset: vi.fn(), unshield: vi.fn(),
}));

const { _workerTickForTest: workerTick } = await import('./executorPool.js');

beforeEach(() => {
  db.moves = [];
  db.open = [];
  for (const k of Object.keys(balances)) delete balances[k];
  vi.clearAllMocks();
});

describe('confidential worker', () => {
  it('expires unpaid deposit quotes and sends checked moves to the back of the queue', async () => {
    db.moves = [{ id: 'm1', kind: 'refill', status: 'PENDING_DEPOSIT', deposit_address: 'a' }, { id: 'm2', kind: 'deposit', status: 'PENDING_DEPOSIT', deposit_address: 'b' }];
    await workerTick();
    expect(db.expireStaleConfidentialQuotes).toHaveBeenCalledWith(48);
    expect(db.markConfidentialMovesChecked).toHaveBeenCalledWith(['m1', 'm2']);
  });

  it('closes an open executor that holds none of its token, and leaves the others', async () => {
    db.open = [
      { account_id: 'empty.exec.near', token: 'tok.near', status: 'open' },
      { account_id: 'holding.exec.near', token: 'tok.near', status: 'open' },
      { account_id: 'rpcdown.exec.near', token: 'tok.near', status: 'open' },
    ];
    balances['empty.exec.near'] = '0';
    balances['holding.exec.near'] = '5000';
    balances['rpcdown.exec.near'] = new Error('RPC timeout');
    await workerTick();
    // closeExecutor starts by reading the executor's on-chain state
    const closedAccounts = view.mock.calls.map((c: any) => c[0]);
    expect(closedAccounts).toEqual(['empty.exec.near']);
    expect(db.touchExecutors).toHaveBeenCalledWith(['empty.exec.near', 'holding.exec.near', 'rpcdown.exec.near']);
  });
});
