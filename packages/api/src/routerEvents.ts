/**
 * Reads what the Racer router (racerbotrouter.near) recorded for a trade from its
 * NEP-297 `EVENT_JSON` logs. One parser for the live trade path, the background
 * re-check of pending trades, and the receipts shown to users.
 */

export const ROUTER_EVENT_STANDARD = 'racerbot-vault';

export interface RouterEvent {
  event: string;
  data: Record<string, any>;
}

export type TradeOutcomeStatus = 'SETTLED' | 'SLIPPAGE_REFUNDED' | 'FAILED' | 'PAYOUT_FAILED' | 'PENDING';

export interface ParsedRouterOutcome {
  status: TradeOutcomeStatus;
  events: RouterEvent[];
  /** Contract panic message when the whole transaction reverted. */
  reverted?: string;
  /** The router refused because another swap of the token was settling. */
  tokenBusy: boolean;
  grossOut?: string;
  netOut?: string;
  fee?: string;
  payoutToken?: string;
  payoutAmount?: string;
  refundedToken?: string;
  refundedAmount?: string;
  /** Input the venue kept on a failed swap (never re-credited by the router). */
  consumedAmount?: string;
  /** `swap_failed` reason code from the router. */
  failCode?: string;
  /** The venue kept input but the router could not measure its output. */
  unaccounted: boolean;
}

/** Router events from a transaction outcome, in execution order. */
export function extractRouterEvents(outcome: any): RouterEvent[] {
  const events: RouterEvent[] = [];
  for (const ro of outcome?.receipts_outcome || []) {
    for (const log of ro?.outcome?.logs || []) {
      if (typeof log !== 'string' || !log.startsWith('EVENT_JSON:')) continue;
      try {
        const ev = JSON.parse(log.slice('EVENT_JSON:'.length));
        if (ev?.standard === ROUTER_EVENT_STANDARD && typeof ev.event === 'string') {
          events.push({ event: ev.event, data: ev.data ?? {} });
        }
      } catch {}
    }
  }
  return events;
}

export function parseRouterOutcome(outcome: any): ParsedRouterOutcome {
  const events = extractRouterEvents(outcome);
  const failure = outcome?.status && typeof outcome.status === 'object' && 'Failure' in outcome.status
    ? JSON.stringify(outcome.status.Failure)
    : '';
  const reverted = failure ? (failure.match(/Smart contract panicked: ([^"\\]+)/)?.[1] ?? 'transaction failed') : undefined;
  const find = (name: string) => events.find(e => e.event === name);

  const settled = find('swap_settled');
  const slippage = find('slippage_refund');
  const paid = find('payout_completed');
  const payoutFailed = find('payout_failed') ?? find('withdraw_failed');
  const swapFailed = find('swap_failed');

  const parsed: ParsedRouterOutcome = {
    status: 'FAILED',
    events,
    reverted: find('intent_submitted') ? undefined : reverted,
    tokenBusy: /Token busy/.test(failure),
    grossOut: settled?.data.gross ?? slippage?.data.got,
    netOut: settled?.data.net ?? slippage?.data.got,
    fee: settled?.data.fee ?? (slippage ? '0' : undefined),
    payoutToken: paid?.data.token ?? payoutFailed?.data.token,
    payoutAmount: paid?.data.amount ?? payoutFailed?.data.amount,
    refundedToken: swapFailed?.data.refunded_token,
    refundedAmount: swapFailed?.data.refunded_amount,
    consumedAmount: swapFailed?.data.consumed_amount,
    failCode: swapFailed?.data.reason,
    unaccounted: Boolean(find('unaccounted_output')),
  };

  if (payoutFailed) parsed.status = 'PAYOUT_FAILED';
  else if ((settled || slippage) && paid) parsed.status = settled ? 'SETTLED' : 'SLIPPAGE_REFUNDED';
  else if (swapFailed || parsed.reverted) parsed.status = 'FAILED';
  // Submitted but no outcome event yet: the receipt chain is still executing
  else if (find('intent_submitted')) parsed.status = 'PENDING';

  return parsed;
}

/** Plain-language explanation of a trade that did not deliver, for users and receipts. */
export function describeOutcome(p: ParsedRouterOutcome): string | undefined {
  if (p.status === 'SLIPPAGE_REFUNDED') {
    return 'Price moved past your slippage limit: the tokens received were delivered with no fee.';
  }
  if (p.status === 'PAYOUT_FAILED') {
    return 'The swap filled but the transfer to your account failed; the tokens were credited to your vault balance.';
  }
  if (p.status === 'PENDING') return 'The trade is still settling on-chain.';
  if (p.status !== 'FAILED') return undefined;
  if (p.unaccounted) {
    return 'The exchange took the input but its output could not be measured by the router. It is flagged for reconciliation; contact support with this transaction hash.';
  }
  switch (p.failCode) {
    case 'venue_refunded_input':
      return 'The exchange rejected the swap (price moved past your slippage limit, or not enough liquidity) and returned your tokens. Nothing was lost; try again or raise slippage.';
    case 'zero_tokens_received':
      return 'No tokens came back from the exchange; any unused input was returned to your vault balance.';
    case 'venue_reverted':
      return 'The exchange call failed and your input was returned to your vault balance.';
    case undefined:
      break;
    default:
      return `The swap failed (${p.failCode}); unused input was returned to your vault balance.`;
  }
  if (p.reverted) return `The router rejected the trade: ${p.reverted}. Nothing was spent.`;
  return undefined;
}
