import { getFillsByPosition, getPositionById } from '@racerbot/db';
import { getTokenInfo } from './wallet.js';
import { computePnL } from '@racerbot/shared';

export interface PNLCardData {
  tokenAddress: string;
  tokenName: string;
  tokenSymbol: string;
  entryPrice: number;
  currentPrice: number;
  quantityHeld: number;
  initialInvestment: number;
  currentValue: number;
  realizedPnl: number;
  totalPnl: number;
  pnlPercent: number;
  isProfit: boolean;
  holdDuration: string;
  positionId: string;
  marketCap?: string;
  venue?: string;
}

/**
 * Generate PNL card data for a position
 */
export async function generatePNLCardData(positionId: string): Promise<PNLCardData | null> {
  try {
    const position = await getPositionById(positionId);
    if (!position) return null;

    const fills = await getFillsByPosition(positionId);
    const buys = fills.filter(f => f.side === 'buy');
    const sells = fills.filter(f => f.side === 'sell');

    if (buys.length === 0) return null;

    // Get token info
    const tokenInfo = await getTokenInfo(position.token_address).catch(() => null);
    const currentPrice = tokenInfo ? parseFloat(tokenInfo.price) : 0;

    // Calculate total initial investment
    let totalInitialInvestment = 0;
    for (const buy of buys) {
      const amount = parseFloat(buy.amount);
      const price = parseFloat(buy.price);
      const fee = parseFloat(buy.fee_paid || '0');
      totalInitialInvestment += (amount * price) + fee;
    }

    // Calculate realized PNL from sells
    let totalRealizedPnl = 0;
    for (const sell of sells) {
      const amount = parseFloat(sell.amount);
      const price = parseFloat(sell.price);
      const fee = parseFloat(sell.fee_paid || '0');
      const sellValue = (amount * price) - fee;

      // Calculate average entry price at time of sell
      const avgEntry = parseFloat(position.avg_entry_price);
      const costBasis = amount * avgEntry;
      totalRealizedPnl += sellValue - costBasis;
    }

    const quantityHeld = parseFloat(position.quantity_held);
    const currentValue = quantityHeld * currentPrice;
    const totalValue = currentValue + totalRealizedPnl;

    const totalPnl = totalValue - totalInitialInvestment;
    const pnlPercent = totalInitialInvestment > 0 ? (totalPnl / totalInitialInvestment) * 100 : 0;
    const isProfit = totalPnl >= 0;

    // Calculate hold duration
    const openedAt = position.opened_at;
    const closedAt = position.closed_at || new Date();
    const holdDurationMs = closedAt.getTime() - openedAt.getTime();
    const holdDuration = formatHoldDuration(holdDurationMs);

    // Format market cap
    let marketCapStr = 'N/A';
    if (tokenInfo?.market_cap && typeof tokenInfo.market_cap === 'number') {
      const mc = tokenInfo.market_cap;
      if (mc >= 1_000_000) marketCapStr = `${(mc / 1_000_000).toFixed(2)}M NEAR`;
      else if (mc >= 1_000) marketCapStr = `${(mc / 1_000).toFixed(2)}K NEAR`;
      else if (mc > 0) marketCapStr = `${mc.toFixed(2)} NEAR`;
    }

    // Get venue name
    const venueMap: Record<string, string> = {
      'rhea': 'Rhea Finance',
      'shardsmarket': 'Shardsmarket',
      'nearlytrade': 'NearlyTrade',
      'intear': 'Intear',
      'onetokenhub': 'OneTokenHub',
      'memecooking': 'Meme.Cooking',
    };
    const venueName = tokenInfo?.venue ? venueMap[tokenInfo.venue] || tokenInfo.venue : 'Unknown';

    return {
      tokenAddress: position.token_address,
      tokenName: tokenInfo?.name || position.token_address,
      tokenSymbol: tokenInfo?.symbol || position.token_address.slice(0, 8),
      entryPrice: parseFloat(position.avg_entry_price),
      currentPrice,
      quantityHeld,
      initialInvestment: totalInitialInvestment,
      currentValue: totalValue,
      realizedPnl: totalRealizedPnl,
      totalPnl,
      pnlPercent,
      isProfit,
      holdDuration,
      positionId,
      marketCap: marketCapStr,
      venue: venueName,
    };
  } catch (err: any) {
    console.error('[PNL_CARD] Error generating PNL card data:', err);
    return null;
  }
}

/**
 * Format hold duration in human-readable format
 */
function formatHoldDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/**
 * Generate PNL card message for Telegram
 */
export function generatePNLCardMessage(data: PNLCardData): string {
  const emoji = data.isProfit ? '🟢' : '🔴';
  const pnlSign = data.isProfit ? '+' : '';

  let card = `
${emoji} *${data.tokenSymbol} PNL CARD*

📝 *Token*: \`${data.tokenName}\`
🔗 *CA*: \`${data.tokenAddress}\`
💧 *Venue*: \`${data.venue || 'Unknown'}\`

💰 *Entry Price*: \`${data.entryPrice.toFixed(8)} NEAR\`
💰 *Current Price*: \`${data.currentPrice.toFixed(8)} NEAR\``;

  if (data.marketCap && data.marketCap !== 'N/A') {
    card += `\n📊 *Market Cap*: \`${data.marketCap}\``;
  }

  card += `
📦 *Quantity Held*: \`${data.quantityHeld.toFixed(4)}\`
💵 *Initial Investment*: \`${data.initialInvestment.toFixed(4)} NEAR\`
💵 *Current Value*: \`${data.currentValue.toFixed(4)} NEAR\`

📊 *Realized PNL*: \`${pnlSign}${data.realizedPnl.toFixed(4)} NEAR\`
📊 *Total PNL*: \`${pnlSign}${data.totalPnl.toFixed(4)} NEAR\` (\`${pnlSign}${data.pnlPercent.toFixed(2)}%\`)

⏱️ *Hold Duration*: \`${data.holdDuration}\`

---
_Generated by RacerBot_`.trim();

  return card;
}
