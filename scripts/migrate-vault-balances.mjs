// Return every balance still held in the old pooled router vault to its owner's wallet, before the
// vault is retired in favour of per-position executors. Accounts come from racer_vault_intents;
// balances are read from the router itself. Preview by default; pass --send to submit withdraw_user
// (owner-only, and the router only ever pays the user themselves).
//
//   node scripts/migrate-vault-balances.mjs [--send]
import 'dotenv/config';
import pg from 'pg';
import { getNear } from '@racerbot/shared';
import { KeyPair, transactions } from 'near-api-js';

const send = process.argv.includes('--send');
const routerId = process.env.ROUTER_CONTRACT_ID || 'racerbotrouter.near';
const ownerId = process.env.RACERBOT_PARENT_ACCOUNT || 'racerbot.near';
const ownerKey = (process.env.RELAYER_PRIVATE_KEY || process.env.MAIN_WALLET_PRIVATE_KEY || '').trim();

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const { rows } = await db.query(`
  SELECT account_id, ARRAY_AGG(DISTINCT token) AS tokens FROM (
    SELECT account_id, token_in AS token FROM racer_vault_intents
    UNION SELECT account_id, token_out FROM racer_vault_intents
  ) t GROUP BY account_id`);
await db.end();

const near = getNear();
const owed = [];
for (const { account_id: user, tokens } of rows) {
  for (const token of new Set([...tokens, 'near', 'wrap.near'])) {
    const raw = await near.view(routerId, 'vault_balance', { user, token }).catch(() => '0');
    if (BigInt(raw || '0') > 0n) owed.push({ user, token, raw: String(raw) });
  }
}

console.log(`Router ${routerId}: ${owed.length} balance(s) across ${new Set(owed.map(o => o.user)).size} account(s)`);
for (const o of owed) console.log(`  ${o.user}  ${o.token}  ${o.raw}`);
if (!send || owed.length === 0) {
  console.log(owed.length ? 'Preview only. Re-run with --send to return them.' : 'Nothing to return.');
  process.exit(0);
}
if (!ownerKey) throw new Error('Owner key (RELAYER_PRIVATE_KEY / MAIN_WALLET_PRIVATE_KEY) is not set');

await near.addKey(ownerId, KeyPair.fromString(ownerKey));
let failed = 0;
for (const o of owed) {
  try {
    const res = await near.signAndSendTransactionAll(ownerId, routerId, [
      transactions.functionCall('withdraw_user', { user: o.user, token: o.token }, BigInt('200000000000000'), 0n),
    ]);
    if (res?.status?.Failure) throw new Error(JSON.stringify(res.status.Failure).slice(0, 200));
    console.log(`  returned ${o.raw} ${o.token} to ${o.user}: https://nearblocks.io/txns/${res.transaction.hash}`);
  } catch (err) {
    failed++;
    console.error(`  FAILED ${o.user} ${o.token}: ${err.message}`);
  }
}
console.log(failed ? `${failed} return(s) failed; re-run to retry.` : 'All balances returned.');
process.exit(failed ? 1 : 0);
