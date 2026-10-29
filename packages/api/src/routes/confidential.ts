/**
 * Confidential wallet routes: private balance, ready pool settings, deposits and withdrawals.
 * Trades themselves go through /alpha/trade with isPrivateTrade (see routes/index.ts).
 */
import type { Router } from 'express';
import { createLogger } from '@racerbot/shared';
import { getConfidentialAccount, updateConfidentialSettings, type UserRecord } from '@racerbot/db';
import {
  EXECUTORS_ENABLED,
  POOL_LIMITS,
  confidentialOverview,
  depositFromWallet,
  ensureConfidentialAccount,
  poolSizesForTotal,
  refillPool,
  withdrawPrivate,
} from '../executorPool.js';

const logger = createLogger('confidential-routes');
function nearToYocto(n: unknown): bigint | null {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return null;
  return BigInt(Math.round(v * 1e6)) * 10n ** 18n;
}

const toNear = (y: bigint) => Number(y / 10n ** 18n) / 1e6;

export function registerConfidentialRoutes(router: Router, resolveUser: (req: any) => Promise<UserRecord | null>): void {
  const authed = async (req: any, res: any): Promise<UserRecord | null> => {
    const user = await resolveUser(req);
    if (!user?.subaccount_id || !user.scoped_key_encrypted) {
      res.status(401).json({ error: 'Confidential trading needs a RacerBot-managed account. Sign in with Telegram.' });
      return null;
    }
    if (!EXECUTORS_ENABLED) {
      res.status(503).json({ error: 'Confidential trading is not switched on yet.' });
      return null;
    }
    return user;
  };

  router.get('/alpha/confidential', async (req, res) => {
    try {
      const user = await authed(req, res);
      if (!user) return;
      res.json({ success: true, ...(await confidentialOverview(user)) });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to load the confidential wallet' });
    }
  });

  /**
   * Pool settings. `poolTotalNear` sets the ready pool (default 5 NEAR as 5 × 1 NEAR); `poolSizesNear`
   * sets an explicit mix instead. Each executor is at least 0.1 NEAR; the total is capped at 100 NEAR.
   */
  router.post('/alpha/confidential/settings', async (req, res) => {
    try {
      const user = await authed(req, res);
      if (!user) return;
      await ensureConfidentialAccount(user);
      const b = req.body || {};
      let sizes: bigint[] | undefined;
      if (Array.isArray(b.poolSizesNear)) {
        sizes = b.poolSizesNear.map(nearToYocto);
        if (sizes!.some(s => s === null || s < POOL_LIMITS.min)) {
          res.status(400).json({ error: `Each executor must hold at least ${toNear(POOL_LIMITS.min)} NEAR.` });
          return;
        }
      } else if (b.poolTotalNear !== undefined) {
        const total = nearToYocto(b.poolTotalNear);
        if (!total || total < POOL_LIMITS.min) {
          res.status(400).json({ error: `The pool must be at least ${toNear(POOL_LIMITS.min)} NEAR.` });
          return;
        }
        sizes = poolSizesForTotal(total).map(BigInt);
      }
      const total = sizes?.reduce((s, x) => s + x, 0n);
      if (total !== undefined && total > POOL_LIMITS.hardCap) {
        res.status(400).json({ error: `The pool can hold at most ${toNear(POOL_LIMITS.hardCap)} NEAR.` });
        return;
      }
      if (sizes && sizes.length > 20) {
        res.status(400).json({ error: 'At most 20 ready executors.' });
        return;
      }
      const buyMode = ['single', 'split', 'fleet'].includes(b.buyMode) ? b.buyMode : undefined;
      const stagger = b.fleetStaggerMaxSec === undefined ? undefined : Math.min(10, Math.max(0, Math.round(Number(b.fleetStaggerMaxSec) || 0)));
      const updated = await updateConfidentialSettings(user.id, {
        pool_sizes: sizes?.map(String),
        pool_cap_yocto: total?.toString(),
        auto_refill: typeof b.autoRefill === 'boolean' ? b.autoRefill : undefined,
        buy_mode: buyMode,
        fleet_stagger_max_sec: stagger,
        round_returns: typeof b.roundReturns === 'boolean' ? b.roundReturns : undefined,
        enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined,
      });
      if (updated) void refillPool(updated).catch(e => logger.warn(`Refill after settings failed: ${e?.message}`));
      res.json({ success: true, ...(await confidentialOverview(user)) });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to save settings' });
    }
  });

  router.post('/alpha/confidential/deposit', async (req, res) => {
    try {
      const user = await authed(req, res);
      if (!user) return;
      const amount = nearToYocto(req.body?.amountNear);
      if (!amount || amount < POOL_LIMITS.min) {
        res.status(400).json({ error: `Deposit at least ${toNear(POOL_LIMITS.min)} NEAR.` });
        return;
      }
      const result = await depositFromWallet(user, amount);
      res.json({ success: true, ...result, amountNear: toNear(amount), message: 'Deposit sent. It reaches your private balance in about 20 seconds.' });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Deposit failed' });
    }
  });

  router.post('/alpha/confidential/withdraw', async (req, res) => {
    try {
      const user = await authed(req, res);
      if (!user) return;
      const amount = nearToYocto(req.body?.amountNear);
      if (!amount) {
        res.status(400).json({ error: 'Enter an amount to withdraw.' });
        return;
      }
      const destination = typeof req.body?.destination === 'string' && req.body.destination.trim() ? req.body.destination.trim() : undefined;
      if (destination && !/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$|^[0-9a-f]{64}$/.test(destination)) {
        res.status(400).json({ error: 'That is not a valid NEAR account.' });
        return;
      }
      const result = await withdrawPrivate(user, amount, destination);
      res.json({ success: true, ...result, amountNear: toNear(amount), message: 'Withdrawal sent. It arrives in about 15 seconds.' });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Withdrawal failed' });
    }
  });

  router.post('/alpha/confidential/refill', async (req, res) => {
    try {
      const user = await authed(req, res);
      if (!user) return;
      const acct = await getConfidentialAccount(user.id);
      if (!acct) {
        res.status(400).json({ error: 'Deposit to your private balance first.' });
        return;
      }
      const started = await refillPool(acct);
      res.json({ success: true, started });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Refill failed' });
    }
  });
}

