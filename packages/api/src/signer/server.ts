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
  restoreSuiKeypair,
  fromTaggedJson,
  decrypt,
  type RemoteSignChain,
} from '@racerbot/shared';
import { getDb, getUserById } from '@racerbot/db';
import { findSigningKey, ownAddresses } from './keyStore.js';
import { registerKeyRoutes } from './keyRoutes.js';
import {
  evaluateEvmTx, evaluateSolanaMessage, evaluateNearTx, evaluateSuiTxData, evaluateStarknetCalls, evaluateStarknetDeploy, evaluateIntentsMessage,
  blocks, policyMode, type Findings,
} from './signPolicy.js';
import { Transaction as SuiTransaction } from '@mysten/sui/transactions';
import { fromBase64, normalizeSuiAddress } from '@mysten/sui/utils';
import { Signer as StarknetSigner, ec as starkEc, stark } from 'starknet';
import { KeyPair as NearKeyPair, utils as nearUtils } from 'near-api-js';
import { getDepositQuote } from '../intentsPrivate.js';
import { isAllowedPaymentDestination } from '../moneyOut.js';
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

/**
 * Whether this signer's master key opens the keys stored in the database. A different key (for
 * example a freshly generated one instead of the API's) makes every decrypt fail with
 * "Unsupported state or unable to authenticate data", so it is checked at startup.
 */
let masterKeyCheck: 'ok' | 'mismatch' | 'unknown' = 'unknown';
async function checkMasterKey(): Promise<void> {
  try {
    const db = await getDb();
    const res = await db.query(
      `SELECT scoped_key_encrypted AS key FROM users
       WHERE scoped_key_encrypted IS NOT NULL AND scoped_key_encrypted <> 'EXTERNAL_CONNECTED_WALLET'
       ORDER BY created_at DESC LIMIT 5`
    );
    if (res.rows.length === 0) return;
    const opened = res.rows.filter((r: any) => {
      try {
        decrypt(r.key, process.env.KEY_ENCRYPTION_MASTER_KEY!);
        return true;
      } catch {
        return false;
      }
    }).length;
    masterKeyCheck = opened > 0 ? 'ok' : 'mismatch';
    if (masterKeyCheck === 'mismatch') {
      logger.error(
        `KEY_ENCRYPTION_MASTER_KEY does not match the database: 0 of ${res.rows.length} stored keys open with it. ` +
        'Set it to the SAME value the API uses (e.g. a Railway reference to the API service variable). ' +
        'Every signature will fail until it does.'
      );
      void sendAdminAlert(
        '🚨 <b>Signer master key mismatch</b>\n\nThe signer cannot decrypt stored keys: its KEY_ENCRYPTION_MASTER_KEY ' +
        'is not the one the keys were encrypted with. Remove SIGNER_URL from the API to keep trading, then fix the signer variable.'
      );
    } else {
      logger.info(`Master key check passed (${opened} of ${res.rows.length} sample keys open)`);
    }
  } catch (err: any) {
    logger.warn(`Master key check could not run: ${err?.message}`);
  }
}

app.get('/health', (_req, res) => {
  res.json({
    ok: masterKeyCheck !== 'mismatch',
    paused: process.env.SIGNER_PAUSED === 'true',
    breaker: breakerState() ? 'tripped' : 'ok',
    masterKey: masterKeyCheck,
  });
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
  if (!['evm', 'solana', 'near', 'sui', 'starknet'].includes(chain) || typeof userId !== 'string' || typeof address !== 'string' || typeof payload !== 'string') {
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

    const refuseWith = (findings: Findings) =>
      res.status(403).json({ ok: false, error: `The signer refused this transaction: ${[...findings.hard, ...findings.soft][0]}` });

    if (chain === 'sui') {
      const keypair = restoreSuiKeypair(encryptedKey, masterKey);
      if (kind === 'public_key') {
        res.json({ ok: true, signed: keypair.getPublicKey().toBase64() });
        return;
      }
      if (kind !== 'transaction') {
        res.status(400).json({ ok: false, error: 'Unknown signing kind' });
        return;
      }
      const bytes = fromBase64(payload);
      const data: any = SuiTransaction.from(bytes).getData();
      if (!data.sender || normalizeSuiAddress(data.sender) !== normalizeSuiAddress(address)) {
        res.status(400).json({ ok: false, error: 'The transaction is not from this wallet.' });
        return;
      }
      const findings = evaluateSuiTxData(data, own);
      const refused = blocks(findings);
      await auditSign(userId, chain, purpose, `${data.commands.length} command(s)`, findings, refused);
      if (refused) {
        refuseWith(findings);
        return;
      }
      const { signature } = await keypair.signTransaction(bytes);
      res.json({ ok: true, signed: signature });
      return;
    }

    if (chain === 'starknet') {
      const privateKey = decrypt(encryptedKey, masterKey);
      if (kind === 'public_key') {
        res.json({ ok: true, signed: starkEc.starkCurve.getStarkKey(privateKey) });
        return;
      }
      const signer = new StarknetSigner(privateKey);
      const { calls, details } = fromTaggedJson(payload);
      let findings: Findings;
      if (kind === 'transaction') {
        if (BigInt(details?.walletAddress ?? 0) !== BigInt(address)) {
          res.status(400).json({ ok: false, error: 'The transaction is not from this wallet.' });
          return;
        }
        findings = evaluateStarknetCalls(calls || [], own);
      } else if (kind === 'deploy_account') {
        findings = evaluateStarknetDeploy(details, own);
      } else {
        res.status(400).json({ ok: false, error: 'Unknown signing kind' });
        return;
      }
      const refused = blocks(findings);
      await auditSign(userId, chain, purpose, kind === 'deploy_account' ? 'deploy account' : `${(calls || []).length} call(s)`, findings, refused);
      if (refused) {
        refuseWith(findings);
        return;
      }
      const signature = kind === 'transaction'
        ? await signer.signTransaction(calls, details)
        : await signer.signDeployAccountTransaction(details);
      res.json({ ok: true, signed: JSON.stringify(stark.formatSignature(signature)) });
      return;
    }

    if (chain === 'near') {
      const keyPair = NearKeyPair.fromString(decrypt(encryptedKey, masterKey) as any);
      // near-api-js asks for the public key first (to read the nonce): no funds move
      if (kind === 'public_key') {
        res.json({ ok: true, signed: keyPair.getPublicKey().toString() });
        return;
      }
      if (kind === 'intents_message') {
        // Private-balance intents: funds only to own accounts, RacerBot or Alpha creators, or a
        // 1Click deposit address whose quote (per 1Click) pays one of those
        const isAllowedReceiver = async (receiver: string): Promise<boolean> => {
          if (await isAllowedPaymentDestination(receiver)) return true;
          const quote = await getDepositQuote(receiver).catch(() => null);
          const recipient = quote?.recipient ? String(quote.recipient).toLowerCase() : null;
          return Boolean(recipient && (own.has(recipient) || (await isAllowedPaymentDestination(recipient))));
        };
        const findings = await evaluateIntentsMessage(payload, address, own, isAllowedReceiver);
        const refused = blocks(findings);
        await auditSign(userId, chain, purpose, 'intents message', findings, refused);
        if (refused) {
          refuseWith(findings);
          return;
        }
        const { signature } = keyPair.sign(Buffer.from(payload, 'utf8'));
        res.json({ ok: true, signed: `ed25519:${nearUtils.serialize.base_encode(signature)}` });
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

// Key custody: generate, seal, export and rotate keys (signer Phase B4)
registerKeyRoutes(app, authenticated);

const port = Number(process.env.SIGNER_PORT || process.env.PORT || 8790);
// '::' listens on IPv6 too, which Railway's private network uses
app.listen(port, '::', () => {
  logger.info(`Signer listening on port ${port}`);
  void checkMasterKey();
});
