/**
 * Security alerts: a Telegram message to the account owner whenever money leaves
 * their wallet, keys are exported, a wallet is imported or a new web session signs in.
 * If someone else got into the account, the owner hears about it at once.
 *
 * Alerts never throw and never delay the action they report.
 */
import { createLogger } from '@racerbot/shared';
import { getDb, getUserById } from '@racerbot/db';
import { Telegram } from 'telegraf';
import { getBotInstance } from './notify.js';

const logger = createLogger('security-alerts');

let directTelegram: Telegram | null = null;
/**
 * The running bot in the API; in the signer service (no bot running) a plain Telegram
 * client on the same token, so the signer can alert owners even if the API is down.
 */
function telegramClient(): Telegram | null {
  const bot = getBotInstance();
  if (bot) return bot.telegram;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  directTelegram ??= new Telegram(token);
  return directTelegram;
}

/** A message to the admins (ADMIN_TELEGRAM_ID, comma separated), e.g. when the signer pauses itself */
export async function sendAdminAlert(html: string): Promise<void> {
  const ids = (process.env.ADMIN_TELEGRAM_ID || '').split(',').map(s => Number(s.trim())).filter(n => n > 0);
  const client = telegramClient();
  if (!client) return;
  for (const id of ids) {
    await client.sendMessage(id, html, { parse_mode: 'HTML' }).catch((err: any) => {
      logger.warn(`Admin alert not sent to ${id}: ${err?.message}`);
    });
  }
}

export type SecurityEvent =
  | {
      kind: 'withdrawal';
      chain: string;
      asset: string;
      amount: string;
      to: string;
      txHash?: string;
      explorerUrl?: string;
    }
  | { kind: 'key_export'; chains: string[] }
  | { kind: 'wallet_import'; chain: string; address: string; active: boolean }
  | { kind: 'web_login'; method: string };

export interface AlertTarget {
  userId?: string | null;
  telegramId?: number | string | null;
}

const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const NOT_YOU =
  `\n\n<b>Not you?</b> Move your funds to a wallet you control right away (/withdraw), ` +
  `rotate your NEAR key with /rotate, and contact support.`;

/** Records the address and says whether this is the first send to it (null when unknown) */
async function isNewDestination(userId: string, chain: string, address: string): Promise<boolean | null> {
  try {
    const db = await getDb();
    const res = await db.query(
      `INSERT INTO security_known_destinations (user_id, chain, address)
       VALUES ($1::uuid, $2::text, $3::text)
       ON CONFLICT (user_id, chain, address) DO NOTHING
       RETURNING address`,
      [userId, chain.toLowerCase(), address.trim().toLowerCase()]
    );
    return res.rows.length > 0;
  } catch {
    return null;
  }
}

/** The alert text for one event */
export function formatSecurityAlert(event: SecurityEvent, firstSendToAddress: boolean | null): string {
  switch (event.kind) {
    case 'withdrawal': {
      const link = event.explorerUrl
        ? `\n🔗 <a href="${esc(event.explorerUrl)}">View transaction</a>`
        : event.txHash ? `\n🧾 Tx: <code>${esc(event.txHash)}</code>` : '';
      const newAddress = firstSendToAddress
        ? `\n\n⚠️ <b>First time sending to this address.</b>`
        : '';
      return (
        `🔐 <b>Security alert: funds sent</b>\n\n` +
        `💸 <b>${esc(event.amount)} ${esc(event.asset)}</b> on ${esc(event.chain)}\n` +
        `📬 To: <code>${esc(event.to)}</code>` +
        link + newAddress + NOT_YOU
      );
    }
    case 'key_export':
      return (
        `🔐 <b>Security alert: private keys exported</b>\n\n` +
        `Your private keys (${esc(event.chains.join(', '))}) were just displayed in this chat. ` +
        `Anyone who sees them controls those wallets.` + NOT_YOU
      );
    case 'wallet_import':
      return (
        `🔐 <b>Security alert: wallet imported</b>\n\n` +
        `A ${esc(event.chain)} wallet was added to your account${event.active ? ' and made active' : ''}:\n` +
        `<code>${esc(event.address)}</code>` +
        (event.active ? `\n\nNew trades now use this wallet.` : '') + NOT_YOU
      );
    case 'web_login':
      return (
        `🔐 <b>Security alert: new web sign-in</b>\n\n` +
        `Your account was just signed in on the Racer web app (${esc(event.method)}).` + NOT_YOU
      );
  }
}

/**
 * Sends a security alert to the account owner. Fire and forget: call it with `void`.
 * Resolves the Telegram chat from the user id when no Telegram id is given.
 */
export async function sendSecurityAlert(target: AlertTarget, event: SecurityEvent): Promise<void> {
  try {
    let telegramId = Number(target.telegramId) || 0;
    let userId = target.userId || null;
    if (!telegramId && userId) {
      const user = await getUserById(userId).catch(() => null);
      telegramId = telegramId || Number(user?.telegram_id) || 0;
    }
    if (!userId && telegramId) {
      const { getUserByTelegramId } = await import('@racerbot/db');
      userId = (await getUserByTelegramId(telegramId).catch(() => null))?.id ?? null;
    }
    // Web-only accounts have no Telegram chat (negative or missing ids)
    if (!telegramId || telegramId < 0) return;

    const firstSend = event.kind === 'withdrawal' && userId
      ? await isNewDestination(userId, event.chain, event.to)
      : null;

    const client = telegramClient();
    if (!client) return;
    await client.sendMessage(telegramId, formatSecurityAlert(event, firstSend), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    } as any);
  } catch (err: any) {
    logger.warn(`Security alert (${event.kind}) not sent: ${err?.message}`);
  }
}
