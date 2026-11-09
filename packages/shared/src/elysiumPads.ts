/**
 * BOXA and ElysPump, launchpads on Elysium mainnet that run their own Uniswap v4 PoolManager. Each coin trades
 * in one pool against native HYPE: currency0 = HYPE, currency1 = the coin, the pad's hook. Contract addresses
 * come from the Kleos app (its explorer labels and /api/asset, which names each coin's router and quoter).
 *  - BOXA: a small router with buy(key, minOut, recipient, deadline) / sell(key, amountIn, minOut, recipient,
 *    deadline); a sell needs the coin approved to the router.
 *  - ElysPump: a Universal Router (standard v4 swap params); a sell pulls the coin through Permit2.
 */
import { ethers } from 'ethers';
import { V4_QUOTER_ABI, PERMIT2_ABI, UNIVERSAL_ROUTER_ABI, v4PoolId, type V4PoolKey } from './ascend.js';

export type ElysiumPadName = 'boxa' | 'elyspump';

export interface ElysiumPad {
  name: ElysiumPadName;
  poolManager: string;
  hook: string;
  router: string;
  quoter: string;
  /** How the router is called */
  style: 'boxa' | 'universal';
}

export const ELYSIUM_PADS: Record<ElysiumPadName, ElysiumPad> = {
  boxa: {
    name: 'boxa',
    poolManager: '0x06C63714fBf1F5753017123E2FcfdEde4540B2c4',
    hook: '0xBCc1f22d137C1D98DFa5548E4d4261D7AeE06acC',
    router: '0x7d812380c241B331d753e8eEF1CEfDEA4e539496',
    quoter: '0x1aD2186a2734dc8715dea55967dF823fd6e6FEA4',
    style: 'boxa',
  },
  elyspump: {
    name: 'elyspump',
    poolManager: '0x5fb015a49f5b35073f9Ce01C2aDb287A75F89600',
    hook: '0xe11CaFA5901B0aaB51eB78251488400f9e4320Cc',
    router: '0x751Cefb96AC88DB5327D39E0FBdd5d882d80b430',
    quoter: '0x4861741785A8319a935741d0B570cafC33C4CA6B',
    style: 'universal',
  },
};

export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const NATIVE = ethers.ZeroAddress;

export interface PadRoute {
  pad: ElysiumPad;
  key: V4PoolKey;
}

const BOXA_ROUTER_ABI = [
  'function buy((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, uint256 minTokensOut, address recipient, uint256 deadline) payable returns (uint256)',
  'function sell((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, uint256 amountIn, uint256 minHypeOut, address recipient, uint256 deadline) returns (uint256)',
];

const coder = ethers.AbiCoder.defaultAbiCoder();
const POOL_KEY_T = 'tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)';
// Standard Uniswap v4 ExactInputSingleParams (ElysPump's router has no per-hop price limits)
const EXACT_IN_SINGLE_T = `tuple(${POOL_KEY_T} poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, bytes hookData)`;
const ACT = { SWAP_EXACT_IN_SINGLE: 0x06, SETTLE_ALL: 0x0c, TAKE: 0x0e } as const;
const V4_SWAP = 0x10;

function padKey(pad: ElysiumPad, token: string, fee: number, tickSpacing: number): V4PoolKey {
  return { currency0: NATIVE, currency1: ethers.getAddress(token), fee, tickSpacing, hooks: ethers.getAddress(pad.hook) };
}

async function quoteOn(provider: ethers.Provider, pad: ElysiumPad, key: V4PoolKey, zeroForOne: boolean, amount: bigint): Promise<bigint> {
  const q = new ethers.Contract(pad.quoter, V4_QUOTER_ABI, provider);
  const [out] = await q.quoteExactInputSingle.staticCall({ poolKey: key, zeroForOne, exactAmount: amount, hookData: '0x' });
  return out;
}

/** Pool settings the Kleos app reports for a coin, used when the usual settings don't quote */
async function kleosAssetPoolSettings(token: string): Promise<{ hooks: string; router: string; quoter: string; fee: number; tickSpacing: number } | null> {
  const res = await fetch(`https://www.thekleos.xyz/api/asset?address=${ethers.getAddress(token)}&interval=1h`, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) return null;
  const a: any = await res.json();
  if (a?.venue !== 'v4' || !a.hooks || !a.router || !a.quoter) return null;
  return { hooks: a.hooks, router: a.router, quoter: a.quoter, fee: Number(a.fee ?? 0), tickSpacing: Number(a.tickSpacing ?? 200) };
}

/**
 * The BOXA or ElysPump pool of a coin, proven by a quote on that pad's own quoter. The usual pool settings
 * (fee 0, tick spacing 200) are tried on chain first; otherwise the Kleos app's settings are used, but only
 * for a known pad's hook, router and quoter. Null when neither pad trades the coin.
 */
export async function findPadRoute(provider: ethers.Provider, token: string, options: { askKleos?: boolean } = {}): Promise<PadRoute | null> {
  if (!ethers.isAddress(token)) return null;
  const probe = 10n ** 15n; // 0.001 HYPE
  for (const pad of Object.values(ELYSIUM_PADS)) {
    const key = padKey(pad, token, 0, 200);
    if ((await quoteOn(provider, pad, key, true, probe).catch(() => 0n)) > 0n) return { pad, key };
  }
  if (options.askKleos === false) return null;
  const settings = await kleosAssetPoolSettings(token).catch(() => null);
  if (!settings) return null;
  const pad = Object.values(ELYSIUM_PADS).find(p =>
    p.hook.toLowerCase() === settings.hooks.toLowerCase() &&
    p.router.toLowerCase() === settings.router.toLowerCase() &&
    p.quoter.toLowerCase() === settings.quoter.toLowerCase());
  if (!pad) return null;
  const key = padKey(pad, token, settings.fee, settings.tickSpacing);
  return (await quoteOn(provider, pad, key, true, probe).catch(() => 0n)) > 0n ? { pad, key } : null;
}

export function padPoolId(route: PadRoute): string {
  return v4PoolId(route.key);
}

/** Coins out for `amountIn` HYPE (buy), or HYPE out for `amountIn` coins (sell) */
export function quotePad(provider: ethers.Provider, route: PadRoute, side: 'buy' | 'sell', amountIn: bigint): Promise<bigint> {
  return quoteOn(provider, route.pad, route.key, side === 'buy', amountIn);
}

function universalSwap(route: PadRoute, zeroForOne: boolean, amountIn: bigint, minOut: bigint, settleCurrency: string, takeCurrency: string, recipient: string, deadline: bigint): string {
  const actions = ethers.hexlify(new Uint8Array([ACT.SWAP_EXACT_IN_SINGLE, ACT.SETTLE_ALL, ACT.TAKE]));
  const params = [
    coder.encode([EXACT_IN_SINGLE_T], [{ poolKey: route.key, zeroForOne, amountIn, amountOutMinimum: minOut, hookData: '0x' }]),
    coder.encode(['address', 'uint256'], [settleCurrency, amountIn]),
    coder.encode(['address', 'address', 'uint256'], [takeCurrency, recipient, 0n]),
  ];
  const input = coder.encode(['bytes', 'bytes[]'], [actions, params]);
  return new ethers.Interface(UNIVERSAL_ROUTER_ABI).encodeFunctionData('execute', [ethers.hexlify(new Uint8Array([V4_SWAP])), [input], deadline]);
}

/** A buy paid in native HYPE (the call's value); the coins go to `recipient`, nothing stays in the router */
export function encodePadBuy(route: PadRoute, hypeIn: bigint, minOut: bigint, recipient: string, deadline: bigint): { to: string; data: string; value: bigint } {
  const to = route.pad.router;
  if (route.pad.style === 'boxa') {
    return { to, data: new ethers.Interface(BOXA_ROUTER_ABI).encodeFunctionData('buy', [route.key, minOut, recipient, deadline]), value: hypeIn };
  }
  return { to, data: universalSwap(route, true, hypeIn, minOut, NATIVE, route.key.currency1, recipient, deadline), value: hypeIn };
}

/** A sell of `amountIn` coins for native HYPE to `recipient` */
export function encodePadSell(route: PadRoute, amountIn: bigint, minOut: bigint, recipient: string, deadline: bigint): { to: string; data: string; value: bigint } {
  const to = route.pad.router;
  if (route.pad.style === 'boxa') {
    return { to, data: new ethers.Interface(BOXA_ROUTER_ABI).encodeFunctionData('sell', [route.key, amountIn, minOut, recipient, deadline]), value: 0n };
  }
  return { to, data: universalSwap(route, false, amountIn, minOut, route.key.currency1, NATIVE, recipient, deadline), value: 0n };
}

/**
 * Approvals a sell needs: BOXA's router takes the coin directly (exact amount); ElysPump's pulls it through
 * Permit2 (the coin to Permit2, then Permit2 to the router for 30 minutes).
 */
export async function padSellApprovals(provider: ethers.Provider, route: PadRoute, owner: string, amountIn: bigint): Promise<{ to: string; data: string; value: bigint }[]> {
  const token = route.key.currency1;
  const erc20 = new ethers.Contract(token, ['function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)'], provider);
  if (route.pad.style === 'boxa') {
    const allowed: bigint = await erc20.allowance(owner, route.pad.router);
    return allowed >= amountIn ? [] : [{ to: token, data: erc20.interface.encodeFunctionData('approve', [route.pad.router, amountIn]), value: 0n }];
  }
  const permit2 = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, provider);
  const [toPermit2, p2] = await Promise.all([
    erc20.allowance(owner, PERMIT2_ADDRESS) as Promise<bigint>,
    permit2.allowance(owner, token, route.pad.router) as Promise<[bigint, bigint, bigint]>,
  ]);
  const calls: { to: string; data: string; value: bigint }[] = [];
  if (toPermit2 < amountIn) calls.push({ to: token, data: erc20.interface.encodeFunctionData('approve', [PERMIT2_ADDRESS, amountIn]), value: 0n });
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (BigInt(p2[0]) < amountIn || BigInt(p2[1]) < now + 120n) {
    calls.push({ to: PERMIT2_ADDRESS, data: permit2.interface.encodeFunctionData('approve', [token, route.pad.router, amountIn, now + 1800n]), value: 0n });
  }
  return calls;
}

/** The approvals a throwaway address would need to sell (for simulations, where nothing is approved yet) */
export function padSimApprovals(route: PadRoute, amount: bigint, deadline: bigint): { to: string; data: string }[] {
  const token = route.key.currency1;
  const erc20 = new ethers.Interface(['function approve(address,uint256) returns (bool)']);
  if (route.pad.style === 'boxa') return [{ to: token, data: erc20.encodeFunctionData('approve', [route.pad.router, amount]) }];
  const permit2 = new ethers.Interface(PERMIT2_ABI);
  return [
    { to: token, data: erc20.encodeFunctionData('approve', [PERMIT2_ADDRESS, amount]) },
    { to: PERMIT2_ADDRESS, data: permit2.encodeFunctionData('approve', [token, route.pad.router, amount, deadline]) },
  ];
}
