import { getFillsByPosition, getPositionById } from '@racerbot/db';
import { getTokenInfo } from './wallet.js';
import { computePnL } from '@racerbot/shared';
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
  marketCap?: string;
  venue?: string;
  isExternalDeposit: boolean;
  externalDepositDetectedAt?: Date | null;
  totalBuys: number;
  totalSells: number;
  totalFeesPaid: number;
  nearUsd: number;
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
    const tokenInfo = await getTokenInfo(position.token_address, true).catch(() => null);
    const currentPrice = tokenInfo ? parseFloat(tokenInfo.price) : 0;
    const nearUsd = tokenInfo?.near_usd || 4.3;

    // Check if position is external deposit
    const isExternalDeposit = position.is_external_deposit || false;
    const externalDepositDetectedAt = position.external_deposit_detected_at;

    // Calculate total initial investment (excluding external deposits)
    let totalInitialInvestment = 0;
    let totalFeesPaid = 0;
    for (const buy of buys) {
      // Skip synthetic fills from external deposits
      if (buy.tx_hash?.startsWith('deposit_')) continue;

      const amount = parseFloat(buy.amount);
      const price = parseFloat(buy.price);
      const fee = parseFloat(buy.fee_paid || '0');
      totalInitialInvestment += (amount * price) + fee;
      totalFeesPaid += fee;
    }

    // If only external deposit exists, use the entry price as cost basis
    if (totalInitialInvestment === 0 && isExternalDeposit) {
      const quantityHeld = parseFloat(position.quantity_held);
      totalInitialInvestment = quantityHeld * parseFloat(position.avg_entry_price);
    }

    // Calculate realized PNL from sells using FIFO-like approximation
    let totalRealizedPnl = 0;
    let totalRealizedValue = 0;
    let totalRealizedCost = 0;

    for (const sell of sells) {
      const amount = parseFloat(sell.amount);
      const price = parseFloat(sell.price);
      const fee = parseFloat(sell.fee_paid || '0');
      const sellValue = (amount * price) - fee;

      // Use the avg_entry_price at the time of the sell (stored in position)
      // This is an approximation - proper FIFO would require tracking lots
      const avgEntry = parseFloat(position.avg_entry_price);
      const costBasis = amount * avgEntry;
      totalRealizedValue += sellValue;
      totalRealizedCost += costBasis;
      totalFeesPaid += fee;
    }

    totalRealizedPnl = totalRealizedValue - totalRealizedCost;

    const quantityHeld = parseFloat(position.quantity_held);
    const unrealizedValue = quantityHeld * currentPrice;
    const totalValue = unrealizedValue + totalRealizedValue;
    const unrealizedPnl = unrealizedValue - (quantityHeld * parseFloat(position.avg_entry_price));

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
      'nearpad': 'NEARpad',
      'gaypad': 'Gaypad',
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
      unrealizedValue,
      realizedPnl: totalRealizedPnl,
      unrealizedPnl,
      totalPnl,
      pnlPercent,
      isProfit,
      holdDuration,
      positionId,
      positionStatus: position.status as 'open' | 'closed',
      marketCap: marketCapStr,
      venue: venueName,
      isExternalDeposit,
      externalDepositDetectedAt,
      totalBuys: buys.filter(b => !b.tx_hash?.startsWith('deposit_')).length,
      totalSells: sells.length,
      totalFeesPaid,
      nearUsd,
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
  const statusEmoji = data.positionStatus === 'open' ? '🟢' : '🔴';

  // Format USD values
  const formatUSD = (nearValue: number) => {
    const usdValue = nearValue * data.nearUsd;
    if (usdValue >= 1000) return `$${(usdValue / 1000).toFixed(2)}K`;
    if (usdValue >= 1) return `$${usdValue.toFixed(2)}`;
    return `$${usdValue.toFixed(4)}`;
  };

  let card = `
${emoji} *${data.tokenSymbol} PNL CARD* ${statusEmoji}

📝 *Token*: \`${data.tokenName}\`
🔗 *CA*: \`${data.tokenAddress}\`
💧 *Venue*: \`${data.venue || 'Unknown'}\``;

  // External deposit indicator
  if (data.isExternalDeposit) {
    card += `\n� *External Deposit*: Detected`;
  }

  card += `

�💰 *Entry Price*: \`${data.entryPrice.toFixed(8)} NEAR\` (${formatUSD(data.entryPrice)})
💰 *Current Price*: \`${data.currentPrice.toFixed(8)} NEAR\` (${formatUSD(data.currentPrice)})`;

  if (data.marketCap && data.marketCap !== 'N/A') {
    card += `\n📊 *Market Cap*: \`${data.marketCap}\``;
  }

  card += `

📦 *Quantity Held*: \`${data.quantityHeld.toFixed(4)}\`
💵 *Initial Investment*: \`${data.initialInvestment.toFixed(4)} NEAR\` (${formatUSD(data.initialInvestment)})
💵 *Unrealized Value*: \`${data.unrealizedValue.toFixed(4)} NEAR\` (${formatUSD(data.unrealizedValue)})

📊 *Realized PNL*: \`${pnlSign}${data.realizedPnl.toFixed(4)} NEAR\` (${formatUSD(data.realizedPnl)})
📊 *Unrealized PNL*: \`${pnlSign}${data.unrealizedPnl.toFixed(4)} NEAR\` (${formatUSD(data.unrealizedPnl)})
📊 *Total PNL*: \`${pnlSign}${data.totalPnl.toFixed(4)} NEAR\` (${formatUSD(data.totalPnl)}) (\`${pnlSign}${data.pnlPercent.toFixed(2)}%\`)

⏱️ *Hold Duration*: \`${data.holdDuration}\`
🔄 *Trades*: ${data.totalBuys} buys, ${data.totalSells} sells
💸 *Total Fees*: \`${data.totalFeesPaid.toFixed(4)} NEAR\` (${formatUSD(data.totalFeesPaid)})
📌 *Status*: \`${data.positionStatus.toUpperCase()}\``;

  card += `

---
_Generated by RacerBot_`.trim();

  return card;
}

/**
 * Generate PNL card with both image and text
 * Returns image buffer and text message
 */
export async function generatePNLCard(positionId: string): Promise<{ image: Buffer | null; text: string }> {
  const data = await generatePNLCardData(positionId);
  if (!data) {
    return { image: null, text: 'Failed to generate PNL card data.' };
  }

  const text = generatePNLCardMessage(data);
  const image = await generatePNLCardImage(data);

  return { image, text };
}
