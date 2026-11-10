import { Markup, Context } from 'telegraf';
import { KeyPair, utils as nearUtils } from 'near-api-js';
import {
  getNear,
  createLogger,
  encrypt,
  decrypt,
  formatTokenUnits,
  generateRandomAccountPrefix,
  getFastnearAccountTokens,
  type SwapEvent,
} from '@racerbot/shared';
import {
  getUserByTelegramId,
  getUserById,
  upsertRaceFleet,
  getRaceFleetByUserId,
  getRaceFleetById,
  createRaceFleetWallets,
  getRaceFleetWallets,
  createRaceFleetOrder,
  getActiveRaceFleetOrders,
  getRaceFleetOrdersByFleet,
  cancelRaceFleetOrder,
  updateRaceFleetOrderStatus,
  renewRaceFleet,
  getDb,
  getActiveWallet,
  recordRaceFleetFill,
  getRaceFleetFills,
  type RaceFleetRecord,
  type RaceFleetWalletRecord,
  type RaceFleetOrderRecord,
  type RaceFleetFillRecord,
  type UserRecord,
} from '@racerbot/db';
import {
  MASTER_KEY,
  RACERBOT_PARENT_ACCOUNT,
  MAIN_WALLET_PRIVATE_KEY,
  TREASURY_ACCOUNT_ID,
} from './config.js';
import {
  getTokenInfo,
  getUserBalances,
  connectWithNearRpcFailover,
  withdrawFunds,
} from './wallet.js';
import { getShortTokenKey } from './routes.js';
import { fireNearTxsTogether, nearActions } from './nearFleetBundle.js';
import {
  isSolanaFleetToken,
  executeSolanaFleetBundleBuy,
  executeSolanaFleetBundleSell,
  buildSolanaFleetCockpit,
  buildSolanaFleetHoldingsSection,
  exportSolanaFleetKeys,
  getSolanaFleetBalances,
  getSolanaFleetTokenPosition,
} from './solanaFleet.js';

const logger = createLogger('race_fleet');

export const RACEFLEET_MONTHLY_FEE_NEAR = 2.0;
export const MAX_FLEET_WALLETS = 25;
/** Platform fee on a NEAR fleet bundle buy, the same 1.5% as a normal buy and a Solana fleet buy */
export const FLEET_BUY_FEE_BPS = 150n;

/** One wallet's buy split into what is swapped and the platform fee. Exported for tests. */
export function splitFleetBuy(amountYocto: bigint): { swapYocto: bigint; feeYocto: bigint } {
  const feeYocto = (amountYocto * FLEET_BUY_FEE_BPS) / 10_000n;
  return { swapYocto: amountYocto - feeYocto, feeYocto };
}
export const MIN_FLEET_WALLETS = 1;

// ── Alias Generator for Privacy ─────────────────────────────────────────────
const FLEET_ADJECTIVES = [
  'speed', 'apex', 'turbo', 'hyper', 'stealth', 'vortex', 'shadow',
  'sonic', 'nitro', 'phantom', 'rapid', 'prime', 'drift', 'aero', 'blaze',
  'strike', 'storm', 'quantum', 'titan', 'cyber',
];

const FLEET_NOUNS = [
  'racer', 'falcon', 'viper', 'beast', 'rocket', 'surge', 'pulse',
  'titan', 'spark', 'bolt', 'arrow', 'dash', 'ghost', 'bullet', 'hawk',
];

export function generateRandomFleetTag(): string {
  const adj = FLEET_ADJECTIVES[Math.floor(Math.random() * FLEET_ADJECTIVES.length)];
  const noun = FLEET_NOUNS[Math.floor(Math.random() * FLEET_NOUNS.length)];
  const num = Math.floor(100 + Math.random() * 900);
  return `f-${adj}-${noun}-${num}`;
}

// ── Key & Account Generation ────────────────────────────────────────────────
export function generateFleetKeyPair(): KeyPair {
  return KeyPair.fromRandom('ed25519');
}

// ── Check Active Fleet Status ───────────────────────────────────────────────
export async function hasActiveRaceFleet(userId: string): Promise<boolean> {
  if (!userId) return false;
  try {
    const fleet = await getRaceFleetByUserId(userId);
    if (!fleet) return false;
    // Considered active if status is active and expiry has not passed
    const isNotExpired = new Date(fleet.expires_at).getTime() > Date.now();
    return fleet.status === 'active' && isNotExpired;
  } catch (err: any) {
    logger.error('Error checking active fleet:', err);
    return false;
  }
}

/**
 * The NEAR account that pays for a fleet: withdrawFunds signs from the active NEAR wallet (else the
 * user's account), so balance checks must read that same account.
 */
async function fleetPayerAccount(user: UserRecord): Promise<string> {
  const active = await getActiveWallet(user.id, 'near').catch(() => null);
  return active?.address || user.subaccount_id;
}

async function resolveFleetUser(userOrTelegramId: number | string | UserRecord): Promise<UserRecord | null> {
  if (typeof userOrTelegramId === 'object' && userOrTelegramId && 'id' in userOrTelegramId) {
    return userOrTelegramId;
  }
  if (typeof userOrTelegramId === 'string') {
    return getUserById(userOrTelegramId);
  }
  if (typeof userOrTelegramId === 'number' && userOrTelegramId > 0) {
    return getUserByTelegramId(userOrTelegramId);
  }
  return null;
}

// ── Deploy / Subscribe to RaceFleet ─────────────────────────────────────────
export async function deployRaceFleet(
  userOrTelegramId: number | string | UserRecord,
  walletCount: number = 10,
  fleetName: string = 'Alpha Fleet'
): Promise<{
  success: boolean;
  fleet?: RaceFleetRecord;
  wallets?: RaceFleetWalletRecord[];
  reason?: string;
  txHash?: string;
}> {
  const user = await resolveFleetUser(userOrTelegramId);
  if (!user) {
    return { success: false, reason: 'User not found. Please sign in or connect your wallet first.' };
  }

  const clampedCount = Math.max(MIN_FLEET_WALLETS, Math.min(MAX_FLEET_WALLETS, walletCount));
  const near = getNear();

  // 1. The wallet that pays the subscription must hold the fee plus a little for gas
  const payer = await fleetPayerAccount(user);
  const balanceYocto = await near.getNearBalance(payer).catch(() => '0');
  const balanceNear = Number(BigInt(balanceYocto || '0') / 10n ** 20n) / 10_000;

  if (balanceNear < RACEFLEET_MONTHLY_FEE_NEAR + 0.05) {
    return {
      success: false,
      reason: `Insufficient balance. RaceFleet subscription is ${RACEFLEET_MONTHLY_FEE_NEAR} NEAR / month. You have ${balanceNear.toFixed(2)} NEAR in your main wallet.`,
    };
  }

  if (!MAIN_WALLET_PRIVATE_KEY) {
    return { success: false, reason: 'Server configuration error: MAIN_WALLET_PRIVATE_KEY missing.' };
  }

  // 2. Generate the fleet's accounts and keys
  const fleetTag = generateRandomFleetTag();
  const parentAccountName = RACERBOT_PARENT_ACCOUNT || 'racerbot.near';
  const walletKeys: { accountId: string; keyPair: KeyPair; encryptedKey: string }[] = [];
  for (let i = 1; i <= clampedCount; i++) {
    const keyPair = generateFleetKeyPair();
    walletKeys.push({
      accountId: `${generateRandomAccountPrefix()}.${parentAccountName}`,
      keyPair,
      encryptedKey: encrypt(keyPair.toString(), MASTER_KEY),
    });
  }

  // 3. Create the accounts before charging anything: the fee is only taken for a fleet that exists.
  // Each account is created on its own, so one failure never discards the ones that worked.
  const parentKeyPair = KeyPair.fromString(MAIN_WALLET_PRIVATE_KEY as any);
  const initialStorageDeposit = BigInt(nearUtils.format.parseNearAmount('0.00182')!);
  const created: typeof walletKeys = [];
  let lastCreateError = '';

  try {
    await connectWithNearRpcFailover(parentAccountName, parentKeyPair, async (parentAccount) => {
      // One at a time: the parent account's key also signs executor transactions, and parallel
      // transactions from one key collide on the nonce
      for (const w of walletKeys) {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            await parentAccount.createAccount(w.accountId, w.keyPair.getPublicKey().toString(), initialStorageDeposit);
            created.push(w);
            break;
          } catch (err: any) {
            const msg = String(err?.message || err);
            if (msg.includes('already exists')) break; // a random name someone else holds: skip it
            lastCreateError = msg;
            if (attempt === 1) logger.warn(`Could not create fleet wallet ${w.accountId}: ${msg}`);
          }
        }
      }
    });
  } catch (deployErr: any) {
    lastCreateError = deployErr?.message || String(deployErr);
    logger.error('Fleet subaccount creation stopped early:', deployErr);
  }

  if (created.length === 0) {
    return {
      success: false,
      reason: `Could not create your fleet wallets, so nothing was charged.${lastCreateError ? ` (${lastCreateError.slice(0, 120)})` : ' Try again in a moment.'}`,
    };
  }

  // 4. Collect the subscription fee. If it fails, remove the new accounts (their storage goes back
  // to the parent account), so no wallet is left on-chain without a stored key.
  try {
    const feeWithdrawal = await withdrawFunds(user, TREASURY_ACCOUNT_ID, RACEFLEET_MONTHLY_FEE_NEAR);
    logger.info(`Paid RaceFleet subscription fee for user ${user.id}: tx ${feeWithdrawal.txHash}`);
  } catch (payErr: any) {
    await removeFleetAccounts(created, parentAccountName);
    return { success: false, reason: `Subscription payment failed, so no fleet was created: ${payErr?.message || payErr}` };
  }

  // 5. Store the fleet with exactly the wallets that exist
  let fleet: RaceFleetRecord;
  let wallets: RaceFleetWalletRecord[];
  try {
    fleet = await upsertRaceFleet({
      user_id: user.id,
      name: fleetName,
      fleet_tag: fleetTag,
      wallet_count: created.length,
      monthly_fee_near: RACEFLEET_MONTHLY_FEE_NEAR,
      duration_days: 30,
      auto_renew: true,
    });
    wallets = await createRaceFleetWallets(
      created.map((w, i) => ({
        fleet_id: fleet.id,
        user_id: user.id,
        account_id: w.accountId,
        wallet_index: i + 1,
        encrypted_private_key: w.encryptedKey,
      }))
    );
  } catch (dbErr: any) {
    // The fee is paid and the accounts exist: log every account so the fleet can be restored
    logger.error(`RaceFleet for user ${user.id} paid but not saved: ${dbErr?.message}. Accounts: ${created.map(w => w.accountId).join(', ')}`);
    return { success: false, reason: 'Your fleet was created and paid for but could not be saved. Contact support; nothing is lost.' };
  }

  if (created.length < clampedCount) {
    logger.warn(`RaceFleet ${fleet.id}: created ${created.length} of ${clampedCount} wallets`);
  }

  logger.info(`Successfully deployed RaceFleet ${fleet.id} with ${wallets.length} wallets for user ${user.id}`);

  invalidateFleetCache(fleet.id);

  return {
    success: true,
    fleet,
    wallets,
  };
}

/** Delete fleet accounts that will not be used, returning their storage deposit to the parent */
async function removeFleetAccounts(accounts: { accountId: string; keyPair: KeyPair }[], beneficiary: string): Promise<void> {
  for (const w of accounts) {
    try {
      await connectWithNearRpcFailover(w.accountId, w.keyPair, (account) => account.deleteAccount(beneficiary));
    } catch (err: any) {
      logger.warn(`Could not remove unused fleet wallet ${w.accountId}: ${err?.message || err}`);
    }
  }
}

// ── In-Memory Caches for High-Performance RaceFleet UI ────────────────────────
const fleetBalancesCache = new Map<string, { at: number; data: FleetBalancesResult }>();
const fleetHoldingsCache = new Map<string, { at: number; data: { text: string; keyboard: any } }>();
const fleetPositionCache = new Map<string, { at: number; data: FleetTokenPosition | null }>();
const FLEET_CACHE_TTL_MS = 15_000; // 15 seconds TTL

export function invalidateFleetCache(fleetId?: string) {
  if (!fleetId) {
    fleetBalancesCache.clear();
    fleetHoldingsCache.clear();
    fleetPositionCache.clear();
    return;
  }
  for (const key of fleetBalancesCache.keys()) {
    if (key.startsWith(fleetId)) fleetBalancesCache.delete(key);
  }
  fleetHoldingsCache.delete(fleetId);
  for (const key of fleetPositionCache.keys()) {
    if (key.startsWith(fleetId)) fleetPositionCache.delete(key);
  }
}

// ── Balance & Portfolio Aggregator ──────────────────────────────────────────
export interface FleetBalancesResult {
  totalNear: number;
  totalNearFormatted: string;
  totalNearUsd: string;
  wallets: {
    accountId: string;
    walletIndex: number;
    balanceNear: number;
    balanceYocto: string;
    tokenBalance?: string;
  }[];
  tokenTotal?: string;
  tokenTotalFormatted?: string;
}

export async function getFleetBalances(
  fleetId: string,
  tokenAddress?: string,
  forceRefresh = false
): Promise<FleetBalancesResult> {
  const cacheKey = `${fleetId}:${tokenAddress || 'none'}`;
  if (!forceRefresh) {
    const cached = fleetBalancesCache.get(cacheKey);
    if (cached && Date.now() - cached.at < FLEET_CACHE_TTL_MS) {
      return cached.data;
    }
  }

  const wallets = await getRaceFleetWallets(fleetId);
  const near = getNear();

  let tokenDecimals = 18;
  if (tokenAddress) {
    try {
      const meta = await near.getTokenMetadata(tokenAddress).catch(() => null);
      if (meta?.decimals) tokenDecimals = meta.decimals;
    } catch { /* no-op */ }
  }

  const walletResults = await Promise.all(
    wallets.map(async (w) => {
      const [balanceYocto, wNearYocto] = await Promise.all([
        near.getNearBalance(w.account_id).catch(() => '0'),
        near.getTokenBalance('wrap.near', w.account_id).catch(() => '0'),
      ]);
      const nativeNear = Number(BigInt(balanceYocto || '0') / 10n ** 20n) / 10_000;
      const wNear = Number(BigInt(wNearYocto || '0') / 10n ** 20n) / 10_000;
      const combinedNear = nativeNear + wNear;

      let tokenBal = '0';
      if (tokenAddress) {
        tokenBal = await near.getTokenBalance(tokenAddress, w.account_id).catch(() => '0');
      }

      return {
        accountId: w.account_id,
        walletIndex: w.wallet_index,
        balanceNear: combinedNear,
        balanceYocto,
        wNearYocto,
        tokenBalance: tokenBal,
      };
    })
  );

  const totalNear = walletResults.reduce((acc, curr) => acc + curr.balanceNear, 0);
  const totalNearFormatted = totalNear.toFixed(3);
  const nearUsdRate = 5.16; // default fallback
  const totalNearUsd = `$${(totalNear * nearUsdRate).toFixed(2)}`;

  let tokenTotalStr = '0';
  let tokenTotalFormatted = '0';
  if (tokenAddress) {
    const sumBigInt = walletResults.reduce(
      (acc, curr) => acc + BigInt(curr.tokenBalance || '0'),
      0n
    );
    tokenTotalStr = sumBigInt.toString();
    const tokenHuman = Number(sumBigInt / BigInt(10 ** Math.min(tokenDecimals, 18)));
    tokenTotalFormatted = tokenHuman >= 1e6
      ? `${(tokenHuman / 1e6).toFixed(2)}M`
      : tokenHuman >= 1e3
        ? `${(tokenHuman / 1e3).toFixed(2)}K`
        : tokenHuman.toFixed(2);
  }

  const result: FleetBalancesResult = {
    totalNear,
    totalNearFormatted,
    totalNearUsd,
    wallets: walletResults,
    tokenTotal: tokenTotalStr,
    tokenTotalFormatted,
  };

  fleetBalancesCache.set(cacheKey, { at: Date.now(), data: result });
  return result;
}

// ── 1-Click Distribute from Main Wallet ──────────────────────────────────────
export async function distributeFundsToFleet(
  userOrTelegramId: number | string | UserRecord,
  totalNear: number
): Promise<{
  success: boolean;
  distributedPerWallet?: number;
  walletCount?: number;
  reason?: string;
}> {
  const user = await resolveFleetUser(userOrTelegramId);
  if (!user) return { success: false, reason: 'User not found' };

  const fleet = await getRaceFleetByUserId(user.id);
  if (!fleet) return { success: false, reason: 'No active RaceFleet found' };

  const wallets = await getRaceFleetWallets(fleet.id);
  if (wallets.length === 0) return { success: false, reason: 'No wallets in fleet' };

  const near = getNear();
  const userBalanceYocto = await near.getNearBalance(await fleetPayerAccount(user)).catch(() => '0');
  const userBalanceNear = Number(BigInt(userBalanceYocto || '0') / 10n ** 20n) / 10_000;

  if (userBalanceNear < totalNear + 0.05) {
    return {
      success: false,
      reason: `Insufficient balance in main wallet. Available: ${userBalanceNear.toFixed(2)} NEAR, requested: ${totalNear} NEAR.`,
    };
  }

  const perWalletNear = totalNear / wallets.length;
  const perWalletFormatted = perWalletNear.toFixed(4);

  // One transfer at a time: they are all signed by the same key, so parallel ones collide on the nonce
  let successCount = 0;
  let lastError = '';
  for (const w of wallets) {
    try {
      await withdrawFunds(user, w.account_id, parseFloat(perWalletFormatted));
      successCount++;
    } catch (err: any) {
      lastError = err?.message || String(err);
      logger.warn(`Fleet funding to ${w.account_id} failed: ${lastError}`);
    }
  }

  if (successCount === 0) {
    return { success: false, reason: `Failed to disburse funds to fleet wallets. ${lastError}`.trim() };
  }

  invalidateFleetCache(fleet.id);

  return {
    success: true,
    distributedPerWallet: parseFloat(perWalletFormatted),
    walletCount: successCount,
  };
}

// ── 1-Click Sweep Funds Back to Main Wallet ─────────────────────────────────
export async function sweepFleetFunds(userOrTelegramId: number | string | UserRecord): Promise<{
  success: boolean;
  totalSweptNear: number;
  successCount: number;
  failCount: number;
  reason?: string;
}> {
  const user = await resolveFleetUser(userOrTelegramId);
  if (!user) return { success: false, totalSweptNear: 0, successCount: 0, failCount: 0, reason: 'User not found' };

  const fleet = await getRaceFleetByUserId(user.id);
  if (!fleet) return { success: false, totalSweptNear: 0, successCount: 0, failCount: 0, reason: 'No RaceFleet found' };

  const wallets = await getRaceFleetWallets(fleet.id);
  if (wallets.length === 0) return { success: false, totalSweptNear: 0, successCount: 0, failCount: 0, reason: 'No wallets in fleet' };

  const near = getNear();
  let totalSweptNear = 0;
  let successCount = 0;
  let failCount = 0;

  // Sweep each wallet in parallel
  await Promise.all(
    wallets.map(async (w) => {
      try {
        const rawPrivateKey = decrypt(w.encrypted_private_key, MASTER_KEY);
        const keyPair = KeyPair.fromString(rawPrivateKey as any);

        await connectWithNearRpcFailover(w.account_id, keyPair, async (account) => {
          // 1. Unwrap any leftover wrap.near back into native NEAR
          const wNearYocto = await near.getTokenBalance('wrap.near', w.account_id).catch(() => '0');
          const wNearBigInt = BigInt(wNearYocto || '0');
          if (wNearBigInt > 0n) {
            await account.functionCall({
              contractId: 'wrap.near',
              methodName: 'near_withdraw',
              args: { amount: wNearBigInt.toString() },
              gas: BigInt('30000000000000'), // 30 TGas
              attachedDeposit: 1n,
            }).catch((e: any) => logger.warn(`Failed unwrapping wNEAR during sweep for ${w.account_id}:`, e?.message));
          }

          // 2. Re-read native NEAR balance and sweep all
          const balYocto = await near.getNearBalance(w.account_id);
          const balNear = Number(BigInt(balYocto || '0') / 10n ** 20n) / 10_000;

          // Leave 0.005 NEAR reserve for gas/storage
          const sweepAmt = balNear - 0.005;
          if (sweepAmt <= 0.01) {
            return; // Skip empty wallet
          }

          const yoctoToSend = nearUtils.format.parseNearAmount(sweepAmt.toFixed(4))!;
          await account.sendMoney(user.subaccount_id, BigInt(yoctoToSend));
          totalSweptNear += sweepAmt;
          successCount++;
        });
      } catch (err: any) {
        logger.warn(`Sweep failed for wallet ${w.account_id}:`, err?.message);
        failCount++;
      }
    })
  );

  invalidateFleetCache(fleet.id);

  return {
    success: successCount > 0,
    totalSweptNear: parseFloat(totalSweptNear.toFixed(3)),
    successCount,
    failCount,
  };
}

// ── 1-Click Coordinated Bundle Buy ──────────────────────────────────────────
export interface FleetBundleBuyResult {
  success: boolean;
  successCount: number;
  failCount: number;
  totalSpentNear: number;
  txHashes: string[];
  errors: string[];
}

export async function executeFleetBundleBuy(
  fleetId: string,
  tokenAddress: string,
  amountNearPerWallet: number,
  slippagePct = 3.0
): Promise<FleetBundleBuyResult> {
  // Solana tokens trade from the fleet's Solana wallets (amount is SOL per wallet).
  if (isSolanaFleetToken(tokenAddress)) {
    const r = await executeSolanaFleetBundleBuy(fleetId, tokenAddress, amountNearPerWallet, slippagePct);
    invalidateFleetCache(fleetId);
    return r;
  }
  const wallets = await getRaceFleetWallets(fleetId);
  const near = getNear();
  const info = await getTokenInfo(tokenAddress, false).catch(() => null);
  const fail = (errors: string[]): FleetBundleBuyResult => ({
    success: false, successCount: 0, failCount: wallets.length, totalSpentNear: 0, txHashes: [], errors,
  });

  if (!info || !info.tradeable) return fail(['Token is not currently tradeable on-chain']);
  if (wallets.length === 0) return fail(['No NEAR wallets in this fleet']);
  const dclPoolId: string | null = info.dcl_pool_id ?? null;
  const rheaPoolId: number | null = info.rhea_pool_id ?? (info as any).pool_id ?? null;
  // Fleet bundles swap on Ref / Rhea pools. Never guess pool 0 for a launchpad token.
  if (!dclPoolId && (rheaPoolId === null || rheaPoolId === undefined)) {
    return fail(['This token has no Ref / Rhea pool yet, so the fleet cannot bundle it. Use a personal buy for launchpad tokens.']);
  }
  const venue = info.venue || 'ref';
  const gross = BigInt(nearUtils.format.parseNearAmount(amountNearPerWallet.toString())!);
  if (gross <= 0n) return fail(['Invalid amount']);
  // Each wallet spends `gross`: 1.5% to the treasury once its swap fills, the rest is swapped
  const { swapYocto: amount, feeYocto } = splitFleetBuy(gross);

  // 1. Read every wallet at once.
  const states = await Promise.all(wallets.map(async (w) => {
    const [bal, wnear, tokReg, wrapReg, refStorage] = await Promise.all([
      near.getNearBalance(w.account_id).catch(() => '0'),
      near.getTokenBalance('wrap.near', w.account_id).catch(() => '0'),
      near.checkStorageRegistered(w.account_id, tokenAddress).catch(() => false),
      near.checkStorageRegistered(w.account_id, 'wrap.near').catch(() => false),
      dclPoolId ? Promise.resolve(true) : near.view('v2.ref-finance.near', 'storage_balance_of', { account_id: w.account_id }).catch(() => null),
    ]);
    return { w, bal: BigInt(bal || '0'), wnear: BigInt(wnear || '0'), tokReg, wrapReg, refOk: Boolean(refStorage) };
  }));

  const errors: string[] = [];
  const legs = states.filter((s) => {
    const storage = (s.tokReg ? 0n : STORAGE_FT) + (s.wrapReg ? 0n : STORAGE_FT) + (s.refOk ? 0n : STORAGE_REF);
    const wrapNeeded = s.wnear >= amount ? 0n : amount - s.wnear;
    if (s.bal < wrapNeeded + feeYocto + storage + FLEET_GAS_RESERVE) {
      errors.push(`Wallet ${s.w.wallet_index} low balance (${(Number(s.bal + s.wnear) / 1e24).toFixed(2)} N)`);
      return false;
    }
    return true;
  });
  if (legs.length === 0) return fail(errors);

  // 2. One-time registrations (only wallets that need them), each wave fired together.
  const prep = async (needs: typeof legs, receiverId: string, deposit: bigint) => {
    if (needs.length === 0) return;
    const res = await fireNearTxsTogether(needs.map((s) => ({
      accountId: s.w.account_id,
      keyPair: KeyPair.fromString(decrypt(s.w.encrypted_private_key, MASTER_KEY) as any),
      receiverId,
      actions: [nearActions.call('storage_deposit', { account_id: s.w.account_id, registration_only: true }, 30, deposit)],
    })));
    res.forEach((r, i) => { if (!r.ok) errors.push(`Wallet ${needs[i].w.wallet_index}: registration failed (${r.error})`); });
  };
  await prep(legs.filter((s) => !s.tokReg), tokenAddress, STORAGE_FT);
  await prep(legs.filter((s) => !s.refOk), 'v2.ref-finance.near', STORAGE_REF);

  // 3. One quote for one wallet and one for the whole fleet: slippage covers the last fill in the wave.
  const single = await near.computeMinAmountOut(venue as any, 'wrap.near', tokenAddress, amount.toString(), slippagePct, rheaPoolId ?? undefined, dclPoolId ?? undefined);
  const expectedOne = BigInt(single.expectedOutput || '0');
  if (expectedOne <= 0n) return fail(['Could not get a price quote for this token']);
  const slipBps = await nearWaveSlippageBps(near, venue, 'wrap.near', tokenAddress, amount, expectedOne, legs.length, slippagePct, rheaPoolId, dclPoolId);
  const minOut = (expectedOne * BigInt(10_000 - slipBps)) / 10_000n;

  // 4. Every wallet's swap in ONE transaction to wrap.near (register + wrap + swap), all fired together.
  const swapMsg = dclPoolId
    ? (w: string) => JSON.stringify({ Swap: { pool_ids: [dclPoolId], output_token: tokenAddress, min_output_amount: minOut.toString(), swap_out_recipient: w } })
    : () => JSON.stringify({ actions: [{ pool_id: rheaPoolId, token_in: 'wrap.near', token_out: tokenAddress, amount_in: amount.toString(), min_amount_out: minOut.toString(), min_output_amount: minOut.toString() }] });
  const receiver = dclPoolId ? 'dclv2.ref-labs.near' : 'v2.ref-finance.near';
  const results = await fireNearTxsTogether(legs.map((s) => {
    const actions = [];
    if (!s.wrapReg) actions.push(nearActions.call('storage_deposit', { account_id: s.w.account_id, registration_only: true }, 30, STORAGE_FT));
    if (s.wnear < amount) actions.push(nearActions.call('near_deposit', {}, 10, amount - s.wnear));
    actions.push(nearActions.call('ft_transfer_call', { receiver_id: receiver, amount: amount.toString(), msg: swapMsg(s.w.account_id) }, 180, 1n));
    return {
      accountId: s.w.account_id,
      keyPair: KeyPair.fromString(decrypt(s.w.encrypted_private_key, MASTER_KEY) as any),
      receiverId: 'wrap.near',
      actions,
    };
  }));

  const txHashes: string[] = [];
  results.forEach((r, i) => {
    const used = ftUsedAmount(r.returnValue);
    if (r.ok && used !== 0n) txHashes.push(r.hash!);
    else errors.push(`Wallet ${legs[i].w.wallet_index}: ${r.ok ? 'swap refunded (price moved past slippage)' : r.error}`);
  });
  // 5. Platform fee, only from wallets whose swap filled (a refunded swap pays nothing)
  const filledLegs = legs.filter((_, i) => results[i].ok && ftUsedAmount(results[i].returnValue) !== 0n);
  let feesCollected = 0;
  if (feeYocto > 0n && filledLegs.length > 0) {
    const feeResults = await fireNearTxsTogether(filledLegs.map((s) => ({
      accountId: s.w.account_id,
      keyPair: KeyPair.fromString(decrypt(s.w.encrypted_private_key, MASTER_KEY) as any),
      receiverId: TREASURY_ACCOUNT_ID,
      actions: [nearActions.transfer(feeYocto)],
    }))).catch((err: any) => {
      logger.warn('Fleet buy fee collection failed', { error: String(err?.message || err) });
      return [];
    });
    feesCollected = feeResults.filter((r) => r.ok).length;
    if (feesCollected < filledLegs.length) {
      logger.warn(`Fleet buy fee: collected ${feesCollected} of ${filledLegs.length}`, { fleetId });
    }
  }
  const feePaidNear = Number(feeYocto * BigInt(feesCollected)) / 1e24;
  const totalSpentNear = (txHashes.length * amountNearPerWallet);

  if (txHashes.length > 0) {
    try {
      const fleet = await getRaceFleetById(fleetId);
      if (fleet) {
        const decimals = info.decimals ?? 18;
        const tokens = (Number(expectedOne) / Math.pow(10, decimals)) * txHashes.length;
        await recordRaceFleetFill({
          fleet_id: fleet.id,
          user_id: fleet.user_id,
          side: 'buy',
          token_address: tokenAddress,
          amount: tokens.toString(),
          price: tokens > 0 ? totalSpentNear / tokens : parseFloat(String(info.price || 0)),
          fee_paid: feePaidNear,
          venue: venue || 'ref',
          tx_hash: txHashes[0],
        });
      }
    } catch (fillErr) {
      logger.warn('Failed to record fleet fill', { error: String(fillErr) });
    }
  }

  invalidateFleetCache(fleetId);
  return {
    success: txHashes.length > 0,
    successCount: txHashes.length,
    failCount: errors.length,
    totalSpentNear: parseFloat(totalSpentNear.toFixed(3)),
    txHashes,
    errors,
  };
}

// ── 1-Click Coordinated Bundle Sell ─────────────────────────────────────────
export interface FleetBundleSellResult {
  success: boolean;
  successCount: number;
  failCount: number;
  txHashes: string[];
  errors: string[];
}

export async function executeFleetBundleSell(
  fleetId: string,
  tokenAddress: string,
  sellPct: number = 100,
  slippagePct = 3.0
): Promise<FleetBundleSellResult> {
  if (isSolanaFleetToken(tokenAddress)) {
    const r = await executeSolanaFleetBundleSell(fleetId, tokenAddress, sellPct, slippagePct);
    invalidateFleetCache(fleetId);
    return r;
  }
  const wallets = await getRaceFleetWallets(fleetId);
  const near = getNear();
  const info = await getTokenInfo(tokenAddress, false).catch(() => null);
  const fail = (errors: string[]): FleetBundleSellResult => ({ success: false, successCount: 0, failCount: wallets.length, txHashes: [], errors });
  if (!info) return fail(['Token information could not be retrieved']);
  const dclPoolId: string | null = info.dcl_pool_id ?? null;
  const rheaPoolId: number | null = info.rhea_pool_id ?? (info as any).pool_id ?? null;
  if (!dclPoolId && (rheaPoolId === null || rheaPoolId === undefined)) {
    return fail(['This token has no Ref / Rhea pool, so the fleet cannot bundle-sell it.']);
  }
  const venue = info.venue || 'ref';
  const pct = BigInt(Math.max(1, Math.min(100, Math.floor(sellPct))));

  // 1. Every wallet's balance at once.
  const states = await Promise.all(wallets.map(async (w) => {
    const [tok, bal] = await Promise.all([
      near.getTokenBalance(tokenAddress, w.account_id).catch(() => '0'),
      near.getNearBalance(w.account_id).catch(() => '0'),
    ]);
    return { w, tok: BigInt(tok || '0'), bal: BigInt(bal || '0') };
  }));
  const errors: string[] = [];
  const legs = states
    .filter((s) => s.tok > 0n)
    .filter((s) => {
      if (s.bal < SELL_GAS_RESERVE) { errors.push(`Wallet ${s.w.wallet_index} has no NEAR for gas`); return false; }
      return true;
    })
    .map((s) => ({ ...s, amount: pct === 100n ? s.tok : (s.tok * pct) / 100n }))
    .filter((s) => s.amount > 0n);
  if (legs.length === 0) return fail(errors.length ? errors : ['No tokens available to sell']);

  // 2. Quotes: an average wallet and the whole fleet, so the last fill still clears slippage.
  const total = legs.reduce((a, l) => a + l.amount, 0n);
  const avg = total / BigInt(legs.length);
  const one = await near.computeMinAmountOut(venue as any, tokenAddress, 'wrap.near', avg.toString(), slippagePct, rheaPoolId ?? undefined, dclPoolId ?? undefined);
  const expectedAvg = BigInt(one.expectedOutput || '0');
  if (expectedAvg <= 0n) return fail(['Could not get a price quote for this token']);
  const slipBps = await nearWaveSlippageBps(near, venue, tokenAddress, 'wrap.near', avg, expectedAvg, legs.length, slippagePct, rheaPoolId, dclPoolId);
  const minOutFor = (amt: bigint) => (((expectedAvg * amt) / avg) * BigInt(10_000 - slipBps)) / 10_000n;

  // 3. All sells fired together.
  const results = await fireNearTxsTogether(legs.map((s) => {
    const minOut = minOutFor(s.amount).toString();
    const msg = dclPoolId
      ? JSON.stringify({ Swap: { pool_ids: [dclPoolId], output_token: 'wrap.near', min_output_amount: minOut, swap_out_recipient: s.w.account_id } })
      : JSON.stringify({ actions: [{ pool_id: rheaPoolId, token_in: tokenAddress, token_out: 'wrap.near', amount_in: s.amount.toString(), min_amount_out: minOut, min_output_amount: minOut }] });
    return {
      accountId: s.w.account_id,
      keyPair: KeyPair.fromString(decrypt(s.w.encrypted_private_key, MASTER_KEY) as any),
      receiverId: tokenAddress,
      actions: [nearActions.call('ft_transfer_call', { receiver_id: dclPoolId ? 'dclv2.ref-labs.near' : 'v2.ref-finance.near', amount: s.amount.toString(), msg }, 180, 1n)],
    };
  }));

  const txHashes: string[] = [];
  const sold: typeof legs = [];
  results.forEach((r, i) => {
    const used = ftUsedAmount(r.returnValue);
    if (r.ok && used !== 0n) { txHashes.push(r.hash!); sold.push(legs[i]); }
    else errors.push(`Wallet ${legs[i].w.wallet_index}: ${r.ok ? 'swap refunded (price moved past slippage)' : r.error}`);
  });

  // 4. Unwrap the proceeds in every wallet, also together (best effort).
  if (sold.length > 0) {
    const wnear = await Promise.all(sold.map((s) => near.getTokenBalance('wrap.near', s.w.account_id).then((v) => BigInt(v || '0')).catch(() => 0n)));
    const unwrap = sold.map((s, i) => ({ s, amt: wnear[i] })).filter((x) => x.amt > 0n);
    await fireNearTxsTogether(unwrap.map((x) => ({
      accountId: x.s.w.account_id,
      keyPair: KeyPair.fromString(decrypt(x.s.w.encrypted_private_key, MASTER_KEY) as any),
      receiverId: 'wrap.near',
      actions: [nearActions.call('near_withdraw', { amount: x.amt.toString() }, 30, 1n)],
    })), 30_000).catch(() => { });
  }

  if (txHashes.length > 0) {
    try {
      const fleet = await getRaceFleetById(fleetId);
      if (fleet) {
        const decimals = info.decimals ?? 18;
        const soldRaw = sold.reduce((a, s) => a + s.amount, 0n);
        await recordRaceFleetFill({
          fleet_id: fleet.id,
          user_id: fleet.user_id,
          side: 'sell',
          token_address: tokenAddress,
          amount: (Number(soldRaw) / Math.pow(10, decimals)).toString(),
          price: info.price ? parseFloat(String(info.price)) : 0,
          fee_paid: 0,
          venue: venue || 'ref',
          tx_hash: txHashes[0],
        });
      }
    } catch (fillErr) {
      logger.warn('Failed to record fleet sell fill', { error: String(fillErr) });
    }
  }

  invalidateFleetCache(fleetId);
  return { success: txHashes.length > 0, successCount: txHashes.length, failCount: errors.length, txHashes, errors };
}

const STORAGE_FT = 1_250_000_000_000_000_000_000n; // 0.00125 NEAR
const STORAGE_REF = 12_500_000_000_000_000_000_000n; // 0.0125 NEAR
const FLEET_GAS_RESERVE = 20_000_000_000_000_000_000_000n; // 0.02 NEAR
const SELL_GAS_RESERVE = 5_000_000_000_000_000_000_000n; // 0.005 NEAR

/** ft_transfer_call returns the amount the receiver used; "0" means the swap was refunded. Null when unknown. */
function ftUsedAmount(returnValue: string | null): bigint | null {
  if (returnValue === null) return null;
  try {
    const v = JSON.parse(returnValue);
    return BigInt(String(v));
  } catch {
    return null;
  }
}

/**
 * Slippage (bps) that still fills the LAST wallet of a wave hitting one pool:
 * compares one wallet's quote with a quote for the whole fleet size.
 */
async function nearWaveSlippageBps(
  near: ReturnType<typeof getNear>,
  venue: string,
  tokenIn: string,
  tokenOut: string,
  amountOne: bigint,
  expectedOne: bigint,
  count: number,
  slippagePct: number,
  rheaPoolId: number | null,
  dclPoolId: string | null,
): Promise<number> {
  const base = Math.round(slippagePct * 100);
  if (count <= 1) return base;
  try {
    const all = await near.computeMinAmountOut(venue as any, tokenIn, tokenOut, (amountOne * BigInt(count)).toString(), slippagePct, rheaPoolId ?? undefined, dclPoolId ?? undefined);
    const expectedAll = Number(all.expectedOutput || '0');
    if (!(expectedAll > 0)) return Math.min(4900, base * 2);
    const avgLoss = 1 - expectedAll / (Number(expectedOne) * count);
    return Math.min(4900, base + Math.max(0, Math.ceil(avgLoss * 2 * 10_000 * 1.15)));
  } catch {
    return Math.min(4900, base * 2);
  }
}

// ── Export Decrypted Private Keys (User Custody) ────────────────────────────
export async function exportFleetKeys(telegramId: number): Promise<{
  success: boolean;
  fleetTag?: string;
  wallets?: { accountId: string; privateKey: string }[];
  reason?: string;
}> {
  const user = await getUserByTelegramId(telegramId);
  if (!user) return { success: false, reason: 'User not found' };

  const fleet = await getRaceFleetByUserId(user.id);
  if (!fleet) return { success: false, reason: 'No RaceFleet found' };

  const wallets = await getRaceFleetWallets(fleet.id);
  const exported = wallets.map((w) => {
    let pk = '';
    try {
      pk = decrypt(w.encrypted_private_key, MASTER_KEY);
    } catch {
      pk = 'Decryption error';
    }
    return {
      accountId: w.account_id,
      privateKey: pk,
    };
  });
  // Solana fleet wallets (base58 secret keys, import into Phantom / Solflare).
  exported.push(...(await exportSolanaFleetKeys(fleet.id).catch(() => [])));

  return {
    success: true,
    fleetTag: fleet.fleet_tag,
    wallets: exported,
  };
}

// ── Fleet Token Position & PnL Helper ───────────────────────────────────────
export interface FleetTokenPosition {
  fleetId: string;
  tokenAddress: string;
  symbol: string;
  totalBalanceRaw: bigint;
  totalBalanceHuman: number;
  walletsHoldingCount: number;
  walletCount: number;
  avgEntryPriceNear: number;
  currentPriceNear: number;
  currentPriceUsd: number;
  totalValueNear: number;
  totalValueUsd: number;
  pnlPct: number;
  pnlDisplay: string;
  emoji: string;
}

export async function getFleetTokenPosition(fleetId: string, tokenAddress: string, forceRefresh = false): Promise<FleetTokenPosition | null> {
  const cacheKey = `${fleetId}:${tokenAddress}`;
  if (!forceRefresh) {
    const cached = fleetPositionCache.get(cacheKey);
    if (cached && Date.now() - cached.at < FLEET_CACHE_TTL_MS) {
      return cached.data;
    }
  }

  const fleet = await getRaceFleetById(fleetId);
  if (!fleet) return null;

  if (isSolanaFleetToken(tokenAddress)) {
    const solPos = await getSolanaFleetTokenPosition(fleet, tokenAddress).catch(() => null);
    fleetPositionCache.set(cacheKey, { at: Date.now(), data: solPos });
    return solPos;
  }

  const wallets = await getRaceFleetWallets(fleetId);
  const near = getNear();
  const info = await getTokenInfo(tokenAddress, false);
  const decimals = info?.decimals ?? 18;
  const currentPriceNear = info?.price ? parseFloat(String(info.price)) : 0;
  const nearUsdRate = info?.near_usd || 5.16;
  const currentPriceUsd = currentPriceNear * nearUsdRate;

  let totalBalanceRaw = 0n;
  let walletsHoldingCount = 0;

  const balances = await Promise.allSettled(
    wallets.map(w => near.getTokenBalance(tokenAddress, w.account_id))
  );

  for (const b of balances) {
    if (b.status === 'fulfilled' && b.value) {
      try {
        const raw = BigInt(b.value);
        if (raw > 0n) {
          totalBalanceRaw += raw;
          walletsHoldingCount++;
        }
      } catch { }
    }
  }

  const totalBalanceHuman = Number(totalBalanceRaw) / Math.pow(10, decimals);
  const totalValueNear = totalBalanceHuman * currentPriceNear;
  const totalValueUsd = totalValueNear * nearUsdRate;

  // Compute entry price strictly from race_fleet_fills (completely independent from personal account)
  let avgEntryPriceNear = 0;
  try {
    const fills = await getRaceFleetFills(fleetId, tokenAddress);
    let totalBuyQty = 0;
    let totalBuyCost = 0;
    for (const f of fills) {
      if (f.side === 'buy') {
        const qty = parseFloat(f.amount || '0');
        const price = parseFloat(f.price || '0');
        if (qty > 0 && price > 0) {
          totalBuyQty += qty;
          totalBuyCost += qty * price;
        }
      }
    }
    if (totalBuyQty > 0 && totalBuyCost > 0) {
      avgEntryPriceNear = totalBuyCost / totalBuyQty;
    }
  } catch (err) {
    logger.warn('Failed to query race_fleet_fills for position', { error: String(err) });
  }

  let pnlPct = 0;
  let pnlDisplay = 'N/A';
  let emoji = '⚪';

  if (currentPriceNear > 0 && avgEntryPriceNear > 0) {
    pnlPct = ((currentPriceNear - avgEntryPriceNear) / avgEntryPriceNear) * 100;
    if (pnlPct > 0) {
      emoji = pnlPct >= 100 ? '🚀' : '🟢';
    } else if (pnlPct < 0) {
      emoji = '🔴';
    }
    pnlDisplay = `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`;
  } else if (currentPriceNear > 0) {
    pnlDisplay = 'LIVE';
    emoji = '🟢';
  }

  const result: FleetTokenPosition = {
    fleetId,
    tokenAddress,
    symbol: info?.symbol || tokenAddress.split('.')[0].toUpperCase(),
    totalBalanceRaw,
    totalBalanceHuman,
    walletsHoldingCount,
    walletCount: fleet.wallet_count,
    avgEntryPriceNear,
    currentPriceNear,
    currentPriceUsd,
    totalValueNear,
    totalValueUsd,
    pnlPct,
    pnlDisplay,
    emoji,
  };

  fleetPositionCache.set(cacheKey, { at: Date.now(), data: result });
  return result;
}

// ── Telegram UI: RaceFleet Cockpit Card ─────────────────────────────────────
export async function buildFleetCockpit(
  telegramId: number,
  tokenAddress: string
): Promise<{ text: string; keyboard: any }> {
  const user = await getUserByTelegramId(telegramId);
  if (!user) throw new Error('User not found');

  const fleet = await getRaceFleetByUserId(user.id);
  if (!fleet) {
    return buildFleetPromoCard();
  }

  if (isSolanaFleetToken(tokenAddress)) {
    return buildSolanaFleetCockpit(fleet, tokenAddress, getShortTokenKey(tokenAddress));
  }

  const [balances, info, fleetPos] = await Promise.all([
    getFleetBalances(fleet.id, tokenAddress),
    getTokenInfo(tokenAddress, false),
    getFleetTokenPosition(fleet.id, tokenAddress),
  ]);

  const shortKey = getShortTokenKey(tokenAddress);
  const sym = info?.symbol || 'TOKEN';
  const priceUsdStr = info?.price_usd ? `$${info.price_usd}` : '';
  const priceNum = typeof info?.price === 'number' ? info.price : parseFloat(String(info?.price || '0'));
  const priceNearStr = priceNum ? `${priceNum.toFixed(6)} NEAR` : '0.00';
  const priceDisplay = priceUsdStr ? `${priceNearStr} (${priceUsdStr})` : priceNearStr;

  const isFunded = balances.totalNear > 0.01;
  const fundingTip = !isFunded
    ? `⚠️ <i>Fleet balance is 0 NEAR. Disburse funds from your main wallet via [📥 Distribute NEAR] below to start bundle trading.</i>\n\n`
    : '';

  const holdingsText = balances.tokenTotal && balances.tokenTotal !== '0'
    ? `🎒 <b>Fleet Holdings</b>: <b>${balances.tokenTotalFormatted} ${sym}</b>\n` +
    (fleetPos && fleetPos.avgEntryPriceNear > 0
      ? `📈 <b>Fleet PnL</b>: ${fleetPos.emoji} <b>${fleetPos.pnlDisplay}</b> (Entry: <code>${fleetPos.avgEntryPriceNear.toFixed(8)} N</code>)\n`
      : '')
    : '';

  const text =
    `🏎 <b>RACEFLEET COCKPIT [BETA]</b> — $${sym}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🏷 <b>Fleet Tag</b>: <code>${fleet.fleet_tag}</code> (${fleet.wallet_count} Wallets)\n` +
    `💰 <b>Fleet Balance</b>: <b>${balances.totalNearFormatted} NEAR</b> (${balances.totalNearUsd})\n` +
    holdingsText +
    `🪙 <b>Target Token</b>: <code>${tokenAddress}</code>\n` +
    `📍 <b>Price</b>: ${priceDisplay}\n\n` +
    fundingTip +
    `⚡ <i>One tap fires all ${fleet.wallet_count} wallets at the same moment.</i>`;

  const keyboard = Markup.inlineKeyboard([
    // One tap fires every fleet wallet at the same instant.
    [
      Markup.button.callback('🟢 Fleet BUY', `fleet_buy_prompt:${shortKey}`),
      Markup.button.callback('🔴 Fleet SELL', `fleet_sell_prompt:${shortKey}`),
    ],
    // Pre-attached Protection Snipe
    [
      Markup.button.callback('🎯 Snipe (1 N + 50% TP / 15% SL)', `fleet_snipe_protect:${shortKey}`),
    ],
    // Fleet Limit Order
    [
      Markup.button.callback('🎯 Fleet Limit Order', `fleet_lo_start:${shortKey}`),
      Markup.button.callback('🌊 Volume Maker', `fleet_volume_prompt:${shortKey}`),
    ],
    // Navigation
    [
      Markup.button.callback('« 👤 Switch to Personal Wallet', `token_refresh:${shortKey}`),
      Markup.button.callback('🏎️ Fleet Dashboard', 'racefleet_menu'),
    ],
  ]);

  return { text, keyboard };
}

// ── Telegram UI: RaceFleet Main Dashboard ───────────────────────────────────
export async function buildRaceFleetDashboard(telegramId: number): Promise<{ text: string; keyboard: any }> {
  const user = await getUserByTelegramId(telegramId);
  if (!user) throw new Error('User not found');

  const fleet = await getRaceFleetByUserId(user.id);
  if (!fleet) {
    return buildFleetPromoCard();
  }

  const [balances, solBalances] = await Promise.all([
    getFleetBalances(fleet.id),
    getSolanaFleetBalances(fleet).catch(() => null),
  ]);
  const isExpired = new Date(fleet.expires_at).getTime() <= Date.now();
  const statusEmoji = isExpired ? '🔴 Expired' : '🟢 Active';
  const expiresAtFormatted = new Date(fleet.expires_at).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  const text =
    `🏎 <b>RACERBOT RACEFLEET [BETA]</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `<i>🚀 Multi-Wallet Coordination Engine (Beta Launch)</i>\n\n` +
    `Status: ${statusEmoji} (Renews: ${expiresAtFormatted})\n` +
    `Fleet ID: <code>${fleet.fleet_tag}</code>\n` +
    `Active Fleet Size: <b>${fleet.wallet_count} Named Wallets</b>\n` +
    `Total Fleet NEAR: <b>${balances.totalNearFormatted} NEAR</b> (${balances.totalNearUsd})\n` +
    `Average per Wallet: <b>${(balances.totalNear / fleet.wallet_count).toFixed(2)} NEAR</b>\n` +
    (solBalances ? `◎ Total Fleet SOL: <b>${solBalances.totalSol.toFixed(4)} SOL</b> (${solBalances.wallets.length} Solana wallets)\n` : '') +
    `\n<i>Paste any NEAR or Solana token and tap 🏎️ Fleet to bundle trade. NEAR subaccounts and Solana wallets run in parallel.</i>`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('📊 Fleet Holdings & PnL', 'fleet_holdings'),
      Markup.button.callback('💳 View All Wallets', 'fleet_wallets_list'),
    ],
    [
      Markup.button.callback('📥 Distribute NEAR', 'fleet_fund_prompt'),
      Markup.button.callback('📤 Sweep NEAR', 'fleet_sweep_prompt'),
    ],
    [
      Markup.button.callback('📥 Distribute SOL', 'fleet_fund_sol_prompt'),
      Markup.button.callback('📤 Sweep SOL', 'fleet_sweep_sol'),
    ],
    [
      Markup.button.callback('📋 Active Orders', 'fleet_orders_list'),
      Markup.button.callback('🔑 Export Fleet Keys', 'fleet_export_keys'),
    ],
    [
      Markup.button.callback('🔄 Renew (2 NEAR)', 'fleet_renew_prompt'),
      Markup.button.callback('🔄 Renew (pay in SOL)', 'fleet_renew_sol_prompt'),
    ],
    [
      Markup.button.callback('🔙 Back to Main Menu', 'menu_home'),
    ],
  ]);

  return { text, keyboard };
}

// ── Telegram UI: RaceFleet Holdings & PnL View ──────────────────────────────
export async function buildFleetHoldingsView(userOrTelegramId: number | UserRecord, forceRefresh = false): Promise<{ text: string; keyboard: any }> {
  // Telegram passes its user id; the webapp passes the signed-in user (web accounts have no Telegram id)
  const user = await resolveFleetUser(userOrTelegramId);
  if (!user) throw new Error('User not found');

  const fleet = await getRaceFleetByUserId(user.id);
  if (!fleet) {
    return buildFleetPromoCard();
  }

  if (!forceRefresh) {
    const cached = fleetHoldingsCache.get(fleet.id);
    if (cached && Date.now() - cached.at < FLEET_CACHE_TTL_MS) {
      return cached.data;
    }
  }

  const wallets = await getRaceFleetWallets(fleet.id);
  const near = getNear();

  // Discover all tokens across all fleet wallets via FastNEAR indexer with 1.5s timeout
  const discoveredTokenContracts = new Set<string>();
  const fastnearTimeout = 1500;
  await Promise.allSettled(
    wallets.map(async (w) => {
      try {
        const fetchPromise = getFastnearAccountTokens(w.account_id);
        const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), fastnearTimeout));
        const res = await Promise.race([fetchPromise, timeoutPromise]);
        const tokens = res?.contract_ids || [];
        for (const t of tokens) {
          if (t && t !== 'wrap.near' && t !== 'near' && t !== 'aurora') {
            discoveredTokenContracts.add(t);
          }
        }
      } catch { /* graceful fallback */ }
    })
  );

  // Discover traded tokens strictly from race_fleet_fills for this fleet (independent from personal account)
  try {
    const fleetFills = await getRaceFleetFills(fleet.id);
    for (const f of fleetFills) {
      if (f.token_address && !f.token_address.includes('::') && !f.token_address.startsWith('0x')) {
        discoveredTokenContracts.add(f.token_address);
      }
    }
  } catch { /* ignore */ }

  const nearBalances = await getFleetBalances(fleet.id, undefined, forceRefresh);
  const tokenList = Array.from(discoveredTokenContracts);

  // Parallel token scanning across all discovered tokens
  const tokenHoldingsResults = await Promise.allSettled(
    tokenList.map(async (tokenAddr) => {
      const info = await getTokenInfo(tokenAddr, false);
      const decimals = info?.decimals ?? 18;
      const currentPriceNear = info?.price ? parseFloat(String(info.price)) : 0;
      const nearUsdRate = info?.near_usd || 5.16;
      const currentPriceUsd = currentPriceNear * nearUsdRate;

      // Query balance across all fleet wallets in parallel
      let totalRawBigInt = 0n;
      let walletsHoldingCount = 0;

      const balances = await Promise.allSettled(
        wallets.map(w => near.getTokenBalance(tokenAddr, w.account_id))
      );

      for (const b of balances) {
        if (b.status === 'fulfilled' && b.value) {
          try {
            const raw = BigInt(b.value);
            if (raw > 0n) {
              totalRawBigInt += raw;
              walletsHoldingCount++;
            }
          } catch { }
        }
      }

      if (totalRawBigInt <= 0n) return null;

      const totalBalanceHuman = Number(totalRawBigInt) / Math.pow(10, decimals);
      if (totalBalanceHuman < 0.000001) return null;

      const totalValueNear = totalBalanceHuman * currentPriceNear;
      const totalValueUsd = totalValueNear * nearUsdRate;

      // Filter dust: if price is known and total fleet value is < 1 cent ($0.01) and quantity is negligible, treat as sold dust
      if (currentPriceNear > 0 && totalValueUsd < 0.01 && totalBalanceHuman < 1) return null;

      // Calculate entry price & PNL strictly from race_fleet_fills (independent from personal account)
      let avgEntryPriceNear = 0;
      try {
        const fills = await getRaceFleetFills(fleet.id, tokenAddr);
        let totalBuyQty = 0;
        let totalBuyCost = 0;
        for (const row of fills) {
          if (row.side === 'buy') {
            const qty = parseFloat(row.amount || '0');
            const price = parseFloat(row.price || '0');
            if (qty > 0 && price > 0) {
              totalBuyQty += qty;
              totalBuyCost += qty * price;
            }
          }
        }

        if (totalBuyQty > 0 && totalBuyCost > 0) {
          avgEntryPriceNear = totalBuyCost / totalBuyQty;
        }
      } catch { }

      let pnlPct = 0;
      let pnlDisplay = 'N/A';
      let emoji = '⚪';

      if (currentPriceNear > 0 && avgEntryPriceNear > 0) {
        pnlPct = ((currentPriceNear - avgEntryPriceNear) / avgEntryPriceNear) * 100;
        if (pnlPct > 0) {
          emoji = pnlPct >= 100 ? '🚀' : '🟢';
        } else if (pnlPct < 0) {
          emoji = '🔴';
        }
        pnlDisplay = `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`;
      } else if (currentPriceNear > 0) {
        pnlDisplay = 'LIVE';
        emoji = '🟢';
      }

      return {
        tokenAddress: tokenAddr,
        symbol: info?.symbol || tokenAddr.split('.')[0].toUpperCase(),
        totalBalanceHuman,
        currentPriceNear,
        currentPriceUsd,
        totalValueNear,
        totalValueUsd,
        avgEntryPriceNear,
        pnlPct,
        pnlDisplay,
        emoji,
        walletsHoldingCount,
      };
    })
  );

  const tokenHoldings: {
    tokenAddress: string;
    symbol: string;
    totalBalanceHuman: number;
    currentPriceNear: number;
    currentPriceUsd: number;
    totalValueNear: number;
    totalValueUsd: number;
    avgEntryPriceNear: number;
    pnlPct: number;
    pnlDisplay: string;
    emoji: string;
    walletsHoldingCount: number;
  }[] = [];

  for (const r of tokenHoldingsResults) {
    if (r.status === 'fulfilled' && r.value) {
      tokenHoldings.push(r.value);
    }
  }

  // Calculate total portfolio value across all fleet wallets
  const totalTokensValueNear = tokenHoldings.reduce((sum, t) => sum + t.totalValueNear, 0);
  const totalTokensValueUsd = tokenHoldings.reduce((sum, t) => sum + t.totalValueUsd, 0);
  const totalPortfolioNear = nearBalances.totalNear + totalTokensValueNear;
  const totalPortfolioUsd = parseFloat((nearBalances.totalNear * 5.16).toFixed(2)) + totalTokensValueUsd;

  let text =
    `📊 <b>RACEFLEET HOLDINGS & PNL</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🏷 <b>Fleet Tag</b>: <code>${fleet.fleet_tag}</code> (${fleet.wallet_count} Wallets)\n` +
    `💼 <b>Total Portfolio Value</b>: <b>${totalPortfolioNear.toFixed(3)} NEAR</b> ($${totalPortfolioUsd.toFixed(2)})\n` +
    `💰 <b>Liquid Cash</b>: <b>${nearBalances.totalNearFormatted} NEAR</b> (${nearBalances.totalNearUsd})\n\n`;

  if (tokenHoldings.length === 0) {
    text +=
      `ℹ️ <i>No token holdings found across your ${fleet.wallet_count} fleet wallets yet.</i>\n\n` +
      `💡 <i>When you execute a bundle buy on any token CA, the combined holdings, live valuations, and PnL will display here.</i>`;
  } else {
    text += `🪙 <b>Fleet Token Positions:</b>\n\n`;
    for (const t of tokenHoldings) {
      const balanceStr = t.totalBalanceHuman >= 1e6
        ? `${(t.totalBalanceHuman / 1e6).toFixed(2)}M`
        : t.totalBalanceHuman >= 1e3
          ? `${(t.totalBalanceHuman / 1e3).toFixed(2)}K`
          : t.totalBalanceHuman.toFixed(2);

      text +=
        `${t.emoji} <b>$${t.symbol}</b> (${t.pnlDisplay})\n` +
        `• <b>Total Balance</b>: <code>${balanceStr} ${t.symbol}</code>\n` +
        `• <b>Total Value</b>: <b>${t.totalValueNear.toFixed(3)} NEAR</b> ($${t.totalValueUsd.toFixed(2)})\n` +
        `• <b>Wallets Holding</b>: ${t.walletsHoldingCount}/${fleet.wallet_count}\n` +
        (t.avgEntryPriceNear > 0 ? `• <b>Avg Entry</b>: ${t.avgEntryPriceNear.toFixed(6)} N | <b>Current</b>: ${t.currentPriceNear.toFixed(6)} N\n` : '') +
        `\n`;
    }
  }

  const solSection = await buildSolanaFleetHoldingsSection(fleet).catch(() => ({ text: '', rows: [] as { symbol: string; mint: string }[] }));
  text += solSection.text;

  const keyboardButtons: any[] = [];
  // Top row: Refresh at the top so users can refresh fleet holdings immediately
  keyboardButtons.push([
    Markup.button.callback('🔄 Refresh Holdings', 'fleet_holdings_refresh'),
    Markup.button.callback('🏎️ Fleet Dashboard', 'racefleet_menu'),
  ]);

  for (const t of tokenHoldings) {
    const shortKey = getShortTokenKey(t.tokenAddress);
    keyboardButtons.push([
      Markup.button.callback(`🏎️ ${t.symbol} Cockpit`, `fleet_cockpit:${shortKey}`),
      Markup.button.callback(`🔴 Fleet SELL`, `fleet_sell_prompt:${shortKey}`),
    ]);
  }

  for (const s of solSection.rows) {
    const shortKey = getShortTokenKey(s.mint);
    keyboardButtons.push([
      Markup.button.callback(`🏎️ ${s.symbol} Cockpit ◎`, `fleet_cockpit:${shortKey}`),
      Markup.button.callback(`🔴 Fleet SELL`, `fleet_sell_prompt:${shortKey}`),
    ]);
  }

  keyboardButtons.push([
    Markup.button.callback('🔙 Main Menu', 'menu_home'),
  ]);

  const viewResult = { text, keyboard: Markup.inlineKeyboard(keyboardButtons) };
  fleetHoldingsCache.set(fleet.id, { at: Date.now(), data: viewResult });
  return viewResult;
}

// ── Telegram UI: RaceFleet Promo / Upgrade Card ─────────────────────────────
export function buildFleetPromoCard(): { text: string; keyboard: any } {
  const text =
    `🏎 <b>Unlock RacerBot RaceFleet [BETA]</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `<i>🚀 Multi-Wallet Coordination Engine (Beta Launch)</i>\n\n` +
    `Deploy a coordinated fleet of up to <b>20 named RacerBot wallets</b> on NEAR mainnet.\n\n` +
    `⚡ <b>Key Advantages:</b>\n` +
    `• <b>1-Block Bundle Sniping</b>: Bypass per-wallet caps at token launch.\n` +
    `• <b>Coordinated Buys/Sells</b>: Fire 20 swaps in 1 single second.\n` +
    `• <b>Fleet-Wide SL/TP</b>: Protect all 20 wallets with 1 combined trigger.\n` +
    `• <b>Autonomous Volume Maker</b>: Generate organic volume loops.\n` +
    `• <b>1-Click Distribute & Sweep</b>: Effortless fund balance management.\n` +
    `• <b>Named Wallets</b>: Promotes the bot across all NEAR explorers.\n\n` +
    `💰 <b>Subscription</b>: <code>${RACEFLEET_MONTHLY_FEE_NEAR} NEAR / month</code> (or the same value in SOL)\n` +
    `◎ <b>Solana</b>: every fleet also gets the same number of Solana wallets for pump.fun and DEX bundles.\n` +
    `<i>(Selling & Sweeping funds are NEVER blocked even if expired)</i>`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('🚀 Deploy Fleet (5 Wallets)', 'fleet_deploy:5'),
      Markup.button.callback('🚀 Deploy Fleet (10 Wallets)', 'fleet_deploy:10'),
    ],
    [
      Markup.button.callback('🚀 Deploy Fleet (15 Wallets)', 'fleet_deploy:15'),
      Markup.button.callback('🚀 Deploy Fleet (20 Wallets)', 'fleet_deploy:20'),
    ],
    [
      Markup.button.callback('◎ Pay in SOL (5 Wallets)', 'fleet_deploy_sol:5'),
      Markup.button.callback('◎ Pay in SOL (10 Wallets)', 'fleet_deploy_sol:10'),
    ],
    [
      Markup.button.callback('🔙 Back to Main Menu', 'menu_home'),
    ],
  ]);

  return { text, keyboard };
}
