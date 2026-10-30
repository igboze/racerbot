import { describe, it, expect, vi, beforeEach } from 'vitest';

const managed = { id: 'u-managed', subaccount_id: 'lunar-nexus-9768.racerbot.near', scoped_key_encrypted: 'enc', telegram_id: 7 };
const external = { id: 'u-external', subaccount_id: 'alice.near', scoped_key_encrypted: '', telegram_id: 0 };
const users: Record<string, any> = { [managed.id]: managed, [external.id]: external };

const getUserById = vi.fn(async (id: string) => users[id] ?? null);
const verifyAuthToken = vi.fn(async (token: string) => (token === 'tok-managed' ? { userId: managed.id, telegramId: 7 }
  : token === 'tok-external' ? { userId: external.id, telegramId: 0 } : null));
const depositFromWallet = vi.fn(async () => ({ depositAddress: 'a'.repeat(64), txHash: 'h' }));
const quoteWalletDeposit = vi.fn(async () => ({ depositAddress: 'b'.repeat(64), amount: '1', transaction: { receiverId: 'wrap.near', actions: [] } }));

vi.mock('@racerbot/db', () => ({
  getUserById: (id: string) => getUserById(id),
  getUserByTelegramId: vi.fn(async () => null),
  getConfidentialAccount: vi.fn(async () => null),
  updateConfidentialSettings: vi.fn(async () => null),
}));
vi.mock('../authSession.js', () => ({ verifyAuthToken: (t: string) => verifyAuthToken(t) }));
vi.mock('../middleware.js', () => ({ validateTelegramInitData: () => ({ valid: false }) }));
vi.mock('../multichainDeposit.js', () => ({
  generateQrBuffer: vi.fn(async () => Buffer.from('qr')),
  generateWalletDeepLink: vi.fn(() => ''),
  getTokenByKey: vi.fn(() => undefined),
  SUPPORTED_CHAINS: {},
  unitsToRaw: vi.fn(() => '1'),
}));
vi.mock('../executorPool.js', () => ({
  EXECUTORS_ENABLED: true,
  POOL_LIMITS: { min: 10n ** 23n, hardCap: 100n * 10n ** 24n },
  confidentialOverview: vi.fn(async () => ({ privateBalance: '0' })),
  depositFromWallet: (...a: any[]) => (depositFromWallet as any)(...a),
  ensureConfidentialAccount: vi.fn(),
  isExternalWallet: (u: any) => !u.scoped_key_encrypted,
  poolSizesForTotal: vi.fn(() => []),
  quoteCrossChainDeposit: vi.fn(),
  quoteWalletDeposit: (...a: any[]) => (quoteWalletDeposit as any)(...a),
  refillPool: vi.fn(),
  submitWalletDeposit: vi.fn(),
  withdrawPrivate: vi.fn(),
}));

const { registerConfidentialRoutes } = await import('./confidential.js');

const handlers: Record<string, (req: any, res: any) => Promise<void>> = {};
registerConfidentialRoutes({
  get: (path: string, h: any) => { handlers[`GET ${path}`] = h; },
  post: (path: string, h: any) => { handlers[`POST ${path}`] = h; },
} as any);

async function call(route: string, headers: Record<string, string>, body: any = {}) {
  const res: any = { statusCode: 200, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: any) => { res.body = b; return res; };
  await handlers[route]({ headers, body, query: {} }, res);
  return res;
}

describe('private trading routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses a bare wallet-address header, even for a real RacerBot account', async () => {
    const res = await call('GET /alpha/confidential', { 'x-wallet-address': managed.subaccount_id });
    expect(res.statusCode).toBe(401);
    expect(getUserById).not.toHaveBeenCalled();
  });

  it('refuses an unknown or made-up session token', async () => {
    const res = await call('POST /alpha/confidential/withdraw', { authorization: 'Bearer racer_tok_wallet_alice_near' }, { amountNear: 1, destination: 'thief.near' });
    expect(res.statusCode).toBe(401);
  });

  it('serves a verified Telegram-managed session', async () => {
    const res = await call('GET /alpha/confidential', { authorization: 'Bearer tok-managed' });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('managed wallets deposit server-side', async () => {
    const res = await call('POST /alpha/confidential/deposit', { authorization: 'Bearer tok-managed' }, { amountNear: 1 });
    expect(res.body.requiresWalletSignature).toBeUndefined();
    expect(depositFromWallet).toHaveBeenCalledOnce();
    expect(quoteWalletDeposit).not.toHaveBeenCalled();
  });

  it('external wallets get a transaction to sign instead', async () => {
    const res = await call('POST /alpha/confidential/deposit', { authorization: 'Bearer tok-external' }, { amountNear: 1 });
    expect(res.statusCode).toBe(200);
    expect(res.body.requiresWalletSignature).toBe(true);
    expect(res.body.transaction.receiverId).toBe('wrap.near');
    expect(depositFromWallet).not.toHaveBeenCalled();
  });

  it('cross-chain deposits need a known token', async () => {
    const res = await call('POST /alpha/confidential/deposit/crosschain', { authorization: 'Bearer tok-external' }, { tokenKey: 'nope', amount: 1 });
    expect(res.statusCode).toBe(400);
  });

  it('a submitted deposit needs a real transaction hash', async () => {
    const res = await call('POST /alpha/confidential/deposit/submit', { authorization: 'Bearer tok-external' }, { depositAddress: 'b'.repeat(64), txHash: 'not a hash!' });
    expect(res.statusCode).toBe(400);
  });
});

describe('unitsToRaw', async () => {
  const { unitsToRaw } = await vi.importActual<typeof import('../multichainDeposit.js')>('../multichainDeposit.js');
  it.each([
    [0.1, 9, '100000000'],
    [1.5, 6, '1500000'],
    [0.001, 8, '100000'],
    [0.1, 18, '100000000000000000'],
    [2.3508, 24, '2350800000000000000000000'],
    [3, 0, '3'],
  ])('%s with %s decimals is %s', (amount, decimals, raw) => {
    expect(unitsToRaw(amount, decimals)).toBe(raw);
  });
});
