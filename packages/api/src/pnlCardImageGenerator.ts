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
 * Generate PNL card image using canvas
 * Rendered using RacerBot modern dark UI card aesthetic
 */
export async function generatePNLCardImage(data: PNLCardData): Promise<Buffer | null> {
  if (!canvasModule) {
    return null;
  }

  try {
    const { createCanvas } = canvasModule;
    const width = 800;
    const height = 620;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    const fontHeader = '"Space Grotesk", "Inter", Roboto, "DejaVu Sans", "Liberation Sans", "Arial", sans-serif';
    const fontBody = '"Inter", Roboto, "DejaVu Sans", "Liberation Sans", "Arial", sans-serif';

    // 1. Background Outer Container Gradient
    const bgGradient = ctx.createLinearGradient(0, 0, 0, height);
    bgGradient.addColorStop(0, '#131a2c');
    bgGradient.addColorStop(0.55, '#0d1220');
    bgGradient.addColorStop(1, '#080c16');

    // Fill background
    ctx.fillStyle = bgGradient;
    ctx.fillRect(0, 0, width, height);

    // Card Outer Border (24px radius inset)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 2;
    drawRoundedRect(ctx, 10, 10, width - 20, height - 20, 24);
    ctx.stroke();

    // 2. Header / Brand Row (Y = 45)
    // Brand name & icon
    ctx.fillStyle = '#23e6c4';
    ctx.font = `bold 22px ${fontHeader}`;
    ctx.textAlign = 'left';
    ctx.fillText('⚡', 40, 48);

    ctx.fillStyle = '#f4f6ff';
    ctx.font = `bold 18px ${fontHeader}`;
    ctx.fillText('RacerBot', 68, 47);

    // Network / Venue Pill (Right aligned)
    const venueText = (data.venue || 'NEAR PROTOCOL').toUpperCase();
    ctx.font = `normal 12px ${fontBody}`;
    const venueWidth = ctx.measureText(venueText).width;
    const pillPaddingX = 12;
    const pillW = venueWidth + pillPaddingX * 2;
    const pillX = width - 40 - pillW;

    ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
    drawRoundedRect(ctx, pillX, 30, pillW, 26, 13);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = '#78829f';
    ctx.textAlign = 'center';
    ctx.fillText(venueText, pillX + pillW / 2, 47);

    // 3. Hero Section (Y = 100 - 230)
    // Token symbol & Name
    ctx.textAlign = 'left';
    ctx.font = `normal 16px ${fontBody}`;
    ctx.fillStyle = '#78829f';
    const tokenDisplay = `${data.tokenSymbol} (${data.tokenName})`;
    ctx.fillText(tokenDisplay, 40, 105);

    // Status Tag (Open / Closed Position)
    const statusText = data.positionStatus === 'open' ? 'OPEN POSITION' : 'CLOSED POSITION';
    const statusColor = data.positionStatus === 'open' ? '#35f2b4' : '#ff5c72';
    const statusBg = data.positionStatus === 'open' ? 'rgba(53, 242, 180, 0.12)' : 'rgba(255, 92, 114, 0.12)';

    ctx.font = `bold 11px ${fontHeader}`;
    const statusW = ctx.measureText(statusText).width + 24;
    const tokenW = ctx.measureText(tokenDisplay).width;
    const tagX = 40 + tokenW + 16;

    ctx.fillStyle = statusBg;
    drawRoundedRect(ctx, tagX, 90, statusW, 22, 11);
    ctx.fill();

    // Status Dot
    ctx.fillStyle = statusColor;
    ctx.beginPath();
    ctx.arc(tagX + 10, 101, 3.5, 0, Math.PI * 2);
    ctx.fill();

    // Status Text
    ctx.fillStyle = statusColor;
    ctx.fillText(statusText, tagX + 18, 105);

    // External deposit badge if active
    if (data.isExternalDeposit) {
      ctx.fillStyle = 'rgba(251, 191, 36, 0.15)';
      drawRoundedRect(ctx, tagX + statusW + 10, 90, 130, 22, 11);
      ctx.fill();
      ctx.fillStyle = '#fbbf24';
      ctx.fillText('EXTERNAL DEPOSIT', tagX + statusW + 20, 105);
    }

    // Giant PNL Display
    const pnlSign = data.isProfit ? '+' : '';
    const pnlPercentText = `${pnlSign}${data.pnlPercent.toFixed(2)}%`;
    const pnlColor = data.isProfit ? '#35f2b4' : '#ff5c72';

    ctx.fillStyle = pnlColor;
    ctx.font = `bold 64px ${fontHeader}`;
    ctx.fillText(pnlPercentText, 40, 178);

    // Sub label: Bought X NEAR -> Worth Y NEAR
    ctx.fillStyle = '#78829f';
    ctx.font = `normal 15px ${fontBody}`;
    const subText = `Total PNL: ${pnlSign}${data.totalPnl.toFixed(4)} NEAR  •  Bought ${data.initialInvestment.toFixed(2)} NEAR ➔ Worth ${data.unrealizedValue.toFixed(2)} NEAR`;
    ctx.fillText(subText, 40, 212);

    // 4. Decorative Cyan Accent Lines (Y = 242)
    const lineY = 242;
    const grad1 = ctx.createLinearGradient(40, 0, width - 40, 0);
    grad1.addColorStop(0, '#23e6c4');
    grad1.addColorStop(1, 'transparent');

    // Line 1 (100% width, 55% opacity)
    ctx.fillStyle = grad1;
    ctx.globalAlpha = 0.55;
    ctx.fillRect(40, lineY, width - 80, 2);

    // Line 2 (62% width, 30% opacity)
    ctx.globalAlpha = 0.30;
    ctx.fillRect(40, lineY + 5, (width - 80) * 0.62, 2);

    // Line 3 (30% width, 15% opacity)
    ctx.globalAlpha = 0.15;
    ctx.fillRect(40, lineY + 10, (width - 80) * 0.30, 2);

    ctx.globalAlpha = 1.0; // reset alpha

    // 5. Stats Grid (2 Columns x 3 Rows)
    const gridStartY = 285;
    const col1X = 40;
    const col2X = 420;
    const rowGap = 65;

    const fields = [
      [
        { label: 'ENTRY PRICE', val: `${data.entryPrice.toFixed(6)} NEAR` },
        { label: 'CURRENT PRICE', val: `${data.currentPrice.toFixed(6)} NEAR` },
      ],
      [
        { label: 'INITIAL INVESTMENT', val: `${data.initialInvestment.toFixed(4)} NEAR` },
        { label: 'UNREALIZED VALUE', val: `${data.unrealizedValue.toFixed(4)} NEAR` },
      ],
      [
        { label: 'REALIZED PNL', val: `${data.isProfit ? '+' : ''}${data.realizedPnl.toFixed(4)} NEAR` },
        { label: 'HOLD DURATION', val: data.holdDuration },
      ],
    ];

    fields.forEach((row, rIdx) => {
      const y = gridStartY + rIdx * rowGap;

      // Col 1
      ctx.fillStyle = '#78829f';
      ctx.font = `normal 12px ${fontBody}`;
      ctx.fillText(row[0].label, col1X, y);
      ctx.fillStyle = '#f4f6ff';
      ctx.font = `bold 19px ${fontHeader}`;
      ctx.fillText(row[0].val, col1X, y + 24);

      // Col 2
      ctx.fillStyle = '#78829f';
      ctx.font = `normal 12px ${fontBody}`;
      ctx.fillText(row[1].label, col2X, y);
      ctx.fillStyle = '#f4f6ff';
      ctx.font = `bold 19px ${fontHeader}`;
      ctx.fillText(row[1].val, col2X, y + 24);
    });

    // 6. Footer Section (Y = 515 - 590)
    const footerY = 515;

    // Footer divider line
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(40, footerY);
    ctx.lineTo(width - 40, footerY);
    ctx.stroke();

    // Footer text left
    ctx.fillStyle = '#454d66';
    ctx.font = `normal 13px ${fontBody}`;
    ctx.textAlign = 'left';
    ctx.fillText(
      `Generated by RacerBot  •  ${data.totalBuys} buys, ${data.totalSells} sells  •  Fees: ${data.totalFeesPaid.toFixed(4)} NEAR`,
      40,
      footerY + 45
    );

    // Footer text right
    ctx.fillStyle = '#78829f';
    ctx.font = `bold 13px ${fontHeader}`;
    ctx.textAlign = 'right';
    ctx.fillText('@RacerBot', width - 40, footerY + 45);

    // Convert to buffer
    const buffer = canvas.toBuffer('image/png');
    return buffer;
  } catch (err: any) {
    console.error('[PNL_CARD_IMAGE] Error generating image:', err);
    return null;
  }
}
