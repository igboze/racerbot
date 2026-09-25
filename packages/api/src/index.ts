import './config.js';
import path from 'path';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { Telegraf } from 'telegraf';
import { createRedis, CHANNELS, assertValidMasterKey, createLogger, generateCorrelationId, type TokenDetectedEvent } from '@racerbot/shared';
import { getDb } from '@racerbot/db';
import apiRouter from './routes/index.js';
import { setupRoutes, localTokenNames } from './routes.js';
import { setBotInstance, startNotifyListener } from './notify.js';
import { warmTokenInfoCache, syncUserTokenDeposits } from './wallet.js';
import { metricsMiddleware, monitoringRoutes } from './monitoring.js';
import { TELEGRAM_BOT_TOKEN, PUBLIC_URL, TELEGRAM_WEBHOOK_SECRET } from './config.js';

const logger = createLogger('api');

const PORT = parseInt(process.env.PORT ?? '3000');
const REDIS_URL = process.env.REDIS_URL!;

let syncInterval: NodeJS.Timeout | null = null;

async function main(): Promise<void> {
  logger.info('Starting RacerBot API service...');

  // ── Fail fast on insecure/missing secrets ──────────────────────────────
  assertValidMasterKey(process.env.KEY_ENCRYPTION_MASTER_KEY);
  if (!TELEGRAM_BOT_TOKEN || TELEGRAM_BOT_TOKEN === 'your-bot-token-here') {
    throw new Error('TELEGRAM_BOT_TOKEN is missing or a placeholder');
  }

  // One stray rejected promise must not kill the whole trading bot
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection (kept alive)', undefined, { reason });
  });

  // Connect to Postgres
  await logger.time('Connected to Postgres', () => getDb());

  // FIX 6: Pre-warm the in-memory token info cache from the DB.
  // Non-blocking — runs in background so startup is not delayed.
  // Populates up to 500 recently-seen tokens so cold-start RPC calls are avoided.
  warmTokenInfoCache().catch((err: any) =>
    logger.warn('Cache warm-up failed (non-fatal)', { error: err.message })
  );

  // ── Telegram bot ──────────────────────────────────────────────────────────
  const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
  setBotInstance(bot);

  // Global error handler to catch expired callback queries or minor Telegram API errors
  bot.catch((err: any, ctx) => {
    if (err?.response?.error_code === 400 || err?.code === 400 || String(err?.message).includes('query is too old')) {
      logger.warn('Ignored stale Telegram 400 error', { 
        error: err.message, 
        updateId: ctx?.update?.update_id 
      });
      return;
    }
    logger.error('Telegraf unhandled error', err, { updateId: ctx?.update?.update_id });
  });

  setupRoutes(bot);

  // ── Express REST server & Mini App static assets ─────────────────────────
  const app = express();
  // Behind Railway/nginx proxies, req.ip must come from X-Forwarded-For
  // for the rate limiter to key on real client IPs.
  app.set('trust proxy', 1);
  
  // Security headers
  app.use(helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://telegram.org", "https://cdn.jsdelivr.net"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'", "https:", "http:"],
      },
    },
  }));
  
  app.use(cors());
  app.use(express.json({ limit: '64kb' }));
  app.use(metricsMiddleware);

  // Mount Telegram webhook handler on the existing Express app
  const webhookPath = '/telegram-webhook';
  if (PUBLIC_URL) {
    app.use(bot.webhookCallback(webhookPath, {
      secretToken: TELEGRAM_WEBHOOK_SECRET || undefined,
    }));
  }

  app.use('/api', apiRouter);

  // Add monitoring routes
  monitoringRoutes(app);

  const publicDir = path.resolve(process.cwd(), 'packages/api/public/miniapp');
  app.use('/miniapp', express.static(publicDir));
  app.get('/miniapp', (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });
  app.get(['/pnl-card', '/miniapp/pnl', '/pnl-card.html'], (_req, res) => {
    res.sendFile(path.join(publicDir, 'pnl.html'));
  });

  app.listen(PORT, () => {
    logger.info('REST server listening', { port: PORT });
  });

  // ── Launch bot (Webhook if PUBLIC_URL set, fallback to long polling) ─────
  if (PUBLIC_URL) {
    const cleanDomain = PUBLIC_URL.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const webhookUrl = `https://${cleanDomain}${webhookPath}`;
    await bot.telegram.setWebhook(webhookUrl, {
      drop_pending_updates: true,
      secret_token: TELEGRAM_WEBHOOK_SECRET || undefined,
    });
    logger.info('Telegram bot launched with webhook', { webhookUrl });
  } else {
    bot.launch({ dropPendingUpdates: true });
    logger.info('Telegram bot launched with long polling (PUBLIC_URL not set)');
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
        logger.debug('Token name cached', { token: event.name, address: event.token_address });
      } catch { /* ignore malformed */ }
    });
  } catch (err: any) {
    logger.warn('Redis pub/sub unavailable, token name caching inactive', { error: err.message });
  }

  // ── Start notification listener (async, non-blocking) ──────────────────────
  try {
    await startNotifyListener(REDIS_URL);
  } catch (err: any) {
    logger.warn('Redis notification listener inactive', { error: err.message });
  }

  // ── Start background sync for external token deposits ─────────────────────
  // Sync all users' external deposits every 5 minutes to detect purchases from other wallets
  const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  syncInterval = setInterval(async () => {
    try {
      const db = await getDb();
      const result = await db.query('SELECT id, telegram_id, subaccount_id FROM users');
      logger.info('Starting external deposit sync', { userCount: result.rows.length });
      
      let totalNewDeposits = 0;
      for (const user of result.rows) {
        try {
          const newDeposits = await syncUserTokenDeposits(user.id, user.subaccount_id);
          if (newDeposits > 0) {
            totalNewDeposits += newDeposits;
            logger.info('External deposits detected', { 
              telegramId: user.telegram_id, 
              newDeposits 
            });
          }
        } catch (err: any) {
          logger.warn('Failed to sync user deposits', { 
            telegramId: user.telegram_id, 
            error: err.message 
          });
        }
      }
      
      if (totalNewDeposits > 0) {
        logger.info('External deposit sync completed', { totalNewDeposits });
      }
    } catch (err: any) {
      logger.error('Background sync error', { error: err.message });
    }
  }, SYNC_INTERVAL_MS);
  
  logger.info('Background external deposit sync started', { intervalMs: SYNC_INTERVAL_MS });

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    logger.info('Shutting down', { signal });
    bot.stop(signal);
    if (syncInterval) {
      clearInterval(syncInterval);
      syncInterval = null;
    }
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