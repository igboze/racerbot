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

const W = 1080;
const H = 1350;

// ── Tier themes: each tier reads as a step up (colour, frame, emblem) ────────

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
  // Rookie — brushed steel
  { accent: '#8d99ab', light: '#d5dce6', bgTop: '#161b23', bgBottom: '#0a0d12', metal: ['#e3e8ef', '#9aa5b5', '#4c5563'] },
  // Street Racer — neon teal
  { accent: '#2ee6c9', light: '#b6fff2', bgTop: '#08262a', bgBottom: '#050d12', metal: ['#c8fff5', '#2ee6c9', '#0b6e66'] },
  // Circuit Racer — electric blue
  { accent: '#3d8bff', light: '#c4dcff', bgTop: '#0a1a3c', bgBottom: '#050915', metal: ['#d6e6ff', '#3d8bff', '#123c8a'] },
  // Pro Driver — violet
  { accent: '#a66bff', light: '#e2d2ff', bgTop: '#1e0f3d', bgBottom: '#080515', metal: ['#efe4ff', '#a66bff', '#4a1f8f'] },
  // Grand Prix — racing red
  { accent: '#ff3b4e', light: '#ffc9ce', bgTop: '#3a0910', bgBottom: '#0f0407', metal: ['#ffd9dd', '#ff3b4e', '#7d0b18'] },
  // Champion — gold
  { accent: '#f5c542', light: '#ffeeb0', bgTop: '#2e2205', bgBottom: '#0c0902', metal: ['#fff4c4', '#f5c542', '#8a5f08'] },
  // Legend — holographic on black
  { accent: '#c9a7ff', light: '#f3eaff', bgTop: '#0d0b1a', bgBottom: '#000000', metal: HOLO },
];

const FINISHES: Record<Finish, { label: string; plate: string; ink: string }> = {
  bronze: { label: 'BRONZE FINISH', plate: 'linear-gradient(135deg, #f3c398 0%, #b8682e 55%, #6e3a16 100%)', ink: '#1d0e04' },
  silver: { label: 'SILVER FINISH', plate: 'linear-gradient(135deg, #ffffff 0%, #b9c4d2 50%, #6b788a 100%)', ink: '#141a22' },
  gold: { label: 'GOLD FINISH', plate: 'linear-gradient(135deg, #fff1b8 0%, #f5c542 50%, #a57610 100%)', ink: '#2a1d02' },
  holo: { label: 'HOLO FINISH', plate: 'linear-gradient(135deg, #ff8ad8 0%, #b69bff 35%, #7fd4ff 70%, #9dffcb 100%)', ink: '#15102a' },
};

export function tierTheme(tierIndex: number): TierTheme {
  return TIER_THEMES[Math.max(0, Math.min(TIER_THEMES.length - 1, tierIndex))];
}

let fontMedium: Buffer | null = null;
let fontBold: Buffer | null = null;
let fontBlack: Buffer | null = null;
let logoB64 = '';
let assetsInitialized = false;

function initAssets(): void {
  if (assetsInitialized) return;
  assetsInitialized = true;
  try {
    const fMed = resolveFont('Orbitron-Medium.ttf');
    if (fMed) fontMedium = fs.readFileSync(fMed);
    const fBold = resolveFont('Orbitron-Bold.ttf');
    if (fBold) fontBold = fs.readFileSync(fBold);
    const fBlack = resolveFont('Orbitron-Black.ttf') || fBold;
    if (fBlack) fontBlack = fs.readFileSync(fBlack);
    const logo = resolveAsset('racerbot-logo.png');
    if (logo) logoB64 = `data:image/png;base64,${fs.readFileSync(logo).toString('base64')}`;
  } catch (err) {
    console.warn('[RACER_CARD_IMAGE] Asset initialization warning:', err);
  }
}

/** The card is built from an HTML string, so escape anything user-derived. */
function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
}

function svgUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function gradientStops(colors: string[]): string {
  return colors.map((c, i) => `<stop offset="${Math.round((i / (colors.length - 1)) * 100)}%" stop-color="${c}"/>`).join('');
}

function star(cx: number, cy: number, r: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 === 0 ? r : r * 0.45;
    pts.push(`${(cx + rr * Math.cos(a)).toFixed(1)},${(cy + rr * Math.sin(a)).toFixed(1)}`);
  }
  return pts.join(' ');
}

// ── Background + frame (one full-card SVG layer) ─────────────────────────────

function backgroundSvg(tier: number, t: TierTheme): string {
  const parts: string[] = [];
  const holo = tier >= 6;

  // Speed lines: more of them, and brighter, per tier
  const lines = tier * 5;
  for (let i = 0; i < lines; i++) {
    const y = 120 + ((i * 197) % 1100);
    const x = (i * 331) % 900;
    const len = 120 + ((i * 53) % 260);
    parts.push(`<line x1="${x}" y1="${y}" x2="${x + len}" y2="${y - len * 0.36}" stroke="${t.accent}" stroke-opacity="${0.05 + tier * 0.012}" stroke-width="${2 + (i % 3)}" stroke-linecap="round"/>`);
  }

  // Legend: star dust
  if (holo) {
    for (let i = 0; i < 70; i++) {
      const x = (i * 467) % W;
      const y = (i * 739) % H;
      parts.push(`<circle cx="${x}" cy="${y}" r="${1 + (i % 3)}" fill="${HOLO[i % 3]}" fill-opacity="${0.25 + (i % 4) * 0.12}"/>`);
    }
  }

  // Grand Prix and up: a checkered strip above the footer
  if (tier >= 4) {
    const sq = 22;
    for (let c = 0; c < Math.ceil((W - 140) / sq); c++) {
      for (let r = 0; r < 1; r++) {
        if ((c + r) % 2 === 0) parts.push(`<rect x="${70 + c * sq}" y="${1090 + r * sq}" width="${sq}" height="${sq}" fill="${holo ? 'url(#holo)' : t.light}" fill-opacity="0.22"/>`);
      }
    }
  }

  // Frame: every tier adds a layer
  const stroke = tier >= 6 ? 'url(#holo)' : tier >= 5 ? 'url(#metal)' : t.accent;
  const outerW = 2 + Math.min(tier, 5);
  parts.push(`<rect x="24" y="24" width="${W - 48}" height="${H - 48}" rx="40" fill="none" stroke="${stroke}" stroke-width="${outerW}" stroke-opacity="${tier === 0 ? 0.5 : 0.9}"/>`);
  if (tier >= 2) {
    parts.push(`<rect x="44" y="44" width="${W - 88}" height="${H - 88}" rx="28" fill="none" stroke="${stroke}" stroke-width="2" stroke-opacity="0.45"/>`);
  }
  if (tier >= 1) {
    const L = 70 + tier * 10;
    const sw = 6 + tier;
    const c = (x: number, y: number, dx: number, dy: number) =>
      `<path d="M${x} ${y + dy * L} L${x} ${y} L${x + dx * L} ${y}" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`;
    parts.push(c(34, 34, 1, 1), c(W - 34, 34, -1, 1), c(34, H - 34, 1, -1), c(W - 34, H - 34, -1, -1));
  }
  if (tier >= 3) {
    // Side chevrons
    for (let i = 0; i < tier - 1; i++) {
      const y = H / 2 - 60 + i * 34;
      parts.push(`<path d="M30 ${y} L52 ${y + 14} L30 ${y + 28}" fill="none" stroke="${stroke}" stroke-width="5" stroke-opacity="0.8"/>`);
      parts.push(`<path d="M${W - 30} ${y} L${W - 52} ${y + 14} L${W - 30} ${y + 28}" fill="none" stroke="${stroke}" stroke-width="5" stroke-opacity="0.8"/>`);
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${t.bgTop}"/><stop offset="100%" stop-color="${t.bgBottom}"/></linearGradient>
      <radialGradient id="glow" cx="50%" cy="27%" r="55%"><stop offset="0%" stop-color="${t.accent}" stop-opacity="${0.22 + tier * 0.03}"/><stop offset="100%" stop-color="${t.accent}" stop-opacity="0"/></radialGradient>
      <linearGradient id="metal" x1="0" y1="0" x2="1" y2="1">${gradientStops(t.metal)}</linearGradient>
      <linearGradient id="holo" x1="0" y1="0" x2="1" y2="1">${gradientStops([...HOLO, '#ff8ad8'])}</linearGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#bg)"/>
    <rect width="${W}" height="${H}" fill="url(#glow)"/>
    ${parts.join('\n')}
  </svg>`;
}

// ── Emblem: a shape that gains wings, stars, laurels and a crown per tier ────

const SHIELD = 'M180 30 L300 75 L300 175 C300 255 245 305 180 335 C115 305 60 255 60 175 L60 75 Z';
const HEXAGON = 'M180 35 L305 107 L305 253 L180 325 L55 253 L55 107 Z';

function emblemSvg(tier: number, t: TierTheme): string {
  const parts: string[] = [];
  const fill = 'url(#em)';

  // Laurels (Champion+)
  if (tier >= 5) {
    for (const side of [-1, 1]) {
      for (let i = 0; i < 8; i++) {
        const a = (Math.PI / 180) * (115 + i * 15);
        const x = 180 + side * -Math.cos(a) * 178;
        const y = 185 + Math.sin(a) * 178;
        const rot = side * (i * 15 + 25);
        parts.push(`<ellipse cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="20" ry="9" transform="rotate(${rot} ${x.toFixed(1)} ${y.toFixed(1)})" fill="${fill}"/>`);
      }
    }
  }

  // Wings (Pro Driver+): more feathers per tier
  if (tier >= 3) {
    const feathers = Math.min(5, tier);
    const wing: string[] = [];
    for (let i = 0; i < feathers; i++) {
      wing.push(`<path d="M66 ${110 + i * 32} L${-6 + i * 12} ${86 + i * 40} L${26 + i * 8} ${132 + i * 34} Z" fill="${fill}" fill-opacity="${1 - i * 0.12}"/>`);
    }
    parts.push(`<g>${wing.join('')}</g>`, `<g transform="translate(360 0) scale(-1 1)">${wing.join('')}</g>`);
  }

  // Main shape
  if (tier === 0) {
    parts.push(`<circle cx="180" cy="180" r="140" fill="none" stroke="${fill}" stroke-width="16"/>`);
    parts.push(`<circle cx="180" cy="180" r="116" fill="#0b0f15"/>`);
  } else {
    const d = tier === 2 ? HEXAGON : SHIELD;
    parts.push(`<path d="${d}" fill="${fill}"/>`);
    parts.push(`<path d="${d}" fill="#0a0d14" transform="translate(180 182) scale(0.84) translate(-180 -180)"/>`);
    if (tier >= 2) {
      parts.push(`<path d="${d}" fill="none" stroke="${fill}" stroke-width="3" stroke-opacity="0.7" transform="translate(180 182) scale(0.74) translate(-180 -180)"/>`);
    }
  }

  // Stars (Grand Prix 1, Champion 2, Legend 3)
  const stars = Math.max(0, tier - 3);
  for (let i = 0; i < stars; i++) {
    const x = 180 + (i - (stars - 1) / 2) * 52;
    parts.push(`<polygon points="${star(x, 372, 20)}" fill="${fill}"/>`);
  }

  // Crown (Champion+)
  if (tier >= 5) {
    parts.push(`<path d="M118 22 L128 -26 L156 2 L180 -42 L204 2 L232 -26 L242 22 Z" fill="${fill}"/>`);
    parts.push(`<circle cx="180" cy="-44" r="9" fill="${tier >= 6 ? '#ffffff' : t.light}"/>`);
  }

  const stops = tier >= 6 ? [...HOLO, '#ff8ad8'] : t.metal;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="440" height="460" viewBox="-40 -60 440 460">
    <defs><linearGradient id="em" x1="0" y1="0" x2="1" y2="1">${gradientStops(stops)}</linearGradient></defs>
    ${parts.join('\n')}
  </svg>`;
}

/** 1080x1350 (4:5) portrait card: fills a phone screen and posts cleanly on X. */
export async function generateRacerCardImage(d: RacerCardImageData): Promise<Buffer | null> {
  initAssets();
  if (!fontBold || !fontMedium) {
    console.warn('[RACER_CARD_IMAGE] Required Orbitron font not found, aborting image generation.');
    return null;
  }

  try {
    const tier = Math.max(0, Math.min(TIER_THEMES.length - 1, d.tierIndex));
    const t = tierTheme(tier);
    const f = FINISHES[d.finish];
    const holo = tier >= 6;
    const metalCss = `linear-gradient(135deg, ${(holo ? HOLO : t.metal).join(', ')})`;
    const title = d.rankTitle.toUpperCase();
    const titleSize = title.length > 12 ? 82 : 96;
    const progress = Math.max(0, Math.min(100, d.progressPct));

    const qrDataUrl = await QRCode.toDataURL(d.referralLink, {
      margin: 1,
      width: 176,
      color: { dark: '#0a1129', light: '#ffffff' },
    });

    const ladder = Array.from({ length: d.tierCount }, (_, i) =>
      `<div style="display: flex; width: 56px; height: 12px; border-radius: 6px; margin: 0 5px; background: ${i <= tier ? (i === tier ? metalCss : t.accent) : 'rgba(255,255,255,0.14)'};"></div>`,
    ).join('');

    const chip = (text: string, bg: string, ink: string) =>
      `<div style="display: flex; padding: 12px 28px; margin: 0 10px; border-radius: 34px; background: ${bg}; color: ${ink}; font-size: 24px; font-weight: 900; letter-spacing: 3px;">${text}</div>`;
    // No trades yet: no PnL, so no finish to show
    const chips = [
      d.hasTrades ? chip(f.label, f.plate, f.ink) : '',
      d.topPercent !== null ? chip(`TOP ${d.topPercent}%`, metalCss, '#0a0d14') : '',
    ].join('');

    let progressBlock: string;
    if (!d.hasTrades) {
      progressBlock = `<div style="display: flex; flex-direction: column; align-items: center;">
          <div style="display: flex; font-size: 44px; font-weight: 900; color: ${t.light};">READY TO RACE</div>
          <div style="display: flex; margin-top: 14px; font-size: 24px; font-weight: 500; color: #b9c6d8;">Make a first NEAR trade to climb the ranks</div>
        </div>`;
    } else if (d.nextLevelName) {
      progressBlock = `<div style="display: flex; flex-direction: column; width: 860px;">
          <div style="display: flex; justify-content: space-between; margin-bottom: 14px; font-size: 22px; font-weight: 700; color: #b9c6d8; letter-spacing: 2px;">
            <span>NEXT: ${esc(d.nextLevelName.toUpperCase())}</span><span style="color: ${t.light};">${progress}%</span>
          </div>
          <div style="display: flex; width: 860px; height: 22px; border-radius: 11px; background: rgba(255,255,255,0.12);">
            <div style="display: flex; width: ${Math.max(3, progress)}%; height: 22px; border-radius: 11px; background: ${metalCss};"></div>
          </div>
        </div>`;
    } else {
      progressBlock = `<div style="display: flex; font-size: 40px; font-weight: 900; color: ${t.light}; letter-spacing: 4px;">MAX RANK REACHED</div>`;
    }

    const badges = d.badges.length
      ? d.badges.map(b =>
        `<div style="display: flex; padding: 10px 20px; margin: 6px; border-radius: 40px; border: 2px solid ${t.accent}; background: rgba(255,255,255,0.05); color: ${t.light}; font-size: 19px; font-weight: 700; letter-spacing: 1px;">${esc(b.toUpperCase())}</div>`,
      ).join('')
      : `<div style="display: flex; color: #7f8fa8; font-size: 22px; font-weight: 500;">Badges unlock as you race</div>`;

    const logo = logoB64
      ? `<img src="${logoB64}" style="width: 64px; height: 64px; border-radius: 14px; margin-right: 18px;" />`
      : '';

    const cardHtml = html(`
      <div style="display: flex; flex-direction: column; align-items: center; position: relative; width: ${W}px; height: ${H}px; font-family: Orbitron; color: #ffffff; background-color: ${t.bgBottom}; background-image: url('${svgUri(backgroundSvg(tier, t))}'); background-size: ${W}px ${H}px;">

        <div style="display: flex; width: ${W - 160}px; justify-content: space-between; align-items: center; margin-top: 76px;">
          <div style="display: flex; align-items: center;">
            ${logo}
            <div style="display: flex; font-size: 34px; font-weight: 900; letter-spacing: 2px;">RACERBOT</div>
          </div>
          <div style="display: flex; font-size: 22px; font-weight: 700; letter-spacing: 4px; color: ${t.light};">NEAR RACER CARD</div>
        </div>

        <div style="display: flex; width: 400px; height: 418px; margin-top: 20px; align-items: center; justify-content: center; background-image: url('${svgUri(emblemSvg(tier, t))}'); background-size: 400px 418px;">
          <div style="display: flex; margin-top: 10px; font-size: ${d.levelLabel.length > 2 ? 96 : 112}px; font-weight: 900; color: ${t.light};">${esc(d.levelLabel)}</div>
        </div>

        <div style="display: flex; margin-top: 4px; font-size: ${titleSize}px; font-weight: 900; letter-spacing: 2px; line-height: 1;">${esc(title)}</div>
        <div style="display: flex; margin-top: 16px; font-size: 28px; font-weight: 700; letter-spacing: 8px; color: ${t.accent};">LEVEL ${esc(d.levelLabel)}</div>
        <div style="display: flex; margin-top: 24px;">${ladder}</div>

        <div style="display: flex; margin-top: 30px;">${chips}</div>
        <div style="display: flex; margin-top: 32px;">${progressBlock}</div>
        <div style="display: flex; flex-wrap: wrap; justify-content: center; width: 940px; margin-top: 20px;">${badges}</div>

        <div style="display: flex; position: absolute; left: 80px; right: 80px; bottom: 76px; align-items: center; justify-content: space-between;">
          <div style="display: flex; flex-direction: column;">
            <div style="display: flex; font-size: 32px; font-weight: 900; letter-spacing: 2px;">RACE ME ON NEAR</div>
            <div style="display: flex; margin-top: 10px; font-size: 24px; font-weight: 500; color: #b9c6d8;">t.me/racertradingbot</div>
            <div style="display: flex; margin-top: 8px; font-size: 26px; font-weight: 700; color: ${t.light};">REF: ${esc(d.referralCode)}</div>
          </div>
          <img src="${qrDataUrl}" style="width: 176px; height: 176px; border-radius: 12px;" />
        </div>
      </div>
    `);

    const svg = await satori(cardHtml as any, {
      width: W,
      height: H,
      fonts: [
        { name: 'Orbitron', data: fontMedium, weight: 500, style: 'normal' },
        { name: 'Orbitron', data: fontBold, weight: 700, style: 'normal' },
        { name: 'Orbitron', data: fontBlack || fontBold, weight: 900, style: 'normal' },
      ],
    });

    const png = new Resvg(svg, { fitTo: { mode: 'width', value: W } }).render().asPng();
    return Buffer.from(png);
  } catch (err: any) {
    console.error('[RACER_CARD_IMAGE] Error generating Racer Card image:', err);
    return null;
  }
}
