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
  `🌐 <b>MULTICHAIN DEPOSITS ARE LIVE ON RACERBOT!</b> 🚀\n\n` +
  `Bridging crypto is now officially a thing of the past. You can now deposit directly into your RacerBot wallet from <b>37+ blockchains</b> in seconds!\n\n` +
  `🔥 <b>Supported Networks & Assets:</b>\n` +
  `• <b>Chains:</b> Solana, Base, Ethereum, BSC, Arbitrum, Polygon, Sui, and 30+ more.\n` +
  `• <b>Assets:</b> SOL, ETH, BNB, USDC, or top tokens like $WIF, PEPE, TRUMP & BOME.\n\n` +
  `⚡ <b>Lightning Fast & Zero Bridge Hassle:</b>\n` +
  `1. Tap <b>📥 Deposit Now</b> below.\n` +
  `2. Pick your blockchain & deposit token.\n` +
  `3. Send to your personal 1-Click solver address.\n` +
  `4. Funds arrive as native <b>NEAR</b> in your subaccount — auto-unwrapped and ready to snipe!\n\n` +
  `🎁 <b>Share & Earn Rewards:</b>\n` +
  `Invite fellow traders to RacerBot and earn lifetime fee shares from every trade they make.\n\n` +
  `👇 <b>Tap below to fund your wallet or invite friends:</b>`;

const SHARE_TEXT = encodeURIComponent(
  '🚀 Deposit directly from Solana, Base, Ethereum, and 37+ chains into RacerBot with zero bridging hassle! Fund your wallet and start trading at lightning speed:'
);
const SHARE_URL = `https://t.me/share/url?url=https://t.me/racertradingbot&text=${SHARE_TEXT}`;

export const BROADCAST_KEYBOARD = Markup.inlineKeyboard([
  [
    Markup.button.callback('📥 Deposit Now (37+ Chains)', 'menu_multichain_deposit'),
  ],
  [
    Markup.button.url('👥 Share with Friends & Earn', SHARE_URL),
    Markup.button.callback('🏆 My Referral Link', 'referral'),
  ],
  [
    Markup.button.callback('🏎️ Main Trading Menu', 'menu_home'),
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
📢 Multichain Deposit Broadcast Tool
====================================
Usage:
  node broadcast_multichain_deposit.mjs --preview <telegram_id>   (Send test preview to admin)
  node broadcast_multichain_deposit.mjs --confirm                 (Broadcast to ALL users)
`);
    console.log('--- MESSAGE PREVIEW ---');
    console.log(BROADCAST_TEXT);
    process.exit(0);
  }

  if (isPreview) {
    if (!previewTarget) {
      console.error('❌ Please specify a telegram_id for preview: --preview <telegram_id>');
      process.exit(1);
    }
    console.log(`📤 Sending test preview to Telegram ID: ${previewTarget}...`);
    try {
      await bot.telegram.sendMessage(previewTarget, BROADCAST_TEXT, {
        parse_mode: 'HTML',
        ...BROADCAST_KEYBOARD,
      });
      console.log('✅ Preview message delivered successfully to', previewTarget);
    } catch (err) {
      console.error('❌ Failed to deliver preview message:', err.message);
    }
    process.exit(0);
  }

  if (isConfirm) {
    console.log('📡 Fetching registered user list from database...');
    const client = new Client({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
    await client.connect();

    const { rows } = await client.query(
      'SELECT DISTINCT telegram_id FROM users WHERE telegram_id IS NOT NULL ORDER BY telegram_id ASC'
    );
    await client.end();

    const userIds = rows.map((r) => r.telegram_id);
    console.log(`🎯 Found ${userIds.length} distinct users to broadcast to.`);

    let sent = 0;
    let blocked = 0;
    let failed = 0;
    const startTime = Date.now();

    for (let i = 0; i < userIds.length; i++) {
      const chatId = Number(userIds[i]);

      try {
        await bot.telegram.sendMessage(chatId, BROADCAST_TEXT, {
          parse_mode: 'HTML',
          ...BROADCAST_KEYBOARD,
        });
        sent++;
      } catch (err) {
        const msg = String(err?.message || '');
        if (msg.includes('blocked') || msg.includes('user is deactivated') || msg.includes('chat not found')) {
          blocked++;
        } else if (msg.includes('Too Many Requests') || msg.includes('retry after')) {
          const retryAfter = err?.parameters?.retry_after || 5;
          console.warn(`⚠️ Rate limited by Telegram. Waiting ${retryAfter}s...`);
          await sleep(retryAfter * 1000);
          i--;
          continue;
        } else {
          failed++;
          console.warn(`⚠️ Failed for ${chatId}: ${msg.slice(0, 80)}`);
        }
      }

      if ((i + 1) % 50 === 0 || i === userIds.length - 1) {
        const pct = (((i + 1) / userIds.length) * 100).toFixed(1);
        console.log(`📊 Progress: ${i + 1}/${userIds.length} (${pct}%) — Sent: ${sent}, Blocked: ${blocked}, Failed: ${failed}`);
      }

      await sleep(40); // ~25 msgs/sec safe pace
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`
🎉 BROADCAST COMPLETED in ${elapsed}s!
===================================
• Total targets: ${userIds.length}
• Successfully Delivered: ${sent}
• Inactive / Blocked Users: ${blocked}
• Failed: ${failed}
`);
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Fatal broadcast error:', err);
  process.exit(1);
});
