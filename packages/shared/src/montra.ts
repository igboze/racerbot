/**
 * Montra Markets (montramarkets.xyz): launchpad on Elysium mainnet (chain 99901).
 *
 * Every Montra coin is deployed by LaunchFactory into the shared Uniswap v4 PoolManager
 * (0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1) with Montra's LaunchHook
 * (0x6b1216A40B65c83e9c9e18a562C446697B8cf8EC) and dynamic fee flag 0x800000 (tickSpacing 200).
 *Each token contract exposes `poolId()` and `hook()`, and LaunchHook exposes `poolKey(bytes32)`.
 *
 * Coins paired with native HYPE (currency0 = 0x0) trade directly through Montra's LaunchRouter
 * (0xc6E9a8E1a99023B67067B8A3605403b8d7B3A157). Coins paired with an ERC-20 quote token
 * (such as KNTQ, USDC, or WHYPE) trade in one two-hop v4 swap (HYPE <-> Quote <-> Coin)
 * through Montra's UniversalRouter (0xA13f7611115752DEB2B13813BDDE16A5073e4b45).
 */
import { ethers } from 'ethers';
import type { EvmCall } from './kleos.js';
import type { V4PoolKey } from './ascend.js';

export const MONTRA = {
  registry: '0xF1E2FA75422F889e565F3142bdbf60B28dce2aa7',
  factory: '0x38d3Ef3A06d18FA3286fB5dEAfe611Be725fcD15',
  lens: '0xb4C202910C40c3A83F6C55683460790aAEC487D4',
  poolManager: '0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1',
  router: '0xc6E9a8E1a99023B67067B8A3605403b8d7B3A157',
  universalRouter: '0xA13f7611115752DEB2B13813BDDE16A5073e4b45',
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  hook: '0x6b1216A40B65c83e9c9e18a562C446697B8cf8EC',
  whype: '0xbA876237B0F021A6c6D852d6c26E107997cC5E81',
  kntq: '0xe45a355d9e9cAd2aD85F2d03E3eE3102A036acF0',
  usdc: '0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65',
} as const;

export const MONTRA_TOKEN_URL = 'https://montramarkets.xyz/token/';
export const MONTRA_API_URL = 'https://api.montramarkets.xyz';

const POOL_KEY_TUPLE = 'tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)';
const PATH_KEY_TUPLE = 'tuple(address intermediateCurrency, uint24 fee, int24 tickSpacing, address hooks, bytes hookData)';
/** Montra's UniversalRouter includes a `uint256[] hopSlippage` array between `path` and `amountIn` */
const MONTRA_EXACT_IN_PARAMS = `tuple(address currencyIn, ${PATH_KEY_TUPLE}[] path, uint256[] hopSlippage, uint128 amountIn, uint128 amountOutMinimum)`;

const MONTRA_TOKEN_ABI = [
  'function poolId() view returns (bytes32)',
  'function hook() view returns (address)',
];

const MONTRA_HOOK_ABI = [
  `function poolKey(bytes32 poolId) view returns (${POOL_KEY_TUPLE})`,
];

const MONTRA_ROUTER_ABI = [
  `function quoteExactIn(${POOL_KEY_TUPLE} key, bool zeroForOne, uint128 amountIn) external returns (uint256 amountOut)`,
  `function swapExactIn(tuple(${POOL_KEY_TUPLE} key, bool zeroForOne, uint128 amountIn, uint128 minAmountOut, address recipient, uint256 deadline) s) external payable returns (uint256 amountOut)`,
];

const UNIVERSAL_ROUTER_ABI = [
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
];

const PERMIT2_ABI = [
  'function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
];

const ERC20_APPROVE_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

const CMD_V4_SWAP = '0x10';
const ACT = {
  SWAP_EXACT_IN: 0x07,
  SETTLE: 0x0b,
  TAKE: 0x0e,
} as const;

const HYPE_HOP_TIERS: ReadonlyArray<readonly [number, number]> = [
  [3000, 60],
  [10000, 200],
  [100, 1],
  [500, 10],
  [2500, 50],
];

const LAUNCH_ROUTER_IFACE = new ethers.Interface(MONTRA_ROUTER_ABI);
const UNIVERSAL_ROUTER_IFACE = new ethers.Interface(UNIVERSAL_ROUTER_ABI);
const PERMIT2_IFACE = new ethers.Interface(PERMIT2_ABI);
const ERC20_IFACE = new ethers.Interface(ERC20_APPROVE_ABI);
const coder = ethers.AbiCoder.defaultAbiCoder();

export interface MontraLaunchInfo {
  poolId: string;
  hook: string;
  launchKey: V4PoolKey;
  quote: string;
  quoteIsCurrency0: boolean;
}

export interface MontraRoute extends MontraLaunchInfo {
  router: string;
  /** Set when `quote` is not native HYPE (e.g. KNTQ): the HYPE <-> quote pool used as hop 1 on buys and hop 2 on sells */
  hypeHop?: V4PoolKey;
}

/**
 * Checks on chain whether `token` is a Montra Markets launch token by reading `poolId()` and `hook()`
 * from the token and verifying the pool key registered on Montra's LaunchHook.
 */
export async function getMontraLaunch(
  provider: ethers.Provider,
  token: string,
): Promise<MontraLaunchInfo | null> {
  if (!ethers.isAddress(token)) return null;
  const addr = ethers.getAddress(token);
  const tok = new ethers.Contract(addr, MONTRA_TOKEN_ABI, provider);
  try {
    const [poolId, hook] = await Promise.all([
      tok.poolId() as Promise<string>,
      tok.hook() as Promise<string>,
    ]);
    if (!poolId || poolId === ethers.ZeroHash || !hook) return null;
    if (hook.toLowerCase() !== MONTRA.hook.toLowerCase()) return null;

    const hookContract = new ethers.Contract(MONTRA.hook, MONTRA_HOOK_ABI, provider);
    const rawKey = await hookContract.poolKey(poolId);
    const currency0 = ethers.getAddress(String(rawKey.currency0));
    const currency1 = ethers.getAddress(String(rawKey.currency1));
    const tokenLower = addr.toLowerCase();
    if (currency0.toLowerCase() !== tokenLower && currency1.toLowerCase() !== tokenLower) {
      return null;
    }
    const quoteIsCurrency0 = currency1.toLowerCase() === tokenLower;
    const quote = quoteIsCurrency0 ? currency0 : currency1;
    const launchKey: V4PoolKey = {
      currency0,
      currency1,
      fee: Number(rawKey.fee),
      tickSpacing: Number(rawKey.tickSpacing),
      hooks: ethers.getAddress(String(rawKey.hooks)),
    };
    return {
      poolId,
      hook: ethers.getAddress(hook),
      launchKey,
      quote,
      quoteIsCurrency0,
    };
  } catch {
    return null;
  }
}

/**
 * Resolves the trading route for a Montra coin from native HYPE.
 * Native HYPE-paired coins trade through `MONTRA.router` (LaunchRouter);
 * ERC-20 quote-paired coins (such as KNTQ) trade through `MONTRA.universalRouter` via a HYPE <-> quote hop.
 */
export async function resolveMontraRoute(
  provider: ethers.Provider,
  token: string,
): Promise<MontraRoute | null> {
  const launch = await getMontraLaunch(provider, token);
  if (!launch) return null;

  if (launch.quote === ethers.ZeroAddress) {
    return {
      ...launch,
      router: MONTRA.router,
    };
  }

  const router = new ethers.Contract(MONTRA.router, MONTRA_ROUTER_ABI, provider);
  const probeIn = 10n ** 16n; // 0.01 HYPE
  const hopCandidates = await Promise.all(
    HYPE_HOP_TIERS.map(async ([fee, tickSpacing]) => {
      const key: V4PoolKey = {
        currency0: ethers.ZeroAddress,
        currency1: launch.quote,
        fee,
        tickSpacing,
        hooks: ethers.ZeroAddress,
      };
      const out = await router.quoteExactIn.staticCall(key, true, probeIn).then(BigInt).catch(() => 0n);
      return { key, out };
    }),
  );

  const bestHop = hopCandidates.reduce(
    (best, cur) => (cur.out > best.out ? cur : best),
    { key: hopCandidates[0].key, out: 0n },
  );
  if (bestHop.out <= 0n) return null;

  return {
    ...launch,
    router: MONTRA.universalRouter,
    hypeHop: bestHop.key,
  };
}

/**
 * Quotes a Montra buy (HYPE in -> coins out) or sell (coins in -> HYPE out) on chain
 * via Montra's LaunchRouter `quoteExactIn`.
 */
export async function quoteMontra(
  provider: ethers.Provider,
  route: MontraRoute,
  _token: string,
  side: 'buy' | 'sell',
  amountIn: bigint,
): Promise<bigint> {
  if (amountIn <= 0n) return 0n;
  const router = new ethers.Contract(MONTRA.router, MONTRA_ROUTER_ABI, provider);

  if (!route.hypeHop) {
    const zeroForOne = side === 'buy' ? route.quoteIsCurrency0 : !route.quoteIsCurrency0;
    return BigInt(await router.quoteExactIn.staticCall(route.launchKey, zeroForOne, amountIn));
  }

  if (side === 'buy') {
    const mid = BigInt(await router.quoteExactIn.staticCall(route.hypeHop, true, amountIn));
    if (mid <= 0n) return 0n;
    return BigInt(await router.quoteExactIn.staticCall(route.launchKey, route.quoteIsCurrency0, mid));
  } else {
    const mid = BigInt(await router.quoteExactIn.staticCall(route.launchKey, !route.quoteIsCurrency0, amountIn));
    if (mid <= 0n) return 0n;
    return BigInt(await router.quoteExactIn.staticCall(route.hypeHop, false, mid));
  }
}

export function encodeMontraBuy(
  route: MontraRoute,
  token: string,
  hypeIn: bigint,
  minOut: bigint,
  recipient: string,
  deadline: bigint,
): EvmCall {
  const coin = ethers.getAddress(token);
  const to = ethers.getAddress(recipient);

  if (!route.hypeHop) {
    return {
      to: MONTRA.router,
      value: hypeIn,
      data: LAUNCH_ROUTER_IFACE.encodeFunctionData('swapExactIn', [
        {
          key: route.launchKey,
          zeroForOne: route.quoteIsCurrency0,
          amountIn: hypeIn,
          minAmountOut: minOut,
          recipient: to,
          deadline,
        },
      ]),
    };
  }

  const actions = ethers.concat([new Uint8Array([ACT.SWAP_EXACT_IN, ACT.SETTLE, ACT.TAKE])]);
  const path = [
    {
      intermediateCurrency: route.quote,
      fee: route.hypeHop.fee,
      tickSpacing: route.hypeHop.tickSpacing,
      hooks: route.hypeHop.hooks,
      hookData: '0x',
    },
    {
      intermediateCurrency: coin,
      fee: route.launchKey.fee,
      tickSpacing: route.launchKey.tickSpacing,
      hooks: route.launchKey.hooks,
      hookData: '0x',
    },
  ];
  const params = [
    coder.encode(
      [MONTRA_EXACT_IN_PARAMS],
      [{ currencyIn: ethers.ZeroAddress, path, hopSlippage: [], amountIn: hypeIn, amountOutMinimum: minOut }],
    ),
    coder.encode(['address', 'uint256', 'bool'], [ethers.ZeroAddress, hypeIn, false]),
    coder.encode(['address', 'address', 'uint256'], [coin, to, 0n]),
  ];
  const v4Input = coder.encode(['bytes', 'bytes[]'], [actions, params]);
  return {
    to: MONTRA.universalRouter,
    value: hypeIn,
    data: UNIVERSAL_ROUTER_IFACE.encodeFunctionData('execute', [CMD_V4_SWAP, [v4Input], deadline]),
  };
}

export function encodeMontraSell(
  route: MontraRoute,
  token: string,
  amountIn: bigint,
  minOut: bigint,
  recipient: string,
  deadline: bigint,
): EvmCall {
  const coin = ethers.getAddress(token);
  const to = ethers.getAddress(recipient);

  if (!route.hypeHop) {
    return {
      to: MONTRA.router,
      value: 0n,
      data: LAUNCH_ROUTER_IFACE.encodeFunctionData('swapExactIn', [
        {
          key: route.launchKey,
          zeroForOne: !route.quoteIsCurrency0,
          amountIn,
          minAmountOut: minOut,
          recipient: to,
          deadline,
        },
      ]),
    };
  }

  const actions = ethers.concat([new Uint8Array([ACT.SWAP_EXACT_IN, ACT.SETTLE, ACT.TAKE])]);
  const path = [
    {
      intermediateCurrency: route.quote,
      fee: route.launchKey.fee,
      tickSpacing: route.launchKey.tickSpacing,
      hooks: route.launchKey.hooks,
      hookData: '0x',
    },
    {
      intermediateCurrency: ethers.ZeroAddress,
      fee: route.hypeHop.fee,
      tickSpacing: route.hypeHop.tickSpacing,
      hooks: route.hypeHop.hooks,
      hookData: '0x',
    },
  ];
  const params = [
    coder.encode(
      [MONTRA_EXACT_IN_PARAMS],
      [{ currencyIn: coin, path, hopSlippage: [], amountIn, amountOutMinimum: minOut }],
    ),
    // payerIsUser = true: UniversalRouter pulls `coin` from msg.sender through Permit2
    coder.encode(['address', 'uint256', 'bool'], [coin, amountIn, true]),
    coder.encode(['address', 'address', 'uint256'], [ethers.ZeroAddress, to, 0n]),
  ];
  const v4Input = coder.encode(['bytes', 'bytes[]'], [actions, params]);
  return {
    to: MONTRA.universalRouter,
    value: 0n,
    data: UNIVERSAL_ROUTER_IFACE.encodeFunctionData('execute', [CMD_V4_SWAP, [v4Input], deadline]),
  };
}

/**
 * Approval calls needed before a Montra sell.
 * Direct HYPE-paired coins approve Montra's LaunchRouter directly;
 * multi-hop quote-paired coins approve Permit2 and grant Montra's UniversalRouter a Permit2 allowance.
 */
export async function montraSellApprovals(
  provider: ethers.Provider,
  route: MontraRoute,
  token: string,
  owner: string,
  amountIn: bigint,
): Promise<EvmCall[]> {
  const erc20 = new ethers.Contract(token, ERC20_APPROVE_ABI, provider);

  if (!route.hypeHop) {
    const allowance = (await erc20.allowance(owner, MONTRA.router)) as bigint;
    if (allowance >= amountIn) return [];
    return [
      {
        to: token,
        value: 0n,
        data: ERC20_IFACE.encodeFunctionData('approve', [MONTRA.router, ethers.MaxUint256]),
      },
    ];
  }

  const permit2 = new ethers.Contract(MONTRA.permit2, PERMIT2_ABI, provider);
  const [erc20Allowance, permit2Allowance] = await Promise.all([
    erc20.allowance(owner, MONTRA.permit2) as Promise<bigint>,
    permit2.allowance(owner, token, MONTRA.universalRouter) as Promise<[bigint, bigint, bigint]>,
  ]);
  const calls: EvmCall[] = [];
  if (erc20Allowance < amountIn) {
    calls.push({
      to: token,
      value: 0n,
      data: ERC20_IFACE.encodeFunctionData('approve', [MONTRA.permit2, ethers.MaxUint256]),
    });
  }
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (permit2Allowance[0] < amountIn || permit2Allowance[1] <= nowSec + 60n) {
    const maxUint160 = (1n << 160n) - 1n;
    const maxUint48 = (1n << 48n) - 1n;
    calls.push({
      to: MONTRA.permit2,
      value: 0n,
      data: PERMIT2_IFACE.encodeFunctionData('approve', [token, MONTRA.universalRouter, maxUint160, maxUint48]),
    });
  }
  return calls;
}

// ── Montra Public API Board & Token Lookup ──────────────────────────────────

export interface MontraApiToken {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  imageUrl?: string | null;
  description?: string | null;
  creator?: string;
  poolId?: string;
  quote?: {
    address: string;
    symbol: string;
    decimals: number;
    native: boolean;
    usd?: number;
  };
  supply?: number;
  burned?: number;
  price?: number;
  priceUsd?: number;
  marketCap?: number;
  marketCapUsd?: number;
  volume24h?: number;
  volume24hUsd?: number;
  change24hPct?: number | null;
  holders?: number;
  totalFeePips?: number;
  recipientKind?: string;
  graduation?: {
    stage?: string;
    progressBps?: number;
  };
  pool?: {
    totalFeePips?: number;
    lpFeePips?: number;
    protocolFeePips?: number;
    earlyBuyFeeWindow?: number;
    earlyBuyFeeUntil?: number;
    earlyBuyFeeStartPips?: number;
    quoteIsCurrency0?: boolean;
  };
  live?: {
    sqrtPriceX96?: string;
    buyFee?: number;
    buyEffectiveTotalFee?: number;
    effectiveTotalFee?: number;
    graduationProgressBps?: number;
  };
}

let montraBoardCache: { at: number; tokens: MontraApiToken[] } | null = null;
const montraTokenCache = new Map<string, { at: number; token: MontraApiToken | null }>();

/**
 * Lists coins on Montra Markets (`https://api.montramarkets.xyz/api/tokens?limit=100`), cached for 30s.
 */
export async function listMontraTokens(): Promise<MontraApiToken[]> {
  if (montraBoardCache && Date.now() - montraBoardCache.at < 30_000) {
    return montraBoardCache.tokens;
  }
  const res = await fetch(`${MONTRA_API_URL}/api/tokens?limit=100`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`Montra board HTTP ${res.status}`);
  const body = (await res.json()) as { tokens?: MontraApiToken[] };
  const tokens = Array.isArray(body?.tokens) ? body.tokens : [];
  montraBoardCache = { at: Date.now(), tokens };
  return tokens;
}

/**
 * Fetches a single coin from Montra Markets' API (`https://api.montramarkets.xyz/api/tokens/:address`),
 * cached for 15s. Returns null when the coin is not listed on Montra.
 */
export async function getMontraToken(address: string): Promise<MontraApiToken | null> {
  if (!ethers.isAddress(address)) return null;
  const lower = address.toLowerCase();
  const cached = montraTokenCache.get(lower);
  if (cached && Date.now() - cached.at < 15_000) {
    return cached.token;
  }
  try {
    const res = await fetch(`${MONTRA_API_URL}/api/tokens/${lower}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(3500),
    });
    if (res.status === 404) {
      montraTokenCache.set(lower, { at: Date.now(), token: null });
      return null;
    }
    if (res.ok) {
      const token = (await res.json()) as MontraApiToken;
      if (token && typeof token.address === 'string') {
        montraTokenCache.set(lower, { at: Date.now(), token });
        return token;
      }
    }
  } catch {
    // Fall back to board list if single-token endpoint times out
  }
  const list = await listMontraTokens().catch(() => []);
  const found = list.find(t => String(t.address).toLowerCase() === lower) ?? null;
  if (found) montraTokenCache.set(lower, { at: Date.now(), token: found });
  return found;
}

