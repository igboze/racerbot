/**
 * RacerBot signer service: the only service that signs money leaving user wallets.
 *
 * Run as its own Railway service (start: `node packages/api/dist/signer/server.js`) on the
 * private network only, with no public domain. The API sends it money-out requests signed with
 * SIGNER_SHARED_SECRET; the signer loads the user from the database itself (it never trusts user
 * data from the API), applies its rules (signer/policy.ts), signs with the keys only it should
 * hold, writes an audit row and alerts the owner in Telegram.
 *
 * Env: DATABASE_URL, KEY_ENCRYPTION_MASTER_KEY, SIGNER_SHARED_SECRET, TELEGRAM_BOT_TOKEN (alerts),
 * ADMIN_TELEGRAM_ID (circuit breaker alerts), the chain RPC variables the API uses, and optionally
 * SIGNER_PORT (default 8790), SIGNER_PAUSED, SIGNER_MAX_WITHDRAWALS_PER_USER_PER_HOUR,
 * SIGNER_GLOBAL_WINDOW_MINUTES, SIGNER_GLOBAL_MAX_WITHDRAWALS.
 */
// Marks this process as the signer before anything reads it (moneyOut.signerEnabled)
process.env.RACERBOT_SIGNER = 'true';

import 'dotenv/config';
import crypto, { createHash } from 'crypto';
import express from 'express';
import { ethers } from 'ethers';
import { VersionedMessage, VersionedTransaction } from '@solana/web3.js';
import {
  createLogger,
  assertValidMasterKey,
  getEvmWalletFromEncrypted,
  restoreSolanaKeypair,
  decrypt,
  type RemoteSignChain,
} from '@racerbot/shared';
import { getDb, getUserById } from '@racerbot/db';
import { findSigningKey, ownAddresses } from './keyStore.js';
import { evaluateEvmTx, evaluateSolanaMessage, evaluateNearTx, blocks, policyMode, type Findings } from './signPolicy.js';
import { KeyPair as NearKeyPair } from 'near-api-js';
import { decodeTransaction as decodeNearTransaction } from '@near-js/transactions';
import { MONEY_OUT_OPS, executeMoneyOut, signBody, toWire, type MoneyOutOp } from '../moneyOut.js';
import { checkAndRecord, finishAudit, breakerState, POLICY } from './policy.js';
import { sendAdminAlert } from '../securityAlerts.js';

const logger = createLogger('signer');
const MAX_CLOCK_SKEW_MS = 60_000;

assertValidMasterKey(process.env.KEY_ENCRYPTION_MASTER_KEY);
const SECRET = process.env.SIGNER_SHARED_SECRET || '';
if (SECRET.length < 32) {
  throw new Error('SIGNER_SHARED_SECRET must be set to at least 32 characters (openssl rand -hex 32).');
}

/** Signatures seen recently: a captured request cannot be sent again */
const seen = new Map<string, number>();
function rememberSignature(sig: string): boolean {
  const now = Date.now();
  for (const [k, at] of seen) if (now - at > MAX_CLOCK_SKEW_MS * 2) seen.delete(k);
  if (seen.has(sig)) return false;
  seen.set(sig, now);
  return true;
}

/** The destination a request sends to, for the audit log */
function destinationOf(op: MoneyOutOp, args: any[]): string | null {
  switch (op) {
    case 'near': case 'solana': case 'sui': case 'starknet': return args[0] ?? null;
    case 'near_token': case 'solana_token': case 'evm_hype': return args[1] ?? null;
    case 'evm_token': return args[0]?.to ?? null;
    case 'private': return args[1] ?? 'payout address';
    case 'near_payment': return args[0] ?? null;
  }
}

const txHashOf = (result: any): string | undefined =>
  result?.txHash || result?.elysiumTxHash || result?.intentHash || undefined;

const app = express();
app.disable('x-powered-by');
app.use(express.json({
  limit: '64kb',
  verify: (req: any, _res, buf) => { req.rawBody = buf.toString('utf8'); },
}));

app.get('/health', (_req, res) => {
  res.json({ ok: true, paused: process.env.SIGNER_PAUSED === 'true', breaker: breakerState() ? 'tripped' : 'ok' });
});

/** Only RacerBot's own services may ask: HMAC over timestamp + body, fresh, and never reused */
function authenticated(req: any): boolean {
  const timestamp = String(req.headers['x-signer-timestamp'] || '');
  const signature = String(req.headers['x-signer-signature'] || '');
  const expected = signBody(SECRET, timestamp, req.rawBody || '');
  const fresh = Math.abs(Date.now() - Number(timestamp)) <= MAX_CLOCK_SKEW_MS;
  const valid = signature.length === expected.length
    && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  return valid && fresh && rememberSignature(signature);
}

app.post('/v1/money-out', async (req: any, res) => {
  // 1. Only the API may ask
  if (!authenticated(req)) {
    logger.warn('Refused an unauthenticated money-out request');
    res.status(401).json({ ok: false, error: 'Not authorized' });
    return;
  }

  const { op, userId, args } = req.body || {};
  if (!MONEY_OUT_OPS.includes(op) || typeof userId !== 'string' || !Array.isArray(args)) {
    res.status(400).json({ ok: false, error: 'Malformed withdrawal request' });
    return;
  }

  // 2. The user comes from the database, never from the request
  const user = await getUserById(userId).catch(() => null);
  if (!user) {
    res.status(404).json({ ok: false, error: 'User not found. Run /start first.' });
    return;
  }

  // 3. The rules, recorded in the audit log whatever they decide
  let decision;
  try {
    decision = await checkAndRecord(user.id, op, destinationOf(op, args));
  } catch (err: any) {
    logger.error(`Policy check failed, refusing: ${err?.message}`);
    res.status(503).json({ ok: false, error: 'Withdrawals are temporarily unavailable. Your funds are safe; try again shortly.' });
    return;
  }
  if (decision.trippedNow) {
    void sendAdminAlert(
      `🚨 <b>Signer paused itself</b>\n\nMore than ${POLICY.globalMaxInWindow()} withdrawals in ${POLICY.globalWindowMinutes()} minutes ` +
      `(last: ${op} for user <code>${user.id}</code>). Every withdrawal is refused until the signer service is restarted. ` +
      `Check signer_audit before restarting.`
    );
  }
  if (!decision.allowed) {
    res.status(429).json({ ok: false, error: decision.reason });
    return;
  }

  // 4. Sign and send
  try {
    const result = await executeMoneyOut(op, user, args);
    await finishAudit(decision.auditId, 'done', { txHash: txHashOf(result) });
    res.type('application/json').send(toWire({ ok: true, result }));
  } catch (err: any) {
    const message = err?.message || 'Withdrawal failed';
    await finishAudit(decision.auditId, 'failed', { reason: message.slice(0, 500) });
    res.status(422).json({ ok: false, error: message });
  }
});

/** Records one signing request and what the rules found */
async function auditSign(userId: string, chain: RemoteSignChain, purpose: string | null, summary: string | null,
  findings: Findings, refused: boolean): Promise<void> {
  const notes = [...findings.hard.map(h => `hard: ${h}`), ...findings.soft.map(s => `soft: ${s}`)];
  const db = await getDb();
  await db.query(
    `INSERT INTO signer_audit (user_id, op, destination, decision, status, reason, finished_at)
     VALUES ($1::uuid, $2::text, $3::text, $4::text, $5::text, $6::text, NOW())`,
    [userId, `sign_${chain}${purpose ? `:${purpose}` : ''}`, summary, refused ? 'refused' : 'allowed',
      refused ? 'refused' : 'done', notes.length ? `[${policyMode()}] ${notes.join('; ')}`.slice(0, 1000) : null]
  ).catch((err: any) => logger.warn(`Sign audit not written: ${err?.message}`));
}

/**
 * Signs a trade transaction (signer Phase B): the caller sends the UNSIGNED transaction,
 * the signer checks it against its rules and signs with the key only it holds.
 */
app.post('/v1/sign', async (req: any, res) => {
  if (!authenticated(req)) {
    logger.warn('Refused an unauthenticated signing request');
    res.status(401).json({ ok: false, error: 'Not authorized' });
    return;
  }
  const { chain, kind, userId, address, purpose, payload } = req.body || {};
  if ((chain !== 'evm' && chain !== 'solana' && chain !== 'near') || typeof userId !== 'string' || typeof address !== 'string' || typeof payload !== 'string') {
    res.status(400).json({ ok: false, error: 'Malformed signing request' });
    return;
  }
  if (process.env.SIGNER_PAUSED === 'true') {
    res.status(429).json({ ok: false, error: 'Trading is paused for maintenance. Your funds are safe; try again later.' });
    return;
  }

  try {
    // The key only if this address belongs to this user
    const encryptedKey = await findSigningKey(userId, chain, address);
    if (!encryptedKey) {
      res.status(404).json({ ok: false, error: 'That wallet does not belong to this account.' });
      return;
    }
    const own = await ownAddresses(userId, chain);
    const masterKey = process.env.KEY_ENCRYPTION_MASTER_KEY!;

    if (chain === 'evm') {
      const wallet = getEvmWalletFromEncrypted(encryptedKey, masterKey);
      if (kind === 'transaction') {
        const tx = ethers.Transaction.from(payload);
        const findings = evaluateEvmTx(tx, own);
        const refused = blocks(findings);
        await auditSign(userId, chain, purpose, tx.to, findings, refused);
        if (refused) {
          res.status(403).json({ ok: false, error: `The signer refused this transaction: ${[...findings.hard, ...findings.soft][0]}` });
          return;
        }
        tx.signature = wallet.signingKey.sign(tx.unsignedHash);
        res.json({ ok: true, signed: tx.serialized });
        return;
      }
      // Messages and typed data move no funds by themselves: always recorded, signed as asked
      if (kind === 'message') {
        await auditSign(userId, chain, purpose, 'message', { hard: [], soft: [] }, false);
        res.json({ ok: true, signed: await wallet.signMessage(ethers.getBytes(payload)) });
        return;
      }
      if (kind === 'typed_data') {
        const { domain, types, value } = JSON.parse(payload);
        const findings: Findings = { hard: [], soft: [] };
        // A signed permit hands token spending to its spender
        if (types?.Permit && value?.spender) findings.soft.push(`typed-data permit for spender ${value.spender}`);
        const refused = blocks(findings);
        await auditSign(userId, chain, purpose, domain?.verifyingContract ?? 'typed data', findings, refused);
        if (refused) {
          res.status(403).json({ ok: false, error: 'The signer refused this signature request.' });
          return;
        }
        const { EIP712Domain: _drop, ...primaryTypes } = types || {};
        res.json({ ok: true, signed: await wallet.signTypedData(domain, primaryTypes, value) });
        return;
      }
      res.status(400).json({ ok: false, error: 'Unknown signing kind' });
      return;
    }

    if (chain === 'near') {
      const keyPair = NearKeyPair.fromString(decrypt(encryptedKey, masterKey) as any);
      // near-api-js asks for the public key first (to read the nonce): no funds move
      if (kind === 'public_key') {
        res.json({ ok: true, signed: keyPair.getPublicKey().toString() });
        return;
      }
      if (kind !== 'transaction') {
        res.status(400).json({ ok: false, error: 'Unknown signing kind' });
        return;
      }
      const bytes = Uint8Array.from(Buffer.from(payload, 'base64'));
      const tx: any = decodeNearTransaction(bytes);
      if (String(tx.signerId).toLowerCase() !== address.toLowerCase()) {
        res.status(400).json({ ok: false, error: 'The transaction is not from this wallet.' });
        return;
      }
      const findings = evaluateNearTx(tx, own);
      const refused = blocks(findings);
      await auditSign(userId, chain, purpose, tx.receiverId, findings, refused);
      if (refused) {
        res.status(403).json({ ok: false, error: `The signer refused this transaction: ${[...findings.hard, ...findings.soft][0]}` });
        return;
      }
      // What InMemorySigner signs: the sha256 of the encoded transaction
      const signature = keyPair.sign(new Uint8Array(createHash('sha256').update(bytes).digest())).signature;
      res.json({ ok: true, signed: Buffer.from(signature).toString('base64') });
      return;
    }

    // Solana: the caller sends the serialized message; the signature comes back
    const keypair = restoreSolanaKeypair(encryptedKey, masterKey);
    const message = VersionedMessage.deserialize(Buffer.from(payload, 'base64'));
    const findings = evaluateSolanaMessage(message, own);
    const refused = blocks(findings);
    await auditSign(userId, chain, purpose, `${message.compiledInstructions.length} instruction(s)`, findings, refused);
    if (refused) {
      res.status(403).json({ ok: false, error: `The signer refused this transaction: ${[...findings.hard, ...findings.soft][0]}` });
      return;
    }
    const index = message.staticAccountKeys.findIndex(k => k.equals(keypair.publicKey));
    if (index < 0 || index >= message.header.numRequiredSignatures) {
      res.status(400).json({ ok: false, error: 'This wallet is not a signer of that transaction.' });
      return;
    }
    const tx = new VersionedTransaction(message);
    tx.sign([keypair]);
    res.json({ ok: true, signed: Buffer.from(tx.signatures[index]).toString('base64') });
  } catch (err: any) {
    logger.warn(`Signing failed: ${err?.message}`);
    res.status(422).json({ ok: false, error: err?.message || 'Signing failed' });
  }
});

const port = Number(process.env.SIGNER_PORT || process.env.PORT || 8790);
// '::' listens on IPv6 too, which Railway's private network uses
app.listen(port, '::', () => logger.info(`Signer listening on port ${port}`));
