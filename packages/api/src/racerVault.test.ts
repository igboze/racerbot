import { describe, expect, it } from 'vitest';
import { afterTransferFee, withMinimumOut } from './racerVault.js';

describe('Shielded vault minimum output', () => {
  const base = {
    venue: 'RefAmm',
    tokenIn: 'wrap.near',
    tokenOut: 'meme.near',
    expectedOut: '0',
    minAmountOut: '0',
    hops: [
      { pool_id: 1, token_in: 'wrap.near', token_out: 'usdc.near', min_amount_out: '0' },
      { pool_id: 2, token_in: 'usdc.near', token_out: 'meme.near', min_amount_out: '0' },
    ],
  };

  it('sets the minimum on the intent and the final hop only', () => {
    const out = withMinimumOut(base as any, '9800');
    expect(out.minAmountOut).toBe('9800');
    expect(out.hops[0].min_amount_out).toBe('0');
    expect(out.hops[1].min_amount_out).toBe('9800');
  });

  it('does not mutate the planned route (it may be cached)', () => {
    withMinimumOut(base as any, '9800');
    expect(base.minAmountOut).toBe('0');
    expect(base.hops[1].min_amount_out).toBe('0');
  });

  it('fills min_tokens_out in bonding-curve messages', () => {
    const out = withMinimumOut(
      { ...base, custom_msg: JSON.stringify({ min_tokens_out: '0', deadline_sec: 1 }) } as any,
      '500',
    );
    expect(JSON.parse(out.custom_msg!)).toEqual({ min_tokens_out: '500', deadline_sec: 1 });
  });

  it('fills the Intear withdraw floor in multi-hop messages', () => {
    const msg = {
      referrer: 'dex-aggregator.intear.near',
      operations: [
        { SwapSimple: { constraint: null } },
        { Withdraw: { asset_id: 'nep141:meme.near', amount: { Full: { at_least: null } } } },
      ],
    };
    const out = withMinimumOut({ ...base, custom_msg: JSON.stringify(msg) } as any, '777');
    const parsed = JSON.parse(out.custom_msg!);
    expect(parsed.operations[1].Withdraw.amount.Full.at_least).toBe('777');
    expect(parsed.operations[0].SwapSimple.constraint).toBeNull();
  });

  it('leaves messages without a minimum field unchanged', () => {
    const custom_msg = JSON.stringify({ token: 'meme.near' });
    const out = withMinimumOut({ ...base, custom_msg } as any, '5');
    expect(out.custom_msg).toBe(custom_msg);
  });
});

describe('Fee-on-transfer tokens', () => {
  it('removes a 3% (30000 pips) fee the way JustHoot tokens charge it', () => {
    // The 2026-10-28 THREE sell: 3,750,033 sent, 3,637,532 reached Ref DCL
    expect(afterTransferFee(3750033276138261254544n, 30000n)).toBe(3637532277854113416907n);
  });

  it('leaves ordinary tokens untouched', () => {
    expect(afterTransferFee('1000', 0n)).toBe(1000n);
  });
});
