import { describe, it, expect } from 'vitest';
import { isLaunchpadToken } from './safety.js';

describe('isLaunchpadToken', () => {
  it('recognises coins from every launchpad the bot trades', () => {
    for (const t of [
      'pcat.nearlytrade.near', 'oyster.v2-launchpad.justhoot.near', 'abc.launchpad.justhoot.near', 'jambo-1679.meme-cooking.near',
      'x.factory.shardsmarket.near', 'y.launch.intear.near', 'z.launch.shoremarkets.near', 'w.gaypad.near', 'v.kelytra.near',
      'u.nearpumpfun.near', 't.pad.onetokenhub.near', 's.nearpadfamily.near',
    ]) expect(isLaunchpadToken(t)).toBe(true);
  });

  it('leaves ordinary and bridged tokens alone', () => {
    for (const t of ['wrap.near', 'usdt.tether-token.near', 'prl.omft.near', 'token.rhealab.near', 'blackdragon.tkn.near']) {
      expect(isLaunchpadToken(t)).toBe(false);
    }
  });
});
