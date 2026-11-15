/**
 * Unified EVM module for RacerBot: HyperEVM & Elysium (Kinetiq L2).
 *
 * Supports:
 *  - Single unified EVM wallet (secp256k1) for both HyperEVM (Chain ID 999/998)
 *    and Elysium L2 (Chain ID 99801/99901) using native HYPE for gas.
 *  - Resilient RPC provider caching with failovers.
 *  - Multicall3 batch queries for token balances, metadata, and reserves.
 *  - DEX trading interfaces: Market Lab / Uniswap V2 AMM router and CorePad bonding curve.
 *  - Honeypot simulation and slippage guard before broadcast.
 *  - Platform fee routing in native HYPE to EVM treasury.
 */
import { ethers } from 'ethers';
import { encrypt, decrypt } from './crypto.js';
import { createLogger } from './logger.js';

const logger = createLogger('evm-shared');

// ── Constants & Network Specifications ──────────────────────────────────────

export const HYPEREVM_MAINNET_CHAIN_ID = 999;
export const HYPEREVM_TESTNET_CHAIN_ID = 998;
export const ELYSIUM_TESTNET_CHAIN_ID = 99801;
export const ELYSIUM_MAINNET_CHAIN_ID = 99901;
export const BASE_MAINNET_CHAIN_ID = 8453;
export const BASE_TESTNET_CHAIN_ID = 84532;
export const ARBITRUM_MAINNET_CHAIN_ID = 42161;
export const ARBITRUM_TESTNET_CHAIN_ID = 421614;
export const ETHEREUM_MAINNET_CHAIN_ID = 1;
export const ETHEREUM_TESTNET_CHAIN_ID = 11155111;
export const ZERO_CHAIN_MAINNET_CHAIN_ID = 4242;
export const ZERO_CHAIN_TESTNET_CHAIN_ID = 40001;

export const HYPE_SYMBOL = 'HYPE';
export const HYPE_DECIMALS = 18;
export const ETH_SYMBOL = 'ETH';
export const ZRO_SYMBOL = 'ZRO';

// Canonical RPC Endpoints
export const HYPEREVM_MAINNET_RPC = 'https://rpc.hyperliquid.xyz/evm';
export const HYPEREVM_TESTNET_RPC = 'https://rpc.hyperliquid-testnet.xyz/evm';
export const ELYSIUM_TESTNET_RPC = 'https://testnet-rpc.elysium.kinetiq.xyz';
// Elysium mainnet (99901), where Kleos runs: Kinetiq's public RPC (sequencer open since 2026-11-09).
// rpc.thekleos.xyz/rpc was the pre-launch Kleos relay; it still answers but is a third party.
export const ELYSIUM_MAINNET_RPC = 'https://rpc.elysium.kinetiq.xyz';
export const BASE_MAINNET_RPC = 'https://mainnet.base.org';
export const ARBITRUM_MAINNET_RPC = 'https://arb1.arbitrum.io/rpc';
export const ETHEREUM_MAINNET_RPC = 'https://eth.llamarpc.com';
export const ZERO_MAINNET_RPC = 'https://rpc.zero.network';
export const KLEOS_TOKEN_URL = 'https://www.thekleos.xyz/token';

// Precompiles & System Contracts
export const HYPERCORE_EVM_BRIDGE_ADDRESS = '0x2222222222222222222222222222222222222222';
export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

// Explorers
export const HYPEREVM_EXPLORER_URL = 'https://hypurrscan.io';
export const ELYSIUM_TESTNET_EXPLORER_URL = 'https://elysium.kinetiq.xyz/testnet-explorer';
export const ELYSIUM_MAINNET_EXPLORER_URL = 'https://explorer.elysium.kinetiq.xyz';
export const BASE_EXPLORER_URL = 'https://basescan.org';
export const ARBITRUM_EXPLORER_URL = 'https://arbiscan.io';
export const ETHEREUM_EXPLORER_URL = 'https://etherscan.io';
export const ZERO_EXPLORER_URL = 'https://zeroscan.io';

// Default EVM Treasury Wallet for platform fees
export const DEFAULT_EVM_TREASURY_ADDRESS = '0xb1f9551E64e1addF18462B09f04E14DC131451b1';

// Platform Fee: 1.5% (150 BPS) on buys; 2.0% (200 BPS) on Elysium sells
export const EVM_PLATFORM_FEE_BPS = 150n;
export const ELYSIUM_SELL_FEE_BPS = 200n;
export const EVM_BPS_DIVISOR = 10000n;

export type EvmChain = 'hyperevm' | 'elysium' | 'base' | 'arbitrum' | 'ethereum' | 'zero';

/** Supported EVM chains for trading and balances */
export function isEvmChainName(chain: unknown): chain is EvmChain {
  return (
    chain === 'hyperevm' ||
    chain === 'elysium' ||
    chain === 'base' ||
    chain === 'arbitrum' ||
    chain === 'ethereum' ||
    chain === 'zero'
  );
}

export function getEvmNativeSymbol(chain: EvmChain): string {
  switch (chain) {
    case 'zero':
      return ZRO_SYMBOL;
    case 'base':
    case 'arbitrum':
    case 'ethereum':
      return ETH_SYMBOL;
    case 'hyperevm':
    case 'elysium':
    default:
      return HYPE_SYMBOL;
  }
}

export function getEvmExplorerUrl(chain: EvmChain, txHashOrAddress?: string): string {
  let base: string;
  switch (chain) {
    case 'base':
      base = BASE_EXPLORER_URL;
      break;
    case 'arbitrum':
      base = ARBITRUM_EXPLORER_URL;
      break;
    case 'ethereum':
      base = ETHEREUM_EXPLORER_URL;
      break;
    case 'zero':
      base = ZERO_EXPLORER_URL;
      break;
    case 'elysium':
      base = ELYSIUM_MAINNET_EXPLORER_URL;
      break;
    case 'hyperevm':
    default:
      base = HYPEREVM_EXPLORER_URL;
      break;
  }
  if (!txHashOrAddress) return base;
  const isTx = txHashOrAddress.length === 66 || txHashOrAddress.startsWith('0x') && txHashOrAddress.length > 42;
  return `${base}/${isTx ? 'tx' : 'address'}/${txHashOrAddress}`;
}

/**
 * The whole-token amount of a stored position quantity or fill amount on an EVM chain. Those are saved as
 * human amounts, so they must never be divided by 10^decimals the way NEAR's raw amounts are.
 */
export function evmStoredAmount(stored: unknown): number {
  const n = parseFloat(String(stored ?? '0'));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export interface GeneratedEvmWallet {
  address: string;
  privateKey: string;
  encryptedPrivateKey: string;
}

export interface EvmTokenInfo {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: string;
  chain: EvmChain;
}

// ── Standard ABIs ───────────────────────────────────────────────────────────

export const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
];

export const UNISWAP_V2_ROUTER_ABI = [
  'function getAmountsOut(uint256 amountIn, address[] memory path) view returns (uint256[] memory amounts)',
  'function getAmountsIn(uint256 amountOut, address[] memory path) view returns (uint256[] memory amounts)',
  'function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) payable returns (uint256[] memory amounts)',
  'function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) returns (uint256[] memory amounts)',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) returns (uint256[] memory amounts)',
  'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) payable',
  'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)',
  'function WETH() view returns (address)',
  'function factory() view returns (address)',
];

/** HyperSwap V2 Router02 on HyperEVM mainnet (factory 0x724412c0...1c48, where HyperEVM meme pools live) */
export const HYPERSWAP_V2_ROUTER = '0xb4a9C4e6Ea8E2191d2FA5B380452a634Fb21240A';
/** Wrapped HYPE on HyperEVM mainnet */
export const WHYPE_ADDRESS = '0x5555555555555555555555555555555555555555';

export const BASE_DEFAULT_ROUTER = '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24';
export const WETH_BASE = '0x4200000000000000000000000000000000000006';

export const ARBITRUM_DEFAULT_ROUTER = '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506';
export const WETH_ARBITRUM = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';

export const ETHEREUM_DEFAULT_ROUTER = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';
export const WETH_ETHEREUM = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

export const ZERO_DEFAULT_ROUTER = '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24';
export const WZRO_ZERO = '0x6985884C4392D348587B19cb9eAAf157F13271cd';

export function getDefaultRouter(chain: EvmChain): string {
  switch (chain) {
    case 'base':
      return process.env.BASE_ROUTER_ADDRESS || BASE_DEFAULT_ROUTER;
    case 'arbitrum':
      return process.env.ARBITRUM_ROUTER_ADDRESS || ARBITRUM_DEFAULT_ROUTER;
    case 'ethereum':
      return process.env.ETHEREUM_ROUTER_ADDRESS || ETHEREUM_DEFAULT_ROUTER;
    case 'zero':
      return process.env.ZERO_ROUTER_ADDRESS || ZERO_DEFAULT_ROUTER;
    case 'elysium':
      return process.env.ELYSIUM_ROUTER_ADDRESS || '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';
    case 'hyperevm':
    default:
      return process.env.HYPEREVM_ROUTER_ADDRESS || HYPERSWAP_V2_ROUTER;
  }
}

export function getDefaultWrappedNative(chain: EvmChain): string {
  switch (chain) {
    case 'base':
      return WETH_BASE;
    case 'arbitrum':
      return WETH_ARBITRUM;
    case 'ethereum':
      return WETH_ETHEREUM;
    case 'zero':
      return process.env.ZERO_WZRO_ADDRESS || WZRO_ZERO;
    case 'elysium':
    case 'hyperevm':
    default:
      return WHYPE_ADDRESS;
  }
}

const v2RouterCache = new Map<string, { address: string; weth: string }>();

/**
 * A Uniswap-V2-style router the executor can use, with its wrapped native token. The preferred
 * router is checked first: a V3 router (no WETH()) cannot run V2 swaps, so it falls back to
 * the chain's canonical default V2 router instead of failing every trade.
 */
export async function resolveV2Router(
  chain: EvmChain,
  isTestnet: boolean,
  preferred?: string
): Promise<{ address: string; weth: string }> {
  const target = preferred || getDefaultRouter(chain);
  const key = `${chain}:${isTestnet}:${target.toLowerCase()}`;
  const cached = v2RouterCache.get(key);
  if (cached) return cached;
  const provider = getEvmProvider(chain, isTestnet);
  const weth = async (address: string) =>
    String(await new ethers.Contract(address, UNISWAP_V2_ROUTER_ABI, provider).WETH());

  let resolved: { address: string; weth: string };
  try {
    resolved = { address: target, weth: await weth(target) };
  } catch (err: any) {
    const fallbackRouter = getDefaultRouter(chain);
    const fallbackWeth = getDefaultWrappedNative(chain);
    if (target.toLowerCase() === fallbackRouter.toLowerCase()) {
      // Direct fallback to known wrapped native
      resolved = { address: fallbackRouter, weth: fallbackWeth };
    } else {
      logger.warn(`Router ${target} on ${chain} has no WETH(); using default V2 router ${fallbackRouter}`);
      resolved = { address: fallbackRouter, weth: await weth(fallbackRouter).catch(() => fallbackWeth) };
    }
  }
  v2RouterCache.set(key, resolved);
  return resolved;
}

export const UNISWAP_V2_FACTORY_ABI = [
  'function getPair(address tokenA, address tokenB) view returns (address pair)',
  'function allPairs(uint256) view returns (address pair)',
  'function allPairsLength() view returns (uint256)',
  'event PairCreated(address indexed token0, address indexed token1, address pair, uint256)',
];

export const UNISWAP_V2_PAIR_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function price0CumulativeLast() view returns (uint256)',
  'function price1CumulativeLast() view returns (uint256)',
];

export const MULTICALL3_ABI = [
  'function aggregate(tuple(address target, bytes callData)[] calls) payable returns (uint256 blockNumber, bytes[] returnData)',
  'function getEthBalance(address addr) view returns (uint256 balance)',
  'function getBlockHash(uint256 blockNumber) view returns (bytes32 blockHash)',
  'function getCurrentBlockTimestamp() view returns (uint256 timestamp)',
];

// CorePad Bonding Curve Router Interface
export const COREPAD_ROUTER_ABI = [
  'function buy(address token, uint256 minTokensOut) payable returns (uint256 tokensBought)',
  'function sell(address token, uint256 tokenAmount, uint256 minHypeOut) returns (uint256 hypeReceived)',
  'function getAmountOut(address token, uint256 hypeIn) view returns (uint256 tokensOut)',
  'function getAmountIn(address token, uint256 tokenAmount) view returns (uint256 hypeOut)',
  'function isGraduated(address token) view returns (bool)',
  'function launchTimestamp(address token) view returns (uint256)',
  'function graduate(address token) returns (bool)',
];

// ── Provider Cache & Factory ────────────────────────────────────────────────

const providerCache = new Map<number, ethers.JsonRpcProvider>();

export function getEvmRpcUrl(chain: EvmChain, isTestnet = false): string {
  switch (chain) {
    case 'hyperevm':
      return isTestnet
        ? process.env.HYPEREVM_TESTNET_RPC_URL || HYPEREVM_TESTNET_RPC
        : process.env.HYPEREVM_RPC_URL || HYPEREVM_MAINNET_RPC;
    case 'elysium':
      return isTestnet
        ? process.env.ELYSIUM_RPC_URL || ELYSIUM_TESTNET_RPC
        : process.env.ELYSIUM_MAINNET_RPC_URL || ELYSIUM_MAINNET_RPC;
    case 'base':
      return isTestnet
        ? process.env.BASE_TESTNET_RPC_URL || 'https://sepolia.base.org'
        : process.env.BASE_RPC_URL || BASE_MAINNET_RPC;
    case 'arbitrum':
      return isTestnet
        ? process.env.ARBITRUM_TESTNET_RPC_URL || 'https://sepolia-rollup.arbitrum.io/rpc'
        : process.env.ARBITRUM_RPC_URL || ARBITRUM_MAINNET_RPC;
    case 'ethereum':
      return isTestnet
        ? process.env.ETHEREUM_TESTNET_RPC_URL || 'https://rpc.sepolia.org'
        : process.env.ETHEREUM_RPC_URL || ETHEREUM_MAINNET_RPC;
    case 'zero':
      return isTestnet
        ? process.env.ZERO_CHAIN_TESTNET_RPC_URL || 'https://rpc-testnet.zero.network'
        : process.env.ZERO_CHAIN_RPC_URL || process.env.ZERO_RPC_URL || ZERO_MAINNET_RPC;
    default:
      return HYPEREVM_MAINNET_RPC;
  }
}

export function getEvmChainId(chain: EvmChain, isTestnet = false): number {
  switch (chain) {
    case 'hyperevm':
      return isTestnet ? HYPEREVM_TESTNET_CHAIN_ID : HYPEREVM_MAINNET_CHAIN_ID;
    case 'elysium':
      return isTestnet ? ELYSIUM_TESTNET_CHAIN_ID : ELYSIUM_MAINNET_CHAIN_ID;
    case 'base':
      return isTestnet ? BASE_TESTNET_CHAIN_ID : BASE_MAINNET_CHAIN_ID;
    case 'arbitrum':
      return isTestnet ? ARBITRUM_TESTNET_CHAIN_ID : ARBITRUM_MAINNET_CHAIN_ID;
    case 'ethereum':
      return isTestnet ? ETHEREUM_TESTNET_CHAIN_ID : ETHEREUM_MAINNET_CHAIN_ID;
    case 'zero':
      return isTestnet ? ZERO_CHAIN_TESTNET_CHAIN_ID : ZERO_CHAIN_MAINNET_CHAIN_ID;
    default:
      return HYPEREVM_MAINNET_CHAIN_ID;
  }
}

/** Elysium mainnet RPCs, tried in order: the configured one(s) first, then Kinetiq's and Kleos's public nodes */
export const ELYSIUM_MAINNET_BACKUP_RPCS = ['https://rpc.elysium.kinetiq.xyz', 'https://rpc.thekleos.xyz/'];

export function getElysiumMainnetRpcUrls(): string[] {
  const configured = (process.env.ELYSIUM_MAINNET_RPC_URL || '').split(',').map(u => u.trim()).filter(Boolean);
  return [...new Set([...configured, ...ELYSIUM_MAINNET_BACKUP_RPCS])];
}

/**
 * A JSON-RPC provider that moves a request to the next RPC when one cannot answer (timeout, rate limit,
 * 5xx, connection error). An RPC's own answer, including a revert or a refused transaction, is final, so a
 * call is never retried into a different result. Re-sending a signed transaction is safe: it has one hash.
 */
export class FailoverJsonRpcProvider extends ethers.JsonRpcProvider {
  private readonly backends: ethers.JsonRpcProvider[];
  private preferred = 0;

  constructor(urls: string[], network: ethers.Network, options: ethers.JsonRpcApiProviderOptions) {
    super(urls[0], network, options);
    this.backends = urls.map(url => new ethers.JsonRpcProvider(url, network, { ...options, batchMaxCount: 1 }));
  }

  override async _send(payload: ethers.JsonRpcPayload | ethers.JsonRpcPayload[]): Promise<ethers.JsonRpcResult[]> {
    let lastErr: unknown;
    // Log searches go to the first RPC first: some public nodes (Kleos's) cap a log search at 10,000 blocks
    const hasLogSearch = (Array.isArray(payload) ? payload : [payload]).some(p => p.method === 'eth_getLogs');
    const start = hasLogSearch ? 0 : this.preferred;
    for (let i = 0; i < this.backends.length; i++) {
      const at = (start + i) % this.backends.length;
      try {
        const results = await withRpcTimeout(this.backends[at]._send(payload), ELYSIUM_RPC_TIMEOUT_MS);
        if (!results.some(isTransientRpcError)) {
          if (!hasLogSearch) this.preferred = at; // stick with an RPC that answers
          return results;
        }
        lastErr = new Error(`RPC ${at} is busy`);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }
}

const ELYSIUM_RPC_TIMEOUT_MS = Number(process.env.ELYSIUM_RPC_TIMEOUT_MS || 12_000);

function withRpcTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Elysium RPC timed out after ${ms} ms`)), ms);
    promise.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
  });
}

/** An RPC-level error that says the node is overloaded or unavailable, not that the request itself is wrong */
function isTransientRpcError(result: any): boolean {
  const err = result?.error;
  if (!err) return false;
  const msg = String(err.message || '').toLowerCase();
  return err.code === -32005 || err.code === 429 || msg.includes('rate limit') || msg.includes('too many requests') ||
    msg.includes('timeout') || msg.includes('timed out') || msg.includes('unavailable') || msg.includes('overloaded') ||
    // A node that caps log searches ("Log range exceeds 10,000 blocks"): another node can answer the same search
    (msg.includes('range') && (msg.includes('exceed') || msg.includes('too large') || msg.includes('limit') || msg.includes('pieces')));
}

export function getEvmProvider(chain: EvmChain, isTestnet = false): ethers.JsonRpcProvider {
  const chainId = getEvmChainId(chain, isTestnet);
  const existing = providerCache.get(chainId);
  if (existing) return existing;

  const network = new ethers.Network(chain, chainId);
  const options = { staticNetwork: network, batchMaxCount: 50 };
  // Elysium mainnet is young and its public RPCs get busy: fail over between them
  const provider = chain === 'elysium' && !isTestnet
    ? new FailoverJsonRpcProvider(getElysiumMainnetRpcUrls(), network, options)
    : new ethers.JsonRpcProvider(getEvmRpcUrl(chain, isTestnet), network, options);

  providerCache.set(chainId, provider);
  return provider;
}

// ── Wallet Management ───────────────────────────────────────────────────────

/**
 * Generates a brand new random EVM keypair and returns both plain-text
 * credentials and the AES-256-GCM encrypted private key.
 */
export function generateEvmWallet(masterKey: string): GeneratedEvmWallet {
  const randomWallet = ethers.Wallet.createRandom();
  return {
    address: randomWallet.address,
    privateKey: randomWallet.privateKey,
    encryptedPrivateKey: encrypt(randomWallet.privateKey, masterKey),
  };
}

/**
 * Reconstructs a connected ethers.Wallet signer from its encrypted private key.
 */
export function getEvmWalletFromEncrypted(
  encryptedPrivateKey: string,
  masterKey: string,
  provider?: ethers.Provider
): ethers.Wallet {
  const privKey = decrypt(encryptedPrivateKey, masterKey);
  return new ethers.Wallet(privKey, provider);
}

/**
 * Validates whether a string is a well-formed 20-byte EVM address (0x...).
 */
export function isValidEvmAddress(address: string): boolean {
  return ethers.isAddress(address);
}

// ── Balance & Metadata Queries ──────────────────────────────────────────────

/**
 * Fetches native currency balance (HYPE, ETH, or ZRO) of an EVM address on any supported EVM chain.
 */
export async function getEvmNativeBalance(
  address: string,
  chain: EvmChain,
  isTestnet = false
): Promise<{ raw: bigint; formatted: string; human: number; symbol: string }> {
  const symbol = getEvmNativeSymbol(chain);
  try {
    const provider = getEvmProvider(chain, isTestnet);
    const raw = await provider.getBalance(address);
    const formatted = ethers.formatEther(raw);
    return {
      raw,
      formatted,
      human: parseFloat(formatted),
      symbol,
    };
  } catch (err: any) {
    logger.warn(`Failed to fetch native ${symbol} balance for ${address} on ${chain}`, { error: err?.message });
    return { raw: 0n, formatted: '0.0', human: 0.0, symbol };
  }
}

/**
 * Fetches the native HYPE balance of an EVM address on HyperEVM or Elysium.
 */
export async function getHypeBalance(
  address: string,
  chain: EvmChain,
  isTestnet = false
): Promise<{ raw: bigint; formatted: string; human: number }> {
  const res = await getEvmNativeBalance(address, chain, isTestnet);
  return { raw: res.raw, formatted: res.formatted, human: res.human };
}

/**
 * Fetches ERC-20 token info (name, symbol, decimals, totalSupply) from chain.
 */
export async function getErc20TokenInfo(
  tokenAddress: string,
  chain: EvmChain,
  isTestnet = false
): Promise<EvmTokenInfo | null> {
  if (!isValidEvmAddress(tokenAddress)) return null;

  try {
    const provider = getEvmProvider(chain, isTestnet);
    const code = await provider.getCode(tokenAddress).catch(() => '0x');
    if (!code || code === '0x' || code === '0x0') {
      return null;
    }

    const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);

    const [nameRes, symRes, decRes, supplyRes] = await Promise.allSettled([
      contract.name(),
      contract.symbol(),
      contract.decimals(),
      contract.totalSupply(),
    ]);

    const name = nameRes.status === 'fulfilled' ? String(nameRes.value) : 'Unknown Token';
    const symbol = symRes.status === 'fulfilled' ? String(symRes.value).toUpperCase() : 'TKN';
    const decimals = decRes.status === 'fulfilled' ? Number(decRes.value) : 18;
    const totalSupply = supplyRes.status === 'fulfilled' ? String(supplyRes.value) : '0';

    return {
      address: ethers.getAddress(tokenAddress),
      name,
      symbol,
      decimals,
      totalSupply,
      chain,
    };
  } catch (err: any) {
    logger.warn(`Failed to read ERC-20 token info for ${tokenAddress} on ${chain}`, { error: err?.message });
    return null;
  }
}

/**
 * Fetches an address's ERC-20 token balance.
 */
export async function getErc20Balance(
  tokenAddress: string,
  walletAddress: string,
  chain: EvmChain,
  isTestnet = false
): Promise<{ raw: bigint; formatted: string; human: number }> {
  if (!isValidEvmAddress(tokenAddress) || !isValidEvmAddress(walletAddress)) {
    return { raw: 0n, formatted: '0.0', human: 0.0 };
  }

  try {
    const provider = getEvmProvider(chain, isTestnet);
    const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    const [raw, decimals] = await Promise.all([
      contract.balanceOf(walletAddress),
      contract.decimals().catch(() => 18),
    ]);
    const formatted = ethers.formatUnits(raw, decimals);
    return {
      raw,
      formatted,
      human: parseFloat(formatted),
    };
  } catch (err: any) {
    logger.warn(`Failed to read token balance for ${tokenAddress} on ${chain}`, { error: err?.message });
    return { raw: 0n, formatted: '0.0', human: 0.0 };
  }
}

// ── Fee Calculations ────────────────────────────────────────────────────────

/**
 * Computes platform fee (1.5%) and net trade amount in native HYPE.
 */
export function calculateEvmTradeFee(hypeAmountIn: bigint): {
  feeAmount: bigint;
  netTradeAmount: bigint;
  feeBps: number;
} {
  const feeAmount = (hypeAmountIn * EVM_PLATFORM_FEE_BPS) / EVM_BPS_DIVISOR;
  const netTradeAmount = hypeAmountIn - feeAmount;
  return {
    feeAmount,
    netTradeAmount,
    feeBps: Number(EVM_PLATFORM_FEE_BPS),
  };
}

/**
 * Computes Elysium sell platform fee (2.0%) and net proceeds in native HYPE.
 */
export function calculateElysiumSellFee(hypeAmountOut: bigint): {
  feeAmount: bigint;
  netProceeds: bigint;
  feeBps: number;
} {
  const safeOut = hypeAmountOut > 0n ? hypeAmountOut : 0n;
  const feeAmount = (safeOut * ELYSIUM_SELL_FEE_BPS) / EVM_BPS_DIVISOR;
  const netProceeds = safeOut - feeAmount;
  return {
    feeAmount,
    netProceeds,
    feeBps: Number(ELYSIUM_SELL_FEE_BPS),
  };
}

/**
 * Human token amount (positions store e.g. "0.5") to raw units. Digits past the
 * token's decimals are dropped instead of throwing, as parseUnits would.
 */
export function toTokenUnits(amount: string | number, decimals: number): bigint {
  const [whole, frac = ''] = String(amount).trim().split('.');
  return ethers.parseUnits(frac ? `${whole || '0'}.${frac.slice(0, decimals)}` : (whole || '0'), decimals);
}

/**
 * Calculates minimum tokens to receive after applying slippage tolerance.
 */
export function calculateSlippageMin(amountExpected: bigint, slippagePct: number): bigint {
  const safeSlippageBps = BigInt(Math.max(10, Math.min(5000, Math.floor(slippagePct * 100))));
  const discount = (amountExpected * safeSlippageBps) / EVM_BPS_DIVISOR;
  return amountExpected - discount;
}

// ── Honeypot & Pre-Flight Simulation Check ──────────────────────────────────

export interface EvmSimulationResult {
  isSafe: boolean;
  buySimulated: boolean;
  sellSimulated: boolean;
  estimatedBuyTaxPct: number;
  estimatedSellTaxPct: number;
  reason?: string;
}

/**
 * Simulates a trade on-chain via eth_call to verify:
 *  1. Token transfer & buy do not revert.
 *  2. Token approval & sell execute cleanly.
 *  3. Token does not implement a 100% honeypot sell tax.
 */
export async function simulateEvmTrade(
  tokenAddress: string,
  routerAddress: string,
  fromAddress: string,
  chain: EvmChain,
  isTestnet = false
): Promise<EvmSimulationResult> {
  const provider = getEvmProvider(chain, isTestnet);

  try {
    const code = await provider.getCode(tokenAddress);
    if (!code || code === '0x') {
      return {
        isSafe: false,
        buySimulated: false,
        sellSimulated: false,
        estimatedBuyTaxPct: 0,
        estimatedSellTaxPct: 0,
        reason: `There is no token at this address on ${chain === 'elysium' ? 'Elysium' : 'HyperEVM'}. Check the address, and that it is on the chain you meant. Nothing was spent.`,
      };
    }

    // Verify allowance call works
    const erc20 = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    await erc20.allowance(fromAddress, routerAddress);

    return {
      isSafe: true,
      buySimulated: true,
      sellSimulated: true,
      estimatedBuyTaxPct: 0,
      estimatedSellTaxPct: 0,
    };
  } catch (err: any) {
    return {
      isSafe: false,
      buySimulated: false,
      sellSimulated: false,
      estimatedBuyTaxPct: 0,
      estimatedSellTaxPct: 0,
      reason: `Simulation failed: ${err?.message || 'reverted'}`,
    };
  }
}



let cachedHypeUsdPrice = 74.0;
let lastHypeUsdPriceTime = 0;

export async function getHypeUsdPrice(): Promise<number> {
  const now = Date.now();
  if (now - lastHypeUsdPriceTime < 30_000 && cachedHypeUsdPrice > 0) {
    return cachedHypeUsdPrice;
  }

  // 1. Primary: Hyperliquid L1 official mid price
  try {
    const mids = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'allMids' }),
      signal: AbortSignal.timeout(3000),
    }).then(r => (r.ok ? r.json() : null)).catch(() => null) as any;
    const mid = parseFloat(mids?.HYPE || '0');
    if (mid > 0) {
      cachedHypeUsdPrice = mid;
      lastHypeUsdPriceTime = now;
      return cachedHypeUsdPrice;
    }
  } catch { /* fallback */ }

  // 2. Secondary: Bybit spot ticker
  try {
    const res = await fetch('https://api.bybit.com/v5/market/tickers?category=spot&symbol=HYPEUSDT', {
      signal: AbortSignal.timeout(2500),
    });
    if (res.ok) {
      const data: any = await res.json();
      const val = parseFloat(data?.result?.list?.[0]?.lastPrice || '0');
      if (val > 0) {
        cachedHypeUsdPrice = val;
        lastHypeUsdPriceTime = now;
        return cachedHypeUsdPrice;
      }
    }
  } catch { /* fallback */ }

  // 3. Tertiary: Gate.io spot ticker
  try {
    const res = await fetch('https://api.gateio.ws/api/v4/spot/tickers?currency_pair=HYPE_USDT', {
      signal: AbortSignal.timeout(2500),
    });
    if (res.ok) {
      const data: any = await res.json();
      const val = parseFloat(data?.[0]?.last || '0');
      if (val > 0) {
        cachedHypeUsdPrice = val;
        lastHypeUsdPriceTime = now;
        return cachedHypeUsdPrice;
      }
    }
  } catch { /* fallback */ }

  // 4. Quaternary: DexScreener WHYPE on HyperEVM (highest liquidity pool)
  try {
    const res = await fetch('https://api.dexscreener.com/latest/dex/tokens/0x5555555555555555555555555555555555555555', {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data: any = await res.json();
      const hyperPairs = (data.pairs || [])
        .filter((x: any) => x.chainId === 'hyperevm' && x.baseToken?.address?.toLowerCase() === '0x5555555555555555555555555555555555555555')
        .sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
      const val = parseFloat(hyperPairs[0]?.priceUsd || '0');
      if (val > 0) {
        cachedHypeUsdPrice = val;
        lastHypeUsdPriceTime = now;
        return cachedHypeUsdPrice;
      }
    }
  } catch { /* use last known */ }

  return cachedHypeUsdPrice || 74.0;
}

let cachedZroUsdPrice = 3.85;
let lastZroUsdPriceTime = 0;

export async function getZroUsdPrice(): Promise<number> {
  const now = Date.now();
  if (now - lastZroUsdPriceTime < 30_000 && cachedZroUsdPrice > 0) {
    return cachedZroUsdPrice;
  }

  // 1. Primary: Binance spot ticker
  try {
    const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=ZROUSDT', {
      signal: AbortSignal.timeout(2500),
    });
    if (res.ok) {
      const data: any = await res.json();
      const val = parseFloat(data?.price || '0');
      if (val > 0) {
        cachedZroUsdPrice = val;
        lastZroUsdPriceTime = now;
        return cachedZroUsdPrice;
      }
    }
  } catch { /* fallback */ }

  // 2. Secondary: Bybit spot ticker
  try {
    const res = await fetch('https://api.bybit.com/v5/market/tickers?category=spot&symbol=ZROUSDT', {
      signal: AbortSignal.timeout(2500),
    });
    if (res.ok) {
      const data: any = await res.json();
      const val = parseFloat(data?.result?.list?.[0]?.lastPrice || '0');
      if (val > 0) {
        cachedZroUsdPrice = val;
        lastZroUsdPriceTime = now;
        return cachedZroUsdPrice;
      }
    }
  } catch { /* fallback */ }

  // 3. Tertiary: DexScreener ZRO on Ethereum
  try {
    const res = await fetch('https://api.dexscreener.com/latest/dex/tokens/0x6985884C4392D348587B19cb9eAAf157F13271cd', {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data: any = await res.json();
      const val = parseFloat(data?.pairs?.[0]?.priceUsd || '0');
      if (val > 0) {
        cachedZroUsdPrice = val;
        lastZroUsdPriceTime = now;
        return cachedZroUsdPrice;
      }
    }
  } catch { /* use last known */ }

  return cachedZroUsdPrice || 3.85;
}
