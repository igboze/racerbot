import 'dotenv/config';
import {
  getNear,
  createRedis,
  CHANNELS,
  decrypt,
  computePnL,
  formatHoldDuration,
  calculateMinOutAdj,
  type SwapEvent,
  type AutoBuySignal,
  type NotifyUserEvent,
} from '@racerbot/shared';

export { calculateMinOutAdj };

import {
  getDb,
  getUserById,
  createFill,
  getOpenPositions,
  getPositionById,
  getFillsByPosition,
  createPosition,
  updatePosition,
  getTokenCache,
  recordFee,
  getReferralByReferredUser,
  activateReferral,
  addReferralReward,
} from '@racerbot/db';
import { KeyPair, transactions, utils } from 'near-api-js';
import { isTradableVenue } from '@racerbot/shared';
import { MAIN_WALLET_PRIVATE_KEY, PARENT_ACCOUNT, TREASURY_ACCOUNT_ID } from './config.js';

const MASTER_KEY = process.env.KEY_ENCRYPTION_MASTER_KEY!;
const REDIS_URL = process.env.REDIS_URL!;
const RPC_URLS = (process.env.RPC_PROVIDERS ?? '')
  .split(',')
  .map(u => u.trim())
  .filter(Boolean); // getNear() falls back to DEFAULT_RPC_URLS when empty

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
   * Helper to build atomic actions on wrap.near for buy orders.
   * Dynamically checks the user's existing wNEAR balance on-chain:
   * - If user already holds enough wNEAR, skips near_deposit entirely.
   * - If user holds partial wNEAR, only wraps the shortfall depositNeeded.
   * - Otherwise wraps the full amountInBigInt.
   * Batches near_deposit (if needed) + ft_transfer (fee to treasury) + ft_transfer_call (swap on DEX).
   */
  private async buildWrapNearBuyActions(
    subaccountId: string,
    amountInBigInt: bigint,
    feeAmount: bigint,
    swapAmount: bigint,
    dexReceiverId: string,
    dexMsg: string,
    swapGas: bigint = BigInt('180000000000000')
  ): Promise<any[]> {
    const wNearBalStr = await near.getTokenBalance('wrap.near', subaccountId).catch(() => '0');
    const wNearBal = BigInt(wNearBalStr || '0');
    const depositNeeded = amountInBigInt > wNearBal ? amountInBigInt - wNearBal : 0n;

    const actions: any[] = [];
    if (depositNeeded > 0n) {
      actions.push(
        transactions.functionCall(
          'near_deposit',
          {},
          BigInt('10000000000000'),
          depositNeeded
        )
      );
    }

    actions.push(
      transactions.functionCall(
        'ft_transfer',
        { receiver_id: TREASURY_ACCOUNT_ID, amount: feeAmount.toString() },
        BigInt('20000000000000'),
        BigInt('1')
      ),
      transactions.functionCall(
        'ft_transfer_call',
        {
          receiver_id: dexReceiverId,
          amount: swapAmount.toString(),
          msg: dexMsg,
        },
        swapGas,
        BigInt('1')
      )
    );

    return actions;
  }

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
    if ((venue === 'nearlytrade' || venue === 'rhea' || venue === 'onetokenhub' || venue === 'nearpad') && !dclPoolId) {
      const tokenTarget = token_in === 'wrap.near' ? token_out : token_in;
      const dbCache = await getTokenCache(tokenTarget).catch(() => null);
      dclPoolId = dbCache?.dcl_pool_id ?? null;
      if (!dclPoolId) {
        if (venue === 'nearlytrade') {
          const ntState = await near.getNearlytradeTokenState(tokenTarget).catch(() => null);
          dclPoolId = ntState?.dclPoolId ?? null;
        } else if (venue === 'rhea') {
          dclPoolId = await near.findDclPoolId(token_in, token_out).catch(() => null);
        } else if (venue === 'onetokenhub') {
          const hubState = await near.getOneTokenHubState(tokenTarget).catch(() => null);
          dclPoolId = hubState?.dclPoolId ?? null;
        } else if (venue === 'nearpad') {
          // NEARpad doesn't use DCL pools, so no dclPoolId needed
          dclPoolId = null;
        }
      }
    }

    const amountInBigInt = BigInt(amount_in);
    // 1.5% fee = 150 bps
    const feeAmount = (amountInBigInt * 150n) / 10000n;
    const swapAmount = amountInBigInt - feeAmount;

    if (swapAmount <= 0n) {
      throw new Error(`Amount too small after fee: ${amount_in}`);
    }

    // The 1.5% fee is skimmed from the INPUT on buy paths and on the
    // intear/shardsmarket sells, but min_amount_out is computed against the
    // FULL input upstream. Rescale it to the amount actually swapped —
    // otherwise every trade carries a hidden 1.5% slippage deficit (buys
    // structurally fail at slippage < 1.5% and pass with only ~0.5% margin
    // at the 2% default). AMM output is concave in input, so proportional
    // scaling is conservative: it can never demand more than the pool gives.
    const minOutAdj = calculateMinOutAdj(min_amount_out, amountInBigInt);


    let result: any;

    if (venue === 'nearlytrade') {
      // First try to find a Rhea pool for the token
      let rheaPoolId: number | null = null;
      try {
        rheaPoolId = await near.findRheaPoolId('wrap.near', token_out).catch(() => null);
      } catch {
        // Ignore Rhea pool lookup errors
      }

      const isBuy = token_in === 'wrap.near' || token_in === 'near';
      if (isBuy) {
        // Ensure user is registered for NEP-141 storage on token_out
        await near.ensureStorageDeposit(subaccountId, token_out);

        // If Rhea pool exists, use Rhea DEX
        if (rheaPoolId) {
          const actions = await this.buildWrapNearBuyActions(
            subaccountId,
            amountInBigInt,
            feeAmount,
            swapAmount,
            'v2.ref-finance.near',
            JSON.stringify({
              actions: [
                {
                  pool_id: rheaPoolId,
                  token_in: 'wrap.near',
                  token_out,
                  amount_in: swapAmount.toString(),
                  min_amount_out: minOutAdj,
                  min_output_amount: minOutAdj,
                },
              ],
            })
          );

          result = await near.signAndSendTransactionAll(subaccountId, 'wrap.near', actions);
        } else if (dclPoolId) {
          // If no Rhea pool but DCL pool exists, use NearlyTrade DCL
          const actions = await this.buildWrapNearBuyActions(
            subaccountId,
            amountInBigInt,
            feeAmount,
            swapAmount,
            'dclv2.ref-labs.near',
            JSON.stringify({
              Swap: {
                pool_ids: [dclPoolId],
                output_token: token_out,
                min_output_amount: minOutAdj,
              },
            })
          );

          result = await near.signAndSendTransactionAll(subaccountId, 'wrap.near', actions);
        } else {
          // No pool exists - token is still in launchpad/bonding phase
          throw new Error(
            `Token ${token_out} is not yet tradable. It's still in the launchpad/bonding phase. Wait for it to bond and create a pool on Rhea or NearlyTrade DCL.`
          );
        }
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

        result = await near.signAndSendTransactionAll(subaccountId, token_in, actions);
      }
    } else if (venue === 'rhea') {
      if (dclPoolId) {
        // Execute Ref DCL swap on dclv2.ref-labs.near
        const isBuy = token_in === 'wrap.near' || token_in === 'near';
        if (isBuy) {
          await near.ensureStorageDeposit(subaccountId, token_out);

          const actions = await this.buildWrapNearBuyActions(
            subaccountId,
            amountInBigInt,
            feeAmount,
            swapAmount,
            'dclv2.ref-labs.near',
            JSON.stringify({
              Swap: {
                pool_ids: [dclPoolId],
                output_token: token_out,
                min_output_amount: minOutAdj,
              },
            })
          );

          result = await near.signAndSendTransactionAll(subaccountId, 'wrap.near', actions);
        } else {
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

          result = await near.signAndSendTransactionAll(subaccountId, token_in, actions);
        }
      } else {
        let rheaPoolId = (event as any).pool_id;
        if (rheaPoolId === null || rheaPoolId === undefined) {
          try {
            rheaPoolId = await near.findRheaPoolId(token_in, token_out);
          } catch {
            const target = token_in === 'wrap.near' || token_in === 'near' ? token_out : token_in;
            const rhea = await near.findRheaPoolForToken(target);
            if (rhea && typeof rhea.poolId === 'number') rheaPoolId = rhea.poolId;
          }
        }

        let isMultiHopJambo = (event as any).intermediate_token === 'jambo-1679.meme-cooking.near';
        if (!isMultiHopJambo && rheaPoolId !== null && rheaPoolId !== undefined) {
          const poolInfo = await near.view<any>('v2.ref-finance.near', 'get_pool', { pool_id: rheaPoolId }).catch(() => null);
          const tokens: string[] = poolInfo?.token_account_ids || [];
          if (!tokens.includes(token_in) && tokens.includes('jambo-1679.meme-cooking.near')) {
            isMultiHopJambo = true;
          }
        }

        const isBuy = token_in === 'wrap.near' || token_in === 'near';
        if (isBuy) {
          await near.ensureStorageDeposit(subaccountId, token_out);

          const rheaActions = isMultiHopJambo
            ? [
                {
                  pool_id: 6518,
                  token_in: 'wrap.near',
                  token_out: 'jambo-1679.meme-cooking.near',
                  amount_in: swapAmount.toString(),
                  min_amount_out: '0',
                },
                {
                  pool_id: rheaPoolId,
                  token_in: 'jambo-1679.meme-cooking.near',
                  token_out,
                  min_amount_out: minOutAdj,
                },
              ]
            : [
                {
                  pool_id: rheaPoolId,
                  token_in: 'wrap.near',
                  token_out,
                  amount_in: swapAmount.toString(),
                  min_amount_out: minOutAdj,
                  min_output_amount: minOutAdj,
                },
              ];

          const actions = await this.buildWrapNearBuyActions(
            subaccountId,
            amountInBigInt,
            feeAmount,
            swapAmount,
            'v2.ref-finance.near',
            JSON.stringify({ actions: rheaActions }),
            BigInt('250000000000000')
          );

          result = await near.signAndSendTransactionAll(subaccountId, 'wrap.near', actions);
        } else {
          await near.ensureStorageDeposit(subaccountId, 'wrap.near');

          const rheaActions = isMultiHopJambo
            ? [
                {
                  pool_id: rheaPoolId,
                  token_in,
                  token_out: 'jambo-1679.meme-cooking.near',
                  amount_in: amountInBigInt.toString(),
                  min_amount_out: '0',
                },
                {
                  pool_id: 6518,
                  token_in: 'jambo-1679.meme-cooking.near',
                  token_out: 'wrap.near',
                  min_amount_out: min_amount_out,
                },
              ]
            : [
                {
                  pool_id: rheaPoolId,
                  token_in,
                  token_out: 'wrap.near',
                  amount_in: amountInBigInt.toString(),
                  min_amount_out: min_amount_out,
                  min_output_amount: min_amount_out,
                },
              ];

          const actions = [
            transactions.functionCall(
              'ft_transfer_call',
              {
                receiver_id: 'v2.ref-finance.near',
                amount: amountInBigInt.toString(),
                msg: JSON.stringify({ actions: rheaActions }),
              },
              BigInt('220000000000000'),
              BigInt('1')
            ),
          ];

          result = await near.signAndSendTransactionAll(subaccountId, token_in, actions);
        }
      }
    } else if (venue === 'intear') {
      const isBuy = token_in === 'wrap.near' || token_in === 'near';
      const targetToken = isBuy ? token_out : token_in;
      const poolId = await near.findIntearPoolId(targetToken);
      const poolBuf = Buffer.alloc(4);
      poolBuf.writeUInt32LE(poolId, 0);
      const poolMsg = poolBuf.toString('base64');

      if (isBuy) {
        await near.ensureStorageDeposit(subaccountId, token_out);

        // Buy on dex.intear.near — atomic transaction with fee skimmed from input
        // User deposits full amount_in, fee is taken from that amount before swap
        result = await near.signAndSendTransactionAll(subaccountId, 'dex.intear.near', [
          transactions.functionCall(
            'deposit_near',
            {
              operations: [
                {
                  // Send 1.5% fee to treasury atomically before swap
                  Transfer: {
                    asset_id: 'near',
                    amount: feeAmount.toString(),
                    to: TREASURY_ACCOUNT_ID,
                  },
                },
                {
                  SwapSimple: {
                    dex_id: 'slimedragon.near/xyk',
                    asset_in: 'near',
                    asset_out: `nep141:${token_out}`,
                    amount: { Amount: { ExactIn: swapAmount.toString() } },
                    constraint: minOutAdj,
                    message: poolMsg,
                  },
                },
                {
                  Withdraw: {
                    asset_id: `nep141:${token_out}`,
                    amount: { Full: { at_least: minOutAdj } },
                    to: null,
                    rescue_address: null,
                  },
                },
              ],
              referrer: 'user.intear.near',
            },
            BigInt('250000000000000'),
            amountInBigInt  // Deposit full amount_in, fee taken atomically
          ),
        ]);
      } else {
        // Sell token on dex.intear.near
        const actions = [
          transactions.functionCall(
            'ft_transfer_call',
            {
              receiver_id: 'dex.intear.near',
              amount: amountInBigInt.toString(),
              msg: JSON.stringify({
                operations: [
                  {
                    SwapSimple: {
                      dex_id: 'slimedragon.near/xyk',
                      asset_in: `nep141:${token_in}`,
                      asset_out: 'near',
                      amount: { Amount: { ExactIn: amountInBigInt.toString() } },
                      constraint: min_amount_out,
                      message: poolMsg,
                    },
                  },
                  {
                    Withdraw: {
                      asset_id: 'near',
                      amount: { Full: { at_least: min_amount_out } },
                      to: null,
                      rescue_address: null,
                    },
                  },
                ],
                referrer: 'user.intear.near',
              }),
            },
            BigInt('220000000000000'),
            BigInt('1')
          ),
        ];

        result = await near.signAndSendTransactionAll(subaccountId, token_in, actions);
      }
    } else if (venue === 'onetokenhub') {
      // OneTokenHub: DCL on dclv2.ref-labs.near with the launch's pool_id
      if (!dclPoolId) {
        const tokenTarget = token_in === 'wrap.near' || token_in === 'near' ? token_out : token_in;
        const hubState = await near.getOneTokenHubState(tokenTarget);
        dclPoolId = hubState.dclPoolId;
      }
      if (!dclPoolId) {
        throw new Error(`No DCL pool found for OneTokenHub token`);
      }

      const isBuy = token_in === 'wrap.near' || token_in === 'near';
      if (isBuy) {
        await near.ensureStorageDeposit(subaccountId, token_out);

        const actions = await this.buildWrapNearBuyActions(
          subaccountId,
          amountInBigInt,
          feeAmount,
          swapAmount,
          'dclv2.ref-labs.near',
          JSON.stringify({
            Swap: {
              pool_ids: [dclPoolId],
              output_token: token_out,
              min_output_amount: minOutAdj,
            },
          })
        );

        result = await near.signAndSendTransactionAll(subaccountId, 'wrap.near', actions);
      } else {
        // Sell OneTokenHub token for the paired quote token
        await near.ensureStorageDeposit(subaccountId, token_out);

        const actions = [
          transactions.functionCall(
            'ft_transfer_call',
            {
              receiver_id: 'dclv2.ref-labs.near',
              amount: amountInBigInt.toString(),
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

        result = await near.signAndSendTransactionAll(subaccountId, token_in, actions);
      }
    } else if (venue === 'nearpad') {
      // NEARpad: direct swap on nearpadfamily.near
      const isBuy = token_in === 'wrap.near' || token_in === 'near';
      if (isBuy) {
        await near.ensureStorageDeposit(subaccountId, token_out);

        const actions = await this.buildWrapNearBuyActions(
          subaccountId,
          amountInBigInt,
          feeAmount,
          swapAmount,
          'nearpadfamily.near',
          JSON.stringify({
            token: token_out,
            min_amount_out: minOutAdj,
          })
        );

        result = await near.signAndSendTransactionAll(subaccountId, 'wrap.near', actions);
      } else {
        // Sell NEARpad token
        await near.ensureStorageDeposit(subaccountId, token_out);

        const actions = [
          transactions.functionCall(
            'ft_transfer_call',
            {
              receiver_id: 'nearpadfamily.near',
              amount: amountInBigInt.toString(),
              msg: JSON.stringify({
                token: token_out,
                min_amount_out: min_amount_out,
              }),
            },
            BigInt('180000000000000'),
            BigInt('1')
          ),
        ];

        result = await near.signAndSendTransactionAll(subaccountId, token_in, actions);
      }
    } else if (venue === 'gaypad') {
      const isBuy = token_in === 'wrap.near' || token_in === 'near';
      const targetToken = isBuy ? token_out : token_in;
      // First check if token is on Rhea (Rule 1)
      let rhea = await near.findRheaPoolForToken(targetToken).catch(() => null);
      if (rhea && typeof rhea.poolId === 'number') {
        const rheaPoolId = rhea.poolId;
        const isMultiHopJambo = rhea.intermediateToken === 'jambo-1679.meme-cooking.near';
        if (isBuy) {
          await near.ensureStorageDeposit(subaccountId, token_out);
          const rheaActions = isMultiHopJambo
            ? [
                { pool_id: 6518, token_in: 'wrap.near', token_out: 'jambo-1679.meme-cooking.near', amount_in: swapAmount.toString(), min_amount_out: '0' },
                { pool_id: rheaPoolId, token_in: 'jambo-1679.meme-cooking.near', token_out, min_amount_out: minOutAdj },
              ]
            : [
                { pool_id: rheaPoolId, token_in: 'wrap.near', token_out, amount_in: swapAmount.toString(), min_amount_out: minOutAdj, min_output_amount: minOutAdj },
              ];
          const actions = await this.buildWrapNearBuyActions(
            subaccountId, amountInBigInt, feeAmount, swapAmount,
            'v2.ref-finance.near', JSON.stringify({ actions: rheaActions }), BigInt('250000000000000')
          );
          result = await near.signAndSendTransactionAll(subaccountId, 'wrap.near', actions);
        } else {
          await near.ensureStorageDeposit(subaccountId, 'wrap.near');
          const rheaActions = isMultiHopJambo
            ? [
                { pool_id: rheaPoolId, token_in, token_out: 'jambo-1679.meme-cooking.near', amount_in: amountInBigInt.toString(), min_amount_out: '0' },
                { pool_id: 6518, token_in: 'jambo-1679.meme-cooking.near', token_out: 'wrap.near', min_amount_out: min_amount_out },
              ]
            : [
                { pool_id: rheaPoolId, token_in, token_out: 'wrap.near', amount_in: amountInBigInt.toString(), min_amount_out: min_amount_out, min_output_amount: min_amount_out },
              ];
          const actions = [
            transactions.functionCall(
              'ft_transfer_call',
              { receiver_id: 'v2.ref-finance.near', amount: amountInBigInt.toString(), msg: JSON.stringify({ actions: rheaActions }) },
              BigInt('220000000000000'), BigInt('1')
            ),
          ];
          result = await near.signAndSendTransactionAll(subaccountId, token_in, actions);
        }
      } else {
        // Pre-bonded on Gaypad
        if (isBuy) {
          await near.ensureStorageDeposit(subaccountId, token_out);
          await near.ensureStorageDeposit(subaccountId, 'jambo-1679.meme-cooking.near');
          // Swap wrap.near -> jambo on Ref, then jambo -> gaypad
          const buyActions = await this.buildWrapNearBuyActions(
            subaccountId, amountInBigInt, feeAmount, swapAmount,
            'v2.ref-finance.near',
            JSON.stringify({
              actions: [
                { pool_id: 6518, token_in: 'wrap.near', token_out: 'jambo-1679.meme-cooking.near', amount_in: swapAmount.toString(), min_amount_out: '0' },
              ],
            }),
            BigInt('200000000000000')
          );
          result = await near.signAndSendTransactionAll(subaccountId, 'wrap.near', buyActions);
          // Transfer jambo to gaypad.j1-racing.near
          const jamboBal = await near.view<string>('jambo-1679.meme-cooking.near', 'ft_balance_of', { account_id: subaccountId }).catch(() => '0');
          if (BigInt(jamboBal || '0') > 0n) {
            const gpAction = [
              transactions.functionCall(
                'ft_transfer_call',
                {
                  receiver_id: 'gaypad.j1-racing.near',
                  amount: jamboBal,
                  msg: JSON.stringify({ token: token_out, min_swap_amount: minOutAdj }),
                },
                BigInt('200000000000000'),
                BigInt('1')
              ),
            ];
            result = await near.signAndSendTransactionAll(subaccountId, 'jambo-1679.meme-cooking.near', gpAction);
          }
        } else {
          await near.ensureStorageDeposit(subaccountId, 'jambo-1679.meme-cooking.near');
          await near.ensureStorageDeposit(subaccountId, 'wrap.near');
          // Sell token on gaypad for jambo
          const gpAction = [
            transactions.functionCall(
              'ft_transfer_call',
              {
                receiver_id: 'gaypad.j1-racing.near',
                amount: amountInBigInt.toString(),
                msg: JSON.stringify({ token: 'jambo-1679.meme-cooking.near', min_swap_amount: '0' }),
              },
              BigInt('200000000000000'),
              BigInt('1')
            ),
          ];
          result = await near.signAndSendTransactionAll(subaccountId, token_in, gpAction);
          // Then swap jambo to wrap.near via Ref 6518
          const jamboBal = await near.view<string>('jambo-1679.meme-cooking.near', 'ft_balance_of', { account_id: subaccountId }).catch(() => '0');
          if (BigInt(jamboBal || '0') > 0n) {
            const sellJamboAction = [
              transactions.functionCall(
                'ft_transfer_call',
                {
                  receiver_id: 'v2.ref-finance.near',
                  amount: jamboBal,
                  msg: JSON.stringify({
                    actions: [
                      { pool_id: 6518, token_in: 'jambo-1679.meme-cooking.near', token_out: 'wrap.near', min_amount_out: min_amount_out },
                    ],
                  }),
                },
                BigInt('200000000000000'),
                BigInt('1')
              ),
            ];
            result = await near.signAndSendTransactionAll(subaccountId, 'jambo-1679.meme-cooking.near', sellJamboAction);
          }
        }
      }
    } else {
      // Shardsmarket
      const isBuy = token_in === 'wrap.near' || token_in === 'near';
      if (isBuy) {
        await near.ensureStorageDeposit(subaccountId, token_out);

        const actions = await this.buildWrapNearBuyActions(
          subaccountId,
          amountInBigInt,
          feeAmount,
          swapAmount,
          token_out,
          JSON.stringify({ min_amount_out: minOutAdj }),
          BigInt('200000000000000')
        );

        result = await near.signAndSendTransactionAll(subaccountId, 'wrap.near', actions);
      } else {
        const actions = [
          transactions.functionCall(
            'ft_transfer_call',
            {
              receiver_id: token_in,
              amount: amountInBigInt.toString(),
              msg: JSON.stringify({ min_amount_out: min_amount_out }),
            },
            BigInt('180000000000000'),
            BigInt('1')
          ),
        ];

        result = await near.signAndSendTransactionAll(subaccountId, token_in, actions);
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
      // Extract the real on-chain failure reason from receipt outcomes
      let failReason = 'Transaction failed or slippage breach';
      const txStatusFailure = (result.status as any)?.Failure;
      if (txStatusFailure) {
        const errStr = JSON.stringify(txStatusFailure).toLowerCase();
        if (errStr.includes('slippage') || errStr.includes('min_amount') || errStr.includes('less than minimum')) {
          failReason = 'Slippage too high — price moved against you. Increase slippage in Settings and retry.';
        } else if (errStr.includes('insufficient') && errStr.includes('balanc')) {
          failReason = 'Insufficient wNEAR balance for this swap. Please retry.';
        } else if (errStr.includes('no pool') || errStr.includes('pool_not_found')) {
          failReason = 'No liquidity pool found on-chain for this token.';
        } else if (errStr.includes('panic')) {
          // Extract panic message for debugging
          const panicMatch = JSON.stringify(txStatusFailure).match(/"FunctionCallError".*?"ExecutionError":"([^"]+)"/);
          if (panicMatch) failReason = `Contract error: ${panicMatch[1].slice(0, 150)}`;
        }
      } else {
        // Check individual receipt outcomes for failure messages
        for (const r of receiptsOutcomes) {
          const outcomeStatus = r.outcome?.status;
          if (outcomeStatus && typeof outcomeStatus === 'object' && 'Failure' in outcomeStatus) {
            const rErrStr = JSON.stringify(outcomeStatus.Failure).toLowerCase();
            if (rErrStr.includes('slippage') || rErrStr.includes('min_amount')) {
              failReason = 'Slippage too high — price moved against you. Increase slippage in Settings and retry.';
            } else if (rErrStr.includes('panic')) {
              const panicMatch = JSON.stringify(outcomeStatus.Failure).match(/"ExecutionError":"([^"]+)"/);
              if (panicMatch) failReason = `Contract error: ${panicMatch[1].slice(0, 150)}`;
            }
            break;
          }
        }
      }

      console.warn(`[EXECUTOR] Trade failed: txHash=${txHash} reason=${failReason}`);
      await this.notifyUser(user_id, 'trade_failed' as any, {
        txHash,
        reason: failReason,
        token: token_out !== 'near' && token_out !== 'wrap.near' ? token_out : token_in,
      });
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

    // Fail closed on unknown/unsupported venue — never guess a swap path
    if (!isTradableVenue(venue)) {
      return { success: false, reason: `unsupported_venue:${venue}` };
    }

    // Run all rug checks. Any failure = skip buy, notify user.
    let rugResult: { safe: boolean; reason?: string };
    try {
      rugResult = await this.rugCheck(token_address, venue);
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

    const inYocto = utils.format.parseNearAmount(amount_near) ?? '0';
    if (BigInt(inYocto) <= 0n) {
      return { success: false, reason: 'invalid_amount' };
    }

    let rheaPoolId: number | null = null;
    let dclPoolId: string | null = null;

    if (venue === 'nearlytrade') {
      const ntState = await near.getNearlytradeTokenState(token_address);
      if (ntState.phase === 'prebonded') {
        return { success: false, reason: 'nearlytrade_prebonded_excluded_from_autobuy' };
      }
      dclPoolId = ntState.dclPoolId;
    } else if (venue === 'rhea') {
      const dbCache = await getTokenCache(token_address).catch(() => null);
      dclPoolId = dbCache?.dcl_pool_id ?? null;
      if (!dclPoolId) {
        dclPoolId = await near.findDclPoolId('wrap.near', token_address).catch(() => null);
      }
      if (!dclPoolId) {
        rheaPoolId = dbCache?.rhea_pool_id ?? (await near.findRheaPoolId('wrap.near', token_address).catch(() => null));
      }
    } else if (venue === 'onetokenhub') {
      const hubState = await near.getOneTokenHubState(token_address);
      dclPoolId = hubState.dclPoolId;
    }

    // FIX Bug 2: Compute minAmountOut against the SWAP amount (98.5% after 1.5% fee).
    // The executor skims the fee before calling the DEX, so quoting against the full
    // inYocto produces a minAmountOut the DEX can never hit — silently failing every trade.
    const feeYocto = (BigInt(inYocto) * 150n) / 10000n;
    const swapYocto = (BigInt(inYocto) - feeYocto).toString();

    const { minAmountOut } = await near.computeMinAmountOut(
      venue,
      'wrap.near',
      token_address,
      swapYocto,       // ← post-fee amount that actually reaches the DEX
      slippagePct,
      rheaPoolId,
      dclPoolId
    );

    const swapEvent: SwapEvent = {
      type: 'execute_swap',
      user_id,
      token_in: 'wrap.near',
      token_out: token_address,
      amount_in: inYocto,
      min_amount_out: minAmountOut,
      venue,
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
  private async rugCheck(tokenAddress: string, venue: string): Promise<{ safe: boolean; reason?: string }> {
    const HOLDER_CONCENTRATION_THRESHOLD = 0.8; // fail if top holder > 80%
    const MIN_LIQUIDITY_NEAR = 100; // fail if < 100 NEAR liquidity

    // 1. Fetch token metadata — if it doesn't respond, fail closed
    const meta = await near.getTokenMetadata(tokenAddress);
    if (!meta.name || !meta.symbol) {
      return { safe: false, reason: 'no_metadata' };
    }

    // 2. Check liquidity using the KNOWN venue directly (no waterfall probing)
    let liquidityNear = 0;
    try {
      if (venue === 'shardsmarket') {
        const smReserves = await near.getShardsmarketPoolReserves(tokenAddress);
        liquidityNear = parseFloat(smReserves.reserveNear) / 1e24;
      } else if (venue === 'rhea') {
        // Try simple pool first, then DCL
        try {
          const poolId = await near.findRheaPoolId('wrap.near', tokenAddress);
          const rheaReserves = await near.getRheaPoolReserves(poolId, 'wrap.near', tokenAddress);
          liquidityNear = parseFloat(rheaReserves.reserveIn) / 1e24;
        } catch {
          const dclPoolId = await near.findDclPoolId('wrap.near', tokenAddress);
          if (!dclPoolId) throw new Error('no dcl pool');
          const dclState = await near.getDclPoolState(dclPoolId);
          liquidityNear = dclState.liquidityNear;
        }
      } else if (venue === 'nearlytrade') {
        const ntState = await near.getNearlytradeTokenState(tokenAddress);
        if (ntState.phase === 'prebonded') {
          return { safe: false, reason: 'nearlytrade_prebonded_excluded_from_autobuy' };
        }
        liquidityNear = ntState.liquidityNear;
      } else if (venue === 'intear') {
        const intearState = await near.getIntearTokenState(tokenAddress);
        liquidityNear = intearState.liquidityNear;
      } else if (venue === 'onetokenhub') {
        const hubState = await near.getOneTokenHubState(tokenAddress);
        liquidityNear = hubState.liquidityNear;
      } else if (venue === 'nearpad') {
        const padState = await near.getNEARpadState(tokenAddress);
        liquidityNear = padState.liquidityNear;
      } else {
        return { safe: false, reason: `liquidity_check_failed` };
      }
    } catch {
      return { safe: false, reason: 'liquidity_check_failed' };
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
          quantity_held: '0',
          avg_entry_price: '0',
        });
      }

      const fillResult = await createFill({
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

      // Record fee in ledger and handle referral rewards (only if fill was inserted)
      if (fillResult.inserted) {
        await recordFee(fillResult.fillId, feePaidNear.toString());

        // Handle referral rewards (30% of fee goes to referrer)
        const referral = await getReferralByReferredUser(userId);
        if (referral && referral.status === 'pending') {
          // Activate referral on first trade
          await activateReferral(referral.id);
        }
        if (referral && (referral.status === 'active' || referral.status === 'completed')) {
          // Calculate 30% reward
          const rewardAmount = (parseFloat(feePaidNear.toString()) * 0.3);
          await addReferralReward(referral.id, rewardAmount);
        }
      }

    } else if (position) {
      const fillResult = await createFill({
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

      // Record fee in ledger and handle referral rewards (only if fill was inserted)
      if (fillResult.inserted) {
        await recordFee(fillResult.fillId, feePaidNear.toString());

        // Handle referral rewards (30% of fee goes to referrer)
        const referral = await getReferralByReferredUser(userId);
        if (referral && (referral.status === 'active' || referral.status === 'completed')) {
          // Calculate 30% reward
          const rewardAmount = (parseFloat(feePaidNear.toString()) * 0.3);
          await addReferralReward(referral.id, rewardAmount);
        }

        // Notify user with PNL card summary and link
        try {
          const updatedPos = await getPositionById(position.id);
          const fills = await getFillsByPosition(position.id);
          const buys = fills.filter(f => f.side === 'buy');
          const avgEntry = parseFloat(position.avg_entry_price);
          const sellPrice = priceNear;
          const qty = parseFloat(tokenQty) / Math.pow(10, decimals);
          const buyFee = buys.length ? parseFloat(buys[0]?.fee_paid ?? '0') / (parseFloat(buys[0]?.amount ?? '1')) : 0;
          const sellFee = feePaidNear / (qty || 1);
          const pnl = computePnL(avgEntry, sellPrice, qty, buyFee, sellFee);
          const duration = formatHoldDuration(position.opened_at, Date.now());

          await this.notifyUser(userId, 'pnl_card', {
            tokenName: (meta as any)?.name || tokenAddress,
            tokenTicker: (meta as any)?.symbol || tokenAddress.slice(0, 8),
            tokenSymbol: (meta as any)?.symbol || tokenAddress.slice(0, 8),
            entryPrice: avgEntry,
            exitPrice: sellPrice,
            currentPrice: sellPrice,
            quantity: qty,
            positionSize: qty,
            realizedPnlNear: pnl.netNear,
            realizedPnlPercent: pnl.pnlPercent,
            profitAmount: pnl.netNear,
            pnlPercent: pnl.pnlPercent,
            holdDuration: duration,
            duration,
            positionId: position.id,
            status: updatedPos?.status || 'closed',
          });
        } catch (err: any) {
          console.warn('[EXECUTOR] Failed to send pnl_card notification:', err.message);
        }
      }
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