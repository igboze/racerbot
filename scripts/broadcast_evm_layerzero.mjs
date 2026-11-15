import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { Client } = require('pg');

const botToken = process.env.TELEGRAM_BOT_TOKEN;
if (!botToken) {
  console.error('❌ TELEGRAM_BOT_TOKEN not found in environment');
  process.exit(1);
}

const bot = new Telegraf(botToken);

export const BROADCAST_TEXT =
  `🔥 <b>NEW CHAINS UNLOCKED: TRADE EVM & ZERO NETWORK ON RACERBOT!</b> 🏎️⚡\n\n` +
  `RacerBot just went ultra multi-chain! You can now snipe and trade meme tokens directly across the hottest EVM ecosystems:\n\n` +
  `🔵 <b>Base</b> • 💙 <b>Arbitrum One</b> • 🅾️ <b>Zero Network (LayerZero L1)</b> • ⚡ <b>HyperEVM</b> • 💎 <b>Ethereum</b>\n\n` +
  `✨ <b>Why Cross-Chain Trading on RacerBot is a Game Changer:</b>\n` +
  `• <b>One Unified EVM Wallet:</b> A single sovereign address across all EVM chains. No network switching, zero wallet friction.\n` +
  `• <b>1-Click Cross-Chain Bridge:</b> Powered by LayerZero & Stargate V2. Found a hot meme on Zero Network but your funds are on Base or Arbitrum? RacerBot moves your liquidity in <b>1 tap</b> so you never miss a pump.\n` +
  `• <b>Instant Paste-to-Buy:</b> Paste any <code>0x...</code> contract address or DexScreener link into this chat to buy in milliseconds.\n` +
  `• <b>True Self-Custody:</b> Full private key exportability to MetaMask or Rabby anytime.\n\n` +
  `🚀 <b>Meme season on Zero Network is kicking off — get in early!</b>\n\n` +
  `👇 <i>Deposit to your unified EVM address or try 1-click bridging below:</i>`;

export const BROADCAST_KEYBOARD = Markup.inlineKeyboard([
  [
    Markup.button.callback('⚡ Deposit EVM & Zero', 'dep_evm_direct'),
    Markup.button.callback('🌉 1-Click Bridge', 'menu_bridge'),
  ],
  [
    Markup.button.callback('💳 My Wallet', 'menu_wallet'),
    Markup.button.callback('🏎️ Start Trading', 'menu_home'),
  ],
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const args = process.argv.slice(2);
  const isPreview = args.includes('--preview');
  const previewTarget = isPreview ? args[args.indexOf('--preview') + 1] : null;
  const isConfirm = args.includes('--confirm') || args.includes('--execute');

  if (!isPreview && !isConfirm) {
    console.log(`
📢 EVM & Zero Network Broadcast Tool
====================================
Usage:
  1. Dry Run / Inspection:
     node scripts/broadcast_evm_layerzero.mjs

  2. Preview (Send to single Telegram ID):
     node scripts/broadcast_evm_layerzero.mjs --preview <telegram_chat_id>

  3. Execute Broadcast to ALL users:
     node scripts/broadcast_evm_layerzero.mjs --confirm

-------------------------------------------
Message Preview:
-------------------------------------------
${BROADCAST_TEXT}
-------------------------------------------
`);
    process.exit(0);
  }

  if (isPreview) {
    if (!previewTarget) {
      console.error('❌ Please provide a telegram_id for preview: --preview <id>');
      process.exit(1);
    }
    console.log(`🚀 Sending preview message to telegram_id: ${previewTarget}...`);
    try {
      await bot.telegram.sendMessage(previewTarget, BROADCAST_TEXT, {
        parse_mode: 'HTML',
        ...BROADCAST_KEYBOARD,
        disable_web_page_preview: true,
      });
      console.log('✅ Preview sent successfully!');
    } catch (err) {
      console.error('❌ Failed to send preview:', err.message);
    }
    process.exit(0);
  }

  // Live Broadcast
  console.log('🔗 Connecting to database to fetch all users...');
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
  });

  await client.connect();

  const query = `
    SELECT DISTINCT telegram_id 
    FROM users 
    WHERE telegram_id IS NOT NULL 
    ORDER BY telegram_id ASC
  `;
  const res = await client.query(query);
  await client.end();

  const totalUsers = res.rows.length;
  console.log(`🎯 Found ${totalUsers} distinct users in the database.`);
  console.log(`🚀 Starting live broadcast to all ${totalUsers} users...`);

  let successCount = 0;
  let blockedCount = 0;
  let failedCount = 0;
  const startTime = Date.now();

  for (let i = 0; i < totalUsers; i++) {
    const user = res.rows[i];
    const chatId = user.telegram_id;

    try {
      await bot.telegram.sendMessage(chatId, BROADCAST_TEXT, {
        parse_mode: 'HTML',
        ...BROADCAST_KEYBOARD,
        disable_web_page_preview: true,
      });
      successCount++;
    } catch (err) {
      const errStr = String(err?.message || err);
      if (
        errStr.includes('bot was blocked by the user') ||
        errStr.includes('user is deactivated') ||
        errStr.includes('chat not found')
      ) {
        blockedCount++;
      } else if (errStr.includes('Too Many Requests') || err?.response?.error_code === 429) {
        const retryAfter = (err?.response?.parameters?.retry_after || 3) + 1;
        console.warn(`⏳ Rate limited (429). Pausing for ${retryAfter}s...`);
        await sleep(retryAfter * 1000);
        i--; // retry this user
        continue;
      } else {
        failedCount++;
        console.warn(`⚠️ Error sending to ${chatId}: ${errStr}`);
      }
    }

    if ((i + 1) % 25 === 0 || i === totalUsers - 1) {
      const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
      const rate = ((i + 1) / ((Date.now() - startTime) / 1000)).toFixed(1);
      console.log(
        `📊 Progress: ${i + 1}/${totalUsers} (${Math.round(((i + 1) / totalUsers) * 100)}%) | ` +
        `✅ Sent: ${successCount} | 🚫 Blocked: ${blockedCount} | ❌ Failed: ${failedCount} | ` +
        `⚡ Rate: ${rate} msg/s | ⏱️ Elapsed: ${elapsedSec}s`
      );
    }

    // Safe rate limiting for Telegram: sleep 35ms between messages
    await sleep(35);
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`
🏁 Broadcast Finished!
======================
👥 Total Users Targeted: ${totalUsers}
✅ Successfully Delivered: ${successCount}
🚫 Blocked / Deactivated: ${blockedCount}
❌ Other Failures: ${failedCount}
⏱️ Total Duration: ${durationSec} seconds
`);
}

main().catch((err) => {
  console.error('Fatal broadcast error:', err);
  process.exit(1);
});
