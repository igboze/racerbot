import type { Express } from 'express';
import {
  getConfidentialRacerExecutors,
  getNearRacerFills,
  getRacerNames,
  listRacerLinks,
  listRacerRanks,
} from '@racerbot/db';
import {
  BADGE_LABELS,
  TIERS,
  buildRacerProfile,
  executorFills,
  racerVolume,
  type Finish,
  type RacerFill,
} from './racerRank.js';
import { foundingCutoff, publicBaseUrl, toRacerFill } from './racerCard.js';
import { tierTheme } from './racerCardImageGenerator.js';

/**
 * Public NEAR Racer leaderboard (/racers). Same privacy as the cards: names
 * are shortened, and there are no amounts, tokens, wallets or links to a
 * racer's own card (its URL carries their referral code).
 */

export const LEADERBOARD_SIZE = 50;
const CACHE_MS = 5 * 60 * 1000;
const BOT_LINK = 'https://t.me/racertradingbot';

export interface LeaderboardEntry {
  position: number;
  name: string;
  rankName: string;
  tierIndex: number;
  finish: Finish;
  badges: string[];
}

export interface Leaderboard {
  racers: number;
  tierCounts: { title: string; count: number }[];
  entries: LeaderboardEntry[];
  updatedAt: Date;
}

/**
 * "fas•••": enough for a racer to spot themselves, not enough to look them up.
 * Wallet-only accounts never show any of the wallet.
 */
export function shortRacerName(username: string | null, referralCode: string | null): string {
  const fromCode = referralCode ? referralCode.replace(/-[A-Z0-9]{5}$/, '') : '';
  const raw = (username || fromCode || '').replace(/^@/, '');
  if (!raw || raw.startsWith('w_')) return 'Wallet racer';
  const shown = raw.length <= 3 ? raw.slice(0, 1) : raw.slice(0, 3);
  return `${shown}•••`;
}

let cache: { at: number; board: Leaderboard } | null = null;

export function clearLeaderboardCache(): void {
  cache = null;
}

export async function racerLeaderboard(): Promise<Leaderboard> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.board;
  const [rows, executors, links, ranks] = await Promise.all([
    getNearRacerFills(),
    getConfidentialRacerExecutors(),
    listRacerLinks(),
    listRacerRanks(),
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

  const best = new Map(ranks.map(r => [r.user_id, r.best_key]));
  const nets = [...byRacer.values()].map(f => racerVolume(f).net);
  const cutoff = foundingCutoff();
  const racers = [...byRacer.entries()]
    .map(([id, fills]) => ({ id, net: racerVolume(fills).net, profile: buildRacerProfile(fills, nets, cutoff, best.get(id) ?? 0) }))
    .filter(r => r.net > 0)
    // Highest rank first; volume only breaks ties and is never shown
    .sort((a, b) => b.profile.rank.key - a.profile.rank.key || b.net - a.net);

  const top = racers.slice(0, LEADERBOARD_SIZE);
  const names = new Map((await getRacerNames(top.map(r => r.id))).map(n => [n.id, n]));
  const tierCounts = TIERS.map((t, i) => ({ title: t.title, count: racers.filter(r => r.profile.rank.tierIndex === i).length }));

  const board: Leaderboard = {
    racers: racers.length,
    tierCounts,
    entries: top.map((r, i) => {
      const n = names.get(r.id);
      return {
        position: i + 1,
        name: shortRacerName(n?.username ?? null, n?.referral_code ?? null),
        rankName: r.profile.rank.name,
        tierIndex: r.profile.rank.tierIndex,
        finish: r.profile.finish,
        badges: r.profile.badges.map(b => BADGE_LABELS[b]),
      };
    }),
    updatedAt: new Date(),
  };
  cache = { at: Date.now(), board };
  return board;
}

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
}

const FINISH_LABEL: Record<Finish, string> = { bronze: 'Bronze', silver: 'Silver', gold: 'Gold', holo: 'Holo' };

export function leaderboardHtml(board: Leaderboard): string {
  const base = publicBaseUrl();
  const title = 'NEAR Racer Leaderboard · RacerBot';
  const desc = `${board.racers} NEAR racers ranked by lifetime trading on RacerBot. Where do you place?`;
  const rows = board.entries.map(e => {
    const accent = tierTheme(e.tierIndex).accent;
    const badges = e.badges.map(b => `<span class="badge">${esc(b)}</span>`).join('');
    return `<li class="row${e.position <= 3 ? ' podium' : ''}">
  <span class="pos">${e.position}</span>
  <span class="who">
    <span class="name">${esc(e.name)}</span>
    <span class="rank" style="color:${accent}">${esc(e.rankName)}</span>
  </span>
  <span class="extras"><span class="finish f-${e.finish}">${FINISH_LABEL[e.finish]}</span>${badges}</span>
</li>`;
  }).join('\n');
  const tiers = board.tierCounts.slice().reverse().filter(t => t.count > 0)
    .map(t => `<li><span>${esc(t.title)}</span><b>${t.count}</b></li>`).join('');

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="RacerBot">
<meta property="og:title" content="NEAR Racer Leaderboard">
<meta property="og:description" content="${esc(desc)}">
${base ? `<meta property="og:url" content="${esc(`${base}/racers`)}">` : ''}
<meta name="twitter:card" content="summary">
<meta name="twitter:site" content="@racertradingbot">
<style>
:root{--bg:#07090f;--surface:#11151f;--line:#222a3a;--text:#f1f4fa;--muted:#9aa5bb;--accent:#2ee6c9}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.45}
main{max-width:760px;margin:0 auto;padding:32px 16px 64px}
h1{font-size:clamp(26px,6vw,36px);margin:0 0 6px;letter-spacing:.5px}
.lede{color:var(--muted);margin:0 0 20px;font-size:15px}
.tiers{display:flex;flex-wrap:wrap;gap:8px;list-style:none;margin:0 0 24px;padding:0}
.tiers li{display:flex;gap:8px;align-items:center;padding:6px 12px;border:1px solid var(--line);border-radius:999px;font-size:13px;color:var(--muted)}
.tiers b{color:var(--text)}
ol{list-style:none;margin:0;padding:0;border:1px solid var(--line);border-radius:14px;overflow:hidden;background:var(--surface)}
.row{display:grid;grid-template-columns:44px minmax(0,1fr) auto;gap:12px;align-items:center;padding:12px 16px;border-top:1px solid var(--line)}
.row:first-child{border-top:0}
.pos{font-weight:800;font-variant-numeric:tabular-nums;color:var(--muted);font-size:15px}
.podium .pos{color:#f5c542}
.who{display:flex;flex-direction:column;min-width:0}
.name{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rank{font-size:14px;font-weight:600}
.extras{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px;max-width:260px}
.finish,.badge{font-size:12px;padding:3px 9px;border-radius:999px;border:1px solid var(--line);white-space:nowrap}
.f-bronze{color:#f3c398}.f-silver{color:#dce3ec}.f-gold{color:#f5c542}.f-holo{color:#c9a7ff}
.badge{color:var(--muted)}
.empty{padding:24px 16px;color:var(--muted)}
.cta{display:inline-flex;align-items:center;min-height:44px;margin-top:24px;padding:0 22px;border-radius:999px;background:var(--accent);color:#06221f;font-weight:700;text-decoration:none}
.cta:focus-visible{outline:2px solid #fff;outline-offset:3px}
.note{color:var(--muted);font-size:13px;margin-top:16px}
@media (max-width:560px){.row{grid-template-columns:32px minmax(0,1fr)}.extras{grid-column:2;justify-content:flex-start;max-width:none}}
</style>
</head><body>
<main>
  <h1>NEAR Racer Leaderboard</h1>
  <p class="lede">${board.racers} racers ranked by lifetime NEAR trading on RacerBot. Ranks never drop.</p>
  ${tiers ? `<ul class="tiers" aria-label="Racers per tier">${tiers}</ul>` : ''}
  <ol aria-label="Top ${board.entries.length} NEAR racers">
${rows || '<li class="empty">No racers yet. Be the first.</li>'}
  </ol>
  <a class="cta" href="${BOT_LINK}">Get your Racer Card</a>
  <p class="note">Names are shortened. No amounts, tokens or wallets are shown. Updated every few minutes.</p>
</main>
</body></html>`;
}

export function registerRacerLeaderboard(app: Express): void {
  app.get('/racers', async (_req, res) => {
    try {
      const board = await racerLeaderboard();
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.set('Cache-Control', 'public, max-age=120');
      res.send(leaderboardHtml(board));
    } catch (err: any) {
      console.error('[RACER_CARD] Leaderboard failed:', err?.message);
      res.status(503).set('Content-Type', 'text/html; charset=utf-8')
        .send(`<!doctype html><meta charset="utf-8"><title>RacerBot</title><p>The leaderboard is taking a pit stop. <a href="${BOT_LINK}">Open RacerBot</a></p>`);
    }
  });
}
