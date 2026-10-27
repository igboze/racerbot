import { describe, it, expect, vi } from 'vitest';

const { mockRedis } = vi.hoisted(() => ({
  mockRedis: {
    publish: vi.fn().mockResolvedValue(1),
    subscribe: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    quit: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@racerbot/shared', async (importOriginal: () => Promise<Record<string, unknown>>) => {
  const actual = await importOriginal();
  return { ...actual, getRedis: () => mockRedis, createRedis: () => mockRedis };
});

import { parseSolanaSwap } from './solanaCopyTrade.js';

const W = '7rBfMSFjbQyP7nzmYSrUANLvar69JTpxSMjntRgxEDS2';
const OTHER = 'Ba5k8bQ5mXyQ8m5sZr4gq8q1Vb8eGqf9w3n2y7dXpUmP';
const MINT = 'C2upouXv5AYVUKcBNomVmEeUwKmdBpkycgwrr22kpump';
const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function tx(opts: {
  pre: number; post: number; fee?: number; payerIsWallet?: boolean;
  preTok?: Array<[string, string, string]>; postTok?: Array<[string, string, string]>; err?: any;
}) {
  const keys = opts.payerIsWallet === false ? [{ pubkey: OTHER }, { pubkey: W }] : [{ pubkey: W }, { pubkey: OTHER }];
  const wIdx = opts.payerIsWallet === false ? 1 : 0;
  const preBalances = [0, 0];
  const postBalances = [0, 0];
  preBalances[wIdx] = opts.pre;
  postBalances[wIdx] = opts.post;
  const tb = (list: Array<[string, string, string]> = []) =>
    list.map(([owner, mint, amount], i) => ({ accountIndex: 2 + i, owner, mint, uiTokenAmount: { amount, decimals: 6 } }));
  return {
    transaction: { message: { accountKeys: keys } },
    meta: {
      err: opts.err ?? null,
      fee: opts.fee ?? 5000,
      preBalances,
      postBalances,
      preTokenBalances: tb(opts.preTok),
      postTokenBalances: tb(opts.postTok),
    },
  };
}

describe('parseSolanaSwap', () => {
  it('detects a SOL buy of a pump.fun token', () => {
    // Spent 0.5 SOL + fee + ATA rent, received 1,000,000 tokens.
    const r = parseSolanaSwap(
      tx({ pre: 2_000_000_000, post: 1_497_955_000, postTok: [[W, MINT, '1000000000000']] }),
      W,
    );
    expect(r).not.toBeNull();
    expect(r!.side).toBe('buy');
    expect(r!.mint).toBe(MINT);
    expect(r!.tokenRaw).toBe(1000000000000n);
    expect(r!.quote).toBe('SOL');
    expect(r!.solLamports).toBe(2_000_000_000n - 1_497_955_000n - 5000n);
  });

  it('detects a partial sell and reports the leader pre-balance for proportional copying', () => {
    const r = parseSolanaSwap(
      tx({
        pre: 100_000_000, post: 350_000_000,
        preTok: [[W, MINT, '1000']], postTok: [[W, MINT, '250']],
      }),
      W,
    );
    expect(r!.side).toBe('sell');
    expect(r!.tokenRaw).toBe(750n);
    expect(r!.preTokenRaw).toBe(1000n);
  });

  it('counts wrapped SOL as SOL (Raydium / Jupiter WSOL routes)', () => {
    const r = parseSolanaSwap(
      tx({
        pre: 50_000_000, post: 50_000_000 - 5000,
        preTok: [[W, WSOL, '400000000']], postTok: [[W, WSOL, '0'], [W, MINT, '42']],
      }),
      W,
    );
    expect(r!.side).toBe('buy');
    expect(r!.solLamports).toBe(400_000_000n);
  });

  it('detects a USDC-quoted buy', () => {
    const r = parseSolanaSwap(
      tx({ pre: 10_000_000, post: 10_000_000 - 5000, preTok: [[W, USDC, '20000000']], postTok: [[W, USDC, '0'], [W, MINT, '99']] }),
      W,
    );
    expect(r!.side).toBe('buy');
    expect(r!.quote).toBe('USDC');
  });

  it('ignores a plain incoming token transfer (no quote asset spent)', () => {
    expect(parseSolanaSwap(tx({ pre: 10_000_000, post: 10_000_000 - 5000, postTok: [[W, MINT, '500']] }), W)).toBeNull();
  });

  it('ignores receiving tokens when the wallet only paid token-account rent', () => {
    // 0.00204 SOL rent is below the 0.003 SOL trade threshold.
    expect(parseSolanaSwap(tx({ pre: 10_000_000, post: 10_000_000 - 5000 - 2_039_280, postTok: [[W, MINT, '500']] }), W)).toBeNull();
  });

  it('ignores sending tokens away and closing the account (rent refund only)', () => {
    expect(parseSolanaSwap(tx({ pre: 10_000_000, post: 10_000_000 - 5000 + 2_039_280, preTok: [[W, MINT, '500']], postTok: [] }), W)).toBeNull();
  });

  it('ignores token-to-token swaps and failed transactions', () => {
    const OTHER_MINT = 'GcK6NwWMZ9v4b5ZcY1u7z3L8w2K9p4q6r7s8t9u1v2w3';
    expect(parseSolanaSwap(tx({ pre: 1e9, post: 1e9 - 5000, preTok: [[W, OTHER_MINT, '10']], postTok: [[W, MINT, '10']] }), W)).toBeNull();
    expect(parseSolanaSwap(tx({ pre: 2e9, post: 1e9, postTok: [[W, MINT, '10']], err: { InstructionError: [2, 'Custom'] } }), W)).toBeNull();
  });

  it('does not add the network fee back when the wallet is not the fee payer', () => {
    const r = parseSolanaSwap(
      tx({ payerIsWallet: false, pre: 1_000_000_000, post: 500_000_000, postTok: [[W, MINT, '10']] }),
      W,
    );
    expect(r!.solLamports).toBe(500_000_000n);
  });

  it('only reads balances owned by the tracked wallet', () => {
    expect(parseSolanaSwap(tx({ pre: 2e9, post: 1e9, postTok: [[OTHER, MINT, '10']] }), W)).toBeNull();
  });
});
