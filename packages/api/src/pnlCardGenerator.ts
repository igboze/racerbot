import { getFillsByPosition, getPositionById, getUserById } from '@racerbot/db';
import { getTokenInfo } from './wallet.js';
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
  nearUsd: number;
  /** Whether to show the user's personal net worth (investment / value) on the card */
  showNetWorth: boolean;
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
    if (showNetWorthOverride !== undefined) {
      showNetWorth = showNetWorthOverride;
    } else if (position.user_id) {
      const user = await getUserById(position.user_id).catch(() => null);
      if (user && user.show_net_worth_on_card === false) {
        showNetWorth = false;
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
    const nearUsd      = tokenInfo?.near_usd || 4.3;

    const isExternalDeposit       = position.is_external_deposit || false;
    const externalDepositDetectedAt = position.external_deposit_detected_at;

    const decimals    = tokenInfo?.decimals ?? 18;
    const toHuman = (rawStr: string): number => {
      const val = parseFloat(rawStr || '0');
      if (val > 1e10 && decimals > 0) return val / Math.pow(10, decimals);
      return val;
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
    for (const buy of buys) {
      if (buy.tx_hash?.startsWith('deposit_')) continue;
      const amount = toHuman(buy.amount);
      const price  = parseFloat(buy.price);
      const fee    = parseFloat(buy.fee_paid || '0');
      totalInitialInvestment += amount * price + fee;
      totalFeesPaid          += fee;
    }

    let quantityHeld = 0;
    try {
      const rawBig = BigInt((position.quantity_held || '0').split('.')[0]);
      quantityHeld = Number(rawBig) / Math.pow(10, decimals);
    } catch {
      quantityHeld = parseFloat(position.quantity_held || '0');
    }
    const avgEntryPrice = parseFloat(position.avg_entry_price || '0');

    if (totalInitialInvestment === 0 && (isExternalDeposit || quantityHeld > 0)) {
      totalInitialInvestment = quantityHeld * avgEntryPrice;
    }

    // ── Realized PNL ─────────────────────────────────────────────────────────
    let totalRealizedPnl   = 0;
    let totalRealizedValue = 0;
    let totalRealizedCost  = 0;
    for (const sell of sells) {
      const amount   = toHuman(sell.amount);
      const price    = parseFloat(sell.price);
      const fee      = parseFloat(sell.fee_paid || '0');
      const sellValue = amount * price - fee;
      const costBasis = amount * avgEntryPrice;
      totalRealizedValue += sellValue;
      totalRealizedCost  += costBasis;
      totalFeesPaid      += fee;
    }
    totalRealizedPnl = totalRealizedValue - totalRealizedCost;

    const unrealizedValue = quantityHeld * currentPrice;
    const totalValue      = unrealizedValue + totalRealizedValue;
    const unrealizedPnl   = unrealizedValue - quantityHeld * avgEntryPrice;
    const totalPnl        = totalValue - totalInitialInvestment;
    const pnlPercent      = totalInitialInvestment > 0 ? (totalPnl / totalInitialInvestment) * 100 : 0;
    const isProfit        = totalPnl >= 0;

    // ── Hold duration ────────────────────────────────────────────────────────
    const openedAt        = position.opened_at;
    const closedAt        = position.closed_at || new Date();
    const holdDuration    = formatHoldDuration(closedAt.getTime() - openedAt.getTime());

    // ── Market caps (NEAR units) ─────────────────────────────────────────────
    let currentMarketCap = tokenInfo?.market_cap || 0;
    if (currentMarketCap <= 0 && totalSupplyHuman > 0 && currentPrice > 0) {
      currentMarketCap = currentPrice * totalSupplyHuman;
    }

    let entryMarketCap = 0;
    if (totalSupplyHuman > 0 && avgEntryPrice > 0) {
      entryMarketCap = avgEntryPrice * totalSupplyHuman;
    } else if (currentPrice > 0 && currentMarketCap > 0 && avgEntryPrice > 0) {
      entryMarketCap = (avgEntryPrice / currentPrice) * currentMarketCap;
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

    return {
      tokenAddress:   position.token_address,
      tokenName:      tokenInfo?.name    || position.token_address,
      tokenSymbol:    tokenInfo?.symbol  || position.token_address.slice(0, 8),
      entryPrice:     avgEntryPrice,
      currentPrice,
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
      nearUsd,
      showNetWorth,
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
  const statusEmoji = data.positionStatus === 'open' ? '🟢' : '🔴';

  const safe = (s: string) => (s || '').replace(/[_*`[\](~|>#+=|{}!@&%$^\\/]/g, ' ');
  const safeSymbol  = safe(data.tokenSymbol);
  const safeName    = safe(data.tokenName);
  const safeAddress = safe(data.tokenAddress);

  const formatUSD = (nearValue: number) => {
    const v = nearValue * data.nearUsd;
    if (Math.abs(v) >= 1000) return `$${(v / 1000).toFixed(2)}K`;
    if (Math.abs(v) >= 1)    return `$${v.toFixed(2)}`;
    return `$${v.toFixed(4)}`;
  };

  const formatMcap = (nearValue: number) => {
    const v = nearValue * data.nearUsd;
    if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
    if (v >= 1_000_000)     return `$${(v / 1_000_000).toFixed(2)}M`;
    if (v >= 1_000)         return `$${(v / 1_000).toFixed(2)}K`;
    return v > 0 ? `$${v.toFixed(2)}` : 'N/A';
  };

  let card = `
${emoji} *${safeSymbol} PNL Card* ${statusEmoji}

📝 *Token*: \`${safeName}\`
🔗 *CA*: \`${safeAddress}\`
💧 *Venue*: \`${safe(data.venue || 'Unknown')}\`

📊 *Entry Market Cap*: \`${formatMcap(data.entryMarketCap)}\`
📊 *Current Market Cap*: \`${formatMcap(data.currentMarketCap)}\`

💰 *Entry Price*: \`${data.entryPrice.toFixed(8)} NEAR\` (${formatUSD(data.entryPrice)})
💰 *Current Price*: \`${data.currentPrice.toFixed(8)} NEAR\` (${formatUSD(data.currentPrice)})`;

  if (data.showNetWorth) {
    card += `

📦 *Quantity Held*: \`${data.quantityHeld.toFixed(4)}\`
💵 *Initial Investment*: \`${formatUSD(data.initialInvestment)}\`
💵 *Unrealized Value*: \`${formatUSD(data.unrealizedValue)}\`

📊 *Realized PNL*: \`${pnlSign}${formatUSD(data.realizedPnl)}\`
📊 *Unrealized PNL*: \`${pnlSign}${formatUSD(data.unrealizedPnl)}\`
📊 *Total PNL*: \`${pnlSign}${formatUSD(data.totalPnl)}\` (\`${pnlSign}${data.pnlPercent.toFixed(2)}%\`)`;
  } else {
    card += `

📊 *Total PNL*: \`${pnlSign}${data.pnlPercent.toFixed(2)}%\``;
  }

  card += `

⏱️ *Hold Duration*: \`${data.holdDuration}\`
📌 *Status*: \`${data.positionStatus.toUpperCase()}\`

---
_Generated by RacerBot_`.trim();

  return card;
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
