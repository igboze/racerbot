/**
 * One-time broadcast: Notify all users about the Token Share feature.
 *
 * Usage:
 *   npx tsx scripts/broadcast-share-feature.ts
 *
 * Set BOT_TOKEN in your environment (or .env) before running.
 */

import 'dotenv/config';
import { getDb } from '../packages/db/src/db.js';

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is not set. Exiting.');
  process.exit(1);
}

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const MESSAGE = `🏎 *RacerBot Update: Token Share Links are Live!*

You can now earn *5% of trading fees* simply by sharing tokens with friends!

*How it works:*
1️⃣ Open any token's details card in RacerBot
2️⃣ Tap 📤 *Share Token (Earn 5% Fees)*
3️⃣ Share the link — it carries your referral code + the token address

Anyone who taps your link lands directly on that token's buy card. If they trade it, you earn *5% of their fees instantly* — even if they're already a RacerBot user!

💰 *Both your 30% account referral rewards and 5% token share rewards* accumulate together in the same claimable balance. Use /referral to see your stats.

📤 Start sharing tokens and stack those rewards! 🚀`;

async function sendMessage(chatId: number, text: string): Promise<boolean> {
  try {
    const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });
    const data = await res.json() as any;
    return data.ok === true;
  } catch {
    return false;
  }
}

async function main() {
  const db = await getDb();
  const result = await db.query('SELECT telegram_id FROM users WHERE telegram_id IS NOT NULL ORDER BY created_at ASC');
  const users: { telegram_id: string }[] = result.rows;

  console.log(`Broadcasting to ${users.length} users…`);

  let sent = 0;
  let failed = 0;
  let blocked = 0;

  for (const user of users) {
    const chatId = Number(user.telegram_id);
    if (!chatId || isNaN(chatId)) continue;

    const ok = await sendMessage(chatId, MESSAGE);
    if (ok) {
      sent++;
    } else {
      failed++;
      // User may have blocked the bot
      blocked++;
    }

    // Respect Telegram rate limit: ~30 messages/second for bulk sends
    await new Promise(r => setTimeout(r, 50));

    if ((sent + failed) % 100 === 0) {
      console.log(`Progress: ${sent} sent, ${failed} failed (${blocked} likely blocked)`);
    }
  }

  console.log(`\n✅ Broadcast complete!`);
  console.log(`   Sent:    ${sent}`);
  console.log(`   Failed:  ${failed}`);
  process.exit(0);
}

main().catch(err => {
  console.error('Broadcast failed:', err);
  process.exit(1);
});
