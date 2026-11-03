import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@racerbot/db', () => ({
  getUserById: vi.fn(),
  getReferralByReferredUser: vi.fn(),
  activateReferral: vi.fn().mockResolvedValue(undefined),
  addReferralReward: vi.fn().mockResolvedValue(undefined),
  addCashbackReward: vi.fn().mockResolvedValue(undefined),
  getTokenReferral: vi.fn().mockResolvedValue(null),
  addTokenReferralReward: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./utils.js', () => ({
  getNearUsdPrice: vi.fn().mockResolvedValue(5.0),
}));

vi.mock('./solana.js', () => ({
  getSolUsdPrice: vi.fn().mockResolvedValue(150.0),
}));

vi.mock('./sui.js', () => ({
  getSuiUsdPrice: vi.fn().mockResolvedValue(2.0),
}));

vi.mock('./starknet.js', () => ({
  getStrkUsdPrice: vi.fn().mockResolvedValue(0.50),
  getEthUsdPrice: vi.fn().mockResolvedValue(2500.0),
}));

vi.mock('./evm.js', () => ({
  getHypeUsdPrice: vi.fn().mockResolvedValue(25.0),
}));

import {
  getUserById,
  getReferralByReferredUser,
  activateReferral,
  addReferralReward,
  addCashbackReward,
} from '@racerbot/db';
import { distributeTradeFeeRewards } from './rewards.js';

describe('distributeTradeFeeRewards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allocates 15% referral fee to normal referrer on NEAR', async () => {
    vi.mocked(getReferralByReferredUser).mockResolvedValue({
      id: 'ref-1',
      referrer_id: 'standard-ref-user',
      referred_user_id: 'trader-user',
      status: 'active',
      referrer_fee_pct: 15,
      referrer_is_ambassador: false,
    } as any);

    vi.mocked(getUserById).mockResolvedValue({
      id: 'trader-user',
      cashback_pct: 0,
    } as any);

    const res = await distributeTradeFeeRewards({
      userId: 'trader-user',
      chain: 'near',
      feeAmount: '10', // 10 NEAR fee
    });

    expect(res.feeInNear).toBe(10);
    expect(res.referralRewardNear).toBe(1.5); // 15% of 10 NEAR
    expect(addReferralReward).toHaveBeenCalledWith('ref-1', 1.5);
    expect(addCashbackReward).not.toHaveBeenCalled();
  });

  it('allocates 50% referral fee to super ambassador on NEAR', async () => {
    vi.mocked(getReferralByReferredUser).mockResolvedValue({
      id: 'ref-2',
      referrer_id: 'cryptogeneral01-id',
      referred_user_id: 'trader-user',
      status: 'active',
      referrer_fee_pct: 50,
      referrer_is_ambassador: true,
      referrer_fee_tier: 'super_ambassador',
    } as any);

    vi.mocked(getUserById).mockResolvedValue({
      id: 'trader-user',
      cashback_pct: 0,
    } as any);

    const res = await distributeTradeFeeRewards({
      userId: 'trader-user',
      chain: 'near',
      feeAmount: '10', // 10 NEAR fee
    });

    expect(res.feeInNear).toBe(10);
    expect(res.referralRewardNear).toBe(5.0); // 50% of 10 NEAR
    expect(addReferralReward).toHaveBeenCalledWith('ref-2', 5.0);
  });

  it('allocates 50% referral fee to super ambassador on Solana (converted to NEAR)', async () => {
    vi.mocked(getReferralByReferredUser).mockResolvedValue({
      id: 'ref-3',
      referrer_id: 'cryptogeneral01-id',
      referred_user_id: 'sol-trader',
      status: 'active',
      referrer_fee_pct: 50,
      referrer_is_ambassador: true,
    } as any);

    vi.mocked(getUserById).mockResolvedValue({
      id: 'sol-trader',
      cashback_pct: 0,
    } as any);

    // SOL price = $150, NEAR price = $5 => 1 SOL = 30 NEAR
    // Fee = 0.1 SOL = 3 NEAR
    const res = await distributeTradeFeeRewards({
      userId: 'sol-trader',
      chain: 'solana',
      feeAmount: '0.1',
    });

    expect(res.feeInNear).toBe(3.0);
    expect(res.referralRewardNear).toBe(1.5); // 50% of 3 NEAR
    expect(addReferralReward).toHaveBeenCalledWith('ref-3', 1.5);
  });

  it('allocates 50% referral fee to super ambassador on HyperEVM (converted to NEAR)', async () => {
    vi.mocked(getReferralByReferredUser).mockResolvedValue({
      id: 'ref-4',
      referrer_id: 'cryptogeneral01-id',
      referred_user_id: 'evm-trader',
      status: 'active',
      referrer_fee_pct: 50,
      referrer_is_ambassador: true,
    } as any);

    vi.mocked(getUserById).mockResolvedValue({
      id: 'evm-trader',
      cashback_pct: 0,
    } as any);

    // HYPE price = $25, NEAR price = $5 => 1 HYPE = 5 NEAR
    // Fee = 2 HYPE = 10 NEAR
    const res = await distributeTradeFeeRewards({
      userId: 'evm-trader',
      chain: 'hyperevm',
      feeAmount: '2',
    });

    expect(res.feeInNear).toBe(10.0);
    expect(res.referralRewardNear).toBe(5.0); // 50% of 10 NEAR
    expect(addReferralReward).toHaveBeenCalledWith('ref-4', 5.0);
  });

  it('credits 5% fee cashback to super ambassador on their own trades', async () => {
    vi.mocked(getReferralByReferredUser).mockResolvedValue(null);

    vi.mocked(getUserById).mockResolvedValue({
      id: 'cryptogeneral01-id',
      cashback_pct: 5,
      fee_tier: 'super_ambassador',
    } as any);

    // 20 NEAR fee paid
    const res = await distributeTradeFeeRewards({
      userId: 'cryptogeneral01-id',
      chain: 'near',
      feeAmount: '20',
    });

    expect(res.feeInNear).toBe(20.0);
    expect(res.cashbackNear).toBe(1.0); // 5% of 20 NEAR = 1 NEAR
    expect(addCashbackReward).toHaveBeenCalledWith('cryptogeneral01-id', 1.0);
  });

  it('activates pending referral on first trade', async () => {
    vi.mocked(getReferralByReferredUser).mockResolvedValue({
      id: 'ref-pending',
      referrer_id: 'cryptogeneral01-id',
      referred_user_id: 'new-user',
      status: 'pending',
      referrer_fee_pct: 50,
    } as any);

    vi.mocked(getUserById).mockResolvedValue({
      id: 'new-user',
      cashback_pct: 0,
    } as any);

    const res = await distributeTradeFeeRewards({
      userId: 'new-user',
      chain: 'near',
      feeAmount: '10',
    });

    expect(activateReferral).toHaveBeenCalledWith('ref-pending');
    expect(res.referralRewardNear).toBe(5.0);
    expect(addReferralReward).toHaveBeenCalledWith('ref-pending', 5.0);
  });
});
