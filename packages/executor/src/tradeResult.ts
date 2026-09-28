/**
 * Pure swap-outcome determination — no RPC, no DB, no side effects.
 *
 * Why this exists: the old executor parsed receipt logs and, when nothing was
 * found, fell back to `min_amount_out` — recording a FILL for tokens the user
 * never received. A refunded/failed swap was reported as success.
 *
 * Rules:
 *  - Any receipt with a Failure status fails the trade with a specific reason.
 *  - Output-token-filtered transfers in the CONFIRMED receipt tree are the
 *    primary success evidence — they are the chain's own record and cannot be
 *    skewed by RPC read lag. Refunded input tokens are excluded by the filter.
 *  - The user's balance DELTA of the output token is the fallback evidence
 *    (and catches transfers the log parser doesn't recognize). A zero/negative
 *    delta with no output transfer is a FAILURE — no fill, no position row.
 *  - Never fabricates an amount: no min_amount_out fallback, ever.
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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Sum output-denominated amounts the account actually received, extracted from
 * the CONFIRMED receipt tree. Output-filtered so a refunded swap can never be
 * miscounted as success:
 *  - ft_transfer EVENT_JSON: only counted when the emitting contract (the
 *    receipt's executor) IS the output token — a refunded INPUT token also
 *    arrives as an ft_transfer to the user and must be excluded.
 *  - Plain-text "Transfer N from <dex> to <user>" (wrap.near style): same
 *    executor filter.
 *  - DEX swap events ("swap" EVENT_JSON with amount_out, Ref-style
 *    "Swapped X <in> for Y <out>"): Y/amount_out is output-denominated by
 *    definition; these logs only exist when a swap actually happened.
 */
function parseOutputAmounts(result: any, subaccountId: string, outputToken: string): string[] {
  const amounts: string[] = [];
  const receiptsOutcomes = result?.receipts_outcome || [];
  for (const r of receiptsOutcomes) {
    const executorId = r?.outcome?.executor_id;
    const logs: string[] = r?.outcome?.logs || [];
    for (const log of logs) {
      if (log.startsWith('EVENT_JSON:')) {
        try {
          const parsed = JSON.parse(log.slice('EVENT_JSON:'.length));
          if (parsed.event === 'ft_transfer') {
            if (executorId !== outputToken) continue;
            const dataList = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
            for (const d of dataList) {
              if ((d?.receiver_id === subaccountId || d?.new_owner_id === subaccountId) && d?.amount) {
                amounts.push(String(d.amount));
              }
            }
          } else if (parsed.event === 'swap') {
            const dataList = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
            for (const d of dataList) {
              // When the event names the output token, it must match — in
              // multihop routes an intermediate hop's swap event would
              // otherwise be miscounted as the final output.
              if ((!d?.token_out || d.token_out === outputToken) && d?.amount_out) {
                amounts.push(String(d.amount_out));
              }
            }
          }
        } catch { /* no-op */ }
        continue;
      }
      // Plain-text NEP-141 transfer log emitted by the output token itself
      // (wrap.near style: "Transfer 123 from v2.ref-finance.near to alice.near").
      if (executorId === outputToken) {
        const m = log.match(new RegExp(`^Transfer (\\d+) from \\S+ to ${escapeRegExp(subaccountId)}$`));
        if (m) amounts.push(m[1]);
        // DCL sells pay out NATIVE NEAR: the DEX contract calls near_withdraw
        // on wrap.near, which logs "Withdraw N NEAR from dclv2.ref-labs.near"
        // and forwards native NEAR to the user. The user's wrap.near balance
        // delta is therefore 0 — without this, a successful DCL sell looks
        // like a refund. Only counted when output IS wrap.near (sells).
        const w = log.match(/^Withdraw (\d+) NEAR from \S+$/);
        if (w) amounts.push(w[1]);
      }
      // DEX-emitted swap logs — output-denominated by definition.
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

  // 2. Confirmed receipt-tree evidence: output-denominated transfers to the
  // user. This is the chain's own record — immune to RPC read lag, and the
  // output-token filter means a refunded input can never be miscounted.
  // Preferred over the balance delta: a lagging post-trade balance read can
  // report the pre-swap state and make a successful swap look like a refund.
  const logAmounts = parseOutputAmounts(result, subaccountId, isBuy ? tokenOut : 'wrap.near');
  if (logAmounts.length > 0) {
    // Last output-denominated receipt in the tree is the final amount the
    // user received (e.g. after token-contract tax deductions).
    return { ok: true, netAmountOut: logAmounts[logAmounts.length - 1] };
  }

  // 3. Balance delta is the fallback evidence when the logs carry nothing
  // recognizable.
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

  // 4. Nothing verifiable → fail closed. Never invent an amount.
  return {
    ok: false,
    reason: `Could not verify the swap output for ${tokenOut} — no balance change or transfer log was found. The trade may have been refunded. Check your wallet or NearBlocks before retrying.`,
  };
}
