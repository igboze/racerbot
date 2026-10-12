// Broadcast: Starknet chain expansion announcement to all RacerBot users.
// Usage:
//   Dry run:  node scripts/broadcast-starknet-launch.mjs
//   Live run: node scripts/broadcast-starknet-launch.mjs --confirm
//
// Rate-limited to ~20 msg/s with 429 retry handling and 403 blocked user tracking.

import { createRequire } from 'module';
import dotenv from 'dotenv';

dotenv.config({ path: new URL('../.env', import.meta.url) });
const require = createRequire(import.meta.url);
const { Client } = require('pg');

const isConfirm = process.argv.includes('--confirm');

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('❌ TELEGRAM_BOT_TOKEN is not set in environment.');
  process.exit(1);
}

const MESSAGE =
  `⚡ *STARKNET IS LIVE ON RACERBOT!* ⚡\n\n` +
  `We are thrilled to announce that *Starknet* trading is now officially live on RacerBot!\n\n` +
  `✨ *What's New:*\n` +
  `• *Instant Account Abstraction Wallet* — Your personal counterfactual Starknet wallet is already generated and ready to use.\n` +
  `• *Dual-Gas Flexibility* — Pay transaction gas directly in *STRK* or *ETH* — no paymaster or sponsorship required.\n` +
  `• *Smart Liquidity & Safety Audits* — Real-time detection of honeypots, malicious Cairo ABI entrypoints, and exact liquidity lock percentages (Launchy, Unruggable Meme & DEX pools).\n` +
  `• *Full Launchpad & DEX Aggregation* — Trade tokens seamlessly across bonding curves and top venues via Launchy, AVNU & Ekubo.\n` +
  `• *True Self-Custody* — Export your Starknet private key anytime to *Argent X* or *Braavos*.\n\n` +
  `🚀 *How to Get Started:*\n` +
  `1. Tap /wallet or /start in RacerBot.\n` +
  `2. Copy your new *Starknet Address*.\n` +
  `3. Deposit STRK or ETH and paste any Starknet token contract to trade at lightning speed!\n\n` +
  `_Thank you for being part of the fastest multi-chain Telegram trading terminal._`;

async function run() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  const { rows } = await client.query('SELECT telegram_id FROM users ORDER BY created_at ASC');
  await client.end();

  console.log(`[BROADCAST] Target user count: ${rows.length}`);

  if (!isConfirm) {
    console.log('--------------------------------------------------');
    console.log('DRY RUN PREVIEW OF MESSAGE:');
    console.log(MESSAGE);
    console.log('--------------------------------------------------');
    console.log('ℹ️ To send this message to all users, run with --confirm:');
    console.log('   node scripts/broadcast-starknet-launch.mjs --confirm');
    process.exit(0);
  }

  console.log(`[BROADCAST] Starting live broadcast to ${rows.length} users...`);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  let sent = 0;
  let blocked = 0;
  let failed = 0;

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
        console.log(`[BROADCAST] Rate limited — waiting ${wait}ms, then retrying...`);
        await sleep(wait);
        i--; // retry same user
        continue;
      } else {
        failed++;
        console.warn(`[BROADCAST] Failed for ${chatId}: ${res.status} ${JSON.stringify(data).slice(0, 100)}`);
      }
    } catch (err) {
      failed++;
      console.warn(`[BROADCAST] Network error for ${chatId}: ${err?.message || err}`);
    }

    if (i % 50 === 0 && i > 0) {
      console.log(`[BROADCAST] Progress: ${i}/${rows.length} sent=${sent} blocked=${blocked} failed=${failed}`);
    }

    await sleep(50); // ~20 msg/sec
  }

  console.log(`[BROADCAST] Completed! Total: ${rows.length} | Sent: ${sent} | Blocked: ${blocked} | Failed: ${failed}`);
  process.exit(0);
}

run().catch((err) => {
  console.error('[BROADCAST] Fatal error:', err);
  process.exit(1);
});
