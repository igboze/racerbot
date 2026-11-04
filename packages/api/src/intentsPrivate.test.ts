import { describe, it, expect, vi, afterEach } from 'vitest';

const { quoteShield } = await import('./intentsPrivate.js');

describe('quoteShield (an executor returning a sold position)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it("pays into the user's private intents account, never a public wallet, and refunds to the sender", async () => {
    let body: any = null;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({ quote: { depositAddress: 'dep.near', amountIn: '5', amountOut: '5', minAmountOut: '5' } }), { status: 200 });
    }));
    const q = await quoteShield('0'.repeat(64), 5n, 'abc.racerbot.near');
    expect(q.depositAddress).toBe('dep.near');
    expect(body).toMatchObject({
      recipient: '0'.repeat(64),
      recipientType: 'CONFIDENTIAL_INTENTS',
      refundTo: 'abc.racerbot.near',
      originAsset: 'nep141:wrap.near',
      destinationAsset: 'nep141:wrap.near',
      amount: '5',
    });
  });
});
