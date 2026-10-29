/**
 * Telegram-safe copy-trade buttons and share links.
 *
 * Telegram rejects a whole message when any button's callback_data exceeds 64 bytes, and accepts
 * only 64 chars of [A-Za-z0-9_-] in a /start parameter. NEAR wallets (64-char implicit accounts,
 * names with dots) and referrer UUIDs break both, so they travel as short keys or a target id.
 */
import { getShortTokenKey } from '@racerbot/shared';

const TELEGRAM_CALLBACK_LIMIT = 64;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** callback_data for the copy-mode choice; the referrer is dropped only if it cannot fit */
export function copyModeData(mode: 'copy' | 'track', wallet: string, referrerId?: string | null): string {
  const base = `copy_mode:${mode}:${getShortTokenKey(wallet)}`;
  const withRef = referrerId ? `${base}:${getShortTokenKey(referrerId)}` : base;
  return Buffer.byteLength(withRef) <= TELEGRAM_CALLBACK_LIMIT ? withRef : base;
}

/** /start parameter for sharing a copy target: cp_ + its id without dashes (35 chars) */
export function copyShareParam(targetId: string): string {
  return `cp_${targetId.replace(/-/g, '').toLowerCase()}`;
}

export type CopyShareRef =
  | { kind: 'target'; targetId: string }
  | { kind: 'wallet'; rawWallet: string; referrerId: string | null };

/**
 * Reads a copy-share /start parameter: `cp_<target id hex>` (current links), or the older
 * `copy_<wallet>` / `copy_<wallet>_<sharer uuid>` form. Returns null for anything else.
 */
export function parseCopyShareParam(payload: string): CopyShareRef | null {
  const byId = payload.match(/^cp_([0-9a-f]{32})$/i);
  if (byId) {
    const h = byId[1].toLowerCase();
    return { kind: 'target', targetId: `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}` };
  }
  if (!payload.startsWith('copy_')) return null;
  let rawWallet = payload.slice(5);
  let referrerId: string | null = null;
  const tail = rawWallet.match(/_([0-9a-f-]{36})$/i);
  if (tail && UUID.test(tail[1])) {
    referrerId = tail[1].toLowerCase();
    rawWallet = rawWallet.slice(0, -tail[0].length);
  }
  return rawWallet ? { kind: 'wallet', rawWallet, referrerId } : null;
}
