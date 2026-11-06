/**
 * Venue-agnostic copy-trade detection from a leader's own balance changes.
 *
 * The argument parser in copyTrade.ts reads known venue messages and fires instantly; anything it
 * cannot read (aggregators, routers, new launchpads) is caught here. For every transaction signed
 * by a tracked wallet we add up what moved in and out of that wallet: NEP-141 ft_transfer / ft_mint
 * / ft_burn events, attached NEAR deposits and incoming NEAR transfers. Once the transaction has
 * been quiet for a few seconds it is a BUY if NEAR (native or wNEAR) went out and exactly one token
 * came in, and a SELL if a token went out and NEAR came in. Plain transfers, airdrops, failed
 * receipts and gas refunds never qualify.
 */
import type { DetectedSwap } from './copyTrade.js';

const NEAR_LIKE = new Set(['wrap.near', 'near']);
/** Smallest NEAR movement that counts as a trade (ignores storage deposits and dust) */
export const MIN_TRADE_YOCTO = 10n ** 22n; // 0.01 NEAR
/** A transaction is judged once no receipt of it has been seen for this long */
export const QUIET_MS = 6_000;
/** Give up on transactions still open after this long */
const MAX_AGE_MS = 120_000;

interface Flow {
  wallet: string;
  txHash: string;
  near: bigint;
  tokens: Map<string, bigint>;
  firstSeen: number;
  lastSeen: number;
}

const flows = new Map<string, Flow>();

function add(map: Map<string, bigint>, key: string, delta: bigint): void {
  map.set(key, (map.get(key) ?? 0n) + delta);
}

function big(v: unknown): bigint {
  try { return BigInt(String(v ?? '0')); } catch { return 0n; }
}

/**
 * Record one receipt execution outcome from a neardata block (`shards[].receipt_execution_outcomes[]`).
 * Only transactions signed by a tracked wallet are kept.
 */
export function observeReceipt(item: any, isTracked: (wallet: string) => boolean, now = Date.now()): void {
  const action = item?.receipt?.receipt?.Action;
  const signer: string = String(action?.signer_id ?? '').trim().toLowerCase();
  const txHash: string = item?.tx_hash ?? '';
  if (!signer || !txHash || !isTracked(signer)) return;
  // A failed receipt moved nothing: its deposit comes back in a system refund, which is ignored too
  const status = item?.execution_outcome?.outcome?.status;
  if (status && typeof status === 'object' && 'Failure' in status) return;

  const predecessor: string = String(item?.receipt?.predecessor_id ?? '').toLowerCase();
  const receiver: string = String(item?.receipt?.receiver_id ?? '').toLowerCase();
  const key = `${txHash}|${signer}`;
  let flow = flows.get(key);
  if (!flow) {
    flow = { wallet: signer, txHash, near: 0n, tokens: new Map(), firstSeen: now, lastSeen: now };
    flows.set(key, flow);
  }
  flow.lastSeen = now;

  // Native NEAR the leader attached to calls or sent out
  if (predecessor === signer && receiver !== signer) {
    for (const a of action?.actions ?? []) {
      flow.near -= big(a?.FunctionCall?.deposit ?? a?.Transfer?.deposit);
    }
  }
  // Native NEAR paid to the leader by a contract (gas refunds come from "system" and are skipped)
  if (receiver === signer && predecessor !== signer && predecessor !== 'system') {
    for (const a of action?.actions ?? []) {
      if (a?.Transfer) flow.near += big(a.Transfer.deposit);
    }
  }

  // Token movements from NEP-141 events emitted by the token contract (the receipt's receiver)
  // Also handles wrap.near and legacy NEP-141 plain-text logs ("Transfer X from A to B", "Deposit X NEAR to A", "Withdraw X NEAR from A")
  const credit = (amount: unknown, sign: 1n | -1n) => {
    const delta = big(amount) * sign;
    if (NEAR_LIKE.has(receiver)) flow!.near += delta;
    else add(flow!.tokens, receiver, delta);
  };
  for (const log of item?.execution_outcome?.outcome?.logs ?? []) {
    if (typeof log !== 'string') continue;
    if (log.startsWith('EVENT_JSON:')) {
      let ev: any;
      try { ev = JSON.parse(log.slice('EVENT_JSON:'.length)); } catch { continue; }
      if (ev?.standard !== 'nep141' || !Array.isArray(ev?.data)) continue;
      for (const d of ev.data) {
        const from = String(d?.old_owner_id ?? '').toLowerCase();
        const to = String(d?.new_owner_id ?? '').toLowerCase();
        const owner = String(d?.owner_id ?? '').toLowerCase();
        if (ev.event === 'ft_transfer') {
          if (to === signer && from !== signer) credit(d.amount, 1n);
          if (from === signer && to !== signer) credit(d.amount, -1n);
        } else if (ev.event === 'ft_mint' && owner === signer) {
          credit(d.amount, 1n);
        } else if (ev.event === 'ft_burn' && owner === signer) {
          credit(d.amount, -1n);
        }
      }
      continue;
    }

    const trimmed = log.trim();
    const transferMatch = /^Transfer (\d+) from ([^\s]+) to ([^\s]+)$/.exec(trimmed);
    if (transferMatch) {
      const [, amt, rawFrom, rawTo] = transferMatch;
      const from = rawFrom.toLowerCase();
      const to = rawTo.toLowerCase();
      if (to === signer && from !== signer) credit(amt, 1n);
      if (from === signer && to !== signer) credit(amt, -1n);
      continue;
    }

    if (NEAR_LIKE.has(receiver)) {
      const depositMatch = /^Deposit (\d+) NEAR to ([^\s]+)$/.exec(trimmed);
      if (depositMatch && depositMatch[2].toLowerCase() === signer) {
        credit(depositMatch[1], 1n);
        continue;
      }
      const withdrawMatch = /^Withdraw (\d+) NEAR from ([^\s]+)$/.exec(trimmed);
      if (withdrawMatch && withdrawMatch[2].toLowerCase() === signer) {
        credit(withdrawMatch[1], -1n);
        continue;
      }
    }
  }
}

/** What a finished transaction amounts to for its signer, if it was a trade */
export function classifyFlow(near: bigint, tokens: Map<string, bigint>): DetectedSwap | null {
  const gained = [...tokens].filter(([, d]) => d > 0n);
  const spent = [...tokens].filter(([, d]) => d < 0n);
  if (near <= -MIN_TRADE_YOCTO && gained.length === 1 && spent.length === 0) {
    const [token] = gained[0];
    return { side: 'buy', tokenAddress: token, tokenIn: 'wrap.near', tokenOut: token, amountIn: (-near).toString() };
  }
  if (near >= MIN_TRADE_YOCTO && spent.length === 1 && gained.length === 0) {
    const [token, amount] = spent[0];
    return { side: 'sell', tokenAddress: token, tokenIn: token, tokenOut: 'wrap.near', amountIn: (-amount).toString() };
  }
  return null;
}

/** Judge transactions that have gone quiet; returns the trades found (and forgets those transactions) */
export function flushFlows(now = Date.now()): { wallet: string; txHash: string; swap: DetectedSwap }[] {
  const found: { wallet: string; txHash: string; swap: DetectedSwap }[] = [];
  for (const [key, f] of flows) {
    const quiet = now - f.lastSeen >= QUIET_MS;
    if (!quiet && now - f.firstSeen < MAX_AGE_MS) continue;
    flows.delete(key);
    const swap = classifyFlow(f.near, f.tokens);
    if (swap) found.push({ wallet: f.wallet, txHash: f.txHash, swap });
  }
  return found;
}

/** Test helper */
export function _resetFlows(): void {
  flows.clear();
}
