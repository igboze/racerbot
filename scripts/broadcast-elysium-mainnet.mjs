// Broadcast: Elysium mainnet trading is live on RacerBot (Kleos, RonsPad and Ascend coins).
// Usage (from the repo root, with TELEGRAM_BOT_TOKEN and DATABASE_URL in .env):
//   Dry run (prints the message, sends nothing):  node scripts/broadcast-elysium-mainnet.mjs
//   Preview to one chat:                          node scripts/broadcast-elysium-mainnet.mjs --preview <telegram_id>
//   Send to every user:                           node scripts/broadcast-elysium-mainnet.mjs --confirm
//
// ~28 msg/s, retries on Telegram 429, counts users who blocked the bot.

import dotenv from 'dotenv';
import { Telegraf, Markup } from 'telegraf';
import { createRequire } from 'module';

dotenv.config({ path: new URL('../.env', import.meta.url) });
const require = createRequire(import.meta.url);

export const BROADCAST_TEXT =
  `🏛️ <b>ELYSIUM MAINNET IS LIVE ON RACERBOT!</b>\n\n` +
  `Elysium, Kinetiq's chain built on Hyperliquid, opened to the public today, and RacerBot trades it from day one.\n\n` +
  `⚡ <b>What you can trade</b>\n` +
  `• <b>Kleos</b> coins (thekleos.xyz)\n` +
  `• <b>Ascend</b> coins (ascendlaunch.xyz), paired with HYPE, USDC or KNTQ\n` +
  `• <b>RonsPad</b> coins (ronspad.fun)\n\n` +
  `🚀 <b>How it works</b>\n` +
  `• Paste any Elysium token address (<code>0x...</code>) in this chat to see its card, then tap Buy.\n` +
  `• Pay with HYPE on Elysium (settles in seconds) or HYPE on HyperEVM (about a minute).\n` +
  `• Sell 25%, 50% or 100% back to HYPE with one tap. Your bags and PnL show Elysium coins too.\n` +
  `• Same EVM wallet as HyperEVM: no new setup.\n\n` +
  `ℹ️ <b>Good to know:</b> sale proceeds stay on Elysium as HYPE, ready for your next trade. Moving HYPE from Elysium back to HyperEVM takes about 6 days (that's how the Elysium bridge works).\n\n` +
  `👇 <b>Get started:</b>`;

export const BROADCAST_KEYBOARD = Markup.inlineKeyboard([
  [
    Markup.button.callback('⚡ Deposit HYPE', 'dep_evm_direct'),
    Markup.button.callback('💳 My Wallets', 'menu_wallet'),
  ],
  [
    Markup.button.callback('🎒 Your Bags', 'menu_holdings'),
    Markup.button.callback('🏎️ Main Menu', 'menu_home'),
  ],
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sendOptions = { parse_mode: 'HTML', ...BROADCAST_KEYBOARD, link_preview_options: { is_disabled: true } };

async function main() {
  const args = process.argv.slice(2);
  const previewIdx = args.indexOf('--preview');
  const previewTarget = previewIdx >= 0 ? args[previewIdx + 1] : null;
  const isConfirm = args.includes('--confirm');

  if (previewIdx < 0 && !isConfirm) {
    console.log('DRY RUN — nothing is sent. Message:\n----------------------------------------');
    console.log(BROADCAST_TEXT);
    console.log('----------------------------------------\nButtons: ⚡ Deposit HYPE | 💳 My Wallets | 🎒 Your Bags | 🏎️ Main Menu');
    console.log('Preview to one chat: --preview <telegram_id>   Send to everyone: --confirm');
    return;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set in .env');
  const bot = new Telegraf(token);

  if (previewIdx >= 0) {
    if (!previewTarget) throw new Error('Give a telegram id: --preview <telegram_id>');
    await bot.telegram.sendMessage(previewTarget, BROADCAST_TEXT, sendOptions);
    console.log(`✅ Preview sent to ${previewTarget}`);
    return;
  }

  const { Client } = require('pg');
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  const { rows } = await client.query('SELECT DISTINCT telegram_id FROM users WHERE telegram_id IS NOT NULL ORDER BY telegram_id ASC');
  await client.end();
  console.log(`🎯 Sending to ${rows.length} users...`);

  let sent = 0, blocked = 0, failed = 0;
  const started = Date.now();
  for (let i = 0; i < rows.length; i++) {
    const chatId = rows[i].telegram_id;
    try {
      await bot.telegram.sendMessage(chatId, BROADCAST_TEXT, sendOptions);
      sent++;
    } catch (err) {
      const msg = String(err?.message || err);
      if (err?.response?.error_code === 429 || msg.includes('Too Many Requests')) {
        const wait = (err?.response?.parameters?.retry_after || 3) + 1;
        console.warn(`⏳ Rate limited, waiting ${wait}s`);
        await sleep(wait * 1000);
        i--;
        continue;
      }
      if (msg.includes('blocked by the user') || msg.includes('user is deactivated') || msg.includes('chat not found')) blocked++;
      else { failed++; console.warn(`⚠️ ${chatId}: ${msg}`); }
    }
    if ((i + 1) % 50 === 0 || i === rows.length - 1) {
      console.log(`📊 ${i + 1}/${rows.length} | sent ${sent} | blocked ${blocked} | failed ${failed}`);
    }
    await sleep(35);
  }
  console.log(`🏁 Done in ${((Date.now() - started) / 1000).toFixed(0)}s: sent ${sent}, blocked/deactivated ${blocked}, other failures ${failed}`);
}

main().catch((err) => {
  console.error('❌', err?.message || err);
  process.exit(1);
});
