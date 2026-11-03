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

async function dclSwap(near: any, from: string, poolId: string, input: string, output: string, amount: bigint, slippagePct: number): Promise<bigint> {
  const expected = await dclQuote(poolId, input, output, amount);
  if (expected <= 0n) throw new Error('The Rhea pool quoted nothing for this swap.');
  const min = (expected * BigInt(Math.round((100 - slippagePct) * 100))) / 10_000n;
  // The pool pays out to the sender, who must be registered on the output token
  const register = await storageActions(output, [from]);
  if (register.length) await send(near, from, output, register);
  const before = await balanceOf(output, from);
  await send(near, from, input, [
    transactions.functionCall('ft_transfer_call', {
      receiver_id: DCL,
      amount: amount.toString(),
      msg: JSON.stringify({ Swap: { pool_ids: [poolId], output_token: output, min_output_amount: min.toString() } }),
    }, 200n * TGAS, 1n),
  ]);
  const after = await balanceOf(output, from);
  return after > before ? after - before : 0n;
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

/** Buys `token` with `amountNear` NEAR through 1Click (and its DCL pool when the route has one) */
export async function buyViaIntents(user: UserRecord, token: string, route: IntentsRoute, amountNear: number, slippagePct: number): Promise<IntentsTradeResult> {
  const account = user.subaccount_id;
  const slippage = Math.max(0.5, Math.min(50, slippagePct));
  try {
    const near = await signer(user);
    const amount = BigInt(Math.round(amountNear * 1e6)) * 10n ** 18n;
    const nativeBal = BigInt((await near.getNearBalance(account, 0).catch(() => '0')) || '0');
    if (nativeBal < amount + 50_000_000_000_000_000_000_000n) {
      return { success: false, reason: `Not enough NEAR: this buy needs ${amountNear} NEAR plus about 0.05 NEAR for fees.` };
    }

    // Leg 1: NEAR -> quote (or the token itself) on 1Click, delivered to the user's wallet on NEAR
    const quoteAsset = await getIntentsNearAsset(route.quote);
    if (!quoteAsset) return { success: false, reason: 'NEAR Intents no longer lists this token.' };
    const quote = await quotePublicSwap({
      originAsset: 'nep141:wrap.near',
      destinationAsset: quoteAsset,
      amount: amount.toString(),
      recipient: account,
      refundTo: account,
      slippageBps: Math.round(slippage * 100),
      appFees: [{ recipient: TREASURY_ACCOUNT_ID, fee: FEE_BPS }],
    });
    // The wallet must be registered on what 1Click delivers, or the delivery fails
    const register = await storageActions(route.quote, [account]);
    if (register.length) await send(near, account, route.quote, register);

    const quoteBefore = await balanceOf(route.quote, account);
    const tokenBefore = await balanceOf(token, account);
    const txHash = await send(near, account, 'wrap.near', [
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
      tokensGot = await dclSwap(near, account, route.dclPoolId, route.quote, token, quoteGot, slippage);
      if (tokensGot <= 0n) {
        const now = (await balanceOf(token, account)) - tokenBefore;
        tokensGot = now > 0n ? now : 0n;
      }
      if (tokensGot <= 0n) throw new Error(`Bought ${route.quote} but the Rhea swap into the coin did not fill; your ${route.quote} is in your wallet.`);
    }

    // Record the position like any other NEAR buy (amounts raw, price in NEAR per whole token)
    const meta = await near.getTokenMetadata(token).catch(() => ({ decimals: 18 }));
    const decimals = meta?.decimals ?? 18;
    const spent = amountNear;
    const fee = spent * FEE_BPS / 10_000;
    const human = Number(tokensGot) / 10 ** decimals;
    const priceNear = human > 0 ? (spent - fee) / human : 0;
    const open = await getOpenPositions(user.id).catch(() => []);
    const position = open.find(p => p.token_address === token && (p.chain === 'near' || !p.chain))
      ?? await createPosition({ user_id: user.id, token_address: token, quantity_held: '0', avg_entry_price: '0' });
    const fill = await createFill({
      user_id: user.id, position_id: position.id, side: 'buy', token_address: token, amount: tokensGot.toString(),
      price: priceNear.toString(), fee_paid: fee.toString(), input_amount: spent.toString(), venue: 'intents' as any, tx_hash: txHash,
    });
    if (fill.inserted) await recordFee(fill.fillId, fee.toString()).catch(() => {});
    return { success: true, txHash, positionId: position.id, tokensRaw: tokensGot.toString(), nearSpent: spent, priceNear };
  } catch (err: any) {
    logger.warn(`Intents buy of ${token} for ${user.id} failed: ${err?.message}`);
    if (/No liquidity available/i.test(err?.message || '')) {
      return { success: false, reason: 'NEAR Intents has no liquidity for this token right now. Nothing was spent; try again later.' };
    }
    return { success: false, reason: err?.message || 'NEAR Intents buy failed' };
  }
}

/** Sells `amountRaw` of `token` for NEAR through its DCL pool (when the route has one) and 1Click */
export async function sellViaIntents(user: UserRecord, token: string, route: IntentsRoute, amountRaw: bigint, slippagePct: number, positionId?: string): Promise<IntentsTradeResult> {
  const account = user.subaccount_id;
  const slippage = Math.max(0.5, Math.min(50, slippagePct));
  try {
    const near = await signer(user);
    const held = await balanceOf(token, account);
    const sell = amountRaw > held ? held : amountRaw;
    if (sell <= 0n) return { success: false, reason: 'Nothing left in your wallet to sell.' };

    // Leg 1: token -> quote in its DCL pool
    let quoteAmount = sell;
    if (route.dclPoolId) {
      quoteAmount = await dclSwap(near, account, route.dclPoolId, token, route.quote, sell, slippage);
      if (quoteAmount <= 0n) throw new Error('The Rhea swap out of the coin did not fill. Nothing was sold.');
    }

    // Leg 2: quote -> NEAR on 1Click, delivered to the wallet
    const quoteAsset = await getIntentsNearAsset(route.quote);
    if (!quoteAsset) throw new Error('NEAR Intents no longer lists this token.');
    const quote = await quotePublicSwap({
      originAsset: quoteAsset,
      destinationAsset: 'nep141:wrap.near',
      amount: quoteAmount.toString(),
      recipient: account,
      refundTo: account,
      slippageBps: Math.round(slippage * 100),
      appFees: [{ recipient: TREASURY_ACCOUNT_ID, fee: FEE_BPS }],
    });
    const nearBefore = BigInt((await near.getNearBalance(account, 0).catch(() => '0')) || '0') + await balanceOf('wrap.near', account);
    const txHash = await send(near, account, route.quote, [
      ...(await storageActions(route.quote, [quote.depositAddress])),
      transactions.functionCall('ft_transfer', { receiver_id: quote.depositAddress, amount: quoteAmount.toString() }, 15n * TGAS, 1n),
    ]);
    await settle(quote.depositAddress, txHash);
    const nearAfter = BigInt((await near.getNearBalance(account, 0).catch(() => '0')) || '0') + await balanceOf('wrap.near', account);
    const received = nearAfter > nearBefore ? yoctoToNear(nearAfter - nearBefore) : yoctoToNear(BigInt(quote.amountOut || '0'));

    const meta = await near.getTokenMetadata(token).catch(() => ({ decimals: 18 }));
    const human = Number(sell) / 10 ** (meta?.decimals ?? 18);
    const fee = received * FEE_BPS / (10_000 - FEE_BPS);
    const priceNear = human > 0 ? received / human : 0;
    const open = positionId ? null : await getOpenPositions(user.id).catch(() => []);
    const posId = positionId ?? open?.find(p => p.token_address === token)?.id;
    if (posId) {
      const fill = await createFill({
        user_id: user.id, position_id: posId, side: 'sell', token_address: token, amount: sell.toString(),
        price: priceNear.toString(), fee_paid: fee.toString(), input_amount: received.toString(), venue: 'intents' as any, tx_hash: txHash,
      });
      if (fill.inserted) await recordFee(fill.fillId, fee.toString()).catch(() => {});
    }
    return { success: true, txHash, positionId: posId, tokensRaw: sell.toString(), nearReceived: received, priceNear };
  } catch (err: any) {
    logger.warn(`Intents sell of ${token} for ${user.id} failed: ${err?.message}`);
    return { success: false, reason: err?.message || 'NEAR Intents sell failed' };
  }
}
