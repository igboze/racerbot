import {
  RpcProvider,
  Account,
  ec,
  stark,
  hash,
  CallData,
  shortString,
  uint256,
} from 'starknet';
import { getQuotes, Quote } from '@avnu/avnu-sdk';
import { encrypt, decrypt } from './crypto.js';

// ── Starknet Constants ───────────────────────────────────────────────────────

export const STARKNET_DECIMALS = 18;
export const FRI_PER_STRK = 1_000_000_000_000_000_000n; // 10^18

// Canonical STRK and ETH ERC-20 token addresses on Starknet Mainnet
export const STRK_TOKEN_ADDRESS =
  '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
export const ETH_TOKEN_ADDRESS =
  '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7';

// Standard OpenZeppelin Account v0.8.1 class hash (widely deployed and verified)
export const OZ_ACCOUNT_CLASS_HASH =
  process.env.STARKNET_ACCOUNT_CLASS_HASH ||
  '0x061dac032f228abef0c420218e6349b33f79f2f5eaf0d4a14c47fa1ea9ec8662';

// Universal Deployer Contract (UDC)
export const UDC_ADDRESS =
  '0x041a78e741e5af2fec34b695679bc6891742439f7afb8484ecd7766661ad02bf';

// Platform fee: 1.5% (150 basis points)
export const STARKNET_FEE_BPS = 150n;
export const STARKNET_BPS_DENOMINATOR = 10000n;

// Default Starknet Treasury Address for protocol fees
export function getStarknetTreasuryAddress(): string {
  return (
    process.env.STARKNET_TREASURY_ADDRESS ||
    '0x0679eC47817013974A8f45df792fcf77504360c1344A0E0bfd1aB4b6dDbaB39A'
  );
}

export const DEFAULT_STARKNET_TREASURY_ADDRESS =
  '0x0679eC47817013974A8f45df792fcf77504360c1344A0E0bfd1aB4b6dDbaB39A';

// Dynamic RPC endpoints with rotation support
const FALLBACK_STARKNET_RPCS = [
  'https://free-rpc.nethermind.io/mainnet-juno',
  'https://rpc.starknet.lava.build',
  'https://starknet.drpc.org',
];

export function getStarknetRpcEndpoints(): string[] {
  const envList = (process.env.STARKNET_RPC_PROVIDERS || process.env.STARKNET_RPC_URL || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return envList.length > 0 ? envList : FALLBACK_STARKNET_RPCS;
}

let activeRpcIndex = 0;
let providerInstance: RpcProvider | null = null;
let readProviderInstance: RpcProvider | null = null;

/**
 * Returns primary provider (QuickNode for fast transaction execution & simulation).
 */
export function getStarknetProvider(): RpcProvider {
  const endpoints = getStarknetRpcEndpoints();
  if (!providerInstance) {
    const nodeUrl = endpoints[activeRpcIndex % endpoints.length];
    providerInstance = new RpcProvider({ nodeUrl });
  }
  return providerInstance;
}

/**
 * Returns read-only provider rotating across free public community RPCs.
 * Used for contract class inspection and metadata lookups to minimize QuickNode credit consumption.
 */
let readRpcIndex = 0;
export function getStarknetReadProvider(): RpcProvider {
  if (!readProviderInstance) {
    const nodeUrl = FALLBACK_STARKNET_RPCS[readRpcIndex % FALLBACK_STARKNET_RPCS.length];
    readProviderInstance = new RpcProvider({ nodeUrl });
  }
  return readProviderInstance;
}

export function rotateStarknetRpc(): RpcProvider {
  const endpoints = getStarknetRpcEndpoints();
  activeRpcIndex = (activeRpcIndex + 1) % endpoints.length;
  const nextUrl = endpoints[activeRpcIndex];
  console.log(`[STARKNET] Rotating RPC provider to ${nextUrl}`);
  providerInstance = new RpcProvider({ nodeUrl: nextUrl });
  return providerInstance;
}

// ── In-Memory Caches for Credit Conservation ─────────────────────────────────
const nativeBalanceCache = new Map<string, { at: number; data: StarknetNativeBalances }>();
const BALANCE_CACHE_TTL_MS = 8_000; // 8 seconds

export function invalidateStarknetBalanceCache(address: string): void {
  nativeBalanceCache.delete(address.toLowerCase().trim());
}

// ── Key Management ──────────────────────────────────────────────────────────

export interface GeneratedStarknetWallet {
  address: string;
  publicKey: string;
  privateKeySecret: string; // 0x...
  encryptedPrivateKey: string;
}

/**
 * Computes deterministic counterfactual address for an OpenZeppelin Account contract.
 */
export function computeStarknetAccountAddress(
  publicKey: string,
  classHash: string = OZ_ACCOUNT_CLASS_HASH
): string {
  const constructorCalldata = CallData.compile({ publicKey });
  return hash.calculateContractAddressFromHash(
    publicKey,
    classHash,
    constructorCalldata,
    0
  );
}

/**
 * Generates a fresh Stark Curve Starknet wallet and encrypts the secret key.
 */
export function generateStarknetWallet(masterKey: string): GeneratedStarknetWallet {
  const privateKeySecret = stark.randomAddress();
  const publicKey = ec.starkCurve.getStarkKey(privateKeySecret);
  const address = computeStarknetAccountAddress(publicKey);
  const encryptedPrivateKey = encrypt(privateKeySecret, masterKey);

  return {
    address,
    publicKey,
    privateKeySecret,
    encryptedPrivateKey,
  };
}

/**
 * Creates an Account instance for signing and executing Starknet transactions.
 */
export function getStarknetAccount(
  privateKeySecret: string,
  address: string,
  provider?: RpcProvider
): Account {
  return new Account({
    provider: provider || getStarknetProvider(),
    address,
    signer: privateKeySecret,
  });
}

// ── Balances & ERC-20 Queries ───────────────────────────────────────────────

export interface StarknetNativeBalances {
  strk: bigint;
  eth: bigint;
  strkFormatted: string;
  ethFormatted: string;
}

// In-memory token metadata cache (permanent - token symbols/decimals do not change)
const tokenMetadataCache = new Map<string, StarknetTokenMetadata>();

/**
 * Fetch both STRK and ETH balances for a Starknet address with fast in-memory caching.
 */
export async function getStarknetBalance(address: string, forceRefresh = false): Promise<StarknetNativeBalances> {
  const norm = address.toLowerCase().trim();
  if (!forceRefresh) {
    const cached = nativeBalanceCache.get(norm);
    if (cached && Date.now() - cached.at < BALANCE_CACHE_TTL_MS) {
      return cached.data;
    }
  }

  const [strkBal, ethBal] = await Promise.all([
    getStarknetTokenBalance(address, STRK_TOKEN_ADDRESS).catch(() => 0n),
    getStarknetTokenBalance(address, ETH_TOKEN_ADDRESS).catch(() => 0n),
  ]);

  const result: StarknetNativeBalances = {
    strk: strkBal,
    eth: ethBal,
    strkFormatted: formatTokenBalance(strkBal, 18),
    ethFormatted: formatTokenBalance(ethBal, 18),
  };

  nativeBalanceCache.set(norm, { at: Date.now(), data: result });
  return result;
}

/**
 * Query ERC-20 balanceOf on Starknet.
 */
export async function getStarknetTokenBalance(
  ownerAddress: string,
  tokenAddress: string
): Promise<bigint> {
  const provider = getStarknetProvider();
  try {
    const res = await provider.callContract({
      contractAddress: tokenAddress,
      entrypoint: 'balanceOf',
      calldata: CallData.compile({ account: ownerAddress }),
    });

    if (res && res.length >= 2) {
      // Cairo u256 is represented as { low: felt, high: felt }
      return uint256.uint256ToBN({ low: res[0], high: res[1] });
    }
    if (res && res.length === 1) {
      return BigInt(res[0]);
    }
    return 0n;
  } catch (err) {
    // If first endpoint fails, try rotate
    try {
      const fallbackProvider = rotateStarknetRpc();
      const res = await fallbackProvider.callContract({
        contractAddress: tokenAddress,
        entrypoint: 'balanceOf',
        calldata: CallData.compile({ account: ownerAddress }),
      });
      if (res && res.length >= 2) {
        return uint256.uint256ToBN({ low: res[0], high: res[1] });
      }
      return 0n;
    } catch {
      return 0n;
    }
  }
}

/**
 * Helper to format BigInt tokens to readable decimal string with up to 6 decimals.
 */
export function formatTokenBalance(rawAmount: bigint, decimals: number = 18): string {
  if (rawAmount === 0n) return '0.00';
  const divisor = 10n ** BigInt(decimals);
  const integerPart = rawAmount / divisor;
  const remainder = rawAmount % divisor;
  
  if (remainder === 0n) return `${integerPart}.00`;
  const remainderStr = remainder.toString().padStart(decimals, '0');
  const trimmed = remainderStr.slice(0, 6).replace(/0+$/, '');
  return `${integerPart}.${trimmed || '00'}`;
}

// ── Token Metadata ──────────────────────────────────────────────────────────

export interface StarknetTokenMetadata {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply?: string;
}

/**
 * Retrieve token name, symbol, decimals, and total supply for any Starknet ERC-20.
 * Utilizes in-memory caching and free read RPCs to avoid draining QuickNode credits.
 */
export async function getStarknetTokenMetadata(
  tokenAddress: string
): Promise<StarknetTokenMetadata> {
  const norm = tokenAddress.toLowerCase().trim();

  // 1. Check in-memory metadata cache
  const cached = tokenMetadataCache.get(norm);
  if (cached) return cached;

  // 2. Handle known core tokens instantly with 0 RPC calls
  if (norm === STRK_TOKEN_ADDRESS.toLowerCase() || norm === 'strk') {
    const res = {
      address: STRK_TOKEN_ADDRESS,
      name: 'Starknet Token',
      symbol: 'STRK',
      decimals: 18,
    };
    tokenMetadataCache.set(norm, res);
    return res;
  }
  if (norm === ETH_TOKEN_ADDRESS.toLowerCase() || norm === 'eth') {
    const res = {
      address: ETH_TOKEN_ADDRESS,
      name: 'Ether',
      symbol: 'ETH',
      decimals: 18,
    };
    tokenMetadataCache.set(norm, res);
    return res;
  }

  // 3. Use free read provider first to conserve QuickNode credits
  const provider = getStarknetReadProvider();

  try {
    const [nameRes, symbolRes, decimalsRes] = await Promise.allSettled([
      provider.callContract({ contractAddress: tokenAddress, entrypoint: 'name', calldata: [] }),
      provider.callContract({ contractAddress: tokenAddress, entrypoint: 'symbol', calldata: [] }),
      provider.callContract({ contractAddress: tokenAddress, entrypoint: 'decimals', calldata: [] }),
    ]);

    let name = 'Unknown';
    let symbol = 'UNKNOWN';
    let decimals = 18;

    if (nameRes.status === 'fulfilled' && nameRes.value.length > 0) {
      name = parseFeltOrByteArray(nameRes.value);
    }
    if (symbolRes.status === 'fulfilled' && symbolRes.value.length > 0) {
      symbol = parseFeltOrByteArray(symbolRes.value);
    }
    if (decimalsRes.status === 'fulfilled' && decimalsRes.value.length > 0) {
      decimals = Number(BigInt(decimalsRes.value[0]));
    }

    const metadata: StarknetTokenMetadata = {
      address: tokenAddress,
      name,
      symbol,
      decimals,
    };

    tokenMetadataCache.set(norm, metadata);
    return metadata;
  } catch {
    // If read provider fails, fall back to primary provider once
    try {
      const primaryProvider = getStarknetProvider();
      const [nameRes, symbolRes, decimalsRes] = await Promise.allSettled([
        primaryProvider.callContract({ contractAddress: tokenAddress, entrypoint: 'name', calldata: [] }),
        primaryProvider.callContract({ contractAddress: tokenAddress, entrypoint: 'symbol', calldata: [] }),
        primaryProvider.callContract({ contractAddress: tokenAddress, entrypoint: 'decimals', calldata: [] }),
      ]);

      let name = 'Unknown';
      let symbol = 'UNKNOWN';
      let decimals = 18;

      if (nameRes.status === 'fulfilled' && nameRes.value.length > 0) {
        name = parseFeltOrByteArray(nameRes.value);
      }
      if (symbolRes.status === 'fulfilled' && symbolRes.value.length > 0) {
        symbol = parseFeltOrByteArray(symbolRes.value);
      }
      if (decimalsRes.status === 'fulfilled' && decimalsRes.value.length > 0) {
        decimals = Number(BigInt(decimalsRes.value[0]));
      }

      const metadata: StarknetTokenMetadata = {
        address: tokenAddress,
        name,
        symbol,
        decimals,
      };

      tokenMetadataCache.set(norm, metadata);
      return metadata;
    } catch {
      return {
        address: tokenAddress,
        name: 'Token',
        symbol: 'TOKEN',
        decimals: 18,
      };
    }
  }
}

/**
 * Safely parses either a felt252 short string or a Cairo ByteArray response.
 */
function parseFeltOrByteArray(values: string[]): string {
  try {
    if (values.length === 1) {
      return shortString.decodeShortString(values[0]).trim();
    }
    // Handle Cairo 2 ByteArray format if serialized as length + chunks
    let combined = '';
    for (const v of values) {
      try {
        const decoded = shortString.decodeShortString(v);
        if (decoded && /^[\x20-\x7E]+$/.test(decoded)) {
          combined += decoded;
        }
      } catch {
        // Ignore non-string felt
      }
    }
    return combined.trim() || 'Unknown';
  } catch {
    return values[0] || 'Unknown';
  }
}

// ── AVNU Routing & Quotes ───────────────────────────────────────────────────

export interface StarknetQuoteParams {
  sellTokenAddress: string;
  buyTokenAddress: string;
  sellAmount: bigint;
  takerAddress?: string;
  slippage?: number;
}

/**
 * Fetch optimal quote from AVNU DEX aggregator.
 */
export async function getStarknetAVNUQuote(
  params: StarknetQuoteParams
): Promise<Quote | null> {
  try {
    const quotes = await getQuotes({
      sellTokenAddress: params.sellTokenAddress,
      buyTokenAddress: params.buyTokenAddress,
      sellAmount: params.sellAmount,
      takerAddress: params.takerAddress,
      size: 1,
    });

    if (quotes && quotes.length > 0) {
      return quotes[0];
    }
    return null;
  } catch (err) {
    console.warn('[STARKNET] AVNU getQuotes warning:', err);
    return null;
  }
}
