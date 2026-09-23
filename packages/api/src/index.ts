import 'dotenv/config';
import path from 'path';
import express from 'express';
import cors from 'cors';
import { Telegraf } from 'telegraf';
import { createRedis, CHANNELS, type TokenDetectedEvent } from '@racerbot/shared';
import { getDb } from '@racerbot/db';
import apiRouter from './routes/index.js';
import { setupRoutes, localTokenNames } from './routes.js';
import { setBotInstance, startNotifyListener } from './notify.js';
import { TELEGRAM_BOT_TOKEN } from './config.js';

const PORT = parseInt(process.env.PORT ?? '3000');
const REDIS_URL = process.env.REDIS_URL!;

async function main(): Promise<void> {
  console.log('[API] Starting RacerBot API service...');

  // Connect to Postgres
  await getDb();

  // ── Express REST server & Mini App static assets ─────────────────────────
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use('/api', apiRouter);

  const publicDir = path.resolve(process.cwd(), 'packages/api/public/miniapp');
  app.use('/miniapp', express.static(publicDir));
  app.get('/miniapp', (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  app.listen(PORT, () => {
    console.log(`[API] REST server listening on port ${PORT}`);
  });

  // ── Telegram bot ──────────────────────────────────────────────────────────
  const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
  setBotInstance(bot);
  setupRoutes(bot);

  // ── Launch bot immediately ────────────────────────────────────────────────
  bot.launch({ dropPendingUpdates: true });
  console.log('[API] Telegram bot launched successfully!');

  // ── Subscribe to detector's NEW_TOKENS to warm local name cache (async) ───
  let redis: any = null;
  try {
    redis = createRedis(REDIS_URL);
    await redis.subscribe(CHANNELS.NEW_TOKENS, (message: string) => {
      try {
        const event: TokenDetectedEvent = JSON.parse(message);
        localTokenNames.set(event.name.toLowerCase(), {
          address: event.token_address,
          symbol: event.symbol,
        });
      } catch { /* ignore malformed */ }
    });
  } catch (err: any) {
    console.warn('[API] Redis pub/sub unavailable, token name caching inactive:', err.message);
  }

  // ── Start notification listener (async, non-blocking) ──────────────────────
  try {
    await startNotifyListener(REDIS_URL);
  } catch (err: any) {
    console.warn('[API] Redis notification listener inactive:', err.message);
  }

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    console.log(`[API] ${signal} received — shutting down`);
    bot.stop(signal);
    if (redis) {
      await redis.disconnect().catch(() => {});
    }
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => {
  console.error('[API] Fatal:', err);
  process.exit(1);
});