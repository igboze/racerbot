import 'dotenv/config';
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

  // ── Express REST server ───────────────────────────────────────────────────
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use('/api', apiRouter);

  app.listen(PORT, () => {
    console.log(`[API] REST server listening on port ${PORT}`);
  });

  // ── Telegram bot ──────────────────────────────────────────────────────────
  const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
  setBotInstance(bot);
  setupRoutes(bot);

  // ── Subscribe to detector's NEW_TOKENS to warm local name cache ───────────
  const redis = createRedis(REDIS_URL);
  await redis.subscribe(CHANNELS.NEW_TOKENS, (message: string) => {
    try {
      const event: TokenDetectedEvent = JSON.parse(message);
      localTokenNames.set(event.name.toLowerCase(), {
        address: event.token_address,
        symbol: event.symbol,
      });
    } catch { /* ignore malformed */ }
  });

  // ── Start notification listener (async, non-blocking) ──────────────────────
  await startNotifyListener(REDIS_URL);

  // ── Launch bot ────────────────────────────────────────────────────────────
  bot.launch({ dropPendingUpdates: true });
  console.log('[API] Telegram bot launched');

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    console.log(`[API] ${signal} received — shutting down`);
    bot.stop(signal);
    await redis.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => {
  console.error('[API] Fatal:', err);
  process.exit(1);
});