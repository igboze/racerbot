import {
  getUserById,
  getReferralByReferredUser,
  activateReferral,
  addReferralReward,
  addCashbackReward,
  getTokenReferral,
  addTokenReferralReward,
} from '@racerbot/db';
import { getNearUsdPrice } from './utils.js';
import { getSolUsdPrice } from './solana.js';
import { getSuiUsdPrice } from './sui.js';
import { getStrkUsdPrice, getEthUsdPrice } from './starknet.js';
import { getHypeUsdPrice } from './evm.js';

export interface DistributeFeeParams {
  userId: string;
  chain: 'near' | 'solana' | 'sui' | 'starknet' | 'hyperevm' | 'elysium' | string;
  feeAmount: number | string;
  tokenAddress?: string;
  tokenSymbol?: string;
}

export interface FeeDistributionResult {
  feeInNear: number;
  referralRewardNear: number;
  referrerId?: string;
  cashbackNear: number;
  tokenShareRewardNear: number;
}

/**
 * Converts trading fees across all chains into NEAR equivalent,
 * then distributes referral rewards (up to 50% for super ambassador)
 * and fee cashback (e.g. 5% for super ambassador) to user balances.
 */
export async function distributeTradeFeeRewards(params: DistributeFeeParams): Promise<FeeDistributionResult> {
  const { userId, chain, feeAmount, tokenAddress, tokenSymbol } = params;
  const result: FeeDistributionResult = {
    feeInNear: 0,
    referralRewardNear: 0,
    cashbackNear: 0,
    tokenShareRewardNear: 0,
  };

  const fee = parseFloat(String(feeAmount || '0'));
  if (!Number.isFinite(fee) || fee <= 0) {
    return result;
  }

  // 1. Calculate NEAR equivalent of the fee across any chain
  let feeInNear = fee;
  try {
    const chainLower = chain.toLowerCase();
    if (chainLower === 'near') {
      feeInNear = fee;
    } else if (chainLower === 'solana') {
      const [solUsd, nearUsd] = await Promise.all([
        getSolUsdPrice().catch(() => 150),
        getNearUsdPrice().catch(() => 5.0),
      ]);
      const effectiveSol = solUsd > 0 ? solUsd : 150;
      const effectiveNear = nearUsd > 0 ? nearUsd : 5.0;
      feeInNear = (fee * effectiveSol) / effectiveNear;
    } else if (chainLower === 'sui') {
      const [suiUsd, nearUsd] = await Promise.all([
        getSuiUsdPrice().catch(() => 2.0),
        getNearUsdPrice().catch(() => 5.0),
      ]);
      const effectiveSui = suiUsd > 0 ? suiUsd : 2.0;
      const effectiveNear = nearUsd > 0 ? nearUsd : 5.0;
      feeInNear = (fee * effectiveSui) / effectiveNear;
    } else if (chainLower === 'starknet') {
      const isEth = tokenSymbol?.toUpperCase() === 'ETH';
      const [tokenUsd, nearUsd] = await Promise.all([
        isEth ? getEthUsdPrice().catch(() => 2600) : getStrkUsdPrice().catch(() => 0.50),
        getNearUsdPrice().catch(() => 5.0),
      ]);
      const effectiveToken = tokenUsd > 0 ? tokenUsd : (isEth ? 2600 : 0.50);
      const effectiveNear = nearUsd > 0 ? nearUsd : 5.0;
      feeInNear = (fee * effectiveToken) / effectiveNear;
    } else if (chainLower === 'hyperevm' || chainLower === 'elysium') {
      const [hypeUsd, nearUsd] = await Promise.all([
        getHypeUsdPrice().catch(() => 74.0),
        getNearUsdPrice().catch(() => 5.0),
      ]);
      const effectiveHype = hypeUsd > 0 ? hypeUsd : 74.0;
      const effectiveNear = nearUsd > 0 ? nearUsd : 5.0;
      feeInNear = (fee * effectiveHype) / effectiveNear;
    } else {
      feeInNear = fee;
    }
  } catch (err: any) {
    console.warn(`[REWARDS] Error converting fee to NEAR for chain ${chain}:`, err?.message);
    feeInNear = fee;
  }

  if (!Number.isFinite(feeInNear) || feeInNear <= 0) {
    return result;
  }
  result.feeInNear = Number(feeInNear.toFixed(8));

  // 2. Token share link referral (5% fee to token link sharer)
  if (tokenAddress) {
    try {
      const tokenRef = await getTokenReferral(userId, tokenAddress);
      if (tokenRef && tokenRef.referrer_id !== userId) {
        const tokenRewardAmount = Number((feeInNear * 0.05).toFixed(8));
        if (tokenRewardAmount > 0) {
          await addTokenReferralReward(tokenRef.id, tokenRewardAmount);
          result.tokenShareRewardNear = tokenRewardAmount;
        }
      }
    } catch (err: any) {
      console.warn('[REWARDS] Failed to award token referral reward:', err?.message);
    }
  }

  // 3. Global referral reward (standard: 30%, ambassador: 45%, super ambassador: 50%)
  try {
    const referral = await getReferralByReferredUser(userId);
    let referralActive = !!referral && (referral.status === 'active' || referral.status === 'completed');
    if (referral && referral.status === 'pending') {
      await activateReferral(referral.id);
      referralActive = true;
    }
    if (referral && referralActive && referral.referrer_id !== userId) {
      result.referrerId = referral.referrer_id;
      const refFeePct = (referral as any).referrer_fee_pct != null
        ? parseFloat(String((referral as any).referrer_fee_pct))
        : ((referral as any).referrer_fee_tier === 'super_ambassador' ? 60 : ((referral as any).referrer_is_ambassador ? 45 : 15));
      const rewardAmount = Number((feeInNear * (refFeePct / 100)).toFixed(8));
      if (rewardAmount > 0) {
        await addReferralReward(referral.id, rewardAmount);
        result.referralRewardNear = rewardAmount;
      }
    }
  } catch (err: any) {
    console.warn('[REWARDS] Failed to award global referral reward:', err?.message);
  }

  // 4. Fee cashback on user's own trading fees (e.g. 5% cashback for super ambassador)
  try {
    const user = await getUserById(userId);
    const cashbackPct = user?.cashback_pct != null ? parseFloat(String(user.cashback_pct)) : 0;
    if (cashbackPct > 0) {
      const cashbackAmount = Number((feeInNear * (cashbackPct / 100)).toFixed(8));
      if (cashbackAmount > 0) {
        await addCashbackReward(userId, cashbackAmount);
        result.cashbackNear = cashbackAmount;
      }
    }
  } catch (err: any) {
    console.warn('[REWARDS] Failed to award fee cashback:', err?.message);
  }

  return result;
}

