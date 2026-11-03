/**
 * Trading NEAR tokens that Rhea has no route for, through NEAR Intents (1Click).
 *
 * Two shapes:
 *  - direct: the token itself is listed on 1Click (bridged tokens such as PRL): NEAR <-> token in one swap;
 *  - via a quote token: the token trades in a Rhea DCL pool against a quote token 1Click lists but Rhea
 *    has no NEAR pool for (a justhoot v2 coin paired with PRL): NEAR -> quote on 1Click, then
 *    quote -> token in the DCL pool; sells run the same path backwards.
 *
 * The 1Click leg follows the verified deposit flow of the private balance: wrap NEAR, register the
 * one-time deposit address, transfer, then wait for 1Click to settle. The platform fee rides on that
 * leg as a 1Click app fee, so it is only paid when the swap settles.
 */
import { KeyPair, transactions } from 'near-api-js';
import { createLogger, decrypt, getNear } from '@racerbot/shared';
import { createFill, createPosition, getOpenPositions, recordFee, type UserRecord } from '@racerbot/db';
import { quotePublicSwap, notifyDeposit, waitForMove, getIntentsNearAsset } from './intentsPrivate.js';
import { TREASURY_ACCOUNT_ID } from './config.js';

const logger = createLogger('intents-route');
const MASTER_KEY = process.env.KEY_ENCRYPTION_MASTER_KEY || '';
const DCL = 'dclv2.ref-labs.near';
const TGAS = 1_000_000_000_000n;
const STORAGE_DEPOSIT = 1_250_000_000_000_000_000_000n; // 0.00125 NEAR
const FEE_BPS = 150; // the platform fee on every NEAR trade (1.5%)
const SETTLE_TIMEOUT_MS = 180_000;

export interface IntentsRoute {
  /** The asset 1Click swaps: the token itself (direct), or the DCL pool's quote token */
  quote: string;
  /** Set when the token trades in a DCL pool against `quote` */
  dclPoolId?: string;
}

export interface IntentsTradeResult {
  success: boolean;
  reason?: string;
  txHash?: string;
  positionId?: string;
  tokensRaw?: string;
  nearSpent?: number;
  nearReceived?: number;
  priceNear?: number;
  /** Buy paid in the quote token (1Click had no liquidity) */
  paidIn?: string;
  /** Sale ended in the quote token, not NEAR (1Click had no liquidity) */
  receivedIn?: string;
  receivedAmount?: number;
}

const yoctoToNear = (y: bigint) => Number(y / 10n ** 18n) / 1e6;

function failureOf(outcome: any): string | null {
  const f = outcome?.status?.Failure;
  if (f) return JSON.stringify(f).slice(0, 300);
  for (const r of outcome?.receipts_outcome ?? []) {
    const rf = r?.outcome?.status?.Failure;
    if (rf) return JSON.stringify(rf).slice(0, 300);
  }
  return null;
}

async function signer(user: UserRecord) {
  if (!user.subaccount_id || !user.scoped_key_encrypted) throw new Error('A RacerBot-managed NEAR wallet is needed for this trade.');
  const near = getNear();
  await near.addKey(user.subaccount_id, KeyPair.fromString(decrypt(user.scoped_key_encrypted, MASTER_KEY) as any));
  return near;
}

async function balanceOf(token: string, account: string): Promise<bigint> {
  return BigInt((await getNear().getTokenBalance(token, account).catch(() => '0')) || '0');
}

/** storage_deposit actions for any of `accounts` not yet registered on `token` */
async function storageActions(token: string, accounts: string[]): Promise<any[]> {
  const near = getNear();
  const out: any[] = [];
  for (const account of accounts) {
    const registered = await near.view<any>(token, 'storage_balance_of', { account_id: account }).catch(() => null);
    if (!registered) out.push(transactions.functionCall('storage_deposit', { account_id: account, registration_only: true }, 10n * TGAS, STORAGE_DEPOSIT));
  }
  return out;
}

async function send(near: any, from: string, receiver: string, actions: any[]): Promise<string> {
  const outcome = await near.signAndSendTransactionAll(from, receiver, actions);
  const err = failureOf(outcome);
  if (err) throw new Error(err);
  return outcome.transaction.hash;
}

/** Output of a DCL swap, from the pool's own quote */
async function dclQuote(poolId: string, input: string, output: string, amount: bigint): Promise<bigint> {
  const q = await getNear().view<any>(DCL, 'quote', { pool_ids: [poolId], input_token: input, output_token: output, input_amount: amount.toString(), tag: null });
  return BigInt(q?.amount || '0');
}

async function dclSwap(near: any, from: string, poolId: string, input: string, output: string, amount: bigint, slippagePct: number): Promise<{ out: bigint; txHash: string }> {
  const expected = await dclQuote(poolId, input, output, amount);
  if (expected <= 0n) throw new Error('The Rhea pool quoted nothing for this swap.');
  const min = (expected * BigInt(Math.round((100 - slippagePct) * 100))) / 10_000n;
  // The pool pays out to the sender, who must be registered on the output token
  const register = await storageActions(output, [from]);
  if (register.length) await send(near, from, output, register);
  const before = await balanceOf(output, from);
  const txHash = await send(near, from, input, [
    transactions.functionCall('ft_transfer_call', {
      receiver_id: DCL,
      amount: amount.toString(),
      msg: JSON.stringify({ Swap: { pool_ids: [poolId], output_token: output, min_output_amount: min.toString() } }),
    }, 200n * TGAS, 1n),
  ]);
  const after = await balanceOf(output, from);
  return { out: after > before ? after - before : 0n, txHash };
}

/** Waits for a 1Click deposit to settle; throws with a plain reason otherwise */
async function settle(depositAddress: string, txHash: string): Promise<void> {
  void notifyDeposit(depositAddress, txHash);
  const status = await waitForMove(depositAddress, SETTLE_TIMEOUT_MS);
  if (status.status === 'SUCCESS') return;
  if (status.status === 'REFUNDED') throw new Error('NEAR Intents could not fill this swap and refunded it to your wallet.');
  if (status.status === 'FAILED' || status.status === 'INCOMPLETE_DEPOSIT') throw new Error(`NEAR Intents swap ${status.status.toLowerCase()}.`);
  throw new Error('NEAR Intents is still processing this swap; check your wallet in a minute before trying again.');
}

/** True when 1Click refused to quote because no solver has liquidity for the pair */
const noLiquidity = (err: any) => /No liquidity available/i.test(err?.message || '');

/** NEAR per whole quote token, and its decimals (PRL is priced from NEAR Intents' live list) */
async function quoteRate(token: string): Promise<{ rate: number; decimals: number }> {
  const near = getNear();
  const [rate, meta] = await Promise.all([
    near.getPairedTokenNearRate(token).catch(() => ({ rateInNear: 0, decimals: 18 })),
    near.getTokenMetadata(token).catch(() => null),
  ]);
  return { rate: rate.rateInNear, decimals: meta?.decimals ?? rate.decimals ?? 18 };
}

/** Sends the platform fee in a token the wallet holds (registering the treasury on it when needed) */
async function payTokenFee(near: any, from: string, token: string, amount: bigint): Promise<void> {
  if (amount <= 0n) return;
  const register = await storageActions(token, [TREASURY_ACCOUNT_ID]);
  await send(near, from, token, [
    ...register,
    transactions.functionCall('ft_transfer', { receiver_id: TREASURY_ACCOUNT_ID, amount: amount.toString() }, 15n * TGAS, 1n),
  ]);
}

async function recordFill(user: UserRecord, token: string, side: 'buy' | 'sell', tokensRaw: bigint, nearValue: number, feeNear: number, txHash: string, positionId?: string): Promise<{ positionId?: string; priceNear: number }> {
  const near = getNear();
  const meta = await near.getTokenMetadata(token).catch(() => ({ decimals: 18 }));
  const human = Number(tokensRaw) / 10 ** (meta?.decimals ?? 18);
  const priceNear = human > 0 ? (side === 'buy' ? nearValue - feeNear : nearValue) / human : 0;
  let posId = positionId;
  if (!posId) {
    const open = await getOpenPositions(user.id).catch(() => []);
    posId = open.find(p => p.token_address === token && (p.chain === 'near' || !p.chain))?.id;
    if (!posId && side === 'buy') posId = (await createPosition({ user_id: user.id, token_address: token, quantity_held: '0', avg_entry_price: '0' })).id;
  }
  if (posId) {
    const fill = await createFill({
      user_id: user.id, position_id: posId, side, token_address: token, amount: tokensRaw.toString(),
      price: priceNear.toString(), fee_paid: feeNear.toString(), input_amount: nearValue.toString(), venue: 'intents' as any, tx_hash: txHash,
    });
    if (fill.inserted) await recordFee(fill.fillId, feeNear.toString()).catch(() => {});
  }
  return { positionId: posId, priceNear };
}

/**
 * Buys `token` with `amountNear` NEAR through 1Click (and its DCL pool when the route has one). When 1Click
 * has no liquidity for the quote token but the wallet already holds enough of it, the buy is paid in that
 * quote token instead (the NEAR amount at its live price), straight into the coin's DCL pool.
 */
export async function buyViaIntents(user: UserRecord, token: string, route: IntentsRoute, amountNear: number, slippagePct: number): Promise<IntentsTradeResult> {
  const account = user.subaccount_id;
  const slippage = Math.max(0.5, Math.min(50, slippagePct));
  try {
    const near = await signer(user);
    const amount = BigInt(Math.round(amountNear * 1e6)) * 10n ** 18n;
    const quoteAsset = await getIntentsNearAsset(route.quote);
    if (!quoteAsset) return { success: false, reason: 'NEAR Intents no longer lists this token.' };

    // Leg 1: NEAR -> quote (or the token itself) on 1Click, delivered to the user's wallet on NEAR
    let quote: Awaited<ReturnType<typeof quotePublicSwap>> | null = null;
    try {
      quote = await quotePublicSwap({
        originAsset: 'nep141:wrap.near',
        destinationAsset: quoteAsset,
        amount: amount.toString(),
        recipient: account,
        refundTo: account,
        slippageBps: Math.round(slippage * 100),
        appFees: [{ recipient: TREASURY_ACCOUNT_ID, fee: FEE_BPS }],
      });
    } catch (err) {
      if (!noLiquidity(err)) throw err;
    }

    if (!quote) {
      // No 1Click liquidity: pay in the quote token the wallet already holds, when the coin trades against it
      const { rate, decimals } = await quoteRate(route.quote);
      const sym = (await near.getTokenMetadata(route.quote).catch(() => null))?.symbol || route.quote;
      if (!route.dclPoolId || rate <= 0) {
        return { success: false, reason: 'NEAR Intents has no liquidity for this token right now. Nothing was spent; try again later.' };
      }
      const needed = BigInt(Math.floor((amountNear / rate) * 10 ** decimals));
      const held = await balanceOf(route.quote, account);
      if (held < needed) {
        const fmt = (v: bigint) => (Number(v) / 10 ** decimals).toLocaleString('en-US', { maximumFractionDigits: 4 });
        return {
          success: false,
          reason: `NEAR Intents has no ${sym} liquidity right now, so NEAR cannot be swapped into ${sym}. ` +
            `This coin trades against ${sym}: with ${fmt(needed)} ${sym} in your wallet (you have ${fmt(held)}) the buy goes straight through its pool. Nothing was spent.`,
        };
      }
      const fee = (needed * BigInt(FEE_BPS)) / 10_000n;
      await payTokenFee(near, account, route.quote, fee);
      const { out, txHash } = await dclSwap(near, account, route.dclPoolId, route.quote, token, needed - fee, slippage);
      if (out <= 0n) throw new Error(`The Rhea swap from ${sym} into the coin did not fill; your ${sym} is in your wallet.`);
      const rec = await recordFill(user, token, 'buy', out, amountNear, amountNear * FEE_BPS / 10_000, txHash);
      return { success: true, txHash, positionId: rec.positionId, tokensRaw: out.toString(), nearSpent: amountNear, priceNear: rec.priceNear, paidIn: sym };
    }

    const nativeBal = BigInt((await near.getNearBalance(account, 0).catch(() => '0')) || '0');
    if (nativeBal < amount + 50_000_000_000_000_000_000_000n) {
      return { success: false, reason: `Not enough NEAR: this buy needs ${amountNear} NEAR plus about 0.05 NEAR for fees.` };
    }
    // The wallet must be registered on what 1Click delivers, or the delivery fails
    const register = await storageActions(route.quote, [account]);
    if (register.length) await send(near, account, route.quote, register);

    const quoteBefore = await balanceOf(route.quote, account);
    const tokenBefore = await balanceOf(token, account);
    let txHash = await send(near, account, 'wrap.near', [
      transactions.functionCall('near_deposit', {}, 10n * TGAS, amount),
      transactions.functionCall('storage_deposit', { account_id: quote.depositAddress, registration_only: true }, 10n * TGAS, STORAGE_DEPOSIT),
      transactions.functionCall('ft_transfer', { receiver_id: quote.depositAddress, amount: amount.toString() }, 15n * TGAS, 1n),
    ]);
    await settle(quote.depositAddress, txHash);
    const quoteGot = (await balanceOf(route.quote, account)) - quoteBefore;
    if (quoteGot <= 0n) throw new Error('The NEAR Intents swap settled but nothing arrived yet. Check your wallet before retrying.');

    // Leg 2: quote -> token in its DCL pool
    let tokensGot = quoteGot;
    if (route.dclPoolId) {
      const swap = await dclSwap(near, account, route.dclPoolId, route.quote, token, quoteGot, slippage);
      tokensGot = swap.out > 0n ? swap.out : (await balanceOf(token, account)) - tokenBefore;
      txHash = swap.txHash || txHash;
      if (tokensGot <= 0n) throw new Error(`Bought ${route.quote} but the Rhea swap into the coin did not fill; your ${route.quote} is in your wallet.`);
    }
    const rec = await recordFill(user, token, 'buy', tokensGot, amountNear, amountNear * FEE_BPS / 10_000, txHash);
    return { success: true, txHash, positionId: rec.positionId, tokensRaw: tokensGot.toString(), nearSpent: amountNear, priceNear: rec.priceNear };
  } catch (err: any) {
    logger.warn(`Intents buy of ${token} for ${user.id} failed: ${err?.message}`);
    if (noLiquidity(err)) return { success: false, reason: 'NEAR Intents has no liquidity for this token right now. Nothing was spent; try again later.' };
    return { success: false, reason: err?.message || 'NEAR Intents buy failed' };
  }
}

/**
 * Sells `amountRaw` of `token` for NEAR through its DCL pool (when the route has one) and 1Click. 1Click is
 * asked for a price before anything is swapped. When it has no liquidity for the quote token, a coin in a
 * DCL pool is still sold, into the quote token (so a stop-loss still exits), and the result says so.
 */
export async function sellViaIntents(user: UserRecord, token: string, route: IntentsRoute, amountRaw: bigint, slippagePct: number, positionId?: string): Promise<IntentsTradeResult> {
  const account = user.subaccount_id;
  const slippage = Math.max(0.5, Math.min(50, slippagePct));
  try {
    const near = await signer(user);
    const held = await balanceOf(token, account);
    const sell = amountRaw > held ? held : amountRaw;
    if (sell <= 0n) return { success: false, reason: 'Nothing left in your wallet to sell.' };
    const quoteAsset = await getIntentsNearAsset(route.quote);
    if (!quoteAsset) throw new Error('NEAR Intents no longer lists this token.');

    // Price check first: can 1Click turn what this sale yields back into NEAR?
    const expectedQuote = route.dclPoolId ? await dclQuote(route.dclPoolId, token, route.quote, sell) : sell;
    if (expectedQuote <= 0n) throw new Error('The Rhea pool quoted nothing for this sale. Nothing was sold.');
    let intentsOk = true;
    await quotePublicSwap({
      dry: true, originAsset: quoteAsset, destinationAsset: 'nep141:wrap.near', amount: expectedQuote.toString(),
      recipient: account, refundTo: account, slippageBps: Math.round(slippage * 100),
    }).catch((err) => {
      if (!noLiquidity(err)) throw err;
      intentsOk = false;
    });
    const sym = (await near.getTokenMetadata(route.quote).catch(() => null))?.symbol || route.quote;
    if (!intentsOk && !route.dclPoolId) {
      return { success: false, reason: `NEAR Intents has no ${sym} liquidity right now. Nothing was sold; try again later.` };
    }

    // Leg 1: token -> quote in its DCL pool
    let quoteAmount = sell;
    let txHash = '';
    if (route.dclPoolId) {
      const swap = await dclSwap(near, account, route.dclPoolId, token, route.quote, sell, slippage);
      quoteAmount = swap.out;
      txHash = swap.txHash;
      if (quoteAmount <= 0n) throw new Error('The Rhea swap out of the coin did not fill. Nothing was sold.');
    }

    if (!intentsOk) {
      // Exit into the quote token: 1Click cannot take it to NEAR right now
      const fee = (quoteAmount * BigInt(FEE_BPS)) / 10_000n;
      await payTokenFee(near, account, route.quote, fee).catch((err: any) => logger.warn(`Fee in ${sym} not paid: ${err?.message}`));
      const { rate, decimals } = await quoteRate(route.quote);
      const kept = Number(quoteAmount - fee) / 10 ** decimals;
      const nearValue = kept * rate;
      const rec = await recordFill(user, token, 'sell', sell, nearValue, Number(fee) / 10 ** decimals * rate, txHash, positionId);
      return {
        success: true, txHash, positionId: rec.positionId, tokensRaw: sell.toString(), nearReceived: nearValue, priceNear: rec.priceNear,
        receivedIn: sym, receivedAmount: kept,
      };
    }

    // Leg 2: quote -> NEAR on 1Click, delivered to the wallet
    const quote = await quotePublicSwap({
      originAsset: quoteAsset,
      destinationAsset: 'nep141:wrap.near',
      amount: quoteAmount.toString(),
      recipient: account,
      refundTo: account,
      slippageBps: Math.round(slippage * 100),
      appFees: [{ recipient: TREASURY_ACCOUNT_ID, fee: FEE_BPS }],
    }).catch((err) => {
      if (route.dclPoolId && noLiquidity(err)) throw new Error(`Sold into ${sym}, but NEAR Intents lost its ${sym} liquidity before the swap to NEAR. Your ${sym} is in your wallet.`);
      throw err;
    });
    const nearBefore = BigInt((await near.getNearBalance(account, 0).catch(() => '0')) || '0') + await balanceOf('wrap.near', account);
    txHash = await send(near, account, route.quote, [
      ...(await storageActions(route.quote, [quote.depositAddress])),
      transactions.functionCall('ft_transfer', { receiver_id: quote.depositAddress, amount: quoteAmount.toString() }, 15n * TGAS, 1n),
    ]);
    await settle(quote.depositAddress, txHash);
    const nearAfter = BigInt((await near.getNearBalance(account, 0).catch(() => '0')) || '0') + await balanceOf('wrap.near', account);
    const received = nearAfter > nearBefore ? yoctoToNear(nearAfter - nearBefore) : yoctoToNear(BigInt(quote.amountOut || '0'));
    const rec = await recordFill(user, token, 'sell', sell, received, received * FEE_BPS / (10_000 - FEE_BPS), txHash, positionId);
    return { success: true, txHash, positionId: rec.positionId, tokensRaw: sell.toString(), nearReceived: received, priceNear: rec.priceNear };
  } catch (err: any) {
    logger.warn(`Intents sell of ${token} for ${user.id} failed: ${err?.message}`);
    return { success: false, reason: err?.message || 'NEAR Intents sell failed' };
  }
}

// ── Launchpad coins quoted in another token, through Rhea's DCL pools ─────────

/**
 * Buys a launchpad coin with NEAR along `path` (Rhea DCL pools from wNEAR to the coin, e.g. NEAR -> USDC ->
 * PRL -> coin): wrap, pay the 1.5% platform fee in wNEAR, and swap the rest, all in one transaction. The DCL
 * contract runs every hop in one call and refunds the wNEAR if the minimum is not met.
 */
export async function buyViaDclPath(user: UserRecord, token: string, path: string[], amountNear: number, slippagePct: number): Promise<IntentsTradeResult> {
  const account = user.subaccount_id;
  const slippage = Math.max(0.5, Math.min(50, slippagePct));
  try {
    const near = await signer(user);
    const amount = BigInt(Math.round(amountNear * 1e6)) * 10n ** 18n;
    const nativeBal = BigInt((await near.getNearBalance(account, 0).catch(() => '0')) || '0');
    if (nativeBal < amount + 50_000_000_000_000_000_000_000n) {
      return { success: false, reason: `Not enough NEAR: this buy needs ${amountNear} NEAR plus about 0.05 NEAR for fees.` };
    }
    const fee = (amount * BigInt(FEE_BPS)) / 10_000n;
    const swapIn = amount - fee;
    const q = await getNear().view<any>(DCL, 'quote', { pool_ids: path, input_token: 'wrap.near', output_token: token, input_amount: swapIn.toString(), tag: null });
    const expected = BigInt(q?.amount || '0');
    if (expected <= 0n) return { success: false, reason: 'The Rhea pools quoted nothing for this buy. Nothing was spent.' };
    const min = (expected * BigInt(Math.round((100 - slippage) * 100))) / 10_000n;

    // The wallet receives the coin, and the treasury the fee: both must be registered
    const registerCoin = await storageActions(token, [account]);
    if (registerCoin.length) await send(near, account, token, registerCoin);
    const before = await balanceOf(token, account);
    const txHash = await send(near, account, 'wrap.near', [
      ...(await storageActions('wrap.near', [account, TREASURY_ACCOUNT_ID])),
      transactions.functionCall('near_deposit', {}, 10n * TGAS, amount),
      transactions.functionCall('ft_transfer', { receiver_id: TREASURY_ACCOUNT_ID, amount: fee.toString() }, 15n * TGAS, 1n),
      transactions.functionCall('ft_transfer_call', {
        receiver_id: DCL,
        amount: swapIn.toString(),
        msg: JSON.stringify({ Swap: { pool_ids: path, output_token: token, min_output_amount: min.toString() } }),
      }, 200n * TGAS, 1n),
    ]);
    const got = (await balanceOf(token, account)) - before;
    if (got <= 0n) {
      return { success: false, txHash, reason: 'The price moved past your slippage limit, so the swap did not fill. Your NEAR came back as wNEAR in your wallet.' };
    }
    const rec = await recordFill(user, token, 'buy', got, amountNear, amountNear * FEE_BPS / 10_000, txHash);
    return { success: true, txHash, positionId: rec.positionId, tokensRaw: got.toString(), nearSpent: amountNear, priceNear: rec.priceNear };
  } catch (err: any) {
    logger.warn(`DCL path buy of ${token} for ${user.id} failed: ${err?.message}`);
    return { success: false, reason: err?.message || 'Buy failed' };
  }
}

/** Sells a launchpad coin back to NEAR along the reversed path, then pays the 1.5% fee from the wNEAR received */
export async function sellViaDclPath(user: UserRecord, token: string, path: string[], amountRaw: bigint, slippagePct: number, positionId?: string): Promise<IntentsTradeResult> {
  const account = user.subaccount_id;
  const slippage = Math.max(0.5, Math.min(50, slippagePct));
  try {
    const near = await signer(user);
    const held = await balanceOf(token, account);
    const sell = amountRaw > held ? held : amountRaw;
    if (sell <= 0n) return { success: false, reason: 'Nothing left in your wallet to sell.' };
    const back = [...path].reverse();
    const q = await getNear().view<any>(DCL, 'quote', { pool_ids: back, input_token: token, output_token: 'wrap.near', input_amount: sell.toString(), tag: null });
    const expected = BigInt(q?.amount || '0');
    if (expected <= 0n) return { success: false, reason: 'The Rhea pools quoted nothing for this sale. Nothing was sold.' };
    const min = (expected * BigInt(Math.round((100 - slippage) * 100))) / 10_000n;

    const registerNear = await storageActions('wrap.near', [account]);
    if (registerNear.length) await send(near, account, 'wrap.near', registerNear);
    const before = await balanceOf('wrap.near', account);
    const txHash = await send(near, account, token, [
      transactions.functionCall('ft_transfer_call', {
        receiver_id: DCL,
        amount: sell.toString(),
        msg: JSON.stringify({ Swap: { pool_ids: back, output_token: 'wrap.near', min_output_amount: min.toString() } }),
      }, 200n * TGAS, 1n),
    ]);
    const got = (await balanceOf('wrap.near', account)) - before;
    if (got <= 0n) return { success: false, txHash, reason: 'The price moved past your slippage limit, so nothing was sold.' };
    const fee = (got * BigInt(FEE_BPS)) / 10_000n;
    await send(near, account, 'wrap.near', [
      ...(await storageActions('wrap.near', [TREASURY_ACCOUNT_ID])),
      transactions.functionCall('ft_transfer', { receiver_id: TREASURY_ACCOUNT_ID, amount: fee.toString() }, 15n * TGAS, 1n),
    ]).catch((err: any) => logger.warn(`Sell fee not paid for ${user.id}: ${err?.message}`));
    const received = yoctoToNear(got - fee);
    const rec = await recordFill(user, token, 'sell', sell, received, yoctoToNear(fee), txHash, positionId);
    return { success: true, txHash, positionId: rec.positionId, tokensRaw: sell.toString(), nearReceived: received, priceNear: rec.priceNear };
  } catch (err: any) {
    logger.warn(`DCL path sell of ${token} for ${user.id} failed: ${err?.message}`);
    return { success: false, reason: err?.message || 'Sell failed' };
  }
}
