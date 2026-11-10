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
  /** Signed transactions sent straight to Elysium */
  l2Sent: [] as ethers.Transaction[],
  /** What Elysium answers to each direct transaction: a receipt (gasUsed, status) or a refusal */
  l2Answers: [] as ({ gasUsed: bigint; status?: number } | { refuse: string })[],
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
  estimateGas: vi.fn(async () => 200_000n),
  send: vi.fn(async (method: string, params: any[]) => {
    if (method === 'eth_sendRawTransaction') {
      const answer = state.l2Answers.shift() ?? { gasUsed: 150_000n };
      if ('refuse' in answer) throw Object.assign(new Error('could not coalesce error'), { info: { error: { message: answer.refuse } } });
      const tx = ethers.Transaction.from(params[0]);
      state.l2Sent.push(tx);
      state.receipts.set(tx.hash!.toLowerCase(), { status: answer.status ?? 1, hash: tx.hash, gasUsed: answer.gasUsed, gasPrice: 100_000_000n, logs: [] });
      return tx.hash;
    }
    state.ethCalls.push({ method, params });
    return '0x';
  }),
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
    ascendSellApprovals: vi.fn(async () => []),
    montraSellApprovals: vi.fn(async () => []),
    simulateV4RoundTrip: vi.fn(async () => 'ok'),
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
const erc20Approve = new ethers.Interface(['function approve(address spender, uint256 amount) returns (bool)']);
const event = (side: 'buy' | 'sell', amount: string) => ({
  type: 'execute_swap' as const, user_id: 'u1', chain: 'elysium' as const, venue: 'kleos' as const,
  token_in: side === 'buy' ? 'HYPE' : COIN, token_out: side === 'buy' ? COIN : 'HYPE',
  amount_in: amount, min_amount_out: '1', slippage_pct: 2, timestamp: Date.now(),
});

beforeEach(() => {
  Object.assign(state, { l1Balance: 0n, l2Balances: [], tokenBalances: [], coinBalance: 0n, allowance: 0n, receipts: new Map(), ethCalls: [], l1Sent: [], l2Sent: [], l2Answers: [] });
  vi.mocked(db.createFill).mockClear();
  delete process.env.ELYSIUM_SEND_MODE;
});

describe('chooseKleosBuyFunding', () => {
  const base = { gross: 100n, elysiumGasCost: 10n, ticketDeposit: 150n };
  it('prefers Elysium HYPE, falls back to a HyperEVM ticket, and refuses when neither covers it', () => {
    const reserve = ethers.parseEther('0.0002');
    expect(chooseKleosBuyFunding({ ...base, elysiumBalance: 110n, hyperevmBalance: reserve })).toBe('elysium');
    expect(chooseKleosBuyFunding({ ...base, elysiumBalance: 109n, hyperevmBalance: reserve + 150n })).toBe('hyperevm');
    expect(chooseKleosBuyFunding({ ...base, elysiumBalance: 0n, hyperevmBalance: reserve + 149n })).toBeNull();
  });

  it('needs no HyperEVM HYPE for an Elysium-paid buy now that transactions go straight to Elysium', () => {
    expect(chooseKleosBuyFunding({ ...base, elysiumBalance: 110n, hyperevmBalance: 0n })).toBe('elysium');
    expect(chooseKleosBuyFunding({ ...base, elysiumBalance: 110n, hyperevmBalance: 0n, viaInbox: true })).toBeNull();
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
    expect(res.reason).toMatch(/Not enough HYPE.*Nothing was spent/);
    expect(state.l1Sent).toHaveLength(0);
  });

  it('sells by posting the signed approve and sell into the inbox in one batch (ELYSIUM_SEND_MODE=inbox)', async () => {
    process.env.ELYSIUM_SEND_MODE = 'inbox';
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

  it('buys with Elysium HYPE in one transaction sent straight to Elysium: fee and swap together, no HyperEVM step', async () => {
    state.l1Balance = 0n;
    state.l2Balances = [ethers.parseEther('1')];
    state.tokenBalances = [0n, ethers.parseEther('990')];
    const res = await executeKleosSwap(event('buy', '0.01') as any, TREASURY);
    expect(res).toMatchObject({ success: true, tokenQty: '990.0' });
    expect(state.l1Sent).toHaveLength(0);
    expect(state.l2Sent).toHaveLength(1);
    const tx = state.l2Sent[0];
    expect([tx.chainId, tx.from, tx.to, tx.value]).toEqual([99901n, USER, '0xcA11bde05977b3631167028862bE2a173976CA11', ethers.parseEther('0.01')]);
    expect(tx.gasLimit).toBe(260_000n); // 200k estimate + 30%
    const [legs] = mc.decodeFunctionData('aggregate3Value', tx.data);
    expect(legs.map((l: any) => [l.target, l.value])).toEqual([
      [TREASURY, ethers.parseEther('0.00015')],
      [V4_ROUTER, ethers.parseEther('0.00985')],
    ]);
    // Short deadline: a direct transaction runs within seconds, not after an inbox delay
    const [, , , deadline] = v4.decodeFunctionData('buy', legs[1].callData).toArray();
    expect(Number(deadline) - Date.now() / 1000).toBeLessThan(25 * 60);
    expect(res.explorerUrl).toContain(tx.hash);
    expect(db.createFill).toHaveBeenCalledWith(expect.objectContaining({ side: 'buy', chain: 'elysium', fee_paid: '0.00015', input_amount: '0.01' }));
  });

  it('explains in plain words when Elysium refuses the buy, and spends nothing', async () => {
    state.l2Balances = [ethers.parseEther('1')];
    state.l2Answers = [{ refuse: 'nonce too low: next nonce 8, tx nonce 7' }];
    const res = await executeKleosSwap(event('buy', '0.01') as any, TREASURY);
    expect(res.success).toBe(false);
    expect(res.reason).toMatch(/Another transaction from this wallet went through first.*Nothing was spent/);
    expect(db.createFill).not.toHaveBeenCalled();
  });

  it('sells straight on Elysium: approves first, waits for it, checks the sell, then sells', async () => {
    state.l1Balance = 0n; // no HyperEVM HYPE needed any more
    state.coinBalance = ethers.parseEther('500');
    state.allowance = 0n;
    state.l2Balances = [ethers.parseEther('0.001'), ethers.parseEther('0.0507')];
    state.l2Answers = [{ gasUsed: 50_000n }, { gasUsed: 200_000n }];
    const res = await executeKleosSwap(event('sell', '500') as any, TREASURY);
    expect(res).toMatchObject({ success: true });
    // 0.0507 - 0.001 + 250k gas at 0.1 gwei = 0.049725 HYPE
    expect(res.hypeSpentOrReceived).toBeCloseTo(0.049725, 9);
    expect(state.l1Sent).toHaveLength(0);
    const [approve, sell] = state.l2Sent;
    expect([approve.to, approve.from]).toEqual([COIN, USER]);
    expect(erc20Approve.decodeFunctionData('approve', approve.data).toArray()).toEqual([V4_ROUTER, ethers.parseEther('500')]);
    expect([sell.to, sell.from]).toEqual([V4_ROUTER, USER]);
    const [, amountIn, minOut, recipient] = v4.decodeFunctionData('sell', sell.data).toArray();
    expect([amountIn, minOut, recipient]).toEqual([ethers.parseEther('500'), ethers.parseEther('0.049'), USER]);
    // The sell was simulated after the approval landed
    expect(state.ethCalls.some(c => c.method === 'eth_call' && c.params[0].to === V4_ROUTER)).toBe(true);
    expect(db.createFill).toHaveBeenCalledWith(expect.objectContaining({ side: 'sell', venue: 'kleos', fee_paid: '0' }));
  });

  it('keeps the coins and says so when the sell reverts on Elysium', async () => {
    state.coinBalance = ethers.parseEther('500');
    state.allowance = ethers.parseEther('500');
    state.l2Balances = [ethers.parseEther('0.01')];
    state.l2Answers = [{ gasUsed: 100_000n, status: 0 }];
    const res = await executeKleosSwap(event('sell', '500') as any, TREASURY);
    expect(res.success).toBe(false);
    expect(res.reason).toMatch(/you still hold the coins/);
    expect(state.l2Sent).toHaveLength(1);
  });

  it('sells an Ascend coin: approves Permit2, lets Permit2 hand the coins to the router, then sells, all on Elysium', async () => {
    const shared = await import('@racerbot/shared');
    const UR = shared.ASCEND.universalRouter;
    const route = { quote: shared.ASCEND.whype, quoteSymbol: 'WHYPE', launchKey: shared.ascendLaunchKey(COIN, shared.ASCEND.whype) };
    vi.mocked(shared.resolveKleosRoute).mockResolvedValueOnce({ kind: 'ascend', router: UR, hopFee: 0, ascend: route } as any);
    const approveP2 = { to: COIN, data: '0x095ea7b3', value: 0n };
    const permit = { to: shared.ASCEND.permit2, data: '0x87517c45', value: 0n };
    vi.mocked(shared.ascendSellApprovals).mockResolvedValueOnce([approveP2, permit]);
    state.coinBalance = ethers.parseEther('500');
    state.l2Balances = [ethers.parseEther('0.01'), ethers.parseEther('0.06')];
    state.l2Answers = [{ gasUsed: 46_000n }, { gasUsed: 50_000n }, { gasUsed: 195_000n }];
    const res = await executeKleosSwap({ ...event('sell', '500'), venue: 'ascend' } as any, TREASURY);
    expect(res).toMatchObject({ success: true });
    expect(state.l2Sent.map(t => t.to)).toEqual([COIN, shared.ASCEND.permit2, UR]);
    expect(db.createFill).toHaveBeenCalledWith(expect.objectContaining({ side: 'sell', venue: 'ascend' }));
  });

  it('refuses to buy a coin from an unknown launchpad when a test buy-then-sell shows it cannot be sold', async () => {
    const shared = await import('@racerbot/shared');
    const route = { quote: ethers.ZeroAddress, quoteSymbol: 'HYPE', launchKey: { currency0: ethers.ZeroAddress, currency1: COIN, fee: 0x800000, tickSpacing: 200, hooks: '0x6b1216A40B65c83e9c9e18a562C446697B8cf8EC' } };
    vi.mocked(shared.resolveKleosRoute).mockResolvedValueOnce({ kind: 'univ4', router: shared.ASCEND.universalRouter, hopFee: 0, ascend: route } as any);
    vi.mocked(shared.simulateV4RoundTrip).mockResolvedValueOnce('sell_blocked');
    state.l2Balances = [ethers.parseEther('1')];
    const res = await executeKleosSwap({ ...event('buy', '0.01'), venue: 'univ4' } as any, TREASURY);
    expect(res.success).toBe(false);
    expect(res.reason).toMatch(/won't buy this coin.*honeypot.*Nothing was spent/);
    expect(state.l2Sent).toHaveLength(0);
  });

  it('sells a Montra coin: runs Montra approvals and executes the sell on Elysium', async () => {
    const shared = await import('@racerbot/shared');
    const LR = shared.MONTRA.router;
    const montraRoute = {
      poolId: ethers.ZeroHash,
      hook: shared.MONTRA.hook,
      router: LR,
      quote: ethers.ZeroAddress,
      quoteIsCurrency0: true,
      launchKey: { currency0: ethers.ZeroAddress, currency1: COIN, fee: 0x800000, tickSpacing: 200, hooks: shared.MONTRA.hook },
    };
    vi.mocked(shared.resolveKleosRoute).mockResolvedValueOnce({ kind: 'montra', router: LR, hopFee: 0, montra: montraRoute } as any);
    const approveLR = { to: COIN, data: '0x095ea7b3', value: 0n };
    vi.mocked(shared.montraSellApprovals).mockResolvedValueOnce([approveLR]);
    state.coinBalance = ethers.parseEther('500');
    state.l2Balances = [ethers.parseEther('0.01'), ethers.parseEther('0.06')];
    state.l2Answers = [{ gasUsed: 46_000n }, { gasUsed: 185_000n }];
    const res = await executeKleosSwap({ ...event('sell', '500'), venue: 'montra' } as any, TREASURY);
    expect(res).toMatchObject({ success: true });
    expect(state.l2Sent.map(t => t.to)).toEqual([COIN, LR]);
    expect(db.createFill).toHaveBeenCalledWith(expect.objectContaining({ side: 'sell', venue: 'montra' }));
  });

  it('refuses a buy through a pool that would give far fewer coins than the market price (a decoy pool)', async () => {
    const shared = await import('@racerbot/shared');
    const route = { quote: ethers.ZeroAddress, quoteSymbol: 'HYPE', marketPriceHype: 0.0000006771,
      launchKey: { currency0: ethers.ZeroAddress, currency1: COIN, fee: 890000, tickSpacing: 200, hooks: ethers.ZeroAddress } };
    vi.mocked(shared.resolveKleosRoute).mockResolvedValueOnce({ kind: 'univ4', router: shared.ASCEND.universalRouter, hopFee: 0, ascend: route } as any);
    state.l2Balances = [ethers.parseEther('1')];
    const res = await executeKleosSwap({ ...event('buy', '0.01'), venue: 'univ4' } as any, TREASURY);
    expect(res.success).toBe(false);
    expect(res.reason).toMatch(/far fewer coins than the market price.*Nothing was spent/);
    expect(state.l2Sent).toHaveLength(0);
  });
});

