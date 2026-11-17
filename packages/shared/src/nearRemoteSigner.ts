/**
 * NEAR signing that works with a local key or the signer service (signer Phase B2).
 *
 * near-api-js hands its Signer the full encoded transaction before hashing, so the signer
 * service receives the real transaction, decodes it and checks receiver and actions before
 * signing. HybridNearSigner signs accounts whose key is loaded here (the platform's own
 * accounts) locally, and user accounts registered as remote through the signer service.
 */
import { createHash } from 'crypto';
import { KeyPair, Signer, keyStores, utils } from 'near-api-js';
import { decrypt } from './crypto.js';
import { remoteSigningEnabled, requestRemoteSignature, type SigningKeyRef } from './remoteSigner.js';

type NearPublicKey = ReturnType<KeyPair['getPublicKey']>;

/** A user's NEAR key held by the signer service: only the reference lives here */
export interface NearRemoteKey {
  readonly remote: true;
  readonly ref: SigningKeyRef;
}

export type NearKeyLike = KeyPair | NearRemoteKey;

export const isRemoteNearKey = (k: unknown): k is NearRemoteKey =>
  Boolean(k) && (k as NearRemoteKey).remote === true;

/** The key for a user's NEAR account: a reference to the signer's key, or the decrypted local key */
export function nearKeyFor(ref: SigningKeyRef, masterKey: string): NearKeyLike {
  if (remoteSigningEnabled()) return { remote: true, ref };
  if (!ref.encryptedKey) throw new Error('NEAR wallet key is not available.');
  return KeyPair.fromString(decrypt(ref.encryptedKey, masterKey) as any);
}

const publicKeyCache = new Map<string, NearPublicKey>();

/** The public key the signer service holds for this account (cached: it only changes on rotation) */
async function remotePublicKey(accountId: string, ref: SigningKeyRef): Promise<NearPublicKey> {
  const cached = publicKeyCache.get(accountId);
  if (cached) return cached;
  const key = utils.PublicKey.fromString(
    await requestRemoteSignature({ chain: 'near', kind: 'public_key', ref, payload: '' })
  );
  publicKeyCache.set(accountId, key);
  return key;
}

/** Forget a cached public key, e.g. after the account's key was rotated */
export function forgetRemoteNearPublicKey(accountId: string): void {
  publicKeyCache.delete(accountId);
}

export class HybridNearSigner extends Signer {
  private readonly remote = new Map<string, SigningKeyRef>();

  constructor(private readonly keyStore: keyStores.KeyStore, private readonly networkId = 'mainnet') {
    super();
  }

  /** Signs this account through the signer service from now on */
  registerRemote(accountId: string, ref: SigningKeyRef): void {
    this.remote.set(accountId, ref);
  }

  isRemote(accountId: string): boolean {
    return this.remote.has(accountId);
  }

  async createKey(): Promise<NearPublicKey> {
    throw new Error('Creating keys here is not supported.');
  }

  private async localKey(accountId?: string, networkId?: string): Promise<KeyPair | null> {
    if (!accountId) return null;
    return (await this.keyStore.getKey(networkId || this.networkId, accountId).catch(() => null)) ?? null;
  }

  async getPublicKey(accountId?: string, networkId?: string): Promise<NearPublicKey> {
    const ref = accountId ? this.remote.get(accountId) : undefined;
    if (ref) return remotePublicKey(accountId!, ref);
    const local = await this.localKey(accountId, networkId);
    if (!local) throw new Error(`No signing key for ${accountId}`);
    return local.getPublicKey();
  }

  async signMessage(message: Uint8Array, accountId?: string, networkId?: string): Promise<any> {
    const ref = accountId ? this.remote.get(accountId) : undefined;
    if (ref) {
      const signature = await requestRemoteSignature({
        chain: 'near', kind: 'transaction', ref, payload: Buffer.from(message).toString('base64'),
      });
      return { signature: Uint8Array.from(Buffer.from(signature, 'base64')), publicKey: await remotePublicKey(accountId!, ref) };
    }
    const local = await this.localKey(accountId, networkId);
    if (!local) throw new Error(`No signing key for ${accountId}`);
    // Exactly what InMemorySigner does: sign the sha256 of the message
    const hash = new Uint8Array(createHash('sha256').update(message).digest());
    return local.sign(hash);
  }
}

/** A signer for one account and its key (local or remote) */
export async function nearSignerFor(accountId: string, key: NearKeyLike, networkId = 'mainnet'): Promise<HybridNearSigner> {
  const keyStore = new keyStores.InMemoryKeyStore();
  const signer = new HybridNearSigner(keyStore, networkId);
  if (isRemoteNearKey(key)) signer.registerRemote(accountId, key.ref);
  else await keyStore.setKey(networkId, accountId, key);
  return signer;
}
