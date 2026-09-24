import './config.js';
import path from 'path';
import express from 'express';
import cors from 'cors';
import { Telegraf } from 'telegraf';
import { createRedis, CHANNELS, assertValidMasterKey, type TokenDetectedEvent } from '@racerbot/shared';
import { getDb } from '@racerbot/db';
import apiRouter from './routes/index.js';
import { setupRoutes, localTokenNames } from './routes.js';
import { setBotInstance, startNotifyListener } from './notify.js';
import { warmTokenInfoCache } from './wallet.js';
import { TELEGRAM_BOT_TOKEN, PUBLIC_URL, TELEGRAM_WEBHOOK_SECRET } from './config.js';

const PORT = parseInt(process.env.PORT ?? '3000');
const REDIS_URL = process.env.REDIS_URL!;

async function main(): Promise<void> {
  console.log('[API] Starting RacerBot API service...');

  // ── Fail fast on insecure/missing secrets ──────────────────────────────
  assertValidMasterKey(process.env.KEY_ENCRYPTION_MASTER_KEY);
  if (!TELEGRAM_BOT_TOKEN || TELEGRAM_BOT_TOKEN === 'your-bot-token-here') {
    throw new Error('TELEGRAM_BOT_TOKEN is missing or a placeholder');
  }

  // One stray rejected promise must not kill the whole trading bot
  process.on('unhandledRejection', (reason) => {
    console.error('[API] Unhandled rejection (kept alive):', reason);
  });

  // Connect to Postgres
  await getDb();

  // FIX 6: Pre-warm the in-memory token info cache from the DB.
  // Non-blocking — runs in background so startup is not delayed.
  // Populates up to 500 recently-seen tokens so cold-start RPC calls are avoided.
  warmTokenInfoCache().catch((err: any) =>
    console.warn('[API] Cache warm-up failed (non-fatal):', err.message)
  );

  // ── Telegram bot ──────────────────────────────────────────────────────────
  const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
  setBotInstance(bot);

  // Global error handler to catch expired callback queries or minor Telegram API errors
  bot.catch((err: any, ctx) => {
    if (err?.response?.error_code === 400 || err?.code === 400 || String(err?.message).includes('query is too old')) {
      console.warn(`[API] Ignored stale Telegram 400 error (${err.message}) for update ${ctx?.update?.update_id}`);
      return;
    }
    console.error(`[API] Telegraf unhandled error for update ${ctx?.update?.update_id}:`, err);
  });

  setupRoutes(bot);

  // ── Express REST server & Mini App static assets ─────────────────────────
  const app = express();
  // Behind Railway/nginx proxies, req.ip must come from X-Forwarded-For
  // for the rate limiter to key on real client IPs.
  app.set('trust proxy', 1);
  app.use(cors());
  app.use(express.json({ limit: '64kb' }));

  // Mount Telegram webhook handler on the existing Express app
  const webhookPath = '/telegram-webhook';
  if (PUBLIC_URL) {
    app.use(bot.webhookCallback(webhookPath, {
      secretToken: TELEGRAM_WEBHOOK_SECRET || undefined,
    }));
  }

  app.use('/api', apiRouter);

  const publicDir = path.resolve(process.cwd(), 'packages/api/public/miniapp');
  app.use('/miniapp', express.static(publicDir));
  app.get('/miniapp', (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  app.listen(PORT, () => {
    console.log(`[API] REST server listening on port ${PORT}`);
  });

  // ── Launch bot (Webhook if PUBLIC_URL set, fallback to long polling) ─────
  if (PUBLIC_URL) {
    const cleanDomain = PUBLIC_URL.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const webhookUrl = `https://${cleanDomain}${webhookPath}`;
    await bot.telegram.setWebhook(webhookUrl, {
      drop_pending_updates: true,
      secret_token: TELEGRAM_WEBHOOK_SECRET || undefined,
    });
    console.log(`[API] Telegram bot launched with webhook @ ${webhookUrl}`);
  } else {
    bot.launch({ dropPendingUpdates: true });
    console.log('[API] Telegram bot launched with long polling (PUBLIC_URL not set)');
  }

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