import { describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import { ethers } from 'ethers';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';

vi.mock('./redis.js', () => ({
  redis: {
    set: vi.fn(async () => 'OK'),
    get: vi.fn(async () => null),
    del: vi.fn(async () => 1),
    eval: vi.fn(async () => null),
  },
  redisPub: { on: vi.fn() },
  redisSub: { on: vi.fn() },
}));

import {
  detectWalletChain,
  verifyEvmSignature,
  verifySolanaSignature,
  createWalletAuthChallenge,
  verifyWalletAuthProof,
  verifyAuthToken,
  authenticateWalletUser,
} from './authSession.js';

describe('Multi-Wallet Authentication (EVM & Solana & NEAR)', () => {
  it('correctly detects wallet chain from account address or explicit input', () => {
    expect(detectWalletChain('0x71C83638372311E77570B369fbA6915AfCdCeB29')).toBe('evm');
    expect(detectWalletChain('0x71c83638372311e77570b369fba6915afcdceb29', 'evm')).toBe('evm');

    const solKeypair = Keypair.generate();
    const solAddr = solKeypair.publicKey.toBase58();
    expect(detectWalletChain(solAddr)).toBe('solana');
    expect(detectWalletChain(solAddr, 'solana')).toBe('solana');

    expect(detectWalletChain('alice.near')).toBe('near');
    expect(detectWalletChain('user.testnet', 'near')).toBe('near');

    expect(() => detectWalletChain('invalid!address@')).toThrow(/Unsupported wallet address/);
  });

  it('generates EIP-4361 SIWE challenge for EVM wallets', async () => {
    const evmWallet = ethers.Wallet.createRandom();
    const challenge = await createWalletAuthChallenge(evmWallet.address, 'evm');

    expect(challenge.chain).toBe('evm');
    expect(challenge.accountId).toBe(evmWallet.address.toLowerCase());
    expect(challenge.nonce).toBeDefined();
    expect(challenge.message).toContain('wants you to sign in with your Ethereum account');
    expect(challenge.message).toContain(evmWallet.address.toLowerCase());
    expect(challenge.message).toContain(`Nonce: ${challenge.nonce}`);
  });

  it('generates SIWS challenge for Solana wallets', async () => {
    const solKeypair = Keypair.generate();
    const solAddr = solKeypair.publicKey.toBase58();
    const challenge = await createWalletAuthChallenge(solAddr, 'solana');

    expect(challenge.chain).toBe('solana');
    expect(challenge.accountId).toBe(solAddr);
    expect(challenge.nonce).toBeDefined();
    expect(challenge.message).toContain('Sign in to RacerBot');
    expect(challenge.message).toContain(`Address: ${solAddr}`);
    expect(challenge.message).toContain(`Nonce: ${challenge.nonce}`);
  });

  it('verifies valid EVM SIWE signature and rejects invalid signatures', async () => {
    const evmWallet = ethers.Wallet.createRandom();
    const challenge = await createWalletAuthChallenge(evmWallet.address, 'evm');

    const signature = await evmWallet.signMessage(challenge.message);

    // Verify raw helper
    expect(verifyEvmSignature(challenge.message, signature, evmWallet.address)).toBe(true);
    expect(verifyEvmSignature(challenge.message, signature, '0x0000000000000000000000000000000000000000')).toBe(false);

    // Verify proof consumed successfully
    const res = await verifyWalletAuthProof({
      challengeId: challenge.challengeId,
      accountId: evmWallet.address,
      chain: 'evm',
      message: challenge.message,
      nonce: challenge.nonce,
      recipient: challenge.recipient,
      signature,
    });
    expect(res.chain).toBe('evm');
  });

  it('verifies valid Solana signature and rejects invalid signatures', async () => {
    const solKeypair = Keypair.generate();
    const solAddr = solKeypair.publicKey.toBase58();
    const challenge = await createWalletAuthChallenge(solAddr, 'solana');

    const msgBytes = Buffer.from(challenge.message, 'utf8');
    const sigBytes = nacl.sign.detached(msgBytes, solKeypair.secretKey);
    const signatureBase58 = bs58.encode(sigBytes);

    // Verify raw helper
    expect(verifySolanaSignature(challenge.message, signatureBase58, solAddr)).toBe(true);

    const otherKeypair = Keypair.generate();
    expect(verifySolanaSignature(challenge.message, signatureBase58, otherKeypair.publicKey.toBase58())).toBe(false);

    // Verify proof consumed successfully
    const res = await verifyWalletAuthProof({
      challengeId: challenge.challengeId,
      accountId: solAddr,
      chain: 'solana',
      message: challenge.message,
      nonce: challenge.nonce,
      recipient: challenge.recipient,
      signature: signatureBase58,
    });
    expect(res.chain).toBe('solana');
  });

  it('rejects tampered nonce or message in wallet proof', async () => {
    const evmWallet = ethers.Wallet.createRandom();
    const challenge = await createWalletAuthChallenge(evmWallet.address, 'evm');
    const signature = await evmWallet.signMessage(challenge.message);

    const tamperedNonce = crypto.randomBytes(32).toString('base64');
    await expect(
      verifyWalletAuthProof({
        challengeId: challenge.challengeId,
        accountId: evmWallet.address,
        chain: 'evm',
        message: challenge.message,
        nonce: tamperedNonce,
        recipient: challenge.recipient,
        signature,
      })
    ).rejects.toThrow(/does not match the issued challenge/);
  });

  it('signs in only as the wallet that signed, never as a named account', async () => {
    const attacker = ethers.Wallet.createRandom();
    const challenge = await createWalletAuthChallenge(attacker.address, 'evm');
    const signature = await attacker.signMessage(challenge.message);
    const res = await authenticateWalletUser({
      accountId: 'victim.near',
      chain: 'evm',
      proof: {
        challengeId: challenge.challengeId,
        accountId: attacker.address,
        chain: 'evm',
        message: challenge.message,
        nonce: challenge.nonce,
        recipient: challenge.recipient,
        signature,
      },
    });
    expect(res.success).toBe(false);
    expect(res.authToken).toBeUndefined();
    expect(res.reason).toMatch(/does not match/);
  });

  it('refuses a stated chain that does not fit the address', () => {
    expect(() => detectWalletChain('victim.near', 'evm')).toThrow();
    expect(() => detectWalletChain('victim.near', 'solana')).toThrow();
    expect(() => detectWalletChain('0x' + 'ab'.repeat(20), 'solana')).toThrow();
    expect(detectWalletChain('0x' + 'ab'.repeat(20), 'near')).toBe('near');
  });
});
