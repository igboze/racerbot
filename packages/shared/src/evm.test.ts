import { describe, it, expect } from 'vitest';
import {
  generateEvmWallet,
  getEvmWalletFromEncrypted,
  isValidEvmAddress,
  calculateEvmTradeFee,
  calculateSlippageMin,
  toTokenUnits,
  HYPE_DECIMALS,
  HYPE_SYMBOL,
  HYPEREVM_MAINNET_CHAIN_ID,
  ELYSIUM_TESTNET_CHAIN_ID,
} from './evm.js';

describe('Unified EVM Module', () => {
  const masterKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  it('generates a valid EVM wallet and encrypts/decrypts private key cleanly', () => {
    const wallet = generateEvmWallet(masterKey);

    expect(wallet.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(isValidEvmAddress(wallet.address)).toBe(true);
    expect(wallet.privateKey).toMatch(/^0x[a-fA-F0-9]{64}$/);
    expect(wallet.encryptedPrivateKey).toBeDefined();

    // Recover wallet from encrypted private key
    const recovered = getEvmWalletFromEncrypted(wallet.encryptedPrivateKey, masterKey);
    expect(recovered.address.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it('validates chain IDs and native gas token', () => {
    expect(HYPE_SYMBOL).toBe('HYPE');
    expect(HYPE_DECIMALS).toBe(18);
    expect(HYPEREVM_MAINNET_CHAIN_ID).toBe(999);
    expect(ELYSIUM_TESTNET_CHAIN_ID).toBe(99801);
  });

  it('calculates 1.5% platform fee correctly', () => {
    const oneHype = 1_000_000_000_000_000_000n; // 1 HYPE (18 decimals)
    const { feeAmount, netTradeAmount, feeBps } = calculateEvmTradeFee(oneHype);

    expect(feeBps).toBe(150);
    // 1.5% of 1 HYPE = 0.015 HYPE = 15_000_000_000_000_000n
    expect(feeAmount).toBe(15_000_000_000_000_000n);
    expect(netTradeAmount).toBe(985_000_000_000_000_000n);
    expect(feeAmount + netTradeAmount).toBe(oneHype);
  });

  it('calculates minimum received output with slippage tolerance', () => {
    const expectedTokens = 1000n;
    // 1% slippage
    const minReceived1Pct = calculateSlippageMin(expectedTokens, 1.0);
    expect(minReceived1Pct).toBe(990n);

    // 5% slippage
    const minReceived5Pct = calculateSlippageMin(expectedTokens, 5.0);
    expect(minReceived5Pct).toBe(950n);
  });
});

describe('toTokenUnits', () => {
  it('converts human amounts and drops digits past the token decimals', () => {
    expect(toTokenUnits('0.5', 18)).toBe(500000000000000000n);
    expect(toTokenUnits('12', 6)).toBe(12000000n);
    expect(toTokenUnits('1.2345678', 6)).toBe(1234567n);
    expect(toTokenUnits('.5', 2)).toBe(50n);
  });
});
