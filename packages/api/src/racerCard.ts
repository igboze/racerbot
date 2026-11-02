import type { Express, Response } from 'express';
import { Markup, type Context, type Telegraf } from 'telegraf';
import {
  claimRacerRankUp,
  generateReferralCode,
  getNearRacerFills,
  getUserByExactReferralCode,
  getRacerRank,
  getUserById,
  getUserByTelegramId,
  raiseRacerBestKey,
  seedRacerRank,
  type NearRacerFillRow,
  type RacerRankRecord,
} from '@racerbot/db';
import {
  BADGE_LABELS,
  TIERS,
  buildRacerProfile,
  fillNearValue,
  isAnnounceableRankUp,
  racerVolume,
  rankKeyBeforeLatestFill,
  rankKeyFor,
  type RacerFill,
  type RacerProfile,
} from './racerRank.js';
import { generateRacerCardImage, generateRacerCardOgImage, type RacerCardImageData } from './racerCardImageGenerator.js';

/**
 * Anyone with a NEAR fill before this moment is a Founding Racer. Placeholder
 * until the owner sets the webapp launch date (RACER_FOUNDING_CUTOFF, ISO 8601;
 * "off" disables the badge).
 */
const DEFAULT_FOUNDING_CUTOFF = '2026-12-01T00:00:00Z';

export function foundingCutoff(): Date | null {
  const raw = (process.env.RACER_FOUNDING_CUTOFF ?? DEFAULT_FOUNDING_CUTOFF).trim();
  if (!raw || raw === 'off') return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** RACER_RANKUP_PROMPT=tier prompts only on a new tier; default prompts every level. */
export function rankUpPromptMode(): 'level' | 'tier' {
  return process.env.RACER_RANKUP_PROMPT?.trim().toLowerCase() === 'tier' ? 'tier' : 'level';
}

const BOT_LINK = 'https://t.me/racertradingbot';

/** Same rule as config.ts, read at call time so tests can set it. */
function publicBaseUrl(): string {
  const raw = process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '');
  return raw.replace(/\/+$/, '');
}

/**
 * Public card page that X and Telegram unfurl into the card image. The rank
 * key is in the URL so a rank-up is a new URL (X caches previews for days).
 * Null without a public URL or a real referral code: share the bot link then.
 */
export function racerCardPageUrl(code: string | null, rankKey: number): string | null {
  const base = publicBaseUrl();
  if (!base || !code) return null;
  return `${base}/c/${encodeURIComponent(code)}?r=${rankKey}`;
}
const FINISH_NAMES = { bronze: 'Bronze', silver: 'Silver', gold: 'Gold', holo: 'Holo' } as const;

export function toRacerFill(row: NearRacerFillRow): RacerFill {
  return {
    side: row.side === 'sell' ? 'sell' : 'buy',
    token: row.token_address,
    venue: row.venue,
    at: new Date(row.created_at),
    nearValue: fillNearValue(row.input_amount, row.fee_paid),
    positionId: row.position_id,
    positionClosed: row.position_status === 'closed',
  };
}

// Percentiles compare against every NEAR racer; a few minutes stale is fine.
const VOLUME_CACHE_MS = 5 * 60 * 1000;
let volumeCache: { at: number; volumes: number[] } | null = null;

export function clearRacerVolumeCache(): void {
  volumeCache = null;
}

async function allNetVolumes(): Promise<number[]> {
  if (volumeCache && Date.now() - volumeCache.at < VOLUME_CACHE_MS) return volumeCache.volumes;
  const byUser = new Map<string, RacerFill[]>();
  for (const row of await getNearRacerFills()) {
    const list = byUser.get(row.user_id) ?? [];
    list.push(toRacerFill(row));
    byUser.set(row.user_id, list);
  }
  const volumes = [...byUser.values()].map(fills => racerVolume(fills).net);
  volumeCache = { at: Date.now(), volumes };
  return volumes;
}

type CardUser = { id: string; username?: string | null; telegram_id?: number | null; referral_code?: string | null };

async function referralFor(user: CardUser) {
  let code = user.referral_code || null;
  if (!code) {
    code = await generateReferralCode(user.id, user.username || `racer${user.telegram_id}`).catch(() => null);
  }
  return { code: code || 'racerbot', link: code ? `${BOT_LINK}?start=${encodeURIComponent(code)}` : BOT_LINK };
}

export function racerShareText(p: RacerProfile): string {
  if (!p.hasTrades) return 'Just joined the race on @racertradingbot 🏁 Come trade NEAR with me.';
  const top = p.topPercent !== null ? ` Top ${p.topPercent}% of NEAR racers.` : '';
  return `I'm a ${p.rank.name} on @racertradingbot 🏁${top} Think you can catch me?`;
}

/** With `pageUrl` (the card page) the post shows the card image; else the bot link. */
export function racerShareLinks(p: RacerProfile, link: string, pageUrl: string | null = null): { x: string; telegram: string } {
  const text = racerShareText(p);
  const url = pageUrl ?? link;
  return {
    x: `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`,
    telegram: `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`,
  };
}

export function racerCardCaption(p: RacerProfile, rankedUp = false): string {
  if (!p.hasTrades) {
    return `🏁 <b>Your Racer Card: ${p.rank.name}</b>\n\n`
      + `Make your first NEAR trade to start climbing the ranks. Paste a token address to begin.`;
  }
  const lines: string[] = [];
  if (rankedUp) lines.push(`🎉 <b>You ranked up — share your new card?</b>`, '');
  lines.push(`🏁 <b>${p.rank.name}</b> · ${FINISH_NAMES[p.finish]} finish`);
  if (p.topPercent !== null) lines.push(`🏆 Top ${p.topPercent}% of NEAR racers`);
  if (p.rank.nextLevelName) lines.push(`📈 ${p.rank.progressPct}% of the way to ${p.rank.nextLevelName}`);
  if (p.badges.length) lines.push(`🎖 ${p.badges.map(b => BADGE_LABELS[b]).join(' · ')}`);
  lines.push('', 'Share your card. Friends who join with your link earn you referral rewards.');
  return lines.join('\n');
}

export function racerCardKeyboard(p: RacerProfile, link: string, pageUrl: string | null = null) {
  const share = racerShareLinks(p, link, pageUrl);
  return Markup.inlineKeyboard([
    [Markup.button.url('𝕏 Share on X', share.x), Markup.button.url('✈️ Share on Telegram', share.telegram)],
    [Markup.button.callback('🔄 Refresh', 'racer_card'), Markup.button.callback('🏠 Menu', 'menu_home')],
  ]);
}

interface RacerState {
  fills: RacerFill[];
  volumes: number[];
  stored: RacerRankRecord | null;
}

async function loadRacerState(userId: string): Promise<RacerState> {
  const [rows, volumes, stored] = await Promise.all([
    getNearRacerFills(userId),
    allNetVolumes(),
    getRacerRank(userId),
  ]);
  return { fills: rows.map(toRacerFill), volumes, stored };
}

function cardImageData(profile: RacerProfile, ref: { code: string; link: string }): RacerCardImageData {
  return {
    rankTitle: profile.rank.title,
    levelLabel: profile.rank.levelLabel,
    tierIndex: profile.rank.tierIndex,
    tierCount: TIERS.length,
    finish: profile.finish,
    topPercent: profile.topPercent,
    progressPct: profile.rank.progressPct,
    nextLevelName: profile.rank.nextLevelName,
    hasTrades: profile.hasTrades,
    badges: profile.badges.map(b => BADGE_LABELS[b]),
    referralCode: ref.code,
    referralLink: ref.link,
  };
}

async function renderRacerCard(user: CardUser, profile: RacerProfile, rankedUp: boolean) {
  const ref = await referralFor(user);
  const data = cardImageData(profile, ref);
  const image = await generateRacerCardImage(data);
  const pageUrl = ref.link !== BOT_LINK ? racerCardPageUrl(ref.code, profile.rank.key) : null;
  // Warm the share page so X's crawler gets the preview without waiting on a render
  if (image && pageUrl) rememberShareImages(ref.code, data, image);
  return {
    profile,
    image,
    caption: racerCardCaption(profile, rankedUp),
    keyboard: racerCardKeyboard(profile, ref.link, pageUrl),
  };
}

// ── Public card page (/c/:code) ──────────────────────────────────────────────

const SHARE_CACHE_MS = 30 * 60 * 1000;
const SHARE_CACHE_MAX = 500;
/** Renders in flight or done, so concurrent crawler requests share one render. */
interface ShareImages { sig: string; at: number; card: Promise<Buffer | null>; preview: Promise<Buffer | null> }
const shareCache = new Map<string, ShareImages>();

/**
 * Images for a card, from the cache when the card data is unchanged. A
 * rendered card (from /card) is reused instead of rendering it again.
 */
function shareImages(code: string, data: RacerCardImageData, rendered?: Buffer): ShareImages {
  const sig = JSON.stringify(data);
  const hit = shareCache.get(code);
  if (hit && hit.sig === sig && Date.now() - hit.at < SHARE_CACHE_MS) return hit;
  const card = rendered ? Promise.resolve(rendered) : generateRacerCardImage(data).catch(() => null);
  const preview = card.then(png => (png ? generateRacerCardOgImage(data, png) : null)).catch(() => null);
  const entry: ShareImages = { sig, at: Date.now(), card, preview };
  shareCache.delete(code);
  shareCache.set(code, entry);
  // A Map iterates oldest first: trim from the front
  while (shareCache.size > SHARE_CACHE_MAX) shareCache.delete(shareCache.keys().next().value!);
  return entry;
}

function rememberShareImages(code: string, data: RacerCardImageData, card: Buffer): void {
  shareImages(code, data, card);
}

export function clearRacerShareCache(): void {
  shareCache.clear();
}

/**
 * What a public card shows. Read-only: viewing someone's page never stores or
 * announces a rank. Only an exact referral code matches.
 */
async function publicCardData(code: string): Promise<RacerCardImageData | null> {
  const user = await getUserByExactReferralCode(code);
  if (!user?.referral_code) return null;
  const { fills, volumes, stored } = await loadRacerState(user.id);
  const profile = buildRacerProfile(fills, volumes, foundingCutoff(), stored?.best_key ?? 0);
  const refCode = user.referral_code;
  return cardImageData(profile, { code: refCode, link: `${BOT_LINK}?start=${encodeURIComponent(refCode)}` });
}

function escHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
}

/** The page X / Telegram crawl: card-image meta tags, then on to the bot. */
export function racerCardPageHtml(data: RacerCardImageData, rankParam: string): string {
  const base = publicBaseUrl();
  const rank = `${data.rankTitle} ${data.levelLabel}`;
  const title = data.hasTrades ? `${rank} on RacerBot` : 'Join the race on RacerBot';
  const desc = data.hasTrades
    ? `${data.topPercent !== null ? `Top ${data.topPercent}% of NEAR racers. ` : ''}Think you can catch me? Trade NEAR on RacerBot.`
    : 'Trade NEAR on RacerBot and climb the Racer ranks.';
  const q = rankParam ? `?r=${encodeURIComponent(rankParam)}` : '';
  const c = encodeURIComponent(data.referralCode);
  const page = `${base}/c/${c}${q}`;
  const previewImage = `${base}/c/${c}/preview.png${q}`;
  const cardImage = `${base}/c/${c}/card.png${q}`;
  const bot = data.referralLink;
  const alt = `NEAR Racer Card: ${rank}`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title)}</title>
<meta name="description" content="${escHtml(desc)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="RacerBot">
<meta property="og:url" content="${escHtml(page)}">
<meta property="og:title" content="${escHtml(title)}">
<meta property="og:description" content="${escHtml(desc)}">
<meta property="og:image" content="${escHtml(previewImage)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${escHtml(alt)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@racertradingbot">
<meta name="twitter:title" content="${escHtml(title)}">
<meta name="twitter:description" content="${escHtml(desc)}">
<meta name="twitter:image" content="${escHtml(previewImage)}">
<meta name="twitter:image:alt" content="${escHtml(alt)}">
<style>
body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;background:#07090f;color:#fff;font-family:system-ui,sans-serif;padding:16px;box-sizing:border-box}
img{width:min(100%,420px);height:auto;border-radius:18px}
a{background:#2ee6c9;color:#06221f;font-weight:700;text-decoration:none;padding:14px 28px;border-radius:999px}
</style>
</head><body>
<img src="${escHtml(cardImage)}" alt="${escHtml(alt)}">
<a href="${escHtml(bot)}">Get your Racer Card</a>
<script>setTimeout(function () { location.replace(${JSON.stringify(bot).replace(/</g, '\\u003c')}); }, 1500);</script>
</body></html>`;
}

function sendPng(res: Response, png: Buffer): void {
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'public, max-age=600');
  res.send(png);
}

const CODE_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Express routes for the public card page and its two images. */
export function registerRacerCardPages(app: Express): void {
  const rankParam = (q: unknown) => (typeof q === 'string' && /^\d{1,2}$/.test(q) ? q : '');

  app.get('/c/:code', async (req, res) => {
    try {
      const data = CODE_RE.test(req.params.code) ? await publicCardData(req.params.code) : null;
      if (!data) {
        res.status(404).set('Content-Type', 'text/html; charset=utf-8')
          .send(`<!doctype html><meta charset="utf-8"><title>RacerBot</title><p>Card not found. <a href="${BOT_LINK}">Open RacerBot</a></p>`);
        return;
      }
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.set('Cache-Control', 'public, max-age=300');
      // Start the render now: the crawler asks for the image right after the page
      shareImages(data.referralCode, data);
      res.send(racerCardPageHtml(data, rankParam(req.query.r)));
    } catch (err: any) {
      console.error('[RACER_CARD] Card page failed:', err?.message);
      res.redirect(302, BOT_LINK);
    }
  });

  app.get(['/c/:code/card.png', '/c/:code/preview.png'], async (req, res) => {
    try {
      const data = CODE_RE.test(req.params.code) ? await publicCardData(req.params.code) : null;
      const share = data ? shareImages(data.referralCode, data) : null;
      const png = share ? await (req.path.endsWith('/preview.png') ? share.preview : share.card) : null;
      if (!png) {
        res.status(404).send('Not found');
        return;
      }
      sendPng(res, png);
    } catch (err: any) {
      console.error('[RACER_CARD] Card image failed:', err?.message);
      res.status(500).send('Error');
    }
  });
}

/**
 * The user's card as they see it on /card. Viewing also keeps the stored rank
 * in step: first sight stores the current rank without announcing it, a higher
 * computed rank raises the stored best, and an unannounced rank-up shown here
 * counts as announced (the caption says so).
 */
export async function buildRacerCard(user: CardUser) {
  const { fills, volumes, stored } = await loadRacerState(user.id);
  const profile = buildRacerProfile(fills, volumes, foundingCutoff(), stored?.best_key ?? 0);
  let rankedUp = false;
  try {
    if (!stored) {
      await seedRacerRank(user.id, profile.rank.key, profile.rank.key);
    } else if (profile.rank.key > stored.announced_key) {
      // Also raises best_key; announced never exceeds best, so this covers a new best too
      rankedUp = await claimRacerRankUp(user.id, profile.rank.key);
    }
  } catch (err: any) {
    console.warn('[RACER_CARD] Could not store rank:', err?.message);
  }
  return renderRacerCard(user, profile, rankedUp);
}

export async function sendRacerCard(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  const user = await getUserByTelegramId(telegramId).catch(() => null);
  if (!user) {
    await ctx.reply('🏁 Tap /start to set up RacerBot first, then come back for your Racer Card.').catch(() => {});
    return;
  }
  try {
    const card = await buildRacerCard(user);
    const extra = { caption: card.caption, parse_mode: 'HTML' as const, reply_markup: card.keyboard.reply_markup };
    if (card.image) {
      await ctx.replyWithPhoto({ source: card.image }, extra);
    } else {
      await ctx.reply(card.caption, { parse_mode: 'HTML', reply_markup: card.keyboard.reply_markup });
    }
  } catch (err: any) {
    console.error('[RACER_CARD] Failed to build card:', err?.message);
    await ctx.reply('❌ Could not build your Racer Card right now. Please try again in a moment.').catch(() => {});
  }
}

// ── Rank-up announcements ────────────────────────────────────────────────────

/** Only a fill this fresh can be "the trade that just happened". */
const RANK_UP_MAX_FILL_AGE_MS = 10 * 60 * 1000;
let _bot: Telegraf | null = null;

/**
 * After a trade: announce a new lifetime rank exactly once, with the upgraded
 * card. Safe to call for any trade, any number of times (non-NEAR → no change;
 * the atomic claim in racer_ranks lets one caller win per rank).
 *
 * A user seen for the first time is stored at their current rank, announced up
 * to the rank before their latest fill — so after deploy nobody is told about a
 * rank they already had, but the trade that just crossed a line still counts.
 */
export async function maybeAnnounceRankUp(userId: string, telegram = _bot?.telegram): Promise<boolean> {
  if (!telegram || !userId) return false;
  try {
    const { fills, stored: existing } = await loadRacerState(userId);
    if (!fills.length) return false;
    const computed = rankKeyFor(racerVolume(fills).net);

    let stored = existing;
    if (!stored) {
      const latest = fills.reduce((t, f) => Math.max(t, f.at.getTime()), 0);
      const fresh = Date.now() - latest <= RANK_UP_MAX_FILL_AGE_MS;
      const announced = fresh ? Math.max(1, rankKeyBeforeLatestFill(fills)) : computed;
      stored = await seedRacerRank(userId, computed, announced);
    } else if (computed > stored.best_key) {
      await raiseRacerBestKey(userId, computed);
    }

    const target = Math.max(stored.best_key, computed);
    if (!isAnnounceableRankUp(stored.announced_key, target, rankUpPromptMode())) return false;
    if (!(await claimRacerRankUp(userId, target))) return false;

    const user = await getUserById(userId).catch(() => null);
    if (!user?.telegram_id) return true;
    clearRacerVolumeCache();
    const profile = buildRacerProfile(fills, await allNetVolumes(), foundingCutoff(), target);
    const card = await renderRacerCard(user, profile, true);
    const extra = { caption: card.caption, parse_mode: 'HTML' as const, reply_markup: card.keyboard.reply_markup };
    if (card.image) {
      await telegram.sendPhoto(user.telegram_id, { source: card.image }, extra);
    } else {
      await telegram.sendMessage(user.telegram_id, card.caption, { parse_mode: 'HTML', reply_markup: card.keyboard.reply_markup });
    }
    return true;
  } catch (err: any) {
    console.warn('[RACER_CARD] Rank-up check failed:', err?.message);
    return false;
  }
}

/**
 * Run the rank-up check now and/or later — for events that fire before the
 * fill is written (a trigger about to sell). Timers never hold the process open.
 */
export function scheduleRankUpCheck(userId: string, delaysMs: number[] = [0]): void {
  if (!userId) return;
  for (const delay of delaysMs) {
    if (delay <= 0) {
      void maybeAnnounceRankUp(userId);
      continue;
    }
    const timer = setTimeout(() => { void maybeAnnounceRankUp(userId); }, delay);
    timer.unref?.();
  }
}

export function registerRacerCard(bot: Telegraf): void {
  _bot = bot;
  bot.command(['card', 'racercard'], ctx => sendRacerCard(ctx));
  bot.action('racer_card', async ctx => {
    await ctx.answerCbQuery().catch(() => {});
    await sendRacerCard(ctx);
  });
}
