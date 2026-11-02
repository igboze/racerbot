import { describe, it, expect, vi, beforeEach } from 'vitest';

// Never reach a real database from this test: dotenv does not override a variable that is already set
process.env.DATABASE_URL = 'postgres://racer-link-test@127.0.0.1:1/none';
process.env.DATABASE_URL_UNPOOLED = 'postgres://racer-link-test@127.0.0.1:1/none';
process.env.RACER_FOUNDING_CUTOFF = 'off';

type Row = {
  user_id: string; side: string; token_address: string; venue: string; created_at: Date;
  input_amount: string | null; fee_paid: string; position_id: string | null; position_status: string | null;
};
type Exec = {
  user_id: string; account_id: string; status: string; token: string | null; venue: string | null; size_yocto: string;
  amount_spent: string | null; fee_paid: string | null; returned_amount: string | null; opened_at: Date | null; exited_at: Date | null;
};
type Link = { wallet_user_id: string; telegram_user_id: string; linked_at: Date };
type Code = { code: string; wallet_user_id: string; expires_at: number; used_at: number | null };

let rows: Row[] = [];
let execs: Exec[] = [];
let links: Link[] = [];
let codes: Code[] = [];
let ranks = new Map<string, { user_id: string; best_key: number; announced_key: number }>();
let users: Record<string, any> = {};

// In-memory tables with the same semantics as the SQL in packages/db
vi.mock('@racerbot/db', () => ({
  getNearRacerFills: vi.fn(async (userId?: string) => rows.filter(r => !userId || r.user_id === userId)),
  getConfidentialRacerExecutors: vi.fn(async (ids?: string[]) => execs.filter(e => !ids || ids.includes(e.user_id))),
  getUserByTelegramId: vi.fn(async (tg: number) => Object.values(users).find(u => u.telegram_id === tg) ?? null),
  getUserById: vi.fn(async (id: string) => users[id] ?? null),
  getUserByExactReferralCode: vi.fn(async (code: string) => Object.values(users).find(u => u.referral_code === code) ?? null),
  generateReferralCode: vi.fn(async (id: string, name: string) => {
    users[id].referral_code = `${name}-AB12C`;
    return users[id].referral_code;
  }),
  getRacerRank: vi.fn(async (id: string) => (ranks.has(id) ? { ...ranks.get(id)! } : null)),
  seedRacerRank: vi.fn(async (id: string, best: number, announced: number) => {
    if (!ranks.has(id)) ranks.set(id, { user_id: id, best_key: best, announced_key: Math.min(announced, best) });
    return { ...ranks.get(id)! };
  }),
  raiseRacerBestKey: vi.fn(async (id: string, best: number) => {
    const r = ranks.get(id);
    if (r && r.best_key < best) r.best_key = best;
  }),
  claimRacerRankUp: vi.fn(async (id: string, key: number) => {
    const r = ranks.get(id);
    if (!r || r.announced_key >= key) return false;
    r.announced_key = key;
    r.best_key = Math.max(r.best_key, key);
    return true;
  }),
  getRacerLinkFor: vi.fn(async (id: string) => links.find(l => l.wallet_user_id === id || l.telegram_user_id === id) ?? null),
  listRacerLinks: vi.fn(async () => links),
  createRacerLinkCode: vi.fn(async (walletUserId: string, code: string, ttlMs: number) => {
    codes = codes.filter(c => !(c.wallet_user_id === walletUserId && c.used_at === null));
    codes.push({ code, wallet_user_id: walletUserId, expires_at: Date.now() + ttlMs, used_at: null });
  }),
  peekRacerLinkCode: vi.fn(async (code: string) => {
    const c = codes.find(x => x.code === code && x.used_at === null && x.expires_at > Date.now());
    return c?.wallet_user_id ?? null;
  }),
  consumeRacerLinkCode: vi.fn(async (code: string) => {
    const c = codes.find(x => x.code === code && x.used_at === null && x.expires_at > Date.now());
    if (!c) return null;
    c.used_at = Date.now();
    return c.wallet_user_id;
  }),
  linkRacerAccounts: vi.fn(async (w: string, t: string) => {
    if (links.some(l => l.wallet_user_id === w && l.telegram_user_id === t)) return 'already';
    if (links.some(l => l.wallet_user_id === w || l.telegram_user_id === t)) return 'conflict';
    links.push({ wallet_user_id: w, telegram_user_id: t, linked_at: new Date() });
    return 'linked';
  }),
}));
vi.mock('./racerCardImageGenerator.js', () => ({
  generateRacerCardImage: vi.fn(async () => Buffer.from('png')),
  generateRacerCardOgImage: vi.fn(async () => Buffer.from('preview-png')),
}));
const session = { user: null as any };
vi.mock('./routes/verifiedUser.js', () => ({ verifiedUser: vi.fn(async () => session.user) }));

const card = await import('./racerCard.js');
const { createRacerCardRouter } = await import('./routes/racerCardRoutes.js');
const db = await import('@racerbot/db');

const N = (near: number) => (BigInt(Math.round(near * 1000)) * 10n ** 21n).toString();
const row = (o: Partial<Row>): Row => ({
  user_id: 'tg', side: 'buy', token_address: 'secret-token.near', venue: 'rhea', created_at: new Date('2026-10-01T12:00:00Z'),
  input_amount: '10', fee_paid: '0.15', position_id: null, position_status: null, ...o,
});
const exec = (o: Partial<Exec>): Exec => ({
  user_id: 'wallet', account_id: 'e1.exec.near', status: 'open', token: 'secret-token.near', venue: 'rhea', size_yocto: N(60),
  amount_spent: N(59), fee_paid: N(1), returned_amount: null, opened_at: new Date('2026-10-05T12:00:00Z'), exited_at: null, ...o,
});

function fakeBot() {
  const commands = new Map<string, Function>();
  const actions: [RegExp | string, Function][] = [];
  const telegram = { sendMessage: vi.fn(async () => ({})), sendPhoto: vi.fn(async () => ({})) };
  const bot: any = {
    command: (names: string | string[], fn: Function) => [names].flat().forEach(n => commands.set(n, fn)),
    action: (name: RegExp | string, fn: Function) => actions.push([name, fn]),
    telegram,
  };
  card.registerRacerCard(bot);
  const press = async (data: string, ctx: any) => {
    for (const [trigger, fn] of actions) {
      const m = typeof trigger === 'string' ? (trigger === data ? [data] : null) : data.match(trigger);
      if (m) return fn({ ...ctx, match: m });
    }
  };
  return { commands, press, telegram };
}

function fakeCtx(telegramId: number, text = '/start', chatType = 'private') {
  return {
    from: { id: telegramId },
    chat: { type: chatType },
    message: { text },
    reply: vi.fn(async () => ({})),
    replyWithPhoto: vi.fn(async () => ({})),
    editMessageText: vi.fn(async () => ({})),
    answerCbQuery: vi.fn(async () => true),
  };
}

async function linkCode(): Promise<string> {
  const res = await card.startRacerLink(users.wallet);
  if (res.status !== 'link') throw new Error(`expected a link, got ${res.status}`);
  return new URL(res.deepLink).searchParams.get('start')!.replace('rclink_', '');
}

beforeEach(() => {
  rows = [];
  execs = [];
  links = [];
  codes = [];
  ranks = new Map();
  users = {
    tg: { id: 'tg', telegram_id: 111, username: 'speedy', referral_code: 'SPEEDY', subaccount_id: 'speedy.racerbot.near' },
    tg2: { id: 'tg2', telegram_id: 222, username: 'other', referral_code: 'OTHER', subaccount_id: 'other.racerbot.near' },
    wallet: { id: 'wallet', telegram_id: 0, username: null, referral_code: null, subaccount_id: 'alice.near' },
    wallet2: { id: 'wallet2', telegram_id: 0, username: null, referral_code: null, subaccount_id: 'bob.near' },
  };
  session.user = null;
  card.clearRacerVolumeCache();
  card.clearRacerShareCache();
  delete process.env.PUBLIC_URL;
  vi.mocked(db.linkRacerAccounts).mockClear();
});

describe('linking a wallet-only web account to Telegram', () => {
  it('starts with a one-time bot link and links only after approval in the bot', async () => {
    const res = await card.startRacerLink(users.wallet);
    expect(res).toMatchObject({ status: 'link', expiresInSec: 600 });
    const deepLink = (res as any).deepLink as string;
    expect(deepLink).toMatch(/^https:\/\/t\.me\/racertradingbot\?start=rclink_[A-Za-z0-9_-]{16,64}$/);
    expect(links).toHaveLength(0);

    const { commands, press } = fakeBot();
    const code = new URL(deepLink).searchParams.get('start')!;
    const ctx = fakeCtx(111, `/start ${code}`);
    const next = vi.fn();
    await commands.get('start')!(ctx, next);
    expect(next).not.toHaveBeenCalled();
    const [text, extra] = ctx.reply.mock.calls[0] as any;
    expect(text).toContain('alice.near');
    expect(text).toContain('Only approve if you started this yourself');
    const [approve, deny] = extra.reply_markup.inline_keyboard.flat();
    expect(approve.callback_data).toBe(`rclink_ok:${code.slice(7)}`);
    expect(deny.callback_data).toBe(`rclink_no:${code.slice(7)}`);
    expect(links).toHaveLength(0);

    await press(approve.callback_data, ctx);
    expect(links).toEqual([expect.objectContaining({ wallet_user_id: 'wallet', telegram_user_id: 'tg' })]);
    expect((ctx.editMessageText.mock.calls[0] as any)[0]).toContain('Linked');
  });

  it('lets every other /start through to the main handler', async () => {
    const { commands } = fakeBot();
    const next = vi.fn();
    await commands.get('start')!(fakeCtx(111, '/start SPEEDY'), next);
    await commands.get('start')!(fakeCtx(111, '/start'), next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('refuses a replayed code', async () => {
    const code = await linkCode();
    expect(await card.approveRacerLink(111, code)).toBe('linked');
    expect(await card.approveRacerLink(222, code)).toBe('expired');
    expect(links).toHaveLength(1);
    expect(links[0].telegram_user_id).toBe('tg');
  });

  it('refuses an expired code', async () => {
    const code = await linkCode();
    codes[0].expires_at = Date.now() - 1;
    expect(await card.approveRacerLink(111, code)).toBe('expired');
    expect(links).toHaveLength(0);
  });

  it('never replaces an existing link on either side', async () => {
    links.push({ wallet_user_id: 'wallet2', telegram_user_id: 'tg', linked_at: new Date() });
    const code = await linkCode();
    expect(await card.approveRacerLink(111, code)).toBe('conflict');
    expect(links).toEqual([expect.objectContaining({ wallet_user_id: 'wallet2', telegram_user_id: 'tg' })]);
  });

  it('is idempotent: an already-linked wallet gets no new code', async () => {
    links.push({ wallet_user_id: 'wallet', telegram_user_id: 'tg', linked_at: new Date() });
    expect(await card.startRacerLink(users.wallet)).toEqual({ status: 'linked' });
    expect(codes).toHaveLength(0);
  });

  it('a Telegram account cannot start a link, and only wallet-only accounts can be linked', async () => {
    expect(await card.startRacerLink(users.tg)).toEqual({ status: 'telegram_account' });
    // A code that somehow points at a Telegram account is refused and used up
    codes.push({ code: 'AAAAAAAAAAAAAAAAAAAAAA', wallet_user_id: 'tg2', expires_at: Date.now() + 60_000, used_at: null });
    expect(await card.approveRacerLink(111, 'AAAAAAAAAAAAAAAAAAAAAA')).toBe('not_wallet');
    expect(codes[0].used_at).not.toBeNull();
    expect(links).toHaveLength(0);
  });

  it('asks someone without a RacerBot account to /start first', async () => {
    const code = await linkCode();
    expect(await card.approveRacerLink(999, code)).toBe('no_account');
    expect(links).toHaveLength(0);
  });

  it('rejects malformed codes without touching the database', async () => {
    expect(await card.approveRacerLink(111, "x'; DROP TABLE users;--")).toBe('expired');
    expect(await card.approveRacerLink(111, 'short')).toBe('expired');
    expect(db.linkRacerAccounts).not.toHaveBeenCalled();
  });

  it('Deny cancels the code', async () => {
    const code = await linkCode();
    const { press } = fakeBot();
    const ctx = fakeCtx(111);
    await press(`rclink_no:${code}`, ctx);
    expect(await card.approveRacerLink(111, code)).toBe('expired');
    expect(links).toHaveLength(0);
  });

  it('ignores link payloads and buttons outside a private chat', async () => {
    const code = await linkCode();
    const { commands, press } = fakeBot();
    const group = fakeCtx(111, `/start rclink_${code}`, 'supergroup');
    const next = vi.fn();
    await commands.get('start')!(group, next);
    expect(next).toHaveBeenCalled();
    await press(`rclink_ok:${code}`, group);
    expect(links).toHaveLength(0);
    expect(group.reply).not.toHaveBeenCalled();
  });
});

describe('one rank across linked accounts and confidential trades', () => {
  it('counts confidential trades on the card', async () => {
    execs = [exec({ user_id: 'tg' })];
    const { json } = await card.webRacerCard(users.tg);
    // 59 + 1 fee = 60 NEAR: Street Racer III
    expect(json.rank.name).toBe('Street Racer III');
    expect(json.hasTrades).toBe(true);
  });

  it('a linked wallet and Telegram account share one rank, stored on the Telegram side', async () => {
    rows = [row({ input_amount: '60' })];
    execs = [exec({ user_id: 'wallet' })];
    links.push({ wallet_user_id: 'wallet', telegram_user_id: 'tg', linked_at: new Date() });

    const fromWallet = await card.webRacerCard(users.wallet);
    const fromTelegram = await card.webRacerCard(users.tg);
    // 60 + 60 = 120 NEAR: Circuit Racer I, whichever side asks
    expect(fromWallet.json.rank.name).toBe('Circuit Racer I');
    expect(fromTelegram.json.rank.name).toBe('Circuit Racer I');
    // Shares carry the Telegram account's referral code
    expect(fromWallet.json.referralCode).toBe('SPEEDY');
    expect(fromWallet.json).toMatchObject({ linked: true, canLink: false });

    // The lifetime rank is announced in the Telegram chat
    const { telegram } = fakeBot();
    ranks.set('tg', { user_id: 'tg', best_key: 6, announced_key: 6 });
    expect(await card.maybeAnnounceRankUp('wallet')).toBe(true);
    expect(telegram.sendPhoto).toHaveBeenCalledWith(111, expect.anything(), expect.objectContaining({ caption: expect.stringContaining('Circuit Racer I') }));
    expect(ranks.get('tg')).toMatchObject({ best_key: 7, announced_key: 7 });
    expect(ranks.has('wallet')).toBe(false);
  });

  it('a wallet-only account keeps its rank-up for the web (no chat to announce in)', async () => {
    execs = [exec({ user_id: 'wallet', opened_at: new Date(Date.now() - 5_000) })];
    ranks.set('wallet', { user_id: 'wallet', best_key: 3, announced_key: 3 });
    fakeBot();
    expect(await card.maybeAnnounceRankUp('wallet')).toBe(false);
    expect(ranks.get('wallet')).toMatchObject({ best_key: 6, announced_key: 3 });
  });

  it('gives a wallet-only account a w_ referral code that cannot look like a Telegram name', async () => {
    const { json } = await card.webRacerCard(users.wallet);
    expect(json.referralCode).toBe('w_alice-AB12C');
    expect(json).toMatchObject({ linked: false, canLink: true, hasTrades: false });
  });
});

describe('/api/racer-card', () => {
  function route(method: string, path: string) {
    const router: any = createRacerCardRouter();
    const layer = router.stack.find((l: any) => l.route?.path === path && l.route.methods[method]);
    return layer.route.stack[0].handle as Function;
  }
  function res() {
    const r: any = { statusCode: 200, headers: {}, body: undefined };
    r.status = (c: number) => { r.statusCode = c; return r; };
    r.set = (k: string, v: string) => { r.headers[k] = v; return r; };
    r.json = (b: any) => { r.body = b; return r; };
    r.send = (b: any) => { r.body = b; return r; };
    return r;
  }

  it('needs a verified session', async () => {
    for (const [m, p] of [['get', '/'], ['get', '/image.png'], ['post', '/link']]) {
      const r = res();
      await route(m, p)({ headers: {} }, r);
      expect(r.statusCode).toBe(401);
    }
  });

  it('returns the card without amounts, tokens or addresses', async () => {
    process.env.PUBLIC_URL = 'https://racer.example';
    session.user = users.tg;
    rows = [row({ input_amount: '150' }), row({ side: 'sell', input_amount: '140', created_at: new Date('2026-10-03T12:00:00Z') })];
    const r = res();
    await route('get', '/')({ headers: {} }, r);
    expect(r.statusCode).toBe(200);
    expect(r.headers['Cache-Control']).toBe('private, no-store');
    expect(r.body).toMatchObject({ rank: { name: 'Circuit Racer II' }, shareUrl: 'https://racer.example/c/SPEEDY?r=8', canLink: false });
    expect(JSON.stringify(r.body)).not.toMatch(/secret-token|speedy\.racerbot\.near|\b290\b|\b150\b|\b140\b/);
  });

  it('serves the card image and starts a link for a wallet session', async () => {
    session.user = users.wallet;
    const img = res();
    await route('get', '/image.png')({ headers: {} }, img);
    expect(img.headers['Content-Type']).toBe('image/png');
    const link = res();
    await route('post', '/link')({ headers: {} }, link);
    expect(link.body.status).toBe('link');
    expect(links).toHaveLength(0);

    session.user = users.tg;
    const refused = res();
    await route('post', '/link')({ headers: {} }, refused);
    expect(refused.statusCode).toBe(400);
  });
});
