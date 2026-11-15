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
  BASE_MAINNET_CHAIN_ID,
  ARBITRUM_MAINNET_CHAIN_ID,
  ETHEREUM_MAINNET_CHAIN_ID,
  ZERO_CHAIN_MAINNET_CHAIN_ID,
  isEvmChainName,
  getEvmNativeSymbol,
  getEvmRpcUrl,
  getEvmChainId,
  getEvmExplorerUrl,
  getDefaultRouter,
  getDefaultWrappedNative,
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
    expect(BASE_MAINNET_CHAIN_ID).toBe(8453);
    expect(ARBITRUM_MAINNET_CHAIN_ID).toBe(42161);
    expect(ETHEREUM_MAINNET_CHAIN_ID).toBe(1);
    expect(ZERO_CHAIN_MAINNET_CHAIN_ID).toBe(4242);
  });

  it('recognizes all supported EVM chains and their native symbols', () => {
    expect(isEvmChainName('base')).toBe(true);
    expect(isEvmChainName('arbitrum')).toBe(true);
    expect(isEvmChainName('ethereum')).toBe(true);
    expect(isEvmChainName('zero')).toBe(true);
    expect(isEvmChainName('hyperevm')).toBe(true);
    expect(isEvmChainName('elysium')).toBe(true);
    expect(isEvmChainName('solana')).toBe(false);
    expect(isEvmChainName('near')).toBe(false);

    expect(getEvmNativeSymbol('base')).toBe('ETH');
    expect(getEvmNativeSymbol('arbitrum')).toBe('ETH');
    expect(getEvmNativeSymbol('ethereum')).toBe('ETH');
    expect(getEvmNativeSymbol('zero')).toBe('ZRO');
    expect(getEvmNativeSymbol('hyperevm')).toBe('HYPE');
    expect(getEvmNativeSymbol('elysium')).toBe('HYPE');
  });

  it('provides correct RPC URLs and chain IDs for all EVM chains', () => {
    expect(getEvmChainId('base')).toBe(8453);
    expect(getEvmChainId('arbitrum')).toBe(42161);
    expect(getEvmChainId('ethereum')).toBe(1);
    expect(getEvmChainId('zero')).toBe(4242);

    expect(getEvmRpcUrl('base')).toContain('base.org');
    expect(getEvmRpcUrl('arbitrum')).toContain('arbitrum.io');
    expect(getEvmRpcUrl('zero')).toContain('zero.network');
  });

  it('provides correct default routers and wrapped native addresses', () => {
    expect(getDefaultRouter('base')).toBe('0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24');
    expect(getDefaultRouter('arbitrum')).toBe('0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506');
    expect(getDefaultRouter('ethereum')).toBe('0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D');
    expect(getDefaultRouter('zero')).toBe('0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24');

    expect(getDefaultWrappedNative('base')).toBe('0x4200000000000000000000000000000000000006');
    expect(getDefaultWrappedNative('arbitrum')).toBe('0x82aF49447D8a07e3bd95BD0d56f35241523fBab1');
    expect(getDefaultWrappedNative('ethereum')).toBe('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2');
    expect(getDefaultWrappedNative('zero')).toBe('0x6985884C4392D348587B19cb9eAAf157F13271cd');
  });

  it('generates clean explorer URLs for transactions and addresses', () => {
    const tx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    expect(getEvmExplorerUrl('base', tx)).toBe(`https://basescan.org/tx/${tx}`);
    expect(getEvmExplorerUrl('arbitrum', tx)).toBe(`https://arbiscan.io/tx/${tx}`);
    expect(getEvmExplorerUrl('zero', tx)).toBe(`https://zeroscan.io/tx/${tx}`);
    expect(getEvmExplorerUrl('ethereum', tx)).toBe(`https://etherscan.io/tx/${tx}`);
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
