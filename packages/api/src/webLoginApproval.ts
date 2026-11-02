import { Markup, type Context, type Telegraf } from 'telegraf';
import { getPendingAuthSession, linkAuthSession, rejectAuthSession } from './authSession.js';

/**
 * WebApp login through the bot (/start auth_<session_id>). Anyone can create a
 * login session and post its link, so tapping the link never logs anyone in:
 * the account owner sees what is being asked and approves it in a private chat.
 */

const isPrivate = (ctx: Context) => ctx.chat?.type === 'private';

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
}

const EXPIRED = '⚠️ This login request has expired or was already used. Start again from the web app.';

/** Step 1, on /start auth_<session_id>: ask before anything is linked. */
export async function askWebLoginApproval(ctx: Context, sessionId: string): Promise<void> {
  const pending = isPrivate(ctx) ? await getPendingAuthSession(sessionId) : null;
  if (!pending) {
    await ctx.reply(
      `⚠️ <b>Session Expired or Invalid</b>\n\n`
      + `Please return to the WebApp and tap "Connect Telegram" to generate a fresh link.`,
      { parse_mode: 'HTML' },
    ).catch(() => { });
    return;
  }
  const who = ctx.from?.username ? `@${ctx.from.username}` : String(ctx.from?.id ?? '');
  await ctx.reply(
    `🔐 <b>Log in to the RacerBot web app?</b>\n\n`
    + `This gives a browser full access to your RacerBot account <code>${esc(who)}</code>, including trading and withdrawals.\n\n`
    + `<b>Only approve if you just tapped "Connect Telegram" on the RacerBot web app yourself.</b> `
    + `If someone sent you this link, tap Deny.`,
    {
      parse_mode: 'HTML',
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('✅ Approve login', `webauth_ok:${sessionId}`), Markup.button.callback('✖️ Deny', `webauth_no:${sessionId}`)],
      ]).reply_markup,
    },
  ).catch(() => { });
}

/** Steps 2 and 3: the Approve / Deny buttons. */
export function registerWebLoginApproval(bot: Telegraf): void {
  bot.action(/^webauth_ok:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => { });
    if (!isPrivate(ctx) || !ctx.from) return;
    const sessionId = ctx.match[1];
    if (!(await getPendingAuthSession(sessionId))) {
      await ctx.editMessageText(EXPIRED).catch(() => { });
      return;
    }
    const linkRes = await linkAuthSession(sessionId, {
      id: ctx.from.id,
      username: ctx.from.username,
      first_name: ctx.from.first_name,
    });
    if (!linkRes.success) {
      await ctx.editMessageText(EXPIRED).catch(() => { });
      return;
    }
    await ctx.editMessageText(
      `🏎️ <b>RacerBot WebApp Connected!</b>\n\n`
      + `✅ <b>Paired Account</b>: <code>${esc(ctx.from.username ? `@${ctx.from.username}` : String(ctx.from.id))}</code>\n`
      + `💳 <b>Trading Subaccount</b>: <code>${esc(linkRes.user?.subaccount_id || 'Ready')}</code>\n\n`
      + `<i>You can now return to your browser window.</i>`,
      {
        parse_mode: 'HTML',
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('💳 Manage Wallets', 'wallets_menu'), Markup.button.callback('🏎️ Main Menu', 'menu_home')],
        ]).reply_markup,
      },
    ).catch(() => { });
  });

  bot.action(/^webauth_no:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => { });
    if (!isPrivate(ctx)) return;
    await rejectAuthSession(ctx.match[1]).catch(() => false);
    await ctx.editMessageText('✖️ Login denied. Nobody was logged in to your account.').catch(() => { });
  });
}
