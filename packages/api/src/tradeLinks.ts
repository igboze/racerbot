/** Links for trades shown in the live trade lists */

export const NEAR_TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
/** A named NEAR account (alice.near, bob.tg) or a 64-hex implicit account */
export const NEAR_ACCOUNT = /^(?:[a-z0-9_-]+\.)+(?:near|tg)$|^[0-9a-f]{64}$/;

/**
 * GeckoTerminal anonymises NEAR trades (short hex ids, not transaction hashes or
 * accounts), so a NearBlocks link would lead nowhere. Link the pool's trade list
 * instead, and only show a wallet that is a real NEAR account. Exported for tests.
 */
export function nearTradeLinks(txHash: unknown, from: unknown, poolAddr: string): { txHash: string; txUrl: string; maker: string | null } {
  const hash = typeof txHash === 'string' ? txHash : '';
  const maker = typeof from === 'string' && NEAR_ACCOUNT.test(from) ? from : null;
  if (NEAR_TX_HASH.test(hash)) return { txHash: hash, txUrl: `https://nearblocks.io/txns/${hash}`, maker };
  return { txHash: '', txUrl: `https://www.geckoterminal.com/near/pools/${encodeURIComponent(poolAddr)}`, maker };
}
