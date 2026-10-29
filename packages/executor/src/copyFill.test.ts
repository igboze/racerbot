import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@racerbot/db', () => ({
  updateCopyTradeFillResult: vi.fn().mockResolvedValue(undefined),
  awardPointsForCopyTrade: vi.fn().mockResolvedValue(undefined),
  recordTokenReferral: vi.fn().mockResolvedValue({ id: 'ref-1' }),
  getTokenReferral: vi.fn().mockResolvedValue(null),
  addTokenReferralReward: vi.fn().mockResolvedValue(undefined),
}));

import * as db from '@racerbot/db';
import { settleCopyFill } from './copyFill.js';

const copy = {
  fill_id: 'fill-1',
  copier_user_id: 'copier',
  token_address: 'cat.near',
  points_volume_near: 2,
  leader_user_id: 'leader',
  referrer_id: 'sharer',
};

describe('settleCopyFill', () => {
  beforeEach(() => vi.clearAllMocks());

  it('a successful copy is filled and earns points and the referral reward', async () => {
    await settleCopyFill(copy, { ok: true, txHash: 'our-tx' });
    expect(db.updateCopyTradeFillResult).toHaveBeenCalledWith('fill-1', 'filled', { our_tx_hash: 'our-tx' });
    expect(db.awardPointsForCopyTrade).toHaveBeenCalledWith('copier', 'fill-1', 2, 'leader');
    expect(db.recordTokenReferral).toHaveBeenCalledWith('copier', 'cat.near', 'sharer');
    expect(db.addTokenReferralReward).toHaveBeenCalledWith('ref-1', 2 * 0.015 * 0.05);
  });

  it('a failed copy is marked failed and earns nothing', async () => {
    await settleCopyFill(copy, { ok: false, reason: 'slippage exceeded' });
    expect(db.updateCopyTradeFillResult).toHaveBeenCalledWith('fill-1', 'failed', { skip_reason: 'slippage exceeded' });
    expect(db.awardPointsForCopyTrade).not.toHaveBeenCalled();
    expect(db.addTokenReferralReward).not.toHaveBeenCalled();
  });

  it('a sell (no volume) is filled without points', async () => {
    await settleCopyFill({ ...copy, points_volume_near: 0 }, { ok: true, txHash: 't' });
    expect(db.updateCopyTradeFillResult).toHaveBeenCalledWith('fill-1', 'filled', { our_tx_hash: 't' });
    expect(db.awardPointsForCopyTrade).not.toHaveBeenCalled();
  });

  it('without a referrer, rewards an existing token share referral', async () => {
    vi.mocked(db.getTokenReferral).mockResolvedValueOnce({ id: 'ref-2' } as any);
    await settleCopyFill({ ...copy, referrer_id: null }, { ok: true });
    expect(db.recordTokenReferral).not.toHaveBeenCalled();
    expect(db.addTokenReferralReward).toHaveBeenCalledWith('ref-2', 2 * 0.015 * 0.05);
  });
});
