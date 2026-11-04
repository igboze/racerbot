import { Router } from 'express';
import { createLogger } from '@racerbot/shared';
import { verifiedUser } from './verifiedUser.js';

const logger = createLogger('fleet-routes');

/**
 * RaceFleet: multi-wallet buys, sells, distribute and sweep for the signed-in
 * owner. Mounted on the API router (paths start with /fleet).
 */
export function createFleetRouter(): Router {
  const router = Router();

  /**
   * The signed-in fleet owner: a session token or Telegram Mini App initData,
   * nothing else. Fleet routes move the user's NEAR and trade with it, so a
   * typed Telegram ID or username is never enough (and there is no fallback).
   */
  async function resolveFleetUser(req: any) {
    return verifiedUser(req).catch(() => null);
  }

  const FLEET_SIGN_IN = 'Sign in with Telegram, or connect your wallet and approve the sign-in message, to use RaceFleet.';

  // 1. Get Fleet Status & Balances
  router.get('/fleet/status', async (req, res) => {
    try {
      const user = await resolveFleetUser(req);
      if (!user) {
        res.status(401).json({ error: FLEET_SIGN_IN });
        return;
      }

      const { hasActiveRaceFleet, getFleetBalances } = await import('../raceFleet.js');
      const { getRaceFleetByUserId } = await import('@racerbot/db');

      const isActive = await hasActiveRaceFleet(user.id);
      const fleet = await getRaceFleetByUserId(user.id);

      if (!isActive || !fleet) {
        res.json({
          success: true,
          hasFleet: false,
          user: {
            id: user.id,
            username: user.username,
            telegramId: user.telegram_id,
            subaccountId: user.subaccount_id,
          },
          subscriptionFeeNear: 2.0,
          minWallets: 5,
          maxWallets: 25,
        });
        return;
      }

      const refresh = req.query.refresh === 'true';
      const balances = await getFleetBalances(fleet.id, req.query.token as string || undefined, refresh);

      res.json({
        success: true,
        hasFleet: true,
        user: {
          id: user.id,
          username: user.username,
          telegramId: user.telegram_id,
          subaccountId: user.subaccount_id,
        },
        fleet: {
          id: fleet.id,
          name: fleet.name,
          fleetTag: fleet.fleet_tag,
          status: fleet.status,
          walletCount: fleet.wallet_count,
          startsAt: fleet.starts_at,
          expiresAt: fleet.expires_at,
          autoRenew: fleet.auto_renew,
        },
        balances,
      });
    } catch (err: any) {
      logger.error('Failed to get fleet status', err);
      res.status(500).json({ error: err.message || 'Failed to fetch fleet status' });
    }
  });

  // 2. Deploy a New Fleet (Subscription)
  router.post('/fleet/deploy', async (req, res) => {
    try {
      const user = await resolveFleetUser(req);
      if (!user) {
        res.status(401).json({ error: FLEET_SIGN_IN });
        return;
      }

      const { walletCount, fleetName } = req.body;
      const count = parseInt(walletCount, 10) || 10;
      const { deployRaceFleet } = await import('../raceFleet.js');
      const userRef = (user.telegram_id && user.telegram_id > 0) ? user.telegram_id : user;

      const result = await deployRaceFleet(userRef, count, fleetName || 'Alpha Fleet');
      if (!result.success) {
        res.status(400).json({ error: result.reason || 'Deployment failed' });
        return;
      }

      res.json({
        success: true,
        fleet: result.fleet,
        wallets: result.wallets,
      });
    } catch (err: any) {
      logger.error('Failed to deploy fleet', err);
      res.status(500).json({ error: err.message || 'Fleet deployment failed' });
    }
  });

  // 3. 1-Click Distribute NEAR to Fleet Wallets
  router.post('/fleet/distribute', async (req, res) => {
    try {
      const user = await resolveFleetUser(req);
      if (!user) {
        res.status(401).json({ error: FLEET_SIGN_IN });
        return;
      }

      const totalNear = parseFloat(req.body.totalNear) || 0;
      if (totalNear <= 0) {
        res.status(400).json({ error: 'Please enter a valid NEAR amount to distribute' });
        return;
      }

      const { distributeFundsToFleet } = await import('../raceFleet.js');
      const userRef = (user.telegram_id && user.telegram_id > 0) ? user.telegram_id : user;
      const result = await distributeFundsToFleet(userRef, totalNear);

      if (!result.success) {
        res.status(400).json({ error: result.reason || 'Distribution failed' });
        return;
      }

      res.json(result);
    } catch (err: any) {
      logger.error('Failed to distribute funds to fleet', err);
      res.status(500).json({ error: err.message || 'Distribution failed' });
    }
  });

  // 4. 1-Click Sweep Funds from Fleet back to Main Wallet
  router.post('/fleet/sweep', async (req, res) => {
    try {
      const user = await resolveFleetUser(req);
      if (!user) {
        res.status(401).json({ error: FLEET_SIGN_IN });
        return;
      }

      const { sweepFleetFunds } = await import('../raceFleet.js');
      const userRef = (user.telegram_id && user.telegram_id > 0) ? user.telegram_id : user;
      const result = await sweepFleetFunds(userRef);

      if (!result.success) {
        res.status(400).json({ error: result.reason || 'Sweep failed' });
        return;
      }

      res.json(result);
    } catch (err: any) {
      logger.error('Failed to sweep fleet funds', err);
      res.status(500).json({ error: err.message || 'Sweep failed' });
    }
  });

  // 5. Coordinated Bundle Buy across all Fleet Wallets
  router.post('/fleet/bundle-buy', async (req, res) => {
    try {
      const user = await resolveFleetUser(req);
      if (!user) {
        res.status(401).json({ error: FLEET_SIGN_IN });
        return;
      }

      const { getRaceFleetByUserId } = await import('@racerbot/db');
      const fleet = await getRaceFleetByUserId(user.id);
      if (!fleet) {
        res.status(400).json({ error: 'No active fleet deployed for this account' });
        return;
      }

      const { tokenAddress, amountNearPerWallet, slippagePct } = req.body;
      if (!tokenAddress) {
        res.status(400).json({ error: 'tokenAddress is required' });
        return;
      }

      const amount = parseFloat(amountNearPerWallet) || 1.0;
      const slippage = parseFloat(slippagePct) || 3.0;

      const { executeFleetBundleBuy } = await import('../raceFleet.js');
      const result = await executeFleetBundleBuy(fleet.id, tokenAddress, amount, slippage);

      res.json(result);
    } catch (err: any) {
      logger.error('Failed to execute bundle buy', err);
      res.status(500).json({ error: err.message || 'Bundle buy failed' });
    }
  });

  // 6. Coordinated Bundle Sell across all Fleet Wallets
  router.post('/fleet/bundle-sell', async (req, res) => {
    try {
      const user = await resolveFleetUser(req);
      if (!user) {
        res.status(401).json({ error: FLEET_SIGN_IN });
        return;
      }

      const { getRaceFleetByUserId } = await import('@racerbot/db');
      const fleet = await getRaceFleetByUserId(user.id);
      if (!fleet) {
        res.status(400).json({ error: 'No active fleet deployed for this account' });
        return;
      }

      const { tokenAddress, sellPct, slippagePct } = req.body;
      if (!tokenAddress) {
        res.status(400).json({ error: 'tokenAddress is required' });
        return;
      }

      const pct = parseFloat(sellPct) || 100;
      const slippage = parseFloat(slippagePct) || 3.0;

      const { executeFleetBundleSell } = await import('../raceFleet.js');
      const result = await executeFleetBundleSell(fleet.id, tokenAddress, pct, slippage);

      res.json(result);
    } catch (err: any) {
      logger.error('Failed to execute bundle sell', err);
      res.status(500).json({ error: err.message || 'Bundle sell failed' });
    }
  });

  // 7. Fleet Holdings & Performance
  router.get('/fleet/holdings', async (req, res) => {
    try {
      const user = await resolveFleetUser(req);
      if (!user) {
        res.status(401).json({ error: FLEET_SIGN_IN });
        return;
      }

      const { buildFleetHoldingsView } = await import('../raceFleet.js');
      const view = await buildFleetHoldingsView(user.telegram_id, req.query.refresh === 'true');

      const { getRaceFleetByUserId, getRaceFleetFills } = await import('@racerbot/db');
      const fleet = await getRaceFleetByUserId(user.id);
      let fills: any[] = [];
      if (fleet) {
        fills = await getRaceFleetFills(fleet.id).catch(() => []);
      }

      res.json({
        success: true,
        summaryText: view.text,
        fills,
      });
    } catch (err: any) {
      logger.error('Failed to get fleet holdings', err);
      res.status(500).json({ error: err.message || 'Failed to fetch fleet holdings' });
    }
  });

  return router;
}
