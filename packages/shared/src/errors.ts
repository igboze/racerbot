/**
 * Machine-readable error codes for trade-path failures.
 * getUserFriendlyError maps on .code first; substring fallback exists only for
 * unstructured errors from near-api-js and contract panics.
 */
export type TradeErrorCode =
  | 'PRE_BROADCAST_TIMEOUT'    // deadline hit before any swap tx was broadcast
  | 'PRICE_MOVED'              // on-chain quote worse than minAmountOut
  | 'NOT_CONFIRMED'            // tx broadcast but not confirmed within deadline
  | 'STEP2_FAILED'             // two-tx path: hop1 ok, hop2 failed/timeout
  | 'LOCK_CONTENTION'          // another tx already in progress for this wallet
  | 'RPC_TIMEOUT'              // all NEAR RPC providers timed out for a view call
  | 'CONTRACT_ERROR'           // contract panic / ExecutionError returned by RPC
  | 'SLIPPAGE'                 // on-chain slippage exceeded
  | 'INSUFFICIENT_BALANCE'     // balance too low to execute trade
  | 'INVALID_TX';               // node rejected the signed tx before inclusion (key, nonce, balance, expiry)

export interface TradeErrorOptions {
  code: TradeErrorCode;
  /** Tells the user whether a one-time storage tx was sent before the failure. */
  storageTxSent?: boolean;
  /** The actual swap transaction hash, if broadcast before the error. */
  txHash?: string;
  /** For STEP2_FAILED: human-readable name of the quote asset the wallet now holds. */
  quoteAssetName?: string;
  /** For STEP2_FAILED: formatted amount of quote asset the wallet holds. */
  quoteAssetAmount?: string;
}

export class TradeError extends Error {
  readonly code: TradeErrorCode;
  readonly storageTxSent: boolean;
  readonly txHash: string | undefined;
  readonly quoteAssetName: string | undefined;
  readonly quoteAssetAmount: string | undefined;

  constructor(message: string, opts: TradeErrorOptions) {
    super(message);
    this.name = 'TradeError';
    this.code = opts.code;
    this.storageTxSent = opts.storageTxSent ?? false;
    this.txHash = opts.txHash;
    this.quoteAssetName = opts.quoteAssetName;
    this.quoteAssetAmount = opts.quoteAssetAmount;
  }
}

/**
 * Redact secrets and sensitive tokens from a string before logging or error display.
 * Removes:
 *   - ed25519: keypairs (base58 after the colon)
 *   - apiKey= / api_key= / token= query-string and header values
 *   - Bearer <token> and tma <initData> authorization headers
 *   - Database connection passwords (postgresql://user:pass@host:port/db)
 *   - Telegram bot tokens (123456789:ABCDefgh...)
 *   - JWT tokens (eyJ...)
 */
export function redactSecrets(s: string): string {
  if (!s) return '';
  return String(s)
    .replace(/ed25519:[a-zA-Z0-9]+/gi, 'ed25519:[REDACTED]')
    .replace(/(postgres(ql)?:\/\/[^:]+:)[^@\s]+(@)/gi, '$1[REDACTED]$3')
    .replace(/([0-9]{8,10}:)[a-zA-Z0-9_-]{35}/g, '$1[BOT_TOKEN_REDACTED]')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[JWT_REDACTED]')
    .replace(/((?:apiKey|api_key|secret|password|authToken|token|access_key)=)[^\s&"']+/gi, '$1[REDACTED]')
    .replace(/((?:Bearer|tma)\s+)[^\s"']+/gi, '$1[REDACTED]');
}
