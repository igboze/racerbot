import { randomBytes } from 'crypto';

export function generateId(): string {
  return randomBytes(16).toString('hex');
}

export function formatNearAmount(amount: string, decimals: number = 24): string {
  const val = BigInt(Math.floor(parseFloat(amount) * 10 ** decimals));
  return val.toString();
}

export function parseNearAmount(amount: string, decimals: number = 24): number {
  return parseInt(amount) / 10 ** decimals;
}

export function calculatePercentage(value: number, percent: number): number {
  return (value * percent) / 100;
}

export function weightedAverage(oldValue: number, oldQty: number, newValue: number, newQty: number): number {
  const totalQty = oldQty + newQty;
  if (totalQty === 0) return newValue;
  return (oldValue * oldQty + newValue * newQty) / totalQty;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function retryWithBackoff<T>(fn: () => Promise<T>, maxRetries = 3, baseDelay = 1000): Promise<T> {
  let lastError: Error | null = null;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;
      const delay = baseDelay * Math.pow(2, i);
      await sleep(delay + Math.random() * delay * 0.1);
    }
  }
  throw lastError;
}

export function fuzzyMatch(input: string, candidates: string[]): { match: string | null; score: number } {
  const query = input.toLowerCase().trim();
  if (!query) return { match: null, score: 0 };

  let bestMatch: string | null = null;
  let bestScore = 0;

  for (const candidate of candidates) {
    const candLower = candidate.toLowerCase();
    if (candLower === query) return { match: candidate, score: 1.0 };

    let score = 0;
    let queryIdx = 0;
    for (let i = 0; i < candLower.length && queryIdx < query.length; i++) {
      if (candLower[i] === query[queryIdx]) {
        queryIdx++;
        score += 1;
      }
    }
    if (queryIdx === query.length) {
      score /= candLower.length;
      if (score > bestScore) {
        bestScore = score;
        bestMatch = candidate;
      }
    }
  }

  return { match: bestMatch, score: bestScore };
}

export function computeMarketCap(price: number, supply: number): number {
  return price * supply;
}

export function computePnL(
  entryPrice: number,
  exitPrice: number,
  quantity: number,
  buyFee: number,
  sellFee: number
): { pnlNear: number; pnlPercent: number; netNear: number } {
  const grossPnl = (exitPrice - entryPrice) * quantity;
  const totalFees = entryPrice * quantity * buyFee + exitPrice * quantity * sellFee;
  const netPnl = grossPnl - totalFees;
  const pnlPercent = entryPrice !== 0 ? (netPnl / (entryPrice * quantity)) * 100 : 0;
  return { pnlNear: grossPnl, pnlPercent, netNear: netPnl };
}

/**
 * Compute minimum output with slippage tolerance.
 * Formula: min_amount_out = expected_output * (1 - slippage_pct / 100)
 *
 * @param expectedOutput Raw atomic token amount (string or bigint)
 * @param slippagePct Slippage tolerance percentage (e.g. 2 for 2%, 5 for 5%)
 * @returns Minimum output as string in raw atomic units
 */
export function calculateMinAmountOut(expectedOutput: string | bigint, slippagePct: number = 2): string {
  const expected = typeof expectedOutput === 'bigint' ? expectedOutput : BigInt(expectedOutput);
  if (expected <= 0n) {
    throw new Error('expected_output must be greater than zero');
  }
  const pct = Math.max(0.01, Math.min(100, slippagePct));
  const bps = BigInt(Math.floor(pct * 100));
  const remainingBps = 10000n - bps;
  const minOut = (expected * remainingBps) / 10000n;
  return (minOut > 0n ? minOut : 1n).toString();
}

/**
 * Calculate expected output from CPMM pool reserves:
 * (amountInWithFee * reserveOut) / (reserveIn * 10000n + amountInWithFee)
 * with a default 0.3% pool fee (30 bps).
 */
export function calculateExpectedOutput(
  amountIn: string | bigint,
  reserveIn: string | bigint,
  reserveOut: string | bigint,
  poolFeeBps: number = 30
): bigint {
  const inVal = typeof amountIn === 'bigint' ? amountIn : BigInt(amountIn);
  const rIn = typeof reserveIn === 'bigint' ? reserveIn : BigInt(reserveIn);
  const rOut = typeof reserveOut === 'bigint' ? reserveOut : BigInt(reserveOut);

  if (rIn <= 0n || rOut <= 0n || inVal <= 0n) {
    throw new Error('Reserves and amountIn must be positive');
  }

  const feeMultiplier = BigInt(10000 - poolFeeBps);
  const amountInWithFee = inVal * feeMultiplier;
  const numerator = amountInWithFee * rOut;
  const denominator = rIn * 10000n + amountInWithFee;
  return numerator / denominator;
}

const ADJECTIVES = [
  'swift', 'rapid', 'bold', 'brave', 'cyber', 'neon', 'hyper', 'sonic',
  'turbo', 'blaze', 'alpha', 'apex', 'vivid', 'prime', 'stellar', 'cosmic',
  'shadow', 'ghost', 'silent', 'solar', 'lunar', 'frost', 'wild', 'quick'
];

const NOUNS = [
  'racer', 'runner', 'falcon', 'tiger', 'lynx', 'comet', 'pilot', 'rider',
  'phoenix', 'viper', 'hawk', 'storm', 'drift', 'spark', 'stride', 'surge',
  'rocket', 'dash', 'nexus', 'pulse', 'orbit', 'flux', 'echo', 'rover'
];

/**
 * Generates an on-brand, human-readable random NEAR account prefix (e.g. 'swift-falcon-4821').
 * Protects user privacy by ensuring Telegram IDs are never exposed on-chain.
 */
export function generateRandomAccountPrefix(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const num = Math.floor(1000 + Math.random() * 9000);
  return `${adj}-${noun}-${num}`;
}