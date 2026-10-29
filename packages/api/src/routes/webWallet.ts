/**
 * Racer Alpha wallet routes: which NEAR wallet the signed-in user trades with, and creating a
 * RacerBot-managed one for users who signed in with their own wallet. Only public addresses are
 * ever returned; keys stay encrypted on the server.
 */
import type { Router } from 'express';
import { createLogger } from '@racerbot/shared';
import { getUserWallets } from '@racerbot/db';
import { createWebManagedWallet, EXTERNAL_WALLET_MARKER, hasManagedWallet } from '../webWallet.js';
import { verifiedUser } from './verifiedUser.js';

const logger = createLogger('web-wallet-routes');

export function registerWebWalletRoutes(router: Router): void {
  router.get('/alpha/wallet', async (req, res) => {
    try {
      const user = await verifiedUser(req).catch(() => null);
      if (!user) {
        res.status(401).json({ error: 'Sign in with Telegram, or connect your NEAR wallet and approve the sign-in message.' });
        return;
      }
      const wallets = await getUserWallets(user.id, 'near').catch(() => []);
      res.json({
        success: true,
        address: user.subaccount_id,
        managed: hasManagedWallet(user),
        connectedWallets: wallets.filter(w => w.encrypted_private_key === EXTERNAL_WALLET_MARKER).map(w => w.address),
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Could not load your wallet' });
    }
  });

  /** Create (or return) the user's RacerBot-managed wallet. Responds with its public address only. */
  router.post('/alpha/wallet/create', async (req, res) => {
    try {
      const user = await verifiedUser(req).catch(() => null);
      if (!user) {
        res.status(401).json({ error: 'Connect your NEAR wallet and approve the sign-in message first.' });
        return;
      }
      const { address, created } = await createWebManagedWallet(user.id);
      res.json({
        success: true,
        address,
        created,
        message: created
          ? 'Your RacerBot wallet is ready. Send NEAR to it to start trading; it appears on-chain with the first deposit.'
          : 'You already have a RacerBot wallet.',
      });
    } catch (err: any) {
      logger.warn(`Web wallet creation failed: ${err?.message}`);
      res.status(400).json({ error: err?.message || 'Could not create your wallet' });
    }
  });
}
