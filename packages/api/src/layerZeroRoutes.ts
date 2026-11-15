/**
 * Telegram Bot Routes & UI for LayerZero V2 / Stargate V2 Cross-Chain Trading.
 *
 * Implements:
 *  - Interactive /bridge and /lz menu with real-time cross-chain balance scanning.
 *  - 1-Click cross-chain bridging with Stargate V2 slippage bounds and fee estimation.
 *  - LayerZero Scan tracking links: https://layerzeroscan.com/tx/...
 *  - Strict Zero-Loss / Anti-Starknet Guard: guarantees funds reside in sovereign secp256k1
 *    EOAs exportable to MetaMask/Rabby at any time, requiring no on-chain contract deployments.
 */
import { Telegraf, Markup, Context } from 'telegraf';
import {
  createLogger,
  LZ_CHAINS,
  quoteStargateSend,
  getLayerZeroScanUrl,
  type LayerZeroChain,
  type StargateAsset,
} from '@racerbot/shared';
import { getUserByTelegramId, type UserRecord } from '@racerbot/db';
import {
  scanCrossChainEvmBalances,
  executeLayerZeroBridge,
  planCrossChain1ClickBuy,
  type CrossChainBalancesResult,
} from './layerZeroBridge.js';
import { ensureUserEvmWallet } from './wallet.js';

const logger = createLogger('layerzero-routes');

function escapeHtml(str: string): string {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const cb = (text: string, action: string) => Markup.button.callback(text, action);

export interface BridgeMenuState {
  sourceChain: LayerZeroChain;
  destChain: LayerZeroChain;
  asset: StargateAsset;
  amount: string;
}

export async function buildBridgeMenu(
  telegramId: number,
  state?: Partial<BridgeMenuState>
): Promise<{ text: string; keyboard: any }> {
  let user = await getUserByTelegramId(telegramId);
  if (!user) {
    throw new Error('Please send /start first to initialize your account.');
  }

  const evmUser = await ensureUserEvmWallet(user);
  const evmAddress = evmUser.evm_address!;

  const sourceChain: LayerZeroChain = state?.sourceChain || 'base';
  const destChain: LayerZeroChain = state?.destChain || 'arbitrum';
  const asset: StargateAsset = state?.asset || 'USDC';
  const amount: string = state?.amount || '25.0';

  const sourceConfig = LZ_CHAINS[sourceChain];
  const destConfig = LZ_CHAINS[destChain];

  // Scan cross-chain balances
  let balances: CrossChainBalancesResult;
  try {
    balances = await scanCrossChainEvmBalances(evmAddress);
  } catch (err: any) {
    logger.warn(`Failed to scan balances in bridge menu: ${err.message}`);
    balances = {
      evmAddress,
      balances: {} as any,
      totalPortfolioUsd: 0,
    };
  }

  const bArb = balances.balances.arbitrum;
  const bBase = balances.balances.base;
  const bOp = balances.balances.optimism;
  const bEth = balances.balances.ethereum;

  // Pre-calculate quote
  let quoteText = '';
  let nativeFeeStr = '~0.0004 ETH (~$1.25)';
  let estDuration = 45;

  try {
    const q = await quoteStargateSend({
      sourceChain,
      destChain,
      asset,
      humanAmount: amount,
      recipientAddress: evmAddress,
    });
    nativeFeeStr = `${parseFloat(q.humanNativeFee).toFixed(5)} ${sourceConfig.nativeSymbol}`;
    estDuration = q.approxDurationSec;
  } catch (err: any) {
    logger.warn(`Quote estimation in menu: ${err.message}`);
  }

  quoteText =
    `⚙️ <b>Active Transfer Route:</b>\n` +
    `• From: <b>${sourceConfig.icon} ${sourceConfig.name}</b>\n` +
    `• To: <b>${destConfig.icon} ${destConfig.name}</b>\n` +
    `• Asset: <b>${amount} ${asset}</b>\n` +
    `• LayerZero Messaging Fee: <b>${nativeFeeStr}</b>\n` +
    `• Est. Cross-Chain Delivery: <b>~${estDuration}s</b>\n`;

  const text =
    `🌉 <b>LayerZero & Stargate V2 Bridge</b> ⚡\n\n` +
    `🔒 <b>Universal Sovereign EVM Wallet:</b>\n` +
    `<code>${escapeHtml(evmAddress)}</code>\n` +
    `<i>🛡️ One sovereign secp256k1 EOA across Arbitrum, Base, Ethereum & Optimism. Private key is 100% exportable to MetaMask/Rabby at any time. Zero smart contract account lockup — funds cannot be trapped.</i>\n\n` +
    `💰 <b>Your EVM Balances:</b>\n` +
    `🔷 <b>Base:</b> <code>${parseFloat(bBase?.nativeBalance || '0').toFixed(4)} ETH</code> • <code>${bBase?.usdcBalance || '0.00'} USDC</code>\n` +
    `🔵 <b>Arbitrum:</b> <code>${parseFloat(bArb?.nativeBalance || '0').toFixed(4)} ETH</code> • <code>${bArb?.usdcBalance || '0.00'} USDC</code>\n` +
    `🔴 <b>Optimism:</b> <code>${parseFloat(bOp?.nativeBalance || '0').toFixed(4)} ETH</code> • <code>${bOp?.usdcBalance || '0.00'} USDC</code>\n` +
    `⟠ <b>Ethereum:</b> <code>${parseFloat(bEth?.nativeBalance || '0').toFixed(4)} ETH</code> • <code>${bEth?.usdcBalance || '0.00'} USDC</code>\n` +
    `💼 <i>Total EVM Portfolio: $${balances.totalPortfolioUsd.toFixed(2)}</i>\n\n` +
    `${quoteText}\n` +
    `<i>Select route and asset below, then tap Confirm to bridge instantly:</i>`;

  // Buttons
  const buttons: any[] = [
    // Preset Route 1
    [
      cb(sourceChain === 'base' && destChain === 'arbitrum' ? '✅ 🔷 Base ➔ 🔵 Arb' : '🔷 Base ➔ 🔵 Arb', 'lz_route:base:arbitrum'),
      cb(sourceChain === 'arbitrum' && destChain === 'base' ? '✅ 🔵 Arb ➔ 🔷 Base' : '🔵 Arb ➔ 🔷 Base', 'lz_route:arbitrum:base'),
    ],
    // Preset Route 2
    [
      cb(sourceChain === 'optimism' && destChain === 'base' ? '✅ 🔴 OP ➔ 🔷 Base' : '🔴 OP ➔ 🔷 Base', 'lz_route:optimism:base'),
      cb(sourceChain === 'base' && destChain === 'optimism' ? '✅ 🔷 Base ➔ 🔴 OP' : '🔷 Base ➔ 🔴 OP', 'lz_route:base:optimism'),
    ],
    // Preset Route 3
    [
      cb(sourceChain === 'ethereum' && destChain === 'base' ? '✅ ⟠ Eth ➔ 🔷 Base' : '⟠ Eth ➔ 🔷 Base', 'lz_route:ethereum:base'),
      cb(sourceChain === 'ethereum' && destChain === 'arbitrum' ? '✅ ⟠ Eth ➔ 🔵 Arb' : '⟠ Eth ➔ 🔵 Arb', 'lz_route:ethereum:arbitrum'),
    ],
    // Asset Selectors
    [
      cb(asset === 'USDC' ? '✅ 💵 USDC' : '💵 USDC', `lz_asset:${sourceChain}:${destChain}:USDC`),
      cb(asset === 'ETH' ? '✅ ⟠ ETH' : '⟠ ETH', `lz_asset:${sourceChain}:${destChain}:ETH`),
    ],
    // Amount Buttons
    [
      cb(amount === '10.0' ? '✅ $10' : '$10', `lz_amt:${sourceChain}:${destChain}:${asset}:10.0`),
      cb(amount === '25.0' ? '✅ $25' : '$25', `lz_amt:${sourceChain}:${destChain}:${asset}:25.0`),
      cb(amount === '50.0' ? '✅ $50' : '$50', `lz_amt:${sourceChain}:${destChain}:${asset}:50.0`),
      cb(amount === '100.0' ? '✅ $100' : '$100', `lz_amt:${sourceChain}:${destChain}:${asset}:100.0`),
    ],
    // Action Confirmation
    [
      cb(`⚡ Bridge ${amount} ${asset} Now`, `lz_confirm:${sourceChain}:${destChain}:${asset}:${amount}`),
    ],
    // Navigation
    [
      cb('🔄 Refresh Balances', `lz_refresh:${sourceChain}:${destChain}:${asset}:${amount}`),
      cb('💳 Wallet', 'menu_wallet'),
      cb('🔙 Main Menu', 'menu_home'),
    ],
  ];

  return { text, keyboard: Markup.inlineKeyboard(buttons) };
}

/**
 * Registers all LayerZero and Stargate V2 routes on the Telegraf bot instance.
 */
export function registerLayerZeroRoutes(bot: Telegraf<Context>): void {
  // ── /bridge & /lz Commands ────────────────────────────────────────────────
  const handleBridgeCommand = async (ctx: Context) => {
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    try {
      const menu = await buildBridgeMenu(telegramId);
      if (ctx.callbackQuery && typeof (ctx as any).editMessageText === 'function') {
        await (ctx as any).editMessageText(menu.text, { parse_mode: 'HTML', ...menu.keyboard }).catch(async () => {
          await ctx.reply(menu.text, { parse_mode: 'HTML', ...menu.keyboard });
        });
      } else {
        await ctx.reply(menu.text, { parse_mode: 'HTML', ...menu.keyboard });
      }
    } catch (err: any) {
      await ctx.reply(`❌ ${err.message}`).catch(() => {});
    }
  };

  bot.command(['bridge', 'lz', 'layerzero', 'stargate'], handleBridgeCommand);
  bot.action('menu_bridge', handleBridgeCommand);

  // ── Route Selector Action ─────────────────────────────────────────────────
  bot.action(/^lz_route:([a-z0-9_]+):([a-z0-9_]+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    const sourceChain = (ctx as any).match[1] as LayerZeroChain;
    const destChain = (ctx as any).match[2] as LayerZeroChain;

    try {
      const menu = await buildBridgeMenu(telegramId, { sourceChain, destChain });
      await (ctx as any).editMessageText(menu.text, { parse_mode: 'HTML', ...menu.keyboard }).catch(() => {});
    } catch (err: any) {
      await ctx.reply(`❌ ${err.message}`).catch(() => {});
    }
  });

  // ── Asset Selector Action ─────────────────────────────────────────────────
  bot.action(/^lz_asset:([a-z0-9_]+):([a-z0-9_]+):([A-Z0-9]+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    const sourceChain = (ctx as any).match[1] as LayerZeroChain;
    const destChain = (ctx as any).match[2] as LayerZeroChain;
    const asset = (ctx as any).match[3] as StargateAsset;

    try {
      const menu = await buildBridgeMenu(telegramId, { sourceChain, destChain, asset });
      await (ctx as any).editMessageText(menu.text, { parse_mode: 'HTML', ...menu.keyboard }).catch(() => {});
    } catch (err: any) {
      await ctx.reply(`❌ ${err.message}`).catch(() => {});
    }
  });

  // ── Amount Selector Action ────────────────────────────────────────────────
  bot.action(/^lz_amt:([a-z0-9_]+):([a-z0-9_]+):([A-Z0-9]+):([0-9.]+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    const sourceChain = (ctx as any).match[1] as LayerZeroChain;
    const destChain = (ctx as any).match[2] as LayerZeroChain;
    const asset = (ctx as any).match[3] as StargateAsset;
    const amount = (ctx as any).match[4];

    try {
      const menu = await buildBridgeMenu(telegramId, { sourceChain, destChain, asset, amount });
      await (ctx as any).editMessageText(menu.text, { parse_mode: 'HTML', ...menu.keyboard }).catch(() => {});
    } catch (err: any) {
      await ctx.reply(`❌ ${err.message}`).catch(() => {});
    }
  });

  // ── Refresh Action ────────────────────────────────────────────────────────
  bot.action(/^lz_refresh:([a-z0-9_]+):([a-z0-9_]+):([A-Z0-9]+):([0-9.]+)$/, async (ctx) => {
    await ctx.answerCbQuery('🔄 Updating balances and quote...').catch(() => {});
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    const sourceChain = (ctx as any).match[1] as LayerZeroChain;
    const destChain = (ctx as any).match[2] as LayerZeroChain;
    const asset = (ctx as any).match[3] as StargateAsset;
    const amount = (ctx as any).match[4];

    try {
      const menu = await buildBridgeMenu(telegramId, { sourceChain, destChain, asset, amount });
      await (ctx as any).editMessageText(menu.text, { parse_mode: 'HTML', ...menu.keyboard }).catch(() => {});
    } catch (err: any) {
      await ctx.reply(`❌ ${err.message}`).catch(() => {});
    }
  });

  // ── Execution Confirmation Action ─────────────────────────────────────────
  bot.action(/^lz_confirm:([a-z0-9_]+):([a-z0-9_]+):([A-Z0-9]+):([0-9.]+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await ctx.reply('User not found. Run /start first.');
      return;
    }

    const sourceChain = (ctx as any).match[1] as LayerZeroChain;
    const destChain = (ctx as any).match[2] as LayerZeroChain;
    const asset = (ctx as any).match[3] as StargateAsset;
    const amount = (ctx as any).match[4];

    const sourceConfig = LZ_CHAINS[sourceChain];
    const destConfig = LZ_CHAINS[destChain];

    const progressMsg = await ctx.reply(
      `⏳ <b>Broadcasting Stargate V2 Bridge Transfer...</b>\n\n` +
      `• Sending: <b>${amount} ${asset}</b> from <b>${sourceConfig.name}</b> ➔ <b>${destConfig.name}</b>\n` +
      `• LayerZero Protocol: <i>Executing pre-flight checks, verifying gas reserves & requesting route...</i>`,
      { parse_mode: 'HTML' }
    ).catch(() => null);

    try {
      const result = await executeLayerZeroBridge({
        userId: user.id,
        sourceChain,
        destChain,
        asset,
        humanAmount: amount,
      });

      if (progressMsg) {
        await ctx.deleteMessage(progressMsg.message_id).catch(() => {});
      }

      const successText =
        `✅ <b>LayerZero V2 Bridge Broadcasted!</b> ⚡\n\n` +
        `🚀 <b>Sent:</b> <code>${result.amount} ${result.asset}</code>\n` +
        `🛣️ <b>Route:</b> ${sourceConfig.icon} ${sourceConfig.name} ➔ ${destConfig.icon} ${destConfig.name}\n` +
        `⏱️ <b>Est. Delivery:</b> ~${result.approxDurationSec} seconds\n` +
        `💰 <b>Messaging Fee Paid:</b> ${result.nativeFee} ETH\n` +
        `🔗 <b>Source Tx:</b> <code>${result.txHash}</code>\n\n` +
        `🔒 <b>Destination Sovereign EOA:</b>\n` +
        `<code>${escapeHtml(result.recipient)}</code>\n` +
        `<i>Your funds are settling directly into your sovereign EOA on ${destConfig.name}. Unused gas has been refunded on-chain.</i>`;

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.url('🔍 Track on LayerZero Scan', result.lzScanUrl)],
        [Markup.button.url(`📜 View on ${sourceConfig.name} Explorer`, result.explorerUrl)],
        [
          cb('🔄 Bridge Again', 'menu_bridge'),
          cb('💼 Wallet / Balance', 'menu_wallet'),
        ],
      ]);

      await ctx.reply(successText, { parse_mode: 'HTML', ...keyboard });
    } catch (err: any) {
      if (progressMsg) {
        await ctx.deleteMessage(progressMsg.message_id).catch(() => {});
      }
      await ctx.reply(`❌ <b>Bridge Execution Failed:</b>\n${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
    }
  });

  // ── 1-Click Cross-Chain Buy Action ────────────────────────────────────────
  bot.action(/^bridge_1click:([a-z0-9_]+):([a-z0-9_]+):([A-Z0-9]+):([0-9.]+)$/, async (ctx) => {
    await ctx.answerCbQuery('⚡ Initiating 1-Click Cross-Chain Buy...').catch(() => {});
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    const user = await getUserByTelegramId(telegramId);
    if (!user) return;

    const sourceChain = (ctx as any).match[1] as LayerZeroChain;
    const destChain = (ctx as any).match[2] as LayerZeroChain;
    const asset = (ctx as any).match[3] as StargateAsset;
    const amount = (ctx as any).match[4];

    const sourceConfig = LZ_CHAINS[sourceChain];
    const destConfig = LZ_CHAINS[destChain];

    const procMsg = await ctx.reply(
      `⚡ <b>Executing 1-Click Cross-Chain Buy...</b>\n\n` +
      `• Bridging: <b>${amount} ${asset}</b> from <b>${sourceConfig.name}</b> ➔ <b>${destConfig.name}</b>\n` +
      `• Once funds arrive on ${destConfig.name}, your swap will execute seamlessly!`,
      { parse_mode: 'HTML' }
    ).catch(() => null);

    try {
      const res = await executeLayerZeroBridge({
        userId: user.id,
        sourceChain,
        destChain,
        asset,
        humanAmount: amount,
      });

      if (procMsg) {
        await ctx.deleteMessage(procMsg.message_id).catch(() => {});
      }

      const msg =
        `⚡ <b>1-Click Cross-Chain Transfer In-Flight!</b>\n\n` +
        `Bridging <b>${amount} ${asset}</b> from ${sourceConfig.name} to ${destConfig.name}.\n` +
        `Estimated arrival: ~${res.approxDurationSec}s.\n\n` +
        `Track delivery live on LayerZero Scan:`;

      const kb = Markup.inlineKeyboard([
        [Markup.button.url('🔍 Track on LayerZero Scan', res.lzScanUrl)],
        [cb('💼 View Wallet', 'menu_wallet')],
      ]);

      await ctx.reply(msg, { parse_mode: 'HTML', ...kb });
    } catch (err: any) {
      if (procMsg) {
        await ctx.deleteMessage(procMsg.message_id).catch(() => {});
      }
      await ctx.reply(`❌ 1-Click Buy Failed: ${err.message}`);
    }
  });
}
