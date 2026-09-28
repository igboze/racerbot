/**
 * Pure swap-outcome determination — no RPC, no DB, no side effects.
 *
 * Why this exists: the old executor parsed receipt logs and, when nothing was
 * found, fell back to `min_amount_out` — recording a FILL for tokens the user
 * never received. A refunded/failed swap was reported as success.
 *
 * New rules:
 *  - The user's balance DELTA of the output token (read before signing and
 *    after confirmation) is the authoritative received amount.
 *  - Parsed receipt logs are used only when the balance reads are unavailable.
 *  - A zero increase is a FAILURE — no fill, no position row.
 *  - Any receipt with a Failure status fails the trade with a specific reason.
 */

export interface SwapOutcomeInput {
  /** FinalExecutionOutcome-shaped result from signAndSendTransactionAll. */
  result: any;
  /** Account that should receive the output. */
  subaccountId: string;
  /** true = buy (output is token_out), false = sell (output is wrap.near). */
  isBuy: boolean;
  tokenOut: string;
  /** Output-token balance read before signing, as a decimal string. null when unavailable. */
  preBalance: string | null;
  /** Output-token balance read after confirmation, as a decimal string. null when unavailable. */
  postBalance: string | null;
}

export interface SwapOutcome {
  ok: boolean;
  /** Actual received amount in yocto (decimal string) when ok. */
  netAmountOut?: string;
  /** Human-readable failure reason when not ok. */
  reason?: string;
  /** Raw failure detail for logs. */
  detail?: string;
}

/** Extract a distilled failure reason from an on-chain Failure payload. */
export function distillFailureReason(failure: any): string {
  const errStr = JSON.stringify(failure ?? {}).toLowerCase();
  const raw = JSON.stringify(failure ?? {});
  if (errStr.includes('slippage') || errStr.includes('min_amount') || errStr.includes('less than minimum')) {
    return 'Slippage too high — price moved against you. Increase slippage in Settings and retry.';
  }
  if (errStr.includes('insufficient') && errStr.includes('balanc')) {
    return 'Insufficient wNEAR balance for this swap. Please retry.';
  }
  if (errStr.includes('no pool') || errStr.includes('pool_not_found')) {
    return 'No liquidity pool found on-chain for this token.';
  }
  if (errStr.includes('panic') || errStr.includes('executionerror')) {
    const panicMatch = raw.match(/"ExecutionError":"([^"]+)"/);
    if (panicMatch) return `Contract error: ${panicMatch[1].slice(0, 150)}`;
  }
  return 'Transaction failed or slippage breach';
}

/** Sum ft_transfer "amount" events received by the account from EVENT_JSON logs. */
function parseLogAmounts(result: any, subaccountId: string): string[] {
  const amounts: string[] = [];
  const receiptsOutcomes = result?.receipts_outcome || [];
  for (const r of receiptsOutcomes) {
    const logs: string[] = r?.outcome?.logs || [];
    for (const log of logs) {
      if (!log.startsWith('EVENT_JSON:')) continue;
      try {
        const parsed = JSON.parse(log.slice('EVENT_JSON:'.length));
        if (parsed.event === 'ft_transfer') {
          const dataList = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
          for (const d of dataList) {
            if ((d?.receiver_id === subaccountId || d?.new_owner_id === subaccountId) && d?.amount) {
              amounts.push(String(d.amount));
            }
          }
        } else if (parsed.event === 'swap') {
          const dataList = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
          for (const d of dataList) {
            if (d?.amount_out) amounts.push(String(d.amount_out));
          }
        }
      } catch { /* no-op */ }
      const refSwapMatch = log.match(/Swapped\s+\d+\s+\S+\s+for\s+(\d+)\s+(\S+)/i);
      if (refSwapMatch) amounts.push(refSwapMatch[1]);
      const shardsMatch = log.match(/bought (\d+) tokens/i) || log.match(/amount_out:?\s*(\d+)/i);
      if (shardsMatch) amounts.push(shardsMatch[1]);
    }
  }
  return amounts;
}

/**
 * Determine the real outcome of a swap.
 * Never fabricates an output amount: no min_amount_out fallback, ever.
 */
export function determineSwapOutcome(input: SwapOutcomeInput): SwapOutcome {
  const { result, subaccountId, isBuy, tokenOut, preBalance, postBalance } = input;
  const receiptsOutcomes = result?.receipts_outcome || [];

  // 1. Any receipt with an explicit Failure status → fail with a reason.
  for (const r of receiptsOutcomes) {
    const status = r?.outcome?.status;
    if (status && typeof status === 'object' && 'Failure' in status) {
      return {
        ok: false,
        reason: distillFailureReason(status.Failure),
        detail: JSON.stringify(status.Failure).slice(0, 300),
      };
    }
  }
  const txFailure = result?.status?.Failure ?? result?.transaction_outcome?.outcome?.status?.Failure;
  if (txFailure) {
    return { ok: false, reason: distillFailureReason(txFailure), detail: JSON.stringify(txFailure).slice(0, 300) };
  }

  // 2. Balance delta is authoritative when both reads succeeded.
  if (preBalance !== null && postBalance !== null) {
    const delta = BigInt(postBalance) - BigInt(preBalance);
    if (delta <= 0n) {
      return {
        ok: false,
        reason: `Swap produced no ${isBuy ? 'tokens' : 'wNEAR'} — the DEX refunded your input (price moved or insufficient liquidity). No fill was recorded. Check your wallet balance, then retry.`,
        detail: `pre=${preBalance} post=${postBalance}`,
      };
    }
    return { ok: true, netAmountOut: delta.toString() };
  }

  // 3. Fall back to parsed logs only when balance reads are unavailable.
  const amounts = parseLogAmounts(result, subaccountId);
  if (amounts.length > 0) {
    // Last transfer to the user in the receipt tree is the final output.
    return { ok: true, netAmountOut: amounts[amounts.length - 1] };
  }

  // 4. Nothing verifiable → fail closed. Never invent an amount.
  return {
    ok: false,
    reason: `Could not verify the swap output for ${tokenOut} — no balance change or transfer log was found. The trade may have been refunded. Check your wallet or NearBlocks before retrying.`,
  };
}
