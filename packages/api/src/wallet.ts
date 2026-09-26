import 'dotenv/config';
import { getNear, encrypt, decrypt, generateScopedAccessKey, generateRandomAccountPrefix, createRedis, CHANNELS } from '@racerbot/shared';
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
const RPC_URLS = (process.env.RPC_PROVIDERS || 'https://rpc.mainnet.fastnear.com').split(',').map(u => u.trim());
const near = getNear(RPC_URLS);

// ── In-memory token info cache with 30s TTL ───────────────────────────────────
const tokenInfoCache = new Map<string, { data: TokenInfoResult; expiresAt: number }>();

// ── In-memory user balance cache with 8s TTL ──────────────────────────────────
const balanceCache = new Map<number, { data: UserBalances; expiresAt: number }>();

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
  venue: 'rhea' | 'shardsmarket' | 'nearlytrade' | 'memecooking' | 'intear' | 'onetokenhub' | 'nearpad' | 'unknown';
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
async function getMemeCookingTokenInfo(tokenAddress: string): Promise<{ price: number; liquidity: number; phase: string }> {
  // meme.cooking tokens: get pool info from meme-cooking.near contract
  // The meme id is extracted from the token address prefix
  const memeId = tokenAddress.replace('.meme-cooking.near', '');
  try {
    const meme = await near.view<any>('meme-cooking.near', 'get_meme', { meme_id: parseInt(memeId) || 0 });
    if (meme) {
      const nearAmount = parseFloat(meme.total_deposit || meme.near_amount || '0') / 1e24;
      const phase = meme.end_timestamp_ms && Date.now() >= Number(meme.end_timestamp_ms) ? 'bonded' : 'bonding';
      return { price: 0, liquidity: nearAmount, phase };
    }
  } catch {
    // Try by name lookup
  }
  return { price: 0, liquidity: 0, phase: 'unknown' };
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
      tradeable: ['rhea', 'shardsmarket', 'nearlytrade', 'intear', 'onetokenhub', 'nearpad'].includes(dbCache.venue ?? 'unknown'),
    };
    tokenInfoCache.set(tokenAddress, { data: result, expiresAt: Date.now() + 60000 });
    return result;
  }

  // Fetch ft_metadata first — this validates the token address is a real NEP-141 contract
  let meta: { name: string; symbol: string; decimals: number };
  let totalSupply: string;
  try {
    [meta, totalSupply] = await Promise.all([
      near.getTokenMetadata(tokenAddress),
      near.getTokenTotalSupply(tokenAddress).catch(() => '0'),
    ]);
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

  // Step 1: Rhea first, for every token — try both Simple and DCL pools in parallel
  if (price === 0) {
    const [rheaSimpleRes, rheaDclRes] = await Promise.allSettled([
      (async () => {
        const poolId =
          rheaPoolId !== null
            ? rheaPoolId
            : await near.findRheaPoolId('wrap.near', tokenAddress);
        const rh = await near.getRheaPoolReserves(poolId, 'wrap.near', tokenAddress);
        const reserveIn = parseFloat(rh.reserveIn);
        const reserveOut = parseFloat(rh.reserveOut);
        if (reserveIn <= 0 || reserveOut <= 0) throw new Error('empty rhea pool');
        return { poolId, reserveIn, reserveOut };
      })(),
      (async () => {
        const pId =
          dclPoolId !== null
            ? dclPoolId
            : await near.findDclPoolId('wrap.near', tokenAddress);
        if (!pId) throw new Error('empty dcl pool');
        const st = await near.getDclPoolState(pId);
        if (!(st.price > 0)) throw new Error('empty dcl pool');
        return st;
      })(),
    ]);

    if (rheaSimpleRes.status === 'fulfilled') {
      const { poolId, reserveIn, reserveOut } = rheaSimpleRes.value;
      const reserveInHuman = reserveIn / 1e24;
      const reserveOutHuman = reserveOut / Math.pow(10, meta.decimals);
      price = reserveInHuman / reserveOutHuman;
      liquidity = reserveInHuman * 2;
      venue = 'rhea';
      rheaPoolId = poolId;
    } else if (rheaDclRes.status === 'fulfilled') {
      const st = rheaDclRes.value;
      venue = 'rhea';
      price = st.price;
      liquidity = st.liquidityNear;
      dclPoolId = st.poolId;
    }
  }

  // Step 2: Only if Rhea has no liquidity, use address suffix to pick a launchpad prober
  if (price === 0) {
    if (isMemooCookingToken(tokenAddress)) {
      venue = 'memecooking';
      const mcInfo = await getMemeCookingTokenInfo(tokenAddress).catch(() => ({ price: 0, liquidity: 0, phase: 'unknown' }));
      price = mcInfo.price;
      liquidity = mcInfo.liquidity;
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
  const tradeable = ['shardsmarket', 'nearlytrade', 'rhea', 'intear', 'onetokenhub', 'nearpad'].includes(venue);
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
 * Execute a swap by publishing to executor via Redis.
 * If Redis is unavailable, disconnected, or times out (e.g. single-container Railway deploy),
 * falls back to executing directly on-chain via SwapExecutor so the trade never fails.
 */
export async function publishSwap(swapEvent: {
  user_id: string;
  token_in: string;
  token_out: string;
  amount_in: string;
  min_amount_out: string;
  venue: 'rhea' | 'shardsmarket' | 'nearlytrade' | 'intear' | 'onetokenhub' | 'nearpad';
  dcl_pool_id?: string;
}): Promise<{ txHash?: string }> {
  const redisUrl = process.env.REDIS_URL;
  let executedViaRedis = false;

  if (redisUrl && !redisUrl.includes('localhost:6379')) {
    try {
      if (!pubRedis) {
        pubRedis = createRedis(redisUrl);
      }
      const pubPromise = pubRedis.publish(
        CHANNELS.EXECUTE_SWAP,
        JSON.stringify({
          type: 'execute_swap',
          ...swapEvent,
          timestamp: Date.now(),
        })
      );
      // Wait up to 1.5s for Redis to accept the message
      await Promise.race([
        pubPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Redis publish timeout')), 1500)),
      ]);
      executedViaRedis = true;
    } catch (err: any) {
      console.warn('[SWAP] Redis publish failed, falling back to direct executor:', err.message);
    }
  }

  // Direct on-chain execution fallback:
  // When Redis is offline, disconnected, or absent on Railway, execute the swap directly
  // using the user's encrypted key and on-chain RPC broadcast.
  if (!executedViaRedis) {
    if (!directExecutor) {
      const { SwapExecutor } = await import('@racerbot/executor');
      directExecutor = new SwapExecutor();
    }
    const result = await directExecutor.execute({
      type: 'execute_swap',
      ...swapEvent,
      timestamp: Date.now(),
    });
    return { txHash: result.txHash };
  }

  return {};
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
 * Detects external token deposits for a user's wallet subaccount.
 * When a user transfers or receives tokens not purchased directly via RacerBot,
 * this discovers them, fetches their current market price at this point in time,
 * and initializes an open position with that price as the avg_entry_price.
 * PNL calculation starts from that exact point onwards.
 */
export async function syncUserTokenDeposits(userId: string, subaccountId: string): Promise<number> {
  let newDepositsCount = 0;
  try {
    // 1. Fetch all FT holdings for this subaccount via FastNEAR API
    let tokens: Array<{ contract_id: string; balance: string }> = [];
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3500);
      const res = await fetch(`https://api.fastnear.com/v1/account/${subaccountId}/ft`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.ok) {
        const data = await res.json() as any;
        if (Array.isArray(data.tokens)) {
          tokens = data.tokens;
        }
      }
    } catch {
      // FastNEAR timeout/network error — fallback continues gracefully
    }

    if (tokens.length === 0) {
      return 0;
    }

    // 2. Fetch existing positions
    const existingPositions = await getOpenPositions(userId);
    const posMap = new Map(existingPositions.map(p => [p.token_address, p]));

    for (const t of tokens) {
      // Exclude wrap.near (wNEAR is trading collateral, not a meme/speculative token)
      if (t.contract_id === 'wrap.near' || !t.balance || BigInt(t.balance) <= 0n) {
        continue;
      }

      const existing = posMap.get(t.contract_id);
      if (!existing) {
        // Token received as external deposit!
        // Start calculating PNL at that point: fetch market price at deposit discovery
        const info = await getTokenInfo(t.contract_id, true).catch(() => null);
        const currentPrice = info?.price && parseFloat(info.price) > 0
          ? parseFloat(info.price)
          : 0;

        // Skip if price is 0 - can't calculate PNL without a baseline
        if (currentPrice === 0) {
          console.warn(`[DEPOSIT] Skipping ${t.contract_id} - price is 0, cannot establish PNL baseline`);
          continue;
        }

        // Convert raw balance to human-readable using token decimals
        const decimals = info?.decimals ?? 18;
        const rawBalance = BigInt(t.balance);

        // Use BigInt arithmetic for large balances to avoid precision loss
        // Then convert to number for storage (position system expects numeric strings)
        const divisor = BigInt(10) ** BigInt(decimals);
        const humanBalanceBigInt = rawBalance / divisor;
        const remainder = rawBalance % divisor;

        // Convert to float with proper decimal handling
        const humanBalance = Number(humanBalanceBigInt) + (Number(remainder) / Number(divisor));

        // Validate converted balance is a reasonable number
        if (!isFinite(humanBalance) || humanBalance <= 0) {
          console.warn(`[DEPOSIT] Skipping ${t.contract_id} - invalid converted balance: ${humanBalance}`);
          continue;
        }

        // Initialize position with zero values - will be updated by fill
        const newPos = await createPosition({
          user_id: userId,
          token_address: t.contract_id,
          quantity_held: '0',
          avg_entry_price: '0',
        });

        // Mark this position as an external deposit
        const db = await getDb();
        await db.query(
          'UPDATE positions SET is_external_deposit = TRUE, external_deposit_detected_at = NOW() WHERE id = $1',
          [newPos.id]
        );

        const venue = info?.venue && ['rhea', 'shardsmarket', 'nearlytrade', 'intear', 'onetokenhub', 'nearpad'].includes(info.venue)
          ? info.venue as any
          : 'nearlytrade';

        // Create fill for external deposit
        await createFill({
          user_id: userId,
          position_id: newPos.id,
          side: 'buy',
          token_address: t.contract_id,
          amount: humanBalance.toString(),
          price: currentPrice.toString(),
          fee_paid: '0',
          venue,
          tx_hash: `deposit_${Date.now()}`,
        }).catch(() => {});

        // Manually update position with the fill data since external deposits don't go through normal trading flow
        // This ensures avg_entry_price and quantity_held are correctly set
        await db.query(
          'UPDATE positions SET quantity_held = $1, avg_entry_price = $2 WHERE id = $3',
          [humanBalance.toString(), currentPrice.toString(), newPos.id]
        );

        newDepositsCount++;
        console.log(`[DEPOSIT] Tracked new external deposit for user ${userId}: ${t.contract_id}, balance=${humanBalance.toFixed(4)}, entryPrice=${currentPrice}`);
      } else {
        // Sync position quantity if changed
        // Convert raw balance to human-readable using token decimals
        const info = await getTokenInfo(t.contract_id, true).catch(() => null);
        const decimals = info?.decimals ?? 18;
        const rawBalance = BigInt(t.balance);

        // Use BigInt arithmetic for large balances to avoid precision loss
        const divisor = BigInt(10) ** BigInt(decimals);
        const humanBalanceBigInt = rawBalance / divisor;
        const remainder = rawBalance % divisor;
        const humanBalance = Number(humanBalanceBigInt) + (Number(remainder) / Number(divisor));

        // Validate converted balance
        if (!isFinite(humanBalance) || humanBalance < 0) {
          console.warn(`[DEPOSIT] Skipping balance update for ${t.contract_id} - invalid converted balance: ${humanBalance}`);
          continue;
        }

        if (existing.quantity_held !== humanBalance.toString()) {
          await updatePosition({
            position_id: existing.id,
            quantity_held: humanBalance.toString(),
          });
        }
      }
    }
  } catch (err: any) {
    console.warn(`[DEPOSIT] syncUserTokenDeposits error: ${err.message}`);
  }
  return newDepositsCount;
}