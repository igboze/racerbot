// Re-encrypt every stored private key from the current master key to a new one.
// Dry run by default (read-only: decrypts everything with the old key and reports);
// pass --commit to re-encrypt in ONE transaction. Each new ciphertext is decrypted
// back and compared before it is written, and nothing is written unless every key
// succeeds. Safe to run again: keys already on the new key are counted and skipped.
//
//   DATABASE_URL=... OLD_MASTER_KEY=... NEW_MASTER_KEY=... node scripts/rotate-master-key.mjs            (dry run)
//   ... CONFIRM_BACKUP=yes node scripts/rotate-master-key.mjs --commit   (after taking a restorable backup)
//
// After a commit, set KEY_ENCRYPTION_MASTER_KEY to the new key on EVERY service that
// reads it (api, executor, triggers, signer) and redeploy them together. Until then the
// old services cannot decrypt, so plan a short maintenance window.
import 'dotenv/config';
import pg from 'pg';
import { encrypt, decrypt, assertValidMasterKey } from '@racerbot/shared';

const commit = process.argv.includes('--commit');
const OLD = process.env.OLD_MASTER_KEY || '';
const NEW = process.env.NEW_MASTER_KEY || '';
const DATABASE_URL = process.env.DATABASE_URL || '';

if (!DATABASE_URL) {
  console.error('Set DATABASE_URL.');
  process.exit(1);
}
try {
  assertValidMasterKey(OLD);
  assertValidMasterKey(NEW);
} catch (err) {
  console.error(`OLD_MASTER_KEY and NEW_MASTER_KEY must both be strong keys: ${err.message}`);
  process.exit(1);
}
// Re-encrypting rewrites every key column: only with a restorable backup taken first
if (commit && process.env.CONFIRM_BACKUP !== 'yes') {
  console.error(
    'Before --commit, take a backup you can restore (a Neon branch or snapshot of the database),\n' +
    'keep a copy of OLD_MASTER_KEY, then re-run with CONFIRM_BACKUP=yes.'
  );
  process.exit(1);
}
if (OLD === NEW) {
  console.error('NEW_MASTER_KEY must differ from OLD_MASTER_KEY.');
  process.exit(1);
}

/** Every column that holds a key encrypted with the master key */
const COLUMNS = [
  { table: 'users', pk: 'id', column: 'scoped_key_encrypted' },
  { table: 'users', pk: 'id', column: 'sui_private_key_enc' },
  { table: 'users', pk: 'id', column: 'starknet_private_key_enc' },
  { table: 'users', pk: 'id', column: 'solana_private_key_enc' },
  { table: 'users', pk: 'id', column: 'evm_private_key_enc' },
  { table: 'user_wallets', pk: 'id', column: 'encrypted_private_key' },
  { table: 'race_fleet_wallets', pk: 'id', column: 'encrypted_private_key' },
  { table: 'confidential_accounts', pk: 'user_id', column: 'secret_key_encrypted' },
];
/** Values that are markers, not ciphertext (web users who connect their own wallet) */
const NOT_CIPHERTEXT = new Set(['', 'EXTERNAL_CONNECTED_WALLET']);

const tryDecrypt = (value, key) => {
  try {
    return decrypt(value, key);
  } catch {
    return null;
  }
};

const client = new pg.Client({ connectionString: DATABASE_URL, ssl: DATABASE_URL.includes('sslmode=disable') ? false : { rejectUnauthorized: true } });
await client.connect();
await client.query(commit ? 'BEGIN' : 'BEGIN READ ONLY');

const totals = { rotated: 0, alreadyNew: 0, skippedMarkers: 0 };
const undecryptable = [];
try {
  for (const { table, pk, column } of COLUMNS) {
    const exists = await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
      [table, column]
    );
    if (exists.rows.length === 0) {
      console.log(`- ${table}.${column}: column not present, skipped`);
      continue;
    }
    const rows = await client.query(
      `SELECT ${pk} AS pk, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL${commit ? ' FOR UPDATE' : ''}`
    );
    let rotated = 0;
    let alreadyNew = 0;
    let markers = 0;
    for (const { pk: id, value } of rows.rows) {
      if (NOT_CIPHERTEXT.has(String(value).trim())) {
        markers++;
        continue;
      }
      const plain = tryDecrypt(value, OLD);
      if (plain === null) {
        if (tryDecrypt(value, NEW) !== null) alreadyNew++;
        else undecryptable.push(`${table}.${column} ${pk}=${id}`);
        continue;
      }
      if (commit) {
        const next = encrypt(plain, NEW);
        if (tryDecrypt(next, NEW) !== plain) throw new Error(`Re-encryption check failed for ${table}.${column} ${pk}=${id}`);
        await client.query(`UPDATE ${table} SET ${column} = $1 WHERE ${pk} = $2`, [next, id]);
      }
      rotated++;
    }
    totals.rotated += rotated;
    totals.alreadyNew += alreadyNew;
    totals.skippedMarkers += markers;
    console.log(`- ${table}.${column}: ${rotated} ${commit ? 'rotated' : 'to rotate'}, ${alreadyNew} already on the new key, ${markers} connected-wallet markers`);
  }

  if (undecryptable.length > 0) {
    console.error(`\n${undecryptable.length} value(s) decrypt with neither key. Nothing was changed:`);
    for (const row of undecryptable.slice(0, 50)) console.error(`  ${row}`);
    await client.query('ROLLBACK');
    process.exitCode = 1;
  } else if (commit) {
    await client.query('COMMIT');
    console.log(`\nCommitted: ${totals.rotated} key(s) re-encrypted with the new master key.`);
    console.log('Now set KEY_ENCRYPTION_MASTER_KEY to the new key on every service and redeploy them together.');
  } else {
    await client.query('ROLLBACK');
    console.log(`\nDry run: ${totals.rotated} key(s) would be re-encrypted. Nothing was changed. Re-run with --commit.`);
  }
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(`Rotation failed, nothing was changed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
