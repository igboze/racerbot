import { PNLCardData } from './pnlCardGenerator.js';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

    const registerIfExists = (file: string, family: string, weight: string) => {
      const fontPath = resolveFont(file);
      if (fontPath) {
        try {
          canvasModule.registerFont(fontPath, { family, weight });
        } catch (e) {
          // Ignore duplicate font registrations
        }
      }
    };

    registerIfExists('SpaceGrotesk-Bold.ttf', 'Space Grotesk', 'bold');
    registerIfExists('SpaceGrotesk-Medium.ttf', 'Space Grotesk', 'normal');
    registerIfExists('Inter-Regular.ttf', 'Inter', 'normal');
    registerIfExists('Inter-SemiBold.ttf', 'Inter', 'bold');
    registerIfExists('Inter-Bold.ttf', 'Inter', 'bold');
    registerIfExists('Roboto-Regular.ttf', 'Roboto', 'normal');
    registerIfExists('Roboto-Bold.ttf', 'Roboto', 'bold');
  }
} catch (err) {
  console.warn('[PNL_CARD_IMAGE] Canvas module not available or font registration failed. PNL cards will be text-only.');
}

const resolveLogo = () => {
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

/**
 * Helper to draw rounded rectangles on canvas
 */
function drawRoundedRect(ctx: any, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Format a USD monetary value with compact notation.
 * Input: a NEAR-denominated value + the NEAR/USD rate.
 */
function fmtUsd(nearValue: number, nearUsd: number): string {
  const v = nearValue * nearUsd;
  if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (Math.abs(v) >= 1_000)     return `$${(v / 1_000).toFixed(2)}K`;
  if (Math.abs(v) >= 1)         return `$${v.toFixed(2)}`;
  if (Math.abs(v) >= 0.0001)    return `$${v.toFixed(4)}`;
  return `$${v.toFixed(6)}`;
}

/**
 * Format a per-token price in USD (fine-grained precision for tiny prices).
 */
function fmtPriceUsd(nearPerToken: number, nearUsd: number): string {
  const v = nearPerToken * nearUsd;
  if (v === 0) return '$0.00';
  if (v >= 1)      return `$${v.toFixed(4)}`;
  if (v >= 0.0001) return `$${v.toFixed(6)}`;
  return `$${v.toFixed(8)}`;
}

/**
 * Generate PNL card image using canvas.
 * Rendered using RacerBot modern dark UI card aesthetic.
 * All monetary values are displayed in USD.
 */
export async function generatePNLCardImage(data: PNLCardData): Promise<Buffer | null> {
  if (!canvasModule) {
    return null;
  }

  try {
    const { createCanvas, loadImage } = canvasModule;
    const width  = 800;
    const height = 620;
    const canvas = createCanvas(width, height);
    const ctx    = canvas.getContext('2d');
    const nr     = data.nearUsd || 1; // NEAR → USD conversion rate

    const fontHeader = '"Space Grotesk", "Inter", Roboto, "DejaVu Sans", "Liberation Sans", "Arial", sans-serif';
    const fontBody   = '"Inter", Roboto, "DejaVu Sans", "Liberation Sans", "Arial", sans-serif';

    // ── 1. Background ─────────────────────────────────────────────────────────
    const bgGradient = ctx.createLinearGradient(0, 0, 0, height);
    bgGradient.addColorStop(0,    '#131a2c');
    bgGradient.addColorStop(0.55, '#0d1220');
    bgGradient.addColorStop(1,    '#080c16');
    ctx.fillStyle = bgGradient;
    ctx.fillRect(0, 0, width, height);

    // Card border
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth   = 2;
    drawRoundedRect(ctx, 10, 10, width - 20, height - 20, 24);
    ctx.stroke();

    // ── 2. Header / Brand Row ─────────────────────────────────────────────────
    let logoImg: any = null;
    const logoPath = resolveLogo();
    if (logoPath && typeof loadImage === 'function') {
      try { logoImg = await loadImage(logoPath); } catch { /* use text fallback */ }
    }

    if (logoImg) {
      ctx.drawImage(logoImg, 40, 22, 44, 44);
      ctx.fillStyle  = '#f4f6ff';
      ctx.font       = `bold 20px ${fontHeader}`;
      ctx.textAlign  = 'left';
      ctx.fillText('RacerBot', 94, 51);
    } else {
      ctx.fillStyle  = '#23e6c4';
      ctx.font       = `bold 22px ${fontHeader}`;
      ctx.textAlign  = 'left';
      ctx.fillText('⚡', 40, 48);
      ctx.fillStyle  = '#f4f6ff';
      ctx.font       = `bold 18px ${fontHeader}`;
      ctx.fillText('RacerBot', 68, 47);
    }
    // NOTE: Venue / network pill intentionally omitted.

    // ── 3. Hero Section ───────────────────────────────────────────────────────
    // Token symbol & name
    ctx.textAlign  = 'left';
    ctx.font       = `normal 16px ${fontBody}`;
    ctx.fillStyle  = '#78829f';
    const tokenDisplay = `${data.tokenSymbol} (${data.tokenName})`;
    ctx.fillText(tokenDisplay, 40, 105);
    const tokenW = ctx.measureText(tokenDisplay).width;

    // Status pill (OPEN / CLOSED POSITION)
    const statusText  = data.positionStatus === 'open' ? 'OPEN POSITION' : 'CLOSED POSITION';
    const statusColor = data.positionStatus === 'open' ? '#35f2b4' : '#ff5c72';
    const statusBg    = data.positionStatus === 'open'
      ? 'rgba(53, 242, 180, 0.12)'
      : 'rgba(255, 92, 114, 0.12)';

    ctx.font = `bold 11px ${fontHeader}`;
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
    // NOTE: External deposit badge intentionally omitted.

    // Giant PNL % display
    const pnlSign       = data.isProfit ? '+' : '';
    const pnlPercentText = `${pnlSign}${data.pnlPercent.toFixed(2)}%`;
    const pnlColor       = data.isProfit ? '#35f2b4' : '#ff5c72';

    ctx.fillStyle = pnlColor;
    ctx.font      = `bold 64px ${fontHeader}`;
    ctx.fillText(pnlPercentText, 40, 178);

    // Sub-label — all figures in USD
    ctx.fillStyle  = '#78829f';
    ctx.font       = `normal 15px ${fontBody}`;
    const totalPnlUsd = fmtUsd(data.totalPnl, nr);
    const boughtUsd   = fmtUsd(data.initialInvestment, nr);
    const worthUsd    = fmtUsd(data.unrealizedValue, nr);
    const subText = `Total PNL: ${pnlSign}${totalPnlUsd}  •  Bought ${boughtUsd} ➔ Worth ${worthUsd}`;
    ctx.fillText(subText, 40, 212);

    // ── 4. Decorative Cyan Accent Lines ──────────────────────────────────────
    const lineY = 242;
    const grad1 = ctx.createLinearGradient(40, 0, width - 40, 0);
    grad1.addColorStop(0, '#23e6c4');
    grad1.addColorStop(1, 'transparent');

    ctx.fillStyle   = grad1;
    ctx.globalAlpha = 0.55;
    ctx.fillRect(40, lineY, width - 80, 2);

    ctx.globalAlpha = 0.30;
    ctx.fillRect(40, lineY + 5, (width - 80) * 0.62, 2);

    ctx.globalAlpha = 0.15;
    ctx.fillRect(40, lineY + 10, (width - 80) * 0.30, 2);

    ctx.globalAlpha = 1.0;

    // ── 5. Stats Grid (2 Columns × 3 Rows) — all monetary values in USD ──────
    const gridStartY = 285;
    const col1X      = 40;
    const col2X      = 420;
    const rowGap     = 65;

    const fields = [
      [
        { label: 'ENTRY PRICE',       val: fmtPriceUsd(data.entryPrice, nr) },
        { label: 'CURRENT PRICE',     val: fmtPriceUsd(data.currentPrice, nr) },
      ],
      [
        { label: 'INITIAL INVESTMENT', val: fmtUsd(data.initialInvestment, nr) },
        { label: 'UNREALIZED VALUE',   val: fmtUsd(data.unrealizedValue, nr) },
      ],
      [
        { label: 'REALIZED PNL',  val: `${data.realizedPnl >= 0 ? '+' : ''}${fmtUsd(data.realizedPnl, nr)}` },
        { label: 'HOLD DURATION', val: data.holdDuration },
      ],
    ];

    fields.forEach((row, rIdx) => {
      const y = gridStartY + rIdx * rowGap;

      // Column 1
      ctx.fillStyle = '#78829f';
      ctx.font      = `normal 12px ${fontBody}`;
      ctx.fillText(row[0].label, col1X, y);
      ctx.fillStyle = '#f4f6ff';
      ctx.font      = `bold 19px ${fontHeader}`;
      ctx.fillText(row[0].val, col1X, y + 24);

      // Column 2
      ctx.fillStyle = '#78829f';
      ctx.font      = `normal 12px ${fontBody}`;
      ctx.fillText(row[1].label, col2X, y);
      ctx.fillStyle = '#f4f6ff';
      ctx.font      = `bold 19px ${fontHeader}`;
      ctx.fillText(row[1].val, col2X, y + 24);
    });

    // ── 6. Footer ─────────────────────────────────────────────────────────────
    const footerY = 515;

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(40, footerY);
    ctx.lineTo(width - 40, footerY);
    ctx.stroke();

    // Footer left — simplified (no buys/sells/fees)
    ctx.fillStyle  = '#454d66';
    ctx.font       = `normal 13px ${fontBody}`;
    ctx.textAlign  = 'left';
    ctx.fillText('Generated by RacerBot', 40, footerY + 45);

    // Footer right
    ctx.fillStyle  = '#78829f';
    ctx.font       = `bold 13px ${fontHeader}`;
    ctx.textAlign  = 'right';
    ctx.fillText('@racertradingbot', width - 40, footerY + 45);

    return canvas.toBuffer('image/png') as Buffer;
  } catch (err: any) {
    console.error('[PNL_CARD_IMAGE] Error generating image:', err);
    return null;
  }
}
