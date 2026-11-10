/**
 * NEAR RaceFleet "fire together".
 *
 * Every fleet wallet's transaction is built and signed FIRST (one shared block
 * hash, each wallet's own nonce), then all of them are broadcast at the same
 * instant with broadcast_tx_async and confirmed together. The swaps land in
 * the same or the next block instead of one wallet after another.
 *
 * Nothing here retries a whole step on another RPC after a broadcast, so a
 * slow RPC can never cause a wallet to swap twice.
 */
import { KeyPair, keyStores, InMemorySigner, transactions, utils } from 'near-api-js';
import { getNearWriteRpcUrls } from './wallet.js';

export interface NearFleetTx {
  accountId: string;
  keyPair: KeyPair;
  receiverId: string;
  actions: transactions.Action[];
}

export interface NearFleetTxResult {
  accountId: string;
  hash: string | null;
  ok: boolean;
  /** Decoded SuccessValue of the transaction (e.g. the amount used by ft_transfer_call). */
  returnValue: string | null;
  error: string | null;
}

async function rpc<T = any>(url: string, method: string, params: any, timeoutMs = 8000): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'fleet', method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j: any = await res.json();
  if (j?.error) {
    const e: any = new Error(j.error?.data?.message || j.error?.cause?.name || j.error?.message || JSON.stringify(j.error));
    e.rpc = j.error;
    throw e;
  }
  return j.result as T;
}

/** First successful answer across all endpoints. */
async function hedged<T = any>(method: string, params: any, timeoutMs = 6000): Promise<T> {
  const urls = getNearWriteRpcUrls();
  return Promise.any(urls.map((u) => rpc<T>(u, method, params, timeoutMs)));
}

async function nextNonce(accountId: string, publicKey: string): Promise<bigint> {
  // Highest nonce any endpoint reports (a lagging node must not cause a reused nonce).
  const urls = getNearWriteRpcUrls();
  const answers = await Promise.allSettled(urls.map((u) =>
    rpc<any>(u, 'query', { request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKey }, 6000),
  ));
  let best = -1n;
  for (const a of answers) if (a.status === 'fulfilled' && a.value?.nonce !== undefined) {
    const n = BigInt(a.value.nonce);
    if (n > best) best = n;
  }
  if (best < 0n) throw new Error(`Access key for ${accountId} not found`);
  return best + 1n;
}

function decodeSuccess(status: any): string | null {
  if (!status || typeof status !== 'object' || !('SuccessValue' in status)) return null;
  try {
    return Buffer.from(String(status.SuccessValue || ''), 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function describeFailure(status: any): string {
  const f = status?.Failure;
  const s = JSON.stringify(f ?? status ?? 'failed');
  if (/NotEnoughBalance|LackBalanceForState/i.test(s)) return 'Not enough NEAR in this wallet for the swap and gas.';
  if (/E68|slippage|min_amount_out|less than minimum/i.test(s)) return 'Price moved past the slippage limit.';
  return `Transaction failed: ${s.slice(0, 140)}`;
}

/**
 * Signs every transaction, broadcasts them all at once, then waits for all
 * outcomes (up to `waitMs`). Results are returned in input order.
 */
export async function fireNearTxsTogether(txs: NearFleetTx[], waitMs = 60_000): Promise<NearFleetTxResult[]> {
  if (txs.length === 0) return [];
  const block = await hedged<any>('block', { finality: 'final' });
  const blockHash = utils.serialize.base_decode(block.header.hash);

  // 1. Sign everything first.
  const signed = await Promise.all(txs.map(async (t) => {
    try {
      const keyStore = new keyStores.InMemoryKeyStore();
      await keyStore.setKey('mainnet', t.accountId, t.keyPair);
      const signer = new InMemorySigner(keyStore);
      const nonce = await nextNonce(t.accountId, t.keyPair.getPublicKey().toString());
      const [hashBytes, signedTx] = await transactions.signTransaction(
        t.receiverId, nonce, t.actions, blockHash, signer, t.accountId, 'mainnet',
      );
      return {
        t,
        hash: utils.serialize.base_encode(hashBytes as Uint8Array),
        b64: Buffer.from(transactions.encodeTransaction(signedTx)).toString('base64'),
        error: null as string | null,
      };
    } catch (err: any) {
      return { t, hash: null as string | null, b64: null as string | null, error: err?.message || 'signing failed' };
    }
  }));

  // 2. Fire all of them at the same instant, to every endpoint.
  const urls = getNearWriteRpcUrls();
  const fire = (list: typeof signed) => Promise.all(list.filter((s) => s.b64).map((s) =>
    Promise.allSettled(urls.map((u) => rpc(u, 'broadcast_tx_async', [s.b64], 6000))),
  ));
  await fire(signed);

  // 3. Confirm together; re-broadcast the ones not seen yet.
  const results = new Map<string, NearFleetTxResult>();
  for (const s of signed) {
    if (!s.hash) results.set(s.t.accountId + s.t.receiverId, { accountId: s.t.accountId, hash: null, ok: false, returnValue: null, error: s.error });
  }
  const pending = () => signed.filter((s) => s.hash && !results.has(s.t.accountId + s.t.receiverId));
  const started = Date.now();
  let lastFire = Date.now();
  while (pending().length > 0 && Date.now() - started < waitMs) {
    await new Promise((r) => setTimeout(r, 1500));
    await Promise.all(pending().map(async (s) => {
      try {
        const out = await hedged<any>('tx', { tx_hash: s.hash, sender_account_id: s.t.accountId, wait_until: 'EXECUTED_OPTIMISTIC' }, 5000);
        const status = out?.status;
        if (status && typeof status === 'object' && ('SuccessValue' in status || 'Failure' in status)) {
          const ok = 'SuccessValue' in status;
          results.set(s.t.accountId + s.t.receiverId, {
            accountId: s.t.accountId, hash: s.hash, ok, returnValue: ok ? decodeSuccess(status) : null, error: ok ? null : describeFailure(status),
          });
        }
      } catch { /* not known yet */ }
    }));
    if (Date.now() - lastFire > 5000) {
      lastFire = Date.now();
      void fire(pending());
    }
  }
  return signed.map((s) => results.get(s.t.accountId + s.t.receiverId) ?? {
    accountId: s.t.accountId,
    hash: s.hash,
    ok: false,
    returnValue: null,
    error: 'Not confirmed in time. Check the wallet before retrying.',
  });
}

export const nearActions = {
  call(methodName: string, args: object, gasTgas: number, depositYocto: bigint): transactions.Action {
    return transactions.functionCall(methodName, Buffer.from(JSON.stringify(args)), BigInt(gasTgas) * 1_000_000_000_000n, depositYocto);
  },
  transfer(depositYocto: bigint): transactions.Action {
    return transactions.transfer(depositYocto);
  },
};
