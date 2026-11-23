import { describe, it, expect, vi, afterEach } from 'vitest';
import { ethers } from 'ethers';
import {
  STARGATE_V2_POOLS,
  getBridgeChains,
  isBridgeChainEnabled,
} from './layerZero.js';
import {
  getEvmRpcUrl,
  isZeroChainEnabled,
  routerTakesReferrer,
  HYPERSWAP_V2_ROUTER,
  HYPERSWAP_V2_ROUTER_ABI,
} from './evm.js';

afterEach(() => vi.unstubAllEnvs());

describe('Stargate pools', () => {
  // Every pool below was checked on-chain on 2026-11-22 (token(), sharedDecimals() = 6, live quoteSend).
  // The old table had 7 addresses with no contract behind them: a send there would have lost the funds.
  const VERIFIED: Record<string, Record<string, string>> = {
    arbitrum: {
      ETH: '0xA45B5130f36CDcA45667738e2a258AB09f4A5f7F',
      USDC: '0xe8CDF27AcD73a434D661C84887215F7598e7d0d3',
      USDT: '0xcE8CcA271Ebc0533920C83d39F417ED6A0abB7D0',
    },
    base: { ETH: '0xdc181Bd607330aeeBEF6ea62e03e5e1Fb4B6F7C7', USDC: '0x27a16dc786820B16E5c9028b75B99F6f604b5d26' },
    ethereum: {
      ETH: '0x77b2043768d28E9C9aB44E1aBfC95944bcE57931',
      USDC: '0xc026395860Db2d07ee33e05fE50ed7bD583189C7',
      USDT: '0x933597a323Eb81cAe705C5bC29985172fd5A3973',
    },
    optimism: {
      ETH: '0xe8CDF27AcD73a434D661C84887215F7598e7d0d3',
      USDC: '0xcE8CcA271Ebc0533920C83d39F417ED6A0abB7D0',
      USDT: '0x19cFCE47eD54a88614648DC3f19A5980097007dD',
    },
    bsc: { USDC: '0x962Bd449E630b0d928f308Ce63f1A21F02576057', USDT: '0x138EB30f73BC423c6455C53df6D89CB01d9eBc63' },
    polygon: { USDC: '0x9Aa02D4Fae7F58b8E8f34c66E756cC734DAc7fe4', USDT: '0xd47b03ee6d86Cf251ee7860FB2ACf9f91B9fD4d7' },
  };

  const ZRO = '0x6985884C4392D348587B19cb9eAAf157F13271cd';
  for (const c of Object.keys(VERIFIED)) VERIFIED[c].ZRO = ZRO; // the ZRO OFT, verified on-chain 2026-11-23

  it('are exactly the verified Stargate pools, all with 6 shared decimals', () => {
    const actual = Object.fromEntries(
      Object.entries(STARGATE_V2_POOLS).map(([chain, pools]) => [
        chain,
        Object.fromEntries(Object.entries(pools!).map(([asset, p]) => [asset, ethers.getAddress(p!.poolAddress)])),
      ])
    );
    expect(actual).toEqual(VERIFIED);
    for (const pools of Object.values(STARGATE_V2_POOLS)) {
      for (const p of Object.values(pools!)) expect(p!.sharedDecimals).toBe(6);
    }
  });

  it('has no Zero pool: Stargate does not list Zero', () => {
    expect(STARGATE_V2_POOLS.zero).toBeUndefined();
  });
});

describe('Zero (LayerZero chain) switch', () => {
  it('is off by default, so Zero is not offered anywhere in the bridge', () => {
    expect(isZeroChainEnabled()).toBe(false);
    expect(getBridgeChains()).toEqual(['base', 'arbitrum', 'ethereum', 'optimism', 'bsc', 'polygon']);
    expect(isBridgeChainEnabled('zero')).toBe(false);
  });

  it('turns on with ZERO_CHAIN_ENABLED=on', () => {
    vi.stubEnv('ZERO_CHAIN_ENABLED', 'on');
    expect(isZeroChainEnabled()).toBe(true);
    expect(getBridgeChains()[0]).toBe('zero');
  });
});

describe('EVM chain plumbing', () => {
  it('uses a working default Ethereum RPC (eth.llamarpc.com answers 403/525)', () => {
    vi.stubEnv('ETHEREUM_RPC_URL', '');
    expect(getEvmRpcUrl('ethereum')).toBe('https://ethereum-rpc.publicnode.com');
  });

  it('calls HyperSwap with its referrer argument', () => {
    expect(routerTakesReferrer(HYPERSWAP_V2_ROUTER)).toBe(true);
    expect(routerTakesReferrer(HYPERSWAP_V2_ROUTER.toLowerCase())).toBe(true);
    expect(routerTakesReferrer('0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24')).toBe(false);
    // These selectors are the ones in HyperSwap's deployed bytecode (the standard ones are absent)
    const iface = new ethers.Interface(HYPERSWAP_V2_ROUTER_ABI);
    expect(iface.getFunction('swapExactETHForTokensSupportingFeeOnTransferTokens')!.inputs.map((i) => i.type)).toEqual([
      'uint256', 'address[]', 'address', 'address', 'uint256',
    ]);
    expect(iface.getFunction('swapExactTokensForETHSupportingFeeOnTransferTokens')!.inputs.map((i) => i.type)).toEqual([
      'uint256', 'uint256', 'address[]', 'address', 'address', 'uint256',
    ]);
  });
});
