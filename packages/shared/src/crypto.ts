import { createCipheriv, createDecipheriv, scryptSync, randomFillSync } from 'crypto';
import { KeyPair } from 'near-api-js';
import { generateMnemonic, mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const SCRYPT_N = 32768;

export function encrypt(plaintext: string, masterKey: string): string {
  const salt = randomFillSync(Buffer.alloc(SALT_LENGTH));
  const key = scryptSync(masterKey, salt, KEY_LENGTH, { N: SCRYPT_N, r: 8, p: 1 });
  const iv = randomFillSync(Buffer.alloc(IV_LENGTH));
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, authTag, encrypted]).toString('base64');
}

export function decrypt(ciphertext: string, masterKey: string): string {
  const buffer = Buffer.from(ciphertext, 'base64');
  const salt = buffer.subarray(0, SALT_LENGTH);
  const iv = buffer.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag = buffer.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = buffer.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
  const key = scryptSync(masterKey, salt, KEY_LENGTH, { N: SCRYPT_N, r: 8, p: 1 });
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

export function validateScopedKey(key: string): boolean {
  return key.startsWith('ed25519:') && key.length > 50;
}

export function generateScopedAccessKey(): KeyPair {
  return KeyPair.fromRandom('ed25519');
}