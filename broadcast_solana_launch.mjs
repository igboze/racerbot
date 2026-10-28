/**
 * broadcast_solana_launch.mjs
 * Announcement broadcast to all RacerBot users: Solana chain integration is LIVE.
 * 
 * Usage:
 *   node broadcast_solana_launch.mjs --dry-run   (tests DB connection and prints message)
 *   node broadcast_solana_launch.mjs             (sends to all active Telegram users)
 */

import { getDb } from './packages/db/dist/index.js';
import dotenv from 'dotenv';
dotenv.config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ No TELEGRAM_BOT_TOKEN / BOT_TOKEN found in environment (.env).');
  process.exit(1);
}

const isDryRun = process.argv.includes('--dry-run');

const MESSAGE = `🏎💨 *RACERBOT IS NOW LIVE ON SOLANA!* 🟣⚡

You already know RacerBot is the fastest trading terminal on *NEAR, SUI, and Starknet*. 

Now, you never have to leave RacerBot to trade Solana meme coins or snipe Pump.fun again.

Stop splitting your focus and paying heavy fees across *Photon, Trojan, BullX, or BONKbot*. Everything you trade on Solana is now built directly into the bot you already trust — faster, smoother, and all under one roof.

🔥 *WHY BRING YOUR SOLANA TRADES TO RACERBOT?*

🎯 *Instant Pump.fun Sniping*
Paste any Pump.fun link or CA. Zero bonding curve delay — get in early before the Raydium migration.

⚡ *Jupiter v6 Institutional Routing*
Every trade routes through Jupiter's deepest liquidity (Raydium, Orca, Meteora, Phoenix) for the best fills and lowest slippage on Solana.

🛡️ *Zero Hanging / Failed Trades*
Dynamic MEV-protected priority fee bidding guarantees your buy/sell lands even during extreme Solana congestion.

💼 *One Unified Cockpit for All 4 Chains*
Track your *Solana, NEAR, SUI, and Starknet* bags in a single *💼 Holdings* dashboard. Instant 1-tap selling, live portfolio tracking, and viral branded PnL cards.

───────────────
💰 *YOUR SOLANA WALLET IS ALREADY LIVE:*

We’ve already generated your secure Solana deposit address inside your existing RacerBot account:

1️⃣ Tap *💳 My Solana Wallet* below to reveal your address
2️⃣ Deposit SOL (from Phantom, Solflare, Binance, or Bybit)
3️⃣ Paste *ANY* Solana mint address or Pump.fun link to execute your first trade!

🏁 *One bot. Four chains. Maximum speed.* Let's ride! 🚀`;

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
      reply_markup: {
        inline_keyboard: [
          [
            { text: '💳 Open Solana Wallet', callback_data: 'menu_wallet' },
            { text: '🚀 Snipe Pump.fun Now', callback_data: 'menu_trade' }
          ],
          [
            { text: '💼 View Portfolio & PnL', callback_data: 'menu_holdings' },
            { text: '🏎️ Launch WebApp Cockpit', url: 'https://t.me/racertradingbot/app' }
          ]
        ]
      }
    }),
  });
  return res.json();
}

async function main() {
  console.log('🔍 Connecting to RacerBot database...');
  const db = await getDb();
  const result = await db.query('SELECT telegram_id FROM users WHERE telegram_id IS NOT NULL ORDER BY created_at');
  const users = result.rows;

  console.log(`\n📋 Target Audience: ${users.length} users registered in RacerBot.`);

  if (isDryRun) {
    console.log('\n--- [DRY RUN MESSAGE PREVIEW] ---');
    console.log(MESSAGE);
    console.log('---------------------------------');
    console.log('✅ Dry run completed successfully! Run without "--dry-run" to broadcast.');
    process.exit(0);
  }

  console.log(`\n📢 Beginning broadcast to ${users.length} users...`);

  let sent = 0;
  let failed = 0;
  let blocked = 0;

  for (const user of users) {
    const chatId = user.telegram_id;
    try {
      const res = await sendMessage(chatId, MESSAGE);
      if (res.ok) {
        sent++;
        process.stdout.write(`\r✅ Sent: ${sent} | 🚫 Blocked: ${blocked} | ❌ Failed: ${failed}`);
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

    // Rate limit: Telegram allows up to 30 msgs/sec for bots; 40ms spacing avoids rate limits
    await new Promise((r) => setTimeout(r, 40));
  }

  console.log(`\n\n🎉 Solana broadcast completed!`);
  console.log(`   ✅ Delivered: ${sent}`);
  console.log(`   🚫 Blocked/Inactive: ${blocked}`);
  console.log(`   ❌ Other Errors: ${failed}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error during broadcast:', err);
  process.exit(1);
});
