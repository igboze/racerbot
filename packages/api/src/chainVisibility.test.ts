import { describe, it, expect } from 'vitest';
import {
  ALL_SUPPORTED_CHAINS,
  isChainVisible,
  getVisibleChains,
  formatActiveChainsSummary,
  buildActiveChainsMenu,
} from './routes.js';

describe('Chain Visibility Settings', () => {
  it('defaults to all chains visible when hidden_chains is undefined or empty', () => {
    expect(isChainVisible(null, 'near')).toBe(true);
    expect(isChainVisible(undefined, 'solana')).toBe(true);
    expect(isChainVisible({ hidden_chains: [] }, 'hyperevm')).toBe(true);
    expect(isChainVisible({ hidden_chains: [] }, 'elysium')).toBe(true);
    expect(isChainVisible({ hidden_chains: [] }, 'sui')).toBe(true);
    expect(isChainVisible({ hidden_chains: [] }, 'starknet')).toBe(true);
  });

  it('correctly reports visibility when specific chains are hidden', () => {
    const user = { hidden_chains: ['solana', 'sui', 'starknet'] };
    expect(isChainVisible(user, 'near')).toBe(true);
    expect(isChainVisible(user, 'solana')).toBe(false);
    expect(isChainVisible(user, 'sui')).toBe(false);
    expect(isChainVisible(user, 'starknet')).toBe(false);
    expect(isChainVisible(user, 'hyperevm')).toBe(true);
    expect(isChainVisible(user, 'elysium')).toBe(true);
  });

  it('safely recovers if all chains are somehow marked hidden', () => {
    const allChains = ALL_SUPPORTED_CHAINS.map(c => c.id);
    const user = { hidden_chains: allChains };
    // Safety guard ensures at least fallback to visible
    for (const chain of allChains) {
      expect(isChainVisible(user, chain)).toBe(true);
    }
  });

  it('getVisibleChains returns only active chains', () => {
    const user = { hidden_chains: ['solana', 'starknet'] };
    const visible = getVisibleChains(user);
    expect(visible).toContain('near');
    expect(visible).toContain('hyperevm');
    expect(visible).toContain('elysium');
    expect(visible).toContain('sui');
    expect(visible).not.toContain('solana');
    expect(visible).not.toContain('starknet');
  });

  it('formatActiveChainsSummary returns proper string', () => {
    expect(formatActiveChainsSummary({ hidden_chains: [] })).toBe('🌐 All Chains');
    const user = { hidden_chains: ['solana', 'hyperevm', 'elysium', 'sui', 'starknet'] };
    const summary = formatActiveChainsSummary(user);
    expect(summary).toContain('NEAR');
  });

  it('buildActiveChainsMenu builds correct keyboard with toggles and presets', () => {
    const mockUser: any = {
      id: 'test-user-id',
      telegram_id: 12345678,
      hidden_chains: ['solana'],
    };
    const menu = buildActiveChainsMenu(mockUser);
    expect(menu.text).toContain('Active Chains & Visibility');
    expect(menu.text).toContain('NEAR Protocol');
    expect(menu.text).toContain('Solana');

    // Flatten button callback data from Telegraf reply_markup
    const inlineKeyboard = menu.keyboard?.reply_markup?.inline_keyboard || [];
    const callbackDataList = inlineKeyboard.flatMap((row: any[]) =>
      row.map((btn: any) => btn.callback_data)
    );

    expect(callbackDataList).toContain('toggle_chain_vis:near');
    expect(callbackDataList).toContain('toggle_chain_vis:solana');
    expect(callbackDataList).toContain('toggle_chain_vis:hyperevm');
    expect(callbackDataList).toContain('toggle_chain_vis:elysium');
    expect(callbackDataList).toContain('toggle_chain_vis:sui');
    expect(callbackDataList).toContain('toggle_chain_vis:starknet');

    expect(callbackDataList).toContain('preset_chain_vis:near');
    expect(callbackDataList).toContain('preset_chain_vis:solana');
    expect(callbackDataList).toContain('preset_chain_vis:hyperevm');
    expect(callbackDataList).toContain('preset_chain_vis:sui');
    expect(callbackDataList).toContain('preset_chain_vis:starknet');
    expect(callbackDataList).toContain('preset_chain_vis:all');
  });
});
