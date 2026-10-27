import { type TokenInfoResult, formatCryptoPrice } from './wallet.js';

export interface BadgeInfo {
  type: 'pass' | 'fail' | 'warn' | 'info';
  label: string;
}

export interface TokenInfoCardData {
  tokenAddress: string;
  name: string;
  symbol: string;
  venue: string;
  priceNear?: string;
  priceUsd?: string;
  marketCapUsd?: string;
  marketCapNear?: string;
  liquidityUsd?: string;
  liquidityNear?: string;
  totalSupply?: string;
  decimals?: number;
  buyTaxPct?: number;
  sellTaxPct?: number;
  holdersCount?: number;
  buysCount?: number;
  sellsCount?: number;
  totalTxns?: number;
  pairedSymbol?: string;
  bondingProgressPct?: number;
  badges?: BadgeInfo[];
  icon?: string;
}

export function toTokenInfoCardData(
  info: TokenInfoResult,
  nearUsd: number | null,
  safetyCheck?: { isHoneypot?: boolean; isDrained?: boolean; isUnlockedRheaPool?: boolean; isAuditedLaunchpad?: boolean; reasons?: string[] } | null
): TokenInfoCardData {
  const priceNum = parseFloat(info.price || '0');
  const priceNear = priceNum > 0 ? formatCryptoPrice(priceNum, '') : undefined;

  const effectiveNearUsd = nearUsd || info.near_usd || null;
  const priceUsdNum = parseFloat((info as any).price_usd || '0');
  let priceUsd: string | undefined = undefined;
  if (priceUsdNum > 0) {
    priceUsd = formatCryptoPrice(priceUsdNum, '$');
  } else if (priceNum > 0 && effectiveNearUsd && effectiveNearUsd > 0) {
    priceUsd = formatCryptoPrice(priceNum * effectiveNearUsd, '$');
  }

  // Market Cap
  let marketCapUsd: string | undefined = undefined;
  let marketCapNear: string | undefined = undefined;
  const mcUsdVal = (info as any).market_cap_usd as number | undefined;
  const mcNearVal = info.market_cap;
  if (mcUsdVal && mcUsdVal > 0) {
    marketCapUsd = mcUsdVal >= 1_000_000_000
      ? `$${(mcUsdVal / 1_000_000_000).toFixed(2)}B`
      : mcUsdVal >= 1_000_000
      ? `$${(mcUsdVal / 1_000_000).toFixed(2)}M`
      : mcUsdVal >= 1_000
      ? `$${(mcUsdVal / 1_000).toFixed(2)}K`
      : `$${mcUsdVal.toFixed(2)}`;
  } else if (mcNearVal > 0 && effectiveNearUsd && effectiveNearUsd > 0) {
    const calcMcUsd = mcNearVal * effectiveNearUsd;
    marketCapUsd = calcMcUsd >= 1_000_000_000
      ? `$${(calcMcUsd / 1_000_000_000).toFixed(2)}B`
      : calcMcUsd >= 1_000_000
      ? `$${(calcMcUsd / 1_000_000).toFixed(2)}M`
      : calcMcUsd >= 1_000
      ? `$${(calcMcUsd / 1_000).toFixed(2)}K`
      : `$${calcMcUsd.toFixed(2)}`;
  }

  if (mcNearVal > 0) {
    if (mcNearVal >= 1_000_000) marketCapNear = `${(mcNearVal / 1_000_000).toFixed(2)}M NEAR`;
    else if (mcNearVal >= 1_000) marketCapNear = `${(mcNearVal / 1_000).toFixed(2)}K NEAR`;
    else marketCapNear = `${mcNearVal.toFixed(2)} NEAR`;
  }

  // Liquidity
  let liquidityNear: string | undefined = undefined;
  let liquidityUsd: string | undefined = undefined;
  const liqNum = parseFloat(info.liquidity || '0');
  if (liqNum > 0) {
    if (liqNum >= 1000) liquidityNear = `${(liqNum / 1000).toFixed(2)}K NEAR`;
    else liquidityNear = `${liqNum.toFixed(2)} NEAR`;
  }

  const liqUsdRaw = parseFloat((info as any).liquidity_usd || '0');
  if (liqUsdRaw > 0) {
    if (liqUsdRaw >= 1_000_000) liquidityUsd = `$${(liqUsdRaw / 1_000_000).toFixed(2)}M`;
    else if (liqUsdRaw >= 1_000) liquidityUsd = `$${(liqUsdRaw / 1_000).toFixed(1)}K`;
    else liquidityUsd = `$${liqUsdRaw.toFixed(0)}`;
  } else if (liqNum > 0 && effectiveNearUsd && effectiveNearUsd > 0) {
    const calcLiqUsd = liqNum * effectiveNearUsd;
    if (calcLiqUsd >= 1_000_000) liquidityUsd = `$${(calcLiqUsd / 1_000_000).toFixed(2)}M`;
    else if (calcLiqUsd >= 1_000) liquidityUsd = `$${(calcLiqUsd / 1_000).toFixed(1)}K`;
    else liquidityUsd = `$${calcLiqUsd.toFixed(0)}`;
  }

  // Supply formatting
  let totalSupply: string | undefined = undefined;
  if (info.total_supply && info.total_supply !== '0') {
    const supplyHuman = parseFloat(info.total_supply) / Math.pow(10, info.decimals || 18);
    if (!isNaN(supplyHuman) && supplyHuman > 0) {
      if (supplyHuman >= 1e9) totalSupply = `${(supplyHuman / 1e9).toFixed(2)}B`;
      else if (supplyHuman >= 1e6) totalSupply = `${(supplyHuman / 1e6).toFixed(2)}M`;
      else if (supplyHuman >= 1e3) totalSupply = `${(supplyHuman / 1e3).toFixed(2)}K`;
      else totalSupply = supplyHuman.toFixed(2);
    }
  }

  // Badges
  const badges: BadgeInfo[] = [];

  if (safetyCheck === undefined || safetyCheck === null) {
    badges.push({ type: 'warn', label: 'RUG CHECK UNAVAILABLE' });
  } else {
    if (safetyCheck.isHoneypot || safetyCheck.isDrained) {
      badges.push({ type: 'fail', label: safetyCheck.isHoneypot ? 'HONEYPOT' : 'DRAINED' });
    } else {
      badges.push({ type: 'pass', label: 'HONEYPOT PASSED' });
    }
  }

  if (info.bonding_phase) {
    badges.push({
      type: 'info',
      label: info.bonding_phase.toUpperCase(),
    });
  }

  // Icon: pass ft_metadata icon or image URL
  const rawIcon = info.icon || (info as any).icon_url;
  const icon = (typeof rawIcon === 'string' && rawIcon.trim().length > 0) ? rawIcon.trim() : undefined;

  return {
    tokenAddress: info.address,
    name: info.name || 'Token',
    symbol: info.symbol || 'TOKEN',
    venue: info.venue || 'Unknown',
    priceNear,
    priceUsd: effectiveNearUsd ? priceUsd : undefined,
    marketCapUsd: effectiveNearUsd ? marketCapUsd : undefined,
    marketCapNear,
    liquidityUsd: effectiveNearUsd ? liquidityUsd : undefined,
    liquidityNear,
    totalSupply,
    decimals: info.decimals,
    buyTaxPct: info.buy_tax_pct,
    sellTaxPct: info.sell_tax_pct,
    holdersCount: info.holders_count ?? undefined,
    buysCount: info.buys_count ?? undefined,
    sellsCount: info.sells_count ?? undefined,
    totalTxns: (info as any).total_txns,
    pairedSymbol: info.paired_symbol,
    bondingProgressPct: info.bonding_progress_pct ?? undefined,
    badges: badges.length > 0 ? badges : undefined,
    icon,
  };
}
