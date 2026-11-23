import { Markup, type Context, type Telegraf } from 'telegraf';
import { getUserByTelegramId } from '@racerbot/db';
import { describeDevice, listWebSessions, revokeAllWebSessions, revokeWebSession, type WebSessionInfo } from './webSessions.js';

/**
 * The owner's view of their web app sign-ins: every signed-in browser, where it came from, and
 * buttons to log any or all of them out. Opened with /websessions, from Settings, or from the
 * "Not me: log it out" button on a sign-in alert.
 */

const esc = (s: string) => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const isPrivate = (ctx: Context) => ctx.chat?.type === 'private';

const METHOD_LABEL: Record<string, string> = {
  telegram: 'Telegram link',
  code: 'sign-in code',
  wallet: 'wallet signature',
  miniapp: 'Telegram mini app',
};

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 90) return 'just now';
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

export function buildWebSessionsScreen(sessions: WebSessionInfo[]): { text: string; keyboard: ReturnType<typeof Markup.inlineKeyboard> } {
  if (sessions.length === 0) {
    return {
      text: `🖥 <b>Web sessions</b>\n\nNo browser is signed in to your account on the RacerBot web app.`,
      keyboard: Markup.inlineKeyboard([[Markup.button.callback('⚙️ Settings', 'menu_settings')]]),
    };
  }
  const lines = sessions.map((s, i) =>
    `<b>${i + 1}.</b> ${esc(describeDevice(s.userAgent))}\n` +
    `    🌐 <code>${esc(s.ip || 'unknown IP')}</code> · via ${esc(METHOD_LABEL[s.method] || s.method)}\n` +
    `    Signed in ${ago(s.createdAt)} · last used ${ago(s.lastSeenAt)}`
  );
  const rows = sessions.map((s, i) => [Markup.button.callback(`🚫 Log out ${i + 1}`, `websess_out:${s.sid}`)]);
  rows.push([Markup.button.callback('🧹 Log out all browsers', 'websess_all')]);
  rows.push([Markup.button.callback('🔄 Refresh', 'websess_list'), Markup.button.callback('⚙️ Settings', 'menu_settings')]);
  return {
    text:
      `🖥 <b>Web sessions</b>\n\nThese browsers are signed in to your account on the RacerBot web app:\n\n` +
      lines.join('\n\n') +
      `\n\n<i>Don't recognise one? Log it out. Withdrawals always need this chat, never only a browser.</i>`,
    keyboard: Markup.inlineKeyboard(rows),
  };
}

async function showSessions(ctx: Context, edit: boolean): Promise<void> {
  const user = ctx.from ? await getUserByTelegramId(ctx.from.id).catch(() => null) : null;
  if (!user) {
    await ctx.reply('Send /start first.').catch(() => {});
    return;
  }
  const { text, keyboard } = buildWebSessionsScreen(await listWebSessions(user.id));
  const opts = { parse_mode: 'HTML' as const, ...keyboard };
  if (edit) await ctx.editMessageText(text, opts).catch(() => ctx.reply(text, opts).catch(() => {}));
  else await ctx.reply(text, opts).catch(() => {});
}

export function registerWebSessionsBot(bot: Telegraf): void {
  bot.command(['websessions', 'sessions'], async (ctx) => {
    if (!isPrivate(ctx)) return;
    await showSessions(ctx, false);
  });

  bot.action('websess_list', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isPrivate(ctx)) return;
    await showSessions(ctx, true);
  });

  // From the list or from a sign-in alert. Only ever ends a session in the tapping user's own account.
  bot.action(/^websess_out:([0-9a-f]{16})$/, async (ctx) => {
    if (!isPrivate(ctx) || !ctx.from) return;
    const user = await getUserByTelegramId(ctx.from.id).catch(() => null);
    const ended = user ? await revokeWebSession(user.id, ctx.match[1]) : false;
    await ctx.answerCbQuery(ended ? 'Logged out.' : 'That browser was already logged out.').catch(() => {});
    await showSessions(ctx, false);
  });

  bot.action('websess_all', async (ctx) => {
    if (!isPrivate(ctx) || !ctx.from) return;
    const user = await getUserByTelegramId(ctx.from.id).catch(() => null);
    const n = user ? await revokeAllWebSessions(user.id) : 0;
    await ctx.answerCbQuery(n ? `Logged out ${n} browser${n === 1 ? '' : 's'}.` : 'No browser was signed in.').catch(() => {});
    await showSessions(ctx, true);
  });
}
