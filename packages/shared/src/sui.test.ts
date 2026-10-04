import { describe, it, expect } from 'vitest';
import {
  generateSuiWallet,
  restoreSuiKeypairFromSecret,
  isValidSuiAddress,
  buildSuiPumpBuyTransaction,
  buildSuiPumpSellTransaction,
} from './sui.js';
import { decrypt } from './crypto.js';
import bs58 from 'bs58';

describe('sui: key management & restoration', () => {
  const masterKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  it('generates a fresh Sui wallet with valid address and encrypted secret', () => {
    const wallet = generateSuiWallet(masterKey);
    expect(wallet.address).toMatch(/^0x[a-fA-F0-9]{64}$/);
    expect(isValidSuiAddress(wallet.address)).toBe(true);
    expect(wallet.privateKeySecret).toMatch(/^suiprivkey1/);
    expect(wallet.encryptedPrivateKey).toBeDefined();
    expect(decrypt(wallet.encryptedPrivateKey, masterKey)).toBe(wallet.privateKeySecret);
  });

  it('restores keypair identically from standard Bech32 suiprivkey1... string', () => {
    const original = generateSuiWallet(masterKey);
    const restored = restoreSuiKeypairFromSecret(original.privateKeySecret);
    expect(restored.toSuiAddress()).toBe(original.address);
  });

  it('restores keypair from 64-character hex string', () => {
    const rawBytes = Buffer.alloc(32, 7); // 32 bytes of 0x07
    const hex = rawBytes.toString('hex');
    const restored = restoreSuiKeypairFromSecret(hex);
    expect(restored.toSuiAddress()).toMatch(/^0x[a-fA-F0-9]{64}$/);

    const withPrefix = `0x${hex}`;
    const restoredPrefix = restoreSuiKeypairFromSecret(withPrefix);
    expect(restoredPrefix.toSuiAddress()).toBe(restored.toSuiAddress());
  });

  it('restores keypair from base64 string', () => {
    const rawBytes = Buffer.alloc(32, 9);
    const b64 = rawBytes.toString('base64');
    const restored = restoreSuiKeypairFromSecret(b64);
    expect(restored.toSuiAddress()).toMatch(/^0x[a-fA-F0-9]{64}$/);
  });

  it('restores keypair from base58 string', () => {
    const rawBytes = Buffer.alloc(32, 11);
    const b58 = bs58.encode(rawBytes);
    const restored = restoreSuiKeypairFromSecret(b58);
    expect(restored.toSuiAddress()).toMatch(/^0x[a-fA-F0-9]{64}$/);
  });

  it('throws descriptive error on malformed private key', () => {
    expect(() => restoreSuiKeypairFromSecret('invalid-key-string-xyz')).toThrow(
      'Invalid Sui private key format'
    );
  });
});

describe('sui: transaction builders', () => {
  const dummyUser = '0x1111111111111111111111111111111111111111111111111111111111111111';
  const dummyCurve = '0x2222222222222222222222222222222222222222222222222222222222222222';
  const dummyTokenType = '0x3333333333333333333333333333333333333333333333333333333333333333::test::TEST';

  it('builds SuiPump buy transaction with minTokensOut and packageId', () => {
    const res = buildSuiPumpBuyTransaction({
      userAddress: dummyUser,
      curveId: dummyCurve,
      tokenType: dummyTokenType,
      suiAmountMist: 1_000_000_000n,
      minTokensOut: 50_000n,
      slippagePct: 2,
    });
    expect(res.tx).toBeDefined();
    expect(res.feeMist).toBe(15_000_000n); // 1.5% of 1 SUI
    expect(res.swapMist).toBe(985_000_000n);
  });

  it('builds SuiPump sell transaction with packageId', () => {
    const res = buildSuiPumpSellTransaction({
      userAddress: dummyUser,
      curveId: dummyCurve,
      tokenType: dummyTokenType,
      tokenAmountRaw: 1_000_000n,
      tokenCoinObjectIds: ['0x4444444444444444444444444444444444444444444444444444444444444444'],
      minSuiOut: 100_000n,
    });
    expect(res.tx).toBeDefined();
  });
});
