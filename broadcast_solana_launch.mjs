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

const MESSAGE = `🏎💨 *RacerBot is now LIVE on Solana!* 🟣

We have officially integrated the *Solana blockchain*! You can now trade any Solana token directly inside Telegram with lightning execution, zero wallet extension hassle, and institutional routing.

Here is what's now live on Solana:

🪙 *Trade Any Solana Token / Mint*
Paste any Solana token mint address or DexScreener/Birdeye link to get instant real-time price, market cap, liquidity, and 1-click Buy/Sell.

🚀 *Pump.fun Launchpad Sniping*
Snipe brand new tokens fresh off the *Pump.fun* bonding curve before they graduate to Raydium, with custom slippage and instant confirmation.

💧 *Jupiter DEX Aggregation*
Every trade automatically routes through *Jupiter v6*, guaranteeing the absolute lowest slippage, deepest liquidity pools, and optimal routes across Raydium, Orca, Meteora, and Phoenix.

💼 *Multi-Chain Portfolio & PnL*
Track all your Solana bags directly in *💼 Holdings* alongside your NEAR, SUI, and Starknet positions — with live PnL and one-click selling.

📊 *Branded Solana PNL Cards*
Win or lose, generate branded, shareable PnL cards showing your profit in SOL and USD with holding duration metrics.

🏁 *RaceFleet Multi-Wallet Trading*
Execute coordinated multi-wallet trades across your Solana fleets for stealth entries and automated volume distribution.

───────────────
⚡ *How to Start in 30 Seconds:*
1. Open @racertradingbot
2. Tap *Settings → Wallets* (your dedicated Solana address is already ready!)
3. Send SOL to your Solana deposit address
4. Paste any token address or Pump.fun link to trade!

_RacerBot — The fastest trading machine in Web3_ 🏎️✨`;

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
