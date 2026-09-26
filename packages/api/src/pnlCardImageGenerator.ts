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

    const regularFont = resolveFont('Roboto-Regular.ttf');
    const boldFont = resolveFont('Roboto-Bold.ttf');

    if (regularFont) {
      canvasModule.registerFont(regularFont, { family: 'Roboto', weight: 'normal' });
    }
    if (boldFont) {
      canvasModule.registerFont(boldFont, { family: 'Roboto', weight: 'bold' });
    }
  }
} catch (err) {
  console.warn('[PNL_CARD_IMAGE] Canvas module not available or font registration failed. PNL cards will be text-only.');
}

/**
 * Generate PNL card image using canvas
 * Falls back to null if canvas is not available or fails
 */
export async function generatePNLCardImage(data: PNLCardData): Promise<Buffer | null> {
  if (!canvasModule) {
    return null;
  }

  try {
    const { createCanvas } = canvasModule;
    const width = 800;
    const height = 600;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    const fontFallback = 'Roboto, "DejaVu Sans", "Liberation Sans", "Arial", sans-serif';

    // Background gradient
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    if (data.isProfit) {
      gradient.addColorStop(0, '#1a2f1a');
      gradient.addColorStop(1, '#0d1f0d');
    } else {
      gradient.addColorStop(0, '#2f1a1a');
      gradient.addColorStop(1, '#1f0d0d');
    }
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    // Border
    ctx.strokeStyle = data.isProfit ? '#4ade80' : '#f87171';
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, width - 4, height - 4);

    // Title
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold 32px ${fontFallback}`;
    ctx.textAlign = 'center';
    ctx.fillText(`${data.tokenSymbol} PNL CARD`, width / 2, 50);

    // Status indicator with canvas drawn dot
    const statusText = data.positionStatus === 'open' ? 'OPEN POSITION' : 'CLOSED POSITION';
    const statusColor = data.positionStatus === 'open' ? '#4ade80' : '#f87171';
    
    // Draw status dot
    ctx.fillStyle = statusColor;
    ctx.beginPath();
    ctx.arc(width / 2 - 80, 78, 6, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#e5e7eb';
    ctx.font = `bold 18px ${fontFallback}`;
    ctx.textAlign = 'left';
    ctx.fillText(statusText, width / 2 - 65, 84);

    // Token info
    ctx.font = `16px ${fontFallback}`;
    ctx.textAlign = 'left';
    ctx.fillStyle = '#e5e7eb';
    ctx.fillText(`Token: ${data.tokenName}`, 30, 130);
    ctx.fillText(`CA: ${data.tokenAddress.length > 30 ? data.tokenAddress.slice(0, 28) + '...' : data.tokenAddress}`, 30, 155);
    ctx.fillText(`Venue: ${data.venue || 'Unknown'}`, 30, 180);

    // External deposit indicator
    if (data.isExternalDeposit) {
      ctx.fillStyle = '#fbbf24';
      ctx.fillText('[External Deposit Detected]', 30, 205);
    }

    // Prices
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold 20px ${fontFallback}`;
    ctx.fillText(`Entry Price: ${data.entryPrice.toFixed(8)} NEAR`, 30, 250);
    ctx.fillText(`Current Price: ${data.currentPrice.toFixed(8)} NEAR`, 30, 280);

    // Market cap
    if (data.marketCap && data.marketCap !== 'N/A') {
      ctx.fillStyle = '#9ca3af';
      ctx.font = `16px ${fontFallback}`;
      ctx.fillText(`Market Cap: ${data.marketCap}`, 30, 310);
    }

    // Holdings
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold 20px ${fontFallback}`;
    ctx.fillText(`Quantity Held: ${data.quantityHeld.toFixed(4)}`, 30, 350);
    ctx.fillText(`Initial Investment: ${data.initialInvestment.toFixed(4)} NEAR`, 30, 380);
    ctx.fillText(`Unrealized Value: ${data.unrealizedValue.toFixed(4)} NEAR`, 30, 410);

    // PNL
    const pnlColor = data.isProfit ? '#4ade80' : '#f87171';
    ctx.fillStyle = pnlColor;
    ctx.font = `bold 24px ${fontFallback}`;
    ctx.fillText(`Realized PNL: ${data.isProfit ? '+' : ''}${data.realizedPnl.toFixed(4)} NEAR`, 30, 450);
    ctx.fillText(`Unrealized PNL: ${data.isProfit ? '+' : ''}${data.unrealizedPnl.toFixed(4)} NEAR`, 30, 480);
    ctx.fillText(`Total PNL: ${data.isProfit ? '+' : ''}${data.totalPnl.toFixed(4)} NEAR (${data.pnlPercent.toFixed(2)}%)`, 30, 510);

    // Footer
    ctx.fillStyle = '#9ca3af';
    ctx.font = `14px ${fontFallback}`;
    ctx.textAlign = 'center';
    ctx.fillText(`Hold: ${data.holdDuration}  |  ${data.totalBuys} buys, ${data.totalSells} sells  |  Fees: ${data.totalFeesPaid.toFixed(4)} NEAR`, width / 2, 560);
    ctx.fillText('Generated by RacerBot', width / 2, 585);

    // Convert to buffer
    const buffer = canvas.toBuffer('image/png');
    return buffer;
  } catch (err: any) {
    console.error('[PNL_CARD_IMAGE] Error generating image:', err);
    return null;
  }
}
