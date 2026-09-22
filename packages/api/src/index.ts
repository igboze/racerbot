import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { createRedis } from './redis.js';
import { getDb } from './db.js';
import { router } from './routes/index.js';
import { TELEGRAM_BOT_TOKEN } from './config.js';

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

async function main() {
  const redis = await createRedis();
  await getDb().connect();

  bot.start(ctx => ctx.reply('Welcome to RacerBot! Open the Mini App to get started.'));
  bot.command('start', ctx => ctx.reply('Welcome! Open the Mini App at https://t.me/RacerBotBot/start'));

  bot.launch();
  console.log('[API] RacerBot API service started');

  process.on('SIGINT', async () => {
    bot.stop();
    await redis.disconnect();
    await getDb().disconnect();
    process.exit(0);
  });
}

main().catch(console.error);