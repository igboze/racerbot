/**
 * Kleos launchpad on Elysium mainnet (chain 99901): routing, quotes and the HyperEVM inbox.
 *
 * Elysium is an Arbitrum Orbit rollup settling on HyperEVM. Before its public sequencer opens, no RPC takes
 * transactions, so everything enters through the delayed inbox on HyperEVM:
 *  - a retryable ticket (createRetryableTicket) runs a call on Elysium paid from HyperEVM HYPE, as the
 *    *aliased* sender, so it can buy (coins go to an explicit recipient) but never move the user's coins;
 *  - a signed Elysium transaction wrapped in sendL2Message runs as the user's own address, so it can sell.
 * Both keep working after the public launch. Addresses come from Kleos's deployments/99901.json.
 */
import { ethers } from 'ethers';

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

export interface KleosPoolKey {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
}

/**
 * The HYPE pool of each quote token the hop router can route through (from the Kleos app, which
 * names them per quote token). Coins paired against these trade HYPE -> quote -> coin in one call.
 */
export const KLEOS_HOP_KEYS: Record<string, KleosPoolKey> = {
  // BLOB
  '0x9a9815af521149e8d982791703a31bca2f95f534': {
    currency0: '0x0000000000000000000000000000000000000000',
    currency1: '0x9a9815Af521149E8D982791703A31bca2F95f534',
    fee: 0,
    tickSpacing: 200,
    hooks: '0xe11cafa5901b0aab51eb78251488400f9e4320cc',
  },
};

/** RonsPad (ronspad.fun), the other launchpad on Elysium: its own Uniswap V3, every coin paired with its WHYPE */
export const RONSPAD = {
  padFactory: '0x371811b06bd66c93b46F2F1FfD45b65455A2D2a2',
  v3Factory: '0x24e21E3F2b0bB0C166ec3EAFf1e615aB14cDD85F',
  whype: '0xbA876237B0F021A6c6D852d6c26E107997cC5E81',
} as const;

export const RONSPAD_TOKEN_URL = 'https://ronspad.fun/token?token=';

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
  Expired: 'The order ran after its deadline, so nothing traded.',
  NoHypeRoute: 'This coin has no HYPE route on Kleos yet.',
  UnknownToken: 'Kleos does not list this coin.',
  MaxWalletExceeded: "In its first minutes no wallet may hold more than this coin's launch-window limit. Buy less, or wait.",
};
const kleosErrorIface = new ethers.Interface([...KLEOS_V4_ROUTER_ABI.filter(f => f.startsWith('error')), ...KLEOS_COIN_ABI.filter(f => f.startsWith('error'))]);

export function describeKleosRevert(err: any): string {
  const data: string | undefined = err?.data ?? err?.info?.error?.data ?? err?.error?.data;
  if (typeof data === 'string' && data.length >= 10) {
    try {
      const parsed = kleosErrorIface.parseError(data);
      if (parsed && KLEOS_ERROR_MESSAGES[parsed.name]) return KLEOS_ERROR_MESSAGES[parsed.name];
    } catch { /* not a Kleos error */ }
  }
  return err?.shortMessage || err?.reason || err?.message || 'reverted';
}

// ── Routing ─────────────────────────────────────────────────────────────────

export type KleosRouteKind = 'classic' | 'v4' | 'v5' | 'pair' | 'hop' | 'ronspad';

export interface KleosRoute {
  kind: KleosRouteKind;
  router: string;
  /** v5 only: fee of the hop from HYPE to the coin's quote token; 0 when the coin trades against HYPE */
  hopFee: number;
  /** hop only: the quote token's HYPE pool */
  hop?: KleosPoolKey;
}

const ROUTES: Record<KleosRouteKind, KleosRoute> = {
  v5: { kind: 'v5', router: KLEOS.v5Router, hopFee: 0 },
  v4: { kind: 'v4', router: KLEOS.v4Router, hopFee: 0 },
  pair: { kind: 'pair', router: KLEOS.pairRouter, hopFee: 0 },
  classic: { kind: 'classic', router: KLEOS.swapRouter, hopFee: 0 },
  hop: { kind: 'hop', router: KLEOS.hopRouter, hopFee: 0 },
  ronspad: { kind: 'ronspad', router: RONSPAD.padFactory, hopFee: 0 },
};

/** The hop route for a coin paired against `quote`, when the hop router knows that quote's HYPE pool */
function hopRouteFor(quote: string | undefined): KleosRoute | null {
  const key = quote ? KLEOS_HOP_KEYS[quote.toLowerCase()] : undefined;
  return key ? { ...ROUTES.hop, hop: key } : null;
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
    if (v4.pair && Number(v4.v5.routeFee ?? 0) === 0) {
      // No HYPE hop on the v5 router: the hop router routes HYPE -> quote -> coin when it knows the quote's pool
      const hop = hopRouteFor(v4.v5.quote);
      if (hop) return hop;
      throw new Error(KLEOS_ERROR_MESSAGES.NoHypeRoute);
    }
    return { ...ROUTES.v5, hopFee: Number(v4.v5.routeFee ?? 0) };
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

/** HYPE-to-quote-token hop fees a v5 coin can use when no board entry says which */
const V5_HOP_FEES = [0, 10000, 3000, 500];

/**
 * Finds the router that trades this coin. Each router only knows its own launches and reverts with
 * UnknownToken() for the rest, so a quote that answers proves the route. The board's launch data is
 * tried first (it carries a v5 coin's hop fee); without it every v5 hop fee is tried.
 */
export async function resolveKleosRoute(provider: ethers.Provider, token: string, launchHint?: any): Promise<KleosRoute> {
  const probe = 10n ** 15n; // 0.001 HYPE
  // RonsPad coins: PadFactory names its own launches
  if (await getRonsPadLaunch(provider, token).catch(() => null)) return ROUTES.ronspad;
  const candidates: KleosRoute[] = [];
  if (launchHint !== undefined && launchHint !== null) {
    try { candidates.push(kleosRouteFromLaunch(launchHint)); } catch { /* no HYPE route per the board: probe anyway */ }
  }
  for (const r of [ROUTES.v5, ROUTES.v4, ROUTES.pair, ROUTES.classic]) {
    if (r.kind === 'v5') {
      for (const hopFee of V5_HOP_FEES) {
        if (!candidates.some(c => c.kind === 'v5' && c.hopFee === hopFee)) candidates.push({ ...r, hopFee });
      }
    } else if (!candidates.some(c => c.kind === r.kind)) {
      candidates.push(r);
    }
  }
  for (const quote of Object.keys(KLEOS_HOP_KEYS)) {
    if (!candidates.some(c => c.kind === 'hop' && c.hop?.currency1.toLowerCase() === quote)) candidates.push(hopRouteFor(quote)!);
  }
  for (const route of candidates) {
    try {
      if ((await quoteKleos(provider, route, token, 'buy', probe)) > 0n) return route;
    } catch { /* not this router */ }
  }
  throw new Error('No Kleos router trades this coin.');
}

export interface EvmCall {
  to: string;
  data: string;
  value: bigint;
}

export function encodeKleosBuy(route: KleosRoute, token: string, hypeIn: bigint, minOut: bigint, recipient: string, deadline: bigint): EvmCall {
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

/** Max fee per gas for an Elysium transaction sent through the inbox (the Kleos app's rule) */
export function elysiumInboxMaxFeePerGas(l2BaseFee: bigint): bigint {
  return l2BaseFee * 3n > MIN_ELYSIUM_FEE_PER_GAS ? l2BaseFee * 3n : MIN_ELYSIUM_FEE_PER_GAS;
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
