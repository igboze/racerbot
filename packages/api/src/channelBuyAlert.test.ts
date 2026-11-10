import { describe, it, expect } from 'vitest';
import {
  WEALTH_TIERS,
  MAX_WEALTH_EMOJIS,
  getWealthTier,
  getWealthEmojiCount,
  buildWealthBar,
  buildChannelBuyAlertText,
  compactNativeAmount,
  compactTokenAmount,
  compactNumber,
  formatBuyUsd,
  shortWallet,
} from './channelBuyAlert.js';

/** Visible text Telegram renders (tags stripped, entities decoded). */
function visible(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Count emoji "characters" (code points that are pictographs). */
function emojiCount(s: string): number {
  return Array.from(s).filter(c => /\p{Extended_Pictographic}/u.test(c)).length;
}

describe('wealth tiers', () => {
  it('picks the documented emoji for each buy size', () => {
    expect(getWealthTier(120).emoji).toBe('🏎️');
    expect(getWealthTier(499.99).emoji).toBe('🏎️');
    expect(getWealthTier(500).emoji).toBe('🚀');
    expect(getWealthTier(999).emoji).toBe('🚀');
    expect(getWealthTier(1_000).emoji).toBe('🔥');
    expect(getWealthTier(1_100).emoji).toBe('🔥');
    expect(getWealthTier(1_999).emoji).toBe('🔥');
    expect(getWealthTier(2_000).emoji).toBe('💰');
    expect(getWealthTier(5_000).emoji).toBe('💎');
    expect(getWealthTier(10_000).emoji).toBe('👑');
    expect(getWealthTier(25_000).emoji).toBe('🐋');
    expect(getWealthTier(5_000_000).emoji).toBe('🐋');
  });

  it('never uses generic green emojis and every tier has a different emoji', () => {
    const emojis = WEALTH_TIERS.map(t => t.emoji);
    expect(new Set(emojis).size).toBe(emojis.length);
    for (const e of emojis) {
      expect(['🟢', '✅', '💚', '🟩']).not.toContain(e);
    }
  });

  it('tiers are sorted and each tier fits on one line', () => {
    for (let i = 1; i < WEALTH_TIERS.length; i++) {
      expect(WEALTH_TIERS[i].minUsd).toBeGreaterThan(WEALTH_TIERS[i - 1].minUsd);
    }
    for (const t of WEALTH_TIERS) {
      expect(t.maxCount).toBeLessThanOrEqual(MAX_WEALTH_EMOJIS);
    }
  });

  it('adds more emojis as the amount rises inside a tier', () => {
    expect(getWealthEmojiCount(500)).toBe(10);
    expect(getWealthEmojiCount(650)).toBe(13);
    expect(getWealthEmojiCount(850)).toBe(18);
    expect(getWealthEmojiCount(999)).toBe(22);
    expect(getWealthEmojiCount(1_000)).toBe(16);
    expect(getWealthEmojiCount(1_450)).toBe(23);
    expect(getWealthEmojiCount(1_999)).toBe(30);
    expect(getWealthEmojiCount(3_000)).toBe(30);
    expect(buildWealthBar(1_450)).toBe('🔥'.repeat(23));
    expect(buildWealthBar(850)).toBe('🚀'.repeat(18));
  });

  it('caps the bar so huge buys stay bounded', () => {
    for (const usd of [25_000, 60_000, 250_000, 10_000_000]) {
      expect(getWealthEmojiCount(usd)).toBeLessThanOrEqual(MAX_WEALTH_EMOJIS);
    }
    expect(buildWealthBar(10_000_000)).toBe('🐋'.repeat(MAX_WEALTH_EMOJIS));
  });

  it('handles bad input without crashing', () => {
    expect(buildWealthBar(NaN)).toBe('🏎️'.repeat(4));
    expect(buildWealthBar(-5)).toBe('🏎️'.repeat(4));
    expect(buildWealthBar(0)).toBe('🏎️'.repeat(4));
  });
});

describe('formatters', () => {
  it('formats amounts compactly', () => {
    expect(formatBuyUsd(850)).toBe('$850');
    expect(formatBuyUsd(1449.6)).toBe('$1,450');
    expect(formatBuyUsd(48.5)).toBe('$48.50');
    expect(compactNumber(3_400_000)).toBe('3.4M');
    expect(compactNumber(12_500)).toBe('12.5K');
    expect(compactNativeAmount('170.0000 NEAR')).toBe('170 NEAR');
    expect(compactNativeAmount('12,500.5 NEAR')).toBe('12.5K NEAR');
    expect(compactNativeAmount('$120.00')).toBe('');
    expect(compactTokenAmount('25,000,000,000 BLACKDRAGON')).toBe('25B');
    expect(compactTokenAmount('1.25M LORDS')).toBe('1.25M');
    expect(compactTokenAmount('Tokens')).toBe('');
    expect(shortWallet('dragonwhale.near')).toBe('dragonwhale.near');
    expect(shortWallet('0x04a3f9c2b1d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4')).toBe('0x04a3f9c2b1d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4');
    expect(shortWallet('')).toBe('Anon');
  });
});

describe('buildChannelBuyAlertText', () => {
  const base = {
    chainLabel: 'NEAR',
    tokenName: 'Black Dragon',
    tokenSymbol: 'BLACKDRAGON',
    tokenAddress: 'blackdragon.tkn.near',
    spentUsd: 1450,
    spentNative: '290.0000 NEAR',
    tokensReceived: '25,000,000,000 BLACKDRAGON',
    priceUsd: 0.000000034,
    marketCapUsd: 3_400_000,
    buyerAddress: 'dragonwhale.near',
    buyerUrl: 'https://nearblocks.io/address/dragonwhale.near',
    venue: '🍳 Meme.Cooking',
  };

  it('renders the compact layout', () => {
    const text = buildChannelBuyAlertText(base);
    expect(text).toBe(
      [
        `${'🔥'.repeat(23)} <b>BIG BUY</b> · NEAR`,
        '<b>Black Dragon</b> $BLACKDRAGON',
        '💸 <b>$1,450</b> (290 NEAR) → 25B',
        '📊 MC <b>$3.4M</b> ($3,400,000) · 💲0.000000034',
        '👤 <a href="https://nearblocks.io/address/dragonwhale.near"><code>dragonwhale.near</code></a> · 🍳 Meme.Cooking',
        '<code>blackdragon.tkn.near</code>',
      ].join('\n')
    );
  });

  it('stays clean and readable on a phone for every tier', () => {
    for (const usd of [150, 700, 1_500, 4_000, 8_000, 20_000, 2_000_000]) {
      const text = buildChannelBuyAlertText({
        ...base,
        tokenAddress: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
        buyerAddress: '0x04a3f9c2b1d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4d3c2b1a0f9e8d7c6b5a4f3e2',
        spentUsd: usd,
      });
      const lines = text.split('\n');
      expect(lines.length).toBeLessThanOrEqual(6);
      expect(emojiCount(lines[0])).toBeLessThanOrEqual(MAX_WEALTH_EMOJIS);
      expect(text).not.toContain('🟢');
    }
  });

  it('drops missing stats instead of printing N/A', () => {
    const text = buildChannelBuyAlertText({
      ...base,
      priceUsd: null,
      marketCapUsd: null,
      spentNative: '$1450.00',
      tokensReceived: 'Tokens',
      buyerUrl: undefined,
      venue: undefined,
    });
    expect(text).not.toContain('N/A');
    expect(text).not.toContain('📊');
    expect(text).toContain('💸 <b>$1,450</b>\n');
    expect(text.split('\n').length).toBe(5);
  });

  it('escapes HTML in token names', () => {
    const text = buildChannelBuyAlertText({ ...base, tokenName: '<script>&' });
    expect(text).toContain('<b>&lt;script&gt;&amp;</b>');
  });

  it('shows only the symbol when the name repeats it', () => {
    const text = buildChannelBuyAlertText({ ...base, tokenName: 'blackdragon' });
    expect(text.split('\n')[1]).toBe('<b>$BLACKDRAGON</b>');
  });
});
