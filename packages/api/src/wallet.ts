import 'dotenv/config';
import { getNear, encrypt, decrypt, generateScopedAccessKey, generateRandomAccountPrefix, createRedis, CHANNELS, parseMemeCookingId, type VenueName } from '@racerbot/shared';
import {
  getDb,
  createUser,
  getUserByTelegramId,
  updateUserScopedKey,
  getTokenCache,
  upsertTokenCache,
  getOpenPositions,
  createPosition,
  createFill,
  updatePosition,
  generateReferralCode,
  getUserByReferralCode,
  createReferral,
  activateReferral,
  addReferralReward,
  getReferralByReferredUser,
} from '@racerbot/db';
import { utils as nearUtils, keyStores, KeyPair, connect } from 'near-api-js';
import { MAIN_WALLET_PRIVATE_KEY, RACERBOT_PARENT_ACCOUNT } from './config.js';

const MASTER_KEY = process.env.KEY_ENCRYPTION_MASTER_KEY!;
const configuredRpcList = (process.env.RPC_PROVIDERS || '').split(',').map(u => u.trim()).filter(Boolean);
const qnUrl = (process.env.QUICKNODE_ENDPOINT_URL || '').trim();
if (qnUrl && !configuredRpcList.includes(qnUrl)) {
  configuredRpcList.push(qnUrl);
}
const RPC_URLS = configuredRpcList.length > 0 ? configuredRpcList : ['https://rpc.mainnet.fastnear.com'];
const near = getNear(RPC_URLS);

// ── In-memory token info cache with 30s TTL ───────────────────────────────────
const tokenInfoCache = new Map<string, { data: TokenInfoResult; expiresAt: number }>();

// ── In-memory user balance cache with 8s TTL ──────────────────────────────────
const balanceCache = new Map<number, { data: UserBalances; expiresAt: number }>();

// ── Permanent in-memory token metadata cache (never changes for NEP-141) ───────
const tokenMetaCache = new Map<string, { name: string; symbol: string; decimals: number }>();

// ── User token deposit sync debounce map (10s TTL) ───────────────────────────
const lastSyncDepositsMap = new Map<string, number>();

// ── NEAR/USD price cache — refresh every 2 minutes ───────────────────────────
let nearUsdPrice = 0;
let nearUsdLastFetch = 0;

/**
 * FIX 6: Warm the in-memory tokenInfoCache from the DB on startup.
 * Runs a single query for all token_cache rows updated in the last 30 minutes
 * and pre-populates the cache so the first user request after a Railway redeploy
 * doesn't need to hit the blockchain for already-known tokens.
 */
export async function warmTokenInfoCache(): Promise<void> {
  try {
    const db = await getDb();
    const result = await db.query(
      `SELECT * FROM token_cache
       WHERE updated_at > NOW() - INTERVAL '30 minutes'
         AND last_price IS NOT NULL
         AND last_price > 0
       ORDER BY updated_at DESC
       LIMIT 500`
    );
    const nearUsd = await getNearUsdPrice().catch(() => 0);
    let warmed = 0;
    for (const row of result.rows) {
      const lastPrice = parseFloat(row.last_price || '0');
      if (lastPrice <= 0) continue;
      const supply = parseFloat(row.total_supply || '0') / Math.pow(10, row.decimals || 18);
      const mcap = lastPrice > 0 && supply > 0 ? lastPrice * supply : 0;
      const tokenData: TokenInfoResult = {
        address: row.token_address,
        name: row.name ?? '',
        symbol: row.symbol ?? '',
        decimals: row.decimals ?? 18,
        total_supply: row.total_supply ?? '0',
        price: lastPrice.toFixed(12),
        price_usd: nearUsd > 0 ? (lastPrice * nearUsd).toFixed(8) : '0',
        liquidity: row.last_liquidity?.toString() ?? '0',
        liquidity_usd: nearUsd > 0 ? (parseFloat(row.last_liquidity || '0') * nearUsd).toFixed(2) : '0',
        market_cap: mcap,
        market_cap_usd: nearUsd > 0 ? mcap * nearUsd : 0,
        near_usd: nearUsd,
        venue: (row.venue as any) ?? 'unknown',
        rhea_pool_id: row.rhea_pool_id != null ? Number(row.rhea_pool_id) : null,
        bonding_phase: (row.bonding_phase as any) ?? null,
        bonding_progress_pct: row.bonding_progress_pct != null ? Number(row.bonding_progress_pct) : null,
        dcl_pool_id: row.dcl_pool_id ?? null,
        tradeable: ['rhea', 'shardsmarket', 'nearlytrade', 'intear', 'onetokenhub', 'nearpad'].includes(row.venue ?? 'unknown'),
      };
      // Use a shorter TTL (15s) for warmed entries — they're older DB data, not live RPC
      tokenInfoCache.set(row.token_address, { data: tokenData, expiresAt: Date.now() + 60000 });
      warmed++;
    }
    console.log(`[API] Token cache warmed: ${warmed} tokens pre-loaded from DB.`);
  } catch (err: any) {
    console.warn('[API] Token cache warm failed (non-fatal):', err.message);
  }
}


export async function getNearUsdPrice(): Promise<number> {
  const now = Date.now();
  // If we already have a price, return it immediately and refresh in background if expired (stale-while-revalidate)
  if (nearUsdPrice > 0) {
    if (now - nearUsdLastFetch >= 120_000) {
      fetch('https://api.coingecko.com/api/v3/simple/price?ids=near&vs_currencies=usd', {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(3000),
      })
        .then((res) => res.json())
        .then((data: any) => {
          if (data?.near?.usd > 0) {
            nearUsdPrice = data.near.usd;
            nearUsdLastFetch = Date.now();
          }
        })
        .catch(() => {});
    }
    return nearUsdPrice;
  }

  // Initial fetch on boot (bounded to 2s timeout)
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=near&vs_currencies=usd',
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(2000) }
    );
    if (res.ok) {
      const data: any = await res.json();
      const price = data?.near?.usd;
      if (price && price > 0) {
        nearUsdPrice = price;
        nearUsdLastFetch = now;
      }
    }
  } catch {
    // Silently fall back
  }
  return nearUsdPrice || 4.3;
}

export interface TokenInfoResult {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  total_supply: string;
  price: string;           // price in NEAR
  price_usd: string;       // price in USD
  liquidity: string;       // liquidity in NEAR
  liquidity_usd: string;   // liquidity in USD
  market_cap: number;      // market cap in NEAR
  market_cap_usd: number;  // market cap in USD
  near_usd: number;        // NEAR/USD exchange rate at time of fetch
  venue: 'rhea' | 'ref' | 'shardsmarket' | 'nearlytrade' | 'memecooking' | 'intear' | 'onetokenhub' | 'gaypad' | 'nearpad' | 'unknown';
  rhea_pool_id?: number | null;
  bonding_phase?: 'prebonded' | 'bonded' | null;
  bonding_progress_pct?: number | null;
  dcl_pool_id?: string | null;
  tradeable: boolean;   // false for venues we support info but not trading on
}

/**
 * Detect whether a token address belongs to meme.cooking launchpad.
 */
function isMemooCookingToken(tokenAddress: string): boolean {
  return tokenAddress.endsWith('.meme-cooking.near');
}

/**
 * Detect whether a token address belongs to intear launchpad.
 */
function isIntearToken(tokenAddress: string): boolean {
  return tokenAddress.endsWith('.launch.intear.near') || tokenAddress.endsWith('.intear.near');
}

/**
 * Fetch meme.cooking token state from on-chain.
 */
async function getMemeCookingTokenInfo(tokenAddress: string): Promise<{ price: number; liquidity: number; phase: string; progress: number }> {
  const memeId = parseMemeCookingId(tokenAddress);
  if (memeId === null) {
    return { price: 0, liquidity: 0, phase: 'unknown', progress: 0 };
  }

  try {
    const meme = await near.view<any>('meme-cooking.near', 'get_meme', { meme_id: memeId }).catch(() => null);
    if (meme) {
      const totalStaked = parseFloat(meme.total_staked || '0') / 1e24;
      const hardCap = parseFloat(meme.hard_cap || '0') / 1e24;
      const tokensToDistribute = parseFloat(meme.amount_to_be_distributed || meme.total_supply || '0') / Math.pow(10, meme.decimals || 18);
      const price = tokensToDistribute > 0 ? totalStaked / tokensToDistribute : 0;
      const progress = hardCap > 0 ? Math.min(100, (totalStaked / hardCap) * 100) : 0;
      return { price, liquidity: totalStaked, phase: 'prebonded', progress };
    }
  } catch {}

  try {
    const fin = await near.view<any>('meme-cooking.near', 'get_finalized_meme', { meme_id: memeId }).catch(() => null);
    if (fin) {
      return { price: 0, liquidity: 0, phase: 'bonded', progress: 100 };
    }
  } catch {}

  return { price: 0, liquidity: 0, phase: 'unknown', progress: 0 };
}

/**
 * Get token info with 30s in-memory TTL cache.
 * Fetches ft_metadata + pool reserves from Shardsmarket, Rhea, NearlyTrade, or other known launchpads.
 * Never returns hardcoded data.
 */
export async function getTokenInfo(tokenAddress: string, forceRefresh = false): Promise<TokenInfoResult> {
  if (!forceRefresh) {
    const cached = tokenInfoCache.get(tokenAddress);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.data;
    }
  }

  // Fetch NEAR/USD price in parallel (non-blocking, uses cache if fresh)
  const nearUsdPromise = getNearUsdPrice();

  // Check DB cache first (written by detector — may be fresh enough if price > 0)
  const dbCache = await getTokenCache(tokenAddress).catch(() => null);
  if (
    dbCache &&
    dbCache.updated_at &&
    Date.now() - dbCache.updated_at.getTime() < 60000 &&
    Number(dbCache.last_price || 0) > 0
  ) {
    const lastPrice = Number(dbCache.last_price || 0);
    const supply = parseFloat(dbCache.total_supply || '0') / Math.pow(10, dbCache.decimals || 18);
    const mcap = lastPrice > 0 && supply > 0 ? lastPrice * supply : 0;
    const nearUsd = await nearUsdPromise;
    const result: TokenInfoResult = {
      address: tokenAddress,
      name: dbCache.name ?? '',
      symbol: dbCache.symbol ?? '',
      decimals: dbCache.decimals ?? 18,
      total_supply: dbCache.total_supply ?? '0',
      price: dbCache.last_price?.toString() ?? '0',
      price_usd: nearUsd > 0 ? (lastPrice * nearUsd).toFixed(8) : '0',
      liquidity: dbCache.last_liquidity?.toString() ?? '0',
      liquidity_usd: nearUsd > 0 ? (Number(dbCache.last_liquidity || 0) * nearUsd).toFixed(2) : '0',
      market_cap: mcap,
      market_cap_usd: nearUsd > 0 ? mcap * nearUsd : 0,
      near_usd: nearUsd,
      venue: (dbCache.venue as any) ?? 'unknown',
      rhea_pool_id: dbCache.rhea_pool_id,
      bonding_phase: (dbCache.bonding_phase as any) ?? null,
      bonding_progress_pct:
        dbCache.bonding_progress_pct !== null && dbCache.bonding_progress_pct !== undefined
          ? Number(dbCache.bonding_progress_pct)
          : null,
      dcl_pool_id: dbCache.dcl_pool_id ?? null,
      tradeable: ['rhea', 'ref', 'shardsmarket', 'nearlytrade', 'intear', 'onetokenhub', 'nearpad', 'gaypad', 'memecooking'].includes(dbCache.venue ?? 'unknown'),
    };
    tokenInfoCache.set(tokenAddress, { data: result, expiresAt: Date.now() + 60000 });
    return result;
  }

  // Fetch ft_metadata — if cached in memory or in DB, reuse without RPC call
  let meta: { name: string; symbol: string; decimals: number };
  let totalSupply = '0';

  if (tokenMetaCache.has(tokenAddress)) {
    meta = tokenMetaCache.get(tokenAddress)!;
    totalSupply = dbCache?.total_supply ?? '0';
  } else if (dbCache && dbCache.name && dbCache.symbol && dbCache.decimals !== null && dbCache.decimals !== undefined) {
    meta = { name: dbCache.name, symbol: dbCache.symbol, decimals: Number(dbCache.decimals) };
    totalSupply = dbCache.total_supply ?? '0';
    tokenMetaCache.set(tokenAddress, meta);
  } else {
    try {
      const [fetchedMeta, fetchedSupply] = await Promise.all([
        near.getTokenMetadata(tokenAddress),
        near.getTokenTotalSupply(tokenAddress).catch(() => '0'),
      ]);
      meta = fetchedMeta;
      totalSupply = fetchedSupply;
      tokenMetaCache.set(tokenAddress, meta);
    } catch {
      // If RPC metadata fetch fails, fall back to DB cache data if available
      if (dbCache && dbCache.name) {
        meta = { name: dbCache.name ?? 'Unknown', symbol: dbCache.symbol ?? '???', decimals: dbCache.decimals ?? 18 };
        totalSupply = dbCache.total_supply ?? '0';
      } else {
        // Last resort: return a minimal result so the caller can still identify the token
        return {
          address: tokenAddress,
          name: 'Unknown',
          symbol: '???',
          decimals: 18,
          total_supply: '0',
          price: '0',
          price_usd: '0',
          liquidity: '0',
          liquidity_usd: '0',
          market_cap: 0,
          market_cap_usd: 0,
          near_usd: 0,
          venue: 'unknown',
          tradeable: false,
        };
      }
    }
  }

  let price = 0;
  let liquidity = 0;
  let venue: TokenInfoResult['venue'] = 'unknown';
  let rheaPoolId: number | null = dbCache?.rhea_pool_id ?? null;
  let bondingPhase: 'prebonded' | 'bonded' | null = (dbCache?.bonding_phase as any) ?? null;
  let bondingProgressPct: number | null =
    dbCache?.bonding_progress_pct !== null && dbCache?.bonding_progress_pct !== undefined
      ? Number(dbCache.bonding_progress_pct)
      : null;
  let dclPoolId: string | null = dbCache?.dcl_pool_id ?? null;

  // Fast-path: if dbCache already knows the exact Rhea pool ID, check it directly in 1 view call
  if (dbCache && dbCache.rhea_pool_id && (dbCache.venue === 'rhea' || dbCache.venue === 'ref')) {
    try {
      const rh = await near.getRheaPoolReserves(dbCache.rhea_pool_id, 'wrap.near', tokenAddress).catch(() => null);
      if (rh) {
        const reserveNearHuman = parseFloat(rh.reserveIn) / 1e24;
        const reserveTokenHuman = parseFloat(rh.reserveOut) / Math.pow(10, meta.decimals);
        if (reserveNearHuman > 0 && reserveTokenHuman > 0) {
          price = reserveNearHuman / reserveTokenHuman;
          liquidity = reserveNearHuman * 2;
          venue = 'rhea';
          rheaPoolId = dbCache.rhea_pool_id;
        }
      }
    } catch {}
  }

  // Step 1: Rhea first, for every token — use findRheaPoolForToken (covers Simple + DCL + multi-hop)
  if (price === 0) {
    try {
      const rhea = await near.findRheaPoolForToken(tokenAddress);
      if (rhea && rhea.poolId !== null && rhea.poolId !== undefined && rhea.price > 0) {
        price = rhea.price;
        liquidity = rhea.liquidityNear;
        venue = 'rhea';
        if (rhea.isDcl) {
          dclPoolId = String(rhea.poolId);
        } else {
          rheaPoolId = typeof rhea.poolId === 'number' ? rhea.poolId : null;
        }
      }
    } catch {}
  }

  // Step 2: Only if Rhea has no liquidity, use address suffix to pick a launchpad prober
  if (price === 0) {
    if (isMemooCookingToken(tokenAddress)) {
      venue = 'memecooking';
      const mcInfo = await getMemeCookingTokenInfo(tokenAddress).catch(() => ({ price: 0, liquidity: 0, phase: 'unknown', progress: 0 }));
      price = mcInfo.price;
      liquidity = mcInfo.liquidity;
      bondingPhase = mcInfo.phase === 'bonded' ? 'bonded' : (mcInfo.phase === 'prebonded' ? 'prebonded' : null);
      bondingProgressPct = mcInfo.progress;
    } else if (isIntearToken(tokenAddress)) {
      venue = 'intear';
      try {
        const intearState = await near.getIntearTokenState(tokenAddress);
        price = intearState.price;
        liquidity = intearState.liquidityNear;
      } catch {
        // If pool lookup failed, keep metadata with 0 price
      }
    } else if (tokenAddress.endsWith('.factory.shardsmarket.near')) {
      // Shardsmarket: token IS its own AMM pool — call get_state() directly
      try {
        const smState = await near.getShardsmarketTokenState(tokenAddress);
        const reserveNearYocto = parseFloat(smState.poolQuote);
        const reserveTokenRaw = parseFloat(smState.poolToken);
        if (reserveNearYocto > 0 && reserveTokenRaw > 0) {
          const reserveNearHuman = reserveNearYocto / 1e24;
          const reserveTokenHuman = reserveTokenRaw / Math.pow(10, meta.decimals);
          price = reserveNearHuman / reserveTokenHuman;
          liquidity = reserveNearHuman * 2;
          venue = 'shardsmarket';
          if (smState.totalSupply && smState.totalSupply !== '0') {
            totalSupply = smState.totalSupply;
          }
        }
      } catch {
        // Not a live Shardsmarket pool (presale phase or not found)
      }
    } else if (tokenAddress.endsWith('.pad.onetokenhub.near')) {
      venue = 'onetokenhub';
      try {
        const hubState = await near.getOneTokenHubState(tokenAddress);
        price = hubState.price;
        liquidity = hubState.liquidityNear;
        dclPoolId = hubState.dclPoolId;
        if (hubState.totalSupply && hubState.totalSupply !== '0') {
          totalSupply = hubState.totalSupply;
        }
      } catch {
        // If state lookup failed, keep metadata
      }
    } else if (tokenAddress.endsWith('.nearpadfamily.near')) {
      venue = 'nearpad';
      try {
        const padState = await near.getNEARpadState(tokenAddress);
        price = padState.price;
        liquidity = padState.liquidityNear;
        dclPoolId = padState.dclPoolId;
        if (padState.totalSupply && padState.totalSupply !== '0') {
          totalSupply = padState.totalSupply;
        }
      } catch {
        // If state lookup failed, keep metadata
      }
    } else {
      // Venue probing for tokens matching no known address suffix
      const [ntRes, hubRes, padRes] = await Promise.allSettled([
        near.getNearlytradeTokenState(tokenAddress),
        near.getOneTokenHubState(tokenAddress),
        near.getNEARpadState(tokenAddress),
      ]);

      if (ntRes.status === 'fulfilled' && ntRes.value) {
        const ntState = ntRes.value;
        venue = 'nearlytrade';
        price = ntState.price;
        liquidity = ntState.liquidityNear;
        bondingPhase = ntState.phase;
        bondingProgressPct = ntState.bondingProgressPct;
        dclPoolId = ntState.dclPoolId;
        if (ntState.totalSupply && ntState.totalSupply !== '0') {
          totalSupply = ntState.totalSupply;
        }
      } else if (hubRes.status === 'fulfilled' && hubRes.value) {
        const hubState = hubRes.value;
        venue = 'onetokenhub';
        price = hubState.price;
        liquidity = hubState.liquidityNear;
        dclPoolId = hubState.dclPoolId;
        if (hubState.totalSupply && hubState.totalSupply !== '0') {
          totalSupply = hubState.totalSupply;
        }
      } else if (padRes.status === 'fulfilled' && padRes.value) {
        const padState = padRes.value;
        venue = 'nearpad';
        price = padState.price;
        liquidity = padState.liquidityNear;
        dclPoolId = padState.dclPoolId;
        if (padState.totalSupply && padState.totalSupply !== '0') {
          totalSupply = padState.totalSupply;
        }
      } else {
        // Intear last resort — full scan, only when cheap probes missed
        try {
          const intearState = await near.getIntearTokenState(tokenAddress);
          if (intearState && intearState.price > 0) {
            venue = 'intear';
            price = intearState.price;
            liquidity = intearState.liquidityNear;
            if (intearState.totalSupply && intearState.totalSupply !== '0') {
              totalSupply = intearState.totalSupply;
            }
          }
        } catch {
          /* not on Intear */
        }
      }
    }
  }

  const supplyNum = parseFloat(totalSupply) / Math.pow(10, meta.decimals);
  const marketCap = price > 0 && supplyNum > 0 ? price * supplyNum : 0;
  const tradeable = ['shardsmarket', 'nearlytrade', 'rhea', 'ref', 'intear', 'onetokenhub', 'nearpad', 'gaypad', 'memecooking'].includes(venue);
  const nearUsd = await nearUsdPromise;

  const result: TokenInfoResult = {
    address: tokenAddress,
    name: meta.name,
    symbol: meta.symbol,
    decimals: meta.decimals,
    total_supply: totalSupply,
    price: price > 0 ? price.toFixed(12) : '0',
    price_usd: price > 0 && nearUsd > 0 ? (price * nearUsd).toFixed(8) : '0',
    liquidity: liquidity.toFixed(4),
    liquidity_usd: liquidity > 0 && nearUsd > 0 ? (liquidity * nearUsd).toFixed(2) : '0',
    market_cap: marketCap,
    market_cap_usd: marketCap > 0 && nearUsd > 0 ? marketCap * nearUsd : 0,
    near_usd: nearUsd,
    venue,
    rhea_pool_id: rheaPoolId,
    bonding_phase: bondingPhase,
    bonding_progress_pct: bondingProgressPct,
    dcl_pool_id: dclPoolId,
    tradeable,
  };

  tokenInfoCache.set(tokenAddress, { data: result, expiresAt: Date.now() + 60000 });

  // Async DB update (non-blocking)
  setImmediate(() =>
    upsertTokenCache({
      token_address: tokenAddress,
      name: meta.name,
      symbol: meta.symbol,
      decimals: meta.decimals,
      total_supply: totalSupply,
      pool_address: tokenAddress,
      venue: venue as any,
      rhea_pool_id: rheaPoolId,
      bonding_phase: bondingPhase,
      bonding_progress_pct: bondingProgressPct,
      dcl_pool_id: dclPoolId,
      last_price: price,
      last_liquidity: liquidity,
      updated_at: new Date(),
    }).catch(() => {})
  );

  return result;
}

// ── Section 1 Replacement: Custodial Onboarding & Key Rotation ──────────────

export interface OnboardResult {
  userId: string;
  subaccountId: string;
  privateKey?: string;
  isExisting: boolean;
}

/**
 * Onboards user via Telegram chat.
 * Generates a single ed25519 keypair, creates & funds the subaccount on-chain,
 * and returns the raw exported key string (ed25519:<base58>) to show once.
 * Idempotent: returns existing account info if user is already onboarded.
 * Optionally accepts a referral code to track who referred the user.
 */
export async function onboardUser(telegramId: number, referralCode?: string, username?: string): Promise<OnboardResult> {
  // Step 5: Check for existing user row (idempotency)
  const existing = await getUserByTelegramId(telegramId).catch(() => null);
  if (existing) {
    return {
      userId: existing.id,
      subaccountId: existing.subaccount_id,
      isExisting: true,
    };
  }

  // Validate referral code if provided
  let referrerId: string | null = null;
  if (referralCode) {
    const referrer = await getUserByReferralCode(referralCode);
    if (referrer) {
      referrerId = referrer.id;
    }
  }

  // Step 1: Generate exactly one ed25519 keypair
  const keyPair = generateScopedAccessKey();
  const publicKey = keyPair.getPublicKey();
  const privateKey = keyPair.toString();
  const prefix = generateRandomAccountPrefix();
  const subaccountId = `${prefix}.${RACERBOT_PARENT_ACCOUNT}`;

  // Step 4: Actually create subaccount on-chain before returning success
  if (!MAIN_WALLET_PRIVATE_KEY) {
    throw new Error('MAIN_WALLET_PRIVATE_KEY is not configured on server.');
  }

  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey(
    'mainnet',
    RACERBOT_PARENT_ACCOUNT,
    KeyPair.fromString(MAIN_WALLET_PRIVATE_KEY as any)
  );

  const nearConn = await connect({
    networkId: 'mainnet',
    keyStore,
    nodeUrl: RPC_URLS[0] || 'https://rpc.mainnet.fastnear.com',
  });

  const parentAccount = await nearConn.account(RACERBOT_PARENT_ACCOUNT);

  // Fund subaccount with minimum storage + gas (0.05 NEAR)
  const initialBalance = nearUtils.format.parseNearAmount('0.05')!;

  // Submit on-chain createAccount and await confirmation
  await parentAccount.createAccount(
    subaccountId,
    publicKey.toString(),
    BigInt(initialBalance)
  );

  // Step 3: Encrypt real secret key and store in DB
  const encryptedKey = encrypt(privateKey, MASTER_KEY);

  // Note: this key currently has no on-chain permission restriction,
  // since there is no user-side signing step to grant one.
  const user = await createUser({
    telegram_id: telegramId,
    subaccount_id: subaccountId,
    scoped_key_encrypted: encryptedKey,
  });

  // Generate referral code based on username
  if (username) {
    await generateReferralCode(user.id, username);
  }

  // Create referral record if referrer exists
  if (referrerId) {
    await createReferral(referrerId, user.id);
  }

  return {
    userId: user.id,
    subaccountId,
    privateKey, // Raw exported private key string (ed25519:<base58>)
    isExisting: false,
  };
}

const activeRotations = new Set<number>();

export interface RotateKeyResult {
  success: boolean;
  subaccountId: string;
  newPrivateKey: string;
}

/**
 * Rotates user's keypair on-chain and updates encrypted storage in DB.
 * Idempotent against double invocation using activeRotations set.
 */
export async function rotateUserKey(telegramId: number): Promise<RotateKeyResult> {
  if (activeRotations.has(telegramId)) {
    throw new Error('A key rotation is already in progress for this account. Please wait.');
  }

  activeRotations.add(telegramId);
  try {
    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      throw new Error('User not found. Run /start first.');
    }

    // Decrypt current key
    const currentPrivateKey = decrypt(user.scoped_key_encrypted, MASTER_KEY);
    const currentKeyPair = KeyPair.fromString(currentPrivateKey as any);
    const currentPublicKey = currentKeyPair.getPublicKey();

    // Generate new keypair
    const newKeyPair = generateScopedAccessKey();
    const newPublicKey = newKeyPair.getPublicKey();
    const newPrivateKey = newKeyPair.toString();

    // Connect as subaccount using current key
    const keyStore = new keyStores.InMemoryKeyStore();
    await keyStore.setKey('mainnet', user.subaccount_id, currentKeyPair);

    const nearConn = await connect({
      networkId: 'mainnet',
      keyStore,
      nodeUrl: RPC_URLS[0] || 'https://rpc.mainnet.fastnear.com',
    });

    const subaccount = await nearConn.account(user.subaccount_id);

    // 1. Add new key first, confirm it landed on-chain
    await subaccount.addKey(newPublicKey.toString());

    // 2. Delete old key, confirm it landed on-chain
    await subaccount.deleteKey(currentPublicKey.toString());

    // 3. Encrypt and store new key in DB only after on-chain swap confirmed
    const encryptedNewKey = encrypt(newPrivateKey, MASTER_KEY);
    await updateUserScopedKey(user.id, encryptedNewKey);

    return {
      success: true,
      subaccountId: user.subaccount_id,
      newPrivateKey,
    };
  } finally {
    activeRotations.delete(telegramId);
  }
}

let pubRedis: any = null;
let directExecutor: any = null;

/**
 * Execute a swap directly via SwapExecutor so the trade executes on-chain fast (~1s),
 * records the fill into the database synchronously, and returns the txHash & positionId
 * immediately for real-time PnL tracking and UI display.
 */
export async function publishSwap(swapEvent: {
  user_id: string;
  token_in: string;
  token_out: string;
  amount_in: string;
  min_amount_out: string;
  venue: VenueName;
  dcl_pool_id?: string;
  pool_id?: number;
}): Promise<{ txHash?: string; success?: boolean; positionId?: string; reason?: string }> {
  if (!directExecutor) {
    const { SwapExecutor } = await import('@racerbot/executor');
    directExecutor = new SwapExecutor();
  }
  const result = await directExecutor.execute({
    type: 'execute_swap',
    ...swapEvent,
    timestamp: Date.now(),
  });
  return {
    txHash: result.txHash,
    success: result.success !== false,
    positionId: result.positionId,
    reason: result.reason,
  };
}

export interface UserBalances {
  subaccountId: string;
  nativeNearYocto: string;
  nativeNearFormatted: string;
  nativeNearUsd: string;
  wrapNearYocto: string;
  wrapNearFormatted: string;
  wrapNearUsd: string;
  totalNearFormatted: string;
  totalNearUsd: string;
  nearUsd: number;
}

/**
 * Fetch native NEAR and wrap.near balances for user's subaccount with caching & parallel requests.
 */
export async function getUserBalances(telegramId: number, forceRefresh = false): Promise<UserBalances> {
  if (!forceRefresh) {
    const cached = balanceCache.get(telegramId);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.data;
    }
  }

  const user = await getUserByTelegramId(telegramId);
  if (!user) {
    throw new Error('User not found. Run /start first.');
  }

  const subaccountId = user.subaccount_id;
  let nativeNearYocto = '0';
  let wrapNearYocto = '0';

  const [nativeRes, wrapRes] = await Promise.allSettled([
    near.getNearBalance(subaccountId),
    near.view<string>('wrap.near', 'ft_balance_of', { account_id: subaccountId }),
  ]);

  if (nativeRes.status === 'fulfilled') {
    nativeNearYocto = nativeRes.value;
  }
  if (wrapRes.status === 'fulfilled') {
    wrapNearYocto = wrapRes.value || '0';
  }

  const nativeNear = Number(BigInt(nativeNearYocto) / 1000000000000000000n) / 1e6;
  const wrapNear = Number(BigInt(wrapNearYocto) / 1000000000000000000n) / 1e6;
  
  // Subtract storage reserve (0.05 NEAR) from display balance to show spendable amount
  const storageReserve = 0.05;
  const spendableNativeNear = Math.max(0, nativeNear - storageReserve);
  const totalNear = spendableNativeNear + wrapNear;

  // Get NEAR/USD price
  const nearUsd = await getNearUsdPrice();

  // Format USD values
  const formatUSD = (nearValue: number) => {
    const usdValue = nearValue * nearUsd;
    if (usdValue >= 1000) return `$${(usdValue / 1000).toFixed(2)}K`;
    if (usdValue >= 1) return `$${usdValue.toFixed(2)}`;
    return `$${usdValue.toFixed(4)}`;
  };

  const result: UserBalances = {
    subaccountId,
    nativeNearYocto,
    nativeNearFormatted: spendableNativeNear.toFixed(4),
    nativeNearUsd: formatUSD(spendableNativeNear),
    wrapNearYocto,
    wrapNearFormatted: wrapNear.toFixed(4),
    wrapNearUsd: formatUSD(wrapNear),
    totalNearFormatted: totalNear.toFixed(4),
    totalNearUsd: formatUSD(totalNear),
    nearUsd,
  };

  balanceCache.set(telegramId, { data: result, expiresAt: Date.now() + 8000 });
  return result;
}

/**
 * Unwraps any wrap.near held in user's subaccount into pure native NEAR.
 */
export async function unwrapUserWrapNear(telegramId: number): Promise<{ success: boolean; unwrappedAmount: string }> {
  const user = await getUserByTelegramId(telegramId);
  if (!user) {
    throw new Error('User not found. Run /start first.');
  }

  const subaccountId = user.subaccount_id;
  const wrapBal = await near.view<string>('wrap.near', 'ft_balance_of', { account_id: subaccountId }).catch(() => '0');
  if (!wrapBal || wrapBal === '0') {
    return { success: true, unwrappedAmount: '0' };
  }

  const privateKey = decrypt(user.scoped_key_encrypted, MASTER_KEY);
  const keyPair = KeyPair.fromString(privateKey as any);
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey('mainnet', subaccountId, keyPair);

  const nearConn = await connect({
    networkId: 'mainnet',
    keyStore,
    nodeUrl: RPC_URLS[0] || 'https://rpc.mainnet.fastnear.com',
  });
  const account = await nearConn.account(subaccountId);

  await account.functionCall({
    contractId: 'wrap.near',
    methodName: 'near_withdraw',
    args: { amount: wrapBal },
    gas: BigInt('30000000000000'),
    attachedDeposit: BigInt('1'),
  });

  const formatted = (Number(BigInt(wrapBal) / 1000000000000000000n) / 1e6).toFixed(4);
  return { success: true, unwrappedAmount: formatted };
}

/**
 * Withdraw native NEAR from user's subaccount to an external address.
 * Automatically unwraps any wrap.near before sending, and ensures 0.05 NEAR
 * remains to cover account storage and gas.
 */
export async function withdrawFunds(
  telegramId: number,
  destination: string,
  amountNear?: number | 'all'
): Promise<{ txHash: string; amountWithdrawn: string; destination: string }> {
  const user = await getUserByTelegramId(telegramId);
  if (!user) {
    throw new Error('User not found. Run /start first.');
  }

  const subaccountId = user.subaccount_id;
  destination = destination.trim();
  if (!destination || destination === subaccountId) {
    throw new Error('Invalid destination account address.');
  }

  // Auto-unwrap any wrap.near first
  await unwrapUserWrapNear(telegramId).catch(() => {});

  const currentBalanceYocto = BigInt(await near.getNearBalance(subaccountId));
  const reserveYocto = BigInt('50000000000000000000000'); // 0.05 NEAR reserved

  if (currentBalanceYocto <= reserveYocto) {
    throw new Error('Insufficient balance to withdraw. A minimum of 0.05 NEAR must remain to cover on-chain account storage.');
  }

  const maxWithdrawableYocto = currentBalanceYocto - reserveYocto;

  let withdrawYocto: bigint;
  if (!amountNear || amountNear === 'all') {
    withdrawYocto = maxWithdrawableYocto;
  } else {
    withdrawYocto = BigInt(Math.floor(amountNear * 1e6)) * 1000000000000000000n;
    if (withdrawYocto > maxWithdrawableYocto) {
      const maxFormatted = (Number(maxWithdrawableYocto / 1000000000000000000n) / 1e6).toFixed(4);
      throw new Error(`Amount exceeds maximum withdrawable balance (${maxFormatted} NEAR after storage reserve).`);
    }
  }

  if (withdrawYocto <= 0n) {
    throw new Error('Withdrawal amount must be greater than 0.');
  }

  const privateKey = decrypt(user.scoped_key_encrypted, MASTER_KEY);
  const keyPair = KeyPair.fromString(privateKey as any);
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey('mainnet', subaccountId, keyPair);

  const nearConn = await connect({
    networkId: 'mainnet',
    keyStore,
    nodeUrl: RPC_URLS[0] || 'https://rpc.mainnet.fastnear.com',
  });
  const account = await nearConn.account(subaccountId);

  const res = await account.sendMoney(destination, withdrawYocto);
  const formattedWithdrawn = (Number(withdrawYocto / 1000000000000000000n) / 1e6).toFixed(4);

  return {
    txHash: res.transaction.hash,
    amountWithdrawn: formattedWithdrawn,
    destination,
  };
}

/**
 * Detects on-chain FT holdings for a user's wallet subaccount across indexers (FastNEAR & NearBlocks)
 * and RPC. Catches all tokens inside the wallet, creates or updates positions, and initializes the
 * entry price baseline for PNL calculation from the point of discovery.
 */
export async function syncUserTokenDeposits(userId: string, subaccountId: string): Promise<number> {
  const lastSync = lastSyncDepositsMap.get(userId);
  if (lastSync && Date.now() - lastSync < 10_000) {
    return 0;
  }
  lastSyncDepositsMap.set(userId, Date.now());

  let newDepositsCount = 0;
  try {
    const discoveredTokens = new Set<string>();
    const indexerBalances = new Map<string, string>();

    // 1. Fetch FT holdings across FastNEAR and NearBlocks in parallel
    const fastnearPromise = (async () => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3500);
        const apiKey = (process.env.FASTNEAR_API_KEY || '').trim();
        const url = `https://api.fastnear.com/v1/account/${subaccountId}/ft${apiKey ? `?api_key=${apiKey}` : ''}`;
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
        if (res.ok) {
          const data = (await res.json()) as any;
          if (Array.isArray(data.tokens)) {
            for (const t of data.tokens) {
              const cid = t?.contract_id || t;
              if (typeof cid === 'string' && cid) {
                discoveredTokens.add(cid);
                if (t.balance) indexerBalances.set(cid, t.balance.toString());
              }
            }
          } else if (Array.isArray(data.contract_ids)) {
            for (const cid of data.contract_ids) {
              if (typeof cid === 'string' && cid) discoveredTokens.add(cid);
            }
          }
        }
      } catch {
        // FastNEAR timeout/network error — fallback continues gracefully
      }
    })();

    const nearblocksPromise = (async () => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3500);
        const res = await fetch(`https://api.nearblocks.io/v1/account/${subaccountId}/inventory`, {
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (res.ok) {
          const data = (await res.json()) as any;
          const fts = data?.inventory?.fts;
          if (Array.isArray(fts)) {
            for (const item of fts) {
              const cid = item?.contract;
              if (typeof cid === 'string' && cid) {
                discoveredTokens.add(cid);
                if (item.amount) indexerBalances.set(cid, item.amount.toString());
              }
            }
          }
        }
      } catch {
        // NearBlocks fallback continues gracefully
      }
    })();

    // 2. Fetch existing open positions in DB
    const [existingPositions] = await Promise.all([
      getOpenPositions(userId).catch(() => []),
      Promise.allSettled([fastnearPromise, nearblocksPromise]),
    ]);

    const posMap = new Map(existingPositions.map(p => [p.token_address, p]));
    for (const p of existingPositions) {
      discoveredTokens.add(p.token_address);
    }

    // Exclude wrap.near (wNEAR is trading collateral, not a meme/speculative token) and 'near'
    discoveredTokens.delete('wrap.near');
    discoveredTokens.delete('near');

    const allTokensToCheck = Array.from(discoveredTokens);
    if (allTokensToCheck.length === 0) {
      return 0;
    }

    const near = getNear();

    // 3. Fetch token balances and metadata in parallel
    const [balanceResults, infoResults] = await Promise.all([
      Promise.allSettled(
        allTokensToCheck.map(async (tokenAddress) => {
          try {
            return await Promise.race([
              near.getTokenBalance(tokenAddress, subaccountId),
              new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2500)),
            ]);
          } catch {
            return indexerBalances.get(tokenAddress) || '0';
          }
        })
      ),
      Promise.allSettled(
        allTokensToCheck.map(tokenAddress => getTokenInfo(tokenAddress, false).catch(() => null))
      ),
    ]);

    for (let i = 0; i < allTokensToCheck.length; i++) {
      const tokenAddress = allTokensToCheck[i];
      const balRes = balanceResults[i];
      const rawBal = balRes.status === 'fulfilled' ? balRes.value : (indexerBalances.get(tokenAddress) || '0');
      const infoRes = infoResults[i];
      const info = infoRes.status === 'fulfilled' ? infoRes.value : null;

      const decimals = info?.decimals ?? 18;
      const cleanRaw = String(rawBal || '0').replace(/["'\s]/g, '').split('.')[0] || '0';
      let rawBalBigInt = 0n;
      try {
        rawBalBigInt = BigInt(cleanRaw);
      } catch {
        rawBalBigInt = 0n;
      }
      const humanBalance = Number(rawBalBigInt) / Math.pow(10, decimals);
      const isDustOrZero = rawBalBigInt === 0n || humanBalance < 0.000001;

      const existing = posMap.get(tokenAddress);
      const currentPrice = info?.price && parseFloat(info.price) > 0 ? parseFloat(info.price) : 0;

      if (existing) {
        if (isDustOrZero) {
          // User sold or no longer holds the token — close the position
          await updatePosition({
            position_id: existing.id,
            status: 'closed',
            closed_at: new Date(),
          });
          console.log(`[DEPOSIT] Closed phantom/sold position for ${tokenAddress} (user ${userId})`);
        } else {
          const updates: any = { position_id: existing.id };
          let hasUpdates = false;

          if (existing.quantity_held !== rawBal) {
            updates.quantity_held = rawBal;
            hasUpdates = true;
          }

          // If entry price wasn't established yet, baseline it now that price is available
          if ((!existing.avg_entry_price || parseFloat(existing.avg_entry_price) <= 0) && currentPrice > 0) {
            updates.avg_entry_price = currentPrice.toString();
            hasUpdates = true;
          }

          if (hasUpdates) {
            await updatePosition(updates);
          }
        }
      } else if (!isDustOrZero) {
        // Token detected in wallet!
        // Start calculating PNL at this discovery point: lock current market price as baseline entry price
        const entryPrice = currentPrice > 0 ? currentPrice.toString() : '0';

        const newPos = await createPosition({
          user_id: userId,
          token_address: tokenAddress,
          quantity_held: rawBal,
          avg_entry_price: entryPrice,
        });

        // Mark this position as an external deposit
        const db = await getDb();
        await db.query(
          'UPDATE positions SET is_external_deposit = TRUE, external_deposit_detected_at = NOW() WHERE id = $1',
          [newPos.id]
        );

        newDepositsCount++;
        console.log(`[DEPOSIT] Tracked new external deposit for user ${userId}: ${tokenAddress}, balance=${humanBalance.toFixed(4)}, entryPrice=${entryPrice}`);
      }
    }
  } catch (err: any) {
    console.warn(`[DEPOSIT] syncUserTokenDeposits error: ${err.message}`);
  }
  return newDepositsCount;
}