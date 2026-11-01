import { describe, it, expect } from 'vitest';
import { evmLookupFailureMessage } from './routes.js';
import { EvmTokenLookupError } from './wallet.js';

const ADDR = '0x65e4d3FECa39b2B11Db522adF6530bcccF9D77DC';

describe('HyperEVM / Elysium not-found replies', () => {
  it('an unused address says nothing is deployed, and does not suggest retrying', () => {
    const msg = evmLookupFailureMessage(ADDR, new EvmTokenLookupError('empty', ADDR));
    expect(msg).toContain('No token at this address');
    expect(msg).toContain('HyperEVM or Elysium');
    expect(msg).not.toMatch(/try again/i);
  });

  it('a wallet is called a wallet', () => {
    expect(evmLookupFailureMessage(ADDR, new EvmTokenLookupError('wallet', ADDR))).toContain('This is a wallet, not a token');
  });

  it('an Elysium contract says so', () => {
    expect(evmLookupFailureMessage(ADDR, new EvmTokenLookupError('elysium', ADDR))).toContain('on Elysium, not HyperEVM');
  });

  it('only a failed lookup (or a timeout) suggests trying again', () => {
    expect(evmLookupFailureMessage(ADDR, new EvmTokenLookupError('rpc', ADDR))).toMatch(/try again/i);
    expect(evmLookupFailureMessage(ADDR, new Error('The token lookup timed out'))).toMatch(/try again/i);
  });
});
