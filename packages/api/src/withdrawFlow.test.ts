import { describe, it, expect } from 'vitest';
import {
  validateWithdrawAddress,
  parseWithdrawAmount,
  resolvePositionWithdrawChain,
  isWithdrawChainId,
  WITHDRAW_CHAIN_META,
} from './withdrawFlow.js';

const HARDHAT_ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const OWN_EVM = '0x1111111111111111111111111111111111111111';
const VALID_SOL = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const OWN_SOL = 'So11111111111111111111111111111111111111112';
const VALID_SUI = '0x' + 'ab'.repeat(32);
const OWN_SUI = '0x' + 'cd'.repeat(32);
const VALID_STARKNET = '0x0679eC47817013974A8f45df792fcf77504360c1344A0E0bfd1aB4b6dDbaB39A';
const OWN_STARKNET = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('withdrawFlow — validateWithdrawAddress', () => {
  const own = {
    near: 'mybot.racerbot.near',
    solana: OWN_SOL,
    sui: OWN_SUI,
    starknet: OWN_STARKNET,
    evm: OWN_EVM,
  };

  it('rejects empty inputs and inputs containing spaces (like "<address> <amount>")', () => {
    expect(validateWithdrawAddress('near', '', own)).toEqual({
      ok: false,
      error: expect.stringMatching(/enter a destination/i),
    });
    expect(validateWithdrawAddress('near', 'alice.near 10', own)).toEqual({
      ok: false,
      error: expect.stringMatching(/only the destination wallet address/i),
    });
    expect(validateWithdrawAddress('base', `${HARDHAT_ADDR} all`, own)).toEqual({
      ok: false,
      error: expect.stringMatching(/only the destination wallet address/i),
    });
  });

  it('validates NEAR addresses and rejects non-NEAR, bare words/numbers, or own addresses', () => {
    expect(validateWithdrawAddress('near', 'Alice.NEAR', own)).toEqual({
      ok: true,
      address: 'alice.near',
    });
    expect(validateWithdrawAddress('near', 'bob.hot.tg', own)).toEqual({
      ok: true,
      address: 'bob.hot.tg',
    });
    expect(validateWithdrawAddress('near', 'a'.repeat(64), own)).toEqual({
      ok: true,
      address: 'a'.repeat(64),
    });
    expect(validateWithdrawAddress('near', '10', own)).toEqual({
      ok: false,
      error: expect.stringMatching(/Invalid NEAR account ID/i),
    });
    expect(validateWithdrawAddress('near', 'all', own)).toEqual({
      ok: false,
      error: expect.stringMatching(/Invalid NEAR account ID/i),
    });
    expect(validateWithdrawAddress('near', 'binance', own)).toEqual({
      ok: false,
      error: expect.stringMatching(/Invalid NEAR account ID/i),
    });
    expect(validateWithdrawAddress('near', 'mybot.racerbot.near', own)).toEqual({
      ok: false,
      error: expect.stringMatching(/your own RacerBot NEAR/i),
    });
    expect(validateWithdrawAddress('near', HARDHAT_ADDR, own)).toEqual({
      ok: false,
      error: expect.stringMatching(/0x address/i),
    });
    expect(validateWithdrawAddress('near', VALID_SOL, own)).toEqual({
      ok: false,
      error: expect.stringMatching(/Solana address/i),
    });
  });

  it('validates Solana addresses and rejects non-Solana or own addresses', () => {
    expect(validateWithdrawAddress('solana', VALID_SOL, own)).toEqual({
      ok: true,
      address: VALID_SOL,
    });
    expect(validateWithdrawAddress('solana', OWN_SOL, own)).toEqual({
      ok: false,
      error: expect.stringMatching(/your own RacerBot Solana/i),
    });
    expect(validateWithdrawAddress('solana', 'alice.near', own)).toEqual({
      ok: false,
      error: expect.stringMatching(/Invalid Solana/i),
    });
  });

  it('validates SUI addresses and rejects 40-hex EVM addresses or own SUI address', () => {
    expect(validateWithdrawAddress('sui', VALID_SUI.toUpperCase().replace('0X', '0x'), own)).toEqual({
      ok: true,
      address: VALID_SUI,
    });
    expect(validateWithdrawAddress('sui', HARDHAT_ADDR, own)).toEqual({
      ok: false,
      error: expect.stringMatching(/40-character EVM address/i),
    });
    expect(validateWithdrawAddress('sui', OWN_SUI, own)).toEqual({
      ok: false,
      error: expect.stringMatching(/your own RacerBot SUI/i),
    });
  });

  it('validates Starknet addresses and rejects 40-hex EVM addresses or own Starknet address', () => {
    expect(validateWithdrawAddress('starknet', VALID_STARKNET, own)).toEqual({
      ok: true,
      address: VALID_STARKNET,
    });
    expect(validateWithdrawAddress('starknet_eth', VALID_STARKNET, own)).toEqual({
      ok: true,
      address: VALID_STARKNET,
    });
    expect(validateWithdrawAddress('starknet', HARDHAT_ADDR, own)).toEqual({
      ok: false,
      error: expect.stringMatching(/40-character EVM address/i),
    });
    expect(validateWithdrawAddress('starknet', OWN_STARKNET, own)).toEqual({
      ok: false,
      error: expect.stringMatching(/your own RacerBot Starknet/i),
    });
  });

  it('validates EVM addresses across Base, Arbitrum, Ethereum, Zero, HyperEVM, Elysium', () => {
    for (const chain of ['base', 'arbitrum', 'ethereum', 'zero', 'hyperevm', 'elysium'] as const) {
      expect(validateWithdrawAddress(chain, HARDHAT_ADDR.toLowerCase(), own)).toEqual({
        ok: true,
        address: HARDHAT_ADDR,
      });
      expect(validateWithdrawAddress(chain, OWN_EVM, own)).toEqual({
        ok: false,
        error: expect.stringMatching(/your own/i),
      });
      expect(validateWithdrawAddress(chain, VALID_SUI, own)).toEqual({
        ok: false,
        error: expect.stringMatching(/Starknet or Sui/i),
      });
    }
  });
});

describe('withdrawFlow — parseWithdrawAmount', () => {
  it('parses positive numbers and explicit all/max', () => {
    expect(parseWithdrawAmount('1.5')).toEqual({ ok: true, amount: 1.5 });
    expect(parseWithdrawAmount('0.0025')).toEqual({ ok: true, amount: 0.0025 });
    expect(parseWithdrawAmount('all')).toEqual({ ok: true, amount: 'all' });
    expect(parseWithdrawAmount('MAX')).toEqual({ ok: true, amount: 'all' });
    expect(parseWithdrawAmount('100%')).toEqual({ ok: true, amount: 'all' });
  });

  it('rejects empty, zero, negative, non-numeric, or multi-word inputs', () => {
    expect(parseWithdrawAmount('')).toEqual({
      ok: false,
      error: expect.stringMatching(/enter the amount/i),
    });
    expect(parseWithdrawAmount('0')).toEqual({
      ok: false,
      error: expect.stringMatching(/greater than 0/i),
    });
    expect(parseWithdrawAmount('-5')).toEqual({
      ok: false,
      error: expect.stringMatching(/Invalid amount/i),
    });
    expect(parseWithdrawAmount('alice.near 10')).toEqual({
      ok: false,
      error: expect.stringMatching(/single number/i),
    });
    expect(parseWithdrawAmount('abc')).toEqual({
      ok: false,
      error: expect.stringMatching(/Invalid amount/i),
    });
  });
});

describe('withdrawFlow — resolvePositionWithdrawChain & chain metadata', () => {
  it('resolves position chain accurately', () => {
    expect(resolvePositionWithdrawChain('solana', VALID_SOL)).toBe('solana');
    expect(resolvePositionWithdrawChain('sui', '0x2::sui::SUI')).toBe('sui');
    expect(resolvePositionWithdrawChain('starknet', VALID_STARKNET)).toBe('starknet');
    expect(resolvePositionWithdrawChain('base', HARDHAT_ADDR)).toBe('base');
    expect(resolvePositionWithdrawChain('hyperevm', HARDHAT_ADDR)).toBe('hyperevm');
    expect(resolvePositionWithdrawChain('elysium', HARDHAT_ADDR)).toBe('elysium');
    expect(resolvePositionWithdrawChain(null, 'lonk.tkn.near')).toBe('near');
  });

  it('recognizes all defined WithdrawChainIds', () => {
    for (const key of Object.keys(WITHDRAW_CHAIN_META)) {
      expect(isWithdrawChainId(key)).toBe(true);
    }
    expect(isWithdrawChainId('unknown_chain')).toBe(false);
  });
});
