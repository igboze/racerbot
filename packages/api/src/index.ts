import './config.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { Telegraf } from 'telegraf';
import { createRedis, CHANNELS, assertValidMasterKey, createLogger, getNear, type TokenDetectedEvent } from '@racerbot/shared';
import { getDb, runMigrations } from '@racerbot/db';
import apiRouter, { serveBubbleMapHtml, serveCompetitionHtml } from './routes/index.js';
import { setupRoutes, localTokenNames } from './routes.js';
import { setInFlightRedis } from './inflight.js';
import { setBotInstance, startNotifyListener } from './notify.js';
import { startBuyAlertListener } from './buyAlerts.js';
import { startStarknetAlertsEngine } from './starknetAlerts.js';
import { warmTokenInfoCache, syncUserTokenDeposits } from './wallet.js';
import { startDepositWatcher, stopDepositWatcher, markUserActiveForDeposit } from './depositWatcher.js';
import { metricsMiddleware, monitoringRoutes } from './monitoring.js';
import { setupMonitor } from './monitor.js';
import { startBackgroundWorkers, stopBackgroundWorkers } from './workers.js';
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

  // Run database migrations on startup to apply any pending schema changes
  await logger.time('Database migrations', () => runMigrations()).catch((err: any) => {
    logger.warn('Database migration warning (non-fatal)', { error: err?.message || err });
  });

  // FIX 6: Pre-warm the in-memory token info cache from the DB.
  // Non-blocking — runs in background so startup is not delayed.
  // Populates up to 500 recently-seen tokens so cold-start RPC calls are avoided.
  warmTokenInfoCache().catch((err: any) =>
    logger.warn('Cache warm-up failed (non-fatal)', { error: err.message })
  );

  // ── Telegram bot ──────────────────────────────────────────────────────────
  const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
  setBotInstance(bot);

  // High-performance Telegram interaction middleware:
  // 1. Auto-acknowledge callback queries immediately so button clicks never hang the Telegram UI
  // 2. Mark active user for high-cadence deposit monitoring
  // 3. 15-second handler timeout safeguard to prevent hanging handlers from leaking resources
  bot.use(async (ctx, next) => {
    if (ctx.callbackQuery) {
      ctx.answerCbQuery().catch(() => {});
    }

    if (ctx.from?.id) {
      markUserActiveForDeposit(ctx.from.id);
    }

    let timer: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<void>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Handler timeout after 15000ms (update_id: ${ctx.update?.update_id})`));
      }, 15_000);
    });

    try {
      await Promise.race([next(), timeoutPromise]);
    } catch (err: any) {
      if (err?.message?.includes('Handler timeout after 15000ms')) {
        logger.warn('Handler processing timed out', {
          updateId: ctx.update?.update_id,
          userId: ctx.from?.id,
          chatId: ctx.chat?.id,
        });
      } else {
        throw err;
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  });

  // RPC provider health checks every 30s. Without this, providers marked

  // unhealthy in THIS process were never restored (only the detector ran
  // health checks), and the trade gate would block every trade forever.
  getNear().startHealthChecks(30_000);

  // Global error handler: stale 400s (expired callback queries) are ignored;
  // anything else gets logged AND the user is told something went wrong, so
  // an unhandled handler error never leaves the user staring at silence.
  bot.catch((err: any, ctx) => {
    if (err?.response?.error_code === 400 || err?.code === 400 || String(err?.message).includes('query is too old')) {
      logger.warn('Ignored stale Telegram 400 error', {
        error: err.message,
        updateId: ctx?.update?.update_id
      });
      return;
    }
    logger.error('Telegraf unhandled error', err, { updateId: ctx?.update?.update_id });
    const chatId = ctx?.chat?.id;
    if (chatId) {
      ctx.telegram.sendMessage(chatId, 'Something went wrong, please retry.').catch(() => {
        // message may fail for the same underlying reason — already logged above
      });
    }
  });

  // Admin monitoring (commands + background alerts) registered BEFORE the
  // generic text handler so /monitor, /failures, /slow take precedence.
  setupMonitor(bot);

  let redis: any = null;
  if (!REDIS_URL) {
    console.warn('[API] REDIS_URL environment variable is not set. Operating with in-memory wallet locking.');
  } else {
    try {
      redis = createRedis(REDIS_URL);
      setInFlightRedis(redis);
      logger.info('In-flight trade guard wired to Redis for cross-replica protection');
    } catch (err: any) {
      console.warn('[API] Failed to initialize Redis for in-flight guard:', err?.message || err);
    }
  }

  setupRoutes(bot);

  // ── Express REST server ─────────────────────────────────────────────────────
  const app = express();
  // Behind Railway/nginx proxies, req.ip must come from X-Forwarded-For
  // for the rate limiter to key on real client IPs.
  app.set('trust proxy', 1);
  
  app.use(cors());
  app.use(express.json({ limit: '64kb' }));
  app.use(metricsMiddleware);

  // Mount Telegram webhook handler on the existing Express app.
  // Responds 200 OK immediately so Telegram never hits "Read timeout expired" or blocks the queue,
  // then dispatches the update asynchronously into Telegraf's pipeline.
  const webhookPath = '/telegram-webhook';
  if (PUBLIC_URL) {
    app.post(webhookPath, (req, res) => {
      if (TELEGRAM_WEBHOOK_SECRET) {
        const secretHeader = req.headers['x-telegram-bot-api-secret-token'];
        if (secretHeader !== TELEGRAM_WEBHOOK_SECRET) {
          res.status(403).send('Forbidden');
          return;
        }
      }

      // Immediately acknowledge HTTP 200 so Telegram clears the pending update instantly
      res.status(200).send('OK');

      const update = req.body;
      if (update && typeof update === 'object') {
        bot.handleUpdate(update).catch((err: any) => {
          logger.error('Error in bot.handleUpdate', err, { updateId: update.update_id });
        });
      }
    });
  }

  app.use('/assets', express.static(path.resolve(__dirname, '..', 'assets')));
  app.use('/assets', express.static(path.resolve(__dirname, 'assets')));

  app.get('/favicon.ico', (_req, res) => {
    const logoFile = path.resolve(__dirname, '..', 'assets', 'logo.png');
    const fallbackLogo = path.resolve(__dirname, 'assets', 'logo.png');
    const target = fs.existsSync(logoFile) ? logoFile : (fs.existsSync(fallbackLogo) ? fallbackLogo : null);
    if (target) {
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.sendFile(target);
    } else {
      res.status(204).end();
    }
  });

  app.use('/api', apiRouter);

  // ── Subdomain & path routing ──────────────────────────────────────────────
  // Detects token subdomains such as:
  // kookdog.bubblemap.racerbot.trade, kookdog.bubblemap.xyz, kookdog.localhost, etc.
  app.use((req, res, next) => {
    // Ignore internal API, assets, webhooks and health checks
    if (req.path.startsWith('/api') || req.path.startsWith('/assets') || req.path === '/health' || req.path === '/favicon.ico' || req.path === webhookPath) {
      return next();
    }

    const host = (req.headers.host || req.hostname || '').toLowerCase().split(':')[0];
    const parts = host.split('.');

    // Ignored root domains, railway deployment hosts, and system prefixes
    const ignoredSubdomains = new Set([
      'www', 'api', 'bot', 'admin', 'bubblemap', 'racerbotbubblemap',
      'localhost', '127', 'railway', 'app', 'racerbot', 'racerbot-production', 'up'
    ]);
    
    let tokenSubdomain: string | null = null;
    const isRailwayHost = host.endsWith('.railway.app');
    if (!isRailwayHost) {
      // Token subdomain only exists when there are 3+ parts (e.g. kookdog.racerbotbubblemap.buzz)
      // or 2 parts on localhost (kookdog.localhost)
      if ((parts.length >= 3 && !host.includes('localhost')) || (parts.length >= 2 && host.includes('localhost'))) {
        const first = parts[0];
        if (!ignoredSubdomains.has(first)) {
          tokenSubdomain = first;
        }
      }
    }

    // Only serve competition UI when explicitly requesting /competition or /leaderboard
    if (req.path === '/competition' || req.path === '/leaderboard') {
      return serveCompetitionHtml(res, tokenSubdomain || 'kookdog');
    }

    // If an actual token subdomain is used on root (e.g. kookdog.racerbotbubblemap.buzz),
    // redirect to the bubble map with token query parameter
    if (tokenSubdomain && (req.path === '/' || req.path === '/bubblemap')) {
      const rootDomain = parts.slice(1).join('.');
      const protocol = req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
      return res.redirect(`${protocol}://${rootDomain}/bubblemap?token=${encodeURIComponent(tokenSubdomain)}`);
    }

    next();
  });

  // Serve Bubble Map at root `/` and `/bubblemap` directly with zero client cache
  app.get(['/', '/bubblemap'], (req, res, next) => {
    // If request is looking for API or health, proceed to next
    if (req.path === '/health' || req.path.startsWith('/api')) return next();
    serveBubbleMapHtml(res);
  });

  // Serve Trading Competition page directly at `/competition` and `/leaderboard`
  app.get(['/competition', '/competition/:id', '/leaderboard', '/leaderboard/:id', '/:token/competition', '/:token/leaderboard'], (req, res) => {
    const compId = (req.params as any)?.id || (req.params as any)?.token || 'kookdog';
    serveCompetitionHtml(res, compId);
  });

  // Add monitoring routes
  monitoringRoutes(app);

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
  if (redis) {
    try {
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
      console.warn('[API] Redis pub/sub unavailable, token name caching inactive:', err?.message || err);
    }

    // ── Start notification listener (async, non-blocking) ──────────────────────
    try {
      await startNotifyListener(REDIS_URL);
    } catch (err: any) {
      console.warn('[API] Redis notification listener inactive:', err?.message || err);
    }

    // ── Start Telegram group buy alert listener ───────────────────────────────
    try {
      await startBuyAlertListener(REDIS_URL, bot);
    } catch (err: any) {
      console.warn('[API] Telegram group buy alert listener inactive:', err?.message || err);
    }
  }

  // ── Start Starknet Alerts Engine (@racerbotalert) ─────────────────────────
  try {
    await startStarknetAlertsEngine(bot);
  } catch (err: any) {
    console.warn('[API] Starknet alerts engine inactive:', err?.message || err);
  }

  // ── Start background sync for external token deposits ─────────────────────
  // Sync all users' external deposits every 15 minutes to detect purchases from other wallets
  // Reduced from 5 minutes to 15 minutes to reduce RPC load and avoid overlapping operations
  const SYNC_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
  const BATCH_SIZE = 10; // Process 10 users in parallel to avoid overwhelming RPC
  syncInterval = setInterval(async () => {
    try {
      const db = await getDb();
      const result = await db.query('SELECT id, telegram_id, subaccount_id FROM users');
      logger.info('Starting external deposit sync', { userCount: result.rows.length });

      let totalNewDeposits = 0;

      // Process users in parallel batches instead of sequentially
      for (let i = 0; i < result.rows.length; i += BATCH_SIZE) {
        const batch = result.rows.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.allSettled(
          batch.map(async (user) => {
            try {
              const newDeposits = await syncUserTokenDeposits(user.id, user.subaccount_id);
              if (newDeposits > 0) {
                logger.info('External deposits detected', {
                  telegramId: user.telegram_id,
                  newDeposits
                });
                return newDeposits;
              }
              return 0;
            } catch (err: any) {
              logger.warn('Failed to sync user deposits', {
                telegramId: user.telegram_id,
                error: err.message
              });
              return 0;
            }
          })
        );

        for (const batchResult of batchResults) {
          if (batchResult.status === 'fulfilled') {
            totalNewDeposits += batchResult.value;
          }
        }
      }

      if (totalNewDeposits > 0) {
        logger.info('External deposit sync completed', { totalNewDeposits });
      }
    } catch (err: any) {
      logger.error('Background sync error', err);
    }
  }, SYNC_INTERVAL_MS);
  
  logger.info('Background external deposit sync started', { intervalMs: SYNC_INTERVAL_MS });

  // ── Real-time NEAR & SUI native deposit watcher ───────────────────────────
  startDepositWatcher(12_000); // Check every 12s for fast real-time deposit alerts

  // ── Start background worker processes (detector, executor, triggers) ──────
  startBackgroundWorkers();

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    logger.info('Shutting down', { signal });
    stopBackgroundWorkers();
    bot.stop(signal);
    stopDepositWatcher();
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