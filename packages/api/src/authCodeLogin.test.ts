import { describe, it, expect, vi } from 'vitest';

// Never reach a real database from this test: dotenv does not override a variable that is already set
process.env.DATABASE_URL = 'postgres://code-login-test@127.0.0.1:1/none';
process.env.DATABASE_URL_UNPOOLED = 'postgres://code-login-test@127.0.0.1:1/none';

// Verification requests live in authSession's in-memory store: no Redis here
vi.mock('@racerbot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@racerbot/shared')>()),
  createRedis: () => { throw new Error('no redis in tests'); },
}));
const victim = { id: 'u-victim', telegram_id: 222, username: 'victim', subaccount_id: 'victim.racerbot.near' };
vi.mock('@racerbot/db', () => ({
  getDb: async () => ({ query: async () => ({ rows: [victim] }) }),
  getUserByTelegramId: vi.fn(async () => victim),
  getUserById: vi.fn(async () => victim),
  createUserWallet: vi.fn(),
  getUserWallets: vi.fn(async () => []),
  syncUserActiveWallet: vi.fn(),
}));
vi.mock('./wallet.js', () => ({ createSubaccount: vi.fn() }));
vi.mock('./notify.js', () => ({ getBotInstance: () => null }));

const { requestTelegramVerification, verifyTelegramCode, getTelegramVerification, MAX_CODE_ATTEMPTS } = await import('./authSession.js');
const { unprovenWalletClaim } = await import('./routes/verifiedUser.js');

async function newRequest() {
  const res = await requestTelegramVerification('victim');
  expect(res.success).toBe(true);
  const vreq = await getTelegramVerification(res.requestId!);
  return { requestId: res.requestId!, code: vreq!.code };
}

const wrong = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

describe('code login cannot be brute-forced', () => {
  it('locks a request after a few wrong codes, even if the right code follows', async () => {
    const { requestId, code } = await newRequest();
    for (let i = 1; i < MAX_CODE_ATTEMPTS; i++) {
      const r = await verifyTelegramCode(requestId, wrong(code));
      expect(r.success).toBe(false);
      expect(r.reason).toContain(`${MAX_CODE_ATTEMPTS - i} attempt`);
    }
    expect((await verifyTelegramCode(requestId, wrong(code))).reason).toMatch(/Too many wrong codes/);
    const late = await verifyTelegramCode(requestId, code);
    expect(late.success).toBe(false);
    expect(late.authToken).toBeUndefined();
  });

  it('still accepts the right code within the limit', async () => {
    const { requestId, code } = await newRequest();
    await verifyTelegramCode(requestId, wrong(code));
    const ok = await verifyTelegramCode(requestId, code);
    expect(ok.success).toBe(true);
    expect(ok.authToken).toMatch(/^racer_tok_/);
  });
});

describe('an unproven wallet claim is for read-only requests only', () => {
  it('counts the x-wallet-address header on GET, never on a request that changes state', () => {
    const headers = { 'x-wallet-address': ' alice.near ' };
    expect(unprovenWalletClaim({ method: 'GET', headers, query: {} })).toBe('alice.near');
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(unprovenWalletClaim({ method, headers, query: {}, body: { walletAddress: 'alice.near' } })).toBeNull();
    }
    expect(unprovenWalletClaim({ method: 'GET', headers: {}, query: {} })).toBeNull();
  });
});
