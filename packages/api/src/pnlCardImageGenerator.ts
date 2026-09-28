import { PNLCardData } from './pnlCardGenerator.js';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Palette ─────────────────────────────────────────────────────────────────
// Flat, solid colors only. No gradients, no alpha, no glow.
// Green and red are reserved for profit and loss. Cyan is the brand accent.
const C = {
  ink: '#0B0B0B',
  paper: '#FFFFFF',
  dim: '#A3A3A3',
  win: '#1FFF7A',
  loss: '#FF3B3B',
  cyan: '#00F0FF',
};

// ── Fonts ───────────────────────────────────────────────────────────────────
// node-canvas → pango/fontconfig font matching is unreliable across platforms
// (Windows vs Linux, aliases vs real family names, multi-face families where
// only the last-registered face is reachable). Instead of guessing one font
// string, we register the faces, then EMPIRICALLY PROBE which CSS font string
// renders without a native "couldn't load font" warning (captured by
// intercepting stderr during a tiny probe render). The first working spec per
// role wins; sans-serif is the last-resort fallback. Files: packages/api/fonts.
const FONT_FILES: Array<{ file: string; family: string; weight?: string; style?: string }> = [
  { file: 'BarlowCondensed-BlackItalic.ttf', family: 'Barlow Condensed', weight: '900', style: 'italic' },
  { file: 'BarlowCondensed-ExtraBold.ttf', family: 'Barlow Condensed', weight: '800' },
  { file: 'IBMPlexMono-Medium.ttf', family: 'IBM Plex Mono', weight: '500' },
  { file: 'IBMPlexMono-Bold.ttf', family: 'IBM Plex Mono', weight: '700' },
];

let canvasModule: any = null;
try {
  canvasModule = require('canvas');
  if (canvasModule && typeof canvasModule.registerFont === 'function') {
    const resolveFont = (filename: string): string | null => {
      const candidates = [
        path.join(__dirname, '..', 'fonts', filename),
        path.join(process.cwd(), 'packages', 'api', 'fonts', filename),
        path.join(process.cwd(), 'fonts', filename),
        path.join(__dirname, 'fonts', filename),
      ];
      for (const p of candidates) {
        if (fs.existsSync(p)) return p;
      }
      return null;
    };

    for (const def of FONT_FILES) {
      const fontPath = resolveFont(def.file);
      if (!fontPath) {
        console.warn(`[PNL_CARD_IMAGE] Font file missing: ${def.file}. Card will render with a fallback font.`);
        continue;
      }
      try {
        canvasModule.registerFont(fontPath, { family: def.family, ...(def.weight ? { weight: def.weight } : {}), ...(def.style ? { style: def.style } : {}) });
      } catch (err: any) {
        console.warn(`[PNL_CARD_IMAGE] Could not register ${def.file}: ${err?.message ?? err}`);
      }
    }
  }
} catch {
  console.warn('[PNL_CARD_IMAGE] Canvas not available. PNL cards will be text-only.');
}

type FontRole = 'display' | 'head' | 'mono' | 'monoBold';

/** Candidate font-string templates per role, most-desired first. */
const FONT_CANDIDATES: Record<FontRole, Array<(px: number) => string>> = {
  display: [
    (px) => `italic 900 ${px}px "Barlow Condensed"`,
    (px) => `900 ${px}px "Barlow Condensed"`,
    (px) => `${px}px "Barlow Condensed"`, // BlackItalic glyphs are inherently slanted
    (px) => `italic 900 ${px}px Barlow Condensed`,
    (px) => `bold italic ${px}px "Arial Narrow", sans-serif`,
  ],
  head: [
    (px) => `800 ${px}px "Barlow Condensed"`,
    (px) => `700 ${px}px "Barlow Condensed"`,
    (px) => `bold ${px}px "Barlow Condensed"`,
    (px) => `${px}px "Barlow Condensed"`,
    (px) => `bold ${px}px "Arial Narrow", sans-serif`,
  ],
  mono: [
    (px) => `500 ${px}px "IBM Plex Mono"`,
    (px) => `${px}px "IBM Plex Mono"`,
    (px) => `${px}px "DejaVu Sans Mono", monospace`,
  ],
  monoBold: [
    (px) => `700 ${px}px "IBM Plex Mono"`,
    (px) => `bold ${px}px "IBM Plex Mono"`,
    (px) => `bold ${px}px "DejaVu Sans Mono", monospace`,
  ],
};

/** Probe one candidate: returns true if node-canvas resolved it without a native font warning. */
function probeFont(template: (px: number) => string): boolean {
  if (!canvasModule) return false;
  try {
    const c = canvasModule.createCanvas(16, 16);
    const ctx = c.getContext('2d');
    const stderrWrite = process.stderr.write;
    let warned = false;
    (process.stderr as any).write = (chunk: any) => {
      if (String(chunk).includes("couldn't load font")) warned = true;
      return true;
    };
    try {
      ctx.font = template(10);
      ctx.fillText('Ag', 0, 10);
      c.toBuffer('image/png');
    } finally {
      (process.stderr as any).write = stderrWrite;
    }
    return !warned;
  } catch {
    return false;
  }
}

/** Lazily resolved font stack — probed once, reused for every card. */
const fontStack: Record<FontRole, (px: number) => string> = {
  display: (px) => `bold italic ${px}px sans-serif`,
  head: (px) => `bold ${px}px sans-serif`,
  mono: (px) => `${px}px monospace`,
  monoBold: (px) => `bold ${px}px monospace`,
};

let fontsProbed = false;
function ensureFontsProbed(): void {
  if (fontsProbed || !canvasModule) return;
  fontsProbed = true;
  for (const role of Object.keys(FONT_CANDIDATES) as FontRole[]) {
    for (const candidate of FONT_CANDIDATES[role]) {
      if (probeFont(candidate)) {
        fontStack[role] = candidate;
        break;
      }
    }
  }
}

const resolveLogo = (): string | null => {
  const candidates = [
    path.join(__dirname, '..', 'assets', 'logo.png'),
    path.join(process.cwd(), 'packages', 'api', 'assets', 'logo.png'),
    path.join(process.cwd(), 'assets', 'logo.png'),
    path.join(__dirname, 'assets', 'logo.png'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
};

// ── Formatters ──────────────────────────────────────────────────────────────

/** Compact USD formatter. The minus sign goes before the dollar sign: -$5.00 */
function fmtUsd(nearValue: number, nr: number): string {
  const v = nearValue * nr;
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (a === 0) return '$0.00';
  if (a >= 1_000_000) return `${sign}$${(a / 1_000_000).toFixed(2)}M`;
  if (a >= 1_000) return `${sign}$${(a / 1_000).toFixed(2)}K`;
  if (a >= 1) return `${sign}$${a.toFixed(2)}`;
  if (a >= 0.0001) return `${sign}$${a.toFixed(4)}`;
  return `${sign}$${a.toFixed(6)}`;
}

/** Compact market-cap formatter */
function fmtMcap(nearValue: number, nr: number): string {
  if (!nearValue || nearValue <= 0) return 'N/A';
  const v = nearValue * nr;
  if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(2)}K`;
  return `$${v.toFixed(2)}`;
}

// ── Canvas helpers ──────────────────────────────────────────────────────────

/** Largest font size (stepping down from maxPx) at which the text fits maxW. */
function fitSize(ctx: any, text: string, fontFn: (px: number) => string, maxPx: number, minPx: number, maxW: number): number {
  let size = maxPx;
  ctx.font = fontFn(size);
  while (size > minPx && ctx.measureText(text).width > maxW) {
    size -= 4;
    ctx.font = fontFn(size);
  }
  return size;
}

/** Cut text with an ellipsis so it fits maxW in the current font. */
function ellipsize(ctx: any, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}

/** Left-aligned text with manual letter spacing. Returns the drawn width. */
function drawSpaced(ctx: any, text: string, x: number, y: number, spacing: number): number {
  let cx = x;
  for (const ch of text) {
    ctx.fillText(ch, cx, y);
    cx += ctx.measureText(ch).width + spacing;
  }
  return cx - x - spacing;
}

/**
 * Generate the PNL card image.
 *
 * Layout (1200 wide):
 *   checkered strip, brand header + status tag, token line,
 *   one flat color slab holding the giant PNL %, a ruled stats grid,
 *   and a footer. The net worth row only renders when data.showNetWorth is on.
 */
export async function generatePNLCardImage(data: PNLCardData): Promise<Buffer | null> {
  if (!canvasModule) return null;
  ensureFontsProbed();

  try {
    const { createCanvas, loadImage } = canvasModule;
    const nr = data.nearUsd || 1;

    const W = 1200;
    const PAD = 48;
    const INNER = W - PAD * 2;
    const STRIP = 24;
    const RULE = 4;

    const SLAB_Y = 212;
    const SLAB_H = 280;
    const SHADOW = 12;
    const STATS_Y = SLAB_Y + SLAB_H + SHADOW + 30;
    const ROW_H = 130;
    const rows = data.showNetWorth ? 2 : 1;
    const statsBottom = STATS_Y + ROW_H * rows;
    const H = statsBottom + 76;

    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    ctx.textBaseline = 'alphabetic';

    const accent = data.isProfit ? C.win : C.loss;

    // 1. Background: one solid color.
    ctx.fillStyle = C.ink;
    ctx.fillRect(0, 0, W, H);

    // 2. Checkered strip across the top.
    const CELL = STRIP / 2;
    ctx.fillStyle = C.paper;
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < Math.ceil(W / CELL); c++) {
        if ((r + c) % 2 === 0) ctx.fillRect(c * CELL, r * CELL, CELL, CELL);
      }
    }

    // 3. Brand header.
    let logoImg: any = null;
    const logoPath = resolveLogo();
    if (logoPath && typeof loadImage === 'function') {
      try { logoImg = await loadImage(logoPath); } catch { /* draw wordmark only */ }
    }
    let wordX = PAD;
    if (logoImg) {
      ctx.drawImage(logoImg, PAD, 46, 64, 64);
      // Flat white ring so the dark badge stays visible on the black card.
      ctx.strokeStyle = C.paper;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(PAD + 32, 78, 31, 0, Math.PI * 2);
      ctx.stroke();
      wordX = PAD + 82;
    }
    ctx.fillStyle = C.paper;
    ctx.textAlign = 'left';
    ctx.font = fontStack.display(50);
    drawSpaced(ctx, 'RACERBOT', wordX, 94, 3);

    // Status tag: solid block, hard corners.
    const isOpen = data.positionStatus === 'open';
    const tagText = isOpen ? 'OPEN POSITION' : 'CLOSED';
    ctx.font = fontStack.monoBold(20);
    const tagW = ctx.measureText(tagText).width + 40;
    const tagX = W - PAD - tagW;
    ctx.fillStyle = isOpen ? C.cyan : C.paper;
    ctx.fillRect(tagX, 56, tagW, 44);
    ctx.fillStyle = C.ink;
    ctx.fillText(tagText, tagX + 20, 86);

    // 4. Token line.
    const symbol = String(data.tokenSymbol || '').toUpperCase();
    ctx.font = fontStack.head(68);
    ctx.fillStyle = C.paper;
    ctx.fillText(symbol, PAD, 178);
    const symW = ctx.measureText(symbol).width;
    ctx.font = fontStack.mono(24);
    ctx.fillStyle = C.dim;
    const nameMaxW = INNER - symW - 24;
    ctx.fillText(ellipsize(ctx, String(data.tokenName || ''), nameMaxW), PAD + symW + 24, 178);

    // 5. The slab: one flat color, hard offset block behind it.
    ctx.fillStyle = C.paper;
    ctx.fillRect(PAD + SHADOW, SLAB_Y + SHADOW, INNER, SLAB_H);
    ctx.fillStyle = accent;
    ctx.fillRect(PAD, SLAB_Y, INNER, SLAB_H);

    ctx.fillStyle = C.ink;
    ctx.font = fontStack.monoBold(20);
    ctx.fillText(isOpen ? 'UNREALIZED PNL' : 'REALIZED PNL', PAD + 28, SLAB_Y + 46);

    const sign = data.isProfit ? '+' : '';
    const pnlText = `${sign}${data.pnlPercent.toFixed(2)}%`;
    const heroSize = fitSize(ctx, pnlText, fontStack.display, 265, 110, INNER - 56);
    ctx.font = fontStack.display(heroSize);
    ctx.fillStyle = C.ink;
    ctx.fillText(pnlText, PAD + 24, SLAB_Y + SLAB_H - 26);

    // 6. Stats grid: hard rules, no boxes, no fills.
    const COL_W = INNER / 3;
    const cell = (i: number, rowTop: number, label: string, value: string, valueColor: string = C.paper) => {
      const colX = PAD + i * COL_W;
      ctx.fillStyle = C.paper;
      ctx.fillRect(colX, rowTop, COL_W, RULE);
      if (i > 0) ctx.fillRect(colX, rowTop, RULE, ROW_H);
      const tx = colX + (i === 0 ? 0 : 28);
      ctx.fillStyle = C.dim;
      ctx.font = fontStack.mono(17);
      ctx.fillText(label, tx, rowTop + 44);
      ctx.fillStyle = valueColor;
      const vSize = fitSize(ctx, value, fontStack.head, 60, 34, COL_W - (i === 0 ? 28 : 56));
      ctx.font = fontStack.head(vSize);
      ctx.fillText(value, tx, rowTop + 106);
    };

    cell(0, STATS_Y, 'ENTRY MARKET CAP', fmtMcap(data.entryMarketCap, nr));
    cell(1, STATS_Y, 'CURRENT MARKET CAP', fmtMcap(data.currentMarketCap, nr));
    cell(2, STATS_Y, 'HOLD TIME', String(data.holdDuration || '-'));

    if (data.showNetWorth) {
      const row2 = STATS_Y + ROW_H;
      const usePnlUnrealized = isOpen && data.realizedPnl === 0;
      const pnlNum = usePnlUnrealized ? data.unrealizedPnl : data.realizedPnl;
      cell(0, row2, 'INVESTED', fmtUsd(data.initialInvestment, nr));
      cell(1, row2, 'WORTH NOW', fmtUsd(data.unrealizedValue, nr));
      cell(
        2,
        row2,
        usePnlUnrealized ? 'UNREALIZED PNL' : 'REALIZED PNL',
        `${pnlNum >= 0 ? '+' : ''}${fmtUsd(pnlNum, nr)}`,
        pnlNum >= 0 ? C.win : C.loss,
      );
    }

    // 7. Footer.
    ctx.fillStyle = C.paper;
    ctx.fillRect(PAD, statsBottom, INNER, RULE);
    ctx.font = fontStack.mono(16);
    ctx.fillStyle = C.dim;
    ctx.textAlign = 'left';
    ctx.fillText('GENERATED BY RACERBOT', PAD, statsBottom + 48);
    ctx.font = fontStack.monoBold(20);
    ctx.fillStyle = C.cyan;
    ctx.textAlign = 'right';
    ctx.fillText('@racertradingbot', W - PAD, statsBottom + 48);

    return canvas.toBuffer('image/png') as Buffer;
  } catch (err: any) {
    console.error('[PNL_CARD_IMAGE] Error generating image:', err);
    return null;
  }
}