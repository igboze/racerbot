import type { Telegraf, Context } from 'telegraf';
import { createLogger } from '@racerbot/shared';
import {
  getBotSetting,
  setBotSetting,
  getRecentTradeAttempts,
  getVolumeStats,
  type TradeAttemptRow,
  type VolumeStats,
} from '@racerbot/db';
import { getNearUsdPrice } from './wallet.js';
import { getSuiUsdPrice, getStrkUsdPrice } from '@racerbot/shared';
import {
  ADMIN_USERNAMES,
  ADMIN_TELEGRAM_ID,
  MONITOR_INTERVAL_MS,
} from './config.js';
import { summarizeAttempts, formatReasons, type AttemptSummary } from './monitorStats.js';

const logger = createLogger('monitor');

// ── Thresholds (module constants — env only overrides interval/usernames) ────
const WINDOW_MINUTES = 15;          // rolling window for failure-rate checks
const MIN_FAILURES_TO_ALERT = 5;    // need at least this many failures to page admin
const FAILURE_RATE_PCT = 40;        // alert when ≥ this % of attempts fail
const SLOW_SIGN_P90_MS = 30_000;    // alert when p90 signing time exceeds this
const ALERT_COOLDOWN_MS = 30 * 60 * 1000; // per-alert-type cooldown to avoid spam

const ADMIN_CHAT_SETTING_KEY = 'admin_chat_id';
const MANUAL_WINDOW_MINUTES = 60;   // /monitor looks back 1 hour

// Daily volume update → admin DM
const VOLUME_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const VOLUME_UPDATE_CHECK_MS = 30 * 60 * 1000; // how often we check whether 24h elapsed
const VOLUME_LAST_SENT_KEY = 'admin_volume_update_last';

let adminChatId: number | null = null;
let adminWarnedOnce = false;
const lastAlertAt = new Map<string, number>();

function isConfigured(): boolean {
  return ADMIN_USERNAMES.length > 0 || ADMIN_TELEGRAM_ID.length > 0;
}

/** Resolve whether a Telegram update comes from an admin. */
export function isAdmin(ctx: Context): boolean {
  const from = ctx.from;
  if (!from) return false;
  if (ADMIN_TELEGRAM_ID && String(from.id) === ADMIN_TELEGRAM_ID) return true;
  if (!from.username) return false;
  const username = from.username.replace(/^@/, '').toLowerCase();
  return ADMIN_USERNAMES.includes(username);
}

async function resolveAdminChatId(): Promise<number | null> {
  if (adminChatId) return adminChatId;
  const stored = await getBotSetting(ADMIN_CHAT_SETTING_KEY).catch(() => null);
  if (stored) {
    const parsed = parseInt(stored, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      adminChatId = parsed;
      return adminChatId;
    }
  }
  return null;
}

async function sendAdminAlert(bot: Telegraf, text: string): Promise<void> {
  const chatId = await resolveAdminChatId();
  if (!chatId) {
    if (!adminWarnedOnce) {
      adminWarnedOnce = true;
      logger.warn('Admin chat id not known yet — admin must /start the bot before alerts can be delivered');
    }
    return;
  }
  try {
    await bot.telegram.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  } catch (err: any) {
    logger.error('Failed to deliver admin alert', err, { chatId });
  }
}

function cooldownOk(kind: string, now: number): boolean {
  const last = lastAlertAt.get(kind) ?? 0;
  if (now - last < ALERT_COOLDOWN_MS) return false;
  lastAlertAt.set(kind, now);
  return true;
}

function venueFailureLines(summary: AttemptSummary): string {
  const entries = Object.entries(summary.venueFailures)
    .filter(([, v]) => v.failed > 0)
    .sort((a, b) => b[1].failed - a[1].failed)
    .slice(0, 5);
  if (entries.length === 0) return 'none';
  return entries
    .map(([venue, v]) => `${venue}: ${v.failed}/${v.attempts} failed`)
    .join('\n');
}

async function checkAndAlert(bot: Telegraf): Promise<void> {
  let rows: TradeAttemptRow[];
  try {
    rows = await getRecentTradeAttempts(WINDOW_MINUTES);
  } catch (err: any) {
    logger.error('Monitor: failed to read trade attempts', err);
    return;
  }

  const summary = summarizeAttempts(rows);
  const now = Date.now();
  const lines: string[] = [];

  if (
    summary.failed >= MIN_FAILURES_TO_ALERT &&
    summary.failureRatePct >= FAILURE_RATE_PCT &&
    cooldownOk('failure_spike', now)
  ) {
    lines.push(
      `🚨 *Failure spike (last ${WINDOW_MINUTES}m)*\n` +
      `${summary.failed}/${summary.total} attempts failed (${summary.failureRatePct}%)\n\n` +
      `*Top reasons:*\n${formatReasons(summary.topReasons, 3)}\n\n` +
      `*By venue:*\n${venueFailureLines(summary)}`
    );
  }

  const p90 = summary.timing.signP90;
  if (
    p90 !== null &&
    p90 >= SLOW_SIGN_P90_MS &&
    summary.total >= 3 &&
    cooldownOk('slow_signing', now)
  ) {
    lines.push(
      `🐌 *Slow signing detected (last ${WINDOW_MINUTES}m)*\n` +
      `p90 sign time: ${(p90 / 1000).toFixed(1)}s (avg ${summary.timing.signAvg ?? '—'}ms)`
    );
  }

  for (const line of lines) {
    await sendAdminAlert(bot, line);
  }
}

function summaryReport(summary: AttemptSummary, windowMinutes: number): string {
  const t = summary.timing;
  return (
    `📊 *Trade monitor — last ${windowMinutes}m*\n\n` +
    `Attempts: ${summary.total}\n` +
    `Failed: ${summary.failed} (${summary.failureRatePct}%)\n\n` +
    `*Timing (ms):*\n` +
    `presign avg: ${t.presignAvg ?? '—'} | sign avg: ${t.signAvg ?? '—'} | sign p90: ${t.signP90 ?? '—'} | post avg: ${t.postAvg ?? '—'}\n\n` +
    `*Top failure reasons:*\n${formatReasons(summary.topReasons, 3)}\n\n` +
    `*By venue:*\n${venueFailureLines(summary)}`
  );
}

// ── Daily volume update ─────────────────────────────────────────────────────

export function buildVolumeUpdateText(s: VolumeStats, nearUsd: number, suiUsd = 0, strkUsd = 0): string {
  const nearFmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  const nearUsdFmt = (nearAmt: number) =>
    nearUsd > 0 ? ` (~$${(nearAmt * nearUsd).toLocaleString('en-US', { maximumFractionDigits: 0 })})` : '';
  const suiFmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  const suiUsdFmt = (suiAmt: number) =>
    suiUsd > 0 ? ` (~$${(suiAmt * suiUsd).toLocaleString('en-US', { maximumFractionDigits: 0 })})` : '';
  const strkFmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  const strkUsdFmt = (strkAmt: number) =>
    strkUsd > 0 ? ` (~$${(strkAmt * strkUsd).toLocaleString('en-US', { maximumFractionDigits: 0 })})` : '';

  const total24hTrades = s.trades24h + s.trades24hSui + (s.trades24hStarknet || 0);
  const totalTrades = s.tradesTotal + s.tradesTotalSui + (s.tradesTotalStarknet || 0);

  return (
    `📊 *RacerBot Daily Report*\n\n` +

    `👥 *Users*\n` +
    `• Total: \`${s.usersTotal.toLocaleString('en-US')}\`\n` +
    `• New today: \`${s.newUsers24h}\`\n\n` +

    `🔥 *Last 24h*\n` +
    `• Total trades: \`${total24hTrades}\` (${s.buys24h} buys / ${s.sells24h} sells)\n` +
    `• Active traders: \`${s.activeTraders24h}\`\n\n` +

    `〽️ *NEAR — 24h*\n` +
    `• Volume: \`${nearFmt(s.volume24hNear)} NEAR\`${nearUsdFmt(s.volume24hNear)}\n` +
    `• Trades: \`${s.trades24h}\`\n\n` +

    `🔵 *SUI — 24h*\n` +
    `• Volume: \`${suiFmt(s.volume24hSui)} SUI\`${suiUsdFmt(s.volume24hSui)}\n` +
    `• Trades: \`${s.trades24hSui}\`\n\n` +

    `⚡ *Starknet — 24h*\n` +
    `• Volume: \`${strkFmt(s.volume24hStarknet || 0)} STRK\`${strkUsdFmt(s.volume24hStarknet || 0)}\n` +
    `• Trades: \`${s.trades24hStarknet || 0}\`\n\n` +

    `📈 *All Time*\n` +
    `• NEAR volume: \`${nearFmt(s.volumeTotalNear)} NEAR\`${nearUsdFmt(s.volumeTotalNear)}\n` +
    `• SUI volume: \`${suiFmt(s.volumeTotalSui)} SUI\`${suiUsdFmt(s.volumeTotalSui)}\n` +
    `• Starknet volume: \`${strkFmt(s.volumeTotalStarknet || 0)} STRK\`${strkUsdFmt(s.volumeTotalStarknet || 0)}\n` +
    `• Total trades: \`${totalTrades.toLocaleString('en-US')}\``
  );
}


/** Sends the volume update if ≥24h since the last one (persisted in bot_settings, so redeploys don't reset or duplicate it). */
async function maybeSendDailyVolumeUpdate(bot: Telegraf): Promise<void> {
  const chatId = await resolveAdminChatId();
  if (!chatId) return; // admin hasn't interacted yet — keep retrying on the check timer
  const lastRaw = await getBotSetting(VOLUME_LAST_SENT_KEY).catch(() => null);
  const last = lastRaw ? parseInt(lastRaw, 10) : 0;
  if (Number.isFinite(last) && Date.now() - last < VOLUME_UPDATE_INTERVAL_MS) return;

  const stats = await getVolumeStats();
  const [nearUsd, suiUsd, strkUsd] = await Promise.all([
    getNearUsdPrice().catch(() => 0),
    getSuiUsdPrice().catch(() => 0),
    getStrkUsdPrice().catch(() => 0),
  ]);
  await sendAdminAlert(bot, buildVolumeUpdateText(stats, nearUsd, suiUsd, strkUsd));
  await setBotSetting(VOLUME_LAST_SENT_KEY, String(Date.now())).catch((err: any) => {
    logger.warn('Failed to persist volume-update timestamp', { error: err.message });
  });
  logger.info('Daily volume update sent to admin');
}

function attemptsTable(rows: TradeAttemptRow[], max = 10): string {  if (rows.length === 0) return 'No attempts in window.';
  return rows.slice(0, max).map((r) => {
    const t = r.timings;
    const timing = t
      ? ` [pre ${t.presign_ms ?? '—'}ms / sign ${t.sign_ms ?? '—'}ms / post ${t.post_ms ?? '—'}ms]`
      : '';
    const reason = (r.error || 'unknown').replace(/[_*`[]/g, ' ').slice(0, 120);
    return `• ${r.side} ${r.venue} — ${r.status}${timing}\n  ${reason}`;
  }).join('\n\n');
}

/**
 * Install admin monitoring on an existing Telegraf bot:
 *  1. Middleware that persists the admin's chat id (keyed off Telegram username)
 *     so alerts survive restarts.
 *  2. Admin-gated commands: /monitor, /failures, /slow.
 *  3. A periodic background check that DMs the admin on failure spikes or
 *     abnormally slow signing.
 */
export function setupMonitor(bot: Telegraf): void {
  if (!isConfigured()) {
    logger.warn('Admin monitoring disabled — set ADMIN_USERNAMES or ADMIN_TELEGRAM_ID to enable');
    return;
  }

  // 1. Persist admin chat id on any interaction from an admin (non-blocking).
  bot.use((ctx, next) => {
    if (isAdmin(ctx) && ctx.from) {
      if (adminChatId !== ctx.from.id) {
        adminChatId = ctx.from.id;
        setBotSetting(ADMIN_CHAT_SETTING_KEY, String(ctx.from.id)).catch((err: any) => {
          logger.warn('Failed to persist admin chat id', { error: err.message });
        });
      }
    }
    return next();
  });

  // 2. Admin-gated commands.
  bot.command('monitor', async (ctx) => {
    if (!isAdmin(ctx)) return; // silent for non-admins
    try {
      const rows = await getRecentTradeAttempts(MANUAL_WINDOW_MINUTES, 500);
      await ctx.replyWithMarkdown(summaryReport(summarizeAttempts(rows), MANUAL_WINDOW_MINUTES));
    } catch (err: any) {
      await ctx.reply('Monitor query failed — check logs.').catch(() => {});
      logger.error('/monitor failed', err);
    }
  });

  bot.command('failures', async (ctx) => {
    if (!isAdmin(ctx)) return;
    try {
      const rows = await getRecentTradeAttempts(MANUAL_WINDOW_MINUTES, 500);
      const failed = rows.filter((r) => r.status === 'failed');
      await ctx.replyWithMarkdown(
        `❌ *Failed attempts — last ${MANUAL_WINDOW_MINUTES}m* (${failed.length})\n\n` +
        attemptsTable(failed, 10)
      );
    } catch (err: any) {
      await ctx.reply('Query failed — check logs.').catch(() => {});
      logger.error('/failures failed', err);
    }
  });

  bot.command('slow', async (ctx) => {
    if (!isAdmin(ctx)) return;
    try {
      const rows = await getRecentTradeAttempts(MANUAL_WINDOW_MINUTES, 500);
      const { slowest } = summarizeAttempts(rows, 5);
      await ctx.replyWithMarkdown(
        `🐌 *Slowest signs — last ${MANUAL_WINDOW_MINUTES}m*\n\n` + attemptsTable(slowest, 5)
      );
    } catch (err: any) {
      await ctx.reply('Query failed — check logs.').catch(() => {});
      logger.error('/slow failed', err);
    }
  });

  bot.command('volume', async (ctx) => {
    if (!isAdmin(ctx)) return;
    try {
      const stats = await getVolumeStats();
      const [nearUsd, suiUsd, strkUsd] = await Promise.all([
        getNearUsdPrice().catch(() => 0),
        getSuiUsdPrice().catch(() => 0),
        getStrkUsdPrice().catch(() => 0),
      ]);
      await ctx.replyWithMarkdown(buildVolumeUpdateText(stats, nearUsd, suiUsd, strkUsd));
    } catch (err: any) {
      await ctx.reply('Volume query failed — check logs.').catch(() => {});
      logger.error('/volume failed', err);
    }
  });

  // 3. Periodic background check. Unref'd so it never holds the process open.
  const timer = setInterval(() => {
    checkAndAlert(bot).catch((err: any) => logger.error('Monitor check failed', err));
  }, MONITOR_INTERVAL_MS);
  timer.unref?.();

  // 4. Daily volume update: checks every 30 min whether 24h have elapsed since
  // the last send (timestamp persisted in bot_settings, so redeploys neither
  // reset the schedule nor double-send). The boot-time call catches up if the
  // process was down when the update fell due.
  const volTimer = setInterval(() => {
    maybeSendDailyVolumeUpdate(bot).catch((err: any) => logger.error('Volume update failed', err));
  }, VOLUME_UPDATE_CHECK_MS);
  volTimer.unref?.();
  maybeSendDailyVolumeUpdate(bot).catch((err: any) => logger.error('Volume update failed', err));

  // Recover admin chat id from DB at startup so alerts work before the admin's
  // next interaction.
  resolveAdminChatId().then((id) => {
    if (id) logger.info('Admin monitoring armed', { adminChatId: id });
  }).catch(() => {});

  logger.info('Admin monitoring enabled', { intervalMs: MONITOR_INTERVAL_MS });
}
