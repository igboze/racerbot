import { createLogger, getNear, getNearUsdPrice, parseMemeCookingId } from '@racerbot/shared';
import {
  getDb,
  recordVaultIntent,
  updateVaultIntentStatus,
  getVaultIntentByCorrelationId,
  getUserVaultIntents,
  type UserRecord,
} from '@racerbot/db';
import crypto from 'crypto';
import { KeyPair } from 'near-api-js';
import { connectWithNearRpcFailover } from './wallet.js';
import { TREASURY_ACCOUNT_ID } from './config.js';

const logger = createLogger('racer-vault');

export const RACER_VAULT_CONTRACT_ID =
  process.env.RACER_VAULT_CONTRACT_ID || process.env.ROUTER_CONTRACT_ID || 'vault.racerbot.near';

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
  message?: string;
  reason?: string;
}

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
 * Deposit NEAR into a user's isolated vault sub-ledger
 */
export async function depositNearToVault(
  user: UserRecord,
  amountYocto: string
): Promise<{ success: boolean; txHash?: string; reason?: string }> {
  if (!user.subaccount_id) {
    return { success: false, reason: 'No managed subaccount for user' };
  }

  const { decrypt } = await import('@racerbot/shared');
  const masterKey = process.env.KEY_ENCRYPTION_MASTER_KEY || process.env.ENCRYPTION_MASTER_KEY || process.env.ENCRYPTION_KEY || 'default-master-key';
  const privateKey = decrypt(user.scoped_key_encrypted, masterKey);
  const keyPair = KeyPair.fromString(privateKey as any);

  try {
    const res = await connectWithNearRpcFailover(user.subaccount_id, keyPair, async (account) => {
      return await account.functionCall({
        contractId: RACER_VAULT_CONTRACT_ID,
        methodName: 'deposit_near',
        args: { user: user.subaccount_id },
        gas: BigInt('30000000000000'), // 30 TGas
        attachedDeposit: BigInt(amountYocto),
      });
    });

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
    // Ensure vault contract is registered with storage deposit on token
    await near.ensureStorageDeposit(RACER_VAULT_CONTRACT_ID, tokenContractId).catch(() => {});

    const res = await connectWithNearRpcFailover(user.subaccount_id, keyPair, async (account) => {
      return await account.functionCall({
        contractId: tokenContractId,
        methodName: 'ft_transfer_call',
        args: {
          receiver_id: RACER_VAULT_CONTRACT_ID,
          amount: amountRaw,
          msg: `user:${user.subaccount_id}`,
        },
        gas: BigInt('80000000000000'), // 80 TGas
        attachedDeposit: 1n, // 1 yocto required
      });
    });

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
  const relayerAccountId =
    process.env.RELAYER_ACCOUNT_ID ||
    process.env.RACERBOT_PARENT_ACCOUNT ||
    'racerbot.near';
  const rawRelayerKey =
    process.env.RELAYER_PRIVATE_KEY ||
    process.env.MAIN_WALLET_PRIVATE_KEY ||
    process.env.ROUTER_CONTRACT_PRIVATE_KEY ||
    '';
  const relayerKey = rawRelayerKey.trim();
  if (!relayerKey) {
    return { success: false, reason: 'Relayer private key not configured' };
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
  const near = getNear();
  const isBuy = params.side === 'BUY';
  const WRAP_NEAR = 'wrap.near';
  const vNorm = (params.venue || '').toLowerCase().trim();

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
    // Check multi-hop route for non-NEAR quote assets (USDT, USDC)
    const route = await near.planNearlytradeRoute(params.tokenAddress).catch(() => null);
    if (route && route.kind === 'multihop') {
      const tokenIn = isBuy ? WRAP_NEAR : params.tokenAddress;
      const tokenOut = isBuy ? params.tokenAddress : WRAP_NEAR;
      if (isBuy) {
        return {
          venue: 'Dcl',
          hops: [
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
          ],
          tokenIn,
          tokenOut,
          expectedOut: '0',
          minAmountOut: '0',
        };
      } else {
        return {
          venue: 'Dcl',
          hops: [
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
      }
    }

    // Direct DCL pair
    let dclPoolId: string | null = null;
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
    if (!dclPoolId) {
      dclPoolId = await near.findDclPoolId(WRAP_NEAR, params.tokenAddress).catch(() => null);
    }

    const tokenIn = isBuy ? WRAP_NEAR : params.tokenAddress;
    const tokenOut = isBuy ? params.tokenAddress : WRAP_NEAR;
    return {
      venue: 'Dcl',
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
  }

  // 7. Rhea & Ref AMM v2 (default)
  // Check if token actually lives on DCL
  const rheaPool = await near.findRheaPoolForToken(params.tokenAddress).catch(() => null);
  if (rheaPool && rheaPool.isDcl) {
    const dclId = String(rheaPool.poolId);
    const tokenIn = isBuy ? WRAP_NEAR : params.tokenAddress;
    const tokenOut = isBuy ? params.tokenAddress : WRAP_NEAR;
    return {
      venue: 'Dcl',
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
  }

  const poolId = typeof rheaPool?.poolId === 'number'
    ? rheaPool.poolId
    : (await near.findRheaPoolId(WRAP_NEAR, params.tokenAddress).catch(() => null));

  const tokenIn = isBuy ? WRAP_NEAR : params.tokenAddress;
  const tokenOut = isBuy ? params.tokenAddress : WRAP_NEAR;

  return {
    venue: 'RefAmm',
    hops: [{
      pool_id: poolId ?? 0,
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
}): Promise<VaultExecutionResult> {
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
      const { parseTokenUnits, getNear } = await import('@racerbot/shared');
      const near = getNear();
      const meta = await near.getTokenMetadata(params.tokenAddress).catch(() => null);
      const dec = meta?.decimals ?? 18;
      rawAmountIn = parseTokenUnits(rawInput, dec).toString();
    } else {
      rawAmountIn = '1000000000000000000';
    }
  }

  // 1. Plan hops (handles all launchpads, multi-hop, non-NEAR quotes, bonding curves)
  const planned = await planVaultHops({
    tokenAddress: params.tokenAddress,
    venue: params.venue,
    side: params.side,
    amountIn: rawAmountIn,
    slippagePct: slippage,
  });

  const intentPayload: ShieldedIntentPayload = {
    user: params.user.subaccount_id || params.user.id,
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

  // 2. Pre-check balance in vault. If insufficient, auto-deposit from user managed account
  let autoDepositedToken: string | null = null;
  let currentBal = await getVaultBalance(intentPayload.user, intentPayload.token_in);
  if (BigInt(currentBal) < BigInt(rawAmountIn) && isBuy) {
    const altToken = intentPayload.token_in === 'wrap.near' ? 'near' : 'wrap.near';
    const altBal = await getVaultBalance(intentPayload.user, altToken);
    if (BigInt(altBal) >= BigInt(rawAmountIn)) {
      currentBal = altBal;
    } else {
      const needed = (BigInt(rawAmountIn) - BigInt(currentBal)).toString();
      logger.info(`Auto-funding vault sub-ledger: ${needed} yocto for ${intentPayload.user}`);
      const depRes = await depositNearToVault(params.user, needed);
      if (!depRes.success) {
        return {
          success: false,
          routing: 'RACER_SHIELDED_VAULT',
          correlationId,
          tokenIn: planned.tokenIn,
          tokenOut: planned.tokenOut,
          amountInFormatted: String(numNear),
          reason: `Insufficient vault balance and auto-deposit failed: ${depRes.reason}`,
        };
      }
      autoDepositedToken = 'near';
    }
  } else if (BigInt(currentBal) < BigInt(rawAmountIn) && !isBuy) {
    const needed = (BigInt(rawAmountIn) - BigInt(currentBal)).toString();
    logger.info(`Auto-depositing ${needed} FT (${planned.tokenIn}) into vault sub-ledger for ${intentPayload.user}`);
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

  // 3. Record PENDING intent in DB for team tracking & user history
  await recordVaultIntent({
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

  // 4. Submit intent using relayer account (pays gas on behalf of user)
  // Contract requires predecessor == self.owner_id ('racerbot.near') or predecessor == intent.user
  const relayerAccountId =
    process.env.RELAYER_ACCOUNT_ID ||
    process.env.RACERBOT_PARENT_ACCOUNT ||
    'racerbot.near';
  const rawRelayerKey =
    process.env.RELAYER_PRIVATE_KEY ||
    process.env.MAIN_WALLET_PRIVATE_KEY ||
    process.env.ROUTER_CONTRACT_PRIVATE_KEY ||
    '';
  const relayerKey = rawRelayerKey.trim();

  if (!relayerKey) {
    logger.warn('Relayer private key not set. Using user subaccount key as authorized direct fallback.');
  }

  try {
    const keyPair = relayerKey
      ? KeyPair.fromString(relayerKey as any)
      : KeyPair.fromString(
          (await import('@racerbot/shared')).decrypt(
            params.user.scoped_key_encrypted,
            process.env.KEY_ENCRYPTION_MASTER_KEY || process.env.ENCRYPTION_MASTER_KEY || 'default-master-key'
          ) as any
        );
    const callerId = relayerKey ? relayerAccountId : intentPayload.user;

    const res = await connectWithNearRpcFailover(callerId, keyPair, async (account) => {
      return await account.functionCall({
        contractId: RACER_VAULT_CONTRACT_ID,
        methodName: 'execute_intent',
        args: { intent: intentPayload },
        gas: BigInt('280000000000000'), // 280 TGas for multi-hop + callbacks
        attachedDeposit: 0n,
      });
    });

    const txHash = res?.transaction?.hash || res?.transaction_outcome?.id;
    logger.info(`Vault intent submitted on-chain: tx=${txHash}, correlation=${correlationId}`);

    // Inspect logs for EVENT_JSON to extract status and amounts
    let isSettled = false;
    let isSlippageRefund = false;
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
              failReason = ev.data?.reason || 'Venue swap failed';
            } else if (ev.event === 'ref_withdraw_failed') {
              failReason = 'Withdrawal from venue failed; credited to vault ledger';
            } else if (ev.event === 'withdraw_failed') {
              failReason = 'Withdrawal to user wallet failed; credited back to vault ledger';
            }
          } catch (_) {}
        }
      }
    }

    const finalStatus = isSettled ? 'SETTLED' : isSlippageRefund ? 'SLIPPAGE_REFUNDED' : 'FAILED';

    await updateVaultIntentStatus(correlationId, {
      status: finalStatus,
      tx_hash: txHash,
      amount_out: netOut,
      failure_reason: failReason,
    }).catch(() => {});

    if (isSettled) {
      return {
        success: true,
        routing: 'RACER_SHIELDED_VAULT',
        txHash,
        correlationId,
        tokenIn: planned.tokenIn,
        tokenOut: planned.tokenOut,
        amountInFormatted: String(numNear),
        amountOutFormatted: netOut,
        message: `Trade settled via Racer Shielded Intent Vault (Atomic multi-hop). On-chain private execution confirmed.`,
      };
    } else {
      if (autoDepositedToken) {
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
        reason: failReason || 'Shielded vault execution reverted or refunded',
      };
    }
  } catch (err: any) {
    logger.error(`Error executing vault intent for correlation=${correlationId}: ${err.message}`);
    await updateVaultIntentStatus(correlationId, {
      status: 'FAILED',
      failure_reason: err.message,
    }).catch(() => {});

    if (autoDepositedToken) {
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
      reason: err.message || 'Vault execution failed',
    };
  }
}
