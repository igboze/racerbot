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
import { isZeroChainEnabled } from './evm.js';

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

// rpcUrls[0] is the one used: each was checked to answer on 2026-11-22 (the llamarpc, ankr and
// polygon-rpc.com endpoints did not)
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
    rpcUrls: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com'],
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
    rpcUrls: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'],
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
    rpcUrls: ['https://ethereum-rpc.publicnode.com', 'https://cloudflare-eth.com'],
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
    rpcUrls: ['https://mainnet.optimism.io', 'https://optimism-rpc.publicnode.com'],
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
    rpcUrls: ['https://polygon-bor-rpc.publicnode.com'],
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
    rpcUrls: ['https://bsc-dataseed.binance.org', 'https://bsc-rpc.publicnode.com'],
    explorerUrl: 'https://bscscan.com',
    minNativeGasReserve: 2_000_000_000_000_000n, // 0.002 BNB (~$1.20)
    approxBridgeTimeSec: 60,
    icon: '🟡',
  },
};

/** Chains the bridge offers: Zero only once its mainnet is live and switched on (ZERO_CHAIN_ENABLED=on) */
export function getBridgeChains(): LayerZeroChain[] {
  const chains: LayerZeroChain[] = ['base', 'arbitrum', 'ethereum', 'optimism', 'bsc', 'polygon'];
  return isZeroChainEnabled() ? ['zero', ...chains] : chains;
}

export function isBridgeChainEnabled(chain: string): chain is LayerZeroChain {
  return (getBridgeChains() as string[]).includes(chain);
}

export type StargateAsset = 'USDC' | 'ETH' | 'USDT' | 'ZRO';

/** RacerBot's bridge fee in basis points (BRIDGE_FEE_BPS, default 50 = 0.5%, capped at 5%) */
export function getBridgeFeeBps(): number {
  const raw = process.env.BRIDGE_FEE_BPS;
  const bps = raw === undefined || raw === '' ? 50 : Number(raw);
  return Number.isFinite(bps) ? Math.min(500, Math.max(0, Math.floor(bps))) : 50;
}

/** Where bridge fees go: the EVM treasury (a plain wallet, the same address on every chain) */
export function getBridgeFeeRecipient(): string {
  return process.env.EVM_TREASURY_ADDRESS || process.env.TREASURY_EVM_ADDRESS || '0xb1f9551E64e1addF18462B09f04E14DC131451b1';
}

export interface StargatePoolInfo {
  poolAddress: string;
  tokenAddress: string; // underlying token address (or zero address for native ETH)
  decimals: number;
  sharedDecimals: number;
}

// Stargate V2 pools from Stargate's "Mainnet Contracts" page, each checked on-chain (2026-11-22):
// token() returns the listed token, sharedDecimals() is 6 for every pool, and quoteSend answers.
// Zero (LayerZero's own chain) is not listed: its mainnet launches 2026-11-30.
const pool = (poolAddress: string, tokenAddress: string, decimals: number): StargatePoolInfo => ({
  poolAddress,
  tokenAddress,
  decimals,
  sharedDecimals: 6,
});

/**
 * ZRO (LayerZero's token) is itself a LayerZero OFT: the same contract on every chain sends it
 * (quoteSend / quoteOFT / send, like a Stargate pool), with no approval and no transfer fee.
 * Checked on-chain 2026-11-23: symbol ZRO, 18 decimals, 6 shared, peers set between all these chains.
 */
export const ZRO_OFT_ADDRESS = '0x6985884C4392D348587B19cb9eAAf157F13271cd';
const zro = pool(ZRO_OFT_ADDRESS, ZRO_OFT_ADDRESS, 18);

/** Canonical Stargate V2 Pool and Token Addresses (plus the ZRO OFT) */
export const STARGATE_V2_POOLS: Partial<Record<LayerZeroChain, Partial<Record<StargateAsset, StargatePoolInfo>>>> = {
  arbitrum: {
    ETH: pool('0xA45B5130f36CDcA45667738e2a258AB09f4A5f7F', ethers.ZeroAddress, 18),
    USDC: pool('0xe8CDF27AcD73a434D661C84887215F7598e7d0d3', '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 6),
    USDT: pool('0xcE8CcA271Ebc0533920C83d39F417ED6A0abB7D0', '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', 6),
    ZRO: zro,
  },
  base: {
    ETH: pool('0xdc181Bd607330aeeBEF6ea62e03e5e1Fb4B6F7C7', ethers.ZeroAddress, 18),
    USDC: pool('0x27a16dc786820B16E5c9028b75B99F6f604b5d26', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 6),
    ZRO: zro,
  },
  ethereum: {
    ETH: pool('0x77b2043768d28E9C9aB44E1aBfC95944bcE57931', ethers.ZeroAddress, 18),
    USDC: pool('0xc026395860Db2d07ee33e05fE50ed7bD583189C7', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 6),
    USDT: pool('0x933597a323Eb81cAe705C5bC29985172fd5A3973', '0xdAC17F958D2ee523a2206206994597C13D831ec7', 6),
    ZRO: zro,
  },
  optimism: {
    ETH: pool('0xe8CDF27AcD73a434D661C84887215F7598e7d0d3', ethers.ZeroAddress, 18),
    USDC: pool('0xcE8CcA271Ebc0533920C83d39F417ED6A0abB7D0', '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', 6),
    USDT: pool('0x19cFCE47eD54a88614648DC3f19A5980097007dD', '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', 6),
    ZRO: zro,
  },
  bsc: {
    USDC: pool('0x962Bd449E630b0d928f308Ce63f1A21F02576057', '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', 18),
    USDT: pool('0x138EB30f73BC423c6455C53df6D89CB01d9eBc63', '0x55d398326f99059fF775485246999027B3197955', 18),
    ZRO: zro,
  },
  polygon: {
    USDC: pool('0x9Aa02D4Fae7F58b8E8f34c66E756cC734DAc7fe4', '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', 6),
    USDT: pool('0xd47b03ee6d86Cf251ee7860FB2ACf9f91B9fD4d7', '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', 6),
    ZRO: zro,
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
  /** What Stargate says arrives after its fee, before slippage */
  amountReceivedLD: bigint;
  /** What leaves the user's wallet: the bridged amount plus RacerBot's fee */
  grossLD: bigint;
  /** RacerBot's bridge fee, paid to the treasury on the source chain after the bridge is sent */
  platformFeeLD: bigint;
  platformFeeBps: number;
  /** The exact SendParam this quote priced: send() must use it unchanged */
  sendParam: StargateSendParam;
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
  // Plain token transfers need no executor options (Stargate's own "taxi" mode)
  const extraOptions = params.extraOptions || '0x';
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
 * Quotes a Stargate V2 cross-chain bridge transfer from the pool itself.
 * Never guesses: if the pool cannot quote the route (wrong pool, unsupported
 * route, RPC down) this throws, so nothing is ever sent on an invented fee.
 */
export async function quoteStargateSend(params: {
  sourceChain: LayerZeroChain;
  destChain: LayerZeroChain;
  asset: StargateAsset;
  humanAmount: string;
  recipientAddress: string;
  slippageBps?: number;
  provider?: ethers.Provider;
  /** Overrides BRIDGE_FEE_BPS (tests, or 0 for internal moves) */
  feeBps?: number;
}): Promise<LayerZeroBridgeQuote> {
  const sourceConfig = LZ_CHAINS[params.sourceChain];
  const destConfig = LZ_CHAINS[params.destChain];

  if (!sourceConfig || !isBridgeChainEnabled(params.sourceChain)) throw new Error(`Unsupported source chain: ${params.sourceChain}`);
  if (!destConfig || !isBridgeChainEnabled(params.destChain)) throw new Error(`Unsupported destination chain: ${params.destChain}`);
  if (params.sourceChain === params.destChain) {
    throw new Error('Source and destination chains must be different for LayerZero bridging');
  }

  const poolInfo = STARGATE_V2_POOLS[params.sourceChain]?.[params.asset];
  if (!poolInfo) {
    throw new Error(`Stargate has no ${params.asset} pool on ${sourceConfig.name}. Pick another asset or chain.`);
  }
  if (!STARGATE_V2_POOLS[params.destChain]?.[params.asset]) {
    throw new Error(`Stargate cannot deliver ${params.asset} to ${destConfig.name}. Pick another asset or chain.`);
  }

  // The user picks what leaves their wallet; RacerBot's fee comes out of it, the rest is bridged.
  // Stargate moves amounts in 6 shared decimals and refunds nothing below that: trim the dust off the
  // bridged part (the trimmed dust stays with the fee, so the total never exceeds what the user picked).
  const grossLD = ethers.parseUnits(params.humanAmount, poolInfo.decimals);
  const platformFeeBps = params.feeBps ?? getBridgeFeeBps();
  const dustUnit = 10n ** BigInt(Math.max(0, poolInfo.decimals - poolInfo.sharedDecimals));
  const amountLD = ((grossLD - (grossLD * BigInt(platformFeeBps)) / 10000n) / dustUnit) * dustUnit;
  const platformFeeLD = grossLD - amountLD;
  if (amountLD <= 0n) {
    throw new Error('Bridge amount must be greater than zero');
  }

  const provider = params.provider || new ethers.JsonRpcProvider(sourceConfig.rpcUrls[0]);
  const pool = new ethers.Contract(poolInfo.poolAddress, STARGATE_V2_POOL_ABI, provider);
  const unquotable = (err: any) =>
    new Error(
      `Stargate could not quote ${params.asset} from ${sourceConfig.name} to ${destConfig.name} right now ` +
        `(${err?.shortMessage || err?.message || 'no answer'}). Nothing was sent.`
    );
  const asTuple = (p: StargateSendParam) => [p.dstEid, p.to, p.amountLD, p.minAmountLD, p.extraOptions, p.composeMsg, p.oftCmd];

  const draft = buildStargateSendParam({
    destChain: params.destChain,
    recipientAddress: params.recipientAddress,
    amountLD,
    slippageBps: params.slippageBps,
  });

  // What actually arrives after Stargate's own fee: slippage protection applies to that, not to the amount sent
  let amountReceivedLD: bigint;
  try {
    const [, , receipt] = await pool.quoteOFT(asTuple({ ...draft, minAmountLD: 0n }));
    amountReceivedLD = BigInt(receipt[1]);
  } catch (err: any) {
    throw unquotable(err);
  }
  if (amountReceivedLD <= 0n) throw unquotable(new Error('nothing would arrive'));

  const slippageBps = params.slippageBps ?? 50;
  const sendParam: StargateSendParam = {
    ...draft,
    minAmountLD: (amountReceivedLD * BigInt(10000 - slippageBps)) / 10000n,
  };

  let nativeFee: bigint;
  try {
    const fee = await pool.quoteSend(asTuple(sendParam), false);
    nativeFee = BigInt(fee[0]);
  } catch (err: any) {
    throw unquotable(err);
  }
  if (nativeFee <= 0n) throw unquotable(new Error('zero messaging fee'));

  // Estimated source transaction gas (approval + send)
  const sourceGasEstimate = params.sourceChain === 'ethereum' ? 800_000_000_000_000n : 100_000_000_000_000n;

  // Total native required: messagingFee + sourceGas (+ amount if bridging native ETH)
  let totalRequiredNative = nativeFee + sourceGasEstimate;
  if (poolInfo.tokenAddress === ethers.ZeroAddress) {
    totalRequiredNative += grossLD;
  }

  return {
    sourceChain: params.sourceChain,
    destChain: params.destChain,
    asset: params.asset,
    amountLD,
    minAmountLD: sendParam.minAmountLD,
    amountReceivedLD,
    humanAmount: ethers.formatUnits(amountLD, poolInfo.decimals),
    nativeFee,
    humanNativeFee: ethers.formatEther(nativeFee),
    sourceGasEstimate,
    totalRequiredNative,
    approxDurationSec: Math.max(sourceConfig.approxBridgeTimeSec, destConfig.approxBridgeTimeSec),
    poolAddress: poolInfo.poolAddress,
    recipient: params.recipientAddress,
    sendParam,
    grossLD,
    platformFeeLD,
    platformFeeBps,
  };
}
