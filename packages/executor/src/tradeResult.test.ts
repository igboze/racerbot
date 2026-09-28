import { describe, it, expect } from 'vitest';
import { determineSwapOutcome, distillFailureReason } from './tradeResult.js';

const USER = 'alice.racerbot.near';
const TOKEN_OUT = 'token-1.near';

/** Minimal FinalExecutionOutcome-shaped success result with no useful logs. */
function bareSuccessResult() {
  return {
    status: { SuccessValue: '' },
    transaction: { hash: 'abc123' },
    transaction_outcome: { outcome: { status: { SuccessValue: '' }, logs: [] } },
    receipts_outcome: [
      { outcome: { status: { SuccessValue: '' }, logs: [] } },
    ],
  };
}

describe('determineSwapOutcome (Fix 3)', () => {
  it('fails when the balance did not increase — no min_amount_out fabrication', () => {
    const result = bareSuccessResult();
    const outcome = determineSwapOutcome({
      result,
      subaccountId: USER,
      isBuy: true,
      tokenOut: TOKEN_OUT,
      preBalance: '1000000',
      postBalance: '1000000', // refunded — no tokens arrived
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBeTruthy();
    expect(outcome.netAmountOut).toBeUndefined();
  });

  it('fails when the balance decreased', () => {
    const outcome = determineSwapOutcome({
      result: bareSuccessResult(),
      subaccountId: USER,
      isBuy: true,
      tokenOut: TOKEN_OUT,
      preBalance: '5000000',
      postBalance: '4000000',
    });
    expect(outcome.ok).toBe(false);
  });

  it('reports the real received amount from the balance delta', () => {
    const outcome = determineSwapOutcome({
      result: bareSuccessResult(),
      subaccountId: USER,
      isBuy: true,
      tokenOut: TOKEN_OUT,
      preBalance: '0',
      postBalance: '98765432100000000000000',
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.netAmountOut).toBe('98765432100000000000000');
  });

  it('fails when any receipt outcome has a Failure status, with a distilled reason', () => {
    const result = {
      status: { SuccessValue: '' },
      transaction: { hash: 'abc123' },
      transaction_outcome: { outcome: { status: { SuccessValue: '' }, logs: [] } },
      receipts_outcome: [
        { outcome: { status: { SuccessValue: '' }, logs: [] } },
        {
          outcome: {
            status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: ERR_MIN_AMOUNT' } } } } },
            logs: [],
          },
        },
      ],
    };
    const outcome = determineSwapOutcome({
      result,
      subaccountId: USER,
      isBuy: true,
      tokenOut: TOKEN_OUT,
      preBalance: null,
      postBalance: null,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('Slippage');
  });

  it('fails closed when neither balances nor logs provide an output', () => {
    const outcome = determineSwapOutcome({
      result: bareSuccessResult(),
      subaccountId: USER,
      isBuy: false,
      tokenOut: 'wrap.near',
      preBalance: null,
      postBalance: null,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/could not verify/i);
  });

  it('falls back to parsed transfer logs when balance reads are unavailable', () => {
    const result = {
      status: { SuccessValue: '' },
      transaction: { hash: 'abc123' },
      transaction_outcome: { outcome: { status: { SuccessValue: '' }, logs: [] } },
      receipts_outcome: [
        {
          outcome: {
            status: { SuccessValue: '' },
            logs: [
              `EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_transfer","data":[{"old_owner_id":"dex.near","new_owner_id":"${USER}","amount":"123456789"}]}`,
            ],
          },
        },
      ],
    };
    const outcome = determineSwapOutcome({
      result,
      subaccountId: USER,
      isBuy: true,
      tokenOut: TOKEN_OUT,
      preBalance: null,
      postBalance: null,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.netAmountOut).toBe('123456789');
  });

  it('prefers the balance delta over logs when both are available', () => {
    const result = {
      status: { SuccessValue: '' },
      transaction: { hash: 'abc123' },
      transaction_outcome: { outcome: { status: { SuccessValue: '' }, logs: [] } },
      receipts_outcome: [
        {
          outcome: {
            status: { SuccessValue: '' },
            logs: [
              `EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_transfer","data":[{"old_owner_id":"dex.near","new_owner_id":"${USER}","amount":"999"}]}`,
            ],
          },
        },
      ],
    };
    const outcome = determineSwapOutcome({
      result,
      subaccountId: USER,
      isBuy: true,
      tokenOut: TOKEN_OUT,
      preBalance: '1000',
      postBalance: '6000',
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.netAmountOut).toBe('5000'); // delta wins over the 999 log
  });
});

describe('distillFailureReason', () => {
  it('maps slippage errors to an actionable message', () => {
    expect(distillFailureReason({ ExecutionError: 'Smart contract panicked: slippage error' }))
      .toContain('Slippage');
  });
  it('maps pool-not-found errors', () => {
    expect(distillFailureReason({ ExecutionError: 'pool_not_found' })).toContain('No liquidity pool');
  });
  it('returns a generic reason for unknown failures', () => {
    expect(distillFailureReason({ ActionError: 'Unknown' })).toContain('failed');
  });
});
