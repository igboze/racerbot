import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Never reach a real database from this test: dotenv does not override a variable that is already set
process.env.DATABASE_URL = 'postgres://racer-card-test@127.0.0.1:1/none';
process.env.DATABASE_URL_UNPOOLED = 'postgres://racer-card-test@127.0.0.1:1/none';
process.env.RACER_FOUNDING_CUTOFF = '2026-12-01T00:00:00Z';

type Row = {
  user_id: string; side: string; token_address: string; venue: string; created_at: Date;
  input_amount: string | null; fee_paid: string; position_id: string | null; position_status: string | null;
};
type RankRow = { user_id: string; best_key: number; announced_key: number };

let rows: Row[] = [];
let ranks = new Map<string, RankRow>();
const users: Record<string, any> = {
  u1: { id: 'u1', telegram_id: 111, username: 'speedy', referral_code: 'SPEEDY' },
  u2: { id: 'u2', telegram_id: 222, username: 'newbie', referral_code: null },
};

// In-memory racer_ranks with the same semantics as the SQL in packages/db
vi.mock('@racerbot/db', () => ({
  getNearRacerFills: vi.fn(async (userId?: string) => rows.filter(r => !userId || r.user_id === userId)),
  getUserByTelegramId: vi.fn(async (tg: number) => Object.values(users).find(u => u.telegram_id === tg) ?? null),
  getUserById: vi.fn(async (id: string) => users[id] ?? null),
  getUserByExactReferralCode: vi.fn(async (code: string) => Object.values(users).find(u => u.referral_code === code) ?? null),
  getConfidentialRacerExecutors: vi.fn(async () => []),
  getRacerLinkFor: vi.fn(async () => null),
  listRacerLinks: vi.fn(async () => []),
  generateReferralCode: vi.fn(async (_id: string, name: string) => `${name.toUpperCase()}1`),
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
}));
vi.mock('./racerCardImageGenerator.js', () => ({
  generateRacerCardImage: vi.fn(async () => Buffer.from('png')),
  generateRacerCardOgImage: vi.fn(async () => Buffer.from('preview-png')),
}));

const { registerRacerCard, registerRacerCardPages, maybeAnnounceRankUp, clearRacerVolumeCache, clearRacerShareCache } = await import('./racerCard.js');
const db = await import('@racerbot/db');
const { generateRacerCardImage } = await import('./racerCardImageGenerator.js');

const row = (o: Partial<Row>): Row => ({
  user_id: 'u1', side: 'buy', token_address: 'secret-token.near', venue: 'rhea', created_at: new Date('2026-10-01T12:00:00Z'),
  input_amount: '10', fee_paid: '0.15', position_id: null, position_status: null, ...o,
});
const ago = (ms: number) => new Date(Date.now() - ms);

function fakeBot() {
  const commands = new Map<string, Function>();
  const actions = new Map<string, Function>();
  const sendMessage = vi.fn(async () => ({}));
  const sendPhoto = vi.fn(async () => ({}));
  const bot: any = {
    command: (names: string | string[], fn: Function) => [names].flat().forEach(n => commands.set(n, fn)),
    action: (name: string, fn: Function) => actions.set(name, fn),
    telegram: { sendMessage, sendPhoto },
  };
  registerRacerCard(bot);
  return { commands, actions, sendMessage, sendPhoto };
}

function fakeCtx(telegramId: number) {
  return {
    from: { id: telegramId },
    reply: vi.fn(async () => ({})),
    replyWithPhoto: vi.fn(async () => ({})),
    answerCbQuery: vi.fn(async () => true),
  };
}

const buttons = (extra: any) => extra.reply_markup.inline_keyboard.flat();

beforeEach(() => {
  rows = [];
  ranks = new Map();
  clearRacerVolumeCache();
  clearRacerShareCache();
  delete process.env.PUBLIC_URL;
  delete process.env.RAILWAY_PUBLIC_DOMAIN;
  vi.mocked(generateRacerCardImage).mockClear();
});

afterEach(() => {
  delete process.env.RACER_RANKUP_PROMPT;
});

describe('/card', () => {
  it('registers /card, /racercard and the home-screen button', () => {
    const { commands, actions } = fakeBot();
    expect([...commands.keys()]).toEqual(['card', 'racercard', 'start']);
    expect(actions.has('racer_card')).toBe(true);
  });

  it('sends a ranked card with share buttons and no amounts, tokens or addresses', async () => {
    rows = [
      row({ input_amount: '150', created_at: new Date('2026-10-01T12:00:00Z') }),
      row({ side: 'sell', input_amount: '140', created_at: new Date('2026-10-03T12:00:00Z') }),
      row({ user_id: 'other', input_amount: '5' }),
      row({ user_id: 'other2', input_amount: '20' }),
      row({ user_id: 'other3', input_amount: '40' }),
    ];
    const { commands } = fakeBot();
    const ctx = fakeCtx(111);
    await commands.get('card')!(ctx);

    expect(ctx.replyWithPhoto).toHaveBeenCalledTimes(1);
    const [, extra] = ctx.replyWithPhoto.mock.calls[0] as any;
    expect(extra.parse_mode).toBe('HTML');
    expect(extra.caption).toContain('Circuit Racer II');
    expect(extra.caption).toContain('Top 25% of NEAR racers');
    expect(extra.caption).toContain('of the way to Circuit Racer III');
    expect(extra.caption).toContain('Founding Racer');
    expect(extra.caption).not.toContain('ranked up');
    expect(extra.caption).not.toMatch(/secret-token|\b290\b|\b150\b|\b140\b/);

    const [x, tg] = buttons(extra);
    expect(x.url).toMatch(/^https:\/\/x\.com\/intent\/post\?text=/);
    expect(decodeURIComponent(x.url)).toContain("I'm a Circuit Racer II on @racertradingbot");
    expect(decodeURIComponent(x.url)).toContain('https://t.me/racertradingbot?start=SPEEDY');
    expect(tg.url).toMatch(/^https:\/\/t\.me\/share\/url\?url=https%3A%2F%2Ft\.me%2Fracertradingbot%3Fstart%3DSPEEDY/);

    const imageData = vi.mocked(generateRacerCardImage).mock.calls[0][0];
    expect(imageData).toMatchObject({ rankTitle: 'Circuit Racer', levelLabel: 'II', nextLevelName: 'Circuit Racer III', topPercent: 25, referralCode: 'SPEEDY', hasTrades: true });
    expect(JSON.stringify(imageData)).not.toMatch(/secret-token|290/);

    // First sight stores the current rank as already announced
    expect(ranks.get('u1')).toMatchObject({ best_key: 8, announced_key: 8 });
  });

  it('gives a user with no NEAR trades a friendly Rookie card', async () => {
    rows = [row({ user_id: 'other', input_amount: '50' })];
    const { actions } = fakeBot();
    const ctx = fakeCtx(222);
    await actions.get('racer_card')!(ctx);

    expect(ctx.answerCbQuery).toHaveBeenCalled();
    const [, extra] = ctx.replyWithPhoto.mock.calls[0] as any;
    expect(extra.caption).toContain('Rookie I');
    expect(extra.caption).toContain('first NEAR trade');
    expect(decodeURIComponent(buttons(extra)[0].url)).toContain('start=NEWBIE1');
    expect(vi.mocked(generateRacerCardImage).mock.calls[0][0]).toMatchObject({ hasTrades: false, topPercent: null, badges: [] });
  });

  it('falls back to a text card when the image fails, and asks unknown users to /start', async () => {
    vi.mocked(generateRacerCardImage).mockResolvedValueOnce(null);
    const { commands } = fakeBot();
    const ctx = fakeCtx(111);
    await commands.get('card')!(ctx);
    expect(ctx.replyWithPhoto).not.toHaveBeenCalled();
    expect((ctx.reply.mock.calls[0] as any)[0]).toContain('Rookie I');

    const stranger = fakeCtx(999);
    await commands.get('card')!(stranger);
    expect((stranger.reply.mock.calls[0] as any)[0]).toContain('/start');
  });

  it('keeps a lifetime rank when the counted volume later drops', async () => {
    ranks.set('u1', { user_id: 'u1', best_key: 8, announced_key: 8 });
    rows = [row({ input_amount: '12' })];
    const { commands } = fakeBot();
    const ctx = fakeCtx(111);
    await commands.get('card')!(ctx);
    const [, extra] = ctx.replyWithPhoto.mock.calls[0] as any;
    expect(extra.caption).toContain('Circuit Racer II');
    expect(ranks.get('u1')).toMatchObject({ best_key: 8, announced_key: 8 });
  });

  it('marks an unannounced rank-up as announced when the card is viewed', async () => {
    ranks.set('u1', { user_id: 'u1', best_key: 4, announced_key: 4 });
    rows = [row({ input_amount: '30' })];
    const { commands } = fakeBot();
    const ctx = fakeCtx(111);
    await commands.get('card')!(ctx);
    const [, extra] = ctx.replyWithPhoto.mock.calls[0] as any;
    expect(extra.caption).toContain('You ranked up — share your new card?');
    expect(ranks.get('u1')).toMatchObject({ best_key: 5, announced_key: 5 });

    await commands.get('card')!(ctx);
    expect((ctx.replyWithPhoto.mock.calls[1] as any)[1].caption).not.toContain('ranked up');
  });
});

describe('rank-up announcements', () => {
  it('announces a rank-up once, with the upgraded card and share buttons', async () => {
    ranks.set('u1', { user_id: 'u1', best_key: 3, announced_key: 3 });
    rows = [
      row({ input_amount: '9', created_at: ago(60 * 60_000) }),
      row({ side: 'sell', input_amount: '4', created_at: ago(30_000) }),
    ];
    const { sendPhoto, sendMessage } = fakeBot();
    expect(await maybeAnnounceRankUp('u1')).toBe(true);
    expect(sendPhoto).toHaveBeenCalledTimes(1);
    const [chatId, , extra] = sendPhoto.mock.calls[0] as any;
    expect(chatId).toBe(111);
    expect(extra.caption).toContain('You ranked up — share your new card?');
    expect(extra.caption).toContain('Street Racer I');
    expect(buttons(extra)[0].url).toMatch(/^https:\/\/x\.com\/intent\/post/);
    expect(vi.mocked(generateRacerCardImage).mock.calls[0][0]).toMatchObject({ rankTitle: 'Street Racer', levelLabel: 'I' });
    expect(ranks.get('u1')).toMatchObject({ best_key: 4, announced_key: 4 });

    expect(await maybeAnnounceRankUp('u1')).toBe(false);
    expect(sendPhoto).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('announces once when several trade hooks fire at the same time', async () => {
    ranks.set('u1', { user_id: 'u1', best_key: 3, announced_key: 3 });
    rows = [row({ input_amount: '30', created_at: ago(10_000) })];
    const { sendPhoto } = fakeBot();
    const results = await Promise.all([maybeAnnounceRankUp('u1'), maybeAnnounceRankUp('u1'), maybeAnnounceRankUp('u1')]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(sendPhoto).toHaveBeenCalledTimes(1);
  });

  it('does not announce an existing rank on first contact after deploy', async () => {
    // Old trades only: the rank is stored, nothing is sent
    rows = [row({ input_amount: '300', created_at: ago(3 * 86_400_000) })];
    const { sendPhoto } = fakeBot();
    expect(await maybeAnnounceRankUp('u1')).toBe(false);
    expect(ranks.get('u1')).toMatchObject({ best_key: 8, announced_key: 8 });
    expect(sendPhoto).not.toHaveBeenCalled();
  });

  it('on first contact, still announces a rank the latest trade just reached', async () => {
    rows = [
      row({ input_amount: '240', created_at: ago(3 * 86_400_000) }),
      row({ side: 'sell', input_amount: '30', created_at: ago(20_000) }),
    ];
    const { sendPhoto } = fakeBot();
    // 240 = Circuit Racer I; the sell takes it to 270 = Circuit Racer II
    expect(await maybeAnnounceRankUp('u1')).toBe(true);
    expect((sendPhoto.mock.calls[0] as any)[2].caption).toContain('Circuit Racer II');
    expect(ranks.get('u1')).toMatchObject({ best_key: 8, announced_key: 8 });
  });

  it('stays quiet for a first tiny trade and for trades that do not rank up', async () => {
    const { sendPhoto } = fakeBot();
    rows = [row({ user_id: 'u2', input_amount: '1', created_at: ago(5_000) })];
    expect(await maybeAnnounceRankUp('u2')).toBe(false);
    rows.push(row({ user_id: 'u2', input_amount: '0.5', created_at: ago(1_000) }));
    expect(await maybeAnnounceRankUp('u2')).toBe(false);
    expect(await maybeAnnounceRankUp('nobody')).toBe(false);
    expect(sendPhoto).not.toHaveBeenCalled();
  });

  it('never re-announces after the volume dips and recovers', async () => {
    ranks.set('u1', { user_id: 'u1', best_key: 8, announced_key: 8 });
    rows = [row({ input_amount: '12', created_at: ago(5_000) })];
    const { sendPhoto } = fakeBot();
    expect(await maybeAnnounceRankUp('u1')).toBe(false);
    rows = [row({ input_amount: '300', created_at: ago(5_000) })];
    expect(await maybeAnnounceRankUp('u1')).toBe(false);
    expect(sendPhoto).not.toHaveBeenCalled();
  });

  it('with RACER_RANKUP_PROMPT=tier, skips level-ups but announces the next tier', async () => {
    process.env.RACER_RANKUP_PROMPT = 'tier';
    ranks.set('u1', { user_id: 'u1', best_key: 4, announced_key: 4 });
    rows = [row({ input_amount: '30', created_at: ago(5_000) })];
    const { sendPhoto } = fakeBot();
    expect(await maybeAnnounceRankUp('u1')).toBe(false);
    expect(ranks.get('u1')).toMatchObject({ best_key: 5, announced_key: 4 });
    rows.push(row({ input_amount: '80', created_at: ago(1_000) }));
    expect(await maybeAnnounceRankUp('u1')).toBe(true);
    expect((sendPhoto.mock.calls[0] as any)[2].caption).toContain('Circuit Racer I');
  });
});

describe('sharing with the card image', () => {
  function fakeApp() {
    const routes = new Map<string, Function>();
    const app: any = { get: (paths: string | string[], fn: Function) => [paths].flat().forEach(p => routes.set(p, fn)) };
    registerRacerCardPages(app);
    return routes;
  }
  function fakeRes() {
    const res: any = { statusCode: 200, headers: {} as Record<string, string>, body: undefined as any };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.set = (k: string, v: string) => { res.headers[k] = v; return res; };
    res.send = (b: any) => { res.body = b; return res; };
    res.redirect = (c: number, url: string) => { res.statusCode = c; res.headers.Location = url; return res; };
    return res;
  }
  const call = async (routes: Map<string, Function>, route: string, params: any, path: string, query: any = {}) => {
    const res = fakeRes();
    await routes.get(route)!({ params, path, query }, res);
    return res;
  };
  const circuitRows = () => [
    row({ input_amount: '150', created_at: new Date('2026-10-01T12:00:00Z') }),
    row({ side: 'sell', input_amount: '140', created_at: new Date('2026-10-03T12:00:00Z') }),
  ];

  it('points the X and Telegram buttons at the card page, keyed by rank', async () => {
    process.env.PUBLIC_URL = 'https://racer.example/';
    rows = circuitRows();
    const { commands } = fakeBot();
    const ctx = fakeCtx(111);
    await commands.get('card')!(ctx);
    const [x, tg] = buttons((ctx.replyWithPhoto.mock.calls[0] as any)[1]);
    const page = 'https://racer.example/c/SPEEDY?r=8';
    expect(new URL(x.url).searchParams.get('url')).toBe(page);
    expect(new URL(tg.url).searchParams.get('url')).toBe(page);
  });

  it('falls back to the bot link without a public URL', async () => {
    rows = circuitRows();
    const { commands } = fakeBot();
    const ctx = fakeCtx(111);
    await commands.get('card')!(ctx);
    const [x] = buttons((ctx.replyWithPhoto.mock.calls[0] as any)[1]);
    expect(new URL(x.url).searchParams.get('url')).toBe('https://t.me/racertradingbot?start=SPEEDY');
  });

  it('serves a page with the large-image card tags and no private data', async () => {
    process.env.PUBLIC_URL = 'https://racer.example';
    ranks.set('u1', { user_id: 'u1', best_key: 8, announced_key: 8 });
    rows = circuitRows();
    const routes = fakeApp();
    const res = await call(routes, '/c/:code', { code: 'SPEEDY' }, '/c/SPEEDY', { r: '8' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toContain('text/html');
    const html: string = res.body;
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(html).toContain('<meta property="og:image" content="https://racer.example/c/SPEEDY/preview.png?r=8">');
    expect(html).toContain('<meta name="twitter:image" content="https://racer.example/c/SPEEDY/preview.png?r=8">');
    expect(html).toContain('Circuit Racer II on RacerBot');
    expect(html).toContain('https://t.me/racertradingbot?start=SPEEDY');
    expect(html).not.toMatch(/secret-token|\b290\b|\b150\b|\b140\b/);
  });

  it('serves the preview and card PNGs', async () => {
    process.env.PUBLIC_URL = 'https://racer.example';
    rows = circuitRows();
    const routes = fakeApp();
    const route = '/c/:code/preview.png';
    const preview = await call(routes, route, { code: 'SPEEDY' }, '/c/SPEEDY/preview.png');
    expect(preview.headers['Content-Type']).toBe('image/png');
    expect(preview.body.toString()).toBe('preview-png');
    const card = await call(routes, '/c/:code/card.png', { code: 'SPEEDY' }, '/c/SPEEDY/card.png');
    expect(card.body.toString()).toBe('png');
    // Second request is served from the cache
    await call(routes, route, { code: 'SPEEDY' }, '/c/SPEEDY/preview.png');
    expect(generateRacerCardImage).toHaveBeenCalledTimes(1);
  });

  it('is read-only and only matches an exact referral code', async () => {
    process.env.PUBLIC_URL = 'https://racer.example';
    rows = circuitRows();
    vi.mocked(db.seedRacerRank).mockClear();
    vi.mocked(db.claimRacerRankUp).mockClear();
    const routes = fakeApp();
    await call(routes, '/c/:code', { code: 'SPEEDY' }, '/c/SPEEDY');
    expect(db.seedRacerRank).not.toHaveBeenCalled();
    expect(db.claimRacerRankUp).not.toHaveBeenCalled();
    expect(ranks.size).toBe(0);

    expect((await call(routes, '/c/:code', { code: 'speedy' }, '/c/speedy')).statusCode).toBe(404);
    expect((await call(routes, '/c/:code', { code: 'bad code!' }, '/c/bad')).statusCode).toBe(404);
    expect((await call(routes, '/c/:code/card.png', { code: 'nobody' }, '/c/nobody/card.png')).statusCode).toBe(404);
  });
});

describe('card image', () => {
  it('renders a 1080x1350 PNG (Legend, the busiest tier)', async () => {
    const { generateRacerCardImage: real, generateRacerCardOgImage: realPreview } = await vi.importActual<typeof import('./racerCardImageGenerator.js')>('./racerCardImageGenerator.js');
    for (const tierIndex of [6]) {
      const png = await real({
        rankTitle: tierIndex ? 'Legend' : 'Rookie', levelLabel: 'II', tierIndex, tierCount: 7, finish: 'holo', topPercent: 8,
        progressPct: 40, nextLevelName: 'Legend III', hasTrades: true, badges: ['Founding Racer', 'Multi-Track'],
        referralCode: 'SPEEDY<x>', referralLink: 'https://t.me/racertradingbot?start=SPEEDY',
      });
      expect(png).not.toBeNull();
      expect(png!.subarray(1, 4).toString()).toBe('PNG');
      expect(png!.readUInt32BE(16)).toBe(1080);
      expect(png!.readUInt32BE(20)).toBe(1350);
      // Landscape link preview for X / Telegram
      const preview = await realPreview({
        rankTitle: 'Legend', levelLabel: 'II', tierIndex, tierCount: 7, finish: 'holo', topPercent: 8,
        progressPct: 40, nextLevelName: 'Legend III', hasTrades: true, badges: [],
        referralCode: 'SPEEDY', referralLink: 'https://t.me/racertradingbot?start=SPEEDY',
      }, png!);
      expect(preview!.readUInt32BE(16)).toBe(1200);
      expect(preview!.readUInt32BE(20)).toBe(630);
    }
  }, 90_000);
});
