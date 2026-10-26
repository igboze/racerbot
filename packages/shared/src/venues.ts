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

export type VenueId = 'rhea' | 'ref' | 'shardsmarket' | 'nearlytrade' | 'intear' | 'memecooking' | 'onetokenhub' | 'gaypad' | 'nearpad' | 'shoremarkets' | 'kelytra' | 'nearpumpfun' | 'qlyphs' | 'launchy' | 'unruggable' | 'ekubo' | 'avnu';

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
    contracts: ['launch.intear.near', 'launch-v2.intear.near', 'dex.intear.near'],
    tradeable: true,
    website: 'https://intea.rs',
    tokenPage: (t) => `https://intea.rs/launch/${t}`,
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
  shoremarkets: {
    id: 'shoremarkets',
    label: 'ShoreMarkets',
    kind: 'launchpad+amm',
    contracts: ['launch.shoremarkets.near', 'dclv2.ref-labs.near'],
    tradeable: true,
    website: 'https://shore.markets',
    tokenPage: (t) => `https://shore.markets/#/token/${t}`,
  },
  kelytra: {
    id: 'kelytra',
    label: 'Kelytra',
    kind: 'launchpad+amm',
    contracts: ['exchange.kelytradevs.near'],
    tradeable: true,
    website: 'https://exchange.kelytradevs.near',
    tokenPage: (t) => `https://nearblocks.io/tokens/${t}`,
  },
  nearpumpfun: {
    id: 'nearpumpfun',
    label: 'NearPumpFun',
    kind: 'launchpad+amm',
    contracts: ['nearpumpfun.near'],
    tradeable: true,
    website: 'https://nearpump.fun',
    tokenPage: (t) => `https://nearblocks.io/tokens/${t}`,
  },
  qlyphs: {
    id: 'qlyphs',
    label: 'Qlyphs',
    kind: 'launchpad+amm',
    contracts: ['qlyphs.near', 'dclv2.ref-labs.near'],
    tradeable: true,
    website: 'https://qlyphs.com',
    tokenPage: (t) => `https://nearblocks.io/tokens/${t}`,
  },
  launchy: {
    id: 'launchy',
    label: 'Launchy',
    kind: 'launchpad+amm',
    contracts: [
      '0x03865fb40c5b7a493299323e71967656243006101e6221246eccdda2bba356c3',
      '0x063883bfd87f65a2e42193f0f5cf18eb69d983abb99b07f7ec9a561b11c85ef4',
    ],
    tradeable: true,
    website: 'https://starklaunchy.fun',
    tokenPage: (t) => `https://starklaunchy.fun/token/${t}`,
  },
  unruggable: {
    id: 'unruggable',
    label: 'Unruggable Meme',
    kind: 'launchpad+amm',
    contracts: ['0x01a46467a9246f45c830a5eb440b544873cba2c4cee663951568e188352e033f'],
    tradeable: true,
    website: 'https://unruggable.meme',
    tokenPage: (t) => `https://unruggable.meme/memecoins/${t}`,
  },
  ekubo: {
    id: 'ekubo',
    label: 'Ekubo DEX',
    kind: 'dex',
    contracts: ['0x00000005dd3d2f4429af886cd1a3b08289dbcea99a294197e9eb43b0e0325b4b'],
    tradeable: true,
    website: 'https://app.ekubo.org',
  },
  avnu: {
    id: 'avnu',
    label: 'AVNU Aggregator',
    kind: 'dex',
    contracts: ['0x04270219d365d6b017231b52e92b3fb5d7c8378b05e9abc89c45f737bc0c5bba'],
    tradeable: true,
    website: 'https://app.avnu.fi',
  },
};

export function getVenueInfo(venue: string | null | undefined): VenueInfo | null {
  if (!venue) return null;
  return VENUES[venue as VenueId] ?? null;
}

/** DexScreener chart/search page for a token on NEAR, SUI, or Starknet. */
export function dexscreenerUrl(tokenAddress: string, venue?: string | null): string {
  if (
    venue === 'launchy' ||
    venue === 'unruggable' ||
    venue === 'avnu' ||
    venue === 'ekubo' ||
    (!tokenAddress.includes('::') && tokenAddress.startsWith('0x') && tokenAddress.length >= 60)
  ) {
    return `https://dexscreener.com/starknet/${tokenAddress}`;
  }
  if (tokenAddress.includes('::') || tokenAddress.startsWith('0x')) {
    return `https://dexscreener.com/sui/${tokenAddress}`;
  }
  return `https://dexscreener.com/near/${tokenAddress}`;
}

export function isIntearToken(tokenAddress: string): boolean {
  if (!tokenAddress) return false;
  const lower = tokenAddress.toLowerCase().trim();
  return (
    lower.endsWith('.intear.near') ||
    lower.endsWith('.launch.intear.near') ||
    lower.endsWith('.launch-v2.intear.near') ||
    lower.includes('intear.near') ||
    (lower.includes('.launch') && lower.includes('intear.near'))
  );
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
  const isStarknet =
    venue === 'launchy' ||
    venue === 'unruggable' ||
    venue === 'avnu' ||
    venue === 'ekubo' ||
    (!tokenAddress.includes('::') && tokenAddress.startsWith('0x') && tokenAddress.length >= 60);

  const isSui = !isStarknet && (tokenAddress.includes('::') || tokenAddress.startsWith('0x'));

  let explorerLink: VenueLink;
  if (isStarknet) {
    explorerLink = { label: '🔎 Starkscan', url: `https://starkscan.co/contract/${tokenAddress}` };
  } else if (isSui) {
    explorerLink = { label: '🔎 Suiscan', url: `https://suiscan.xyz/mainnet/coin/${encodeURIComponent(tokenAddress)}` };
  } else {
    explorerLink = { label: '🔎 NearBlocks', url: nearblocksTokenUrl(tokenAddress) };
  }

  const links: VenueLink[] = [
    { label: '🫧 Bubble Map', url: bubbleMapUrl(tokenAddress, symbol, name) },
    { label: '📊 DexScreener', url: dexscreenerUrl(tokenAddress, venue) },
    explorerLink,
  ];
  const info = getVenueInfo(venue);
  if (info) {
    links.push({
      label: `🚀 ${info.label}`,
      url: info.tokenPage ? info.tokenPage(tokenAddress) : info.website,
    });
  }
  // Telegram rejects the WHOLE inline keyboard if any URL button is invalid.
  // NEAR account "domains" (e.g. https://gaypad.j1-racing.near) and localhost
  // are not public web hosts, so drop them rather than break the card.
  return links.filter(l => isTelegramSafeUrl(l.url));
}

/** True when a URL is a public http(s) URL Telegram will accept on a button. */
export function isTelegramSafeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.near') || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      return false;
    }
    return host.includes('.');
  } catch {
    return false;
  }
}
