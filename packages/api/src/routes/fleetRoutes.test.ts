import { describe, it, expect, vi, beforeEach } from 'vitest';

// Never reach a real database from this test: dotenv does not override a variable that is already set
process.env.DATABASE_URL = 'postgres://fleet-routes-test@127.0.0.1:1/none';
process.env.DATABASE_URL_UNPOOLED = 'postgres://fleet-routes-test@127.0.0.1:1/none';

const owner = { id: 'u-owner', telegram_id: 111, username: 'owner', subaccount_id: 'owner.racerbot.near' };
const session = { user: null as any };
vi.mock('./verifiedUser.js', () => ({ verifiedUser: vi.fn(async () => session.user) }));

const fleet = {
  hasActiveRaceFleet: vi.fn(async () => true),
  getFleetBalances: vi.fn(async () => ({ wallets: [] })),
  deployRaceFleet: vi.fn(async () => ({ success: true })),
  distributeFundsToFleet: vi.fn(async () => ({ success: true, walletCount: 5 })),
  sweepFundsFromFleet: vi.fn(async () => ({ success: true })),
  executeFleetBundleBuy: vi.fn(async () => ({ success: true })),
  executeFleetBundleSell: vi.fn(async () => ({ success: true })),
  buildFleetHoldingsView: vi.fn(async () => ({})),
};
vi.mock('../raceFleet.js', () => fleet);
vi.mock('../nearFleetBundle.js', () => fleet);
vi.mock('@racerbot/db', () => ({
  getRaceFleetByUserId: vi.fn(async () => ({ id: 'f1', name: 'Alpha', wallet_count: 5, status: 'active' })),
  getRaceFleetFills: vi.fn(async () => []),
  getUserById: vi.fn(async () => null),
  getUserByTelegramId: vi.fn(async () => owner),
  getDb: vi.fn(async () => { throw new Error('no db in tests'); }),
}));

const { createFleetRouter } = await import('./fleetRoutes.js');

const router: any = createFleetRouter();
function handler(method: string, path: string): Function {
  const layer = router.stack.find((l: any) => l.route?.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`no ${method} ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
async function call(method: string, path: string, req: any) {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: any) => { res.body = b; return res; };
  res.set = () => res;
  await handler(method, path)({ headers: {}, query: {}, body: {}, ...req }, res);
  return res;
}

const ROUTES: [string, string][] = [
  ['get', '/fleet/status'], ['post', '/fleet/deploy'], ['post', '/fleet/distribute'], ['post', '/fleet/sweep'],
  ['post', '/fleet/bundle-buy'], ['post', '/fleet/bundle-sell'], ['get', '/fleet/holdings'],
];

beforeEach(() => {
  session.user = null;
  for (const fn of Object.values(fleet)) fn.mockClear();
});

describe('fleet routes need a verified sign-in', () => {
  it('refuse a request that only names a Telegram ID or username, and touch nothing', async () => {
    for (const [m, p] of ROUTES) {
      const forged = { body: { telegramId: 111, username: 'owner', totalNear: 5, tokenAddress: 'x.near', amountNear: 1, walletCount: 5 }, query: { telegramId: '111', username: 'owner' } };
      const res = await call(m, p, forged);
      expect(res.statusCode, `${m} ${p}`).toBe(401);
      expect(res.body.error).toMatch(/Sign in/);
    }
    for (const fn of Object.values(fleet)) expect(fn).not.toHaveBeenCalled();
  });

  it('refuse a request with nothing at all (no fallback to the latest fleet owner)', async () => {
    for (const [m, p] of ROUTES) {
      expect((await call(m, p, {})).statusCode, `${m} ${p}`).toBe(401);
    }
    for (const fn of Object.values(fleet)) expect(fn).not.toHaveBeenCalled();
  });

  it('act for the verified user only, whatever the body says', async () => {
    session.user = owner;
    const res = await call('post', '/fleet/distribute', { body: { totalNear: 5, telegramId: 999 } });
    expect(res.statusCode).toBe(200);
    expect(fleet.distributeFundsToFleet).toHaveBeenCalledWith(owner, 5);
    const status = await call('get', '/fleet/status', {});
    expect(status.body.user).toMatchObject({ subaccountId: 'owner.racerbot.near' });
  });
});
