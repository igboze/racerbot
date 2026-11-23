import type { Telegraf } from 'telegraf';
import { createLogger } from '@racerbot/shared';
import { getDb } from '@racerbot/db';

/**
 * Keeps users.username equal to the account's real Telegram username.
 *
 * It used to be overwritten with the public alpha-caller handle chosen on the web app, so the bot
 * showed that handle as the user's Telegram name, and code sign-in could be aimed at an account from
 * its public copy-trading profile. Each private message refreshes it (at most once an hour per user).
 */

const logger = createLogger('username-sync');
const SYNC_EVERY_MS = 60 * 60 * 1000;
const lastSynced = new Map<number, { username: string; at: number }>();

export async function syncTelegramUsername(telegramId: number, username: string | undefined): Promise<void> {
  if (!telegramId || !username) return;
  const prev = lastSynced.get(telegramId);
  if (prev && prev.username === username && Date.now() - prev.at < SYNC_EVERY_MS) return;
  lastSynced.set(telegramId, { username, at: Date.now() });
  try {
    const db = await getDb();
    await db.query(
      `UPDATE users SET username = $1 WHERE telegram_id = $2 AND username IS DISTINCT FROM $1`,
      [username, telegramId]
    );
  } catch (err: any) {
    logger.warn(`Username sync failed for ${telegramId}: ${err?.message}`);
  }
}

export function registerUsernameSync(bot: Telegraf): void {
  bot.use((ctx, next) => {
    if (ctx.chat?.type === 'private' && ctx.from && !ctx.from.is_bot) {
      void syncTelegramUsername(ctx.from.id, ctx.from.username);
    }
    return next();
  });
}
