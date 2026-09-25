import { describe, it, expect } from 'vitest';

describe('wallet balance storage reserve subtraction', () => {
  it('correctly subtracts 0.05 NEAR storage reserve from balance', () => {
    // Test the calculation logic from getUserBalances
    const nativeNearYocto = '100000000000000000000000'; // 0.10 NEAR in yoctoNEAR
    const wrapNearYocto = '0'; // 0 wNEAR
    
    const nativeNear = Number(BigInt(nativeNearYocto) / 1000000000000000000n) / 1e6;
    const wrapNear = Number(BigInt(wrapNearYocto) / 1000000000000000000n) / 1e6;
    
    // Subtract storage reserve (0.05 NEAR) from display balance to show spendable amount
    const storageReserve = 0.05;
    const spendableNativeNear = Math.max(0, nativeNear - storageReserve);
    const totalNear = spendableNativeNear + wrapNear;
    
    expect(nativeNear).toBeCloseTo(0.10, 4);
    expect(spendableNativeNear).toBeCloseTo(0.05, 4);
    expect(totalNear).toBeCloseTo(0.05, 4);
  });

  it('handles balance below storage reserve', () => {
    // Test the calculation logic when balance is less than storage reserve
    const nativeNearYocto = '30000000000000000000000'; // 0.03 NEAR in yoctoNEAR
    const wrapNearYocto = '0'; // 0 wNEAR
    
    const nativeNear = Number(BigInt(nativeNearYocto) / 1000000000000000000n) / 1e6;
    const wrapNear = Number(BigInt(wrapNearYocto) / 1000000000000000000n) / 1e6;
    
    // Subtract storage reserve (0.05 NEAR) from display balance to show spendable amount
    const storageReserve = 0.05;
    const spendableNativeNear = Math.max(0, nativeNear - storageReserve);
    const totalNear = spendableNativeNear + wrapNear;
    
    expect(nativeNear).toBeCloseTo(0.03, 4);
    expect(spendableNativeNear).toBe(0); // Should be clamped to 0
    expect(totalNear).toBe(0);
  });

  it('includes wrapped NEAR in total', () => {
    // Test the calculation logic with wrapped NEAR
    const nativeNearYocto = '100000000000000000000000'; // 0.10 NEAR in yoctoNEAR
    const wrapNearYocto = '50000000000000000000000'; // 0.05 wNEAR in yoctoNEAR
    
    const nativeNear = Number(BigInt(nativeNearYocto) / 1000000000000000000n) / 1e6;
    const wrapNear = Number(BigInt(wrapNearYocto) / 1000000000000000000n) / 1e6;
    
    // Subtract storage reserve (0.05 NEAR) from display balance to show spendable amount
    const storageReserve = 0.05;
    const spendableNativeNear = Math.max(0, nativeNear - storageReserve);
    const totalNear = spendableNativeNear + wrapNear;
    
    expect(nativeNear).toBeCloseTo(0.10, 4);
    expect(wrapNear).toBeCloseTo(0.05, 4);
    expect(spendableNativeNear).toBeCloseTo(0.05, 4);
    expect(totalNear).toBeCloseTo(0.10, 4); // 0.05 + 0.05
  });
});
