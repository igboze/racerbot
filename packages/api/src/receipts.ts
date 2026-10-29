import { createLogger, getNear } from '@racerbot/shared';
import {
  expireUnsentVaultIntents,
  getUserVaultIntents,
  listPendingVaultIntents,
  markVaultIntentChecked,
  updateVaultIntentStatus,
  type RacerVaultIntentRecord,
} from '@racerbot/db';
import { getVaultBalance, RACER_VAULT_CONTRACT_ID } from './racerVault.js';
import { describeOutcome, parseRouterOutcome, type RouterEvent } from './routerEvents.js';

const logger = createLogger('receipts');

const NEAR_TOKENS = new Set(['near', 'wrap.near']);

export interface TokenInfo {
  id: string;
  symbol: string;
  decimals: number;
}

export interface TradeReceipt {
  id: string;
  createdAt: string;
  side: 'BUY' | 'SELL';
  status: RacerVaultIntentRecord['status'];
  venue: string;
  token: TokenInfo;
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  amountIn: string;
  minAmountOut: string;
  netOut?: string;
  fee?: string;
  feeBps: number;
  payoutToken?: string;
  payoutAmount?: string;
  refundedAmount?: string;
  consumedAmount?: string;
  reason?: string;
  txHash?: string;
  signerId: string;
  events: RouterEvent[];
}

export interface VaultBalance {
  token: TokenInfo;
  raw: string;
}

const tokenInfoCache = new Map<string, TokenInfo>();

async function tokenInfo(id: string): Promise<TokenInfo> {
  if (NEAR_TOKENS.has(id)) return { id, symbol: id === 'near' ? 'NEAR' : 'wNEAR', decimals: 24 };
  const cached = tokenInfoCache.get(id);
  if (cached) return cached;
  const meta = await getNear().getTokenMetadata(id).catch(() => null);
  const info = { id, symbol: meta?.symbol || id.split('.')[0].toUpperCase(), decimals: meta?.decimals ?? 18 };
  if (meta) tokenInfoCache.set(id, info);
  return info;
}

async function toReceipt(r: RacerVaultIntentRecord): Promise<TradeReceipt> {
  const isBuy = NEAR_TOKENS.has(r.token_in);
  const [tIn, tOut] = await Promise.all([tokenInfo(r.token_in), tokenInfo(r.token_out)]);
  return {
    id: r.correlation_id,
    createdAt: r.created_at.toISOString(),
    side: isBuy ? 'BUY' : 'SELL',
    status: r.status,
    venue: r.venue,
    token: isBuy ? tOut : tIn,
    tokenIn: tIn,
    tokenOut: tOut,
    amountIn: String(r.amount_in),
    minAmountOut: String(r.min_amount_out),
    netOut: r.amount_out != null ? String(r.amount_out) : undefined,
    fee: r.fee_amount != null ? String(r.fee_amount) : undefined,
    feeBps: r.fee_bps,
    payoutToken: r.payout_token,
    payoutAmount: r.payout_amount != null ? String(r.payout_amount) : undefined,
    refundedAmount: r.refunded_amount != null ? String(r.refunded_amount) : undefined,
    consumedAmount: r.consumed_amount != null ? String(r.consumed_amount) : undefined,
    reason: r.failure_reason,
    txHash: r.tx_hash,
    signerId: r.account_id,
    events: r.events || [],
  };
}

/** A user's private trades (newest first) and every non-zero balance they hold in the router vault. */
export async function getReceiptsAndVault(accountId: string, limit = 50): Promise<{
  router: string;
  accountId: string;
  receipts: TradeReceipt[];
  balances: VaultBalance[];
}> {
  const intents = await getUserVaultIntents(accountId, limit);
  // The vault cannot list a user's tokens, so check every token they have traded plus NEAR / wNEAR
  const tokens = new Set<string>(['near', 'wrap.near']);
  for (const i of intents) {
    tokens.add(i.token_in);
    tokens.add(i.token_out);
  }
  const [receipts, balances] = await Promise.all([
    Promise.all(intents.map(toReceipt)),
    Promise.all([...tokens].map(async (id) => ({ id, raw: await getVaultBalance(accountId, id).catch(() => '0') }))),
  ]);
  const held = await Promise.all(
    balances.filter(b => BigInt(b.raw || '0') > 0n).map(async (b) => ({ token: await tokenInfo(b.id), raw: b.raw }))
  );
  return { router: RACER_VAULT_CONTRACT_ID, accountId, receipts, balances: held };
}

/** Resolve a trade from its on-chain outcome (unresolved trades, and events for older ones). */
export async function recheckIntent(r: RacerVaultIntentRecord): Promise<boolean> {
  if (!r.tx_hash) return false;
  const outcome = await getNear().waitForOutcome(r.tx_hash, r.account_id, 4_000).catch(() => null);
  const parsed = outcome ? parseRouterOutcome(outcome) : null;
  if (!parsed || parsed.status === 'PENDING') {
    await markVaultIntentChecked(r.correlation_id);
    return false;
  }
  await updateVaultIntentStatus(r.correlation_id, {
    status: parsed.status,
    amount_out: parsed.netOut,
    fee_amount: parsed.fee,
    failure_reason: describeOutcome(parsed),
    events: parsed.events,
    payout_token: parsed.payoutToken,
    payout_amount: parsed.payoutAmount,
    refunded_amount: parsed.refundedAmount,
    consumed_amount: parsed.consumedAmount,
  });
  logger.info(`Receipt resolved: ${r.correlation_id} -> ${parsed.status} (tx ${r.tx_hash})`);
  return true;
}

/** Background job: resolve trades left PENDING (timeouts, restarts) and expire ones never sent. */
export function startReceiptReconciler(intervalMs = 30_000): NodeJS.Timeout {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const expired = await expireUnsentVaultIntents();
      if (expired > 0) logger.info(`Expired ${expired} trade(s) that were never sent on-chain`);
      for (const r of await listPendingVaultIntents(60, 20)) {
        await recheckIntent(r).catch((e: any) => logger.warn(`Re-check of ${r.correlation_id} failed: ${e?.message}`));
      }
    } catch (e: any) {
      logger.warn(`Receipt reconciler tick failed: ${e?.message}`);
    } finally {
      running = false;
    }
  };
  setTimeout(tick, 15_000);
  return setInterval(tick, intervalMs);
}
