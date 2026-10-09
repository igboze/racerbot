import { describe, it, expect } from 'vitest';
import { parseTokenUnits, formatTokenUnits, isValidNearAccountId } from '@racerbot/shared';

// Helper mirror for unit testing transfer argument parsing logic
function parseTransferArgs(parts: string[]): {
  destination?: string;
  amount?: number | 'all';
  token?: string;
} {
  if (parts.length === 0) return {};
  let destination: string | undefined;
  let amount: number | 'all' | undefined;
  let token: string | undefined;
  const remaining: string[] = [];

  for (const part of parts) {
    const lower = part.toLowerCase();
    if (amount === undefined && (lower === 'all' || (/^\d+(\.\d+)?$/.test(lower) && !isNaN(parseFloat(lower))))) {
      amount = lower === 'all' ? 'all' : parseFloat(lower);
    } else {
      remaining.push(part);
    }
  }

  if (remaining.length === 1) {
    destination = remaining[0];
  } else if (remaining.length >= 2) {
    const first = remaining[0];
    const second = remaining[1];
    if (second.includes('.tkn.near') || (!second.includes('.') && !second.startsWith('0x'))) {
      destination = first;
      token = second;
    } else if (first.includes('.tkn.near') || (!first.includes('.') && !first.startsWith('0x'))) {
      token = first;
      destination = second;
    } else {
      destination = first;
      token = second;
    }
  }

  return { destination, amount, token };
}

describe('Token Transfer Argument Parsing', () => {
  it('parses destination, amount, and token correctly in standard order', () => {
    const res = parseTransferArgs(['alice.near', '100', 'LONK']);
    expect(res.destination).toBe('alice.near');
    expect(res.amount).toBe(100);
    expect(res.token).toBe('LONK');
  });

  it('parses destination, amount, and full contract address', () => {
    const res = parseTransferArgs(['bob.near', '50.5', 'blackdragon.tkn.near']);
    expect(res.destination).toBe('bob.near');
    expect(res.amount).toBe(50.5);
    expect(res.token).toBe('blackdragon.tkn.near');
  });

  it('parses "all" amount keyword for token transfer', () => {
    const res = parseTransferArgs(['charlie.near', 'all', 'LONK']);
    expect(res.destination).toBe('charlie.near');
    expect(res.amount).toBe('all');
    expect(res.token).toBe('LONK');
  });

  it('handles token name appearing before amount', () => {
    const res = parseTransferArgs(['david.near', 'LONK', '250']);
    expect(res.destination).toBe('david.near');
    expect(res.amount).toBe(250);
    expect(res.token).toBe('LONK');
  });

  it('parses native NEAR withdrawal when token is omitted', () => {
    const res = parseTransferArgs(['recipient.near', '1.5']);
    expect(res.destination).toBe('recipient.near');
    expect(res.amount).toBe(1.5);
    expect(res.token).toBeUndefined();
  });

  it('parses native NEAR "all" withdrawal', () => {
    const res = parseTransferArgs(['recipient.near', 'all']);
    expect(res.destination).toBe('recipient.near');
    expect(res.amount).toBe('all');
    expect(res.token).toBeUndefined();
  });

  it('parses SUI destination address and amount', () => {
    const res = parseTransferArgs(['0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef', '3.5']);
    expect(res.destination).toBe('0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef');
    expect(res.amount).toBe(3.5);
    expect(res.token).toBeUndefined();
  });
});

describe('Token Unit Conversions', () => {
  it('converts 18 decimal amounts accurately', () => {
    const raw = parseTokenUnits('1.5', 18);
    expect(raw).toBe(1_500_000_000_000_000_000n);
    expect(formatTokenUnits(raw, 18)).toBe('1.5');
  });

  it('converts 24 decimal NEAR/wNEAR amounts accurately', () => {
    const raw = parseTokenUnits('0.05', 24);
    expect(raw).toBe(50_000_000_000_000_000_000_000n);
    expect(formatTokenUnits(raw, 24)).toBe('0.05');
  });

  it('converts 6 decimal USDC/SUI amounts accurately', () => {
    const raw = parseTokenUnits('100.25', 6);
    expect(raw).toBe(100_250_000n);
    expect(formatTokenUnits(raw, 6)).toBe('100.25');
  });

  it('handles whole integer amounts without decimals', () => {
    const raw = parseTokenUnits('1000', 18);
    expect(raw).toBe(1_000_000_000_000_000_000_000n);
    expect(formatTokenUnits(raw, 18)).toBe('1000');
  });

  it('truncates excess decimal places gracefully', () => {
    const raw = parseTokenUnits('1.123456789', 6);
    expect(raw).toBe(1_123_456n);
    expect(formatTokenUnits(raw, 6)).toBe('1.123456');
  });

  it('throws error on invalid number format', () => {
    expect(() => parseTokenUnits('abc', 18)).toThrow();
    expect(() => parseTokenUnits('-5', 18)).toThrow();
  });
});

describe('NEAR Account ID Validation', () => {
  it('validates standard named accounts', () => {
    expect(isValidNearAccountId('alice.near')).toBe(true);
    expect(isValidNearAccountId('sub.alice.near')).toBe(true);
    expect(isValidNearAccountId('user-1.near')).toBe(true);
    expect(isValidNearAccountId('blackdragon.tkn.near')).toBe(true);
  });

  it('validates 64-char implicit hex accounts', () => {
    const hex = 'a'.repeat(64);
    expect(isValidNearAccountId(hex)).toBe(true);
  });

  it('rejects invalid account IDs', () => {
    expect(isValidNearAccountId('')).toBe(false);
    expect(isValidNearAccountId('a')).toBe(false);
    expect(isValidNearAccountId('alice@near')).toBe(false);
    expect(isValidNearAccountId('alice near')).toBe(false);
    expect(isValidNearAccountId('a'.repeat(65))).toBe(false);
  });
});
