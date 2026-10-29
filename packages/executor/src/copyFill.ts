/**
 * Settles a copy-trade fill once the executor knows the outcome. The detector records the fill as
 * 'pending' when it sends the swap; only a swap that succeeded becomes 'filled' and earns Season 1
 * points and the share-link referral reward. A failed swap is marked 'failed' with its reason.
 */
import {
  addTokenReferralReward,
  awardPointsForCopyTrade,
  getTokenReferral,
  recordTokenReferral,
  updateCopyTradeFillResult,
} from '@racerbot/db';
import type { CopyFillMeta } from '@racerbot/shared';

/** Bot fee rate the referral reward is a share of, and that share */
const BOT_FEE_RATE = 0.015;
const REFERRAL_SHARE = 0.05;

export type SwapOutcome = { ok: true; txHash?: string } | { ok: false; reason: string };

export async function settleCopyFill(copy: CopyFillMeta, outcome: SwapOutcome): Promise<void> {
  if (!outcome.ok) {
    await updateCopyTradeFillResult(copy.fill_id, 'failed', { skip_reason: outcome.reason.slice(0, 200) });
    return;
  }
  await updateCopyTradeFillResult(copy.fill_id, 'filled', { our_tx_hash: outcome.txHash });

  const volume = copy.points_volume_near;
  if (!(volume > 0)) return;
  await awardPointsForCopyTrade(copy.copier_user_id, copy.fill_id, volume, copy.leader_user_id ?? undefined).catch(() => {});

  const reward = volume * BOT_FEE_RATE * REFERRAL_SHARE;
  if (copy.referrer_id && copy.referrer_id !== copy.copier_user_id) {
    const ref = await recordTokenReferral(copy.copier_user_id, copy.token_address, copy.referrer_id).catch(() => null);
    if (ref) await addTokenReferralReward(ref.id, reward).catch(() => {});
  } else {
    const ref = await getTokenReferral(copy.copier_user_id, copy.token_address).catch(() => null);
    if (ref) await addTokenReferralReward(ref.id, reward).catch(() => {});
  }
}
