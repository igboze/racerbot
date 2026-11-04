import { describe, expect, it } from 'vitest';
import { encodeExecPlan } from './executorPlan.js';

// Same plan and bytes as plan_borsh_vector in packages/contract/src/executors/tests.rs
const VECTOR =
  '02090000006d656d652e6e6561720100000001120100000000000001190000006d656d652e6e6561727c777261702e6e6561727c3130303030040000006e656172090000006d656d652e6e65617205000000000000000000000000000000e80300000000000000000000000000000500000000000000000000000000000001150000006761797061642e6a312d726163696e672e6e65617200d2496b0000000008000000696e74656e745f31';

describe('encodeExecPlan', () => {
  it('matches the executor SwapPlan borsh layout byte for byte', () => {
    const bytes = encodeExecPlan({
      venue: 'Intear',
      token: 'meme.near',
      hops: [{ pool_id: 274, dcl_pool_id: 'meme.near|wrap.near|10000', token_in: 'near', token_out: 'meme.near', min_amount_out: '5' }],
      amount_in: '1000',
      min_amount_out: '5',
      receiver: 'gaypad.j1-racing.near',
      deadline_sec: 1_800_000_000,
      correlation_id: 'intent_1',
    });
    expect(bytes.toString('hex')).toBe(VECTOR);
  });

  it('encodes absent options and large amounts', () => {
    const bytes = encodeExecPlan({
      venue: 'Dcl', token: 'a.near', hops: [{ pool_id: null, dcl_pool_id: null, token_in: 'near', token_out: 'a.near', min_amount_out: '0' }],
      amount_in: (10n ** 30n).toString(), min_amount_out: '1', receiver: null, deadline_sec: 0, correlation_id: '',
    });
    // venue 0, token, one hop with two None options
    expect(bytes.subarray(0, 1).toString('hex')).toBe('00');
    expect(bytes.subarray(11, 17).toString('hex')).toBe('010000000000');
    expect(() => encodeExecPlan({
      venue: 'Dcl', token: 'a.near', hops: [], amount_in: (1n << 128n).toString(), min_amount_out: '0', receiver: null, deadline_sec: 0, correlation_id: '',
    })).toThrow(/out of range/);
  });
});
