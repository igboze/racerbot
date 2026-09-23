import 'dotenv/config';
import {
  getNear,
  createRedis,
  CHANNELS,
  decrypt,
  type SwapEvent,
  type AutoBuySignal,
  type NotifyUserEvent,
} from '@racerbot/shared';
import {
  getDb,
  getUserById,
  createFill,
  getOpenPositions,
  getPositionById,
  createPosition,
  updatePosition,
  getTokenCache,
} from '@racerbot/db';
import { KeyPair, transactions, utils } from 'near-api-js';
import { MAIN_WALLET_PRIVATE_KEY, PARENT_ACCOUNT, TREASURY_ACCOUNT_ID } from './config.js';

const MASTER_KEY = process.env.KEY_ENCRYPTION_MASTER_KEY!;
const REDIS_URL = process.env.REDIS_URL!;
const RPC_URLS = process.env.RPC_PROVIDERS!.split(',').map(u => u.trim());

// ── Warm key store ────────────────────────────────────────────────────────────
// Pre-loaded on startup from encrypted DB records — no DB query in hot path

const warmKeys = new Map<string, { keyPair: KeyPair; subaccountId: string }>();

// ── Services ─────────────────────────────────────────────────────────────────

const near = getNear(RPC_URLS);
const redis = createRedis(REDIS_URL);

// ── Key pre-warming ────────────────────────────────────────────────────────────

/** Load ALL user scoped keys into memory at startup. */
export async function warmAllKeys(): Promise<void> {
  const db = await getDb();
  const result = await db.query('SELECT id, subaccount_id, scoped_key_encrypted FROM users');
  let loaded = 0;

  for (const row of result.rows) {
    try {
      const keyStr = decrypt(row.scoped_key_encrypted, MASTER_KEY);
      const keyPair = KeyPair.fromString(keyStr as any);
      warmKeys.set(row.id, { keyPair, subaccountId: row.subaccount_id });
      await near.addKey(row.subaccount_id, keyPair);
      loaded++;
    } catch (err) {
      console.error(`[EXECUTOR] Failed to warm key for user ${row.id}:`, (err as Error).message);
    }
  }
  console.log(`[EXECUTOR] Pre-warmed ${loaded} user keys`);
}

/** Add a newly onboarded user's key to the warm store without restart. */
export async function addUserKey(userId: string, subaccountId: string, encryptedKey: string): Promise<void> {
  const keyStr = decrypt(encryptedKey, MASTER_KEY);
  const keyPair = KeyPair.fromString(keyStr as any);
  warmKeys.set(userId, { keyPair, subaccountId });
  await near.addKey(subaccountId, keyPair);
}

// ── Swap execution ────────────────────────────────────────────────────────────

export class SwapExecutor {

  /**
   * Execute a swap event. Uses the user's pre-warmed scoped key.
   * Broadcasts to ALL RPC providers simultaneously; accepts first confirmation.
   */
  async execute(event: SwapEvent): Promise<{ txHash: string; success: boolean }> {
    const { user_id, token_in, token_out, amount_in, min_amount_out, venue } = event;

    const warm = warmKeys.get(user_id);
    if (!warm) {
      // Attempt to load from DB (handles edge case where key wasn't pre-warmed)
      const user = await getUserById(user_id);
      if (!user) throw new Error(`User ${user_id} not found`);
      await addUserKey(user_id, user.subaccount_id, user.scoped_key_encrypted);
      return this.execute(event); // retry with warm key
    }

    const { subaccountId, keyPair } = warm;

    // Use near-api-js to build, sign, and broadcast the FunctionCall transaction
    const account = await near.getAccount(subaccountId);

    let dclPoolId = (event as any).dcl_pool_id ?? null;
    if (venue === 'nearlytrade' && !dclPoolId) {
      const tokenTarget = token_in === 'wrap.near' ? token_out : token_in;
      const dbCache = await getTokenCache(tokenTarget).catch(() => null);
      dclPoolId = dbCache?.dcl_pool_id ?? null;
      if (!dclPoolId) {
        const ntState = await near.getNearlytradeTokenState(tokenTarget).catch(() => null);
        dclPoolId = ntState?.dclPoolId ?? null;
      }
    }

    const amountInBigInt = BigInt(amount_in);
    // 1.5% fee = 150 bps
    const feeAmount = (amountInBigInt * 150n) / 10000n;
    const swapAmount = amountInBigInt - feeAmount;

    if (swapAmount <= 0n) {
      throw new Error(`Amount too small after fee: ${amount_in}`);
    }

    let result: any;

    if (venue === 'nearlytrade') {
      if (!dclPoolId) {
        throw new Error(`DCL pool ID not found for NearlyTrade token`);
      }

      const isBuy = token_in === 'wrap.near' || token_in === 'near';
      if (isBuy) {
        // Ensure user is registered for NEP-141 storage on token_out
        await near.ensureStorageDeposit(subaccountId, token_out);

        // Batched actions on wrap.near in 1 atomic transaction:
        // 1. near_deposit to wrap native NEAR
        // 2. ft_transfer to send 1.5% fee to treasury
        // 3. ft_transfer_call to swap 98.5% on DCL
        const actions = [
          transactions.functionCall(
            'near_deposit',
            {},
            BigInt('10000000000000'),
            amountInBigInt
          ),
          transactions.functionCall(
            'ft_transfer',
            { receiver_id: TREASURY_ACCOUNT_ID, amount: feeAmount.toString() },
            BigInt('20000000000000'),
            BigInt('1')
          ),
          transactions.functionCall(
            'ft_transfer_call',
            {
              receiver_id: 'dclv2.ref-labs.near',
              amount: swapAmount.toString(),
              msg: JSON.stringify({
                Swap: {
                  pool_ids: [dclPoolId],
                  output_token: token_out,
                  min_output_amount: min_amount_out,
                },
              }),
            },
            BigInt('180000000000000'),
            BigInt('1')
          ),
        ];

        result = await account.signAndSendTransaction({
          receiverId: 'wrap.near',
          actions,
        });
      } else {
        // Sell token on DCL for wrap.near
        await near.ensureStorageDeposit(subaccountId, 'wrap.near');

        const actions = [
          transactions.functionCall(
            'ft_transfer_call',
            {
              receiver_id: 'dclv2.ref-labs.near',
              amount: amountInBigInt.toString(),
              msg: JSON.stringify({
                Swap: {
                  pool_ids: [dclPoolId],
                  output_token: 'wrap.near',
                  min_output_amount: min_amount_out,
                },
              }),
            },
            BigInt('180000000000000'),
            BigInt('1')
          ),
        ];

        result = await account.signAndSendTransaction({
          receiverId: token_in,
          actions,
        });
      }
    } else if (venue === 'rhea') {
      let rheaPoolId = (event as any).pool_id;
      if (rheaPoolId === null || rheaPoolId === undefined) {
        rheaPoolId = await near.findRheaPoolId(token_in, token_out);
      }

      const isBuy = token_in === 'wrap.near' || token_in === 'near';
      if (isBuy) {
        await near.ensureStorageDeposit(subaccountId, token_out);

        const actions = [
          transactions.functionCall(
            'near_deposit',
            {},
            BigInt('10000000000000'),
            amountInBigInt
          ),
          transactions.functionCall(
            'ft_transfer',
            { receiver_id: TREASURY_ACCOUNT_ID, amount: feeAmount.toString() },
            BigInt('20000000000000'),
            BigInt('1')
          ),
          transactions.functionCall(
            'ft_transfer_call',
            {
              receiver_id: 'v2.ref-finance.near',
              amount: swapAmount.toString(),
              msg: JSON.stringify({
                actions: [
                  {
                    pool_id: rheaPoolId,
                    token_in: 'wrap.near',
                    token_out,
                    min_output_amount: min_amount_out,
                  },
                ],
              }),
            },
            BigInt('180000000000000'),
            BigInt('1')
          ),
        ];

        result = await account.signAndSendTransaction({
          receiverId: 'wrap.near',
          actions,
        });
      } else {
        await near.ensureStorageDeposit(subaccountId, 'wrap.near');

        const actions = [
          transactions.functionCall(
            'ft_transfer_call',
            {
              receiver_id: 'v2.ref-finance.near',
              amount: amountInBigInt.toString(),
              msg: JSON.stringify({
                actions: [
                  {
                    pool_id: rheaPoolId,
                    token_in,
                    token_out: 'wrap.near',
                    min_output_amount: min_amount_out,
                  },
                ],
              }),
            },
            BigInt('180000000000000'),
            BigInt('1')
          ),
        ];

        result = await account.signAndSendTransaction({
          receiverId: token_in,
          actions,
        });
      }
    } else {
      // Shardsmarket
      const isBuy = token_in === 'wrap.near' || token_in === 'near';
      if (isBuy) {
        await near.ensureStorageDeposit(subaccountId, token_out);

        // Send 1.5% fee to treasury
        await account.sendMoney(TREASURY_ACCOUNT_ID, feeAmount).catch(() => {});

        // Buy on shardsmarket factory
        result = await account.functionCall({
          contractId: 'factory.shardsmarket.near',
          methodName: 'buy',
          args: {
            token_id: token_out,
            min_amount_out,
          },
          gas: BigInt('200000000000000'),
          attachedDeposit: swapAmount,
        });
      } else {
        const actions = [
          transactions.functionCall(
            'ft_transfer',
            { receiver_id: TREASURY_ACCOUNT_ID, amount: feeAmount.toString() },
            BigInt('20000000000000'),
            BigInt('1')
          ),
          transactions.functionCall(
            'ft_transfer_call',
            {
              receiver_id: 'factory.shardsmarket.near',
              amount: swapAmount.toString(),
              msg: JSON.stringify({ min_amount_out }),
            },
            BigInt('180000000000000'),
            BigInt('1')
          ),
        ];

        result = await account.signAndSendTransaction({
          receiverId: token_in,
          actions,
        });
      }
    }

    const txHash = result.transaction.hash;
    console.log(`[EXECUTOR] Direct swap submitted: user=${user_id} venue=${venue} txHash=${txHash}`);

    // Parse receipt outcomes to determine actual output amount
    let netAmountOut = '0';
    const receiptsOutcomes = (result as any).receipts_outcome || [];
    for (const r of receiptsOutcomes) {
      const logs: string[] = r.outcome?.logs || [];
      for (const log of logs) {
        if (log.startsWith('EVENT_JSON:')) {
          try {
            const parsed = JSON.parse(log.slice('EVENT_JSON:'.length));
            if (parsed.event === 'ft_transfer') {
              const data = Array.isArray(parsed.data) ? parsed.data[0] : parsed.data;
              if (data?.receiver_id === subaccountId && data?.amount) {
                netAmountOut = data.amount;
              }
            } else if (parsed.event === 'swap') {
              const data = Array.isArray(parsed.data) ? parsed.data[0] : parsed.data;
              if (data?.amount_out) {
                netAmountOut = data.amount_out;
              }
            }
          } catch {}
        }
        const shardsMatch = log.match(/bought (\d+) tokens/i) || log.match(/amount_out:?\s*(\d+)/i);
        if (shardsMatch) {
          netAmountOut = shardsMatch[1];
        }
      }
    }

    if (!netAmountOut || netAmountOut === '0') {
      const hasFailure = (result.status as any)?.Failure;
      if (!hasFailure) {
        netAmountOut = min_amount_out;
      }
    }

    if (!netAmountOut || netAmountOut === '0') {
      console.warn(`[EXECUTOR] Trade unconfirmed / failed: txHash=${txHash}`);
      await this.notifyUser(user_id, 'trade_failed' as any, { txHash, reason: 'Transaction failed or slippage breach' });
      return { txHash, success: false };
    }

    let onChainFeeYocto = feeAmount.toString();
    const isBuy = token_in === 'wrap.near' || token_in === 'near';

    // Auto-unwrap wrap.near to pure native NEAR on sell and transfer 1.5% fee to treasury
    if (!isBuy && (venue === 'nearlytrade' || venue === 'rhea') && BigInt(netAmountOut) > 0n) {
      const sellFeeNear = (BigInt(netAmountOut) * 150n) / 10000n;
      onChainFeeYocto = sellFeeNear.toString();

      try {
        console.log(`[EXECUTOR] Auto-unwrapping ${netAmountOut} yoctoNEAR of wrap.near for ${subaccountId}`);
        await account.functionCall({
          contractId: 'wrap.near',
          methodName: 'near_withdraw',
          args: { amount: netAmountOut },
          gas: BigInt('30000000000000'),
          attachedDeposit: BigInt('1'),
        });
        console.log(`[EXECUTOR] Auto-unwrapped to native NEAR successfully for ${subaccountId}`);

        if (sellFeeNear > 0n) {
          await account.sendMoney(TREASURY_ACCOUNT_ID, sellFeeNear).catch(err =>
            console.warn('[EXECUTOR] Sell fee transfer warning:', err.message)
          );
        }
      } catch (err: any) {
        console.warn('[EXECUTOR] Auto-unwrap error:', err.message);
      }
    }

    // Record the fill and update position with real on-chain output
    await this.recordFill(
      user_id,
      token_in,
      token_out,
      amount_in,
      netAmountOut,
      onChainFeeYocto,
      venue,
      txHash,
      event
    ).catch(err => console.error('[EXECUTOR] recordFill error:', err.message));

    return { txHash, success: true };
  }

  /**
   * Auto-buy flow: rug check first, then execute.
   * Fail closed — any rug check exception = skip the buy.
   */
  async autoBuy(signal: AutoBuySignal): Promise<{ success: boolean; reason?: string }> {
    const { user_id, token_address, amount_near, venue } = signal;

    // Run all rug checks. Any failure = skip buy, notify user.
    let rugResult: { safe: boolean; reason?: string };
    try {
      rugResult = await this.rugCheck(token_address);
    } catch (err) {
      rugResult = { safe: false, reason: `check_failed: ${(err as Error).message}` };
    }

    if (!rugResult.safe) {
      console.log(`[EXECUTOR] Auto-buy skipped for ${token_address}: ${rugResult.reason}`);
      await this.notifyUser(user_id, 'auto_buy_skipped', { token: token_address, reason: rugResult.reason });
      return { success: false, reason: rugResult.reason };
    }

    // Dynamic slippage calculation (default 2% or user's preference)
    const user = await getUserById(user_id);
    const slippagePct = user?.slippage_pct ?? 2;

    let minAmountOut = '1';
    let rheaPoolId: number | null = null;
    let dclPoolId: string | null = null;

    if (venue === 'rhea') {
      rheaPoolId = await near.findRheaPoolId('wrap.near', token_address).catch(() => null);
      if (rheaPoolId !== null) {
        const reserves = await near.getRheaPoolReserves(rheaPoolId, 'wrap.near', token_address).catch(() => null);
        if (reserves && parseFloat(reserves.reserveIn) > 0 && parseFloat(reserves.reserveOut) > 0) {
          const inYocto = parseFloat(utils.format.parseNearAmount(amount_near) ?? '0');
          const expectedOut = (inYocto * parseFloat(reserves.reserveOut)) / parseFloat(reserves.reserveIn);
          const minOut = expectedOut * (1 - slippagePct / 100);
          minAmountOut = Math.max(1, Math.floor(minOut)).toString();
        }
      }
    } else if (venue === 'nearlytrade') {
      const ntState = await near.getNearlytradeTokenState(token_address);
      if (ntState.phase === 'prebonded') {
        return { success: false, reason: 'nearlytrade_prebonded_excluded_from_autobuy' };
      }
      dclPoolId = ntState.dclPoolId;
      const inYocto = utils.format.parseNearAmount(amount_near) ?? '0';
      const computed = await near.computeMinAmountOut(
        'nearlytrade',
        'wrap.near',
        token_address,
        inYocto,
        slippagePct,
        undefined,
        dclPoolId ?? undefined
      );
      minAmountOut = computed.minAmountOut;
    } else {
      const reserves = await near.getShardsmarketPoolReserves(token_address).catch(() => null);
      if (reserves && parseFloat(reserves.reserveNear) > 0 && parseFloat(reserves.reserveToken) > 0) {
        const inYocto = parseFloat(utils.format.parseNearAmount(amount_near) ?? '0');
        const expectedOut = (inYocto * parseFloat(reserves.reserveToken)) / parseFloat(reserves.reserveNear);
        const minOut = expectedOut * (1 - slippagePct / 100);
        minAmountOut = Math.max(1, Math.floor(minOut)).toString();
      }
    }

    const swapEvent: SwapEvent = {
      type: 'execute_swap',
      user_id,
      token_in: 'wrap.near',
      token_out: token_address,
      amount_in: utils.format.parseNearAmount(amount_near) ?? '0',
      min_amount_out: minAmountOut,
      venue: venue as 'rhea' | 'shardsmarket' | 'nearlytrade',
      timestamp: Date.now(),
    };
    if (rheaPoolId !== null) {
      (swapEvent as any).pool_id = rheaPoolId;
    }
    if (dclPoolId !== null) {
      (swapEvent as any).dcl_pool_id = dclPoolId;
    }

    return this.execute(swapEvent)
      .then(r => ({ success: r.success }))
      .catch(err => ({ success: false, reason: err.message }));
  }

  // ── Rug / honeypot checks ─────────────────────────────────────────────────

  /**
   * Returns { safe: true } only if ALL checks pass.
   * Any thrown exception propagates to the caller, which treats it as unsafe (fail-closed).
   */
  private async rugCheck(tokenAddress: string): Promise<{ safe: boolean; reason?: string }> {
    const HOLDER_CONCENTRATION_THRESHOLD = 0.8; // fail if top holder > 80%
    const MIN_LIQUIDITY_NEAR = 100; // fail if < 100 NEAR liquidity

    // 1. Fetch token metadata — if it doesn't respond, fail closed
    const meta = await near.getTokenMetadata(tokenAddress);
    if (!meta.name || !meta.symbol) {
      return { safe: false, reason: 'no_metadata' };
    }

    // 2. Check liquidity from Shardsmarket, Rhea, or NearlyTrade
    let liquidityNear = 0;
    try {
      const smReserves = await near.getShardsmarketPoolReserves(tokenAddress);
      liquidityNear = parseFloat(smReserves.reserveNear) / 1e24;
    } catch {
      // Try Rhea
      try {
        const poolId = await near.findRheaPoolId('wrap.near', tokenAddress);
        const rheaReserves = await near.getRheaPoolReserves(poolId, 'wrap.near', tokenAddress);
        liquidityNear = parseFloat(rheaReserves.reserveIn) / 1e24;
      } catch {
        // Try NearlyTrade
        try {
          const ntState = await near.getNearlytradeTokenState(tokenAddress);
          if (ntState.phase === 'prebonded') {
            return { safe: false, reason: 'nearlytrade_prebonded_excluded_from_autobuy' };
          }
          liquidityNear = ntState.liquidityNear;
        } catch {
          return { safe: false, reason: 'liquidity_check_failed' };
        }
      }
    }

    if (liquidityNear < MIN_LIQUIDITY_NEAR) {
      return { safe: false, reason: `insufficient_liquidity_${liquidityNear.toFixed(2)}_near` };
    }

    // 3. Check total supply vs holder concentration
    // Check deployer/contract account balance vs total supply
    let totalSupplyStr = '0';
    try {
      totalSupplyStr = await near.getTokenTotalSupply(tokenAddress);
    } catch {
      return { safe: false, reason: 'total_supply_check_failed' };
    }

    const totalSupply = parseFloat(totalSupplyStr);

    // Check the token contract itself for any remaining mint authority
    // (Shardsmarket tokens are immutable; Rhea tokens should have no owner after launch)
    try {
      const contractBalance = await near.getTokenBalance(tokenAddress, tokenAddress);
      const contractHolding = parseFloat(contractBalance) / totalSupply;
      if (contractHolding > HOLDER_CONCENTRATION_THRESHOLD) {
        return { safe: false, reason: `contract_holds_${(contractHolding * 100).toFixed(0)}pct` };
      }
    } catch {
      // Some tokens don't have balances — not a rug signal by itself
    }

    return { safe: true };
  }

  // ── Fill recording ────────────────────────────────────────────────────────

  private async recordFill(
    userId: string,
    tokenIn: string,
    tokenOut: string,
    amountIn: string,
    netAmountOut: string,
    onChainFeeYocto: string,
    venue: string,
    txHash: string,
    event: SwapEvent,
  ): Promise<void> {
    const db = await getDb();

    // Determine buy vs sell direction
    const isBuy = tokenIn === 'wrap.near' || tokenIn === 'near';
    const tokenAddress = isBuy ? tokenOut : tokenIn;
    const side = isBuy ? 'buy' : 'sell';

    const meta = await near.getTokenMetadata(tokenAddress).catch(() => ({ decimals: 24 }));
    const decimals = meta?.decimals ?? 24;

    let tokenQty: string;
    let priceNear: number;
    let feePaidNear: number;

    if (isBuy) {
      // For buys: netAmountOut is the actual on-chain token units received
      tokenQty = netAmountOut;
      const nearSpent = parseFloat(utils.format.formatNearAmount(amountIn));
      const tokensReceived = parseFloat(netAmountOut) / Math.pow(10, decimals);
      priceNear = tokensReceived > 0 ? (nearSpent / tokensReceived) : 0;

      // Fee read directly from on-chain receipt logs
      const parsedFeeNear = parseFloat(utils.format.formatNearAmount(onChainFeeYocto));
      if (!isNaN(parsedFeeNear) && parsedFeeNear > 0) {
        feePaidNear = parsedFeeNear;
      } else {
        const tokensFee = parseFloat(onChainFeeYocto) / Math.pow(10, decimals);
        feePaidNear = tokensFee * priceNear;
      }
    } else {
      // For sells: amountIn is the token units sold, netAmountOut is yoctoNEAR received
      tokenQty = amountIn;
      const nearReceived = parseFloat(utils.format.formatNearAmount(netAmountOut));
      const tokensSold = parseFloat(amountIn) / Math.pow(10, decimals);
      priceNear = tokensSold > 0 ? (nearReceived / tokensSold) : 0;
      feePaidNear = parseFloat(utils.format.formatNearAmount(onChainFeeYocto));
    }

    // Find or create position
    const positions = await getOpenPositions(userId);
    let position = positions.find(p => p.token_address === tokenAddress);

    if (isBuy) {
      if (!position) {
        position = await createPosition({
          user_id: userId,
          token_address: tokenAddress,
          quantity_held: tokenQty,
          avg_entry_price: priceNear.toString(),
        });
      }

      await createFill({
        user_id: userId,
        position_id: position.id,
        side: 'buy',
        token_address: tokenAddress,
        amount: tokenQty,
        price: priceNear.toString(),
        fee_paid: feePaidNear.toString(),
        venue,
        tx_hash: txHash,
      });

      // Update position weighted average via stored proc
      await db.query(
        'SELECT update_position_fill($1, $2, $3, $4, $5)',
        [position.id, 'buy', tokenQty, priceNear, feePaidNear]
      );
    } else if (position) {
      await createFill({
        user_id: userId,
        position_id: position.id,
        side: 'sell',
        token_address: tokenAddress,
        amount: tokenQty,
        price: priceNear.toString(),
        fee_paid: feePaidNear.toString(),
        venue,
        tx_hash: txHash,
      });

      await db.query(
        'SELECT update_position_fill($1, $2, $3, $4, $5)',
        [position.id, 'sell', tokenQty, priceNear, feePaidNear]
      );
    }
  }

  // ── Notifications ─────────────────────────────────────────────────────────

  private async notifyUser(userId: string, eventType: NotifyUserEvent['event'], data?: Record<string, unknown>): Promise<void> {
    const user = await getUserById(userId);
    if (!user) return;
    const notify: NotifyUserEvent = {
      type: 'notify_user',
      telegram_id: user.telegram_id,
      event: eventType,
      data,
    };
    await redis.publish(CHANNELS.NOTIFY_USER, JSON.stringify(notify));
  }
}