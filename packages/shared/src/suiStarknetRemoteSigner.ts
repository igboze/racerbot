/**
 * Sui and Starknet signing that works with a local key or the signer service (signer Phase B3).
 *
 * - Sui: the signer receives the full transaction bytes (signTransaction), decodes the
 *   commands and signs.
 * - Starknet: the signer receives the calls and the transaction details, checks each call
 *   and computes the signature itself with starknet.js, exactly as a local Signer would.
 */
import { Signer as SuiSigner, type SignatureScheme } from '@mysten/sui/cryptography';
import { Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519';
import { toBase64 } from '@mysten/sui/utils';
import { SignerInterface, type Call, type InvocationsSignerDetails, type DeployAccountSignerDetails, type Signature, type TypedData } from 'starknet';
import { decrypt } from './crypto.js';
import { restoreSuiKeypair } from './sui.js';
import { remoteSigningEnabled, requestRemoteSignature, type SigningKeyRef } from './remoteSigner.js';

/** JSON that keeps bigints exact both ways (Starknet details and calldata carry them) */
export const toTaggedJson = (value: unknown): string =>
  JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? { __bigint__: v.toString() } : v));
export const fromTaggedJson = (text: string): any =>
  JSON.parse(text, (_k, v) => (v && typeof v === 'object' && typeof v.__bigint__ === 'string' ? BigInt(v.__bigint__) : v));

// ── Sui ───────────────────────────────────────────────────────────────────────

/** A Sui signer whose key lives in the signer service */
export class RemoteSuiSigner extends SuiSigner {
  constructor(private readonly ref: SigningKeyRef, private readonly publicKey: Ed25519PublicKey) {
    super();
  }

  getKeyScheme(): SignatureScheme {
    return 'ED25519';
  }

  getPublicKey(): Ed25519PublicKey {
    return this.publicKey;
  }

  /** Raw digests are never signed remotely: the signer must see the whole transaction */
  async sign(): Promise<Uint8Array<ArrayBuffer>> {
    throw new Error('Only full transactions can be signed by the signer service.');
  }

  async signTransaction(bytes: Uint8Array): Promise<{ signature: string; bytes: string }> {
    const signature = await requestRemoteSignature({ chain: 'sui', kind: 'transaction', ref: this.ref, payload: toBase64(bytes) });
    return { signature, bytes: toBase64(bytes) };
  }

  async signPersonalMessage(): Promise<{ signature: string; bytes: string }> {
    throw new Error('Message signing is not available through the signer service.');
  }
}

/** The signer for a user's Sui wallet: remote when the signer service is configured */
export async function getSuiSigner(ref: SigningKeyRef, masterKey: string): Promise<SuiSigner> {
  if (remoteSigningEnabled()) {
    const publicKey = new Ed25519PublicKey(await requestRemoteSignature({ chain: 'sui', kind: 'public_key', ref, payload: '' }));
    if (publicKey.toSuiAddress().toLowerCase() !== ref.address.toLowerCase()) {
      throw new Error('Sui wallet key does not match the stored address. Please contact support.');
    }
    return new RemoteSuiSigner(ref, publicKey);
  }
  if (!ref.encryptedKey) throw new Error('Sui wallet key is not available.');
  return restoreSuiKeypair(ref.encryptedKey, masterKey);
}

// ── Starknet ─────────────────────────────────────────────────────────────────

/** A Starknet signer whose key lives in the signer service */
export class RemoteStarknetSigner extends SignerInterface {
  private pubKey: string | null = null;

  constructor(private readonly ref: SigningKeyRef) {
    super();
  }

  async getPubKey(): Promise<string> {
    this.pubKey ??= await requestRemoteSignature({ chain: 'starknet', kind: 'public_key', ref: this.ref, payload: '' });
    return this.pubKey;
  }

  async signTransaction(transactions: Call[], details: InvocationsSignerDetails): Promise<Signature> {
    const signed = await requestRemoteSignature({
      chain: 'starknet', kind: 'transaction', ref: this.ref, payload: toTaggedJson({ calls: transactions, details }),
    });
    return JSON.parse(signed);
  }

  async signDeployAccountTransaction(details: DeployAccountSignerDetails): Promise<Signature> {
    const signed = await requestRemoteSignature({
      chain: 'starknet', kind: 'deploy_account', ref: this.ref, payload: toTaggedJson({ details }),
    });
    return JSON.parse(signed);
  }

  async signMessage(_typedData: TypedData, _accountAddress: string): Promise<Signature> {
    throw new Error('Message signing is not available through the signer service.');
  }

  async signDeclareTransaction(): Promise<Signature> {
    throw new Error('Declaring contracts is not allowed through the signer service.');
  }
}

/**
 * The signer for a user's Starknet wallet: remote when the signer service is configured,
 * else the decrypted private key (which starknet.js's Account turns into a Signer).
 */
export function getStarknetSigner(ref: SigningKeyRef, masterKey: string): SignerInterface | string {
  if (remoteSigningEnabled()) return new RemoteStarknetSigner(ref);
  if (!ref.encryptedKey) throw new Error('Starknet wallet key is not available.');
  return decrypt(ref.encryptedKey, masterKey);
}
