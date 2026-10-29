import { describe, expect, it } from 'vitest';
import fixtures from './__fixtures__/router-outcomes.json' with { type: 'json' };
import { describeOutcome, extractRouterEvents, parseRouterOutcome } from './routerEvents.js';

// Real racerbotrouter.near outcomes from 2026-10-28 (logs trimmed to router events)

describe('parseRouterOutcome on real router transactions', () => {
  it('settled DCL buy: swap_settled + payout_completed', () => {
    const p = parseRouterOutcome(fixtures.settled_dcl_buy);
    expect(p.status).toBe('SETTLED');
    expect(p.netOut).toBe('3209960080700367973306');
    expect(p.payoutAmount).toBe(p.netOut);
    expect(describeOutcome(p)).toBeUndefined();
  });

  it('THREE sell DCL refused (E204): FAILED, nothing consumed', () => {
    const p = parseRouterOutcome(fixtures.venue_refunded_sell);
    expect(p.status).toBe('FAILED');
    expect(p.failCode).toBe('venue_refunded_input');
    expect(p.refundedAmount).toBe('3750033276138261254544');
    expect(describeOutcome(p)).toMatch(/rejected the swap/);
  });

  it('THREE sell measured before DCL paid: slippage_refund + payout_completed', () => {
    const p = parseRouterOutcome(fixtures.slippage_refund_sell);
    expect(p.status).toBe('SLIPPAGE_REFUNDED');
    expect(p.netOut).toBe('99390195329199999999');
    expect(p.fee).toBe('0');
  });

  it('USDC sell before the refund fix: FAILED with zero_tokens_received', () => {
    const p = parseRouterOutcome(fixtures.zero_tokens_sell);
    expect(p.status).toBe('FAILED');
    expect(p.failCode).toBe('zero_tokens_received');
  });
});

describe('parseRouterOutcome edge cases', () => {
  const log = (event: string, data: any = {}) =>
    `EVENT_JSON:${JSON.stringify({ standard: 'racerbot-vault', version: '1.0.0', event, data })}`;
  const outcome = (logs: string[], status: any = { SuccessValue: '' }) => ({ status, receipts_outcome: [{ outcome: { logs } }] });

  it('a transaction the router rejected outright is FAILED with the panic message', () => {
    const p = parseRouterOutcome(outcome([], {
      Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: Token busy: a sell to NEAR is settling, retry shortly' } } } },
    }));
    expect(p.status).toBe('FAILED');
    expect(p.tokenBusy).toBe(true);
    expect(p.reverted).toMatch(/^Token busy/);
  });

  it('a submitted intent with no outcome yet is PENDING', () => {
    expect(parseRouterOutcome(outcome([log('intent_submitted')])).status).toBe('PENDING');
  });

  it('a failed payout wins over the settle event', () => {
    const p = parseRouterOutcome(outcome([log('swap_settled', { net: '10' }), log('payout_failed', { token: 'meme.near', amount: '10' })]));
    expect(p.status).toBe('PAYOUT_FAILED');
    expect(p.payoutToken).toBe('meme.near');
  });

  it('flags output the router could not measure', () => {
    const p = parseRouterOutcome(outcome([log('swap_failed', { reason: 'zero_tokens_received', consumed_amount: '5' }), log('unaccounted_output')]));
    expect(p.unaccounted).toBe(true);
    expect(p.consumedAmount).toBe('5');
    expect(describeOutcome(p)).toMatch(/flagged for reconciliation/);
  });

  it('ignores events from other contracts (token transfers, swaps)', () => {
    const other = `EVENT_JSON:${JSON.stringify({ standard: 'nep141', event: 'ft_transfer', data: [] })}`;
    expect(extractRouterEvents(outcome([other, log('deposit')])).map(e => e.event)).toEqual(['deposit']);
  });
});
