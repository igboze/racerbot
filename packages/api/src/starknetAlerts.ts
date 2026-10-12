import type { Telegraf } from 'telegraf';
import { Markup } from 'telegraf';
import {
  getStarknetProvider,
  getStarknetTokenMetadata,
  LAUNCHY_FACTORY_V6,
  STRK_TOKEN_ADDRESS,
  ETH_TOKEN_ADDRESS,
} from '@racerbot/shared';
import { formatPriceUsd, escapeHtml } from './buyAlerts.js';

export const STARKNET_ALERTS_CHANNEL = process.env.STARKNET_ALERTS_CHANNEL || '@racerbotalert';
export const WHALE_BUY_THRESHOLD_USD = 100.0;

let _bot: Telegraf | null = null;
let _engineInterval: NodeJS.Timeout | null = null;
let _isPolling = false;

// In-memory deduplication sets
const seenTokenLaunches = new Set<string>();
const seenWhaleTrades = new Set<string>();

/**
 * Format address nicely for Telegram
 */
function maskAddress(addr: string): string {
  if (!addr) return 'Unknown';
  if (addr.length > 16) {
    return `${addr.slice(0, 8)}...${addr.slice(-6)}`;
  }
  return addr;
}

/**
 * Format USD numbers (e.g. $12.5K or $1.2M)
 */
function formatUsdAmount(val?: number | string | null): string {
  if (val == null) return 'N/A';
  const num = typeof val === 'string' ? parseFloat(val) : val;
  if (isNaN(num) || num <= 0) return 'N/A';
  if (num >= 1_000_000) {
    return `$${(num / 1_000_000).toFixed(2)}M`;
  }
  if (num >= 1_000) {
    return `$${(num / 1_000).toFixed(2)}K`;
  }
  return `$${num.toFixed(2)}`;
}

/**
 * Dispatches a formatted Token Creation Alert to @racerbotalert
 */
export async function sendStarknetTokenCreationAlert(params: {
  tokenAddress: string;
  tokenName: string;
  tokenSymbol: string;
  creatorAddress?: string;
  marketCapUsd?: number | null;
  priceUsd?: number | null;
  liquidityUsd?: number | null;
  venue?: string;
}): Promise<boolean> {
  if (!_bot) return false;

  const botUsername = _bot.botInfo?.username || 'racertradingbot';
  const ca = params.tokenAddress.toLowerCase();
  const symbol = (params.tokenSymbol || 'TOKEN').toUpperCase();
  const name = params.tokenName || symbol;
  const creator = params.creatorAddress ? maskAddress(params.creatorAddress) : 'Contract Deployer';
  const venue = params.venue || 'Starknet DEX';

  const mcapStr = formatUsdAmount(params.marketCapUsd);
  const liqStr = formatUsdAmount(params.liquidityUsd);
  const priceStr = params.priceUsd && params.priceUsd > 0 ? `$${formatPriceUsd(params.priceUsd)}` : 'N/A';

  const explorerUrl = `https://starkscan.co/contract/${ca}`;
  const dexUrl = `https://dexscreener.com/starknet/${ca}`;
  const buyDeepLink = `https://t.me/${botUsername}?start=token_${ca}`;

  const text =
    `🚀 <b>NEW STARKNET TOKEN CREATED!</b> 🚀\n\n` +
    `🪙 <b>Token:</b> ${escapeHtml(name)} (<code>$${escapeHtml(symbol)}</code>)\n` +
    `📄 <b>CA:</b> <code>${ca}</code>\n` +
    `👤 <b>Creator:</b> <code>${creator}</code>\n` +
    `📊 <b>Market Cap:</b> <b>${mcapStr}</b>\n` +
    `💵 <b>Price:</b> <b>${priceStr}</b>\n` +
    `💧 <b>Liquidity:</b> <b>${liqStr}</b>\n` +
    `🏛️ <b>Venue:</b> ${escapeHtml(venue)}\n\n` +
    `🔗 <a href="${explorerUrl}">Starkscan</a> | <a href="${dexUrl}">DexScreener</a>`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.url(`🏎️ Buy $${symbol} on RacerBot`, buyDeepLink)],
    [
      Markup.button.url('🔍 Explorer', explorerUrl),
      Markup.button.url('📈 DexScreener', dexUrl),
    ],
  ]);

  try {
    await _bot.telegram.sendMessage(STARKNET_ALERTS_CHANNEL, text, {
      parse_mode: 'HTML',
      ...keyboard,
    });
    console.log(`[STARKNET_ALERTS] Creation alert posted for ${symbol} (${ca})`);
    return true;
  } catch (err: any) {
    console.warn(`[STARKNET_ALERTS] Failed to post token creation alert for ${ca}:`, err?.message);
    return false;
  }
}

/**
 * Dispatches a formatted Whale Buy Alert ($100+) to @racerbotalert
 */
export async function sendStarknetWhaleBuyAlert(params: {
  tokenAddress: string;
  tokenName: string;
  tokenSymbol: string;
  buyerAddress: string;
  spentUsd: number;
  spentNative?: string;
  tokensReceived?: string;
  priceUsd?: number | null;
  marketCapUsd?: number | null;
  txHash?: string;
}): Promise<boolean> {
  if (!_bot) return false;
  if (params.spentUsd < WHALE_BUY_THRESHOLD_USD) return false;

  const botUsername = _bot.botInfo?.username || 'racertradingbot';
  const ca = params.tokenAddress.toLowerCase();
  const symbol = (params.tokenSymbol || 'TOKEN').toUpperCase();
  const name = params.tokenName || symbol;
  const buyer = maskAddress(params.buyerAddress);

  const whaleIconsCount = Math.min(25, Math.max(3, Math.round(params.spentUsd / 35)));
  const whaleBar = '🐋'.repeat(whaleIconsCount);

  const mcapStr = formatUsdAmount(params.marketCapUsd);
  const priceStr = params.priceUsd && params.priceUsd > 0 ? `$${formatPriceUsd(params.priceUsd)}` : 'N/A';
  const spentNative = params.spentNative || `$${params.spentUsd.toFixed(2)}`;
  const gotStr = params.tokensReceived || 'Tokens';

  const explorerUrl = params.txHash
    ? `https://starkscan.co/tx/${params.txHash}`
    : `https://starkscan.co/contract/${ca}`;
  const dexUrl = `https://dexscreener.com/starknet/${ca}`;
  const buyDeepLink = `https://t.me/${botUsername}?start=token_${ca}`;

  const text =
    `🚨 <b>STARKNET WHALE BUY DETECTED!</b> 🚨\n` +
    `${whaleBar}\n\n` +
    `🪙 <b>Token:</b> ${escapeHtml(name)} (<code>$${escapeHtml(symbol)}</code>)\n` +
    `📄 <b>CA:</b> <code>${ca}</code>\n` +
    `💰 <b>Spent:</b> <b>${spentNative}</b> ($${params.spentUsd.toFixed(2)} USD)\n` +
    `📦 <b>Got:</b> ${escapeHtml(gotStr)}\n` +
    `👤 <b>Buyer:</b> <code>${buyer}</code>\n` +
    `💵 <b>Price:</b> <b>${priceStr}</b>\n` +
    `📊 <b>Market Cap:</b> <b>${mcapStr}</b>\n\n` +
    `🔗 <a href="${explorerUrl}">Starkscan</a> | <a href="${dexUrl}">DexScreener</a>`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.url(`🏎️ Buy $${symbol} on RacerBot`, buyDeepLink)],
    [
      Markup.button.url('🔍 Tx Explorer', explorerUrl),
      Markup.button.url('📈 DexScreener', dexUrl),
    ],
  ]);

  try {
    await _bot.telegram.sendMessage(STARKNET_ALERTS_CHANNEL, text, {
      parse_mode: 'HTML',
      ...keyboard,
    });
    console.log(`[STARKNET_ALERTS] Whale buy alert posted: $${params.spentUsd.toFixed(2)} on ${symbol}`);
    return true;
  } catch (err: any) {
    console.warn(`[STARKNET_ALERTS] Failed to post whale buy alert for ${ca}:`, err?.message);
    return false;
  }
}

/**
 * Scan for newly created pools and tokens on Starknet
 */
async function pollNewTokenCreations(): Promise<void> {
  try {
    const res: any = await fetch(
      'https://api.geckoterminal.com/api/v2/networks/starknet-alpha/new_pools?include=base_token,quote_token,dex',
      { headers: { Accept: 'application/json' } }
    ).then((r) => r.json()).catch(() => null);

    if (!res?.data || !Array.isArray(res.data)) return;

    const includedMap = new Map<string, any>(
      (res.included || []).map((item: any) => [item.id, item])
    );

    for (const pool of res.data) {
      const baseId = pool.relationships?.base_token?.data?.id;
      const baseToken = includedMap.get(baseId)?.attributes;
      if (!baseToken?.address) continue;

      const tokenAddress = baseToken.address.toLowerCase();

      // Skip common native / wrapped tokens
      if (
        tokenAddress === STRK_TOKEN_ADDRESS.toLowerCase() ||
        tokenAddress === ETH_TOKEN_ADDRESS.toLowerCase()
      ) {
        continue;
      }

      // If already alerted, continue
      if (seenTokenLaunches.has(tokenAddress)) continue;
      seenTokenLaunches.add(tokenAddress);

      const dexName = includedMap.get(pool.relationships?.dex?.data?.id)?.attributes?.name || 'Starknet DEX';
      const mcapUsd = pool.attributes?.fdv_usd
        ? parseFloat(pool.attributes.fdv_usd)
        : pool.attributes?.market_cap_usd
        ? parseFloat(pool.attributes.market_cap_usd)
        : null;
      const priceUsd = pool.attributes?.base_token_price_usd
        ? parseFloat(pool.attributes.base_token_price_usd)
        : null;
      const liquidityUsd = pool.attributes?.reserve_in_usd
        ? parseFloat(pool.attributes.reserve_in_usd)
        : null;

      // Resolve creator via on-chain metadata or default
      let creatorAddress = 'Launchpad Pool';
      try {
        const meta = await getStarknetTokenMetadata(tokenAddress);
        if (meta.name) baseToken.name = meta.name;
        if (meta.symbol) baseToken.symbol = meta.symbol;
      } catch { /* ignore */ }

      await sendStarknetTokenCreationAlert({
        tokenAddress,
        tokenName: baseToken.name || 'New Token',
        tokenSymbol: baseToken.symbol || 'TOKEN',
        creatorAddress,
        marketCapUsd: mcapUsd,
        priceUsd,
        liquidityUsd,
        venue: dexName,
      });

      // Brief delay to respect Telegram flood limits
      await new Promise((r) => setTimeout(r, 1200));
    }
  } catch (err: any) {
    console.warn('[STARKNET_ALERTS] pollNewTokenCreations error:', err?.message);
  }
}

/**
 * Scan for whale buy trades ($100+) on active Starknet pools
 */
async function pollWhaleBuys(): Promise<void> {
  try {
    const trendingRes: any = await fetch(
      'https://api.geckoterminal.com/api/v2/networks/starknet-alpha/trending_pools?include=base_token',
      { headers: { Accept: 'application/json' } }
    ).then((r) => r.json()).catch(() => null);

    const pools: any[] = Array.isArray(trendingRes?.data) ? trendingRes.data.slice(0, 10) : [];
    if (pools.length === 0) return;

    const includedMap = new Map<string, any>(
      (trendingRes.included || []).map((item: any) => [item.id, item])
    );

    for (const pool of pools) {
      const poolAddr = pool.attributes?.address;
      if (!poolAddr) continue;

      const baseId = pool.relationships?.base_token?.data?.id;
      const baseToken = includedMap.get(baseId)?.attributes;
      const tokenAddress = (baseToken?.address || '').toLowerCase();
      if (!tokenAddress) continue;

      // Skip native pair buy alerts (e.g. buying STRK with ETH) unless it's a meme/alt token
      const isAltToken =
        tokenAddress !== STRK_TOKEN_ADDRESS.toLowerCase() &&
        tokenAddress !== ETH_TOKEN_ADDRESS.toLowerCase();

      const tradesRes: any = await fetch(
        `https://api.geckoterminal.com/api/v2/networks/starknet-alpha/pools/${poolAddr}/trades`,
        { headers: { Accept: 'application/json' } }
      ).then((r) => r.json()).catch(() => null);

      if (!tradesRes?.data || !Array.isArray(tradesRes.data)) continue;

      const trades: any[] = tradesRes.data;
      for (const trade of trades) {
        const attr = trade.attributes;
        if (!attr || attr.kind !== 'buy') continue;

        const volumeUsd = parseFloat(attr.volume_in_usd || '0');
        if (isNaN(volumeUsd) || volumeUsd < WHALE_BUY_THRESHOLD_USD) continue;

        const tradeKey = attr.tx_hash || trade.id;
        if (!tradeKey || seenWhaleTrades.has(tradeKey)) continue;
        seenWhaleTrades.add(tradeKey);

        const buyerAddress = attr.tx_from_address || 'Anonymous Whale';
        const fromAmount = attr.from_token_amount ? `${parseFloat(attr.from_token_amount).toLocaleString('en-US', { maximumFractionDigits: 2 })} STRK` : `$${volumeUsd.toFixed(2)}`;
        const toAmount = attr.to_token_amount ? `${parseFloat(attr.to_token_amount).toLocaleString('en-US', { maximumFractionDigits: 0 })} ${baseToken?.symbol || 'tokens'}` : 'Tokens';
        const priceUsd = attr.price_to_in_usd ? parseFloat(attr.price_to_in_usd) : null;
        const mcapUsd = pool.attributes?.fdv_usd ? parseFloat(pool.attributes.fdv_usd) : null;

        await sendStarknetWhaleBuyAlert({
          tokenAddress: isAltToken ? tokenAddress : (attr.to_token_address || tokenAddress),
          tokenName: baseToken?.name || 'Starknet Token',
          tokenSymbol: baseToken?.symbol || 'TOKEN',
          buyerAddress,
          spentUsd: volumeUsd,
          spentNative: fromAmount,
          tokensReceived: toAmount,
          priceUsd,
          marketCapUsd: mcapUsd,
          txHash: attr.tx_hash,
        });

        // Delay between posts
        await new Promise((r) => setTimeout(r, 1200));
      }
    }
  } catch (err: any) {
    console.warn('[STARKNET_ALERTS] pollWhaleBuys error:', err?.message);
  }
}

/**
 * Prime existing tokens into seen set on cold start so we don't replay history
 */
async function primeHistoricalDeduplication(): Promise<void> {
  try {
    const res: any = await fetch(
      'https://api.geckoterminal.com/api/v2/networks/starknet-alpha/new_pools?include=base_token',
      { headers: { Accept: 'application/json' } }
    ).then((r) => r.json()).catch(() => null);

    if (res?.data && Array.isArray(res.data)) {
      const incMap = new Map((res.included || []).map((x: any) => [x.id, x]));
      for (const p of res.data) {
        const bId = p.relationships?.base_token?.data?.id;
        const bAddr = (incMap.get(bId) as any)?.attributes?.address;
        if (bAddr) seenTokenLaunches.add(bAddr.toLowerCase());
      }
    }

    // Also prime initial trades so we only alert fresh buys
    const trending: any = await fetch(
      'https://api.geckoterminal.com/api/v2/networks/starknet-alpha/trending_pools',
      { headers: { Accept: 'application/json' } }
    ).then((r) => r.json()).catch(() => null);

    if (trending?.data && Array.isArray(trending.data)) {
      for (const pool of trending.data.slice(0, 5)) {
        const addr = pool.attributes?.address;
        if (!addr) continue;
        const tr: any = await fetch(
          `https://api.geckoterminal.com/api/v2/networks/starknet-alpha/pools/${addr}/trades`,
          { headers: { Accept: 'application/json' } }
        ).then((r) => r.json()).catch(() => null);

        if (tr?.data && Array.isArray(tr.data)) {
          for (const t of tr.data) {
            const key = t.attributes?.tx_hash || t.id;
            if (key) seenWhaleTrades.add(key);
          }
        }
      }
    }

    console.log(
      `[STARKNET_ALERTS] Primed historical deduplication: ${seenTokenLaunches.size} tokens, ${seenWhaleTrades.size} trades.`
    );
  } catch (err: any) {
    console.warn('[STARKNET_ALERTS] Error priming history:', err?.message);
  }
}

/**
 * Main engine entrypoint
 */
export async function startStarknetAlertsEngine(bot: Telegraf): Promise<void> {
  _bot = bot;

  console.log(`[STARKNET_ALERTS] Initializing Starknet Alerts Engine for channel: ${STARKNET_ALERTS_CHANNEL}`);

  // Prime current tokens to prevent cold start blast
  await primeHistoricalDeduplication().catch(() => {});

  // Run poll loop every 15 seconds
  if (_engineInterval) clearInterval(_engineInterval);

  _engineInterval = setInterval(async () => {
    if (_isPolling) return;
    _isPolling = true;
    try {
      await pollNewTokenCreations();
      await pollWhaleBuys();
    } catch (err: any) {
      console.warn('[STARKNET_ALERTS] Polling cycle error:', err?.message);
    } finally {
      _isPolling = false;
    }
  }, 15_000);

  // Trigger first check immediately in background
  setTimeout(() => {
    void pollNewTokenCreations();
    void pollWhaleBuys();
  }, 2_000);
}
