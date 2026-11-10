/**
 * Compact, mobile-first buy alerts for the public @racerbotalert channel.
 *
 * Pure helpers only (no Telegram / DB access) so the layout and the
 * wealth-tier emoji bar can be unit-tested directly.
 */

// ── Wealth tiers ──────────────────────────────────────────────────────────────
//
// The emoji bar grows with the buy size in USD. Each tier uses its own
// wealth-themed emoji; inside a tier one more emoji is added every `stepUsd`.
// When a buy crosses into the next tier the emoji gets "richer" and the
// count starts again from one.
//
//   Buy size (USD)        Emoji  Label       Count inside the tier
//   under $500            🪙     BUY         +1 per $100   (max 5)
//   $500 – $1,000         💵     NICE BUY    +1 per $100   (max 6)
//   $1,000 – $2,000       💰     BIG BUY     +1 per $200   (max 5)
//   $2,000 – $5,000       💎     HUGE BUY    +1 per $500   (max 6)
//   $5,000 – $10,000      👑     ROYAL BUY   +1 per $1,000 (max 5)
//   $10,000 – $25,000     🏦     MEGA BUY    +1 per $2,500 (max 6)
//   $25,000 and up        🐋     WHALE BUY   +1 per $5,000 (max 10)
//
// Tier boundaries belong to the higher tier (exactly $1,000 is 💰). The bar is
// capped at MAX_WEALTH_EMOJIS so even a $1M buy stays on one phone line.

export interface WealthTier {
  /** Lowest USD amount (inclusive) for this tier. */
  minUsd: number;
  emoji: string;
  label: string;
  /** Starting count of emojis for this tier. */
  baseCount: number;
  /** One more emoji is added every `stepUsd` above `minUsd`. */
  stepUsd: number;
  maxCount: number;
}

export const MAX_WEALTH_EMOJIS = 60;

export const WEALTH_TIERS: readonly WealthTier[] = [
  { minUsd: 0, emoji: '🪙', label: 'BUY', baseCount: 4, stepUsd: 60, maxCount: 12 },
  { minUsd: 500, emoji: '💵', label: 'NICE BUY', baseCount: 10, stepUsd: 40, maxCount: 22 },
  { minUsd: 1_000, emoji: '💰', label: 'BIG BUY', baseCount: 16, stepUsd: 60, maxCount: 30 },
  { minUsd: 2_000, emoji: '💎', label: 'HUGE BUY', baseCount: 22, stepUsd: 120, maxCount: 40 },
  { minUsd: 5_000, emoji: '👑', label: 'ROYAL BUY', baseCount: 30, stepUsd: 200, maxCount: 48 },
  { minUsd: 10_000, emoji: '🏦', label: 'MEGA BUY', baseCount: 38, stepUsd: 350, maxCount: 54 },
  { minUsd: 25_000, emoji: '🐋', label: 'WHALE BUY', baseCount: 46, stepUsd: 600, maxCount: MAX_WEALTH_EMOJIS },
];

export function getWealthTier(usd: number): WealthTier {
  const v = Number.isFinite(usd) && usd > 0 ? usd : 0;
  let tier = WEALTH_TIERS[0];
  for (const t of WEALTH_TIERS) {
    if (v >= t.minUsd) tier = t;
  }
  return tier;
}

/** Number of emojis to show for a buy of `usd` dollars (always generous). */
export function getWealthEmojiCount(usd: number): number {
  const tier = getWealthTier(usd);
  const v = Number.isFinite(usd) && usd > 0 ? usd : 0;
  const count = tier.baseCount + Math.floor((v - tier.minUsd) / tier.stepUsd);
  return Math.max(tier.baseCount, Math.min(count, tier.maxCount, MAX_WEALTH_EMOJIS));
}

/** e.g. $1,450 → multiple emojis representing buy volume */
export function buildWealthBar(usd: number): string {
  return getWealthTier(usd).emoji.repeat(getWealthEmojiCount(usd));
}

// ── Formatting helpers ────────────────────────────────────────────────────────

export function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function trimNum(n: number, decimals: number): string {
  return n.toFixed(decimals).replace(/\.?0+$/, '');
}

/** 950 → "950", 12_500 → "12.5K", 3_400_000 → "3.4M" */
export function compactNumber(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1e12) return `${trimNum(n / 1e12, 2)}T`;
  if (n >= 1e9) return `${trimNum(n / 1e9, 2)}B`;
  if (n >= 1e6) return `${trimNum(n / 1e6, 2)}M`;
  if (n >= 1e4) return `${trimNum(n / 1e3, 1)}K`;
  if (n >= 100) return Math.round(n).toLocaleString('en-US');
  if (n >= 1) return trimNum(n, 2);
  return trimNum(n, 4) || '0';
}

/** Buy size: "$850", "$1,450", "$48.50" */
export function formatBuyUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0';
  if (usd >= 100) return `$${Math.round(usd).toLocaleString('en-US')}`;
  return `$${usd.toFixed(2)}`;
}

export function formatPriceUsd(price: number): string {
  if (!price || isNaN(price) || price <= 0) return '';
  if (price >= 1000) {
    return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  if (price >= 1) {
    return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  }
  if (price >= 0.01) {
    return price.toFixed(4);
  }
  if (price >= 0.0001) {
    return price.toFixed(6).replace(/0+$/, '');
  }
  // Micro-prices: up to 12 decimals, trailing zeros stripped, never exponential
  const str = price.toFixed(12).replace(/0+$/, '');
  return str.length > 0 ? str : price.toFixed(8);
}

/**
 * "170.0000 NEAR" → "170 NEAR", "12500 NEAR" → "12.5K NEAR".
 * Returns '' when the value is not a native amount (e.g. a "$…" fallback).
 */
export function compactNativeAmount(spentNative?: string): string {
  const raw = String(spentNative ?? '').trim();
  const m = raw.match(/^([0-9][0-9.,]*)\s*([A-Za-z.$]*)/);
  if (!m) return '';
  const num = parseFloat(m[1].replace(/,/g, ''));
  if (!Number.isFinite(num) || num <= 0) return '';
  const unit = m[2] || '';
  return unit ? `${compactNumber(num)} ${unit}` : compactNumber(num);
}

/** "25,000,000,000 BLACKDRAGON" → "25B" */
export function compactTokenAmount(tokensReceived?: string): string {
  const raw = String(tokensReceived ?? '').trim();
  const m = raw.match(/^([0-9][0-9.,]*)\s*([KMBT])?\b/i);
  if (!m) return '';
  let num = parseFloat(m[1].replace(/,/g, ''));
  if (!Number.isFinite(num) || num <= 0) return '';
  const suffix = (m[2] || '').toUpperCase();
  const mult: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
  if (suffix) num *= mult[suffix];
  return compactNumber(num);
}

/** Wallet display: keep readable NEAR names and full addresses unabbreviated for 1-tap copy. */
export function shortWallet(addr?: string): string {
  const a = String(addr ?? '').trim();
  if (!a || a === 'Unknown') return 'Anon';
  return a;
}

// ── Message layout ────────────────────────────────────────────────────────────

export interface ChannelBuyAlertInput {
  /** Display name for the chain, e.g. "NEAR". */
  chainLabel: string;
  tokenName: string;
  tokenSymbol: string;
  tokenAddress: string;
  spentUsd: number;
  /** Native amount as reported, e.g. "170.0000 NEAR". */
  spentNative?: string;
  /** Tokens bought, e.g. "25,000,000,000 BLACKDRAGON". */
  tokensReceived?: string;
  priceUsd?: number | null;
  marketCapUsd?: number | null;
  buyerAddress?: string;
  /** Explorer page for the buyer; if set, the wallet becomes a link. */
  buyerUrl?: string;
  /** Optional short venue name, e.g. "Meme.Cooking". */
  venue?: string;
  isBondingCurve?: boolean;
}

/**
 * Builds the compact channel alert (Telegram HTML). At most 6 short lines:
 *
 *   💰💰💰 BIG BUY · NEAR
 *   Black Dragon $BLACKDRAGON
 *   💸 $1,450 (290 NEAR) → 25B
 *   📊 MC $3.4M ($3,400,000) · 💲0.000000034
 *   👤 dragonwhale.near · Meme.Cooking
 *   blackdragon.tkn.near            ← tap to copy
 */
export function buildChannelBuyAlertText(input: ChannelBuyAlertInput): string {
  const tier = getWealthTier(input.spentUsd);
  const bar = buildWealthBar(input.spentUsd);
  const symbol = (input.tokenSymbol || 'TOKEN').toUpperCase().replace(/^\$/, '');
  const name = (input.tokenName || '').trim();
  const showName = name && name.toUpperCase() !== symbol && !name.includes('.near');

  const lines: string[] = [];

  lines.push(`${bar} <b>${tier.label}</b> · ${escapeHtml(input.chainLabel)}`);

  lines.push(
    showName
      ? `<b>${escapeHtml(name)}</b> $${escapeHtml(symbol)}`
      : `<b>$${escapeHtml(symbol)}</b>`
  );

  const native = compactNativeAmount(input.spentNative);
  const got = compactTokenAmount(input.tokensReceived);
  lines.push(
    `💸 <b>${formatBuyUsd(input.spentUsd)}</b>` +
      (native && !native.startsWith('$') ? ` (${escapeHtml(native)})` : '') +
      (got ? ` → ${got}` : '')
  );

  const stats: string[] = [];
  if (input.marketCapUsd && input.marketCapUsd > 0) {
    const compactMc = compactNumber(input.marketCapUsd);
    const exactMc = `$${Math.round(input.marketCapUsd).toLocaleString('en-US')}`;
    const mcDisplay = input.marketCapUsd >= 10_000
      ? `MC <b>$${compactMc}</b> (${exactMc})`
      : `MC <b>${exactMc}</b> ($${compactMc})`;
    const suffix = input.isBondingCurve ? ' • <i>Bonding Curve</i>' : '';
    stats.push(`${mcDisplay}${suffix}`);
  }
  const price = input.priceUsd && input.priceUsd > 0 ? formatPriceUsd(input.priceUsd) : '';
  if (price) stats.push(`💲${price}`);
  if (stats.length) lines.push(`📊 ${stats.join(' · ')}`);

  const wallet = shortWallet(input.buyerAddress);
  const walletCode = wallet !== 'Anon' ? `<code>${escapeHtml(wallet)}</code>` : 'Anon';
  const walletHtml = input.buyerUrl && wallet !== 'Anon' ? `<a href="${input.buyerUrl}">${walletCode}</a>` : walletCode;
  lines.push(`👤 ${walletHtml}` + (input.venue ? ` · ${escapeHtml(input.venue)}` : ''));

  lines.push(`<code>${escapeHtml(input.tokenAddress)}</code>`);

  return lines.join('\n');
}
