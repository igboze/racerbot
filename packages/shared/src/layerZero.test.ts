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

    it('quotes Stargate bridge with fallback estimation when RPC is mock/unreachable', async () => {
      const quote = await quoteStargateSend({
        sourceChain: 'base',
        destChain: 'arbitrum',
        asset: 'USDC',
        humanAmount: '50.0',
        recipientAddress: TEST_EVM_ADDRESS,
      });

      expect(quote.sourceChain).toBe('base');
      expect(quote.destChain).toBe('arbitrum');
      expect(quote.asset).toBe('USDC');
      expect(quote.amountLD).toBe(50_000_000n);
      expect(quote.minAmountLD).toBe(49_750_000n); // 50 * 0.995 = 49.75
      expect(quote.nativeFee > 0n).toBe(true);
      expect(quote.totalRequiredNative > quote.nativeFee).toBe(true);
      expect(quote.approxDurationSec).toBe(45);
    });
  });
});
