import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import {
  LZ_CHAINS,
  LZ_EID_ARBITRUM,
  LZ_EID_BASE,
  LZ_EID_ETHEREUM,
  LZ_EID_OPTIMISM,
  addressToBytes32,
  bytes32ToAddress,
  encodeLzReceiveOptions,
  getLayerZeroScanUrl,
  verifySovereignEvmWallet,
  buildStargateSendParam,
  quoteStargateSend,
  getBridgeChains,
  getBridgeFeeBps,
  STARGATE_V2_POOLS,
  STARGATE_V2_POOL_ABI,
} from './layerZero.js';
import { encrypt } from './crypto.js';

describe('LayerZero & Stargate V2 Shared Module', () => {
  const TEST_EVM_ADDRESS = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'; // Vitalik's address
  const TEST_PRIV_KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f361b21';
  const MASTER_KEY = 'unit-test-encryption-key-for-layerzero-test-32bytes';

  it('maps correct canonical LayerZero V2 Endpoint IDs', () => {
    expect(LZ_CHAINS.arbitrum.eid).toBe(LZ_EID_ARBITRUM);
    expect(LZ_CHAINS.arbitrum.eid).toBe(30110);
    expect(LZ_CHAINS.base.eid).toBe(LZ_EID_BASE);
    expect(LZ_CHAINS.base.eid).toBe(30184);
    expect(LZ_CHAINS.ethereum.eid).toBe(LZ_EID_ETHEREUM);
    expect(LZ_CHAINS.ethereum.eid).toBe(30101);
    expect(LZ_CHAINS.optimism.eid).toBe(LZ_EID_OPTIMISM);
    expect(LZ_CHAINS.optimism.eid).toBe(30111);
  });

  it('converts EVM address to 32-byte hex and back without loss', () => {
    const bytes32 = addressToBytes32(TEST_EVM_ADDRESS);
    expect(bytes32.startsWith('0x')).toBe(true);
    expect(bytes32.length).toBe(66); // '0x' + 64 hex chars
    expect(bytes32.slice(2, 26)).toBe('000000000000000000000000'); // padded 12 bytes

    const recovered = bytes32ToAddress(bytes32);
    expect(recovered.toLowerCase()).toBe(TEST_EVM_ADDRESS.toLowerCase());
  });

  it('encodes LayerZero V2 options type 3 correctly', () => {
    // 1. Standard lzReceive (200k gas)
    const optionsStandard = encodeLzReceiveOptions(200_000n, 0n);
    expect(optionsStandard.startsWith('0x000301')).toBe(true); // type 3, worker 01
    expect(optionsStandard.length).toBe(2 + 4 + 2 + 4 + 2 + 32); // 0x + 0003 + 01 + 0011 + 01 + gas(32 chars) = 46 chars

    // 2. lzReceive with native airdrop / drop on destination
    const optionsWithDrop = encodeLzReceiveOptions(200_000n, 500_000_000_000_000n);
    expect(optionsWithDrop.startsWith('0x000301')).toBe(true);
    expect(optionsWithDrop.length).toBe(2 + 4 + 2 + 4 + 2 + 32 + 32); // 78 chars
  });

  it('generates correct LayerZero Scan URL', () => {
    const txHash = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
    expect(getLayerZeroScanUrl(txHash)).toBe(`https://layerzeroscan.com/tx/${txHash}`);
  });

  describe('Anti-Starknet-Failure Sovereign Wallet Verification', () => {
    it('verifies valid EVM EOA address', () => {
      const res = verifySovereignEvmWallet(TEST_EVM_ADDRESS);
      expect(res.valid).toBe(true);
      expect(res.address).toBe(ethers.getAddress(TEST_EVM_ADDRESS));
    });

    it('rejects Starknet 64/66 character contract addresses to prevent trapped funds', () => {
      const starknetAddr = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
      const res = verifySovereignEvmWallet(starknetAddr);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain('Starknet/Sui non-EVM address format');
    });

    it('rejects zero address', () => {
      const res = verifySovereignEvmWallet(ethers.ZeroAddress);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain('Zero address');
    });

    it('validates private key derivation to ensure full user exportability', () => {
      const wallet = new ethers.Wallet(TEST_PRIV_KEY);
      const encKey = encrypt(wallet.privateKey, MASTER_KEY);

      // Matches
      const validRes = verifySovereignEvmWallet(wallet.address, encKey, MASTER_KEY);
      expect(validRes.valid).toBe(true);

      // Mismatch
      const wrongAddr = ethers.Wallet.createRandom().address;
      const invalidRes = verifySovereignEvmWallet(wrongAddr, encKey, MASTER_KEY);
      expect(invalidRes.valid).toBe(false);
      expect(invalidRes.reason).toContain('Cryptographic mismatch');
    });
  });

  describe('Stargate V2 Send Param & Quoting', () => {
    it('builds Stargate SendParam with 0.5% slippage by default', () => {
      const amountLD = 100_000_000n; // 100 USDC (6 decimals)
      const param = buildStargateSendParam({
        destChain: 'base',
        recipientAddress: TEST_EVM_ADDRESS,
        amountLD,
      });

      expect(param.dstEid).toBe(LZ_EID_BASE);
      expect(param.amountLD).toBe(amountLD);
      // 100 USDC * 99.5% = 99.5 USDC = 99_500_000n
      expect(param.minAmountLD).toBe(99_500_000n);
      expect(param.to).toBe(addressToBytes32(TEST_EVM_ADDRESS));
    });

    it('quotes from the pool: minimum received comes from quoteOFT, fee from quoteSend', async () => {
      const iface = new ethers.Interface(STARGATE_V2_POOL_ABI);
      const sent: any[] = [];
      const provider: any = {
        call: async (tx: any) => {
          const parsed = iface.parseTransaction({ data: tx.data })!;
          sent.push({ to: tx.to, fn: parsed.name, param: parsed.args[0] });
          if (parsed.name === 'quoteOFT') {
            return iface.encodeFunctionResult('quoteOFT', [[0n, 10n ** 30n], [], [50_000_000n, 49_970_000n]]);
          }
          return iface.encodeFunctionResult('quoteSend', [[123_000_000_000_000n, 0n]]);
        },
      };
      const quote = await quoteStargateSend({
        sourceChain: 'base',
        destChain: 'arbitrum',
        asset: 'USDC',
        humanAmount: '50.0',
        recipientAddress: TEST_EVM_ADDRESS,
        provider,
        feeBps: 0,
      });

      expect(sent.map((s) => s.fn)).toEqual(['quoteOFT', 'quoteSend']);
      expect(sent[0].to.toLowerCase()).toBe(STARGATE_V2_POOLS.base!.USDC!.poolAddress.toLowerCase());
      expect(quote.amountLD).toBe(50_000_000n);
      expect(quote.amountReceivedLD).toBe(49_970_000n);
      expect(quote.minAmountLD).toBe((49_970_000n * 9950n) / 10000n); // 0.5% below what Stargate delivers
      expect(quote.sendParam.minAmountLD).toBe(quote.minAmountLD);
      expect(quote.sendParam.extraOptions).toBe('0x');
      expect(quote.nativeFee).toBe(123_000_000_000_000n);
      expect(quote.totalRequiredNative > quote.nativeFee).toBe(true);
    });

    it('refuses instead of guessing a fee when the pool cannot quote', async () => {
      const provider: any = { call: async () => '0x' };
      await expect(
        quoteStargateSend({
          sourceChain: 'base',
          destChain: 'arbitrum',
          asset: 'ETH',
          humanAmount: '0.01',
          recipientAddress: TEST_EVM_ADDRESS,
          provider,
        })
      ).rejects.toThrow(/could not quote .*Nothing was sent/);
    });

    it('trims ETH to the 6 shared decimals Stargate moves', async () => {
      const iface = new ethers.Interface(STARGATE_V2_POOL_ABI);
      let amountSent = 0n;
      const provider: any = {
        call: async (tx: any) => {
          const parsed = iface.parseTransaction({ data: tx.data })!;
          amountSent = parsed.args[0][2];
          return parsed.name === 'quoteOFT'
            ? iface.encodeFunctionResult('quoteOFT', [[0n, 10n ** 30n], [], [amountSent, amountSent]])
            : iface.encodeFunctionResult('quoteSend', [[1n, 0n]]);
        },
      };
      const quote = await quoteStargateSend({
        sourceChain: 'arbitrum', destChain: 'base', asset: 'ETH', humanAmount: '0.0123456789', recipientAddress: TEST_EVM_ADDRESS, provider, feeBps: 0,
      });
      expect(quote.amountLD).toBe(12_345_000_000_000_000n);
      expect(amountSent).toBe(12_345_000_000_000_000n);
    });

    it("takes RacerBot's bridge fee out of the amount, bridges the rest, and never exceeds what the user picked", async () => {
      const iface = new ethers.Interface(STARGATE_V2_POOL_ABI);
      let bridged = 0n;
      const provider: any = {
        call: async (tx: any) => {
          const parsed = iface.parseTransaction({ data: tx.data })!;
          bridged = parsed.args[0][2];
          return parsed.name === 'quoteOFT'
            ? iface.encodeFunctionResult('quoteOFT', [[0n, 10n ** 30n], [], [bridged, bridged]])
            : iface.encodeFunctionResult('quoteSend', [[1n, 0n]]);
        },
      };
      // 100 USDC at the default 0.5%: 99.5 bridged, 0.5 to the treasury
      const usdc = await quoteStargateSend({ sourceChain: 'base', destChain: 'arbitrum', asset: 'USDC', humanAmount: '100', recipientAddress: TEST_EVM_ADDRESS, provider });
      expect(usdc.platformFeeBps).toBe(50);
      expect(usdc.grossLD).toBe(100_000_000n);
      expect(usdc.amountLD).toBe(99_500_000n);
      expect(usdc.platformFeeLD).toBe(500_000n);
      expect(bridged).toBe(99_500_000n);

      // ETH: the dust Stargate cannot move stays with the fee; bridged + fee = exactly what was picked
      const eth = await quoteStargateSend({ sourceChain: 'base', destChain: 'arbitrum', asset: 'ETH', humanAmount: '0.0123456789', recipientAddress: TEST_EVM_ADDRESS, provider });
      expect(eth.amountLD + eth.platformFeeLD).toBe(eth.grossLD);
      expect(eth.amountLD % 10n ** 12n).toBe(0n);
      expect(eth.totalRequiredNative).toBe(eth.grossLD + eth.nativeFee + eth.sourceGasEstimate);
    });

    it('reads the fee from BRIDGE_FEE_BPS, capped at 5%', () => {
      const before = process.env.BRIDGE_FEE_BPS;
      process.env.BRIDGE_FEE_BPS = '25';
      expect(getBridgeFeeBps()).toBe(25);
      process.env.BRIDGE_FEE_BPS = '9000';
      expect(getBridgeFeeBps()).toBe(500);
      process.env.BRIDGE_FEE_BPS = '0';
      expect(getBridgeFeeBps()).toBe(0);
      if (before === undefined) delete process.env.BRIDGE_FEE_BPS; else process.env.BRIDGE_FEE_BPS = before;
    });

    it('knows no pool Stargate does not list, and no Zero route while Zero is off', async () => {
      await expect(
        quoteStargateSend({ sourceChain: 'base', destChain: 'arbitrum', asset: 'USDT', humanAmount: '10', recipientAddress: TEST_EVM_ADDRESS })
      ).rejects.toThrow(/no USDT pool on Base/);
      await expect(
        quoteStargateSend({ sourceChain: 'base', destChain: 'zero', asset: 'USDC', humanAmount: '10', recipientAddress: TEST_EVM_ADDRESS })
      ).rejects.toThrow(/Unsupported destination chain: zero/);
      expect(getBridgeChains()).not.toContain('zero');
    });
  });
});
