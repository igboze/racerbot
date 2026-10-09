import { randomBytes } from 'crypto';

export function generateId(): string {
  return randomBytes(16).toString('hex');
}

export function parseMemeCookingId(tokenAddress: string): number | null {
  if (!tokenAddress || typeof tokenAddress !== 'string' || !tokenAddress.endsWith('.meme-cooking.near')) {
    return null;
  }
  const match = tokenAddress.match(/-(\d+)\.meme-cooking\.near$/) || tokenAddress.match(/(\d+)\.meme-cooking\.near$/);
  if (match) {
    const id = parseInt(match[1], 10);
    return isNaN(id) ? null : id;
  }
  const clean = tokenAddress.replace('.meme-cooking.near', '');
  const id = parseInt(clean, 10);
  return isNaN(id) ? null : id;
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

export function calculateMinOutAdj(minAmountOut: string | bigint, amountIn: string | bigint): string {
  const amountInBigInt = BigInt(amountIn);
  const feeAmount = (amountInBigInt * 150n) / 10000n;
  const swapAmount = amountInBigInt - feeAmount;
  const scaled = (BigInt(minAmountOut) * swapAmount) / amountInBigInt;
  return scaled > 0n ? scaled.toString() : (typeof minAmountOut === 'string' ? minAmountOut : minAmountOut.toString());
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

/**
 * Format hold duration from milliseconds or start/end dates into human readable '4h 12m', '2d 5h', etc.
 */
export function formatHoldDuration(start: Date | string | number, end: Date | string | number = Date.now()): string {
  const startTime = typeof start === 'number' ? start : new Date(start).getTime();
  const endTime = typeof end === 'number' ? end : new Date(end).getTime();
  const diffMs = Math.max(0, endTime - startTime);
  const totalMinutes = Math.floor(diffMs / 60000);

  if (totalMinutes < 1) return '< 1m';
  if (totalMinutes < 60) return `${totalMinutes}m`;

  const hours = Math.floor(totalMinutes / 60);
  const remainingMinutes = totalMinutes % 60;

  if (hours < 24) {
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;

  if (days < 7) {
    return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
  }

  const weeks = Math.floor(days / 7);
  const remainingDays = days % 7;

  return remainingDays > 0 ? `${weeks}w ${remainingDays}d` : `${weeks}w`;
}

// ── NEAR/USD price with multi-source failover ───────────────────────────────
let nearUsdPrice = 0;
let nearUsdLastFetch = 0;

const NEAR_USD_SOURCES: Array<{ name: string; fetch: () => Promise<number> }> = [
  {
    name: 'coinbase',
    fetch: async () => {
      const res = await fetch('https://api.coinbase.com/v2/prices/NEAR-USD/spot', {
        signal: AbortSignal.timeout(2500),
      });
      if (!res.ok) throw new Error(`coinbase http ${res.status}`);
      const data: any = await res.json();
      const p = parseFloat(data?.data?.amount);
      if (!(p > 0)) throw new Error('coinbase bad price');
      return p;
    },
  },
  {
    name: 'coingecko',
    fetch: async () => {
      const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=near&vs_currencies=usd', {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(2500),
      });
      if (!res.ok) throw new Error(`coingecko http ${res.status}`);
      const data: any = await res.json();
      const p = data?.near?.usd;
      if (!(p > 0)) throw new Error('coingecko bad price');
      return p;
    },
  },
  {
    name: 'binance',
    fetch: async () => {
      const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=NEARUSDT', {
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) throw new Error(`binance http ${res.status}`);
      const data: any = await res.json();
      const p = parseFloat(data?.price);
      if (!(p > 0)) throw new Error('binance bad price');
      return p;
    },
  },
  {
    name: 'dexscreener',
    fetch: async () => {
      const res = await fetch('https://api.dexscreener.com/latest/dex/tokens/wrap.near', {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(2500),
      });
      if (!res.ok) throw new Error(`dexscreener http ${res.status}`);
      const data: any = await res.json();
      const topPair = data.pairs?.find((p: any) => p.quoteToken?.symbol === 'USDC' || p.quoteToken?.symbol === 'USDt');
      const p = parseFloat(topPair?.priceUsd);
      if (!(p > 0)) throw new Error('dexscreener bad price');
      return p;
    },
  },
];

async function fetchNearUsdPrice(): Promise<number> {
  for (const src of NEAR_USD_SOURCES) {
    try {
      return await src.fetch();
    } catch {
      // try next source
    }
  }
  return 0;
}

export async function getNearUsdPrice(): Promise<number> {
  const now = Date.now();
  if (nearUsdPrice > 0) {
    if (now - nearUsdLastFetch >= 15_000) {
      fetchNearUsdPrice()
        .then((p) => {
          if (p > 0) {
            nearUsdPrice = p;
            nearUsdLastFetch = Date.now();
          }
        })
        .catch(() => {});
    }
    return nearUsdPrice;
  }

  const p = await fetchNearUsdPrice();
  if (p > 0) {
    nearUsdPrice = p;
    nearUsdLastFetch = now;
  }
  return nearUsdPrice || 5.16;
}

// ── NEAR account id validator ────────────────────────────────────────────────
const NEAR_NAMED_ACCOUNT_RE = /^(([a-z0-9]+[-_])*[a-z0-9]+\.)*([a-z0-9]+[-_])*[a-z0-9]+$/;
export function isValidNearAccountId(id: string): boolean {
  if (!id || id.length < 2 || id.length > 64) return false;
  if (/^[0-9a-f]{64}$/.test(id)) return true;
  return NEAR_NAMED_ACCOUNT_RE.test(id);
}

// ── Token unit conversions (arbitrary decimals without float drift) ──────────
export function parseTokenUnits(amountStr: string, decimals: number): bigint {
  const trimmed = amountStr.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid amount format: "${amountStr}". Please provide a valid positive number.`);
  }
  const [whole, frac = ''] = trimmed.split('.');
  const truncatedFrac = frac.slice(0, decimals).padEnd(decimals, '0');
  return BigInt(whole) * (10n ** BigInt(decimals)) + BigInt(truncatedFrac);
}

export function formatTokenUnits(amountRaw: bigint, decimals: number, maxDecimals = 6): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = amountRaw / divisor;
  const rem = amountRaw % divisor;
  if (rem === 0n) return whole.toString();
  const fracStr = rem.toString().padStart(decimals, '0');
  const trimmedFrac = fracStr.slice(0, maxDecimals).replace(/0+$/, '');
  return trimmedFrac ? `${whole}.${trimmedFrac}` : whole.toString();
}