import { describe, it, expect, vi, beforeEach } from 'vitest';

// Never reach a real database from this test: dotenv does not override a variable that is already set
process.env.DATABASE_URL = 'postgres://web-login-test@127.0.0.1:1/none';
process.env.DATABASE_URL_UNPOOLED = 'postgres://web-login-test@127.0.0.1:1/none';

// Sessions live in authSession's in-memory store: no Redis here
vi.mock('@racerbot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@racerbot/shared')>()),
  createRedis: () => { throw new Error('no redis in tests'); },
}));
const users: Record<number, any> = {
  111: { id: 'u-owner', telegram_id: 111, subaccount_id: 'owner.racerbot.near' },
  222: { id: 'u-victim', telegram_id: 222, subaccount_id: 'victim.racerbot.near' },
};
vi.mock('@racerbot/db', () => ({
  getUserByTelegramId: vi.fn(async (tg: number) => users[tg] ?? null),
  getUserById: vi.fn(async (id: string) => Object.values(users).find(u => u.id === id) ?? null),
  createUserWallet: vi.fn(),
  getUserWallets: vi.fn(async () => []),
  syncUserActiveWallet: vi.fn(),
}));
vi.mock('./wallet.js', () => ({ createSubaccount: vi.fn() }));
vi.mock('./notify.js', () => ({ getBotInstance: () => null }));

const { createAuthSession, getAuthSession, verifyAuthToken, claimAuthSession } = await import('./authSession.js');
const { askWebLoginApproval, registerWebLoginApproval } = await import('./webLoginApproval.js');

function fakeBot() {
  const actions: [RegExp, Function][] = [];
  registerWebLoginApproval({ action: (re: RegExp, fn: Function) => actions.push([re, fn]) } as any);
  return async (data: string, ctx: any) => {
    for (const [re, fn] of actions) {
      const m = data.match(re);
      if (m) return fn({ ...ctx, match: m });
    }
  };
}

function fakeCtx(telegramId: number, chatType = 'private') {
  return {
    from: { id: telegramId, username: `user${telegramId}`, first_name: 'Racer' },
    chat: { type: chatType },
    reply: vi.fn(async () => ({})),
    editMessageText: vi.fn(async () => ({})),
    answerCbQuery: vi.fn(async () => true),
  };
}

const sessionIdFrom = (deepLink: string) => new URL(deepLink).searchParams.get('start')!.replace('auth_', '');

let sessionId = '';
beforeEach(async () => {
  sessionId = sessionIdFrom((await createAuthSession()).deepLink);
});

describe('web login through the bot needs approval', () => {
  it('tapping the link only asks; nothing is linked and no token exists yet', async () => {
    const ctx = fakeCtx(222);
    await askWebLoginApproval(ctx as any, sessionId);
    const [text, extra] = ctx.reply.mock.calls[0] as any;
    expect(text).toContain('Log in to the RacerBot web app?');
    expect(text).toContain('If someone sent you this link, tap Deny');
    const [approve, deny] = extra.reply_markup.inline_keyboard.flat();
    expect(approve.callback_data).toBe(`webauth_ok:${sessionId}`);
    expect(deny.callback_data).toBe(`webauth_no:${sessionId}`);

    const session = await getAuthSession(sessionId);
    expect(session).toMatchObject({ status: 'pending' });
    expect(session?.authToken).toBeUndefined();
    expect(session?.userId).toBeUndefined();
  });

  it('Approve links the session to the account that approved it', async () => {
    const press = fakeBot();
    const ctx = fakeCtx(111);
    await press(`webauth_ok:${sessionId}`, ctx);
    const session = await getAuthSession(sessionId);
    expect(session).toMatchObject({ status: 'linked', userId: 'u-owner', telegramId: 111 });
    expect(await verifyAuthToken(session!.authToken!)).toEqual({ userId: 'u-owner', telegramId: 111 });
    expect((ctx.editMessageText.mock.calls[0] as any)[0]).toContain('WebApp Connected');
  });

  it('hands the login token to the polling page once', async () => {
    await fakeBot()(`webauth_ok:${sessionId}`, fakeCtx(111));
    const first = await claimAuthSession(sessionId);
    expect(first).toMatchObject({ status: 'linked', userId: 'u-owner' });
    expect(first?.authToken).toBeTruthy();
    const again = await claimAuthSession(sessionId);
    expect(again?.status).toBe('claimed');
    expect(again?.authToken).toBeUndefined();
    expect(await verifyAuthToken(first!.authToken!)).toEqual({ userId: 'u-owner', telegramId: 111 });
  });

  it('Deny ends the session: the web page stops waiting and a later Approve does nothing', async () => {
    const press = fakeBot();
    const victim = fakeCtx(222);
    await press(`webauth_no:${sessionId}`, victim);
    expect(await getAuthSession(sessionId)).toMatchObject({ status: 'expired' });
    expect((victim.editMessageText.mock.calls[0] as any)[0]).toContain('Nobody was logged in');

    await press(`webauth_ok:${sessionId}`, victim);
    const session = await getAuthSession(sessionId);
    expect(session?.status).toBe('expired');
    expect(session?.authToken).toBeUndefined();
  });

  it('a used session cannot be approved again by someone else', async () => {
    const press = fakeBot();
    await press(`webauth_ok:${sessionId}`, fakeCtx(111));
    const other = fakeCtx(222);
    await press(`webauth_ok:${sessionId}`, other);
    expect(await getAuthSession(sessionId)).toMatchObject({ userId: 'u-owner', telegramId: 111 });
    expect((other.editMessageText.mock.calls[0] as any)[0]).toContain('expired or was already used');
  });

  it('refuses unknown, malformed and stale sessions', async () => {
    for (const bad of ['sess_' + '0'.repeat(32), 'not-a-session', "sess_'; DROP"]) {
      const ctx = fakeCtx(222);
      await askWebLoginApproval(ctx as any, bad);
      expect((ctx.reply.mock.calls[0] as any)[0]).toContain('Session Expired or Invalid');
      expect((ctx.reply.mock.calls[0] as any)[1].reply_markup).toBeUndefined();
    }
    const session = await getAuthSession(sessionId);
    session!.createdAt = Date.now() - 11 * 60 * 1000;
    const press = fakeBot();
    await press(`webauth_ok:${sessionId}`, fakeCtx(111));
    expect((await getAuthSession(sessionId))?.status).toBe('pending');
  });

  it('does nothing in a group chat', async () => {
    const group = fakeCtx(222, 'supergroup');
    await askWebLoginApproval(group as any, sessionId);
    expect((group.reply.mock.calls[0] as any)[1].reply_markup).toBeUndefined();
    const press = fakeBot();
    await press(`webauth_ok:${sessionId}`, group);
    expect(await getAuthSession(sessionId)).toMatchObject({ status: 'pending' });
    expect(group.editMessageText).not.toHaveBeenCalled();
  });
});
