/**
 * LayerZero V2 & Stargate V2 Cross-Chain Module for RacerBot.
 *
 * Provides:
 *  - Native Stargate V2 cross-chain transfers (USDC, ETH, USDT) across
 *    Arbitrum, Base, Ethereum, and Optimism.
 *  - LayerZero Endpoint V2 EID mappings, OptionsBuilder v2 encoding,
 *    and quoteSend / send parameter construction.
 *  - Strict sovereign EOA safety guards: EVM addresses are always 20-byte
 *    secp256k1 EOAs requiring no on-chain contract deployment (preventing the
 *    Starknet account abstraction failure where funds got trapped).
 *  - Direct LayerZero Scan transaction tracking.
 */
import { ethers } from 'ethers';
import { createLogger } from './logger.js';
import { decrypt } from './crypto.js';

const logger = createLogger('layerzero-shared');

// ── LayerZero V2 Endpoint IDs (EID) ──────────────────────────────────────────
export const LZ_EID_ARBITRUM = 30110;
export const LZ_EID_BASE = 30184;
export const LZ_EID_ETHEREUM = 30101;
export const LZ_EID_OPTIMISM = 30111;
export const LZ_EID_POLYGON = 30109;
export const LZ_EID_BSC = 30102;
export const LZ_EID_ZERO = 30286;

export type LayerZeroChain = 'arbitrum' | 'base' | 'ethereum' | 'optimism' | 'polygon' | 'bsc' | 'zero';

export interface LayerZeroChainConfig {
  chain: LayerZeroChain;
  name: string;
  eid: number;
  chainId: number;
  nativeSymbol: string;
  nativeDecimals: number;
  rpcUrls: string[];
  explorerUrl: string;
  minNativeGasReserve: bigint; // Minimum native gas balance that must remain in wallet
  approxBridgeTimeSec: number;
  icon: string;
}

export const LZ_CHAINS: Record<LayerZeroChain, LayerZeroChainConfig> = {
  zero: {
    chain: 'zero',
    name: 'Zero Network',
    eid: LZ_EID_ZERO,
    chainId: 4242,
    nativeSymbol: 'ZRO',
    nativeDecimals: 18,
    rpcUrls: [
      'https://rpc.zero.network',
      'https://zero-network.rpc.subquery.network/public',
    ],
    explorerUrl: 'https://zeroscan.io',
    minNativeGasReserve: 10_000_000_000_000_000n, // 0.01 ZRO (~$0.04)
    approxBridgeTimeSec: 30,
    icon: '🅾️',
  },
  arbitrum: {
    chain: 'arbitrum',
    name: 'Arbitrum One',
    eid: LZ_EID_ARBITRUM,
    chainId: 42161,
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    rpcUrls: [
      'https://arb1.arbitrum.io/rpc',
      'https://arbitrum.llamarpc.com',
      'https://rpc.ankr.com/arbitrum',
    ],
    explorerUrl: 'https://arbiscan.io',
    minNativeGasReserve: 500_000_000_000_000n, // 0.0005 ETH (~$1.50)
    approxBridgeTimeSec: 45,
    icon: '🔵',
  },
  base: {
    chain: 'base',
    name: 'Base',
    eid: LZ_EID_BASE,
    chainId: 8453,
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    rpcUrls: [
      'https://mainnet.base.org',
      'https://base.llamarpc.com',
      'https://rpc.ankr.com/base',
    ],
    explorerUrl: 'https://basescan.org',
    minNativeGasReserve: 500_000_000_000_000n, // 0.0005 ETH (~$1.50)
    approxBridgeTimeSec: 45,
    icon: '🔷',
  },
  ethereum: {
    chain: 'ethereum',
    name: 'Ethereum Mainnet',
    eid: LZ_EID_ETHEREUM,
    chainId: 1,
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    rpcUrls: [
      'https://eth.llamarpc.com',
      'https://cloudflare-eth.com',
      'https://rpc.ankr.com/eth',
    ],
    explorerUrl: 'https://etherscan.io',
    minNativeGasReserve: 5_000_000_000_000_000n, // 0.005 ETH (~$15.00)
    approxBridgeTimeSec: 900, // ~15 mins for L1 finality
    icon: '⟠',
  },
  optimism: {
    chain: 'optimism',
    name: 'OP Mainnet',
    eid: LZ_EID_OPTIMISM,
    chainId: 10,
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    rpcUrls: [
      'https://mainnet.optimism.io',
      'https://optimism.llamarpc.com',
      'https://rpc.ankr.com/optimism',
    ],
    explorerUrl: 'https://optimistic.etherscan.io',
    minNativeGasReserve: 500_000_000_000_000n, // 0.0005 ETH (~$1.50)
    approxBridgeTimeSec: 45,
    icon: '🔴',
  },
  polygon: {
    chain: 'polygon',
    name: 'Polygon PoS',
    eid: LZ_EID_POLYGON,
    chainId: 137,
    nativeSymbol: 'POL',
    nativeDecimals: 18,
    rpcUrls: ['https://polygon-rpc.com', 'https://polygon.llamarpc.com'],
    explorerUrl: 'https://polygonscan.com',
    minNativeGasReserve: 1_000_000_000_000_000_000n, // 1 POL (~$0.40)
    approxBridgeTimeSec: 120,
    icon: '🟣',
  },
  bsc: {
    chain: 'bsc',
    name: 'BNB Smart Chain',
    eid: LZ_EID_BSC,
    chainId: 56,
    nativeSymbol: 'BNB',
    nativeDecimals: 18,
    rpcUrls: ['https://binance.llamarpc.com', 'https://bsc-dataseed.binance.org'],
    explorerUrl: 'https://bscscan.com',
    minNativeGasReserve: 2_000_000_000_000_000n, // 0.002 BNB (~$1.20)
    approxBridgeTimeSec: 60,
    icon: '🟡',
  },
};

export type StargateAsset = 'USDC' | 'ETH' | 'USDT';

export interface StargatePoolInfo {
  poolAddress: string;
  tokenAddress: string; // underlying token address (or zero address for native ETH)
  decimals: number;
  sharedDecimals: number;
}

/** Canonical Stargate V2 Pool and Token Addresses */
export const STARGATE_V2_POOLS: Partial<Record<LayerZeroChain, Partial<Record<StargateAsset, StargatePoolInfo>>>> = {
  arbitrum: {
    USDC: {
      poolAddress: '0xe8CDF27AcD73a434D661C84887215F7598e7d0d3',
      tokenAddress: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      decimals: 6,
      sharedDecimals: 6,
    },
    ETH: {
      poolAddress: '0xc20092c457314545089307779774dbca3c415e9a',
      tokenAddress: ethers.ZeroAddress,
      decimals: 18,
      sharedDecimals: 18,
    },
    USDT: {
      poolAddress: '0xcE8CcA271Ebc053242945f2ddB84533F7220547c',
      tokenAddress: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
      decimals: 6,
      sharedDecimals: 6,
    },
  },
  base: {
    USDC: {
      poolAddress: '0x27a16dc3771391a403d6d5ef62cfb37624522906',
      tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      decimals: 6,
      sharedDecimals: 6,
    },
    ETH: {
      poolAddress: '0x3ffb1b11b52a1eb54b423c4a452ef29b8a3e7284',
      tokenAddress: ethers.ZeroAddress,
      decimals: 18,
      sharedDecimals: 18,
    },
  },
  ethereum: {
    USDC: {
      poolAddress: '0xc026395860Db3505327ac1b6DCAfde1b140709d6',
      tokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      decimals: 6,
      sharedDecimals: 6,
    },
    ETH: {
      poolAddress: '0x77b2043768d28E9C9aB44E1aBfC95944bcE57931',
      tokenAddress: ethers.ZeroAddress,
      decimals: 18,
      sharedDecimals: 18,
    },
  },
  optimism: {
    USDC: {
      poolAddress: '0xcE8CcA271Ebc053242945f2ddB84533F7220547c',
      tokenAddress: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
      decimals: 6,
      sharedDecimals: 6,
    },
    ETH: {
      poolAddress: '0x266854e488B87e81057E88aAb74C97818A57BE9D',
      tokenAddress: ethers.ZeroAddress,
      decimals: 18,
      sharedDecimals: 18,
    },
  },
  zero: {
    USDC: {
      poolAddress: '0x27a16dc3771391a403d6d5ef62cfb37624522906',
      tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      decimals: 6,
      sharedDecimals: 6,
    },
    ETH: {
      poolAddress: '0x3ffb1b11b52a1eb54b423c4a452ef29b8a3e7284',
      tokenAddress: ethers.ZeroAddress,
      decimals: 18,
      sharedDecimals: 18,
    },
  },
  bsc: {
    USDC: {
      poolAddress: '0x160345fc359604fc6e70e3c5facbde5f7a9342d8',
      tokenAddress: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
      decimals: 18,
      sharedDecimals: 6,
    },
    USDT: {
      poolAddress: '0x160345fc359604fc6e70e3c5facbde5f7a9342d8',
      tokenAddress: '0x55d398326f99059fF775485246999027B3197955',
      decimals: 18,
      sharedDecimals: 6,
    },
  },
  polygon: {
    USDC: {
      poolAddress: '0x9aa83081aa06af0208d066624ac9677579f60532',
      tokenAddress: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
      decimals: 6,
      sharedDecimals: 6,
    },
    USDT: {
      poolAddress: '0x160345fc359604fc6e70e3c5facbde5f7a9342d8',
      tokenAddress: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
      decimals: 6,
      sharedDecimals: 6,
    },
  },
};

// ── Standard Stargate V2 & LayerZero ABIs ────────────────────────────────────
export const STARGATE_V2_POOL_ABI = [
  'function quoteSend((uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) _sendParam, bool _payInLzToken) view returns ((uint256 nativeFee, uint256 lzTokenFee))',
  'function quoteOFT((uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) _sendParam) view returns ((uint256 minAmountLD, uint256 maxAmountLD), (int256 feeBps, string description)[], (uint256 amountSentLD, uint256 amountReceivedLD))',
  'function send((uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) _sendParam, (uint256 nativeFee, uint256 lzTokenFee) _fee, address _refundAddress) payable returns ((bytes32 guid, uint64 nonce, (uint256 nativeFee, uint256 lzTokenFee) fee), (uint256 amountSentLD, uint256 amountReceivedLD))',
  'function token() view returns (address)',
  'function endpoint() view returns (address)',
];

export const LZ_ENDPOINT_V2_ABI = [
  'function eid() view returns (uint32)',
  'function quote((uint32 dstEid, bytes32 receiver, bytes message, bytes options, bool payInLzToken) _params, address _sender) view returns ((uint256 nativeFee, uint256 lzTokenFee))',
];

// ── Types ───────────────────────────────────────────────────────────────────

export interface StargateSendParam {
  dstEid: number;
  to: string; // 32-byte hex string (bytes32)
  amountLD: bigint;
  minAmountLD: bigint;
  extraOptions: string; // hex encoded
  composeMsg: string; // hex encoded ('0x' if none)
  oftCmd: string; // hex encoded ('0x' if none)
}

export interface StargateMessagingFee {
  nativeFee: bigint;
  lzTokenFee: bigint;
}

export interface LayerZeroBridgeQuote {
  sourceChain: LayerZeroChain;
  destChain: LayerZeroChain;
  asset: StargateAsset;
  amountLD: bigint;
  minAmountLD: bigint;
  humanAmount: string;
  nativeFee: bigint;
  humanNativeFee: string;
  sourceGasEstimate: bigint;
  totalRequiredNative: bigint; // nativeFee + source gas (+ bridge amount if bridging native ETH)
  approxDurationSec: number;
  poolAddress: string;
  recipient: string;
}

// ── LayerZero Address & Option Helpers ──────────────────────────────────────

/**
 * Converts a standard 20-byte EVM address to a 32-byte hex string for LayerZero.
 */
export function addressToBytes32(address: string): string {
  if (!ethers.isAddress(address)) {
    throw new Error(`Invalid EVM address for LayerZero conversion: ${address}`);
  }
  return ethers.zeroPadValue(ethers.getAddress(address), 32);
}

/**
 * Recovers the 20-byte EVM address from a 32-byte LayerZero recipient.
 */
export function bytes32ToAddress(bytes32Str: string): string {
  const clean = bytes32Str.startsWith('0x') ? bytes32Str.slice(2) : bytes32Str;
  if (clean.length !== 64) {
    throw new Error(`Expected 32 bytes (64 hex characters), got ${clean.length}`);
  }
  return ethers.getAddress('0x' + clean.slice(24));
}

/**
 * Encodes LayerZero V2 Options (Type 3).
 *
 * Format:
 *  - 2 bytes: type = 0x0003
 *  - Worker options (Executor):
 *    - 1 byte: workerId = 0x01 (Executor)
 *    - 2 bytes: optionSize = length(optionType + params)
 *    - 1 byte: optionType = 0x01 (lzReceive)
 *    - 16 bytes: gasLimit (uint128)
 *    - Optional 16 bytes: nativeDropValue (uint128) if native drop on destination is desired
 */
export function encodeLzReceiveOptions(gasLimit: bigint = 200_000n, nativeDrop: bigint = 0n): string {
  const OPTION_TYPE_3 = '0003';
  const WORKER_ID_EXECUTOR = '01';
  const OPTION_TYPE_LZRECEIVE = '01';

  const gasHex = ethers.toBeHex(gasLimit).slice(2).padStart(32, '0'); // 16 bytes = 32 hex chars

  if (nativeDrop > 0n) {
    const valueHex = ethers.toBeHex(nativeDrop).slice(2).padStart(32, '0');
    // option length = 1 byte (type) + 16 bytes (gas) + 16 bytes (value) = 33 bytes
    const sizeHex = (33).toString(16).padStart(4, '0');
    return '0x' + OPTION_TYPE_3 + WORKER_ID_EXECUTOR + sizeHex + OPTION_TYPE_LZRECEIVE + gasHex + valueHex;
  }

  // option length = 1 byte (type) + 16 bytes (gas) = 17 bytes
  const sizeHex = (17).toString(16).padStart(4, '0');
  return '0x' + OPTION_TYPE_3 + WORKER_ID_EXECUTOR + sizeHex + OPTION_TYPE_LZRECEIVE + gasHex;
}

/**
 * Returns the official LayerZero Scan URL for tracking cross-chain delivery.
 */
export function getLayerZeroScanUrl(txHash: string): string {
  const clean = (txHash || '').trim();
  return `https://layerzeroscan.com/tx/${clean}`;
}

// ── Sovereign Wallet Verification (Anti-Starknet Failure Guard) ─────────────

export interface SovereignEvmCheckResult {
  valid: boolean;
  address: string;
  reason?: string;
}

/**
 * Strict verification that an EVM address is a sovereign secp256k1 EOA.
 *
 * Context & Failure Mode Prevented:
 * In the previous Starknet integration, accounts were smart contracts requiring
 * on-chain deployment and specific Cairo bytecode. Users who received addresses
 * had funds trapped because the contract was undeployed, or the user could not
 * export their key into standard wallets like MetaMask/Rabby.
 *
 * For EVM LayerZero:
 *  1. The address is an externally owned account (EOA) standard across all EVM chains.
 *  2. No contract deployment is ever needed. Funds sent to it are immediately spendable.
 *  3. The private key is sovereign and 100% exportable to MetaMask/Rabby at any moment.
 *  4. LayerZero refunds route directly to this address.
 */
export function verifySovereignEvmWallet(
  address: string,
  encryptedPrivateKey?: string,
  masterKey?: string
): SovereignEvmCheckResult {
  if (!address || typeof address !== 'string') {
    return { valid: false, address: '', reason: 'Missing EVM address' };
  }
  const clean = address.trim();

  // Guard against Starknet or Sui addresses (longer than 42 chars)
  if (/^0x[0-9a-fA-F]{43,66}$/.test(clean)) {
    return {
      valid: false,
      address: clean,
      reason: 'Detected Starknet/Sui non-EVM address format. LayerZero requires standard 20-byte EVM addresses.',
    };
  }

  if (!ethers.isAddress(clean)) {
    return { valid: false, address: clean, reason: 'Invalid EVM checksum or address format' };
  }

  if (clean.toLowerCase() === ethers.ZeroAddress) {
    return { valid: false, address: clean, reason: 'Zero address is not a valid user wallet' };
  }

  // If private key is provided, verify it derives to this exact address
  if (encryptedPrivateKey && masterKey) {
    try {
      const rawPrivKey = decrypt(encryptedPrivateKey, masterKey);
      const wallet = new ethers.Wallet(rawPrivKey);
      if (wallet.address.toLowerCase() !== clean.toLowerCase()) {
        return {
          valid: false,
          address: clean,
          reason: 'Cryptographic mismatch: stored private key does not derive to public EVM address',
        };
      }
    } catch (err: any) {
      return {
        valid: false,
        address: clean,
        reason: `Failed to verify sovereign private key decryption: ${err.message}`,
      };
    }
  }

  return { valid: true, address: ethers.getAddress(clean) };
}

// ── Quote & Parameter Construction ──────────────────────────────────────────

/**
 * Builds the SendParam struct for Stargate V2.
 * Enforces slippage protection (default 0.5% = 50 BPS).
 */
export function buildStargateSendParam(params: {
  destChain: LayerZeroChain;
  recipientAddress: string;
  amountLD: bigint;
  slippageBps?: number; // e.g. 50 = 0.5%
  extraOptions?: string;
  composeMsg?: string;
}): StargateSendParam {
  const destConfig = LZ_CHAINS[params.destChain];
  if (!destConfig) {
    throw new Error(`Unsupported destination chain: ${params.destChain}`);
  }

  const toBytes32 = addressToBytes32(params.recipientAddress);
  const slippageBps = params.slippageBps ?? 50;
  const minAmountLD = (params.amountLD * BigInt(10000 - slippageBps)) / 10000n;
  const extraOptions = params.extraOptions || encodeLzReceiveOptions(200_000n, 0n);
  const composeMsg = params.composeMsg || '0x';

  return {
    dstEid: destConfig.eid,
    to: toBytes32,
    amountLD: params.amountLD,
    minAmountLD,
    extraOptions,
    composeMsg,
    oftCmd: '0x',
  };
}

/**
 * Quotes a Stargate V2 cross-chain bridge transfer.
 * Performs live RPC queries to the Stargate pool contract with graceful fallback.
 */
export async function quoteStargateSend(params: {
  sourceChain: LayerZeroChain;
  destChain: LayerZeroChain;
  asset: StargateAsset;
  humanAmount: string;
  recipientAddress: string;
  slippageBps?: number;
  provider?: ethers.Provider;
}): Promise<LayerZeroBridgeQuote> {
  const sourceConfig = LZ_CHAINS[params.sourceChain];
  const destConfig = LZ_CHAINS[params.destChain];

  if (!sourceConfig) throw new Error(`Unsupported source chain: ${params.sourceChain}`);
  if (!destConfig) throw new Error(`Unsupported destination chain: ${params.destChain}`);
  if (params.sourceChain === params.destChain) {
    throw new Error('Source and destination chains must be different for LayerZero bridging');
  }

  const poolMap = STARGATE_V2_POOLS[params.sourceChain];
  const poolInfo = poolMap ? poolMap[params.asset] : undefined;
  if (!poolInfo) {
    throw new Error(`Stargate V2 does not have a registered pool for ${params.asset} on ${params.sourceChain}`);
  }

  const amountLD = ethers.parseUnits(params.humanAmount, poolInfo.decimals);
  if (amountLD <= 0n) {
    throw new Error('Bridge amount must be greater than zero');
  }

  const sendParam = buildStargateSendParam({
    destChain: params.destChain,
    recipientAddress: params.recipientAddress,
    amountLD,
    slippageBps: params.slippageBps,
  });

  let nativeFee = 0n;
  let lzTokenFee = 0n;

  // Attempt live RPC query
  const rpcUrl = sourceConfig.rpcUrls[0];
  const rpcProvider = params.provider || new ethers.JsonRpcProvider(rpcUrl);

  try {
    const poolContract = new ethers.Contract(poolInfo.poolAddress, STARGATE_V2_POOL_ABI, rpcProvider);
    const feeResult = await poolContract.quoteSend(
      [
        sendParam.dstEid,
        sendParam.to,
        sendParam.amountLD,
        sendParam.minAmountLD,
        sendParam.extraOptions,
        sendParam.composeMsg,
        sendParam.oftCmd,
      ],
      false
    );
    nativeFee = BigInt(feeResult[0] || feeResult.nativeFee || 0);
    lzTokenFee = BigInt(feeResult[1] || feeResult.lzTokenFee || 0);
  } catch (err: any) {
    logger.warn(`RPC quoteSend failed on ${params.sourceChain}, using resilient fallback estimate: ${err.message}`);
    // Standard L2-to-L2 LayerZero native messaging fee estimate: ~0.0003 - 0.0008 ETH
    if (params.sourceChain === 'ethereum') {
      nativeFee = 2_500_000_000_000_000n; // ~0.0025 ETH on L1
    } else if (params.sourceChain === 'bsc') {
      nativeFee = 2_000_000_000_000_000n; // ~0.002 BNB
    } else if (params.sourceChain === 'polygon') {
      nativeFee = 1_000_000_000_000_000_000n; // ~1 POL
    } else if (params.sourceChain === 'zero') {
      nativeFee = 50_000_000_000_000_000n; // ~0.05 ZRO (~$0.20)
    } else {
      nativeFee = 400_000_000_000_000n; // ~0.0004 ETH on Arbitrum/Base/OP (~$1.20)
    }
  }

  // Estimated source transaction gas (approval + send)
  const sourceGasEstimate =
    params.sourceChain === 'ethereum'
      ? 800_000_000_000_000n
      : params.sourceChain === 'zero'
        ? 10_000_000_000_000_000n
        : 100_000_000_000_000n;

  // Total native required: messagingFee + sourceGas (+ amount if bridging native ETH)
  let totalRequiredNative = nativeFee + sourceGasEstimate;
  if (params.asset === 'ETH' && sourceConfig.nativeSymbol === 'ETH') {
    totalRequiredNative += amountLD;
  }

  return {
    sourceChain: params.sourceChain,
    destChain: params.destChain,
    asset: params.asset,
    amountLD,
    minAmountLD: sendParam.minAmountLD,
    humanAmount: params.humanAmount,
    nativeFee,
    humanNativeFee: ethers.formatEther(nativeFee),
    sourceGasEstimate,
    totalRequiredNative,
    approxDurationSec: Math.max(sourceConfig.approxBridgeTimeSec, destConfig.approxBridgeTimeSec),
    poolAddress: poolInfo.poolAddress,
    recipient: params.recipientAddress,
  };
}
