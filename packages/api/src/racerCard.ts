import crypto from 'crypto';
import type { Express, Response } from 'express';
import { Markup, type Context, type Telegraf } from 'telegraf';
import {
  claimRacerRankUp,
  consumeRacerLinkCode,
  createRacerLinkCode,
  generateReferralCode,
  setReferralCodeFromName,
  getConfidentialRacerExecutors,
  getNearRacerFills,
  getRacerLinkFor,
  listRacerLinks,
  getUserByExactReferralCode,
  getRacerRank,
  getUserById,
  getUserByTelegramId,
  linkRacerAccounts,
  peekRacerLinkCode,
  raiseRacerBestKey,
  seedRacerRank,
  type NearRacerFillRow,
  type RacerRankRecord,
} from '@racerbot/db';
import {
  BADGE_LABELS,
  TIERS,
  buildRacerProfile,
  executorFills,
  fillNearValue,
  isAnnounceableRankUp,
  racerVolume,
  rankKeyBeforeLatestFill,
  rankKeyFor,
  type RacerFill,
  type RacerProfile,
} from './racerRank.js';
import {
  CARD_H,
  CARD_W,
  LEVEL_COLORS,
  generateRacerCardImage,
  generateRacerCardOgImage,
  levelNumber,
  type RacerCardImageData,
} from './racerCardImageGenerator.js';

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

/**
 * Address of the public card pages, as people see it in shared posts: the
 * website domain in RACER_CARD_URL, never the server's own address. Without
 * it, shares use the plain bot link. A Railway host is refused even when set,
 * so the production server's address can never end up in a post.
 */
export function publicBaseUrl(): string {
  const raw = (process.env.RACER_CARD_URL || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || /(^|\.)railway\.app$/i.test(url.hostname)) return '';
    return url.origin;
  } catch {
    return '';
  }
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
  const [rows, executors, links] = await Promise.all([
    getNearRacerFills(),
    getConfidentialRacerExecutors(),
    listRacerLinks(),
  ]);
  // A linked wallet account races as its Telegram account
  const canonical = new Map(links.map(l => [l.wallet_user_id, l.telegram_user_id]));
  const byRacer = new Map<string, RacerFill[]>();
  const add = (userId: string, fills: RacerFill[]) => {
    const id = canonical.get(userId) ?? userId;
    byRacer.set(id, [...(byRacer.get(id) ?? []), ...fills]);
  };
  for (const row of rows) add(row.user_id, [toRacerFill(row)]);
  for (const e of executors) add(e.user_id, executorFills(e));
  const volumes = [...byRacer.values()].map(fills => racerVolume(fills).net);
  volumeCache = { at: Date.now(), volumes };
  return volumes;
}

type CardUser = {
  id: string;
  username?: string | null;
  telegram_id?: number | null;
  referral_code?: string | null;
  subaccount_id?: string | null;
};

/** Name for a new referral code. Wallet-only accounts get a w_ prefix so it never looks like a Telegram name. */
function referralName(user: CardUser): string {
  // Wallet sign-ins get a shortened display name like "racerb...near": not usable in a link
  if (user.username && TELEGRAM_SAFE_NAME.test(user.username)) return user.username;
  if (user.telegram_id) return `racer${user.telegram_id}`;
  const wallet = String(user.subaccount_id || '').replace(/\.near$/i, '').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 20);
  return `w_${wallet || user.id.slice(0, 8)}`;
}

/** What a Telegram /start parameter may hold: anything else and Telegram drops it. */
const TELEGRAM_SAFE_CODE = /^[A-Za-z0-9_-]{1,64}$/;
const TELEGRAM_SAFE_NAME = /^[A-Za-z0-9_]{1,40}$/;

export function isTelegramSafeCode(code: string): boolean {
  return TELEGRAM_SAFE_CODE.test(code);
}

async function referralFor(user: CardUser) {
  let code = user.referral_code || null;
  if (!code) {
    code = await generateReferralCode(user.id, referralName(user)).catch(() => null);
  } else if (!isTelegramSafeCode(code)) {
    // e.g. "racerb...near-KBVZB": the bot link, QR and share page all need a clean code
    code = await setReferralCodeFromName(user.id, referralName(user)).catch(() => code);
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
  const base = publicBaseUrl();
  return Markup.inlineKeyboard([
    [Markup.button.url('𝕏 Share on X', share.x), Markup.button.url('✈️ Share on Telegram', share.telegram)],
    ...(base ? [[Markup.button.url('🏆 Racer Leaderboard', `${base}/racers`)]] : []),
    [Markup.button.callback('🔄 Refresh', 'racer_card'), Markup.button.callback('🏠 Menu', 'menu_home')],
  ]);
}

interface RacerState {
  /** Where the rank is stored: the Telegram account when a wallet account is linked to one */
  racerId: string;
  fills: RacerFill[];
  volumes: number[];
  stored: RacerRankRecord | null;
}

/**
 * Everything one racer traded on NEAR: bot fills plus confidential positions,
 * across a linked wallet account and its Telegram account.
 */
async function loadRacerState(userId: string): Promise<RacerState> {
  const link = await getRacerLinkFor(userId);
  const racerId = link ? link.telegram_user_id : userId;
  const members = link ? [link.telegram_user_id, link.wallet_user_id] : [userId];
  const [rowLists, executors, volumes, stored] = await Promise.all([
    Promise.all(members.map(id => getNearRacerFills(id))),
    getConfidentialRacerExecutors(members),
    allNetVolumes(),
    getRacerRank(racerId),
  ]);
  const fills = [...rowLists.flat().map(toRacerFill), ...executors.flatMap(executorFills)];
  return { racerId, fills, volumes, stored };
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
  const level = levelNumber(data.levelLabel);
  const accent = LEVEL_COLORS[level - 1];
  // Dark text on the silver and gold buttons, light on purple
  const ink = level === 1 ? '#F6FBFC' : '#111726';
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
<meta property="og:image:secure_url" content="${escHtml(previewImage)}">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${escHtml(alt)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@racertradingbot">
<meta name="twitter:title" content="${escHtml(title)}">
<meta name="twitter:description" content="${escHtml(desc)}">
<meta name="twitter:image" content="${escHtml(previewImage)}">
<meta name="twitter:image:alt" content="${escHtml(alt)}">
<link rel="canonical" href="${escHtml(page)}">
<style>
body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;background:#111726;color:#F6FBFC;font-family:system-ui,sans-serif;padding:16px;box-sizing:border-box}
img{width:min(100%,420px,calc((100vh - 120px) * 2 / 3));height:auto;aspect-ratio:2/3}
a{background:${accent};color:${ink};font-weight:700;text-decoration:none;padding:14px 28px;border-radius:999px}
</style>
</head><body>
<img src="${escHtml(cardImage)}" alt="${escHtml(alt)}" width="${CARD_W}" height="${CARD_H}">
<a href="${escHtml(bot)}">Get your Racer Card</a>
<script>setTimeout(function () { location.replace(${JSON.stringify(bot).replace(/</g, '\\u003c')}); }, 1500);</script>
</body></html>`;
}

function sendPng(res: Response, png: Buffer): void {
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'public, max-age=600');
  res.send(png);
}

// Dots allowed so links shared with an older wallet code ("racerb...near-KBVZB") still open
const CODE_RE = /^[A-Za-z0-9_.-]{1,64}$/;

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
  const { racerId, fills, volumes, stored } = await loadRacerState(user.id);
  const profile = buildRacerProfile(fills, volumes, foundingCutoff(), stored?.best_key ?? 0);
  let rankedUp = false;
  try {
    if (!stored) {
      await seedRacerRank(racerId, profile.rank.key, profile.rank.key);
    } else if (profile.rank.key > stored.announced_key) {
      // Also raises best_key; announced never exceeds best, so this covers a new best too
      rankedUp = await claimRacerRankUp(racerId, profile.rank.key);
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
    const { racerId, fills, stored: existing } = await loadRacerState(userId);
    if (!fills.length) return false;
    const computed = rankKeyFor(racerVolume(fills).net);

    let stored = existing;
    if (!stored) {
      const latest = fills.reduce((t, f) => Math.max(t, f.at.getTime()), 0);
      const fresh = Date.now() - latest <= RANK_UP_MAX_FILL_AGE_MS;
      const announced = fresh ? Math.max(1, rankKeyBeforeLatestFill(fills)) : computed;
      stored = await seedRacerRank(racerId, computed, announced);
    } else if (computed > stored.best_key) {
      await raiseRacerBestKey(racerId, computed);
    }

    const target = Math.max(stored.best_key, computed);
    if (!isAnnounceableRankUp(stored.announced_key, target, rankUpPromptMode())) return false;
    // A wallet-only account has no chat to announce in: keep the rank-up for its web view
    const user = await getUserById(racerId).catch(() => null);
    if (!user?.telegram_id) return false;
    if (!(await claimRacerRankUp(racerId, target))) return false;

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

// ── Web: the signed-in user's card ───────────────────────────────────────────

/**
 * The card a signed-in web user sees: their own NEAR activity plus a linked
 * account's. Read-only. Shares use the Telegram account's referral code when
 * a wallet account is linked to one.
 */
export async function webRacerCard(user: CardUser) {
  const { racerId, fills, volumes, stored } = await loadRacerState(user.id);
  const profile = buildRacerProfile(fills, volumes, foundingCutoff(), stored?.best_key ?? 0);
  const racer: CardUser = racerId === user.id ? user : ((await getUserById(racerId).catch(() => null)) ?? user);
  const ref = await referralFor(racer);
  const data = cardImageData(profile, ref);
  const pageUrl = ref.link !== BOT_LINK ? racerCardPageUrl(ref.code, profile.rank.key) : null;
  const linked = racerId !== user.id || !!(await getRacerLinkFor(user.id));
  return {
    data,
    json: {
      hasTrades: profile.hasTrades,
      rank: {
        name: profile.rank.name,
        title: profile.rank.title,
        levelLabel: profile.rank.levelLabel,
        tierIndex: profile.rank.tierIndex,
        key: profile.rank.key,
        nextLevelName: profile.rank.nextLevelName,
        progressPct: profile.rank.progressPct,
      },
      finish: profile.finish,
      topPercent: profile.topPercent,
      badges: profile.badges.map(b => BADGE_LABELS[b]),
      referralCode: ref.code,
      shareUrl: pageUrl ?? ref.link,
      share: racerShareLinks(profile, ref.link, pageUrl),
      linked,
      canLink: !user.telegram_id && !linked,
    },
  };
}

/** The web user's card PNG (cached with the public page's images). */
export async function webRacerCardImage(user: CardUser): Promise<Buffer | null> {
  const { data } = await webRacerCard(user);
  return shareImages(data.referralCode, data).card;
}

// ── Linking a wallet-only web account to Telegram ────────────────────────────

export const RACER_LINK_TTL_MS = 10 * 60 * 1000;
const LINK_PREFIX = 'rclink_';
const LINK_CODE_RE = /^[A-Za-z0-9_-]{16,64}$/;

export type StartLinkResult =
  | { status: 'link'; deepLink: string; expiresInSec: number }
  | { status: 'linked' }
  | { status: 'telegram_account' };

/**
 * Step 1, on the web (signed wallet session): a one-time code behind a bot
 * deep link. Nothing is linked until the Telegram account approves in the bot.
 */
export async function startRacerLink(user: CardUser): Promise<StartLinkResult> {
  if (user.telegram_id) return { status: 'telegram_account' };
  if (await getRacerLinkFor(user.id)) return { status: 'linked' };
  const code = crypto.randomBytes(16).toString('base64url');
  await createRacerLinkCode(user.id, code, RACER_LINK_TTL_MS);
  const botUsername = process.env.BOT_USERNAME || 'racertradingbot';
  return { status: 'link', deepLink: `https://t.me/${botUsername}?start=${LINK_PREFIX}${code}`, expiresInSec: RACER_LINK_TTL_MS / 1000 };
}

const isPrivate = (ctx: Context) => ctx.chat?.type === 'private';

/** Step 2, in the bot: show which wallet would be linked and ask. */
async function askToLink(ctx: Context, code: string): Promise<void> {
  const walletUserId = LINK_CODE_RE.test(code) ? await peekRacerLinkCode(code) : null;
  const wallet = walletUserId ? await getUserById(walletUserId).catch(() => null) : null;
  if (!wallet || wallet.telegram_id) {
    await ctx.reply('⚠️ This Racer Card link has expired or was already used. Start again from the RacerBot web app.').catch(() => {});
    return;
  }
  const text = [
    '🔗 <b>Link a web wallet to your Racer Card?</b>',
    '',
    `Wallet: <code>${escHtml(wallet.subaccount_id || 'web wallet')}</code>`,
    '',
    'Its NEAR trades will count toward your rank, and the web app will show your card.',
    '<b>Only approve if you started this yourself on the RacerBot web app.</b>',
  ].join('\n');
  await ctx.reply(text, {
    parse_mode: 'HTML',
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback('✅ Approve', `rclink_ok:${code}`), Markup.button.callback('✖️ Deny', `rclink_no:${code}`)],
    ]).reply_markup,
  }).catch(() => {});
}

export type ApproveLinkResult = 'linked' | 'already' | 'conflict' | 'expired' | 'no_account' | 'not_wallet';

/**
 * Step 3: the Telegram account approves. The code is used up whatever happens
 * next, and an existing link on either side is never replaced.
 */
export async function approveRacerLink(telegramId: number, code: string): Promise<ApproveLinkResult> {
  const tg = await getUserByTelegramId(telegramId);
  if (!tg || !tg.telegram_id) return 'no_account';
  const walletUserId = LINK_CODE_RE.test(code) ? await peekRacerLinkCode(code) : null;
  if (!walletUserId) return 'expired';
  const wallet = await getUserById(walletUserId).catch(() => null);
  if (!wallet || wallet.telegram_id || wallet.id === tg.id) {
    await consumeRacerLinkCode(code);
    return 'not_wallet';
  }
  if ((await consumeRacerLinkCode(code)) !== walletUserId) return 'expired';
  const result = await linkRacerAccounts(walletUserId, tg.id);
  if (result === 'linked') {
    clearRacerVolumeCache();
    scheduleRankUpCheck(tg.id);
  }
  return result;
}

const APPROVE_REPLIES: Record<ApproveLinkResult, string> = {
  linked: '✅ Linked. Your web wallet now counts toward your Racer Card. Tap /card to see it.',
  already: '✅ That wallet is already linked to your Racer Card.',
  conflict: '⚠️ Not linked: this wallet or your Telegram account is already linked to a different account.',
  expired: '⚠️ This link has expired or was already used. Start again from the RacerBot web app.',
  no_account: '🏁 Tap /start to set up RacerBot first, then try the link again.',
  not_wallet: '⚠️ Not linked: only a wallet-only web account can be linked to Telegram.',
};

export function registerRacerCard(bot: Telegraf): void {
  _bot = bot;
  bot.command(['card', 'racercard'], ctx => sendRacerCard(ctx));
  bot.action('racer_card', async ctx => {
    await ctx.answerCbQuery().catch(() => {});
    await sendRacerCard(ctx);
  });

  // /start rclink_<code>; every other /start goes on to the main handler
  bot.command('start', async (ctx, next) => {
    const payload = ctx.message.text.split(' ')[1] || '';
    if (!payload.startsWith(LINK_PREFIX) || !isPrivate(ctx)) return next();
    await askToLink(ctx, payload.slice(LINK_PREFIX.length));
  });
  bot.action(/^rclink_ok:(.+)$/, async ctx => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isPrivate(ctx) || !ctx.from) return;
    try {
      const reply = APPROVE_REPLIES[await approveRacerLink(ctx.from.id, ctx.match[1])];
      await ctx.editMessageText(reply).catch(() => ctx.reply(reply));
    } catch (err: any) {
      console.error('[RACER_CARD] Link approval failed:', err?.message);
      await ctx.reply('❌ Could not link right now. Please try again in a moment.').catch(() => {});
    }
  });
  bot.action(/^rclink_no:(.+)$/, async ctx => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isPrivate(ctx)) return;
    if (LINK_CODE_RE.test(ctx.match[1])) await consumeRacerLinkCode(ctx.match[1]).catch(() => null);
    await ctx.editMessageText('✖️ Not linked. The link has been cancelled.').catch(() => {});
  });
}
