import { describe, expect, it } from 'vitest';
import { resolveTokenAddressFromKey } from '@racerbot/shared';
import { copyModeData, copyShareParam, parseCopyShareParam, shortenTrackerAlertMarkup } from './copyLinks.js';

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

describe('shortenTrackerAlertMarkup', () => {
  it('keeps tracker buttons within Telegram limits and preserves the address mapping', () => {
    const token = 'a'.repeat(64);
    const markup = shortenTrackerAlertMarkup({
      inline_keyboard: [[
        { text: 'Buy', callback_data: `buy_fixed:${token}:0.5` },
        { text: 'View', callback_data: `token_refresh:${token}` },
      ]],
    }, token);
    const callbacks = markup.inline_keyboard[0].map((button) => button.callback_data!);
    expect(callbacks.every((callback) => Buffer.byteLength(callback) <= 64)).toBe(true);
    expect(callbacks[0]).toMatch(/^buy_fixed:t_[0-9a-f]{8}[a-z]{4}:0\.5$/);
    expect(callbacks[1]).toMatch(/^token_refresh:t_[0-9a-f]{8}[a-z]{4}$/);
    expect(resolveTokenAddressFromKey(callbacks[0].split(':')[1])).toBe(token);
    expect(resolveTokenAddressFromKey(callbacks[1].slice('token_refresh:'.length))).toBe(token);
  });

  it('leaves chart URLs and short-address callbacks unchanged', () => {
    const markup = {
      inline_keyboard: [[
        { text: 'Buy', callback_data: 'buy_fixed:token.near:0.5' },
        { text: 'Chart', url: 'https://dexscreener.com/near/token.near' },
      ]],
    };
    expect(shortenTrackerAlertMarkup(markup, 'token.near')).toEqual(markup);
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
