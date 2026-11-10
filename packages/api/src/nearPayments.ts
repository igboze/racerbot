/**
 * Checks that a NEAR payment a browser wallet says it made really happened:
 * signed by one of the buyer's own accounts, sent to the expected account,
 * at least the expected amount, and successful on-chain. Used for viewing keys
 * and the creator entry fee, which used to accept any text as a "tx hash".
 */

export interface NearTxOutcome {
  transaction?: {
    signer_id?: string;
    receiver_id?: string;
    actions?: Array<string | Record<string, any>>;
  };
  status?: unknown;
}

export type FetchOutcome = (txHash: string, signerId: string) => Promise<NearTxOutcome | null>;

const NEAR_TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

/** NEAR sent by a transaction's Transfer actions, in yoctoNEAR */
export function transferredYocto(outcome: NearTxOutcome): bigint {
  let total = 0n;
  for (const a of outcome.transaction?.actions ?? []) {
    if (a && typeof a === 'object' && a.Transfer && a.Transfer.deposit !== undefined) {
      try { total += BigInt(String(a.Transfer.deposit)); } catch { /* not a number: ignore */ }
    }
  }
  return total;
}

function succeeded(status: unknown): boolean {
  if (!status || typeof status !== 'object') return false;
  if ('Failure' in (status as any)) return false;
  return 'SuccessValue' in (status as any) || 'SuccessReceiptId' in (status as any);
}

export async function verifyNearPayment(
  p: { txHash: string; signerIds: string[]; receiverId: string; minYocto: bigint },
  fetchOutcome: FetchOutcome,
): Promise<{ ok: true; signerId: string; paidYocto: bigint } | { ok: false; reason: string }> {
  const txHash = String(p.txHash || '').trim();
  if (!NEAR_TX_HASH.test(txHash)) return { ok: false, reason: 'That is not a valid NEAR transaction.' };
  const signers = [...new Set(p.signerIds.map(s => String(s || '').trim().toLowerCase()).filter(Boolean))];
  if (signers.length === 0) return { ok: false, reason: 'Connect the NEAR wallet you paid from first.' };

  for (const signer of signers) {
    const outcome = await fetchOutcome(txHash, signer).catch(() => null);
    if (!outcome?.transaction) continue;
    if (String(outcome.transaction.signer_id || '').toLowerCase() !== signer) continue;
    if (String(outcome.transaction.receiver_id || '').toLowerCase() !== p.receiverId.toLowerCase()) {
      return { ok: false, reason: `That payment was not sent to ${p.receiverId}.` };
    }
    if (!succeeded(outcome.status)) return { ok: false, reason: 'That payment failed on-chain.' };
    const paid = transferredYocto(outcome);
    if (paid < p.minYocto) return { ok: false, reason: 'That payment is smaller than the price.' };
    return { ok: true, signerId: signer, paidYocto: paid };
  }
  return { ok: false, reason: 'No payment with that transaction was found from your wallet.' };
}

/** The real chain lookup, through the shared multi-RPC NEAR client */
export const fetchNearOutcome: FetchOutcome = async (txHash, signerId) => {
  const { getNear } = await import('@racerbot/shared');
  return (await getNear().waitForOutcome(txHash, signerId, 20_000).catch(() => null)) as NearTxOutcome | null;
};
