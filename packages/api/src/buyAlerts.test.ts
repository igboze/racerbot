import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildAlertSettingsCard,
  dispatchBuyAlert,
  buyAlertPendingActions,
} from './buyAlerts.js';
import type { GroupBuyAlertRecord } from '@racerbot/db';
import type { BuyAlertEvent } from '@racerbot/shared';

// Mock DB module
vi.mock('@racerbot/db', () => ({
  getGroupBuyAlertsByToken: vi.fn(),
  updateGroupBuyAlert: vi.fn().mockResolvedValue({}),
  deleteGroupBuyAlert: vi.fn().mockResolvedValue(true),
  upsertGroupBuyAlert: vi.fn(),
  getTokenCache: vi.fn().mockResolvedValue(null),
  getUserByTelegramId: vi.fn().mockResolvedValue({ id: 'user-admin-1', telegram_id: 12345 }),
  getOrCreateTokenShare: vi.fn().mockResolvedValue('t_share_admin123'),
  getDb: vi.fn().mockResolvedValue({
    query: vi.fn(),
  }),
}));

// Mock shared redis pub/sub
vi.mock('@racerbot/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@racerbot/shared')>();
  return {
    ...actual,
    createRedis: () => ({
      subscribe: vi.fn(),
    }),
  };
});

// Mock wallet module
vi.mock('./wallet.js', () => ({
  getTokenInfo: vi.fn().mockResolvedValue({ symbol: 'TEST', name: 'Test Token' }),
  isSuiToken: vi.fn((ca: string) => ca.startsWith('0x')),
}));

import * as db from '@racerbot/db';

describe('Group Buy Alerts Engine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buyAlertPendingActions.clear();
  });

  describe('buildAlertSettingsCard', () => {
    it('should format active NEAR alert card correctly', () => {
      const alert: GroupBuyAlertRecord = {
        id: 'ba-1',
        chat_id: '-1001234567890',
        chat_title: 'Racer Community',
        admin_id: '12345',
        token_address: 'token.near',
        chain: 'near',
        min_buy_usd: 10,
        emoji: '🏎️',
        emoji_step_usd: 5,
        media_file_id: undefined,
        media_type: 'default',
        whale_threshold_usd: 500,
        is_active: true,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const card = buildAlertSettingsCard(alert);
      expect(card.text).toContain('Racer Community');
      expect(card.text).toContain('token.near');
      expect(card.text).toContain('🟢 ACTIVE');
      expect(card.text).toContain('⬛ NEAR');
      expect(card.text).toContain('$10.00 USD');
      expect(card.text).toContain('🏎️ (1 per $5.00)');
      expect(card.text).toContain('$500.00 USD');
      expect(card.keyboard).toBeDefined();
    });

    it('should format paused SUI alert with custom media correctly', () => {
      const alert: GroupBuyAlertRecord = {
        id: 'ba-2',
        chat_id: '-1009876543210',
        chat_title: 'Sui Degens',
        admin_id: '54321',
        token_address: '0x2::sui::SUI',
        chain: 'sui',
        min_buy_usd: 25,
        emoji: '🚀',
        emoji_step_usd: 10,
        media_file_id: 'file_id_animation_abc',
        media_type: 'animation',
        whale_threshold_usd: 1000,
        is_active: false,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const card = buildAlertSettingsCard(alert);
      expect(card.text).toContain('Sui Degens');
      expect(card.text).toContain('🔴 PAUSED');
      expect(card.text).toContain('💧 SUI');
      expect(card.text).toContain('Custom Media 🖼️');
      expect(card.text).toContain('🚀 (1 per $10.00)');
    });
  });

  describe('dispatchBuyAlert', () => {
    it('should skip alerts when spent_usd is below min_buy_usd', async () => {
      const mockSendMessage = vi.fn();
      const mockBot: any = {
        botInfo: { username: 'racertradingbot' },
        telegram: {
          sendMessage: mockSendMessage,
        },
      };

      const { startBuyAlertListener } = await import('./buyAlerts.js');
      await startBuyAlertListener('redis://localhost:6379', mockBot);

      vi.mocked(db.getGroupBuyAlertsByToken).mockResolvedValue([
        {
          id: 'ba-1',
          chat_id: '-100111',
          admin_id: '12345',
          token_address: 'test.near',
          chain: 'near',
          min_buy_usd: 50, // requires $50
          emoji: '🏎️',
          emoji_step_usd: 5,
          media_type: 'default',
          whale_threshold_usd: 200,
          is_active: true,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ]);

      const event: BuyAlertEvent = {
        type: 'buy_alert',
        chain: 'near',
        token_address: 'test.near',
        token_name: 'Test Token',
        token_symbol: 'TEST',
        buyer_address: 'buyer.near',
        spent_amount_native: '2.5 NEAR',
        spent_usd: 12.50, // Only $12.50 < $50
        tokens_received: '500 TEST',
        price_usd: 0.025,
        tx_hash: 'tx-123',
        timestamp: Date.now(),
      };

      await dispatchBuyAlert(event);
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it('should format and dispatch message with dynamic emoji bar and 1-tap Buy button', async () => {
      const mockSendMessage = vi.fn().mockResolvedValue({});
      const mockBot: any = {
        botInfo: { username: 'racertradingbot' },
        telegram: {
          sendMessage: mockSendMessage,
        },
      };

      const { startBuyAlertListener } = await import('./buyAlerts.js');
      await startBuyAlertListener('redis://localhost:6379', mockBot);

      vi.mocked(db.getGroupBuyAlertsByToken).mockResolvedValue([
        {
          id: 'ba-2',
          chat_id: '-100222',
          admin_id: '12345',
          token_address: 'moon.near',
          chain: 'near',
          min_buy_usd: 5,
          emoji: '🔥',
          emoji_step_usd: 10,
          media_type: 'default',
          whale_threshold_usd: 200,
          is_active: true,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ]);

      const event: BuyAlertEvent = {
        type: 'buy_alert',
        chain: 'near',
        token_address: 'moon.near',
        token_name: 'Moon Token',
        token_symbol: 'MOON',
        buyer_address: 'whale.near',
        spent_amount_native: '50 NEAR',
        spent_usd: 250.00, // $250 / 10 = 25 emojis, also triggers whale alert (>= 200)
        tokens_received: '100,000 MOON',
        price_usd: 0.0025,
        market_cap_usd: 250000,
        tx_hash: 'tx-whale-456',
        timestamp: Date.now(),
      };

      await dispatchBuyAlert(event);

      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      const callArgs = mockSendMessage.mock.calls[0];
      expect(callArgs[0]).toBe('-100222');
      const text = callArgs[1];
      expect(text).toContain('RACERBOT BUY ALERT');
      expect(text).toContain('WHALE BUY DETECTED!');
      expect(text).toContain('🔥'.repeat(25));
      expect(text).toContain('50 NEAR');
      expect(text).toContain('$250.00 USD');
      expect(text).toContain('whale.near');
      expect(text).toContain('Moon Token ($MOON)');

      // Verify referral deep link button
      const extra = callArgs[2];
      expect(extra.reply_markup.inline_keyboard[0][0].text).toBe('⚡ Buy on RacerBot');
      expect(extra.reply_markup.inline_keyboard[0][0].url).toContain('https://t.me/racertradingbot?start=t_share_admin123');
    });

    it('should send custom animation when alert media is configured', async () => {
      const mockSendAnimation = vi.fn().mockResolvedValue({});
      const mockBot: any = {
        botInfo: { username: 'racertradingbot' },
        telegram: {
          sendAnimation: mockSendAnimation,
          sendMessage: vi.fn(),
        },
      };

      const { startBuyAlertListener } = await import('./buyAlerts.js');
      await startBuyAlertListener('redis://localhost:6379', mockBot);

      vi.mocked(db.getGroupBuyAlertsByToken).mockResolvedValue([
        {
          id: 'ba-3',
          chat_id: '-100333',
          admin_id: '12345',
          token_address: '0x2::token::COIN',
          chain: 'sui',
          min_buy_usd: 5,
          emoji: '⚡',
          emoji_step_usd: 5,
          media_file_id: 'gif_file_id_xyz',
          media_type: 'animation',
          whale_threshold_usd: 500,
          is_active: true,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ]);

      const event: BuyAlertEvent = {
        type: 'buy_alert',
        chain: 'sui',
        token_address: '0x2::token::COIN',
        token_name: 'Sui Coin',
        token_symbol: 'SCOIN',
        buyer_address: '0x1234567890abcdef1234',
        spent_amount_native: '10 SUI',
        spent_usd: 20.00,
        tokens_received: '5,000 SCOIN',
        tx_hash: 'sui-tx-123',
        timestamp: Date.now(),
      };

      await dispatchBuyAlert(event);

      expect(mockSendAnimation).toHaveBeenCalledTimes(1);
      const args = mockSendAnimation.mock.calls[0];
      expect(args[0]).toBe('-100333');
      expect(args[2].caption).toContain('SCOIN');
      expect(args[2].caption).toContain('0x1234...1234');
      expect(args[2].caption).toContain('0x2::token::COIN');
      expect(args[2].reply_markup.inline_keyboard[1][0].url).toContain('suiscan.xyz');
    });

    it('should auto-pause alert when bot is kicked from the group', async () => {
      const mockSendMessage = vi.fn().mockRejectedValue(new Error('Forbidden: bot was kicked from the supergroup chat'));
      const mockBot: any = {
        botInfo: { username: 'racertradingbot' },
        telegram: {
          sendMessage: mockSendMessage,
        },
      };

      const { startBuyAlertListener } = await import('./buyAlerts.js');
      await startBuyAlertListener('redis://localhost:6379', mockBot);

      vi.mocked(db.getGroupBuyAlertsByToken).mockResolvedValue([
        {
          id: 'ba-kicked',
          chat_id: '-100444',
          admin_id: '12345',
          token_address: 'token.near',
          chain: 'near',
          min_buy_usd: 1,
          emoji: '🏎️',
          emoji_step_usd: 5,
          media_type: 'default',
          whale_threshold_usd: 200,
          is_active: true,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ]);

      const event: BuyAlertEvent = {
        type: 'buy_alert',
        chain: 'near',
        token_address: 'token.near',
        token_name: 'Token',
        token_symbol: 'TKN',
        buyer_address: 'alice.near',
        spent_amount_native: '5 NEAR',
        spent_usd: 25.00,
        tokens_received: '10 TKN',
        tx_hash: 'tx-kicked',
        timestamp: Date.now(),
      };

      await dispatchBuyAlert(event);

      expect(db.updateGroupBuyAlert).toHaveBeenCalledWith('ba-kicked', { is_active: false });
    });
  });
});
