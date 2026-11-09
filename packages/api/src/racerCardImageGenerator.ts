import QRCode from 'qrcode';
import satori from 'satori';
import { html } from 'satori-html';
import { Resvg } from '@resvg/resvg-js';
import fs from 'fs';
import { resolveAsset, resolveFont } from './pnlCardImageGenerator.js';
import type { Finish } from './racerRank.js';

/**
 * Everything the Racer Card shows. By design there are no amounts, token names
 * or addresses here — only the rank, finish, percentile and badges.
 */
export interface RacerCardImageData {
  rankTitle: string;
  levelLabel: string;
  tierIndex: number;
  tierCount: number;
  finish: Finish;
  topPercent: number | null;
  /** 0–100 toward nextLevelName */
  progressPct: number;
  /** "Circuit Racer III"; null at the top rank */
  nextLevelName: string | null;
  hasTrades: boolean;
  badges: string[];
  referralCode: string;
  referralLink: string;
}

/**
 * The card is the supplied design artwork, one picture per rank and level
 * (assets/racer-cards/<tier>-<level>.jpg, 1200x1800). Everything on it is
 * fixed per rank except the referral code and the QR code, which are drawn on
 * top here. The artwork has the designer's sample code and QR removed.
 */
export const CARD_W = 1200;
export const CARD_H = 1800;

const TIER_SLUGS = ['rookie', 'street-racer', 'circuit-racer', 'pro-driver', 'grand-prix', 'champion', 'legend'];

/** Frame colour of each level in the design: I purple, II silver, III gold. */
export const LEVEL_COLORS = ['#7560A9', '#C0C8CD', '#F1C525'] as const;
/** Card background and text colours from the design. */
const CARD_NAVY = '#111726';
const CARD_INK = '#F6FBFC';

// Where the code and QR go, in card pixels. The level II and III artwork sits
// 2px and 4px further right than level I.
const REF_X = 103;
const REF_CAP_TOP = 1574;
const REF_CAP_HEIGHT = 19;
/** Characters that fit one line at the design's size (its sample code is 14) */
const REF_LINE_CHARS = 14;
const QR_X = 930;
const QR_Y = 1548;
const QR_SIZE = 144;

// ── Tier colours (used by the leaderboard) ───────────────────────────────────

interface TierTheme {
  accent: string;
  light: string;
  bgTop: string;
  bgBottom: string;
  /** Emblem metal, light → dark */
  metal: [string, string, string];
}

const HOLO: [string, string, string] = ['#ff8ad8', '#8fd9ff', '#9dffcb'];

export const TIER_THEMES: TierTheme[] = [
  { accent: '#8d99ab', light: '#d5dce6', bgTop: '#161b23', bgBottom: '#0a0d12', metal: ['#e3e8ef', '#9aa5b5', '#4c5563'] },
  { accent: '#2ee6c9', light: '#b6fff2', bgTop: '#08262a', bgBottom: '#050d12', metal: ['#c8fff5', '#2ee6c9', '#0b6e66'] },
  { accent: '#3d8bff', light: '#c4dcff', bgTop: '#0a1a3c', bgBottom: '#050915', metal: ['#d6e6ff', '#3d8bff', '#123c8a'] },
  { accent: '#a66bff', light: '#e2d2ff', bgTop: '#1e0f3d', bgBottom: '#080515', metal: ['#efe4ff', '#a66bff', '#4a1f8f'] },
  { accent: '#ff3b4e', light: '#ffc9ce', bgTop: '#3a0910', bgBottom: '#0f0407', metal: ['#ffd9dd', '#ff3b4e', '#7d0b18'] },
  { accent: '#f5c542', light: '#ffeeb0', bgTop: '#2e2205', bgBottom: '#0c0902', metal: ['#fff4c4', '#f5c542', '#8a5f08'] },
  { accent: '#c9a7ff', light: '#f3eaff', bgTop: '#0d0b1a', bgBottom: '#000000', metal: HOLO },
];

export function tierTheme(tierIndex: number): TierTheme {
  return TIER_THEMES[Math.max(0, Math.min(TIER_THEMES.length - 1, tierIndex))];
}

// ── Assets ───────────────────────────────────────────────────────────────────

let fontRegular: Buffer | null = null;
let fontMedium: Buffer | null = null;
let fontBold: Buffer | null = null;
let fontBlack: Buffer | null = null;
let fontsLoaded = false;
const artCache = new Map<string, string | null>();

function loadFonts(): void {
  if (fontsLoaded) return;
  fontsLoaded = true;
  try {
    // Static Regular (400), cut from the variable Orbitron.ttf: the weight of the design's small text
    const fReg = resolveFont('Orbitron-Regular.ttf');
    if (fReg) fontRegular = fs.readFileSync(fReg);
    const fMed = resolveFont('Orbitron-Medium.ttf');
    if (fMed) fontMedium = fs.readFileSync(fMed);
    const fBold = resolveFont('Orbitron-Bold.ttf');
    if (fBold) fontBold = fs.readFileSync(fBold);
    const fBlack = resolveFont('Orbitron-Black.ttf') || fBold;
    if (fBlack) fontBlack = fs.readFileSync(fBlack);
  } catch (err) {
    console.warn('[RACER_CARD_IMAGE] Font loading warning:', err);
  }
}

export function levelNumber(levelLabel: string): 1 | 2 | 3 {
  return levelLabel === 'III' ? 3 : levelLabel === 'II' ? 2 : 1;
}

/** The artwork file for a rank, e.g. "racer-cards/circuit-racer-2.jpg". */
export function racerCardArtName(tierIndex: number, levelLabel: string): string {
  const tier = TIER_SLUGS[Math.max(0, Math.min(TIER_SLUGS.length - 1, tierIndex))];
  return `racer-cards/${tier}-${levelNumber(levelLabel)}.jpg`;
}

/** The artwork as a data URI (cached), or null when the file is missing. */
function cardArt(tierIndex: number, levelLabel: string): string | null {
  const name = racerCardArtName(tierIndex, levelLabel);
  if (!artCache.has(name)) {
    const file = resolveAsset(name);
    artCache.set(name, file ? `data:image/jpeg;base64,${fs.readFileSync(file).toString('base64')}` : null);
  }
  return artCache.get(name)!;
}

/** The card is built from an HTML string, so escape anything user-derived. */
function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
}

/** Replace an <img> src placeholder in a satori-html tree. */
function setImageSrc(node: any, placeholder: string, src: string): void {
  if (!node || typeof node !== 'object') return;
  if (node.props?.src === placeholder) node.props.src = src;
  const kids = node.props?.children;
  for (const k of Array.isArray(kids) ? kids : [kids]) setImageSrc(k, placeholder, src);
}

function orbitron() {
  return [
    ...(fontRegular ? [{ name: 'Orbitron', data: fontRegular, weight: 400 as const, style: 'normal' as const }] : []),
    { name: 'Orbitron', data: fontMedium!, weight: 500 as const, style: 'normal' as const },
    { name: 'Orbitron', data: fontBold!, weight: 700 as const, style: 'normal' as const },
    { name: 'Orbitron', data: (fontBlack || fontBold)!, weight: 900 as const, style: 'normal' as const },
  ];
}

// Orbitron: cap height as a share of the font size
const ORBITRON_CAP = 0.72;

/**
 * How the referral code is set: one line at the design's size, or for a long
 * code two lines (the space below is empty), smaller only past two lines' worth.
 */
export function referralLayout(code: string): { lines: string[]; size: number } {
  const designSize = REF_CAP_HEIGHT / ORBITRON_CAP;
  if (code.length <= REF_LINE_CHARS) return { lines: [code], size: designSize };
  const perLine = Math.max(REF_LINE_CHARS, Math.ceil(code.length / 2));
  return {
    lines: [code.slice(0, perLine), code.slice(perLine)],
    size: Math.round(designSize * (REF_LINE_CHARS / perLine) * 10) / 10,
  };
}

/** 1200x1800 (2:3) portrait card: the supplied design with the racer's code and QR. */
export async function generateRacerCardImage(d: RacerCardImageData): Promise<Buffer | null> {
  loadFonts();
  const art = cardArt(d.tierIndex, d.levelLabel);
  if (!fontMedium || !fontBold || !art) {
    console.warn('[RACER_CARD_IMAGE] Card artwork or Orbitron font not found, aborting image generation.');
    return null;
  }

  try {
    const dx = (levelNumber(d.levelLabel) - 1) * 2;
    const { lines, size } = referralLayout(d.referralCode);
    // First line's caps end where the design's do. In a 1.3 line box the caps
    // start 0.14 em (Orbitron's ascent above caps) + 0.15 em (half leading) down.
    const top = REF_CAP_TOP + REF_CAP_HEIGHT - size * (ORBITRON_CAP + 0.14 + 0.15);
    const refLines = lines.map(l => `<div style="display: flex;">${esc(l)}</div>`).join('');
    const qrDataUrl = await QRCode.toDataURL(d.referralLink, {
      margin: 1,
      width: QR_SIZE * 2,
      color: { dark: CARD_NAVY, light: '#ffffff' },
    });

    const cardHtml = html(`
      <div style="display: flex; position: relative; width: ${CARD_W}px; height: ${CARD_H}px; font-family: Orbitron; background-color: ${CARD_NAVY};">
        <img src="__RACER_ART__" style="position: absolute; left: 0; top: 0; width: ${CARD_W}px; height: ${CARD_H}px;" />
        <div style="display: flex; position: absolute; left: ${REF_X + dx}px; top: ${top.toFixed(1)}px; font-size: ${size}px; flex-direction: column; line-height: 1.3; font-weight: 400; color: ${CARD_INK}; white-space: nowrap;">${refLines}</div>
        <img src="${qrDataUrl}" style="position: absolute; left: ${QR_X + dx}px; top: ${QR_Y}px; width: ${QR_SIZE}px; height: ${QR_SIZE}px;" />
      </div>
    `);
    // The artwork goes into the parsed tree, not the HTML string: satori-html is
    // very slow on a large attribute
    setImageSrc(cardHtml, '__RACER_ART__', art);

    const svg = await satori(cardHtml as any, { width: CARD_W, height: CARD_H, fonts: orbitron() });
    const png = new Resvg(svg, { fitTo: { mode: 'width', value: CARD_W } }).render().asPng();
    return Buffer.from(png);
  } catch (err: any) {
    console.error('[RACER_CARD_IMAGE] Error generating Racer Card image:', err);
    return null;
  }
}

const OG_W = 1200;
const OG_H = 630;

/**
 * 1200x630 link-preview image for X / Telegram (summary_large_image). A tall
 * card would be cropped in the timeline, so the card sits on the left and the
 * rank is spelled out on the right, in the card's own colours. Takes the
 * already-rendered card PNG.
 */
export async function generateRacerCardOgImage(d: RacerCardImageData, cardPng: Buffer): Promise<Buffer | null> {
  loadFonts();
  if (!fontBold || !fontMedium) return null;

  try {
    const accent = LEVEL_COLORS[levelNumber(d.levelLabel) - 1];
    const title = d.rankTitle.toUpperCase();
    const cardH = OG_H - 50;
    const cardW = Math.round((cardH * CARD_W) / CARD_H);
    const tagline = d.hasTrades ? 'Think you can catch me?' : 'Just joined the race';
    const top = d.topPercent !== null
      ? `<div style="display: flex; margin-top: 28px; padding: 10px 22px; border-radius: 30px; background: ${accent}; color: ${CARD_NAVY}; font-size: 22px; font-weight: 900; letter-spacing: 2px;">TOP ${d.topPercent}% OF NEAR RACERS</div>`
      : '';

    const ogHtml = html(`
      <div style="display: flex; align-items: center; width: ${OG_W}px; height: ${OG_H}px; font-family: Orbitron; color: ${CARD_INK}; background-color: ${CARD_NAVY}; border-left: 12px solid ${accent};">
        <img src="__RACER_CARD__" style="width: ${cardW}px; height: ${cardH}px; margin-left: 40px;" />
        <div style="display: flex; flex-direction: column; align-items: flex-start; margin-left: 56px; width: ${OG_W - cardW - 150}px;">
          <div style="display: flex; font-size: 24px; font-weight: 900; letter-spacing: 4px; color: ${accent};">NEAR RACER CARD</div>
          <div style="display: flex; margin-top: 18px; font-size: ${title.length > 12 ? 60 : 72}px; font-weight: 900; line-height: 1;">${esc(title)}</div>
          <div style="display: flex; margin-top: 14px; font-size: 30px; font-weight: 500; letter-spacing: 6px;">LEVEL ${esc(d.levelLabel)}</div>
          ${top}
          <div style="display: flex; margin-top: 40px; font-size: 30px; font-weight: 900;">${tagline}</div>
          <div style="display: flex; margin-top: 10px; font-size: 24px; font-weight: 500; color: #C0C8CD;">Race me: t.me/racertradingbot</div>
        </div>
      </div>
    `);
    setImageSrc(ogHtml, '__RACER_CARD__', `data:image/png;base64,${cardPng.toString('base64')}`);

    const svg = await satori(ogHtml as any, { width: OG_W, height: OG_H, fonts: orbitron() });
    return Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: OG_W } }).render().asPng());
  } catch (err: any) {
    console.error('[RACER_CARD_IMAGE] Error generating Racer Card preview image:', err);
    return null;
  }
}
