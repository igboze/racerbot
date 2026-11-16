/**
 * Key vault: the one place stored private keys are sealed and opened.
 *
 * Today the only provider is `local`: the KEY_ENCRYPTION_MASTER_KEY environment
 * variable with the existing AES-256-GCM format, so nothing stored changes. A cloud
 * KMS (AWS KMS, Google Cloud KMS, HashiCorp Vault) plugs in as another provider
 * that wraps a per-record data key, without touching callers: they only see
 * seal() and open(). Selected by KEY_VAULT_PROVIDER (default `local`).
 */
import { encrypt, decrypt, assertValidMasterKey } from './crypto.js';

export interface KeyVault {
  readonly provider: string;
  /** Encrypts a private key for storage */
  seal(plaintext: string): Promise<string>;
  /** Decrypts a stored private key */
  open(ciphertext: string): Promise<string>;
}

class LocalKeyVault implements KeyVault {
  readonly provider = 'local';
  constructor(private readonly masterKey: string) {}
  async seal(plaintext: string): Promise<string> {
    return encrypt(plaintext, this.masterKey);
  }
  async open(ciphertext: string): Promise<string> {
    return decrypt(ciphertext, this.masterKey);
  }
}

let cached: KeyVault | null = null;

/** The configured key vault. Throws at first use when it is not configured, never silently weak. */
export function getKeyVault(): KeyVault {
  if (cached) return cached;
  const provider = (process.env.KEY_VAULT_PROVIDER || 'local').trim().toLowerCase();
  if (provider === 'local') {
    const masterKey = process.env.KEY_ENCRYPTION_MASTER_KEY;
    assertValidMasterKey(masterKey);
    cached = new LocalKeyVault(masterKey);
    return cached;
  }
  throw new Error(
    `KEY_VAULT_PROVIDER=${provider} is not available yet. Supported: local. ` +
    'A cloud KMS provider is added as a KeyVault implementation in packages/shared/src/keyVault.ts.'
  );
}

/** Tests only: forget the cached vault so a changed environment is read again */
export function resetKeyVaultForTests(): void {
  cached = null;
}
