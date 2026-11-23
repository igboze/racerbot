import { describe, it, expect, vi } from 'vitest';

// Never reach a real database from this test: dotenv does not override a variable that is already set
process.env.DATABASE_URL = 'postgres://code-flood-test@127.0.0.1:1/none';
process.env.DATABASE_URL_UNPOOLED = 'postgres://code-flood-test@127.0.0.1:1/none';

vi.mock('@racerbot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@racerbot/shared')>()),
  createRedis: () => { throw new Error('no redis in tests'); },
}));
const target = { id: 'u-target', telegram_id: 333, username: 'badguy', subaccount_id: 'target.racerbot.near' };
vi.mock('@racerbot/db', () => ({
  getDb: async () => ({ query: async () => ({ rows: [target] }) }),
  getUserByTelegramId: vi.fn(async () => target),
  getUserById: vi.fn(async () => target),
  createUserWallet: vi.fn(),
  getUserWallets: vi.fn(async () => []),
  syncUserActiveWallet: vi.fn(),
}));
vi.mock('./wallet.js', () => ({ createSubaccount: vi.fn() }));
const dms: { chatId: number; text: string }[] = [];
vi.mock('./notify.js', () => ({
  getBotInstance: () => ({ telegram: { sendMessage: async (chatId: number, text: string) => { dms.push({ chatId, text }); } } }),
}));

const { requestTelegramVerification, verifyTelegramCode, getTelegramVerification, MAX_CODE_ATTEMPTS, MAX_CODE_DMS_PER_HOUR, isCodeLoginEnabled } =
  await import('./authSession.js');

const ATTACKER = { ip: '102.89.68.154', userAgent: 'Python-urllib/3.14' };
const burn = async (requestId: string) => {
  const { code } = (await getTelegramVerification(requestId))!;
  const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
  for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) await verifyTelegramCode(requestId, wrong);
};

describe('username + code sign-in', () => {
  it('is switched off unless CODE_LOGIN_ENABLED=on', () => {
    expect(isCodeLoginEnabled()).toBe(false);
    vi.stubEnv('CODE_LOGIN_ENABLED', 'on');
    expect(isCodeLoginEnabled()).toBe(true);
    vi.unstubAllEnvs();
  });
});

describe('a script flooding one account with sign-in codes (if code sign-in is ever switched on)', () => {
  it('gets one DM per open request, a capped number per hour, and the owner sees where it came from', async () => {
    // 40 requests in a burst (what hit @fast_eag): one DM, one request id
    const burst = [];
    for (let i = 0; i < 40; i++) burst.push(await requestTelegramVerification('badguy', ATTACKER));
    expect(burst.filter((r) => !r.success).map((r) => r.reason)).toEqual([]);
    expect(new Set(burst.map((r) => r.requestId)).size).toBe(1);
    expect(dms).toHaveLength(1);
    expect(dms[0].text).toContain('102.89.68.154');
    expect(dms[0].text).toContain('Python-urllib');
    expect(dms[0].text).toContain('Only approve if you are signing in yourself right now');

    // Guessing out each request opens the next, up to the hourly cap
    let requestId = burst[0].requestId!;
    for (let i = 1; i < MAX_CODE_DMS_PER_HOUR; i++) {
      await burn(requestId);
      const next = await requestTelegramVerification('badguy', ATTACKER);
      expect(next.success).toBe(true);
      expect(next.requestId).not.toBe(requestId);
      requestId = next.requestId!;
    }
    expect(dms).toHaveLength(MAX_CODE_DMS_PER_HOUR);

    await burn(requestId);
    const refused = await requestTelegramVerification('badguy', ATTACKER);
    expect(refused.success).toBe(false);
    expect(refused.reason).toMatch(/Too many sign-in codes/);
    expect(dms).toHaveLength(MAX_CODE_DMS_PER_HOUR);
  });
});
