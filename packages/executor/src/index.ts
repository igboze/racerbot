import 'dotenv/config';
import { pathToFileURL } from 'url';
import { createRedis, CHANNELS, assertValidMasterKey, createLogger, generateCorrelationId, getNear, type SwapEvent, type AutoBuySignal } from '@racerbot/shared';
import { getDb } from '@racerbot/db';
import { SwapExecutor, warmAllKeys, ensureRefStorage, ensureTreasuryStorage, preWarmActiveSnipeStorage } from './executor.js';
import { settleCopyFill } from './copyFill.js';
import { PARENT_ACCOUNT, MASTER_KEY } from './config.js';

const REDIS_URL = process.env.REDIS_URL!;
const logger = createLogger('executor');
const executor = new SwapExecutor();
const redis = createRedis(REDIS_URL);

async function main(): Promise<void> {
  logger.info('Starting warm signing service...', { parentAccount: PARENT_ACCOUNT });

  // Fail fast — never decrypt user keys with a missing/placeholder master key
  assertValidMasterKey(MASTER_KEY);

  // One stray rejected promise must not kill the signing service
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection (kept alive)', undefined, { reason });
  });

  // Connect DB
  await logger.time('Connected to database', () => getDb());

  // Reap orphaned 'pending' trade attempts. A service restart or hard crash
  // mid-trade leaves rows pending forever; users then believe a trade is still
  // running and stop retrying. Any attempt older than 5 minutes is a corpse —
  // the trade deadline (30s) guarantees live trades resolve far sooner.
  const reapStaleAttempts = async () => {
    try {
      const db = await getDb();
      const res = await db.query(
        `UPDATE trade_attempts
         SET status = 'failed',
             error = 'Expired: trade never completed (service restart or hard timeout)'
         WHERE status = 'pending' AND created_at < now() - interval '5 minutes'`
      );
      const reaped = res.rowCount ?? 0;
      if (reaped > 0) {
        logger.warn('Reaped stale pending trade attempts', { count: reaped });
      }
    } catch (err: any) {
      logger.warn('Stale-attempt reaper failed (will retry next tick)', { error: err?.message });
    }
  };
  await reapStaleAttempts();
  setInterval(reapStaleAttempts, 60_000);

  // RPC provider health checks every 30s in this process too — without them
  // providers marked unhealthy here were never restored and the trade gate
  // would block every trade forever.
  getNear().startHealthChecks(30_000);

  // Pre-warm ALL user scoped keys into memory before accepting events
  await logger.time('Warmed user keys', () => warmAllKeys());

  // Confirm router contract storage registration on Ref Finance
  await logger.time('Checked Ref Finance storage', () => ensureRefStorage());

  // Confirm treasury storage registration on wrap.near
  await logger.time('Checked Treasury wrap.near storage', () => ensureTreasuryStorage());

  // Pre-warm storage deposit on NEAR for all active snipe targets
  await logger.time('Pre-warmed active snipe storage', () => preWarmActiveSnipeStorage());
  setInterval(preWarmActiveSnipeStorage, 60_000);

  // Subscribe to swap execution events from API and triggers
  await redis.subscribe(CHANNELS.EXECUTE_SWAP, async (message: string) => {
    const correlationId = generateCorrelationId();
    let event: SwapEvent;
    try {
      event = JSON.parse(message);
    } catch {
      logger.error('Bad swap event JSON', undefined, { correlationId });
      return;
    }
    logger.info('Swap event received', {
      correlationId,
      userId: event.user_id,
      token: event.token_out,
    });

    await logger.time('Swap executed', async () => {
      const result = await executor.execute(event).catch(async (err: Error) => {
        if (event.copy) {
          await settleCopyFill(event.copy, { ok: false, reason: err.message ?? 'swap failed' })
            .catch(e => logger.warn('Copy fill settle failed', { error: e?.message, fillId: event.copy?.fill_id }));
        }
        logger.error('Swap failed', err, { correlationId, userId: event.user_id });
        if ((event as any).trigger_id) {
          try {
            const db = await getDb();
            await db.query("UPDATE triggers SET status = 'active' WHERE id = $1", [(event as any).trigger_id]);
            logger.info('Re-armed failed trigger so it can retry', { triggerId: (event as any).trigger_id });
          } catch (rearmErr: any) {
            logger.warn('Failed to re-arm trigger:', { error: rearmErr.message });
          }
        }
        // Notify the user via Telegram — notify.ts resolves telegram_id from data.user_id
        try {
          const NATIVE = new Set(['near', 'wrap.near', 'sui', '0x0', 'So11111111111111111111111111111111111111112']);
          const isSellEvent = !NATIVE.has(event.token_in);
          const rawToken = isSellEvent ? event.token_in : event.token_out;
          await redis.publish(
            CHANNELS.NOTIFY_USER,
            JSON.stringify({
              type: 'notify_user',
              telegram_id: 0, // resolved by notify.ts from data.user_id below
              event: 'trade_failed',
              data: {
                user_id: event.user_id,
                txHash: 'none',
                reason: err.message ?? 'Unknown executor error',
                token: rawToken,
                is_sell: isSellEvent,
                chain: event.chain,
                trigger_id: (event as any).trigger_id,
              },
            })
          );
        } catch (notifyErr: any) {
          logger.warn('Failed to publish trade_failed notification', { error: notifyErr.message });
        }
        return null;
      });
      // A failure the executor returned (rather than threw) is still a failed copy
      if (event.copy && result) {
        await settleCopyFill(event.copy, result.success === false
          ? { ok: false, reason: result.reason || 'swap failed' }
          : { ok: true, txHash: result.txHash })
          .catch(e => logger.warn('Copy fill settle failed', { error: e?.message, fillId: event.copy?.fill_id }));
      }
    }, { correlationId, userId: event.user_id });
  });

  // Subscribe to auto-buy signals from detector
  await redis.subscribe(CHANNELS.AUTO_BUY_SIGNAL, async (message: string) => {
    const correlationId = generateCorrelationId();
    let signal: AutoBuySignal;
    try {
      signal = JSON.parse(message);
    } catch {
      logger.error('Bad auto-buy signal JSON', undefined, { correlationId });
      return;
    }
    logger.info('Auto-buy signal received', {
      correlationId,
      userId: signal.user_id,
      token: signal.token_address,
    });

    await logger.time('Auto-buy executed', async () => {
      await executor.autoBuy(signal).catch(async (err: Error) => {
        logger.error('Auto-buy failed', err, { correlationId, userId: signal.user_id });
        try {
          await redis.publish(
            CHANNELS.NOTIFY_USER,
            JSON.stringify({
              type: 'notify_user',
              telegram_id: 0,
              event: 'trade_failed',
              data: {
                user_id: signal.user_id,
                txHash: 'none',
                reason: err.message ?? 'Auto-buy executor error',
                token: signal.token_address,
                is_sell: false,
                chain: signal.chain,
              },
            })
          );
        } catch (notifyErr: any) {
          logger.warn('Failed to publish auto-buy trade_failed notification', { error: notifyErr.message });
        }
      });
    }, { correlationId, userId: signal.user_id });
  });

  logger.info('Ready — listening for swap events');

  process.on('SIGINT', async () => {
    console.log('[EXECUTOR] Shutting down...');
    await redis.disconnect();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await redis.disconnect();
    process.exit(0);
  });
}

// Run main() ONLY when this file is the process entrypoint. Importing
// @racerbot/executor (e.g. from the API for key warming) used to boot a
// second executor that subscribed to the same Redis channel and
// double-executed every swap. The executor now loads new keys lazily from
// the DB on first use, so cross-process imports are never needed.
const isDirectRun =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch(err => {
    console.error('[EXECUTOR] Fatal:', err);
    process.exit(1);
  });
}

export { addUserKey, warmAllKeys, SwapExecutor, ensureRefStorage, ensureRefTokenRegistered, RefRegistrationTracker } from './executor.js';