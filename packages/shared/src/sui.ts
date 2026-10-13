import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Transaction } from '@mysten/sui/transactions';
import { Aftermath } from 'aftermath-ts-sdk';
import bs58 from 'bs58';
import { encrypt, decrypt } from './crypto.js';
import { withTimeout } from './utils.js';

// ── Sui Constants ────────────────────────────────────────────────────────────

export const SUI_DECIMALS = 9;
export const MIST_PER_SUI = 1_000_000_000n;
export const SUI_CLOCK_OBJECT_ID = '0x0000000000000000000000000000000000000000000000000000000000000006';

// SuiPump V17 Lineage Package IDs
export const SUIPUMP_IDENTITY_PACKAGE_ID = '0xb205fea41ccedac051bc66498e6ca68cb802c4a6ea06da12e524bed09c80d9b0';
export const SUIPUMP_LATEST_PACKAGE_ID = '0x70a9b28a28c028e5ab9ed9fefec26f1fc43918bc094d60527b8968fb4f5ab0b5'; // v5 MoveCall target
export const SUIPUMP_PACKAGE_ID = SUIPUMP_LATEST_PACKAGE_ID;

export const SUIPUMP_PRICE_CONFIG_OBJECT_ID = '0xaebff66fd224e4fefae2426b5cdb30c6e5c488dce5ec34a730246e8b91d44ff9';

// Default platform fee: 1.5% (150 basis points)
export const SUI_FEE_BPS = 150n;
export const SUI_BPS_DENOMINATOR = 10000n;

// Default Sui Treasury Address (can be overridden via env SUI_TREASURY_ADDRESS)
export const DEFAULT_SUI_TREASURY_ADDRESS = process.env.SUI_TREASURY_ADDRESS || '0xc6f4dffb87ba4d0ba749c929c5e805def45276f3b02cf156f24035d9ab2398cc';

// Public RPC Endpoints for fallback redundancy
const envRpcList = (process.env.SUI_RPC_PROVIDERS || process.env.SUI_RPC_URL || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const SUI_RPC_ENDPOINTS = [
  ...envRpcList,
  'https://sui-rpc.publicnode.com',
  'https://sui-mainnet.nodeinfra.com',
  'https://mainnet.sui.rpcpool.com',
  'https://sui-mainnet-endpoint.blockvision.org',
].filter(Boolean) as string[];

let activeRpcIndex = 0;
let suiClientInstance: SuiJsonRpcClient | null = null;

export function getSuiClient(): SuiJsonRpcClient {
  if (!suiClientInstance) {
    const url = SUI_RPC_ENDPOINTS[activeRpcIndex] || 'https://sui-rpc.publicnode.com';
    suiClientInstance = new SuiJsonRpcClient({ url, network: 'mainnet' });
  }
  return suiClientInstance;
}

export function rotateSuiRpc(): SuiJsonRpcClient {
  activeRpcIndex = (activeRpcIndex + 1) % SUI_RPC_ENDPOINTS.length;
  const nextUrl = SUI_RPC_ENDPOINTS[activeRpcIndex];
  console.log(`[SUI] Rotating RPC to ${nextUrl}`);
  suiClientInstance = new SuiJsonRpcClient({ url: nextUrl, network: 'mainnet' });
  return suiClientInstance;
}

// ── Key Management ──────────────────────────────────────────────────────────

export interface GeneratedSuiWallet {
  address: string;
  privateKeySecret: string; // Bech32 or raw secret
  encryptedPrivateKey: string;
}

/**
 * Generates a fresh Ed25519 Sui wallet and encrypts the secret key.
 */
export function generateSuiWallet(masterKey: string): GeneratedSuiWallet {
  const keypair = new Ed25519Keypair();
  const address = keypair.toSuiAddress();
  const privateKeySecret = keypair.getSecretKey();
  const encryptedPrivateKey = encrypt(privateKeySecret, masterKey);

  return {
    address,
    privateKeySecret,
    encryptedPrivateKey,
  };
}

/**
 * Restores an Ed25519Keypair from any valid Sui private key string format:
 * - Bech32 (e.g. suiprivkey1...)
 * - Hex (64 or 128 characters)
 * - Base64
 * - Base58
 */
export function restoreSuiKeypairFromSecret(rawSecret: string): Ed25519Keypair {
  const clean = rawSecret.trim();

  // 1. Sui standard Bech32 format
  if (clean.startsWith('suiprivkey')) {
    const { secretKey } = decodeSuiPrivateKey(clean);
    return Ed25519Keypair.fromSecretKey(secretKey);
  }

  // 2. Hex format (0x prefixed or raw hex, 32 or 64 bytes)
  const hexPart = clean.startsWith('0x') ? clean.slice(2) : clean;
  if (/^[0-9a-fA-F]{64}$/.test(hexPart) || /^[0-9a-fA-F]{128}$/.test(hexPart)) {
    const raw32 = Buffer.from(hexPart.slice(0, 64), 'hex');
    return Ed25519Keypair.fromSecretKey(raw32);
  }

  // 3. Base64 format
  try {
    const b64 = Buffer.from(clean, 'base64');
    if (b64.length === 32 || b64.length === 64) {
      return Ed25519Keypair.fromSecretKey(b64.subarray(0, 32));
    }
  } catch {}

  // 4. Base58 format
  try {
    const b58 = bs58.decode(clean);
    if (b58.length === 32 || b58.length === 64) {
      return Ed25519Keypair.fromSecretKey(b58.subarray(0, 32));
    }
  } catch {}

  // 5. Direct secret key string fallback
  try {
    return Ed25519Keypair.fromSecretKey(clean);
  } catch {}

  throw new Error('Invalid Sui private key format. Please provide a suiprivkey1... string, 32-byte hex, or base58 key.');
}

/**
 * Restores an Ed25519Keypair from an encrypted private key.
 */
export function restoreSuiKeypair(encryptedPrivateKey: string, masterKey: string): Ed25519Keypair {
  const decryptedSecret = decrypt(encryptedPrivateKey, masterKey);
  return restoreSuiKeypairFromSecret(decryptedSecret);
}

/**
 * Checks if a string is a valid Sui address (0x followed by 64 hex chars).
 */
export function isValidSuiAddress(address: string): boolean {
  if (!address || typeof address !== 'string') return false;
  const clean = address.trim().toLowerCase();
  return /^0x[0-9a-f]{1,64}$/.test(clean);
}

/**
 * Formats a Sui address to full 66-character 0x-prefixed hex.
 */
export function normalizeSuiAddress(address: string): string {
  const clean = address.trim().toLowerCase();
  if (!clean.startsWith('0x')) return '0x' + clean.padStart(64, '0');
  const hexPart = clean.slice(2);
  return '0x' + hexPart.padStart(64, '0');
}

// ── Short Token Key mapping to guarantee callback_data never exceeds Telegram's 64-byte limit ──
const shortTokenKeyMap = new Map<string, string>();
const tokenKeyToAddressMap = new Map<string, string>();

/**
 * Encodes a long token address into a compact token key (e.g. t_2cd41592f0dd) so
 * that Telegram inline button callback_data is always well below the 64-byte limit.
 */
export function getShortTokenKey(tokenAddress: string): string {
  if (!tokenAddress || typeof tokenAddress !== 'string') return '';
  const trimmed = tokenAddress.trim();
  if (trimmed.length <= 32) return trimmed;
  let short = shortTokenKeyMap.get(trimmed);
  if (!short) {
    // Generate simple deterministic 12-char hex hash
    let hash = 0;
    for (let i = 0; i < trimmed.length; i++) {
      hash = ((hash << 5) - hash) + trimmed.charCodeAt(i);
      hash |= 0;
    }
    const hex = Math.abs(hash).toString(16).padStart(8, '0') + trimmed.slice(-4);
    short = `t_${hex}`;
    shortTokenKeyMap.set(trimmed, short);
    tokenKeyToAddressMap.set(short, trimmed);
  }
  return short;
}

/**
 * Registers an association between a short token key and full address in memory.
 */
export function registerShortTokenKey(shortKey: string, fullAddress: string): void {
  if (shortKey && fullAddress) {
    shortTokenKeyMap.set(fullAddress.trim(), shortKey.trim());
    tokenKeyToAddressMap.set(shortKey.trim(), fullAddress.trim());
  }
}

/**
 * Resolves a short token key (t_...) or standard token address back into its full address.
 */
export function resolveTokenAddressFromKey(keyOrAddress: string): string {
  if (!keyOrAddress || typeof keyOrAddress !== 'string') return '';
  const trimmed = keyOrAddress.trim();
  return tokenKeyToAddressMap.get(trimmed) || trimmed;
}

// ── Balance & Metadata Queries ──────────────────────────────────────────────

export interface SuiBalanceResult {
  mist: bigint;
  sui: number;
  formatted: string;
}

const suiBalanceCache = new Map<string, { result: SuiBalanceResult; at: number }>();
const SUI_BAL_CACHE_TTL_MS = 3_000;

/**
 * Gets native SUI coin balance for an address.
 */
export async function getSuiBalance(address: string): Promise<SuiBalanceResult> {
  const normAddr = address.toLowerCase().trim();
  const cached = suiBalanceCache.get(normAddr);
  if (cached && Date.now() - cached.at < SUI_BAL_CACHE_TTL_MS) {
    return cached.result;
  }

  const client = getSuiClient();
  try {
    const res = await withTimeout(client.getBalance({ owner: address }), 3500, 'Sui getBalance timeout');
    const mist = BigInt(res.totalBalance || '0');
    const sui = Number(mist) / 1e9;
    const result: SuiBalanceResult = {
      mist,
      sui,
      formatted: sui.toFixed(4),
    };
    suiBalanceCache.set(normAddr, { result, at: Date.now() });
    return result;
  } catch (err: any) {
    // Retry once with rotated RPC on network failure
    try {
      const fallbackClient = rotateSuiRpc();
      const res = await withTimeout(fallbackClient.getBalance({ owner: address }), 3500, 'Sui fallback getBalance timeout');
      const mist = BigInt(res.totalBalance || '0');
      const sui = Number(mist) / 1e9;
      const result: SuiBalanceResult = { mist, sui, formatted: sui.toFixed(4) };
      suiBalanceCache.set(normAddr, { result, at: Date.now() });
      return result;
    } catch (e2: any) {
      throw new Error(`Failed to fetch Sui balance for ${address}: ${err.message}`);
    }
  }
}

export interface SuiTokenBalanceResult {
  raw: bigint;
  formatted: string;
  uiAmount: number;
  decimals: number;
  symbol: string;
  coinObjectIds: string[];
}

/**
 * Gets token balance and coin objects for a specific coin type.
 */
export async function getSuiTokenBalance(
  address: string,
  coinType: string
): Promise<SuiTokenBalanceResult> {
  const fetchBalance = async (client: SuiJsonRpcClient) => {
    const [coinsRes, meta] = await Promise.all([
      client.getCoins({ owner: address, coinType }),
      getSuiTokenMetadata(coinType),
    ]);

    const coinObjectIds = coinsRes.data.map((c) => c.coinObjectId);
    const raw = coinsRes.data.reduce((sum, c) => sum + BigInt(c.balance), 0n);
    const decimals = meta.decimals ?? 6;
    const divisor = Math.pow(10, decimals);
    const uiAmount = Number(raw) / divisor;

    return {
      raw,
      uiAmount,
      decimals,
      symbol: meta.symbol,
      formatted: uiAmount.toLocaleString('en-US', { maximumFractionDigits: 4 }),
      coinObjectIds,
    };
  };

  try {
    return await fetchBalance(getSuiClient());
  } catch (err: any) {
    try {
      const fallbackClient = rotateSuiRpc();
      return await fetchBalance(fallbackClient);
    } catch (e2: any) {
      throw new Error(`Failed to fetch Sui token balance for ${coinType}: ${err.message}`);
    }
  }
}

export interface SuiTokenMetadata {
  name: string;
  symbol: string;
  decimals: number;
  description: string;
  iconUrl?: string | null;
}

const tokenMetadataCache = new Map<string, { meta: SuiTokenMetadata; expiresAt: number }>();

/**
 * Fetches token metadata from on-chain CoinMetadata object.
 */
export async function getSuiTokenMetadata(coinType: string): Promise<SuiTokenMetadata> {
  const cached = tokenMetadataCache.get(coinType);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.meta;
  }

  const client = getSuiClient();
  try {
    const meta = await client.getCoinMetadata({ coinType });
    const result: SuiTokenMetadata = {
      name: meta?.name || coinType.split('::').pop() || 'Unknown',
      symbol: meta?.symbol || coinType.split('::').pop() || 'TOKEN',
      decimals: meta?.decimals ?? 9,
      description: meta?.description || '',
      iconUrl: meta?.iconUrl || null,
    };
    tokenMetadataCache.set(coinType, { meta: result, expiresAt: Date.now() + 300_000 }); // 5 min cache
    return result;
  } catch (err: any) {
    const fallback: SuiTokenMetadata = {
      name: coinType.split('::').pop() || 'Token',
      symbol: coinType.split('::').pop() || 'TKN',
      decimals: 9,
      description: '',
      iconUrl: null,
    };
    return fallback;
  }
}

/**
 * Attempts to fetch total on-chain supply for a Sui coin type.
 */
export async function getSuiTokenSupply(coinType: string): Promise<string | null> {
  const client = getSuiClient();
  try {
    const supply = await client.getTotalSupply({ coinType });
    if (supply?.value) {
      return supply.value;
    }
  } catch {
    // Non-fatal if historical treasury object is pruned or not accessible
  }
  return null;
}

// ── SuiPump Bonding Curve State & Pricing ───────────────────────────────────

export interface SuiPumpCurveState {
  curveId: string;
  tokenType: string;
  name: string;
  symbol: string;
  decimals: number;
  iconUrl?: string | null;
  packageId: string;
  reserveSuiMist: bigint;
  reserveSui: number;
  reserveTokensRaw: bigint;
  reserveTokens: number;
  lastPriceSui: number;
  marketCapSui: number;
  graduationThresholdSui: number;
  bondingProgressPct: number;
  graduated: boolean;
  poolId?: string | null;
  buys?: number;
  sells?: number;
  trades?: number;
}

/**
 * Fetches current SuiPump bonding curve state, pricing, and reserves.
 */
export async function getSuiPumpCurveState(curveIdOrTokenType: string): Promise<SuiPumpCurveState | null> {
  try {
    const res = await fetch('https://suipump-main-web.onrender.com/tokens', { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const tokens = (await res.json()) as any[];
    
    const query = curveIdOrTokenType.toLowerCase().trim();
    const token = tokens.find(
      (t) =>
        t.curveId?.toLowerCase() === query ||
        t.tokenType?.toLowerCase() === query ||
        t.symbol?.toLowerCase() === query ||
        t.name?.toLowerCase() === query ||
        (t.tokenType && t.tokenType.toLowerCase().startsWith(query))
    );

    if (!token) return null;

    const stats = token.stats || {};
    const reserveSui = parseFloat(stats.reserve_sui || '0');
    const gradThreshold = parseFloat(stats.grad_threshold_sui || '8324.01286926');
    const bondingProgressPct = gradThreshold > 0 ? Math.min(100, (reserveSui / gradThreshold) * 100) : 0;
    const lastPriceSui = parseFloat(stats.last_price || '0');
    const totalSupply = 1_000_000_000; // 1 Billion standard supply on SuiPump
    const marketCapSui = lastPriceSui * totalSupply;

    return {
      curveId: token.curveId,
      tokenType: token.tokenType,
      name: token.name,
      symbol: token.symbol,
      decimals: 6,
      iconUrl: token.iconUrl,
      packageId: token.packageId || SUIPUMP_PACKAGE_ID,
      reserveSuiMist: BigInt(Math.floor(reserveSui * 1e9)),
      reserveSui,
      reserveTokensRaw: BigInt(Math.floor((stats.token_reserve || 0) * 1e6)),
      reserveTokens: parseFloat(stats.token_reserve || '0'),
      lastPriceSui,
      marketCapSui,
      graduationThresholdSui: gradThreshold,
      bondingProgressPct,
      graduated: Boolean(token.graduated),
      poolId: token.poolId || null,
      buys: stats.buys !== undefined ? Number(stats.buys) : undefined,
      sells: stats.sells !== undefined ? Number(stats.sells) : undefined,
      trades: stats.trades !== undefined ? Number(stats.trades) : undefined,
    };
  } catch (err) {
    return null;
  }
}

// ── Sui SUI/USD Price Feed ──────────────────────────────────────────────────

let cachedSuiUsdPrice = 2.0;
let lastSuiUsdFetch = 0;

export async function getSuiUsdPrice(): Promise<number> {
  if (Date.now() - lastSuiUsdFetch < 60_000 && cachedSuiUsdPrice > 0) {
    return cachedSuiUsdPrice;
  }
  const sources = [
    fetch('https://api.binance.com/api/v3/ticker/price?symbol=SUIUSDT', { signal: AbortSignal.timeout(2000) })
      .then(r => r.json())
      .then((d: any) => {
        const p = parseFloat(d?.price);
        if (!(p > 0)) throw new Error('invalid price');
        return p;
      }),
    fetch('https://api.coingecko.com/api/v3/simple/price?ids=sui&vs_currencies=usd', { signal: AbortSignal.timeout(2000) })
      .then(r => r.json())
      .then((d: any) => {
        const p = Number(d?.sui?.usd);
        if (!(p > 0)) throw new Error('invalid price');
        return p;
      }),
  ];

  try {
    const fastest = await Promise.any(sources);
    if (fastest > 0) {
      cachedSuiUsdPrice = fastest;
      lastSuiUsdFetch = Date.now();
      return cachedSuiUsdPrice;
    }
  } catch {}

  return cachedSuiUsdPrice;
}

// ── Programmable Transaction Block (PTB) Builders ───────────────────────────

export interface BuildSuiPumpBuyParams {
  userAddress: string;
  curveId: string;
  tokenType: string;
  packageId?: string;
  suiAmountMist: bigint;
  minTokensOut?: bigint;
  slippagePct?: number;
  treasuryAddress?: string;
  referrerAddress?: string | null;
}

/**
 * Builds a SuiPump Buy PTB:
 * 1. Splits dev fee (1.5%) + swap amount from Gas.
 * 2. Transfers dev fee directly to treasury.
 * 3. Calls `suipump::bonding_curve::buy`.
 * 4. Transfers output token coins and refund SUI change to the user.
 */
export function buildSuiPumpBuyTransaction(params: BuildSuiPumpBuyParams): { tx: Transaction; feeMist: bigint; swapMist: bigint } {
  const {
    userAddress,
    curveId,
    tokenType,
    packageId,
    suiAmountMist,
    minTokensOut,
    slippagePct = 2,
    treasuryAddress = DEFAULT_SUI_TREASURY_ADDRESS,
    referrerAddress,
  } = params;

  if (suiAmountMist <= 0n) {
    throw new Error('SUI amount must be greater than 0');
  }

  const feeMist = (suiAmountMist * SUI_FEE_BPS) / SUI_BPS_DENOMINATOR;
  const swapMist = suiAmountMist - feeMist;

  if (swapMist <= 0n) {
    throw new Error('Amount too small after 1.5% dev fee');
  }

  const tx = new Transaction();
  tx.setSender(userAddress);

  // 1. Split fee and swap coins from Gas
  const [feeCoin, swapCoin] = tx.splitCoins(tx.gas, [
    tx.pure.u64(feeMist.toString()),
    tx.pure.u64(swapMist.toString()),
  ]);

  // 2. Transfer dev fee to Treasury
  tx.transferObjects([feeCoin], treasuryAddress);

  // 3. Prepare referrer option (if any)
  const referrerArg = referrerAddress && isValidSuiAddress(referrerAddress)
    ? tx.pure.option('address', referrerAddress)
    : tx.pure.option('address', null);

  // Min token out computation with slippage protection
  const minAmountOut = (minTokensOut !== undefined && minTokensOut > 0n) ? minTokensOut : 1n;

  // 4. MoveCall: bonding_curve::buy<tokenType>(curve, swapCoin, minAmountOut, referrer, priceConfig, clock)
  const [tokenOut, refundSui] = tx.moveCall({
    package: packageId || SUIPUMP_PACKAGE_ID,
    module: 'bonding_curve',
    function: 'buy',
    typeArguments: [tokenType],
    arguments: [
      tx.object(curveId),
      swapCoin,
      tx.pure.u64(minAmountOut.toString()),
      referrerArg,
      tx.object(SUIPUMP_PRICE_CONFIG_OBJECT_ID),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  // 5. Transfer purchased tokens and any refund SUI change to user
  tx.transferObjects([tokenOut, refundSui], userAddress);

  return { tx, feeMist, swapMist };
}

export interface BuildSuiPumpSellParams {
  userAddress: string;
  curveId: string;
  tokenType: string;
  packageId?: string;
  tokenAmountRaw: bigint;
  tokenCoinObjectIds: string[];
  feeMist?: bigint;
  minSuiOut?: bigint;
  slippagePct?: number;
  treasuryAddress?: string;
  referrerAddress?: string | null;
}

/**
 * Builds a SuiPump Sell PTB:
 * 1. Merges user's token coin objects (if multiple exist).
 * 2. Splits exact token amount to sell.
 * 3. Calls `suipump::bonding_curve::sell`.
 * 4. Atomically splits 1.5% dev fee from returned SUI coin and transfers to Treasury.
 * 5. Transfers remaining SUI proceeds to user.
 */
export function buildSuiPumpSellTransaction(params: BuildSuiPumpSellParams): { tx: Transaction; feeMist: bigint } {
  const {
    userAddress,
    curveId,
    tokenType,
    packageId,
    tokenAmountRaw,
    tokenCoinObjectIds,
    feeMist = 0n,
    minSuiOut = 1n,
    treasuryAddress = DEFAULT_SUI_TREASURY_ADDRESS,
    referrerAddress,
  } = params;

  if (tokenAmountRaw <= 0n) {
    throw new Error('Token amount must be greater than 0');
  }
  if (!tokenCoinObjectIds || tokenCoinObjectIds.length === 0) {
    throw new Error(`No coin objects found for token ${tokenType}`);
  }

  const tx = new Transaction();
  tx.setSender(userAddress);

  // 1. Manage coin objects
  let primaryCoin = tx.object(tokenCoinObjectIds[0]);
  if (tokenCoinObjectIds.length > 1) {
    tx.mergeCoins(
      primaryCoin,
      tokenCoinObjectIds.slice(1).map((id) => tx.object(id))
    );
  }

  // 2. Split exact sell amount
  const [coinToSell] = tx.splitCoins(primaryCoin, [tx.pure.u64(tokenAmountRaw.toString())]);

  // 3. Referrer argument
  const referrerArg = referrerAddress && isValidSuiAddress(referrerAddress)
    ? tx.pure.option('address', referrerAddress)
    : tx.pure.option('address', null);

  // 4. MoveCall: bonding_curve::sell<tokenType>(curve, coinToSell, minSuiOut, referrer)
  const [suiProceeds] = tx.moveCall({
    package: packageId || SUIPUMP_PACKAGE_ID,
    module: 'bonding_curve',
    function: 'sell',
    typeArguments: [tokenType],
    arguments: [
      tx.object(curveId),
      coinToSell,
      tx.pure.u64(minSuiOut.toString()),
      referrerArg,
    ],
  });

  // 5. Deduct 1.5% dev fee to treasury if feeMist > 0
  if (feeMist > 0n) {
    const [feeCoin] = tx.splitCoins(suiProceeds, [tx.pure.u64(feeMist.toString())]);
    tx.transferObjects([feeCoin], treasuryAddress);
  }

  // 6. Transfer SUI proceeds back to user
  tx.transferObjects([suiProceeds], userAddress);

  return { tx, feeMist };
}

// ── Multi-DEX Router Aggregation (Aftermath SOR / Cetus / Bluefin / Turbos / DeepBook) ──

export interface SuiRouterQuoteResult {
  coinInType: string;
  coinOutType: string;
  amountIn: bigint;
  expectedAmountOut: bigint;
  spotPrice: number;
  venue: string;
  completeRoute: any;
}

/**
 * Gets the best swap quote and trade route across all Sui DEXes.
 * Optionally configures native 1.5% platform fee via Aftermath externalFee.
 */
export async function getSuiRouterQuote(params: {
  coinInType: string;
  coinOutType: string;
  amountIn: bigint;
  treasuryAddress?: string;
  includeFee?: boolean;
  feePercentage?: number;
}): Promise<SuiRouterQuoteResult | null> {
  try {
    const af = await Aftermath.create({ network: 'MAINNET' });
    const router = af.Router();
    const feePct = params.feePercentage ?? 0.015;
    const externalFee = params.includeFee !== false ? {
      recipient: params.treasuryAddress || DEFAULT_SUI_TREASURY_ADDRESS,
      feePercentage: feePct,
    } : undefined;

    const completeRoute = await router.getCompleteTradeRouteGivenAmountIn({
      coinInType: params.coinInType,
      coinOutType: params.coinOutType,
      coinInAmount: params.amountIn,
      externalFee,
    });

    if (!completeRoute || !completeRoute.coinOut?.amount) {
      return null;
    }

    const firstPath = completeRoute.routes?.[0]?.paths?.[0];
    const venue = firstPath?.protocolName?.toLowerCase() || 'sui_dex';

    return {
      coinInType: params.coinInType,
      coinOutType: params.coinOutType,
      amountIn: params.amountIn,
      expectedAmountOut: BigInt(completeRoute.coinOut.amount),
      spotPrice: completeRoute.spotPrice || 0,
      venue,
      completeRoute,
    };
  } catch (err: any) {
    return null;
  }
}

/**
 * Builds a multi-DEX swap transaction with slippage protection.
 */
export async function buildSuiRouterSwapTransaction(params: {
  walletAddress: string;
  completeRoute: any;
  slippagePct?: number;
}): Promise<Transaction> {
  const af = await Aftermath.create({ network: 'MAINNET' });
  const router = af.Router();
  const slippage = (params.slippagePct ?? 2) / 100;
  const tx = await router.getTransactionForCompleteTradeRoute({
    walletAddress: params.walletAddress,
    completeRoute: params.completeRoute,
    slippage,
  });
  return tx;
}

// ── Transaction Execution ───────────────────────────────────────────────────

export interface ExecuteSuiTxResult {
  digest: string;
  status: 'success' | 'failure';
  gasUsedMist: bigint;
  errorMessage?: string;
}

/**
 * Signs and submits a PTB to Sui Mainnet with automatic RPC failover.
 */
export async function executeSuiTransaction(
  tx: Transaction,
  keypair: Ed25519Keypair
): Promise<ExecuteSuiTxResult> {
  const submitTx = async (client: SuiJsonRpcClient) => {
    const result = await client.signAndExecuteTransaction({
      signer: keypair,
      transaction: tx,
      options: {
        showEffects: true,
        showEvents: true,
      },
    });

    const status = result.effects?.status.status === 'success' ? 'success' : 'failure';
    const error = result.effects?.status.error;
    const gasComputation = BigInt(result.effects?.gasUsed.computationCost || '0');
    const gasStorage = BigInt(result.effects?.gasUsed.storageCost || '0');
    const gasRebate = BigInt(result.effects?.gasUsed.storageRebate || '0');
    const netGas = gasComputation + gasStorage - (gasRebate > gasStorage ? gasStorage : gasRebate);

    if (status === 'failure') {
      return {
        digest: result.digest,
        status: 'failure' as const,
        gasUsedMist: netGas,
        errorMessage: error || 'Transaction failed on-chain',
      };
    }

    return {
      digest: result.digest,
      status: 'success' as const,
      gasUsedMist: netGas,
    };
  };

  try {
    return await submitTx(getSuiClient());
  } catch (err: any) {
    try {
      const fallbackClient = rotateSuiRpc();
      return await submitTx(fallbackClient);
    } catch (e2: any) {
      throw new Error(`Sui transaction execution failed: ${err.message}`);
    }
  }
}
