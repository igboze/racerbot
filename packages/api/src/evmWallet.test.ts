import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { parseEvmSecret, evmRecipientProblem } from './evmWallet.js';

// Well-known test vector (Hardhat account #0); never holds real funds
const HARDHAT_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const HARDHAT_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const TEST_PHRASE = 'test test test test test test test test test test test junk';

describe('parseEvmSecret', () => {
  it('accepts a 64-hex private key with or without 0x', () => {
    expect(parseEvmSecret(HARDHAT_KEY).address).toBe(HARDHAT_ADDRESS);
    expect(parseEvmSecret(HARDHAT_KEY.slice(2)).address).toBe(HARDHAT_ADDRESS);
    expect(parseEvmSecret(`  ${HARDHAT_KEY.toUpperCase().replace('0X', '0x')}  `).address).toBe(HARDHAT_ADDRESS);
  });

  it('accepts a 12-word seed phrase and uses its first account', () => {
    expect(parseEvmSecret(TEST_PHRASE).address).toBe(HARDHAT_ADDRESS);
  });

  it('rejects anything that is not an EVM key or phrase', () => {
    expect(() => parseEvmSecret('ed25519:5Kd3NBUAdUnhyzenEwVLy9pBKxSwXvE9FMPyR4UKZvpe')).toThrow(/not an EVM private key/);
    expect(() => parseEvmSecret('0x1234')).toThrow(/not an EVM private key/);
    expect(() => parseEvmSecret('one two three four five six seven eight nine ten eleven twelve')).toThrow(/seed phrase/);
  });
});

describe('evmRecipientProblem', () => {
  const own = '0x1111111111111111111111111111111111111111';

  it('accepts a plain 20-byte address', () => {
    expect(evmRecipientProblem(HARDHAT_ADDRESS, own)).toBeNull();
    expect(evmRecipientProblem(HARDHAT_ADDRESS.toLowerCase(), own)).toBeNull();
  });

  it('refuses Starknet and Sui addresses, which are 0x but longer', () => {
    const starknet = '0x0679eC47817013974A8f45df792fcf77504360c1344A0E0bfd1aB4b6dDbaB39A';
    const sui = '0x' + 'ab'.repeat(32);
    expect(evmRecipientProblem(starknet, own)).toMatch(/Starknet or Sui/);
    expect(evmRecipientProblem(sui, own)).toMatch(/Starknet or Sui/);
    expect(evmRecipientProblem('0x' + 'a'.repeat(41), own)).toMatch(/Starknet or Sui/);
  });

  it('refuses NEAR accounts and Solana addresses', () => {
    expect(evmRecipientProblem('alice.near', own)).toMatch(/NEAR account/);
    expect(evmRecipientProblem('a'.repeat(64), own)).toMatch(/NEAR account/);
    expect(evmRecipientProblem('So11111111111111111111111111111111111111112', own)).toMatch(/Solana/);
  });

  it('refuses a bad checksum, the zero address and the own wallet', () => {
    const badChecksum = HARDHAT_ADDRESS.replace('F39', 'f39').replace('aad', 'AAD');
    expect(ethers.isAddress(badChecksum)).toBe(false);
    expect(evmRecipientProblem(badChecksum, own)).toMatch(/checksum/);
    expect(evmRecipientProblem(ethers.ZeroAddress, own)).toMatch(/zero address/);
    expect(evmRecipientProblem(own, own)).toMatch(/your own/);
  });

  it('refuses anything else', () => {
    expect(evmRecipientProblem('0x123', own)).toMatch(/not an EVM address/);
    expect(evmRecipientProblem('', own)).toMatch(/not an EVM address/);
  });
});
