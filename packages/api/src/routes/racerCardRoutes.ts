import { Router } from 'express';
import { verifiedUser } from './verifiedUser.js';
import { startRacerLink, webRacerCard, webRacerCardImage } from '../racerCard.js';
import type { RacerPeriod } from '../racerRank.js';

/** ?period=week asks for the weekly card; anything else is the all-time card. */
const periodOf = (q: unknown): RacerPeriod => (q === 'week' ? 'week' : 'all');

/**
 * NEAR Racer Card for the signed-in web user (session token or Mini App
 * initData only, never a bare wallet header). Mounted at /api/racer-card.
 */
export function createRacerCardRouter(): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    try {
      const user = await verifiedUser(req);
      if (!user) return void res.status(401).json({ error: 'Sign in to see your Racer Card' });
      const { json } = await webRacerCard(user, periodOf(req.query?.period));
      res.set('Cache-Control', 'private, no-store');
      res.json(json);
    } catch (err: any) {
      console.error('[RACER_CARD] Web card failed:', err?.message);
      res.status(500).json({ error: 'Could not load your Racer Card' });
    }
  });

  router.get('/image.png', async (req, res) => {
    try {
      const user = await verifiedUser(req);
      if (!user) return void res.status(401).json({ error: 'Sign in to see your Racer Card' });
      const png = await webRacerCardImage(user, periodOf(req.query?.period));
      if (!png) return void res.status(503).json({ error: 'Card image is not available right now' });
      res.set('Content-Type', 'image/png');
      res.set('Cache-Control', 'private, max-age=300');
      res.send(png);
    } catch (err: any) {
      console.error('[RACER_CARD] Web card image failed:', err?.message);
      res.status(500).json({ error: 'Could not render your Racer Card' });
    }
  });

  // Wallet-only accounts: get a one-time bot link; the Telegram side approves in the bot
  router.post('/link', async (req, res) => {
    try {
      const user = await verifiedUser(req);
      if (!user) return void res.status(401).json({ error: 'Sign in with your wallet first' });
      const result = await startRacerLink(user);
      if (result.status === 'telegram_account') {
        return void res.status(400).json({ error: 'This account already uses Telegram, so its card is already shared with the bot.' });
      }
      res.set('Cache-Control', 'private, no-store');
      res.json(result);
    } catch (err: any) {
      console.error('[RACER_CARD] Link start failed:', err?.message);
      res.status(500).json({ error: 'Could not start linking' });
    }
  });

  return router;
}
