import 'dotenv/config';
import { getNear, encrypt, decrypt, generateScopedAccessKey, generateRandomAccountPrefix } from '@racerbot/shared';
import {
  getDb,
  createUser,
  getUserByTelegramId,
  updateUserScopedKey,
  getTokenCache,
  upsertTokenCache,
} from '@racerbot/db';
import { utils as nearUtils, keyStores, KeyPair, connect } from 'near-api-js';
import { MAIN_WALLET_PRIVATE_KEY, RACERBOT_PARENT_ACCOUNT } from './config.js';

const MASTER_KEY = process.env.KEY_ENCRYPTION_MASTER_KEY!;
const RPC_URLS = (process.env.RPC_PROVIDERS || 'https://rpc.mainnet.fastnear.com').split(',').map(u => u.trim());
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
  venue: 'rhea' | 'shardsmarket' | 'nearlytrade' | 'unknown';
  rhea_pool_id?: number | null;
  bonding_phase?: 'prebonded' | 'bonded' | null;
  bonding_progress_pct?: number | null;
  dcl_pool_id?: string | null;
}

/**
 * Get token info with 5s in-memory TTL cache.
 * Fetches ft_metadata + pool reserves from Shardsmarket, Rhea, or NearlyTrade.
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
      total_supply: dbCache.total_supply ?? '0',
      price: dbCache.last_price?.toString() ?? '0',
      liquidity: dbCache.last_liquidity?.toString() ?? '0',
      market_cap: 0,
      venue: (dbCache.venue as any) ?? 'unknown',
      rhea_pool_id: dbCache.rhea_pool_id,
      bonding_phase: (dbCache.bonding_phase as any) ?? null,
      bonding_progress_pct:
        dbCache.bonding_progress_pct !== null && dbCache.bonding_progress_pct !== undefined
          ? Number(dbCache.bonding_progress_pct)
          : null,
      dcl_pool_id: dbCache.dcl_pool_id ?? null,
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
  let venue: 'rhea' | 'shardsmarket' | 'nearlytrade' | 'unknown' = 'unknown';
  let rheaPoolId: number | null = dbCache?.rhea_pool_id ?? null;
  let bondingPhase: 'prebonded' | 'bonded' | null = (dbCache?.bonding_phase as any) ?? null;
  let bondingProgressPct: number | null =
    dbCache?.bonding_progress_pct !== null && dbCache?.bonding_progress_pct !== undefined
      ? Number(dbCache.bonding_progress_pct)
      : null;
  let dclPoolId: string | null = dbCache?.dcl_pool_id ?? null;

  // 1. Try Shardsmarket first (most NEAR launchpad tokens)
  try {
    const sm = await near.getShardsmarketPoolReserves(tokenAddress);
    const reserveNear = parseFloat(sm.reserveNear);
    const reserveToken = parseFloat(sm.reserveToken);
    if (reserveNear > 0 && reserveToken > 0) {
      price = reserveNear / reserveToken;
      liquidity = reserveNear / 1e24; // convert yoctoNEAR to NEAR
      venue = 'shardsmarket';
    }
  } catch {
    /* try Rhea or Nearlytrade */
  }

  // 2. Fallback to Rhea
  if (venue === 'unknown') {
    try {
      if (rheaPoolId === null) {
        rheaPoolId = await near.findRheaPoolId('wrap.near', tokenAddress).catch(() => null);
      }
      if (rheaPoolId !== null) {
        const rh = await near.getRheaPoolReserves(rheaPoolId, 'wrap.near', tokenAddress);
        const reserveIn = parseFloat(rh.reserveIn);
        const reserveOut = parseFloat(rh.reserveOut);
        if (reserveIn > 0 && reserveOut > 0) {
          price = reserveIn / reserveOut;
          liquidity = reserveIn / 1e24;
          venue = 'rhea';
        }
      }
    } catch {
      /* try Nearlytrade */
    }
  }

  // 3. Fallback to NearlyTrade
  if (venue === 'unknown') {
    try {
      const ntState = await near.getNearlytradeTokenState(tokenAddress);
      if (ntState) {
        venue = 'nearlytrade';
        price = ntState.price;
        liquidity = ntState.liquidityNear;
        bondingPhase = ntState.phase;
        bondingProgressPct = ntState.bondingProgressPct;
        dclPoolId = ntState.dclPoolId;
      }
    } catch {
      /* no pool found */
    }
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
    rhea_pool_id: rheaPoolId,
    bonding_phase: bondingPhase,
    bonding_progress_pct: bondingProgressPct,
    dcl_pool_id: dclPoolId,
  };

  tokenInfoCache.set(tokenAddress, { data: result, expiresAt: Date.now() + 5000 });

  // Async DB update (non-blocking)
  setImmediate(() =>
    upsertTokenCache({
      token_address: tokenAddress,
      name: meta.name,
      symbol: meta.symbol,
      decimals: meta.decimals,
      total_supply: totalSupply,
      pool_address: tokenAddress,
      venue,
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
 */
export async function onboardUser(telegramId: number): Promise<OnboardResult> {
  // Step 5: Check for existing user row (idempotency)
  const existing = await getUserByTelegramId(telegramId).catch(() => null);
  if (existing) {
    return {
      userId: existing.id,
      subaccountId: existing.subaccount_id,
      isExisting: true,
    };
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
  venue: 'rhea' | 'shardsmarket' | 'nearlytrade';
  dcl_pool_id?: string;
}): Promise<void> {
  const { createRedis, CHANNELS } = await import('@racerbot/shared');
  if (!pubRedis) {
    pubRedis = createRedis(process.env.REDIS_URL!);
  }
  await pubRedis.publish(
    CHANNELS.EXECUTE_SWAP,
    JSON.stringify({
      type: 'execute_swap',
      ...swapEvent,
      timestamp: Date.now(),
    })
  );
}

export interface UserBalances {
  subaccountId: string;
  nativeNearYocto: string;
  nativeNearFormatted: string;
  wrapNearYocto: string;
  wrapNearFormatted: string;
  totalNearFormatted: string;
}

/**
 * Fetch native NEAR and wrap.near balances for user's subaccount.
 */
export async function getUserBalances(telegramId: number): Promise<UserBalances> {
  const user = await getUserByTelegramId(telegramId);
  if (!user) {
    throw new Error('User not found. Run /start first.');
  }

  const subaccountId = user.subaccount_id;
  let nativeNearYocto = '0';
  let wrapNearYocto = '0';

  try {
    nativeNearYocto = await near.getNearBalance(subaccountId);
  } catch (err: any) {
    console.warn(`[API] Failed to fetch native balance for ${subaccountId}:`, err.message);
  }

  try {
    const wrapBal = await near.view<string>('wrap.near', 'ft_balance_of', { account_id: subaccountId });
    wrapNearYocto = wrapBal || '0';
  } catch {}

  const nativeNear = Number(BigInt(nativeNearYocto) / 1000000000000000000n) / 1e6;
  const wrapNear = Number(BigInt(wrapNearYocto) / 1000000000000000000n) / 1e6;
  const totalNear = nativeNear + wrapNear;

  return {
    subaccountId,
    nativeNearYocto,
    nativeNearFormatted: nativeNear.toFixed(4),
    wrapNearYocto,
    wrapNearFormatted: wrapNear.toFixed(4),
    totalNearFormatted: totalNear.toFixed(4),
  };
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