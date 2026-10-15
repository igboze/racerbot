// One-off: send the current volume stats to the admin immediately.
// Usage: node scripts/send-volume-update.mjs --confirm
import { createRequire } from 'module';
import dotenv from 'dotenv';

dotenv.config({ path: new URL('../.env', import.meta.url) });
const require = createRequire(import.meta.url);
const { getVolumeStats, getDb, disconnectDb } = require('../packages/db/dist/index.js');

if (!process.argv.includes('--confirm')) {
  console.log('Dry run. Re-run with --confirm to actually send.');
  process.exit(0);
}

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is not set');
  process.exit(1);
}

const stats = await getVolumeStats();

// NEAR/USD for the USD figures — Binance first, Coinbase as backup.
let nearUsd = 0;
for (const url of [
  'https://api.binance.com/api/v3/ticker/price?symbol=NEARUSDT',
  'https://api.coinbase.com/v2/prices/NEAR-USD/spot',
]) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    const p = parseFloat(data?.price ?? data?.data?.amount ?? '0');
    if (p > 0) { nearUsd = p; break; }
  } catch { /* try next */ }
}

let suiUsd = 0;
for (const url of [
  'https://api.binance.com/api/v3/ticker/price?symbol=SUIUSDT',
  'https://api.coinbase.com/v2/prices/SUI-USD/spot',
]) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    const p = parseFloat(data?.price ?? data?.data?.amount ?? '0');
    if (p > 0) { suiUsd = p; break; }
  } catch { /* try next */ }
}

let strkUsd = 0;
for (const url of [
  'https://api.binance.com/api/v3/ticker/price?symbol=STRKUSDT',
  'https://api.coingecko.com/api/v3/simple/price?ids=starknet&vs_currencies=usd',
]) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    const p = parseFloat(data?.price ?? data?.starknet?.usd ?? '0');
    if (p > 0) { strkUsd = p; break; }
  } catch { /* try next */ }
}

const fmt = (n) => (n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
const nearUsdFmt = (n) => nearUsd > 0 ? ` (~$${(n * nearUsd).toLocaleString('en-US', { maximumFractionDigits: 0 })})` : '';
const suiUsdFmt = (n) => suiUsd > 0 ? ` (~$${(n * suiUsd).toLocaleString('en-US', { maximumFractionDigits: 0 })})` : '';
const strkUsdFmt = (n) => strkUsd > 0 ? ` (~$${(n * strkUsd).toLocaleString('en-US', { maximumFractionDigits: 0 })})` : '';

const total24hTrades = stats.trades24h + stats.trades24hSui + (stats.trades24hStarknet || 0);
const totalTrades = stats.tradesTotal + stats.tradesTotalSui + (stats.tradesTotalStarknet || 0);

const text =
  `📊 *RacerBot Daily Report*\n\n` +
  `👥 *Users*\n` +
  `• Total: \`${stats.usersTotal.toLocaleString('en-US')}\`\n` +
  `• New today: \`${stats.newUsers24h}\`\n\n` +
  `🔥 *Last 24h*\n` +
  `• Total trades: \`${total24hTrades}\` (${stats.buys24h} buys / ${stats.sells24h} sells)\n` +
  `• Active traders: \`${stats.activeTraders24h}\`\n\n` +
  `〽️ *NEAR — 24h*\n` +
  `• Volume: \`${fmt(stats.volume24hNear)} NEAR\`${nearUsdFmt(stats.volume24hNear)}\n` +
  `• Trades: \`${stats.trades24h}\`\n\n` +
  `🔵 *SUI — 24h*\n` +
  `• Volume: \`${fmt(stats.volume24hSui)} SUI\`${suiUsdFmt(stats.volume24hSui)}\n` +
  `• Trades: \`${stats.trades24hSui}\`\n\n` +
  `⚡ *Starknet — 24h*\n` +
  `• Volume: \`${fmt(stats.volume24hStarknet)} STRK\`${strkUsdFmt(stats.volume24hStarknet)}\n` +
  `• Trades: \`${stats.trades24hStarknet || 0}\`\n\n` +
  `📈 *All Time*\n` +
  `• NEAR volume: \`${fmt(stats.volumeTotalNear)} NEAR\`${nearUsdFmt(stats.volumeTotalNear)}\n` +
  `• SUI volume: \`${fmt(stats.volumeTotalSui)} SUI\`${suiUsdFmt(stats.volumeTotalSui)}\n` +
  `• Starknet volume: \`${fmt(stats.volumeTotalStarknet)} STRK\`${strkUsdFmt(stats.volumeTotalStarknet)}\n` +
  `• Total trades: \`${totalTrades.toLocaleString('en-US')}\``;

// Resolve the admin chat: persisted admin_chat_id first, then username lookup.
const db = await getDb();
let chatId = null;
const stored = await db.query("SELECT value FROM bot_settings WHERE key = 'admin_chat_id'").catch(() => null);
if (stored && stored.rows[0]?.value) {
  chatId = parseInt(stored.rows[0].value, 10);
}
if (!chatId) {
  const names = (process.env.ADMIN_USERNAMES || '').split(',').map(s => s.trim().replace(/^@/, '').toLowerCase()).filter(Boolean);
  if (names.length > 0) {
    const r = await db.query('SELECT telegram_id FROM users WHERE LOWER(username) = ANY($1)', [names]);
    if (r.rows[0]) chatId = Number(r.rows[0].telegram_id);
  }
}
if (!chatId) {
  console.error('Could not resolve an admin chat id (no admin_chat_id setting, no matching username)');
  process.exit(1);
}

const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
});
const data = await res.json();
if (res.ok && data.ok) {
  console.log(`[VOLUME] Update sent to admin chat ${chatId}`);
} else {
  console.error(`[VOLUME] Send failed: ${res.status} ${JSON.stringify(data).slice(0, 200)}`);
  process.exit(1);
}
await disconnectDb().catch(() => {});
process.exit(0);
