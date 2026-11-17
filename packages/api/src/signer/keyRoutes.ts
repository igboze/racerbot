/**
 * The signer's key-custody routes (signer Phase B4): generate, seal, export and rotate keys,
 * so the API never needs the master key. All of them need the API's HMAC signature.
 *
 * Exports go from the signer straight to the user's Telegram chat with protect_content (the
 * message cannot be forwarded or saved, not even by a bot holding the token) and are deleted
 * after two minutes. The API never sees a decrypted key.
 */
import type { Express, Request } from 'express';
import { ethers } from 'ethers';
import { KeyPair } from 'near-api-js';
import {
  createLogger,
  decrypt,
  encrypt,
  exportSolanaPrivateKey,
  restoreSolanaKeypairFromSecret,
  restoreSuiKeypairFromSecret,
} from '@racerbot/shared';
import { getDb, getUserById, getUserWallets, getRaceFleetByUserId, getRaceFleetWallets } from '@racerbot/db';
import { generateCustodyKeyLocal, type CustodyKind } from '../keyCustody.js';
import { sendTelegramHtml, deleteTelegramMessage, sendSecurityAlert } from '../securityAlerts.js';

const logger = createLogger('signer-keys');
const KINDS: CustodyKind[] = ['near', 'evm', 'solana', 'sui', 'starknet', 'intents'];
const EXPORT_COOLDOWN_MS = 5 * 60_000;
const KEY_MESSAGE_TTL_MS = 2 * 60_000;
const lastExport = new Map<string, number>();
const masterKey = () => process.env.KEY_ENCRYPTION_MASTER_KEY!;

const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Refuses a plaintext that is not a key of that kind, so junk is never stored as a wallet */
function assertKeyOfKind(kind: CustodyKind, plaintext: string): void {
  const p = plaintext.trim();
  switch (kind) {
    case 'near': KeyPair.fromString(p as any); return;
    case 'evm': new ethers.Wallet(p); return;
    case 'solana': restoreSolanaKeypairFromSecret(p); return;
    case 'sui': restoreSuiKeypairFromSecret(p); return;
    case 'starknet': if (BigInt(p) <= 0n) throw new Error('bad key'); return;
    case 'intents': if (!p) throw new Error('empty key'); return;
  }
}

async function audit(userId: string | null, op: string, status: 'done' | 'failed' | 'refused', reason?: string): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO signer_audit (user_id, op, decision, status, reason, finished_at)
     VALUES ($1::uuid, $2::text, $3::text, $4::text, $5::text, NOW())`,
    [userId, op, status === 'refused' ? 'refused' : 'allowed', status, reason ?? null]
  ).catch((err: any) => logger.warn(`Key audit not written: ${err?.message}`));
}

const tryDecrypt = (enc?: string | null): string => {
  if (!enc) return '';
  try {
    return decrypt(enc, masterKey());
  } catch {
    return '';
  }
};

/** The keys message for /export: the user's main wallet on every chain */
async function walletKeysHtml(user: any): Promise<{ html: string; chains: string[] }> {
  const [nearWallets, suiWallets] = await Promise.all([
    getUserWallets(user.id, 'near').catch(() => []),
    getUserWallets(user.id, 'sui').catch(() => []),
  ]);
  const name = (ws: any[]) => {
    const a = ws.find(w => w.is_active);
    return a ? ` [${esc(a.name)}]` : '';
  };
  const chains: string[] = [];
  let html = '';
  const near = tryDecrypt(user.scoped_key_encrypted);
  if (near) {
    chains.push('NEAR');
    html += `🔑 <b>NEAR Private Key</b>${name(nearWallets)} (<code>${esc(user.subaccount_id)}</code>):\n<tg-spoiler><code>${esc(near)}</code></tg-spoiler>\n\n`;
  }
  const sui = tryDecrypt(user.sui_private_key_enc);
  if (user.sui_address && sui) {
    chains.push('Sui');
    html += `🔷 <b>SUI Private Key</b>${name(suiWallets)} (<code>${esc(user.sui_address)}</code>):\n<tg-spoiler><code>${esc(sui)}</code></tg-spoiler>\n\n`;
  }
  const starknet = tryDecrypt(user.starknet_private_key_enc);
  if (user.starknet_address && starknet) {
    chains.push('Starknet');
    html += `✨ <b>Starknet Private Key</b> (<code>${esc(user.starknet_address)}</code>):\n<tg-spoiler><code>${esc(starknet)}</code></tg-spoiler>\n\n`;
  }
  let solana = '';
  try {
    solana = user.solana_private_key_enc ? exportSolanaPrivateKey(user.solana_private_key_enc, masterKey()) : '';
  } catch {
    solana = '';
  }
  if (user.solana_address && solana) {
    chains.push('Solana');
    html += `◎ <b>Solana Private Key</b> (<code>${esc(user.solana_address)}</code>):\n<tg-spoiler><code>${esc(solana)}</code></tg-spoiler>\n\n`;
  }
  const evm = tryDecrypt(user.evm_private_key_enc);
  if (user.evm_address && evm) {
    chains.push('EVM (HyperEVM · Elysium · Kleos)');
    html += `⚡ <b>EVM Private Key</b>: HyperEVM · Elysium · Kleos (<code>${esc(user.evm_address)}</code>):\n<tg-spoiler><code>${esc(evm)}</code></tg-spoiler>\n\n`;
  }
  return { html, chains };
}

/** The keys message for a fleet export: every fleet wallet, NEAR and Solana */
async function fleetKeysHtml(userId: string): Promise<{ html: string; chains: string[] }> {
  const fleet = await getRaceFleetByUserId(userId);
  if (!fleet) return { html: '', chains: [] };
  const wallets = await getRaceFleetWallets(fleet.id);
  let html = `🏎️ <b>RaceFleet keys</b> (${esc(fleet.fleet_tag)})\n\n`;
  for (const w of wallets as any[]) {
    let pk = '';
    try {
      pk = (w.chain || 'near') === 'solana' ? exportSolanaPrivateKey(w.encrypted_private_key, masterKey()) : decrypt(w.encrypted_private_key, masterKey());
    } catch {
      pk = 'Decryption error';
    }
    html += `${(w.chain || 'near') === 'solana' ? '◎ ' : ''}W${w.wallet_index} <code>${esc(w.account_id)}</code>\n<tg-spoiler><code>${esc(pk)}</code></tg-spoiler>\n\n`;
  }
  return { html, chains: ['RaceFleet'] };
}

export function registerKeyRoutes(app: Express, authenticated: (req: Request) => boolean): void {
  const guard = (handler: (req: any, res: any) => Promise<void>) => async (req: any, res: any) => {
    if (!authenticated(req)) {
      logger.warn(`Refused an unauthenticated ${req.path} request`);
      res.status(401).json({ ok: false, error: 'Not authorized' });
      return;
    }
    try {
      await handler(req, res);
    } catch (err: any) {
      logger.warn(`${req.path} failed: ${err?.message}`);
      res.status(422).json({ ok: false, error: err?.message || 'Key request failed' });
    }
  };

  /** A new wallet key, generated here: the API receives only the address, public key and ciphertext */
  app.post('/v1/keys/generate', guard(async (req, res) => {
    const kind = req.body?.kind as CustodyKind;
    if (!KINDS.includes(kind)) {
      res.status(400).json({ ok: false, error: 'Unknown key kind' });
      return;
    }
    const key = generateCustodyKeyLocal(kind);
    await audit(null, `key_generate:${kind}`, 'done', key.address || key.publicKey);
    res.json({ ok: true, result: key });
  }));

  /** Encrypts a key the user imported */
  app.post('/v1/keys/seal', guard(async (req, res) => {
    const kind = req.body?.kind as CustodyKind;
    const plaintext = String(req.body?.plaintext ?? '');
    if (!KINDS.includes(kind)) {
      res.status(400).json({ ok: false, error: 'Unknown key kind' });
      return;
    }
    try {
      assertKeyOfKind(kind, plaintext);
    } catch {
      res.status(400).json({ ok: false, error: `That is not a valid ${kind.toUpperCase()} private key.` });
      return;
    }
    res.json({ ok: true, result: { encryptedPrivateKey: encrypt(plaintext.trim(), masterKey()) } });
  }));

  /** Sends the user their keys in Telegram, from the signer */
  app.post('/v1/keys/export', guard(async (req, res) => {
    const userId = String(req.body?.userId || '');
    const scope = req.body?.scope === 'fleet' ? 'fleet' : 'wallets';
    const user = await getUserById(userId).catch(() => null);
    const chatId = Number(user?.telegram_id) || 0;
    if (!user || chatId <= 0) {
      res.status(404).json({ ok: false, error: 'Keys can only be sent to a Telegram account.' });
      return;
    }
    const key = `${userId}:${scope}`;
    const last = lastExport.get(key);
    if (last && Date.now() - last < EXPORT_COOLDOWN_MS) {
      await audit(userId, `key_export:${scope}`, 'refused', 'cooldown');
      res.status(429).json({ ok: false, error: `Export is on cooldown. Try again in ${Math.ceil((EXPORT_COOLDOWN_MS - (Date.now() - last)) / 1000)}s.` });
      return;
    }
    const { html, chains } = scope === 'fleet' ? await fleetKeysHtml(userId) : await walletKeysHtml(user);
    if (!html) {
      res.status(404).json({ ok: false, error: 'No keys to export.' });
      return;
    }
    lastExport.set(key, Date.now());
    // Telegram caps a message at 4096 characters: a large fleet goes in several parts
    const footer = `👆 <i>Tap the covered boxes to uncover and copy your keys.</i>\n\n⚠️ <i>These messages delete themselves in 2 minutes and cannot be forwarded.</i>`;
    const parts: string[] = [];
    let part = '';
    for (const block of html.split('\n\n').filter(Boolean)) {
      if (part.length + block.length > 3500) {
        parts.push(part);
        part = '';
      }
      part += block + '\n\n';
    }
    parts.push(part + footer);
    const sent: number[] = [];
    for (const text of parts) {
      const messageId = await sendTelegramHtml(chatId, text, { protectContent: true });
      if (messageId) sent.push(messageId);
    }
    if (sent.length === 0) throw new Error('Could not send the keys to your Telegram chat.');
    setTimeout(() => { for (const id of sent) void deleteTelegramMessage(chatId, id); }, KEY_MESSAGE_TTL_MS).unref?.();
    await audit(userId, `key_export:${scope}`, 'done');
    void sendSecurityAlert({ userId, telegramId: chatId }, { kind: 'key_export', chains });
    res.json({ ok: true, result: { sent: true } });
  }));

  /** Rotates the user's NEAR key here and sends them the new one */
  app.post('/v1/keys/rotate-near', guard(async (req, res) => {
    const userId = String(req.body?.userId || '');
    const user = await getUserById(userId).catch(() => null);
    const chatId = Number(user?.telegram_id) || 0;
    if (!user || chatId <= 0) {
      res.status(404).json({ ok: false, error: 'User not found. Run /start first.' });
      return;
    }
    const { rotateUserKeyImpl } = await import('../wallet.js');
    const rotated = await rotateUserKeyImpl(chatId);
    await audit(userId, 'key_rotate:near', 'done', rotated.subaccountId);
    const messageId = await sendTelegramHtml(chatId,
      `✅ <b>Trading Key Rotated</b>\n\nAccount: <code>${esc(rotated.subaccountId)}</code>\n\n` +
      `⚠️ <b>NEW PRIVATE KEY</b>:\n<tg-spoiler><code>${esc(rotated.newPrivateKey)}</code></tg-spoiler>\n\n` +
      `• The old key has been removed from your account on-chain.\n• Save this new key securely.\n\n` +
      `⚠️ <i>This message deletes itself in 2 minutes and cannot be forwarded.</i>`,
      { protectContent: true });
    if (messageId) setTimeout(() => void deleteTelegramMessage(chatId, messageId), KEY_MESSAGE_TTL_MS).unref?.();
    res.json({ ok: true, result: { subaccountId: rotated.subaccountId } });
  }));
}
