import { ethers } from 'ethers';
import {
  type SwapEvent,
  getEvmProvider,
  getEvmWalletFromEncrypted,
  getErc20TokenInfo,
  getErc20Balance,
  calculateEvmTradeFee,
  calculateElysiumSellFee,
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
  getKleosBoardCoin,
  retryableTicketCost,
  toTokenUnits,
  type EvmCall,
  distributeTradeFeeRewards,
  isElysiumDirectSend,
  elysiumGasLimit,
  describeElysiumSendError,
  elysiumPadName,
  ascendSellApprovals,
  montraSellApprovals,
  padSellApprovals,
  simulateV4RoundTrip,
  isSaneV4Fee,
  quoteMatchesMarket,
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
// Direct Elysium transactions confirm in about a second; inbox messages take minutes
const pollMs = () => (isElysiumDirectSend() ? 1_000 : 4_000);
// An inbox message can wait up to the 24h force-inclusion delay; minOut is the price guard, as in the Kleos app
const INBOX_DEADLINE_SEC = 3 * 24 * 3600;
// Gas budgeted for a direct Elysium buy or sell when checking a balance (hop coins use up to ~660k; unused gas is never charged)
const ELYSIUM_DIRECT_TRADE_GAS = 800_000n;
const ELYSIUM_DIRECT_APPROVE_GAS = 80_000n;
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
  /** True when signed Elysium transactions go through the HyperEVM inbox, which costs HyperEVM gas */
  viaInbox?: boolean;
}): KleosBuyFunding | null {
  const inboxGasOk = !p.viaInbox || p.hyperevmBalance >= HYPEREVM_INBOX_GAS_RESERVE;
  if (p.elysiumBalance >= p.gross + p.elysiumGasCost && inboxGasOk) return 'elysium';
  if (p.hyperevmBalance >= p.ticketDeposit + HYPEREVM_INBOX_GAS_RESERVE) return 'hyperevm';
  return null;
}

async function waitForElysiumReceipt(provider: ethers.JsonRpcProvider, hash: string): Promise<ethers.TransactionReceipt | null> {
  const until = Date.now() + CONFIRM_TIMEOUT_MS;
  while (Date.now() < until) {
    const receipt = await provider.getTransactionReceipt(hash).catch(() => null);
    if (receipt) return receipt;
    await new Promise(r => setTimeout(r, pollMs()));
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

const notYetConfirmed = (what: string, elysiumTx: string): string =>
  `${what} was sent to Elysium (${ELYSIUM_MAINNET_EXPLORER_URL}/tx/${elysiumTx}) but no confirmation arrived yet. ` +
  `Check your balance before trying again, so you don't trade twice.`;

/**
 * A read tried up to three times with a short pause: public RPCs answer some calls from a node that is a block
 * behind ("invalid block height") or busy, and one such answer must not stop a trade.
 */
async function retryRead<T>(read: () => Promise<T>, tries = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      return await read();
    } catch (err) {
      lastErr = err;
      await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
    }
  }
  throw lastErr;
}

const isAlreadyKnown = (err: any): boolean =>
  /already known|known transaction/i.test(String(err?.info?.error?.message || err?.error?.message || err?.shortMessage || err?.message || ''));

/** A signed Elysium transaction the RPC refused (or would revert); its message is already in plain language */
class ElysiumSendError extends Error { }

/**
 * Buy or sell a Kleos (or RonsPad) coin on Elysium mainnet. Signed transactions go straight to Elysium
 * (ELYSIUM_SEND_MODE=inbox posts them through the HyperEVM inbox instead); a buy paid from HyperEVM HYPE
 * enters through a retryable ticket in the HyperEVM inbox.
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
  const userAddress: string = activeWallet?.address || user.evm_address || '';
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
    // The board's launch data carries a v5 coin's hop fee; without it those coins find no route
    const boardCoin = await getKleosBoardCoin(token).catch(() => null);
    route = await resolveKleosRoute(l2, token, boardCoin?.launch);
  } catch (err: any) {
    return fail(`${err?.message || 'No Kleos route'} Nothing was spent.`);
  }
  // RonsPad, Ascend, Montra, BOXA, ElysPump and Uniswap v4 coins trade through the same Elysium flow
  const fillVenue = route.kind === 'ronspad' ? 'ronspad' : route.kind === 'ascend' ? 'ascend' : route.kind === 'montra' ? 'montra'
    : route.kind === 'pad' ? route.pad!.pad.name : route.kind === 'padv3' ? 'elyspump' : route.kind === 'univ4' ? 'univ4' : 'kleos';
  const venueName = elysiumPadName(fillVenue);

  const direct = isElysiumDirectSend();
  const l2Block = await retryRead(() => l2.getBlock('latest'));
  const l2MaxFee = elysiumInboxMaxFeePerGas(l2Block?.baseFeePerGas ?? 0n);
  // A direct transaction runs within seconds; an inbox message can wait up to the 24h force-inclusion delay
  const deadline = BigInt(Math.floor(Date.now() / 1000) + (direct ? 20 * 60 : INBOX_DEADLINE_SEC));

  /**
   * Signs one Elysium transaction from the user's own address and sends it straight to the Elysium RPC.
   * Gas is estimated first, so a call that would revert is never sent.
   */
  const sendDirect = async (call: EvmCall): Promise<string> => {
    let estimate: bigint;
    try {
      estimate = await l2.estimateGas({ from: userAddress, to: call.to, data: call.data, value: call.value });
    } catch (err) {
      throw new ElysiumSendError(describeKleosRevert(err));
    }
    const nonce = await l2.getTransactionCount(userAddress, 'pending');
    const raw = await l2Signer.signTransaction({
      type: 2, chainId: Number(ELYSIUM_BRIDGE.childChainId), nonce,
      to: call.to, data: call.data, value: call.value,
      gasLimit: elysiumGasLimit(estimate), maxFeePerGas: l2MaxFee, maxPriorityFeePerGas: 0n,
    });
    try {
      await l2.send('eth_sendRawTransaction', [raw]);
    } catch (err) {
      // A backup RPC saying "already known" means an earlier attempt did reach Elysium: it is sent
      if (!isAlreadyKnown(err)) throw new ElysiumSendError(describeElysiumSendError(err));
    }
    return ethers.keccak256(raw);
  };

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
      return fail(`${venueName} could not quote this buy: ${describeKleosRevert(err)} Nothing was spent.`);
    }
    if (expectedOut <= 0n) return fail(`${venueName} quoted zero coins for this buy. Nothing was spent.`);
    // A plain Uniswap v4 pool can carry any hook or fee: the quote must match the coin's market price, and the
    // coin must sell back, before anything is bought
    if (route.kind === 'univ4') {
      if (!isSaneV4Fee(route.ascend!.launchKey.fee) || !quoteMatchesMarket(netTradeAmount, expectedOut, decimals, route.ascend!.marketPriceHype)) {
        return fail(`RacerBot won't buy this coin here: the only pool it could use would give you far fewer coins than the market price (very high pool fee or too little liquidity). Nothing was spent.`);
      }
      onProgress?.('simulating');
      const roundTrip = await simulateV4RoundTrip(l2, route.ascend!, token, netTradeAmount);
      if (roundTrip === 'sell_blocked') {
        return fail(`RacerBot won't buy this coin: a test buy followed by a sell failed, so its pool may not let you sell it back (a possible honeypot). Nothing was spent.`);
      }
      if (roundTrip === 'sells_return_little') {
        return fail(`RacerBot won't buy this coin: in a test, selling right after buying gave back less than half the HYPE, so its pool has almost no HYPE to pay sellers. Nothing was spent.`);
      }
      if (roundTrip === 'buy_blocked') return fail(`This coin's pool is not accepting buys right now. Nothing was spent.`);
    }
    const minOut = calculateSlippageMin(expectedOut, slippage_pct);

    // HyperEVM only matters for a buy paid from HyperEVM HYPE: if it can't be read, pay from Elysium HYPE alone
    const [l2Balance, [l1Balance, l1Block]] = await Promise.all([
      retryRead(() => l2.getBalance(userAddress)),
      Promise.all([retryRead(() => l1.getBalance(userAddress)), retryRead(() => l1.getBlock('latest'))])
        .catch(() => [0n, null] as [bigint, ethers.Block | null]),
    ]);
    const topUp = l2Balance < KLEOS_SELL_GAS_TOPUP ? KLEOS_SELL_GAS_TOPUP : 0n;
    const swap = encodeKleosBuy(route, token, netTradeAmount, minOut, userAddress, deadline);
    const signedCall = encodeKleosBuyWithTransfers([{ to: treasury, value: feeAmount }], swap);
    const ticketCall = encodeKleosBuyWithTransfers([{ to: treasury, value: feeAmount }, { to: userAddress, value: topUp }], swap);
    const ticket = retryableTicketCost({
      dataLength: ethers.dataLength(ticketCall.data), l1BaseFee: l1Block?.baseFeePerGas ?? 0n,
      l2BaseFee: l2Block?.baseFeePerGas ?? 0n, gasLimit: KLEOS_INBOX_TRADE_GAS, l2CallValue: ticketCall.value,
    });
    const elysiumGasCost = (direct ? ELYSIUM_DIRECT_TRADE_GAS : KLEOS_INBOX_TRADE_GAS) * l2MaxFee;
    const funding = chooseKleosBuyFunding({
      gross, elysiumBalance: l2Balance, elysiumGasCost,
      hyperevmBalance: l1Balance, ticketDeposit: ticket.deposit, viaInbox: !direct,
    });
    if (!funding) {
      return fail(
        `Not enough HYPE. A ${amount_in} HYPE buy needs about ${ethers.formatEther(gross + elysiumGasCost)} HYPE on Elysium ` +
        `(you have ${ethers.formatEther(l2Balance)}), or about ${ethers.formatEther(ticket.deposit + HYPEREVM_INBOX_GAS_RESERVE)} HYPE on HyperEVM ` +
        `(you have ${ethers.formatEther(l1Balance)}). Nothing was spent.`
      );
    }

    // Check the exact call before paying for it; a ticket runs as the aliased HyperEVM address
    onProgress?.('simulating');
    const payer = funding === 'elysium' ? userAddress : applyL1ToL2Alias(userAddress);
    const call = funding === 'elysium' ? signedCall : ticketCall;
    const simError = await simulateOnElysium(l2, payer, call, funding === 'hyperevm');
    if (simError) return fail(`This buy would fail on ${venueName}: ${simError} Nothing was spent.`);

    const before = await getErc20Balance(token, userAddress, chain, false);
    onProgress?.('executing_swap');
    let swapTxHash: string | null;
    let parentTx = '';
    if (funding === 'elysium' && direct) {
      try {
        swapTxHash = await sendDirect(call);
      } catch (err: any) {
        if (err instanceof ElysiumSendError) return fail(`This buy could not be sent: ${err.message} Nothing was spent.`);
        throw err;
      }
    } else if (funding === 'elysium') {
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
    if (!swapReceipt) return fail(parentTx ? notYetRun('Your buy', parentTx) : notYetConfirmed('Your buy', swapTxHash));
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
        input_amount: ethers.formatEther(gross), venue: fillVenue, tx_hash: swapReceipt.hash,
      }).catch(() => null);
      if (fill?.fillId && fill.inserted) {
        const feeHype = ethers.formatEther(feeAmount);
        await recordFee(fill.fillId, feeHype).catch(() => { });
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
    expectedHype = await quoteKleos(l2, route, token, 'sell', amountIn, userAddress);
  } catch (err) {
    return fail(`${venueName} could not quote this sell: ${describeKleosRevert(err)} Nothing was sold.`);
  }
  if (expectedHype <= 0n) return fail(`${venueName} quoted no HYPE for this sell. Nothing was sold.`);
  const minOut = calculateSlippageMin(expectedHype, slippage_pct);
  const sell = encodeKleosSell(route, token, amountIn, minOut, userAddress, deadline);

  // Exactly this amount, as the launchpads' own apps approve. Ascend and multi-hop Montra pull coins through Permit2 (two approvals).
  // BOXA approves its router; ElysPump, Ascend and plain Uniswap v4 pools pull the coin through Permit2
  const approvals: EvmCall[] = route.kind === 'pad'
    ? await padSellApprovals(l2, route.pad!, userAddress, amountIn)
    : route.kind === 'ascend' || route.kind === 'univ4'
    ? await ascendSellApprovals(l2, token, userAddress, amountIn)
    : route.kind === 'montra'
      ? await montraSellApprovals(l2, route.montra!, token, userAddress, amountIn)
      : (await coin.allowance(userAddress, route.router)) < amountIn
        ? [{ to: token, data: new ethers.Interface(ERC20_ABI).encodeFunctionData('approve', [route.router, amountIn]), value: 0n }]
        : [];
  const needsApprove = approvals.length > 0;
  if (direct) return sellDirect();

  const calls: { call: EvmCall; gasLimit: bigint }[] = [];
  if (needsApprove) {
    for (const call of approvals) calls.push({ call, gasLimit: KLEOS_INBOX_APPROVE_GAS });
  } else {
    onProgress?.('simulating');
    const simError = await simulateOnElysium(l2, userAddress, sell, false);
    if (simError) return fail(`This sell would fail on ${venueName}: ${simError} Nothing was sold.`);
  }
  calls.push({ call: sell, gasLimit: KLEOS_INBOX_TRADE_GAS });

  const gasNeeded = calls.reduce((sum, c) => sum + c.gasLimit, 0n) * l2MaxFee;
  const [l1Balance, l2Before] = await Promise.all([retryRead(() => l1.getBalance(userAddress)), retryRead(() => l2.getBalance(userAddress))]);
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
  if (receipts[receipts.length - 1].status !== 1) {
    return fail('The sell ran on Elysium but reverted (usually the price moved past your slippage). Only its gas was spent; you still hold the coins.');
  }

  return finishSell(receipts, l2Before);

  /** Approve (when needed), then sell, each sent straight to Elysium and confirmed before the next */
  async function sellDirect(): Promise<EvmSwapExecutionResult> {
    const gasNeeded = (ELYSIUM_DIRECT_APPROVE_GAS * BigInt(approvals.length) + ELYSIUM_DIRECT_TRADE_GAS) * l2MaxFee;
    const l2Before = await retryRead(() => l2.getBalance(userAddress));
    if (l2Before < gasNeeded) {
      return fail(
        `Selling needs about ${ethers.formatEther(gasNeeded)} HYPE on Elysium for gas; you have ${ethers.formatEther(l2Before)}. ` +
        `Add a little HYPE to your Elysium wallet first. Nothing was sold.`
      );
    }
    const receipts: ethers.TransactionReceipt[] = [];
    try {
      for (const approveCall of approvals) {
        onProgress?.('approving');
        const approveHash = await sendDirect(approveCall);
        const approveReceipt = await waitForElysiumReceipt(l2, approveHash);
        if (!approveReceipt) return fail(notYetConfirmed(`The approval to sell ${tokenSymbol}`, approveHash));
        if (approveReceipt.status !== 1) return fail('The approval to sell was refused on Elysium. Only its gas was spent; you still hold the coins.');
        receipts.push(approveReceipt);
      }
      onProgress?.('simulating');
      const simError = await simulateOnElysium(l2, userAddress, sell, false);
      if (simError) return fail(`This sell would fail on ${venueName}: ${simError} Nothing was sold.`);
      onProgress?.('executing_swap');
      const sellHash = await sendDirect(sell);
      onProgress?.('waiting_elysium');
      const sellReceipt = await waitForElysiumReceipt(l2, sellHash);
      if (!sellReceipt) return fail(notYetConfirmed('Your sell', sellHash));
      receipts.push(sellReceipt);
    } catch (err: any) {
      if (err instanceof ElysiumSendError) return fail(`This sell could not be sent: ${err.message} Nothing was sold.`);
      throw err;
    }
    if (receipts[receipts.length - 1].status !== 1) {
      return fail('The sell ran on Elysium but reverted (usually the price moved past your slippage). Only its gas was spent; you still hold the coins.');
    }
    return finishSell(receipts, l2Before);
  }

  async function finishSell(receipts: ethers.TransactionReceipt[], l2Before: bigint): Promise<EvmSwapExecutionResult> {
    const sellReceipt = receipts[receipts.length - 1];
    // HYPE received = balance change plus the gas every transaction paid
    const l2After = await l2.getBalance(userAddress);
    const gasPaid = receipts.reduce((sum, r) => sum + r.gasUsed * (r.gasPrice ?? 0n), 0n);
    const grossReceivedRaw = l2After + gasPaid > l2Before ? l2After + gasPaid - l2Before : 0n;
    const { feeAmount, netProceeds } = calculateElysiumSellFee(grossReceivedRaw);

    if (direct && treasury && ethers.isAddress(treasury) && feeAmount > 0n) {
      try {
        const feeHash = await sendDirect({ to: treasury, data: '0x', value: feeAmount });
        await waitForElysiumReceipt(l2, feeHash);
      } catch (err: any) {
        console.warn('[KLEOS_EXECUTOR] Sell fee transfer warning:', err?.message);
      }
    }

    const receivedHype = Number(ethers.formatEther(netProceeds));
    const priceHype = Number(ethers.formatEther(grossReceivedRaw)) / (Number(soldQty) || 1);
    const feeHype = ethers.formatEther(feeAmount);

    const openPositions = await getOpenPositions(user!.id);
    const pos = openPositions.find(p => p.token_address === token && p.chain === (chain as any));
    if (pos) {
      const fill = await createFill({
        user_id: user!.id, position_id: pos.id, chain: chain as any, side: 'sell', token_address: token,
        amount: soldQty, price: priceHype.toString(), fee_paid: feeHype,
        input_amount: ethers.formatEther(netProceeds), venue: fillVenue, tx_hash: sellReceipt.hash,
      }).catch(() => null);
      if (fill?.fillId && fill.inserted) {
        await recordFee(fill.fillId, feeHype).catch(() => {});
        if (feeAmount > 0n) {
          await distributeTradeFeeRewards({
            userId: user!.id,
            chain: 'elysium',
            feeAmount: feeHype,
            tokenAddress: token,
          }).catch((err) => console.warn('[KLEOS_EXECUTOR] Sell fee distribution error:', err?.message));
        }
      }
    }

    return {
      txHash: sellReceipt.hash, success: true, chain, positionId: pos?.id, tokenName, tokenSymbol,
      tokenQty: soldQty, priceHype, hypeSpentOrReceived: receivedHype,
      explorerUrl: `${ELYSIUM_MAINNET_EXPLORER_URL}/tx/${sellReceipt.hash}`,
    };
  }
}
