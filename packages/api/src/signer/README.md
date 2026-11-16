# Signer service and key security: setup

This covers what shipped in the key-security change and the owner steps to turn it on.
Nothing here changes or deletes existing data: the two new tables are additive, and every
withdrawal works exactly as before until you set `SIGNER_URL`.

## What is live after deploy (no setup needed)

- **Security alerts in Telegram** for every withdrawal (all chains, private balance and
  cross-chain), key export, wallet import (NEAR, Sui, EVM) and wallet sign-in on the web app.
  The first send to a new address is flagged.
- **Logs never carry keys**: the logger now strips the real key columns
  (`*_private_key_enc`, `scoped_key_encrypted`, `encrypted_private_key`, salts).
- **Migrations 070 and 071** add `security_known_destinations` and `signer_audit`. They only
  create new tables.

## Step 2: the signer service (owner steps on Railway)

The signer is the same repository with a different start command. It is the only service
that signs withdrawals, it is reachable only on Railway's private network, and it applies its
own rules, so a compromised API cannot drain wallets.

1. **Create the service.** New service → same GitHub repo. Settings:
   - Build command: same as the API (`npm run build`)
   - Start command: `node packages/api/dist/signer/server.js`
   - **Do not generate a public domain.** Private networking only.
2. **Generate a shared secret** (any machine): `openssl rand -hex 32`
3. **Signer variables:** copy from the API service `DATABASE_URL`,
   `KEY_ENCRYPTION_MASTER_KEY`, `TELEGRAM_BOT_TOKEN`, `ADMIN_TELEGRAM_ID` and the chain RPC
   variables (`NEAR_*`, `SOLANA_*`, `SUI_*`, `STARKNET_*`, `HYPEREVM_*`, `ELYSIUM_*`), then add:
   - `SIGNER_SHARED_SECRET` = the secret from step 2
   - `SIGNER_PORT` = `8790`
4. **Deploy the signer** and check its logs show `Signer listening on port 8790`.
5. **API variables:** add
   - `SIGNER_SHARED_SECRET` = the same secret
   - `SIGNER_URL` = `http://<signer-service-name>.railway.internal:8790`
6. **Redeploy the API.** From now on every withdrawal goes through the signer.
7. **Test** a small withdrawal in the bot. You should get the usual confirmation and the
   security alert, and a row in `signer_audit` with `status = 'done'`.

**To roll back**, remove `SIGNER_URL` from the API and redeploy: withdrawals run in the API
again. Nothing else changes.

### The signer's rules (environment, all optional)

| Variable | Default | What it does |
|---|---|---|
| `SIGNER_PAUSED` | `false` | `true` refuses every withdrawal (kill switch) |
| `SIGNER_MAX_WITHDRAWALS_PER_USER_PER_HOUR` | `10` | Per-user limit |
| `SIGNER_GLOBAL_MAX_WITHDRAWALS` | `60` | Circuit breaker: withdrawals across all users... |
| `SIGNER_GLOBAL_WINDOW_MINUTES` | `10` | ...within this window. When hit, the signer pauses itself and alerts the admins; restart the service to clear it, after checking `signer_audit` |

## Phase B: trades signed by the signer

Phase B moves trade signing into the signer too, chain by chain, so that in the end only the
signer holds `KEY_ENCRYPTION_MASTER_KEY`.

| Stage | Chains | Status |
|---|---|---|
| B1 | HyperEVM, Elysium, Kleos and the other Elysium pads; Solana (swaps and RaceFleet) | shipped |
| B2 | NEAR (swaps, fleet, confidential executors, vault) | next |
| B3 | Sui, Starknet | later |
| B4 | Key creation, import and export inside the signer; remove the master key from the API | last |

**How it works.** With `SIGNER_URL` set, a trade builds its transaction as before but sends it
*unsigned* to the signer (`/v1/sign`). The signer checks that the wallet belongs to the user,
checks the transaction against its rules, signs with the key and sends the signature back.
The trade code itself does not change.

**Every service that trades needs the two variables**: the API, and the executor and triggers
services if they run separately (when they run inside the API container they inherit them):
`SIGNER_URL` and `SIGNER_SHARED_SECRET`.

### The trade rules (`SIGNER_POLICY_MODE`)

- **Hard** findings are what only theft looks like: native funds or tokens sent to an address
  that is not the user's own (main, imported or fleet wallet) or RacerBot's fee wallet, token
  approvals to unknown spenders, account authority or owner changes, contract deployment.
- **Soft** findings are calls to a contract or program not yet on the allowlist (a new
  launchpad or router).

| Mode | Effect |
|---|---|
| `monitor` (default) | Signs everything, records findings in `signer_audit.reason` |
| `enforce_hard` | Refuses hard findings, records soft ones |
| `enforce` | Refuses both |

Run `monitor` for a few days of normal trading, then review:

```sql
SELECT op, destination, reason, COUNT(*) FROM signer_audit
WHERE op LIKE 'sign_%' AND reason IS NOT NULL AND created_at > NOW() - INTERVAL '7 days'
GROUP BY 1, 2, 3 ORDER BY 4 DESC;
```

Add any legitimate contract to `SIGNER_EVM_ALLOWED_CONTRACTS` or program to
`SIGNER_SOLANA_ALLOWED_PROGRAMS` (comma separated) on the signer, then switch to
`enforce_hard`, and later `enforce`.

Known limit: a Kleos/Elysium Multicall3 order is checked as a call to Multicall3; the value
transfers bundled inside it are not unpacked yet.

## Rotating the master key (optional, owner-run)

`scripts/rotate-master-key.mjs` re-encrypts every stored key with a new master key.

1. Take a restorable backup first: a Neon branch or snapshot of the production database.
   Keep a copy of the old master key.
2. Dry run (read-only, changes nothing): reports how many keys would be re-encrypted.
   ```
   DATABASE_URL=... OLD_MASTER_KEY=<old> NEW_MASTER_KEY=<new> node scripts/rotate-master-key.mjs
   ```
3. Commit (one transaction; each new value is checked before it is written; if any key
   fails, nothing is written):
   ```
   DATABASE_URL=... OLD_MASTER_KEY=<old> NEW_MASTER_KEY=<new> CONFIRM_BACKUP=yes node scripts/rotate-master-key.mjs --commit
   ```
4. Immediately set `KEY_ENCRYPTION_MASTER_KEY` to the new key on **every** service that has
   it (API, executor, triggers, signer) and redeploy them together. Plan a few minutes of
   maintenance: until they restart they cannot decrypt.

Re-running is safe: keys already on the new key are counted and skipped.

## Cloud KMS (after your research)

`getKeyVault()` (`packages/shared/src/keyVault.ts`) is the seam for a cloud KMS. Its only
provider today is `local` (the master key in the environment), and the signing code still
decrypts with the master key directly. In Phase B, decryption moves inside the signer and goes
through the key vault; adding AWS KMS, Google Cloud KMS or HashiCorp Vault is then one new
provider class, selected by `KEY_VAULT_PROVIDER`. Tell me which provider you pick.
