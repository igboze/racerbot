import {
  createLogger,
  getNear,
  getNearUsdPrice,
  parseMemeCookingId,
  decrypt,
  parseTokenUnits,
} from '@racerbot/shared';
import {
  getDb,
  recordVaultIntent,
  updateVaultIntentStatus,
  getVaultIntentByCorrelationId,
  getUserVaultIntents,
  type UserRecord,
} from '@racerbot/db';
import crypto from 'crypto';
import { KeyPair, transactions } from 'near-api-js';
import { connectWithNearRpcFailover } from './wallet.js';
import { TREASURY_ACCOUNT_ID } from './config.js';

const logger = createLogger('racer-vault');

export const RACER_VAULT_CONTRACT_ID =
  process.env.RACER_VAULT_CONTRACT_ID || process.env.ROUTER_CONTRACT_ID || 'vault.racerbot.near';

// High-performance in-memory cache for resolved vault hop routes (0ms route lookup on repeat trades)
const hopRouteCache = new Map<string, {
  route: {
    venue: VaultVenue;
    hops: VaultHop[];
    tokenIn: string;
    tokenOut: string;
    expectedOut: string;
    minAmountOut: string;
    custom_contract?: string | null;
    custom_msg?: string | null;
  };
  cachedAt: number;
}>();
const HOP_CACHE_TTL_MS = 300_000; // 5 minutes

export type VaultVenue =
  | 'Rhea'
  | 'Nearlytrade'
  | 'Shardsmarket'
  | 'RefAmm'
  | 'Dcl'
  | 'Intear'
  | 'BondingCurve'
  | 'GenericFtCall';

export type AnyLaunchpadVenue =
  | VaultVenue
  | 'rhea'
  | 'ref'
  | 'shardsmarket'
  | 'nearlytrade'
  | 'intear'
  | 'memecooking'
  | 'onetokenhub'
  | 'gaypad'
  | 'nearpad'
  | 'shoremarkets'
  | 'kelytra'
  | 'nearpumpfun'
  | 'qlyphs';

export interface VaultHop {
  pool_id?: number | null;
  dcl_pool_id?: string | null;
  token_in: string;
  token_out: string;
  min_amount_out: string;
}

export interface ShieldedIntentPayload {
  user: string;
  venue: VaultVenue;
  hops: VaultHop[];
  amount_in: string;
  token_in: string;
  token_out: string;
  min_amount_out: string;
  nonce: number[];
  deadline: number;
  correlation_id: string;
  custom_contract?: string | null;
  custom_msg?: string | null;
}

export interface VaultExecutionResult {
  success: boolean;
  routing: 'RACER_SHIELDED_VAULT' | 'AMM';
  txHash?: string;
  correlationId: string;
  tokenIn: string;
  tokenOut: string;
  amountInFormatted: string;
  amountOutFormatted?: string;
  /** Account that signed the trade and receives the output tokens. */
  recipientAccountId?: string;
  /** Contract rejected the intent because another swap of this token is still settling. */
  tokenBusy?: boolean;
  message?: string;
  reason?: string;
}

const TOKEN_BUSY_RETRIES = 3;
const TOKEN_BUSY_RETRY_MS = 2500;

/**
 * Query a user's isolated sub-ledger balance in the Shielded Vault
 */
export async function getVaultBalance(userAccountId: string, token: string = 'near'): Promise<string> {
  const near = getNear();
  try {
    const bal = await near.view<string>(RACER_VAULT_CONTRACT_ID, 'vault_balance', {
      user: userAccountId,
      token,
    });
    return bal || '0';
  } catch (err: any) {
    logger.warn(`Failed reading vault balance for ${userAccountId} on ${token}: ${err.message}`);
    return '0';
  }
}

/**
 * Ensure RACER_VAULT_CONTRACT_ID is registered for NEP-141 storage on tokenAddress.
 * Two-tier registration:
 * 1. Router contract account self-registers using ROUTER_CONTRACT_PRIVATE_KEY.
 * 2. Fallback: payerAccountId (user subaccount) registers RACER_VAULT_CONTRACT_ID.
 */
export async function ensureRouterStorage(
  tokenAddress: string,
  fallbackPayerAccountId?: string
): Promise<boolean> {
  if (!tokenAddress || tokenAddress === 'near') return true;
  const routerId = RACER_VAULT_CONTRACT_ID;
  const near = getNear();

  const isRegistered = await near.checkStorageRegistered(routerId, tokenAddress).catch(() => false);
  if (isRegistered) {
    return true;
  }

  logger.info(`Ensuring storage registration for router ${routerId} on token ${tokenAddress}...`);

  const bounds = await near.view<any>(tokenAddress, 'storage_balance_bounds', {}).catch(() => null);
  const deposit = bounds?.min ? BigInt(bounds.min) : BigInt('1250000000000000000000'); // 0.00125 NEAR

  const routerKey = process.env.ROUTER_CONTRACT_PRIVATE_KEY;
  if (routerKey) {
    try {
      const keyPair = KeyPair.fromString(routerKey as any);
      await near.addKey(routerId, keyPair);
      await near.signAndSendTransactionAll(routerId, tokenAddress, [
        transactions.functionCall(
          'storage_deposit',
          { account_id: routerId, registration_only: true },
          BigInt('30000000000000'),
          deposit
        ),
      ]);
      near.markStorageRegistered(routerId, tokenAddress);
      logger.info(`Router ${routerId} successfully self-registered on ${tokenAddress}`);
      return true;
    } catch (selfErr: any) {
      logger.warn(`Router self-registration on ${tokenAddress} failed: ${selfErr.message}`);
    }
  }

  if (fallbackPayerAccountId) {
    try {
      await near.signAndSendTransactionAll(fallbackPayerAccountId, tokenAddress, [
        transactions.functionCall(
          'storage_deposit',
          { account_id: routerId, registration_only: true },
          BigInt('30000000000000'),
          deposit
        ),
      ]);
      near.markStorageRegistered(routerId, tokenAddress);
      logger.info(`Payer ${fallbackPayerAccountId} successfully registered router ${routerId} on ${tokenAddress}`);
      return true;
    } catch (payerErr: any) {
      logger.warn(`Payer registration of router on ${tokenAddress} failed: ${payerErr.message}`);
    }
  }

  return false;
}

/**
 * Deposit NEAR into a user's isolated vault sub-ledger
 */
export async function depositNearToVault(
  user: UserRecord,
  amountYocto: string
): Promise<{ success: boolean; txHash?: string; reason?: string }> {
  if (!user.subaccount_id) {
    return { success: false, reason: 'No managed subaccount for user' };
  }

  const { decrypt, getNear } = await import('@racerbot/shared');
  const masterKey = process.env.KEY_ENCRYPTION_MASTER_KEY || process.env.ENCRYPTION_MASTER_KEY || process.env.ENCRYPTION_KEY || 'default-master-key';
  const privateKey = decrypt(user.scoped_key_encrypted, masterKey);
  const keyPair = KeyPair.fromString(privateKey as any);

  try {
    const near = getNear();
    await near.addKey(user.subaccount_id, keyPair);
    const { transactions } = await import('near-api-js');
    const res = await near.signAndSendTransactionAll(
      user.subaccount_id,
      RACER_VAULT_CONTRACT_ID,
      [
        transactions.functionCall(
          'deposit_near',
          { user: user.subaccount_id },
          BigInt('30000000000000'), // 30 TGas
          BigInt(amountYocto)
        )
      ]
    );

    const txHash = res?.transaction?.hash || res?.transaction_outcome?.id;
    logger.info(`Deposited ${amountYocto} yoctoNEAR to vault for ${user.subaccount_id}: tx=${txHash}`);
    return { success: true, txHash };
  } catch (err: any) {
    logger.error(`Failed depositNearToVault for ${user.subaccount_id}: ${err.message}`);
    return { success: false, reason: err.message };
  }
}

/**
 * Deposit NEP-141 FT into a user's isolated vault sub-ledger via ft_transfer_call
 */
export async function depositFtToVault(
  user: UserRecord,
  tokenContractId: string,
  amountRaw: string
): Promise<{ success: boolean; txHash?: string; reason?: string }> {
  if (!user.subaccount_id) {
    return { success: false, reason: 'No managed subaccount for user' };
  }

  const { decrypt, getNear } = await import('@racerbot/shared');
  const masterKey = process.env.KEY_ENCRYPTION_MASTER_KEY || process.env.ENCRYPTION_MASTER_KEY || process.env.ENCRYPTION_KEY || 'default-master-key';
  const privateKey = decrypt(user.scoped_key_encrypted, masterKey);
  const keyPair = KeyPair.fromString(privateKey as any);

  try {
    const near = getNear();
    await near.addKey(user.subaccount_id, keyPair);
    // Ensure vault contract is registered with storage deposit on token
    await near.ensureStorageDeposit(RACER_VAULT_CONTRACT_ID, tokenContractId).catch(() => {});

    const { transactions } = await import('near-api-js');
    const res = await near.signAndSendTransactionAll(
      user.subaccount_id,
      tokenContractId,
      [
        transactions.functionCall(
          'ft_transfer_call',
          {
            receiver_id: RACER_VAULT_CONTRACT_ID,
            amount: amountRaw,
            msg: `user:${user.subaccount_id}`,
          },
          BigInt('80000000000000'), // 80 TGas
          1n // 1 yocto required
        )
      ]
    );

    const txHash = res?.transaction?.hash || res?.transaction_outcome?.id;
    logger.info(`Deposited ${amountRaw} FT (${tokenContractId}) to vault for ${user.subaccount_id}: tx=${txHash}`);
    return { success: true, txHash };
  } catch (err: any) {
    logger.error(`Failed depositFtToVault for ${user.subaccount_id} on ${tokenContractId}: ${err.message}`);
    return { success: false, reason: err.message };
  }
}

/**
 * Relayer refunds/withdraws a user's isolated vault sub-ledger balance back to their managed subaccount.
 * Uses the relayer key (owner_id: racerbot.near) calling contract method `withdraw_user`.
 * Non-custodial: contract forces recipient to strictly be `user`!
 */
export async function refundUserFromVault(
  subaccountId: string,
  token: string = 'near'
): Promise<{ success: boolean; txHash?: string; reason?: string }> {
  let relayerAccountId =
    process.env.RELAYER_ACCOUNT_ID ||
    process.env.RACERBOT_PARENT_ACCOUNT ||
    'racerbot.near';
  if (relayerAccountId === RACER_VAULT_CONTRACT_ID || relayerAccountId.includes('router')) {
    relayerAccountId = process.env.RACERBOT_PARENT_ACCOUNT || 'racerbot.near';
  }

  const rawRelayerKey =
    process.env.RELAYER_PRIVATE_KEY ||
    process.env.MAIN_WALLET_PRIVATE_KEY ||
    '';
  const relayerKey = rawRelayerKey.trim();
  if (!relayerKey) {
    return { success: false, reason: 'Relayer private key (racerbot.near) not configured' };
  }

  try {
    const keyPair = KeyPair.fromString(relayerKey as any);
    const res = await connectWithNearRpcFailover(relayerAccountId, keyPair, async (account) => {
      return await account.functionCall({
        contractId: RACER_VAULT_CONTRACT_ID,
        methodName: 'withdraw_user',
        args: { user: subaccountId, token },
        gas: BigInt('60000000000000'), // 60 TGas
        attachedDeposit: 1n, // 1 yocto
      });
    });

    const txHash = res?.transaction?.hash || res?.transaction_outcome?.id;
    logger.info(`Refunded ${token} from vault to ${subaccountId}: tx=${txHash}`);
    return { success: true, txHash };
  } catch (err: any) {
    logger.warn(`Failed refundUserFromVault for ${subaccountId} (${token}): ${err.message}`);
    return { success: false, reason: err.message };
  }
}


/**
 * Plan atomic route for ANY launchpad on NEAR (Ref AMM, Ref DCL, Intear,
 * Shardsmarket, NearPumpFun, MemeCooking, OneTokenHub, Gaypad, ShoreMarkets, NearPad, Qlyphs, Kelytra)
 * Supports native tokens (NEAR / wNEAR) and non-NEAR quote tokens (USDT, USDC, INTEAR).
 */
export async function planVaultHops(params: {
  tokenAddress: string;
  venue: AnyLaunchpadVenue | string;
  side: 'BUY' | 'SELL';
  amountIn: string;
  slippagePct: number;
  poolId?: number | null;
  dclPoolId?: string | null;
}): Promise<{
  venue: VaultVenue;
  hops: VaultHop[];
  tokenIn: string;
  tokenOut: string;
  expectedOut: string;
  minAmountOut: string;
  custom_contract?: string | null;
  custom_msg?: string | null;
}> {
  const isBuy = params.side === 'BUY';
  const WRAP_NEAR = 'wrap.near';
  const vNorm = (params.venue || '').toLowerCase().trim();

  // 0. Cache check for ultra-fast instant resolution (0ms repeat route calculation)
  const cacheKey = `${params.tokenAddress}:${vNorm}:${params.side}:${params.dclPoolId || ''}:${params.poolId ?? ''}`;
  const cached = hopRouteCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < HOP_CACHE_TTL_MS) {
    return cached.route;
  }

  const near = getNear();

  // 1. Shardsmarket Bonding Curve
  if (vNorm === 'shardsmarket') {
    const tokenIn = isBuy ? 'near' : params.tokenAddress;
    const tokenOut = isBuy ? params.tokenAddress : 'near';
    return {
      venue: 'Shardsmarket',
      hops: [{
        token_in: tokenIn,
        token_out: tokenOut,
        min_amount_out: '0',
      }],
      tokenIn,
      tokenOut,
      expectedOut: '0',
      minAmountOut: '0',
    };
  }

  // 2. Intear Launchpad & DEX (dex.intear.near)
  if (vNorm === 'intear') {
    const tokenIn = isBuy ? 'near' : params.tokenAddress;
    const tokenOut = isBuy ? params.tokenAddress : 'near';
    const intearState = await near.getIntearTokenState(params.tokenAddress).catch(() => null);
    const poolId = intearState?.poolId ?? (await near.findIntearPoolId(params.tokenAddress).catch(() => 0)) ?? 0;
    const isPairedWithIntearToken = intearState?.pairedAsset === 'token.intear.near';

    let custom_msg: string | null = null;
    if (isBuy && isPairedWithIntearToken) {
      // 2-hop route: near -> token.intear.near -> token_out
      const intearNearPoolId = (await near.findIntearPoolId('token.intear.near').catch(() => 274)) || 274;
      const buf1 = Buffer.alloc(4);
      buf1.writeUInt32LE(intearNearPoolId, 0);
      const buf2 = Buffer.alloc(4);
      buf2.writeUInt32LE(poolId, 0);

      custom_msg = JSON.stringify({
        referrer: 'dex-aggregator.intear.near',
        operations: [
          {
            SwapSimple: {
              dex_id: 'slimedragon.near/xyk',
              asset_in: 'near',
              asset_out: 'nep141:token.intear.near',
              amount: { Amount: { ExactIn: params.amountIn } },
              constraint: null,
              message: buf1.toString('base64'),
            },
          },
          {
            SwapSimple: {
              dex_id: 'slimedragon.near/xyk',
              asset_in: 'nep141:token.intear.near',
              asset_out: `nep141:${params.tokenAddress}`,
              amount: 'OutputOfLastIn',
              constraint: null,
              message: buf2.toString('base64'),
            },
          },
          {
            Withdraw: {
              asset_id: `nep141:${params.tokenAddress}`,
              amount: { Full: { at_least: null } },
              to: null,
              rescue_address: null,
            },
          },
        ],
      });
    }

    return {
      venue: 'Intear',
      hops: [{
        pool_id: poolId,
        token_in: tokenIn,
        token_out: tokenOut,
        min_amount_out: '0',
      }],
      tokenIn,
      tokenOut,
      expectedOut: '0',
      minAmountOut: '0',
      custom_msg,
    };
  }

  // 3. NearPumpFun
  if (vNorm === 'nearpumpfun') {
    // Check if graduated to Ref AMM
    const rhea = await near.findRheaPoolForToken(params.tokenAddress).catch(() => null);
    if (rhea && typeof rhea.poolId === 'number' && rhea.poolId >= 0) {
      const tokenIn = isBuy ? WRAP_NEAR : params.tokenAddress;
      const tokenOut = isBuy ? params.tokenAddress : WRAP_NEAR;
      return {
        venue: 'RefAmm',
        hops: [{
          pool_id: rhea.poolId,
          token_in: tokenIn,
          token_out: tokenOut,
          min_amount_out: '0',
        }],
        tokenIn,
        tokenOut,
        expectedOut: '0',
        minAmountOut: '0',
      };
    }

    // Pre-bonded on NearPumpFun bonding curve contract
    const tokenIn = isBuy ? 'near' : params.tokenAddress;
    const tokenOut = isBuy ? params.tokenAddress : 'near';
    const deadlineSec = Math.floor(Date.now() / 1000) + 120;
    return {
      venue: 'BondingCurve',
      hops: [{
        token_in: tokenIn,
        token_out: tokenOut,
        min_amount_out: '0',
      }],
      tokenIn,
      tokenOut,
      expectedOut: '0',
      minAmountOut: '0',
      custom_contract: params.tokenAddress,
      custom_msg: JSON.stringify({ min_tokens_out: '0', deadline_sec: deadlineSec }),
    };
  }

  // 4. MemeCooking
  if (vNorm === 'memecooking') {
    const memeId = parseMemeCookingId(params.tokenAddress);
    const rhea = await near.findRheaPoolForToken(params.tokenAddress).catch(() => null);
    if (rhea && typeof rhea.poolId === 'number') {
      const tokenIn = isBuy ? WRAP_NEAR : params.tokenAddress;
      const tokenOut = isBuy ? params.tokenAddress : WRAP_NEAR;
      return {
        venue: 'RefAmm',
        hops: [{
          pool_id: rhea.poolId,
          token_in: tokenIn,
          token_out: tokenOut,
          min_amount_out: '0',
        }],
        tokenIn,
        tokenOut,
        expectedOut: '0',
        minAmountOut: '0',
      };
    }

    if (rhea && rhea.isDcl && rhea.poolId) {
      const tokenIn = isBuy ? WRAP_NEAR : params.tokenAddress;
      const tokenOut = isBuy ? params.tokenAddress : WRAP_NEAR;
      return {
        venue: 'Dcl',
        hops: [{
          dcl_pool_id: String(rhea.poolId),
          token_in: tokenIn,
          token_out: tokenOut,
          min_amount_out: '0',
        }],
        tokenIn,
        tokenOut,
        expectedOut: '0',
        minAmountOut: '0',
      };
    }

    const directDcl = await near.findDclPoolId(WRAP_NEAR, params.tokenAddress).catch(() => null);
    if (directDcl) {
      const tokenIn = isBuy ? WRAP_NEAR : params.tokenAddress;
      const tokenOut = isBuy ? params.tokenAddress : WRAP_NEAR;
      return {
        venue: 'Dcl',
        hops: [{
          dcl_pool_id: directDcl,
          token_in: tokenIn,
          token_out: tokenOut,
          min_amount_out: '0',
        }],
        tokenIn,
        tokenOut,
        expectedOut: '0',
        minAmountOut: '0',
      };
    }

    // Pre-bonded auction on meme-cooking.near
    const tokenIn = isBuy ? WRAP_NEAR : params.tokenAddress;
    const tokenOut = isBuy ? params.tokenAddress : WRAP_NEAR;
    return {
      venue: 'GenericFtCall',
      hops: [{
        token_in: tokenIn,
        token_out: tokenOut,
        min_amount_out: '0',
      }],
      tokenIn,
      tokenOut,
      expectedOut: '0',
      minAmountOut: '0',
      custom_contract: 'meme-cooking.near',
      custom_msg: JSON.stringify({ Deposit: { meme_id: memeId } }),
    };
  }

  // 5. Gaypad, Kelytra
  if (vNorm === 'gaypad' || vNorm === 'kelytra') {
    const rhea = await near.findRheaPoolForToken(params.tokenAddress).catch(() => null);
    if (rhea && typeof rhea.poolId === 'number') {
      const tokenIn = isBuy ? WRAP_NEAR : params.tokenAddress;
      const tokenOut = isBuy ? params.tokenAddress : WRAP_NEAR;
      return {
        venue: 'RefAmm',
        hops: [{
          pool_id: rhea.poolId,
          token_in: tokenIn,
          token_out: tokenOut,
          min_amount_out: '0',
        }],
        tokenIn,
        tokenOut,
        expectedOut: '0',
        minAmountOut: '0',
      };
    }
    if (rhea && rhea.isDcl && rhea.poolId) {
      const tokenIn = isBuy ? WRAP_NEAR : params.tokenAddress;
      const tokenOut = isBuy ? params.tokenAddress : WRAP_NEAR;
      return {
        venue: 'Dcl',
        hops: [{
          dcl_pool_id: String(rhea.poolId),
          token_in: tokenIn,
          token_out: tokenOut,
          min_amount_out: '0',
        }],
        tokenIn,
        tokenOut,
        expectedOut: '0',
        minAmountOut: '0',
      };
    }
    const tokenIn = isBuy ? WRAP_NEAR : params.tokenAddress;
    const tokenOut = isBuy ? params.tokenAddress : WRAP_NEAR;
    const targetReceiver = vNorm === 'gaypad' ? 'gaypad.j1-racing.near' : 'exchange.kelytradevs.near';
    return {
      venue: 'GenericFtCall',
      hops: [{
        token_in: tokenIn,
        token_out: tokenOut,
        min_amount_out: '0',
      }],
      tokenIn,
      tokenOut,
      expectedOut: '0',
      minAmountOut: '0',
      custom_contract: targetReceiver,
      custom_msg: JSON.stringify({ token: params.tokenAddress }),
    };
  }

  // 6. Ref DCL Launchpads: Nearlytrade, OneTokenHub, NEARpad, ShoreMarkets, Qlyphs
  const isDclVenue =
    vNorm === 'nearlytrade' ||
    vNorm === 'onetokenhub' ||
    vNorm === 'nearpad' ||
    vNorm === 'shoremarkets' ||
    vNorm === 'qlyphs' ||
    vNorm === 'dcl';

  if (isDclVenue) {
    let dclPoolId: string | null = params.dclPoolId || null;

    if (!dclPoolId) {
      // Check multi-hop route for non-NEAR quote assets (USDT, USDC)
      const route = await near.planNearlytradeRoute(params.tokenAddress).catch(() => null);
      if (route && route.kind === 'multihop') {
        const tokenIn = isBuy ? WRAP_NEAR : params.tokenAddress;
        const tokenOut = isBuy ? params.tokenAddress : WRAP_NEAR;
        const plan = {
          venue: 'Dcl' as const,
          hops: isBuy ? [
            {
              dcl_pool_id: route.hop1.poolId,
              token_in: WRAP_NEAR,
              token_out: route.quote,
              min_amount_out: '0',
            },
            {
              dcl_pool_id: route.launchPoolId,
              token_in: route.quote,
              token_out: params.tokenAddress,
              min_amount_out: '0',
            },
          ] : [
            {
              dcl_pool_id: route.launchPoolId,
              token_in: params.tokenAddress,
              token_out: route.quote,
              min_amount_out: '0',
            },
            {
              dcl_pool_id: route.hop1.poolId,
              token_in: route.quote,
              token_out: WRAP_NEAR,
              min_amount_out: '0',
            },
          ],
          tokenIn,
          tokenOut,
          expectedOut: '0',
          minAmountOut: '0',
        };
        hopRouteCache.set(cacheKey, { route: plan, cachedAt: Date.now() });
        return plan;
      } else if (route && route.launchPoolId) {
        // Fast path: direct launch pool already resolved by planNearlytradeRoute!
        dclPoolId = route.launchPoolId;
      }
    }

    // Direct DCL pair
    if (!dclPoolId) {
      if (vNorm === 'onetokenhub') {
        const st = await near.getOneTokenHubState(params.tokenAddress).catch(() => null);
        dclPoolId = st?.dclPoolId || null;
      } else if (vNorm === 'shoremarkets') {
        const st = await near.getShoremarketsTokenState(params.tokenAddress).catch(() => null);
        dclPoolId = st?.dclPoolId || null;
      } else if (vNorm === 'nearpad') {
        const st = await near.getNEARpadState(params.tokenAddress).catch(() => null);
        dclPoolId = st?.dclPoolId || null;
      }
    }
    if (!dclPoolId) {
      dclPoolId = await near.findDclPoolId(WRAP_NEAR, params.tokenAddress).catch(() => null);
    }

    const tokenIn = isBuy ? WRAP_NEAR : params.tokenAddress;
    const tokenOut = isBuy ? params.tokenAddress : WRAP_NEAR;
    const plan = {
      venue: 'Dcl' as const,
      hops: [{
        dcl_pool_id: dclPoolId || `${params.tokenAddress}|${WRAP_NEAR}|10000`,
        token_in: tokenIn,
        token_out: tokenOut,
        min_amount_out: '0',
      }],
      tokenIn,
      tokenOut,
      expectedOut: '0',
      minAmountOut: '0',
    };
    hopRouteCache.set(cacheKey, { route: plan, cachedAt: Date.now() });
    return plan;
  }

  // 7. Rhea & Ref AMM v2 (default)
  let dclId: string | null = params.dclPoolId || null;
  let ammPoolId: number | null = typeof params.poolId === 'number' ? params.poolId : null;

  if (!dclId && ammPoolId === null) {
    const rheaPool = await near.findRheaPoolForToken(params.tokenAddress).catch(() => null);
    if (rheaPool && rheaPool.isDcl) {
      dclId = String(rheaPool.poolId);
    } else if (typeof rheaPool?.poolId === 'number') {
      ammPoolId = rheaPool.poolId;
    }
  }

  if (dclId) {
    const tokenIn = isBuy ? WRAP_NEAR : params.tokenAddress;
    const tokenOut = isBuy ? params.tokenAddress : WRAP_NEAR;
    const plan = {
      venue: 'Dcl' as const,
      hops: [{
        dcl_pool_id: dclId,
        token_in: tokenIn,
        token_out: tokenOut,
        min_amount_out: '0',
      }],
      tokenIn,
      tokenOut,
      expectedOut: '0',
      minAmountOut: '0',
    };
    hopRouteCache.set(cacheKey, { route: plan, cachedAt: Date.now() });
    return plan;
  }

  if (ammPoolId === null) {
    ammPoolId = await near.findRheaPoolId(WRAP_NEAR, params.tokenAddress).catch(() => null);
  }

  const tokenIn = isBuy ? WRAP_NEAR : params.tokenAddress;
  const tokenOut = isBuy ? params.tokenAddress : WRAP_NEAR;

  const plan = {
    venue: 'RefAmm' as const,
    hops: [{
      pool_id: ammPoolId ?? 0,
      token_in: tokenIn,
      token_out: tokenOut,
      min_amount_out: '0',
    }],
    tokenIn,
    tokenOut,
    expectedOut: '0',
    minAmountOut: '0',
  };
  hopRouteCache.set(cacheKey, { route: plan, cachedAt: Date.now() });
  return plan;
}

/**
 * Execute a shielded intent via the relayer
 * Non-custodial: funds are deducted from user's isolated vault sub-ledger,
 * executed through AMM/bonding curve, and net tokens are settled to user.
 * Re-credits on any failure or slippage breach.
 */
export async function executeShieldedVaultIntent(params: {
  user: UserRecord;
  tokenAddress: string;
  venue: AnyLaunchpadVenue | string;
  side: 'BUY' | 'SELL';
  amountNear?: number;
  amountTokens?: string;
  slippagePct?: number;
  poolId?: number | null;
  dclPoolId?: string | null;
  tokenDecimals?: number;
}): Promise<VaultExecutionResult> {
  // The router serialises swaps per payout token; retry briefly when another swap is settling
  for (let attempt = 1; ; attempt++) {
    const res = await executeShieldedVaultIntentOnce(params);
    if (!res.tokenBusy || attempt >= TOKEN_BUSY_RETRIES) return res;
    logger.info(`Router busy settling ${params.tokenAddress}; retry ${attempt}/${TOKEN_BUSY_RETRIES - 1}`);
    await new Promise(r => setTimeout(r, TOKEN_BUSY_RETRY_MS));
  }
}

async function executeShieldedVaultIntentOnce(params: Parameters<typeof executeShieldedVaultIntent>[0]): Promise<VaultExecutionResult> {
  const correlationId = `intent_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
  const nonceBytes = crypto.randomBytes(32);
  const nonceArray = Array.from(nonceBytes);
  const deadline = Math.floor(Date.now() / 1000) + 120; // 2 minutes

  const isBuy = params.side === 'BUY';
  const numNear = params.amountNear || 1.0;
  const slippage = params.slippagePct ?? 2.0;

  let rawAmountIn: string;
  if (isBuy) {
    rawAmountIn = (BigInt(Math.floor(numNear * 1e6)) * 1000000000000000000n).toString();
  } else {
    const rawInput = (params.amountTokens || '').trim();
    if (/^\d+$/.test(rawInput)) {
      rawAmountIn = rawInput;
    } else if (rawInput && !isNaN(Number(rawInput))) {
      // Input was passed as a decimal number (e.g. "50.5" tokens) -> parse with token decimals
      let dec = params.tokenDecimals;
      if (!dec || isNaN(dec) || dec <= 0) {
        const near = getNear();
        const meta = await near.getTokenMetadata(params.tokenAddress).catch(() => null);
        dec = meta?.decimals ?? 18;
      }
      rawAmountIn = parseTokenUnits(rawInput, dec).toString();
    } else {
      rawAmountIn = '1000000000000000000';
    }
  }

  const userAccountId = params.user.subaccount_id || params.user.id;
  if (!params.user.scoped_key_encrypted) {
    // Externally connected wallets (Meteor, MyNearWallet, ...) have no server-held key, so the
    // server cannot sign for them; fail clearly instead of with an opaque decrypt error.
    return {
      success: false,
      routing: 'RACER_SHIELDED_VAULT',
      correlationId,
      tokenIn: isBuy ? 'near' : params.tokenAddress,
      tokenOut: isBuy ? params.tokenAddress : 'near',
      amountInFormatted: String(numNear),
      recipientAccountId: userAccountId,
      reason: `Confidential trades run from a RacerBot-managed account, and ${userAccountId} is an external wallet without one. Sign in with Telegram to use your managed account.`,
    };
  }
  const masterKey = process.env.KEY_ENCRYPTION_MASTER_KEY || process.env.ENCRYPTION_MASTER_KEY || process.env.ENCRYPTION_KEY || 'default-master-key';
  const privateKey = decrypt(params.user.scoped_key_encrypted, masterKey);
  const keyPair = KeyPair.fromString(privateKey as any);
  const near = getNear();

  // Concurrent Execution: 1. Plan hops, 2. Check vault ledger balances, 3. Ensure signing key ready in NearClient
  const [planned, [balNear, balWrap]] = await Promise.all([
    planVaultHops({
      tokenAddress: params.tokenAddress,
      venue: params.venue,
      side: params.side,
      amountIn: rawAmountIn,
      slippagePct: slippage,
      poolId: params.poolId,
      dclPoolId: params.dclPoolId,
    }),
    isBuy
      ? Promise.all([getVaultBalance(userAccountId, 'near'), getVaultBalance(userAccountId, 'wrap.near')])
      : Promise.all([getVaultBalance(userAccountId, params.tokenAddress), Promise.resolve('0')]),
    near.addKey(userAccountId, keyPair),
  ]);

  if (planned.venue === 'GenericFtCall' && planned.custom_contract === 'meme-cooking.near') {
    return {
      success: false,
      routing: 'RACER_SHIELDED_VAULT',
      correlationId,
      tokenIn: planned.tokenIn,
      tokenOut: planned.tokenOut,
      amountInFormatted: String(numNear),
      reason: 'Token is in the Meme.Cooking pre-bonding auction phase. Atomic shielded swap requires bonded Ref/DCL pool liquidity.',
    };
  }

  // Shielded router guarantee: Ensure router contract and user subaccount have storage deposit registered
  // on tokenOut (and tokenIn) before executing intent to eliminate "zero_tokens_received" registration errors
  await Promise.all([
    ensureRouterStorage(planned.tokenOut, userAccountId).catch(e =>
      logger.warn(`Router storage registration warning on tokenOut (${planned.tokenOut}): ${e?.message}`)
    ),
    ensureRouterStorage(planned.tokenIn, userAccountId).catch(e =>
      logger.warn(`Router storage registration warning on tokenIn (${planned.tokenIn}): ${e?.message}`)
    ),
    near.ensureStorageDeposit(userAccountId, planned.tokenOut).catch(e =>
      logger.warn(`User storage deposit warning on tokenOut (${planned.tokenOut}): ${e?.message}`)
    ),
    near.ensureStorageDeposit(userAccountId, 'wrap.near').catch(e =>
      logger.warn(`User storage deposit warning on wrap.near: ${e?.message}`)
    ),
  ]);

  const intentPayload: ShieldedIntentPayload = {
    user: userAccountId,
    venue: planned.venue,
    hops: planned.hops,
    amount_in: rawAmountIn,
    token_in: planned.tokenIn,
    token_out: planned.tokenOut,
    min_amount_out: planned.minAmountOut || '0',
    nonce: nonceArray,
    deadline,
    correlation_id: correlationId,
    custom_contract: planned.custom_contract || null,
    custom_msg: planned.custom_msg || null,
  };

  // 2. Pre-check balance in vault.
  // For BUY: If insufficient, we atomically batch [deposit_near, execute_intent] into a single transaction,
  // cutting out the sequential 2nd transaction and eliminating 4+ seconds of latency!
  let autoDepositedToken: string | null = null;
  let neededNearToAttach = 0n;

  if (isBuy) {
    const maxAvailable = BigInt(balNear) >= BigInt(balWrap) ? BigInt(balNear) : BigInt(balWrap);
    if (maxAvailable < BigInt(rawAmountIn)) {
      const needed = BigInt(rawAmountIn) - maxAvailable;
      if (needed > 0n) {
        logger.info(`Auto-funding vault sub-ledger: ${needed} yocto for ${userAccountId} (batched atomically into intent tx)`);
        neededNearToAttach = needed;
        autoDepositedToken = 'near';
      }
    }
  } else if (!isBuy && BigInt(balNear) < BigInt(rawAmountIn)) {
    const needed = (BigInt(rawAmountIn) - BigInt(balNear)).toString();
    logger.info(`Auto-depositing ${needed} FT (${planned.tokenIn}) into vault sub-ledger for ${userAccountId}`);
    const depRes = await depositFtToVault(params.user, planned.tokenIn, needed);
    if (!depRes.success) {
      return {
        success: false,
        routing: 'RACER_SHIELDED_VAULT',
        correlationId,
        tokenIn: planned.tokenIn,
        tokenOut: planned.tokenOut,
        amountInFormatted: String(numNear),
        reason: `Insufficient ${planned.tokenIn} in shielded vault ledger and auto-deposit failed: ${depRes.reason}`,
      };
    }
    autoDepositedToken = planned.tokenIn;
  }

  // 3. Record PENDING intent in DB for team tracking & user history (non-blocking)
  recordVaultIntent({
    correlation_id: correlationId,
    user_id: params.user.id,
    account_id: intentPayload.user,
    venue: planned.venue,
    token_in: planned.tokenIn,
    token_out: planned.tokenOut,
    amount_in: rawAmountIn,
    amount_in_formatted: numNear,
    min_amount_out: planned.minAmountOut || '0',
    fee_bps: 150,
    status: 'PENDING',
    hops: planned.hops,
    nonce: nonceBytes,
    deadline,
  }).catch((dbErr: any) => logger.warn(`Failed recording vault intent to DB: ${dbErr?.message}`));

  // 4. Submit intent using user's scoped subaccount with fast hedged multi-RPC broadcaster
  const actions: any[] = [];
  if (isBuy && neededNearToAttach > 0n) {
    actions.push(
      transactions.functionCall(
        'deposit_near',
        { user: intentPayload.user },
        BigInt('10000000000000'), // 10 TGas
        neededNearToAttach
      )
    );
  }

  actions.push(
    transactions.functionCall(
      'execute_intent',
      { intent: intentPayload },
      BigInt('285000000000000'), // 285 TGas: snapshot → swap → balance check → payout chain (+10 for deposit <= 300 limit)
      0n
    )
  );

  try {
    const res = await near.signAndSendTransactionAll(
      intentPayload.user,
      RACER_VAULT_CONTRACT_ID,
      actions
    );

    const txHash = res?.transaction?.hash || res?.transaction_outcome?.id;
    logger.info(`Vault intent executed on-chain: tx=${txHash}, correlation=${correlationId}`);

    // A reverted transaction comes back as an outcome with status.Failure (not a thrown error)
    const txFailure = res?.status && typeof res.status === 'object' && 'Failure' in res.status
      ? JSON.stringify(res.status.Failure)
      : '';
    const panicMsg = txFailure.match(/Smart contract panicked: ([^"\\]+)/)?.[1];
    if (/Token busy/.test(txFailure)) {
      await updateVaultIntentStatus(correlationId, { status: 'FAILED', tx_hash: txHash, failure_reason: 'token_busy' }).catch(() => {});
      return {
        success: false,
        routing: 'RACER_SHIELDED_VAULT',
        txHash,
        correlationId,
        tokenIn: planned.tokenIn,
        tokenOut: planned.tokenOut,
        amountInFormatted: String(numNear),
        recipientAccountId: intentPayload.user,
        tokenBusy: true,
        reason: 'Another trade of this token is still settling on the router; please retry in a few seconds',
      };
    }

    // Inspect logs for EVENT_JSON to extract status and amounts
    let isSettled = false;
    let isSlippageRefund = false;
    let isPaidOut = false;
    let payoutFailedToken: string | undefined;
    let netOut = '0';
    let failReason: string | undefined;

    const allReceipts = res?.receipts_outcome || [];
    for (const ro of allReceipts) {
      for (const log of ro.outcome?.logs || []) {
        if (log.startsWith('EVENT_JSON:')) {
          try {
            const ev = JSON.parse(log.slice(11));
            if (ev.event === 'swap_settled') {
              isSettled = true;
              netOut = ev.data?.net || '0';
            } else if (ev.event === 'slippage_refund') {
              isSlippageRefund = true;
              failReason = 'Slippage breach: full refund returned to user';
            } else if (ev.event === 'swap_failed') {
              const r = ev.data?.reason || 'Venue swap failed';
              failReason = r === 'zero_tokens_received'
                ? 'zero_tokens_received (0 tokens received from venue - liquidity temporarily unavailable or slippage limit exceeded; refunded to vault)'
                : r;
            } else if (ev.event === 'ref_withdraw_failed') {
              failReason = 'Withdrawal from venue failed; credited to vault ledger';
            } else if (ev.event === 'payout_completed') {
              isPaidOut = true;
            } else if (ev.event === 'payout_failed' || ev.event === 'withdraw_failed') {
              payoutFailedToken = ev.data?.token || planned.tokenOut;
              failReason = 'Swap filled but the token transfer to your account failed; tokens were credited to your shielded vault balance';
            }
          } catch (_) {}
        }
      }
    }

    if (!failReason && panicMsg) {
      failReason = `Router rejected the trade: ${panicMsg}`;
    }

    // "swap_settled" only means the venue filled; the trade is done once the payout transfer succeeded
    const delivered = (isSettled || isSlippageRefund) && isPaidOut && !payoutFailedToken;
    const finalStatus = delivered
      ? (isSettled ? 'SETTLED' : 'SLIPPAGE_REFUNDED')
      : payoutFailedToken ? 'PAYOUT_FAILED' : 'FAILED';

    if (payoutFailedToken) {
      // Tokens are safe in the vault ledger; retry delivering them to the user's account
      const retry = await refundUserFromVault(intentPayload.user, payoutFailedToken).catch((e: any): { success: boolean; txHash?: string; reason?: string } => ({ success: false, reason: e?.message }));
      if (retry.success) {
        failReason = `Swap filled; first token transfer failed but redelivery to ${intentPayload.user} was submitted (tx ${retry.txHash})`;
      } else {
        logger.warn(`Payout redelivery failed for ${intentPayload.user} (${payoutFailedToken}): ${retry.reason}`);
      }
    }

    await updateVaultIntentStatus(correlationId, {
      status: finalStatus,
      tx_hash: txHash,
      amount_out: netOut,
      failure_reason: failReason,
    }).catch(() => {});

    if (delivered) {
      const fromVault = isBuy ? BigInt(rawAmountIn) - neededNearToAttach : 0n;
      const vaultNote = fromVault > 0n
        ? ` ${(Number(fromVault / 10n ** 18n) / 1e6).toString()} NEAR was paid from your existing shielded vault balance.`
        : '';
      return {
        success: true,
        routing: 'RACER_SHIELDED_VAULT',
        txHash,
        correlationId,
        tokenIn: planned.tokenIn,
        tokenOut: planned.tokenOut,
        amountInFormatted: String(numNear),
        amountOutFormatted: netOut,
        recipientAccountId: intentPayload.user,
        message: isSettled
          ? `Trade settled via Racer Shielded Intent Vault. Tokens delivered to ${intentPayload.user}.${vaultNote}`
          : `Price moved past your slippage limit; the ${netOut} tokens received were delivered to ${intentPayload.user} with no fee.${vaultNote}`,
      };
    } else {
      // Input is only refundable when the swap itself did not fill
      if (autoDepositedToken && !payoutFailedToken) {
        logger.info(`Auto-refunding ${autoDepositedToken} to ${intentPayload.user} following execution failure...`);
        await refundUserFromVault(intentPayload.user, autoDepositedToken).catch(rErr =>
          logger.warn(`Auto-refund attempt failed: ${rErr?.message}`)
        );
      }

      return {
        success: false,
        routing: 'RACER_SHIELDED_VAULT',
        txHash,
        correlationId,
        tokenIn: planned.tokenIn,
        tokenOut: planned.tokenOut,
        amountInFormatted: String(numNear),
        recipientAccountId: intentPayload.user,
        reason: failReason || 'Shielded vault execution reverted or refunded',
      };
    }
  } catch (err: any) {
    const tokenBusy = /Token busy/.test(err?.message || '');
    logger[tokenBusy ? 'info' : 'error'](`Error executing vault intent for correlation=${correlationId}: ${err.message}`);
    await updateVaultIntentStatus(correlationId, {
      status: 'FAILED',
      failure_reason: err.message,
    }).catch(() => {});

    if (autoDepositedToken && (autoDepositedToken !== 'near' || neededNearToAttach === 0n)) {
      logger.info(`Auto-refunding ${autoDepositedToken} to ${intentPayload.user} following execution error...`);
      await refundUserFromVault(intentPayload.user, autoDepositedToken).catch(rErr =>
        logger.warn(`Auto-refund attempt failed: ${rErr?.message}`)
      );
    }

    return {
      success: false,
      routing: 'RACER_SHIELDED_VAULT',
      correlationId,
      tokenIn: planned.tokenIn,
      tokenOut: planned.tokenOut,
      amountInFormatted: String(numNear),
      recipientAccountId: intentPayload.user,
      tokenBusy,
      reason: tokenBusy
        ? 'Another trade of this token is still settling on the router; please retry in a few seconds'
        : err.message || 'Vault execution failed',
    };
  }
}
