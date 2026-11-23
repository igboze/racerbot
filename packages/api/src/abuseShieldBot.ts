import type { Telegraf } from 'telegraf';
import { getAbuseShield } from './abuseShield.js';

/** Admin-only commands for the API's IP block list: /blockedips, /blockip <ip>, /unblockip <ip> */

const admins = () =>
  (process.env.ADMIN_TELEGRAM_ID || '').split(',').map(s => Number(s.trim())).filter(n => n > 0);
const IP_RE = /^[0-9a-fA-F:.]{3,45}$/;

export function registerAbuseShieldBot(bot: Telegraf): void {
  const adminOnly = (id?: number) => Boolean(id && admins().includes(id));

  bot.command('blockedips', async (ctx) => {
    if (!adminOnly(ctx.from?.id)) return;
    const shield = getAbuseShield();
    const list = shield?.listBlocks() ?? [];
    await ctx.reply(
      list.length
        ? `🛡 Blocked IPs:\n\n${list.map(b => `${b.ip} until ${new Date(b.until).toISOString().slice(0, 16).replace('T', ' ')} UTC`).join('\n')}`
        : '🛡 No IP is blocked right now.',
    ).catch(() => {});
  });

  bot.command('blockip', async (ctx) => {
    if (!adminOnly(ctx.from?.id)) return;
    const ip = (ctx.message?.text || '').split(/\s+/)[1] || '';
    if (!IP_RE.test(ip)) {
      await ctx.reply('Usage: /blockip <ip>').catch(() => {});
      return;
    }
    const until = await getAbuseShield()?.block(ip, `blocked by admin ${ctx.from?.id}`);
    await ctx.reply(until ? `🛡 ${ip} blocked until ${new Date(until).toISOString().slice(0, 16).replace('T', ' ')} UTC.` : 'Shield not running.').catch(() => {});
  });

  bot.command('unblockip', async (ctx) => {
    if (!adminOnly(ctx.from?.id)) return;
    const ip = (ctx.message?.text || '').split(/\s+/)[1] || '';
    if (!IP_RE.test(ip)) {
      await ctx.reply('Usage: /unblockip <ip>').catch(() => {});
      return;
    }
    const had = await getAbuseShield()?.unblock(ip);
    await ctx.reply(had ? `✅ ${ip} unblocked.` : `${ip} was not blocked.`).catch(() => {});
  });
}
