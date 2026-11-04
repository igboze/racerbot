import { describe, it, expect, vi } from 'vitest';

// Never reach a real database from this test
process.env.DATABASE_URL = 'postgres://resolve-test@127.0.0.1:1/none';

const query = vi.fn(async () => ({ rows: [{ id: 'victim', subaccount_id: 'alice.near', scoped_key_encrypted: '' }] }));
vi.mock('@racerbot/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@racerbot/db')>()),
  getDb: vi.fn(async () => ({ query })),
  getUserById: vi.fn(async () => null),
  getUserByTelegramId: vi.fn(async () => null),
}));

const { resolveAlphaUser } = await import('./index.js');

describe('resolveAlphaUser', () => {
  it('a wallet address in a header or query is never a user, and creates nothing', async () => {
    for (const req of [
      { method: 'GET', headers: { 'x-wallet-address': 'alice.near' }, query: {}, body: {} },
      { method: 'GET', headers: {}, query: { walletAddress: 'alice.near' }, body: {} },
      { method: 'POST', headers: { 'x-wallet-address': 'alice.near' }, query: {}, body: { walletAddress: 'alice.near' } },
    ]) {
      expect(await resolveAlphaUser(req)).toBeNull();
    }
    expect(query).not.toHaveBeenCalled();
  });
});
