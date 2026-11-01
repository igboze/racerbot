import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

process.env.FASTNEAR_API_KEY = 'test-key';
const fallbackView = vi.fn(async () => '777');
vi.mock('@racerbot/shared', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }),
  getNear: () => ({ view: fallbackView }),
}));

const { fetchLaunchTime, loadTokenFacts, peekTokenFacts, resetTokenFactsForTests } = await import('./tokenFacts.js');

const rpcResult = (value: unknown) => ({ result: { result: [...Buffer.from(JSON.stringify(value))] } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('token facts from FastNEAR', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    resetTokenFactsForTests();
    fetchMock.mockReset();
    fallbackView.mockClear();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('launch time is the oldest transaction, asked for with the key in a header only', async () => {
    fetchMock.mockResolvedValueOnce(json({ account_txs: [{ tx_block_timestamp: '1790937708236829117' }] }));
    expect(await fetchLaunchTime('kookdog-42db38.launchpad.justhoot.near')).toBe(1790937708236);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://tx.main.fastnear.com/v0/account');
    expect(String(url)).not.toContain('test-key');
    expect(init.headers.Authorization).toBe('Bearer test-key');
    expect(JSON.parse(init.body)).toEqual({ account_id: 'kookdog-42db38.launchpad.justhoot.near', desc: false, limit: 1 });
  });

  it('loads supply and launch time, and keeps the launch time for good', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/v0/account') ? json({ account_txs: [{ tx_block_timestamp: '1790000000000000000' }] }) : json(rpcResult('1000000')));
    const first = await loadTokenFacts('T.near');
    expect(first).toEqual({ launchedAt: 1790000000000, totalSupply: '1000000', missing: undefined });
    expect(peekTokenFacts('t.near').launchedAt).toBe(1790000000000);
    fetchMock.mockClear();
    await loadTokenFacts('t.near');
    expect(fetchMock).not.toHaveBeenCalled(); // supply still fresh, launch time never changes
  });

  it('marks tokens whose account does not exist', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/v0/account') ? json({ account_txs: [] }) : json({ error: { cause: { name: 'UNKNOWN_ACCOUNT' } } }));
    expect((await loadTokenFacts('chill.meme-cooking.near')).missing).toBe(true);
    expect(fallbackView).not.toHaveBeenCalled();
  });

  it('falls back to the shared RPC client when FastNEAR fails', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/v0/account') ? json({ account_txs: [] }) : json({ error: { message: 'Too many requests' } }, 429));
    expect((await loadTokenFacts('x.near')).totalSupply).toBe('777');
    expect(fallbackView).toHaveBeenCalledWith('x.near', 'ft_total_supply', {});
  });
});
