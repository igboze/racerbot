import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import { getDb } from '../packages/db/dist/index.js';

const botToken = process.env.TELEGRAM_BOT_TOKEN;
if (!botToken) {
  console.error('❌ TELEGRAM_BOT_TOKEN not found in environment');
  process.exit(1);
}

const bot = new Telegraf(botToken);

// ── Pure Marketing Announcement Copy (High-Converting, Action-Packed) ────────
export const BROADCAST_TEXT =
  `🏎️ <b>STOP TRADING SOLO. UNLEASH RACERFLEET!</b>\n\n` +
  `Ever missed a 50x moonshot because of a <i>"max buy per wallet"</i> launchpad limit?\n` +
  `Ever wished you could enter a position with 10 or 20 wallets at the exact same second?\n\n` +
  `<b>Those days are officially OVER.</b> 🔥\n\n` +
  `Welcome to <b>RacerFleet</b> — your private army of up to <b>20 coordinated trading wallets</b>, built to dominate NEAR token launches and print profits with 1 single tap.\n\n` +
  `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
  `💎 <b>WHY RACERFLEET CHANGES EVERYTHING:</b>\n\n` +
  `🚀 <b>Shatter Per-Wallet Caps:</b>\n` +
  `Launchpad limits buyers to 1 NEAR per wallet? Fire 20 fleet wallets simultaneously and lock in a <b>20 NEAR bag</b> before the crowd even opens their charts!\n\n` +
  `⚡ <b>1-Tap Coordinated Sniping:</b>\n` +
  `Paste any token CA, tap <i>"Buy with Fleet"</i>, and watch every wallet execute in the same second. Split your budget evenly or set custom amounts effortlessly.\n\n` +
  `🛡️ <b>Whale-Grade Auto-Protection:</b>\n` +
  `Lock in pre-attached <b>+50% Take-Profit</b> & <b>-15% Stop-Loss</b>. RacerBot monitors your fleet 24/7 and triggers an emergency coordinated exit automatically.\n\n` +
  `💰 <b>Effortless 1-Click Funding & Sweep:</b>\n` +
  `Disburse NEAR from your main wallet to your fleet with 1 tap. When you take profit, sweep 100% of your funds back to your main wallet instantly.\n` +
  `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
  `👑 <b>BETA ACCESS IS NOW LIVE!</b>\n\n` +
  `The fastest traders on NEAR are already building their fleets. Don't trade at a disadvantage.\n\n` +
  `👇 <b>Tap below to deploy your fleet and start dominating:</b>`;

export const BROADCAST_KEYBOARD = Markup.inlineKeyboard([
  [
    Markup.button.callback('🚀 Deploy My RaceFleet Now', 'racefleet_menu'),
  ],
  [
    Markup.button.callback('📊 Open Fleet Cockpit', 'racefleet_menu'),
    Markup.button.callback('💳 Fleet Holdings & PnL', 'fleet_holdings'),
  ],
  [
    Markup.button.callback('🏎️ Back to Main Menu', 'menu_home'),
  ],
]);

// Sleep helper for Telegram broadcast rate limiting (max ~25-30 msgs/sec)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const args = process.argv.slice(2);
  const isPreview = args.includes('--preview');
  const previewTarget = args[args.indexOf('--preview') + 1] || '7938723184';
  const isExecute = args.includes('--execute');

  if (!isPreview && !isExecute) {
    console.log(`
📢 RacerFleet Broadcast Tool
============================
Usage:
  node scripts/broadcast_racefleet.mjs --preview <telegram_id>   (Send test message to specific admin)
  node scripts/broadcast_racefleet.mjs --execute                 (Broadcast to ALL database users)
`);
    process.exit(0);
  }

  if (isPreview) {
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

  if (isExecute) {
    console.log('📡 Fetching registered user list from database...');
    const db = await getDb();
    const res = await db.query(
      `SELECT DISTINCT telegram_id FROM users WHERE telegram_id IS NOT NULL`
    );

    const userIds = res.rows.map((r) => r.telegram_id);
    console.log(`🎯 Found ${userIds.length} distinct users to broadcast to.`);

    let sentCount = 0;
    let blockedCount = 0;
    let errorCount = 0;

    const startTime = Date.now();

    for (let i = 0; i < userIds.length; i++) {
      const telegramId = userIds[i];

      try {
        await bot.telegram.sendMessage(telegramId, BROADCAST_TEXT, {
          parse_mode: 'HTML',
          ...BROADCAST_KEYBOARD,
        });
        sentCount++;
      } catch (err) {
        const msg = String(err?.message || '');
        if (msg.includes('blocked') || msg.includes('user is deactivated') || msg.includes('chat not found')) {
          blockedCount++;
        } else if (msg.includes('Too Many Requests')) {
          // Telegram flood wait backoff
          const retryAfter = err?.parameters?.retry_after || 5;
          console.warn(`⚠️ Rate limited by Telegram. Waiting ${retryAfter}s...`);
          await sleep(retryAfter * 1000);
          i--; // retry this user
          continue;
        } else {
          errorCount++;
          console.warn(`⚠️ Failed to send to ${telegramId}:`, msg);
        }
      }

      // Progress reporting every 25 users
      if ((i + 1) % 25 === 0 || i === userIds.length - 1) {
        const pct = (((i + 1) / userIds.length) * 100).toFixed(1);
        console.log(`📊 Progress: ${i + 1}/${userIds.length} (${pct}%) — Delivered: ${sentCount}, Blocked: ${blockedCount}, Failed: ${errorCount}`);
      }

      // Safe pace: 40ms sleep (~25 messages/second) to stay well within Telegram limits
      await sleep(40);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`
🎉 BROADCAST COMPLETED in ${elapsed}s!
===================================
• Total targets: ${userIds.length}
• Successfully Delivered: ${sentCount}
• Inactive / Blocked Users: ${blockedCount}
• Errors: ${errorCount}
`);
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Fatal broadcast error:', err);
  process.exit(1);
});
