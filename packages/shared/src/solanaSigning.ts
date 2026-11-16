/**
 * Something that can sign a Solana transaction: a local Keypair, or a remote signer
 * (the signer service holds the key and checks the transaction before signing).
 */
import type { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';

export interface SolanaRemoteSigner {
  readonly publicKey: PublicKey;
  /** Adds this signer's signature to the transaction */
  signVersioned(tx: VersionedTransaction): Promise<void>;
}

export type SolanaKeyLike = Keypair | SolanaRemoteSigner;

export const isLocalKeypair = (k: SolanaKeyLike): k is Keypair => 'secretKey' in k;

/** Signs with every signer given: local keypairs in one pass, remote signers one by one */
export async function signSolanaTx(tx: VersionedTransaction, signers: SolanaKeyLike[]): Promise<void> {
  const local = signers.filter(isLocalKeypair);
  if (local.length > 0) tx.sign(local);
  for (const s of signers) {
    if (!isLocalKeypair(s)) await s.signVersioned(tx);
  }
}
