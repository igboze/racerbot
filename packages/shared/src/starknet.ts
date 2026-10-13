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
export const USDC_TOKEN_ADDRESS =
  '0x053b40a647cedf4301a4126a35d7d8e120cad0437ec04bde68e8d39e5ec95b1f';
export const USDC_NATIVE_TOKEN_ADDRESS =
  '0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8';
export const USDC_BRIDGED_TOKEN_ADDRESS =
  '0x05574eb6b8789a91466f902c380d978e472db68170ff82a5b650b95a58ddf4ad';
export const USDT_TOKEN_ADDRESS =
  '0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8';
export const UNRUGGABLE_FACTORY_ADDRESS =
  '0x01a46467a9246f45c830a5eb440b544873cba2c4cee663951568e188352e033f';

/**
 * Robustly normalizes Starknet contract and account addresses.
 * Strips/adds leading zeroes to canonical 64 hex characters (0x + 64 hex chars).
 */
export function normalizeStarknetAddress(addr?: string | null): string {
  if (!addr) return '';
  try {
    const clean = addr.trim().toLowerCase();
    if (!clean.startsWith('0x')) return clean;
    return '0x' + BigInt(clean).toString(16).padStart(64, '0');
  } catch {
    return (addr || '').toLowerCase().trim();
  }
}

/**
 * Compares two Starknet addresses regardless of leading-zero variations from JSON-RPC nodes.
 */
export function isSameStarknetAddress(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  return normalizeStarknetAddress(a) === normalizeStarknetAddress(b);
}

/**
 * Validates whether a string is a well-formed Starknet field element address (felt252).
 */
export function isValidStarknetAddress(addr?: string | null): boolean {
  if (!addr) return false;
  const s = addr.trim().toLowerCase();
  if (!/^0x[0-9a-f]{1,66}$/.test(s)) return false;
  try {
    const val = BigInt(s);
    // Valid Starknet felt252 must be non-zero and strictly less than Starknet prime
    return (
      val > 0n &&
      val < BigInt('0x800000000000011000000000000000000000000000000000000000000000001')
    );
  } catch {
    return false;
  }
}

// Standard OpenZeppelin Account v0.8.1 class hash (canonical declared Sierra contract on Starknet Mainnet)
export const OZ_ACCOUNT_CLASS_HASH =
  process.env.STARKNET_ACCOUNT_CLASS_HASH ||
  '0x061dac032f228abef9c6626f995015233097ae253a7f72d68552db02f2971b8f';

// Previous typo hash for backwards compatibility and auto-migration detection
export const TYPO_OZ_ACCOUNT_CLASS_HASH =
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

// Dynamic RPC endpoints with Cartridge Mainnet and PublicNode as primary high-performance RPCs
const FALLBACK_STARKNET_RPCS = [
  'https://api.cartridge.gg/x/starknet/mainnet',
  'https://starknet-rpc.publicnode.com',
  'https://free-rpc.nethermind.io/mainnet-juno',
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
 * Utilizes GeckoTerminal zero-credit lookup, in-memory caching, and RPC fallback.
 */
export async function getStarknetTokenMetadata(
  tokenAddress: string
): Promise<StarknetTokenMetadata> {
  const norm = tokenAddress.toLowerCase().trim();

  // 1. Check in-memory metadata cache
  const cached = tokenMetadataCache.get(norm);
  if (cached && cached.name !== 'Unknown' && cached.symbol !== 'UNKNOWN') return cached;

  // 2. Handle known core tokens instantly with 0 RPC calls
  if (norm === STRK_TOKEN_ADDRESS.toLowerCase() || norm === 'strk') {
    const res = {
      address: STRK_TOKEN_ADDRESS,
      name: 'Starknet Token',
      symbol: 'STRK',
      decimals: 18,
      totalSupply: '10000000000000000000000000000',
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
      totalSupply: '120000000000000000000000000',
    };
    tokenMetadataCache.set(norm, res);
    return res;
  }

  // 3. Try GeckoTerminal zero-credit free public API first
  try {
    const geckoRes: any = await fetch(`https://api.geckoterminal.com/api/v2/networks/starknet-alpha/tokens/${norm}`, {
      headers: { Accept: 'application/json' },
    }).then((r) => r.json()).catch(() => null);

    if (geckoRes?.data?.attributes) {
      const attr = geckoRes.data.attributes;
      const metadata: StarknetTokenMetadata = {
        address: tokenAddress,
        name: attr.name || 'Token',
        symbol: (attr.symbol || 'TOKEN').toUpperCase(),
        decimals: Number(attr.decimals) || 18,
        totalSupply: attr.total_supply ? attr.total_supply.split('.')[0] : undefined,
      };
      tokenMetadataCache.set(norm, metadata);
      return metadata;
    }
  } catch {
    // Fall back to RPC inspection
  }

  // 4. On-chain RPC calls using primary provider for reliable execution
  const provider = getStarknetProvider();

  try {
    const [nameRes, symbolRes, decimalsRes, supplyRes] = await Promise.allSettled([
      provider.callContract({ contractAddress: tokenAddress, entrypoint: 'name', calldata: [] }),
      provider.callContract({ contractAddress: tokenAddress, entrypoint: 'symbol', calldata: [] }),
      provider.callContract({ contractAddress: tokenAddress, entrypoint: 'decimals', calldata: [] }),
      provider.callContract({ contractAddress: tokenAddress, entrypoint: 'totalSupply', calldata: [] }).catch(() =>
        provider.callContract({ contractAddress: tokenAddress, entrypoint: 'total_supply', calldata: [] })
      ),
    ]);

    let name = 'Unknown';
    let symbol = 'UNKNOWN';
    let decimals = 18;
    let totalSupply: string | undefined;

    if (nameRes.status === 'fulfilled' && nameRes.value.length > 0) {
      name = parseFeltOrByteArray(nameRes.value);
    }
    if (symbolRes.status === 'fulfilled' && symbolRes.value.length > 0) {
      symbol = parseFeltOrByteArray(symbolRes.value);
    }
    if (decimalsRes.status === 'fulfilled' && decimalsRes.value.length > 0) {
      decimals = Number(BigInt(decimalsRes.value[0]));
    }
    if (supplyRes.status === 'fulfilled' && supplyRes.value && supplyRes.value.length >= 2) {
      totalSupply = uint256.uint256ToBN({ low: supplyRes.value[0], high: supplyRes.value[1] }).toString();
    } else if (supplyRes.status === 'fulfilled' && supplyRes.value && supplyRes.value.length === 1) {
      totalSupply = BigInt(supplyRes.value[0]).toString();
    }

    const metadata: StarknetTokenMetadata = {
      address: tokenAddress,
      name,
      symbol,
      decimals,
      totalSupply,
    };

    if (name !== 'Unknown' && symbol !== 'UNKNOWN') {
      tokenMetadataCache.set(norm, metadata);
    }
    return metadata;
  } catch {
    return {
      address: tokenAddress,
      name: 'Unknown',
      symbol: 'UNKNOWN',
      decimals: 18,
    };
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

// ── Starknet Launchpad Detection & Routing ───────────────────────────────────

export const LAUNCHY_OFFICIAL_URL = 'https://starklaunchy.fun';
export const LAUNCHY_TOKEN_ADDRESS =
  '0x03663d816450fa6d639d9d3e0b72187007d733266d70fc507a20671c32a7bfd1';
export const LAUNCHY_FACTORY_V6 =
  '0x03865fb40c5b7a493299323e71967656243006101e6221246eccdda2bba356c3';
export const LAUNCHY_FACTORY_V2 =
  '0x063883bfd87f65a2e42193f0f5cf18eb69d983abb99b07f7ec9a561b11c85ef4';
export const LAUNCHY_SWAPPER_V3 =
  '0x033175f310b7e5218aa6c9f5a9cad931f62f5119c07541b1b12ec34df92e08d3';

// Launchy trading pairs from https://starklaunchy.fun/docs
export const ZEC_TOKEN_ADDRESS =
  '0x05ce53b9b68fb8e9ecab9283a96d97948914733fd6ed8d9a53a276a419497841';
export const STRKBTC_TOKEN_ADDRESS =
  '0x0787150e306e6eae6e3f79dea881770e8bbff2c1b8eb490f969669ee945b3135';

// Launchy fee and protection policy from https://starklaunchy.fun/docs
export const LAUNCHY_POOL_FEE_PCT = 1.0; // 1% pool trading fee
export const LAUNCHY_CREATOR_FEE_SHARE_PCT = 50; // 50% to Creator (0.5% of trade)
export const LAUNCHY_PLATFORM_FEE_SHARE_PCT = 30; // 30% to Launchy Treasury (0.3% of trade)
export const LAUNCHY_EKUBO_FEE_SHARE_PCT = 20; // 20% to Ekubo (0.2% of trade)
export const LAUNCHY_CREATION_FEE_EST_USD = 1.50; // ≈ $1.50 in STRK
export const LAUNCHY_PROTECTION_MAX_BUY_PCT = 2; // Up to 2% of initial supply per buy
export const LAUNCHY_PROTECTION_WINDOW_SEC = 900; // 15 minutes fixed on chain

export interface StarknetLaunchpadPoolKey {
  token0: string;
  token1: string;
  fee: string;
  tick_spacing: string;
  extension: string;
}

export interface StarknetLaunchpadInfo {
  launchpad: 'launchy' | 'unruggable' | 'ekubo' | 'jediswap' | 'none';
  name: string;
  venue: 'launchy' | 'unruggable' | 'ekubo' | 'jediswap' | 'avnu';
  isBonded: boolean;
  bondingPhase: 'bonding_curve' | 'bonded';
  factoryAddress?: string;
  routerAddress?: string;
  quoteToken?: string;
  quoteTokenSymbol?: 'STRK' | 'ZEC' | 'strkBTC' | string;
  poolKey?: StarknetLaunchpadPoolKey;
  websiteUrl?: string;
  poolFeePct?: number;
  launchProtectionNote?: string;
}

const launchpadInfoCache = new Map<string, { info: StarknetLaunchpadInfo; expiresAt: number }>();

/**
 * Detect the launchpad a Starknet token was created/launched on.
 * Inspects factory(), protocol_version(), and pool_config() on-chain.
 */
export async function detectStarknetLaunchpad(
  tokenAddress: string
): Promise<StarknetLaunchpadInfo> {
  const norm = tokenAddress.toLowerCase();
  const cached = launchpadInfoCache.get(norm);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.info;
  }

  // Core tokens are not launchpad memecoins
  if (
    norm === STRK_TOKEN_ADDRESS.toLowerCase() ||
    norm === 'strk' ||
    norm === ETH_TOKEN_ADDRESS.toLowerCase() ||
    norm === 'eth'
  ) {
    const defaultInfo: StarknetLaunchpadInfo = {
      launchpad: 'none',
      name: 'Starknet DEX',
      venue: 'avnu',
      isBonded: true,
      bondingPhase: 'bonded',
    };
    return defaultInfo;
  }

  const provider = getStarknetProvider();

  try {
    // 1. Check if token contract has a factory() method
    const factoryRes = await provider
      .callContract({
        contractAddress: tokenAddress,
        entrypoint: 'factory',
        calldata: [],
      })
      .catch(() => null);

    const factoryAddr = factoryRes && factoryRes[0] ? factoryRes[0] : null;

    // Check if token exposes is_launched()
    const isLaunchedRes = await provider
      .callContract({
        contractAddress: tokenAddress,
        entrypoint: 'is_launched',
        calldata: [],
      })
      .catch(() => null);

    const isBonded =
      isLaunchedRes && isLaunchedRes.length > 0
        ? isLaunchedRes[0] === '0x1' || isLaunchedRes[0] === '1'
        : true;

    if (factoryAddr) {
      const normFactory = factoryAddr.toLowerCase();

      // Check protocol_version on the factory
      let protocolVersion = '';
      try {
        const pvRes = await provider.callContract({
          contractAddress: factoryAddr,
          entrypoint: 'protocol_version',
          calldata: [],
        });
        if (pvRes && pvRes[0]) {
          protocolVersion = parseFeltOrByteArray([pvRes[0]]).toLowerCase();
        }
      } catch {
        // fallback
      }

      const isLaunchy =
        normFactory === LAUNCHY_FACTORY_V6.toLowerCase() ||
        protocolVersion.includes('launchy') ||
        protocolVersion.includes('launchpad_cairo');

      if (isLaunchy) {
        // Query pool config from Launchy factory
        let poolKey: StarknetLaunchpadPoolKey | undefined;
        let quoteToken = STRK_TOKEN_ADDRESS;
        try {
          const pcRes = await provider.callContract({
            contractAddress: factoryAddr,
            entrypoint: 'pool_config',
            calldata: [tokenAddress],
          });
          if (pcRes && pcRes.length >= 5) {
            poolKey = {
              token0: pcRes[0],
              token1: pcRes[1],
              fee: pcRes[2],
              tick_spacing: pcRes[3],
              extension: pcRes[4],
            };
            quoteToken = pcRes[1];
          }
        } catch {
          // ignore
        }

        let quoteTokenSymbol: 'STRK' | 'ZEC' | 'strkBTC' | string = 'STRK';
        if (quoteToken.toLowerCase() === ZEC_TOKEN_ADDRESS.toLowerCase()) {
          quoteTokenSymbol = 'ZEC';
        } else if (quoteToken.toLowerCase() === STRKBTC_TOKEN_ADDRESS.toLowerCase()) {
          quoteTokenSymbol = 'strkBTC';
        }

        const info: StarknetLaunchpadInfo = {
          launchpad: 'launchy',
          name: 'Launchy',
          venue: 'launchy',
          isBonded,
          bondingPhase: isBonded ? 'bonded' : 'bonding_curve',
          factoryAddress: factoryAddr,
          routerAddress: LAUNCHY_SWAPPER_V3,
          quoteToken,
          quoteTokenSymbol,
          poolKey,
          websiteUrl: `${LAUNCHY_OFFICIAL_URL}/token/${norm}`,
          poolFeePct: LAUNCHY_POOL_FEE_PCT,
          launchProtectionNote: 'First 15 min: max 2% of initial supply per buy',
        };
        launchpadInfoCache.set(norm, { info, expiresAt: Date.now() + 600_000 });
        return info;
      }

      if (protocolVersion.includes('unruggable')) {
        const info: StarknetLaunchpadInfo = {
          launchpad: 'unruggable',
          name: 'Unruggable Meme',
          venue: 'unruggable',
          isBonded,
          bondingPhase: isBonded ? 'bonded' : 'bonding_curve',
          factoryAddress: factoryAddr,
        };
        launchpadInfoCache.set(norm, { info, expiresAt: Date.now() + 600_000 });
        return info;
      }
    }

    // 2. Check token class ABI for signature strings
    const contractClass: any = await provider.getClassAt(tokenAddress).catch(() => null);
    const abiString = contractClass?.abi ? JSON.stringify(contractClass.abi).toLowerCase() : '';

    if (abiString.includes('launchy') || abiString.includes('launchpad_cairo')) {
      let poolKey: StarknetLaunchpadPoolKey | undefined;
      try {
        const pcRes = await provider.callContract({
          contractAddress: LAUNCHY_FACTORY_V6,
          entrypoint: 'pool_config',
          calldata: [tokenAddress],
        });
        if (pcRes && pcRes.length >= 5) {
          poolKey = {
            token0: pcRes[0],
            token1: pcRes[1],
            fee: pcRes[2],
            tick_spacing: pcRes[3],
            extension: pcRes[4],
          };
        }
      } catch {
        // ignore
      }

      const info: StarknetLaunchpadInfo = {
        launchpad: 'launchy',
        name: 'Launchy',
        venue: 'launchy',
        isBonded,
        bondingPhase: isBonded ? 'bonded' : 'bonding_curve',
        factoryAddress: LAUNCHY_FACTORY_V6,
        routerAddress: LAUNCHY_SWAPPER_V3,
        quoteToken: STRK_TOKEN_ADDRESS,
        quoteTokenSymbol: 'STRK',
        poolKey,
        websiteUrl: `${LAUNCHY_OFFICIAL_URL}/token/${norm}`,
        poolFeePct: LAUNCHY_POOL_FEE_PCT,
        launchProtectionNote: 'First 15 min: max 2% of initial supply per buy',
      };
      launchpadInfoCache.set(norm, { info, expiresAt: Date.now() + 600_000 });
      return info;
    }

    if (abiString.includes('unruggable')) {
      const info: StarknetLaunchpadInfo = {
        launchpad: 'unruggable',
        name: 'Unruggable Meme',
        venue: 'unruggable',
        isBonded,
        bondingPhase: isBonded ? 'bonded' : 'bonding_curve',
      };
      launchpadInfoCache.set(norm, { info, expiresAt: Date.now() + 600_000 });
      return info;
    }

    if (abiString.includes('ekubo')) {
      const info: StarknetLaunchpadInfo = {
        launchpad: 'ekubo',
        name: 'Ekubo DEX',
        venue: 'ekubo',
        isBonded: true,
        bondingPhase: 'bonded',
      };
      launchpadInfoCache.set(norm, { info, expiresAt: Date.now() + 600_000 });
      return info;
    }

    const defaultInfo: StarknetLaunchpadInfo = {
      launchpad: 'none',
      name: 'AVNU Aggregator',
      venue: 'avnu',
      isBonded: true,
      bondingPhase: 'bonded',
    };
    launchpadInfoCache.set(norm, { info: defaultInfo, expiresAt: Date.now() + 300_000 });
    return defaultInfo;
  } catch {
    const fallbackInfo: StarknetLaunchpadInfo = {
      launchpad: 'none',
      name: 'AVNU Aggregator',
      venue: 'avnu',
      isBonded: true,
      bondingPhase: 'bonded',
    };
    return fallbackInfo;
  }
}

export interface LaunchyQuoteResult {
  outputAmount: bigint;
  minReceived: bigint;
  platformFee: bigint;
  netInput: bigint;
}

/**
 * Direct on-chain quote from Launchy's EkuboFeeSwapperV3 swapper contract.
 */
export async function getLaunchyQuote(
  tokenAddress: string,
  tokenIn: string,
  amountIn: bigint,
  slippagePct: number = 2.0,
  poolKeyOverride?: StarknetLaunchpadPoolKey,
  routerAddressOverride?: string
): Promise<LaunchyQuoteResult | null> {
  try {
    const provider = getStarknetProvider();
    const router = routerAddressOverride || LAUNCHY_SWAPPER_V3;

    let poolKey = poolKeyOverride;
    if (!poolKey) {
      const launchpadInfo = await detectStarknetLaunchpad(tokenAddress);
      poolKey = launchpadInfo.poolKey;
      if (!poolKey && launchpadInfo.factoryAddress) {
        const pcRes = await provider.callContract({
          contractAddress: launchpadInfo.factoryAddress,
          entrypoint: 'pool_config',
          calldata: [tokenAddress],
        });
        if (pcRes && pcRes.length >= 5) {
          poolKey = {
            token0: pcRes[0],
            token1: pcRes[1],
            fee: pcRes[2],
            tick_spacing: pcRes[3],
            extension: pcRes[4],
          };
        }
      }
    }

    if (!poolKey) return null;

    const amountInU256 = uint256.bnToUint256(amountIn);
    const slippageBps = Math.floor(slippagePct * 100);

    const calldata = [
      poolKey.token0,
      poolKey.token1,
      poolKey.fee,
      poolKey.tick_spacing,
      poolKey.extension,
      tokenIn,
      amountInU256.low.toString(),
      amountInU256.high.toString(),
      slippageBps.toString(),
    ];

    const quoteRes = await provider.callContract({
      contractAddress: router,
      entrypoint: 'quote_exact_input',
      calldata,
    });

    if (!quoteRes || quoteRes.length < 8) return null;

    const outputAmount = uint256.uint256ToBN({ low: quoteRes[0], high: quoteRes[1] });
    const minReceived = uint256.uint256ToBN({ low: quoteRes[2], high: quoteRes[3] });
    const platformFee = uint256.uint256ToBN({ low: quoteRes[4], high: quoteRes[5] });
    const netInput = uint256.uint256ToBN({ low: quoteRes[6], high: quoteRes[7] });

    return {
      outputAmount,
      minReceived,
      platformFee,
      netInput,
    };
  } catch (err) {
    console.warn('[STARKNET] getLaunchyQuote error:', (err as any)?.message || err);
    return null;
  }
}
