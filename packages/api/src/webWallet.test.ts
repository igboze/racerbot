import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.KEY_ENCRYPTION_MASTER_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const users: Record<string, any> = {};
const createUserWallet = vi.fn(async (p: any) => {
  if (p.isActive) Object.assign(users[p.userId], { subaccount_id: p.address, scoped_key_encrypted: p.encryptedPrivateKey });
  return { ...p };
});
const getUserWallets = vi.fn(async () => [] as any[]);

vi.mock('@racerbot/db', () => ({
  getUserById: vi.fn(async (id: string) => (users[id] ? { ...users[id] } : null)),
  createUserWallet: (p: any) => createUserWallet(p),
  getUserWallets: () => getUserWallets(),
}));

const { createWebManagedWallet, hasManagedWallet, implicitAccountId, EXTERNAL_WALLET_MARKER } = await import('./webWallet.js');
const { decrypt } = await import('@racerbot/shared');

describe('web managed wallets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    users['u1'] = { id: 'u1', subaccount_id: 'alice.near', scoped_key_encrypted: '' };
    users['u2'] = { id: 'u2', subaccount_id: 'bob.racerbot.near', scoped_key_encrypted: 'enc' };
  });

  it('only a real stored key counts as managed', () => {
    expect(hasManagedWallet({ scoped_key_encrypted: '' })).toBe(false);
    expect(hasManagedWallet({ scoped_key_encrypted: EXTERNAL_WALLET_MARKER })).toBe(false);
    expect(hasManagedWallet({ scoped_key_encrypted: 'abc:def' })).toBe(true);
  });

  it('implicit account IDs are the public key in hex', () => {
    expect(implicitAccountId(new Uint8Array(32).fill(255))).toBe('ff'.repeat(32));
  });

  it('creates an implicit-account wallet, keeps the connected wallet linked, returns only the address', async () => {
    const result = await createWebManagedWallet('u1');
    expect(Object.keys(result).sort()).toEqual(['address', 'created']);
    expect(result.created).toBe(true);
    expect(result.address).toMatch(/^[0-9a-f]{64}$/);

    const [link, managed] = createUserWallet.mock.calls.map(c => c[0]);
    expect(link).toMatchObject({ address: 'alice.near', encryptedPrivateKey: EXTERNAL_WALLET_MARKER, isActive: false });
    expect(managed).toMatchObject({ address: result.address, isActive: true });
    // Stored encrypted, and it really is the key for that address
    expect(managed.encryptedPrivateKey).not.toContain('ed25519:');
    const secret = decrypt(managed.encryptedPrivateKey, process.env.KEY_ENCRYPTION_MASTER_KEY!);
    const { KeyPair } = await import('near-api-js');
    expect(implicitAccountId(KeyPair.fromString(secret as any).getPublicKey().data)).toBe(result.address);
  });

  it('is idempotent: an account that already has one gets it back', async () => {
    expect(await createWebManagedWallet('u2')).toEqual({ address: 'bob.racerbot.near', created: false });
    expect(createUserWallet).not.toHaveBeenCalled();
  });

  it('does not relink a wallet that is already linked', async () => {
    getUserWallets.mockResolvedValueOnce([{ address: 'alice.near' }]);
    await createWebManagedWallet('u1');
    expect(createUserWallet).toHaveBeenCalledOnce();
  });
});
