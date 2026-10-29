import { describe, it, expect } from 'vitest';
import { Markup } from 'telegraf';
import { isPrivateDeposit, privatizeDepositPicker, setPrivateDeposit } from './botPrivate.js';

describe('private cross-chain deposits in the bot', () => {
  it('the private mark is per user and can be cleared', () => {
    setPrivateDeposit(101, true);
    expect(isPrivateDeposit(101)).toBe(true);
    expect(isPrivateDeposit(202)).toBe(false);
    setPrivateDeposit(101, false);
    expect(isPrivateDeposit(101)).toBe(false);
  });

  it('labels the picker as private and offers a way back', () => {
    const menu = privatizeDepositPicker({
      text: 'Deposit into your RacerBot NEAR account',
      keyboard: Markup.inlineKeyboard([[Markup.button.callback('🟣 Solana', 'dep_chain:sol:0')]]),
    });
    expect(menu.text).toContain('private balance');
    const rows = menu.keyboard.reply_markup.inline_keyboard;
    expect((rows[0][0] as any).callback_data).toBe('pv_xchain_off');
    expect((rows[1][0] as any).callback_data).toBe('dep_chain:sol:0');
  });
});
