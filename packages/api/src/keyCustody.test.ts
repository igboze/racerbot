import { describe, it, expect, vi, afterEach } from 'vitest';
import { ethers } from 'ethers';
import { KeyPair } from 'near-api-js';
import { decrypt, restoreSolanaKeypair, restoreSuiKeypair } from '@racerbot/shared';
import { generateCustodyKey, generateCustodyKeyLocal, sealCustodyKey, nearImplicitAccountOf } from './keyCustody.js';

const MASTER = 'k'.repeat(40);

describe('key custody', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    vi.unstubAllGlobals();
  });

  it('generates keys locally whose encrypted key matches the address and public key', () => {
    process.env.KEY_ENCRYPTION_MASTER_KEY = MASTER;
    const near = generateCustodyKeyLocal('near');
    expect(KeyPair.fromString(decrypt(near.encryptedPrivateKey, MASTER) as any).getPublicKey().toString()).toBe(near.publicKey);
    expect(nearImplicitAccountOf(near.publicKey)).toMatch(/^[0-9a-f]{64}$/);

    const evm = generateCustodyKeyLocal('evm');
    expect(new ethers.Wallet(decrypt(evm.encryptedPrivateKey, MASTER)).address).toBe(evm.address);

    const sol = generateCustodyKeyLocal('solana');
    expect(restoreSolanaKeypair(sol.encryptedPrivateKey, MASTER).publicKey.toBase58()).toBe(sol.address);

    const sui = generateCustodyKeyLocal('sui');
    expect(restoreSuiKeypair(sui.encryptedPrivateKey, MASTER).toSuiAddress()).toBe(sui.address);

    const stark = generateCustodyKeyLocal('starknet');
    expect(stark.publicKey).toMatch(/^0x/);
    expect(decrypt(stark.encryptedPrivateKey, MASTER)).toMatch(/^0x/);

    const intents = generateCustodyKeyLocal('intents');
    expect(intents.address).toMatch(/^[0-9a-f]{64}$/);
  });

  it('seals an imported key locally without a signer', async () => {
    process.env.KEY_ENCRYPTION_MASTER_KEY = MASTER;
    delete process.env.SIGNER_URL;
    const kp = KeyPair.fromRandom('ed25519');
    expect(decrypt(await sealCustodyKey('near', kp.toString()), MASTER)).toBe(kp.toString());
  });

  it('asks the signer to generate and seal when it holds the keys, with no master key here', async () => {
    delete process.env.KEY_ENCRYPTION_MASTER_KEY;
    process.env.SIGNER_URL = 'http://signer.test';
    process.env.SIGNER_SHARED_SECRET = 's'.repeat(40);
    delete process.env.RACERBOT_SIGNER;
    const fetchMock = vi.fn(async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      const result = url.endsWith('/v1/keys/generate')
        ? { address: 'addr-' + body.kind, publicKey: 'pk', encryptedPrivateKey: 'ciphertext' }
        : { encryptedPrivateKey: 'sealed' };
      return { ok: true, status: 200, json: async () => ({ ok: true, result }) } as any;
    });
    vi.stubGlobal('fetch', fetchMock);

    expect(await generateCustodyKey('solana')).toEqual({ address: 'addr-solana', publicKey: 'pk', encryptedPrivateKey: 'ciphertext' });
    expect(await sealCustodyKey('sui', 'suiprivkey1xyz')).toBe('sealed');
    expect(fetchMock.mock.calls.map(c => c[0])).toEqual(['http://signer.test/v1/keys/generate', 'http://signer.test/v1/keys/seal']);
    // Every request is authenticated
    expect(fetchMock.mock.calls[0][1].headers['x-signer-signature']).toMatch(/^[0-9a-f]{64}$/);
  });
});
