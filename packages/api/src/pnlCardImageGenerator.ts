import { PNLCardData } from './pnlCardGenerator.js';
import QRCode from 'qrcode';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Theme & Palettes ────────────────────────────────────────────────────────
// State rule: pnl >= 0 -> "win" (fox wins). pnl < 0 -> "loss" (turtle wins, fox loses).
// Profit (Win):  --a: #00f076 (vibrant green), --b: #8b5cf6 (purple), --glow: rgba(0,240,118,0.35)
// Loss:          --a: #ff334b (vibrant red),   --b: #8b5cf6 (purple), --glow: rgba(255,51,75,0.32)
// Base canvas: 1200 x 675, bg: #070914

const FONT_FILES: Array<{ file: string; family: string; weight?: string; style?: string }> = [
  { file: 'BarlowCondensed-BlackItalic.ttf', family: 'Barlow Condensed', weight: '900', style: 'italic' },
  { file: 'BarlowCondensed-ExtraBold.ttf', family: 'Barlow Condensed', weight: '800' },
  { file: 'Inter-Regular.ttf', family: 'Inter', weight: '400' },
  { file: 'Inter-SemiBold.ttf', family: 'Inter', weight: '600' },
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
      if (!fontPath) continue;
      try {
        canvasModule.registerFont(fontPath, {
          family: def.family,
          ...(def.weight ? { weight: def.weight } : {}),
          ...(def.style ? { style: def.style } : {}),
        });
      } catch (err: any) {
        console.warn(`[PNL_CARD_IMAGE] Could not register ${def.file}: ${err?.message ?? err}`);
      }
    }
  }
} catch {
  console.warn('[PNL_CARD_IMAGE] Canvas not available. PNL cards will be text-only.');
}

type FontRole = 'display' | 'brand' | 'token' | 'body' | 'bodyBold' | 'statsNum' | 'statsLabel';

const FONT_CANDIDATES: Record<FontRole, Array<(px: number) => string>> = {
  display: [
    (px) => `italic 800 ${px}px "Barlow Condensed"`,
    (px) => `italic 900 ${px}px "Barlow Condensed"`,
    (px) => `800 ${px}px "Barlow Condensed"`,
    (px) => `bold italic ${px}px "Arial Narrow", Impact, sans-serif`,
    (px) => `bold italic ${px}px sans-serif`,
  ],
  brand: [
    (px) => `italic 800 ${px}px "Barlow Condensed"`,
    (px) => `800 ${px}px "Barlow Condensed"`,
    (px) => `bold italic ${px}px "Arial Narrow", Impact, sans-serif`,
    (px) => `bold italic ${px}px sans-serif`,
  ],
  token: [
    (px) => `italic 800 ${px}px "Barlow Condensed"`,
    (px) => `800 ${px}px "Barlow Condensed"`,
    (px) => `bold italic ${px}px "Arial Narrow", Impact, sans-serif`,
    (px) => `bold italic ${px}px sans-serif`,
  ],
  body: [
    (px) => `400 ${px}px "Inter", "Sora", sans-serif`,
    (px) => `${px}px "Inter", "Sora", sans-serif`,
    (px) => `${px}px sans-serif`,
  ],
  bodyBold: [
    (px) => `600 ${px}px "Inter", "Sora", sans-serif`,
    (px) => `bold ${px}px "Inter", "Sora", sans-serif`,
    (px) => `bold ${px}px sans-serif`,
  ],
  statsNum: [
    (px) => `italic 700 ${px}px "Barlow Condensed"`,
    (px) => `italic 800 ${px}px "Barlow Condensed"`,
    (px) => `800 ${px}px "Barlow Condensed"`,
    (px) => `bold italic ${px}px "Arial Narrow", Impact, sans-serif`,
    (px) => `bold ${px}px sans-serif`,
  ],
  statsLabel: [
    (px) => `400 ${px}px "Inter", "Sora", sans-serif`,
    (px) => `${px}px "Inter", "Sora", sans-serif`,
    (px) => `${px}px sans-serif`,
  ],
};

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

const fontStack: Record<FontRole, (px: number) => string> = {
  display: (px) => `bold italic ${px}px "Arial Narrow", Impact, sans-serif`,
  brand: (px) => `bold italic ${px}px "Arial Narrow", Impact, sans-serif`,
  token: (px) => `bold italic ${px}px "Arial Narrow", Impact, sans-serif`,
  body: (px) => `${px}px sans-serif`,
  bodyBold: (px) => `bold ${px}px sans-serif`,
  statsNum: (px) => `bold italic ${px}px "Arial Narrow", Impact, sans-serif`,
  statsLabel: (px) => `${px}px sans-serif`,
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

// ── Asset Resolvers ─────────────────────────────────────────────────────────

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

// ── Formatters ──────────────────────────────────────────────────────────────

function fmtMcap(nearValue: number, nr: number): string {
  if (!nearValue || nearValue <= 0) return '$0.00K';
  const v = nearValue * nr;
  if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(2)}K`;
  return `$${v.toFixed(2)}`;
}

function fmtUsd(v: number): string {
  if (!v || v === 0) return '$0.00';
  if (Math.abs(v) >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (Math.abs(v) >= 1_000) return `$${(v / 1_000).toFixed(2)}K`;
  if (Math.abs(v) >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(4)}`;
}

// ── Canvas Helpers ──────────────────────────────────────────────────────────

function roundRect(ctx: any, x: number, y: number, w: number, h: number, r: number) {
  if (w < 2 * r) r = w / 2;
  if (h < 2 * r) r = h / 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Generate the RacerBot PnL Card Image.
 * Dimensions: 1200 x 675.
 * High-performance, modern, cyber-racing theme with Fox & Turtle race track mechanics.
 */
export async function generatePNLCardImage(data: PNLCardData): Promise<Buffer | null> {
  if (!canvasModule) return null;
  ensureFontsProbed();

  try {
    const { createCanvas, loadImage } = canvasModule;
    const nr = data.nearUsd || 1;

    const W = 1200;
    const H = 675;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');

    const p = Number(data.pnlPercent) || 0;
    const win = p >= 0;

    // Theme colors: Green for profit, Red for loss
    const colorA = win ? '#00f076' : '#ff334b';
    const colorB = '#8b5cf6';
    const glowColor = win ? 'rgba(0, 240, 118, 0.35)' : 'rgba(255, 51, 75, 0.32)';
    const bgColor = '#070914';

    // 1. Clip base rounded rectangle (border-radius: 28px)
    ctx.save();
    roundRect(ctx, 0, 0, W, H, 28);
    ctx.clip();

    // 2. Base Dark Background
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, W, H);

    // 3. Radial Glow Gradients:
    // radial-gradient(900px 500px at 85% 20%, rgba(139,92,246,.35), transparent 60%)
    const g1 = ctx.createRadialGradient(W * 0.85, H * 0.20, 0, W * 0.85, H * 0.20, 600);
    g1.addColorStop(0, 'rgba(139, 92, 246, 0.35)');
    g1.addColorStop(0.6, 'rgba(139, 92, 246, 0)');
    g1.addColorStop(1, 'transparent');
    ctx.fillStyle = g1;
    ctx.fillRect(0, 0, W, H);

    // radial-gradient(700px 400px at 10% 100%, var(--glow), transparent 65%)
    const g2 = ctx.createRadialGradient(W * 0.10, H, 0, W * 0.10, H, 500);
    g2.addColorStop(0, glowColor);
    g2.addColorStop(0.65, 'rgba(0, 0, 0, 0)');
    g2.addColorStop(1, 'transparent');
    ctx.fillStyle = g2;
    ctx.fillRect(0, 0, W, H);

    // 4. Diagonal Lines Background:
    // repeating-linear-gradient(115deg, transparent 0 46px, rgba(255,255,255,.035) 46px 48px)
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.035)';
    ctx.lineWidth = 2;
    const rad = (115 * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const diagDist = Math.sqrt(W * W + H * H) * 1.5;
    for (let offset = -diagDist; offset <= diagDist; offset += 48) {
      const cx = W / 2 + offset * cos;
      const cy = H / 2 + offset * sin;
      ctx.beginPath();
      ctx.moveTo(cx - 1500 * -sin, cy - 1500 * cos);
      ctx.lineTo(cx + 1500 * -sin, cy + 1500 * cos);
      ctx.stroke();
    }
    ctx.restore();

    // 5. Skewed Right Panel:
    // right: -60px; top: -40px; width: 520px; height: 780px; transform: skewX(-12deg);
    // background: linear-gradient(180deg, rgba(139,92,246,.28), rgba(139,92,246,.05));
    // border-left: 3px solid var(--b);
    ctx.save();
    ctx.transform(1, 0, Math.tan((-12 * Math.PI) / 180), 1, 0, 0);
    const panelX = W - 460;
    const panelY = -40;
    const panelW = 560;
    const panelH = 780;
    const panelGrad = ctx.createLinearGradient(0, panelY, 0, panelY + panelH);
    panelGrad.addColorStop(0, 'rgba(139, 92, 246, 0.28)');
    panelGrad.addColorStop(1, 'rgba(139, 92, 246, 0.05)');
    ctx.fillStyle = panelGrad;
    ctx.fillRect(panelX, panelY, panelW, panelH);

    ctx.strokeStyle = colorB;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(panelX, panelY);
    ctx.lineTo(panelX, panelY + panelH);
    ctx.stroke();
    ctx.restore();

    // 6. Glowing Ring:
    // right: 70px; top: 90px; width: 360px; height: 360px; border-radius: 50%;
    // background: radial-gradient(circle, var(--glow), transparent 68%)
    const ringCx = W - 70 - 180;
    const ringCy = 90 + 180;
    const ringGrad = ctx.createRadialGradient(ringCx, ringCy, 0, ringCx, ringCy, 180);
    ringGrad.addColorStop(0, glowColor);
    ringGrad.addColorStop(0.68, 'rgba(0, 0, 0, 0)');
    ringGrad.addColorStop(1, 'transparent');
    ctx.fillStyle = ringGrad;
    ctx.beginPath();
    ctx.arc(ringCx, ringCy, 180, 0, Math.PI * 2);
    ctx.fill();

    // 7. Right Mascot Illustration (Fox for win, Turtle for loss)
    // .rb-card[data-state="win"] .rb-fox { display:block; right:44px; top:34px; height:596px }
    // .rb-card[data-state="loss"] .rb-turtle { display:block; right:110px; top:50px; height:400px }
    const mascotName = win ? 'fox-win.png' : 'turtle.png';
    const mascotPath = resolveAsset(mascotName);
    if (mascotPath && typeof loadImage === 'function') {
      try {
        const mascotImg = await loadImage(mascotPath);
        if (win) {
          // Fox at right: 30px; top: 60px; height: 520px
          const mH = 520;
          const mW = (mascotImg.width / mascotImg.height) * mH;
          const mX = W - 30 - mW;
          const mY = 60;
          ctx.save();
          ctx.shadowColor = 'rgba(0,0,0,0.55)';
          ctx.shadowBlur = 28;
          ctx.shadowOffsetY = 18;
          ctx.drawImage(mascotImg, mX, mY, mW, mH);
          ctx.restore();
        } else {
          // Turtle at right: 70px; top: 60px; height: 420px
          const mH = 420;
          const mW = (mascotImg.width / mascotImg.height) * mH;
          const mX = W - 70 - mW;
          const mY = 60;
          ctx.save();
          ctx.shadowColor = 'rgba(0,0,0,0.55)';
          ctx.shadowBlur = 28;
          ctx.shadowOffsetY = 18;
          ctx.drawImage(mascotImg, mX, mY, mW, mH);
          ctx.restore();
        }
      } catch (e) {
        console.warn('[PNL_CARD_IMAGE] Could not draw mascot image:', e);
      }
    }

    // 8. Brand Header:
    // left: 52px; top: 36px; display: flex; align-items: center; gap: 14px;
    // font: italic 800 36px 'Barlow Condensed'; letter-spacing: 1px
    const logoPath = resolveAsset('logo.png');
    let brandX = 52;
    if (logoPath && typeof loadImage === 'function') {
      try {
        const logoImg = await loadImage(logoPath);
        ctx.save();
        ctx.beginPath();
        ctx.arc(52 + 28, 36 + 28, 28, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(logoImg, 52, 36, 56, 56);
        ctx.restore();
        brandX = 52 + 56 + 14;
      } catch {
        brandX = 52;
      }
    }

    ctx.fillStyle = '#ffffff';
    ctx.font = fontStack.brand(36);
    ctx.textBaseline = 'middle';
    ctx.fillText('RACERBOT', brandX, 36 + 28);

    // 9. Position Chip:
    // left: 52px; top: 112px; display: inline-flex; gap: 10px; align-items: center;
    // padding: 8px 16px; border-radius: 999px; background: rgba(255,255,255,.07);
    // border: 1px solid var(--a); font-size: 15px; font-weight: 600
    const chipText = data.positionStatus === 'closed'
      ? (win ? 'Closed position, race won' : 'Closed position, race lost')
      : (win ? 'Open position, winning the race' : 'Open position, losing the race');

    ctx.font = fontStack.bodyBold(15);
    const chipTextW = ctx.measureText(chipText).width;
    const chipW = 16 + 9 + 10 + chipTextW + 16;
    const chipH = 34;
    const chipX = 52;
    const chipY = 112;

    ctx.save();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.07)';
    roundRect(ctx, chipX, chipY, chipW, chipH, 17);
    ctx.fill();

    ctx.strokeStyle = colorA;
    ctx.lineWidth = 1;
    roundRect(ctx, chipX, chipY, chipW, chipH, 17);
    ctx.stroke();

    // Chip glowing dot
    ctx.fillStyle = colorA;
    ctx.shadowColor = colorA;
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(chipX + 16 + 4.5, chipY + chipH / 2, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Chip text
    ctx.fillStyle = '#ffffff';
    ctx.font = fontStack.bodyBold(15);
    ctx.textBaseline = 'middle';
    ctx.fillText(chipText, chipX + 16 + 9 + 10, chipY + chipH / 2);

    // 10. Token & Handle:
    // left: 52px; top: 164px; font: italic 800 76px/1 'Barlow Condensed'
    // small: font: 400 20px Sora; opacity: .6; margin-left: 14px
    const sym = String(data.tokenSymbol || '').toUpperCase();
    const handle = String(data.tokenName || data.tokenSymbol || '');
    ctx.textBaseline = 'top';
    ctx.font = fontStack.token(76);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(sym, 52, 164);
    const symW = ctx.measureText(sym).width;

    ctx.font = fontStack.body(20);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.fillText(handle, 52 + symW + 14, 164 + 44);

    // 11. Hero PnL Percentage:
    // left: 46px; top: 228px; font: italic 800 190px/1 'Barlow Condensed'
    // color: var(--a); text-shadow: 0 0 60px var(--glow); letter-spacing: -2px
    const pnlSign = win ? '+' : '';
    const pnlString = `${pnlSign}${p.toFixed(2)}%`;
    ctx.save();
    let pnlFontSize = 170;
    const maxPnlW = 660; // leaves space for skewed panel and mascot on right
    ctx.font = fontStack.display(pnlFontSize);
    while (pnlFontSize > 70 && ctx.measureText(pnlString).width > maxPnlW) {
      pnlFontSize -= 4;
      ctx.font = fontStack.display(pnlFontSize);
    }
    ctx.fillStyle = colorA;
    ctx.shadowColor = glowColor;
    ctx.shadowBlur = 60;
    ctx.textBaseline = 'top';
    ctx.fillText(pnlString, 46, 228 + (170 - pnlFontSize) * 0.5);
    ctx.restore();

    // 12. Verdict Caption:
    // left: 54px; top: 420px; font-size: 20px; opacity: .85
    const verdictText = win
      ? 'Fox crossed the line first.'
      : 'Turtle took this one. Regroup and run again.';
    ctx.font = fontStack.body(20);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.textBaseline = 'top';
    ctx.fillText(verdictText, 54, 420);

    // 13. Race Track:
    // left: 52px; right: 52px; top: 458px; height: 64px
    const trackLeft = 52;
    const trackRight = W - 52;
    const trackWidth = trackRight - trackLeft;
    const trackTop = 458;
    const laneY = trackTop + 28;
    const laneH = 8;

    // Track Lane base (opacity 0.1)
    ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
    roundRect(ctx, trackLeft, laneY, trackWidth, laneH, 4);
    ctx.fill();

    // Race progress calculation: pos = Math.max(5, Math.min(94, 55 + p * 0.4))
    const posPercent = Math.max(5, Math.min(94, 55 + p * 0.4));
    const fillWidth = (trackWidth * posPercent) / 100;

    // Track Fill gradient
    ctx.save();
    const fillGrad = ctx.createLinearGradient(trackLeft, laneY, trackLeft + fillWidth, laneY);
    fillGrad.addColorStop(0, colorB);
    fillGrad.addColorStop(1, colorA);
    ctx.fillStyle = fillGrad;
    ctx.shadowColor = colorA;
    ctx.shadowBlur = 18;
    roundRect(ctx, trackLeft, laneY, fillWidth, laneH, 4);
    ctx.fill();
    ctx.restore();

    // Checkered Flag at the end of the track:
    // right: 0; top: 12px; width: 30px; height: 40px; border-radius: 4px; border: 1px solid #fff3
    const flagW = 30;
    const flagH = 40;
    const flagX = trackRight - flagW;
    const flagY = trackTop + 12;

    ctx.save();
    roundRect(ctx, flagX, flagY, flagW, flagH, 4);
    ctx.clip();
    const checkSize = 10;
    for (let r = 0; r < Math.ceil(flagH / checkSize); r++) {
      for (let c = 0; c < Math.ceil(flagW / checkSize); c++) {
        ctx.fillStyle = (r + c) % 2 === 0 ? '#ffffff' : '#111111';
        ctx.fillRect(flagX + c * checkSize, flagY + r * checkSize, checkSize, checkSize);
      }
    }
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = 1;
    roundRect(ctx, flagX, flagY, flagW, flagH, 4);
    ctx.stroke();
    ctx.restore();

    // Turtle Runner sitting at 55%:
    // style="left:55%; height:56px"
    const turtleRunnerPath = resolveAsset('turtle.png');
    const turtleLeft = trackLeft + trackWidth * 0.55;
    if (turtleRunnerPath && typeof loadImage === 'function') {
      try {
        const turtleImg = await loadImage(turtleRunnerPath);
        const trH = 56;
        const trW = (turtleImg.width / turtleImg.height) * trH;
        ctx.drawImage(turtleImg, turtleLeft - trW / 2, trackTop + 4, trW, trH);
      } catch { /* skip */ }
    }

    // Fox Runner sitting at pos%:
    // style="left:pos%; height:54px; border-radius:50%; border:2px solid var(--a); background:#10142a; padding:2px"
    const foxRunnerPath = resolveAsset('fox-head.png');
    const foxLeft = trackLeft + trackWidth * (posPercent / 100);
    const foxSize = 54;
    const foxX = foxLeft - foxSize / 2;
    const foxY = trackTop + 4;

    ctx.save();
    // Circular background
    ctx.fillStyle = '#10142a';
    ctx.beginPath();
    ctx.arc(foxLeft, foxY + foxSize / 2, foxSize / 2, 0, Math.PI * 2);
    ctx.fill();

    // Circular border
    ctx.strokeStyle = colorA;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Clip and draw fox head
    if (foxRunnerPath && typeof loadImage === 'function') {
      try {
        const foxImg = await loadImage(foxRunnerPath);
        ctx.save();
        ctx.beginPath();
        ctx.arc(foxLeft, foxY + foxSize / 2, foxSize / 2 - 2, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(foxImg, foxX + 2, foxY + 2, foxSize - 4, foxSize - 4);
        ctx.restore();
      } catch { /* skip */ }
    }
    ctx.restore();

    // 14. Stats Bar:
    // left: 52px; right: badgeX - 20px; bottom: 40px; display: flex;
    // border-top: 1px solid rgba(255,255,255,.15); padding-top: 20px
    const statsLeft = 52;
    const badgeW = 320;
    const badgeMargin = 16;
    const badgeX = W - 52 - badgeW;
    const statsRight = badgeX - badgeMargin;
    const statsWidth = statsRight - statsLeft;
    const statsTop = H - 140;

    // Top border
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(statsLeft, statsTop);
    ctx.lineTo(statsRight, statsTop);
    ctx.stroke();

    const statsData: Array<{ label: string; value: string; color?: string }> = [];

    if (data.showNetWorth) {
      // 1. Initial Investment
      statsData.push({
        label: 'Invested',
        value: fmtUsd(data.initialInvestment * nr),
      });

      // 2. Realized PnL (or Current Value / Net Value)
      if (data.realizedPnl !== 0) {
        const isRealizedProf = data.realizedPnl >= 0;
        statsData.push({
          label: 'Realized PnL',
          value: `${isRealizedProf ? '+' : '-'}${fmtUsd(Math.abs(data.realizedPnl * nr))}`,
          color: isRealizedProf ? '#00f076' : '#ff334b',
        });
      } else {
        statsData.push({
          label: 'Current Value',
          value: fmtUsd(data.unrealizedValue * nr),
        });
      }

      // 3. Entry Market Cap
      statsData.push({
        label: 'Entry MC',
        value: fmtMcap(data.entryMarketCap, nr),
      });

      // 4. Current / Exit Market Cap
      statsData.push({
        label: data.positionStatus === 'closed' ? 'Exit MC' : 'Current MC',
        value: fmtMcap(data.currentMarketCap, nr),
      });

      // 5. Hold Time
      statsData.push({
        label: 'Hold Time',
        value: String(data.holdDuration || '-'),
      });
    } else {
      statsData.push({
        label: 'Entry market cap',
        value: fmtMcap(data.entryMarketCap, nr),
      });
      statsData.push({
        label: data.positionStatus === 'closed' ? 'Exit market cap' : 'Current market cap',
        value: fmtMcap(data.currentMarketCap, nr),
      });
      statsData.push({
        label: 'Hold time',
        value: String(data.holdDuration || '-'),
      });
    }

    const numCols = statsData.length;
    const colW = statsWidth / numCols;
    const valFontSize = numCols > 3 ? 34 : 46;
    const labelFontSize = numCols > 3 ? 13 : 15;

    statsData.forEach((st, i) => {
      const colX = statsLeft + i * colW;
      // Label
      ctx.font = fontStack.statsLabel(labelFontSize);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
      ctx.textBaseline = 'top';
      ctx.fillText(st.label, colX, statsTop + 20);

      // Value
      ctx.font = fontStack.statsNum(valFontSize);
      ctx.fillStyle = st.color || '#ffffff';
      ctx.fillText(st.value, colX, statsTop + (numCols > 3 ? 42 : 45));
    });

    // 15. Referral Barcode & QR Code Widget (Bottom Right):
    // Draws a high-tech Cyber-Racing telemetry badge containing:
    // - Scannable 2D Barcode (QR code) encoding the user's referral link
    // - Stylized 1D Barcode lines (racing telemetry aesthetic)
    // - User's referral code and scan callout
    const refCode = data.referralCode || 'RACERBOT';
    const refLink = data.referralLink || `https://t.me/racertradingbot?start=${refCode}`;

    const badgeH = 88;
    const badgeY = statsTop + 5;

    ctx.save();
    // Glassmorphic / dark panel background
    ctx.fillStyle = 'rgba(10, 14, 28, 0.88)';
    roundRect(ctx, badgeX, badgeY, badgeW, badgeH, 12);
    ctx.fill();

    // Subtle border with accent corner glow
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.lineWidth = 1;
    roundRect(ctx, badgeX, badgeY, badgeW, badgeH, 12);
    ctx.stroke();

    // Corner accents in theme color (green for win, red for loss)
    ctx.strokeStyle = colorA;
    ctx.lineWidth = 2;
    // Top-left corner bracket
    ctx.beginPath();
    ctx.moveTo(badgeX, badgeY + 14);
    ctx.lineTo(badgeX, badgeY + 6);
    ctx.arcTo(badgeX, badgeY, badgeX + 6, badgeY, 6);
    ctx.lineTo(badgeX + 14, badgeY);
    ctx.stroke();

    // Bottom-right corner bracket
    ctx.beginPath();
    ctx.moveTo(badgeX + badgeW - 14, badgeY + badgeH);
    ctx.lineTo(badgeX + badgeW - 6, badgeY + badgeH);
    ctx.arcTo(badgeX + badgeW, badgeY + badgeH, badgeX + badgeW, badgeY + badgeH - 6, 6);
    ctx.lineTo(badgeX + badgeW, badgeY + badgeH - 14);
    ctx.stroke();

    // Generate & draw scannable QR Code
    try {
      const qrSize = 68;
      const qrBuf = await QRCode.toBuffer(refLink, {
        type: 'png',
        margin: 0,
        width: qrSize,
        color: {
          dark: '#0a0e1c',
          light: '#ffffff',
        },
      });
      if (qrBuf && typeof loadImage === 'function') {
        const qrImg = await loadImage(qrBuf);
        // White rounded protective backdrop for crisp contrast
        ctx.fillStyle = '#ffffff';
        roundRect(ctx, badgeX + 10, badgeY + 10, qrSize, qrSize, 6);
        ctx.fill();

        ctx.drawImage(qrImg, badgeX + 10, badgeY + 10, qrSize, qrSize);
      }
    } catch (e) {
      console.warn('[PNL_CARD_IMAGE] Could not generate QR code:', e);
    }

    // Right column inside badge: Barcode + Referral Info
    const infoX = badgeX + 88;
    const infoW = badgeW - 98;

    // Stylized 1D Barcode lines
    const barcodeY = badgeY + 12;
    const barcodeH = 14;
    const barPattern = [2, 1, 3, 1, 1, 2, 4, 1, 2, 1, 3, 2, 1, 1, 4, 2, 1, 3, 1, 2, 1, 3, 2, 1, 4, 1, 2, 3, 1, 2];
    let curBarX = infoX;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    for (let b = 0; b < barPattern.length; b++) {
      const bw = barPattern[b];
      if (b % 2 === 0) {
        ctx.fillRect(curBarX, barcodeY, bw, barcodeH);
      }
      curBarX += bw + 1.5;
      if (curBarX > infoX + infoW - 4) break;
    }

    // Label: "SCAN TO TRADE"
    ctx.font = fontStack.bodyBold(11);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.textBaseline = 'top';
    ctx.fillText('SCAN TO TRADE', infoX, badgeY + 34);

    // Referral code display with theme color
    ctx.font = fontStack.statsNum(22);
    ctx.fillStyle = colorA;
    ctx.fillText(`REF: ${refCode}`, infoX, badgeY + 48);

    // Subtle bot link
    ctx.font = fontStack.body(11);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.fillText('t.me/racertradingbot', infoX, badgeY + 70);

    ctx.restore();

    // 16. Footer tag:
    // left: 52px; bottom: 14px; font-size: 14px; opacity: .6
    ctx.font = fontStack.body(14);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.textBaseline = 'bottom';
    ctx.fillText('@racertradingbot', 52, H - 14);

    ctx.restore(); // restore rounded card clipping

    return canvas.toBuffer('image/png') as Buffer;
  } catch (err: any) {
    console.error('[PNL_CARD_IMAGE] Error generating image:', err);
    return null;
  }
}