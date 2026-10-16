import { Markup, Context } from 'telegraf';
import { KeyPair, utils as nearUtils } from 'near-api-js';
import {
  getNear,
  createLogger,
  encrypt,
  decrypt,
  formatTokenUnits,
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
  type RaceFleetRecord,
  type RaceFleetWalletRecord,
  type RaceFleetOrderRecord,
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

const logger = createLogger('race_fleet');

export const RACEFLEET_MONTHLY_FEE_NEAR = 2.0;
export const MAX_FLEET_WALLETS = 25;
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

// ── Deploy / Subscribe to RaceFleet ─────────────────────────────────────────
export async function deployRaceFleet(
  telegramId: number,
  walletCount: number = 10,
  fleetName: string = 'Alpha Fleet'
): Promise<{
  success: boolean;
  fleet?: RaceFleetRecord;
  wallets?: RaceFleetWalletRecord[];
  reason?: string;
  txHash?: string;
}> {
  const user = await getUserByTelegramId(telegramId);
  if (!user) {
    return { success: false, reason: 'User not found. Please run /start first.' };
  }

  const clampedCount = Math.max(MIN_FLEET_WALLETS, Math.min(MAX_FLEET_WALLETS, walletCount));
  const near = getNear();

  // 1. Verify User Balance has at least 2.0 NEAR
  const balanceYocto = await near.getNearBalance(user.subaccount_id).catch(() => '0');
  const balanceNear = Number(BigInt(balanceYocto || '0') / 10n ** 20n) / 10_000;

  if (balanceNear < RACEFLEET_MONTHLY_FEE_NEAR + 0.05) {
    return {
      success: false,
      reason: `Insufficient balance. RaceFleet subscription is ${RACEFLEET_MONTHLY_FEE_NEAR} NEAR / month. You have ${balanceNear.toFixed(2)} NEAR in your main wallet.`,
    };
  }

  // 2. Collect 2 NEAR Subscription Fee to Treasury
  try {
    const feeWithdrawal = await withdrawFunds(telegramId, TREASURY_ACCOUNT_ID, RACEFLEET_MONTHLY_FEE_NEAR);
    logger.info(`Paid RaceFleet subscription fee for user ${user.id}: tx ${feeWithdrawal.txHash}`);
  } catch (payErr: any) {
    return { success: false, reason: `Subscription payment failed: ${payErr?.message || payErr}` };
  }

  // 3. Generate Fleet Tag & Child Accounts
  const fleetTag = generateRandomFleetTag();
  const parentAccountName = RACERBOT_PARENT_ACCOUNT || 'racerbot.near';

  const walletKeys: {
    accountId: string;
    keyPair: KeyPair;
    encryptedKey: string;
    walletIndex: number;
  }[] = [];

  for (let i = 1; i <= clampedCount; i++) {
    const idxStr = i < 10 ? `0${i}` : `${i}`;
    const accountId = `${fleetTag}-${idxStr}.${parentAccountName}`;
    const keyPair = generateFleetKeyPair();
    const encryptedKey = encrypt(keyPair.toString(), MASTER_KEY);
    walletKeys.push({
      accountId,
      keyPair,
      encryptedKey,
      walletIndex: i,
    });
  }

  // 4. Deploy Subaccounts on NEAR Mainnet via Parent Account
  if (!MAIN_WALLET_PRIVATE_KEY) {
    return { success: false, reason: 'Server configuration error: MAIN_WALLET_PRIVATE_KEY missing.' };
  }

  const parentKeyPair = KeyPair.fromString(MAIN_WALLET_PRIVATE_KEY as any);
  const initialStorageDeposit = nearUtils.format.parseNearAmount('0.00182')!;

  try {
    await connectWithNearRpcFailover(parentAccountName, parentKeyPair, async (parentAccount) => {
      // Deploy all subaccounts in parallel batches of 5 to avoid RPC spam
      const batchSize = 5;
      for (let i = 0; i < walletKeys.length; i += batchSize) {
        const batch = walletKeys.slice(i, i + batchSize);
        await Promise.all(
          batch.map(async (w) => {
            await parentAccount.createAccount(
              w.accountId,
              w.keyPair.getPublicKey().toString(),
              BigInt(initialStorageDeposit)
            ).catch((err: any) => {
              // If account already exists on-chain, proceed
              if (!String(err?.message).includes('already exists')) {
                throw err;
              }
            });
          })
        );
      }
    });
  } catch (deployErr: any) {
    logger.error('Failed to create fleet subaccounts on-chain:', deployErr);
    return {
      success: false,
      reason: `Failed to deploy fleet subaccounts: ${deployErr?.message || deployErr}`,
    };
  }

  // 5. Store in Database
  const fleet = await upsertRaceFleet({
    user_id: user.id,
    name: fleetName,
    fleet_tag: fleetTag,
    wallet_count: clampedCount,
    monthly_fee_near: RACEFLEET_MONTHLY_FEE_NEAR,
    duration_days: 30,
    auto_renew: true,
  });

  const wallets = await createRaceFleetWallets(
    walletKeys.map((w) => ({
      fleet_id: fleet.id,
      user_id: user.id,
      account_id: w.accountId,
      wallet_index: w.walletIndex,
      encrypted_private_key: w.encryptedKey,
    }))
  );

  logger.info(`Successfully deployed RaceFleet ${fleet.id} with ${wallets.length} wallets for user ${user.id}`);

  return {
    success: true,
    fleet,
    wallets,
  };
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
  tokenAddress?: string
): Promise<FleetBalancesResult> {
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
      const balanceYocto = await near.getNearBalance(w.account_id).catch(() => '0');
      const balanceNear = Number(BigInt(balanceYocto || '0') / 10n ** 20n) / 10_000;

      let tokenBal = '0';
      if (tokenAddress) {
        tokenBal = await near.getTokenBalance(tokenAddress, w.account_id).catch(() => '0');
      }

      return {
        accountId: w.account_id,
        walletIndex: w.wallet_index,
        balanceNear,
        balanceYocto,
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

  return {
    totalNear,
    totalNearFormatted,
    totalNearUsd,
    wallets: walletResults,
    tokenTotal: tokenTotalStr,
    tokenTotalFormatted,
  };
}

// ── 1-Click Distribute from Main Wallet ──────────────────────────────────────
export async function distributeFundsToFleet(
  telegramId: number,
  totalNear: number
): Promise<{
  success: boolean;
  distributedPerWallet?: number;
  walletCount?: number;
  reason?: string;
}> {
  const user = await getUserByTelegramId(telegramId);
  if (!user) return { success: false, reason: 'User not found' };

  const fleet = await getRaceFleetByUserId(user.id);
  if (!fleet) return { success: false, reason: 'No active RaceFleet found' };

  const wallets = await getRaceFleetWallets(fleet.id);
  if (wallets.length === 0) return { success: false, reason: 'No wallets in fleet' };

  const near = getNear();
  const userBalanceYocto = await near.getNearBalance(user.subaccount_id).catch(() => '0');
  const userBalanceNear = Number(BigInt(userBalanceYocto || '0') / 10n ** 20n) / 10_000;

  if (userBalanceNear < totalNear + 0.05) {
    return {
      success: false,
      reason: `Insufficient balance in main wallet. Available: ${userBalanceNear.toFixed(2)} NEAR, requested: ${totalNear} NEAR.`,
    };
  }

  const perWalletNear = totalNear / wallets.length;
  const perWalletFormatted = perWalletNear.toFixed(4);

  // Send transfers from main wallet to each fleet wallet
  const results = await Promise.allSettled(
    wallets.map((w) =>
      withdrawFunds(telegramId, w.account_id, parseFloat(perWalletFormatted))
    )
  );

  const successCount = results.filter((r) => r.status === 'fulfilled').length;

  if (successCount === 0) {
    return { success: false, reason: 'Failed to disburse funds to fleet wallets.' };
  }

  return {
    success: true,
    distributedPerWallet: parseFloat(perWalletFormatted),
    walletCount: successCount,
  };
}

// ── 1-Click Sweep Funds Back to Main Wallet ─────────────────────────────────
export async function sweepFleetFunds(telegramId: number): Promise<{
  success: boolean;
  totalSweptNear: number;
  successCount: number;
  failCount: number;
  reason?: string;
}> {
  const user = await getUserByTelegramId(telegramId);
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
        const balYocto = await near.getNearBalance(w.account_id);
        const balNear = Number(BigInt(balYocto || '0') / 10n ** 20n) / 10_000;

        // Leave 0.005 NEAR reserve for gas/storage
        const sweepAmt = balNear - 0.005;
        if (sweepAmt <= 0.01) {
          return; // Skip empty wallet
        }

        const rawPrivateKey = decrypt(w.encrypted_private_key, MASTER_KEY);
        const keyPair = KeyPair.fromString(rawPrivateKey as any);

        await connectWithNearRpcFailover(w.account_id, keyPair, async (account) => {
          const yoctoToSend = nearUtils.format.parseNearAmount(sweepAmt.toFixed(4))!;
          await account.sendMoney(user.subaccount_id, BigInt(yoctoToSend));
        });

        totalSweptNear += sweepAmt;
        successCount++;
      } catch (err: any) {
        logger.warn(`Sweep failed for wallet ${w.account_id}:`, err?.message);
        failCount++;
      }
    })
  );

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
  const wallets = await getRaceFleetWallets(fleetId);
  const near = getNear();
  const info = await getTokenInfo(tokenAddress, false);

  if (!info || !info.tradeable) {
    return {
      success: false,
      successCount: 0,
      failCount: wallets.length,
      totalSpentNear: 0,
      txHashes: [],
      errors: ['Token is not currently tradeable on-chain'],
    };
  }

  const amountYocto = nearUtils.format.parseNearAmount(amountNearPerWallet.toString())!;
  const venue = info.venue || 'ref';

  const txHashes: string[] = [];
  const errors: string[] = [];
  let totalSpentNear = 0;

  // Execute across all fleet wallets in parallel with Promise.allSettled
  const executions = await Promise.allSettled(
    wallets.map(async (w) => {
      // 1. Check wallet balance
      const balYocto = await near.getNearBalance(w.account_id);
      const balNear = Number(BigInt(balYocto || '0') / 10n ** 20n) / 10_000;
      if (balNear < amountNearPerWallet + 0.01) {
        throw new Error(`Wallet ${w.wallet_index} low balance (${balNear.toFixed(2)} N)`);
      }

      const rawPrivateKey = decrypt(w.encrypted_private_key, MASTER_KEY);
      const keyPair = KeyPair.fromString(rawPrivateKey as any);

      return connectWithNearRpcFailover(w.account_id, keyPair, async (account) => {
        // 2. Ensure NEP-141 storage deposit is registered
        const isRegistered = await near.checkStorageRegistered(w.account_id, tokenAddress).catch(() => false);
        if (!isRegistered) {
          const storageDepositYocto = nearUtils.format.parseNearAmount('0.00125')!;
          await account.functionCall({
            contractId: tokenAddress,
            methodName: 'storage_deposit',
            args: { account_id: w.account_id, registration_only: true },
            gas: BigInt('30000000000000'), // 30 TGas
            attachedDeposit: BigInt(storageDepositYocto),
          }).catch(() => { /* may be already registered */ });
        }

        // 3. Deposit wrap.near
        await account.functionCall({
          contractId: 'wrap.near',
          methodName: 'near_deposit',
          args: {},
          gas: BigInt('30000000000000'), // 30 TGas
          attachedDeposit: BigInt(amountYocto),
        });

        // 4. Ensure Ref Finance storage if trading on AMM
        if (!info.dcl_pool_id && info.rhea_pool_id !== undefined && info.rhea_pool_id !== null) {
          const refStorage = await near.view('v2.ref-finance.near', 'storage_balance_of', { account_id: w.account_id }).catch(() => null);
          if (!refStorage) {
            const refStorageDeposit = nearUtils.format.parseNearAmount('0.0125')!;
            await account.functionCall({
              contractId: 'v2.ref-finance.near',
              methodName: 'storage_deposit',
              args: { account_id: w.account_id, registration_only: false },
              gas: BigInt('30000000000000'),
              attachedDeposit: BigInt(refStorageDeposit),
            }).catch(() => {});
          }
        }

        // 5. Compute min amount out
        const { minAmountOut } = await near.computeMinAmountOut(
          venue as any,
          'wrap.near',
          tokenAddress,
          amountYocto,
          slippagePct,
          info.rhea_pool_id ?? undefined,
          info.dcl_pool_id ?? undefined
        );

        // 6. Execute Buy Swap via ft_transfer_call
        let res: any;
        if (info.dcl_pool_id) {
          res = await account.functionCall({
            contractId: 'wrap.near',
            methodName: 'ft_transfer_call',
            args: {
              receiver_id: 'dclv2.ref-labs.near',
              amount: amountYocto,
              msg: JSON.stringify({
                Swap: {
                  pool_ids: [info.dcl_pool_id],
                  output_token: tokenAddress,
                  min_output_amount: minAmountOut,
                  swap_out_recipient: w.account_id,
                },
              }),
            },
            gas: BigInt('180000000000000'), // 180 TGas
            attachedDeposit: 1n,
          });
        } else {
          // Ref / Rhea AMM swap
          const poolId = info.rhea_pool_id ?? (info as any).pool_id ?? 0;
          res = await account.functionCall({
            contractId: 'wrap.near',
            methodName: 'ft_transfer_call',
            args: {
              receiver_id: 'v2.ref-finance.near',
              amount: amountYocto,
              msg: JSON.stringify({
                actions: [
                  {
                    pool_id: poolId,
                    token_in: 'wrap.near',
                    token_out: tokenAddress,
                    amount_in: amountYocto,
                    min_amount_out: minAmountOut,
                    min_output_amount: minAmountOut,
                  },
                ],
              }),
            },
            gas: BigInt('180000000000000'), // 180 TGas
            attachedDeposit: 1n,
          });
        }

        const txHash = res?.transaction?.hash || 'confirmed';
        return { txHash, spentNear: amountNearPerWallet };
      });
    })
  );

  for (const exec of executions) {
    if (exec.status === 'fulfilled') {
      txHashes.push(exec.value.txHash);
      totalSpentNear += exec.value.spentNear;
    } else {
      errors.push(exec.reason?.message || 'Execution error');
    }
  }

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
  const wallets = await getRaceFleetWallets(fleetId);
  const near = getNear();
  const info = await getTokenInfo(tokenAddress, false);

  if (!info) {
    return {
      success: false,
      successCount: 0,
      failCount: wallets.length,
      txHashes: [],
      errors: ['Token information could not be retrieved'],
    };
  }

  const venue = info.venue || 'ref';
  const txHashes: string[] = [];
  const errors: string[] = [];

  const executions = await Promise.allSettled(
    wallets.map(async (w) => {
      // 1. Get token balance
      const tokenBalStr = await near.getTokenBalance(tokenAddress, w.account_id);
      const tokenBalBigInt = BigInt(tokenBalStr || '0');
      if (tokenBalBigInt <= 0n) {
        return { txHash: 'skipped (no tokens)', sold: false };
      }

      const clampedSellPct = Math.max(1, Math.min(100, sellPct));
      const amountToSellBigInt = (tokenBalBigInt * BigInt(clampedSellPct)) / 100n;
      if (amountToSellBigInt <= 0n) {
        return { txHash: 'skipped', sold: false };
      }

      const rawPrivateKey = decrypt(w.encrypted_private_key, MASTER_KEY);
      const keyPair = KeyPair.fromString(rawPrivateKey as any);

      return connectWithNearRpcFailover(w.account_id, keyPair, async (account) => {
        const { minAmountOut } = await near.computeMinAmountOut(
          venue as any,
          tokenAddress,
          'wrap.near',
          amountToSellBigInt.toString(),
          slippagePct,
          info.rhea_pool_id ?? undefined,
          info.dcl_pool_id ?? undefined
        );

        let res: any;
        if (info.dcl_pool_id) {
          res = await account.functionCall({
            contractId: tokenAddress,
            methodName: 'ft_transfer_call',
            args: {
              receiver_id: 'dclv2.ref-labs.near',
              amount: amountToSellBigInt.toString(),
              msg: JSON.stringify({
                Swap: {
                  pool_ids: [info.dcl_pool_id],
                  output_token: 'wrap.near',
                  min_output_amount: minAmountOut,
                  swap_out_recipient: w.account_id,
                },
              }),
            },
            gas: BigInt('180000000000000'), // 180 TGas
            attachedDeposit: 1n,
          });
        } else {
          const poolId = info.rhea_pool_id ?? (info as any).pool_id ?? 0;
          res = await account.functionCall({
            contractId: tokenAddress,
            methodName: 'ft_transfer_call',
            args: {
              receiver_id: 'v2.ref-finance.near',
              amount: amountToSellBigInt.toString(),
              msg: JSON.stringify({
                actions: [
                  {
                    pool_id: poolId,
                    token_in: tokenAddress,
                    token_out: 'wrap.near',
                    amount_in: amountToSellBigInt.toString(),
                    min_amount_out: minAmountOut,
                    min_output_amount: minAmountOut,
                  },
                ],
              }),
            },
            gas: BigInt('180000000000000'), // 180 TGas
            attachedDeposit: 1n,
          });
        }

        // Unwrap wrap.near to native NEAR so the wallet holds native NEAR
        await account.functionCall({
          contractId: 'wrap.near',
          methodName: 'near_withdraw',
          args: { amount: minAmountOut },
          gas: BigInt('30000000000000'),
          attachedDeposit: 1n,
        }).catch(() => {});

        const txHash = res?.transaction?.hash || 'confirmed';
        return { txHash, sold: true };
      });
    })
  );

  for (const exec of executions) {
    if (exec.status === 'fulfilled' && exec.value.sold) {
      txHashes.push(exec.value.txHash);
    } else if (exec.status === 'rejected') {
      errors.push(exec.reason?.message || 'Sell error');
    }
  }

  return {
    success: txHashes.length > 0,
    successCount: txHashes.length,
    failCount: errors.length,
    txHashes,
    errors,
  };
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

  return {
    success: true,
    fleetTag: fleet.fleet_tag,
    wallets: exported,
  };
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

  const [balances, info] = await Promise.all([
    getFleetBalances(fleet.id, tokenAddress),
    getTokenInfo(tokenAddress, false),
  ]);

  const shortKey = getShortTokenKey(tokenAddress);
  const sym = info?.symbol || 'TOKEN';
  const priceUsdStr = info?.price_usd ? `$${info.price_usd}` : '';
  const priceNum = typeof info?.price === 'number' ? info.price : parseFloat(String(info?.price || '0'));
  const priceNearStr = priceNum ? `${priceNum.toFixed(6)} NEAR` : '0.00';
  const priceDisplay = priceUsdStr ? `${priceNearStr} (${priceUsdStr})` : priceNearStr;

  const text =
    `🏎 <b>RACEFLEET COCKPIT</b> — $${sym}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🏷 <b>Fleet Tag</b>: <code>${fleet.fleet_tag}</code> (${fleet.wallet_count} Wallets)\n` +
    `💰 <b>Fleet Balance</b>: <b>${balances.totalNearFormatted} NEAR</b> (${balances.totalNearUsd})\n` +
    (balances.tokenTotal && balances.tokenTotal !== '0'
      ? `🎒 <b>Fleet Holdings</b>: <b>${balances.tokenTotalFormatted} ${sym}</b>\n`
      : '') +
    `🪙 <b>Target Token</b>: <code>${tokenAddress}</code>\n` +
    `📍 <b>Price</b>: ${priceDisplay}\n\n` +
    `⚡ <i>Select 1-click execution mode across all ${fleet.wallet_count} wallets:</i>`;

  const keyboard = Markup.inlineKeyboard([
    // Quick-buy amounts per wallet
    [
      Markup.button.callback('⚡ 0.5 N each', `fleet_buy_amt:${shortKey}:0.5`),
      Markup.button.callback('⚡ 1.0 N each', `fleet_buy_amt:${shortKey}:1.0`),
      Markup.button.callback('⚡ 2.0 N each', `fleet_buy_amt:${shortKey}:2.0`),
    ],
    // Custom / Budget split
    [
      Markup.button.callback('✏️ Custom N Each', `fleet_custom_buy:${shortKey}`),
      Markup.button.callback('➗ Split Total Budget', `fleet_split_buy:${shortKey}`),
    ],
    // Pre-attached Protection Snipe
    [
      Markup.button.callback('🎯 Snipe (1 N + 50% TP / 15% SL)', `fleet_snipe_protect:${shortKey}`),
    ],
    // Coordinated Sell Options
    [
      Markup.button.callback('🔴 Sell 25%', `fleet_sell:${shortKey}:25`),
      Markup.button.callback('🔴 Sell 50%', `fleet_sell:${shortKey}:50`),
      Markup.button.callback('🔴 Dump All (100%)', `fleet_sell:${shortKey}:100`),
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

  const balances = await getFleetBalances(fleet.id);
  const isExpired = new Date(fleet.expires_at).getTime() <= Date.now();
  const statusEmoji = isExpired ? '🔴 Expired' : '🟢 Active';
  const expiresAtFormatted = new Date(fleet.expires_at).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  const text =
    `🏎 <b>RACERBOT RACEFLEET</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `Status: ${statusEmoji} (Renews: ${expiresAtFormatted})\n` +
    `Fleet ID: <code>${fleet.fleet_tag}</code>\n` +
    `Active Fleet Size: <b>${fleet.wallet_count} Named Wallets</b>\n` +
    `Total Fleet NEAR: <b>${balances.totalNearFormatted} NEAR</b> (${balances.totalNearUsd})\n` +
    `Average per Wallet: <b>${(balances.totalNear / fleet.wallet_count).toFixed(2)} NEAR</b>\n\n` +
    `<i>All fleet subaccounts are live on NEAR mainnet with independent nonces for parallel execution.</i>`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('📥 Distribute from Main', 'fleet_fund_prompt'),
      Markup.button.callback('📤 Sweep to Main', 'fleet_sweep_prompt'),
    ],
    [
      Markup.button.callback('💳 View All Fleet Wallets', 'fleet_wallets_list'),
      Markup.button.callback('📊 Active Orders', 'fleet_orders_list'),
    ],
    [
      Markup.button.callback('🔄 Renew Subscription (2 NEAR)', 'fleet_renew_prompt'),
      Markup.button.callback('🔑 Export Fleet Keys', 'fleet_export_keys'),
    ],
    [
      Markup.button.callback('🔙 Back to Main Menu', 'menu_home'),
    ],
  ]);

  return { text, keyboard };
}

// ── Telegram UI: RaceFleet Promo / Upgrade Card ─────────────────────────────
export function buildFleetPromoCard(): { text: string; keyboard: any } {
  const text =
    `🏎 <b>Unlock RacerBot RaceFleet</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `Deploy a coordinated fleet of up to <b>20 named RacerBot wallets</b> on NEAR mainnet.\n\n` +
    `⚡ <b>Key Advantages:</b>\n` +
    `• <b>1-Block Bundle Sniping</b>: Bypass per-wallet caps at token launch.\n` +
    `• <b>Coordinated Buys/Sells</b>: Fire 20 swaps in 1 single second.\n` +
    `• <b>Fleet-Wide SL/TP</b>: Protect all 20 wallets with 1 combined trigger.\n` +
    `• <b>Autonomous Volume Maker</b>: Generate organic volume loops.\n` +
    `• <b>1-Click Distribute & Sweep</b>: Effortless fund balance management.\n` +
    `• <b>Named Wallets</b>: Promotes the bot across all NEAR explorers.\n\n` +
    `💰 <b>Subscription</b>: <code>${RACEFLEET_MONTHLY_FEE_NEAR} NEAR / month</code>\n` +
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
      Markup.button.callback('🔙 Back to Main Menu', 'menu_home'),
    ],
  ]);

  return { text, keyboard };
}
