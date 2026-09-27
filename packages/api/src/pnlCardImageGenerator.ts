import { PNLCardData } from './pnlCardGenerator.js';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// Dynamic import for canvas to avoid build failures on platforms without Python
let canvasModule: any = null;
try {
  canvasModule = require('canvas');
  if (canvasModule && typeof canvasModule.registerFont === 'function') {
    const resolveFont = (filename: string) => {
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

    const reg = (file: string, family: string, weight: string) => {
      const fontPath = resolveFont(file);
      if (fontPath) {
        try { canvasModule.registerFont(fontPath, { family, weight }); } catch { /* ignore dup */ }
      }
    };

    reg('SpaceGrotesk-Bold.ttf',   'Space Grotesk', 'bold');
    reg('SpaceGrotesk-Medium.ttf', 'Space Grotesk', 'normal');
    reg('Inter-Regular.ttf',       'Inter', 'normal');
    reg('Inter-SemiBold.ttf',      'Inter', 'bold');
    reg('Inter-Bold.ttf',          'Inter', 'bold');
    reg('Roboto-Regular.ttf',      'Roboto', 'normal');
    reg('Roboto-Bold.ttf',         'Roboto', 'bold');
  }
} catch {
  console.warn('[PNL_CARD_IMAGE] Canvas not available. PNL cards will be text-only.');
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

function drawRoundedRect(ctx: any, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Compact USD formatter for investment-scale values */
function fmtUsd(nearValue: number, nr: number): string {
  const v = nearValue * nr;
  if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (Math.abs(v) >= 1_000)     return `$${(v / 1_000).toFixed(2)}K`;
  if (Math.abs(v) >= 1)         return `$${v.toFixed(2)}`;
  if (Math.abs(v) >= 0.0001)    return `$${v.toFixed(4)}`;
  return `$${v.toFixed(6)}`;
}

/** Compact market-cap formatter */
function fmtMcap(nearValue: number, nr: number): string {
  if (!nearValue || nearValue <= 0) return 'N/A';
  const v = nearValue * nr;
  if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (v >= 1_000_000)     return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000)         return `$${(v / 1_000).toFixed(2)}K`;
  return `$${v.toFixed(2)}`;
}

/**
 * Generate PNL card image using canvas.
 * Layout:
 *   • Always: big PNL %, entry/current market cap (static), realized PNL, hold duration
 *   • Conditional (data.showNetWorth): initial investment & unrealized value rows + USD subtitle
 */
export async function generatePNLCardImage(data: PNLCardData): Promise<Buffer | null> {
  if (!canvasModule) return null;

  try {
    const { createCanvas, loadImage } = canvasModule;
    const nr = data.nearUsd || 1;

    // Canvas height adjusts dynamically based on whether net worth rows are shown
    const width  = 800;
    const height = data.showNetWorth ? 640 : 540;
    const canvas = createCanvas(width, height);
    const ctx    = canvas.getContext('2d');

    const H = '"Space Grotesk", "Inter", Roboto, "DejaVu Sans", "Liberation Sans", "Arial", sans-serif';
    const B = '"Inter", Roboto, "DejaVu Sans", "Liberation Sans", "Arial", sans-serif';

    // ── 1. Background ─────────────────────────────────────────────────────────
    const bg = ctx.createLinearGradient(0, 0, 0, height);
    bg.addColorStop(0,    '#131a2c');
    bg.addColorStop(0.55, '#0d1220');
    bg.addColorStop(1,    '#080c16');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth   = 2;
    drawRoundedRect(ctx, 10, 10, width - 20, height - 20, 24);
    ctx.stroke();

    // ── 2. Brand header ───────────────────────────────────────────────────────
    let logoImg: any = null;
    const logoPath = resolveLogo();
    if (logoPath && typeof loadImage === 'function') {
      try { logoImg = await loadImage(logoPath); } catch { /* fallback */ }
    }

    if (logoImg) {
      ctx.drawImage(logoImg, 40, 22, 44, 44);
      ctx.fillStyle = '#f4f6ff';
      ctx.font      = `bold 20px ${H}`;
      ctx.textAlign = 'left';
      ctx.fillText('RacerBot', 94, 51);
    } else {
      ctx.fillStyle = '#23e6c4';
      ctx.font      = `bold 22px ${H}`;
      ctx.textAlign = 'left';
      ctx.fillText('⚡', 40, 48);
      ctx.fillStyle = '#f4f6ff';
      ctx.font      = `bold 18px ${H}`;
      ctx.fillText('RacerBot', 68, 47);
    }

    // ── 3. Token name + status pill ───────────────────────────────────────────
    ctx.textAlign = 'left';
    ctx.font      = `normal 16px ${B}`;
    ctx.fillStyle = '#78829f';
    const tokenDisplay = `${data.tokenSymbol} (${data.tokenName})`;
    ctx.fillText(tokenDisplay, 40, 105);
    const tokenW = ctx.measureText(tokenDisplay).width;

    const statusText  = data.positionStatus === 'open' ? 'OPEN POSITION' : 'CLOSED POSITION';
    const statusColor = data.positionStatus === 'open' ? '#35f2b4' : '#ff5c72';
    const statusBg    = data.positionStatus === 'open'
      ? 'rgba(53,242,180,0.12)'
      : 'rgba(255,92,114,0.12)';

    ctx.font = `bold 11px ${H}`;
    const statusW = ctx.measureText(statusText).width + 24;
    const tagX    = 40 + tokenW + 16;

    ctx.fillStyle = statusBg;
    drawRoundedRect(ctx, tagX, 90, statusW, 22, 11);
    ctx.fill();

    ctx.fillStyle = statusColor;
    ctx.beginPath();
    ctx.arc(tagX + 10, 101, 3.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = statusColor;
    ctx.fillText(statusText, tagX + 18, 105);

    // ── 4. Giant PNL % — ALWAYS shown ─────────────────────────────────────────
    const pnlSign        = data.isProfit ? '+' : '';
    const pnlPercentText = `${pnlSign}${data.pnlPercent.toFixed(2)}%`;
    const pnlColor       = data.isProfit ? '#35f2b4' : '#ff5c72';

    ctx.fillStyle = pnlColor;
    ctx.font      = `bold 64px ${H}`;
    ctx.fillText(pnlPercentText, 40, 178);

    // Sub-label: Total PNL (USD) • Bought X → Worth Y (only if showNetWorth)
    if (data.showNetWorth) {
      const boughtUsd = fmtUsd(data.initialInvestment, nr);
      const worthUsd  = fmtUsd(data.unrealizedValue, nr);
      const subText   = `Total PNL: ${pnlSign}${fmtUsd(data.totalPnl, nr)}  •  Bought ${boughtUsd} ➔ Worth ${worthUsd}`;
      ctx.fillStyle   = '#78829f';
      ctx.font        = `normal 15px ${B}`;
      ctx.fillText(subText, 40, 212);
    }

    // ── 5. Decorative accent lines ─────────────────────────────────────────────
    const lineY = 242;
    const grad  = ctx.createLinearGradient(40, 0, width - 40, 0);
    grad.addColorStop(0, '#23e6c4');
    grad.addColorStop(1, 'transparent');

    ctx.fillStyle   = grad;
    ctx.globalAlpha = 0.55;
    ctx.fillRect(40, lineY,       width - 80,        2);
    ctx.globalAlpha = 0.30;
    ctx.fillRect(40, lineY + 5,  (width - 80) * 0.62, 2);
    ctx.globalAlpha = 0.15;
    ctx.fillRect(40, lineY + 10, (width - 80) * 0.30, 2);
    ctx.globalAlpha = 1.0;

    // ── 6. Stats grid ─────────────────────────────────────────────────────────
    // Row layout:
    //   Row 1 (Static):    ENTRY MARKET CAP   | CURRENT MARKET CAP
    //   Row 2 (Optional):  INITIAL INVESTMENT | UNREALIZED VALUE (only if showNetWorth)
    //   Row 3 (or Row 2):  REALIZED PNL       | HOLD DURATION
    const col1X  = 40;
    const col2X  = 420;
    const rowGap = 75;
    const gridY  = 285;

    const drawRow = (lLabel: string, lVal: string, rLabel: string, rVal: string, yPos: number) => {
      ctx.fillStyle = '#78829f';
      ctx.font      = `normal 12px ${B}`;
      ctx.fillText(lLabel, col1X, yPos);
      ctx.fillStyle = '#f4f6ff';
      ctx.font      = `bold 19px ${H}`;
      ctx.fillText(lVal,   col1X, yPos + 24);

      ctx.fillStyle = '#78829f';
      ctx.font      = `normal 12px ${B}`;
      ctx.fillText(rLabel, col2X, yPos);
      ctx.fillStyle = '#f4f6ff';
      ctx.font      = `bold 19px ${H}`;
      ctx.fillText(rVal,   col2X, yPos + 24);
    };

    // Row 1 — Entry & Current Market Cap (Always static)
    drawRow(
      'ENTRY MARKET CAP',   fmtMcap(data.entryMarketCap, nr),
      'CURRENT MARKET CAP', fmtMcap(data.currentMarketCap, nr),
      gridY
    );

    if (data.showNetWorth) {
      // Row 2 — Net worth (Personal financial data)
      drawRow(
        'INITIAL INVESTMENT', fmtUsd(data.initialInvestment, nr),
        'UNREALIZED VALUE',   fmtUsd(data.unrealizedValue, nr),
        gridY + rowGap
      );

      // Row 3 — Realized PNL + Hold Duration
      drawRow(
        'REALIZED PNL',  `${data.realizedPnl >= 0 ? '+' : ''}${fmtUsd(data.realizedPnl, nr)}`,
        'HOLD DURATION', data.holdDuration,
        gridY + rowGap * 2
      );
    } else {
      // Row 2 (When net worth is hidden) — Realized PNL + Hold Duration
      drawRow(
        'REALIZED PNL',  `${data.realizedPnl >= 0 ? '+' : ''}${fmtUsd(data.realizedPnl, nr)}`,
        'HOLD DURATION', data.holdDuration,
        gridY + rowGap
      );
    }

    // ── 7. Footer ─────────────────────────────────────────────────────────────
    const footerY = height - 85;

    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(40, footerY);
    ctx.lineTo(width - 40, footerY);
    ctx.stroke();

    ctx.fillStyle  = '#454d66';
    ctx.font       = `normal 13px ${B}`;
    ctx.textAlign  = 'left';
    ctx.fillText('Generated by RacerBot', 40, footerY + 45);

    ctx.fillStyle  = '#78829f';
    ctx.font       = `bold 13px ${H}`;
    ctx.textAlign  = 'right';
    ctx.fillText('@racertradingbot', width - 40, footerY + 45);

    return canvas.toBuffer('image/png') as Buffer;
  } catch (err: any) {
    console.error('[PNL_CARD_IMAGE] Error generating image:', err);
    return null;
  }
}
