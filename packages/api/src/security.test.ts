import { describe, it, expect } from 'vitest';
import { isSafeExternalImageUrl } from './tokenCardGenerator.js';
import { encrypt, decrypt, validateScopedKey, assertValidMasterKey } from '@racerbot/shared';

describe('Security Auditing & Hardening Suite', () => {
  describe('SSRF Protection (OWASP A10)', () => {
    it('blocks non-HTTPS protocols', () => {
      expect(isSafeExternalImageUrl('http://example.com/logo.png')).toBe(false);
      expect(isSafeExternalImageUrl('ftp://example.com/logo.png')).toBe(false);
      expect(isSafeExternalImageUrl('file:///etc/passwd')).toBe(false);
      expect(isSafeExternalImageUrl('gopher://127.0.0.1')).toBe(false);
    });

    it('blocks cloud metadata endpoints (AWS, GCP, Azure, OpenStack)', () => {
      expect(isSafeExternalImageUrl('https://169.254.169.254/latest/meta-data/')).toBe(false);
      expect(isSafeExternalImageUrl('https://169.254.1.1/')).toBe(false);
    });

    it('blocks loopback and private RFC1918 IPv4 ranges', () => {
      expect(isSafeExternalImageUrl('https://localhost/admin')).toBe(false);
      expect(isSafeExternalImageUrl('https://app.localhost/admin')).toBe(false);
      expect(isSafeExternalImageUrl('https://127.0.0.1/status')).toBe(false);
      expect(isSafeExternalImageUrl('https://127.0.0.2:8080/')).toBe(false);
      expect(isSafeExternalImageUrl('https://0.0.0.0/')).toBe(false);
      expect(isSafeExternalImageUrl('https://10.0.0.1/icon.png')).toBe(false);
      expect(isSafeExternalImageUrl('https://192.168.1.1/icon.png')).toBe(false);
      expect(isSafeExternalImageUrl('https://172.16.0.1/icon.png')).toBe(false);
      expect(isSafeExternalImageUrl('https://172.31.255.255/icon.png')).toBe(false);
    });

    it('blocks internal and local domain names', () => {
      expect(isSafeExternalImageUrl('https://service.internal/icon.png')).toBe(false);
      expect(isSafeExternalImageUrl('https://server.local/icon.png')).toBe(false);
      expect(isSafeExternalImageUrl('https://router.lan/icon.png')).toBe(false);
    });

    it('permits legitimate public HTTPS image CDN endpoints', () => {
      expect(isSafeExternalImageUrl('https://assets.ref.finance/images/ref.png')).toBe(true);
      expect(isSafeExternalImageUrl('https://raw.githubusercontent.com/near/tokens/main/assets/near.png')).toBe(true);
      expect(isSafeExternalImageUrl('https://ipfs.io/ipfs/bafybeic7v6...')).toBe(true);
    });
  });

  describe('Cryptographic Storage & Key Safety (OWASP A02)', () => {
    const testMasterKey = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

    it('assertValidMasterKey fails fast on placeholder or weak keys', () => {
      expect(() => assertValidMasterKey('')).toThrow();
      expect(() => assertValidMasterKey('short')).toThrow();
      expect(() => assertValidMasterKey('your-secret-encryption-master-key-here-12345')).toThrow();
      expect(() => assertValidMasterKey('change-me-before-production-use-12345')).toThrow();
      expect(() => assertValidMasterKey(testMasterKey)).not.toThrow();
    });

    it('encrypts and decrypts with AES-256-GCM authenticated cipher', () => {
      const secret = 'ed25519:5M7kQz...super_secret_subaccount_key';
      const encrypted = encrypt(secret, testMasterKey);

      expect(encrypted).not.toBe(secret);
      expect(typeof encrypted).toBe('string');

      const decrypted = decrypt(encrypted, testMasterKey);
      expect(decrypted).toBe(secret);
    });

    it('fails decryption on tampered ciphertext (authenticated tag mismatch)', () => {
      const secret = 'ed25519:test_key';
      const encrypted = encrypt(secret, testMasterKey);

      const buf = Buffer.from(encrypted, 'base64');
      buf[buf.length - 1] ^= 0xff; // tamper last byte
      const tampered = buf.toString('base64');

      expect(() => decrypt(tampered, testMasterKey)).toThrow();
    });

    it('validates scoped ed25519 key format correctly', () => {
      expect(validateScopedKey('ed25519:2x7P7wWn5...fake_valid_length_key_over_50_chars_long')).toBe(true);
      expect(validateScopedKey('secp256k1:invalid')).toBe(false);
      expect(validateScopedKey('ed25519:short')).toBe(false);
    });
  });
});
