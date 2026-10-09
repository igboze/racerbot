import { describe, it, expect } from 'vitest';
import {
  formatDropAmount,
  getTelegramDisplayName,
  buildRaceDropGroupCard,
  buildRaceDropClaimSuccessCard,
  buildRaceDropCreatorShareCard,
} from './raceDrop.js';
import type { RaceDropRecord, RaceDropClaimRecord } from '@racerbot/db';

describe('RaceDrop formatting and card generators', () => {
  it('formats drop amounts nicely with human units', () => {
    expect(formatDropAmount(500)).toBe('500');
    expect(formatDropAmount(1500)).toBe('1.5k');
    expect(formatDropAmount(2500000)).toBe('2.5M');
    expect(formatDropAmount('10000000')).toBe('10M');
    expect(formatDropAmount('0.005')).toBe('0.005');
  });

  it('correctly resolves Telegram display names', () => {
    expect(getTelegramDisplayName({ first_name: 'John', last_name: 'Doe' })).toBe('John Doe');
    expect(getTelegramDisplayName({ first_name: 'Alice' })).toBe('Alice');
    expect(getTelegramDisplayName({ username: 'crypto_racer' })).toBe('@crypto_racer');
    expect(getTelegramDisplayName(undefined)).toBe('A Racer');
  });

  const mockDropWithName: RaceDropRecord = {
    id: '11111111-2222-3333-4444-555555555555',
    creator_id: 'aaaa-bbbb',
    creator_telegram_id: 123456789,
    creator_name: 'Satoshi Nakamoto',
    chain: 'near',
    token_address: 'blackdragon.tkn.near',
    token_symbol: 'BLACKDRAGON',
    decimals: 24,
    amount_per_user: '10000',
    total_amount: '100000',
    remaining_amount: '80000',
    total_claims: 10,
    claims_count: 2,
    split_mode: 'equal',
    message_text: 'RacerBot to the moon! 🏎️',
    status: 'active',
    expires_at: new Date(Date.now() + 86400000),
    created_at: new Date(),
  };

  it('builds group card with Telegram creator name in header and claim button', () => {
    const card = buildRaceDropGroupCard(mockDropWithName, 'satoshi', 'racertradingbot');
    // Header check
    expect(card.text).toContain('🏎️ <b>Satoshi Nakamoto created a RaceDrop!</b> 🏎️');
    expect(card.text).toContain('Amount per User:</b> <code>10k BLACKDRAGON</code>');
    expect(card.text).toContain('Total Pool:</b> <code>100k BLACKDRAGON</code>');
    expect(card.text).toContain('<b>2</b> / <b>10</b> claimed');
    expect(card.text).toContain('RacerBot to the moon!');

    const buttons = card.keyboard.reply_markup.inline_keyboard;
    expect(buttons.length).toBeGreaterThanOrEqual(1);
    const claimBtn = buttons[0][0];
    expect(claimBtn.text).toBe('🏎️ Claim RaceDrop!');
    expect((claimBtn as any).url).toBe(
      'https://t.me/racertradingbot?start=drop_11111111-2222-3333-4444-555555555555'
    );
  });

  it('builds group card header with fallback username if creator_name is not set', () => {
    const mockDropNoName: RaceDropRecord = {
      ...mockDropWithName,
      creator_name: undefined,
    };
    const card = buildRaceDropGroupCard(mockDropNoName, 'satoshi', 'racertradingbot');
    expect(card.text).toContain('🏎️ <b>@satoshi created a RaceDrop!</b> 🏎️');
  });

  it('builds group card for completed drops with closed status', () => {
    const completedDrop: RaceDropRecord = {
      ...mockDropWithName,
      claims_count: 10,
      remaining_amount: '0',
      status: 'completed',
    };
    const card = buildRaceDropGroupCard(completedDrop, 'satoshi', 'racertradingbot');
    expect(card.text).toContain('COMPLETED');
    const buttons = card.keyboard.reply_markup.inline_keyboard;
    expect(buttons[0][0].text).toBe('🏎️ Open RacerBot');
  });

  it('builds DM claim success card with referral welcome banner for new users', () => {
    const mockClaim: RaceDropClaimRecord = {
      id: 'claim-1',
      drop_id: mockDropWithName.id,
      user_id: 'new-user-1',
      telegram_id: 987654321,
      claim_amount: '10000',
      is_new_user: true,
      tx_hash: '9xYAbc123TxHash',
      created_at: new Date(),
    };

    const card = buildRaceDropClaimSuccessCard(mockDropWithName, mockClaim, 'satoshi');
    expect(card.text).toContain('RaceDrop Claimed!');
    expect(card.text).toContain('Welcome to RacerBot!');
    expect(card.text).toContain('+10k BLACKDRAGON');
    expect(card.text).toContain('Satoshi Nakamoto');
    expect(card.text).toContain('https://nearblocks.io/txns/9xYAbc123TxHash');

    const buttons = card.keyboard.reply_markup.inline_keyboard;
    expect(buttons[0][0].text).toContain('Buy More BLACKDRAGON');
    expect(buttons[0][1].text).toBe('🎒 View Wallet');
  });

  it('builds creator share card with Share to Group button', () => {
    const card = buildRaceDropCreatorShareCard(mockDropWithName, 'racertradingbot');
    expect(card.text).toContain('RaceDrop Successfully Created!');
    expect(card.text).toContain('Satoshi Nakamoto');
    expect(card.text).toContain('10k BLACKDRAGON');
    expect(card.text).toContain('100k BLACKDRAGON');
    expect(card.text).toContain('https://t.me/racertradingbot?start=drop_11111111-2222-3333-4444-555555555555');

    const buttons = card.keyboard.reply_markup.inline_keyboard;
    expect(buttons[0][0].text).toContain('Share to Group');
    expect((buttons[0][0] as any).switch_inline_query).toBe(
      'drop_11111111-2222-3333-4444-555555555555'
    );
    expect((buttons[1][0] as any).url).toContain('https://t.me/share/url');
  });
});
