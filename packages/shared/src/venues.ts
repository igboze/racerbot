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

export type VenueId = 'rhea' | 'ref' | 'shardsmarket' | 'nearlytrade' | 'intear' | 'memecooking' | 'onetokenhub' | 'gaypad' | 'nearpad';

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
  ref: {
    id: 'ref',
    label: 'Ref Finance',
    kind: 'dex',
    contracts: ['v2.ref-finance.near', 'dclv2.ref-labs.near'],
    tradeable: true,
    website: 'https://ref.finance',
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
    kind: 'launchpad+amm',
    contracts: ['meme-cooking.near'],
    tradeable: true,
    website: 'https://meme.cooking',
    tokenPage: (t) => `https://meme.cooking/meme/${t}`,
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
  gaypad: {
    id: 'gaypad',
    label: 'Gaypad',
    kind: 'launchpad',
    contracts: ['gaypad.j1-racing.near'],
    tradeable: true,
    website: 'https://gaypad.j1-racing.near',
    tokenPage: (t) => `https://gaypad.j1-racing.near/#/token/${t}`,
  },
  nearpad: {
    id: 'nearpad',
    label: 'NEARpad',
    kind: 'launchpad+amm',
    contracts: ['nearpadfamily.near', 'dclv2.ref-labs.near'],
    tradeable: true,
    website: 'https://nearpad.family',
  },
};

export function getVenueInfo(venue: string | null | undefined): VenueInfo | null {
  if (!venue) return null;
  return VENUES[venue as VenueId] ?? null;
}

/** DexScreener chart/search page for a token on NEAR or SUI. */
export function dexscreenerUrl(tokenAddress: string): string {
  if (tokenAddress.includes('::') || tokenAddress.startsWith('0x')) {
    return `https://dexscreener.com/sui/${tokenAddress}`;
  }
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

/**
 * RacerBot bubble map page for a token’s holder distribution.
 * Served by the API itself so it works in any browser / Telegram WebView.
 */
export function bubbleMapUrl(tokenAddress: string, symbol?: string, name?: string): string {
  let base = (
    process.env.BUBBLE_PUBLIC_URL ||
    process.env.BUBBLEMAP_URL ||
    process.env.PUBLIC_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '') ||
    'http://localhost:3000'
  ).trim().replace(/\/+$/, '');

  if (base && !base.startsWith('http://') && !base.startsWith('https://')) {
    base = `https://${base}`;
  }

  const endpoint = base.includes('localhost') ? '' : '/api';
  let url = `${base}${endpoint}/bubblemap?token=${encodeURIComponent(tokenAddress)}`;
  if (symbol) url += `&symbol=${encodeURIComponent(symbol)}`;
  if (name) url += `&name=${encodeURIComponent(name)}`;
  return url;
}

export interface VenueLink {
  label: string;
  url: string;
}

/**
 * Deep links for a token card: DexScreener chart, explorer,
 * and the token's page on its own launchpad/DEX (when it has one).
 * Also includes a RacerBot bubble map link for holder distribution.
 */
export function tokenLinks(
  venue: string | null | undefined,
  tokenAddress: string,
  symbol?: string,
  name?: string,
): VenueLink[] {
  const isSui = tokenAddress.includes('::') || tokenAddress.startsWith('0x');
  const explorerLink: VenueLink = isSui
    ? { label: '🔎 Suiscan', url: `https://suiscan.xyz/mainnet/coin/${encodeURIComponent(tokenAddress)}` }
    : { label: '🔎 NearBlocks', url: nearblocksTokenUrl(tokenAddress) };

  const links: VenueLink[] = [
    { label: '🫧 Bubble Map', url: bubbleMapUrl(tokenAddress, symbol, name) },
    { label: '📊 DexScreener', url: dexscreenerUrl(tokenAddress) },
    explorerLink,
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
