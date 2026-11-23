import { describe, it, expect, vi, afterEach } from 'vitest';

// Never reach a real database: dotenv does not override a variable that is already set
process.env.DATABASE_URL = 'postgres://web-sessions-test@127.0.0.1:1/none';
process.env.REDIS_URL = '';

vi.mock('@racerbot/db', () => ({
  getUserById: vi.fn(async (id: string) => users[id] ?? null),
  getUserByTelegramId: vi.fn(async () => null),
}));
const users: Record<string, any> = {
  tg: { id: 'tg', telegram_id: 111 },
  web: { id: 'web', telegram_id: 0 },
};

const ws = await import('./webSessions.js');
const { fundsOutAllowed } = await import('./routes/verifiedUser.js');
const { buildWebSessionsScreen } = await import('./webSessionsBot.js');
const { formatSecurityAlert } = await import('./securityAlerts.js');

afterEach(() => vi.useRealTimers());

const ATTACKER = { ip: '102.89.68.154', userAgent: 'Python-urllib/3.14' };

describe('web sessions', () => {
  it('are listed for their owner and can be logged out one by one or all at once', async () => {
    const a = await ws.issueWebSession({ userId: 'u1', telegramId: 1, method: 'telegram', origin: { ip: '1.2.3.4', userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120' } });
    const b = await ws.issueWebSession({ userId: 'u1', telegramId: 1, method: 'code', origin: ATTACKER });
    const other = await ws.issueWebSession({ userId: 'u2', telegramId: 2, method: 'telegram' });

    expect((await ws.listWebSessions('u1')).map((s) => s.sid).sort()).toEqual([a.session.sid, b.session.sid].sort());
    expect(await ws.verifyWebSession(b.token)).toMatchObject({ userId: 'u1', method: 'code', ip: ATTACKER.ip });

    // Someone else's session id does nothing in this account
    expect(await ws.revokeWebSession('u1', other.session.sid)).toBe(false);
    expect(await ws.verifyWebSession(other.token)).not.toBeNull();

    expect(await ws.revokeWebSession('u1', b.session.sid)).toBe(true);
    expect(await ws.verifyWebSession(b.token)).toBeNull();
    expect(await ws.verifyWebSession(a.token)).not.toBeNull();

    expect(await ws.revokeAllWebSessions('u1')).toBe(1);
    expect(await ws.verifyWebSession(a.token)).toBeNull();
    expect(await ws.listWebSessions('u1')).toEqual([]);
  });

  it('last 7 days, renew while used, and never outlive 30 days', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-23T00:00:00Z'));
    const { token } = await ws.issueWebSession({ userId: 'u3', telegramId: 3, method: 'telegram' });
    const day = 24 * 3600 * 1000;

    vi.setSystemTime(Date.now() + 6 * day);
    expect(await ws.verifyWebSession(token)).not.toBeNull(); // used on day 6: renewed for 7 more days
    vi.setSystemTime(Date.now() + 6 * day);
    expect(await ws.verifyWebSession(token)).not.toBeNull(); // day 12, still fine

    vi.setSystemTime(Date.now() + 8 * day);
    expect(await ws.verifyWebSession(token)).toBeNull(); // 8 days unused: expired
  });

  it('end 30 days after sign-in even if used every day', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-23T00:00:00Z'));
    const { token } = await ws.issueWebSession({ userId: 'u4', telegramId: 4, method: 'telegram' });
    for (let d = 1; d <= 29; d++) {
      vi.setSystemTime(new Date('2026-11-23T00:00:00Z').getTime() + d * 24 * 3600 * 1000);
      expect(await ws.verifyWebSession(token)).not.toBeNull();
    }
    vi.setSystemTime(new Date('2026-11-23T00:00:00Z').getTime() + 30 * 24 * 3600 * 1000 + 1000);
    expect(await ws.verifyWebSession(token)).toBeNull();
  });

  it('names scripts as scripts, so the owner can tell it was not their browser', () => {
    expect(ws.describeDevice('Python-urllib/3.14')).toMatch(/^a script/);
    expect(ws.describeDevice('curl/8.7.1')).toMatch(/^a script/);
    expect(ws.describeDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1')).toBe('Safari on iOS');
  });
});

describe('withdrawals from a browser', () => {
  const req = (auth: string) => ({ headers: { authorization: auth } });

  it('are refused for Telegram-linked accounts signed in only in a browser', async () => {
    const { token } = await ws.issueWebSession({ userId: 'tg', telegramId: 111, method: 'code', origin: ATTACKER });
    expect(await fundsOutAllowed(req(`Bearer ${token}`), users.tg)).toBe(false);
  });

  it('are allowed from the Telegram mini app', async () => {
    const { token } = await ws.issueWebSession({ userId: 'tg', telegramId: 111, method: 'miniapp' });
    expect(await fundsOutAllowed(req(`Bearer ${token}`), users.tg)).toBe(true);
  });

  it('stay allowed for wallet-only accounts, whose only way in is the web app', async () => {
    const { token } = await ws.issueWebSession({ userId: 'web', telegramId: 0, method: 'wallet' });
    expect(await fundsOutAllowed(req(`Bearer ${token}`), users.web)).toBe(true);
  });

  it('cannot borrow another account\'s mini-app session', async () => {
    const { token } = await ws.issueWebSession({ userId: 'someone-else', telegramId: 222, method: 'miniapp' });
    expect(await fundsOutAllowed(req(`Bearer ${token}`), users.tg)).toBe(false);
  });
});

describe('what the owner sees', () => {
  it('the sign-in alert says where it came from', () => {
    const text = formatSecurityAlert({ kind: 'web_login', method: 'sign-in code', sid: 'abcd', ip: ATTACKER.ip, device: 'a script (Python-urllib/3.14)' }, null);
    expect(text).toContain('102.89.68.154');
    expect(text).toContain('a script');
    expect(text).toContain('Log it out');
  });

  it('the sessions screen lists each browser with a log-out button', () => {
    const now = Date.now();
    const screen = buildWebSessionsScreen([
      { sid: '0123456789abcdef', method: 'code', ip: ATTACKER.ip, userAgent: ATTACKER.userAgent, createdAt: now, lastSeenAt: now, expiresAt: now + 1 },
    ]);
    expect(screen.text).toContain('102.89.68.154');
    const data = screen.keyboard.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);
    expect(data).toContain('websess_out:0123456789abcdef');
    expect(data).toContain('websess_all');
  });
});
