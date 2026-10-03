import { getFillsByPosition, getPositionById, getUserById, generateReferralCode } from '@racerbot/db';
import { getTokenInfo, isSuiToken } from './wallet.js';
import { generatePNLCardImage } from './pnlCardImageGenerator.js';

export interface PNLCardData {
  tokenAddress: string;
  tokenName: string;
  tokenSymbol: string;
  entryPrice: number;
  currentPrice: number;
  quantityHeld: number;
  initialInvestment: number;
  unrealizedValue: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  pnlPercent: number;
  isProfit: boolean;
  holdDuration: string;
  positionId: string;
  positionStatus: 'open' | 'closed';
  /** Market cap (in NEAR) at the time the user entered the position */
  entryMarketCap: number;
  /** Current market cap (in NEAR) */
  currentMarketCap: number;
  venue?: string;
  isExternalDeposit: boolean;
  externalDepositDetectedAt?: Date | null;
  totalBuys: number;
  totalSells: number;
  totalFeesPaid: number;
  /** Buy-side fees only (in native units) */
  buyFeesPaid: number;
  /** Sell-side fees only (in native units) */
  sellFeesPaid: number;
  /** How much the token price itself moved (entry → exit/current), in % */
  tokenPriceChangePct: number;
  nearUsd: number;
  /** Whether to show the user's personal net worth (investment / value) on the card */
  showNetWorth: boolean;
  /** User referral code for QR/bar code link */
  referralCode?: string | null;
  /** Full Telegram deep-link for referral */
  referralLink?: string | null;
}

/**
 * Generate PNL card data for a position.
 * @param showNetWorthOverride - overrides the user's global preference for this render
 */
export async function generatePNLCardData(
  positionId: string,
  showNetWorthOverride?: boolean
): Promise<PNLCardData | null> {
  try {
    const position = await getPositionById(positionId);
    if (!position) return null;

    let showNetWorth = true;
    let referralCode: string | null = null;
    let referralLink: string | null = null;

    if (position.user_id) {
      const user = await getUserById(position.user_id).catch(() => null);
      if (user) {
        if (showNetWorthOverride !== undefined) {
          showNetWorth = showNetWorthOverride;
        } else if (user.show_net_worth_on_card === false) {
          showNetWorth = false;
        }

        referralCode = user.referral_code || null;
        if (!referralCode && (user.username || user.telegram_id)) {
          referralCode = await generateReferralCode(
            user.id,
            user.username || `racer${user.telegram_id}`
          ).catch(() => null);
        }
        if (referralCode) {
          referralLink = `https://t.me/racertradingbot?start=${referralCode}`;
        }
      }
    }

    const fills = await getFillsByPosition(positionId);
    const buys  = fills.filter(f => f.side === 'buy');
    const sells = fills.filter(f => f.side === 'sell');

    // Get token info. Live price reads can flake (RPC timeout) — retry once
    // before accepting a zero-price render; getTokenInfo itself falls back to
    // the last known DB price when discovery fails.
    let tokenInfo     = await getTokenInfo(position.token_address, true).catch(() => null);
    if (!tokenInfo || parseFloat(tokenInfo.price || '0') <= 0) {
      tokenInfo = await getTokenInfo(position.token_address, true).catch(() => tokenInfo);
    }
    const currentPrice = tokenInfo ? parseFloat(tokenInfo.price) : 0;
    const isSuiPos     = position.chain === 'sui' || isSuiToken(position.token_address);
    const nearUsd      = isSuiPos ? (tokenInfo?.sui_usd || 2.0) : (tokenInfo?.near_usd || 4.3);

    const isExternalDeposit       = position.is_external_deposit || false;
    const externalDepositDetectedAt = position.external_deposit_detected_at;

    const decimals    = tokenInfo?.decimals ?? (isSuiPos ? 9 : 18);
    const toHuman = (rawStr: string): number => {
      const val = parseFloat(rawStr || '0');
      if (val > 1e10 && decimals > 0) return val / Math.pow(10, decimals);
      return val;
    };

    const normalizeFee = (rawFeeStr: string): number => {
      let fee = parseFloat(rawFeeStr || '0');
      if (isSuiPos && fee > 1e6) fee = fee / 1e9;
      else if (!isSuiPos && fee > 1e18) fee = fee / 1e24;
      return fee;
    };

    // ── Total supply for market cap ──────────────────────────────────────────
    let totalSupplyHuman = 0;
    if (tokenInfo?.total_supply) {
      try {
        const raw = BigInt(String(tokenInfo.total_supply).split('.')[0]);
        totalSupplyHuman = Number(raw) / Math.pow(10, decimals);
      } catch { /* leave 0 */ }
    }

    // ── Investment calculation (excluding synthetic deposit fills) ───────────
    let totalInitialInvestment = 0;
    let totalFeesPaid          = 0;
    let totalBuyTokensHuman    = 0;
    for (const buy of buys) {
      if (buy.tx_hash?.startsWith('deposit_')) continue;
      const amount = toHuman(buy.amount);
      const fee    = normalizeFee(buy.fee_paid || '0');
      totalFeesPaid += fee;
      totalBuyTokensHuman += amount;

      if (buy.input_amount != null && parseFloat(buy.input_amount) > 0) {
        // On-chain source of truth: actual SUI/NEAR spent
        totalInitialInvestment += parseFloat(buy.input_amount);
      } else {
        // Legacy fills: approximate from amount*price + normalized fee
        const price = parseFloat(buy.price);
        totalInitialInvestment += amount * price + fee;
      }
    }

    let quantityHeld = 0;
    try {
      const rawBig = BigInt((position.quantity_held || '0').split('.')[0]);
      quantityHeld = Number(rawBig) / Math.pow(10, decimals);
    } catch {
      quantityHeld = parseFloat(position.quantity_held || '0');
    }

    let avgEntryPrice = parseFloat(position.avg_entry_price || '0');
    if (totalBuyTokensHuman > 0 && totalInitialInvestment > 0) {
      const fillAvgEntry = totalInitialInvestment / totalBuyTokensHuman;
      // Heal if stored entry is 0, or 10× above current and fill calc gives a sane value
      if (avgEntryPrice <= 0 || (currentPrice > 0 && avgEntryPrice > currentPrice * 10 && fillAvgEntry <= currentPrice * 10)) {
        avgEntryPrice = fillAvgEntry;
      }
    } else if (avgEntryPrice <= 0 && currentPrice > 0) {
      avgEntryPrice = currentPrice;
    }

    if (totalInitialInvestment === 0 && (isExternalDeposit || quantityHeld > 0)) {
      totalInitialInvestment = quantityHeld * avgEntryPrice;
    }

    // ── Exit Price & Realized Metrics for Closed Positions ──────────────────
    let totalRealizedPnl   = 0;
    let totalRealizedValue = 0;
    let totalRealizedCost  = 0;
    let totalSoldAmount    = 0;
    let totalSoldGross     = 0;
    let sellFeesPaid       = 0;
    for (const sell of sells) {
      const amount   = toHuman(sell.amount);
      const price    = parseFloat(sell.price);
      const fee      = normalizeFee(sell.fee_paid || '0');
      const sellValue = amount * price - fee;
      const costBasis = amount * avgEntryPrice;
      totalRealizedValue += sellValue;
      totalRealizedCost  += costBasis;
      totalFeesPaid      += fee;
      sellFeesPaid       += fee;
      totalSoldAmount    += amount;
      totalSoldGross     += amount * price;
    }
    totalRealizedPnl = totalRealizedValue - totalRealizedCost;
    const buyFeesPaid = totalFeesPaid - sellFeesPaid;

    const isClosed = position.status === 'closed' || quantityHeld <= 0;
    const avgExitPrice = totalSoldAmount > 0
      ? totalSoldGross / totalSoldAmount
      : (sells.length > 0 ? parseFloat(sells[sells.length - 1].price) : currentPrice);

    // For closed positions, the display price is the actual weighted execution exit price
    const displayPrice = isClosed && avgExitPrice > 0 ? avgExitPrice : currentPrice;

    const unrealizedValue = quantityHeld * currentPrice;
    const totalValue      = unrealizedValue + totalRealizedValue;
    const unrealizedPnl   = unrealizedValue - quantityHeld * avgEntryPrice;
    const totalPnl        = totalValue - totalInitialInvestment;

    // ── PnL % for the hero display ────────────────────────────────────────────
    const costBasisHeld = quantityHeld * avgEntryPrice;
    const pnlPercent = isClosed
      ? (totalInitialInvestment > 0 ? (totalPnl / totalInitialInvestment) * 100 : (avgEntryPrice > 0 ? ((avgExitPrice - avgEntryPrice) / avgEntryPrice) * 100 : 0))
      : (costBasisHeld > 0 ? (unrealizedPnl / costBasisHeld) * 100 : (totalInitialInvestment > 0 ? (totalPnl / totalInitialInvestment) * 100 : 0));
    const isProfit = totalPnl >= 0;

    // ── Hold duration ────────────────────────────────────────────────────────
    const openedAt        = position.opened_at;
    const closedAt        = position.closed_at || new Date();
    const holdDuration    = formatHoldDuration(closedAt.getTime() - openedAt.getTime());

    // ── Market caps (NEAR units) ─────────────────────────────────────────────
    let currentMarketCap = tokenInfo?.market_cap || 0;
    if (isClosed && avgExitPrice > 0 && totalSupplyHuman > 0) {
      currentMarketCap = avgExitPrice * totalSupplyHuman;
    } else if (currentMarketCap <= 0 && totalSupplyHuman > 0 && displayPrice > 0) {
      currentMarketCap = displayPrice * totalSupplyHuman;
    }

    let entryMarketCap = 0;
    if (totalSupplyHuman > 0 && avgEntryPrice > 0) {
      entryMarketCap = avgEntryPrice * totalSupplyHuman;
    } else if (displayPrice > 0 && currentMarketCap > 0 && avgEntryPrice > 0) {
      entryMarketCap = (avgEntryPrice / displayPrice) * currentMarketCap;
    }

    // ── Venue name ───────────────────────────────────────────────────────────
    const venueMap: Record<string, string> = {
      rhea:         'Rhea Finance',
      shardsmarket: 'Shardsmarket',
      nearlytrade:  'NearlyTrade',
      intear:       'Intear',
      onetokenhub:  'OneTokenHub',
      memecooking:  'Meme.Cooking',
      nearpad:      'NEARpad',
      gaypad:       'Gaypad',
    };
    const venueName = tokenInfo?.venue ? venueMap[tokenInfo.venue] || tokenInfo.venue : 'Unknown';

    // Token price % change (pure market move, no fees)
    const tokenPriceChangePct = avgEntryPrice > 0
      ? ((displayPrice - avgEntryPrice) / avgEntryPrice) * 100
      : 0;

    return {
      tokenAddress:   position.token_address,
      tokenName:      tokenInfo?.name    || position.token_address,
      tokenSymbol:    tokenInfo?.symbol  || position.token_address.slice(0, 8),
      entryPrice:     avgEntryPrice,
      currentPrice:   displayPrice,
      quantityHeld,
      initialInvestment: totalInitialInvestment,
      unrealizedValue,
      realizedPnl:    totalRealizedPnl,
      unrealizedPnl,
      totalPnl,
      pnlPercent,
      isProfit,
      holdDuration,
      positionId,
      positionStatus: position.status as 'open' | 'closed',
      entryMarketCap,
      currentMarketCap,
      venue:          venueName,
      isExternalDeposit,
      externalDepositDetectedAt,
      totalBuys:      buys.filter(b => !b.tx_hash?.startsWith('deposit_')).length,
      totalSells:     sells.length,
      totalFeesPaid,
      buyFeesPaid,
      sellFeesPaid,
      tokenPriceChangePct,
      nearUsd,
      showNetWorth,
      referralCode,
      referralLink,
    };
  } catch (err: any) {
    console.error('[PNL_CARD] Error generating PNL card data:', err);
    return null;
  }
}

/**
 * Format hold duration into human-readable string
 */
function formatHoldDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours   = Math.floor(minutes / 60);
  const days    = Math.floor(hours / 24);

  if (days > 0)    return `${days}d ${hours % 24}h`;
  if (hours > 0)   return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/**
 * Generate PNL card Telegram message text
 */
export function generatePNLCardMessage(data: PNLCardData): string {
  const emoji       = data.isProfit ? '🟢' : '🔴';
  const pnlSign     = data.isProfit ? '+' : '';
  const isClosed    = data.positionStatus === 'closed';
  const statusEmoji = isClosed ? '🔒' : '🟢';
  const nativeUnit  = data.tokenAddress.includes('::') ? 'SUI' : 'NEAR';

  const safe = (s: string) => (s || '').replace(/[_*`[\](~|>#+=|{}!@&%$^\\/]/g, ' ');
  const safeSymbol  = safe(data.tokenSymbol);
  const safeName    = safe(data.tokenName);
  const safeAddress = safe(data.tokenAddress);

  const formatNative = (v: number) => {
    if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(2)}K ${nativeUnit}`;
    return `${v.toFixed(4)} ${nativeUnit}`;
  };

  const formatUSD = (nativeValue: number) => {
    const v = nativeValue * data.nearUsd;
    if (Math.abs(v) >= 1000) return `$${(v / 1000).toFixed(2)}K`;
    if (Math.abs(v) >= 1)    return `$${v.toFixed(2)}`;
    return `$${v.toFixed(4)}`;
  };

  const formatMcap = (nativeValue: number) => {
    const v = nativeValue * data.nearUsd;
    if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
    if (v >= 1_000_000)     return `$${(v / 1_000_000).toFixed(2)}M`;
    if (v >= 1_000)         return `$${(v / 1_000).toFixed(2)}K`;
    return v > 0 ? `$${v.toFixed(2)}` : 'N/A';
  };

  const tokenMoveSign  = data.tokenPriceChangePct >= 0 ? '+' : '';
  const tokenMoveEmoji = data.tokenPriceChangePct >= 0 ? '📈' : '📉';
  const currentOrExitLabel = isClosed ? 'Exit' : 'Current';

  // Build card
  let card = `${emoji} *${safeSymbol} PNL Card* ${statusEmoji}

📝 *Token*: \`${safeName}\`
🔗 *CA*: \`${safeAddress}\`
💧 *Venue*: \`${safe(data.venue || 'Unknown')}\`

💰 *Entry Price*: \`${data.entryPrice.toFixed(8)} ${nativeUnit}\`
💰 *${currentOrExitLabel} Price*: \`${data.currentPrice.toFixed(8)} ${nativeUnit}\`
${tokenMoveEmoji} *Token Move*: \`${tokenMoveSign}${data.tokenPriceChangePct.toFixed(2)}%\``;

  if (data.showNetWorth) {
    card += `\n\n💵 *Invested*: \`${formatNative(data.initialInvestment)}\` (${formatUSD(data.initialInvestment)})`;

    if (isClosed) {
      const netProceeds = data.initialInvestment + data.totalPnl;
      card += `\n💵 *Received*: \`${formatNative(netProceeds)}\` (${formatUSD(netProceeds)})`;
    } else {
      card += `\n📦 *Holding*: \`${data.quantityHeld.toFixed(4)} ${safeSymbol}\``;
      card += `\n💵 *Current Value*: \`${formatNative(data.unrealizedValue)}\` (${formatUSD(data.unrealizedValue)})`;
    }

    card += `\n\n${emoji} *Your PNL*: \`${pnlSign}${formatNative(data.totalPnl)}\` (\`${pnlSign}${data.pnlPercent.toFixed(2)}%\`) (${formatUSD(data.totalPnl)})`;
  } else {
    card += `\n\n${emoji} *Your PNL*: \`${pnlSign}${data.pnlPercent.toFixed(2)}%\``;
  }

  if (data.entryMarketCap > 0 || data.currentMarketCap > 0) {
    card += `\n\n📊 *Entry Market Cap*: \`${formatMcap(data.entryMarketCap)}\``;
    card += `\n📊 *${currentOrExitLabel} Market Cap*: \`${formatMcap(data.currentMarketCap)}\``;
  }

  card += `\n\n⏱️ *Hold Duration*: \`${data.holdDuration}\`
📌 *Status*: \`${data.positionStatus.toUpperCase()}\`

---
_Generated by RacerBot_`;

  return card.trim();
}



/**
 * Generate PNL card with both image and text.
 * @param positionId - position to render
 * @param showNetWorth - whether to show investment / value on the card (overrides global setting if provided)
 */
export async function generatePNLCard(
  positionId: string,
  showNetWorth?: boolean
): Promise<{ image: Buffer | null; text: string }> {
  try {
    const data = await generatePNLCardData(positionId, showNetWorth);
    if (!data) return { image: null, text: '' };

    const text  = generatePNLCardMessage(data);
    const image = await generatePNLCardImage(data).catch(() => null);
    return { image, text };
  } catch {
    return { image: null, text: '' };
  }
}
