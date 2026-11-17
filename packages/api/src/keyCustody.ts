/**
 * Key custody (signer Phase B4): creating, sealing, exporting and rotating user keys.
 *
 * With SIGNER_URL set these run in the signer service, so the API never needs the master key:
 * - new wallets are generated in the signer; the API receives only the address, the public key
 *   and the encrypted key to store
 * - an imported key (which the user sends through the bot) is encrypted by the signer
 * - /export and fleet key exports are sent by the signer straight to the user's Telegram chat,
 *   so the API never sees decrypted keys
 * - NEAR key rotation runs in the signer, which also sends the new key to the user
 * Without SIGNER_URL everything runs here, exactly as before.
 */
import { KeyPair, utils as nearUtils } from 'near-api-js';
import {
  encrypt,
  decrypt,
  generateEvmWallet,
  generateSolanaWallet,
  generateSuiWallet,
  generateStarknetWallet,
  remoteSigningEnabled,
  callSignerService,
} from '@racerbot/shared';
import { generatePrivateAccount } from './intentsPrivate.js';

export type CustodyKind = 'near' | 'evm' | 'solana' | 'sui' | 'starknet' | 'intents';

export interface CustodyKey {
  /** The chain address ('' for NEAR named subaccounts, whose name the caller chooses) */
  address: string;
  publicKey: string;
  encryptedPrivateKey: string;
}

const masterKey = () => process.env.KEY_ENCRYPTION_MASTER_KEY || process.env.ENCRYPTION_MASTER_KEY || '';

/** Generates a key with this process's master key (the API without a signer, or the signer itself) */
export function generateCustodyKeyLocal(kind: CustodyKind): CustodyKey {
  const mk = masterKey();
  switch (kind) {
    case 'near': {
      const kp = KeyPair.fromRandom('ed25519');
      return { address: '', publicKey: kp.getPublicKey().toString(), encryptedPrivateKey: encrypt(kp.toString(), mk) };
    }
    case 'evm': {
      const w = generateEvmWallet(mk);
      return { address: w.address, publicKey: '', encryptedPrivateKey: w.encryptedPrivateKey };
    }
    case 'solana': {
      const w = generateSolanaWallet(mk);
      return { address: w.address, publicKey: w.address, encryptedPrivateKey: w.encryptedPrivateKey };
    }
    case 'sui': {
      const w = generateSuiWallet(mk);
      return { address: w.address, publicKey: '', encryptedPrivateKey: w.encryptedPrivateKey };
    }
    case 'starknet': {
      const w = generateStarknetWallet(mk);
      return { address: w.address, publicKey: w.publicKey, encryptedPrivateKey: w.encryptedPrivateKey };
    }
    case 'intents': {
      const keys = generatePrivateAccount();
      return { address: keys.accountId, publicKey: keys.publicKey, encryptedPrivateKey: encrypt(keys.secretKey, mk) };
    }
  }
}

/** A new wallet key: generated in the signer when it is configured */
export async function generateCustodyKey(kind: CustodyKind): Promise<CustodyKey> {
  if (!remoteSigningEnabled()) return generateCustodyKeyLocal(kind);
  return callSignerService('/v1/keys/generate', { kind });
}

/** Encrypts a key the user imported: by the signer when it is configured */
export async function sealCustodyKey(kind: CustodyKind, plaintext: string): Promise<string> {
  if (!remoteSigningEnabled()) return encrypt(plaintext, masterKey());
  const res = await callSignerService('/v1/keys/seal', { kind, plaintext });
  return res.encryptedPrivateKey;
}

/** The NEAR implicit account id for a public key string (ed25519:...) */
export function nearImplicitAccountOf(publicKey: string): string {
  return Buffer.from(nearUtils.PublicKey.fromString(publicKey).data).toString('hex');
}

/** The Starknet public key for an encrypted key: from the signer when it is configured */
export async function starknetPublicKeyOf(userId: string, address: string, encryptedKey: string): Promise<string> {
  if (!remoteSigningEnabled()) {
    const { ec } = await import('starknet');
    return ec.starkCurve.getStarkKey(decrypt(encryptedKey, masterKey()));
  }
  const { requestRemoteSignature } = await import('@racerbot/shared');
  return requestRemoteSignature({ chain: 'starknet', kind: 'public_key', ref: { userId, address, purpose: 'starknet_address_check' }, payload: '' });
}

/** True when keys are exported and rotated by the signer, which messages the user itself */
export const keysHandledBySigner = (): boolean => remoteSigningEnabled();

/** Asks the signer to send the user their private keys in Telegram (it deletes them after 2 minutes) */
export async function exportKeysViaSigner(userId: string, scope: 'wallets' | 'fleet'): Promise<void> {
  await callSignerService('/v1/keys/export', { userId, scope });
}

/** Asks the signer to rotate the user's NEAR key; it sends the new key to the user */
export async function rotateNearKeyViaSigner(userId: string): Promise<{ subaccountId: string }> {
  return callSignerService('/v1/keys/rotate-near', { userId });
}
