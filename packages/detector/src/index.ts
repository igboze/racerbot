import 'dotenv/config';
import {
  getNear,
  createRedis,
  CHANNELS,
  createLogger,
  generateCorrelationId,
  DEFAULT_RPC_URLS,
  getNearUsdPrice,
  isCoreToken,
  isAuditedLaunchpadToken,
  isIntearToken,
  type TokenDetectedEvent,
  type PoolCreatedEvent,
  type PriceUpdateEvent,
  type AutoBuySignal,
  type BuyAlertEvent,
} from '@racerbot/shared';
import {
  getDb,
  upsertTokenCache,
  getTokenCache,
  getActiveTriggers,
  getPositionsByIds,
  getActiveTokenSnipes,
  getActiveDeployerSnipes,
  getDistinctActiveSnipeTokens,
  getDistinctActiveBuyAlertTokens,
  recordSnipeTrigger,
} from '@racerbot/db';
import { initCopyTradeDetector, checkCopyTradeReceipt } from './copyTrade.js';

const logger = createLogger('detector');

// ── In-memory caches (primary read path — never query DB in hot loop) ─────────

/** token_address → { price, liquidity, marketCap, timestamp } */
const priceCache = new Map<string, { price: number; liquidity: number; marketCap: number; ts: number }>();

/** token_address → TokenDetectedEvent (for snipe-by-name matching) */
const tokenNameCache = new Map<string, TokenDetectedEvent>();

/** Set of lowercase token addresses currently tracked by any Telegram group */
let activeBuyAlertTokens = new Set<string>();

/**
 * Snipe watchdog negative result cache (15s TTL).
 * When a poll cycle finds no pool for a snipe target, we skip it on the next
 * tick to avoid burning 3 RPC calls per 5s per armed token on a non-existent pool.
 * Cache is cleared immediately when a block event touches the token contract.
 */
const snipeNegativeCache = new Map<string, number>(); // tokenAddress → timestamp
const SNIPE_NEGATIVE_TTL_MS = 3_000;

async function refreshActiveBuyAlertTokens(): Promise<void> {
  try {
    const tokens = await getDistinctActiveBuyAlertTokens();
    activeBuyAlertTokens = new Set(tokens.map(t => t.toLowerCase()));
  } catch (err: any) {
    // Non-fatal
  }
}

// ── RPC + Redis setup ────────────────────────────────────────────────────────

const REDIS_URL = process.env.REDIS_URL!;
const envRpcUrls = (process.env.RPC_PROVIDERS ?? '')
  .split(',')
  .map(u => u.trim())
  .filter(Boolean);
const RPC_URLS = envRpcUrls.length > 0 ? envRpcUrls : DEFAULT_RPC_URLS;
if (envRpcUrls.length === 0) {
  console.warn('[DETECTOR] RPC_PROVIDERS not set — using built-in default RPCs');
}
const POLL_INTERVAL_MS = 1000; // NEAR block time ~1.2s
const TRIGGER_PRICE_REFRESH_MS = 30_000; // 30s — well within 60s staleness guard in trigger engine
const LAST_BLOCK_KEY = 'detector:last_block';
const MAX_CATCHUP_BLOCKS = 50; // bounded replay after downtime

// Rhea Finance = Ref Finance rebrand; pools live on v2.ref-finance.near & dclv2.ref-labs.near
// (rhea.finance is only the website — watching it alone missed every launch).
const RHEA_RECEIVERS = new Set(['rhea.finance', 'v2.ref-finance.near', 'dclv2.ref-labs.near', 'dcl.ref-finance.near']);

const near = getNear(RPC_URLS);
const redis = createRedis(REDIS_URL);

// ── Main loop ────────────────────────────────────────────────────────────────

async function main() {
  await logger.time('Connected to database', () => getDb());
  near.startHealthChecks(30_000);

  // One stray rejected promise must not kill the block watcher
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection (kept alive)', undefined, { reason });
  });

  // Stop-loss/take-profit prices must not depend on a swap happening to
  // occur — refresh every token with an active trigger on a fixed cadence.
  setInterval(() => {
    void refreshTriggerTokenPrices();
  }, TRIGGER_PRICE_REFRESH_MS);

  // Active targeted snipe watchdog (checks armed tokens like token.intear.near every 2.5s)
  setInterval(() => {
    void pollActiveTokenSnipes();
  }, 2_500);

  // Initialize copy-trade wallet tracker (refreshes every 60s from DB)
  await initCopyTradeDetector().catch(err =>
    logger.error('Copy-trade detector init failed (non-fatal)', err as Error)
  );

  // Initialize active group buy alert tracked tokens (refreshes every 10s from DB)
  await refreshActiveBuyAlertTokens().catch(() => {});
  setInterval(() => {
    void refreshActiveBuyAlertTokens();
  }, 10_000);

  logger.info('Starting NEAR block watcher...', { rpcProviders: RPC_URLS.length });

  let lastBlock = parseInt((await redis.get(LAST_BLOCK_KEY)) ?? '0');

  // Case 1 & 2: Initial bootstrap or jump forward if too far behind
  const initialHeight = await fetchBlockHeight();
  if (initialHeight > 0) {
    if (lastBlock === 0) {
      console.log(`[DETECTOR] Initializing block tracking at current height: ${initialHeight}`);
      lastBlock = initialHeight;
      await redis.set(LAST_BLOCK_KEY, initialHeight.toString(), 86400).catch(() => {});
    } else if (initialHeight - lastBlock > MAX_CATCHUP_BLOCKS) {
      logger.info('Catching up: jumping blocks', { 
        from: lastBlock, 
        to: initialHeight - MAX_CATCHUP_BLOCKS, 
        replayCount: MAX_CATCHUP_BLOCKS 
      });
      lastBlock = initialHeight - MAX_CATCHUP_BLOCKS;

      // Replay in batches of up to 5 blocks in order
      for (let h = lastBlock + 1; h <= initialHeight; h += 5) {
        const batch: number[] = [];
        for (let b = h; b <= Math.min(h + 4, initialHeight); b++) {
          batch.push(b);
        }
        await Promise.all(
          batch.map(height =>
            processBlock(height).catch(err => {
              logger.error('Block processing error', err, { height });
            })
          )
        );
      }
      lastBlock = initialHeight;
      await redis.set(LAST_BLOCK_KEY, initialHeight.toString(), 86400).catch(() => {});
    }
  }

  // Steady-state polling loop: fetch next block directly from neardata without polling block height
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      if (lastBlock === 0) {
        const h = await fetchBlockHeight();
        if (h > 0) {
          lastBlock = h;
          await redis.set(LAST_BLOCK_KEY, h.toString(), 86400).catch(() => {});
        } else {
          await sleep(POLL_INTERVAL_MS);
          continue;
        }
      }

      const nextHeight = lastBlock + 1;
      const res = await fetch(`https://mainnet.neardata.xyz/v0/block/${nextHeight}`, {
        signal: AbortSignal.timeout(3000),
      }).catch(() => null);

      if (!res || res.status === 404) {
        // Next block hasn't been produced yet: sleep and retry same height
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      if (res.ok) {
        const text = await res.text();
        if (!text || text.trim() === '' || text === '{}') {
          await sleep(POLL_INTERVAL_MS);
          continue;
        }

        let blockData: any = null;
        try {
          blockData = JSON.parse(text);
        } catch {
          // ignore json parse error
        }

        if (blockData) {
          const shards = blockData?.shards ?? [];
          // Collect all (log, receiverId, txHash) tuples from all shards/outcomes and process concurrently
          const eventPairs: Array<{ log: string; receiverId: string; txHash?: string }> = [];
          for (const shard of shards) {
            const outcomes = shard?.receipt_execution_outcomes ?? [];
            for (const item of outcomes) {
              const logs: string[] = item?.execution_outcome?.outcome?.logs ?? [];
              const receiverId: string = item?.receipt?.receiver_id ?? '';
              const signerId: string = item?.receipt?.predecessor_id ?? '';
              const txHash: string = item?.execution_outcome?.id ?? '';
              for (const log of logs) {
                eventPairs.push({ log, receiverId, txHash });
              }
              // Copy-trade detection: check if signer is a tracked wallet
              if (signerId && txHash) {
                const receiptActions = (item?.receipt?.receipt?.Action?.actions ?? []) as any[];
                const parsedActions = receiptActions.map((a: any) => {
                  const fn = a?.FunctionCall;
                  if (!fn) return null;
                  try {
                    return {
                      methodName: fn.method_name as string,
                      args: JSON.parse(Buffer.from(fn.args, 'base64').toString('utf8')),
                    };
                  } catch { return null; }
                }).filter(Boolean) as Array<{ methodName: string; args: Record<string, unknown> }>;
                if (parsedActions.length > 0) {
                  checkCopyTradeReceipt(signerId, receiverId, txHash, parsedActions).catch(() => {});
                }
              }
            }
          }
          await Promise.all(
            eventPairs.map(({ log, receiverId, txHash }) => parseEventLog(log, receiverId, txHash).catch(() => {}))
          );
        } else {
          await processBlock(nextHeight).catch(err => {
            console.error(`[DETECTOR] Block ${nextHeight} error:`, err.message);
          });
        }

        lastBlock = nextHeight;
        redis.set(LAST_BLOCK_KEY, lastBlock.toString(), 86400).catch(() => {});
        // Immediately attempt next block in same tick (no sleep) to drain backlog
        continue;
      }
    } catch (err: any) {
      logger.error('Poll error', err);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/** Fetch current block height directly from NEAR RPC JSON-RPC */
async function fetchBlockHeight(): Promise<number> {
  // Try providers in random order with a hard timeout each — a hung RPC
  // used to stall the entire watcher (no timeout, single random pick).
  const urls = [...RPC_URLS].sort(() => Math.random() - 0.5);
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'detector',
          method: 'block',
          params: { finality: 'final' },
        }),
        signal: AbortSignal.timeout(4000),
      });
      const data = (await response.json()) as any;
      const height = data?.result?.header?.height ?? 0;
      if (height > 0) return height;
    } catch {
      // try next provider
    }
  }
  return 0;
}

/** Process a single NEAR block — parse execution outcomes and events */
async function processBlock(height: number): Promise<void> {
  // 1. Primary high-speed path: FastNEAR Neardata stream (complete block with all shard outcomes and logs)
  try {
    const neardataRes = await fetch(`https://mainnet.neardata.xyz/v0/block/${height}`, {
      signal: AbortSignal.timeout(3000),
    });
    if (neardataRes.ok) {
      const blockData = (await neardataRes.json()) as any;
      const shards = blockData?.shards ?? [];
      // Collect all (log, receiverId, txHash) tuples from all shards/outcomes and process concurrently
      const eventPairs: Array<{ log: string; receiverId: string; txHash: string }> = [];
      for (const shard of shards) {
        const outcomes = shard?.receipt_execution_outcomes ?? [];
        for (const item of outcomes) {
          const logs: string[] = item?.execution_outcome?.outcome?.logs ?? [];
          const receiverId: string = item?.receipt?.receiver_id ?? '';
          const txHash: string = item?.tx_hash ?? item?.execution_outcome?.id ?? '';
          for (const log of logs) {
            eventPairs.push({ log, receiverId, txHash });
          }
        }
      }
      await Promise.all(
        eventPairs.map(({ log, receiverId, txHash }) => parseEventLog(log, receiverId, txHash).catch(() => {}))
      );
      return;
    }
  } catch {
    // Fall back to standard JSON-RPC chunk inspection
  }

  // 2. Fallback path: standard NEAR JSON-RPC chunk transactions inspection
  try {
    const rpcUrl = RPC_URLS[Math.floor(Math.random() * RPC_URLS.length)];
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'block',
        method: 'block',
        params: { block_id: height },
      }),
    });

    const data = (await response.json()) as any;
    const chunks = data?.result?.chunks ?? [];

    // Chunks are independent — fetch them in parallel for much faster replay
    await Promise.all(
      chunks.map((chunk: any) =>
        processChunk(rpcUrl, chunk.chunk_hash).catch(() => {})
      )
    );
  } catch (err) {
    console.error(`[DETECTOR] Fallback block ${height} error:`, (err as Error).message);
  }
}

/** Process chunk function calls — look for Shardsmarket, Rhea, and NearlyTrade creation transactions */
async function processChunk(rpcUrl: string, chunkHash: string): Promise<void> {
  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'chunk',
        method: 'chunk',
        params: { chunk_id: chunkHash },
      }),
    });

    const data = (await response.json()) as any;
    const txs = data?.result?.transactions ?? [];

    for (const tx of txs) {
      const receiverId: string = tx?.receiver_id ?? '';
      if (
        receiverId === 'factory.shardsmarket.near' ||
        RHEA_RECEIVERS.has(receiverId) ||
        receiverId === 'nearlytrade.near' ||
        receiverId === 'launch.intear.near' ||
        receiverId === 'launch-v2.intear.near' ||
        receiverId === 'dex.intear.near' ||
        receiverId === 'meme-cooking.near' ||
        receiverId === 'pad.onetokenhub.near' ||
        receiverId === 'gaypad.j1-racing.near' ||
        receiverId === 'nearpadfamily.near' ||
        receiverId === 'launch.shoremarkets.near' ||
        receiverId.endsWith('.launch.shoremarkets.near') ||
        receiverId === 'exchange.kelytradevs.near' ||
        receiverId.endsWith('.exchange.kelytradevs.near') ||
        receiverId.endsWith('.kelytra.near')
      ) {
        const actions = tx?.actions ?? [];
        for (const action of actions) {
          const fn = action?.FunctionCall;
          if (fn && fn.method_name && fn.args) {
            try {
              const decoded = JSON.parse(Buffer.from(fn.args, 'base64').toString('utf8'));
              if (
                receiverId === 'factory.shardsmarket.near' &&
                (fn.method_name === 'create_token' || fn.method_name === 'create_pool' || fn.method_name === 'buy')
              ) {
                const tokenAddress = decoded?.token_id ?? decoded?.token_address ?? '';
                if (tokenAddress) {
                  await handlePoolCreated(tokenAddress, 'shardsmarket', decoded).catch(() => {});
                }
              } else if (
                RHEA_RECEIVERS.has(receiverId) &&
                (
                  fn.method_name === 'add_simple_pool' ||
                  fn.method_name === 'add_stable_swap_pool' ||
                  fn.method_name === 'create_pool' ||
                  fn.method_name === 'create_dcl_pool' ||
                  fn.method_name === 'add_liquidity' ||
                  fn.method_name === 'deposit_and_add_liquidity'
                )
              ) {
                const candidateTokens: string[] = [];
                if (Array.isArray(decoded?.tokens)) candidateTokens.push(...decoded.tokens);
                if (decoded?.token_id) candidateTokens.push(decoded.token_id);
                if (decoded?.token_a) candidateTokens.push(decoded.token_a);
                if (decoded?.token_b) candidateTokens.push(decoded.token_b);
                if (typeof decoded?.pool_id === 'string' && decoded.pool_id.includes('|')) {
                  candidateTokens.push(...decoded.pool_id.split('|').slice(0, 2));
                }
                const uniqueNonNear = [...new Set(candidateTokens)].filter(
                  t => t && typeof t === 'string' && t !== 'wrap.near' && t !== 'near' && !t.includes(':') && isNaN(Number(t)) && !isCoreToken(t)
                );
                for (const t of uniqueNonNear) {
                  await handlePoolCreated(t, 'rhea', decoded).catch(() => {});
                }
              } else if (receiverId === 'launch.intear.near' || receiverId.includes('launch') && receiverId.endsWith('.intear.near')) {
                // Intear launchpad — field extraction from launch_token or create_pool
                const symbol = decoded?.symbol ? String(decoded.symbol).toLowerCase() : '';
                const tokenAddress =
                  decoded?.token ?? decoded?.token_id ?? decoded?.account_id ?? decoded?.token_account_id ??
                  (symbol ? `${symbol}.${receiverId}` : '');
                if (tokenAddress) {
                  await handlePoolCreated(tokenAddress, 'intear', decoded).catch(() => {});
                }
              } else if (receiverId === 'meme-cooking.near' && fn.method_name.includes('create')) {
                // Meme.Cooking: token account is <meme_id>.meme-cooking.near
                const memeId = decoded?.meme_id ?? decoded?.id;
                const tokenAddress =
                  decoded?.token ??
                  decoded?.token_id ??
                  (memeId !== undefined && memeId !== null ? `${memeId}.meme-cooking.near` : '');
                if (tokenAddress) {
                  await handlePoolCreated(tokenAddress, 'memecooking', decoded).catch(() => {});
                }
              } else if (
                receiverId === 'nearlytrade.near' &&
                fn.method_name === 'launch'
              ) {
                const tokenAddress = decoded?.token ?? decoded?.token_id ?? decoded?.token_address ?? '';
                if (tokenAddress) {
                  await handlePoolCreated(tokenAddress, 'nearlytrade', decoded).catch(() => {});
                }
              } else if (receiverId === 'pad.onetokenhub.near') {
                const tokenAddress = decoded?.token ?? '';
                if (tokenAddress) {
                  await handlePoolCreated(tokenAddress, 'onetokenhub', decoded).catch(() => {});
                }
              } else if (receiverId === 'gaypad.j1-racing.near') {
                const tokenAddress = decoded?.token_id ?? decoded?.token ?? '';
                if (tokenAddress) {
                  await handlePoolCreated(tokenAddress, 'gaypad', decoded).catch(() => {});
                }
              } else if (receiverId === 'nearpadfamily.near') {
                const tokenAddress = decoded?.token ?? decoded?.token_id ?? '';
                if (tokenAddress) {
                  await handlePoolCreated(tokenAddress, 'nearpad', decoded).catch(() => {});
                }
              } else if (receiverId === 'launch.shoremarkets.near') {
                // ShoreMarkets factory: create_token / buy / launch
                const tokenAddress =
                  decoded?.token_id ??
                  decoded?.token ??
                  decoded?.token_address ??
                  decoded?.account_id ??
                  '';
                if (tokenAddress) {
                  await handlePoolCreated(tokenAddress, 'shoremarkets', decoded).catch(() => {});
                }
              } else if (receiverId.endsWith('.launch.shoremarkets.near') && fn.method_name === 'buy') {
                // Direct call on the token contract itself (buy on bonding curve)
                await handlePoolCreated(receiverId, 'shoremarkets', decoded).catch(() => {});
              } else if (receiverId === 'exchange.kelytradevs.near') {
                const tokenAddress = decoded?.token_id ?? decoded?.token ?? '';
                if (tokenAddress) {
                  await handlePoolCreated(tokenAddress, 'kelytra', decoded).catch(() => {});
                }
              } else if (receiverId.endsWith('.exchange.kelytradevs.near') || receiverId.endsWith('.kelytra.near')) {
                await handlePoolCreated(receiverId, 'kelytra', decoded).catch(() => {});
              }
            } catch {
              // Ignore binary or non-JSON arguments
            }
          }
        }
      }
    }
  } catch {
    // Ignore transient chunk error
  }
}

/**
 * Parse NEP-297 standard event logs.
 * Format: EVENT_JSON:{"standard":"...","event":"...","data":[...]}
 */
async function parseEventLog(log: string, receiverId: string, txHash?: string): Promise<void> {
  if (!log.startsWith('EVENT_JSON:')) return;

  // If the event receiver is an armed snipe target, immediately invalidate its
  // negative cache so the watchdog re-probes on the very next 5s tick.
  if (snipeNegativeCache.has(receiverId)) {
    snipeNegativeCache.delete(receiverId);
  }

  let event: any;
  try {
    event = JSON.parse(log.slice('EVENT_JSON:'.length));
  } catch {
    return;
  }

  const eventName: string = event?.event ?? '';
  const data = Array.isArray(event?.data) ? event.data[0] : event?.data;

  // ── Shardsmarket pool creation (factory or a *.factory.shardsmarket.near
  //    token contract — each token is its own pool contract) ──────────────────
  if (receiverId.endsWith('.shardsmarket.near') && eventName === 'pool_created') {
    const tokenAddress: string = data?.token_id ?? data?.token_address ?? receiverId;
    if (!tokenAddress) return;

    await handlePoolCreated(tokenAddress, 'shardsmarket', data);
  }

  // ── Rhea pool / token launch (v2.ref-finance.near & dclv2.ref-labs.near) ──
  if (RHEA_RECEIVERS.has(receiverId) && (eventName === 'pool_created' || eventName === 'token_launch')) {
    const candidates: string[] = [];
    if (data?.token_id) candidates.push(data.token_id);
    if (data?.token_out) candidates.push(data.token_out);
    if (data?.token_in) candidates.push(data.token_in);
    if (Array.isArray(data?.tokens)) candidates.push(...data.tokens);
    if (typeof data?.pool_id === 'string' && data.pool_id.includes('|')) {
      candidates.push(...data.pool_id.split('|').slice(0, 2));
    }
    const uniqueTokens = [...new Set(candidates)].filter(
      t => t && typeof t === 'string' && t !== 'wrap.near' && t !== 'near' && !t.includes(':') && isNaN(Number(t)) &&
        !t.endsWith('.nearlytrade.near') && !t.endsWith('.shardsmarket.near') && !t.endsWith('.launch.shoremarkets.near') && !isCoreToken(t)
    );
    for (const t of uniqueTokens) {
      await handlePoolCreated(t, 'rhea', data).catch(() => {});
    }
  }

  // ── Intear launchpad ────────────────────────────────────────────────────
  if (
    (receiverId === 'launch.intear.near' || receiverId.includes('launch') && receiverId.endsWith('.intear.near')) &&
    (eventName === 'launch' || eventName === 'token_launch' || eventName === 'pool_created' || eventName === 'dex_event')
  ) {
    const tokenAddress: string = data?.token ?? data?.token_id ?? data?.account_id ?? data?.token_account_id ?? '';
    if (tokenAddress) {
      await handlePoolCreated(tokenAddress, 'intear', data);
    }
  }

  // ── Meme.Cooking launchpad (info-only venue) ──────────────────────────────
  if (
    receiverId === 'meme-cooking.near' &&
    (eventName === 'meme_created' || eventName === 'token_created' || eventName === 'pool_created')
  ) {
    const memeId = data?.meme_id ?? data?.id;
    const tokenAddress: string =
      data?.token ??
      data?.token_id ??
      (memeId !== undefined && memeId !== null ? `${memeId}.meme-cooking.near` : '');
    if (tokenAddress) {
      await handlePoolCreated(tokenAddress, 'memecooking', data);
    }
  }

  // ── NearlyTrade token creation & bonding transition ─────────────────────
  if (
    receiverId === 'nearlytrade.near' &&
    (eventName === 'launch' || eventName === 'launch_started' || eventName === 'bonded')
  ) {
    const tokenAddress: string = data?.token ?? data?.token_id ?? '';
    if (!tokenAddress) return;

    // Handle bonding transition directly if step is Done or event is bonded
    if (eventName === 'bonded' || data?.step === 'Done' || data?.step === 'Graduated') {
      console.log(`[DETECTOR] Token graduated/bonded on NearlyTrade: ${tokenAddress}`);
      const dclPoolId = data?.pool_id ?? `${tokenAddress}|wrap.near|10000`;
      setImmediate(() => {
        upsertTokenCache({
          token_address: tokenAddress,
          bonding_phase: 'bonded',
          bonding_progress_pct: 100,
          dcl_pool_id: dclPoolId,
          updated_at: new Date(),
        }).catch(err => console.error('[DETECTOR] DB graduation update error:', err.message));
      });
    }

    await handlePoolCreated(tokenAddress, 'nearlytrade', data);
  }

  // ── OneTokenHub launchpad ─────────────────────────────────────────────────
  if (
    receiverId === 'pad.onetokenhub.near' &&
    (eventName === 'launch' || eventName === 'launch_created' || eventName === 'pool_created' || eventName === 'step_done')
  ) {
    const tokenAddress: string = data?.token ?? data?.token_id ?? '';
    if (tokenAddress) {
      await handlePoolCreated(tokenAddress, 'onetokenhub', data);
    }
  }

  // ── NEARpad launchpad ────────────────────────────────────────────────────
  if (
    receiverId === 'nearpadfamily.near' &&
    (eventName === 'launch' || eventName === 'launch_created' || eventName === 'pool_created' || eventName === 'token_created')
  ) {
    const tokenAddress: string = data?.token ?? data?.token_id ?? '';
    if (tokenAddress) {
      await handlePoolCreated(tokenAddress, 'nearpad', data);
    }
  }

  // ── ShoreMarkets launchpad ───────────────────────────────────────────────
  if (
    (receiverId === 'launch.shoremarkets.near' ||
      receiverId.endsWith('.launch.shoremarkets.near')) &&
    (eventName === 'launch' ||
      eventName === 'token_launch' ||
      eventName === 'pool_created' ||
      eventName === 'token_created' ||
      eventName === 'create')
  ) {
    const tokenAddress: string =
      data?.token_id ??
      data?.token ??
      data?.account_id ??
      (receiverId.endsWith('.launch.shoremarkets.near') ? receiverId : '');
    if (tokenAddress) {
      await handlePoolCreated(tokenAddress, 'shoremarkets', data);
    }
  }

  // ── Kelytra launchpad ──────────────────────────────────────────────────
  if (
    (receiverId === 'exchange.kelytradevs.near' ||
      receiverId.endsWith('.exchange.kelytradevs.near') ||
      receiverId.endsWith('.kelytra.near')) &&
    (eventName === 'launch' ||
      eventName === 'create_launch' ||
      eventName === 'curve_swap' ||
      eventName === 'terminal_swap')
  ) {
    const tokenAddress: string =
      data?.token_id ??
      data?.token ??
      data?.account_id ??
      (receiverId.endsWith('.exchange.kelytradevs.near') || receiverId.endsWith('.kelytra.near') ? receiverId : '');
    if (tokenAddress && tokenAddress !== 'exchange.kelytradevs.near') {
      await handlePoolCreated(tokenAddress, 'kelytra', data);
    }
  }

  // ── Swaps & Buy Alerts from any venue ─────────────────────────────────────
  if (eventName === 'swap') {
    const swapItems = Array.isArray(event?.data) ? event.data : (event?.data ? [event.data] : []);
    for (const item of swapItems) {
      if (item && ((item.token_in && item.token_out) || item.pool_id)) {
        await handleSwapEvent(item, receiverId, txHash).catch(() => {});
      }
    }
  } else if (receiverId === 'nearlytrade.near' && (eventName === 'buy' || eventName === 'launch_buy')) {
    const buyItems = Array.isArray(event?.data) ? event.data : (event?.data ? [event.data] : []);
    for (const item of buyItems) {
      if (item) {
        await handleSwapEvent(item, receiverId, txHash).catch(() => {});
      }
    }
  }
}

/** When a new pool is detected: fetch token metadata, cache it, publish event */
async function handlePoolCreated(
  tokenAddress: string,
  venue: 'rhea' | 'ref' | 'shardsmarket' | 'nearlytrade' | 'intear' | 'memecooking' | 'onetokenhub' | 'gaypad' | 'nearpad' | 'shoremarkets' | 'kelytra',
  rawData: any
): Promise<void> {
  const correlationId = generateCorrelationId();
  logger.info('New pool detected', { correlationId, tokenAddress, venue });

  // Fetch token metadata via NEAR RPC
  let name = rawData?.name ?? '';
  let symbol = rawData?.symbol ?? '';
  let decimals = rawData?.decimals ?? 18;
  let totalSupply = '0';

  try {
    // Parallelize metadata + total_supply — they are independent calls
    const [meta, supply] = await Promise.all([
      near.getTokenMetadata(tokenAddress),
      near.getTokenTotalSupply(tokenAddress).catch(() => '0'),
    ]);
    name = meta.name;
    symbol = meta.symbol;
    decimals = meta.decimals;
    totalSupply = supply;
  } catch (err) {
    logger.warn('Could not fetch token metadata', { correlationId, tokenAddress, error: (err as Error).message });
    if (!name) return; // Skip if we have no data at all
  }

  const poolAddress = rawData?.pool_id ?? rawData?.pool_address ?? tokenAddress;
  let initialLiquidity = rawData?.near_amount ?? rawData?.initial_liquidity ?? '0';
  let creator = rawData?.creator_id ?? rawData?.owner_id ?? '';

  let bondingPhase: 'prebonded' | 'bonded' | null = null;
  let bondingProgressPct: number | null = null;
  let dclPoolId: string | null = rawData?.pool_id ?? null;
  let initialPrice = 0;

  if (venue === 'nearlytrade') {
    try {
      const ntState = await near.getNearlytradeTokenState(tokenAddress);
      if (ntState) {
        bondingPhase = ntState.phase;
        bondingProgressPct = ntState.bondingProgressPct;
        dclPoolId = ntState.dclPoolId;
        initialPrice = ntState.price;
        initialLiquidity = (ntState.liquidityNear * 1e24).toString();
        // The launch record carries the real creator wallet — needed for
        // deployer sniping when the detection event didn't include it.
        if (!creator && ntState.creator) {
          creator = ntState.creator;
        }
      }
    } catch (err) {
      logger.warn('Could not fetch NearlyTrade state', { correlationId, tokenAddress, error: (err as Error).message });
    }
  } else if (venue === 'onetokenhub') {
    try {
      const hubState = await near.getOneTokenHubState(tokenAddress);
      if (hubState) {
        dclPoolId = hubState.dclPoolId;
        initialPrice = hubState.price;
        initialLiquidity = (hubState.liquidityNear * 1e24).toString();
      }
    } catch (err) {
      logger.warn('Could not fetch OneTokenHub state', { correlationId, tokenAddress, error: (err as Error).message });
    }
  } else if (venue === 'gaypad') {
    try {
      const gpState = await near.getGaypadTokenState(tokenAddress);
      if (gpState) {
        bondingPhase = gpState.phase;
        bondingProgressPct = gpState.bondingProgressPct;
        initialPrice = gpState.price;
        initialLiquidity = (gpState.liquidityNear * 1e24).toString();
      }
    } catch (err) {
      logger.warn('Could not fetch Gaypad state', { correlationId, tokenAddress, error: (err as Error).message });
    }
  } else if (venue === 'nearpad') {
    try {
      const padState = await near.getNEARpadState(tokenAddress);
      if (padState) {
        dclPoolId = padState.dclPoolId;
        initialPrice = padState.price;
        initialLiquidity = (padState.liquidityNear * 1e24).toString();
      }
    } catch (err) {
      logger.warn('Could not fetch NEARpad state', { correlationId, tokenAddress, error: (err as Error).message });
    }
  } else if (venue === 'shoremarkets') {
    try {
      const smState = await near.getShoremarketsTokenState(tokenAddress);
      if (smState) {
        bondingPhase = smState.phase;
        bondingProgressPct = smState.bondingProgressPct;
        dclPoolId = smState.dclPoolId;
        initialPrice = smState.price;
        initialLiquidity = (smState.liquidityNear * 1e24).toString();
        if (!creator && smState.creator) {
          creator = smState.creator;
        }
      }
    } catch (err) {
      logger.warn('Could not fetch ShoreMarkets state', { correlationId, tokenAddress, error: (err as Error).message });
    }
  } else if (venue === 'kelytra') {
    try {
      const ktState = await near.getKelytraTokenState(tokenAddress);
      if (ktState) {
        bondingPhase = ktState.phase;
        bondingProgressPct = ktState.bondingProgressPct;
        dclPoolId = ktState.dclPoolId;
        initialPrice = ktState.price;
        initialLiquidity = (ktState.liquidityNear * 1e24).toString();
        if (!creator && ktState.creator) {
          creator = ktState.creator;
        }
      }
    } catch (err) {
      logger.warn('Could not fetch Kelytra state', { correlationId, tokenAddress, error: (err as Error).message });
    }
  }

  // Creation events frequently carry no usable liquidity/price. Pull the
  // live pool state instead — auto-buy gating (min liquidity) and the
  // initial price/market-cap both depended on this and silently saw 0 before.
  if ((!initialLiquidity || initialLiquidity === '0') || initialPrice <= 0) {
    try {
      const knownRheaPool = venue === 'rhea' && typeof poolAddress === 'number' ? poolAddress : null;
      const knownDclPool = dclPoolId ?? (typeof poolAddress === 'string' && poolAddress.includes('|') ? poolAddress : null);
      const spot = await near.getVenueSpotPrice(venue, tokenAddress, decimals, knownRheaPool, knownDclPool);
      if (spot) {
        if (!initialLiquidity || initialLiquidity === '0') {
          initialLiquidity = spot.reserveNearYocto;
        }
        if (initialPrice <= 0) {
          initialPrice = spot.price;
        }
      }
    } catch {
      // No live pool yet (presale phase) — keep zeros, auto-buy stays gated
    }
  }

  if (initialPrice <= 0) {
    initialPrice = computeInitialPrice(initialLiquidity, totalSupply, decimals);
  }

  const supplyNum = parseFloat(totalSupply) / Math.pow(10, decimals);
  const marketCap = initialPrice * supplyNum;

  // 1. Update in-memory name cache immediately
  const tokenEvent: TokenDetectedEvent = {
    type: 'token_detected',
    token_address: tokenAddress,
    name,
    symbol,
    decimals,
    venue,
    pool_address: poolAddress,
    creator,
    timestamp: Date.now(),
  };
  tokenNameCache.set(tokenAddress, tokenEvent);

  // 2. Update in-memory price cache
  priceCache.set(tokenAddress, { price: initialPrice, liquidity: parseFloat(initialLiquidity) / 1e24, marketCap, ts: Date.now() });

  // 3. Publish to Redis for other services
  await redis.publish(CHANNELS.NEW_TOKENS, JSON.stringify(tokenEvent));
  await redis.publish(
    CHANNELS.POOL_CREATED,
    JSON.stringify({
      type: 'pool_created',
      token_address: tokenAddress,
      pool_address: poolAddress,
      venue,
      total_supply: totalSupply,
      initial_liquidity: initialLiquidity,
      timestamp: Date.now(),
    } satisfies PoolCreatedEvent)
  );

  // Publish initial price update
  const priceUpdate: PriceUpdateEvent = {
    type: 'price_update',
    token_address: tokenAddress,
    price: initialPrice,
    liquidity: parseFloat(initialLiquidity) / 1e24,
    market_cap: marketCap,
    timestamp: Date.now(),
  };
  await redis.publish(CHANNELS.PRICE_UPDATE, JSON.stringify(priceUpdate));
  await redis.set(`token:price:${tokenAddress}`, JSON.stringify(priceUpdate), 300);

  // 4. Async DB write — does NOT block the detection loop
  setImmediate(() => {
    upsertTokenCache({
      token_address: tokenAddress,
      name,
      symbol,
      decimals,
      total_supply: totalSupply,
      pool_address: poolAddress,
      venue,
      rhea_pool_id: venue === 'rhea' && typeof poolAddress === 'number' ? poolAddress : undefined,
      bonding_phase: bondingPhase,
      bonding_progress_pct: bondingProgressPct,
      dcl_pool_id: dclPoolId,
      last_price: initialPrice,
      last_liquidity: parseFloat(initialLiquidity) / 1e24,
      updated_at: new Date(),
    }).catch(err => console.error('[DETECTOR] DB cache write error:', err.message));
  });

  // 5. Check auto-buy signals + targeted snipe orders (async, non-blocking)
  setImmediate(() => checkAutoBuySignals(tokenAddress, venue, initialLiquidity, marketCap, creator));
}

/** When a swap is detected, extract the new price and publish a price update / buy alert */
async function handleSwapEvent(data: any, venue: string, txHash?: string): Promise<void> {
  let targetToken = '';
  let isBuy = false;

  const tokenIn = (data?.token_in || '').toLowerCase();
  const tokenOut = (data?.token_out || '').toLowerCase();

  const isNearIn = tokenIn === 'wrap.near' || tokenIn === 'near';
  const isNearOut = tokenOut === 'wrap.near' || tokenOut === 'near';

  if (tokenOut && !isNearOut) {
    targetToken = data.token_out;
    isBuy = true;
  } else if (tokenIn && !isNearIn) {
    targetToken = data.token_in;
    isBuy = false;
  } else if (typeof data?.pool_id === 'string' && data.pool_id.includes('|')) {
    const parts = data.pool_id.split('|');
    targetToken = parts.find((p: string) => p !== 'wrap.near' && p !== 'near') || '';
    if (tokenOut === targetToken.toLowerCase()) {
      isBuy = true;
    }
  }

  if (!targetToken || targetToken === 'near' || targetToken === 'wrap.near') return;
  const tokenAddress = targetToken;

  // 1. Resolve token_cache row for total_supply, decimals, and pool info
  const dbCache = await getTokenCache(tokenAddress).catch(() => null);
  let totalSupply = dbCache?.total_supply;
  let decimals = dbCache?.decimals;
  let rheaPoolId = dbCache?.rhea_pool_id;

  // If no token_cache row exists or missing supply/decimals, fetch via RPC directly
  if (!totalSupply || decimals === undefined) {
    try {
      const [meta, fetchedSupply] = await Promise.all([
        near.getTokenMetadata(tokenAddress),
        near.getTokenTotalSupply(tokenAddress),
      ]);
      decimals = meta.decimals;
      totalSupply = fetchedSupply;
      const detectedVenue: 'rhea' | 'shardsmarket' | 'nearlytrade' = venue.includes('rhea')
        ? 'rhea'
        : venue.includes('nearlytrade') || venue.includes('dclv2')
        ? 'nearlytrade'
        : 'shardsmarket';

      setImmediate(() => {
        upsertTokenCache({
          token_address: tokenAddress,
          name: meta.name,
          symbol: meta.symbol,
          decimals: meta.decimals,
          total_supply: fetchedSupply,
          pool_address: tokenAddress,
          venue: detectedVenue,
          updated_at: new Date(),
        }).catch(() => {});
      });
    } catch (err) {
      console.warn(`[DETECTOR] Skipping price update: failed to fetch supply/metadata for ${tokenAddress}:`, (err as Error).message);
      return;
    }
  }

  // Pull reserves for fresh price calculation
  let price = 0;
  let liquidity = 0;

  if (venue === 'rhea.finance' || venue.includes('rhea') || venue.includes('ref-finance')) {
    if (rheaPoolId === null || rheaPoolId === undefined) {
      rheaPoolId = await near.findRheaPoolId(data.token_in, data.token_out).catch(() => null);
    }
    if (typeof rheaPoolId === 'number') {
      try {
        const reserves = await near.getRheaPoolReserves(rheaPoolId, data.token_in, data.token_out);
        const isTokenInNear = data.token_in === 'wrap.near' || data.token_in === 'near';
        const isTokenOutNear = data.token_out === 'wrap.near' || data.token_out === 'near';
        let nearReserveRaw = '0';
        let tokenReserveRaw = '0';
        if (isTokenInNear) {
          nearReserveRaw = reserves.reserveIn;
          tokenReserveRaw = reserves.reserveOut;
        } else if (isTokenOutNear) {
          nearReserveRaw = reserves.reserveOut;
          tokenReserveRaw = reserves.reserveIn;
        }
        const reserveNearHuman = parseFloat(nearReserveRaw) / 1e24;
        const reserveTokenHuman = parseFloat(tokenReserveRaw) / Math.pow(10, decimals ?? 18);
        if (reserveTokenHuman > 0 && reserveNearHuman > 0) {
          price = reserveNearHuman / reserveTokenHuman;
          liquidity = reserveNearHuman * 2;
        }
      } catch { /* skip */ }
    }
  } else if (venue === 'nearlytrade.near' || venue === 'dclv2.ref-labs.near' || venue.includes('nearlytrade') || venue.includes('dclv2')) {
    try {
      if (tokenAddress.endsWith('.nearlytrade.near')) {
        const ntState = await near.getNearlytradeTokenState(tokenAddress);
        if (ntState && ntState.price > 0) {
          price = ntState.price;
          liquidity = ntState.liquidityNear;

          // Check if a direct wrap.near pool exists on Rhea with deeper liquidity
          const rhea = await near.findRheaPoolForToken(tokenAddress).catch(() => null);
          if (rhea && rhea.price > 0 && rhea.liquidityNear >= 5) {
            if (!ntState.quoteIsNear || ntState.phase === 'bonded' || rhea.liquidityNear >= (ntState.liquidityNear + 5)) {
              price = rhea.price;
              liquidity = rhea.liquidityNear;
            }
          }
        }
      } else {
        const dclId = await near.findDclPoolId('wrap.near', tokenAddress).catch(() => null);
        if (dclId) {
          const dcl = await near.getDclPoolState(dclId, 'wrap.near').catch(() => null);
          if (dcl && dcl.price > 0 && dcl.liquidityNear > 0.1) {
            price = dcl.price;
            liquidity = dcl.liquidityNear;
          }
        }
      }
    } catch {
      // skip
    }
  } else if (venue === 'factory.shardsmarket.near' || venue.includes('shardsmarket')) {
    try {
      const reserves = await near.getShardsmarketPoolReserves(tokenAddress);
      const reserveNearHuman = parseFloat(reserves.reserveNear) / 1e24;
      const reserveTokenHuman = parseFloat(reserves.reserveToken) / Math.pow(10, decimals ?? 18);
      if (reserveTokenHuman > 0) {
        price = reserveNearHuman / reserveTokenHuman;
        liquidity = reserveNearHuman * 2;
      }
    } catch {
      // skip
    }
  }

  if (price <= 0) {
    if (data?.amount_in && data?.amount_out) {
      if (isNearIn) {
        const spentNear = parseFloat(data.amount_in) / 1e24;
        const tokensGot = parseFloat(data.amount_out) / Math.pow(10, decimals ?? 18);
        if (tokensGot > 0 && spentNear > 0) price = spentNear / tokensGot;
      } else if (isNearOut) {
        const receivedNear = parseFloat(data.amount_out) / 1e24;
        const tokensSold = parseFloat(data.amount_in) / Math.pow(10, decimals ?? 18);
        if (tokensSold > 0 && receivedNear > 0) price = receivedNear / tokensSold;
      }
    }
  }

  if (price <= 0) return;

  const supplyNum = parseFloat(totalSupply!) / Math.pow(10, decimals!);
  if (supplyNum <= 0) return;

  const marketCap = price * supplyNum;
  const liquidityNear = liquidity;

  priceCache.set(tokenAddress, { price, liquidity: liquidityNear, marketCap, ts: Date.now() });

  const update: PriceUpdateEvent = {
    type: 'price_update',
    token_address: tokenAddress,
    price,
    liquidity: liquidityNear,
    market_cap: marketCap,
    timestamp: Date.now(),
  };

  redis.publish(CHANNELS.PRICE_UPDATE, JSON.stringify(update)).catch(() => {});
  redis.set(`token:price:${tokenAddress}`, JSON.stringify(update), 300).catch(() => {});

  // ── Emit Group Buy Alert if this was a BUY of the token ───────────────────
  if (isBuy) {
    try {
      const nearPriceUsd = await getNearUsdPrice().catch(() => 0);
      const effectiveNearPrice = nearPriceUsd > 0 ? nearPriceUsd : 5.16;
      let spentNear = 0;

      if (isNearIn && data?.amount_in) {
        spentNear = parseFloat(data.amount_in) / 1e24;
      } else if (data?.amount_out) {
        const tokensReceivedNum = parseFloat(data.amount_out) / Math.pow(10, decimals ?? 18);
        spentNear = tokensReceivedNum * price;
      }

      const spentUsd = Math.round(spentNear * effectiveNearPrice * 100) / 100;

      if (spentUsd > 0 && !isNaN(spentUsd)) {
        const isTracked = activeBuyAlertTokens.size > 0 && activeBuyAlertTokens.has(tokenAddress.toLowerCase());

        if (isTracked) {
          const tokenName = dbCache?.name || tokenNameCache.get(tokenAddress)?.name || tokenAddress;
          const tokenSymbol = dbCache?.symbol || tokenNameCache.get(tokenAddress)?.symbol || 'TOKEN';
          const tokensReceivedNum = parseFloat(data?.amount_out || '0') / Math.pow(10, decimals ?? 18);
          const tokensReceivedStr = tokensReceivedNum > 0
            ? `${tokensReceivedNum.toLocaleString('en-US', { maximumFractionDigits: tokensReceivedNum >= 100 ? 0 : 2 })} ${tokenSymbol}`
            : `0 ${tokenSymbol}`;
          const buyer = data?.swapper || data?.account_id || data?.trader || data?.signer_id || 'Unknown';
          const priceUsd = price * nearPriceUsd;
          const marketCapUsd = marketCap * nearPriceUsd;

          // Fetch buyer's NEAR balance for whale detection (non-fatal)
          let buyerNearBalance: number | undefined;
          if (buyer && buyer !== 'Unknown') {
            try {
              const rawBal = await near.getNearBalance(buyer).catch(() => null);
              if (rawBal) {
                const { utils: nearUtils } = await import('near-api-js');
                buyerNearBalance = parseFloat(nearUtils.format.formatNearAmount(rawBal, 4));
              }
            } catch { /* non-fatal */ }
          }

          const buyAlert: BuyAlertEvent = {
            type: 'buy_alert',
            chain: 'near',
            token_address: tokenAddress,
            token_name: tokenName,
            token_symbol: tokenSymbol,
            buyer_address: buyer,
            spent_amount_native: `${spentNear.toFixed(4)} NEAR`,
            spent_usd: spentUsd,
            tokens_received: tokensReceivedStr,
            price_usd: priceUsd > 0 ? priceUsd : undefined,
            market_cap_usd: marketCapUsd > 0 ? marketCapUsd : undefined,
            buyer_near_balance: buyerNearBalance,
            tx_hash: txHash || '',
            timestamp: Date.now(),
          };

          logger.info(`[DETECTOR] Emitting on-chain BUY alert for ${tokenAddress}: $${spentUsd} USD by ${buyer}`, {
            tokenAddress,
            spentUsd,
            buyer,
            txHash,
          });

          await redis.publish(CHANNELS.BUY_ALERT, JSON.stringify(buyAlert)).catch(() => {});
        }
      }
    } catch (err: any) {
      logger.warn('[DETECTOR] Failed to process buy alert for swap', { error: err?.message });
    }
  }
}

/**
 * Fire armed targeted snipe orders (token or deployer) for a specific token.
 * Safe to call from both block scanner and the watchdog poller because
 * recordSnipeTrigger deduplicates fires and prevents re-triggering.
 */
async function checkSnipeSignalsOnly(
  tokenAddress: string,
  venue: 'rhea' | 'ref' | 'shardsmarket' | 'nearlytrade' | 'intear' | 'memecooking' | 'onetokenhub' | 'gaypad' | 'nearpad' | 'shoremarkets' | 'kelytra',
  creator = ''
): Promise<void> {
  try {
    const [tokenOrders, deployerOrders] = await Promise.all([
      getActiveTokenSnipes(tokenAddress).catch(() => []),
      creator ? getActiveDeployerSnipes(creator).catch(() => []) : Promise.resolve([]),
    ]);

    for (const order of [...tokenOrders, ...deployerOrders]) {
      const triggerId = await recordSnipeTrigger(order.id, tokenAddress, venue).catch(() => null);
      if (!triggerId) continue; // already fired/firing for this token

      const signal: AutoBuySignal = {
        type: 'auto_buy_signal',
        user_id: order.user_id,
        token_address: tokenAddress,
        amount_near: order.amount_near.toString(),
        venue,
        timestamp: Date.now(),
        snipe_order_id: order.id,
        snipe_trigger_id: triggerId,
        snipe_type: order.snipe_type,
      };
      await redis.publish(CHANNELS.AUTO_BUY_SIGNAL, JSON.stringify(signal));
      console.log(`[DETECTOR] Snipe ${order.snipe_type} order ${order.id} fired for ${tokenAddress} (user ${order.user_id})`);
    }
  } catch (err) {
    console.error('[DETECTOR] Snipe order match error:', (err as Error).message);
  }
}

/** In-memory dedup set: `${userId}:${tokenAddress.toLowerCase()}` → timestamp */
const autoBuyExecutedCache = new Map<string, number>();

/**
 * After a new token is detected, check if any users have auto-buy enabled
 * and the token passes their filters. Publish AUTO_BUY_SIGNAL for each match.
 */
async function checkAutoBuySignals(
  tokenAddress: string,
  venue: 'rhea' | 'ref' | 'shardsmarket' | 'nearlytrade' | 'intear' | 'memecooking' | 'onetokenhub' | 'gaypad' | 'nearpad' | 'shoremarkets' | 'kelytra',
  liquidityStr: string,
  marketCapNear: number,
  creator = ''
): Promise<void> {
  // 1. Check targeted snipe orders
  await checkSnipeSignalsOnly(tokenAddress, venue, creator);

  // 2. Skip core/major tokens (USDC, USDT, wrap.near, SWEAT, etc.) from general auto-buy
  if (isCoreToken(tokenAddress)) {
    return;
  }

  // 2b. Block auto-buy on unverified standalone Rhea AMM pools with unlocked liquidity (rug-pull risk)
  if ((venue === 'rhea' || venue === 'ref') && !isAuditedLaunchpadToken(tokenAddress)) {
    logger.warn('[DETECTOR] Skipping auto-buy for unverified standalone Rhea AMM pool (unlocked liquidity rug risk)', {
      tokenAddress,
      venue,
    });
    return;
  }

  // 3. General auto-buy for new token launches
  try {
    const db = await getDb();
    const result = await db
      .query(
        `SELECT id, telegram_id, default_buy_pct, auto_buy_amount_near, auto_buy_min_liquidity_near, auto_buy_max_market_cap_usd 
         FROM users 
         WHERE auto_buy_enabled = true AND auto_buy_amount_near > 0`
      )
      .catch(() => ({ rows: [] as any[] }));

    const liquidity = parseFloat(liquidityStr) / 1e24; // Convert yoctoNEAR to NEAR
    const now = Date.now();
    const normToken = tokenAddress.toLowerCase().trim();

    const nearPriceUsd = await getNearUsdPrice().catch(() => 0);
    const effectiveNearPrice = nearPriceUsd > 0 ? nearPriceUsd : 5.16;
    const tokenMcapUsd = marketCapNear > 0 ? marketCapNear * effectiveNearPrice : 0;

    for (const user of result.rows) {
      const minLiquidity = parseFloat(user.auto_buy_min_liquidity_near ?? '10');
      if (liquidity < minLiquidity) continue;

      // Filter: enforce user's max market cap ceiling ($100k safety default)
      const maxMcapUsd = user.auto_buy_max_market_cap_usd != null
        ? parseFloat(user.auto_buy_max_market_cap_usd)
        : 100000;

      if (maxMcapUsd > 0 && tokenMcapUsd > maxMcapUsd) {
        logger.info('[DETECTOR] Skipping auto-buy: token market cap exceeds user max', {
          tokenAddress,
          tokenMcapUsd: Math.round(tokenMcapUsd),
          maxMcapUsd,
          userId: user.id,
        });
        continue;
      }

      const dedupKey = `${user.id}:${normToken}`;
      const lastFired = autoBuyExecutedCache.get(dedupKey);
      if (lastFired && now - lastFired < 86_400_000) {
        // Already fired for this user on this token within the last 24h
        continue;
      }
      autoBuyExecutedCache.set(dedupKey, now);

      const signal: AutoBuySignal = {
        type: 'auto_buy_signal',
        user_id: user.id,
        token_address: tokenAddress,
        amount_near: user.auto_buy_amount_near.toString(),
        venue,
        timestamp: now,
      };
      await redis.publish(CHANNELS.AUTO_BUY_SIGNAL, JSON.stringify(signal));
    }
  } catch (err) {
    console.error('[DETECTOR] Auto-buy signal error:', (err as Error).message);
  }
}

function computeInitialPrice(liquidityYocto: string, totalSupply: string, decimals = 18): number {
  const liqNear = parseFloat(liquidityYocto) / 1e24;
  // Supply is in RAW base units — must be decimal-adjusted or the price
  // comes out ~1e18 times too small (and market-cap garbage).
  const supply = parseFloat(totalSupply) / Math.pow(10, decimals);
  if (supply <= 0 || liqNear <= 0) return 0;
  return liqNear / supply;
}

/**
 * Periodically refresh prices for tokens with ACTIVE triggers directly from
 * live pool state. Stop-losses must not depend on a swap happening to occur:
 * if trading goes quiet (or detector price events stall), the trigger engine
 * would otherwise evaluate against frozen data.
 */
async function refreshTriggerTokenPrices(): Promise<void> {
  try {
    const triggers = await getActiveTriggers().catch(() => []);
    if (triggers.length === 0) return;

    const tokenSet = new Set<string>();
    // Positions are independent read-only rows — fetch them in one parallel
    // round instead of one serial DB hop per trigger.
    const positionIds = [...new Set(triggers.map(t => t.position_id))];
    const positions = await getPositionsByIds(positionIds).catch(() => []);
    for (const pos of positions) {
      if (pos?.token_address && pos.status === 'open') {
        tokenSet.add(pos.token_address);
      }
    }
    if (tokenSet.size === 0) return;

    await Promise.all(
      Array.from(tokenSet).map(async (tokenAddress) => {
        try {
          const dbCache = await getTokenCache(tokenAddress).catch(() => null);
          const venue = dbCache?.venue;
          if (!venue) return;
          const decimals = dbCache?.decimals ?? 18;

          // Pass cached pool IDs — skips expensive findRheaPoolForToken scan.
          // Falls back to full scan automatically if both are null.
          const spot = await near.getVenueSpotPrice(
            venue,
            tokenAddress,
            decimals,
            dbCache?.rhea_pool_id ?? null,
            dbCache?.dcl_pool_id ?? null,
          );
          if (!spot || !(spot.price > 0)) return;

          const supply = parseFloat(dbCache?.total_supply ?? '0') / Math.pow(10, decimals);
          const marketCap = supply > 0 ? spot.price * supply : 0;
          const liquidityNear = (parseFloat(spot.reserveNearYocto) / 1e24) * 2;

          priceCache.set(tokenAddress, {
            price: spot.price,
            liquidity: liquidityNear,
            marketCap,
            ts: Date.now(),
          });

          const update: PriceUpdateEvent = {
            type: 'price_update',
            token_address: tokenAddress,
            price: spot.price,
            liquidity: liquidityNear,
            market_cap: marketCap,
            timestamp: Date.now(),
          };
          redis.publish(CHANNELS.PRICE_UPDATE, JSON.stringify(update)).catch(() => {});
          redis.set(`token:price:${tokenAddress}`, JSON.stringify(update), 300).catch(() => {});
        } catch {
          // per-token failure must not break the refresh loop
        }
      })
    );
  } catch (err) {
    console.error('[DETECTOR] Trigger price refresh error:', (err as Error).message);
  }
}

/**
 * Active watchdog for armed token snipes (e.g. pearpe.tkn.near).
 * Runs every 5s. Probes on-chain pool status directly so any token that gains
 * liquidity or creates a pool triggers IMMEDIATELY, even if the block chunk
 * receipt was skipped or arrived before detector startup.
 */
async function pollActiveTokenSnipes(): Promise<void> {
  try {
    const activeTokens = await getDistinctActiveSnipeTokens().catch(() => []);
    if (activeTokens.length === 0) return;

    const now = Date.now();
    await Promise.all(
      activeTokens.map(async (tokenAddress) => {
        // Skip tokens that recently returned no pool — saves RPC calls
        const lastNegative = snipeNegativeCache.get(tokenAddress);
        if (lastNegative && now - lastNegative < SNIPE_NEGATIVE_TTL_MS) return;

        try {
          // Priority 1: Native Intear token probe (Authoritative DEX source for Intear tokens)
          if (isIntearToken(tokenAddress)) {
            const intearPoolId = await near.findIntearPoolId(tokenAddress).catch(() => null);
            if (intearPoolId !== null && intearPoolId !== undefined && intearPoolId >= 0) {
              const intearState = await near.getIntearTokenState(tokenAddress).catch(() => null);
              if (
                intearState &&
                (intearState.liquidityNear > 0 || (intearState.price > 0 && BigInt(intearState.reserveNear) > 0n))
              ) {
                console.log(`[SNIPE_WATCHDOG] Armed target ${tokenAddress} is LIVE on Intear (pool ${intearPoolId})! Liq: ${intearState.liquidityNear} NEAR, Price: ${intearState.price}`);
                snipeNegativeCache.delete(tokenAddress);
                await checkSnipeSignalsOnly(tokenAddress, 'intear');
                return;
              }
            }
          }

          // Priority 2: Native token launchpads
          if (tokenAddress.endsWith('.nearlytrade.near')) {
            const nt = await near.getNearlytradeTokenState(tokenAddress).catch(() => null);
            if (nt && nt.live && nt.price > 0 && nt.liquidityNear > 0) {
              console.log(`[SNIPE_WATCHDOG] Armed target ${tokenAddress} is LIVE on NearlyTrade! Liq: ${nt.liquidityNear} NEAR`);
              snipeNegativeCache.delete(tokenAddress);
              await checkSnipeSignalsOnly(tokenAddress, 'nearlytrade');
              return;
            }
          }

          if (tokenAddress.endsWith('.onetokenhub.near')) {
            const hub = await near.getOneTokenHubState(tokenAddress).catch(() => null);
            if (hub && hub.price > 0 && hub.liquidityNear > 0) {
              console.log(`[SNIPE_WATCHDOG] Armed target ${tokenAddress} is LIVE on OneTokenHub! Liq: ${hub.liquidityNear} NEAR`);
              snipeNegativeCache.delete(tokenAddress);
              await checkSnipeSignalsOnly(tokenAddress, 'onetokenhub');
              return;
            }
          }

          if (tokenAddress.endsWith('.nearpadfamily.near') || tokenAddress.endsWith('.nearpad.near')) {
            const pad = await near.getNEARpadState(tokenAddress).catch(() => null);
            if (pad && pad.price > 0 && pad.liquidityNear > 0) {
              console.log(`[SNIPE_WATCHDOG] Armed target ${tokenAddress} is LIVE on NEARpad! Liq: ${pad.liquidityNear} NEAR`);
              snipeNegativeCache.delete(tokenAddress);
              await checkSnipeSignalsOnly(tokenAddress, 'nearpad');
              return;
            }
          }

          // Fast-path: Check if token venue is already known in DB cache
          const dbCache = await getTokenCache(tokenAddress).catch(() => null);
          if (dbCache && dbCache.venue) {
            if (dbCache.venue === 'intear') {
              const intearPoolId = dbCache.dcl_pool_id ? parseInt(dbCache.dcl_pool_id, 10) : await near.findIntearPoolId(tokenAddress).catch(() => null);
              if (intearPoolId !== null && intearPoolId !== undefined && intearPoolId >= 0) {
                const intearState = await near.getIntearTokenState(tokenAddress).catch(() => null);
                if (intearState && (intearState.liquidityNear > 0 || (intearState.price > 0 && BigInt(intearState.reserveNear) > 0n))) {
                  console.log(`[SNIPE_WATCHDOG] Armed target ${tokenAddress} is LIVE on Intear (pool ${intearPoolId})! Liq: ${intearState.liquidityNear} NEAR`);
                  snipeNegativeCache.delete(tokenAddress);
                  await checkSnipeSignalsOnly(tokenAddress, 'intear');
                  return;
                }
              }
            } else if (dbCache.venue === 'nearlytrade') {
              const nt = await near.getNearlytradeTokenState(tokenAddress).catch(() => null);
              if (nt && nt.live && nt.price > 0 && nt.liquidityNear > 0) {
                console.log(`[SNIPE_WATCHDOG] Armed target ${tokenAddress} is LIVE on NearlyTrade! Liq: ${nt.liquidityNear} NEAR`);
                snipeNegativeCache.delete(tokenAddress);
                await checkSnipeSignalsOnly(tokenAddress, 'nearlytrade');
                return;
              }
            } else if (dbCache.venue === 'rhea' || dbCache.venue === 'ref') {
              const rheaPool = await near.findRheaPoolForToken(tokenAddress, false).catch(() => null);
              if (rheaPool && rheaPool.poolId !== null && rheaPool.poolId !== undefined && rheaPool.price > 0 && rheaPool.liquidityNear > 0) {
                console.log(`[SNIPE_WATCHDOG] Armed target ${tokenAddress} is LIVE on Rhea/Ref! Liq: ${rheaPool.liquidityNear} NEAR`);
                snipeNegativeCache.delete(tokenAddress);
                await checkSnipeSignalsOnly(tokenAddress, 'rhea');
                return;
              }
            }
          }

          // Standard probes: DCL & Ref Simple Pools
          const dclPoolId = await near.findDclPoolId('wrap.near', tokenAddress).catch(() => null);
          if (dclPoolId) {
            const st = await near.getDclPoolState(dclPoolId, 'wrap.near').catch(() => null);
            if (st && st.price > 0 && st.liquidityNear > 0) {
              console.log(`[SNIPE_WATCHDOG] Armed target ${tokenAddress} is LIVE on DCL (${dclPoolId})! Liq: ${st.liquidityNear} NEAR`);
              snipeNegativeCache.delete(tokenAddress);
              await checkSnipeSignalsOnly(tokenAddress, 'rhea');
              return;
            }
          }

          const rheaPoolId = await near.findRheaPoolId('wrap.near', tokenAddress).catch(() => null);
          if (rheaPoolId !== null && rheaPoolId !== undefined) {
            const res = await near.getRheaPoolReserves(rheaPoolId, 'wrap.near', tokenAddress).catch(() => null);
            if (res) {
              const nearRes = parseFloat(res.reserveIn) / 1e24;
              if (nearRes > 0) {
                console.log(`[SNIPE_WATCHDOG] Armed target ${tokenAddress} is LIVE on Ref Simple Pool (${rheaPoolId})! Reserve: ${nearRes} NEAR`);
                snipeNegativeCache.delete(tokenAddress);
                await checkSnipeSignalsOnly(tokenAddress, 'rhea');
                return;
              }
            }
          }

          const rheaPool = await near.findRheaPoolForToken(tokenAddress, false).catch(() => null);
          if (rheaPool && rheaPool.poolId !== null && rheaPool.poolId !== undefined && rheaPool.price > 0 && rheaPool.liquidityNear > 0) {
            console.log(`[SNIPE_WATCHDOG] Armed target ${tokenAddress} is LIVE on Rhea/Ref! Liq: ${rheaPool.liquidityNear} NEAR, Price: ${rheaPool.price}`);
            snipeNegativeCache.delete(tokenAddress);
            await checkSnipeSignalsOnly(tokenAddress, 'rhea');
            return;
          }

          // All probes returned nothing — cache negative result for 3s
          snipeNegativeCache.set(tokenAddress, Date.now());
        } catch {
          // Keep looping across targets
        }
      })
    );
  } catch (err: any) {
    // Keep watchdog timer alive
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

main().catch(err => {
  console.error('[DETECTOR] Fatal error:', err);
  process.exit(1);
});

// Export caches for use in tests
export { priceCache, tokenNameCache };