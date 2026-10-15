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

// ── Pre-cached Fonts & Static Assets in Memory ──────────────────────────────
let cachedOrbitronMedium: Buffer | null = null;
let cachedOrbitronBold: Buffer | null = null;
let cachedOrbitronBlack: Buffer | null = null;
let cachedLogoB64: string = '';
let cachedRobotLossB64: string = '';
let cachedRobotProfitB64: string = '';
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

    const pLogo = resolveAsset('logo.png') || resolveAsset('racerbot-logo.png');
    if (pLogo) cachedLogoB64 = `data:image/png;base64,${fs.readFileSync(pLogo).toString('base64')}`;

    const pLoss = resolveAsset('robot-loss-transparent.png') || resolveAsset('robot-loss.png');
    if (pLoss) cachedRobotLossB64 = `data:image/png;base64,${fs.readFileSync(pLoss).toString('base64')}`;

    const pProfit = resolveAsset('robot-profit-transparent.png') || resolveAsset('robot-profit.png');
    if (pProfit) cachedRobotProfitB64 = `data:image/png;base64,${fs.readFileSync(pProfit).toString('base64')}`;
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
 * Generate 1200x630 landscape PNL Card Image matching the official RacerBot Design Contract.
 * - Loss: data-state="loss" (Red banner #ff4d57, Red REF, heavy walking robot mascot)
 * - Profit: data-state="profit" (Green banner #1fc43a, Green REF, fast running robot mascot)
 */
export async function generatePNLCardImage(data: PNLCardData): Promise<Buffer | null> {
  initAssets();

  if (!cachedOrbitronBold || !cachedOrbitronMedium) {
    console.warn('[PNL_CARD_IMAGE] Required Orbitron font not found, aborting image generation.');
    return null;
  }

  try {
    const p = Number(data.pnlPercent) || 0;
    const isProfit = p >= 0;

    // Tokens
    const pnlColor = isProfit ? '#1fc43a' : '#ff4d57';
    const pnlSign = isProfit ? '+' : '-';
    const pctStr = `${pnlSign}${Math.abs(p).toFixed(2)}%`;

    const nr = data.nearUsd || 1;
    const investedUsd = data.initialInvestment * nr;
    const currentValUsd = data.positionStatus === 'closed'
      ? (data.initialInvestment + data.totalPnl) * nr
      : data.unrealizedValue * nr;

    const isClosed = data.positionStatus === 'closed';
    const currentOrExitLabel = isClosed ? 'Exit' : 'Present';

    let stat1Label: string;
    let stat1Value: string;
    let stat2Label: string;
    let stat2Value: string;

    if (data.showNetWorth) {
      stat1Label = 'Entry Amount';
      stat1Value = formatUSDVal(investedUsd);
      stat2Label = isClosed ? 'Exit Amount' : 'Present Amount';
      stat2Value = formatUSDVal(currentValUsd);
    } else {
      stat1Label = 'Entry MC';
      stat1Value = formatMcapVal(data.entryMarketCap * nr);
      stat2Label = currentOrExitLabel + ' MC';
      stat2Value = formatMcapVal(data.currentMarketCap * nr);
    }

    const holdTimeStr = data.holdDuration || '1m';
    const refCode = data.referralCode || 'racerbot';
    const refLink = data.referralLink || `https://t.me/racertradingbot?start=${encodeURIComponent(refCode)}`;

    // Generate QR code for referral link
    const qrDataUrl = await QRCode.toDataURL(refLink, {
      margin: 1,
      width: 65,
      color: { dark: '#0a1129', light: '#ffffff' },
    });

    // Mascot dimensions (explicit pixel sizing for Satori layout engine)
    const mascotSrc = isProfit ? cachedRobotProfitB64 : cachedRobotLossB64;
    const mascotLeft = isProfit ? 48 : 24;
    const mascotHeight = isProfit ? 228 : 276;
    const mascotWidth = isProfit ? 289 : 323;

    // Logo dimensions
    const logoSrc = cachedLogoB64;
    const logoWidth = 332;
    const logoHeight = 62;

    const ticker = data.tokenSymbol || 'TOKEN';

    const cardHtml = html`
      <div style="display: flex; position: relative; width: 1200px; height: 630px; overflow: hidden; background: linear-gradient(180deg, #0a1129 0%, #0b1c40 45%, #0b3270 100%); font-family: Orbitron; color: #ffffff;">
        
        <!-- Star particles (radial star points) -->
        <div style="display: flex; position: absolute; left: 8%; top: 30%; width: 3px; height: 3px; background: rgba(255,255,255,0.8); border-radius: 50%;"></div>
        <div style="display: flex; position: absolute; left: 22%; top: 12%; width: 2px; height: 2px; background: rgba(255,255,255,0.6); border-radius: 50%;"></div>
        <div style="display: flex; position: absolute; left: 15%; top: 55%; width: 2px; height: 2px; background: rgba(255,255,255,0.5); border-radius: 50%;"></div>
        <div style="display: flex; position: absolute; left: 33%; top: 38%; width: 3px; height: 3px; background: rgba(255,255,255,0.6); border-radius: 50%;"></div>
        <div style="display: flex; position: absolute; left: 28%; top: 70%; width: 2px; height: 2px; background: rgba(255,255,255,0.4); border-radius: 50%;"></div>
        <div style="display: flex; position: absolute; left: 5%; top: 80%; width: 2px; height: 2px; background: rgba(255,255,255,0.5); border-radius: 50%;"></div>

        <!-- Glowing speed streaks -->
        <div style="display: flex; position: absolute; left: 0; right: 0; bottom: 0; height: 288px; opacity: 0.75;">
          <div style="position: absolute; left: 62%; top: 22%; width: 36%; height: 3px; background: linear-gradient(90deg, transparent, #3aa0ff 40%, transparent);"></div>
          <div style="position: absolute; left: 40%; top: 38%; width: 55%; height: 4px; background: linear-gradient(90deg, transparent, #5bb6ff 50%, transparent);"></div>
          <div style="position: absolute; left: 70%; top: 52%; width: 30%; height: 4px; background: linear-gradient(90deg, transparent, #2e8cff 50%, transparent);"></div>
          <div style="position: absolute; left: 30%; top: 68%; width: 60%; height: 2px; background: linear-gradient(90deg, transparent, #8fd0ff 50%, transparent);"></div>
          <div style="position: absolute; left: 55%; top: 82%; width: 40%; height: 4px; background: linear-gradient(90deg, transparent, #2e8cff 50%, transparent);"></div>
        </div>

        <!-- Logo -->
        <div style="display: flex; position: absolute; left: 31px; top: 38px;">
          <img src="${logoSrc}" style="width: ${logoWidth}px; height: ${logoHeight}px;" />
        </div>

        <!-- Handle -->
        <div style="display: flex; position: absolute; right: 36px; top: 53px; font-size: 18px; font-weight: 500; opacity: 0.95; letter-spacing: 0.5px;">
          @racertradingbot
        </div>

        <!-- Ticker -->
        <div style="display: flex; position: absolute; right: 36px; top: 110px; font-size: 74px; font-weight: 900; letter-spacing: 2.4px; line-height: 1;">
          ${ticker}
        </div>

        <!-- PNL Banner -->
        <div style="display: flex; position: absolute; right: 0; left: 564px; top: 204px; height: 115px; background: ${pnlColor}; align-items: center; justify-content: flex-end; padding-right: 36px; font-size: 91px; font-weight: 900; color: #1a2244; line-height: 1;">
          ${pctStr}
        </div>

        <!-- Stats -->
        <div style="display: flex; position: absolute; right: 36px; top: 338px; gap: 38px; text-align: center;">
          <div style="display: flex; flex-direction: column; align-items: center;">
            <div style="font-size: 12px; font-style: italic; font-weight: 500; opacity: 0.85; margin-bottom: 6px;">${stat1Label}</div>
            <div style="font-size: 23px; font-weight: 700;">${stat1Value}</div>
          </div>
          <div style="display: flex; flex-direction: column; align-items: center;">
            <div style="font-size: 12px; font-style: italic; font-weight: 500; opacity: 0.85; margin-bottom: 6px;">${stat2Label}</div>
            <div style="font-size: 23px; font-weight: 700;">${stat2Value}</div>
          </div>
          <div style="display: flex; flex-direction: column; align-items: center;">
            <div style="font-size: 12px; font-style: italic; font-weight: 500; opacity: 0.85; margin-bottom: 6px;">Hold Time</div>
            <div style="font-size: 23px; font-weight: 700;">${holdTimeStr}</div>
          </div>
        </div>

        <!-- Mascot (Heavy Walking Robot for Loss, Fast Running Robot for Profit) -->
        <div style="display: flex; position: absolute; left: ${mascotLeft}px; bottom: 6px;">
          <img src="${mascotSrc}" style="width: ${mascotWidth}px; height: ${mascotHeight}px;" />
        </div>

        <!-- CTA & Referral QR Code -->
        <div style="display: flex; position: absolute; right: 36px; bottom: 19px; align-items: flex-end; gap: 12px; text-align: right;">
          <div style="display: flex; flex-direction: column; align-items: flex-end; font-size: 14px; line-height: 1.45; font-weight: 500;">
            <div>SCAN TO TRADE</div>
            <div>t.me/racertradingbot</div>
            <div style="color: ${pnlColor}; font-weight: 700; font-size: 12px;">REF: ${refCode}</div>
          </div>
          <img src="${qrDataUrl}" style="width: 65px; height: 65px; border-radius: 4px;" />
        </div>

      </div>
    `;

    const svg = await satori(cardHtml, {
      width: 1200,
      height: 630,
      fonts: [
        { name: 'Orbitron', data: cachedOrbitronMedium, weight: 500, style: 'normal' },
        { name: 'Orbitron', data: cachedOrbitronBold, weight: 700, style: 'normal' },
        { name: 'Orbitron', data: cachedOrbitronBlack || cachedOrbitronBold, weight: 900, style: 'normal' },
      ],
    });

    const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } });
    const pngBuffer = resvg.render().asPng();
    return Buffer.from(pngBuffer);
  } catch (err: any) {
    console.error('[PNL_CARD_IMAGE] Error generating PNL card image with Satori:', err);
    return null;
  }
}
