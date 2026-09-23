import 'dotenv/config';
import {
  getNear,
  createRedis,
  CHANNELS,
  type TokenDetectedEvent,
  type PoolCreatedEvent,
  type PriceUpdateEvent,
  type AutoBuySignal,
} from '@racerbot/shared';
import { getDb, upsertTokenCache, getTokenCache, getActiveTriggers, getPositionById } from '@racerbot/db';

// ── In-memory caches (primary read path — never query DB in hot loop) ─────────

/** token_address → { price, liquidity, marketCap, timestamp } */
const priceCache = new Map<string, { price: number; liquidity: number; marketCap: number; ts: number }>();

/** token_address → TokenDetectedEvent (for snipe-by-name matching) */
const tokenNameCache = new Map<string, TokenDetectedEvent>();

// ── RPC + Redis setup ────────────────────────────────────────────────────────

const REDIS_URL = process.env.REDIS_URL!;
const RPC_URLS = (process.env.RPC_PROVIDERS ?? '')
  .split(',')
  .map(u => u.trim())
  .filter(Boolean); // getNear() falls back to DEFAULT_RPC_URLS when empty
if (RPC_URLS.length === 0) {
  console.warn('[DETECTOR] RPC_PROVIDERS not set — using built-in default RPCs');
}
const POLL_INTERVAL_MS = 1000; // NEAR block time ~1.2s
const TRIGGER_PRICE_REFRESH_MS = 15_000; // keep stop-loss prices fresh
const LAST_BLOCK_KEY = 'detector:last_block';
const MAX_CATCHUP_BLOCKS = 50; // bounded replay after downtime

// Rhea Finance = Ref Finance rebrand; pools live on v2.ref-finance.near
// (rhea.finance is only the website — watching it alone missed every launch).
const RHEA_RECEIVERS = new Set(['rhea.finance', 'v2.ref-finance.near']);

const near = getNear(RPC_URLS);
const redis = createRedis(REDIS_URL);

// ── Main loop ────────────────────────────────────────────────────────────────

async function main() {
  await getDb();
  near.startHealthChecks(30_000);

  // One stray rejected promise must not kill the block watcher
  process.on('unhandledRejection', (reason) => {
    console.error('[DETECTOR] Unhandled rejection (kept alive):', reason);
  });

  // Stop-loss/take-profit prices must not depend on a swap happening to
  // occur — refresh every token with an active trigger on a fixed cadence.
  setInterval(() => {
    void refreshTriggerTokenPrices();
  }, TRIGGER_PRICE_REFRESH_MS);

  console.log('[DETECTOR] Starting NEAR block watcher...');
  console.log(`[DETECTOR] RPC providers: ${RPC_URLS.length}`);

  let lastBlock = parseInt((await redis.get(LAST_BLOCK_KEY)) ?? '0');

  // Case 1 & 2: Initial bootstrap or jump forward if too far behind
  const initialHeight = await fetchBlockHeight();
  if (initialHeight > 0) {
    if (lastBlock === 0) {
      console.log(`[DETECTOR] Initializing block tracking at current height: ${initialHeight}`);
      lastBlock = initialHeight;
      await redis.set(LAST_BLOCK_KEY, initialHeight.toString(), 86400).catch(() => {});
    } else if (initialHeight - lastBlock > MAX_CATCHUP_BLOCKS) {
      console.log(
        `[DETECTOR] Catching up: jumping ${lastBlock} → ${initialHeight - MAX_CATCHUP_BLOCKS} (bounded replay of ${MAX_CATCHUP_BLOCKS} blocks)`
      );
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
              console.error(`[DETECTOR] Block ${height} error:`, err.message);
            })
          )
        );
      }
      lastBlock = initialHeight;
      await redis.set(LAST_BLOCK_KEY, initialHeight.toString(), 86400).catch(() => {});
    }
  }

  // Steady-state polling loop: fetch next block directly from neardata without polling block height
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
          for (const shard of shards) {
            const outcomes = shard?.receipt_execution_outcomes ?? [];
            for (const item of outcomes) {
              const logs: string[] = item?.execution_outcome?.outcome?.logs ?? [];
              const receiverId: string = item?.receipt?.receiver_id ?? '';
              for (const log of logs) {
                await parseEventLog(log, receiverId).catch(() => {});
              }
            }
          }
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
      console.error('[DETECTOR] Poll error:', err.message);
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
      for (const shard of shards) {
        const outcomes = shard?.receipt_execution_outcomes ?? [];
        for (const item of outcomes) {
          const logs: string[] = item?.execution_outcome?.outcome?.logs ?? [];
          const receiverId: string = item?.receipt?.receiver_id ?? '';
          for (const log of logs) {
            await parseEventLog(log, receiverId).catch(() => {});
          }
        }
      }
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
        receiverId === 'meme-cooking.near'
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
                (fn.method_name === 'add_simple_pool' || fn.method_name === 'create_pool' || fn.method_name === 'swap')
              ) {
                const tokenAddress = decoded?.tokens?.[0] ?? decoded?.tokens?.[1] ?? '';
                if (tokenAddress) {
                  await handlePoolCreated(tokenAddress, 'rhea', decoded).catch(() => {});
                }
              } else if (receiverId === 'launch.intear.near') {
                // Intear launchpad — best-effort field extraction
                const tokenAddress =
                  decoded?.token ?? decoded?.token_id ?? decoded?.account_id ?? '';
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
                (fn.method_name === 'launch' || fn.method_name === 'buy' || fn.method_name === 'sell')
              ) {
                const tokenAddress = decoded?.token ?? decoded?.token_id ?? decoded?.token_address ?? '';
                if (tokenAddress) {
                  await handlePoolCreated(tokenAddress, 'nearlytrade', decoded).catch(() => {});
                }
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
async function parseEventLog(log: string, receiverId: string): Promise<void> {
  if (!log.startsWith('EVENT_JSON:')) return;

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

  // ── Rhea pool / token launch (v2.ref-finance.near is the real contract) ──
  if (RHEA_RECEIVERS.has(receiverId) && (eventName === 'pool_created' || eventName === 'token_launch')) {
    const tokenAddress: string = data?.token_id ?? data?.token_out ?? '';
    if (!tokenAddress) return;

    await handlePoolCreated(tokenAddress, 'rhea', data);
  }

  // ── Intear launchpad ────────────────────────────────────────────────────
  if (
    receiverId === 'launch.intear.near' &&
    (eventName === 'launch' || eventName === 'token_launch' || eventName === 'pool_created')
  ) {
    const tokenAddress: string = data?.token ?? data?.token_id ?? data?.account_id ?? '';
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

  // ── Price update from any venue (swap events) ───────────────────────────
  if (eventName === 'swap' && ((data?.token_in && data?.token_out) || data?.pool_id)) {
    await handleSwapEvent(data, receiverId).catch(() => {});
  }
}

/** When a new pool is detected: fetch token metadata, cache it, publish event */
async function handlePoolCreated(
  tokenAddress: string,
  venue: 'rhea' | 'shardsmarket' | 'nearlytrade' | 'intear' | 'memecooking',
  rawData: any
): Promise<void> {
  console.log(`[DETECTOR] New pool detected: ${tokenAddress} on ${venue}`);

  // Fetch token metadata via NEAR RPC
  let name = rawData?.name ?? '';
  let symbol = rawData?.symbol ?? '';
  let decimals = rawData?.decimals ?? 18;
  let totalSupply = '0';

  try {
    const meta = await near.getTokenMetadata(tokenAddress);
    name = meta.name;
    symbol = meta.symbol;
    decimals = meta.decimals;
    totalSupply = await near.getTokenTotalSupply(tokenAddress);
  } catch (err) {
    console.warn(`[DETECTOR] Could not fetch metadata for ${tokenAddress}:`, (err as Error).message);
    if (!name) return; // Skip if we have no data at all
  }

  const poolAddress = rawData?.pool_id ?? rawData?.pool_address ?? tokenAddress;
  let initialLiquidity = rawData?.near_amount ?? rawData?.initial_liquidity ?? '0';
  const creator = rawData?.creator_id ?? rawData?.owner_id ?? '';

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
      }
    } catch (err) {
      console.warn(`[DETECTOR] Could not fetch NearlyTrade state for ${tokenAddress}:`, (err as Error).message);
    }
  }

  // Creation events frequently carry no usable liquidity/price. Pull the
  // live pool state instead — auto-buy gating (min liquidity) and the
  // initial price/market-cap both depended on this and silently saw 0 before.
  if ((!initialLiquidity || initialLiquidity === '0') || initialPrice <= 0) {
    try {
      const spot = await near.getVenueSpotPrice(venue, tokenAddress, decimals);
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

  // 5. Check auto-buy signals (async, non-blocking)
  setImmediate(() => checkAutoBuySignals(tokenAddress, venue, initialLiquidity, marketCap));
}

/** When a swap is detected, extract the new price and publish a price update */
async function handleSwapEvent(data: any, venue: string): Promise<void> {
  const tokenAddress: string = data.token_out ?? data.token_in ?? '';
  if (!tokenAddress || tokenAddress === 'near' || tokenAddress === 'wrap.near') return;

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
      const reserves = await near.getRheaPoolReserves(rheaPoolId, data.token_in, data.token_out);
      const reserveInHuman = parseFloat(reserves.reserveIn) / 1e24;
      const reserveOutHuman = parseFloat(reserves.reserveOut) / Math.pow(10, decimals ?? 18);
      if (reserveOutHuman > 0) {
        price = reserveInHuman / reserveOutHuman;
        liquidity = reserveInHuman * 2;
      }
    }
  } else if (venue === 'nearlytrade.near' || venue === 'dclv2.ref-labs.near' || venue.includes('nearlytrade') || venue.includes('dclv2')) {
    try {
      const ntState = await near.getNearlytradeTokenState(tokenAddress);
      if (ntState && ntState.price > 0) {
        price = ntState.price;
        liquidity = ntState.liquidityNear;
      }
    } catch {
      // skip
    }
  } else if (venue === 'factory.shardsmarket.near' || venue.includes('shardsmarket')) {
    const reserves = await near.getShardsmarketPoolReserves(tokenAddress);
    const reserveNearHuman = parseFloat(reserves.reserveNear) / 1e24;
    const reserveTokenHuman = parseFloat(reserves.reserveToken) / Math.pow(10, decimals ?? 18);
    if (reserveTokenHuman > 0) {
      price = reserveNearHuman / reserveTokenHuman;
      liquidity = reserveNearHuman * 2;
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
}

/**
 * After a new token is detected, check if any users have auto-buy enabled
 * and the token passes their filters. Publish AUTO_BUY_SIGNAL for each match.
 */
async function checkAutoBuySignals(
  tokenAddress: string,
  venue: 'rhea' | 'shardsmarket' | 'nearlytrade' | 'intear' | 'memecooking',
  liquidityStr: string,
  marketCap: number
): Promise<void> {
  // Only tradeable venues can be auto-bought
  if (venue === 'memecooking') return;
  try {
    const db = await getDb();
    const result = await db
      .query(
        `SELECT id, telegram_id, default_buy_pct, auto_buy_amount_near, auto_buy_min_liquidity_near FROM users WHERE auto_buy_enabled = true AND auto_buy_amount_near > 0`
      )
      .catch(() => ({ rows: [] as any[] }));

    const liquidity = parseFloat(liquidityStr) / 1e24; // Convert yoctoNEAR to NEAR

    for (const user of result.rows) {
      const minLiquidity = parseFloat(user.auto_buy_min_liquidity_near ?? '500');
      if (liquidity < minLiquidity) continue;

      const signal: AutoBuySignal = {
        type: 'auto_buy_signal',
        user_id: user.id,
        token_address: tokenAddress,
        amount_near: user.auto_buy_amount_near.toString(),
        venue,
        timestamp: Date.now(),
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
    for (const t of triggers) {
      const pos = await getPositionById(t.position_id).catch(() => null);
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
          if (!venue || venue === 'memecooking') return;
          const decimals = dbCache?.decimals ?? 18;
          const spot = await near.getVenueSpotPrice(venue, tokenAddress, decimals);
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

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

main().catch(err => {
  console.error('[DETECTOR] Fatal error:', err);
  process.exit(1);
});

// Export caches for use in tests
export { priceCache, tokenNameCache };