import { describe, expect, it } from 'vitest';
import { resolveTokenAddressFromKey } from '@racerbot/shared';
import { copyModeData, copyShareParam, parseCopyShareParam } from './copyLinks.js';

const IMPLICIT = 'f8bc60638f0a6e7036657a995927e7e3ccb3be8c302a89708b1b0002e155af41';
const LONG_NAMED = 'a-very-long-trader-name-that-goes-on.some-subaccount.racerbot.near';
const SOLANA = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const REFERRER = '5c1e2f3a-4b5c-4d6e-8f70-0123456789ab';

describe('copyModeData', () => {
  for (const [label, wallet] of [['implicit 64-hex NEAR', IMPLICIT], ['long named NEAR', LONG_NAMED], ['Solana', SOLANA], ['short named NEAR', 'trader.near']]) {
    it(`fits Telegram's 64-byte limit for a ${label} wallet, with a referrer`, () => {
      for (const mode of ['copy', 'track'] as const) {
        const data = copyModeData(mode, wallet, REFERRER);
        expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
        // The copy_mode handler's pattern, and both keys resolve back
        const m = data.match(/^copy_mode:(copy|track):([^:]+)(?::([^:]+))?$/);
        expect(m).not.toBeNull();
        expect(resolveTokenAddressFromKey(m![2])).toBe(wallet);
        expect(resolveTokenAddressFromKey(m![3])).toBe(REFERRER);
      }
    });
  }

  it('omits the referrer when there is none', () => {
    expect(copyModeData('copy', 'trader.near')).toBe('copy_mode:copy:trader.near');
  });
});

describe('copy share links', () => {
  it('fit a Telegram start parameter and round-trip the target id', () => {
    const param = copyShareParam(REFERRER);
    expect(param).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(parseCopyShareParam(param)).toEqual({ kind: 'target', targetId: REFERRER });
  });

  it('still read older copy_<wallet>_<sharer> links', () => {
    expect(parseCopyShareParam(`copy_trader_near_${REFERRER}`)).toEqual({ kind: 'wallet', rawWallet: 'trader_near', referrerId: REFERRER });
    expect(parseCopyShareParam('copy_trader_near')).toEqual({ kind: 'wallet', rawWallet: 'trader_near', referrerId: null });
    expect(parseCopyShareParam(`copy_${SOLANA}`)).toEqual({ kind: 'wallet', rawWallet: SOLANA, referrerId: null });
  });

  it('ignore other start parameters', () => {
    expect(parseCopyShareParam('t_2cd41592f0dd')).toBeNull();
    expect(parseCopyShareParam('cp_tooshort')).toBeNull();
    expect(parseCopyShareParam('copy_')).toBeNull();
  });
});
