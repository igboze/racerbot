// One-off: retroactively award Season 1 points for all historical fills.
// Idempotent — safe to re-run. Usage: node scripts/backfill-points.mjs
import { createRequire } from 'module';
import dotenv from 'dotenv';

dotenv.config({ path: new URL('../.env', import.meta.url) });
const require = createRequire(import.meta.url);
const { backfillAllPoints, disconnectDb } = require('../packages/db/dist/index.js');

console.log('[BACKFILL] Starting Season 1 points backfill...');
const started = Date.now();
const { fillsProcessed } = await backfillAllPoints((done, total) => {
  console.log(`[BACKFILL] ${done}/${total} fills processed`);
});
console.log(`[BACKFILL] Done — ${fillsProcessed} fills processed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
await disconnectDb().catch(() => {});
process.exit(0);
