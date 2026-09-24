import { describe, it, expect } from 'vitest';
import { KeyPair } from 'near-api-js';
import { generateScopedAccessKey, encrypt, decrypt } from './crypto.js';

describe('crypto', () => {
  const masterKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  it('exports and encrypts/decrypts producing the real key matching original public key exactly', () => {
    const originalKeyPair = generateScopedAccessKey();
    const originalPublicKey = originalKeyPair.getPublicKey().toString();
    const originalPrivateKey = originalKeyPair.toString();

    const ciphertext = encrypt(originalPrivateKey, masterKey);
    const decryptedPrivateKey = decrypt(ciphertext, masterKey);

    const parsedKeyPair = KeyPair.fromString(decryptedPrivateKey as any);
    expect(parsedKeyPair.getPublicKey().toString()).toBe(originalPublicKey);
  });

  it('produces different ciphertext for the same plaintext on two separate calls (randomized IV/salt)', () => {
    const plaintext = 'ed25519:testkey1234567890abcdefghijklmnopqrstuvwxyz';
    const cipher1 = encrypt(plaintext, masterKey);
    const cipher2 = encrypt(plaintext, masterKey);

    expect(cipher1).not.toBe(cipher2);
    expect(decrypt(cipher1, masterKey)).toBe(plaintext);
    expect(decrypt(cipher2, masterKey)).toBe(plaintext);
  });
});
