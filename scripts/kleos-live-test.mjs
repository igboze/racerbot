// Live Kleos test on Elysium mainnet: buy 0.005 HYPE of one coin (paid from HyperEVM by retryable ticket), then sell it all.
// Mirrors packages/executor/src/kleosExecutor.ts using the same shared helpers.
//
//   KLEOS_TEST_PRIVATE_KEY   the wallet's key (read from the environment, never printed)
//   KLEOS_TEST_COIN          optional coin address (default: AGORA, a v4 coin)
//
//   node scripts/kleos-live-test.mjs          dry run: checks, simulation and cost; nothing is signed or sent
//   node scripts/kleos-live-test.mjs --send   runs the trades
//
// Requires a build of packages/shared (npm run build:shared).
import { ethers } from 'ethers';
import * as K from '../packages/shared/dist/kleos.js';

const SEND = process.argv.includes('--send');
const BUY_HYPE = ethers.parseEther('0.005');
const HYPEREVM_CAP = ethers.parseEther('0.006'); // most this test may take from HyperEVM, gas included
const SLIPPAGE_BPS = 200n;
const WAIT_MS = 5 * 60_000;
const TREASURY = '0xb1f9551E64e1addF18462B09f04E14DC131451b1';
const TOP_UP = ethers.parseEther('0.0005');
const COIN = ethers.getAddress(process.env.KLEOS_TEST_COIN || '0x5e5Df82d563FCF36b6f853c4D09f89e2d18825B4');

const l1 = new ethers.JsonRpcProvider('https://rpc.hyperliquid.xyz/evm', 999, { staticNetwork: true });
const l2 = new ethers.JsonRpcProvider('https://rpc.thekleos.xyz/rpc', 99901, { staticNetwork: true });
const erc20 = new ethers.Interface([
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function symbol() view returns (string)',
]);
const inboxIface = new ethers.Interface(K.ELYSIUM_INBOX_ABI);
const fmt = (wei) => `${ethers.formatEther(wei)} HYPE`;
const q = (n) => ethers.toQuantity(n);
const stop = (msg) => { console.log(`\nSTOPPED: ${msg}\nNothing more was sent.`); process.exit(1); };
const bal = async (token, who) => BigInt(await l2.call({ to: token, data: erc20.encodeFunctionData('balanceOf', [who]) }));

async function waitReceipt(hash, label) {
  const until = Date.now() + WAIT_MS;
  process.stdout.write(`  waiting for ${label} on Elysium`);
  while (Date.now() < until) {
    const r = await l2.getTransactionReceipt(hash).catch(() => null);
    if (r) { console.log(' - ran'); return r; }
    process.stdout.write('.');
    await new Promise(res => setTimeout(res, 5000));
  }
  console.log(' - not yet');
  return null;
}

// The key is typed at a hidden prompt when it is not in the environment, so it never appears on screen
async function askKey() {
  if (!process.stdin.isTTY) return '';
  process.stdout.write('Paste the test wallet private key, then press Enter (hidden): ');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let input = '';
  for await (const chunk of process.stdin) {
    for (const ch of chunk.toString('utf8')) {
      if (ch === '\r' || ch === '\n') { process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n'); return input.trim(); }
      if (ch === '\u0003') { process.stdout.write('\n'); process.exit(130); }
      if (ch === '\u007f' || ch === '\b') input = input.slice(0, -1);
      else input += ch;
    }
  }
  return input.trim();
}
const key = process.env.KLEOS_TEST_PRIVATE_KEY || await askKey();
if (!key) stop('No key given.');
let wallet;
try { wallet = new ethers.Wallet(key.startsWith('0x') ? key : `0x${key}`); } catch { stop('That is not a valid private key.'); }
const USER = wallet.address;
const ALIAS = K.applyL1ToL2Alias(USER);
const l1Signer = wallet.connect(l1);
console.log(`Mode: ${SEND ? 'LIVE (--send)' : 'dry run (nothing is signed or sent)'}`);
console.log(`Wallet: ${USER}\nCoin: ${COIN}`);

// Right chains
const genesis = await l2.getBlock(0);
if (genesis?.hash !== K.ELYSIUM_BRIDGE.genesisHash) stop(`Elysium RPC genesis ${genesis?.hash} is not Elysium mainnet.`);

// ── Buy plan ──
const route = await K.resolveKleosRoute(l2, COIN).catch(e => stop(e.message));
const symbol = await l2.call({ to: COIN, data: erc20.encodeFunctionData('symbol', []) }).then(d => erc20.decodeFunctionResult('symbol', d)[0]).catch(() => 'TKN');
const fee = BUY_HYPE * 150n / 10000n, net = BUY_HYPE - fee;
const expected = await K.quoteKleos(l2, route, COIN, 'buy', net);
const minOut = expected * (10000n - SLIPPAGE_BPS) / 10000n;
const deadline = BigInt(Math.floor(Date.now() / 1000) + 3 * 86400);
const [l1Before, l2Before, tokBefore, l1Block, l2Block, l1GasPrice] = await Promise.all([
  l1.getBalance(USER), l2.getBalance(USER), bal(COIN, USER), l1.getBlock('latest'), l2.getBlock('latest'),
  l1.send('eth_gasPrice', []).then(BigInt),
]);
const topUp = l2Before < TOP_UP ? TOP_UP : 0n;
const call = K.encodeKleosBuyWithTransfers([{ to: TREASURY, value: fee }, { to: USER, value: topUp }],
  K.encodeKleosBuy(route, COIN, net, minOut, USER, deadline));
const ticket = K.retryableTicketCost({ dataLength: ethers.dataLength(call.data), l1BaseFee: l1Block.baseFeePerGas, l2BaseFee: l2Block.baseFeePerGas, gasLimit: K.KLEOS_INBOX_TRADE_GAS, l2CallValue: call.value });
const ticketData = inboxIface.encodeFunctionData('createRetryableTicket', [call.to, call.value, ticket.maxSubmissionCost, USER, USER, K.KLEOS_INBOX_TRADE_GAS, ticket.maxFeePerGas, call.data]);
console.log(`\nRoute: ${route.kind} (${route.router})`);
console.log(`Buy: ${fmt(BUY_HYPE)} = ${fmt(net)} swap + ${fmt(fee)} fee + ${fmt(topUp)} gas top-up to your Elysium address`);
console.log(`Quote: ${ethers.formatEther(expected)} ${symbol}, minimum ${ethers.formatEther(minOut)}`);

// Simulate the ticket's Elysium call as the aliased sender, and the HyperEVM ticket itself
const sim = await l2.send('eth_call', [{ from: ALIAS, to: call.to, data: call.data, value: q(call.value) }, 'latest', { [ALIAS]: { balance: q(call.value + ethers.parseEther('1')) } }]).then(() => null, e => K.describeKleosRevert(e));
if (sim) stop(`Buy simulation failed: ${sim}`);
console.log('Buy simulation on Elysium: ok');
const l1Gas = await l1.send('eth_estimateGas', [{ from: USER, to: K.ELYSIUM_BRIDGE.inbox, data: ticketData, value: q(ticket.deposit) }, 'latest', { [USER]: { balance: q(ticket.deposit + ethers.parseEther('1')) } }]).then(BigInt, e => stop(`HyperEVM ticket estimate failed: ${e.shortMessage || e.message}`));
const l1GasLimit = l1Gas * 125n / 100n;
// Sell needs one more small HyperEVM transaction (sendL2Message, ~95k gas)
const sellL1Reserve = 150_000n * l1GasPrice * 2n;
const worstCase = ticket.deposit + l1GasLimit * l1GasPrice * 2n + sellL1Reserve;
console.log(`HyperEVM: ticket deposit ${fmt(ticket.deposit)} (unused gas refunds to Elysium), gas ~${l1Gas}; worst case for the whole test ${fmt(worstCase)}`);
console.log(`Balances: HyperEVM ${fmt(l1Before)}, Elysium ${fmt(l2Before)}, ${ethers.formatEther(tokBefore)} ${symbol}`);
if (worstCase > HYPEREVM_CAP) stop(`Worst case ${fmt(worstCase)} is over the ${fmt(HYPEREVM_CAP)} cap.`);
if (l1Before < worstCase) stop(`HyperEVM balance ${fmt(l1Before)} is below the ${fmt(worstCase)} the test needs.`);
if (!SEND) { console.log('\nDry run passed. Run again with --send to trade.'); process.exit(0); }

// ── Buy ──
console.log('\nSending the buy (createRetryableTicket on HyperEVM)...');
const buyTx = await l1Signer.sendTransaction({ to: K.ELYSIUM_BRIDGE.inbox, data: ticketData, value: ticket.deposit, gasLimit: l1GasLimit });
console.log(`  HyperEVM tx ${buyTx.hash}`);
const buyRcpt = await buyTx.wait(1);
if (buyRcpt.status !== 1) stop('The HyperEVM ticket transaction reverted (only its gas was spent).');
const opened = K.findRetryableTicket(buyRcpt.logs);
if (!opened) stop('No ticket found in the HyperEVM receipt.');
console.log(`  ticket ${opened.ticketId}`);
const ticketRcpt = await waitReceipt(opened.ticketId, 'the ticket');
if (!ticketRcpt) stop(`The buy hasn't run on Elysium within 5 minutes. Ticket ${opened.ticketId}; check before retrying.`);
const redeemHash = K.findRedeemTxHash(ticketRcpt.logs);
if (!redeemHash) stop('The ticket landed but no redeem was scheduled. Its HYPE waits in the ticket (7 days).');
const redeemRcpt = await waitReceipt(redeemHash, 'the buy');
if (!redeemRcpt) stop(`The buy hasn't run on Elysium within 5 minutes. Redeem ${redeemHash}.`);
if (redeemRcpt.status !== 1) stop(`The buy reverted on Elysium (${redeemHash}). Its HYPE waits in the ticket and returns to ${USER} on Elysium within 7 days.`);
const tokAfterBuy = await bal(COIN, USER);
const bought = tokAfterBuy - tokBefore;
console.log(`  bought ${ethers.formatEther(bought)} ${symbol} (Elysium tx ${redeemHash})`);

// ── Sell everything the buy got ──
const l1AfterBuy = await l1.getBalance(USER);
const spentSoFar = l1Before - l1AfterBuy;
const sellQuote = await K.quoteKleos(l2, route, COIN, 'sell', bought);
const sellMin = sellQuote * (10000n - SLIPPAGE_BPS) / 10000n;
const sell = K.encodeKleosSell(route, COIN, bought, sellMin, USER, deadline);
const approve = { to: COIN, data: erc20.encodeFunctionData('approve', [route.router, bought]), value: 0n };
const sellSim = await l2.send('eth_simulateV1', [{ blockStateCalls: [{ calls: [
  { from: USER, to: approve.to, data: approve.data },
  { from: USER, to: sell.to, data: sell.data },
] }], validation: false }, 'latest']).catch(e => ({ error: e }));
const simCalls = sellSim?.[0]?.calls;
if (!simCalls || simCalls.some(c => c.status !== '0x1')) stop(`Sell simulation failed (${JSON.stringify(simCalls?.map(c => c.error?.message) ?? sellSim.error?.message)}). You hold the coins; nothing more was sent.`);
console.log(`\nSell: ${ethers.formatEther(bought)} ${symbol}, quote ${fmt(sellQuote)}, minimum ${fmt(sellMin)}; simulation ok`);

const l2Base = (await l2.getBlock('latest')).baseFeePerGas;
const maxFee = K.elysiumInboxMaxFeePerGas(l2Base);
const l2Bal = await l2.getBalance(USER);
const l2GasNeeded = (K.KLEOS_INBOX_APPROVE_GAS + K.KLEOS_INBOX_TRADE_GAS) * maxFee;
if (l2Bal < l2GasNeeded) stop(`Elysium balance ${fmt(l2Bal)} is below the ${fmt(l2GasNeeded)} the sell's gas needs.`);
const nonce = await l2.getTransactionCount(USER, 'pending');
const raws = await Promise.all([
  [approve, K.KLEOS_INBOX_APPROVE_GAS], [sell, K.KLEOS_INBOX_TRADE_GAS],
].map(([c, gasLimit], i) => wallet.signTransaction({ type: 2, chainId: 99901, nonce: nonce + i, to: c.to, data: c.data, value: c.value, gasLimit, maxFeePerGas: maxFee, maxPriorityFeePerGas: 0n })));
const msgData = inboxIface.encodeFunctionData('sendL2Message', [K.encodeSignedTxMessage(raws)]);
const sellL1Gas = BigInt(await l1.estimateGas({ from: USER, to: K.ELYSIUM_BRIDGE.inbox, data: msgData })) * 125n / 100n;
if (spentSoFar + sellL1Gas * l1GasPrice * 2n > HYPEREVM_CAP) stop(`Sending the sell would take HyperEVM spend over the ${fmt(HYPEREVM_CAP)} cap. You hold the coins.`);
console.log('Sending the sell (signed approve + sell via sendL2Message on HyperEVM)...');
const sellTx = await l1Signer.sendTransaction({ to: K.ELYSIUM_BRIDGE.inbox, data: msgData, gasLimit: sellL1Gas });
console.log(`  HyperEVM tx ${sellTx.hash}`);
if ((await sellTx.wait(1)).status !== 1) stop('The HyperEVM sendL2Message reverted (only its gas was spent). You hold the coins.');
const [approveHash, sellHash] = raws.map(r => ethers.keccak256(r));
const approveRcpt = await waitReceipt(approveHash, 'the approve');
const sellRcpt = approveRcpt && await waitReceipt(sellHash, 'the sell');
if (!sellRcpt) stop(`The sell hasn't run on Elysium within 5 minutes (approve ${approveHash}, sell ${sellHash}).`);
if (sellRcpt.status !== 1) stop(`The sell reverted on Elysium (${sellHash}). You still hold the coins.`);

// ── Report ──
const [l1End, l2End, tokEnd] = await Promise.all([l1.getBalance(USER), l2.getBalance(USER), bal(COIN, USER)]);
console.log('\n=== Kleos live test passed ===');
console.log(`Buy:  HyperEVM ${buyTx.hash}\n      Elysium ticket ${opened.ticketId}\n      Elysium buy ${redeemHash}`);
console.log(`Sell: HyperEVM ${sellTx.hash}\n      Elysium approve ${approveHash}\n      Elysium sell ${sellHash}`);
console.log(`HyperEVM spent: ${fmt(l1Before - l1End)} (cap ${fmt(HYPEREVM_CAP)})`);
console.log(`Elysium HYPE: ${fmt(l2Before)} -> ${fmt(l2End)} (sale proceeds, top-up and ticket refunds stay at ${USER} on Elysium)`);
console.log(`${symbol}: ${ethers.formatEther(tokBefore)} -> ${ethers.formatEther(tokEnd)}`);
console.log(`Platform fee: ${fmt(fee)} to ${TREASURY} on Elysium`);
