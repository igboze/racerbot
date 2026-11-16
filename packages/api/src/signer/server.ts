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
import crypto from 'crypto';
import express from 'express';
import { createLogger, assertValidMasterKey } from '@racerbot/shared';
import { getUserById } from '@racerbot/db';
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

app.post('/v1/money-out', async (req: any, res) => {
  // 1. Only the API may ask: HMAC over timestamp + body, fresh, and never reused
  const timestamp = String(req.headers['x-signer-timestamp'] || '');
  const signature = String(req.headers['x-signer-signature'] || '');
  const expected = signBody(SECRET, timestamp, req.rawBody || '');
  const fresh = Math.abs(Date.now() - Number(timestamp)) <= MAX_CLOCK_SKEW_MS;
  const valid = signature.length === expected.length
    && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  if (!valid || !fresh || !rememberSignature(signature)) {
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

const port = Number(process.env.SIGNER_PORT || process.env.PORT || 8790);
// '::' listens on IPv6 too, which Railway's private network uses
app.listen(port, '::', () => logger.info(`Signer listening on port ${port}`));
