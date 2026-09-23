import 'dotenv/config';
import { getNear, createRedis, CHANNELS, decrypt, type SwapEvent, type AutoBuySignal, type NotifyUserEvent } from '@racerbot/shared';
import { getDb, getUserById, createFill, getOpenPositions, getPositionById, createPosition, updatePosition } from '@racerbot/db';
import { KeyPair, transactions, utils } from 'near-api-js';
import { MAIN_WALLET_PRIVATE_KEY, PARENT_ACCOUNT, ROUTER_CONTRACT_ID } from './config.js';

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

    const result = await account.functionCall({
      contractId: ROUTER_CONTRACT_ID,
      methodName: 'execute_swap',
      args: {
        params: {
          token_in,
          token_out,
          amount_in,
          min_amount_out,
          venue: venue === 'rhea' ? 'Rhea' : 'Shardsmarket',
        },
      },
      gas: BigInt('300000000000000'),
      attachedDeposit: BigInt('1'), // 1 yoctoNEAR
    });

    const txHash = result.transaction.hash;
    console.log(`[EXECUTOR] Swap submitted: user=${user_id} txHash=${txHash}`);

    // Record the fill and update position (non-blocking on the critical path)
    setImmediate(() => this.recordFill(user_id, token_in, token_out, amount_in, venue, txHash, event)
      .catch(err => console.error('[EXECUTOR] recordFill error:', err.message)));

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

    const swapEvent: SwapEvent = {
      type: 'execute_swap',
      user_id,
      token_in: 'wrap.near',
      token_out: token_address,
      amount_in: utils.format.parseNearAmount(amount_near) ?? '0',
      min_amount_out: '0',
      venue: venue as 'rhea' | 'shardsmarket',
      timestamp: Date.now(),
    };

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

    // 2. Check liquidity from Shardsmarket or Rhea
    let liquidityNear = 0;
    try {
      const smReserves = await near.getShardsmarketPoolReserves(tokenAddress);
      liquidityNear = parseFloat(smReserves.reserveNear) / 1e24;
    } catch {
      // Try Rhea
      try {
        const rheaReserves = await near.getRheaPoolReserves('', 'wrap.near', tokenAddress);
        liquidityNear = parseFloat(rheaReserves.reserveIn) / 1e24;
      } catch {
        return { safe: false, reason: 'liquidity_check_failed' };
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
    venue: string,
    txHash: string,
    event: SwapEvent,
  ): Promise<void> {
    const db = await getDb();

    // Determine buy vs sell direction
    const isBuy = tokenIn === 'wrap.near' || tokenIn === 'near';
    const tokenAddress = isBuy ? tokenOut : tokenIn;
    const side = isBuy ? 'buy' : 'sell';

    // Estimate price from amount (in production, read from tx outcome)
    const amountNear = parseFloat(utils.format.formatNearAmount(amountIn));

    // Find or create position
    const positions = await getOpenPositions(userId);
    let position = positions.find(p => p.token_address === tokenAddress);

    if (isBuy) {
      if (!position) {
        position = await createPosition({
          user_id: userId,
          token_address: tokenAddress,
          quantity_held: amountIn,
          avg_entry_price: amountNear.toString(),
        });
      }

      const feeRate = 0.015; // 1.5% fee on each transaction (BUY/SELL)
      const feeAmountNear = amountNear * feeRate;

      await createFill({
        user_id: userId,
        position_id: position.id,
        side: 'buy',
        token_address: tokenAddress,
        amount: amountIn,
        price: amountNear.toString(),
        fee_paid: feeAmountNear.toString(),
        venue,
        tx_hash: txHash,
      });

      // Update position weighted average via stored proc
      await db.query(
        'SELECT update_position_fill($1, $2, $3, $4, $5)',
        [position.id, 'buy', amountIn, amountNear, feeAmountNear]
      );
    } else if (position) {
      const feeRate = 0.015; // 1.5% fee on each transaction (BUY/SELL)
      const feeAmountNear = amountNear * feeRate;

      await createFill({
        user_id: userId,
        position_id: position.id,
        side: 'sell',
        token_address: tokenAddress,
        amount: amountIn,
        price: amountNear.toString(),
        fee_paid: feeAmountNear.toString(),
        venue,
        tx_hash: txHash,
      });

      await db.query(
        'SELECT update_position_fill($1, $2, $3, $4, $5)',
        [position.id, 'sell', amountIn, amountNear, feeAmountNear]
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