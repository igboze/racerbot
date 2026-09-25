# External Wallet Sync Fix

## Problem
The bot was not automatically detecting when users bought tokens from external wallet providers. Users had to manually check their positions or PNL screens to trigger the sync, which meant external purchases wouldn't be tracked until they explicitly viewed their holdings.

## Root Cause
The `syncUserTokenDeposits` function existed in the codebase but was only called manually in:
- The positions menu handler (`menu_positions`)
- The PNL summary handler (`menu_pnl`)

There was no automatic background process to periodically check for external deposits.

## Solution
Added a **background sync mechanism** that automatically checks for external token deposits every 5 minutes.

## Changes Made

### 1. Modified `packages/api/src/index.ts`
- Added import for `syncUserTokenDeposits` from wallet module
- Added import for `getDb` from db module  
- Created a global `syncInterval` variable to track the background sync timer
- Implemented a background sync function that:
  - Runs every 5 minutes (300,000ms)
  - Fetches all users from the database
  - Calls `syncUserTokenDeposits` for each user
  - Logs new deposits detected
  - Handles errors gracefully for individual users
- Added proper cleanup in the shutdown handler to clear the interval

### 2. Existing Functionality (No Changes)
The `syncUserTokenDeposits` function in `packages/api/src/wallet.ts` already had the correct logic:
- Fetches all FT holdings from user's subaccount via FastNEAR API
- Compares against existing positions in the database
- Creates new positions for tokens not tracked by the bot
- Updates existing position quantities
- Uses current market price as entry price for new deposits

## Impact
- **Automatic Detection**: External token purchases are now detected automatically within 5 minutes
- **PNL Accuracy**: Users' PNL calculations will include external purchases without manual intervention
- **User Experience**: Users no longer need to manually check positions to trigger sync
- **Scalability**: The sync processes users sequentially to avoid overwhelming the API
- **Graceful Handling**: Individual user sync failures don't affect other users

## Configuration
The sync interval is set to 5 minutes (`5 * 60 * 1000` ms) in `packages/api/src/index.ts`. This can be adjusted by modifying the `SYNC_INTERVAL_MS` constant if needed.

## Monitoring
The sync process logs:
- Number of users being synced
- New deposits detected per user
- Total new deposits across all users
- Any errors that occur during sync

## Testing
- Build completed successfully with no TypeScript errors
- The sync interval is properly initialized on startup
- Graceful shutdown properly clears the interval
- Error handling prevents cascade failures

## Future Enhancements
- Consider making the sync interval configurable via environment variable
- Add notifications to users when new external deposits are detected
- Implement user-specific sync preferences (enable/disable auto-sync)
- Add rate limiting for users with many tokens to avoid API timeouts
