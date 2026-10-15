import { PNLCardData } from './pnlCardGenerator.js';
import QRCode from 'qrcode';
import satori from 'satori';
import { html } from 'satori-html';
import { Resvg } from '@resvg/resvg-js';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Path & Asset Resolvers ──────────────────────────────────────────────────

function resolveAsset(name: string): string | null {
  const candidates = [
    path.join(__dirname, '..', 'assets', name),
    path.join(process.cwd(), 'packages', 'api', 'assets', name),
    path.join(process.cwd(), 'assets', name),
    path.join(__dirname, 'assets', name),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function resolveFont(name: string): string | null {
  const candidates = [
    path.join(__dirname, '..', 'fonts', name),
    path.join(process.cwd(), 'packages', 'api', 'fonts', name),
    path.join(process.cwd(), 'fonts', name),
    path.join(__dirname, 'fonts', name),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ── Pre-cached Fonts & Static Templates in Memory ───────────────────────────
let cachedOrbitronMedium: Buffer | null = null;
let cachedOrbitronBold: Buffer | null = null;
let cachedOrbitronBlack: Buffer | null = null;
let cachedTemplateProfitB64: string = '';
let cachedTemplateLossB64: string = '';
let assetsInitialized = false;

function initAssets(): void {
  if (assetsInitialized) return;
  assetsInitialized = true;

  try {
    const fMed = resolveFont('Orbitron-Medium.ttf');
    if (fMed) cachedOrbitronMedium = fs.readFileSync(fMed);

    const fBold = resolveFont('Orbitron-Bold.ttf');
    if (fBold) cachedOrbitronBold = fs.readFileSync(fBold);

    const fBlack = resolveFont('Orbitron-Black.ttf') || fBold;
    if (fBlack) cachedOrbitronBlack = fs.readFileSync(fBlack);

    const pProfit = resolveAsset('pnl-template-profit.png');
    if (pProfit) {
      cachedTemplateProfitB64 = `data:image/png;base64,${fs.readFileSync(pProfit).toString('base64')}`;
    }

    const pLoss = resolveAsset('pnl-template-loss.png');
    if (pLoss) {
      cachedTemplateLossB64 = `data:image/png;base64,${fs.readFileSync(pLoss).toString('base64')}`;
    }
  } catch (err) {
    console.warn('[PNL_CARD_IMAGE] Asset initialization warning:', err);
  }
}

function formatUSDVal(val: number): string {
  const abs = Math.abs(val);
  if (abs >= 1_000_000_000) return '$' + (val / 1_000_000_000).toFixed(2) + 'B';
  if (abs >= 1_000_000) return '$' + (val / 1_000_000).toFixed(2) + 'M';
  if (abs >= 10_000) return '$' + val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (abs >= 1) return '$' + val.toFixed(2);
  return '$' + val.toFixed(4);
}

function formatMcapVal(val: number): string {
  const abs = Math.abs(val);
  if (abs >= 1_000_000_000) return '$' + (val / 1_000_000_000).toFixed(2) + 'B';
  if (abs >= 1_000_000) return '$' + (val / 1_000_000).toFixed(2) + 'M';
  if (abs >= 1_000) return '$' + (val / 1_000).toFixed(2) + 'K';
  if (abs > 0) return '$' + val.toFixed(2);
  return 'N/A';
}

/**
 * Generate 1024x1024 square PNL Card Image matching the official RacerBot Ultra-Quality Design.
 * - Loss: Red banner #ff334c, Red REF, heavy round walking robot with glowing red eyes
 * - Profit: Green banner #0abb33, Green REF, high-speed roller-skating robot with cyan trails
 * - Dynamic space background with galactic stars, horizontal electric speed flares,
 *   crisp RacerBot logo, @racertradingbot, 3-column stats, and referral QR code.
 */
export async function generatePNLCardImage(data: PNLCardData): Promise<Buffer | null> {
  initAssets();

  if (!cachedOrbitronBold || !cachedOrbitronMedium) {
    console.warn('[PNL_CARD_IMAGE] Required Orbitron font not found, aborting image generation.');
    return null;
  }

  if (!cachedTemplateProfitB64 || !cachedTemplateLossB64) {
    console.warn('[PNL_CARD_IMAGE] Master PNL templates not found, aborting image generation.');
    return null;
  }

  try {
    const p = Number(data.pnlPercent) || 0;
    const isProfit = p >= 0;

    const bgTemplateB64 = isProfit ? cachedTemplateProfitB64 : cachedTemplateLossB64;
    const bannerBg = isProfit ? '#0abb33' : '#ff334c';
    const refColor = isProfit ? '#0abb33' : '#ff334c';

    // Sign and percentage format: matching reference design (positive: '5.37%', negative: '-9.01%')
    const sign = isProfit ? '' : '-';
    const pctStr = `${sign}${Math.abs(p).toFixed(2)}%`;

    const nr = data.nearUsd || 1;
    const investedUsd = data.initialInvestment * nr;
    const currentValUsd = data.positionStatus === 'closed'
      ? (data.initialInvestment + data.totalPnl) * nr
      : data.unrealizedValue * nr;

    const isClosed = data.positionStatus === 'closed';
    const currentOrExitLabel = isClosed ? 'Exit Value' : 'Current Value';
    const currentOrExitMcLabel = isClosed ? 'Exit MC' : 'Current MC';

    let stat1Label: string;
    let stat1Value: string;
    let stat2Label: string;
    let stat2Value: string;

    if (data.showNetWorth) {
      stat1Label = 'Invested';
      stat1Value = formatUSDVal(investedUsd);
      stat2Label = currentOrExitLabel;
      stat2Value = formatUSDVal(currentValUsd);
    } else {
      stat1Label = 'Entry MC';
      stat1Value = formatMcapVal(data.entryMarketCap * nr);
      stat2Label = currentOrExitMcLabel;
      stat2Value = formatMcapVal(data.currentMarketCap * nr);
    }

    const holdTimeStr = data.holdDuration || '1m';
    const refCode = data.referralCode || 'racerbot';
    const refLink = data.referralLink || `https://t.me/racertradingbot?start=${encodeURIComponent(refCode)}`;

    // Generate crisp QR code for referral link
    const qrDataUrl = await QRCode.toDataURL(refLink, {
      margin: 1,
      width: 94,
      color: { dark: '#0a1129', light: '#ffffff' },
    });

    const ticker = data.tokenSymbol || 'TOKEN';

    // Dynamically scale font size for long tickers
    const tickerFontSize = ticker.length > 7 ? 50 : ticker.length > 5 ? 60 : 72;

    // Dynamically scale font size for large percentage values
    const pctFontSize = pctStr.length > 7 ? 96 : pctStr.length > 6 ? 112 : 128;

    const cardHtml = html`
      <div style="display: flex; position: relative; width: 1024px; height: 1024px; font-family: Orbitron;">
        <!-- High-fidelity background template (starfield, mascot, logo, handle, lighting beams) -->
        <img src="${bgTemplateB64}" style="position: absolute; left: 0; top: 0; width: 1024px; height: 1024px;" />

        <!-- Token Ticker -->
        <div style="display: flex; position: absolute; left: 683px; top: 234px; font-size: ${tickerFontSize}px; font-weight: 700; color: #ffffff; letter-spacing: 1.5px; line-height: 1;">
          ${ticker}
        </div>

        <!-- PNL Banner -->
        <div style="display: flex; position: absolute; left: 477px; top: 310px; width: 547px; height: 128px; background: ${bannerBg}; padding-left: 31px; padding-top: 14px;">
          <span style="font-size: ${pctFontSize}px; font-weight: 900; color: #1f2c4c; line-height: 1; letter-spacing: -1px;">
            ${pctStr}
          </span>
        </div>

        <!-- 3 Stats Columns -->
        <div style="display: flex; position: absolute; left: 477px; top: 446px; width: 547px; justify-content: space-around; text-align: center;">
          <div style="display: flex; flex-direction: column; align-items: center; width: 170px;">
            <div style="font-size: 15px; font-style: italic; font-weight: 500; color: #8fa2be; margin-bottom: 6px;">${stat1Label}</div>
            <div style="font-size: 26px; font-weight: 700; color: #ffffff;">${stat1Value}</div>
          </div>
          <div style="display: flex; flex-direction: column; align-items: center; width: 170px;">
            <div style="font-size: 15px; font-style: italic; font-weight: 500; color: #8fa2be; margin-bottom: 6px;">${stat2Label}</div>
            <div style="font-size: 26px; font-weight: 700; color: #ffffff;">${stat2Value}</div>
          </div>
          <div style="display: flex; flex-direction: column; align-items: center; width: 170px;">
            <div style="font-size: 15px; font-style: italic; font-weight: 500; color: #8fa2be; margin-bottom: 6px;">Hold Time</div>
            <div style="font-size: 26px; font-weight: 700; color: #ffffff;">${holdTimeStr}</div>
          </div>
        </div>

        <!-- Referral Code Text -->
        <div style="display: flex; position: absolute; right: 114px; top: 1004px; font-size: 14px; font-weight: 700; color: ${refColor}; letter-spacing: 0.5px;">
          REF: ${refCode}
        </div>

        <!-- Referral QR Code -->
        <div style="display: flex; position: absolute; left: 922px; top: 926px; width: 94px; height: 94px; border-radius: 4px; overflow: hidden;">
          <img src="${qrDataUrl}" style="width: 94px; height: 94px;" />
        </div>
      </div>
    `;

    const svg = await satori(cardHtml, {
      width: 1024,
      height: 1024,
      fonts: [
        { name: 'Orbitron', data: cachedOrbitronMedium, weight: 500, style: 'normal' },
        { name: 'Orbitron', data: cachedOrbitronBold, weight: 700, style: 'normal' },
        { name: 'Orbitron', data: cachedOrbitronBlack || cachedOrbitronBold, weight: 900, style: 'normal' },
      ],
    });

    const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: 1024 } });
    const pngBuffer = resvg.render().asPng();
    return Buffer.from(pngBuffer);
  } catch (err: any) {
    console.error('[PNL_CARD_IMAGE] Error generating PNL card image with Satori:', err);
    return null;
  }
}
