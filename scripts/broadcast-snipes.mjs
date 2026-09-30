// One-off: broadcast the targeted-snipe launch announcement to every bot user.
// Usage: node scripts/broadcast-snipes.mjs --confirm
// Rate-limited to ~20 msg/s (Telegram global limit is ~30/s). Users who
// blocked the bot (403) are skipped and counted.
import { createRequire } from 'module';
import dotenv from 'dotenv';

dotenv.config({ path: new URL('../.env', import.meta.url) });
const require = createRequire(import.meta.url);
const { Client } = require('pg');

if (!process.argv.includes('--confirm')) {
  console.log('Dry run. Re-run with --confirm to actually send.');
  process.exit(0);
}

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is not set');
  process.exit(1);
}

const MESSAGE =
  `🎯 *NEW: Targeted Snipes are LIVE on RacerBot!*\n\n` +
  `Two powerful new ways to never miss a launch — each with its own custom amount:\n\n` +
  `🎯 *Snipe by Token CA*\n` +
  `Paste a token contract address. Already trading? The buy executes instantly. Not launched or still bonding? Your snipe stays *armed* and fires the moment a pool goes live.\n\n` +
  `👤 *Snipe by Deployer*\n` +
  `Follow a wallet you trust. *Every* new token that wallet launches gets auto-bought the second it's detected — until you cancel.\n\n` +
  `⚡ Snipes execute on our priority pipeline and you'll get a Buy Confirmed card with your PNL the moment a snipe fills.\n\n` +
  `Set yours up now: 🎯 *Snipe Rules* in the main menu → *Snipe Token CA* or *Snipe by Dev*. Manage or cancel anytime in 📋 *My Snipe Orders*.\n\n` +
  `_And yes — snipes earn Season 1 points toward the $RACER airdrop too._ 🏁`;

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();
const { rows } = await client.query('SELECT telegram_id FROM users ORDER BY created_at ASC');
await client.end();

console.log(`[BROADCAST] Sending to ${rows.length} users...`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let sent = 0, blocked = 0, failed = 0;
for (let i = 0; i < rows.length; i++) {
  const chatId = Number(rows[i].telegram_id);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: MESSAGE,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) {
      sent++;
    } else if (res.status === 403) {
      blocked++;
    } else if (res.status === 429) {
      const wait = ((data?.parameters?.retry_after ?? 2) + 1) * 1000;
      console.log(`[BROADCAST] Rate limited — waiting ${wait}ms, then retrying`);
      await sleep(wait);
      i--; // retry the same user
      continue;
    } else {
      failed++;
      console.warn(`[BROADCAST] Failed for ${chatId}: ${res.status} ${JSON.stringify(data).slice(0, 120)}`);
    }
  } catch (err) {
    failed++;
    console.warn(`[BROADCAST] Error for ${chatId}: ${err.message}`);
  }
  await sleep(50); // ~20 msg/s
}

console.log(`[BROADCAST] Done. sent=${sent} blocked=${blocked} failed=${failed}`);
process.exit(0);
