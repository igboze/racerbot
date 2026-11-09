import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isNearTokenAddress } from './nearOnly.js';

const quotePublicSwap = vi.fn();
const notifyDeposit = vi.fn();
vi.mock('./intentsPrivate.js', () => ({
  quotePublicSwap: (...a: any[]) => quotePublicSwap(...a),
  notifyDeposit: (...a: any[]) => notifyDeposit(...a),
}));

vi.mock('./multichainDeposit.js', () => ({
  SUPPORTED_CHAINS: {
    sol: { id: 'sol', name: 'Solana', icon: 'S', nativeSymbol: 'SOL' },
    base: { id: 'base', name: 'Base', icon: 'B', nativeSymbol: 'ETH' },
  },
  getTokensForChain: (chain: string) => ({
    sol: [
      { symbol: 'SOL', assetId: 'nep141:sol.omft.near', decimals: 9 },
      { symbol: 'WIF', assetId: 'nep141:sol-wif.omft.near', decimals: 6 },
    ],
    base: [
      { symbol: 'KAITO', assetId: 'nep141:base-kaito.omft.near', decimals: 18 },
      { symbol: 'USDC', assetId: 'nep141:base-usdc.omft.near', decimals: 6 },
      { symbol: 'ETH', assetId: 'nep141:base.omft.near', decimals: 18 },
    ],
  } as any)[chain] || [],
}));

const calls: string[] = [];
const withdrawPrivate = vi.fn();
const assertWalletCovers = vi.fn();
const payDepositAddressFromWallet = vi.fn();
let external = false;
vi.mock('./executorPool.js', () => ({
  withdrawPrivate: (...a: any[]) => withdrawPrivate(...a),
  assertWalletCovers: (...a: any[]) => { calls.push('check'); return assertWalletCovers(...a); },
  payDepositAddressFromWallet: (...a: any[]) => { calls.push('pay'); return payDepositAddressFromWallet(...a); },
  isExternalWallet: () => external,
}));

const { listWithdrawDestinations, isValidWithdrawAddress, quoteWithdrawToChain, withdrawToChain } = await import('./crossChainWithdraw.js');

const NEAR = 10n ** 24n;
const user = { id: 'u1', subaccount_id: 'a'.repeat(64) } as any;
const EVM = '0x65e4d3FECa39b2B11Db522adF6530bcccF9D77DC';
const SOL = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';

describe('NEAR-only tokens for webapp Fleet and Swarm', () => {
  it('accepts NEAR token contracts', () => {
    expect(isNearTokenAddress('blackdragon.tkn.near')).toBe(true);
    expect(isNearTokenAddress('wrap.near')).toBe(true);
    expect(isNearTokenAddress('17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1')).toBe(true);
  });
  it('rejects EVM and Solana addresses, even though 0x… passes NEAR account rules', () => {
    expect(isNearTokenAddress(EVM)).toBe(false);
    expect(isNearTokenAddress(EVM.toLowerCase())).toBe(false);
    expect(isNearTokenAddress(SOL)).toBe(false);
    expect(isNearTokenAddress('')).toBe(false);
  });
});

describe('withdraw to another chain', () => {
  beforeEach(() => {
    calls.length = 0;
    external = false;
    [quotePublicSwap, notifyDeposit, withdrawPrivate, assertWalletCovers, payDepositAddressFromWallet].forEach(f => f.mockReset());
  });

  it('offers each chain its native coin and stablecoins only, native first', () => {
    const d = listWithdrawDestinations();
    expect(d.find(x => x.chain === 'base')?.tokens.map(t => t.symbol)).toEqual(['ETH', 'USDC']);
    expect(d.find(x => x.chain === 'sol')?.tokens.map(t => t.symbol)).toEqual(['SOL']);
  });

  it('checks the address against the chain', () => {
    expect(isValidWithdrawAddress('base', EVM)).toBe(true);
    expect(isValidWithdrawAddress('base', SOL)).toBe(false);
    expect(isValidWithdrawAddress('sol', SOL)).toBe(true);
    expect(isValidWithdrawAddress('sol', EVM)).toBe(false);
    expect(isValidWithdrawAddress('btc', 'bc1qxyz')).toBe(false);
  });

  it('refuses a wrong address or a tiny amount before quoting', async () => {
    await expect(quoteWithdrawToChain(user, { amountYocto: NEAR, chain: 'base', symbol: 'USDC', address: SOL })).rejects.toThrow(/EVM address/);
    await expect(quoteWithdrawToChain(user, { amountYocto: NEAR / 100n, chain: 'base', symbol: 'USDC', address: EVM })).rejects.toThrow(/minimum/);
    await expect(quoteWithdrawToChain(user, { amountYocto: NEAR, chain: 'base', symbol: 'KAITO', address: EVM })).rejects.toThrow(/cannot be sent/);
    expect(quotePublicSwap).not.toHaveBeenCalled();
  });

  it('prices a withdrawal from wNEAR to the chosen asset, without reserving anything', async () => {
    quotePublicSwap.mockResolvedValue({ depositAddress: '', amountOut: '4080000', minAmountOut: '4040000', timeEstimate: 90 });
    const q = await quoteWithdrawToChain(user, { amountYocto: NEAR, chain: 'base', symbol: 'usdc', address: EVM });
    expect(quotePublicSwap).toHaveBeenCalledWith(expect.objectContaining({
      dry: true, originAsset: 'nep141:wrap.near', destinationAsset: 'nep141:base-usdc.omft.near', recipient: EVM, refundTo: user.subaccount_id,
    }));
    expect(q).toMatchObject({ receive: '4.08', minReceive: '4.04', symbol: 'USDC', timeEstimateSec: 90 });
  });

  it('from the private balance: unshields straight to the chain asset', async () => {
    withdrawPrivate.mockResolvedValue({ depositAddress: 'dep1', intentHash: 'ih', amountOut: '500000000' });
    const r = await withdrawToChain(user, 'private', { amountYocto: NEAR, chain: 'sol', symbol: 'SOL', address: SOL });
    expect(withdrawPrivate).toHaveBeenCalledWith(user, NEAR, SOL, 'nep141:sol.omft.near');
    expect(r).toMatchObject({ depositAddress: 'dep1', receive: '0.5', symbol: 'SOL' });
    expect(payDepositAddressFromWallet).not.toHaveBeenCalled();
  });

  it('from the RacerBot wallet: checks the balance, quotes, then pays the deposit address', async () => {
    quotePublicSwap.mockImplementation(async () => { calls.push('quote'); return { depositAddress: 'dep2', amountOut: '4080000' }; });
    payDepositAddressFromWallet.mockResolvedValue('tx1');
    const r = await withdrawToChain(user, 'wallet', { amountYocto: NEAR, chain: 'base', symbol: 'USDC', address: EVM });
    expect(calls).toEqual(['check', 'quote', 'pay']);
    expect(quotePublicSwap.mock.calls[0][0]).not.toHaveProperty('dry');
    expect(payDepositAddressFromWallet).toHaveBeenCalledWith(user, NEAR, 'dep2', 'Withdrawal');
    expect(notifyDeposit).toHaveBeenCalledWith('dep2', 'tx1');
    expect(r).toMatchObject({ depositAddress: 'dep2', txHash: 'tx1', receive: '4.08' });
  });

  it('never quotes or pays when the wallet balance is short', async () => {
    assertWalletCovers.mockRejectedValue(new Error('Your RacerBot wallet has 0.5 NEAR'));
    await expect(withdrawToChain(user, 'wallet', { amountYocto: NEAR, chain: 'base', symbol: 'USDC', address: EVM })).rejects.toThrow(/0.5 NEAR/);
    expect(quotePublicSwap).not.toHaveBeenCalled();
    expect(payDepositAddressFromWallet).not.toHaveBeenCalled();
  });

  it('a wallet RacerBot holds no key for cannot send from the RacerBot wallet', async () => {
    external = true;
    await expect(withdrawToChain(user, 'wallet', { amountYocto: NEAR, chain: 'base', symbol: 'USDC', address: EVM })).rejects.toThrow(/no key/);
  });
});
