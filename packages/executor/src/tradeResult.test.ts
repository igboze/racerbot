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
            executor_id: TOKEN_OUT, // transfer emitted BY the output token
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

  it('trusts confirmed output-token transfer logs over a stale balance read', () => {
    // The confirmed receipt tree is the chain's own record. A lagging
    // post-trade balance read (pre-swap state) must not override it —
    // that exact race made successful swaps report "produced no tokens".
    const result = {
      status: { SuccessValue: '' },
      transaction: { hash: 'abc123' },
      transaction_outcome: { outcome: { status: { SuccessValue: '' }, logs: [] } },
      receipts_outcome: [
        {
          outcome: {
            status: { SuccessValue: '' },
            executor_id: TOKEN_OUT,
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
      postBalance: '1000', // stale read — equals pre-balance
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.netAmountOut).toBe('999');
  });

  it('never counts a refunded input token as swap output', () => {
    // Refunded buy: the DEX sends the wNEAR INPUT back. The ft_transfer lands
    // on the user but is emitted by wrap.near, NOT the output token — it must
    // be excluded, or every refund would record a fake fill.
    const result = {
      status: { SuccessValue: '' },
      transaction: { hash: 'abc123' },
      transaction_outcome: { outcome: { status: { SuccessValue: '' }, logs: [] } },
      receipts_outcome: [
        {
          outcome: {
            status: { SuccessValue: '' },
            executor_id: 'wrap.near',
            logs: [
              `EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_transfer","data":[{"old_owner_id":"dex.near","new_owner_id":"${USER}","amount":"777"}]}`,
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
      postBalance: '1000',
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/produced no tokens/i);
  });

  it('detects sell output from plain wrap.near Transfer logs', () => {
    const result = {
      status: { SuccessValue: '' },
      transaction: { hash: 'abc123' },
      transaction_outcome: { outcome: { status: { SuccessValue: '' }, logs: [] } },
      receipts_outcome: [
        {
          outcome: {
            status: { SuccessValue: '' },
            executor_id: 'v2.ref-finance.near',
            logs: [`Swapped 117839114753311225139451 some.token.near for 6879098348856606685300749 wrap.near`],
          },
        },
        {
          outcome: {
            status: { SuccessValue: '' },
            executor_id: 'wrap.near',
            logs: [`Transfer 6879098348856606685300749 from v2.ref-finance.near to ${USER}`],
          },
        },
      ],
    };
    const outcome = determineSwapOutcome({
      result,
      subaccountId: USER,
      isBuy: false,
      tokenOut: 'wrap.near',
      preBalance: null,
      postBalance: null,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.netAmountOut).toBe('6879098348856606685300749');
  });

  it('reports the actually received amount (after token tax), not the DEX gross output', () => {
    // Mirrors mainnet tx HJ2Kkudu… (kaida buy): the DCL swap event reports
    // amount_out BEFORE the token contract's 1% tax; the ft_transfer to the
    // user is the true received amount and appears later in the tree.
    const result = {
      status: { SuccessValue: '' },
      transaction: { hash: 'abc123' },
      transaction_outcome: { outcome: { status: { SuccessValue: '' }, logs: [] } },
      receipts_outcome: [
        {
          outcome: {
            status: { SuccessValue: '' },
            executor_id: 'dclv2.ref-labs.near',
            logs: [
              `EVENT_JSON:{"data":[{"amount_in":"492499999999999999999998","amount_out":"43011027484144488458558","pool_id":"kaida.nearlytrade.near|wrap.near|10000","swapper":"${USER}","token_in":"wrap.near","token_out":"${TOKEN_OUT}"}],"event":"swap","standard":"dcl"}`,
            ],
          },
        },
        {
          outcome: {
            status: { SuccessValue: '' },
            executor_id: TOKEN_OUT,
            logs: [
              `EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_transfer","data":[{"old_owner_id":"dclv2.ref-labs.near","new_owner_id":"${USER}","amount":"42580917209303043573973"}]}`,
              `EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_transfer","data":[{"old_owner_id":"dclv2.ref-labs.near","new_owner_id":"${TOKEN_OUT}","amount":"430110274841444884585","memo":"tax"}]}`,
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
    expect(outcome.netAmountOut).toBe('42580917209303043573973');
  });

  it('detects DCL sells paid in native NEAR via wrap.near Withdraw logs', () => {
    // Mirrors mainnet tx 6AXNbx8k… (screnearly sell): DCL swaps to wNEAR then
    // immediately near_withdraws it, paying the user NATIVE NEAR. The user's
    // wrap.near balance delta is 0 — the only evidence is the swap event and
    // the wrap.near "Withdraw N NEAR from dclv2.ref-labs.near" log. Without
    // this, a successful DCL sell is misreported as a DEX refund.
    const result = {
      status: { SuccessValue: '' },
      transaction: { hash: 'abc123' },
      transaction_outcome: { outcome: { status: { SuccessValue: '' }, logs: [] } },
      receipts_outcome: [
        {
          outcome: {
            status: { SuccessValue: '' },
            executor_id: 'dclv2.ref-labs.near',
            logs: [
              `EVENT_JSON:{"data":[{"amount_in":"117839114753311225139451","amount_out":"921131067414805846755856","pool_id":"screnearly.nearlytrade.near|wrap.near|10000","swapper":"${USER}","token_in":"screnearly.nearlytrade.near","token_out":"wrap.near"}],"event":"swap","standard":"dcl"}`,
            ],
          },
        },
        {
          outcome: {
            status: { SuccessValue: '' },
            executor_id: 'wrap.near',
            logs: [`Withdraw 921131067414805846755856 NEAR from dclv2.ref-labs.near`],
          },
        },
      ],
    };
    const outcome = determineSwapOutcome({
      result,
      subaccountId: USER,
      isBuy: false,
      tokenOut: 'wrap.near',
      preBalance: '1000',
      postBalance: '1000', // native payout — wrap.near balance never changes
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.netAmountOut).toBe('921131067414805846755856');
  });

  it('detects a DCL native-NEAR sell even when the swap event is missing (Withdraw log only)', () => {
    const result = {
      status: { SuccessValue: '' },
      transaction: { hash: 'abc123' },
      transaction_outcome: { outcome: { status: { SuccessValue: '' }, logs: [] } },
      receipts_outcome: [
        {
          outcome: {
            status: { SuccessValue: '' },
            executor_id: 'wrap.near',
            logs: [`Withdraw 500000000000000000000000 NEAR from dclv2.ref-labs.near`],
          },
        },
      ],
    };
    const outcome = determineSwapOutcome({
      result,
      subaccountId: USER,
      isBuy: false,
      tokenOut: 'wrap.near',
      preBalance: null,
      postBalance: null,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.netAmountOut).toBe('500000000000000000000000');
  });

  it('does not count wrap.near Withdraw logs as BUY output', () => {
    // A buy must never succeed on wrap.near activity — output is the token.
    const result = {
      status: { SuccessValue: '' },
      transaction: { hash: 'abc123' },
      transaction_outcome: { outcome: { status: { SuccessValue: '' }, logs: [] } },
      receipts_outcome: [
        {
          outcome: {
            status: { SuccessValue: '' },
            executor_id: 'wrap.near',
            logs: [`Withdraw 500000000000000000000000 NEAR from dclv2.ref-labs.near`],
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
      postBalance: '1000',
    });
    expect(outcome.ok).toBe(false);
  });

  it('recovers output amount from receipt logs if RPC view read was stale (delta <= 0)', () => {
    const result = {
      status: { SuccessValue: '' },
      transaction: { hash: 'abc123' },
      transaction_outcome: { outcome: { status: { SuccessValue: '' }, logs: [] } },
      receipts_outcome: [
        {
          outcome: {
            executor_id: TOKEN_OUT,
            status: { SuccessValue: '' },
            logs: [
              `EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_transfer","data":[{"old_owner_id":"dclv2.ref-labs.near","new_owner_id":"${USER}","amount":"52751050585155686507261"}]}`,
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
      postBalance: '1000', // stale RPC read
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.netAmountOut).toBe('52751050585155686507261');
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
