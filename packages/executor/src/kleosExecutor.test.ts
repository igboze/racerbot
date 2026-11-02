import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { ethers } from 'ethers';

process.env.KEY_ENCRYPTION_MASTER_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const wallet = ethers.Wallet.createRandom();
const USER = wallet.address;
const COIN = '0x5e5Df82d563FCF36b6f853c4D09f89e2d18825B4';
const TREASURY = '0xb1f9551E64e1addF18462B09f04E14DC131451b1';
const V4_ROUTER = '0xbA0b2699A9d21a2a138C494db82DFD2fFce3344c';
const INBOX = '0xce59f8b65ad41c9dae4c07a0571a39824bd92cff';
// A real Kleos retryable ticket: its HyperEVM logs and the Elysium receipt they lead to
const ticket = JSON.parse(readFileSync(new URL('../../shared/src/__fixtures__/kleosRetryableTicket.json', import.meta.url), 'utf8'));

const erc20 = new ethers.Interface([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
]);
const state = {
  l1Balance: 0n,
  l2Balances: [] as bigint[],
  tokenBalances: [] as bigint[],
  coinBalance: 0n,
  allowance: 0n,
  receipts: new Map<string, any>(),
  ethCalls: [] as any[],
  l1Sent: [] as any[],
};

const l1 = {
  getBalance: vi.fn(async () => state.l1Balance),
  getBlock: vi.fn(async () => ({ baseFeePerGas: 100_000_000n })),
};
const l2 = {
  getBalance: vi.fn(async () => state.l2Balances.shift() ?? 0n),
  getBlock: vi.fn(async () => ({ baseFeePerGas: 100_000_000n })),
  getTransactionCount: vi.fn(async () => 7),
  getTransactionReceipt: vi.fn(async (hash: string) => state.receipts.get(hash.toLowerCase()) ?? null),
  send: vi.fn(async (method: string, params: any[]) => { state.ethCalls.push({ method, params }); return '0x'; }),
  // ERC20 reads through ethers.Contract
  call: vi.fn(async (tx: any) => {
    const parsed = erc20.parseTransaction({ data: tx.data });
    const v = parsed?.name === 'balanceOf' ? state.coinBalance : state.allowance;
    return erc20.encodeFunctionResult(parsed!.name, [v]);
  }),
};
const l1Signer = {
  sendTransaction: vi.fn(async (tx: any) => {
    state.l1Sent.push(tx);
    return { wait: async () => ({ status: 1, hash: '0x' + 'ab'.repeat(32), logs: ticket.l1Logs }) };
  }),
};

vi.mock('@racerbot/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@racerbot/shared')>();
  return {
    ...actual,
    getEvmProvider: (chain: string) => (chain === 'hyperevm' ? l1 : l2),
    getEvmWalletFromEncrypted: (_enc: string, _key: string, provider: unknown) => (provider === l1 ? l1Signer : wallet),
    getErc20TokenInfo: vi.fn(async () => ({ symbol: 'AGORA', name: 'Agora', decimals: 18 })),
    getErc20Balance: vi.fn(async () => {
      const raw = state.tokenBalances.shift() ?? 0n;
      return { raw, formatted: ethers.formatEther(raw), human: Number(ethers.formatEther(raw)) };
    }),
    resolveKleosRoute: vi.fn(async () => ({ kind: 'v4', router: V4_ROUTER, hopFee: 0 })),
    quoteKleos: vi.fn(async (_p: unknown, _r: unknown, _t: string, side: string) => (side === 'buy' ? ethers.parseEther('1000') : ethers.parseEther('0.05'))),
  };
});

vi.mock('@racerbot/db', () => ({
  getUserById: vi.fn(async () => ({ id: 'u1', evm_address: USER, evm_private_key_enc: 'enc' })),
  getActiveWallet: vi.fn(async () => null),
  getOpenPositions: vi.fn(async () => [{ id: 'pos-1', token_address: COIN, chain: 'elysium' }]),
  createPosition: vi.fn(async () => ({ id: 'pos-1' })),
  createFill: vi.fn(async () => ({ fillId: 'f1', inserted: true })),
  recordFee: vi.fn(async () => {}),
}));

const { executeKleosSwap, chooseKleosBuyFunding, KLEOS_SELL_GAS_TOPUP } = await import('./kleosExecutor.js');
const { applyL1ToL2Alias, ELYSIUM_INBOX_ABI, MULTICALL3_VALUE_ABI, KLEOS_V4_ROUTER_ABI } = await import('@racerbot/shared');
const db = await import('@racerbot/db');

const inboxIface = new ethers.Interface(ELYSIUM_INBOX_ABI);
const mc = new ethers.Interface(MULTICALL3_VALUE_ABI);
const v4 = new ethers.Interface(KLEOS_V4_ROUTER_ABI);
const event = (side: 'buy' | 'sell', amount: string) => ({
  type: 'execute_swap' as const, user_id: 'u1', chain: 'elysium' as const, venue: 'kleos' as const,
  token_in: side === 'buy' ? 'HYPE' : COIN, token_out: side === 'buy' ? COIN : 'HYPE',
  amount_in: amount, min_amount_out: '1', slippage_pct: 2, timestamp: Date.now(),
});

beforeEach(() => {
  Object.assign(state, { l1Balance: 0n, l2Balances: [], tokenBalances: [], coinBalance: 0n, allowance: 0n, receipts: new Map(), ethCalls: [], l1Sent: [] });
  vi.mocked(db.createFill).mockClear();
});

describe('chooseKleosBuyFunding', () => {
  const base = { gross: 100n, elysiumGasCost: 10n, ticketDeposit: 150n };
  it('prefers Elysium HYPE, falls back to a HyperEVM ticket, and refuses when neither covers it', () => {
    const reserve = ethers.parseEther('0.0002');
    expect(chooseKleosBuyFunding({ ...base, elysiumBalance: 110n, hyperevmBalance: reserve })).toBe('elysium');
    expect(chooseKleosBuyFunding({ ...base, elysiumBalance: 109n, hyperevmBalance: reserve + 150n })).toBe('hyperevm');
    expect(chooseKleosBuyFunding({ ...base, elysiumBalance: 0n, hyperevmBalance: reserve + 149n })).toBeNull();
  });
});

describe('executeKleosSwap', () => {
  it('buys with HyperEVM HYPE through one retryable ticket carrying the fee, a gas top-up and the swap', async () => {
    state.l1Balance = ethers.parseEther('1');
    state.l2Balances = [0n];
    state.tokenBalances = [0n, ethers.parseEther('980')];
    state.receipts.set(ticket.ticketId.toLowerCase(), { status: 1, logs: ticket.l2Logs });
    state.receipts.set(ticket.redeem.toLowerCase(), { status: 1, hash: ticket.redeem, logs: [] });

    const res = await executeKleosSwap(event('buy', '0.01') as any, TREASURY);
    expect(res).toMatchObject({ success: true, txHash: ticket.redeem, tokenQty: '980.0' });

    expect(state.l1Sent).toHaveLength(1);
    const sent = state.l1Sent[0];
    expect(sent.to).toBe(INBOX);
    const [to, l2CallValue, maxSubmissionCost, excessRefund, valueRefund, gasLimit, maxFeePerGas, data] =
      inboxIface.decodeFunctionData('createRetryableTicket', sent.data).toArray();
    expect([to, excessRefund, valueRefund]).toEqual(['0xcA11bde05977b3631167028862bE2a173976CA11', USER, USER]);
    expect(l2CallValue).toBe(ethers.parseEther('0.01') + KLEOS_SELL_GAS_TOPUP);
    expect(sent.value).toBe(maxSubmissionCost + l2CallValue + gasLimit * maxFeePerGas);

    const [legs] = mc.decodeFunctionData('aggregate3Value', data);
    expect(legs.map((l: any) => [l.target, l.allowFailure, l.value])).toEqual([
      [TREASURY, false, ethers.parseEther('0.00015')],
      [USER, false, KLEOS_SELL_GAS_TOPUP],
      [V4_ROUTER, false, ethers.parseEther('0.00985')],
    ]);
    const [, minOut, recipient] = v4.decodeFunctionData('buy', legs[2].callData).toArray();
    expect(recipient).toBe(USER);
    expect(minOut).toBe(ethers.parseEther('980')); // 1000 quoted, 2% slippage

    // Simulated first as the aliased sender the ticket runs as
    expect(state.ethCalls[0].params[0].from).toBe(applyL1ToL2Alias(USER));
    expect(db.createFill).toHaveBeenCalledWith(expect.objectContaining({ side: 'buy', venue: 'kleos', fee_paid: '0.00015' }));
  });

  it('sends nothing when the simulation reverts', async () => {
    state.l1Balance = ethers.parseEther('1');
    state.l2Balances = [0n];
    const revert = v4.encodeErrorResult('TooLittleReceived', []);
    l2.send.mockImplementationOnce(async () => { throw Object.assign(new Error('execution reverted'), { data: revert }); });
    const res = await executeKleosSwap(event('buy', '0.01') as any, TREASURY);
    expect(res.success).toBe(false);
    expect(res.reason).toMatch(/slippage limit.*Nothing was spent/);
    expect(state.l1Sent).toHaveLength(0);
  });

  it('refuses a buy neither chain can pay for', async () => {
    state.l1Balance = ethers.parseEther('0.005');
    state.l2Balances = [0n];
    const res = await executeKleosSwap(event('buy', '0.01') as any, TREASURY);
    expect(res).toMatchObject({ success: false });
    expect(res.reason).toMatch(/Insufficient HYPE/);
    expect(state.l1Sent).toHaveLength(0);
  });

  it('sells by posting the signed approve and sell into the inbox in one batch', async () => {
    state.l1Balance = ethers.parseEther('0.01');
    state.coinBalance = ethers.parseEther('500');
    state.allowance = 0n;
    state.l2Balances = [ethers.parseEther('0.001'), ethers.parseEther('0.0507')];
    const gasPrice = 300_000_000n;
    const respond = (raw: string, gasUsed: bigint) =>
      state.receipts.set(ethers.keccak256(raw).toLowerCase(), { status: 1, hash: ethers.keccak256(raw), gasUsed, gasPrice });
    l1Signer.sendTransaction.mockImplementationOnce(async (tx: any) => {
      state.l1Sent.push(tx);
      const [message] = inboxIface.decodeFunctionData('sendL2Message', tx.data).toArray();
      // 0x03 | len(8) | 0x04 raw | len(8) | 0x04 raw
      const bytes = ethers.getBytes(message);
      expect(bytes[0]).toBe(3);
      let at = 1;
      for (const gasUsed of [50_000n, 200_000n]) {
        const len = Number(ethers.toBigInt(bytes.slice(at, at + 8)));
        respond(ethers.hexlify(bytes.slice(at + 9, at + 8 + len)), gasUsed);
        at += 8 + len;
      }
      return { wait: async () => ({ status: 1, hash: '0x' + 'cd'.repeat(32), logs: [] }) };
    });

    const res = await executeKleosSwap(event('sell', '500') as any, TREASURY);
    expect(res).toMatchObject({ success: true });
    // 0.0507 - 0.001 + 250k gas at 0.3 gwei = 0.049775 HYPE
    expect(res.hypeSpentOrReceived).toBeCloseTo(0.049775, 9);

    const [message] = inboxIface.decodeFunctionData('sendL2Message', state.l1Sent[0].data).toArray();
    const bytes = ethers.getBytes(message);
    const firstLen = Number(ethers.toBigInt(bytes.slice(1, 9)));
    const approve = ethers.Transaction.from(ethers.hexlify(bytes.slice(10, 9 + firstLen)));
    const sell = ethers.Transaction.from(ethers.hexlify(bytes.slice(9 + firstLen + 9)));
    expect([approve.chainId, approve.nonce, approve.to, approve.from]).toEqual([99901n, 7, COIN, USER]);
    expect([sell.nonce, sell.to, sell.from]).toEqual([8, V4_ROUTER, USER]);
    const [, amountIn, minOut, recipient] = v4.decodeFunctionData('sell', sell.data).toArray();
    expect([amountIn, minOut, recipient]).toEqual([ethers.parseEther('500'), ethers.parseEther('0.049'), USER]);
    expect(db.createFill).toHaveBeenCalledWith(expect.objectContaining({ side: 'sell', venue: 'kleos', fee_paid: '0' }));
  });

  it('asks for Elysium gas before selling when the wallet has none', async () => {
    state.l1Balance = ethers.parseEther('0.01');
    state.coinBalance = ethers.parseEther('500');
    state.l2Balances = [0n];
    const res = await executeKleosSwap(event('sell', '500') as any, TREASURY);
    expect(res.success).toBe(false);
    expect(res.reason).toMatch(/HYPE on Elysium for gas/);
    expect(state.l1Sent).toHaveLength(0);
  });
});
