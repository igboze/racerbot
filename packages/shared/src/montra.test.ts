import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import {
  MONTRA,
  MONTRA_TOKEN_URL,
  encodeMontraBuy,
  encodeMontraSell,
  type MontraRoute,
} from './montra.js';
import {
  describeKleosRevert,
  elysiumPadName,
  elysiumPadUrl,
  isElysiumPadVenue,
  encodeKleosBuy,
  encodeKleosBuyWithTransfers,
} from './kleos.js';

const HYPEPE = '0x5dcfb191f0cdb853bac3a6a4385e160e779e377f';
const BLOB = '0x547a2a9c5af6e4372ead794e80eaf3f42dbbaaac';
const USER = '0x00000000000000000000000000000000000000A1';
const DEADLINE = 1_800_000_000n;

const launchRouterIface = new ethers.Interface([
  'function swapExactIn(tuple(tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, bool zeroForOne, uint128 amountIn, uint128 minAmountOut, address recipient, uint256 deadline) s) payable returns (uint256 amountOut)',
]);
const urIface = new ethers.Interface(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']);
const coder = ethers.AbiCoder.defaultAbiCoder();
const PATH_KEY_T = 'tuple(address intermediateCurrency, uint24 fee, int24 tickSpacing, address hooks, bytes hookData)';

const hypeRoute: MontraRoute = {
  poolId: ethers.ZeroHash,
  hook: MONTRA.hook,
  router: MONTRA.router,
  quote: ethers.ZeroAddress,
  quoteIsCurrency0: true,
  launchKey: {
    currency0: ethers.ZeroAddress,
    currency1: ethers.getAddress(HYPEPE),
    fee: 0x800000,
    tickSpacing: 200,
    hooks: MONTRA.hook,
  },
};

const kntqRoute: MontraRoute = {
  poolId: ethers.ZeroHash,
  hook: MONTRA.hook,
  router: MONTRA.universalRouter,
  quote: MONTRA.kntq,
  quoteIsCurrency0: false,
  launchKey: {
    currency0: ethers.getAddress(BLOB),
    currency1: MONTRA.kntq,
    fee: 0x800000,
    tickSpacing: 200,
    hooks: MONTRA.hook,
  },
  hypeHop: {
    currency0: ethers.ZeroAddress,
    currency1: MONTRA.kntq,
    fee: 10000,
    tickSpacing: 200,
    hooks: ethers.ZeroAddress,
  },
};

describe('Montra Markets launchpad', () => {
  it('recognises Montra as an Elysium launchpad with its own token page', () => {
    expect(isElysiumPadVenue('montra')).toBe(true);
    expect(elysiumPadName('montra')).toBe('Montra');
    expect(elysiumPadUrl('montra', HYPEPE)).toBe(`${MONTRA_TOKEN_URL}${HYPEPE}`);
  });

  it('encodes a single-hop HYPE-paired Montra buy on LaunchRouter', () => {
    const buy = encodeMontraBuy(hypeRoute, HYPEPE, 1000n, 900n, USER, DEADLINE);
    expect(buy).toMatchObject({ to: MONTRA.router, value: 1000n });
    const [s] = launchRouterIface.decodeFunctionData('swapExactIn', buy.data);
    expect(s.key.hooks).toBe(MONTRA.hook);
    expect([s.zeroForOne, s.amountIn, s.minAmountOut, s.recipient, s.deadline]).toEqual([true, 1000n, 900n, USER, DEADLINE]);
  });

  it('encodes a single-hop HYPE-paired Montra sell on LaunchRouter', () => {
    const sell = encodeMontraSell(hypeRoute, HYPEPE, 5000n, 40n, USER, DEADLINE);
    expect(sell).toMatchObject({ to: MONTRA.router, value: 0n });
    const [s] = launchRouterIface.decodeFunctionData('swapExactIn', sell.data);
    expect([s.zeroForOne, s.amountIn, s.minAmountOut, s.recipient, s.deadline]).toEqual([false, 5000n, 40n, USER, DEADLINE]);
  });

  it('encodes a multi-hop KNTQ-paired Montra buy (HYPE -> KNTQ -> Token) on Montra UniversalRouter', () => {
    const buy = encodeMontraBuy(kntqRoute, BLOB, 1000n, 900n, USER, DEADLINE);
    expect(buy).toMatchObject({ to: MONTRA.universalRouter, value: 1000n });
    const [commands, inputs, deadline] = urIface.decodeFunctionData('execute', buy.data).toArray();
    expect([...ethers.getBytes(commands)]).toEqual([0x10]);
    expect(deadline).toBe(DEADLINE);
    const [actions, params] = coder.decode(['bytes', 'bytes[]'], inputs[0]).toArray();
    expect([...ethers.getBytes(actions)]).toEqual([0x07, 0x0b, 0x0e]); // SWAP_EXACT_IN, SETTLE, TAKE
    const [swap] = coder.decode(
      [`tuple(address currencyIn, ${PATH_KEY_T}[] path, uint256[] hopSlippage, uint128 amountIn, uint128 amountOutMinimum)`],
      params[0],
    );
    expect(swap.currencyIn).toBe(ethers.ZeroAddress);
    expect(swap.path.map((h: any) => [h.intermediateCurrency, h.hooks])).toEqual([
      [MONTRA.kntq, ethers.ZeroAddress],
      [ethers.getAddress(BLOB), MONTRA.hook],
    ]);
    expect(coder.decode(['address', 'address', 'uint256'], params[2]).toArray()).toEqual([ethers.getAddress(BLOB), USER, 0n]);
  });

  it('encodes a multi-hop KNTQ-paired Montra sell (Token -> KNTQ -> HYPE) on Montra UniversalRouter', () => {
    const sell = encodeMontraSell(kntqRoute, BLOB, 5000n, 40n, USER, DEADLINE);
    expect(sell).toMatchObject({ to: MONTRA.universalRouter, value: 0n });
    const [commands, inputs] = urIface.decodeFunctionData('execute', sell.data).toArray();
    expect([...ethers.getBytes(commands)]).toEqual([0x10]);
    const [actions, params] = coder.decode(['bytes', 'bytes[]'], inputs[0]).toArray();
    expect([...ethers.getBytes(actions)]).toEqual([0x07, 0x0b, 0x0e]); // SWAP_EXACT_IN, SETTLE (Permit2), TAKE
    expect(coder.decode(['address', 'uint256', 'bool'], params[1]).toArray()).toEqual([ethers.getAddress(BLOB), 5000n, true]);
    expect(coder.decode(['address', 'address', 'uint256'], params[2]).toArray()).toEqual([ethers.ZeroAddress, USER, 0n]);
  });

  it('bundles the platform fee and Montra buy in a single Multicall3 call', () => {
    const swap = encodeKleosBuy({ kind: 'montra', router: MONTRA.router, hopFee: 0, montra: hypeRoute }, HYPEPE, 985n, 900n, USER, DEADLINE);
    const call = encodeKleosBuyWithTransfers([{ to: USER, value: 15n }], swap);
    expect(call.value).toBe(1000n);
  });

  it('decodes Montra launchpad custom revert errors in plain language', () => {
    const iface = new ethers.Interface(['error PartialFillRejected()', 'error PastOpening()']);
    expect(describeKleosRevert({ data: iface.encodeErrorResult('PartialFillRejected', []) })).toMatch(/not have enough liquidity/);
    expect(describeKleosRevert({ data: iface.encodeErrorResult('PastOpening', []) })).toMatch(/not opened/);
  });
});
