import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('./wallet.js', () => ({ getNearWriteRpcUrls: () => ['https://rpc-a.test', 'https://rpc-b.test'] }));

import { KeyPair, transactions, utils } from 'near-api-js';
import { fireNearTxsTogether, nearActions } from './nearFleetBundle.js';

describe('NEAR fleet: sign everything first, then fire together', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('signs every wallet before the first broadcast, broadcasts all to every RPC, and reads outcomes', async () => {
    const log: string[] = [];
    const txPolls = new Map<string, number>();
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      log.push(`${body.method}`);
      const ok = (result: any) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
      if (body.method === 'block') return ok({ header: { hash: utils.serialize.base_encode(new Uint8Array(32).fill(7)) } });
      if (body.method === 'query') return ok({ nonce: body.params.account_id === 'w1.racerbot.near' ? 5 : 9 });
      if (body.method === 'broadcast_tx_async') return ok('hash');
      if (body.method === 'tx') {
        const n = (txPolls.get(body.params.tx_hash) ?? 0) + 1;
        txPolls.set(body.params.tx_hash, n);
        if (n === 1) return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'UNKNOWN_TRANSACTION' } }));
        const isW2 = body.params.sender_account_id === 'w2.racerbot.near';
        return ok({
          status: isW2 ? { Failure: { ActionError: { kind: 'E68: slippage error' } } } : { SuccessValue: Buffer.from('"100"').toString('base64') },
          final_execution_status: 'EXECUTED_OPTIMISTIC',
        });
      }
      throw new Error('unexpected ' + body.method);
    }));

    const mk = (accountId: string) => ({
      accountId,
      keyPair: KeyPair.fromRandom('ed25519'),
      receiverId: 'wrap.near',
      actions: [nearActions.call('ft_transfer_call', { receiver_id: 'v2.ref-finance.near', amount: '1', msg: '' }, 180, 1n)],
    });
    const res = await fireNearTxsTogether([mk('w1.racerbot.near'), mk('w2.racerbot.near')], 20_000);

    const firstBroadcast = log.indexOf('broadcast_tx_async');
    const lastQuery = log.lastIndexOf('query');
    expect(firstBroadcast).toBeGreaterThan(lastQuery); // all signing finished before anything was sent
    expect(log.filter((m) => m === 'broadcast_tx_async').length).toBeGreaterThanOrEqual(4); // 2 wallets x 2 RPCs
    expect(res[0].ok).toBe(true);
    expect(res[0].returnValue).toBe('"100"');
    expect(res[1].ok).toBe(false);
    expect(res[1].error).toMatch(/slippage/i);
  });

  it('builds function-call actions with the right gas and deposit', () => {
    const a: any = nearActions.call('near_withdraw', { amount: '5' }, 30, 1n);
    expect(a.functionCall.methodName).toBe('near_withdraw');
    expect(BigInt(a.functionCall.gas)).toBe(30_000_000_000_000n);
    expect(BigInt(a.functionCall.deposit)).toBe(1n);
    expect(transactions).toBeTruthy();
  });
});
