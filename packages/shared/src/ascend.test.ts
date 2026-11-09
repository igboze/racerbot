import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import {
  ASCEND,
  ASCEND_QUOTES,
  ascendLaunchKey,
  v4PoolId,
  encodeAscendBuy,
  encodeAscendSell,
  UNIVERSAL_ROUTER_ABI,
  findElysiumV4Route,
  type AscendRoute,
} from './ascend.js';
import { vi } from 'vitest';
import { describeKleosRevert, elysiumPadName, elysiumPadUrl, isElysiumPadVenue, encodeKleosBuy, encodeKleosBuyWithTransfers } from './kleos.js';

// ORPHEUS, launched on Ascend against WHYPE; its launch pool id is the one DexScreener lists
const ORPHEUS = '0x7701a31c0b3815fe6d09a8a313967c5977a5fa7a';
const USER = '0x00000000000000000000000000000000000000A1';
const DEADLINE = 1_800_000_000n;
const coder = ethers.AbiCoder.defaultAbiCoder();
const ur = new ethers.Interface(UNIVERSAL_ROUTER_ABI);
const POOL_KEY_T = 'tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)';
const PATH_KEY_T = 'tuple(address intermediateCurrency, uint24 fee, int24 tickSpacing, address hooks, bytes hookData)';

function decode(data: string) {
  const [commands, inputs, deadline] = ur.decodeFunctionData('execute', data).toArray();
  const [actions, params] = coder.decode(['bytes', 'bytes[]'], inputs[ethers.getBytes(commands).indexOf(0x10)]).toArray();
  return { commands: [...ethers.getBytes(commands)], inputs, deadline, actions: [...ethers.getBytes(actions)], params };
}

const whypeRoute: AscendRoute = { quote: ASCEND.whype, quoteSymbol: 'WHYPE', launchKey: ascendLaunchKey(ORPHEUS, ASCEND.whype) };
const kntqRoute: AscendRoute = {
  quote: ASCEND_QUOTES.KNTQ, quoteSymbol: 'KNTQ', launchKey: ascendLaunchKey(ORPHEUS, ASCEND_QUOTES.KNTQ),
  hypeHop: { currency0: ethers.ZeroAddress, currency1: ASCEND_QUOTES.KNTQ, fee: 10000, tickSpacing: 200, hooks: ethers.ZeroAddress },
};

describe('Ascend launch pools', () => {
  it('derives the launch pool from the coin, its quote and the launchpad hook', () => {
    const key = ascendLaunchKey(ORPHEUS, ASCEND.whype);
    expect(key).toMatchObject({ fee: 0x800000, tickSpacing: 200, hooks: ASCEND.launchpad });
    expect(v4PoolId(key)).toBe('0x3a077faaacdeda490aca701b05b8c2f224f8c67455e55a41f24dfa428c9b7fc5');
  });

  it('names Ascend as an Elysium launchpad with its own token page', () => {
    expect(isElysiumPadVenue('ascend')).toBe(true);
    expect(isElysiumPadVenue('hyperevm_dex')).toBe(false);
    expect(elysiumPadName('ascend')).toBe('Ascend');
    expect(elysiumPadUrl('ascend', ORPHEUS)).toBe(`https://app.ascendlaunch.xyz/tokens/${ORPHEUS}`);
  });
});

describe('Ascend Universal Router calls', () => {
  it('buys a WHYPE coin: wraps exactly the HYPE sent, swaps, and sends the coins to the user', () => {
    const buy = encodeAscendBuy(whypeRoute, ORPHEUS, 1000n, 900n, USER, DEADLINE);
    expect(buy).toMatchObject({ to: ASCEND.universalRouter, value: 1000n });
    const d = decode(buy.data);
    expect(d.commands).toEqual([0x0b, 0x10]); // WRAP_ETH, V4_SWAP
    expect(coder.decode(['address', 'uint256'], d.inputs[0]).toArray()).toEqual(['0x0000000000000000000000000000000000000002', 1000n]);
    expect(d.actions).toEqual([0x06, 0x0b, 0x0e]); // SWAP_EXACT_IN_SINGLE, SETTLE, TAKE
    const [swap] = coder.decode([`tuple(${POOL_KEY_T} poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, uint256 minHopPriceX36, bytes hookData)`], d.params[0]);
    expect([swap.zeroForOne, swap.amountIn, swap.amountOutMinimum]).toEqual([BigInt(ASCEND.whype) < BigInt(ORPHEUS), 1000n, 900n]);
    expect(coder.decode(['address', 'address', 'uint256'], d.params[2]).toArray()).toEqual([ethers.getAddress(ORPHEUS), USER, 0n]);
    expect(d.deadline).toBe(DEADLINE);
  });

  it('buys a KNTQ coin from native HYPE through the KNTQ pool, then the launch pool', () => {
    const d = decode(encodeAscendBuy(kntqRoute, ORPHEUS, 1000n, 900n, USER, DEADLINE).data);
    expect(d.commands).toEqual([0x10]);
    expect(d.actions).toEqual([0x07, 0x0b, 0x0e]); // SWAP_EXACT_IN, SETTLE (native), TAKE
    const [swap] = coder.decode([`tuple(address currencyIn, ${PATH_KEY_T}[] path, uint256[] minHopPriceX36, uint128 amountIn, uint128 amountOutMinimum)`], d.params[0]);
    expect(swap.currencyIn).toBe(ethers.ZeroAddress);
    expect(swap.path.map((h: any) => [h.intermediateCurrency, h.hooks])).toEqual([
      [ASCEND_QUOTES.KNTQ, ethers.ZeroAddress],
      [ethers.getAddress(ORPHEUS), ASCEND.launchpad],
    ]);
  });

  it('sells a WHYPE coin: pulls the coins via Permit2, takes WHYPE into the router and unwraps it to the user', () => {
    const sell = encodeAscendSell(whypeRoute, ORPHEUS, 5000n, 40n, USER, DEADLINE);
    expect(sell.value).toBe(0n);
    const d = decode(sell.data);
    expect(d.commands).toEqual([0x10, 0x0c]); // V4_SWAP, UNWRAP_WETH
    expect(d.actions).toEqual([0x06, 0x0c, 0x0e]); // SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE
    expect(coder.decode(['address', 'uint256'], d.params[1]).toArray()).toEqual([ethers.getAddress(ORPHEUS), 5000n]);
    expect(coder.decode(['address', 'uint256'], d.inputs[1]).toArray()).toEqual([USER, 40n]);
  });

  it('pays the platform fee in the same Multicall3 call, through the shared Kleos buy encoder', () => {
    const swap = encodeKleosBuy({ kind: 'ascend', router: ASCEND.universalRouter, hopFee: 0, ascend: whypeRoute }, ORPHEUS, 985n, 900n, USER, DEADLINE);
    const call = encodeKleosBuyWithTransfers([{ to: USER, value: 15n }], swap);
    expect(call.value).toBe(1000n);
  });

  it('explains Uniswap v4 reverts the quoter wraps, in plain words', () => {
    const iface = new ethers.Interface(['error NotEnoughLiquidity(bytes32 poolId)', 'error UnexpectedRevertBytes(bytes revertData)', 'error V4TooLittleReceived(uint256,uint256)']);
    const inner = iface.encodeErrorResult('NotEnoughLiquidity', [ethers.ZeroHash]);
    expect(describeKleosRevert({ data: iface.encodeErrorResult('UnexpectedRevertBytes', [inner]) })).toMatch(/no HYPE in it to pay for a sell/);
    expect(describeKleosRevert({ data: iface.encodeErrorResult('V4TooLittleReceived', [2n, 1n]) })).toMatch(/slippage/);
  });
});

describe('Coins from other Elysium launchpads (any Uniswap v4 pool against HYPE)', () => {
  const HYPEJAK = '0xFC877FDdA01522876E398bcf1657aF183631bA38';
  const HOOK = '0x6b1216A40B65c83e9c9e18a562C446697B8cf8EC';
  const key = { currency0: ethers.ZeroAddress, currency1: HYPEJAK, fee: 0x800000, tickSpacing: 200, hooks: HOOK };
  const nativeRoute: AscendRoute = { quote: ethers.ZeroAddress, quoteSymbol: 'HYPE', launchKey: key };

  it('buys with native HYPE straight into the pool: no wrapping, the HYPE sent is settled', () => {
    const d = decode(encodeAscendBuy(nativeRoute, HYPEJAK, 1000n, 900n, USER, DEADLINE).data);
    expect(d.commands).toEqual([0x10]);
    expect(d.actions).toEqual([0x06, 0x0b, 0x0e]);
    const [swap] = coder.decode([`tuple(${POOL_KEY_T} poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, uint256 minHopPriceX36, bytes hookData)`], d.params[0]);
    expect([swap.zeroForOne, swap.poolKey.hooks]).toEqual([true, HOOK]);
    expect(coder.decode(['address', 'uint256', 'bool'], d.params[1]).toArray()).toEqual([ethers.ZeroAddress, 0n, false]);
  });

  it('sells for native HYPE paid straight to the user', () => {
    const d = decode(encodeAscendSell(nativeRoute, HYPEJAK, 5000n, 40n, USER, DEADLINE).data);
    expect(d.commands).toEqual([0x10]);
    expect(coder.decode(['address', 'address', 'uint256'], d.params[2]).toArray()).toEqual([ethers.ZeroAddress, USER, 0n]);
  });

  it('finds the pool from DexScreener and confirms its key from the chain', async () => {
    const poolId = v4PoolId(key);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ pairs: [
      { chainId: 'hyperevm', pairAddress: '0x' + '1'.repeat(64), baseToken: { address: HYPEJAK }, quoteToken: { address: ethers.ZeroAddress }, liquidity: { usd: 1e9 } },
      { chainId: 'elysium', pairAddress: poolId, baseToken: { address: HYPEJAK }, quoteToken: { address: ethers.ZeroAddress }, liquidity: { usd: 16543 } },
    ] }), { status: 200 })));
    const iface = new ethers.Interface(['event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)']);
    const log = iface.encodeEventLog('Initialize', [poolId, key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks, 1n, 0]);
    const provider = {
      getBlockNumber: async () => 3_500_000,
      getLogs: vi.fn(async (f: any) => (f.toBlock === 3_500_000 ? [{ ...log, address: ASCEND.poolManager }] : [])),
    } as any;
    const route = await findElysiumV4Route(provider, HYPEJAK);
    expect(route).toEqual({ quote: ethers.ZeroAddress, quoteSymbol: 'HYPE', launchKey: expect.objectContaining({ hooks: HOOK, fee: 0x800000 }) });
    vi.unstubAllGlobals();
  });

  it('takes a pool from the Kleos app only when its settings hash to the pool id it names (HELIOS)', async () => {
    const HELIOS = '0x875E0130b52404c75f594EA8451597dd16C6B6e4';
    const HOOK = '0x10F11002b148BE522005f9b5D666bef339392aEC';
    const goodKey = { currency0: ethers.ZeroAddress, currency1: HELIOS, fee: 0, tickSpacing: 200, hooks: HOOK };
    const asset = (poolId: string) => ({ venue: 'v4', router: ASCEND.universalRouter, hooks: HOOK, fee: 0, tickSpacing: 200, pool: { id: poolId, v4: true } });
    const provider = { getBlockNumber: vi.fn(async () => 1), getLogs: vi.fn(async () => []) } as any;

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(asset(v4PoolId(goodKey))), { status: 200 })));
    expect(await findElysiumV4Route(provider, HELIOS)).toEqual({ quote: ethers.ZeroAddress, quoteSymbol: 'HYPE', launchKey: goodKey });
    expect(provider.getLogs).not.toHaveBeenCalled(); // no slow log search

    // Settings that do not hash to the pool id are ignored (and DexScreener lists nothing here)
    const OTHER = '0x0000000000000000000000000000000000c0ffee';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('thekleos') ? asset('0x' + '2'.repeat(64)) : { pairs: [] }), { status: 200 })));
    expect(await findElysiumV4Route(provider, OTHER)).toBeNull();
    vi.unstubAllGlobals();
  });
});

