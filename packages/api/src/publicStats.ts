/**
 * Headline numbers for the home page: total volume RacerBot has routed (in USD),
 * total trades, and total users, across every chain the bot trades on. Read from
 * the same totals as the bot's daily admin volume update, and cached.
 */

import type { VolumeStats } from '@racerbot/db';

export interface PublicStats {
  volumeRoutedUsd: number;
  trades: number;
  users: number;
  updatedAt: number;
}

export interface ChainPrices {
  near: number;
  sui: number;
  strk: number;
  sol: number;
  hype: number;
}

/** Adds up all-time volume (priced in USD) and trades across chains */
export function summarizePublicStats(s: VolumeStats, p: ChainPrices, now = Date.now()): PublicStats {
  const volumeRoutedUsd =
    (s.volumeTotalNear || 0) * p.near +
    (s.volumeTotalSui || 0) * p.sui +
    (s.volumeTotalStarknet || 0) * p.strk +
    (s.volumeTotalSolana || 0) * p.sol +
    ((s.volumeTotalHyperevm || 0) + (s.volumeTotalElysium || 0)) * p.hype;
  const trades =
    (s.tradesTotal || 0) + (s.tradesTotalSui || 0) + (s.tradesTotalStarknet || 0) +
    (s.tradesTotalSolana || 0) + (s.tradesTotalHyperevm || 0) + (s.tradesTotalElysium || 0);
  return {
    volumeRoutedUsd: Math.round(volumeRoutedUsd),
    trades,
    users: s.usersTotal || 0,
    updatedAt: now,
  };
}
