import { ethers } from 'ethers';
import {
  type SwapEvent,
  getEvmProvider,
  getEvmWalletFromEncrypted,
  getErc20TokenInfo,
  getErc20Balance,
  calculateEvmTradeFee,
  calculateSlippageMin,
  ERC20_ABI,
  ELYSIUM_INBOX_ABI,
  ELYSIUM_MAINNET_EXPLORER_URL,
  HYPEREVM_EXPLORER_URL,
  HYPE_SYMBOL,
  KLEOS_INBOX_TRADE_GAS,
  KLEOS_INBOX_APPROVE_GAS,
  ELYSIUM_BRIDGE,
  applyL1ToL2Alias,
  describeKleosRevert,
  elysiumInboxMaxFeePerGas,
  encodeKleosBuy,
  encodeKleosBuyWithTransfers,
  encodeKleosSell,
  encodeSignedTxMessage,
  findRedeemTxHash,
  findRetryableTicket,
  quoteKleos,
  resolveKleosRoute,
  retryableTicketCost,
  toTokenUnits,
  type EvmCall,
  distributeTradeFeeRewards,
} from '@racerbot/shared';
import {
  getUserById,
  getActiveWallet,
  createFill,
  getOpenPositions,
  createPosition,
  recordFee,
} from '@racerbot/db';
import type { EvmSwapExecutionResult } from './evmExecutor.js';

const MASTER_KEY = process.env.KEY_ENCRYPTION_MASTER_KEY || '';
const CONFIRM_TIMEOUT_MS = Number(process.env.KLEOS_CONFIRM_TIMEOUT_MS || 300_000);
const POLL_MS = 4_000;
// An inbox message can wait up to the 24h force-inclusion delay; minOut is the price guard, as in the Kleos app
const INBOX_DEADLINE_SEC = 3 * 24 * 3600;
// HYPE sent along with a HyperEVM-paid buy so the coins can be sold later (approve + sell gas on Elysium)
export const KLEOS_SELL_GAS_TOPUP = ethers.parseEther('0.0005');
// Gas for the HyperEVM transaction that carries the order into the inbox (~93k used)
const HYPEREVM_INBOX_GAS_RESERVE = ethers.parseEther('0.0002');

export type KleosBuyFunding = 'elysium' | 'hyperevm';

/**
 * Which chain's HYPE pays for a buy: Elysium HYPE first (a signed transaction, no ticket), then HyperEVM HYPE
 * through a retryable ticket. Null when neither balance covers it.
 */
export function chooseKleosBuyFunding(p: {
  gross: bigint;
  elysiumBalance: bigint;
  elysiumGasCost: bigint;
  hyperevmBalance: bigint;
  ticketDeposit: bigint;
}): KleosBuyFunding | null {
  if (p.elysiumBalance >= p.gross + p.elysiumGasCost && p.hyperevmBalance >= HYPEREVM_INBOX_GAS_RESERVE) return 'elysium';
  if (p.hyperevmBalance >= p.ticketDeposit + HYPEREVM_INBOX_GAS_RESERVE) return 'hyperevm';
  return null;
}

async function waitForElysiumReceipt(provider: ethers.JsonRpcProvider, hash: string): Promise<ethers.TransactionReceipt | null> {
  const until = Date.now() + CONFIRM_TIMEOUT_MS;
  while (Date.now() < until) {
    const receipt = await provider.getTransactionReceipt(hash).catch(() => null);
    if (receipt) return receipt;
    await new Promise(r => setTimeout(r, POLL_MS));
  }
  return null;
}

/** eth_call with the payer's balance overridden, so a HyperEVM-funded call can be checked before it is paid for */
async function simulateOnElysium(provider: ethers.JsonRpcProvider, from: string, call: EvmCall, fundFrom: boolean): Promise<string | null> {
  const tx = { from, to: call.to, data: call.data, value: ethers.toQuantity(call.value) };
  const overrides = fundFrom ? { [from]: { balance: ethers.toQuantity(call.value + ethers.parseEther('1')) } } : undefined;
  try {
    await provider.send('eth_call', overrides ? [tx, 'latest', overrides] : [tx, 'latest']);
    return null;
  } catch (err: any) {
    return describeKleosRevert(err);
  }
}

const notYetRun = (what: string, parentTx: string): string =>
  `${what} was sent into the Elysium inbox (${HYPEREVM_EXPLORER_URL}/tx/${parentTx}) but has not run on Elysium yet. ` +
  `It usually runs within a few minutes. Check your Kleos balance before trying again, so you don't buy twice.`;

/**
 * Buy or sell a Kleos coin on Elysium mainnet, entering through the HyperEVM inbox.
 * Buys pay the 1.5% platform fee in the same Multicall3 call as the swap; sells pay none, as on HyperEVM.
 */
export async function executeKleosSwap(
  event: SwapEvent,
  treasury: string,
  onProgress?: (stage: string) => void
): Promise<EvmSwapExecutionResult> {
  const chain = 'elysium' as const;
  const { user_id, token_in, token_out, amount_in, slippage_pct = 2 } = event;
  onProgress?.('routing_kleos');

  const user = await getUserById(user_id);
  if (!user) throw new Error(`User not found: ${user_id}`);
  const activeWallet = await getActiveWallet(user.id, chain).catch(() => null);
  const userAddress = activeWallet?.address || user.evm_address;
  const userKeyEnc = activeWallet?.encrypted_private_key || user.evm_private_key_enc;
  if (!userAddress || !userKeyEnc) throw new Error(`User ${user_id} does not have an initialized EVM wallet.`);

  const l1 = getEvmProvider('hyperevm', false);
  const l2 = getEvmProvider('elysium', false);
  const l1Signer = getEvmWalletFromEncrypted(userKeyEnc, MASTER_KEY, l1);
  const l2Signer = getEvmWalletFromEncrypted(userKeyEnc, MASTER_KEY, l2);
  const inboxIface = new ethers.Interface(ELYSIUM_INBOX_ABI);
  const sendToInbox = async (fn: 'sendL2Message' | 'createRetryableTicket', args: unknown[], value = 0n) => {
    const tx = await l1Signer.sendTransaction({ to: ELYSIUM_BRIDGE.inbox, data: inboxIface.encodeFunctionData(fn, args), value });
    return await tx.wait(1);
  };

  const isBuy = token_in.toUpperCase() === HYPE_SYMBOL || token_in === 'native' || token_in === ethers.ZeroAddress;
  const token = isBuy ? token_out : token_in;
  const tokenInfo = await getErc20TokenInfo(token, chain, false);
  const tokenSymbol = tokenInfo?.symbol || 'TKN';
  const tokenName = tokenInfo?.name || 'Kleos coin';
  const decimals = tokenInfo?.decimals ?? 18;
  const fail = (reason: string): EvmSwapExecutionResult => ({ txHash: '', success: false, chain, reason, tokenSymbol, tokenName });

  let route;
  try {
    route = await resolveKleosRoute(l2, token);
  } catch (err: any) {
    return fail(`${err?.message || 'No Kleos route'} Nothing was spent.`);
  }

  const l2Block = await l2.getBlock('latest');
  const l2MaxFee = elysiumInboxMaxFeePerGas(l2Block?.baseFeePerGas ?? 0n);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + INBOX_DEADLINE_SEC);

  /** Signs Elysium transactions from the user's own address and posts them into the inbox from HyperEVM */
  const sendSigned = async (calls: { call: EvmCall; gasLimit: bigint }[]): Promise<{ hashes: string[]; parentTx: string }> => {
    const nonce = await l2.getTransactionCount(userAddress, 'pending');
    const raws = await Promise.all(calls.map(({ call, gasLimit }, i) => l2Signer.signTransaction({
      type: 2, chainId: Number(ELYSIUM_BRIDGE.childChainId), nonce: nonce + i,
      to: call.to, data: call.data, value: call.value,
      gasLimit, maxFeePerGas: l2MaxFee, maxPriorityFeePerGas: 0n,
    })));
    const receipt = await sendToInbox('sendL2Message', [encodeSignedTxMessage(raws)]);
    if (receipt?.status !== 1) throw new Error('The HyperEVM inbox transaction reverted. Nothing ran on Elysium.');
    return { hashes: raws.map(raw => ethers.keccak256(raw)), parentTx: receipt.hash };
  };

  if (isBuy) {
    onProgress?.('preparing_buy');
    const gross = ethers.parseEther(String(amount_in));
    const { feeAmount, netTradeAmount } = calculateEvmTradeFee(gross);

    let expectedOut: bigint;
    try {
      expectedOut = await quoteKleos(l2, route, token, 'buy', netTradeAmount);
    } catch (err) {
      return fail(`Kleos could not quote this buy: ${describeKleosRevert(err)} Nothing was spent.`);
    }
    if (expectedOut <= 0n) return fail('Kleos quoted zero coins for this buy. Nothing was spent.');
    const minOut = calculateSlippageMin(expectedOut, slippage_pct);

    const [l1Balance, l2Balance, l1Block] = await Promise.all([l1.getBalance(userAddress), l2.getBalance(userAddress), l1.getBlock('latest')]);
    const topUp = l2Balance < KLEOS_SELL_GAS_TOPUP ? KLEOS_SELL_GAS_TOPUP : 0n;
    const swap = encodeKleosBuy(route, token, netTradeAmount, minOut, userAddress, deadline);
    const signedCall = encodeKleosBuyWithTransfers([{ to: treasury, value: feeAmount }], swap);
    const ticketCall = encodeKleosBuyWithTransfers([{ to: treasury, value: feeAmount }, { to: userAddress, value: topUp }], swap);
    const ticket = retryableTicketCost({
      dataLength: ethers.dataLength(ticketCall.data), l1BaseFee: l1Block?.baseFeePerGas ?? 0n,
      l2BaseFee: l2Block?.baseFeePerGas ?? 0n, gasLimit: KLEOS_INBOX_TRADE_GAS, l2CallValue: ticketCall.value,
    });
    const funding = chooseKleosBuyFunding({
      gross, elysiumBalance: l2Balance, elysiumGasCost: KLEOS_INBOX_TRADE_GAS * l2MaxFee,
      hyperevmBalance: l1Balance, ticketDeposit: ticket.deposit,
    });
    if (!funding) {
      return fail(
        `Insufficient HYPE. A ${amount_in} HYPE Kleos buy needs about ${ethers.formatEther(ticket.deposit + HYPEREVM_INBOX_GAS_RESERVE)} HYPE on HyperEVM ` +
        `(you have ${ethers.formatEther(l1Balance)}), or ${amount_in} HYPE plus gas on Elysium (you have ${ethers.formatEther(l2Balance)}).`
      );
    }

    // Check the exact call before paying for it; a ticket runs as the aliased HyperEVM address
    onProgress?.('simulating');
    const payer = funding === 'elysium' ? userAddress : applyL1ToL2Alias(userAddress);
    const call = funding === 'elysium' ? signedCall : ticketCall;
    const simError = await simulateOnElysium(l2, payer, call, funding === 'hyperevm');
    if (simError) return fail(`This buy would fail on Kleos: ${simError} Nothing was spent.`);

    const before = await getErc20Balance(token, userAddress, chain, false);
    onProgress?.('executing_swap');
    let swapTxHash: string | null;
    let parentTx: string;
    if (funding === 'elysium') {
      const sent = await sendSigned([{ call, gasLimit: KLEOS_INBOX_TRADE_GAS }]);
      parentTx = sent.parentTx;
      swapTxHash = sent.hashes[0];
    } else {
      const receipt = await sendToInbox('createRetryableTicket', [
        call.to, call.value, ticket.maxSubmissionCost, userAddress, userAddress,
        KLEOS_INBOX_TRADE_GAS, ticket.maxFeePerGas, call.data,
      ], ticket.deposit);
      if (receipt?.status !== 1) return fail('The HyperEVM inbox transaction reverted. Nothing was spent beyond its gas.');
      parentTx = receipt.hash;
      const opened = findRetryableTicket(receipt.logs);
      if (!opened) return fail(notYetRun('Your buy', parentTx));
      onProgress?.('waiting_elysium');
      const ticketReceipt = await waitForElysiumReceipt(l2, opened.ticketId);
      swapTxHash = ticketReceipt ? findRedeemTxHash(ticketReceipt.logs) : null;
      if (ticketReceipt && !swapTxHash) {
        return fail(`Your buy reached Elysium but was not run. Its HYPE waits in the ticket and returns to your Elysium address when it expires (7 days).`);
      }
    }
    if (!swapTxHash) return fail(notYetRun('Your buy', parentTx));

    onProgress?.('waiting_elysium');
    const swapReceipt = await waitForElysiumReceipt(l2, swapTxHash);
    if (!swapReceipt) return fail(notYetRun('Your buy', parentTx));
    if (swapReceipt.status !== 1) {
      return fail(funding === 'hyperevm'
        ? 'The buy ran on Elysium but reverted (usually the price moved past your slippage). Its HYPE waits in the ticket and returns to your Elysium address when it expires (7 days).'
        : 'The buy ran on Elysium but reverted (usually the price moved past your slippage). Only its gas was spent.');
    }

    const after = await getErc20Balance(token, userAddress, chain, false);
    const boughtRaw = after.raw > before.raw ? after.raw - before.raw : 0n;
    const tokensBought = ethers.formatUnits(boughtRaw, decimals);
    const priceHype = Number(ethers.formatEther(netTradeAmount)) / (Number(tokensBought) || 1);

    const openPositions = await getOpenPositions(user.id);
    let position = openPositions.find(p => p.token_address === token && p.chain === (chain as any));
    if (!position) {
      position = await createPosition({
        user_id: user.id, chain: chain as any, token_address: token, quantity_held: '0', avg_entry_price: '0',
      }).catch(() => null) as any;
    }
    if (position) {
      const fill = await createFill({
        user_id: user.id, position_id: position.id, chain: chain as any, side: 'buy', token_address: token,
        amount: tokensBought, price: priceHype.toString(), fee_paid: ethers.formatEther(feeAmount),
        input_amount: ethers.formatEther(gross), venue: 'kleos', tx_hash: swapReceipt.hash,
      }).catch(() => null);
      if (fill?.fillId && fill.inserted) {
        const feeHype = ethers.formatEther(feeAmount);
        await recordFee(fill.fillId, feeHype).catch(() => {});
        await distributeTradeFeeRewards({
          userId: user.id,
          chain: 'elysium',
          feeAmount: feeHype,
          tokenAddress: token,
        }).catch((err) => console.warn('[KLEOS_EXECUTOR] Fee distribution error:', err?.message));
      }
    }

    return {
      txHash: swapReceipt.hash, success: true, chain, positionId: position?.id, tokenName, tokenSymbol,
      tokenQty: tokensBought, priceHype, hypeSpentOrReceived: Number(amount_in),
      explorerUrl: `${ELYSIUM_MAINNET_EXPLORER_URL}/tx/${swapReceipt.hash}`,
    };
  }

  // ── SELL: coin -> HYPE on Elysium, signed by the user so the router can take the coins ──
  onProgress?.('preparing_sell');
  const coin = new ethers.Contract(token, ERC20_ABI, l2);
  let amountIn = toTokenUnits(amount_in, decimals);
  const held: bigint = await coin.balanceOf(userAddress);
  if (held <= 0n) return fail(`No ${tokenSymbol} left in your wallet to sell.`);
  // The bot's record can sit slightly above the wallet: sell what is really there (stop-losses must not fail)
  if (held < amountIn) amountIn = held;
  if (amountIn <= 0n) return fail('Sell amount must be greater than 0.');
  const soldQty = ethers.formatUnits(amountIn, decimals);

  let expectedHype: bigint;
  try {
    expectedHype = await quoteKleos(l2, route, token, 'sell', amountIn);
  } catch (err) {
    return fail(`Kleos could not quote this sell: ${describeKleosRevert(err)} Nothing was sold.`);
  }
  if (expectedHype <= 0n) return fail('Kleos quoted no HYPE for this sell. Nothing was sold.');
  const minOut = calculateSlippageMin(expectedHype, slippage_pct);
  const sell = encodeKleosSell(route, token, amountIn, minOut, userAddress, deadline);

  const allowance: bigint = await coin.allowance(userAddress, route.router);
  const calls: { call: EvmCall; gasLimit: bigint }[] = [];
  if (allowance < amountIn) {
    // Exactly this amount, as the Kleos app approves
    const approve = new ethers.Interface(ERC20_ABI).encodeFunctionData('approve', [route.router, amountIn]);
    calls.push({ call: { to: token, data: approve, value: 0n }, gasLimit: KLEOS_INBOX_APPROVE_GAS });
  } else {
    onProgress?.('simulating');
    const simError = await simulateOnElysium(l2, userAddress, sell, false);
    if (simError) return fail(`This sell would fail on Kleos: ${simError} Nothing was sold.`);
  }
  calls.push({ call: sell, gasLimit: KLEOS_INBOX_TRADE_GAS });

  const gasNeeded = calls.reduce((sum, c) => sum + c.gasLimit, 0n) * l2MaxFee;
  const [l1Balance, l2Before] = await Promise.all([l1.getBalance(userAddress), l2.getBalance(userAddress)]);
  if (l1Balance < HYPEREVM_INBOX_GAS_RESERVE) {
    return fail(`Selling on Kleos needs about ${ethers.formatEther(HYPEREVM_INBOX_GAS_RESERVE)} HYPE on HyperEVM for the inbox transaction. You have ${ethers.formatEther(l1Balance)}.`);
  }
  if (l2Before < gasNeeded) {
    return fail(
      `Selling needs about ${ethers.formatEther(gasNeeded)} HYPE on Elysium for gas; you have ${ethers.formatEther(l2Before)}. ` +
      `Bridge a little HYPE to Elysium first.`
    );
  }

  onProgress?.(calls.length > 1 ? 'approving' : 'executing_swap');
  const sent = await sendSigned(calls);
  onProgress?.('waiting_elysium');
  const receipts: ethers.TransactionReceipt[] = [];
  for (const hash of sent.hashes) {
    const receipt = await waitForElysiumReceipt(l2, hash);
    if (!receipt) return fail(notYetRun('Your sell', sent.parentTx));
    receipts.push(receipt);
  }
  const sellReceipt = receipts[receipts.length - 1];
  if (sellReceipt.status !== 1) {
    return fail('The sell ran on Elysium but reverted (usually the price moved past your slippage). Only its gas was spent; you still hold the coins.');
  }

  // HYPE received = balance change plus the gas both transactions paid
  const l2After = await l2.getBalance(userAddress);
  const gasPaid = receipts.reduce((sum, r) => sum + r.gasUsed * (r.gasPrice ?? 0n), 0n);
  const receivedRaw = l2After + gasPaid - l2Before;
  const receivedHype = Number(ethers.formatEther(receivedRaw > 0n ? receivedRaw : 0n));
  const priceHype = receivedHype / (Number(soldQty) || 1);

  const openPositions = await getOpenPositions(user.id);
  const pos = openPositions.find(p => p.token_address === token && p.chain === (chain as any));
  if (pos) {
    const fill = await createFill({
      user_id: user.id, position_id: pos.id, chain: chain as any, side: 'sell', token_address: token,
      amount: soldQty, price: priceHype.toString(), fee_paid: '0',
      input_amount: ethers.formatEther(receivedRaw > 0n ? receivedRaw : 0n), venue: 'kleos', tx_hash: sellReceipt.hash,
    }).catch(() => null);
    if (fill?.fillId && fill.inserted) await recordFee(fill.fillId, '0').catch(() => {});
  }

  return {
    txHash: sellReceipt.hash, success: true, chain, positionId: pos?.id, tokenName, tokenSymbol,
    tokenQty: soldQty, priceHype, hypeSpentOrReceived: receivedHype,
    explorerUrl: `${ELYSIUM_MAINNET_EXPLORER_URL}/tx/${sellReceipt.hash}`,
  };
}
