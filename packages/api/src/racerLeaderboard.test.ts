import { describe, it, expect, vi, beforeEach } from 'vitest';

// Never reach a real database from this test: dotenv does not override a variable that is already set
process.env.DATABASE_URL = 'postgres://racer-board-test@127.0.0.1:1/none';
process.env.DATABASE_URL_UNPOOLED = 'postgres://racer-board-test@127.0.0.1:1/none';
process.env.RACER_FOUNDING_CUTOFF = 'off';

type Row = {
  user_id: string; side: string; token_address: string; venue: string; created_at: Date;
  input_amount: string | null; fee_paid: string; position_id: string | null; position_status: string | null;
};
let rows: Row[] = [];
let links: any[] = [];
let ranks: any[] = [];
const names: Record<string, any> = {
  a: { id: 'a', username: 'speedracer', referral_code: 'speedracer-AB12C' },
  b: { id: 'b', username: null, referral_code: 'nightowl-ZZ99Q' },
  c: { id: 'c', username: '<script>x</script>', referral_code: null },
  w: { id: 'w', username: 'w_alice', referral_code: 'w_alice-QQ11Q' },
  t: { id: 't', username: 'tg', referral_code: 'tg-AAAAA' },
};

vi.mock('@racerbot/db', () => ({
  getNearRacerFills: vi.fn(async () => rows),
  getConfidentialRacerExecutors: vi.fn(async () => []),
  listRacerLinks: vi.fn(async () => links),
  listRacerRanks: vi.fn(async () => ranks),
  getRacerNames: vi.fn(async (ids: string[]) => ids.map(id => names[id]).filter(Boolean)),
}));
vi.mock('./racerCardImageGenerator.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./racerCardImageGenerator.js')>();
  return { ...real, generateRacerCardImage: vi.fn(async () => Buffer.from('png')), generateRacerCardOgImage: vi.fn(async () => Buffer.from('png')) };
});

const { racerLeaderboard, leaderboardHtml, shortRacerName, clearLeaderboardCache, registerRacerLeaderboard } = await import('./racerLeaderboard.js');

const row = (user_id: string, input_amount: string, at = '2026-10-01T12:00:00Z'): Row => ({
  user_id, side: 'buy', token_address: 'secret-token.near', venue: 'rhea', created_at: new Date(at),
  input_amount, fee_paid: '0', position_id: null, position_status: null,
});

beforeEach(() => {
  rows = [];
  links = [];
  ranks = [];
  clearLeaderboardCache();
  delete process.env.RACER_CARD_URL;
  delete process.env.PUBLIC_URL;
});

describe('shortRacerName', () => {
  it('shows only the first letters, and nothing of a wallet', () => {
    expect(shortRacerName('speedracer', 'speedracer-AB12C')).toBe('spe•••');
    expect(shortRacerName('@ab', null)).toBe('a•••');
    expect(shortRacerName(null, 'nightowl-ZZ99Q')).toBe('nig•••');
    expect(shortRacerName('w_alice', 'w_alice-QQ11Q')).toBe('Wallet racer');
    expect(shortRacerName(null, null)).toBe('Wallet racer');
  });
});

describe('racerLeaderboard', () => {
  it('orders by rank (volume only breaks ties) and skips racers without volume', async () => {
    rows = [row('a', '300'), row('b', '1200'), row('c', '310'), row('z', '0')];
    const board = await racerLeaderboard();
    expect(board.racers).toBe(3);
    expect(board.entries.map(e => [e.position, e.name, e.rankName])).toEqual([
      [1, 'nig•••', 'Pro Driver I'],
      [2, '<sc•••', 'Circuit Racer II'],
      [3, 'spe•••', 'Circuit Racer II'],
    ]);
    expect(board.tierCounts.find(t => t.title === 'Circuit Racer')?.count).toBe(2);
  });

  it('keeps a lifetime rank that the current volume no longer reaches', async () => {
    rows = [row('a', '20'), row('b', '60')];
    ranks = [{ user_id: 'a', best_key: 10, announced_key: 10 }];
    const board = await racerLeaderboard();
    expect(board.entries[0]).toMatchObject({ name: 'spe•••', rankName: 'Pro Driver I' });
  });

  it('counts a linked wallet as its Telegram account', async () => {
    rows = [row('t', '60'), row('w', '60')];
    links = [{ wallet_user_id: 'w', telegram_user_id: 't', linked_at: new Date() }];
    const board = await racerLeaderboard();
    expect(board.racers).toBe(1);
    expect(board.entries[0]).toMatchObject({ name: 't•••', rankName: 'Circuit Racer I' });
  });
});

describe('/racers page', () => {
  it('shows ranks with no amounts, tokens, wallets, card links or server address', async () => {
    process.env.PUBLIC_URL = 'https://racerbot-production.up.railway.app';
    process.env.RACER_CARD_URL = 'https://racertrades.xyz';
    rows = [row('a', '300'), row('b', '1200'), row('c', '310'), row('w', '15')];
    const html = leaderboardHtml(await racerLeaderboard());
    expect(html).toContain('NEAR Racer Leaderboard');
    expect(html).toContain('Pro Driver I');
    expect(html).toContain('<meta property="og:url" content="https://racertrades.xyz/racers">');
    expect(html).toContain('Wallet racer');
    expect(html).not.toMatch(/secret-token|\b1200\b|\b300\b|\b310\b|speedracer|nightowl|alice|AB12C|\/c\/|railway/);
    expect(html).not.toContain('<script>x');
    expect(html).toContain('&#60;sc•••');
  });

  it('serves the page, and a friendly error when the data is down', async () => {
    const routes = new Map<string, Function>();
    registerRacerLeaderboard({ get: (p: string, fn: Function) => routes.set(p, fn) } as any);
    const res = () => {
      const r: any = { statusCode: 200, headers: {}, body: '' };
      r.status = (c: number) => { r.statusCode = c; return r; };
      r.set = (k: string, v: string) => { r.headers[k] = v; return r; };
      r.send = (b: string) => { r.body = b; return r; };
      return r;
    };
    rows = [row('a', '300')];
    const ok = res();
    await routes.get('/racers')!({}, ok);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['Content-Type']).toContain('text/html');

    clearLeaderboardCache();
    const db = await import('@racerbot/db');
    vi.mocked(db.getNearRacerFills).mockRejectedValueOnce(new Error('db down'));
    const down = res();
    await routes.get('/racers')!({}, down);
    expect(down.statusCode).toBe(503);
    expect(down.body).toContain('pit stop');
  });
});
