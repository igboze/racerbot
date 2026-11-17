import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { Keypair, PublicKey, SystemProgram, TransactionMessage, ComputeBudgetProgram, TransactionInstruction } from '@solana/web3.js';
import { HYPERSWAP_V2_ROUTER, DEFAULT_EVM_TREASURY_ADDRESS, DEFAULT_SOLANA_DEV_FEE_WALLET } from '@racerbot/shared';
import { evaluateEvmTx, evaluateSolanaMessage, blocks } from './signPolicy.js';

const USER = '0x00000000000000000000000000000000000000a1';
const STRANGER = '0x00000000000000000000000000000000000000ee';
const TOKEN = '0x00000000000000000000000000000000000000cc';
const own = new Set([USER]);
const erc20 = new ethers.Interface([
  'function transfer(address,uint256)',
  'function approve(address,uint256)',
]);
const evmTx = (fields: ethers.TransactionLike) => ethers.Transaction.from({ chainId: 999, nonce: 0, gasLimit: 100000, type: 2, ...fields });

describe('EVM trade rules', () => {
  it('lets a swap through an allowlisted router pass', () => {
    const f = evaluateEvmTx(evmTx({ to: HYPERSWAP_V2_ROUTER, data: '0x7ff36ab5' + '00'.repeat(64), value: 10n ** 17n }), own);
    expect(f).toEqual({ hard: [], soft: [] });
  });

  it('allows the platform fee to the treasury and transfers to the user\'s own wallets', () => {
    expect(evaluateEvmTx(evmTx({ to: DEFAULT_EVM_TREASURY_ADDRESS, value: 10n ** 15n }), own).hard).toEqual([]);
    expect(evaluateEvmTx(evmTx({ to: USER, value: 10n ** 15n }), own).hard).toEqual([]);
  });

  it('flags HYPE sent to a stranger as theft-shaped', () => {
    const f = evaluateEvmTx(evmTx({ to: STRANGER, value: 10n ** 18n }), own);
    expect(f.hard[0]).toMatch(/sends 1.0 HYPE/);
    expect(blocks(f, 'enforce_hard')).toBe(true);
    expect(blocks(f, 'monitor')).toBe(false);
  });

  it('flags token transfers and approvals to strangers, allows approvals to routers', () => {
    expect(evaluateEvmTx(evmTx({ to: TOKEN, data: erc20.encodeFunctionData('transfer', [STRANGER, 5n]) }), own).hard).toHaveLength(1);
    expect(evaluateEvmTx(evmTx({ to: TOKEN, data: erc20.encodeFunctionData('approve', [STRANGER, ethers.MaxUint256]) }), own).hard).toHaveLength(1);
    expect(evaluateEvmTx(evmTx({ to: TOKEN, data: erc20.encodeFunctionData('approve', [HYPERSWAP_V2_ROUTER, ethers.MaxUint256]) }), own)).toEqual({ hard: [], soft: [] });
    expect(evaluateEvmTx(evmTx({ to: TOKEN, data: erc20.encodeFunctionData('approve', [STRANGER, 0n]) }), own).hard).toEqual([]);
  });

  it('marks unknown contracts soft (blocked only in full enforce) and deployments hard', () => {
    const f = evaluateEvmTx(evmTx({ to: STRANGER, data: '0xdeadbeef' }), own);
    expect(f.hard).toEqual([]);
    expect(f.soft).toHaveLength(1);
    expect(blocks(f, 'enforce_hard')).toBe(false);
    expect(blocks(f, 'enforce')).toBe(true);
    expect(evaluateEvmTx(evmTx({ to: null, data: '0x6000' }), own).hard).toEqual(['contract deployment']);
  });
});

describe('Solana trade rules', () => {
  const user = Keypair.generate();
  const stranger = Keypair.generate().publicKey;
  const ownSol = new Set([user.publicKey.toBase58()]);
  const message = (instructions: TransactionInstruction[]) => new TransactionMessage({
    payerKey: user.publicKey, recentBlockhash: '11111111111111111111111111111111', instructions,
  }).compileToV0Message();

  it('allows compute budget instructions and the platform fee', () => {
    const f = evaluateSolanaMessage(message([
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      SystemProgram.transfer({ fromPubkey: user.publicKey, toPubkey: new PublicKey(DEFAULT_SOLANA_DEV_FEE_WALLET), lamports: 1000n }),
    ]), ownSol);
    expect(f).toEqual({ hard: [], soft: [] });
  });

  it('flags SOL sent to a stranger', () => {
    const f = evaluateSolanaMessage(message([
      SystemProgram.transfer({ fromPubkey: user.publicKey, toPubkey: stranger, lamports: 5_000_000_000n }),
    ]), ownSol);
    expect(f.hard[0]).toMatch(/sends 5 SOL/);
  });

  it('flags reassigning an account and unknown programs', () => {
    expect(evaluateSolanaMessage(message([SystemProgram.assign({ accountPubkey: user.publicKey, programId: stranger })]), ownSol).hard).toHaveLength(1);
    const unknown = new TransactionInstruction({ programId: stranger, keys: [], data: Buffer.from([1]) });
    expect(evaluateSolanaMessage(message([unknown]), ownSol).soft[0]).toMatch(/not on the allowlist/);
  });
});

describe('NEAR trade rules', () => {
  const own = new Set(['alice.near', 'alice-fleet-1.racerbot.near']);
  const fc = (methodName: string, args: object, deposit = 1n) => ({ functionCall: { methodName, args: Buffer.from(JSON.stringify(args)), gas: 30n, deposit } });
  const tx = (receiverId: string, actions: any[]) => ({ signerId: 'alice.near', receiverId, actions });

  it('lets swaps through known exchanges and routine token calls pass', async () => {
    const { evaluateNearTx } = await import('./signPolicy.js');
    expect(evaluateNearTx(tx('wrap.near', [fc('near_deposit', {}), fc('ft_transfer_call', { receiver_id: 'v2.ref-finance.near', amount: '1', msg: '' })]), own)).toEqual({ hard: [], soft: [] });
    expect(evaluateNearTx(tx('token.v2.ref-finance.near', [fc('storage_deposit', { account_id: 'alice.near' })]), own)).toEqual({ hard: [], soft: [] });
    expect(evaluateNearTx(tx('jambo-1679.meme-cooking.near', [fc('buy', {})]), own)).toEqual({ hard: [], soft: [] });
  });

  it('allows funding the user\'s own fleet wallets and paying RacerBot', async () => {
    const { evaluateNearTx } = await import('./signPolicy.js');
    expect(evaluateNearTx(tx('alice-fleet-1.racerbot.near', [{ transfer: { deposit: 10n ** 24n } }]), own).hard).toEqual([]);
    expect(evaluateNearTx(tx('racerbottreasury.near', [{ transfer: { deposit: 10n ** 22n } }]), own).hard).toEqual([]);
  });

  it('flags NEAR and tokens sent to strangers, keys and contract changes', async () => {
    const { evaluateNearTx } = await import('./signPolicy.js');
    expect(evaluateNearTx(tx('thief.near', [{ transfer: { deposit: 5n * 10n ** 24n } }]), own).hard[0]).toMatch(/sends 5 NEAR to thief.near/);
    expect(evaluateNearTx(tx('wrap.near', [fc('ft_transfer', { receiver_id: 'thief.near', amount: '1' })]), own).hard).toHaveLength(1);
    expect(evaluateNearTx(tx('intents.near', [fc('ft_withdraw', { receiver_id: 'thief.near', token: 'wrap.near', amount: '1' })]), own).hard).toHaveLength(1);
    expect(evaluateNearTx(tx('alice.near', [{ addKey: {} }]), own).hard).toEqual(['adds an access key to the account']);
    expect(evaluateNearTx(tx('alice.near', [{ deployContract: {} }]), own).hard).toEqual(['deploys a contract']);
    expect(evaluateNearTx(tx('alice.near', [{ deleteAccount: { beneficiaryId: 'thief.near' } }]), own).hard).toHaveLength(1);
    expect(evaluateNearTx(tx('alice.near', [{ deleteAccount: { beneficiaryId: 'alice-fleet-1.racerbot.near' } }]), own).hard).toEqual([]);
  });

  it('marks calls into unknown contracts soft', async () => {
    const { evaluateNearTx } = await import('./signPolicy.js');
    const f = evaluateNearTx(tx('wrap.near', [fc('ft_transfer_call', { receiver_id: 'unknown-dex.near', amount: '1', msg: '' })]), own);
    expect(f.hard).toEqual([]);
    expect(f.soft).toHaveLength(1);
  });
});
