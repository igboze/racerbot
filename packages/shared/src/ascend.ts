/**
 * Ascend (app.ascendlaunch.xyz), a launchpad on Elysium mainnet. Every Ascend coin trades in a Uniswap v4
 * "launch pool" on Elysium's PoolManager, paired with one quote token (WHYPE, USDC or KNTQ). The pool key is
 * fixed: the coin and its quote, the dynamic-fee flag, tick spacing 200, and Ascend's launchpad as the hook.
 * Trades go through Uniswap's Universal Router; sells pull the coin through Permit2.
 * Addresses come from Ascend's app bundle (deployment for chain 99901, deployBlock 422319).
 */
import { ethers } from 'ethers';

export const ASCEND = {
  launchpad: '0xe0dEF4221b9840a610D4e7d55812a79A6431a8eC',
  poolManager: '0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1',
  stateView: '0x27eD73aE0652fdCf71d6793412A7525f32bE9dfE',
  v4Quoter: '0x379F556c5a748BD7Cc9baF0F7A344094Ac1814f5',
  universalRouter: '0x1B341FDD55d56F8E08409A2C25DDFad93Eb03C1a',
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  /** Elysium's canonical wrapped HYPE (the Universal Router's WETH9) */
  whype: '0xbA876237B0F021A6c6D852d6c26E107997cC5E81',
} as const;

export const ASCEND_TOKEN_URL = 'https://app.ascendlaunch.xyz/tokens/';

/** Uniswap v4's dynamic-fee flag: the launchpad hook sets each launch pool's fee */
const DYNAMIC_FEE = 0x800000;
const LAUNCH_TICK_SPACING = 200;
const NATIVE = ethers.ZeroAddress;

export interface V4PoolKey {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
}

/** The quote tokens an Ascend coin can launch against */
export const ASCEND_QUOTES = {
  WHYPE: ASCEND.whype,
  USDC: '0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65',
  KNTQ: '0xe45a355d9e9cAd2aD85F2d03E3eE3102A036acF0',
} as const;

export interface AscendRoute {
  /** The coin's quote token */
  quote: string;
  quoteSymbol: string;
  /** The coin's launch pool */
  launchKey: V4PoolKey;
  /** For a USDC or KNTQ coin: the native HYPE pool that turns HYPE into the quote token */
  hypeHop?: V4PoolKey;
}

const sortPair = (a: string, b: string): [string, string] => (BigInt(a) < BigInt(b) ? [a, b] : [b, a]);

export function ascendLaunchKey(token: string, quote: string): V4PoolKey {
  const [currency0, currency1] = sortPair(ethers.getAddress(token), ethers.getAddress(quote));
  return { currency0, currency1, fee: DYNAMIC_FEE, tickSpacing: LAUNCH_TICK_SPACING, hooks: ASCEND.launchpad };
}

export function v4PoolId(key: V4PoolKey): string {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'address', 'uint24', 'int24', 'address'],
    [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
  ));
}

const STATE_VIEW_ABI = ['function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)'];
const POOL_KEY_T = 'tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)';
const PATH_KEY_T = 'tuple(address intermediateCurrency, uint24 fee, int24 tickSpacing, address hooks, bytes hookData)';
export const V4_QUOTER_ABI = [
  `function quoteExactInputSingle(tuple(${POOL_KEY_T} poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)`,
  `function quoteExactInput(tuple(address exactCurrency, ${PATH_KEY_T}[] path, uint128 exactAmount) params) returns (uint256 amountOut, uint256 gasEstimate)`,
];
export const UNIVERSAL_ROUTER_ABI = ['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable'];
export const PERMIT2_ABI = [
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
];

/** Native HYPE pools (no hook) that may turn HYPE into a quote token, most liquid tiers first */
const HYPE_HOP_TIERS = [
  { fee: 10000, tickSpacing: 200 },
  { fee: 3000, tickSpacing: 60 },
  { fee: 500, tickSpacing: 10 },
  { fee: 100, tickSpacing: 1 },
];

/** Uniswap v4 path step from `from` through `key` */
function pathKey(key: V4PoolKey, to: string) {
  return { intermediateCurrency: to, fee: key.fee, tickSpacing: key.tickSpacing, hooks: key.hooks, hookData: '0x' };
}

/** The Ascend launch of a coin, read from the chain (the launch pool that exists), or null */
export async function getAscendLaunch(provider: ethers.Provider, token: string): Promise<{ quote: string; quoteSymbol: string; launchKey: V4PoolKey } | null> {
  if (!ethers.isAddress(token)) return null;
  const stateView = new ethers.Contract(ASCEND.stateView, STATE_VIEW_ABI, provider);
  const found = await Promise.all(Object.entries(ASCEND_QUOTES).map(async ([symbol, quote]) => {
    if (quote.toLowerCase() === token.toLowerCase()) return null;
    const launchKey = ascendLaunchKey(token, quote);
    const [sqrtPriceX96] = await stateView.getSlot0(v4PoolId(launchKey));
    return BigInt(sqrtPriceX96) > 0n ? { quote: ethers.getAddress(quote), quoteSymbol: symbol, launchKey } : null;
  }));
  return found.find(Boolean) ?? null;
}

const quoter = (provider: ethers.Provider) => new ethers.Contract(ASCEND.v4Quoter, V4_QUOTER_ABI, provider);

/** The route for an Ascend coin: its launch pool, plus a HYPE pool into its quote token when that is not WHYPE */
export async function resolveAscendRoute(provider: ethers.Provider, token: string): Promise<AscendRoute | null> {
  const launch = await getAscendLaunch(provider, token);
  if (!launch) return null;
  if (launch.quote.toLowerCase() === ASCEND.whype.toLowerCase()) return launch;
  // Pick the native HYPE pool that gives the most of the quote token for a small probe
  const probe = 10n ** 16n; // 0.01 HYPE
  let best: { key: V4PoolKey; out: bigint } | null = null;
  for (const tier of HYPE_HOP_TIERS) {
    const key: V4PoolKey = { currency0: NATIVE, currency1: launch.quote, ...tier, hooks: NATIVE };
    try {
      const [out] = await quoter(provider).quoteExactInputSingle.staticCall({ poolKey: key, zeroForOne: true, exactAmount: probe, hookData: '0x' });
      if (out > 0n && (!best || out > best.out)) best = { key, out };
    } catch { /* no such pool */ }
  }
  if (!best) throw new Error(`Ascend coin ${token} is paired with ${launch.quoteSymbol}, and there is no HYPE pool for ${launch.quoteSymbol} on Elysium.`);
  return { ...launch, hypeHop: best.key };
}

/** Coins out for `amountIn` HYPE (buy), or HYPE out for `amountIn` coins (sell); taxes and pool fees included */
export async function quoteAscend(provider: ethers.Provider, route: AscendRoute, token: string, side: 'buy' | 'sell', amountIn: bigint): Promise<bigint> {
  const q = quoter(provider);
  if (!route.hypeHop) {
    const tokenIsCurrency0 = route.launchKey.currency0.toLowerCase() === token.toLowerCase();
    // Buy: WHYPE -> token; sell: token -> WHYPE (WHYPE unwraps 1:1)
    const zeroForOne = side === 'buy' ? !tokenIsCurrency0 : tokenIsCurrency0;
    const [out] = await q.quoteExactInputSingle.staticCall({ poolKey: route.launchKey, zeroForOne, exactAmount: amountIn, hookData: '0x' });
    return out;
  }
  const path = side === 'buy'
    ? [pathKey(route.hypeHop, route.quote), pathKey(route.launchKey, ethers.getAddress(token))]
    : [pathKey(route.launchKey, route.quote), pathKey(route.hypeHop, NATIVE)];
  const [out] = await q.quoteExactInput.staticCall({ exactCurrency: side === 'buy' ? NATIVE : ethers.getAddress(token), path, exactAmount: amountIn });
  return out;
}

// ── Universal Router encoding ───────────────────────────────────────────────

const CMD = { SWEEP: 0x04, WRAP_ETH: 0x0b, UNWRAP_WETH: 0x0c, V4_SWAP: 0x10 } as const;
const ACT = { SWAP_EXACT_IN_SINGLE: 0x06, SWAP_EXACT_IN: 0x07, SETTLE: 0x0b, SETTLE_ALL: 0x0c, TAKE: 0x0e } as const;
/** The Universal Router's own address in commands, and "the whole open delta" as an amount */
const ADDRESS_THIS = '0x0000000000000000000000000000000000000002';
const OPEN_DELTA = 0n;
const coder = ethers.AbiCoder.defaultAbiCoder();
// Ascend's Universal Router build takes per-hop minimum prices; 0 / [] means no extra limit
const EXACT_IN_SINGLE_T = `tuple(${POOL_KEY_T} poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, uint256 minHopPriceX36, bytes hookData)`;
const EXACT_IN_T = `tuple(address currencyIn, ${PATH_KEY_T}[] path, uint256[] minHopPriceX36, uint128 amountIn, uint128 amountOutMinimum)`;

function v4Swap(actions: number[], params: string[]): string {
  return coder.encode(['bytes', 'bytes[]'], [ethers.hexlify(new Uint8Array(actions)), params]);
}

function execute(commands: number[], inputs: string[], deadline: bigint): string {
  return new ethers.Interface(UNIVERSAL_ROUTER_ABI).encodeFunctionData('execute', [ethers.hexlify(new Uint8Array(commands)), inputs, deadline]);
}

/**
 * A buy paid in native HYPE: `hypeIn` is the call's value, the coins go to `recipient`. Nothing is left in the
 * router (the exact value is wrapped or settled), so it can be called through Multicall3 with the fee.
 */
export function encodeAscendBuy(route: AscendRoute, token: string, hypeIn: bigint, minOut: bigint, recipient: string, deadline: bigint): { to: string; data: string; value: bigint } {
  const coin = ethers.getAddress(token);
  if (!route.hypeHop && route.quote === NATIVE) {
    // A pool paired with native HYPE (always currency0): settle the HYPE sent, no wrapping
    const swap = v4Swap(
      [ACT.SWAP_EXACT_IN_SINGLE, ACT.SETTLE, ACT.TAKE],
      [
        coder.encode([EXACT_IN_SINGLE_T], [{ poolKey: route.launchKey, zeroForOne: true, amountIn: hypeIn, amountOutMinimum: minOut, minHopPriceX36: 0n, hookData: '0x' }]),
        coder.encode(['address', 'uint256', 'bool'], [NATIVE, OPEN_DELTA, false]),
        coder.encode(['address', 'address', 'uint256'], [coin, recipient, OPEN_DELTA]),
      ],
    );
    return { to: ASCEND.universalRouter, data: execute([CMD.V4_SWAP], [swap], deadline), value: hypeIn };
  }
  if (!route.hypeHop) {
    const zeroForOne = route.launchKey.currency0.toLowerCase() === ASCEND.whype.toLowerCase();
    const swap = v4Swap(
      [ACT.SWAP_EXACT_IN_SINGLE, ACT.SETTLE, ACT.TAKE],
      [
        coder.encode([EXACT_IN_SINGLE_T], [{ poolKey: route.launchKey, zeroForOne, amountIn: hypeIn, amountOutMinimum: minOut, minHopPriceX36: 0n, hookData: '0x' }]),
        coder.encode(['address', 'uint256', 'bool'], [ASCEND.whype, OPEN_DELTA, false]),
        coder.encode(['address', 'address', 'uint256'], [coin, recipient, OPEN_DELTA]),
      ],
    );
    const wrap = coder.encode(['address', 'uint256'], [ADDRESS_THIS, hypeIn]);
    return { to: ASCEND.universalRouter, data: execute([CMD.WRAP_ETH, CMD.V4_SWAP], [wrap, swap], deadline), value: hypeIn };
  }
  const swap = v4Swap(
    [ACT.SWAP_EXACT_IN, ACT.SETTLE, ACT.TAKE],
    [
      coder.encode([EXACT_IN_T], [{
        currencyIn: NATIVE, path: [pathKey(route.hypeHop, route.quote), pathKey(route.launchKey, coin)],
        minHopPriceX36: [], amountIn: hypeIn, amountOutMinimum: minOut,
      }]),
      coder.encode(['address', 'uint256', 'bool'], [NATIVE, OPEN_DELTA, false]),
      coder.encode(['address', 'address', 'uint256'], [coin, recipient, OPEN_DELTA]),
    ],
  );
  return { to: ASCEND.universalRouter, data: execute([CMD.V4_SWAP], [swap], deadline), value: hypeIn };
}

/** A sell of `amountIn` coins for native HYPE to `recipient`; the coins are pulled from the caller through Permit2 */
export function encodeAscendSell(route: AscendRoute, token: string, amountIn: bigint, minOut: bigint, recipient: string, deadline: bigint): { to: string; data: string; value: bigint } {
  const coin = ethers.getAddress(token);
  const settle = coder.encode(['address', 'uint256'], [coin, amountIn]);
  if (!route.hypeHop && route.quote === NATIVE) {
    const swap = v4Swap(
      [ACT.SWAP_EXACT_IN_SINGLE, ACT.SETTLE_ALL, ACT.TAKE],
      [
        coder.encode([EXACT_IN_SINGLE_T], [{ poolKey: route.launchKey, zeroForOne: false, amountIn, amountOutMinimum: minOut, minHopPriceX36: 0n, hookData: '0x' }]),
        settle,
        coder.encode(['address', 'address', 'uint256'], [NATIVE, recipient, OPEN_DELTA]),
      ],
    );
    return { to: ASCEND.universalRouter, data: execute([CMD.V4_SWAP], [swap], deadline), value: 0n };
  }
  if (!route.hypeHop) {
    const zeroForOne = route.launchKey.currency0.toLowerCase() === coin.toLowerCase();
    const swap = v4Swap(
      [ACT.SWAP_EXACT_IN_SINGLE, ACT.SETTLE_ALL, ACT.TAKE],
      [
        coder.encode([EXACT_IN_SINGLE_T], [{ poolKey: route.launchKey, zeroForOne, amountIn, amountOutMinimum: minOut, minHopPriceX36: 0n, hookData: '0x' }]),
        settle,
        coder.encode(['address', 'address', 'uint256'], [ASCEND.whype, ADDRESS_THIS, OPEN_DELTA]),
      ],
    );
    const unwrap = coder.encode(['address', 'uint256'], [recipient, minOut]);
    return { to: ASCEND.universalRouter, data: execute([CMD.V4_SWAP, CMD.UNWRAP_WETH], [swap, unwrap], deadline), value: 0n };
  }
  const swap = v4Swap(
    [ACT.SWAP_EXACT_IN, ACT.SETTLE_ALL, ACT.TAKE],
    [
      coder.encode([EXACT_IN_T], [{
        currencyIn: coin, path: [pathKey(route.launchKey, route.quote), pathKey(route.hypeHop, NATIVE)],
        minHopPriceX36: [], amountIn, amountOutMinimum: minOut,
      }]),
      settle,
      coder.encode(['address', 'address', 'uint256'], [NATIVE, recipient, OPEN_DELTA]),
    ],
  );
  return { to: ASCEND.universalRouter, data: execute([CMD.V4_SWAP], [swap], deadline), value: 0n };
}

/**
 * The approvals a sell of `amountIn` needs before the router can pull the coins: the coin to Permit2 (exact
 * amount, as Ascend's app does), then Permit2 to the Universal Router for 30 minutes.
 */
export async function ascendSellApprovals(provider: ethers.Provider, token: string, owner: string, amountIn: bigint): Promise<{ to: string; data: string; value: bigint }[]> {
  const erc20 = new ethers.Contract(token, ['function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)'], provider);
  const permit2 = new ethers.Contract(ASCEND.permit2, PERMIT2_ABI, provider);
  const [toPermit2, p2] = await Promise.all([
    erc20.allowance(owner, ASCEND.permit2) as Promise<bigint>,
    permit2.allowance(owner, token, ASCEND.universalRouter) as Promise<[bigint, bigint, bigint]>,
  ]);
  const calls: { to: string; data: string; value: bigint }[] = [];
  if (toPermit2 < amountIn) {
    calls.push({ to: token, data: erc20.interface.encodeFunctionData('approve', [ASCEND.permit2, amountIn]), value: 0n });
  }
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (BigInt(p2[0]) < amountIn || BigInt(p2[1]) < now + 120n) {
    calls.push({ to: ASCEND.permit2, data: permit2.interface.encodeFunctionData('approve', [token, ASCEND.universalRouter, amountIn, now + 1800n]), value: 0n });
  }
  return calls;
}

// ── Any Uniswap v4 pool on Elysium ──────────────────────────────────────────

const INITIALIZE_ABI = ['event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)'];
const v4KeyCache = new Map<string, { route: AscendRoute | null; at: number }>();
/** A coin with no pool yet (e.g. not on DexScreener yet) is looked up again after this long */
const V4_MISS_TTL_MS = 3 * 60_000;

/**
 * The pool key behind a pool id, from the PoolManager's Initialize event. Searches back from the newest block,
 * where launchpad pools usually are, in chunks an RPC accepts.
 */
export async function findV4PoolKey(provider: ethers.Provider, poolId: string, chunk = 150_000): Promise<V4PoolKey | null> {
  const iface = new ethers.Interface(INITIALIZE_ABI);
  const topic = iface.getEvent('Initialize')!.topicHash;
  const latest = await provider.getBlockNumber();
  for (let to = latest; to >= 0; to -= chunk) {
    const from = Math.max(0, to - chunk + 1);
    const filter = { address: ASCEND.poolManager, topics: [topic, poolId], fromBlock: from, toBlock: to };
    // A busy RPC can time out on a log search: try each chunk twice before giving up
    const logs = await provider.getLogs(filter).catch(() => provider.getLogs(filter));
    if (logs.length > 0) {
      const e = iface.parseLog(logs[0])!;
      return { currency0: e.args.currency0, currency1: e.args.currency1, fee: Number(e.args.fee), tickSpacing: Number(e.args.tickSpacing), hooks: e.args.hooks };
    }
  }
  return null;
}

/**
 * The deepest Uniswap v4 pool pairing a coin with HYPE (native or WHYPE) on Elysium's PoolManager, found
 * through DexScreener's Elysium listing and confirmed on chain. Covers launchpads RacerBot has no special
 * support for. Null when there is none.
 */
export async function findElysiumV4Route(provider: ethers.Provider, token: string): Promise<AscendRoute | null> {
  const key = token.toLowerCase();
  const cached = v4KeyCache.get(key);
  if (cached && (cached.route || Date.now() - cached.at < V4_MISS_TTL_MS)) return cached.route;
  // Fast path: the pool settings the Kleos app reports, accepted only when they hash to that pool's id
  const fromKleos = await v4RouteFromKleos(token).catch(() => null);
  if (fromKleos) {
    v4KeyCache.set(key, { route: fromKleos, at: Date.now() });
    return fromKleos;
  }
  const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${ethers.getAddress(token)}`, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`DexScreener returned ${res.status}`);
  const data: any = await res.json();
  const hypeQuotes = new Set([NATIVE, ASCEND.whype.toLowerCase()]);
  const pools = (data?.pairs ?? [])
    .filter((p: any) => p.chainId === 'elysium' && /^0x[0-9a-fA-F]{64}$/.test(p.pairAddress ?? '')
      && p.baseToken?.address?.toLowerCase() === key && hypeQuotes.has(String(p.quoteToken?.address).toLowerCase()))
    .sort((a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  for (const pair of pools.slice(0, 2)) {
    const poolKey = await findV4PoolKey(provider, pair.pairAddress);
    if (!poolKey || v4PoolId(poolKey) !== pair.pairAddress.toLowerCase()) continue;
    const quote = poolKey.currency0 === NATIVE ? NATIVE : ethers.getAddress(String(pair.quoteToken.address));
    const route: AscendRoute = { quote, quoteSymbol: quote === NATIVE ? 'HYPE' : 'WHYPE', launchKey: poolKey };
    v4KeyCache.set(key, { route, at: Date.now() });
    return route;
  }
  v4KeyCache.set(key, { route: null, at: Date.now() });
  return null;
}

/**
 * The coin's Uniswap v4 pool from the Kleos app's /api/asset (which names the pool id, hook, fee and tick
 * spacing). Used only for a pool on Elysium's Uniswap PoolManager traded through the Universal Router, paired
 * with native HYPE, and only when those settings hash to the pool id it names; anything else is ignored.
 */
async function v4RouteFromKleos(token: string): Promise<AscendRoute | null> {
  const res = await fetch(`https://www.thekleos.xyz/api/asset?address=${ethers.getAddress(token)}&interval=1h`, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) return null;
  const a: any = await res.json();
  if (a?.venue !== 'v4' || !a.pool?.id || !a.hooks || String(a.router).toLowerCase() !== ASCEND.universalRouter.toLowerCase()) return null;
  const launchKey: V4PoolKey = {
    currency0: NATIVE, currency1: ethers.getAddress(token), fee: Number(a.fee ?? 0), tickSpacing: Number(a.tickSpacing ?? 200), hooks: ethers.getAddress(a.hooks),
  };
  if (v4PoolId(launchKey) !== String(a.pool.id).toLowerCase()) return null;
  return { quote: NATIVE, quoteSymbol: 'HYPE', launchKey };
}

/**
 * Buys a little of the coin and sells part of it back in one simulated block (eth_simulateV1, a funded
 * throwaway address, nothing sent). Pools with an unknown hook can block sells; this catches that before any
 * real buy. 'unavailable' when the RPC cannot simulate.
 */
export async function simulateV4RoundTrip(provider: ethers.JsonRpcProvider, route: AscendRoute, token: string): Promise<'ok' | 'sell_blocked' | 'buy_blocked' | 'unavailable'> {
  const sim = '0x000000000000000000000000000000000000bEEF';
  const hypeIn = 10n ** 15n; // 0.001 HYPE
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const out = await quoteAscend(provider, route, token, 'buy', hypeIn).catch(() => 0n);
  if (out <= 0n) return 'buy_blocked';
  const sellAmount = out / 2n;
  const buy = encodeAscendBuy(route, token, hypeIn, 1n, sim, deadline);
  const sell = encodeAscendSell(route, token, sellAmount, 1n, sim, deadline);
  const erc20 = new ethers.Interface(['function approve(address,uint256) returns (bool)']);
  const permit2 = new ethers.Interface(PERMIT2_ABI);
  const q = ethers.toQuantity;
  let result: any;
  try {
    result = await provider.send('eth_simulateV1', [{
      blockStateCalls: [{
        stateOverrides: { [sim]: { balance: q(10n ** 18n) } },
        calls: [
          { from: sim, to: buy.to, data: buy.data, value: q(buy.value) },
          { from: sim, to: token, data: erc20.encodeFunctionData('approve', [ASCEND.permit2, sellAmount]) },
          { from: sim, to: ASCEND.permit2, data: permit2.encodeFunctionData('approve', [token, ASCEND.universalRouter, sellAmount, deadline]) },
          { from: sim, to: sell.to, data: sell.data, value: '0x0' },
        ],
      }],
      validation: false,
    }, 'latest']);
  } catch {
    return 'unavailable';
  }
  const calls = result?.[0]?.calls;
  if (!Array.isArray(calls) || calls.length !== 4) return 'unavailable';
  if (calls[0].status !== '0x1') return 'buy_blocked';
  return calls.every((c: any) => c.status === '0x1') ? 'ok' : 'sell_blocked';
}
