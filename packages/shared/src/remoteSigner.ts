/**
 * Remote signing (signer Phase B): with SIGNER_URL set, trades are signed by the signer
 * service instead of this process. Callers get a signer object that fits the chain library
 * (an ethers signer for HyperEVM/Elysium/Kleos, a Solana signer), so trading code does not
 * change; the unsigned transaction goes to the signer, which checks it against its rules,
 * signs with the key only it holds and sends the signature back.
 *
 * Without SIGNER_URL (or inside the signer itself) these return local signers built from
 * the encrypted key, exactly as before.
 */
import crypto from 'crypto';
import { ethers } from 'ethers';
import { PublicKey, type VersionedTransaction } from '@solana/web3.js';
import { getEvmWalletFromEncrypted } from './evm.js';
import { restoreSolanaKeypair } from './solana.js';
import type { SolanaKeyLike, SolanaRemoteSigner } from './solanaSigning.js';

export type RemoteSignChain = 'evm' | 'solana' | 'near' | 'sui' | 'starknet';

/** Which key: the signer looks it up by owner and address, never from the caller */
export interface SigningKeyRef {
  userId: string;
  address: string;
  /** Used only when signing locally (no signer service) */
  encryptedKey?: string | null;
  /** What the signature is for, recorded in the signer's audit log (e.g. "evm_swap") */
  purpose?: string;
}

/** True when this process should ask the signer service to sign (never inside the signer) */
export function remoteSigningEnabled(): boolean {
  return Boolean(process.env.SIGNER_URL) && process.env.RACERBOT_SIGNER !== 'true';
}

const hmac = (secret: string, timestamp: string, body: string) =>
  crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

/**
 * One authenticated request to the signer service (HMAC over timestamp + body). Returns the
 * response's `result`, or its `signed` value for signing routes; throws the signer's error.
 */
export async function callSignerService(path: string, payload: unknown, timeoutMs = 30_000): Promise<any> {
  const url = (process.env.SIGNER_URL || '').replace(/\/+$/, '');
  const secret = process.env.SIGNER_SHARED_SECRET || '';
  if (!url || !secret) throw new Error('This is temporarily unavailable (signer not configured).');
  const body = JSON.stringify(payload);
  const timestamp = String(Date.now());
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signer-timestamp': timestamp, 'x-signer-signature': hmac(secret, timestamp, body) },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((err: any) => {
    throw new Error(`This is temporarily unavailable: ${err?.message || 'signer unreachable'}`);
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || data?.ok !== true) {
    throw new Error(data?.error || `The signer refused this request (${res.status})`);
  }
  return data.result !== undefined ? data.result : data.signed;
}

/** Asks the signer service to sign one payload; returns its signature or signed transaction */
export async function requestRemoteSignature(req: {
  chain: RemoteSignChain;
  kind: 'transaction' | 'message' | 'typed_data' | 'public_key' | 'deploy_account' | 'intents_message';
  ref: SigningKeyRef;
  payload: string;
}): Promise<string> {
  const signed = await callSignerService('/v1/sign', {
    chain: req.chain,
    kind: req.kind,
    userId: req.ref.userId,
    address: req.ref.address,
    purpose: req.ref.purpose || null,
    payload: req.payload,
  }).catch((err: any) => {
    throw new Error(String(err?.message || err).replace(/^This is/, 'Trading is'));
  });
  if (typeof signed !== 'string') throw new Error('The signer returned no signature.');
  return signed;
}

/** An ethers signer whose key lives in the signer service */
export class RemoteEvmSigner extends ethers.AbstractSigner {
  readonly address: string;

  constructor(private readonly ref: SigningKeyRef, provider: ethers.Provider | null = null) {
    super(provider);
    this.address = ethers.getAddress(ref.address);
  }

  async getAddress(): Promise<string> {
    return this.address;
  }

  connect(provider: ethers.Provider | null): RemoteEvmSigner {
    return new RemoteEvmSigner(this.ref, provider);
  }

  async signTransaction(request: ethers.TransactionRequest): Promise<string> {
    const tx = { ...request };
    // Resolve names to addresses, as ethers' own Wallet does
    const [to, from] = await Promise.all([
      tx.to ? ethers.resolveAddress(tx.to, this.provider) : null,
      tx.from ? ethers.resolveAddress(tx.from, this.provider) : null,
    ]);
    if (to !== null) tx.to = to;
    if (from !== null && ethers.getAddress(from) !== this.address) {
      throw new Error('Transaction from does not match the signing wallet');
    }
    delete tx.from;
    const unsigned = ethers.Transaction.from(tx as ethers.TransactionLike<string>).unsignedSerialized;
    return requestRemoteSignature({ chain: 'evm', kind: 'transaction', ref: this.ref, payload: unsigned });
  }

  async signMessage(message: string | Uint8Array): Promise<string> {
    const bytes = typeof message === 'string' ? ethers.toUtf8Bytes(message) : message;
    return requestRemoteSignature({ chain: 'evm', kind: 'message', ref: this.ref, payload: ethers.hexlify(bytes) });
  }

  async signTypedData(
    domain: ethers.TypedDataDomain,
    types: Record<string, ethers.TypedDataField[]>,
    value: Record<string, any>
  ): Promise<string> {
    const payload = JSON.stringify({ domain, types, value }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    return requestRemoteSignature({ chain: 'evm', kind: 'typed_data', ref: this.ref, payload });
  }
}

/** A Solana signer whose key lives in the signer service */
export class RemoteSolanaKey implements SolanaRemoteSigner {
  readonly publicKey: PublicKey;

  constructor(private readonly ref: SigningKeyRef) {
    this.publicKey = new PublicKey(ref.address);
  }

  async signVersioned(tx: VersionedTransaction): Promise<void> {
    const payload = Buffer.from(tx.message.serialize()).toString('base64');
    const signature = await requestRemoteSignature({ chain: 'solana', kind: 'transaction', ref: this.ref, payload });
    tx.addSignature(this.publicKey, Uint8Array.from(Buffer.from(signature, 'base64')));
  }
}

/** The signer for a user's EVM wallet: remote when the signer service is configured */
export function getEvmSigner(ref: SigningKeyRef, masterKey: string, provider?: ethers.Provider): ethers.AbstractSigner & { address: string } {
  if (remoteSigningEnabled()) return new RemoteEvmSigner(ref, provider ?? null);
  if (!ref.encryptedKey) throw new Error('EVM wallet key is not available.');
  const wallet = getEvmWalletFromEncrypted(ref.encryptedKey, masterKey, provider);
  if (wallet.address.toLowerCase() !== ref.address.toLowerCase()) {
    throw new Error('EVM wallet key does not match the stored address. Please contact support.');
  }
  return wallet;
}

/** The signer for a user's Solana wallet: remote when the signer service is configured */
export function getSolanaSigner(ref: SigningKeyRef, masterKey: string): SolanaKeyLike {
  if (remoteSigningEnabled()) return new RemoteSolanaKey(ref);
  if (!ref.encryptedKey) throw new Error('Solana wallet key is not available.');
  const keypair = restoreSolanaKeypair(ref.encryptedKey, masterKey);
  if (keypair.publicKey.toBase58() !== ref.address) {
    throw new Error('Solana wallet key does not match the stored address. Please contact support.');
  }
  return keypair;
}
