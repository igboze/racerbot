import { describe, it, expect, vi } from 'vitest';

vi.mock('./wallet.js', () => ({
  transferNearFromUser: vi.fn(),
  unwrapUserWrapNear: vi.fn(),
}));

const { computeCopyProfitShare } = await import('./alphaCopyFee.js');

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
