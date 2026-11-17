import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ethers } from 'ethers';
import nacl from 'tweetnacl';
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { RemoteEvmSigner, RemoteSolanaKey, getEvmSigner, remoteSigningEnabled } from './remoteSigner.js';
import { encrypt } from './crypto.js';

const MASTER = 'm'.repeat(40);
const evmWallet = ethers.Wallet.createRandom();
const solKey = Keypair.generate();

/** Stands in for the signer service: signs what it is sent with the real key */
function fakeSigner() {
  return vi.fn(async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    let signed: string;
    if (body.chain === 'evm') {
      const tx = ethers.Transaction.from(body.payload);
      tx.signature = evmWallet.signingKey.sign(tx.unsignedHash);
      signed = tx.serialized;
    } else {
      const message = Buffer.from(body.payload, 'base64');
      signed = Buffer.from(nacl.sign.detached(message, solKey.secretKey)).toString('base64');
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, signed }) } as any;
  });
}

describe('remote signing', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.SIGNER_URL = 'http://signer.test';
    process.env.SIGNER_SHARED_SECRET = 's'.repeat(40);
    delete process.env.RACERBOT_SIGNER;
  });
  afterEach(() => {
    process.env = { ...saved };
    vi.unstubAllGlobals();
  });

  it('is used only when SIGNER_URL is set and never inside the signer', () => {
    expect(remoteSigningEnabled()).toBe(true);
    process.env.RACERBOT_SIGNER = 'true';
    expect(remoteSigningEnabled()).toBe(false);
  });

  it('returns a remote EVM signer, and a local one without the signer service', () => {
    const ref = { userId: 'u1', address: evmWallet.address, encryptedKey: encrypt(evmWallet.privateKey, MASTER) };
    expect(getEvmSigner(ref, MASTER)).toBeInstanceOf(RemoteEvmSigner);
    delete process.env.SIGNER_URL;
    const local = getEvmSigner(ref, MASTER);
    expect(local).toBeInstanceOf(ethers.Wallet);
    expect(local.address).toBe(evmWallet.address);
  });

  it('signs an EVM transaction remotely into one that recovers to the user', async () => {
    const fetchMock = fakeSigner();
    vi.stubGlobal('fetch', fetchMock);
    const signer = new RemoteEvmSigner({ userId: 'u1', address: evmWallet.address, purpose: 'test' });
    const raw = await signer.signTransaction({
      type: 2, chainId: 999, nonce: 3, to: '0x00000000000000000000000000000000000000a1',
      value: 1n, gasLimit: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 0n,
    });
    const parsed = ethers.Transaction.from(raw);
    expect(parsed.from).toBe(evmWallet.address);
    expect(parsed.nonce).toBe(3);
    // The request is authenticated
    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers['x-signer-signature']).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).payload).toBe(ethers.Transaction.from(raw).unsignedSerialized);
  });

  it('adds a valid Solana signature from the signer', async () => {
    vi.stubGlobal('fetch', fakeSigner());
    const msg = new TransactionMessage({
      payerKey: solKey.publicKey, recentBlockhash: '11111111111111111111111111111111',
      instructions: [SystemProgram.transfer({ fromPubkey: solKey.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1n })],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    await new RemoteSolanaKey({ userId: 'u1', address: solKey.publicKey.toBase58() }).signVersioned(tx);
    expect(nacl.sign.detached.verify(tx.message.serialize(), tx.signatures[0], solKey.publicKey.toBytes())).toBe(true);
  });

  it('passes the signer\'s refusal through as the error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ ok: false, error: 'The signer refused this transaction: sends 1 HYPE' }) })));
    const signer = new RemoteEvmSigner({ userId: 'u1', address: evmWallet.address });
    await expect(signer.signTransaction({ type: 2, chainId: 999, nonce: 0, to: evmWallet.address, gasLimit: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 0n }))
      .rejects.toThrow(/refused this transaction/);
  });
});

describe('remote NEAR signing', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    vi.unstubAllGlobals();
  });

  it('signs a NEAR transaction through the signer service into one that verifies', async () => {
    const { KeyPair, transactions } = await import('near-api-js');
    const { createHash } = await import('crypto');
    const { HybridNearSigner } = await import('./nearRemoteSigner.js');
    const { keyStores } = await import('near-api-js');
    process.env.SIGNER_URL = 'http://signer.test';
    process.env.SIGNER_SHARED_SECRET = 's'.repeat(40);
    delete process.env.RACERBOT_SIGNER;

    const key = KeyPair.fromRandom('ed25519');
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      const signed = body.kind === 'public_key'
        ? key.getPublicKey().toString()
        : Buffer.from(key.sign(new Uint8Array(createHash('sha256').update(Buffer.from(body.payload, 'base64')).digest())).signature).toString('base64');
      return { ok: true, status: 200, json: async () => ({ ok: true, signed }) } as any;
    }));

    const signer = new HybridNearSigner(new keyStores.InMemoryKeyStore());
    signer.registerRemote('alice.near', { userId: 'u1', address: 'alice.near', purpose: 'test' });
    expect((await signer.getPublicKey('alice.near', 'mainnet')).toString()).toBe(key.getPublicKey().toString());

    const [hash, signedTx] = await transactions.signTransaction(
      'wrap.near', 1n, [transactions.functionCall('near_deposit', {}, 30_000_000_000_000n, 1n)], new Uint8Array(32), signer, 'alice.near', 'mainnet'
    );
    expect(key.verify(hash, (signedTx.signature as any).ed25519Signature.data)).toBe(true);
  });
});
