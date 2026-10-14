/**
 * broadcast_batman.mjs
 * Targeted broadcast to registered users who have not yet executed a trade.
 * Reminds them about $BATMAN (batman-4.nearlytrade.near) and lets them ape with 1 tap.
 *
 * Usage:
 *   node broadcast_batman.mjs --dry-run   (preview target user count and message)
 *   node broadcast_batman.mjs --send      (broadcast to all inactive users)
 */
import { getDb } from './packages/db/dist/index.js';
import dotenv from 'dotenv';
dotenv.config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ No TELEGRAM_BOT_TOKEN found in .env');
  process.exit(1);
}

const isSend = process.argv.includes('--send');
const isDryRun = process.argv.includes('--dry-run') || !isSend;

function buildMessage(subaccountId) {
  return (
`🦇 <b>$BATMAN is Going Parabolic on NEAR!</b> 🚀

Looking for the next runner? <b>$BATMAN</b> is doing insane numbers on NearlyTrade / Ref DCL right now!

📈 <b>Token Highlights:</b>
• <b>Token:</b> $BATMAN
• <b>Contract:</b> <code>batman-4.nearlytrade.near</code>
• <b>Status:</b> 100% Bonded & Migrated to Ref DCL
• <b>Liquidity:</b> $350K+ (83,500+ NEAR locked)
• <b>Execution:</b> Lightning-fast 1-click execution on RacerBot

🏎️ <i>Your RacerBot trading wallet is active and ready:</i>
<u>Deposit Address</u>: <code>${subaccountId}</code>

Tap below to ape instantly with zero hassle:`
  );
}

const KEYBOARD = {
  inline_keyboard: [
    [
      { text: '🚀 Buy 1 NEAR', callback_data: 'buy_fixed:batman-4.nearlytrade.near:1' },
      { text: '🚀 Buy 5 NEAR', callback_data: 'buy_fixed:batman-4.nearlytrade.near:5' },
    ],
    [
      { text: '🟢 Buy Custom NEAR', callback_data: 'buy_custom_prompt:batman-4.nearlytrade.near' },
    ],
    [
      { text: '💳 My Wallet / Deposit', callback_data: 'menu_wallet' },
    ],
  ],
};

async function sendMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      reply_markup: KEYBOARD,
      disable_web_page_preview: true,
    }),
  });
  return await res.json();
}

async function main() {
  const db = await getDb();
  
  // Target: Users who signed up (have subaccount) but have 0 executed trades in fills
  const query = `
    SELECT telegram_id, subaccount_id, username
    FROM users
    WHERE id NOT IN (SELECT DISTINCT user_id FROM fills)
      AND telegram_id IS NOT NULL
    ORDER BY created_at DESC
  `;
  const result = await db.query(query);
  const users = result.rows;

  console.log(`\n🎯 Found ${users.length} registered users who have not yet traded.\n`);

  if (isDryRun) {
    console.log('🧪 DRY RUN MODE (use --send to actually deliver messages)');
    console.log('Sample message for user', users[0]?.telegram_id, `(${users[0]?.username || 'anon'}):`);
    console.log('─'.repeat(50));
    console.log(buildMessage(users[0]?.subaccount_id || 'your-wallet.racerbot.near'));
    console.log('─'.repeat(50));
    console.log('\nButtons attached: [🚀 Buy 1 NEAR] [🚀 Buy 5 NEAR] [🟢 Buy Custom NEAR] [💳 My Wallet / Deposit]');
    console.log('\nTo broadcast to all ' + users.length + ' users, run:\n  node broadcast_batman.mjs --send\n');
    process.exit(0);
  }

  console.log(`📢 Broadcasting $BATMAN reminder to ${users.length} users...\n`);

  let sent = 0;
  let blocked = 0;
  let failed = 0;

  for (let i = 0; i < users.length; i++) {
    const user = users[i];
    const chatId = user.telegram_id;
    const subaccount = user.subaccount_id || 'your-wallet.racerbot.near';
    const text = buildMessage(subaccount);

    try {
      const res = await sendMessage(chatId, text);
      if (res.ok) {
        sent++;
      } else {
        const errCode = res.error_code;
        if (errCode === 403 || errCode === 400) {
          blocked++; // User blocked bot or deleted chat
        } else if (errCode === 429) {
          // Rate limited: respect retry_after
          const retrySec = res.parameters?.retry_after || 2;
          console.log(`\n⏳ Rate limited. Backing off ${retrySec}s...`);
          await new Promise(r => setTimeout(r, retrySec * 1000));
          // Retry once
          const retryRes = await sendMessage(chatId, text);
          if (retryRes.ok) sent++;
          else failed++;
        } else {
          failed++;
          console.log(`\n⚠️ Chat ${chatId}: ${res.description}`);
        }
      }
    } catch (err) {
      failed++;
      console.log(`\n⚠️ Chat ${chatId}: ${err.message}`);
    }

    if ((i + 1) % 10 === 0 || i === users.length - 1) {
      process.stdout.write(`\rProgress: [${i + 1}/${users.length}] | ✅ Sent: ${sent} | 🚫 Blocked: ${blocked} | ❌ Failed: ${failed}`);
    }

    // Rate-limit safety: 40ms interval (~25 msgs/sec, safe under Telegram's 30/sec limit)
    await new Promise(r => setTimeout(r, 45));
  }

  console.log('\n\n📊 Broadcast completed successfully!');
  console.log(`   ✅ Delivered: ${sent}`);
  console.log(`   🚫 Blocked/Inactive: ${blocked}`);
  console.log(`   ❌ Failed: ${failed}`);
  process.exit(0);
}

main().catch(console.error);
