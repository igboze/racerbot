import { describe, it, expect, vi, afterEach } from 'vitest';
import { ethers } from 'ethers';
import { ELYSIUM_PADS, findPadRoute, encodePadBuy, encodePadSell, padSimApprovals, type PadRoute } from './elysiumPads.js';
import { UNIVERSAL_ROUTER_ABI, V4_QUOTER_ABI } from './ascend.js';

const ARC = '0x4957693c8AA15aF1f21ABa2E6716Cdd29B2bD31C';
const USER = '0x00000000000000000000000000000000000000A1';
const DEADLINE = 1_800_000_000n;
const keyFor = (pad: keyof typeof ELYSIUM_PADS) => ({ currency0: ethers.ZeroAddress, currency1: ARC, fee: 0, tickSpacing: 200, hooks: ELYSIUM_PADS[pad].hook });
const boxa: PadRoute = { pad: ELYSIUM_PADS.boxa, key: keyFor('boxa') };
const elyspump: PadRoute = { pad: ELYSIUM_PADS.elyspump, key: keyFor('elyspump') };
const boxaIface = new ethers.Interface([
  'function buy((address,address,uint24,int24,address) key, uint256 minTokensOut, address recipient, uint256 deadline)',
  'function sell((address,address,uint24,int24,address) key, uint256 amountIn, uint256 minHypeOut, address recipient, uint256 deadline)',
]);
const quoterIface = new ethers.Interface(V4_QUOTER_ABI);

afterEach(() => vi.unstubAllGlobals());

describe('BOXA and ElysPump coins', () => {
  it('buys and sells on BOXA through its own router, paying the user', () => {
    const buy = encodePadBuy(boxa, 1000n, 900n, USER, DEADLINE);
    expect([buy.to, buy.value]).toEqual([ELYSIUM_PADS.boxa.router, 1000n]);
    const [key, minOut, recipient] = boxaIface.decodeFunctionData('buy', buy.data).toArray();
    expect([key[1], key[4], minOut, recipient]).toEqual([ARC, ELYSIUM_PADS.boxa.hook, 900n, USER]);
    const sell = encodePadSell(boxa, 5000n, 40n, USER, DEADLINE);
    expect(boxaIface.decodeFunctionData('sell', sell.data).toArray().slice(1, 4)).toEqual([5000n, 40n, USER]);
    // BOXA takes the coin directly: one approval, to its router
    expect(padSimApprovals(boxa, 5000n, DEADLINE).map(c => c.to)).toEqual([ARC]);
  });

  it('buys on ElysPump through its Universal Router with standard v4 swap params', () => {
    const buy = encodePadBuy(elyspump, 1000n, 900n, USER, DEADLINE);
    expect(buy.to).toBe(ELYSIUM_PADS.elyspump.router);
    const [commands, inputs] = new ethers.Interface(UNIVERSAL_ROUTER_ABI).decodeFunctionData('execute', buy.data).toArray();
    expect(commands).toBe('0x10');
    const [actions, params] = ethers.AbiCoder.defaultAbiCoder().decode(['bytes', 'bytes[]'], inputs[0]).toArray();
    expect(actions).toBe('0x060c0e');
    const [swap] = ethers.AbiCoder.defaultAbiCoder().decode(['tuple(tuple(address,address,uint24,int24,address) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, bytes hookData)'], params[0]);
    expect([swap.zeroForOne, swap.amountIn, swap.amountOutMinimum]).toEqual([true, 1000n, 900n]);
    expect(ethers.AbiCoder.defaultAbiCoder().decode(['address', 'address', 'uint256'], params[2]).toArray()).toEqual([ARC, USER, 0n]);
    // ElysPump pulls the coin through Permit2: two approvals
    expect(padSimApprovals(elyspump, 5000n, DEADLINE)).toHaveLength(2);
  });

  it('finds the pad on chain from the pad quoter answering at the usual settings', async () => {
    const provider = {
      call: vi.fn(async (tx: any) => {
        if (tx.to.toLowerCase() !== ELYSIUM_PADS.boxa.quoter.toLowerCase()) throw Object.assign(new Error('revert'), { code: 'CALL_EXCEPTION' });
        return quoterIface.encodeFunctionResult('quoteExactInputSingle', [123n, 0n]);
      }),
    } as any;
    const route = await findPadRoute(provider, ARC, { askKleos: false });
    expect(route?.pad.name).toBe('boxa');
    expect(route?.key).toMatchObject({ fee: 0, tickSpacing: 200, hooks: ELYSIUM_PADS.boxa.hook });
  });

  it('ignores pool settings from the Kleos app that name a router it does not know', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      venue: 'v4', hooks: ELYSIUM_PADS.boxa.hook, router: '0x000000000000000000000000000000000000dEaD', quoter: ELYSIUM_PADS.boxa.quoter, fee: 3000, tickSpacing: 60,
    }), { status: 200 })));
    const provider = { call: vi.fn(async () => { throw Object.assign(new Error('revert'), { code: 'CALL_EXCEPTION' }); }) } as any;
    expect(await findPadRoute(provider, ARC)).toBeNull();
  });
});
