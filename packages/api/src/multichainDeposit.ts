import QRCode from 'qrcode';
import { createLogger } from '@racerbot/shared';
import {
  createRacerDeposit,
  updateRacerDeposit,
  getRacerDepositById,
  getActiveRacerDeposits,
  getUserByTelegramId,
  type RacerDepositRecord,
} from '@racerbot/db';
import { unwrapUserWrapNear } from './wallet.js';
import { suppressDepositAlert } from './notify.js';
import type { Telegraf } from 'telegraf';

const logger = createLogger('multichain-deposit');

export interface OneClickToken {
  key: string;
  blockchain: string;
  symbol: string;
  name?: string;
  assetId: string;
  decimals: number;
  price?: number;
  contractAddress?: string;
}

export interface SupportedChain {
  id: string;
  name: string;
  icon: string;
  category: 'popular' | 'evm' | 'alt_l1' | 'other';
  nativeSymbol: string;
  nativeDecimals: number;
}

export const SUPPORTED_CHAINS: Record<string, SupportedChain> = {
  sol: { id: 'sol', name: 'Solana', icon: '🟣', category: 'popular', nativeSymbol: 'SOL', nativeDecimals: 9 },
  eth: { id: 'eth', name: 'Ethereum', icon: '🔷', category: 'popular', nativeSymbol: 'ETH', nativeDecimals: 18 },
  btc: { id: 'btc', name: 'Bitcoin', icon: '🟠', category: 'popular', nativeSymbol: 'BTC', nativeDecimals: 8 },
  base: { id: 'base', name: 'Base', icon: '🔵', category: 'popular', nativeSymbol: 'ETH', nativeDecimals: 18 },
  bsc: { id: 'bsc', name: 'BNB Chain', icon: '🟡', category: 'popular', nativeSymbol: 'BNB', nativeDecimals: 18 },
  sui: { id: 'sui', name: 'Sui Network', icon: '💧', category: 'popular', nativeSymbol: 'SUI', nativeDecimals: 9 },
  tron: { id: 'tron', name: 'TRON', icon: '🔴', category: 'popular', nativeSymbol: 'TRX', nativeDecimals: 6 },
  arb: { id: 'arb', name: 'Arbitrum One', icon: '🔷', category: 'evm', nativeSymbol: 'ETH', nativeDecimals: 18 },
  pol: { id: 'pol', name: 'Polygon', icon: '🟣', category: 'evm', nativeSymbol: 'POL', nativeDecimals: 18 },
  op: { id: 'op', name: 'Optimism', icon: '🔴', category: 'evm', nativeSymbol: 'ETH', nativeDecimals: 18 },
  avax: { id: 'avax', name: 'Avalanche C-Chain', icon: '🔺', category: 'evm', nativeSymbol: 'AVAX', nativeDecimals: 18 },
  starknet: { id: 'starknet', name: 'Starknet', icon: '✨', category: 'evm', nativeSymbol: 'STRK', nativeDecimals: 18 },
  gnosis: { id: 'gnosis', name: 'Gnosis', icon: '🦉', category: 'evm', nativeSymbol: 'xDAI', nativeDecimals: 18 },
  scroll: { id: 'scroll', name: 'Scroll', icon: '📜', category: 'evm', nativeSymbol: 'ETH', nativeDecimals: 18 },
  monad: { id: 'monad', name: 'Monad', icon: '🟣', category: 'evm', nativeSymbol: 'MON', nativeDecimals: 18 },
  bera: { id: 'bera', name: 'Berachain', icon: '🐻', category: 'evm', nativeSymbol: 'BERA', nativeDecimals: 18 },
  aleo: { id: 'aleo', name: 'Aleo', icon: '🛡️', category: 'evm', nativeSymbol: 'ALEO', nativeDecimals: 6 },
  movement: { id: 'movement', name: 'Movement', icon: '⚡', category: 'evm', nativeSymbol: 'MOVE', nativeDecimals: 8 },
  hood: { id: 'hood', name: 'Robinhood Chain', icon: '🏹', category: 'evm', nativeSymbol: 'ETH', nativeDecimals: 18 },
  xlayer: { id: 'xlayer', name: 'X Layer', icon: '⬛', category: 'evm', nativeSymbol: 'OKB', nativeDecimals: 18 },
  fogo: { id: 'fogo', name: 'Fogo', icon: '🔥', category: 'evm', nativeSymbol: 'FOGO', nativeDecimals: 18 },
  abs: { id: 'abs', name: 'Abstract', icon: '🟩', category: 'evm', nativeSymbol: 'ETH', nativeDecimals: 18 },
  ton: { id: 'ton', name: 'TON', icon: '💎', category: 'alt_l1', nativeSymbol: 'TON', nativeDecimals: 9 },
  aptos: { id: 'aptos', name: 'Aptos', icon: '🌐', category: 'alt_l1', nativeSymbol: 'APT', nativeDecimals: 8 },
  doge: { id: 'doge', name: 'Dogecoin', icon: '🐕', category: 'other', nativeSymbol: 'DOGE', nativeDecimals: 8 },
  xrp: { id: 'xrp', name: 'Ripple XRP', icon: '🪙', category: 'other', nativeSymbol: 'XRP', nativeDecimals: 6 },
  cardano: { id: 'cardano', name: 'Cardano', icon: '🔷', category: 'alt_l1', nativeSymbol: 'ADA', nativeDecimals: 6 },
  stellar: { id: 'stellar', name: 'Stellar', icon: '🚀', category: 'alt_l1', nativeSymbol: 'XLM', nativeDecimals: 7 },
  ltc: { id: 'ltc', name: 'Litecoin', icon: '🪙', category: 'other', nativeSymbol: 'LTC', nativeDecimals: 8 },
  bch: { id: 'bch', name: 'Bitcoin Cash', icon: '🟢', category: 'other', nativeSymbol: 'BCH', nativeDecimals: 8 },
  dash: { id: 'dash', name: 'Dash', icon: '💨', category: 'other', nativeSymbol: 'DASH', nativeDecimals: 8 },
  zec: { id: 'zec', name: 'Zcash', icon: '🛡️', category: 'other', nativeSymbol: 'ZEC', nativeDecimals: 8 },
  adi: { id: 'adi', name: 'Adiri', icon: '🌟', category: 'alt_l1', nativeSymbol: 'ADI', nativeDecimals: 18 },
  qtc: { id: 'qtc', name: 'Qitmeer', icon: '🌙', category: 'other', nativeSymbol: 'QTC', nativeDecimals: 18 },
  plasma: { id: 'plasma', name: 'Plasma', icon: '⚡', category: 'evm', nativeSymbol: 'XPL', nativeDecimals: 18 },
  hypercore: { id: 'hypercore', name: 'Hypercore', icon: '⚡', category: 'alt_l1', nativeSymbol: 'USDC', nativeDecimals: 6 },
  near: { id: 'near', name: 'NEAR Protocol', icon: '⬛', category: 'popular', nativeSymbol: 'wNEAR', nativeDecimals: 24 },
};

// ── In-Memory Token Registry ────────────────────────────────────────────────
const tokenKeyMap = new Map<string, OneClickToken>();
const tokensByChain = new Map<string, OneClickToken[]>();

const NEAR_INTENTS_API_URL = process.env.NEAR_INTENTS_API_URL || 'https://1click.chaindefuser.com';
const NEAR_INTENTS_API_KEY = process.env.NEAR_INTENTS_API_KEY || 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6IjIwMjUtMDEtMTItdjEifQ.eyJ2IjoxLCJrZXlfdHlwZSI6ImRpc3RyaWJ1dGlvbl9jaGFubmVsIiwicGFydG5lcl9pZCI6InBheWl0IiwiaWF0IjoxNzkyMjAxMjY3LCJleHAiOjE4MjM3MzcyNjd9.Xx-_Xhp8UT138O2pc-MfBotKF_6bCwPNRSjuHgHyVC-cLLWYc6_vYxuuLfZ5ZhIO-n7rvQfFGhL4YXJV-cQ9jae6hFG8b7cuXbvE_Q7ZX57MkyX2qELHQw7r3PqDbOTXfTMlhw7PBDAnBV79h3Lh8ebQU4M-2rKo5dlru4whqjNNyU1jcXr6Z5VQHx1xPFtdiilDAhXbG4N7qfQNY15bp-XqBaewMpgSiUhFNvicXWKKcsTQlkhDa6cGpCI_dRto_mNMJoeZaDVA4nhE9Mxxi8cOIo9_at3dBP6p9p63iBWqFbDRwvODt1gq4sggCHzxROq5Y6IAnDMw8ECRc8rEDw';
const RACER_FEE_RECIPIENT = process.env.RACER_FEE_RECIPIENT || process.env.TREASURY_ACCOUNT_ID || 'wild-falcon-5130.racerbot.near';
const RACER_FEE_BPS = parseInt(process.env.RACER_FEE_BPS || '100', 10);

/**
 * Fetch and register all tokens supported by NEAR Intents (1Click)
 */
export async function refresh1ClickTokens(): Promise<void> {
  try {
    const res = await fetch(`${NEAR_INTENTS_API_URL}/v0/tokens`, {
      headers: {
        ...(NEAR_INTENTS_API_KEY ? { Authorization: `Bearer ${NEAR_INTENTS_API_KEY}` } : {}),
      },
    });

    if (!res.ok) {
      logger.warn(`Failed to fetch 1Click tokens list (${res.status})`);
      return;
    }

    const rawList: any = await res.json();
    if (!Array.isArray(rawList)) return;

    tokenKeyMap.clear();
    tokensByChain.clear();

    let counter = 0;
    for (const item of rawList) {
      const ch = (item.blockchain || '').toLowerCase();
      const key = String(counter++);
      const tok: OneClickToken = {
        key,
        blockchain: ch,
        symbol: item.symbol || 'TOKEN',
        name: item.name,
        assetId: item.assetId,
        decimals: typeof item.decimals === 'number' ? item.decimals : 18,
        price: typeof item.price === 'number' ? item.price : undefined,
        contractAddress: item.contractAddress,
      };

      tokenKeyMap.set(key, tok);

      const list = tokensByChain.get(ch) || [];
      list.push(tok);
      tokensByChain.set(ch, list);
    }

    logger.info(`Registered ${tokenKeyMap.size} tokens across ${tokensByChain.size} chains from 1Click Solver`);
  } catch (err: any) {
    logger.warn(`Failed to refresh 1Click tokens: ${err.message}`);
  }
}

// Initial prefetch on startup
refresh1ClickTokens().catch(() => {});
// Refresh every 15 minutes
setInterval(() => refresh1ClickTokens().catch(() => {}), 15 * 60 * 1000);


export interface MinimumDepositInfo {
  amount: number;
  formatted: string;
  usdEstimated?: string;
  example: string;
}

/**
 * Calculate the lowest deposit amount allowed by NEAR Intents solver
 */
export function getMinimumDeposit(token: OneClickToken): MinimumDepositInfo {
  const sym = (token.symbol || '').toUpperCase();
  const ch = (token.blockchain || '').toLowerCase();

  // Known hard solver minimums from 1Click
  if (sym === 'BTC' || token.assetId.includes('btc.omft')) {
    return {
      amount: 0.000065,
      formatted: '0.000065 BTC',
      usdEstimated: '~$5.30 USD',
      example: '0.0001',
    };
  }

  if (sym === 'SOL' || token.assetId.includes('sol.omft')) {
    // 890,880 lamports = ~0.000891 SOL
    return {
      amount: 0.0009,
      formatted: '0.0009 SOL',
      usdEstimated: '~$0.10 USD',
      example: '0.05',
    };
  }

  if (sym === 'XRP') {
    // 2,000,000 drops = 2.0 XRP
    return {
      amount: 2.0,
      formatted: '2.0 XRP',
      usdEstimated: '~$1.00 USD',
      example: '10',
    };
  }

  if (ch === 'tron' && sym === 'TRX') {
    return {
      amount: 400.0,
      formatted: '400 TRX',
      usdEstimated: '~$100 USD (Temporary Solver Limit)',
      example: '450',
    };
  }

  if (sym === 'ETH') {
    return {
      amount: 0.0001,
      formatted: '0.0001 ETH',
      usdEstimated: '~$0.25 USD',
      example: '0.01',
    };
  }

  // Stablecoins
  if (sym === 'USDC' || sym === 'USDT' || sym === 'DAI' || sym === 'USDE' || sym === 'USDD' || sym.endsWith('USD')) {
    return {
      amount: 0.50,
      formatted: `0.50 ${token.symbol}`,
      usdEstimated: '~$0.50 USD',
      example: '25',
    };
  }

  // Priced tokens: calibrate minimum to roughly ~$0.50 USD
  if (token.price && token.price > 0) {
    const rawMin = 0.5 / token.price;
    let minAmt: number;
    let formatted: string;
    let example: string;

    if (rawMin < 0.0001) {
      minAmt = Number(rawMin.toPrecision(2));
      formatted = `${minAmt} ${token.symbol}`;
      example = (minAmt * 10).toString();
    } else if (rawMin < 1) {
      minAmt = Math.ceil(rawMin * 100) / 100;
      formatted = `${minAmt} ${token.symbol}`;
      example = (minAmt * 5).toFixed(2);
    } else if (rawMin < 10) {
      minAmt = Math.ceil(rawMin * 10) / 10;
      formatted = `${minAmt} ${token.symbol}`;
      example = Math.ceil(minAmt * 5).toString();
    } else {
      minAmt = Math.ceil(rawMin);
      formatted = `${minAmt} ${token.symbol}`;
      example = (minAmt * 5).toString();
    }

    const usdVal = (minAmt * token.price).toFixed(2);
    return {
      amount: minAmt,
      formatted,
      usdEstimated: `~${usdVal} USD`,
      example,
    };
  }

  // Fallback defaults
  return {
    amount: 0.1,
    formatted: `0.1 ${token.symbol}`,
    example: '1.0',
  };
}

export function getAmountSuggestions(token: OneClickToken, minAmount: number): string[] {
  const sym = (token.symbol || '').toUpperCase();
  if (sym === 'BTC') {
    return ['0.0001', '0.0005', '0.001', '0.0025', '0.005', '0.01'];
  }
  if (sym === 'SOL') {
    return ['0.01', '0.05', '0.1', '0.25', '0.5', '1.0'];
  }
  if (sym === 'ETH') {
    return ['0.001', '0.005', '0.01', '0.025', '0.05', '0.1'];
  }
  if (sym === 'USDC' || sym === 'USDT' || sym.endsWith('USD')) {
    return ['5', '10', '25', '50', '100', '250'];
  }
  if (token.price) {
    if (token.price > 1000) {
      return ['0.001', '0.005', '0.01', '0.025', '0.05', '0.1'];
    }
    if (token.price > 100) {
      return ['0.01', '0.05', '0.1', '0.25', '0.5', '1.0'];
    }
    if (token.price > 10) {
      return ['0.5', '1.0', '2.5', '5.0', '10', '25'];
    }
    if (token.price >= 0.5) {
      return ['5', '10', '25', '50', '100', '250'];
    }
    if (token.price < 0.001) {
      return ['1000', '5000', '10000', '50000', '100000', '500000'];
    }
  }
  // Default based on minAmount
  const base = Math.max(minAmount * 2, 1);
  return [
    (base).toFixed(base < 1 ? 2 : 0),
    (base * 2.5).toFixed(base < 1 ? 2 : 0),
    (base * 5).toFixed(base < 1 ? 2 : 0),
    (base * 10).toFixed(base < 1 ? 2 : 0),
    (base * 25).toFixed(base < 1 ? 2 : 0),
    (base * 50).toFixed(base < 1 ? 2 : 0),
  ];
}

export function getTokenByKey(key: string): OneClickToken | undefined {
  return tokenKeyMap.get(key);
}

export function getTokensForChain(chainId: string): OneClickToken[] {
  const ch = chainId.toLowerCase();
  const list = tokensByChain.get(ch) || [];
  if (list.length > 0) return list;

  // Fallback defaults if API not yet populated
  const chain = SUPPORTED_CHAINS[ch];
  if (!chain) return [];

  const defaultKey = `def_${ch}`;
  const defToken: OneClickToken = {
    key: defaultKey,
    blockchain: ch,
    symbol: chain.nativeSymbol,
    assetId: ch === 'sol' ? 'nep141:sol.omft.near' : `${ch}:native`,
    decimals: chain.nativeDecimals,
  };
  tokenKeyMap.set(defaultKey, defToken);
  return [defToken];
}

/**
 * Generate deep-link for instant mobile wallet open
 */
export function generateWalletDeepLink(chain: string, address: string, amount?: number | string): string {
  const c = SUPPORTED_CHAINS[chain.toLowerCase()];
  if (!c) return '';
  const amtStr = amount ? String(amount) : '';

  switch (c.id) {
    case 'sol':
      return amtStr ? `solana:${address}?amount=${amtStr}` : `solana:${address}`;
    case 'eth':
    case 'base':
    case 'bsc':
    case 'arb':
    case 'pol':
    case 'op':
    case 'avax':
    case 'scroll':
    case 'gnosis':
    case 'monad':
    case 'bera':
      return amtStr ? `ethereum:${address}?value=${amtStr}` : `ethereum:${address}`;
    case 'btc':
      return amtStr ? `bitcoin:${address}?amount=${amtStr}` : `bitcoin:${address}`;
    case 'tron':
      return `tron:${address}`;
    default:
      return '';
  }
}

/**
 * Generate QR code buffer for deposit address
 */
export async function generateQrBuffer(text: string): Promise<Buffer> {
  return await QRCode.toBuffer(text, {
    errorCorrectionLevel: 'M',
    type: 'png',
    margin: 2,
    width: 400,
    color: {
      dark: '#000000',
      light: '#ffffff',
    },
  });
}

/**
 * Request a 1Click Multi-chain Deposit Quote
 */
export async function create1ClickDepositQuote(params: {
  telegramId: number;
  subaccountId: string;
  token: OneClickToken;
  amount: number;
}): Promise<RacerDepositRecord> {
  const token = params.token;
  const user = await getUserByTelegramId(params.telegramId);

  // Calculate raw base units (e.g. 1 SOL = 1000000000)
  const decimals = token.decimals;
  const rawUnits = BigInt(Math.floor(params.amount * Math.pow(10, Math.min(decimals, 18)))).toString();

  const deadline = new Date(Date.now() + 30 * 60 * 1000).toISOString();

  const payload = {
    dry: false,
    swapType: 'EXACT_INPUT',
    slippageTolerance: 100, // 1%
    originAsset: token.assetId,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: 'nep141:wrap.near',
    amount: rawUnits,
    recipient: params.subaccountId,
    recipientType: 'DESTINATION_CHAIN',
    refundTo: params.subaccountId,
    refundType: 'INTENTS',
    deadline,
    appFees: [
      {
        recipient: RACER_FEE_RECIPIENT,
        fee: RACER_FEE_BPS, // 100 bps
      },
    ],
  };

  logger.info(`Requesting 1Click deposit quote: chain=${token.blockchain} asset=${token.assetId} amt=${rawUnits} tg=${params.telegramId}`);

  let quoteData: any;
  let depositAddress = '';
  let minNearOut: number | undefined;

  try {
    const res = await fetch(`${NEAR_INTENTS_API_URL}/v0/quote`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(NEAR_INTENTS_API_KEY ? { Authorization: `Bearer ${NEAR_INTENTS_API_KEY}` } : {}),
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text();
      logger.error(`1Click quote API error (${res.status}): ${errText}`);

      const matchBridgeMin = errText.match(/try at least (\d+)/i);
      if (matchBridgeMin) {
        const minRaw = BigInt(matchBridgeMin[1]);
        const minHuman = Number(minRaw) / Math.pow(10, token.decimals);
        throw new Error(`Amount is below NEAR Intents bridge minimum. The lowest deposit amount for ${token.symbol} is ${minHuman} ${token.symbol}.`);
      }
      if (errText.includes('Temporary swap limits') || errText.includes('minimum swap amount')) {
        throw new Error(`NEAR Intents Solver has a temporary minimum swap limit of $100 for ${token.symbol}.`);
      }
      if (errText.includes('No liquidity')) {
        throw new Error(`No solver liquidity route currently available for ${token.symbol} at this amount. Please try a higher amount or another token.`);
      }

      throw new Error(`1Click Solver error: ${errText || res.statusText}`);
    }

    const data: any = await res.json();
    quoteData = data.quote || data;
    depositAddress = quoteData.depositAddress || quoteData.address || data.depositAddress;

    if (quoteData.amountOutFormatted) {
      minNearOut = parseFloat(quoteData.amountOutFormatted);
    } else if (quoteData.amountOut || quoteData.minAmountOut) {
      const out = quoteData.amountOut || quoteData.minAmountOut;
      try {
        minNearOut = Number(BigInt(out) / 1000000000000000000n) / 1e6;
      } catch {
        minNearOut = parseFloat(out) / 1e24;
      }
    }
  } catch (err: any) {
    if (err.message && (err.message.includes('bridge minimum') || err.message.includes('minimum swap limit') || err.message.includes('liquidity') || err.message.includes('1Click Solver error'))) {
      throw err;
    }
    logger.error(`1Click live quote failed: ${err.message}`);
    throw err;
  }

  const depositId = quoteData.correlationId || quoteData.depositId || `racer_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  const record = await createRacerDeposit({
    deposit_id: depositId,
    user_id: user?.id,
    telegram_id: params.telegramId,
    subaccount_id: params.subaccountId,
    source_chain: token.blockchain,
    source_asset: token.assetId,
    source_symbol: token.symbol,
    source_amount: params.amount,
    destination_chain: 'near',
    destination_asset: 'nep141:wrap.near',
    destination_symbol: 'NEAR',
    destination_address: params.subaccountId,
    deposit_address: depositAddress,
    min_destination_amount: minNearOut,
    fee_recipient: RACER_FEE_RECIPIENT,
    fee_bps: RACER_FEE_BPS,
    status: 'PENDING',
    quote_data: quoteData,
  });

  return record;
}

/**
 * Check execution status of a deposit
 */
export async function check1ClickDepositStatus(depositAddress: string): Promise<{
  status: 'PENDING' | 'PROCESSING' | 'SUCCESS' | 'FAILED' | 'EXPIRED';
  txHash?: string;
  nearAmount?: number;
}> {
  try {
    const res = await fetch(`${NEAR_INTENTS_API_URL}/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`, {
      headers: {
        ...(NEAR_INTENTS_API_KEY ? { Authorization: `Bearer ${NEAR_INTENTS_API_KEY}` } : {}),
      },
    });

    if (!res.ok) {
      return { status: 'PENDING' };
    }

    const data: any = await res.json();
    const rawStatus = (data.status || data.state || '').toUpperCase();

    if (rawStatus === 'SUCCESS' || rawStatus === 'COMPLETED' || rawStatus === 'FILLED') {
      return {
        status: 'SUCCESS',
        txHash: data.txHash || data.transactionHash || data.nearTxHash,
        nearAmount: data.amountOut ? Number(BigInt(data.amountOut) / 1000000000000000000n) / 1e6 : undefined,
      };
    } else if (rawStatus === 'PROCESSING' || rawStatus === 'DETECTED') {
      return { status: 'PROCESSING', txHash: data.txHash };
    } else if (rawStatus === 'FAILED' || rawStatus === 'CANCELLED') {
      return { status: 'FAILED' };
    } else if (rawStatus === 'EXPIRED') {
      return { status: 'EXPIRED' };
    }

    return { status: 'PENDING' };
  } catch (err: any) {
    logger.warn(`1Click check status failed: ${err.message}`);
    return { status: 'PENDING' };
  }
}

// Track notified deposits in-memory to prevent duplicate or looping messages
const notifiedMultichainDeposits = new Set<string>();

/**
 * Poller daemon to sweep active deposits, detect settlements, and trigger auto-unwraps
 */
export function startMultichainDepositPoller(bot: Telegraf, intervalMs = 10000): NodeJS.Timeout {
  logger.info('Starting 1Click Multichain Deposit poller daemon');

  return setInterval(async () => {
    try {
      const active = await getActiveRacerDeposits();
      if (!active.length) return;

      for (const dep of active) {
        try {
          // Anti-loop: skip if already notified or marked SUCCESS
          if (notifiedMultichainDeposits.has(dep.deposit_id) || dep.status === 'SUCCESS') {
            continue;
          }

          const check = await check1ClickDepositStatus(dep.deposit_address);

          if (check.status === 'SUCCESS' && dep.status !== 'SUCCESS') {
            notifiedMultichainDeposits.add(dep.deposit_id);
            logger.info(`Deposit ${dep.deposit_id} fulfilled! Triggering JIT auto-unwrap for user ${dep.telegram_id}`);

            // Explicitly suppress duplicate native NEAR deposit alert in depositWatcher for 10 minutes
            suppressDepositAlert(dep.telegram_id, 'near', 10 * 60 * 1000);

            await updateRacerDeposit(dep.deposit_id, {
              status: 'SUCCESS',
              tx_hash: check.txHash,
              completed_at: new Date(),
            });

            let unwrappedAmount = '0';
            try {
              const unwrapRes = await unwrapUserWrapNear(dep.telegram_id);
              unwrappedAmount = unwrapRes.unwrappedAmount;
              await updateRacerDeposit(dep.deposit_id, {
                unwrapped: true,
                unwrapped_amount: parseFloat(unwrappedAmount) || 0,
              });
              logger.info(`Auto-unwrapped ${unwrappedAmount} wNEAR for user ${dep.telegram_id}`);
            } catch (unwrapErr: any) {
              logger.warn(`Auto-unwrap wrap.near deferred for ${dep.telegram_id}: ${unwrapErr.message}`);
            }

            const chainInfo = SUPPORTED_CHAINS[dep.source_chain.toLowerCase()];
            const chainName = chainInfo ? `${chainInfo.icon} ${chainInfo.name}` : dep.source_chain.toUpperCase();
            const sourceAmtStr = dep.source_amount ? `${dep.source_amount} ${dep.source_symbol || ''}` : '';
            const nearAmtStr = dep.min_destination_amount ? `${dep.min_destination_amount.toFixed(4)} Ⓝ` : 'NEAR';

            const msg =
              `🎉 <b>Deposit Received &amp; Settled!</b>\n\n` +
              `📥 <b>Source:</b> ${chainName} (${sourceAmtStr})\n` +
              `💳 <b>Received:</b> <b>${nearAmtStr}</b>\n` +
              `🏎️ <b>Account:</b> <code>${dep.subaccount_id}</code>\n` +
              (unwrappedAmount !== '0' ? `🔄 <b>Auto-Unwrap:</b> Converted to native NEAR\n` : '') +
              (check.txHash ? `🔗 <b>Tx:</b> <code>${check.txHash.slice(0, 16)}...</code>\n` : '') +
              `\n<i>Your funds are ready to trade immediately!</i>`;

            const keyboard = {
              inline_keyboard: [
                [
                  { text: '💳 View Wallet', callback_data: 'menu_wallet', style: 'primary' },
                  { text: '🏎️ Start Trading', callback_data: 'menu_holdings', style: 'success' },
                ],
              ],
            };

            await bot.telegram.sendMessage(dep.telegram_id, msg, {
              parse_mode: 'HTML',
              reply_markup: keyboard,
            }).catch((err) => {
              logger.warn(`Failed to notify user ${dep.telegram_id} of deposit completion: ${err.message}`);
            });
          } else if (check.status === 'EXPIRED' || check.status === 'FAILED') {
            await updateRacerDeposit(dep.deposit_id, { status: check.status });
          }
        } catch (itemErr: any) {
          logger.warn(`Error updating deposit ${dep.deposit_id}: ${itemErr.message}`);
        }
      }
    } catch (err: any) {
      logger.error('Error in multichain deposit poller loop:', err);
    }
  }, intervalMs);
}
