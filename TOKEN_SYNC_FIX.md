# Token Sync Balance Conversion Fix

## Problem

The bot's token sync function (`syncUserTokenDeposits`) was not accurately detecting and displaying user holdings. When users added tokens to their wallet from external providers, the bot showed arbitrary/incorrect token quantities instead of the real amounts.

## Root Cause

The FastNEAR API returns token balances in **raw yocto format** (e.g., `"100000000000000000000"` for 100 tokens with 18 decimals), but the bot's position system expects **human-readable quantities** (e.g., `"100"`).

The sync function was storing the raw yocto balance directly into the database without converting it to human-readable format using the token's decimals. This caused:

- Massive display errors (showing 100,000,000,000,000,000,000 instead of 100)
- Incorrect PNL calculations
- Users seeing wrong token quantities in their holdings

## Solution

Modified `syncUserTokenDeposits` in `packages/api/src/wallet.ts` to:

1. Fetch token metadata (including decimals) via `getTokenInfo`
2. Convert raw yocto balance to human-readable quantity using the formula:
   ```typescript
   const decimals = info?.decimals ?? 18;
   const rawBalance = BigInt(t.balance);
   const humanBalance = Number(rawBalance) / Math.pow(10, decimals);
   ```
3. Store the converted human-readable balance in positions and fills
4. Apply the same conversion when updating existing positions

## Implementation Details

### Before (incorrect):
```typescript
await createFill({
  amount: t.balance,  // Raw yocto - WRONG!
  price: currentPrice.toString(),
  // ...
});
```

### After (correct):
```typescript
const decimals = info?.decimals ?? 18;
const rawBalance = BigInt(t.balance);
const humanBalance = Number(rawBalance) / Math.pow(10, decimals);

await createFill({
  amount: humanBalance.toString(),  // Human-readable - CORRECT!
  price: currentPrice.toString(),
  // ...
});
```

## Testing

Added unit tests in `packages/api/src/wallet-sync.test.ts` to verify:
- Correct conversion for various decimal configurations (6, 9, 18, 24)
- Handling of zero, small, and large balances
- Floating-point precision for 24-decimal NEAR balances

All tests pass successfully.

## Impact

- **Accurate token detection**: External token purchases are now detected with correct quantities
- **Real-time PNL updates**: PNL is calculated from the moment of detection using current market price
- **No more arbitrary numbers**: Users see their actual token holdings
- **Immediate visibility**: Holdings screen shows correct balances when users view it
- **Background sync**: 5-minute background sync continues to work with accurate conversions

## Files Changed

- `packages/api/src/wallet.ts` - Fixed balance conversion in `syncUserTokenDeposits`
- `packages/api/src/wallet-sync.test.ts` - Added unit tests for balance conversion
