import { beforeEach, describe, expect, it } from 'vitest';
import { _resetFlows, classifyFlow, flushFlows, MIN_TRADE_YOCTO, observeReceipt, QUIET_MS } from './copyTradeFlow.js';

const LEADER = 'leader.near';
const NEAR = 10n ** 24n;
const tracked = (w: string) => w === LEADER;
const ev = (event: string, data: object[]) => `EVENT_JSON:${JSON.stringify({ standard: 'nep141', version: '1.0.0', event, data })}`;

/** A neardata receipt_execution_outcome */
function receipt(p: {
  receiver: string; predecessor?: string; signer?: string; tx?: string;
  actions?: object[]; logs?: string[]; failed?: boolean;
}) {
  return {
    tx_hash: p.tx ?? 'tx1',
    receipt: {
      receiver_id: p.receiver,
      predecessor_id: p.predecessor ?? LEADER,
      receipt: { Action: { signer_id: p.signer ?? LEADER, actions: p.actions ?? [] } },
    },
    execution_outcome: { outcome: { logs: p.logs ?? [], status: p.failed ? { Failure: {} } : { SuccessValue: '' } } },
  };
}

const call = (deposit: bigint) => ({ FunctionCall: { method_name: 'x', args: '', gas: 1, deposit: deposit.toString() } });
const transfer = (deposit: bigint) => ({ Transfer: { deposit: deposit.toString() } });

function settle(t0: number) {
  return flushFlows(t0 + QUIET_MS + 1);
}

describe('copy-trade detection from balance changes', () => {
  beforeEach(() => _resetFlows());

  it('a buy through an unknown router: wNEAR out, one token in', () => {
    const t0 = 1_000;
    // near_deposit, then the router swaps and pays the token back
    observeReceipt(receipt({ receiver: 'wrap.near', actions: [call(NEAR)], logs: [ev('ft_mint', [{ owner_id: LEADER, amount: NEAR.toString() }])] }), tracked, t0);
    observeReceipt(receipt({ receiver: 'wrap.near', logs: [ev('ft_transfer', [{ old_owner_id: LEADER, new_owner_id: 'some-router.near', amount: NEAR.toString() }])] }), tracked, t0);
    observeReceipt(receipt({ receiver: 'cat.token.near', predecessor: 'some-router.near', logs: [ev('ft_transfer', [{ old_owner_id: 'some-router.near', new_owner_id: LEADER, amount: '500' }])] }), tracked, t0 + 500);
    expect(flushFlows(t0 + 1_000)).toEqual([]); // still settling
    expect(settle(t0 + 500)).toEqual([{ wallet: LEADER, txHash: 'tx1', swap: { side: 'buy', tokenAddress: 'cat.token.near', tokenIn: 'wrap.near', tokenOut: 'cat.token.near', amountIn: NEAR.toString() } }]);
  });

  it('a bonding-curve buy with attached NEAR', () => {
    observeReceipt(receipt({ receiver: 'curve.near', actions: [call(2n * NEAR)] }), tracked, 0);
    observeReceipt(receipt({ receiver: 'dog.curve.near', predecessor: 'curve.near', logs: [ev('ft_mint', [{ owner_id: LEADER, amount: '7' }])] }), tracked, 0);
    expect(settle(0)[0].swap).toMatchObject({ side: 'buy', tokenAddress: 'dog.curve.near' });
  });

  it('a sell paid in native NEAR', () => {
    observeReceipt(receipt({ receiver: 'cat.token.near', actions: [call(1n)], logs: [ev('ft_transfer', [{ old_owner_id: LEADER, new_owner_id: 'pool.near', amount: '500' }])] }), tracked, 0);
    observeReceipt(receipt({ receiver: LEADER, predecessor: 'pool.near', actions: [transfer(3n * NEAR)] }), tracked, 0);
    expect(settle(0)[0].swap).toMatchObject({ side: 'sell', tokenAddress: 'cat.token.near', amountIn: '500' });
  });

  it('a sell paid in wNEAR', () => {
    observeReceipt(receipt({ receiver: 'cat.token.near', logs: [ev('ft_transfer', [{ old_owner_id: LEADER, new_owner_id: 'pool.near', amount: '500' }])] }), tracked, 0);
    observeReceipt(receipt({ receiver: 'wrap.near', predecessor: 'pool.near', logs: [ev('ft_transfer', [{ old_owner_id: 'pool.near', new_owner_id: LEADER, amount: NEAR.toString() }])] }), tracked, 0);
    expect(settle(0)[0].swap).toMatchObject({ side: 'sell', tokenAddress: 'cat.token.near' });
  });

  it('ignores a plain token transfer to a friend (no NEAR came back)', () => {
    observeReceipt(receipt({ receiver: 'cat.token.near', actions: [call(1n)], logs: [ev('ft_transfer', [{ old_owner_id: LEADER, new_owner_id: 'friend.near', amount: '500' }])] }), tracked, 0);
    expect(settle(0)).toEqual([]);
  });

  it('ignores tokens someone else sends the leader (not signed by the leader)', () => {
    observeReceipt(receipt({ receiver: 'cat.token.near', signer: 'stranger.near', predecessor: 'stranger.near', logs: [ev('ft_transfer', [{ old_owner_id: 'stranger.near', new_owner_id: LEADER, amount: '500' }])] }), tracked, 0);
    expect(settle(0)).toEqual([]);
  });

  it('ignores a failed swap whose deposit was refunded', () => {
    observeReceipt(receipt({ receiver: 'curve.near', actions: [call(2n * NEAR)], failed: true }), tracked, 0);
    observeReceipt(receipt({ receiver: LEADER, predecessor: 'system', actions: [transfer(2n * NEAR)] }), tracked, 0);
    expect(settle(0)).toEqual([]);
  });

  it('ignores gas refunds and storage-sized deposits', () => {
    observeReceipt(receipt({ receiver: 'cat.token.near', actions: [call(1_250_000_000_000_000_000_000n)], logs: [ev('ft_mint', [{ owner_id: LEADER, amount: '1' }])] }), tracked, 0);
    observeReceipt(receipt({ receiver: LEADER, predecessor: 'system', actions: [transfer(NEAR)] }), tracked, 0);
    expect(settle(0)).toEqual([]);
  });

  it('ignores token-for-token swaps', () => {
    expect(classifyFlow(0n, new Map([['a.near', 5n], ['b.near', -5n]]))).toBeNull();
    expect(classifyFlow(-NEAR, new Map([['a.near', 5n], ['b.near', 5n]]))).toBeNull();
  });

  it('needs at least the minimum NEAR movement', () => {
    expect(classifyFlow(-MIN_TRADE_YOCTO + 1n, new Map([['a.near', 5n]]))).toBeNull();
    expect(classifyFlow(-MIN_TRADE_YOCTO, new Map([['a.near', 5n]]))?.side).toBe('buy');
  });

  it('skips wallets nobody tracks', () => {
    observeReceipt(receipt({ receiver: 'curve.near', signer: 'other.near', predecessor: 'other.near', actions: [call(NEAR)] }), tracked, 0);
    expect(settle(0)).toEqual([]);
  });

  it('keeps transactions apart and forgets them once judged', () => {
    observeReceipt(receipt({ tx: 'a', receiver: 'curve.near', actions: [call(NEAR)] }), tracked, 0);
    observeReceipt(receipt({ tx: 'a', receiver: 'x.curve.near', predecessor: 'curve.near', logs: [ev('ft_mint', [{ owner_id: LEADER, amount: '1' }])] }), tracked, 0);
    observeReceipt(receipt({ tx: 'b', receiver: 'curve.near', actions: [call(NEAR)] }), tracked, 0);
    expect(settle(0).map(f => f.txHash)).toEqual(['a']);
    expect(settle(0)).toEqual([]);
  });
});
