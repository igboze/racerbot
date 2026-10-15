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
import { extractSwapDetails, checkCopyTradeReceipt, initCopyTradeDetector } from './copyTrade.js';

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
