/**
 * Solana Copy Trading & Wallet Tracker
 *
 * NEAR copy trading reads the block stream. Solana has far too many blocks for
 * that, so this module polls ONLY the wallets that users follow:
 *
 *  1. getSignaturesForAddress(wallet, until: last seen) on the FREE RPC
 *     endpoints (never the paid QuickNode RPC, so no credits are used).
 *  2. For each new successful signature, getTransaction (jsonParsed) and read
 *     the wallet's own balance changes:
 *       - BUY  = one token went up while SOL / WSOL / USDC / USDT went down
 *       - SELL = one token went down while SOL / WSOL / USDC / USDT went up
 *     This works for every venue (pump.fun curve, PumpSwap, Raydium, Meteora,
 *     Orca, Jupiter and other aggregators) without decoding each program.
 *     Plain transfers do not match because no quote asset moves the other way
 *     (small thresholds filter out token-account rent).
 *  3. Followers in tracker mode get an alert; auto-copy followers get a buy
 *     with their SOL size, or a sell of the SAME PERCENT the leader sold.
 *
 * Copies of trades older than SOLANA_COPY_MAX_AGE_MS are skipped so a restart
 * or RPC hiccup never buys late. Alerts tolerate a longer delay.
 */

import {
  createRedis,
  CHANNELS,
  createLogger,
  isSolanaAddress,
  solanaRpc,
  getSolanaTokenInfo,
  getSolanaTokenBalance,
  getSolUsdPrice,
  getNearUsdPrice,
  solToLamports,
  SOL_MINT,
  type SwapEvent,
} from '@racerbot/shared';
import {
  getAllActiveCopyTargetWallets,
  getCopyTargetFollowersByWallet,
  recordCopyTradeFill,
  updateCopyTradeFillResult,
  getCopyTradeDailySpend,
  getUserById,
  getUserBySolanaAddress,
  type CopyTradeTargetRecord,
} from '@racerbot/db';

const logger = createLogger('solana-copy');
const REDIS_URL = process.env.REDIS_URL!;
const redis = createRedis(REDIS_URL);

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const QUOTE_MINTS = new Set([SOL_MINT, USDC_MINT, USDT_MINT]);

/** Minimum SOL moved (beyond the network fee) to count as a trade. Above token-account rent (~0.00204 SOL). */
const MIN_SOL_MOVE_LAMPORTS = 3_000_000n;
/** Minimum stablecoin moved to count as a trade (6 decimals → $0.50). */
const MIN_STABLE_MOVE = 500_000n;

const MAX_COPY_AGE_MS = Number(process.env.SOLANA_COPY_MAX_AGE_MS || 90_000);
const MAX_ALERT_AGE_MS = 10 * 60_000;
const RPC_MIN_GAP_MS = Math.max(100, Math.round(1000 / Number(process.env.SOLANA_COPY_RPC_RPS || 4)));
const MIN_POLL_MS = 3000;
const WALLET_REFRESH_MS = 30_000;

// ── Free-RPC pacing (shared by every call in this module) ───────────────────

let nextRpcAt = 0;
async function rpc<T = any>(method: string, params: any[]): Promise<T> {
  const now = Date.now();
  const wait = Math.max(0, nextRpcAt - now);
  nextRpcAt = Math.max(now, nextRpcAt) + RPC_MIN_GAP_MS;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  return solanaRpc<T>(method, params, { timeoutMs: 8000, allowPaid: false });
}

/**
 * Mainnet now carries both v0 and v1 transactions (many Jupiter and bot swaps
 * are v1). Ask for v1 support; if an endpoint does not know v1 yet, fall back
 * to v0 so at least v0 trades are still read.
 */
let txVersionSupport = 1;
async function getParsedTransaction(signature: string): Promise<any> {
  try {
    return await rpc<any>('getTransaction', [
      signature,
      { encoding: 'jsonParsed', maxSupportedTransactionVersion: txVersionSupport, commitment: 'confirmed' },
    ]);
  } catch (err: any) {
    if (txVersionSupport === 1 && /maxSupportedTransactionVersion|invalid/i.test(String(err?.message))) {
      txVersionSupport = 0;
      return getParsedTransaction(signature);
    }
    throw err;
  }
}

// ── Parsing ─────────────────────────────────────────────────────────────────

export interface SolanaDetectedSwap {
  side: 'buy' | 'sell';
  mint: string;
  /** Leader's token amount bought or sold (raw). */
  tokenRaw: bigint;
  /** Leader's balance of the token before the trade (raw), for proportional sells. */
  preTokenRaw: bigint;
  /** SOL spent (buy) or received (sell) by the leader, lamports, network fee excluded. Stable-quoted trades report 0. */
  solLamports: bigint;
  quote: 'SOL' | 'USDC' | 'USDT';
}

/**
 * Reads one jsonParsed transaction and returns the wallet's swap, or null when
 * the transaction is not a single-token swap against SOL or a stablecoin.
 * Exported for unit tests.
 */
export function parseSolanaSwap(tx: any, wallet: string): SolanaDetectedSwap | null {
  if (!tx?.meta || tx.meta.err) return null;
  const keys: any[] = tx.transaction?.message?.accountKeys || [];
  const keyOf = (k: any) => (typeof k === 'string' ? k : k?.pubkey);
  const idx = keys.findIndex((k) => keyOf(k) === wallet);
  if (idx < 0) return null;

  let solDelta = BigInt(tx.meta.postBalances?.[idx] ?? 0) - BigInt(tx.meta.preBalances?.[idx] ?? 0);
  if (idx === 0) solDelta += BigInt(tx.meta.fee ?? 0); // fee payer: add the network fee back

  const pre = new Map<string, bigint>();
  const post = new Map<string, bigint>();
  for (const b of tx.meta.preTokenBalances || []) {
    if (b?.owner !== wallet) continue;
    pre.set(b.mint, (pre.get(b.mint) ?? 0n) + BigInt(b.uiTokenAmount?.amount ?? '0'));
  }
  for (const b of tx.meta.postTokenBalances || []) {
    if (b?.owner !== wallet) continue;
    post.set(b.mint, (post.get(b.mint) ?? 0n) + BigInt(b.uiTokenAmount?.amount ?? '0'));
  }
  const mints = new Set([...pre.keys(), ...post.keys()]);
  const delta = (m: string) => (post.get(m) ?? 0n) - (pre.get(m) ?? 0n);

  // Wrapped SOL counts as SOL.
  if (mints.has(SOL_MINT)) solDelta += delta(SOL_MINT);
  const usdc = mints.has(USDC_MINT) ? delta(USDC_MINT) : 0n;
  const usdt = mints.has(USDT_MINT) ? delta(USDT_MINT) : 0n;

  const moved = [...mints].filter((m) => !QUOTE_MINTS.has(m) && delta(m) !== 0n);
  if (moved.length !== 1) return null; // no token, or a token-to-token swap
  const mint = moved[0];
  const d = delta(mint);

  if (d > 0n) {
    let quote: SolanaDetectedSwap['quote'] | null = null;
    if (solDelta <= -MIN_SOL_MOVE_LAMPORTS) quote = 'SOL';
    else if (usdc <= -MIN_STABLE_MOVE) quote = 'USDC';
    else if (usdt <= -MIN_STABLE_MOVE) quote = 'USDT';
    if (!quote) return null;
    return { side: 'buy', mint, tokenRaw: d, preTokenRaw: pre.get(mint) ?? 0n, solLamports: quote === 'SOL' ? -solDelta : 0n, quote };
  }
  let quote: SolanaDetectedSwap['quote'] | null = null;
  if (solDelta >= MIN_SOL_MOVE_LAMPORTS) quote = 'SOL';
  else if (usdc >= MIN_STABLE_MOVE) quote = 'USDC';
  else if (usdt >= MIN_STABLE_MOVE) quote = 'USDT';
  if (!quote) return null;
  return { side: 'sell', mint, tokenRaw: -d, preTokenRaw: pre.get(mint) ?? 0n, solLamports: quote === 'SOL' ? solDelta : 0n, quote };
}

// ── Wallet polling ──────────────────────────────────────────────────────────

interface WalletState {
  cursor: string | null; // newest signature already handled
  nextPollAt: number;
}

const wallets = new Map<string, WalletState>();

async function refreshWallets(): Promise<void> {
  try {
    const list = (await getAllActiveCopyTargetWallets()).map((w) => w.trim()).filter((w) => isSolanaAddress(w));
    const keep = new Set(list);
    for (const w of [...wallets.keys()]) if (!keep.has(w)) wallets.delete(w);
    for (const w of list) if (!wallets.has(w)) wallets.set(w, { cursor: null, nextPollAt: 0 });
  } catch (err) {
    logger.warn('Failed to refresh Solana copy wallets', { error: (err as Error).message });
  }
}

function pollIntervalMs(): number {
  // Two calls per wallet per round at most (signatures + usually 0-1 tx), spaced by the RPC gap.
  return Math.max(MIN_POLL_MS, wallets.size * RPC_MIN_GAP_MS * 2);
}

async function pollWallet(wallet: string, state: WalletState): Promise<void> {
  const sigs = await rpc<any[]>('getSignaturesForAddress', [
    wallet,
    { limit: state.cursor ? 15 : 1, commitment: 'confirmed', ...(state.cursor ? { until: state.cursor } : {}) },
  ]);
  if (!Array.isArray(sigs) || sigs.length === 0) return;
  const newest = sigs[0].signature as string;
  if (!state.cursor) {
    // First sight of this wallet: start from now, never replay history.
    state.cursor = newest;
    return;
  }

  // Oldest first so buys are copied before a later sell of the same token.
  for (const s of [...sigs].reverse()) {
    if (s.err) {
      state.cursor = s.signature;
      continue;
    }
    const ageMs = s.blockTime ? Date.now() - s.blockTime * 1000 : 0;
    if (ageMs > MAX_ALERT_AGE_MS) {
      state.cursor = s.signature;
      continue;
    }
    try {
      const tx = await getParsedTransaction(s.signature);
      if (!tx) {
        logger.warn('Solana copy transaction is not available yet; will retry', { wallet, sig: s.signature });
        break;
      }
      const swap = parseSolanaSwap(tx, wallet);
      if (swap) await dispatchSwap(wallet, swap, s.signature, ageMs);
      state.cursor = s.signature;
    } catch (err) {
      logger.warn('Solana copy tx read failed', { wallet, sig: s.signature, error: (err as Error).message });
      break;
    }
  }
}

async function dispatchSwap(wallet: string, swap: SolanaDetectedSwap, sig: string, ageMs: number): Promise<void> {
  logger.info('Solana copy-trade event', { wallet, side: swap.side, mint: swap.mint, sig, ageMs });
  const followers = await getCopyTargetFollowersByWallet(wallet).catch(() => [] as CopyTradeTargetRecord[]);
  await Promise.all(
    followers.map(async (target) => {
      try {
        if (target.track_only) {
          await sendTrackerAlert(target, wallet, swap, sig);
        } else if (ageMs > MAX_COPY_AGE_MS) {
          logger.info('Solana copy skipped: trade too old', { copyTargetId: target.id, ageMs });
        } else if (swap.side === 'buy') {
          await copyBuy(target, wallet, swap, sig);
        } else if (target.copy_sells) {
          await copySell(target, wallet, swap, sig);
        }
      } catch (err) {
        logger.error('Solana copy-trade execution error', err as Error, { copyTargetId: target.id, side: swap.side });
      }
    }),
  );
}

// ── Actions ─────────────────────────────────────────────────────────────────

function fmtSol(lamports: bigint): string {
  return (Number(lamports) / 1e9).toFixed(3);
}

async function notify(userId: string, event: string, data: Record<string, unknown>): Promise<void> {
  await redis.publish(CHANNELS.NOTIFY_USER, JSON.stringify({
    type: 'notify_user',
    telegram_id: 0,
    event,
    data: { user_id: userId, ...data },
  }));
}

async function sendTrackerAlert(target: CopyTradeTargetRecord, leader: string, swap: SolanaDetectedSwap, sig: string): Promise<void> {
  const fill = await recordCopyTradeFill({
    copy_target_id: target.id,
    user_id: target.user_id,
    source_tx_hash: sig,
    token_address: swap.mint,
    side: swap.side,
  });
  if (!fill) return;
  await updateCopyTradeFillResult(fill.id, 'filled', { amount_near: 0 });

  const info = await getSolanaTokenInfo(swap.mint).catch(() => null);
  const symbol = info?.symbol || swap.mint.slice(0, 6);
  const isBuy = swap.side === 'buy';
  const size = swap.quote === 'SOL'
    ? `${fmtSol(swap.solLamports)} SOL`
    : `${swap.quote} trade`;
  const phase = info?.launchpad === 'pump.fun'
    ? (info.bondingPhase === 'prebonded' ? '\n🏪 *Venue*: pump.fun (bonding curve)' : '\n🏛 *Venue*: PumpSwap / DEX (bonded)')
    : '';
  const pct = !isBuy && swap.preTokenRaw > 0n ? ` (${Math.min(100, Number((swap.tokenRaw * 10000n) / swap.preTokenRaw) / 100).toFixed(0)}% of bag)` : '';
  const message =
    `🎯 *Wallet Tracker Alert* ◎ Solana\n\n` +
    `👤 *Tracked Wallet*: \`${leader}\`\n` +
    `${isBuy ? '🟢' : '🔴'} *Action*: ${isBuy ? 'BOUGHT' : 'SOLD'} *${symbol}* for ${size}${pct}` +
    `${phase}\n` +
    `🪙 *Mint*: \`${swap.mint}\`\n` +
    `🔗 [View Tx on Solscan](https://solscan.io/tx/${sig})\n\n` +
    `_Tap below to take action or view the token:_\n`;
  // Raw mint, not a short key: short keys only resolve inside the API process.
  // (buy_fixed:<44-char mint>:0.25 stays under Telegram's 64-byte limit.)
  const key = swap.mint;
  const inline_keyboard = isBuy
    ? [
        [
          { text: '⚡ Buy 0.1 SOL', callback_data: `buy_fixed:${key}:0.1` },
          { text: '⚡ Buy 0.25 SOL', callback_data: `buy_fixed:${key}:0.25` },
          { text: '⚡ Buy 0.5 SOL', callback_data: `buy_fixed:${key}:0.5` },
        ],
        [
          { text: '📊 View Token Card', callback_data: `token_refresh:${key}` },
          { text: '📈 Chart', url: `https://dexscreener.com/solana/${swap.mint}` },
        ],
      ]
    : [
        [
          { text: '📊 View Token & Holdings', callback_data: `token_refresh:${key}` },
          { text: '📈 Chart', url: `https://dexscreener.com/solana/${swap.mint}` },
        ],
      ];
  await notify(target.user_id, 'wallet_tracker_alert', {
    copy_target_id: target.id,
    leader_wallet: leader,
    token_address: swap.mint,
    token_symbol: symbol,
    side: swap.side,
    source_tx_hash: sig,
    message,
    reply_markup: { inline_keyboard },
  });
}

async function copyBuy(target: CopyTradeTargetRecord, leader: string, swap: SolanaDetectedSwap, sig: string): Promise<void> {
  const fill = await recordCopyTradeFill({
    copy_target_id: target.id,
    user_id: target.user_id,
    source_tx_hash: sig,
    token_address: swap.mint,
    side: 'buy',
  });
  if (!fill) return;
  try {
    const amountSol = Number(target.buy_amount_near); // SOL for Solana targets
    if (target.max_daily_budget_near !== null) {
      const today = new Date().toISOString().slice(0, 10);
      const spent = await getCopyTradeDailySpend(target.id, today);
      if (spent + amountSol > Number(target.max_daily_budget_near)) {
        await updateCopyTradeFillResult(fill.id, 'skipped', {
          skip_reason: `Daily budget cap reached (${spent.toFixed(3)}/${target.max_daily_budget_near} SOL)`,
        });
        return;
      }
    }
    const user = await getUserById(target.user_id).catch(() => null);
    if (!user?.solana_address) {
      await updateCopyTradeFillResult(fill.id, 'failed', { skip_reason: 'Solana wallet not set up' });
      return;
    }
    const info = await getSolanaTokenInfo(swap.mint).catch(() => null);
    if (info && info.freezeAuthorityDisabled === false) {
      await updateCopyTradeFillResult(fill.id, 'skipped', { skip_reason: 'Freeze authority active (honeypot risk)' });
      await notify(target.user_id, 'auto_buy_skipped', { token: swap.mint, reason: 'honeypot_backdoor: freeze authority is active' });
      return;
    }
    const slippage = Math.max(Number(target.max_slippage_pct) || 5, info?.bondingPhase === 'prebonded' ? 10 : 3);
    const swapEvent: SwapEvent = {
      type: 'execute_swap',
      chain: 'solana',
      user_id: target.user_id,
      token_in: SOL_MINT,
      token_out: swap.mint,
      amount_in: solToLamports(amountSol).toString(),
      min_amount_out: '1',
      venue: 'jupiter',
      slippage_pct: slippage,
      timestamp: Date.now(),
      notify_user: false,
    };
    // Points and referral rewards are NEAR-denominated: convert by USD value. The executor awards
    // them, and marks the fill filled or failed, once the swap's outcome is known.
    const [solUsd, nearUsd] = await Promise.all([getSolUsdPrice(), getNearUsdPrice().catch(() => 0)]);
    const nearEquivalent = nearUsd > 0 ? (amountSol * solUsd) / nearUsd : 0;
    const leaderUser = await getUserBySolanaAddress(leader).catch(() => null);
    swapEvent.copy = {
      fill_id: fill.id,
      copier_user_id: target.user_id,
      token_address: swap.mint,
      points_volume_near: nearEquivalent,
      leader_user_id: leaderUser?.id ?? null,
      referrer_id: target.referrer_id ?? null,
    };
    await updateCopyTradeFillResult(fill.id, 'pending', { amount_near: amountSol });
    await redis.publish(CHANNELS.EXECUTE_SWAP, JSON.stringify(swapEvent));

    const symbol = info?.symbol || swap.mint.slice(0, 6);
    await notify(target.user_id, 'copy_trade_filled', {
      copy_target_id: target.id,
      leader_wallet: leader,
      token_address: swap.mint,
      token_symbol: symbol,
      amount_near: amountSol,
      source_tx_hash: sig,
      message:
        `🏎️ *Copy Trade Sent (BUY)* ◎ Solana\n\n` +
        `🎯 *Copied*: \`${leader}\`\n` +
        `🪙 *Token*: ${symbol}\n` +
        `💰 *Buying*: ${amountSol} SOL worth\n` +
        `🔗 [Source Tx on Solscan](https://solscan.io/tx/${sig})\n\n` +
        `_You will get a message if the swap fails. Use Holdings to manage the position._`,
    });
  } catch (err) {
    await updateCopyTradeFillResult(fill.id, 'failed', { skip_reason: (err as Error).message.slice(0, 200) }).catch(() => {});
    throw err;
  }
}

async function copySell(target: CopyTradeTargetRecord, leader: string, swap: SolanaDetectedSwap, sig: string): Promise<void> {
  const fill = await recordCopyTradeFill({
    copy_target_id: target.id,
    user_id: target.user_id,
    source_tx_hash: sig,
    token_address: swap.mint,
    side: 'sell',
  });
  if (!fill) return;
  try {
    const user = await getUserById(target.user_id).catch(() => null);
    if (!user?.solana_address) {
      await updateCopyTradeFillResult(fill.id, 'skipped', { skip_reason: 'Solana wallet not set up' });
      return;
    }
    const bal = await getSolanaTokenBalance(user.solana_address, swap.mint, true).catch(() => null);
    if (!bal || bal.raw <= 0n) {
      await updateCopyTradeFillResult(fill.id, 'skipped', { skip_reason: 'User holds no balance in token' });
      return;
    }
    // Mirror the leader: sell the same share of the bag (full exit at 98%+).
    let bps = swap.preTokenRaw > 0n ? Number((swap.tokenRaw * 10000n) / swap.preTokenRaw) : 10000;
    if (bps >= 9800 || bps <= 0) bps = 10000;
    const amount = bps === 10000 ? bal.raw : (bal.raw * BigInt(bps)) / 10000n;
    if (amount <= 0n) {
      await updateCopyTradeFillResult(fill.id, 'skipped', { skip_reason: 'Sell amount rounds to 0' });
      return;
    }
    const swapEvent: SwapEvent = {
      type: 'execute_swap',
      chain: 'solana',
      user_id: target.user_id,
      token_in: swap.mint,
      token_out: SOL_MINT,
      amount_in: amount.toString(),
      min_amount_out: '1',
      venue: 'jupiter',
      slippage_pct: Math.max(Number(target.max_slippage_pct) || 5, 5),
      timestamp: Date.now(),
      notify_user: false,
    };
    swapEvent.copy = { fill_id: fill.id, copier_user_id: target.user_id, token_address: swap.mint, points_volume_near: 0 };
    await redis.publish(CHANNELS.EXECUTE_SWAP, JSON.stringify(swapEvent));

    const info = await getSolanaTokenInfo(swap.mint).catch(() => null);
    const symbol = info?.symbol || swap.mint.slice(0, 6);
    await notify(target.user_id, 'copy_trade_filled', {
      copy_target_id: target.id,
      leader_wallet: leader,
      token_address: swap.mint,
      token_symbol: symbol,
      source_tx_hash: sig,
      message:
        `🏎️ *Copy Trade Sent (SELL)* ◎ Solana\n\n` +
        `🎯 *Copied*: \`${leader}\`\n` +
        `🪙 *Token*: ${symbol}\n` +
        `🔴 *Action*: Selling ${(bps / 100).toFixed(0)}% of your holdings\n` +
        `🔗 [Source Tx on Solscan](https://solscan.io/tx/${sig})\n\n` +
        `_You will get a message if the swap fails._`,
    });
  } catch (err) {
    await updateCopyTradeFillResult(fill.id, 'failed', { skip_reason: (err as Error).message.slice(0, 200) }).catch(() => {});
    throw err;
  }
}

// ── Main loop ───────────────────────────────────────────────────────────────

export async function startSolanaCopyTrader(): Promise<void> {
  await refreshWallets();
  setInterval(() => void refreshWallets(), WALLET_REFRESH_MS);
  try {
    const sub = createRedis(REDIS_URL);
    await sub.subscribe('racerbot:refresh_tracked_wallets', async () => {
      await refreshWallets();
    });
  } catch { /* the 30s refresh still runs */ }

  logger.info('Solana copy-trade watcher started', { wallets: wallets.size, rpcGapMs: RPC_MIN_GAP_MS });

  void (async () => {
    for (;;) {
      const now = Date.now();
      let polled = 0;
      for (const [wallet, state] of wallets) {
        if (now < state.nextPollAt) continue;
        state.nextPollAt = now + pollIntervalMs();
        polled++;
        await pollWallet(wallet, state).catch((err) =>
          logger.warn('Solana copy poll failed', { wallet, error: (err as Error).message }),
        );
      }
      await new Promise((r) => setTimeout(r, polled === 0 ? 500 : 50));
    }
  })();
}
