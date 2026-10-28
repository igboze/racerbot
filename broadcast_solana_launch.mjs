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

const MESSAGE = `🚨 *STILL TRADING SOLANA WITH SLOW BOTS? TIME TO SWITCH.* 🟣⚡

If you're still getting front-run, suffering failed transactions, or paying ridiculous fees on Photon, Trojan, BullX, or BONKbot — you're leaving money on the table.

*RacerBot Solana is officially LIVE.*
Engineered for raw speed, zero-lag execution, and sniper-grade precision directly inside Telegram.

🔥 *WHY TRADERS ARE SWITCHING TO RACERBOT:*

⚡ *Sub-Second Execution Speed*
Direct high-priority MEV-protected routing. When milliseconds decide between a 10x entry and a red candle, RacerBot lands your block first.

🎯 *Instant Pump.fun Sniping*
Paste any Pump.fun link or CA. Zero bonding curve delay. Enter before the crowd and exit cleanly with automated slippage.

💧 *Institutional Jupiter v6 Aggregation*
Automatic multi-route liquidity across Raydium, Orca, Meteora & Phoenix. Get maximum tokens per SOL with zero wasted slippage.

🛡️ *Zero Failed TX Headaches*
Dynamic priority fees and adaptive gas bidding ensure your trades never hang or revert during extreme volatility.

💼 *One Cockpit. Four Chains.*
Stop juggling 5 different bots. Trade *Solana, NEAR, SUI, and Starknet* from a single unified wallet dashboard with live PnL tracking and one-tap instant sells.

───────────────
💰 *CLAIM YOUR EDGE RIGHT NOW:*

Your personal Solana high-speed wallet is *already generated and waiting in your account.*

👉 *Step 1:* Open @racertradingbot
👉 *Step 2:* Tap *💳 View Wallet* (or type /wallet) to grab your Solana address
👉 *Step 3:* Send 0.1+ SOL and paste ANY token CA to experience instant execution!

🚀 *Stop settling for second place. Start trading with the fastest machine in crypto.* 🏁`;

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
