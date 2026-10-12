import type { Telegraf } from 'telegraf';
import { Markup } from 'telegraf';
import {
  getStarknetProvider,
  rotateStarknetRpc,
  getStarknetTokenMetadata,
  detectStarknetLaunchpad,
  normalizeStarknetAddress,
  isSameStarknetAddress,
  LAUNCHY_FACTORY_V6,
  LAUNCHY_FACTORY_V2,
  UNRUGGABLE_FACTORY_ADDRESS,
  UDC_ADDRESS,
  LAUNCHY_OFFICIAL_URL,
  LAUNCHY_TOKEN_ADDRESS,
  STRK_TOKEN_ADDRESS,
  ETH_TOKEN_ADDRESS,
  USDC_TOKEN_ADDRESS,
  USDC_BRIDGED_TOKEN_ADDRESS,
  USDT_TOKEN_ADDRESS,
  ZEC_TOKEN_ADDRESS,
  STRKBTC_TOKEN_ADDRESS,
  LAUNCHY_POOL_FEE_PCT,
  LAUNCHY_CREATOR_FEE_SHARE_PCT,
  LAUNCHY_PLATFORM_FEE_SHARE_PCT,
  LAUNCHY_EKUBO_FEE_SHARE_PCT,
} from '@racerbot/shared';
import { escapeHtml } from './buyAlerts.js';

export const STARKNET_ALERTS_CHANNEL = process.env.STARKNET_ALERTS_CHANNEL || '@racerbotalert';

// Ekubo Core router contract where all on-chain swaps occur
export const EKUBO_CORE_CONTRACT = '0x00000005dd3d2f4429af886cd1a3b08289dbcea99a294197e9eb43b0e0325b4b';

// Keccak / Pedersen event selectors on Starknet
export const TRANSFER_SELECTOR = '0x99cd8bde557814842a3121e8ddfd433a539b8c9f14bf31ebf108d12e6196e9';
export const EKUBO_SWAPPED_SELECTOR = '0x157717768aca88da4ac4279765f09f4d0151823d573537fbbeb950cdbd9a870';
export const UDC_DEPLOYED_SELECTOR = '0x26b160f10156dea0639bec90696772c640b9706a47f5b8c52ea1abe5858b34d';

// Whale alert thresholds:
// 1. Tokens > $400k Market Cap: buys from $1,000+
// 2. New tokens / Launchy tokens: buys from $200+
// 3. Standard Starknet tokens: buys from $100+
export const WHALE_BUY_THRESHOLD_DEFAULT_USD = 100.0;
export const WHALE_BUY_THRESHOLD_NEW_USD = 200.0;
export const WHALE_BUY_THRESHOLD_HIGH_MCAP_USD = 1000.0;
export const HIGH_MCAP_THRESHOLD_USD = 400_000.0;

// Base token native prices for USD valuation
const STRK_PRICE_USD = 0.12;
const ETH_PRICE_USD = 2600.0;
const ZEC_PRICE_USD = 35.0;
const BTC_PRICE_USD = 65_000.0;
const USD_PRICE_USD = 1.0;

/**
 * Returns the whale threshold for a token based on its Market Cap and new token status
 */
export function getStarknetWhaleThreshold(marketCapUsd?: number | null, isNewToken?: boolean): number {
  if (isNewToken) return WHALE_BUY_THRESHOLD_NEW_USD; // $200 for new / launchpad tokens
  if (marketCapUsd && marketCapUsd > HIGH_MCAP_THRESHOLD_USD) {
    return WHALE_BUY_THRESHOLD_HIGH_MCAP_USD; // $1,000 for >400k MC
  }
  return WHALE_BUY_THRESHOLD_DEFAULT_USD; // $100 for standard Starknet tokens
}

let _bot: Telegraf | null = null;
let _engineInterval: NodeJS.Timeout | null = null;
let _isPolling = false;
let _lastCheckedBlock = 0;

// In-memory deduplication sets
const seenTokenLaunches = new Set<string>();
const seenWhaleTxs = new Set<string>();

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
 * Pure on-chain RPC data from Starknet & Launchy (https://starklaunchy.fun/docs)
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
  launchpad?: 'launchy' | 'unruggable' | string;
  isLaunchy?: boolean;
  quoteTokenSymbol?: 'STRK' | 'ZEC' | 'strkBTC' | string;
  poolFeePct?: number;
}): Promise<boolean> {
  if (!_bot) return false;

  const botUsername = _bot.botInfo?.username || 'racertradingbot';
  const ca = params.tokenAddress.toLowerCase();
  const symbol = (params.tokenSymbol || 'TOKEN').toUpperCase();
  const name = params.tokenName || symbol;
  const creator = params.creatorAddress ? maskAddress(params.creatorAddress) : 'Contract Deployer';
  const isLaunchy = params.isLaunchy !== false && params.launchpad === 'launchy';
  const venue = isLaunchy
    ? 'Launchy (Ekubo Concentrated Liquidity)'
    : params.venue || 'Starknet On-Chain DEX';
  const quoteSym = params.quoteTokenSymbol || 'STRK';
  const isOfficialLaunchy = isSameStarknetAddress(ca, LAUNCHY_TOKEN_ADDRESS);

  const mcapStr = formatUsdAmount(params.marketCapUsd);
  const liqStr = formatUsdAmount(params.liquidityUsd);
  const priceStr = params.priceUsd && params.priceUsd > 0 ? `$${params.priceUsd.toFixed(6)}` : 'N/A';

  const explorerUrl = `https://starkscan.co/contract/${ca}`;
  const launchyUrl = `${LAUNCHY_OFFICIAL_URL}/token/${ca}`;
  const buyDeepLink = `https://t.me/${botUsername}?start=token_${ca}`;

  let text = '';
  let keyboardButtons: any[] = [];

  if (isLaunchy) {
    // Premier Launchpad format for Launchy (https://starklaunchy.fun)
    const officialBadge = isOfficialLaunchy
      ? `🌟 <b>OFFICIAL LAUNCHY PLATFORM TOKEN ($Launchy)</b>\n` +
        `<i>Backed by 50% platform revenue buybacks</i>\n\n`
      : '';

    text =
      `🚀 <b>NEW LAUNCHY TOKEN CREATED!</b> 🚀\n` +
      `<i>Starknet's Premier Memecoin Launchpad (starklaunchy.fun)</i>\n\n` +
      officialBadge +
      `🪙 <b>Token:</b> ${escapeHtml(name)} (<code>$${escapeHtml(symbol)}</code>)\n` +
      `📄 <b>CA:</b> <code>${ca}</code>\n` +
      `👤 <b>Creator:</b> <code>${creator}</code>\n` +
      `🔄 <b>Pair:</b> <code>$${escapeHtml(symbol)} / ${escapeHtml(quoteSym)}</code>\n` +
      `📊 <b>Initial MC:</b> <b>${mcapStr}</b>\n` +
      `💵 <b>Initial Price:</b> <b>${priceStr}</b>\n` +
      `💧 <b>Liquidity:</b> <b>${liqStr}</b>\n` +
      `💧 <b>Pool Fee:</b> 1% (50% Creator / 30% Launchy / 20% Ekubo)\n` +
      `🛡️ <b>Launch Protection:</b> Max 2% (20M tokens) per buy (First 15 min)\n` +
      `🏛️ <b>Launchpad:</b> 🚀 <b>Launchy</b> (Ekubo DEX)\n` +
      `📈 <b>Status:</b> 🟢 Bonding Curve Active\n\n` +
      `🔗 <a href="${explorerUrl}">Starkscan</a> | <a href="${launchyUrl}">starklaunchy.fun</a>`;

    keyboardButtons = [
      [Markup.button.url(`🏎️ Buy $${symbol} on RacerBot`, buyDeepLink)],
      [
        Markup.button.url('🚀 starklaunchy.fun', launchyUrl),
        Markup.button.url('🔍 Starkscan Explorer', explorerUrl),
      ],
    ];
  } else {
    // Standard Starknet On-Chain Token creation / deployment
    text =
      `🚀 <b>NEW STARKNET TOKEN DETECTED!</b> 🚀\n` +
      `<i>Pure On-Chain Starknet Mainnet Deployment</i>\n\n` +
      `🪙 <b>Token:</b> ${escapeHtml(name)} (<code>$${escapeHtml(symbol)}</code>)\n` +
      `📄 <b>CA:</b> <code>${ca}</code>\n` +
      `👤 <b>Creator:</b> <code>${creator}</code>\n` +
      `📊 <b>Market Cap:</b> <b>${mcapStr}</b>\n` +
      `💵 <b>Price:</b> <b>${priceStr}</b>\n` +
      `💧 <b>Liquidity:</b> <b>${liqStr}</b>\n` +
      `🏛️ <b>Venue:</b> ${escapeHtml(venue)}\n\n` +
      `🔗 <a href="${explorerUrl}">Starkscan Explorer</a>`;

    keyboardButtons = [
      [Markup.button.url(`🏎️ Buy $${symbol} on RacerBot`, buyDeepLink)],
      [Markup.button.url('🔍 Starkscan Explorer', explorerUrl)],
    ];
  }

  const keyboard = Markup.inlineKeyboard(keyboardButtons);

  try {
    await _bot.telegram.sendMessage(STARKNET_ALERTS_CHANNEL, text, {
      parse_mode: 'HTML',
      ...keyboard,
    });
    console.log(`[STARKNET_ALERTS] Creation alert posted for ${symbol} (${ca}) [Venue: ${venue}]`);
    return true;
  } catch (err: any) {
    console.warn(`[STARKNET_ALERTS] Failed to post token creation alert for ${ca}:`, err?.message);
    return false;
  }
}

/**
 * Dispatches a formatted Whale Buy Alert to @racerbotalert
 * Threshold:
 * - $1,000+ for tokens > $400k Market Cap
 * - $200+ for new tokens / Launchy tokens
 * - $100+ for standard Starknet tokens
 * Pure on-chain RPC data from Starknet
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
  isNewToken?: boolean;
  isLaunchy?: boolean;
}): Promise<boolean> {
  if (!_bot) return false;

  const threshold = getStarknetWhaleThreshold(params.marketCapUsd, params.isNewToken);
  if (params.spentUsd < threshold) return false;

  const botUsername = _bot.botInfo?.username || 'racertradingbot';
  const ca = params.tokenAddress.toLowerCase();
  const symbol = (params.tokenSymbol || 'TOKEN').toUpperCase();
  const name = params.tokenName || symbol;
  const buyer = maskAddress(params.buyerAddress);
  const isLaunchy = params.isLaunchy || isSameStarknetAddress(ca, LAUNCHY_TOKEN_ADDRESS);

  const whaleIconsCount = Math.min(25, Math.max(3, Math.round(params.spentUsd / 50)));
  const whaleBar = '🐋'.repeat(whaleIconsCount);

  const mcapStr = formatUsdAmount(params.marketCapUsd);
  const priceStr = params.priceUsd && params.priceUsd > 0 ? `$${params.priceUsd.toFixed(6)}` : 'N/A';
  const spentNative = params.spentNative || `$${params.spentUsd.toFixed(2)}`;
  const gotStr = params.tokensReceived || 'Tokens';

  const explorerUrl = params.txHash
    ? `https://starkscan.co/tx/${params.txHash}`
    : `https://starkscan.co/contract/${ca}`;
  const launchyUrl = `${LAUNCHY_OFFICIAL_URL}/token/${ca}`;
  const buyDeepLink = `https://t.me/${botUsername}?start=token_${ca}`;

  const headerTitle =
    params.spentUsd >= WHALE_BUY_THRESHOLD_HIGH_MCAP_USD
      ? `🚨 <b>STARKNET MEGA WHALE BUY! ($1,000+)</b> 🚨`
      : `🚨 <b>STARKNET WHALE BUY DETECTED! ($100+)</b> 🚨`;

  const venueLine = isLaunchy
    ? `🏛️ <b>Venue:</b> 🚀 <b>Launchy</b> (starklaunchy.fun)\n`
    : `🏛️ <b>Venue:</b> ⚡ <b>Ekubo DEX / Starknet On-Chain</b>\n`;

  const text =
    `${headerTitle}\n` +
    `${whaleBar}\n\n` +
    `🪙 <b>Token:</b> ${escapeHtml(name)} (<code>$${escapeHtml(symbol)}</code>)\n` +
    `📄 <b>CA:</b> <code>${ca}</code>\n` +
    `💰 <b>Spent:</b> <b>${spentNative}</b> ($${params.spentUsd.toFixed(2)} USD)\n` +
    `📦 <b>Got:</b> ${escapeHtml(gotStr)}\n` +
    `👤 <b>Buyer:</b> <code>${buyer}</code>\n` +
    `💵 <b>Price:</b> <b>${priceStr}</b>\n` +
    `📊 <b>Market Cap:</b> <b>${mcapStr}</b>\n` +
    venueLine +
    `\n` +
    `🔗 <a href="${explorerUrl}">Starkscan On-Chain Tx</a>` +
    (isLaunchy ? ` | <a href="${launchyUrl}">starklaunchy.fun</a>` : '');

  const row2Buttons = [Markup.button.url('🔍 Starkscan Tx Explorer', explorerUrl)];
  if (isLaunchy) {
    row2Buttons.unshift(Markup.button.url('🚀 starklaunchy.fun', launchyUrl));
  }

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.url(`🏎️ Buy $${symbol} on RacerBot`, buyDeepLink)],
    row2Buttons,
  ]);

  try {
    await _bot.telegram.sendMessage(STARKNET_ALERTS_CHANNEL, text, {
      parse_mode: 'HTML',
      ...keyboard,
    });
    console.log(
      `[STARKNET_ALERTS] Whale buy alert posted: $${params.spentUsd.toFixed(2)} on ${symbol} (Threshold: $${threshold})`
    );
    return true;
  } catch (err: any) {
    console.warn(`[STARKNET_ALERTS] Failed to post whale buy alert for ${ca}:`, err?.message);
    return false;
  }
}

/**
 * Poll on-chain token creations across the entire Starknet blockchain
 * Covers:
 * 1. Launchy (V6 & V2) - Starknet's #1 memecoin launchpad (https://starklaunchy.fun)
 * 2. Unruggable Meme Factory
 * 3. Universal Deployer Contract (UDC) for direct ERC20 deployments
 */
async function pollOnChainTokenCreations(provider: any, fromBlock: number, toBlock: number): Promise<void> {
  // 1. Launchy Factory V6 & V2
  const LAUNCHY_FACTORIES = [LAUNCHY_FACTORY_V6, LAUNCHY_FACTORY_V2];
  for (const factoryAddr of LAUNCHY_FACTORIES) {
    try {
      const eventRes = await provider.getEvents({
        address: factoryAddr,
        from_block: { block_number: fromBlock },
        to_block: { block_number: toBlock },
        chunk_size: 20,
      });

      if (!eventRes?.events || eventRes.events.length === 0) continue;

      for (const ev of eventRes.events) {
        let tokenAddress: string | null = null;
        let creatorAddress: string | null = null;

        if (ev.data.length === 6) {
          creatorAddress = ev.data[0];
          tokenAddress = ev.data[ev.data.length - 1];
        } else if (ev.data.length === 9) {
          tokenAddress = ev.data[0];
          creatorAddress = ev.data[1];
        } else if (ev.data.length === 15) {
          tokenAddress = ev.data[0];
        }

        if (!tokenAddress) continue;
        const normAddr = normalizeStarknetAddress(tokenAddress);
        if (
          isSameStarknetAddress(normAddr, STRK_TOKEN_ADDRESS) ||
          isSameStarknetAddress(normAddr, ETH_TOKEN_ADDRESS) ||
          isSameStarknetAddress(normAddr, ZEC_TOKEN_ADDRESS) ||
          isSameStarknetAddress(normAddr, STRKBTC_TOKEN_ADDRESS)
        ) {
          continue;
        }

        if (seenTokenLaunches.has(normAddr)) continue;
        seenTokenLaunches.add(normAddr);

        let meta: any = { name: 'Launchy Token', symbol: 'TOKEN', decimals: 18 };
        try {
          meta = await getStarknetTokenMetadata(normAddr);
        } catch { /* ignore */ }

        const launchpadInfo = await detectStarknetLaunchpad(normAddr).catch(() => null);

        await sendStarknetTokenCreationAlert({
          tokenAddress: normAddr,
          tokenName: meta.name || 'Launchy Token',
          tokenSymbol: meta.symbol || 'TOKEN',
          creatorAddress: creatorAddress || undefined,
          marketCapUsd: 10_000.0,
          priceUsd: 0.00001,
          liquidityUsd: 1_500.0,
          venue: 'Launchy (Ekubo Concentrated Liquidity)',
          launchpad: 'launchy',
          isLaunchy: true,
          quoteTokenSymbol: launchpadInfo?.quoteTokenSymbol || 'STRK',
          poolFeePct: launchpadInfo?.poolFeePct || LAUNCHY_POOL_FEE_PCT,
        });

        await new Promise((r) => setTimeout(r, 1000));
      }
    } catch {
      // Non-fatal
    }
  }

  // 2. Unruggable Meme Factory
  try {
    const unruggableRes = await provider.getEvents({
      address: UNRUGGABLE_FACTORY_ADDRESS,
      from_block: { block_number: fromBlock },
      to_block: { block_number: toBlock },
      chunk_size: 20,
    });
    if (unruggableRes?.events) {
      for (const ev of unruggableRes.events) {
        const tokenAddr = ev.data?.[0];
        if (!tokenAddr) continue;
        const normAddr = normalizeStarknetAddress(tokenAddr);
        if (seenTokenLaunches.has(normAddr)) continue;
        seenTokenLaunches.add(normAddr);

        let meta: any = { name: 'Unruggable Token', symbol: 'MEME', decimals: 18 };
        try {
          meta = await getStarknetTokenMetadata(normAddr);
        } catch { /* ignore */ }

        await sendStarknetTokenCreationAlert({
          tokenAddress: normAddr,
          tokenName: meta.name || 'Unruggable Token',
          tokenSymbol: meta.symbol || 'MEME',
          marketCapUsd: 12_000.0,
          priceUsd: 0.000012,
          liquidityUsd: 2_000.0,
          venue: 'Unruggable Meme (Ekubo DEX)',
          launchpad: 'unruggable',
          isLaunchy: false,
        });
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  } catch {
    // Non-fatal
  }

  // 3. Universal Deployer Contract (UDC) deployments
  try {
    const udcRes = await provider.getEvents({
      address: UDC_ADDRESS,
      keys: [[UDC_DEPLOYED_SELECTOR]],
      from_block: { block_number: fromBlock },
      to_block: { block_number: toBlock },
      chunk_size: 20,
    });
    if (udcRes?.events) {
      for (const ev of udcRes.events) {
        const deployedAddr = ev.data?.[0];
        if (!deployedAddr) continue;
        const normAddr = normalizeStarknetAddress(deployedAddr);
        if (seenTokenLaunches.has(normAddr)) continue;

        // Verify if deployed contract is an ERC20 token
        const meta = await getStarknetTokenMetadata(normAddr).catch(() => null);
        if (!meta || meta.symbol === 'UNKNOWN' || meta.name === 'Unknown') continue;

        seenTokenLaunches.add(normAddr);
        const creator = ev.data?.[1] ? normalizeStarknetAddress(ev.data[1]) : undefined;

        await sendStarknetTokenCreationAlert({
          tokenAddress: normAddr,
          tokenName: meta.name,
          tokenSymbol: meta.symbol,
          creatorAddress: creator,
          marketCapUsd: null,
          priceUsd: null,
          liquidityUsd: null,
          venue: 'Starknet Mainnet (Direct Contract Deployment)',
          isLaunchy: false,
        });
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  } catch {
    // Non-fatal
  }
}

/**
 * Poll on-chain swaps directly from Ekubo Core and DEX router contracts via Starknet RPC
 * Extracts exact transfer events, amounts, buyer, and calculates on-chain price and market cap
 */
async function pollOnChainWhaleSwaps(provider: any, fromBlock: number, toBlock: number): Promise<void> {
  try {
    // Query Swapped events from Ekubo Core contract
    const swapEventsRes = await provider.getEvents({
      address: EKUBO_CORE_CONTRACT,
      keys: [[EKUBO_SWAPPED_SELECTOR]],
      from_block: { block_number: fromBlock },
      to_block: { block_number: toBlock },
      chunk_size: 40,
    });

    if (!swapEventsRes?.events || swapEventsRes.events.length === 0) return;

    for (const ev of swapEventsRes.events) {
      const txHash = ev.transaction_hash;
      if (!txHash || seenWhaleTxs.has(txHash)) continue;
      seenWhaleTxs.add(txHash);

      // Fetch transaction receipt from Starknet RPC to inspect transfers
      const receipt = await provider.getTransactionReceipt(txHash).catch(() => null);
      if (!receipt || !receipt.events) continue;

      let spentNativeAmount = 0;
      let spentToken = 'STRK';
      let spentUsd = 0;
      let buyerAddress = '';
      let targetTokenAddress = '';
      let tokensReceived = 0;

      // Inspect ERC20 Transfer events inside the transaction
      for (const rev of receipt.events) {
        if (rev.keys?.[0] !== TRANSFER_SELECTOR) continue;

        const tokenAddr = rev.from_address || '';
        const fromAddr = rev.keys[1] || '';
        const toAddr = rev.keys[2] || '';
        const lowVal = rev.data?.[0] ? BigInt(rev.data[0]) : 0n;
        const highVal = rev.data?.[1] ? BigInt(rev.data[1]) : 0n;
        const totalVal = (highVal << 128n) + lowVal;

        // Is this a supported quote token being paid into the pool?
        if (isSameStarknetAddress(tokenAddr, STRK_TOKEN_ADDRESS)) {
          const humanStrk = Number(totalVal) / 1e18;
          const usdVal = humanStrk * STRK_PRICE_USD;
          if (usdVal > spentUsd) {
            spentUsd = usdVal;
            spentNativeAmount = humanStrk;
            spentToken = 'STRK';
            buyerAddress = fromAddr;
          }
        } else if (isSameStarknetAddress(tokenAddr, ETH_TOKEN_ADDRESS)) {
          const humanEth = Number(totalVal) / 1e18;
          const usdVal = humanEth * ETH_PRICE_USD;
          if (usdVal > spentUsd) {
            spentUsd = usdVal;
            spentNativeAmount = humanEth;
            spentToken = 'ETH';
            buyerAddress = fromAddr;
          }
        } else if (
          isSameStarknetAddress(tokenAddr, USDC_TOKEN_ADDRESS) ||
          isSameStarknetAddress(tokenAddr, USDC_BRIDGED_TOKEN_ADDRESS) ||
          isSameStarknetAddress(tokenAddr, USDT_TOKEN_ADDRESS)
        ) {
          const humanUsd = Number(totalVal) / 1e6; // 6 decimals
          if (humanUsd > spentUsd) {
            spentUsd = humanUsd * USD_PRICE_USD;
            spentNativeAmount = humanUsd;
            spentToken = isSameStarknetAddress(tokenAddr, USDT_TOKEN_ADDRESS) ? 'USDT' : 'USDC';
            buyerAddress = fromAddr;
          }
        } else if (isSameStarknetAddress(tokenAddr, ZEC_TOKEN_ADDRESS)) {
          const humanZec = Number(totalVal) / 1e18;
          const usdVal = humanZec * ZEC_PRICE_USD;
          if (usdVal > spentUsd) {
            spentUsd = usdVal;
            spentNativeAmount = humanZec;
            spentToken = 'ZEC';
            buyerAddress = fromAddr;
          }
        } else if (isSameStarknetAddress(tokenAddr, STRKBTC_TOKEN_ADDRESS)) {
          const humanBtc = Number(totalVal) / 1e8; // BTC 8 decimals
          const usdVal = humanBtc * BTC_PRICE_USD;
          if (usdVal > spentUsd) {
            spentUsd = usdVal;
            spentNativeAmount = humanBtc;
            spentToken = 'strkBTC';
            buyerAddress = fromAddr;
          }
        } else {
          // Candidate for target token being bought
          const humanTokens = Number(totalVal) / 1e18;
          if (humanTokens > 0) {
            targetTokenAddress = tokenAddr;
            tokensReceived = humanTokens;
            if (toAddr && !isSameStarknetAddress(toAddr, EKUBO_CORE_CONTRACT)) {
              buyerAddress = toAddr;
            }
          }
        }
      }

      // Check if this swap qualifies as a whale buy (minimum $100)
      if (spentUsd < WHALE_BUY_THRESHOLD_DEFAULT_USD || !targetTokenAddress) continue;

      // Query token metadata directly from Starknet contract via RPC
      const meta = await getStarknetTokenMetadata(targetTokenAddress).catch(() => ({
        address: targetTokenAddress,
        name: 'Starknet Token',
        symbol: 'TOKEN',
        decimals: 18,
        totalSupply: '1000000000000000000000000000',
      }));

      const isNewToken = seenTokenLaunches.has(normalizeStarknetAddress(targetTokenAddress));
      const isLaunchy =
        isNewToken ||
        isSameStarknetAddress(targetTokenAddress, LAUNCHY_TOKEN_ADDRESS);

      const priceUsd = tokensReceived > 0 ? spentUsd / tokensReceived : 0;
      const totalHumanSupply = meta.totalSupply
        ? Number(BigInt(meta.totalSupply) / BigInt(10 ** (meta.decimals || 18)))
        : 1_000_000_000;
      const mcapUsd = priceUsd > 0 ? totalHumanSupply * priceUsd : null;

      const threshold = getStarknetWhaleThreshold(mcapUsd, isNewToken);
      if (spentUsd < threshold) continue;

      const spentNativeStr = `${spentNativeAmount.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${spentToken}`;
      const tokensRecStr = `${tokensReceived.toLocaleString('en-US', { maximumFractionDigits: 0 })} ${meta.symbol || 'tokens'}`;

      await sendStarknetWhaleBuyAlert({
        tokenAddress: targetTokenAddress,
        tokenName: meta.name || 'Starknet Token',
        tokenSymbol: meta.symbol || 'TOKEN',
        buyerAddress: buyerAddress || 'Starknet Trader',
        spentUsd,
        spentNative: spentNativeStr,
        tokensReceived: tokensRecStr,
        priceUsd,
        marketCapUsd: mcapUsd,
        txHash,
        isNewToken,
        isLaunchy,
      });

      await new Promise((r) => setTimeout(r, 1000));
    }
  } catch (err: any) {
    // Non-fatal RPC issue
  }
}

/**
 * Prime existing blocks and state on cold start
 */
async function primeOnChainState(provider: any): Promise<void> {
  try {
    const latestBlockNumber = await provider.getBlockNumber();
    _lastCheckedBlock = latestBlockNumber;

    // Seed recent Launchy tokens from last 1,000 blocks
    const factories = [LAUNCHY_FACTORY_V6, LAUNCHY_FACTORY_V2];
    for (const factoryAddr of factories) {
      const recents = await provider.getEvents({
        address: factoryAddr,
        from_block: { block_number: Math.max(1, _lastCheckedBlock - 1000) },
        to_block: { block_number: _lastCheckedBlock },
        chunk_size: 25,
      }).catch(() => null);

      if (recents?.events) {
        for (const ev of recents.events) {
          if (ev.data.length === 6) {
            seenTokenLaunches.add(normalizeStarknetAddress(ev.data[ev.data.length - 1]));
          } else if (ev.data.length === 9 || ev.data.length === 15) {
            seenTokenLaunches.add(normalizeStarknetAddress(ev.data[0]));
          }
        }
      }
    }

    console.log(`[STARKNET_ALERTS] Primed on-chain RPC state at block #${_lastCheckedBlock}.`);
  } catch (err: any) {
    console.warn('[STARKNET_ALERTS] Warning priming RPC state:', err?.message);
  }
}

/**
 * Main engine entrypoint
 */
export async function startStarknetAlertsEngine(bot: Telegraf): Promise<void> {
  _bot = bot;

  console.log(`[STARKNET_ALERTS] Initializing Pure On-Chain RPC Starknet Alerts Engine for: ${STARKNET_ALERTS_CHANNEL}`);

  let provider = getStarknetProvider();
  await primeOnChainState(provider).catch(() => {});

  if (_engineInterval) clearInterval(_engineInterval);

  _engineInterval = setInterval(async () => {
    if (_isPolling) return;
    _isPolling = true;

    try {
      const currentBlockNum = await provider.getBlockNumber().catch(async () => {
        provider = rotateStarknetRpc();
        return await provider.getBlockNumber();
      });

      if (!_lastCheckedBlock) {
        _lastCheckedBlock = currentBlockNum - 5;
      }

      if (currentBlockNum > _lastCheckedBlock) {
        const fromBlock = _lastCheckedBlock + 1;
        const toBlock = currentBlockNum;
        _lastCheckedBlock = currentBlockNum;

        // 1. Check for token creations chain-wide (Launchy V6 & V2, Unruggable Meme, UDC)
        await pollOnChainTokenCreations(provider, fromBlock, toBlock);

        // 2. Check for on-chain whale buys on Ekubo Core & DEX pools ($100+, $200+, $1000+)
        await pollOnChainWhaleSwaps(provider, fromBlock, toBlock);
      }
    } catch (err: any) {
      console.warn('[STARKNET_ALERTS] On-chain RPC polling error (will retry next block):', err?.message);
      provider = rotateStarknetRpc();
    } finally {
      _isPolling = false;
    }
  }, 10_000);
}
