import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { ethers } from 'ethers';
import {
  KLEOS,
  KLEOS_CLASSIC_POOL_FEE,
  KLEOS_V4_ROUTER_ABI,
  KLEOS_V5_ROUTER_ABI,
  KLEOS_SWAP_ROUTER_ABI,
  MULTICALL3_VALUE_ABI,
  kleosRouteFromLaunch,
  RONSPAD,
  encodeKleosBuy,
  encodeKleosSell,
  encodeKleosBuyWithTransfers,
  applyL1ToL2Alias,
  retryableTicketCost,
  elysiumInboxMaxFeePerGas,
  encodeSignedTxMessage,
  findRetryableTicket,
  findRedeemTxHash,
  describeKleosRevert,
  KLEOS_V5_DEPLOYMENTS,
  isElysiumDirectSend,
  elysiumGasLimit,
  describeElysiumSendError,
  sendElysiumTransaction,
} from './kleos.js';

// A real retryable ticket from the Kleos app: HyperEVM receipt logs and the matching Elysium receipt logs
const ticket = JSON.parse(readFileSync(new URL('./__fixtures__/kleosRetryableTicket.json', import.meta.url), 'utf8'));

const COIN = '0x5e5Df82d563FCF36b6f853c4D09f89e2d18825B4';
const USER = '0x00000000000000000000000000000000000000A1';
const DEADLINE = 1_800_000_000n;

describe('Kleos routing', () => {
  it('picks the router the board launch implies', () => {
    expect(kleosRouteFromLaunch({}).kind).toBe('classic');
    expect(kleosRouteFromLaunch({ v4: { poolId: '0x01' } })).toMatchObject({ kind: 'v4', router: KLEOS.v4Router });
    expect(kleosRouteFromLaunch({ v4: { v5: { hook: '0x', quote: ethers.ZeroAddress, routeFee: 0 } } }))
      .toMatchObject({ kind: 'v5', router: KLEOS.v5Router, hopFee: 0 });
    expect(kleosRouteFromLaunch({ v4: { pair: { launcher: KLEOS.pairLauncher, symbol: 'KLEOS' } } }))
      .toMatchObject({ kind: 'pair', router: KLEOS.pairRouter });
  });

  it('refuses a paired v5 coin with no HYPE route and an unknown pair launcher', () => {
    expect(() => kleosRouteFromLaunch({ v4: { v5: { routeFee: 0 }, pair: { launcher: KLEOS.pairLauncher } } })).toThrow(/no HYPE route/);
    expect(() => kleosRouteFromLaunch({ v4: { pair: { launcher: '0x0000000000000000000000000000000000000001' } } })).toThrow(/Unknown Kleos pair launcher/);
  });
});

describe('Kleos calldata', () => {
  const v4 = new ethers.Interface(KLEOS_V4_ROUTER_ABI);
  const v5 = new ethers.Interface(KLEOS_V5_ROUTER_ABI);
  const sr = new ethers.Interface(KLEOS_SWAP_ROUTER_ABI);

  it('buys through each router with the HYPE as value and the user as recipient', () => {
    const v4Buy = encodeKleosBuy({ kind: 'v4', router: KLEOS.v4Router, hopFee: 0 }, COIN, 100n, 90n, USER, DEADLINE);
    expect(v4Buy).toMatchObject({ to: KLEOS.v4Router, value: 100n });
    expect(v4.decodeFunctionData('buy', v4Buy.data).toArray()).toEqual([COIN, 90n, USER, DEADLINE]);

    const v5Buy = encodeKleosBuy({ kind: 'v5', router: KLEOS.v5Router, hopFee: 10000 }, COIN, 100n, 90n, USER, DEADLINE);
    expect(v5.decodeFunctionData('buy', v5Buy.data).toArray()).toEqual([COIN, 10000n, 90n, USER, DEADLINE]);

    const classic = encodeKleosBuy({ kind: 'classic', router: KLEOS.swapRouter, hopFee: 0 }, COIN, 100n, 90n, USER, DEADLINE);
    const [p] = sr.decodeFunctionData('exactInputSingle', classic.data);
    expect(p.toObject()).toMatchObject({ tokenIn: KLEOS.whype, tokenOut: COIN, fee: BigInt(KLEOS_CLASSIC_POOL_FEE), recipient: USER, amountIn: 100n, amountOutMinimum: 90n });
    expect(classic.value).toBe(100n);
  });

  it('sells a classic coin to the router, then unwraps the WHYPE to the user', () => {
    const sell = encodeKleosSell({ kind: 'classic', router: KLEOS.swapRouter, hopFee: 0 }, COIN, 500n, 40n, USER, DEADLINE);
    const [calls] = sr.decodeFunctionData('multicall', sell.data);
    const [swap] = sr.decodeFunctionData('exactInputSingle', calls[0]);
    expect(swap.toObject()).toMatchObject({ tokenIn: COIN, tokenOut: KLEOS.whype, recipient: KLEOS.swapRouter, amountIn: 500n, amountOutMinimum: 40n });
    expect(sr.decodeFunctionData('unwrapWETH9', calls[1]).toArray()).toEqual([40n, USER]);
    expect(sell.value).toBe(0n);

    const v4Sell = encodeKleosSell({ kind: 'pair', router: KLEOS.pairRouter, hopFee: 0 }, COIN, 500n, 40n, USER, DEADLINE);
    expect(v4.decodeFunctionData('sell', v4Sell.data).toArray()).toEqual([COIN, 500n, 40n, USER, DEADLINE]);
  });

  it('pays the fee and any top-up in the same Multicall3 call as the buy, failing together', () => {
    const buy = encodeKleosBuy({ kind: 'v4', router: KLEOS.v4Router, hopFee: 0 }, COIN, 985n, 1n, USER, DEADLINE);
    const treasury = '0xb1f9551E64e1addF18462B09f04E14DC131451b1';
    const call = encodeKleosBuyWithTransfers([{ to: treasury, value: 15n }, { to: USER, value: 0n }], buy);
    expect(call).toMatchObject({ to: KLEOS.multicall3, value: 1000n });
    const [legs] = new ethers.Interface(MULTICALL3_VALUE_ABI).decodeFunctionData('aggregate3Value', call.data);
    expect(legs.map((l: any) => [l.target, l.allowFailure, l.value, l.callData])).toEqual([
      [treasury, false, 15n, '0x'],
      [KLEOS.v4Router, false, 985n, buy.data],
    ]);
  });
});

describe('HyperEVM inbox helpers', () => {
  it('aliases a HyperEVM sender the Arbitrum way, wrapping at 2^160', () => {
    expect(applyL1ToL2Alias(ethers.ZeroAddress)).toBe('0x1111000000000000000000000000000000001111');
    expect(applyL1ToL2Alias('0xffffffffffffffffffffffffffffffffffffffff')).toBe('0x1111000000000000000000000000000000001110');
  });

  it('sizes a ticket and a signed transaction like the Kleos app', () => {
    const cost = retryableTicketCost({ dataLength: 100, l1BaseFee: 10n, l2BaseFee: 50_000_000n, gasLimit: 1_000_000n, l2CallValue: 7n });
    expect(cost.maxSubmissionCost).toBe((1400n + 600n) * 10n * 2n);
    expect(cost.maxFeePerGas).toBe(200_000_000n); // floor of 0.2 gwei
    expect(cost.deposit).toBe(cost.maxSubmissionCost + 7n + 1_000_000n * 200_000_000n);
    expect(elysiumInboxMaxFeePerGas(100_000_000n)).toBe(300_000_000n);
    expect(elysiumInboxMaxFeePerGas(1n)).toBe(200_000_000n);
  });

  it('wraps signed transactions as one message or a length-prefixed batch', () => {
    expect(encodeSignedTxMessage(['0xaabb'])).toBe('0x04aabb');
    expect(encodeSignedTxMessage(['0xaabb', '0xcc'])).toBe('0x03' + '0000000000000003' + '04aabb' + '0000000000000002' + '04cc');
    expect(() => encodeSignedTxMessage([])).toThrow();
  });

  it('derives the Elysium ticket id from a real createRetryableTicket receipt', () => {
    const found = findRetryableTicket(ticket.l1Logs);
    // Elysium has a receipt under exactly this hash (checked on 2026-11-02)
    expect(found?.ticketId).toBe(ticket.ticketId);
    expect(findRedeemTxHash(ticket.l2Logs)).toBe(ticket.redeem);
    expect(findRetryableTicket([])).toBeNull();
  });

  it('explains Kleos reverts in plain words', () => {
    const data = new ethers.Interface(KLEOS_V4_ROUTER_ABI).encodeErrorResult('TooLittleReceived', []);
    expect(describeKleosRevert({ data })).toMatch(/slippage/);
    expect(describeKleosRevert({ shortMessage: 'boom' })).toBe('boom');
  });
});

describe('BLOB-paired and RonsPad routes', () => {
  it('routes a v5 coin paired against BLOB through the hop router', () => {
    const route = kleosRouteFromLaunch({ v4: { pair: { symbol: 'BLOB' }, v5: { routeFee: 0, quote: '0x9a9815Af521149E8D982791703A31bca2F95f534' } } });
    expect(route.kind).toBe('hop');
    expect(route.router).toBe(KLEOS.hopRouter);
    expect(route.hop).toMatchObject({ tickSpacing: 200, fee: 0, hooks: '0xe11cafa5901b0aab51eb78251488400f9e4320cc' });
  });

  it('still refuses a pair whose quote token has no known HYPE pool', () => {
    expect(() => kleosRouteFromLaunch({ v4: { pair: {}, v5: { routeFee: 0, quote: '0x0000000000000000000000000000000000000001' } } })).toThrow(/no HYPE route/);
  });

  it('never sends RonsPad a minimum of 0, which PadFactory refuses', () => {
    const route = { kind: 'ronspad' as const, router: RONSPAD.padFactory, hopFee: 0 };
    const iface = new ethers.Interface(['function buy(address token, uint256 pairIn, uint256 minTokensOut, address recipient, uint256 deadline)',
      'function sell(address token, uint256 tokensIn, uint256 minPairOut, address recipient, bool toNative, uint256 deadline)']);
    const coin = '0x44d13223e2024c6f3f957d5c9ab98f8a550061f3';
    const me = '0x000000000000000000000000000000000000bEEF';
    const buy = encodeKleosBuy(route, coin, 10n ** 16n, 0n, me, 1n);
    expect(buy.value).toBe(10n ** 16n);
    expect(iface.decodeFunctionData('buy', buy.data)[2]).toBe(1n);
    const sell = encodeKleosSell(route, coin, 5n, 0n, me, 1n);
    const args = iface.decodeFunctionData('sell', sell.data);
    expect(args[2]).toBe(1n);
    expect(args[4]).toBe(true); // paid out as native HYPE
  });
});

describe('Kleos v5 deployments (2026-11-09 public launch)', () => {
  const NEW_LAUNCHER = '0x1c24B6d08220c9584DF1e3D8A15AD7B0D9BC2E6A';
  const OLD_LAUNCHER = '0x2dA68edFF4588A77B55A829689C382F2acB39502';
  const KNTQ = '0xe45a355d9e9cAd2aD85F2d03E3eE3102A036acF0';
  const BLOB = '0x9a9815Af521149E8D982791703A31bca2F95f534';

  it('trades a v5 coin on the router of the launcher that made it', () => {
    expect(kleosRouteFromLaunch({ v4: { v5: { launcher: NEW_LAUNCHER, quote: ethers.ZeroAddress, routeFee: 0 } } }))
      .toEqual({ kind: 'v5', router: '0x15c7Ee481CE8c57461bC8620adC5Fb784374c240', hopFee: 0 });
    expect(kleosRouteFromLaunch({ v4: { v5: { launcher: OLD_LAUNCHER, quote: ethers.ZeroAddress, routeFee: 10000 } } }))
      .toEqual({ kind: 'v5', router: KLEOS.v5Router, hopFee: 10000 });
    expect(KLEOS_V5_DEPLOYMENTS.map(d => d.launcher)).toEqual([NEW_LAUNCHER, OLD_LAUNCHER]);
  });

  it('picks the hop router per quote token and deployment, as the Kleos app does', () => {
    const kntq = kleosRouteFromLaunch({ v4: { pair: {}, v5: { launcher: NEW_LAUNCHER, quote: KNTQ, routeFee: 0 } } });
    expect(kntq).toMatchObject({ kind: 'hop', router: '0xB755388A004DB8008A1F6e88274090F02Fc5dDb3' });
    expect(kntq.hop).toMatchObject({ currency1: KNTQ, fee: 10000, tickSpacing: 200, hooks: ethers.ZeroAddress });
    // BLOB on the new launcher uses that deployment's own hop router; on the old one, the original hop router
    expect(kleosRouteFromLaunch({ v4: { pair: {}, v5: { launcher: NEW_LAUNCHER, quote: BLOB, routeFee: 0 } } }).router)
      .toBe('0xfd5d7bf62A315495a59715C333bd1311a3A1f7ed');
    expect(kleosRouteFromLaunch({ v4: { pair: {}, v5: { launcher: OLD_LAUNCHER, quote: BLOB, routeFee: 0 } } }).router).toBe(KLEOS.hopRouter);
  });

  it('refuses a v5 launcher it does not know, so the route is probed instead', () => {
    expect(() => kleosRouteFromLaunch({ v4: { v5: { launcher: '0x0000000000000000000000000000000000000009', routeFee: 0 } } }))
      .toThrow(/Unknown Kleos v5 launcher/);
  });
});

describe('Direct Elysium transactions', () => {
  it('sends straight to Elysium unless ELYSIUM_SEND_MODE=inbox', () => {
    const before = process.env.ELYSIUM_SEND_MODE;
    delete process.env.ELYSIUM_SEND_MODE;
    expect(isElysiumDirectSend()).toBe(true);
    process.env.ELYSIUM_SEND_MODE = 'inbox';
    expect(isElysiumDirectSend()).toBe(false);
    if (before === undefined) delete process.env.ELYSIUM_SEND_MODE; else process.env.ELYSIUM_SEND_MODE = before;
  });

  it('pads the gas estimate by 30%', () => {
    expect(elysiumGasLimit(200_000n)).toBe(260_000n);
    expect(elysiumGasLimit(1n)).toBe(21_000n);
  });

  it('turns RPC refusals into plain words', () => {
    const rpc = (message: string) => ({ info: { error: { message } } });
    expect(describeElysiumSendError(rpc('insufficient funds for gas * price + value: have 0 want 42'))).toMatch(/Not enough HYPE on Elysium/);
    expect(describeElysiumSendError(rpc('nonce too low: next nonce 8, tx nonce 7'))).toMatch(/Another transaction/);
    expect(describeElysiumSendError(rpc('max fee per gas less than block base fee'))).toMatch(/gas went up/);
    expect(describeElysiumSendError({ message: 'fetch failed' })).toMatch(/Could not reach the Elysium network/);
    const revert = new ethers.Interface(KLEOS_V4_ROUTER_ABI).encodeErrorResult('UnknownToken', []);
    expect(describeElysiumSendError({ data: revert })).toBe('Kleos does not list this coin.');
  });

  it('estimates, signs for chain 99901 and broadcasts on Elysium, then waits for the receipt', async () => {
    delete process.env.ELYSIUM_SEND_MODE;
    const wallet = ethers.Wallet.createRandom();
    const sent: string[] = [];
    const receipts = new Map<string, any>();
    const elysium = {
      getBlock: async () => ({ baseFeePerGas: 100_000_000n }),
      getTransactionCount: async () => 3,
      estimateGas: async () => 21_000n,
      send: async (method: string, [raw]: [string]) => {
        expect(method).toBe('eth_sendRawTransaction');
        sent.push(raw);
        receipts.set(ethers.keccak256(raw), { status: 1 });
        return ethers.keccak256(raw);
      },
      getTransactionReceipt: async (hash: string) => receipts.get(hash) ?? null,
    } as any;
    const l1Signer = { sendTransaction: async () => { throw new Error('must not touch HyperEVM'); } } as any;
    const hyperevm = { getBalance: async () => 0n } as any;
    const res = await sendElysiumTransaction({
      elysium, l2Signer: wallet as any, l1Signer, hyperevm, tx: { to: USER, value: 5n }, inboxGasLimit: 100_000n,
    });
    expect(res).toEqual({ elysiumTxHash: ethers.keccak256(sent[0]), confirmed: true });
    const tx = ethers.Transaction.from(sent[0]);
    expect([tx.chainId, tx.nonce, tx.to, tx.value, tx.gasLimit, tx.from]).toEqual([99901n, 3, USER, 5n, 27_300n, wallet.address]);
    expect(tx.maxFeePerGas).toBe(300_000_000n);
  });

  it('refuses before signing when Elysium says the call would fail', async () => {
    delete process.env.ELYSIUM_SEND_MODE;
    const elysium = {
      getBlock: async () => ({ baseFeePerGas: 100_000_000n }),
      getTransactionCount: async () => 0,
      estimateGas: async () => { throw { info: { error: { message: 'insufficient funds for gas * price + value' } } }; },
      send: async () => { throw new Error('must not broadcast'); },
    } as any;
    await expect(sendElysiumTransaction({
      elysium, l2Signer: ethers.Wallet.createRandom() as any, l1Signer: {} as any, hyperevm: {} as any,
      tx: { to: USER, value: 5n }, inboxGasLimit: 100_000n,
    })).rejects.toThrow(/Not enough HYPE on Elysium.*Nothing was sent/);
  });
});
