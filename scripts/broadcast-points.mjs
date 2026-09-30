// One-off: broadcast the Season 1 points announcement to every bot user.
// Usage: node scripts/broadcast-points.mjs --confirm
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
  `🏆 *RacerBot Points — Season 1 is LIVE!*\n\n` +
  `Every action on RacerBot now earns points that convert into the *$RACER airdrop* at token launch:\n\n` +
  `📈 *Trade* — 1.5 pts per 1 NEAR bought or sold\n` +
  `👥 *Refer* — 500 pts when your referral makes their first trade, plus 5% of all their trading points (they get 250 pts too)\n` +
  `🔥 *Daily activity* — 25 pts every day you trade, with streak boosts up to ×2\n` +
  `🐣 *Early Bird* — accounts created before Season 1 get ×1.25 on all points\n\n` +
  `✨ *Your past trades already count* — open 🏆 *Points* in the main menu to see your balance, rank and the leaderboard.\n\n` +
  `⏳ *Season 1 snapshot: October 15, 23:59 UTC.*\n\n` +
  `_Points are not tokens and carry no promise of value. $RACER allocation will be pro-rata to each user's share of Season 1 points at TGE._`;

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
