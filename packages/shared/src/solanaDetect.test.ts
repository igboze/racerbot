import { describe, it, expect } from 'vitest';
import { extractSolanaCandidate } from './solana.js';

const M = '37HUJAw35KccKwFb8Lb5ECZfppRaEy88apkL4WYgpump';
const P = '5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9';

describe('extractSolanaCandidate', () => {
  const cases: Array<[string, string | null, boolean?]> = [
    [M, M], [`CA: ${M}`, M], [`CA:${M}.`, M], [`buy this ${M}!`, M], [`(${M})`, M],
    [`https://pump.fun/coin/${M}`, M], [`pump.fun/${M}`, M],
    [`https://neo.bullx.io/terminal?chainId=1399811149&address=${M}`, M],
    [`https://raydium.io/swap/?inputMint=sol&outputMint=${M}`, M],
    [`https://jup.ag/swap/So11111111111111111111111111111111111111112-${M}`, M],
    [`https://gmgn.ai/sol/token/abc123_${M}`, M],
    [`https://birdeye.so/token/${M}?chain=solana`, M],
    [`https://solscan.io/token/${M}#holders`, M],
    [`https://dexscreener.com/solana/${P.toLowerCase()}`, P.toLowerCase(), true],
    [`https://photon-sol.tinyastro.io/en/lp/${P}?handle=x`, P, true],
    [`https://axiom.trade/meme/${P}`, P, true],
    ['0x' + 'ab'.repeat(32), null],
    ['0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN', null],
    ['bob.near', null], ['f'.repeat(64), null], ['wrap.near 1.5', null],
  ];
  for (const [text, want, pair] of cases) {
    it(`finds ${want ?? 'nothing'} in ${text.slice(0, 40)}`, () => {
      const r = extractSolanaCandidate(text);
      expect(r?.address ?? null).toBe(want);
      if (want) expect(r!.maybePair).toBe(Boolean(pair));
    });
  }
});
