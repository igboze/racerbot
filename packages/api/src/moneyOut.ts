/**
 * Money out: every way funds leave a user's wallet goes through runMoneyOut.
 *
 * With SIGNER_URL set, the API does not sign withdrawals itself: it forwards the request
 * to the signer service (signer/server.ts, its own Railway service on the private network),
 * which loads the user from the database, applies its rules, signs, records an audit row and
 * alerts the owner. Without SIGNER_URL it runs here, as before, and still alerts.
 *
 * Requests to the signer are authenticated with an HMAC over a timestamp and the body
 * (SIGNER_SHARED_SECRET), so only the API can ask and a captured request cannot be replayed.
 */
import crypto from 'crypto';
import type { UserRecord } from '@racerbot/db';
import { sendSecurityAlert, type SecurityEvent } from './securityAlerts.js';

export type MoneyOutOp =
  | 'near' | 'near_token' | 'solana' | 'solana_token' | 'sui' | 'starknet'
  | 'evm_hype' | 'evm_token' | 'private' | 'near_payment';

export const MONEY_OUT_OPS: readonly MoneyOutOp[] = [
  'near', 'near_token', 'solana', 'solana_token', 'sui', 'starknet', 'evm_hype', 'evm_token', 'private', 'near_payment',
];

/** JSON with bigints as strings: plans and amounts cross the wire */
export const toWire = (value: unknown): string =>
  JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

export const signBody = (secret: string, timestamp: string, body: string): string =>
  crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

/** True in the API when withdrawals must go to the signer service (never inside the signer itself) */
export function signerEnabled(): boolean {
  return Boolean(process.env.SIGNER_URL) && process.env.RACERBOT_SIGNER !== 'true';
}

/** Forwards a money-out request to the signer service; throws its error message on refusal */
export async function forwardToSigner(op: MoneyOutOp, userId: string, args: unknown[]): Promise<any> {
  const url = (process.env.SIGNER_URL || '').replace(/\/+$/, '');
  const secret = process.env.SIGNER_SHARED_SECRET || '';
  if (!secret) throw new Error('Withdrawals are temporarily unavailable (signer not configured).');
  const body = toWire({ op, userId, args });
  const timestamp = String(Date.now());
  const res = await fetch(`${url}/v1/money-out`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-signer-timestamp': timestamp,
      'x-signer-signature': signBody(secret, timestamp, body),
    },
    body,
    // Withdrawals can wait on chain confirmation (Elysium inbox, Starknet)
    signal: AbortSignal.timeout(180_000),
  }).catch((err: any) => {
    const cause = err?.cause?.code || err?.cause?.message || '';
    throw new Error(`Withdrawals are temporarily unavailable: ${err?.message || 'signer unreachable'}${cause ? ` (${cause})` : ''} reaching ${url}`);
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || data?.ok === false) throw new Error(data?.error || `Withdrawal refused (${res.status})`);
  return data.result;
}

interface Outcome<T> {
  result: T;
  event: SecurityEvent | null;
}

const explorer = (chain: string, hash: string): string | undefined => ({
  near: `https://nearblocks.io/txns/${hash}`,
  sui: `https://suiscan.xyz/mainnet/tx/${hash}`,
  starknet: `https://voyager.online/tx/${hash}`,
  solana: `https://solscan.io/tx/${hash}`,
} as Record<string, string>)[chain];

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Runs one money-out operation with the current process's keys and alerts the owner.
 * Used by the API when there is no signer, and by the signer itself.
 */
export async function executeMoneyOut(op: MoneyOutOp, user: UserRecord, args: any[]): Promise<any> {
  const wallet = await import('./wallet.js');
  let outcome: Outcome<any>;
  switch (op) {
    case 'near': {
      const r = await wallet.withdrawFundsImpl(user, args[0], args[1]);
      outcome = { result: r, event: { kind: 'withdrawal', chain: 'NEAR', asset: 'NEAR', amount: r.amountWithdrawn, to: r.destination, txHash: r.txHash, explorerUrl: explorer('near', r.txHash) } };
      break;
    }
    case 'near_token': {
      const r = await wallet.withdrawTokenFundsImpl(Number(user.telegram_id), args[0], args[1], args[2]);
      outcome = { result: r, event: { kind: 'withdrawal', chain: capitalize(r.chain), asset: r.symbol, amount: r.amountWithdrawn, to: r.destination, txHash: r.txHash, explorerUrl: explorer(r.chain, r.txHash) } };
      break;
    }
    case 'solana': {
      const r = await wallet.withdrawSolanaFundsImpl(Number(user.telegram_id), args[0], args[1]);
      outcome = { result: r, event: { kind: 'withdrawal', chain: 'Solana', asset: 'SOL', amount: r.amountWithdrawn, to: r.destination, txHash: r.txHash, explorerUrl: explorer('solana', r.txHash) } };
      break;
    }
    case 'solana_token': {
      const r = await wallet.withdrawSolanaTokenFundsImpl(Number(user.telegram_id), args[0], args[1], args[2]);
      outcome = { result: r, event: { kind: 'withdrawal', chain: 'Solana', asset: r.symbol, amount: r.amountWithdrawn, to: r.destination, txHash: r.txHash, explorerUrl: explorer('solana', r.txHash) } };
      break;
    }
    case 'sui': {
      const r = await wallet.withdrawSuiFundsImpl(Number(user.telegram_id), args[0], args[1]);
      outcome = { result: r, event: { kind: 'withdrawal', chain: 'Sui', asset: 'SUI', amount: r.amountWithdrawn, to: r.destination, txHash: r.txHash, explorerUrl: explorer('sui', r.txHash) } };
      break;
    }
    case 'starknet': {
      const r = await wallet.withdrawStarknetFundsImpl(Number(user.telegram_id), args[0], args[1], args[2]);
      outcome = { result: r, event: { kind: 'withdrawal', chain: 'Starknet', asset: r.symbol, amount: r.amountWithdrawn, to: r.destination, txHash: r.txHash, explorerUrl: explorer('starknet', r.txHash) } };
      break;
    }
    case 'evm_hype': {
      const r = await wallet.withdrawEvmHypeImpl(user, args[0], args[1], args[2]);
      outcome = {
        result: r,
        event: r.success
          ? { kind: 'withdrawal', chain: args[0] === 'elysium' ? 'Elysium' : 'HyperEVM', asset: 'HYPE', amount: r.amountHype || '?', to: args[1], txHash: r.elysiumTxHash || r.txHash }
          : null,
      };
      break;
    }
    case 'evm_token': {
      const { sendEvmTokenImpl } = await import('./evmWallet.js');
      const plan = { ...args[0], amountRaw: BigInt(args[0].amountRaw) };
      const r = await sendEvmTokenImpl(user, plan);
      outcome = { result: r, event: { kind: 'withdrawal', chain: plan.chain === 'elysium' ? 'Elysium' : 'HyperEVM', asset: plan.symbol, amount: plan.amountDisplay, to: plan.to, txHash: r.elysiumTxHash || r.txHash } };
      break;
    }
    case 'private': {
      const { withdrawPrivateImpl } = await import('./executorPool.js');
      const { getConfidentialAccount } = await import('@racerbot/db');
      const amount = BigInt(args[0]);
      const r = await withdrawPrivateImpl(user, amount, args[1] || undefined, args[2] || undefined);
      const payout = args[1] ? null : (await getConfidentialAccount(user.id).catch(() => null))?.payout_address;
      outcome = {
        result: r,
        event: {
          kind: 'withdrawal',
          chain: args[2] ? 'NEAR Intents (cross-chain)' : 'NEAR (private balance)',
          asset: args[2] ? 'NEAR → ' + String(args[2]).split(':').pop() : 'NEAR',
          amount: (Number(amount / 10n ** 18n) / 1e6).toFixed(4),
          to: args[1] || payout || 'your payout address',
          txHash: r.intentHash,
        },
      };
      break;
    }
    case 'near_payment': {
      // Fees, Viewing Keys and profit shares: only to RacerBot or a registered Alpha creator
      if (!(await isAllowedPaymentDestination(String(args[0])))) {
        throw new Error('Payments can only go to RacerBot or a registered Racer Alpha creator.');
      }
      const r = await wallet.transferNearFromUserImpl(user.id, args[0], args[1]);
      // A purchase the user made on purpose: the purchase message is enough, no security alert
      outcome = { result: r, event: null };
      break;
    }
    default:
      throw new Error(`Unknown withdrawal type: ${op}`);
  }
  if (outcome.event) void sendSecurityAlert({ userId: user.id, telegramId: user.telegram_id }, outcome.event);
  return outcome.result;
}

/** RacerBot's own accounts and the payout accounts of registered Racer Alpha creators */
export async function isAllowedPaymentDestination(destination: string): Promise<boolean> {
  const dest = destination.trim().toLowerCase();
  const platform = [process.env.TREASURY_ACCOUNT_ID || 'racerbottreasury.near', process.env.RACERBOT_PARENT_ACCOUNT || 'racerbot.near']
    .map(a => a.toLowerCase());
  if (platform.includes(dest)) return true;
  const { getDb } = await import('@racerbot/db');
  const db = await getDb();
  const res = await db.query(
    `SELECT 1 FROM racer_alpha_traders t
     LEFT JOIN users u ON u.id::text = t.user_id OR u.subaccount_id = t.user_id
     WHERE LOWER(t.payout_wallet_address) = $1::text OR LOWER(u.subaccount_id) = $1::text
     LIMIT 1`,
    [dest]
  );
  return res.rows.length > 0;
}

/** Where the exported withdraw functions send their work: the signer when configured, else here */
export async function runMoneyOut(op: MoneyOutOp, user: UserRecord, args: any[]): Promise<any> {
  if (signerEnabled()) return forwardToSigner(op, user.id, args);
  return executeMoneyOut(op, user, args);
}
