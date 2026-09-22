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

export function retryWithBackoff<T>(fn: () => Promise<T>, maxRetries: number = 3, baseDelay: number = 1000): Promise<T> {
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