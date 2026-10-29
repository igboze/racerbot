import { describe, it, expect, vi, beforeEach } from 'vitest';

const signedIn = { id: 'u1', subaccount_id: 'alice.near', scoped_key_encrypted: '' };
const verifiedUser = vi.fn(async (req: any) => (req.headers.authorization === 'Bearer good' ? signedIn : null));
const createWebManagedWallet = vi.fn(async () => ({ address: 'ab'.repeat(32), created: true }));

vi.mock('./verifiedUser.js', () => ({ verifiedUser: (req: any) => verifiedUser(req) }));
vi.mock('../webWallet.js', () => ({
  createWebManagedWallet: () => createWebManagedWallet(),
  EXTERNAL_WALLET_MARKER: 'EXTERNAL_CONNECTED_WALLET',
  hasManagedWallet: (u: any) => Boolean(u.scoped_key_encrypted),
}));
vi.mock('@racerbot/db', () => ({ getUserWallets: vi.fn(async () => []) }));

const { registerWebWalletRoutes } = await import('./webWallet.js');
const handlers: Record<string, any> = {};
registerWebWalletRoutes({
  get: (p: string, h: any) => { handlers[`GET ${p}`] = h; },
  post: (p: string, h: any) => { handlers[`POST ${p}`] = h; },
} as any);

async function call(route: string, headers: Record<string, string>) {
  const res: any = { statusCode: 200 };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: any) => { res.body = b; return res; };
  await handlers[route]({ headers, body: {} }, res);
  return res;
}

describe('Racer Alpha wallet routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('a wallet-address header alone cannot create or read a wallet', async () => {
    for (const route of ['GET /alpha/wallet', 'POST /alpha/wallet/create']) {
      const res = await call(route, { 'x-wallet-address': 'alice.near' });
      expect(res.statusCode).toBe(401);
    }
    expect(createWebManagedWallet).not.toHaveBeenCalled();
  });

  it('creation answers with public fields only', async () => {
    const res = await call('POST /alpha/wallet/create', { authorization: 'Bearer good' });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['address', 'created', 'message', 'success']);
    expect(JSON.stringify(res.body)).not.toMatch(/ed25519:|private|secret|encrypted/i);
  });

  it('reports whether the active wallet is managed', async () => {
    const res = await call('GET /alpha/wallet', { authorization: 'Bearer good' });
    expect(res.body).toMatchObject({ success: true, address: 'alice.near', managed: false, connectedWallets: [] });
  });
});
