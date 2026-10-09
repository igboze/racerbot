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
  iconUrl?: string;
  supply?: string;
  launchpad?: string;
  pair?: string;
  dexStatus?: string;
  marketCap?: string;
  price?: string;
  footerText?: string;
  themeColor?: string;
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
 * Generates a sleek, high-resolution Token Data Card PNG image using Satori & Resvg.
 * Output Dimensions: 1200 x 750 (2x scaling for crisp retina display on mobile/Telegram).
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

    const tokenName = data.name || 'Intear';
    const rawSymbol = (data.symbol || 'TEAR').replace(/^\$/, '');
    const symbolText = `$${rawSymbol}`;
    const supply = data.supply || '21M';
    const launchpad = data.launchpad || 'rhea-finance';
    const pair = data.pair || 'NEAR';
    const dexStatus = data.dexStatus || 'Paid';
    const footer = data.footerText || 'dawn.trade';

    // Default icon svg base64 encoded if none supplied
    const defaultSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 24 24" fill="none" stroke="#0099ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/></svg>`;
    const defaultIconSvg = `data:image/svg+xml;base64,${Buffer.from(defaultSvg).toString('base64')}`;
    const iconSrc = data.iconUrl || defaultIconSvg;

    // Build template HTML for Satori
    const templateString = `
    <div style="display: flex; flex-direction: column; width: 100%; height: 100%; background: linear-gradient(135deg, #ff7e36 0%, #e65100 50%, #d84315 100%); padding: 36px; align-items: center; justify-content: center; font-family: 'Inter', sans-serif;">
      
      <!-- Ambient Card Container -->
      <div style="display: flex; flex-direction: column; width: 1120px; background: #121317; border-radius: 36px; padding: 20px; box-shadow: 0 40px 80px rgba(0, 0, 0, 0.5); border: 1px solid rgba(255, 255, 255, 0.12);">
        
        <!-- Header Banner Section -->
        <div style="display: flex; position: relative; width: 1080px; height: 380px; background: linear-gradient(135deg, #1b2838 0%, #0d131d 100%); border-radius: 28px; overflow: hidden; align-items: center; justify-content: center;">
          
          <!-- Background Droplet Watermark Graphic -->
          <div style="display: flex; position: absolute; right: 40px; top: 20px; opacity: 0.18;">
            <svg width="340" height="340" viewBox="0 0 100 100" fill="none" stroke="#0099ff" stroke-width="3">
              <path d="M50 15 C30 45, 20 60, 20 72 A30 30 0 0 0 80 72 C80 60, 70 45, 50 15 Z" />
            </svg>
          </div>

          <!-- Floating Token Avatar Square Box -->
          <div style="display: flex; position: absolute; left: 48px; top: 48px; width: 180px; height: 180px; background: #08090c; border-radius: 32px; align-items: center; justify-content: center; box-shadow: 0 24px 48px rgba(0, 0, 0, 0.7); border: 2px solid rgba(255, 255, 255, 0.12);">
            <img src="${iconSrc}" width="100" height="100" style="object-fit: contain;" />
          </div>

          <!-- Token Titles Center Group -->
          <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; margin-left: 100px;">
            <span style="font-family: 'Space Grotesk', sans-serif; font-size: 84px; font-weight: 700; color: #ffffff; letter-spacing: -2px; line-height: 1;">
              ${tokenName}
            </span>
            <span style="font-family: 'Space Grotesk', sans-serif; font-size: 40px; font-weight: 700; color: rgba(255, 255, 255, 0.45); margin-top: 12px; letter-spacing: 1px;">
              ${symbolText}
            </span>
          </div>
        </div>

        <!-- Metric Pills Grid (4 Cards Row) -->
        <div style="display: flex; flex-direction: row; width: 1080px; gap: 16px; margin-top: 20px;">
          
          <!-- Pill 1: Supply -->
          <div style="display: flex; flex: 1; background: #1a1c23; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 24px; padding: 20px 22px; align-items: center; gap: 18px;">
            <div style="display: flex; width: 54px; height: 54px; background: #252834; border-radius: 50%; align-items: center; justify-content: center; font-size: 24px;">
              🪙
            </div>
            <div style="display: flex; flex-direction: column;">
              <span style="font-size: 18px; font-weight: 600; color: #8e92a0;">Supply</span>
              <span style="font-size: 26px; font-weight: 700; color: #ffffff; margin-top: 2px;">${supply}</span>
            </div>
          </div>

          <!-- Pill 2: Launchpad -->
          <div style="display: flex; flex: 1; background: #1a1c23; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 24px; padding: 20px 22px; align-items: center; gap: 18px;">
            <div style="display: flex; width: 54px; height: 54px; background: #252834; border-radius: 50%; align-items: center; justify-content: center; font-size: 22px; font-weight: 700; color: #ffffff;">
              R
            </div>
            <div style="display: flex; flex-direction: column;">
              <span style="font-size: 18px; font-weight: 600; color: #8e92a0;">Launchpad</span>
              <span style="font-size: 24px; font-weight: 700; color: #ffffff; margin-top: 2px;">${launchpad}</span>
            </div>
          </div>

          <!-- Pill 3: Pair -->
          <div style="display: flex; flex: 1; background: #1a1c23; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 24px; padding: 20px 22px; align-items: center; gap: 18px;">
            <div style="display: flex; width: 54px; height: 54px; background: #00c08b; border-radius: 50%; align-items: center; justify-content: center; font-size: 22px; font-weight: 700; color: #ffffff;">
              N
            </div>
            <div style="display: flex; flex-direction: column;">
              <span style="font-size: 18px; font-weight: 600; color: #8e92a0;">Pair</span>
              <span style="font-size: 26px; font-weight: 700; color: #ffffff; margin-top: 2px;">${pair}</span>
            </div>
          </div>

          <!-- Pill 4: Dex Status -->
          <div style="display: flex; flex: 1; background: #1a1c23; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 24px; padding: 20px 22px; align-items: center; gap: 18px;">
            <div style="display: flex; width: 54px; height: 54px; background: #1b3827; border-radius: 50%; align-items: center; justify-content: center; font-size: 24px;">
              🦅
            </div>
            <div style="display: flex; flex-direction: column;">
              <span style="font-size: 18px; font-weight: 600; color: #8e92a0;">Dex Status</span>
              <span style="font-size: 26px; font-weight: 700; color: #ffffff; margin-top: 2px;">${dexStatus}</span>
            </div>
          </div>

        </div>

      </div>

      <!-- Footer Domain Text -->
      <div style="display: flex; margin-top: 18px; font-size: 20px; font-weight: 600; color: rgba(255, 255, 255, 0.45); letter-spacing: 0.5px;">
        ${footer}
      </div>

    </div>
    `;

    // Convert HTML to Satori VNode tree
    const markupNode = html(templateString);

    // Generate SVG string via Satori
    const satoriOptions: any = {
      width: 1200,
      height: 750,
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
