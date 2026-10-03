/**
 * broadcast_sui_launch.mjs
 * One-time broadcast: SUI chain integration announcement to all RacerBot users.
 * Run with: node broadcast_sui_launch.mjs
 */
import { getDb } from './packages/db/dist/index.js';
import dotenv from 'dotenv';
dotenv.config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ No TELEGRAM_BOT_TOKEN / BOT_TOKEN found in .env');
  process.exit(1);
}

const MESSAGE = `🏎💨 *RacerBot is now live on SUI!*

We've just integrated the *SUI blockchain*, and you can now trade SUI tokens directly from the bot — no wallet app needed.

Here's what you can do on SUI:

🪙 *Trade Any SUI Token*
Paste any SUI token contract address to get instant price, market cap, liquidity, and 1-click buy/sell.

🚀 *SuiPump Launchpad*
Buy tokens fresh off the bonding curve via *SuiPump* — snipe early before they graduate.

💧 *Multi-DEX Routing*
Trade on *Bluefin*, *Cetus*, *Turbos*, *FlowX* and more — RacerBot automatically finds the best route.

💼 *Track Your Bags*
Your SUI holdings appear in *💼 Holdings*, alongside your NEAR bags. Full PNL tracking per token.

📊 *PNL Cards*
Get a shareable PNL card for every SUI position — win or loss, it tells the story.

⚡ *How to Start*
1. Open @racertradingbot
2. Go to *Settings → Wallets*
3. Fund your SUI wallet
4. Paste any SUI token CA and trade!

_RacerBot — the fastest trader in the race_ 🏁`;

async function sendMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    }),
  });
  const data = await res.json();
  return data;
}

async function main() {
  const db = await getDb();
  const result = await db.query('SELECT telegram_id FROM users ORDER BY created_at');
  const users = result.rows;
  console.log(`📢 Broadcasting to ${users.length} users...`);

  let sent = 0, failed = 0, blocked = 0;

  for (const user of users) {
    const chatId = user.telegram_id;
    try {
      const res = await sendMessage(chatId, MESSAGE);
      if (res.ok) {
        sent++;
        process.stdout.write(`\r✅ Sent: ${sent} | ❌ Failed: ${failed} | 🚫 Blocked: ${blocked}`);
      } else {
        const errCode = res.error_code;
        if (errCode === 403 || errCode === 400) {
          blocked++;
        } else {
          failed++;
          console.log(`\n⚠️  Chat ${chatId}: ${res.description}`);
        }
      }
    } catch (err) {
      failed++;
      console.log(`\n⚠️  Chat ${chatId}: ${err.message}`);
    }

    // Rate limit: Telegram allows ~30 msgs/sec for bots, use 40ms delay to be safe
    await new Promise(r => setTimeout(r, 40));
  }

  console.log(`\n\n📊 Broadcast complete!`);
  console.log(`   ✅ Delivered: ${sent}`);
  console.log(`   🚫 Blocked/Stopped bot: ${blocked}`);
  console.log(`   ❌ Other errors: ${failed}`);
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
