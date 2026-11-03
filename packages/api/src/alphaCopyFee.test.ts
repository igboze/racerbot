import { describe, it, expect, vi } from 'vitest';

const transferNearFromUser = vi.fn();
const payFromPrivateBalance = vi.fn();
const query = vi.fn();

vi.mock('./wallet.js', () => ({
  transferNearFromUser,
  unwrapUserWrapNear: vi.fn(),
}));
vi.mock('./executorPool.js', () => ({ payFromPrivateBalance }));
vi.mock('@racerbot/db', () => ({
  getDb: async () => ({ query }),
  getUserById: vi.fn(),
}));

const { computeCopyProfitShare, retryFailedCopyFees } = await import('./alphaCopyFee.js');

describe('computeCopyProfitShare', () => {
  const base = { costNear: 10, copiedQtyRaw: 1000n, balanceBeforeRaw: 1000n, soldRaw: 1000n, proceedsNear: 15, feePct: 10 };

  it('charges the fee percentage of the profit on a full copied exit', () => {
    const s = computeCopyProfitShare(base);
    expect(s.copiedSoldRaw).toBe(1000n);
    expect(s.costPortionNear).toBeCloseTo(10);
    expect(s.profitNear).toBeCloseTo(5);
    expect(s.feeNear).toBeCloseTo(0.5);
  });

  it('charges nothing on a loss', () => {
    const s = computeCopyProfitShare({ ...base, proceedsNear: 8 });
    expect(s.profitNear).toBeCloseTo(-2);
    expect(s.feeNear).toBe(0);
    expect(s.costPortionNear).toBeCloseTo(10); // the basis is still used up
  });

  it('uses only the sold share of the cost on a partial sell', () => {
    const s = computeCopyProfitShare({ ...base, soldRaw: 400n, proceedsNear: 6 });
    expect(s.copiedSoldRaw).toBe(400n);
    expect(s.costPortionNear).toBeCloseTo(4);
    expect(s.feeNear).toBeCloseTo(0.2);
  });

  it("counts only copied tokens when the wallet also holds the follower's own", () => {
    // 1000 copied + 1000 own; selling all 2000 for 30 NEAR: the copied half got 15 NEAR on a 10 NEAR cost
    const s = computeCopyProfitShare({ ...base, balanceBeforeRaw: 2000n, soldRaw: 2000n, proceedsNear: 30 });
    expect(s.copiedSoldRaw).toBe(1000n);
    expect(s.profitNear).toBeCloseTo(5);
    expect(s.feeNear).toBeCloseTo(0.5);
  });

  it('caps the fee at 25% and charges nothing at 0%', () => {
    expect(computeCopyProfitShare({ ...base, feePct: 90 }).feeNear).toBeCloseTo(1.25);
    expect(computeCopyProfitShare({ ...base, feePct: 0 }).feeNear).toBe(0);
  });

  it('charges nothing when proceeds or balances are unknown', () => {
    expect(computeCopyProfitShare({ ...base, proceedsNear: 0 }).feeNear).toBe(0);
    expect(computeCopyProfitShare({ ...base, balanceBeforeRaw: 0n }).copiedSoldRaw).toBe(0n);
    expect(computeCopyProfitShare({ ...base, copiedQtyRaw: 0n }).feeNear).toBe(0);
  });
});

describe('retryFailedCopyFees', () => {
  const failedRow = (route: string) => ({
    id: 'cfee_1', user_id: 'u1', trader_id: 't1', route, fee_near: '0.5', payout_account: 'creator.near', telegram_id: null,
  });

  /** Answers the SELECT with `rows` and the claim with `claimed` rows; every other query succeeds */
  function fakeDb(rows: any[], claimed: number) {
    query.mockReset();
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM racer_alpha_copy_fees')) return { rows };
      if (sql.includes("SET status = 'collecting'")) return { rows: Array.from({ length: claimed }, () => ({ id: 'cfee_1' })) };
      return { rows: [] };
    });
  }

  it('sends a failed wallet share again and marks it paid', async () => {
    fakeDb([failedRow('wallet')], 1);
    transferNearFromUser.mockReset().mockResolvedValue({ txHash: 'tx-fee' });
    expect(await retryFailedCopyFees()).toEqual({ paid: 1, failed: 0 });
    expect(transferNearFromUser).toHaveBeenCalledWith('u1', 'creator.near', (5n * 10n ** 23n).toString());
    expect(query.mock.calls.some(([sql]) => sql.includes("status = 'paid'"))).toBe(true);
  });

  it('pays confidential shares from the private balance', async () => {
    fakeDb([failedRow('confidential')], 1);
    payFromPrivateBalance.mockReset().mockResolvedValue({ intentHash: 'intent-1' });
    transferNearFromUser.mockReset();
    expect(await retryFailedCopyFees()).toEqual({ paid: 1, failed: 0 });
    expect(payFromPrivateBalance).toHaveBeenCalledWith('u1', 5n * 10n ** 23n, 'creator.near');
    expect(transferNearFromUser).not.toHaveBeenCalled();
  });

  it('skips a row another attempt already claimed, so it is never sent twice', async () => {
    fakeDb([failedRow('wallet')], 0);
    transferNearFromUser.mockReset();
    expect(await retryFailedCopyFees()).toEqual({ paid: 0, failed: 0 });
    expect(transferNearFromUser).not.toHaveBeenCalled();
  });

  it('keeps a share that still cannot be paid for the next retry', async () => {
    fakeDb([failedRow('confidential')], 1);
    payFromPrivateBalance.mockReset().mockRejectedValue(new Error('The private balance does not cover it yet'));
    expect(await retryFailedCopyFees()).toEqual({ paid: 0, failed: 1 });
    expect(query.mock.calls.some(([sql]) => sql.includes("ELSE 'failed'"))).toBe(true);
  });
});
