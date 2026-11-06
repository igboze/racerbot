import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRedis } = vi.hoisted(() => {
  return {
    mockRedis: {
      publish: vi.fn().mockResolvedValue(1),
      subscribe: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      quit: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    },
  };
});

vi.mock('@racerbot/shared', async (importOriginal: () => Promise<Record<string, unknown>>) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getRedis: () => mockRedis,
    createRedis: () => mockRedis,
  };
});

import * as db from '@racerbot/db';
import * as shared from '@racerbot/shared';
import { extractSwapDetails, checkCopyTradeReceipt, initCopyTradeDetector, intearRoute, isNonTraderContract } from './copyTrade.js';

describe('Copy Trading & Wallet Tracker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('extractSwapDetails side & token identification', () => {
    it('detects Ref / Rhea ft_transfer_call BUY (wrap.near -> target token)', () => {
      const actions = [
        {
          methodName: 'ft_transfer_call',
          args: {
            receiver_id: 'ref-finance-101.near',
            amount: '1000000000000000000000000',
            msg: JSON.stringify({
              actions: [
                {
                  token_in: 'wrap.near',
                  token_out: 'meme.token.near',
                  min_amount_out: '100',
                },
              ],
            }),
          },
        },
      ];

      const res = extractSwapDetails('wrap.near', actions);
      expect(res).not.toBeNull();
      expect(res?.side).toBe('buy');
      expect(res?.tokenAddress).toBe('meme.token.near');
    });

    it('detects Ref / Rhea ft_transfer_call SELL (target token -> wrap.near)', () => {
      const actions = [
        {
          methodName: 'ft_transfer_call',
          args: {
            receiver_id: 'ref-finance-101.near',
            amount: '5000000',
            msg: JSON.stringify({
              actions: [
                {
                  token_in: 'meme.token.near',
                  token_out: 'wrap.near',
                  min_amount_out: '100000000000000000000000',
                },
              ],
            }),
          },
        },
      ];

      const res = extractSwapDetails('meme.token.near', actions);
      expect(res).not.toBeNull();
      expect(res?.side).toBe('sell');
      expect(res?.tokenAddress).toBe('meme.token.near');
    });

    it('detects direct swap method BUY', () => {
      const actions = [
        {
          methodName: 'swap',
          args: {
            token_in: 'wrap.near',
            token_out: 'moon.near',
            amount_in: '2000000000000000000000000',
          },
        },
      ];

      const res = extractSwapDetails('router.rhea.near', actions);
      expect(res).not.toBeNull();
      expect(res?.side).toBe('buy');
      expect(res?.tokenAddress).toBe('moon.near');
    });

    it('detects direct swap method SELL', () => {
      const actions = [
        {
          methodName: 'swap',
          args: {
            token_in: 'moon.near',
            token_out: 'wrap.near',
            amount_in: '50000',
          },
        },
      ];

      const res = extractSwapDetails('router.rhea.near', actions);
      expect(res).not.toBeNull();
      expect(res?.side).toBe('sell');
      expect(res?.tokenAddress).toBe('moon.near');
    });

    // ── Unbonded Launchpad Tests ──
    it('detects NearlyTrade direct buy method (unbonded launchpad token)', () => {
      const actions = [
        {
          methodName: 'buy',
          args: {
            token_id: 'pepe.nearlytrade.near',
            amount: '1000000000000000000000000',
          },
        },
      ];

      const res = extractSwapDetails('nearlytrade.near', actions);
      expect(res).not.toBeNull();
      expect(res?.side).toBe('buy');
      expect(res?.tokenAddress).toBe('pepe.nearlytrade.near');
    });

    it('detects Meme.Cooking ft_transfer_call deposit BUY (unbonded launchpad token)', () => {
      const actions = [
        {
          methodName: 'ft_transfer_call',
          args: {
            receiver_id: 'meme-cooking.near',
            amount: '2000000000000000000000000',
            msg: JSON.stringify({ Deposit: { meme_id: 88 } }),
          },
        },
      ];

      const res = extractSwapDetails('wrap.near', actions);
      expect(res).not.toBeNull();
      expect(res?.side).toBe('buy');
      expect(res?.tokenAddress).toBe('88.meme-cooking.near');
    });

    it('detects unbonded launchpad token ft_transfer_call SELL into launchpad contract', () => {
      const actions = [
        {
          methodName: 'ft_transfer_call',
          args: {
            receiver_id: 'nearlytrade.near',
            amount: '500000000000',
            msg: 'sell',
          },
        },
      ];

      const res = extractSwapDetails('doge.nearlytrade.near', actions);
      expect(res).not.toBeNull();
      expect(res?.side).toBe('sell');
      expect(res?.tokenAddress).toBe('doge.nearlytrade.near');
    });

    it('detects Intear launch_buy method for unbonded tokens', () => {
      const actions = [
        {
          methodName: 'launch_buy',
          args: {
            token: 'cat.launch.intear.near',
          },
        },
      ];

      const res = extractSwapDetails('launch.intear.near', actions);
      expect(res).not.toBeNull();
      expect(res?.side).toBe('buy');
      expect(res?.tokenAddress).toBe('cat.launch.intear.near');
    });
  });

  describe('checkCopyTradeReceipt routing', () => {
    const leaderWallet = 'whale.near';
    const txHash = 'tx_test_12345';

    it('routes to Wallet Tracker alert and skips auto-trade when target is track_only', async () => {
      vi.spyOn(db, 'getAllActiveCopyTargetWallets').mockResolvedValue([leaderWallet]);
      vi.spyOn(db, 'recordCopyTradeFill').mockResolvedValue({ id: 'fill-1' } as any);
      vi.spyOn(db, 'updateCopyTradeFillResult').mockResolvedValue(undefined as any);
      vi.spyOn(db, 'getTokenCache').mockResolvedValue({
        symbol: 'DRAGON',
        venue: 'rhea',
      } as any);

      const targetRecord = {
        id: 'target-1',
        user_id: 'user-tracker-1',
        target_wallet: leaderWallet,
        referrer_id: null,
        buy_amount_near: 0,
        copy_sells: true,
        max_slippage_pct: 5.0,
        max_daily_budget_near: null,
        track_only: true,
        status: 'active' as const,
        created_at: new Date(),
        updated_at: new Date(),
      };

      vi.spyOn(db, 'getCopyTargetFollowersByWallet').mockResolvedValue([targetRecord as unknown as db.CopyTradeTargetRecord]);

      let publishedChannel: string | null = null;
      let publishedPayload: any = null;

      mockRedis.publish.mockImplementation(async (ch: string, msg: string) => {
        publishedChannel = ch;
        publishedPayload = JSON.parse(msg);
        return 1;
      });

      const actions = [
        {
          methodName: 'swap',
          args: { token_in: 'wrap.near', token_out: 'dragon.tkn.near' },
        },
      ];

      await initCopyTradeDetector();
      await checkCopyTradeReceipt(leaderWallet, 'router.near', txHash, actions);

      expect(publishedChannel).toBe(shared.CHANNELS.NOTIFY_USER);
      expect(publishedPayload).not.toBeNull();
      expect(publishedPayload.event).toBe('wallet_tracker_alert');
      expect(publishedPayload.data.leader_wallet).toBe(leaderWallet);
      expect(publishedPayload.data.token_symbol).toBe('DRAGON');
      expect(publishedPayload.data.side).toBe('buy');
      expect(publishedPayload.data.reply_markup.inline_keyboard.length).toBeGreaterThan(0);
    });

    it('routes to Wallet Tracker alert for unbonded launchpad token with Launchpad badge', async () => {
      vi.spyOn(db, 'getAllActiveCopyTargetWallets').mockResolvedValue([leaderWallet]);
      vi.spyOn(db, 'recordCopyTradeFill').mockResolvedValue({ id: 'fill-launchpad' } as any);
      vi.spyOn(db, 'updateCopyTradeFillResult').mockResolvedValue(undefined as any);
      vi.spyOn(db, 'getTokenCache').mockResolvedValue(null); // unbonded, not yet cached in DB

      const targetRecord = {
        id: 'target-tracker-nt',
        user_id: 'user-tracker-2',
        target_wallet: leaderWallet,
        referrer_id: null,
        buy_amount_near: 0,
        copy_sells: true,
        max_slippage_pct: 5.0,
        max_daily_budget_near: null,
        track_only: true,
        status: 'active' as const,
        created_at: new Date(),
        updated_at: new Date(),
      };

      vi.spyOn(db, 'getCopyTargetFollowersByWallet').mockResolvedValue([targetRecord as unknown as db.CopyTradeTargetRecord]);

      let publishedChannel: string | null = null;
      let publishedPayload: any = null;

      mockRedis.publish.mockImplementation(async (ch: string, msg: string) => {
        publishedChannel = ch;
        publishedPayload = JSON.parse(msg);
        return 1;
      });

      const actions = [
        {
          methodName: 'buy',
          args: { token_id: 'turbo.nearlytrade.near' },
        },
      ];

      await checkCopyTradeReceipt(leaderWallet, 'nearlytrade.near', 'tx_nt_123', actions);

      expect(publishedChannel).toBe(shared.CHANNELS.NOTIFY_USER);
      expect(publishedPayload).not.toBeNull();
      expect(publishedPayload.event).toBe('wallet_tracker_alert');
      expect(publishedPayload.data.leader_wallet).toBe(leaderWallet);
      expect(publishedPayload.data.token_symbol).toBe('TURBO');
      expect(publishedPayload.data.token_address).toBe('turbo.nearlytrade.near');
      expect(publishedPayload.data.message).toContain('NearlyTrade');
      expect(publishedPayload.data.message).toContain('Unbonded Curve');
    });

    it('triggers automated BUY when target is in Auto-Copy mode', async () => {
      vi.spyOn(db, 'recordCopyTradeFill').mockResolvedValue({ id: 'fill-2' } as any);
      vi.spyOn(db, 'updateCopyTradeFillResult').mockResolvedValue(undefined as any);
      vi.spyOn(db, 'getCopyTradeDailySpend').mockResolvedValue(0);
      vi.spyOn(db, 'getTokenCache').mockResolvedValue({
        symbol: 'DRAGON',
        venue: 'rhea',
      } as any);
      vi.spyOn(db, 'getUserById').mockResolvedValue({ id: 'user-copy-1' } as any);
      vi.spyOn(db, 'getUserBySubaccount').mockResolvedValue(null);
      vi.spyOn(db, 'getTokenReferral').mockResolvedValue(null);
      vi.spyOn(db, 'awardPointsForCopyTrade').mockResolvedValue(undefined as any);

      const targetRecord = {
        id: 'target-2',
        user_id: 'user-copy-1',
        target_wallet: leaderWallet,
        referrer_id: null,
        buy_amount_near: 2.0,
        copy_sells: true,
        max_slippage_pct: 5.0,
        max_daily_budget_near: 50.0,
        track_only: false,
        status: 'active' as const,
        created_at: new Date(),
        updated_at: new Date(),
      };

      vi.spyOn(db, 'getCopyTargetFollowersByWallet').mockResolvedValue([targetRecord as unknown as db.CopyTradeTargetRecord]);

      const publishedChannels: string[] = [];
      const publishedEvents: any[] = [];
      mockRedis.publish.mockImplementation(async (ch: string, msg: string) => {
        publishedChannels.push(ch);
        publishedEvents.push(JSON.parse(msg));
        return 1;
      });

      const nearMock = shared.getNear();
      vi.spyOn(nearMock, 'computeMinAmountOut').mockResolvedValue({ expectedOutput: '1000', minAmountOut: '900' } as any);

      const actions = [
        {
          methodName: 'swap',
          args: { token_in: 'wrap.near', token_out: 'dragon.tkn.near' },
        },
      ];

      await checkCopyTradeReceipt(leaderWallet, 'router.near', 'tx_buy_999', actions);

      expect(publishedChannels).toContain(shared.CHANNELS.EXECUTE_SWAP);
      const swapEvent = publishedEvents.find(e => e.type === 'execute_swap');
      expect(swapEvent).toBeDefined();
      expect(swapEvent.token_in).toBe('wrap.near');
      expect(swapEvent.token_out).toBe('dragon.tkn.near');
      expect(swapEvent.user_id).toBe('user-copy-1');
      // The executor settles the fill and awards points only once the swap succeeds
      expect(swapEvent.copy).toEqual({
        fill_id: 'fill-2', copier_user_id: 'user-copy-1', token_address: 'dragon.tkn.near',
        points_volume_near: 2.0, leader_user_id: null, referrer_id: null,
      });
      expect(swapEvent.notify_user).toBeUndefined();
      expect(db.awardPointsForCopyTrade).not.toHaveBeenCalled();
      expect(db.updateCopyTradeFillResult).toHaveBeenCalledWith('fill-2', 'pending', { amount_near: 2.0 });
    });

    it('triggers automated BUY for unbonded launchpad token', async () => {
      vi.spyOn(db, 'recordCopyTradeFill').mockResolvedValue({ id: 'fill-nt-buy' } as any);
      vi.spyOn(db, 'updateCopyTradeFillResult').mockResolvedValue(undefined as any);
      vi.spyOn(db, 'getCopyTradeDailySpend').mockResolvedValue(0);
      vi.spyOn(db, 'getTokenCache').mockResolvedValue(null);
      vi.spyOn(db, 'getUserById').mockResolvedValue({ id: 'user-copy-nt' } as any);
      vi.spyOn(db, 'getUserBySubaccount').mockResolvedValue(null);
      vi.spyOn(db, 'getTokenReferral').mockResolvedValue(null);
      vi.spyOn(db, 'awardPointsForCopyTrade').mockResolvedValue(undefined as any);

      const targetRecord = {
        id: 'target-nt',
        user_id: 'user-copy-nt',
        target_wallet: leaderWallet,
        referrer_id: null,
        buy_amount_near: 1.5,
        copy_sells: true,
        max_slippage_pct: 10.0,
        max_daily_budget_near: null,
        track_only: false,
        status: 'active' as const,
        created_at: new Date(),
        updated_at: new Date(),
      };

      vi.spyOn(db, 'getCopyTargetFollowersByWallet').mockResolvedValue([targetRecord as unknown as db.CopyTradeTargetRecord]);

      const publishedChannels: string[] = [];
      const publishedEvents: any[] = [];
      mockRedis.publish.mockImplementation(async (ch: string, msg: string) => {
        publishedChannels.push(ch);
        publishedEvents.push(JSON.parse(msg));
        return 1;
      });

      const nearMock = shared.getNear();
      vi.spyOn(nearMock, 'computeMinAmountOut').mockResolvedValue({ expectedOutput: '50000', minAmountOut: '45000' } as any);

      const actions = [
        {
          methodName: 'buy',
          args: { token_id: 'turbo.nearlytrade.near' },
        },
      ];

      await checkCopyTradeReceipt(leaderWallet, 'nearlytrade.near', 'tx_nt_auto', actions);

      expect(publishedChannels).toContain(shared.CHANNELS.EXECUTE_SWAP);
      const swapEvent = publishedEvents.find(e => e.type === 'execute_swap');
      expect(swapEvent).toBeDefined();
      expect(swapEvent.token_in).toBe('wrap.near');
      expect(swapEvent.token_out).toBe('turbo.nearlytrade.near');
      expect(swapEvent.venue).toBe('nearlytrade');
      expect(swapEvent.user_id).toBe('user-copy-nt');
    });

    it('triggers automated SELL when leader sells and copier has position', async () => {
      vi.spyOn(db, 'recordCopyTradeFill').mockResolvedValue({ id: 'fill-3' } as any);
      vi.spyOn(db, 'updateCopyTradeFillResult').mockResolvedValue(undefined as any);
      vi.spyOn(db, 'getTokenCache').mockResolvedValue({
        symbol: 'DRAGON',
        venue: 'rhea',
      } as any);
      vi.spyOn(db, 'getOpenPositions').mockResolvedValue([
        {
          id: 'pos-1',
          user_id: 'user-copy-1',
          token_address: 'dragon.tkn.near',
          quantity_held: '500000000',
          avg_entry_price: '1.0',
          status: 'open',
          opened_at: new Date(),
          closed_at: null,
        },
      ] as any);

      const targetRecord = {
        id: 'target-3',
        user_id: 'user-copy-1',
        target_wallet: leaderWallet,
        referrer_id: null,
        buy_amount_near: 2.0,
        copy_sells: true,
        max_slippage_pct: 5.0,
        max_daily_budget_near: null,
        track_only: false,
        status: 'active' as const,
        created_at: new Date(),
        updated_at: new Date(),
      };

      vi.spyOn(db, 'getCopyTargetFollowersByWallet').mockResolvedValue([targetRecord as unknown as db.CopyTradeTargetRecord]);

      const publishedChannels: string[] = [];
      const publishedEvents: any[] = [];
      mockRedis.publish.mockImplementation(async (ch: string, msg: string) => {
        publishedChannels.push(ch);
        publishedEvents.push(JSON.parse(msg));
        return 1;
      });

      const actions = [
        {
          methodName: 'swap',
          args: { token_in: 'dragon.tkn.near', token_out: 'wrap.near' },
        },
      ];

      await checkCopyTradeReceipt(leaderWallet, 'router.near', 'tx_sell_888', actions);

      expect(publishedChannels).toContain(shared.CHANNELS.EXECUTE_SWAP);
      const swapEvent = publishedEvents.find(e => e.type === 'execute_swap');
      expect(swapEvent).toBeDefined();
      expect(swapEvent.token_in).toBe('dragon.tkn.near');
      expect(swapEvent.token_out).toBe('wrap.near');
      expect(swapEvent.amount_in).toBe('500000000');
    });
  });
});

// Real message shapes from each venue (DCL, Intear, NearPumpFun, Aggregatedex): buys must be recognised,
// otherwise copy buys never fire and copy sells are skipped for lack of a position.
describe('extractSwapDetails on real venue messages', () => {
  const ftCall = (receiver: string, msg: unknown) =>
    [{ methodName: 'ft_transfer_call', args: { receiver_id: receiver, amount: '1000', msg: typeof msg === 'string' ? msg : JSON.stringify(msg) } }];
  const THREE = 'three-de86d6.launchpad.justhoot.near';
  const DCL_POOL = `${THREE}|wrap.near|10000`;

  it('DCL buy: wrap.near into dclv2 with Swap.output_token', () => {
    const r = extractSwapDetails('wrap.near', ftCall('dclv2.ref-labs.near', { Swap: { pool_ids: [DCL_POOL], output_token: THREE, min_output_amount: '1' } }));
    expect(r).toMatchObject({ side: 'buy', tokenAddress: THREE, tokenIn: 'wrap.near' });
  });

  it('DCL buy is also recognised on the ft_on_transfer receipt at the pool', () => {
    const r = extractSwapDetails('dclv2.ref-labs.near',
      [{ methodName: 'ft_on_transfer', args: { sender_id: 'leader.near', amount: '1000', msg: JSON.stringify({ Swap: { pool_ids: [DCL_POOL], output_token: THREE } }) } }],
      'wrap.near');
    expect(r).toMatchObject({ side: 'buy', tokenAddress: THREE });
  });

  it('DCL sell with skip_unwrap_near still a sell', () => {
    const r = extractSwapDetails(THREE, ftCall('dclv2.ref-labs.near', { Swap: { pool_ids: [DCL_POOL], output_token: 'wrap.near', min_output_amount: '1', skip_unwrap_near: true } }));
    expect(r).toMatchObject({ side: 'sell', tokenAddress: THREE });
  });

  it('DCL SwapByOutput buy', () => {
    const r = extractSwapDetails('wrap.near', ftCall('dclv2.ref-labs.near', { SwapByOutput: { pool_ids: [DCL_POOL], output_token: THREE, output_amount: '5' } }));
    expect(r).toMatchObject({ side: 'buy', tokenAddress: THREE });
  });

  it('DCL multi-hop swap through wrap.near into a launchpad token is recognised as a BUY of output_token (not a false sell)', () => {
    const TOKEN_A = 'wth-0b2227.launchpad.justhoot.near';
    const TOKEN_B = 'imeme-2.launchpad.justhoot.near';
    const r = extractSwapDetails(
      TOKEN_A,
      ftCall('dclv2.ref-labs.near', {
        Swap: {
          pool_ids: [`${TOKEN_A}|wrap.near|2000`, `${TOKEN_B}|wrap.near|2000`],
          output_token: TOKEN_B,
          min_output_amount: '1',
        },
      }),
      'leader.near'
    );
    expect(r).toMatchObject({ side: 'buy', tokenAddress: TOKEN_B, tokenOut: TOKEN_B });
  });

  it('aggregatedex.near client_echo payout receipt is ignored (never misclassified as a SELL)', () => {
    const clientEcho = {
      user: 'ezmoneygems.near',
      receive_user: 'ezmoneygems.near',
      swap_fee: { fee_token: 'wrap.near', fee_bps: 10, fee_receiver: 'fee-astr.near' },
    };
    const r1 = extractSwapDetails(THREE, ftCall('aggregatedex.near', clientEcho), 'dclv2.ref-labs.near');
    expect(r1).toBeNull();
    const r2 = extractSwapDetails(THREE, ftCall('aggregatedex.near', clientEcho), 'ezmoneygems.near');
    expect(r2).toBeNull();
  });

  it('aggregatedex.near callback_swap decodes swap_request for BUY and SELL', () => {
    const buyRes = extractSwapDetails('aggregatedex.near', [
      {
        methodName: 'callback_swap',
        args: {
          swap_request: {
            token_in: 'wrap.near',
            msgs: [
              {
                contract_id: 'dclv2.ref-labs.near',
                amount: '1000000000000000000000000',
                msg: JSON.stringify({ Swap: { pool_ids: [DCL_POOL], output_token: THREE, min_output_amount: '0' } }),
              },
            ],
          },
        },
      },
    ]);
    expect(buyRes).toMatchObject({ side: 'buy', tokenAddress: THREE });

    const sellRes = extractSwapDetails('aggregatedex.near', [
      {
        methodName: 'callback_swap',
        args: {
          swap_request: {
            token_in: THREE,
            msgs: [
              {
                contract_id: 'dclv2.ref-labs.near',
                amount: '5000000',
                msg: JSON.stringify({ Swap: { pool_ids: [DCL_POOL], output_token: 'wrap.near', min_output_amount: '0' } }),
              },
            ],
          },
        },
      },
    ]);
    expect(sellRes).toMatchObject({ side: 'sell', tokenAddress: THREE });
  });

  it('isNonTraderContract filters out DEXes and launchpads while keeping user wallets', () => {
    expect(isNonTraderContract('dclv2.ref-labs.near')).toBe(true);
    expect(isNonTraderContract('aggregatedex.near')).toBe(true);
    expect(isNonTraderContract('kookdog-42db38.launchpad.justhoot.near')).toBe(true);
    expect(isNonTraderContract('ezmoneygems.near')).toBe(false);
    expect(isNonTraderContract('ethereal_contraption.user.intear.near')).toBe(false);
    expect(isNonTraderContract('lunar-nexus-9768.racerbot.near')).toBe(false);
  });

  const intearOps = (assetIn: string, assetOut: string, viaIntear = false) => ({
    referrer: 'dex-aggregator.intear.near',
    operations: [
      ...(viaIntear
        ? [
            { SwapSimple: { dex_id: 'slimedragon.near/xyk', asset_in: assetIn, asset_out: 'nep141:token.intear.near', amount: { Amount: { ExactIn: '1000' } }, message: 'EgEAAA==' } },
            { SwapSimple: { dex_id: 'slimedragon.near/xyk', asset_in: 'nep141:token.intear.near', asset_out: assetOut, amount: 'OutputOfLastIn', message: 'CQAAAA==' } },
          ]
        : [{ SwapSimple: { dex_id: 'slimedragon.near/xyk', asset_in: assetIn, asset_out: assetOut, amount: { Amount: { ExactIn: '1000' } }, message: 'EgEAAA==' } }]),
      { Withdraw: { asset_id: assetOut, amount: { Full: { at_least: null } }, to: null, rescue_address: null } },
    ],
  });

  it('Intear buy through deposit_near', () => {
    const r = extractSwapDetails('dex.intear.near', [{ methodName: 'deposit_near', args: { operations: intearOps('near', 'nep141:cat.near') } }]);
    expect(r).toMatchObject({ side: 'buy', tokenAddress: 'cat.near', tokenIn: 'wrap.near' });
  });

  it('Intear two-hop buy resolves to the final token, not token.intear.near', () => {
    const r = extractSwapDetails('dex.intear.near', [{ methodName: 'deposit_near', args: { operations: intearOps('near', 'nep141:cat.near', true) } }]);
    expect(r).toMatchObject({ side: 'buy', tokenAddress: 'cat.near' });
  });

  it('Intear sell through ft_transfer_call', () => {
    const r = extractSwapDetails('cat.near', ftCall('dex.intear.near', intearOps('nep141:cat.near', 'near')));
    expect(r).toMatchObject({ side: 'sell', tokenAddress: 'cat.near', tokenOut: 'wrap.near' });
  });

  it('Intear two-hop sell resolves to the token sold', () => {
    const r = extractSwapDetails('cat.near', ftCall('dex.intear.near', intearOps('nep141:cat.near', 'near', true)));
    expect(r).toMatchObject({ side: 'sell', tokenAddress: 'cat.near' });
  });

  it('Intear token-to-token swap is neither a buy nor a sell', () => {
    expect(extractSwapDetails('cat.near', ftCall('dex.intear.near', intearOps('nep141:cat.near', 'nep141:dog.near')))).toBeNull();
  });

  it('intearRoute reads all message forms', () => {
    const ops = intearOps('near', 'nep141:cat.near');
    expect(intearRoute(ops)).toEqual({ tokenIn: 'near', tokenOut: 'cat.near' });
    expect(intearRoute(ops.operations)).toEqual({ tokenIn: 'near', tokenOut: 'cat.near' });
    expect(intearRoute(JSON.stringify(ops))).toEqual({ tokenIn: 'near', tokenOut: 'cat.near' });
    expect(intearRoute({ operations: ops })).toEqual({ tokenIn: 'near', tokenOut: 'cat.near' });
    expect(intearRoute('not json')).toBeNull();
  });

  it('NearPumpFun buy and sell on the token contract', () => {
    expect(extractSwapDetails('cat.nearpumpfun.near', [{ methodName: 'buy', args: { min_tokens_out: '1', deadline_sec: 1 } }]))
      .toMatchObject({ side: 'buy', tokenAddress: 'cat.nearpumpfun.near', tokenIn: 'wrap.near' });
    expect(extractSwapDetails('cat.nearpumpfun.near', [{ methodName: 'sell', args: { tokens_in: '5', min_near_out: '1', deadline_sec: 1 } }]))
      .toMatchObject({ side: 'sell', tokenAddress: 'cat.nearpumpfun.near', amountIn: '5' });
  });

  it('other calls on a NearPumpFun token are not trades', () => {
    expect(extractSwapDetails('cat.nearpumpfun.near', [{ methodName: 'storage_deposit', args: {} }])).toBeNull();
  });

  it('Ref v2 buy still recognised', () => {
    const r = extractSwapDetails('wrap.near', ftCall('v2.ref-finance.near', { force: 0, actions: [{ pool_id: 1, token_in: 'wrap.near', token_out: 'meme.near', amount_in: '1000', min_amount_out: '1' }] }));
    expect(r).toMatchObject({ side: 'buy', tokenAddress: 'meme.near' });
  });
});
