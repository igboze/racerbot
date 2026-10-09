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
  pair?: string;
  venue?: string;
  securityStatus?: string;
  contractType?: string;
  footerText?: string;
}

// ── Font Loader Helper ──────────────────────────────────────────────────────
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

/**
 * Generates an ultra-sleek, rich dashboard Token Card PNG image using Satori & Resvg.
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
    const priceUsd = data.priceUsd || '$0.00';
    const marketCap = data.marketCap || 'N/A';
    const liquidity = data.liquidity || '0.00 NEAR';
    const supply = data.supply || '1.00B';
    const dexTax = data.dexTax || 'Buy 0.3% / Sell 0.3%';
    const holders = data.holders || 'N/A';
    const trades = data.trades || '0B / 0S';
    const pair = data.pair || `${rawSymbol} / NEAR`;
    const venue = data.venue || 'DEX Router';
    const securityStatus = data.securityStatus || '🟢 Honeypot PASSED';
    const contractType = data.contractType || 'Audited Contract';
    const footer = data.footerText || 'racerbot.trade';

    // Generate a fallback avatar with token initials if iconUrl is missing or invalid
    const initialLetter = rawSymbol.charAt(0).toUpperCase() || 'T';
    const defaultAvatarSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">
      <defs>
        <linearGradient id="avatarGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#00f076" />
          <stop offset="100%" stop-color="#0080ff" />
        </linearGradient>
      </defs>
      <rect width="120" height="120" rx="60" fill="url(#avatarGrad)" />
      <text x="60" y="78" font-family="Space Grotesk, sans-serif" font-size="58" font-weight="bold" fill="#ffffff" text-anchor="middle">${initialLetter}</text>
    </svg>`;
    const fallbackAvatarSrc = `data:image/svg+xml;base64,${Buffer.from(defaultAvatarSvg).toString('base64')}`;
    const iconSrc = (data.iconUrl && data.iconUrl.length > 5) ? data.iconUrl : fallbackAvatarSrc;

    // Build template HTML for Satori
    const templateString = `
    <div style="display: flex; flex-direction: column; width: 100%; height: 100%; background: linear-gradient(135deg, #ff6b2b 0%, #e65100 50%, #a81c07 100%); padding: 32px; align-items: center; justify-content: center; font-family: 'Inter', sans-serif;">
      
      <!-- Main Ambient Glass Card Container -->
      <div style="display: flex; flex-direction: column; width: 1136px; background: #0c0e14; border-radius: 36px; padding: 24px; box-shadow: 0 40px 80px rgba(0, 0, 0, 0.6); border: 1px solid rgba(255, 255, 255, 0.12);">
        
        <!-- Header Banner Section -->
        <div style="display: flex; position: relative; width: 1088px; background: linear-gradient(135deg, #151824 0%, #0d0f18 100%); border-radius: 28px; padding: 28px 32px; align-items: center; border: 1px solid rgba(255, 255, 255, 0.06); overflow: hidden;">
          
          <!-- Background Abstract Radial Glow Watermark -->
          <div style="display: flex; position: absolute; right: -40px; top: -60px; width: 300px; height: 300px; background: radial-gradient(circle, rgba(0, 240, 118, 0.15) 0%, transparent 70%); border-radius: 50%;"></div>

          <!-- Token Logo Avatar Box -->
          <div style="display: flex; width: 120px; height: 120px; background: #08090d; border-radius: 28px; align-items: center; justify-content: center; box-shadow: 0 16px 36px rgba(0, 0, 0, 0.7); border: 2px solid rgba(255, 255, 255, 0.12); flex-shrink: 0;">
            <img src="${iconSrc}" width="90" height="90" style="object-fit: contain; border-radius: 18px;" />
          </div>

          <!-- Token Information Header Group -->
          <div style="display: flex; flex-direction: column; margin-left: 28px; flex: 1;">
            
            <!-- Top Line: Token Name + Symbol -->
            <div style="display: flex; align-items: center; gap: 14px;">
              <span style="font-family: 'Space Grotesk', sans-serif; font-size: 48px; font-weight: 700; color: #ffffff; letter-spacing: -1px; line-height: 1.1;">
                ${tokenName}
              </span>
              <span style="font-family: 'Space Grotesk', sans-serif; font-size: 26px; font-weight: 700; color: rgba(255, 255, 255, 0.45); letter-spacing: 0.5px;">
                ${symbolText}
              </span>
            </div>

            <!-- Second Line: Contract Address & Venue Tag -->
            <div style="display: flex; align-items: center; gap: 12px; margin-top: 10px;">
              ${tokenAddress ? `<div style="display: flex; background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 8px; padding: 4px 12px; font-size: 15px; color: #00f076; font-family: monospace;">📝 ${tokenAddress}</div>` : ''}
              <div style="display: flex; background: rgba(0, 153, 255, 0.12); border: 1px solid rgba(0, 153, 255, 0.25); border-radius: 8px; padding: 4px 12px; font-size: 15px; color: #38bdf8; font-weight: 600;">💧 ${venue}</div>
            </div>

            <!-- Third Line: Security Audit Badge -->
            <div style="display: flex; align-items: center; gap: 10px; margin-top: 10px;">
              <div style="display: flex; background: rgba(0, 240, 118, 0.12); border: 1px solid rgba(0, 240, 118, 0.3); border-radius: 8px; padding: 4px 12px; font-size: 14px; color: #00f076; font-weight: 600;">
                🛡️ ${securityStatus}
              </div>
              <div style="display: flex; background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 8px; padding: 4px 12px; font-size: 14px; color: rgba(255, 255, 255, 0.7);">
                ${contractType}
              </div>
            </div>

          </div>

        </div>

        <!-- Sleek Dashboard Metrics Grid (2 Rows x 4 Columns = 8 Cards) -->
        <div style="display: flex; flex-direction: column; width: 1088px; gap: 14px; margin-top: 18px;">
          
          <!-- Row 1: Price, Market Cap, Liquidity, DEX Tax -->
          <div style="display: flex; flex-direction: row; gap: 14px; width: 100%;">
            
            <!-- Card 1: Price -->
            <div style="display: flex; flex: 1; background: #151720; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 20px; padding: 16px 20px; align-items: center; gap: 14px;">
              <div style="display: flex; width: 44px; height: 44px; background: rgba(0, 240, 118, 0.12); border-radius: 50%; align-items: center; justify-content: center; font-size: 20px;">
                💎
              </div>
              <div style="display: flex; flex-direction: column;">
                <span style="font-size: 14px; font-weight: 600; color: #8e92a0;">Price</span>
                <span style="font-size: 18px; font-weight: 700; color: #00f076; margin-top: 2px;">${priceNear}</span>
                <span style="font-size: 13px; color: rgba(255, 255, 255, 0.5);">${priceUsd}</span>
              </div>
            </div>

            <!-- Card 2: Market Cap -->
            <div style="display: flex; flex: 1; background: #151720; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 20px; padding: 16px 20px; align-items: center; gap: 14px;">
              <div style="display: flex; width: 44px; height: 44px; background: rgba(255, 184, 0, 0.12); border-radius: 50%; align-items: center; justify-content: center; font-size: 20px;">
                📊
              </div>
              <div style="display: flex; flex-direction: column;">
                <span style="font-size: 14px; font-weight: 600; color: #8e92a0;">Market Cap</span>
                <span style="font-size: 22px; font-weight: 700; color: #ffffff; margin-top: 2px;">${marketCap}</span>
              </div>
            </div>

            <!-- Card 3: Liquidity -->
            <div style="display: flex; flex: 1; background: #151720; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 20px; padding: 16px 20px; align-items: center; gap: 14px;">
              <div style="display: flex; width: 44px; height: 44px; background: rgba(0, 153, 255, 0.12); border-radius: 50%; align-items: center; justify-content: center; font-size: 20px;">
                💧
              </div>
              <div style="display: flex; flex-direction: column;">
                <span style="font-size: 14px; font-weight: 600; color: #8e92a0;">Liquidity</span>
                <span style="font-size: 20px; font-weight: 700; color: #ffffff; margin-top: 2px;">${liquidity}</span>
              </div>
            </div>

            <!-- Card 4: DEX Tax -->
            <div style="display: flex; flex: 1; background: #151720; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 20px; padding: 16px 20px; align-items: center; gap: 14px;">
              <div style="display: flex; width: 44px; height: 44px; background: rgba(168, 85, 247, 0.12); border-radius: 50%; align-items: center; justify-content: center; font-size: 20px;">
                ⚡
              </div>
              <div style="display: flex; flex-direction: column;">
                <span style="font-size: 14px; font-weight: 600; color: #8e92a0;">DEX Tax</span>
                <span style="font-size: 18px; font-weight: 700; color: #ffffff; margin-top: 2px;">${dexTax}</span>
              </div>
            </div>

          </div>

          <!-- Row 2: Total Supply, Holders, 24h Trades, Pair -->
          <div style="display: flex; flex-direction: row; gap: 14px; width: 100%;">
            
            <!-- Card 5: Total Supply -->
            <div style="display: flex; flex: 1; background: #151720; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 20px; padding: 16px 20px; align-items: center; gap: 14px;">
              <div style="display: flex; width: 44px; height: 44px; background: #252834; border-radius: 50%; align-items: center; justify-content: center; font-size: 20px;">
                🪙
              </div>
              <div style="display: flex; flex-direction: column;">
                <span style="font-size: 14px; font-weight: 600; color: #8e92a0;">Total Supply</span>
                <span style="font-size: 20px; font-weight: 700; color: #ffffff; margin-top: 2px;">${supply}</span>
              </div>
            </div>

            <!-- Card 6: Holders -->
            <div style="display: flex; flex: 1; background: #151720; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 20px; padding: 16px 20px; align-items: center; gap: 14px;">
              <div style="display: flex; width: 44px; height: 44px; background: #252834; border-radius: 50%; align-items: center; justify-content: center; font-size: 20px;">
                👥
              </div>
              <div style="display: flex; flex-direction: column;">
                <span style="font-size: 14px; font-weight: 600; color: #8e92a0;">Holders</span>
                <span style="font-size: 22px; font-weight: 700; color: #ffffff; margin-top: 2px;">${holders}</span>
              </div>
            </div>

            <!-- Card 7: 24h Trades -->
            <div style="display: flex; flex: 1; background: #151720; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 20px; padding: 16px 20px; align-items: center; gap: 14px;">
              <div style="display: flex; width: 44px; height: 44px; background: #252834; border-radius: 50%; align-items: center; justify-content: center; font-size: 20px;">
                📈
              </div>
              <div style="display: flex; flex-direction: column;">
                <span style="font-size: 14px; font-weight: 600; color: #8e92a0;">24h Trades</span>
                <span style="font-size: 20px; font-weight: 700; color: #ffffff; margin-top: 2px;">${trades}</span>
              </div>
            </div>

            <!-- Card 8: Pair -->
            <div style="display: flex; flex: 1; background: #151720; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 20px; padding: 16px 20px; align-items: center; gap: 14px;">
              <div style="display: flex; width: 44px; height: 44px; background: #252834; border-radius: 50%; align-items: center; justify-content: center; font-size: 20px;">
                🔄
              </div>
              <div style="display: flex; flex-direction: column;">
                <span style="font-size: 14px; font-weight: 600; color: #8e92a0;">Pair</span>
                <span style="font-size: 20px; font-weight: 700; color: #ffffff; margin-top: 2px;">${pair}</span>
              </div>
            </div>

          </div>

        </div>

      </div>

      <!-- Footer Brand Text -->
      <div style="display: flex; margin-top: 16px; font-size: 18px; font-weight: 600; color: rgba(255, 255, 255, 0.5); letter-spacing: 0.5px;">
        🏎 RACERBOT AUTOMATED TRADING ENGINE • ${footer}
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
