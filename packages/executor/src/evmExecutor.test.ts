import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ethers } from 'ethers';

// Never reach a real database: dotenv does not override a variable that is already set
process.env.DATABASE_URL = 'postgres://evm-exec-test@127.0.0.1:1/none';
process.env.KEY_ENCRYPTION_MASTER_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const USER = '0x00000000000000000000000000000000000000A1';
const TOKEN = '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed';
const HYPERSWAP = '0xb4a9C4e6Ea8E2191d2FA5B380452a634Fb21240A';
const BASE_ROUTER = '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24';
const WNATIVE = '0x4200000000000000000000000000000000000006';

const quoteIface = new ethers.Interface(['function getAmountsOut(uint256,address[]) view returns (uint256[])']);
const sent: { to: string; data: string; value?: bigint }[] = [];
let routerFor: Record<string, string> = {};

const provider = {
  getBalance: vi.fn(async () => ethers.parseEther('1')),
};
const signer = {
  provider,
  call: vi.fn(async (tx: any) => {
    const parsed = quoteIface.parseTransaction({ data: tx.data })!;
    return quoteIface.encodeFunctionResult('getAmountsOut', [[parsed.args[0], 1_000_000n]]);
  }),
  sendTransaction: vi.fn(async (tx: any) => {
    sent.push({ to: tx.to, data: tx.data, value: tx.value });
    return { hash: '0x' + '11'.repeat(32), wait: async () => ({ status: 1, hash: '0x' + '11'.repeat(32), gasUsed: 1n, gasPrice: 1n }) };
  }),
};

vi.mock('@racerbot/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@racerbot/shared')>();
  return {
    ...actual,
    getEvmProvider: () => provider,
    getEvmSigner: () => signer,
    resolveV2Router: vi.fn(async (chain: string) => ({ address: routerFor[chain], weth: WNATIVE })),
    simulateEvmTrade: vi.fn(async () => ({ isSafe: true })),
    getErc20TokenInfo: vi.fn(async () => ({ symbol: 'TKN', name: 'Token', decimals: 18 })),
    getErc20Balance: vi.fn(async () => ({ raw: 0n, formatted: '0', human: 0 })),
  };
});

vi.mock('@racerbot/db', () => ({
  getUserById: vi.fn(async () => ({ id: 'u1', evm_address: USER, evm_private_key_enc: 'enc' })),
  getActiveWallet: vi.fn(async () => null),
  getOpenPositions: vi.fn(async () => []),
  createPosition: vi.fn(async () => ({ id: 'pos-1' })),
  createFill: vi.fn(async () => ({ fillId: 'f1', inserted: true })),
  recordFee: vi.fn(async () => {}),
}));

const { executeEvmSwap } = await import('./evmExecutor.js');
const { HYPERSWAP_V2_ROUTER_ABI, UNISWAP_V2_ROUTER_ABI } = await import('@racerbot/shared');

const buy = (chain: string) => ({
  type: 'execute_swap' as const, user_id: 'u1', chain: chain as any, venue: `${chain}_dex` as any,
  token_in: 'native', token_out: TOKEN, amount_in: '0.01', min_amount_out: '0', slippage_pct: 5, timestamp: Date.now(),
});

beforeEach(() => {
  sent.length = 0;
  routerFor = { hyperevm: HYPERSWAP, base: BASE_ROUTER, ethereum: BASE_ROUTER };
});

describe('EVM swaps', () => {
  it('buys on HyperSwap with its referrer argument (the standard call does not exist there)', async () => {
    await executeEvmSwap(buy('hyperevm')).catch(() => {});
    const swap = sent.find((t) => t.to === HYPERSWAP)!;
    expect(swap).toBeDefined();
    const parsed = new ethers.Interface(HYPERSWAP_V2_ROUTER_ABI).parseTransaction({ data: swap.data })!;
    expect(parsed.name).toBe('swapExactETHForTokensSupportingFeeOnTransferTokens');
    expect(parsed.args.length).toBe(5);
    expect(parsed.args[2]).toBe(USER);
    expect(parsed.args[3]).toBe(ethers.ZeroAddress); // referrer
  });

  it('keeps the standard Uniswap V2 call on Base', async () => {
    await executeEvmSwap(buy('base')).catch(() => {});
    const swap = sent.find((t) => t.to === BASE_ROUTER)!;
    expect(swap).toBeDefined();
    const parsed = new ethers.Interface(UNISWAP_V2_ROUTER_ABI).parseTransaction({ data: swap.data })!;
    expect(parsed.name).toBe('swapExactETHForTokensSupportingFeeOnTransferTokens');
    expect(parsed.args.length).toBe(4);
  });

  it('refuses Zero before touching the wallet while Zero is off', async () => {
    await expect(executeEvmSwap(buy('zero'))).rejects.toThrow(/not live yet.*Nothing was spent/);
    expect(sent).toHaveLength(0);
  });
});
