/**
 * Venue & launchpad registry.
 *
 * Single source of truth for every NEAR venue RacerBot knows about:
 * trading venues (DEXes / AMM launchpads), informational launchpads,
 * their on-chain contract IDs, and their public web links
 * (DexScreener chart, NearBlocks explorer, launchpad token page).
 *
 * Adding a new DEX/launchpad = one entry here + venue handling in
 * MultiRpcNear.computeMinAmountOut / SwapExecutor.
 */

export type VenueId = 'rhea' | 'shardsmarket' | 'nearlytrade' | 'intear' | 'memecooking' | 'onetokenhub';

export interface VenueInfo {
  id: VenueId;
  /** Human-readable label shown in cards/messages */
  label: string;
  kind: 'dex' | 'launchpad' | 'launchpad+amm';
  /** On-chain contracts this venue transacts with */
  contracts: string[];
  /** Whether RacerBot can execute swaps on this venue */
  tradeable: boolean;
  /** Venue website (launchpad home / DEX app) */
  website: string;
  /** Optional per-token page on the venue's own site */
  tokenPage?: (tokenAddress: string) => string;
}

export const VENUES: Record<VenueId, VenueInfo> = {
  rhea: {
    id: 'rhea',
    label: 'Rhea Finance',
    kind: 'dex',
    contracts: ['v2.ref-finance.near', 'dclv2.ref-labs.near'],
    tradeable: true,
    website: 'https://rhea.finance',
  },
  shardsmarket: {
    id: 'shardsmarket',
    label: 'Shards',
    kind: 'launchpad+amm',
    contracts: ['factory.shardsmarket.near'],
    tradeable: true,
    website: 'https://shards.market',
    tokenPage: (t) => `https://shards.market/t/${t}`,
  },
  nearlytrade: {
    id: 'nearlytrade',
    label: 'NearlyTrade',
    kind: 'launchpad+amm',
    contracts: ['nearlytrade.near', 'dclv2.ref-labs.near'],
    tradeable: true,
    website: 'https://nearly.trade',
    tokenPage: (t) => `https://nearly.trade/${t}`,
  },
  intear: {
    id: 'intear',
    label: 'Intear Launch',
    kind: 'launchpad+amm',
    contracts: ['launch.intear.near', 'dex.intear.near'],
    tradeable: true,
    website: 'https://intea.rs',
  },
  memecooking: {
    id: 'memecooking',
    label: 'Meme.Cooking',
    kind: 'launchpad',
    contracts: ['meme-cooking.near'],
    tradeable: false,
    website: 'https://meme.cooking',
  },
  onetokenhub: {
    id: 'onetokenhub',
    label: 'OneTokenHub',
    kind: 'launchpad+amm',
    contracts: ['pad.onetokenhub.near', 'dclv2.ref-labs.near'],
    tradeable: true,
    website: 'https://onetokenhub.xyz',
    tokenPage: (t) => `https://onetokenhub.xyz/token/${t}`,
  },
};

export function getVenueInfo(venue: string | null | undefined): VenueInfo | null {
  if (!venue) return null;
  return VENUES[venue as VenueId] ?? null;
}

/** DexScreener chart/search page for a token on NEAR. */
export function dexscreenerUrl(tokenAddress: string): string {
  return `https://dexscreener.com/near/${tokenAddress}`;
}

/** NearBlocks explorer page for a token contract. */
export function nearblocksTokenUrl(tokenAddress: string): string {
  return `https://nearblocks.io/tokens/${tokenAddress}`;
}

/** NearBlocks explorer page for a transaction. */
export function nearblocksTxUrl(txHash: string): string {
  return `https://nearblocks.io/txns/${txHash}`;
}

export interface VenueLink {
  label: string;
  url: string;
}

/**
 * Deep links for a token card: DexScreener chart, NearBlocks explorer,
 * and the token's page on its own launchpad/DEX (when it has one).
 */
export function tokenLinks(venue: string | null | undefined, tokenAddress: string): VenueLink[] {
  const links: VenueLink[] = [
    { label: '📊 DexScreener', url: dexscreenerUrl(tokenAddress) },
    { label: '🔎 NearBlocks', url: nearblocksTokenUrl(tokenAddress) },
  ];
  const info = getVenueInfo(venue);
  if (info) {
    links.push({
      label: `🚀 ${info.label}`,
      url: info.tokenPage ? info.tokenPage(tokenAddress) : info.website,
    });
  }
  return links;
}
