import { describe, it, expect } from 'vitest';
import {
  isSolanaAddress,
  generateSolanaWallet,
  restoreSolanaKeypair,
  restoreSolanaKeypairFromSecret,
  exportSolanaPrivateKey,
  solanaSellFeeBps,
  SOLANA_FEE_BPS,
  SOLANA_SELL_FEE_BPS_HIGH,
  DEFAULT_SOLANA_DEV_FEE_WALLET,
  lamportsToSol,
  solToLamports,
} from './solana.js';

const MK = 'unit-test-master-key-0123456789abcdef0123456789ab';

describe('solana: addresses', () => {
  it('accepts real mints and wallets', () => {
    expect(isSolanaAddress('So11111111111111111111111111111111111111112')).toBe(true);
    expect(isSolanaAddress('37HUJAw35KccKwFb8Lb5ECZfppRaEy88apkL4WYgpump')).toBe(true);
    expect(isSolanaAddress(DEFAULT_SOLANA_DEV_FEE_WALLET)).toBe(true);
  });
  it('rejects NEAR, Sui, Starknet and garbage', () => {
    expect(isSolanaAddress('blackdragon.tkn.near')).toBe(false);
    expect(isSolanaAddress('0x2::sui::SUI')).toBe(false);
    expect(isSolanaAddress('0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d')).toBe(false);
    expect(isSolanaAddress('hello')).toBe(false);
    expect(isSolanaAddress('')).toBe(false);
  });
});

describe('solana: keys', () => {
  it('generates, encrypts and restores the same wallet', () => {
    const w = generateSolanaWallet(MK);
    expect(isSolanaAddress(w.address)).toBe(true);
    expect(restoreSolanaKeypair(w.encryptedPrivateKey, MK).publicKey.toBase58()).toBe(w.address);
    expect(restoreSolanaKeypairFromSecret(w.privateKeySecret).publicKey.toBase58()).toBe(w.address);
    expect(exportSolanaPrivateKey(w.encryptedPrivateKey, MK)).toBe(w.privateKeySecret);
  });
  it('restores from a JSON byte array (CLI format)', () => {
    const w = generateSolanaWallet(MK);
    const kp = restoreSolanaKeypairFromSecret(w.privateKeySecret);
    const json = JSON.stringify(Array.from(kp.secretKey));
    expect(restoreSolanaKeypairFromSecret(json).publicKey.toBase58()).toBe(w.address);
  });
});

describe('solana: fees match NEAR', () => {
  it('buy fee is 1.5%', () => {
    expect(SOLANA_FEE_BPS).toBe(150n);
    expect((1_000_000_000n * SOLANA_FEE_BPS) / 10000n).toBe(15_000_000n);
  });
  it('sell fee is 1.5% up to $200 and 2% above', () => {
    expect(solanaSellFeeBps(1_000_000_000n, 150)).toBe(SOLANA_FEE_BPS); // $150
    expect(solanaSellFeeBps(2_000_000_000n, 150)).toBe(SOLANA_SELL_FEE_BPS_HIGH); // $300
  });
  it('converts units', () => {
    expect(lamportsToSol(1_500_000_000n)).toBe(1.5);
    expect(solToLamports(0.25)).toBe(250_000_000n);
  });
});

import { solanaUiToRaw } from './solana.js';

describe('solanaUiToRaw', () => {
  it('converts human amounts without float drift', () => {
    expect(solanaUiToRaw(1250.5, 6)).toBe(1_250_500_000n);
    expect(solanaUiToRaw('0.1', 9)).toBe(100_000_000n);
    expect(solanaUiToRaw(0.3, 6)).toBe(300_000n);
    expect(solanaUiToRaw(250000, 6)).toBe(250_000_000_000n);
  });
  it('returns 0 for invalid or non-positive input', () => {
    expect(solanaUiToRaw(-1, 6)).toBe(0n);
    expect(solanaUiToRaw(NaN, 6)).toBe(0n);
    expect(solanaUiToRaw('abc', 6)).toBe(0n);
  });
});
