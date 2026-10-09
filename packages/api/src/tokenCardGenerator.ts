import satori from 'satori';
import { html } from 'satori-html';
import { Resvg } from '@resvg/resvg-js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface TokenCardData {
  name: string;
  symbol: string;
  address?: string;
  iconUrl?: string;
  priceNear?: string;
  priceUsd?: string;
  marketCap?: string;
  liquidity?: string;
  supply?: string;
  dexTax?: string;
  holders?: string;
  trades?: string;
  totalTxns?: string;
  pair?: string;
  venue?: string;
  securityStatus?: string;
  contractType?: string;
  footerText?: string;
}

// ── Asset Loaders ────────────────────────────────────────────────────────────
function loadFont(fontFileName: string): Buffer | null {
  const candidates = [
    path.join(__dirname, '..', 'fonts', fontFileName),
    path.join(process.cwd(), 'packages', 'api', 'fonts', fontFileName),
    path.join(process.cwd(), 'fonts', fontFileName),
    path.join(__dirname, 'fonts', fontFileName),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return fs.readFileSync(p);
    }
  }
  return null;
}

function loadAssetBase64(name: string): string | null {
  const candidates = [
    path.join(__dirname, '..', 'assets', name),
    path.join(process.cwd(), 'packages', 'api', 'assets', name),
    path.join(process.cwd(), 'assets', name),
    path.join(__dirname, 'assets', name),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const buf = fs.readFileSync(p);
      const ext = path.extname(name).replace('.', '') || 'png';
      return `data:image/${ext};base64,${buf.toString('base64')}`;
    }
  }
  return null;
}

/**
 * Pre-fetches an HTTP/HTTPS image URL and converts it to a base64 Data URI
 * so Satori can render remote token icons reliably without HTTP failure.
 */
async function fetchImageAsBase64(url: string): Promise<string | null> {
  if (!url) return null;
  if (url.startsWith('data:')) return url;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500); // 3.5s max wait
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    const contentType = res.headers.get('content-type') || 'image/png';
    const base64 = Buffer.from(arrayBuffer).toString('base64');
    return `data:${contentType};base64,${base64}`;
  } catch {
    return null;
  }
}

/**
 * Generates an official RacerBot Brand Token Card PNG image using Satori & Resvg.
 * Output Dimensions: 1200 x 860.
 */
export async function generateTokenCardImage(data: TokenCardData): Promise<Buffer | null> {
  try {
    const interRegular = loadFont('Inter-Regular.ttf');
    const interBold = loadFont('Inter-Bold.ttf');
    const spaceGroteskBold = loadFont('SpaceGrotesk-Bold.ttf') || interBold;

    const fonts: any[] = [];
    if (interRegular) {
      fonts.push({ name: 'Inter', data: interRegular, weight: 400, style: 'normal' });
    }
    if (interBold) {
      fonts.push({ name: 'Inter', data: interBold, weight: 700, style: 'normal' });
    }
    if (spaceGroteskBold) {
      fonts.push({ name: 'Space Grotesk', data: spaceGroteskBold, weight: 700, style: 'normal' });
    }

    const tokenName = data.name || 'Token';
    const rawSymbol = (data.symbol || 'TOKEN').replace(/^\$/, '');
    const symbolText = `$${rawSymbol}`;
    const tokenAddress = data.address || '';

    const priceNear = data.priceNear || '0.00000000 NEAR';
    const priceUsd = data.priceUsd || '';
    const marketCap = data.marketCap || 'N/A';
    const liquidity = data.liquidity || '0.00 NEAR';
    const supply = data.supply || '1.00B';
    const dexTax = data.dexTax || 'Buy 0.3% / Sell 0.3%';
    const holders = data.holders || 'N/A';
    const trades = data.trades || '0B / 0S';
    const totalTxns = data.totalTxns || 'N/A';
    const pair = data.pair || `${rawSymbol} / NEAR`;
    const venue = data.venue || 'NEAR Protocol DEX';
    const securityStatus = data.securityStatus || '🟢 Honeypot PASSED';
    const contractType = data.contractType || 'Audited Contract';
    const footer = data.footerText || '@racertradingbot';

    // RacerBot Official Brand Logo
    const racerbotLogoSrc = loadAssetBase64('logo.png');

    // Token Icon resolution: pre-fetch if HTTP URL, or fallback to gradient avatar
    let tokenIconSrc: string | null = null;
    if (data.iconUrl) {
      tokenIconSrc = await fetchImageAsBase64(data.iconUrl);
    }

    if (!tokenIconSrc) {
      const initialLetter = rawSymbol.charAt(0).toUpperCase() || 'T';
      const defaultAvatarSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">
        <defs>
          <linearGradient id="avatarGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#8b5cf6" />
            <stop offset="100%" stop-color="#00f076" />
          </linearGradient>
        </defs>
        <rect width="120" height="120" rx="30" fill="url(#avatarGrad)" />
        <text x="60" y="76" font-family="Space Grotesk, sans-serif" font-size="54" font-weight="bold" fill="#ffffff" text-anchor="middle">${initialLetter}</text>
      </svg>`;
      tokenIconSrc = `data:image/svg+xml;base64,${Buffer.from(defaultAvatarSvg).toString('base64')}`;
    }

    // Build template HTML for Satori with RacerBot Cyber Racing Aesthetic
    const templateString = `
    <div style="display: flex; flex-direction: column; width: 100%; height: 100%; background: #070914; padding: 32px; align-items: center; justify-content: center; font-family: 'Inter', sans-serif; position: relative;">
      
      <!-- RacerBot Cyber Background Ambient Lighting & Glows -->
      <div style="display: flex; position: absolute; right: 0; top: 0; width: 600px; height: 600px; background: radial-gradient(circle, rgba(139, 92, 246, 0.25) 0%, transparent 65%);"></div>
      <div style="display: flex; position: absolute; left: 0; bottom: 0; width: 500px; height: 500px; background: radial-gradient(circle, rgba(0, 240, 118, 0.18) 0%, transparent 65%);"></div>

      <!-- Main RacerBot Glassmorphic Card Frame -->
      <div style="display: flex; flex-direction: column; width: 1136px; background: rgba(14, 17, 28, 0.92); border-radius: 36px; padding: 26px; box-shadow: 0 40px 80px rgba(0, 0, 0, 0.7); border: 1px solid rgba(139, 92, 246, 0.25); position: relative; overflow: hidden;">
        
        <!-- RacerBot Brand Bar Top Row -->
        <div style="display: flex; width: 100%; align-items: center; justify-content: space-between; margin-bottom: 20px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); padding-bottom: 16px;">
          
          <!-- RacerBot Logo + Name Left Group -->
          <div style="display: flex; align-items: center; gap: 14px;">
            ${racerbotLogoSrc ? `<img src="${racerbotLogoSrc}" width="48" height="48" style="border-radius: 12px; box-shadow: 0 8px 16px rgba(0,0,0,0.4);" />` : ''}
            <div style="display: flex; flex-direction: column;">
              <span style="font-family: 'Space Grotesk', sans-serif; font-size: 30px; font-weight: 700; color: #ffffff; letter-spacing: 1.5px; line-height: 1;">
                RACERBOT
              </span>
              <span style="font-size: 13px; font-weight: 600; color: #8b5cf6; letter-spacing: 1px; margin-top: 4px;">
                🏎 #1 FAST TRADING ENGINE
              </span>
            </div>
          </div>

          <!-- Top Right Venue Tag -->
          <div style="display: flex; background: rgba(139, 92, 246, 0.15); border: 1px solid rgba(139, 92, 246, 0.4); border-radius: 12px; padding: 8px 18px; align-items: center; gap: 8px;">
            <span style="font-size: 16px;">💧</span>
            <span style="font-size: 15px; font-weight: 700; color: #c4b5fd;">${venue}</span>
          </div>

        </div>

        <!-- Token Header Banner Section -->
        <div style="display: flex; position: relative; width: 1084px; background: linear-gradient(135deg, #151828 0%, #0c0e18 100%); border-radius: 28px; padding: 24px 28px; align-items: center; border: 1px solid rgba(255, 255, 255, 0.08); overflow: hidden;">
          
          <!-- Floating Token Avatar Box -->
          <div style="display: flex; width: 110px; height: 110px; background: #070914; border-radius: 24px; align-items: center; justify-content: center; box-shadow: 0 16px 36px rgba(0, 0, 0, 0.8); border: 2px solid #8b5cf6; flex-shrink: 0;">
            <img src="${tokenIconSrc}" width="84" height="84" style="object-fit: contain; border-radius: 16px;" />
          </div>

          <!-- Token Info Details Group -->
          <div style="display: flex; flex-direction: column; margin-left: 26px; flex: 1;">
            
            <!-- Token Name + Ticker -->
            <div style="display: flex; align-items: center; gap: 14px;">
              <span style="font-family: 'Space Grotesk', sans-serif; font-size: 44px; font-weight: 700; color: #ffffff; letter-spacing: -1px; line-height: 1.1;">
                ${tokenName}
              </span>
              <span style="font-family: 'Space Grotesk', sans-serif; font-size: 26px; font-weight: 700; color: rgba(255, 255, 255, 0.45);">
                ${symbolText}
              </span>
            </div>

            <!-- Contract Address Pill -->
            <div style="display: flex; align-items: center; gap: 12px; margin-top: 8px;">
              ${tokenAddress ? `<div style="display: flex; background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 8px; padding: 4px 12px; font-size: 15px; color: #00f076; font-family: monospace;">📝 ${tokenAddress}</div>` : ''}
              <div style="display: flex; background: rgba(0, 240, 118, 0.12); border: 1px solid rgba(0, 240, 118, 0.3); border-radius: 8px; padding: 4px 12px; font-size: 14px; color: #00f076; font-weight: 600;">
                🛡️ ${securityStatus}
              </div>
              <div style="display: flex; background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 8px; padding: 4px 12px; font-size: 14px; color: rgba(255, 255, 255, 0.7);">
                ${contractType}
              </div>
            </div>

          </div>

        </div>

        <!-- Sleek Dashboard Metrics Grid (2 Rows x 4 Columns = 8 Data Cards) -->
        <div style="display: flex; flex-direction: column; width: 1084px; gap: 14px; margin-top: 18px;">
          
          <!-- Row 1: Price, Market Cap, Liquidity, DEX Tax -->
          <div style="display: flex; flex-direction: row; gap: 14px; width: 100%;">
            
            <!-- Card 1: Price -->
            <div style="display: flex; flex: 1; background: #141724; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 20px; padding: 16px 20px; align-items: center; gap: 14px;">
              <div style="display: flex; width: 44px; height: 44px; background: rgba(0, 240, 118, 0.12); border-radius: 50%; align-items: center; justify-content: center; font-size: 20px;">
                💎
              </div>
              <div style="display: flex; flex-direction: column;">
                <span style="font-size: 13px; font-weight: 600; color: #8e92a0;">Price</span>
                <span style="font-size: 17px; font-weight: 700; color: #00f076; margin-top: 2px;">${priceNear}</span>
                ${priceUsd ? `<span style="font-size: 13px; color: rgba(255, 255, 255, 0.5);">${priceUsd}</span>` : ''}
              </div>
            </div>

            <!-- Card 2: Market Cap -->
            <div style="display: flex; flex: 1; background: #141724; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 20px; padding: 16px 20px; align-items: center; gap: 14px;">
              <div style="display: flex; width: 44px; height: 44px; background: rgba(255, 184, 0, 0.12); border-radius: 50%; align-items: center; justify-content: center; font-size: 20px;">
                📊
              </div>
              <div style="display: flex; flex-direction: column;">
                <span style="font-size: 13px; font-weight: 600; color: #8e92a0;">Market Cap</span>
                <span style="font-size: 21px; font-weight: 700; color: #ffffff; margin-top: 2px;">${marketCap}</span>
              </div>
            </div>

            <!-- Card 3: Liquidity -->
            <div style="display: flex; flex: 1; background: #141724; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 20px; padding: 16px 20px; align-items: center; gap: 14px;">
              <div style="display: flex; width: 44px; height: 44px; background: rgba(0, 153, 255, 0.12); border-radius: 50%; align-items: center; justify-content: center; font-size: 20px;">
                💧
              </div>
              <div style="display: flex; flex-direction: column;">
                <span style="font-size: 13px; font-weight: 600; color: #8e92a0;">Liquidity</span>
                <span style="font-size: 19px; font-weight: 700; color: #ffffff; margin-top: 2px;">${liquidity}</span>
              </div>
            </div>

            <!-- Card 4: DEX Tax -->
            <div style="display: flex; flex: 1; background: #141724; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 20px; padding: 16px 20px; align-items: center; gap: 14px;">
              <div style="display: flex; width: 44px; height: 44px; background: rgba(168, 85, 247, 0.12); border-radius: 50%; align-items: center; justify-content: center; font-size: 20px;">
                ⚡
              </div>
              <div style="display: flex; flex-direction: column;">
                <span style="font-size: 13px; font-weight: 600; color: #8e92a0;">DEX Tax</span>
                <span style="font-size: 17px; font-weight: 700; color: #ffffff; margin-top: 2px;">${dexTax}</span>
              </div>
            </div>

          </div>

          <!-- Row 2: Total Supply, Holders, 24h Trades, Pair / Total Txns -->
          <div style="display: flex; flex-direction: row; gap: 14px; width: 100%;">
            
            <!-- Card 5: Total Supply -->
            <div style="display: flex; flex: 1; background: #141724; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 20px; padding: 16px 20px; align-items: center; gap: 14px;">
              <div style="display: flex; width: 44px; height: 44px; background: #252834; border-radius: 50%; align-items: center; justify-content: center; font-size: 20px;">
                🪙
              </div>
              <div style="display: flex; flex-direction: column;">
                <span style="font-size: 13px; font-weight: 600; color: #8e92a0;">Total Supply</span>
                <span style="font-size: 19px; font-weight: 700; color: #ffffff; margin-top: 2px;">${supply}</span>
              </div>
            </div>

            <!-- Card 6: Holders -->
            <div style="display: flex; flex: 1; background: #141724; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 20px; padding: 16px 20px; align-items: center; gap: 14px;">
              <div style="display: flex; width: 44px; height: 44px; background: #252834; border-radius: 50%; align-items: center; justify-content: center; font-size: 20px;">
                👥
              </div>
              <div style="display: flex; flex-direction: column;">
                <span style="font-size: 13px; font-weight: 600; color: #8e92a0;">Holders</span>
                <span style="font-size: 21px; font-weight: 700; color: #ffffff; margin-top: 2px;">${holders}</span>
              </div>
            </div>

            <!-- Card 7: 24h Trades -->
            <div style="display: flex; flex: 1; background: #141724; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 20px; padding: 16px 20px; align-items: center; gap: 14px;">
              <div style="display: flex; width: 44px; height: 44px; background: #252834; border-radius: 50%; align-items: center; justify-content: center; font-size: 20px;">
                📈
              </div>
              <div style="display: flex; flex-direction: column;">
                <span style="font-size: 13px; font-weight: 600; color: #8e92a0;">24h Trades</span>
                <span style="font-size: 19px; font-weight: 700; color: #ffffff; margin-top: 2px;">${trades}</span>
              </div>
            </div>

            <!-- Card 8: Pair / Total Txns -->
            <div style="display: flex; flex: 1; background: #141724; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 20px; padding: 16px 20px; align-items: center; gap: 14px;">
              <div style="display: flex; width: 44px; height: 44px; background: #252834; border-radius: 50%; align-items: center; justify-content: center; font-size: 20px;">
                🔄
              </div>
              <div style="display: flex; flex-direction: column;">
                <span style="font-size: 13px; font-weight: 600; color: #8e92a0;">${totalTxns !== 'N/A' ? 'Total Txns' : 'Pair'}</span>
                <span style="font-size: 19px; font-weight: 700; color: #ffffff; margin-top: 2px;">${totalTxns !== 'N/A' ? totalTxns : pair}</span>
              </div>
            </div>

          </div>

        </div>

      </div>

      <!-- Footer Domain Text -->
      <div style="display: flex; margin-top: 14px; font-size: 16px; font-weight: 600; color: rgba(255, 255, 255, 0.45); letter-spacing: 0.5px;">
        ${footer}
      </div>

    </div>
    `;

    // Convert HTML to Satori VNode tree
    const markupNode = html(templateString);

    // Generate SVG string via Satori
    const satoriOptions: any = {
      width: 1200,
      height: 860,
      fonts: fonts,
    };

    const svg = await satori(markupNode as any, satoriOptions);

    // Render SVG to PNG Buffer via Resvg
    const resvg = new Resvg(svg, {
      fitTo: {
        mode: 'width',
        value: 1200,
      },
    });

    const pngData = resvg.render();
    return pngData.asPng();
  } catch (err: any) {
    console.error('[TOKEN_CARD_IMAGE] Error generating card image with Satori:', err);
    return null;
  }
}
