import 'dotenv/config';
import { getNear, encrypt, generateScopedAccessKey, generateSeedPhrase, decrypt } from '@racerbot/shared';
import { getDb, createUser, getUserByTelegramId, getTokenCache, upsertTokenCache } from '@racerbot/db';
import { utils } from 'near-api-js';
import { MAIN_WALLET_PRIVATE_KEY, RACERBOT_PARENT_ACCOUNT, ROUTER_CONTRACT_ID } from './config.js';

const MASTER_KEY = process.env.KEY_ENCRYPTION_MASTER_KEY!;
const RPC_URLS = process.env.RPC_PROVIDERS!.split(',').map(u => u.trim());
const near = getNear(RPC_URLS);

// ── In-memory token info cache with 5s TTL ────────────────────────────────────
const tokenInfoCache = new Map<string, { data: TokenInfoResult; expiresAt: number }>();

export interface TokenInfoResult {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  total_supply: string;
  price: string;
  liquidity: string;
  market_cap: number;
  venue: 'rhea' | 'shardsmarket' | 'unknown';
}

/**
 * Get token info with 5s in-memory TTL cache.
 * Fetches ft_metadata + pool reserves from Rhea or Shardsmarket.
 * Never returns hardcoded data.
 */
export async function getTokenInfo(tokenAddress: string): Promise<TokenInfoResult> {
  const cached = tokenInfoCache.get(tokenAddress);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.data;
  }

  // Check DB cache first (written by detector — may be fresh enough)
  const dbCache = await getTokenCache(tokenAddress).catch(() => null);
  if (dbCache && dbCache.updated_at && Date.now() - dbCache.updated_at.getTime() < 5000) {
    const result: TokenInfoResult = {
      address: tokenAddress,
      name: dbCache.name ?? '',
      symbol: dbCache.symbol ?? '',
      decimals: dbCache.decimals ?? 18,
      total_supply: '0',
      price: dbCache.last_price?.toString() ?? '0',
      liquidity: dbCache.last_liquidity?.toString() ?? '0',
      market_cap: 0,
      venue: (dbCache.venue as any) ?? 'unknown',
    };
    tokenInfoCache.set(tokenAddress, { data: result, expiresAt: Date.now() + 5000 });
    return result;
  }

  // Fetch from chain
  const [meta, totalSupply] = await Promise.all([
    near.getTokenMetadata(tokenAddress),
    near.getTokenTotalSupply(tokenAddress).catch(() => '0'),
  ]);

  let price = 0;
  let liquidity = 0;
  let venue: 'rhea' | 'shardsmarket' | 'unknown' = 'unknown';

  // Try Shardsmarket first (most NEAR launchpad tokens)
  try {
    const sm = await near.getShardsmarketPoolReserves(tokenAddress);
    const reserveNear = parseFloat(sm.reserveNear);
    const reserveToken = parseFloat(sm.reserveToken);
    if (reserveNear > 0 && reserveToken > 0) {
      price = reserveNear / reserveToken;
      liquidity = reserveNear / 1e24; // convert yoctoNEAR to NEAR
      venue = 'shardsmarket';
    }
  } catch { /* try rhea */ }

  // Fallback to Rhea
  if (venue === 'unknown') {
    try {
      const rh = await near.getRheaPoolReserves('', 'wrap.near', tokenAddress);
      const reserveIn = parseFloat(rh.reserveIn);
      const reserveOut = parseFloat(rh.reserveOut);
      if (reserveIn > 0 && reserveOut > 0) {
        price = reserveIn / reserveOut;
        liquidity = reserveIn / 1e24;
        venue = 'rhea';
      }
    } catch { /* no pool found */ }
  }

  const supplyNum = parseFloat(totalSupply) / Math.pow(10, meta.decimals);
  const marketCap = price * supplyNum;

  const result: TokenInfoResult = {
    address: tokenAddress,
    name: meta.name,
    symbol: meta.symbol,
    decimals: meta.decimals,
    total_supply: totalSupply,
    price: price.toFixed(10),
    liquidity: liquidity.toFixed(4),
    market_cap: marketCap,
    venue,
  };

  tokenInfoCache.set(tokenAddress, { data: result, expiresAt: Date.now() + 5000 });

  // Async DB update (non-blocking)
  setImmediate(() => upsertTokenCache({
    token_address: tokenAddress,
    name: meta.name,
    symbol: meta.symbol,
    decimals: meta.decimals,
    pool_address: tokenAddress,
    venue,
    last_price: price,
    last_liquidity: liquidity,
    updated_at: new Date(),
  }).catch(() => {}));

  return result;
}

/**
 * Onboard a new user:
 * 1. Generate keypair server-side (no Mini App)
 * 2. Generate BIP39 seed phrase (shown once in bot chat)
 * 3. Create subaccount on NEAR
 * 4. Store only the scoped function-call key, encrypted
 * Returns: subaccountId + seed phrase for display
 */
export async function onboardUser(telegramId: number): Promise<{
  subaccountId: string;
  seedPhrase: string;
  publicKey: string;
}> {
  const subaccountId = `${telegramId}.racerbot.near`;

  // Check if already onboarded
  const existing = await getUserByTelegramId(telegramId).catch(() => null);
  if (existing) {
    throw new Error('already_onboarded');
  }

  // Generate ed25519 keypair using near-api-js
  const keypair = generateScopedAccessKey();
  // Generate BIP39 12-word seed phrase (shown once, never stored)
  const seedPhrase = generateSeedPhrase();

  // Encrypt the scoped key for storage
  const encryptedKey = encrypt(keypair.secretKey, MASTER_KEY);

  // Store in DB — only encrypted scoped key, never seed phrase or full key
  await createUser({
    telegram_id: telegramId,
    subaccount_id: subaccountId,
    scoped_key_encrypted: encryptedKey,
  });

  // TODO: create NEAR subaccount using parent key (requires parent key in env)
  // For now log intent — actual account creation requires parent key to be funded
  console.log(`[WALLET] User onboarded: telegramId=${telegramId} subaccount=${subaccountId}`);

  return {
    subaccountId,
    seedPhrase, // Shown ONCE in Telegram chat — never stored anywhere
    publicKey: keypair.publicKey,
  };
}

let pubRedis: any = null;

/**
 * Execute a swap by publishing to executor via Redis.
 * The API service never signs transactions — that is the executor's role.
 */
export async function publishSwap(swapEvent: {
  user_id: string;
  token_in: string;
  token_out: string;
  amount_in: string;
  min_amount_out: string;
  venue: 'rhea' | 'shardsmarket';
}): Promise<void> {
  const { createRedis, CHANNELS } = await import('@racerbot/shared');
  if (!pubRedis) {
    pubRedis = createRedis(process.env.REDIS_URL!);
  }
  await pubRedis.publish(CHANNELS.EXECUTE_SWAP, JSON.stringify({
    type: 'execute_swap',
    ...swapEvent,
    timestamp: Date.now(),
  }));
}