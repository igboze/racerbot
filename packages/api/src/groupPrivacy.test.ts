import { describe, it, expect, vi } from 'vitest';
import { isGroupChat, isPrivateChat, replyGroupDmRedirect } from './routes.js';

describe('Public Group Chat Privacy Safeguards', () => {
  it('correctly classifies chat types into group vs private', () => {
    expect(isGroupChat({ chat: { type: 'group' } })).toBe(true);
    expect(isGroupChat({ chat: { type: 'supergroup' } })).toBe(true);
    expect(isGroupChat({ chat: { type: 'channel' } })).toBe(true);
    expect(isGroupChat({ chat: { type: 'private' } })).toBe(false);
    expect(isGroupChat({ chat: undefined })).toBe(false);

    expect(isPrivateChat({ chat: { type: 'private' } })).toBe(true);
    expect(isPrivateChat({ chat: { type: 'group' } })).toBe(false);
    expect(isPrivateChat({ chat: { type: 'supergroup' } })).toBe(false);
  });

  it('replyGroupDmRedirect sends privacy notice with DM link without exposing sensitive data', async () => {
    const mockReply = vi.fn().mockResolvedValue({});
    const mockCtx = {
      botInfo: { username: 'racertradingbot' },
      reply: mockReply,
    } as any;

    await replyGroupDmRedirect(mockCtx, 'Wallet details');

    expect(mockReply).toHaveBeenCalledTimes(1);
    const [text, options] = mockReply.mock.calls[0];

    // Must emphasize that wallet details are private
    expect(text).toContain('Wallet details are private');
    expect(text).toContain('strictly restricted to private DM');
    // Must NOT contain sensitive deposit account formats or balances
    expect(text).not.toContain('.near');
    expect(text).not.toContain('0x');

    // Must provide deep link button to private DM
    const inlineKeyboard = options.reply_markup.inline_keyboard;
    expect(inlineKeyboard[0][0].text).toBe('🏎️ Open RacerBot in DM');
    expect(inlineKeyboard[0][0].url).toBe('https://t.me/racertradingbot?start=menu');
  });
});
