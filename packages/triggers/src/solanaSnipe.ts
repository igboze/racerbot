import 'dotenv/config';
import {
  createRedis,
  CHANNELS,
  createLogger,
  isSolanaAddress,
  isSolanaTokenTradable,
  getSolanaTokenInfo,
  getPumpLatestLaunches,
  getPumpLaunchesByCreator,
  type AutoBuySignal,
  type PumpLaunch,
} from '@racerbot/shared';
import {
  getDistinctActiveSnipeTokens,
  getActiveTokenSnipes,
  getAllActiveDeployerSnipes,
  recordSnipeTrigger,
  type SnipeOrderRecord,
} from '@racerbot/db';

/**
 * Solana snipe watchdog.
 *
 *  - Token snipes: an armed mint fires as soon as it can be bought (a live
 *    pump.fun bonding curve, or a priced token Jupiter can route).
 *  - Deployer snipes: watches pump.fun launches. One call to the public
 *    "newest coins" feed covers every watched creator at once; a slower
 *    per-creator catch-up call covers gaps (for example after a restart).
 *    Only coins launched AFTER the order was armed, and at most a few minutes
 *    old, are bought, so a restart never buys stale launches.
 *
 * Everything here uses free HTTP APIs (pump.fun, Jupiter). No RPC is used.
 */

const logger = createLogger('triggers:solana-snipe');
const redis = createRedis(process.env.REDIS_URL!);

const TICK_MS = Number(process.env.SOLANA_SNIPE_TICK_MS || 3000);
const TOKEN_NEGATIVE_TTL_MS = 6000;
const CATCHUP_INTERVAL_MS = 60_000;
/** Launches older than this are never sniped (protects against late fills). */
const MAX_LAUNCH_AGE_MS = Number(process.env.SOLANA_SNIPE_MAX_LAUNCH_AGE_MS || 5 * 60_000);

const tokenNegativeCache = new Map<string, number>();
const deployerCatchupAt = new Map<string, number>();
const firedLaunches = new Map<string, number>(); // `${orderId}:${mint}` → ts

async function fireSnipe(order: SnipeOrderRecord, mint: string, venue: 'pumpfun' | 'jupiter'): Promise<void> {
  const key = `${order.id}:${mint}`;
  if (firedLaunches.has(key)) return;
  const triggerId = await recordSnipeTrigger(order.id, mint, venue).catch(() => null);
  if (!triggerId) return; // already pending or filled
  firedLaunches.set(key, Date.now());
  const signal: AutoBuySignal = {
    type: 'auto_buy_signal',
    chain: 'solana',
    user_id: order.user_id,
    token_address: mint,
    amount_near: order.amount_near.toString(), // SOL amount for Solana orders
    venue,
    timestamp: Date.now(),
    snipe_order_id: order.id,
    snipe_trigger_id: triggerId,
    snipe_type: order.snipe_type,
  };
  await redis.publish(CHANNELS.AUTO_BUY_SIGNAL, JSON.stringify(signal));
  logger.info(`Solana ${order.snipe_type} snipe ${order.id} fired for ${mint} (user ${order.user_id})`);
}

async function checkTokenSnipes(): Promise<void> {
  const tokens = (await getDistinctActiveSnipeTokens().catch(() => [] as string[])).filter((t) => isSolanaAddress(t));
  const now = Date.now();
  // Sequential on purpose: the Jupiter free tier is shared by the whole process.
  for (const mint of tokens) {
    const neg = tokenNegativeCache.get(mint);
    if (neg && now - neg < TOKEN_NEGATIVE_TTL_MS) continue;
    try {
      if (!(await isSolanaTokenTradable(mint))) {
        tokenNegativeCache.set(mint, Date.now());
        continue;
      }
      tokenNegativeCache.delete(mint);
      const info = await getSolanaTokenInfo(mint).catch(() => null);
      const venue = info?.launchpad === 'pump.fun' && info.bondingPhase === 'prebonded' ? 'pumpfun' : 'jupiter';
      const orders = await getActiveTokenSnipes(mint).catch(() => [] as SnipeOrderRecord[]);
      for (const order of orders) await fireSnipe(order, mint, venue);
    } catch (err: any) {
      logger.warn('Solana token snipe check failed', { mint, error: err?.message });
    }
  }
}

function launchMatches(order: SnipeOrderRecord, launch: PumpLaunch): boolean {
  if (!launch.createdAt) return false;
  const armedAt = new Date(order.created_at).getTime();
  const executeAfter = order.execute_after ? new Date(order.execute_after).getTime() : 0;
  // Small tolerance for clock skew between pump.fun and our database.
  if (launch.createdAt < Math.max(armedAt, executeAfter) - 5000) return false;
  return Date.now() - launch.createdAt <= MAX_LAUNCH_AGE_MS;
}

async function handleLaunches(launches: PumpLaunch[], byCreator: Map<string, SnipeOrderRecord[]>): Promise<void> {
  for (const launch of launches) {
    const orders = byCreator.get(launch.creator);
    if (!orders) continue;
    for (const order of orders) {
      if (launchMatches(order, launch)) {
        await fireSnipe(order, launch.mint, launch.complete ? 'jupiter' : 'pumpfun').catch((err) =>
          logger.warn('Deployer snipe fire failed', { orderId: order.id, error: err?.message }),
        );
      }
    }
  }
}

async function checkDeployerSnipes(): Promise<void> {
  const orders = (await getAllActiveDeployerSnipes().catch(() => [] as SnipeOrderRecord[]))
    .filter((o) => o.deployer_address && isSolanaAddress(o.deployer_address));
  if (orders.length === 0) return;

  const byCreator = new Map<string, SnipeOrderRecord[]>();
  for (const o of orders) {
    const list = byCreator.get(o.deployer_address!) || [];
    list.push(o);
    byCreator.set(o.deployer_address!, list);
  }

  // 1. Global newest-launches feed (one call for every watched creator).
  try {
    const latest = await getPumpLatestLaunches(50);
    await handleLaunches(latest, byCreator);
  } catch (err: any) {
    logger.warn('pump.fun latest feed failed', { error: err?.message });
  }

  // 2. Catch-up: one creator per tick, each at most once a minute.
  const now = Date.now();
  for (const creator of byCreator.keys()) {
    if (now - (deployerCatchupAt.get(creator) || 0) < CATCHUP_INTERVAL_MS) continue;
    deployerCatchupAt.set(creator, now);
    try {
      const mine = await getPumpLaunchesByCreator(creator, 5);
      await handleLaunches(mine, byCreator);
    } catch (err: any) {
      logger.warn('pump.fun creator catch-up failed', { creator, error: err?.message });
    }
    break;
  }
}

function pruneMemory(): void {
  const cutoff = Date.now() - 60 * 60_000;
  for (const [k, ts] of firedLaunches) if (ts < cutoff) firedLaunches.delete(k);
  for (const [k, ts] of tokenNegativeCache) if (ts < cutoff) tokenNegativeCache.delete(k);
}

export async function runSolanaSnipeEngine(): Promise<void> {
  logger.info('Solana snipe watchdog started', { tickMs: TICK_MS });
  let ticks = 0;
  for (;;) {
    try {
      await Promise.all([checkTokenSnipes(), checkDeployerSnipes()]);
      if (++ticks % 200 === 0) pruneMemory();
    } catch (err: any) {
      logger.error('Solana snipe tick error', err);
    }
    await new Promise((r) => setTimeout(r, TICK_MS));
  }
}
