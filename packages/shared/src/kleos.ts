/**
 * Kleos launchpad on Elysium mainnet (chain 99901): routing, quotes and the HyperEVM inbox.
 *
 * Elysium is an Arbitrum Orbit rollup settling on HyperEVM. Its public sequencer opened on 2026-11-09, so a
 * signed Elysium transaction is sent straight to the Elysium RPC and runs in seconds. The HyperEVM delayed
 * inbox is still used for one thing: a retryable ticket (createRetryableTicket) that pays for a buy from
 * HyperEVM HYPE when the wallet has no HYPE on Elysium. A ticket runs as the *aliased* sender, so it can buy
 * (coins go to an explicit recipient) but never move the user's coins. ELYSIUM_SEND_MODE=inbox puts signed
 * transactions back through sendL2Message, the pre-launch path. Addresses come from Kleos's deployments/99901.json.
 */
import { ethers } from 'ethers';
import {
  ASCEND,
  ASCEND_TOKEN_URL,
  encodeAscendBuy,
  encodeAscendSell,
  quoteAscend,
  resolveAscendRoute,
  findElysiumV4Route,
  type AscendRoute,
} from './ascend.js';
import {
  MONTRA,
  MONTRA_TOKEN_URL,
  encodeMontraBuy,
  encodeMontraSell,
  quoteMontra,
  resolveMontraRoute,
  type MontraRoute,
} from './montra.js';

export const KLEOS = {
  launchpad: '0x6E3AFDdc49f5D43858a1FDD48184426deD11029b',
  swapRouter: '0x03c291D55Cc178B8Fc3e20607125b8F6e9D12687',
  quoterV2: '0x18C139815b72f06a89e5e7f811427CD96b61Caff',
  whype: '0x0269031ace34a7821e9D9980d087c35cE7c19EEF',
  v4Router: '0xbA0b2699A9d21a2a138C494db82DFD2fFce3344c',
  v5Router: '0xB15D5A0159Fc11BF1a1F9E383b0DE76440Ec6FC3',
  pairRouter: '0x819741D02baFa76f0eEDF9EE8eDAb2a3EcCD37de',
  pairLauncher: '0x3AD2Ea50c1BFfBDE6FA47E219D2e1e838B22Cb77',
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
  /** Buys and sells coins paired against a quote token whose HYPE pool sits on another pool manager */
  hopRouter: '0x9428d860fE65C585704CCA1C3F2F02eecF12ee0d',
} as const;

/**
 * Kleos's v5 launchers, newest first (from the Kleos app's deployments/99901.json). Each has its own router and
 * pool manager; a coin is traded on the router of the launcher that made it. The second one went live with
 * Elysium's public launch on 2026-11-09.
 */
export const KLEOS_V5_DEPLOYMENTS = [
  {
    launcher: '0x1c24B6d08220c9584DF1e3D8A15AD7B0D9BC2E6A',
    router: '0x15c7Ee481CE8c57461bC8620adC5Fb784374c240',
    poolManager: '0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1',
    hopRouter: '0xfd5d7bf62A315495a59715C333bd1311a3A1f7ed',
  },
  {
    launcher: '0x2dA68edFF4588A77B55A829689C382F2acB39502',
    router: KLEOS.v5Router,
    poolManager: '0xb308B5df891c300a5f5a5b8fdBC30108bA842490',
    hopRouter: KLEOS.hopRouter,
  },
] as const;

export interface KleosPoolKey {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
}

/**
 * The HYPE pool of each quote token a hop router can route through (from the Kleos app, which names them per
 * quote token). Coins paired against these trade HYPE -> quote -> coin in one call.
 */
export const KLEOS_HOP_KEYS: Record<string, KleosPoolKey> = {
  // BLOB (its HYPE pool is on ElysPump)
  '0x9a9815af521149e8d982791703a31bca2f95f534': {
    currency0: '0x0000000000000000000000000000000000000000',
    currency1: '0x9a9815Af521149E8D982791703A31bca2F95f534',
    fee: 0,
    tickSpacing: 200,
    hooks: '0xe11cafa5901b0aab51eb78251488400f9e4320cc',
  },
  // KNTQ (Kinetiq; its HYPE pool is a plain Uniswap v4 pool)
  '0xe45a355d9e9cad2ad85f2d03e3ee3102a036acf0': {
    currency0: '0x0000000000000000000000000000000000000000',
    currency1: '0xe45a355d9e9cAd2aD85F2d03E3eE3102A036acF0',
    fee: 10000,
    tickSpacing: 200,
    hooks: '0x0000000000000000000000000000000000000000',
  },
};

/** Quote tokens whose hop runs through their own router for a given v5 router (v5 router -> hop router) */
const KLEOS_QUOTE_HOP_ROUTERS: Record<string, Record<string, string>> = {
  '0xe45a355d9e9cad2ad85f2d03e3ee3102a036acf0': {
    '0x15c7ee481ce8c57461bc8620adc5fb784374c240': '0xb755388a004db8008a1f6e88274090f02fc5ddb3',
  },
};

/** RonsPad (ronspad.fun), the other launchpad on Elysium: its own Uniswap V3, every coin paired with its WHYPE */
export const RONSPAD = {
  padFactory: '0x371811b06bd66c93b46F2F1FfD45b65455A2D2a2',
  v3Factory: '0x24e21E3F2b0bB0C166ec3EAFf1e615aB14cDD85F',
  whype: '0xbA876237B0F021A6c6D852d6c26E107997cC5E81',
} as const;

export const RONSPAD_TOKEN_URL = 'https://ronspad.fun/token?token=';

/** The Elysium mainnet launchpads RacerBot trades, by venue name */
/** `univ4`: any other coin with a Uniswap v4 pool against HYPE on Elysium (launchpads without special support) */
export const ELYSIUM_PAD_VENUES = ['kleos', 'ronspad', 'ascend', 'montra', 'univ4'] as const;
export type ElysiumPadVenue = (typeof ELYSIUM_PAD_VENUES)[number];

export function isElysiumPadVenue(venue: unknown): venue is ElysiumPadVenue {
  return typeof venue === 'string' && (ELYSIUM_PAD_VENUES as readonly string[]).includes(venue);
}

export function elysiumPadName(venue: unknown): string {
  return venue === 'ronspad' ? 'RonsPad' : venue === 'ascend' ? 'Ascend' : venue === 'montra' ? 'Montra' : venue === 'univ4' ? 'Uniswap v4' : 'Kleos';
}

/** The launchpad's own page for a coin */
export function elysiumPadUrl(venue: unknown, address: string): string {
  if (venue === 'ronspad') return `${RONSPAD_TOKEN_URL}${address}`;
  if (venue === 'ascend') return `${ASCEND_TOKEN_URL}${address}`;
  if (venue === 'montra') return `${MONTRA_TOKEN_URL}${address}`;
  if (venue === 'univ4') return `https://dexscreener.com/elysium/${address}`;
  return `https://www.thekleos.xyz/token/${address}`;
}

/** KleosSwap (classic coins) pools all use the 1% fee tier */
export const KLEOS_CLASSIC_POOL_FEE = 10000;

export const ELYSIUM_BRIDGE = {
  childChainId: 99901n,
  inbox: '0xce59f8b65ad41c9dae4c07a0571a39824bd92cff',
  bridge: '0x503d572157113faaad4dbed2647bb10b949216b6',
  arbRetryableTx: '0x000000000000000000000000000000000000006E',
  genesisHash: '0x14cd46a8e7cfd201c7a79d307c320213f984e7a2b3297cd4e2c4b514538db600',
} as const;

export const ELYSIUM_MAINNET_EXPLORER_URL = 'https://www.thekleos.xyz/scan';

/** Gas Kleos gives every inbox trade; real use is 150k-360k, and unused gas is refunded */
export const KLEOS_INBOX_TRADE_GAS = 1_000_000n;
export const KLEOS_INBOX_APPROVE_GAS = 100_000n;
const MIN_ELYSIUM_FEE_PER_GAS = 200_000_000n; // 0.2 gwei

export const KLEOS_V4_ROUTER_ABI = [
  'function buy(address token, uint256 minOut, address recipient, uint256 deadline) payable returns (uint256 out)',
  'function sell(address token, uint256 amountIn, uint256 minOut, address recipient, uint256 deadline) returns (uint256 out)',
  'function quoteBuy(address token, uint256 hypeIn) view returns (uint256)',
  'function quoteSell(address token, uint256 amountIn) view returns (uint256)',
  'error Expired()', 'error TooLittleReceived()', 'error UnknownToken()', 'error NoHypeRoute()',
];

export const KLEOS_V5_ROUTER_ABI = [
  'function buy(address token, uint24 hopFee, uint256 minOut, address recipient, uint256 deadline) payable returns (uint256 out)',
  'function sell(address token, uint256 amountIn, uint24 hopFee, uint256 minOut, address recipient, uint256 deadline) returns (uint256 out)',
  'function quoteBuy(address token, uint256 hypeIn, uint24 hopFee) view returns (uint256)',
  'function quoteSell(address token, uint256 amountIn, uint24 hopFee) view returns (uint256)',
  'error Expired()', 'error TooLittleReceived()', 'error UnknownToken()', 'error NoHypeRoute()',
];

export const KLEOS_SWAP_ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
  'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
];

export const KLEOS_QUOTER_V2_ABI = [
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
];

const POOL_KEY = '(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)';
export const KLEOS_HOP_ROUTER_ABI = [
  `function buy(address token, ${POOL_KEY} hop, uint256 minOut, address recipient, uint256 deadline) payable returns (uint256 out)`,
  `function sell(address token, ${POOL_KEY} hop, uint256 amountIn, uint256 minOut, address recipient, uint256 deadline) returns (uint256 out)`,
  `function quoteBuy(address token, ${POOL_KEY} hop, uint256 hypeIn) view returns (uint256 quoteIn, uint256 tokensOut)`,
  `function quoteSell(address token, ${POOL_KEY} hop, uint256 amountIn) view returns (uint256 quoteOut, uint256 hypeOut)`,
  'error Expired()', 'error TooLittleReceived()', 'error WrongHopPool()', 'error ZeroRecipient()',
];

/** RonsPad's PadFactory: native HYPE in and out at the coin's own pool tier. It refuses a minimum of 0. */
export const RONSPAD_FACTORY_ABI = [
  'function buy(address token, uint256 pairIn, uint256 minTokensOut, address recipient, uint256 deadline) payable returns (uint256 tokensOut)',
  'function sell(address token, uint256 tokensIn, uint256 minPairOut, address recipient, bool toNative, uint256 deadline) returns (uint256 pairOut)',
  'function poolOfToken(address token) view returns (address)',
  'function getLaunch(address token) view returns (tuple(address token, address pool, address creator, address feeRecipient, bool tokenIsToken0, int24 tickLower, int24 tickUpper, uint128 liquidity, uint64 createdAt, uint64 lastBurnAt, uint256 creatorFees, uint256 creatorFeesToken, uint256 burned, uint96 startMcap, uint24 fee, uint16 buybackBps, uint16 dividendBps, uint16 liquidityBps, uint16 coinToDeadBps))',
];

const V3_POOL_SLOT0_ABI = ['function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)'];

export const KLEOS_COIN_ABI = [
  'function maxWallet() view returns (uint256)',
  'error MaxWalletExceeded()',
];

export const MULTICALL3_VALUE_ABI = [
  'function aggregate3Value((address target, bool allowFailure, uint256 value, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
];

export const ELYSIUM_INBOX_ABI = [
  'function createRetryableTicket(address to, uint256 l2CallValue, uint256 maxSubmissionCost, address excessFeeRefundAddress, address callValueRefundAddress, uint256 gasLimit, uint256 maxFeePerGas, bytes data) payable returns (uint256)',
  'function depositEth() payable returns (uint256)',
  'function sendL2Message(bytes messageData) returns (uint256)',
  'event InboxMessageDelivered(uint256 indexed messageNum, bytes data)',
];

export const ELYSIUM_BRIDGE_ABI = [
  'event MessageDelivered(uint256 indexed messageIndex, bytes32 indexed beforeInboxAcc, address inbox, uint8 kind, address sender, bytes32 messageDataHash, uint256 baseFeeL1, uint64 timestamp)',
];

export const ARB_RETRYABLE_TX_ABI = [
  'event RedeemScheduled(bytes32 indexed ticketId, bytes32 indexed retryTxHash, uint64 indexed sequenceNum, uint64 donatedGas, address gasDonor, uint256 maxRefund, uint256 submissionFeeRefund)',
];

/** Human-readable reasons for the errors Kleos contracts revert with (wording from the Kleos app) */
const KLEOS_ERROR_MESSAGES: Record<string, string> = {
  TooLittleReceived: 'The price moved past your slippage limit, so nothing traded.',
  V4TooLittleReceived: 'The price moved past your slippage limit, so nothing traded.',
  DeadlineReached: 'The order ran after its deadline, so nothing traded.',
  NotEnoughLiquidity: 'This coin’s pool has no HYPE in it to pay for a sell yet, so it can’t be sold right now.',
  PartialFillRejected: 'This coin’s pool does not have enough liquidity for that trade size yet.',
  PastOpening: 'Trading has not opened for this coin yet.',
  Expired: 'The order ran after its deadline, so nothing traded.',
  NoHypeRoute: 'This coin has no HYPE route on Kleos yet.',
  UnknownToken: 'Kleos does not list this coin.',
  MaxWalletExceeded: "In its first minutes no wallet may hold more than this coin's launch-window limit. Buy less, or wait.",
};
const kleosErrorIface = new ethers.Interface([
  ...KLEOS_V4_ROUTER_ABI.filter(f => f.startsWith('error')),
  ...KLEOS_COIN_ABI.filter(f => f.startsWith('error')),
  // Uniswap v4 (Ascend & Montra): the quoter wraps a pool's revert in UnexpectedRevertBytes / UnexpectedRevert
  'error V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived)',
  'error DeadlineReached()',
  'error NotEnoughLiquidity(bytes32 poolId)',
  'error PartialFillRejected()',
  'error PastOpening()',
  'error UnexpectedRevertBytes(bytes revertData)',
  'error UnexpectedRevert(bytes reason)',
]);

export function describeKleosRevert(err: any): string {
  let data: string | undefined = err?.data ?? err?.info?.error?.data ?? err?.error?.data;
  for (let depth = 0; typeof data === 'string' && data.length >= 10 && depth < 3; depth++) {
    let parsed: ethers.ErrorDescription | null = null;
    try { parsed = kleosErrorIface.parseError(data); } catch { /* not a known error */ }
    if (!parsed) break;
    if (parsed.name === 'UnexpectedRevertBytes') { data = parsed.args.revertData; continue; }
    if (parsed.name === 'UnexpectedRevert') { data = parsed.args.reason; continue; }
    if (KLEOS_ERROR_MESSAGES[parsed.name]) return KLEOS_ERROR_MESSAGES[parsed.name];
    break;
  }
  return err?.shortMessage || err?.reason || err?.message || 'reverted';
}

// ── Routing ─────────────────────────────────────────────────────────────────

export type KleosRouteKind = 'classic' | 'v4' | 'v5' | 'pair' | 'hop' | 'ronspad' | 'ascend' | 'montra' | 'univ4';

export interface KleosRoute {
  kind: KleosRouteKind;
  router: string;
  /** v5 only: fee of the hop from HYPE to the coin's quote token; 0 when the coin trades against HYPE */
  hopFee: number;
  /** hop only: the quote token's HYPE pool */
  hop?: KleosPoolKey;
  /** ascend / univ4: the coin's Uniswap v4 pool and, for a USDC or KNTQ Ascend coin, the HYPE pool into its quote */
  ascend?: AscendRoute;
  /** montra only: the coin's launch pool on Montra Markets and optional HYPE hop pool */
  montra?: MontraRoute;
}

const ROUTES: Record<KleosRouteKind, KleosRoute> = {
  v5: { kind: 'v5', router: KLEOS.v5Router, hopFee: 0 },
  v4: { kind: 'v4', router: KLEOS.v4Router, hopFee: 0 },
  pair: { kind: 'pair', router: KLEOS.pairRouter, hopFee: 0 },
  classic: { kind: 'classic', router: KLEOS.swapRouter, hopFee: 0 },
  hop: { kind: 'hop', router: KLEOS.hopRouter, hopFee: 0 },
  ronspad: { kind: 'ronspad', router: RONSPAD.padFactory, hopFee: 0 },
  ascend: { kind: 'ascend', router: ASCEND.universalRouter, hopFee: 0 },
  montra: { kind: 'montra', router: MONTRA.router, hopFee: 0 },
  univ4: { kind: 'univ4', router: ASCEND.universalRouter, hopFee: 0 },
};

type V5Deployment = (typeof KLEOS_V5_DEPLOYMENTS)[number];

/** The v5 deployment whose launcher made a coin, by the board's `launch.v4.v5.launcher` (older board entries name none) */
function v5DeploymentFor(launcher: string | undefined): V5Deployment | null {
  if (!launcher) return KLEOS_V5_DEPLOYMENTS[1];
  return KLEOS_V5_DEPLOYMENTS.find(d => d.launcher.toLowerCase() === launcher.toLowerCase()) ?? null;
}

/**
 * The hop route for a coin paired against `quote`, when a hop router knows that quote's HYPE pool. The router is
 * the quote's own one for this v5 deployment if it has one, else the deployment's (the Kleos app's rule).
 */
function hopRouteFor(quote: string | undefined, deployment: V5Deployment = KLEOS_V5_DEPLOYMENTS[1]): KleosRoute | null {
  const q = quote?.toLowerCase();
  const key = q ? KLEOS_HOP_KEYS[q] : undefined;
  if (!key) return null;
  const router = KLEOS_QUOTE_HOP_ROUTERS[q!]?.[deployment.router.toLowerCase()] ?? deployment.hopRouter;
  return { kind: 'hop', router: ethers.getAddress(router), hopFee: 0, hop: key };
}

/** The RonsPad launch of a coin, or null when PadFactory did not launch it */
export async function getRonsPadLaunch(provider: ethers.Provider, token: string): Promise<{ pool: string; fee: number; tokenIsToken0: boolean } | null> {
  const pad = new ethers.Contract(RONSPAD.padFactory, RONSPAD_FACTORY_ABI, provider);
  const pool: string = await pad.poolOfToken(token);
  if (!pool || pool === ethers.ZeroAddress) return null;
  const launch = await pad.getLaunch(token);
  return { pool, fee: Number(launch.fee), tokenIsToken0: Boolean(launch.tokenIsToken0) };
}

/** HYPE per whole RonsPad coin from its pool's current price (both sides have 18 decimals) */
export async function ronsPadPriceHype(provider: ethers.Provider, launch: { pool: string; tokenIsToken0: boolean }): Promise<number> {
  const [sqrtPriceX96] = await new ethers.Contract(launch.pool, V3_POOL_SLOT0_ABI, provider).slot0();
  const ratio = Number(sqrtPriceX96) / 2 ** 96;
  const token1PerToken0 = ratio * ratio;
  return launch.tokenIsToken0 ? token1PerToken0 : (token1PerToken0 > 0 ? 1 / token1PerToken0 : 0);
}

/**
 * The router the Kleos board's `launch` object implies (the same rules as the Kleos app).
 * Board data is off-chain: confirm it with a quote before trading on it.
 */
export function kleosRouteFromLaunch(launch: any): KleosRoute {
  const v4 = launch?.v4;
  if (!v4) return ROUTES.classic;
  if (v4.v5) {
    const deployment = v5DeploymentFor(v4.v5.launcher);
    if (!deployment) throw new Error(`Unknown Kleos v5 launcher ${v4.v5.launcher}`);
    if (v4.pair && Number(v4.v5.routeFee ?? 0) === 0) {
      // No HYPE hop on the v5 router: a hop router routes HYPE -> quote -> coin when it knows the quote's pool
      const hop = hopRouteFor(v4.v5.quote, deployment);
      if (hop) return hop;
      throw new Error(KLEOS_ERROR_MESSAGES.NoHypeRoute);
    }
    return { kind: 'v5', router: deployment.router, hopFee: Number(v4.v5.routeFee ?? 0) };
  }
  if (v4.pair) {
    if (String(v4.pair.launcher).toLowerCase() !== KLEOS.pairLauncher.toLowerCase()) {
      throw new Error(`Unknown Kleos pair launcher ${v4.pair.launcher}`);
    }
    return ROUTES.pair;
  }
  return ROUTES.v4;
}

export async function quoteKleos(
  provider: ethers.Provider,
  route: KleosRoute,
  token: string,
  side: 'buy' | 'sell',
  amountIn: bigint,
  /** RonsPad sells: the seller, whose approval lets the sale be simulated exactly */
  from?: string
): Promise<bigint> {
  if (route.kind === 'hop') {
    const hop = new ethers.Contract(route.router, KLEOS_HOP_ROUTER_ABI, provider);
    const [, out] = side === 'buy' ? await hop.quoteBuy(token, route.hop, amountIn) : await hop.quoteSell(token, route.hop, amountIn);
    return out;
  }
  if (route.kind === 'ronspad') return quoteRonsPad(provider, token, side, amountIn, from);
  if (route.kind === 'ascend' || route.kind === 'univ4') return quoteAscend(provider, route.ascend!, token, side, amountIn);
  if (route.kind === 'montra') return quoteMontra(provider, route.montra!, token, side, amountIn);
  if (route.kind === 'classic') {
    const quoter = new ethers.Contract(KLEOS.quoterV2, KLEOS_QUOTER_V2_ABI, provider);
    const [tokenIn, tokenOut] = side === 'buy' ? [KLEOS.whype, token] : [token, KLEOS.whype];
    const [out] = await quoter.quoteExactInputSingle.staticCall({ tokenIn, tokenOut, amountIn, fee: KLEOS_CLASSIC_POOL_FEE, sqrtPriceLimitX96: 0 });
    return out;
  }
  const fn = side === 'buy' ? 'quoteBuy' : 'quoteSell';
  if (route.kind === 'v5') {
    return await new ethers.Contract(route.router, KLEOS_V5_ROUTER_ABI, provider)[fn](token, amountIn, route.hopFee);
  }
  return await new ethers.Contract(route.router, KLEOS_V4_ROUTER_ABI, provider)[fn](token, amountIn);
}

/**
 * RonsPad has no quoter: a buy is simulated on PadFactory from a funded throwaway address. A sell is
 * simulated from the seller when their approval allows it, else estimated from the pool's price
 * after its tier (price impact is then left to the slippage limit).
 */
async function quoteRonsPad(provider: ethers.Provider, token: string, side: 'buy' | 'sell', amountIn: bigint, from?: string): Promise<bigint> {
  const pad = new ethers.Interface(RONSPAD_FACTORY_ABI);
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const send = (provider as any).send?.bind(provider);
  if (side === 'buy' && send) {
    const sim = '0x000000000000000000000000000000000000bEEF';
    const data = pad.encodeFunctionData('buy', [token, amountIn, 1n, sim, deadline]);
    const raw = await send('eth_call', [
      { from: sim, to: RONSPAD.padFactory, data, value: ethers.toQuantity(amountIn) },
      'latest',
      { [sim]: { balance: ethers.toQuantity(amountIn + 10n ** 18n) } },
    ]);
    return pad.decodeFunctionResult('buy', raw)[0];
  }
  if (side === 'sell' && from && send) {
    try {
      const data = pad.encodeFunctionData('sell', [token, amountIn, 1n, from, true, deadline]);
      const raw = await send('eth_call', [{ from, to: RONSPAD.padFactory, data }, 'latest']);
      return pad.decodeFunctionResult('sell', raw)[0];
    } catch { /* not approved yet: estimate below */ }
  }
  const launch = await getRonsPadLaunch(provider, token);
  if (!launch) throw new Error('RonsPad did not launch this coin.');
  const price = await ronsPadPriceHype(provider, launch);
  const PRICE_SCALE = 10n ** 18n;
  const priceScaled = BigInt(Math.floor(price * 1e18));
  const gross = side === 'sell' ? (amountIn * priceScaled) / PRICE_SCALE : (priceScaled > 0n ? (amountIn * PRICE_SCALE) / priceScaled : 0n);
  return (gross * BigInt(1_000_000 - launch.fee)) / 1_000_000n;
}

// ── Kleos board ─────────────────────────────────────────────────────────────

const KLEOS_BOARD_URL = 'https://www.thekleos.xyz/api/board';
const KLEOS_BOARD_TTL_MS = 60_000;
let kleosBoard: { at: number; byAddress: Map<string, any> } | null = null;
let kleosBoardRefresh: Promise<void> | null = null;

async function refreshKleosBoard(): Promise<void> {
  const res = await fetch(KLEOS_BOARD_URL, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Kleos board returned ${res.status}`);
  const coins = (await res.json()) as any[];
  if (!Array.isArray(coins)) throw new Error('Kleos board returned an unexpected shape');
  kleosBoard = { at: Date.now(), byAddress: new Map(coins.map(c => [String(c.address).toLowerCase(), c])) };
}

/**
 * The Kleos board entry for a coin (name, symbol, image, price, pool and route data), or null.
 * Kleos lists every coin it launched; DexScreener does not index Elysium mainnet. A failed
 * refresh keeps serving the last board, so a Kleos hiccup never hides coins already known.
 */
export async function getKleosBoardCoin(address: string): Promise<any | null> {
  const stale = !kleosBoard || Date.now() - kleosBoard.at > KLEOS_BOARD_TTL_MS;
  if (stale) {
    kleosBoardRefresh ??= refreshKleosBoard().finally(() => { kleosBoardRefresh = null; });
    if (kleosBoard) kleosBoardRefresh.catch(() => undefined); // serve the old board while it refreshes
    else await kleosBoardRefresh;
  }
  return kleosBoard?.byAddress.get(address.toLowerCase()) ?? null;
}

/** Every coin on the Kleos board (address, name, symbol, launch data), for wallet holding scans */
export async function listKleosBoardCoins(): Promise<any[]> {
  await getKleosBoardCoin(ZERO_ADDRESS);
  return kleosBoard ? [...kleosBoard.byAddress.values()] : [];
}
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** HYPE-to-quote-token hop fees a v5 coin can use when no board entry says which */
const V5_HOP_FEES = [0, 10000, 3000, 500];

/**
 * Finds the router that trades this coin. Each router only knows its own launches and reverts with
 * UnknownToken() for the rest, so a quote that answers proves the route. The board's launch data is
 * tried first (it carries a v5 coin's hop fee); without it every v5 hop fee is tried.
 */
export async function resolveKleosRoute(
  provider: ethers.Provider,
  token: string,
  launchHint?: any,
  /** false: only the launchpads' own routers (a Kleos lookup), never a plain Uniswap v4 pool */
  options: { allowUniV4?: boolean } = {}
): Promise<KleosRoute> {
  const probe = 10n ** 15n; // 0.001 HYPE
  // RonsPad, Ascend and Montra name their own launches on chain
  const [ronsPad, ascend, montra] = await Promise.all([
    getRonsPadLaunch(provider, token).catch(() => null),
    // One retry: a busy RPC must not make an Ascend coin look like it can't be traded
    resolveAscendRoute(provider, token).catch(() => resolveAscendRoute(provider, token)).catch((err: Error) => err),
    resolveMontraRoute(provider, token).catch(() => null),
  ]);
  if (ronsPad) return ROUTES.ronspad;
  if (montra) return { ...ROUTES.montra, router: montra.router, montra };
  // resolveAscendRoute answers null for a coin Ascend did not launch, so an error is a real failure: say so
  // rather than probing Kleos and calling an Ascend coin untradeable after an RPC hiccup
  if (ascend instanceof Error) {
    throw /Ascend coin/.test(ascend.message) ? ascend : new Error('Could not reach the Elysium network to look up this coin. Try again in a moment.');
  }
  if (ascend && !(ascend instanceof Error)) return { ...ROUTES.ascend, ascend };
  const candidates: KleosRoute[] = [];
  if (launchHint !== undefined && launchHint !== null) {
    try { candidates.push(kleosRouteFromLaunch(launchHint)); } catch { /* no HYPE route per the board: probe anyway */ }
  }
  const same = (a: KleosRoute, b: KleosRoute) =>
    a.kind === b.kind && a.router.toLowerCase() === b.router.toLowerCase() && a.hopFee === b.hopFee &&
    (a.hop?.currency1 ?? '').toLowerCase() === (b.hop?.currency1 ?? '').toLowerCase();
  const add = (r: KleosRoute) => { if (!candidates.some(c => same(c, r))) candidates.push(r); };
  for (const d of KLEOS_V5_DEPLOYMENTS) {
    for (const hopFee of V5_HOP_FEES) add({ kind: 'v5', router: d.router, hopFee });
  }
  for (const r of [ROUTES.v4, ROUTES.pair, ROUTES.classic]) add(r);
  for (const d of KLEOS_V5_DEPLOYMENTS) {
    for (const quote of Object.keys(KLEOS_HOP_KEYS)) add(hopRouteFor(quote, d)!);
  }
  for (const route of candidates) {
    try {
      if ((await quoteKleos(provider, route, token, 'buy', probe)) > 0n) return route;
    } catch { /* not this router */ }
  }
  // Another launchpad's coin: trade its Uniswap v4 pool against HYPE, if it has one
  if (options.allowUniV4 !== false) {
    const v4 = await findElysiumV4Route(provider, token).catch(() => null);
    if (v4) return { ...ROUTES.univ4, ascend: v4 };
  }
  throw new Error('No Kleos router trades this coin.');
}

export interface EvmCall {
  to: string;
  data: string;
  value: bigint;
}

export function encodeKleosBuy(route: KleosRoute, token: string, hypeIn: bigint, minOut: bigint, recipient: string, deadline: bigint): EvmCall {
  if (route.kind === 'ascend' || route.kind === 'univ4') return encodeAscendBuy(route.ascend!, token, hypeIn, minOut, recipient, deadline);
  if (route.kind === 'montra') return encodeMontraBuy(route.montra!, token, hypeIn, minOut, recipient, deadline);
  if (route.kind === 'hop') {
    const data = new ethers.Interface(KLEOS_HOP_ROUTER_ABI).encodeFunctionData('buy', [token, route.hop, minOut, recipient, deadline]);
    return { to: route.router, data, value: hypeIn };
  }
  if (route.kind === 'ronspad') {
    const min = minOut > 0n ? minOut : 1n;
    const data = new ethers.Interface(RONSPAD_FACTORY_ABI).encodeFunctionData('buy', [token, hypeIn, min, recipient, deadline]);
    return { to: route.router, data, value: hypeIn };
  }
  if (route.kind === 'classic') {
    const data = new ethers.Interface(KLEOS_SWAP_ROUTER_ABI).encodeFunctionData('exactInputSingle', [{
      tokenIn: KLEOS.whype, tokenOut: token, fee: KLEOS_CLASSIC_POOL_FEE, recipient, deadline,
      amountIn: hypeIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0,
    }]);
    return { to: route.router, data, value: hypeIn };
  }
  const data = route.kind === 'v5'
    ? new ethers.Interface(KLEOS_V5_ROUTER_ABI).encodeFunctionData('buy', [token, route.hopFee, minOut, recipient, deadline])
    : new ethers.Interface(KLEOS_V4_ROUTER_ABI).encodeFunctionData('buy', [token, minOut, recipient, deadline]);
  return { to: route.router, data, value: hypeIn };
}

export function encodeKleosSell(route: KleosRoute, token: string, amountIn: bigint, minOut: bigint, recipient: string, deadline: bigint): EvmCall {
  if (route.kind === 'ascend' || route.kind === 'univ4') return encodeAscendSell(route.ascend!, token, amountIn, minOut, recipient, deadline);
  if (route.kind === 'montra') return encodeMontraSell(route.montra!, token, amountIn, minOut, recipient, deadline);
  if (route.kind === 'hop') {
    const data = new ethers.Interface(KLEOS_HOP_ROUTER_ABI).encodeFunctionData('sell', [token, route.hop, amountIn, minOut, recipient, deadline]);
    return { to: route.router, data, value: 0n };
  }
  if (route.kind === 'ronspad') {
    const min = minOut > 0n ? minOut : 1n;
    const data = new ethers.Interface(RONSPAD_FACTORY_ABI).encodeFunctionData('sell', [token, amountIn, min, recipient, true, deadline]);
    return { to: route.router, data, value: 0n };
  }
  if (route.kind === 'classic') {
    // The router receives the WHYPE and unwraps it to the seller
    const iface = new ethers.Interface(KLEOS_SWAP_ROUTER_ABI);
    const swap = iface.encodeFunctionData('exactInputSingle', [{
      tokenIn: token, tokenOut: KLEOS.whype, fee: KLEOS_CLASSIC_POOL_FEE, recipient: route.router, deadline,
      amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0,
    }]);
    const unwrap = iface.encodeFunctionData('unwrapWETH9', [minOut, recipient]);
    return { to: route.router, data: iface.encodeFunctionData('multicall', [[swap, unwrap]]), value: 0n };
  }
  const data = route.kind === 'v5'
    ? new ethers.Interface(KLEOS_V5_ROUTER_ABI).encodeFunctionData('sell', [token, amountIn, route.hopFee, minOut, recipient, deadline])
    : new ethers.Interface(KLEOS_V4_ROUTER_ABI).encodeFunctionData('sell', [token, amountIn, minOut, recipient, deadline]);
  return { to: route.router, data, value: 0n };
}

/**
 * One Multicall3 call that pays plain HYPE transfers (the platform fee, a gas top-up) and then the buy.
 * Every leg must succeed, so the fee is only taken when the swap goes through.
 */
export function encodeKleosBuyWithTransfers(transfers: { to: string; value: bigint }[], buy: EvmCall): EvmCall {
  const calls = [
    ...transfers.filter(t => t.value > 0n).map(t => ({ target: t.to, allowFailure: false, value: t.value, callData: '0x' })),
    { target: buy.to, allowFailure: false, value: buy.value, callData: buy.data },
  ];
  const value = calls.reduce((sum, c) => sum + c.value, 0n);
  const data = new ethers.Interface(MULTICALL3_VALUE_ABI).encodeFunctionData('aggregate3Value', [calls]);
  return { to: KLEOS.multicall3, data, value };
}

// ── HyperEVM inbox ──────────────────────────────────────────────────────────

const ALIAS_OFFSET = BigInt('0x1111000000000000000000000000000000001111');

/** The address a HyperEVM sender acts as on Elysium inside a retryable ticket */
export function applyL1ToL2Alias(address: string): string {
  const aliased = (BigInt(address) + ALIAS_OFFSET) & ((1n << 160n) - 1n);
  return ethers.getAddress(ethers.toBeHex(aliased, 20));
}

/** Max fee per gas for an Elysium transaction (the Kleos app's rule); only the base fee is charged */
export function elysiumInboxMaxFeePerGas(l2BaseFee: bigint): bigint {
  return l2BaseFee * 3n > MIN_ELYSIUM_FEE_PER_GAS ? l2BaseFee * 3n : MIN_ELYSIUM_FEE_PER_GAS;
}
export const elysiumMaxFeePerGas = elysiumInboxMaxFeePerGas;

/**
 * Signed Elysium transactions go straight to the Elysium RPC now that its public sequencer is open.
 * ELYSIUM_SEND_MODE=inbox sends them through the HyperEVM inbox instead (slower; needs HyperEVM gas).
 */
export function isElysiumDirectSend(): boolean {
  return process.env.ELYSIUM_SEND_MODE !== 'inbox';
}

/** Gas limit for a direct Elysium transaction: the estimate plus 30%, never below 21,000 */
export function elysiumGasLimit(estimate: bigint): bigint {
  const padded = (estimate * 13n) / 10n;
  return padded > 21_000n ? padded : 21_000n;
}

/** Plain-language reason an Elysium RPC refused a signed transaction */
export function describeElysiumSendError(err: any): string {
  const raw = String(err?.info?.error?.message || err?.error?.message || err?.shortMessage || err?.message || '').toLowerCase();
  if (raw.includes('insufficient funds')) return 'Not enough HYPE on Elysium to pay for this transaction and its gas.';
  if (raw.includes('nonce too low') || raw.includes('already known') || raw.includes('nonce has already been used')) {
    return 'Another transaction from this wallet went through first. Check your balance, then try again.';
  }
  if (raw.includes('nonce too high')) return 'An earlier transaction from this wallet is still waiting. Try again in a minute.';
  if (raw.includes('max fee per gas less than block base fee') || raw.includes('fee cap') || raw.includes('underpriced')) {
    return 'Elysium gas went up while the order was being sent. Try again.';
  }
  if (raw.includes('intrinsic gas too low') || raw.includes('gas limit')) return 'The transaction was given too little gas. Try again.';
  if (raw.includes('timeout') || raw.includes('fetch failed') || raw.includes('econn') || raw.includes('network')) {
    return 'Could not reach the Elysium network. Try again in a moment.';
  }
  return describeKleosRevert(err);
}

export interface RetryableTicketCost {
  maxSubmissionCost: bigint;
  maxFeePerGas: bigint;
  /** msg.value for createRetryableTicket; what the ticket does not use is refunded on Elysium */
  deposit: bigint;
}

/** Sizes a retryable ticket the way the Kleos app does, with 2x headroom on both base fees */
export function retryableTicketCost(p: { dataLength: number; l1BaseFee: bigint; l2BaseFee: bigint; gasLimit: bigint; l2CallValue: bigint }): RetryableTicketCost {
  const maxSubmissionCost = (1400n + 6n * BigInt(p.dataLength)) * p.l1BaseFee * 2n;
  const maxFeePerGas = p.l2BaseFee * 2n > MIN_ELYSIUM_FEE_PER_GAS ? p.l2BaseFee * 2n : MIN_ELYSIUM_FEE_PER_GAS;
  return { maxSubmissionCost, maxFeePerGas, deposit: maxSubmissionCost + p.l2CallValue + p.gasLimit * maxFeePerGas };
}

/** sendL2Message payload: kind 4 is one signed transaction, kind 3 a batch of length-prefixed ones */
export function encodeSignedTxMessage(rawTxs: string[]): string {
  if (rawTxs.length === 0) throw new Error('No transactions to send');
  const items = rawTxs.map(raw => ethers.concat(['0x04', raw]));
  if (items.length === 1) return items[0];
  return ethers.concat(['0x03', ...items.flatMap(item => [ethers.toBeHex(ethers.dataLength(item), 8), item])]);
}

const rlpQuantity = (n: bigint) => (n === 0n ? '0x' : ethers.toBeHex(n));

export interface RetryableTicketFields {
  to: string;
  l2CallValue: bigint;
  deposit: bigint;
  maxSubmissionCost: bigint;
  excessFeeRefundAddress: string;
  callValueRefundAddress: string;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  data: string;
}

/** Decodes the InboxMessageDelivered data of a retryable ticket */
export function decodeRetryableTicketData(data: string): RetryableTicketFields {
  const word = (i: number) => BigInt(ethers.dataSlice(data, i * 32, (i + 1) * 32));
  const address = (i: number) => ethers.getAddress(ethers.toBeHex(word(i), 20));
  const dataLength = Number(word(8));
  return {
    to: address(0), l2CallValue: word(1), deposit: word(2), maxSubmissionCost: word(3),
    excessFeeRefundAddress: address(4), callValueRefundAddress: address(5), gasLimit: word(6), maxFeePerGas: word(7),
    data: dataLength === 0 ? '0x' : ethers.dataSlice(data, 288, 288 + dataLength),
  };
}

/** Hash of the ArbitrumSubmitRetryableTx Elysium creates for a ticket; its receipt names the redeem */
export function computeRetryableTicketId(p: { childChainId: bigint; messageIndex: bigint; sender: string; baseFeeL1: bigint; fields: RetryableTicketFields }): string {
  const f = p.fields;
  return ethers.keccak256(ethers.concat(['0x69', ethers.encodeRlp([
    rlpQuantity(p.childChainId),
    ethers.toBeHex(p.messageIndex, 32),
    p.sender,
    rlpQuantity(p.baseFeeL1),
    rlpQuantity(f.deposit),
    rlpQuantity(f.maxFeePerGas),
    rlpQuantity(f.gasLimit),
    BigInt(f.to) === 0n ? '0x' : f.to,
    rlpQuantity(f.l2CallValue),
    f.callValueRefundAddress,
    rlpQuantity(f.maxSubmissionCost),
    f.excessFeeRefundAddress,
    f.data,
  ])]));
}

/** The retryable ticket a createRetryableTicket receipt opened, from its bridge and inbox logs */
export function findRetryableTicket(logs: readonly { address: string; topics: readonly string[]; data: string }[]): { ticketId: string; messageIndex: bigint } | null {
  const bridgeIface = new ethers.Interface(ELYSIUM_BRIDGE_ABI);
  const inboxIface = new ethers.Interface(ELYSIUM_INBOX_ABI);
  for (const log of logs) {
    if (log.address.toLowerCase() !== ELYSIUM_BRIDGE.bridge) continue;
    const delivered = (() => { try { return bridgeIface.parseLog(log); } catch { return null; } })();
    if (!delivered || delivered.name !== 'MessageDelivered' || Number(delivered.args.kind) !== 9) continue;
    const messageIndex: bigint = delivered.args.messageIndex;
    for (const inboxLog of logs) {
      if (inboxLog.address.toLowerCase() !== ELYSIUM_BRIDGE.inbox) continue;
      const parsed = (() => { try { return inboxIface.parseLog(inboxLog); } catch { return null; } })();
      if (!parsed || parsed.name !== 'InboxMessageDelivered' || parsed.args.messageNum !== messageIndex) continue;
      const ticketId = computeRetryableTicketId({
        childChainId: ELYSIUM_BRIDGE.childChainId, messageIndex, sender: delivered.args.sender,
        baseFeeL1: delivered.args.baseFeeL1, fields: decodeRetryableTicketData(parsed.args.data),
      });
      return { ticketId, messageIndex };
    }
  }
  return null;
}

/** retryTxHash of the auto-redeem in a ticket's Elysium receipt */
export function findRedeemTxHash(logs: readonly { address: string; topics: readonly string[]; data: string }[]): string | null {
  const iface = new ethers.Interface(ARB_RETRYABLE_TX_ABI);
  for (const log of logs) {
    if (log.address.toLowerCase() !== ELYSIUM_BRIDGE.arbRetryableTx.toLowerCase()) continue;
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === 'RedeemScheduled') return parsed.args.retryTxHash;
    } catch { /* other event */ }
  }
  return null;
}

/** Kleos trading is on unless KLEOS_TRADING=off, the switch for turning it off without a deploy */
export function isKleosTradingEnabled(): boolean {
  return process.env.KLEOS_TRADING !== 'off';
}

/** HyperEVM gas kept back for the transaction that carries a signed Elysium transaction into the inbox */
export const HYPEREVM_INBOX_GAS_RESERVE = ethers.parseEther('0.0002');

/**
 * Signs one Elysium transaction from the wallet and sends it: straight to the Elysium RPC (gas estimated, so
 * a call that would revert is never sent, then confirmed), or through the HyperEVM inbox when
 * ELYSIUM_SEND_MODE=inbox. Errors are in plain language.
 */
export async function sendElysiumTransaction(p: {
  elysium: ethers.JsonRpcProvider;
  l2Signer: ethers.Wallet;
  /** Only used in inbox mode */
  l1Signer: ethers.Wallet;
  hyperevm: ethers.Provider;
  tx: { to: string; data?: string; value?: bigint };
  /** Gas limit used in inbox mode, where nothing can be estimated against queued messages */
  inboxGasLimit: bigint;
  confirmTimeoutMs?: number;
}): Promise<{ elysiumTxHash: string; inboxTxHash?: string; confirmed: boolean }> {
  const { elysium, l2Signer, tx } = p;
  const from = await l2Signer.getAddress();
  const value = tx.value ?? 0n;
  const data = tx.data ?? '0x';
  const [block, nonce] = await Promise.all([elysium.getBlock('latest'), elysium.getTransactionCount(from, 'pending')]);
  const maxFeePerGas = elysiumMaxFeePerGas(block?.baseFeePerGas ?? 0n);

  if (!isElysiumDirectSend()) {
    if ((await p.hyperevm.getBalance(from)) < HYPEREVM_INBOX_GAS_RESERVE) {
      throw new Error(`Sending on Elysium needs about ${ethers.formatEther(HYPEREVM_INBOX_GAS_RESERVE)} HYPE on HyperEVM for the inbox transaction.`);
    }
    const raw = await l2Signer.signTransaction({
      type: 2, chainId: Number(ELYSIUM_BRIDGE.childChainId), nonce,
      to: tx.to, data, value, gasLimit: p.inboxGasLimit, maxFeePerGas, maxPriorityFeePerGas: 0n,
    });
    const inbox = new ethers.Interface(ELYSIUM_INBOX_ABI);
    const sent = await p.l1Signer.sendTransaction({ to: ELYSIUM_BRIDGE.inbox, data: inbox.encodeFunctionData('sendL2Message', [encodeSignedTxMessage([raw])]) });
    const receipt = await sent.wait(1);
    if (receipt?.status !== 1) throw new Error('The HyperEVM inbox transaction reverted. Nothing was sent on Elysium.');
    return { elysiumTxHash: ethers.keccak256(raw), inboxTxHash: receipt.hash, confirmed: false };
  }

  let estimate: bigint;
  try {
    estimate = await elysium.estimateGas({ from, to: tx.to, data, value });
  } catch (err) {
    throw new Error(`Elysium would refuse this transaction: ${describeElysiumSendError(err)} Nothing was sent.`);
  }
  const raw = await l2Signer.signTransaction({
    type: 2, chainId: Number(ELYSIUM_BRIDGE.childChainId), nonce,
    to: tx.to, data, value, gasLimit: elysiumGasLimit(estimate), maxFeePerGas, maxPriorityFeePerGas: 0n,
  });
  try {
    await elysium.send('eth_sendRawTransaction', [raw]);
  } catch (err: any) {
    // A backup RPC saying "already known" means an earlier attempt did reach Elysium: it is sent
    const msg = String(err?.info?.error?.message || err?.error?.message || err?.shortMessage || err?.message || '');
    if (!/already known|known transaction/i.test(msg)) throw new Error(`${describeElysiumSendError(err)} Nothing was sent.`);
  }
  const hash = ethers.keccak256(raw);
  const until = Date.now() + (p.confirmTimeoutMs ?? 60_000);
  while (Date.now() < until) {
    const receipt = await elysium.getTransactionReceipt(hash).catch(() => null);
    if (receipt) {
      if (receipt.status !== 1) throw new Error('The transaction ran on Elysium but reverted. Only its gas was spent.');
      return { elysiumTxHash: hash, confirmed: true };
    }
    await new Promise(r => setTimeout(r, 1_000));
  }
  return { elysiumTxHash: hash, confirmed: false };
}
