import type { Telegraf } from 'telegraf';
import { createRedis, CHANNELS, isSolanaAddress, type NotifyUserEvent } from '@racerbot/shared';
import { getUserById } from '@racerbot/db';
import { executeFleetBundleBuy, executeFleetBundleSell } from './raceFleet.js';
import { shortenTrackerAlertMarkup } from './copyLinks.js';

let _bot: Telegraf | null = null;

/** Strip Telegram Markdown control chars so user/data strings can't break messages. */
function sanitize(s: string): string {
  return String(s ?? '').replace(/[_*`[]/g, ' ').slice(0, 300);
}

export function setBotInstance(bot: Telegraf): void {
  _bot = bot;
}

export function getBotInstance(): Telegraf | null {
  return _bot;
}

/**
 * Start listening for NOTIFY_USER events from Redis and forward to Telegram.
 * This is async and non-blocking — PNL cards and trigger alerts go through here.
 */
export async function startNotifyListener(redisUrl: string): Promise<void> {
  const redis = createRedis(redisUrl);

  await redis.subscribe(CHANNELS.NOTIFY_USER, async (message: string) => {
    let event: NotifyUserEvent;
    try {
      event = JSON.parse(message);
    } catch {
      return;
    }

    // Resolve telegram_id from user_id if not set (executor publishes user_id, not telegram_id)
    const evName = String(event.event || '');
    const evData = (event.data ?? {}) as Record<string, any>;

    // 1. On-chain trade detected by detector for a registered RacerAlpha Caller -> record signal & run subscriber auto-copy
    if (evName === 'alpha_caller_onchain_trade' && evData.trader_id && evData.token_address) {
      try {
        const { recordAlphaSignal } = await import('./racerAlpha.js');
        const { getTokenInfo } = await import('./wallet.js');
        const info: any = await getTokenInfo(String(evData.token_address), false).catch(() => null);
        await recordAlphaSignal({
          traderId: String(evData.trader_id),
          tokenAddress: String(evData.token_address),
          tokenSymbol: String(evData.token_symbol || info?.symbol || evData.token_address.split('.')[0].toUpperCase()),
          tokenName: String(evData.token_name || info?.name || evData.token_symbol || 'TOKEN'),
          side: String(evData.side || 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
          priceNear: parseFloat(info?.price || '0') || 0,
          amountNear: Number(evData.amount_near) || 1.0,
          venue: String(evData.venue || 'rhea'),
          txHash: evData.tx_hash ? String(evData.tx_hash) : undefined,
        });
      } catch (err: any) {
        console.warn('[NOTIFY] Failed to process alpha_caller_onchain_trade:', err?.message);
      }
      return;
    }

    // 2. Direct Wallet Copy Trade via Confidential Executor Pool (works for WebApp & Telegram users)
    if (evName === 'confidential_copy_trade' && evData.user_id && evData.token_address) {
      try {
        const { updateCopyTradeFillResult, awardPointsForCopyTrade } = await import('@racerbot/db');
        const { confidentialBuy, confidentialSell } = await import('./executorPool.js');
        const copierUser = await getUserById(String(evData.user_id)).catch(() => null);
        const fillId = String(evData.fill_id || '');
        if (!copierUser) {
          if (fillId) await updateCopyTradeFillResult(fillId, 'failed', { skip_reason: 'User not found' }).catch(() => {});
          return;
        }
        const side = String(evData.side || 'buy').toLowerCase();
        const tokenAddress = String(evData.token_address);
        const venue = String(evData.venue || 'rhea');
        const slippagePct = Number(evData.slippage_pct) || 5;
        if (side === 'buy') {
          const buyNear = Number(evData.amount_near) || 1.0;
          const amountYocto = BigInt(Math.round(buyNear * 1e6)) * 10n ** 18n;
          const res = await confidentialBuy({
            user: copierUser,
            tokenAddress,
            venue,
            amountYocto,
            slippagePct,
          });
          if (res.success && res.txHashes.length > 0) {
            if (fillId) {
              await updateCopyTradeFillResult(fillId, 'filled', {
                our_tx_hash: res.txHashes[0],
                amount_near: buyNear,
              }).catch(() => {});
            }
            await awardPointsForCopyTrade(copierUser.id, fillId || res.txHashes[0], buyNear, undefined).catch(() => {});
            if (copierUser.telegram_id && _bot) {
              await _bot.telegram.sendMessage(
                copierUser.telegram_id,
                `✅ <b>Confidential Copy Trade Executed (BUY)</b>\n\n` +
                `🎯 <b>Copied</b>: <code>${evData.leader_wallet || ''}</code>\n` +
                `🪙 <b>Token</b>: <code>${tokenAddress}</code>\n` +
                `💰 <b>Amount</b>: <code>${buyNear.toFixed(2)} NEAR</code>\n` +
                `🛡️ <b>Route</b>: Confidential Executor Pool`,
                { parse_mode: 'HTML' }
              ).catch(() => {});
            }
          } else {
            if (fillId) {
              await updateCopyTradeFillResult(fillId, 'failed', {
                skip_reason: (res.reason || 'Confidential buy failed').slice(0, 200),
              }).catch(() => {});
            }
          }
        } else {
          const res = await confidentialSell({
            user: copierUser,
            tokenAddress,
            venue,
            percent: 100,
            slippagePct,
          });
          if (res.success && res.txHashes.length > 0) {
            if (fillId) {
              await updateCopyTradeFillResult(fillId, 'filled', {
                our_tx_hash: res.txHashes[0],
              }).catch(() => {});
            }
            if (copierUser.telegram_id && _bot) {
              await _bot.telegram.sendMessage(
                copierUser.telegram_id,
                `✅ <b>Confidential Copy Trade Executed (SELL)</b>\n\n` +
                `🎯 <b>Copied</b>: <code>${evData.leader_wallet || ''}</code>\n` +
                `🪙 <b>Token</b>: <code>${tokenAddress}</code>\n` +
                `🔴 <b>Action</b>: Sold 100% via Confidential Executor`,
                { parse_mode: 'HTML' }
              ).catch(() => {});
            }
          } else {
            if (fillId) {
              await updateCopyTradeFillResult(fillId, 'failed', {
                skip_reason: (res.reason || 'Confidential sell failed').slice(0, 200),
              }).catch(() => {});
            }
          }
        }
      } catch (err: any) {
        console.warn('[NOTIFY] Failed to process confidential_copy_trade:', err?.message);
      }
      return;
    }

    let telegramId = event.telegram_id;
    if ((!telegramId || telegramId === 0) && (event.data?.user_id || (event as any).user_id)) {
      const uid = (event.data?.user_id ?? (event as any).user_id) as string;
      const user = await getUserById(uid).catch(() => null);
      telegramId = user?.telegram_id ?? 0;
    }

    if (!telegramId || !_bot) return;

    await sendNotification(telegramId, event).catch(err => {
      console.error('[NOTIFY] Failed to send notification:', err.message);
    });

    queueRacerRankCheck(event);
  });
}

/**
 * NEAR Racer Card: after a confirmed NEAR trade, announce a new lifetime rank
 * (once). A trigger fires before its sell lands, so check again a little later.
 */
function queueRacerRankCheck(event: NotifyUserEvent): void {
  const data = event.data ?? {};
  const userId = (data.user_id ?? (event as any).user_id) as string | undefined;
  if (!userId || (data.chain && data.chain !== 'near')) return;
  const delays = event.event === 'trade_confirmed' ? [0]
    : event.event === 'trigger_fired' ? [45_000, 150_000]
    : null;
  if (!delays) return;
  void import('./racerCard.js')
    .then(m => m.scheduleRankUpCheck(userId, delays))
    .catch(() => { });
}

async function sendNotification(telegramId: number, event: NotifyUserEvent): Promise<void> {
  if (!_bot) return;

  const data = event.data ?? {};

  switch (event.event) {
    case 'trigger_fired': {
      const triggerType = data.trigger_type as string;
      const token = data.token_address as string;
      const targetVal = parseFloat(String(data.target_value || '0'));
      const currentPrice = Number(data.current_price || 0);
      const entryPrice = Number(data.entry_price || 0);
      const isSolana = data.chain === 'solana';
      const isStarknet = !isSolana && (data.chain === 'starknet' || (typeof token === 'string' && token.startsWith('0x') && !token.includes('::')));
      const isSui = !isSolana && !isStarknet && (data.chain === 'sui' || (typeof token === 'string' && token.includes('::')));
      const unit = isSolana ? 'SOL' : isStarknet ? 'STRK' : isSui ? 'SUI' : 'NEAR';

      let sym = 'TOKEN';
      let decimals = isSolana ? 6 : isStarknet ? 18 : isSui ? 9 : 18;
      try {
        const { getTokenInfo } = await import('./wallet.js');
        const info = await getTokenInfo(token, false).catch(() => null);
        if (info?.symbol) sym = sanitize(info.symbol);
        if (info?.decimals) decimals = info.decimals;
      } catch { /* fallback to default */ }

      let humanQty = 0;
      try {
        const rawBig = BigInt(String(data.quantity_held || '0').split('.')[0]);
        humanQty = Number(rawBig) / Math.pow(10, decimals);
      } catch {
        humanQty = parseFloat(String(data.quantity_held || '0'));
      }

      const qtyDisplay = humanQty >= 1_000_000
        ? `${(humanQty / 1_000_000).toFixed(2)}M`
        : humanQty >= 1_000
        ? humanQty.toLocaleString('en-US', { maximumFractionDigits: 1 })
        : humanQty > 0
        ? humanQty.toFixed(2)
        : '—';

      const soldForNative = humanQty * currentPrice;
      const costBasisNative = humanQty * entryPrice;
      const diffNative = soldForNative - costBasisNative;
      const sellPct = typeof (data as any)?.sell_pct === 'number' ? (data as any).sell_pct : 100;
      const partialNote = sellPct < 100 ? ` (${sellPct}% of position)` : '';

      if (triggerType === 'stop_loss') {
        const lossNative = Math.abs(diffNative);
        const lossDisplay = lossNative >= 0.0001 ? lossNative.toFixed(4) : lossNative.toFixed(6);
        const text =
          `🔴 *Stop Loss Triggered!*\n\n` +
          `*${sym}* hit your -${targetVal}% stop loss target${partialNote}.\n` +
          `Executing market exit: \`${qtyDisplay} ${sym}\` → estimated \`~${soldForNative.toFixed(4)} ${unit}\`\n` +
          `Target loss: \`-${lossDisplay} ${unit}\` (-${targetVal}%)`;

        await _bot.telegram.sendMessage(telegramId, text, { parse_mode: 'Markdown' });
      } else if (triggerType === 'take_profit') {
        const profitNative = Math.abs(diffNative);
        const profitDisplay = profitNative >= 0.0001 ? profitNative.toFixed(4) : profitNative.toFixed(6);
        const text =
          `🟢 *Take Profit Hit!* 🎉\n\n` +
          `*${sym}* hit your +${targetVal}% take profit target${partialNote}.\n` +
          `Executing market sell: \`${qtyDisplay} ${sym}\` → estimated \`~${soldForNative.toFixed(4)} ${unit}\`\n` +
          `Target profit: \`+${profitDisplay} ${unit}\` (+${targetVal}%)`;

        await _bot.telegram.sendMessage(telegramId, text, { parse_mode: 'Markdown' });
      } else {
        const text =
          `📈 *Market Cap Target Triggered!*\n\n` +
          `🪙 Token: \`${token}\`\n` +
          `💰 Price: \`${currentPrice.toFixed(8)} ${unit}\`\n\n` +
          `Sell order executed to secure position.`;

        await _bot.telegram.sendMessage(telegramId, text, { parse_mode: 'Markdown' });
      }
      break;
    }

    case 'rug_check_failed':
    case 'auto_buy_skipped': {
      const token = data.token as string ?? data.token_address as string ?? 'unknown';
      const reason = data.reason as string ?? 'rug check failed';
      await _bot.telegram.sendMessage(telegramId,
        `⚠️ *Auto-Buy Skipped*\n\n` +
        `🪙 Token: \`${token}\`\n` +
        `📋 Reason: _${reason}_\n\n` +
        `_Safety check blocked this buy. No funds were used._`,
        { parse_mode: 'Markdown' }
      );
      break;
    }

    case 'allowance_low': {
      await _bot.telegram.sendMessage(telegramId,
        `⚡ *Allowance Running Low*\n\n` +
        `Your bot key allowance is nearly exhausted.\n` +
        `No more trades until you top up.\n\n` +
        `Use /topup to add more allowance.`,
        { parse_mode: 'Markdown' }
      );
      break;
    }

    case 'pnl_card': {
      const pnl = data as any;
      const pnlPercent = pnl.realizedPnlPercent ?? pnl.pnlPercent ?? 0;
      const pnlSign = pnlPercent >= 0 ? '+' : '';
      const emoji = pnlPercent >= 0 ? '🟢' : '🔴';
      const tokenSym = sanitize(pnl.tokenTicker || pnl.tokenSymbol || pnl.tokenName || 'TOKEN');
      const tokenName = sanitize(pnl.tokenName || tokenSym);
      const exitPrice = pnl.exitPrice ?? pnl.currentPrice ?? 0;
      const realizedNear = pnl.realizedPnlNear ?? pnl.profitAmount ?? 0;
      const holdDuration = pnl.holdDuration || pnl.duration || '—';
      const quantity = pnl.quantity ?? pnl.positionSize ?? 0;

      const extra: any = { parse_mode: 'Markdown' };

      const unit = tokenSym.includes('::') || (pnl.tokenAddress || '').includes('::') ? 'SUI' : 'NEAR';
      await _bot.telegram.sendMessage(telegramId,
        `${emoji} *Trade Closed — PNL Summary*\n\n` +
        `🪙 *${tokenName}* (\`${tokenSym}\`)\n\n` +
        `\`\`\`\n` +
        `Entry   : ${pnl.entryPrice} ${unit}\n` +
        `Exit    : ${exitPrice} ${unit}\n` +
        `Qty     : ${quantity}\n` +
        `PNL     : ${pnlSign}${Number(realizedNear).toFixed(4)} ${unit}\n` +
        `PNL %   : ${pnlSign}${Number(pnlPercent).toFixed(2)}%\n` +
        `Hold    : ${holdDuration}\n` +
        `\`\`\``,
        extra
      );
      break;
    }

    case 'trade_failed': {
      const txHash = data.txHash as string ?? 'unknown';
      const rawReason = (data.reason as string) ?? 'transaction failed or slippage breach';
      const token = data.token as string ?? '';
      let sym = token;
      try {
        const { getCachedTokenInfo } = await import('./wallet.js');
        const info = getCachedTokenInfo(token);
        if (info?.symbol) sym = info.symbol;
      } catch {}
      const tokenLine = sym ? `🪙 Token: \`${sanitize(sym)}\`\n` : '';

      // Map raw NEAR / RPC errors to user-friendly language
      const friendlyReason = (() => {
        const r = rawReason.toLowerCase();
        if (r.includes('no transaction was sent')) return 'Price moved beyond your slippage setting in the seconds before execution. The trade was NOT sent — no funds spent. Retry for a fresh quote, or increase slippage in ⚙️ Settings.';
        if (r.includes('notenoughallowance') || r.includes('not enough allowance')) return 'Insufficient key allowance — please contact support.';
        if (r.includes('slippage') || r.includes('min_amount_out') || r.includes('less than minimum')) return 'Slippage too high — price moved against you. Try increasing slippage in ⚙️ Settings.';
        if (r.includes('refunded your input') || r.includes('swap produced no')) return 'Price moved or pool liquidity was too low — the DEX refunded your input. Try increasing slippage in ⚙️ Settings.';
        if (r.includes('insufficient balance') || (r.includes('insufficient') && r.includes('wnear balance'))) return 'Insufficient balance for this trade.';
        if (r.includes('no pool') || r.includes('pool not found') || r.includes('no dcl pool')) return 'No liquidity pool found for this token. It may not yet be tradeable.';
        if (r.includes('prebonded')) return 'Token is still in its bonding curve phase — wait for it to bond before buying.';
        if (r.includes('liquidity') && r.includes('insufficient')) return 'Pool liquidity too low to fill this order.';
        if (r.includes('all near rpc broadcast failed')) return 'Network error — all RPC nodes rejected the transaction. Please retry.';
        if (r.includes('never reached the near network')) return 'Transaction never reached the NEAR network — no funds were spent. Please retry in a moment.';
        if (r.includes('not confirmed within') || r.includes('taking too long') || r.includes('outcome is unknown')) return 'Transaction was submitted but confirmation is delayed. Please check your wallet balance before retrying to avoid duplicate trades.';
        if (r.includes('another transaction is already in progress') || r.includes('wallet lock') || r.includes('contention')) return 'Another transaction is already in progress for this wallet — please wait a moment and try again.';
        if (r.includes('signing timed out')) return 'Transaction signing timed out. Please retry.';
        if (r.includes('timeout') || r.includes('timed out')) return 'Network timeout — the NEAR RPC did not respond in time. Please retry.';
        if (r.includes('invalid receiver') || r.includes('does not exist')) return 'Contract not found on-chain. Verify the token contract address.';
        if (r.includes('panic')) return `Contract execution failed: ${sanitize(rawReason.slice(0, 120))}`;
        return sanitize(rawReason.slice(0, 200));
      })();

      const isSolanaFail = data.chain === 'solana';
      const isSell = typeof data.is_sell === 'boolean'
        ? data.is_sell
        : Boolean(token && token !== 'wrap.near' && token !== 'near' && token !== 'sui' && token !== '0x0');
      const refundNote = isSell
        ? 'No funds were lost on a failed swap — your tokens remain in your wallet. Use /wallet to check.'
        : isSolanaFail
        ? 'A failed Solana swap does not move your SOL (only a tiny network fee may apply). Use /wallet to check.'
        : 'No funds were lost on a failed swap — wNEAR is returned to your wallet. Use /wallet to check.';
      const retryNote = data.trigger_id ? '\n\n🔄 _Stop loss trigger remains active and will retry on the next price tick._' : '';

      await _bot.telegram.sendMessage(telegramId,
        `❌ *Trade Failed*\n\n` +
        tokenLine +
        `📋 *Reason*:\n_${friendlyReason}_\n` +
        (txHash !== 'none' ? `\n🧾 TX: \`${sanitize(txHash)}\`\n` : '') +
        `\n💡 _${refundNote}_` +
        retryNote,
        { parse_mode: 'Markdown' }
      );
      break;
    }


    case 'trade_confirmed': {
      const tokenName = sanitize((data.tokenName as string) || (data.tokenSymbol as string) || 'TOKEN');
      const tokenSym = sanitize((data.tokenSymbol as string) || '???');
      const tokenQty = Number(data.tokenQty ?? 0);
      const priceNear = Number(data.priceNear ?? 0);
      const nearSpent = Number(data.nearSpent ?? 0);

      const qtyDisplay = tokenQty >= 1_000_000
        ? `${(tokenQty / 1_000_000).toFixed(3)}M`
        : tokenQty >= 1_000
        ? tokenQty.toLocaleString('en-US', { maximumFractionDigits: 2 })
        : tokenQty >= 0.0001
        ? tokenQty.toFixed(4)
        : tokenQty.toExponential(3);

      // PNL snapshot at entry instead of an explorer link: position value vs
      // amount spent (the t=0 delta is the entry cost — fee + token tax).
      const valueNear = tokenQty * priceNear;
      const pnlNear = valueNear - nearSpent;
      const pnlPct = nearSpent > 0 ? (pnlNear / nearSpent) * 100 : 0;
      const pnlEmoji = pnlNear >= 0 ? '📈' : '📉';
      const pnlSign = pnlNear >= 0 ? '+' : '';

      await _bot.telegram.sendMessage(telegramId,
        `✅ *Buy Confirmed!*\n\n` +
        `🪙 *${tokenName}* (${tokenSym})\n` +
        `📦 Received: \`${qtyDisplay} ${tokenSym}\`\n` +
        `💸 Spent: \`${nearSpent.toFixed(4)} NEAR\`\n` +
        `💵 Entry: \`${priceNear > 0 ? priceNear.toFixed(8) : '—'} NEAR\`\n\n` +
        `📊 *Position*\n` +
        `💰 Value: \`${valueNear.toFixed(4)} NEAR\`\n` +
        `${pnlEmoji} PnL: \`${pnlSign}${pnlPct.toFixed(1)}%\` (\`${pnlSign}${pnlNear.toFixed(4)} NEAR\`)`,
        { parse_mode: 'Markdown' }
      );
      break;
    }

    case 'solana_trade_confirmed': {
      const side = data.side === 'sell' ? 'sell' : 'buy';
      const tokenName = sanitize((data.tokenName as string) || (data.tokenSymbol as string) || 'TOKEN');
      const tokenSym = sanitize((data.tokenSymbol as string) || 'TOKEN');
      const qty = Number(data.tokenQty ?? 0);
      const priceSol = Number(data.priceSol ?? 0);
      const solAmount = Number(data.solAmount ?? 0);
      const qtyDisplay = qty >= 1_000_000 ? `${(qty / 1_000_000).toFixed(3)}M`
        : qty >= 1_000 ? `${(qty / 1_000).toFixed(2)}K`
        : qty >= 0.0001 ? qty.toFixed(4) : qty.toExponential(3);
      const txHash = String(data.txHash || '');
      const lines = side === 'buy'
        ? `✅ *Buy Confirmed on Solana!*\n\n` +
          `🪙 *${tokenName}* (${tokenSym})\n` +
          `📦 Received: \`${qtyDisplay} ${tokenSym}\`\n` +
          `💸 Spent: \`${solAmount.toFixed(4)} SOL\`\n` +
          `💵 Entry: \`${priceSol > 0 ? priceSol.toExponential(4) : '—'} SOL\``
        : `✅ *Sell Confirmed on Solana!*\n\n` +
          `🪙 *${tokenName}* (${tokenSym})\n` +
          `📦 Sold: \`${qtyDisplay} ${tokenSym}\`\n` +
          `💰 Received: \`${solAmount.toFixed(4)} SOL\`\n` +
          `💵 Price: \`${priceSol > 0 ? priceSol.toExponential(4) : '—'} SOL\``;
      const keyboard: any[] = [];
      if (txHash) keyboard.push([{ text: '🔗 View on Solscan', url: `https://solscan.io/tx/${txHash}` }]);
      if (data.positionId) keyboard.push([{ text: '📊 View Position', callback_data: `token_detail:${data.positionId}` }]);
      await _bot.telegram.sendMessage(telegramId, lines, {
        parse_mode: 'Markdown',
        ...(keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {}),
      } as any);
      break;
    }

    case 'token_not_found': {
      await _bot.telegram.sendMessage(telegramId,
        `❌ *Token Not Found*\n\n` +
        `No match in cache.\n` +
        `Try pasting the contract address (CA) directly.`,
        { parse_mode: 'Markdown' }
      );
      break;
    }

    case 'copy_trade_filled':
    case 'wallet_tracker_alert': {
      // Pre-formatted message is composed by the copy-trade detector
      const msg = (data as any).message as string | undefined;
      const markup = (data as any).reply_markup;
      if (msg) {
        const replyMarkup = event.event === 'wallet_tracker_alert'
          && markup
          && typeof data.token_address === 'string'
          ? shortenTrackerAlertMarkup(markup, data.token_address)
          : markup;
        await _bot.telegram.sendMessage(telegramId, msg, {
          parse_mode: 'Markdown',
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        });
      }
      break;
    }

    case 'dca_fill' as any: {
      // Pre-formatted message is composed by the DCA engine
      const msg = (data as any).message as string | undefined;
      if (msg) {
        await _bot.telegram.sendMessage(telegramId, msg, { parse_mode: 'Markdown' });
      }
      break;
    }

    case 'deposit_received': {
      const chain = (data.chain as string) || 'near';
      const amount = (data.amount as string) || '0';
      const symbol = (data.symbol as string) || (chain === 'solana' ? 'SOL' : chain === 'starknet' ? 'STRK' : chain === 'sui' ? 'SUI' : 'NEAR');
      const address = (data.address as string) || '';
      const usdValue = (data.usdValue as string) || '';
      const icon = chain === 'solana' ? '🟣' : chain === 'starknet' ? '✨' : chain === 'sui' ? '🔷' : '⬛';
      const tokenIcon = chain === 'solana' ? '◎' : chain === 'starknet' ? '✨' : chain === 'sui' ? '💧' : 'Ⓝ';
      const chainLabel = chain === 'solana' ? 'Solana' : chain === 'starknet' ? 'Starknet' : chain === 'sui' ? 'SUI' : 'NEAR';

      const msg =
        `💰 <b>Deposit Confirmed!</b>\n\n` +
        `${icon} <b>+${amount} ${symbol}</b> ${tokenIcon} ${usdValue ? `(${usdValue})` : ''}\n` +
        `<u>${chainLabel}</u>: <code>${address}</code>\n\n` +
        `Your funds are credited and ready to trade.`;

      await _bot.telegram.sendMessage(telegramId, msg, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🎒 Your Bags', callback_data: 'menu_holdings' },
              { text: '💳 Wallet', callback_data: 'menu_wallet' },
            ],
            [
              { text: '🎯 Snipe', callback_data: 'menu_snipe' },
              { text: '👥 Copy Trade', callback_data: 'menu_copy' },
            ],
          ],
        },
      });
      break;
    }

    case 'limit_order_fill': {
      const symbol = (data.symbol as string) || 'TOKEN';
      const side = (data.side as string) || 'buy';
      const sideIcon = side === 'buy' ? '🟢' : '🔴';
      const sideText = side === 'buy' ? 'Limit Buy Triggered' : 'Limit Sell Triggered';
      const currentPrice = Number(data.current_price || 0);
      const currentMcap = Number(data.current_mcap || 0);
      const loUnit = (data.unit as string) || 'NEAR';
      const amount = data.amount_input ? `${Number(data.amount_input).toFixed(loUnit === 'SOL' ? 3 : 2)} ${loUnit}` : (data.sell_pct ? `${data.sell_pct}%` : 'Position');
      const priceLine = loUnit === 'SOL'
        ? `📊 <b>Trigger Price:</b> ${currentPrice > 0 ? currentPrice.toExponential(4) : '—'} SOL\n`
        : `📊 <b>Trigger Price:</b> $${currentPrice.toFixed(6)}\n`;

      const msg =
        `🎯 <b>${sideIcon} ${sideText}!</b>\n\n` +
        `🪙 <b>Token:</b> $${symbol}\n` +
        `💵 <b>Amount:</b> ${amount}\n` +
        priceLine +
        `📈 <b>Market Cap:</b> $${currentMcap.toLocaleString('en-US', { maximumFractionDigits: 0 })}\n\n` +
        `🚀 <i>Swap dispatched to DEX executor. Confirmation will follow shortly.</i>`;

      await _bot.telegram.sendMessage(telegramId, msg, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🎒 Your Bags', callback_data: 'menu_holdings' },
              { text: '🎯 Active Orders', callback_data: 'menu_lo' },
            ],
          ],
        },
      }).catch(() => {});
      break;
    }

    case 'fleet_order_triggered' as any: {
      const fleetId = data.fleet_id as string;
      const fleetTag = (data.fleet_tag as string) || 'Fleet';
      const orderType = (data.order_type as string) || 'Order';
      const reason = (data.reason as string) || 'Trigger condition met';
      const tokenAddress = (data.token_address as string) || '';
      const currentPrice = Number(data.current_price || 0);
      const fleetUnit = isSolanaAddress(tokenAddress) ? 'SOL' : 'NEAR';
      const priceText = fleetUnit === 'SOL' ? `${currentPrice > 0 ? currentPrice.toExponential(4) : '—'} SOL` : `$${currentPrice.toFixed(6)}`;

      const msg =
        `🏎️ <b>RaceFleet [Beta] Order Triggered!</b>\n\n` +
        `🏷 <b>Fleet:</b> <code>${fleetTag}</code>\n` +
        `🪙 <b>Token:</b> <code>${tokenAddress}</code>\n` +
        `📊 <b>Type:</b> ${orderType.toUpperCase()}\n` +
        `🎯 <b>Trigger:</b> ${reason}\n` +
        `💵 <b>Price:</b> ${priceText}\n\n` +
        `<i>Coordinated bundle execution initiated across your fleet...</i>`;

      await _bot.telegram.sendMessage(telegramId, msg, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🏎️ Fleet Dashboard', callback_data: 'racefleet_menu' },
              { text: '🎒 Your Bags', callback_data: 'menu_holdings' },
            ],
          ],
        },
      }).catch(() => {});

      // Automatically execute fleet bundle if fleetId and tokenAddress exist
      if (fleetId && tokenAddress) {
        if (orderType === 'limit_buy') {
          const buyAmt = Number(data.amount_per_wallet) || (fleetUnit === 'SOL' ? 0.1 : 1.0);
          executeFleetBundleBuy(fleetId, tokenAddress, buyAmt, 3.0)
            .then((res) => {
              if (res.success) {
                _bot!.telegram.sendMessage(
                  telegramId,
                  `✅ <b>Fleet Limit Buy Executed!</b>\n\n` +
                  `🪙 <b>Token</b>: <code>${tokenAddress}</code>\n` +
                  `📦 <b>Swaps</b>: ${res.successCount} wallets\n` +
                  `💰 <b>Spent</b>: ${res.totalSpentNear} ${fleetUnit}`,
                  { parse_mode: 'HTML' }
                ).catch(() => {});
              } else {
                _bot!.telegram.sendMessage(
                  telegramId,
                  `❌ <b>Fleet Limit Buy Failed:</b> ${res.errors[0] || 'Unknown error'}`,
                  { parse_mode: 'HTML' }
                ).catch(() => {});
              }
            })
            .catch((err) => {
              _bot!.telegram.sendMessage(
                telegramId,
                `❌ <b>Fleet Order Execution Error:</b> ${err?.message || err}`,
                { parse_mode: 'HTML' }
              ).catch(() => {});
            });
        } else if (orderType === 'limit_sell' || orderType === 'tp_sl') {
          const sellPct = Number(data.sell_pct) || 100;
          executeFleetBundleSell(fleetId, tokenAddress, sellPct, 3.0)
            .then((res) => {
              if (res.success) {
                _bot!.telegram.sendMessage(
                  telegramId,
                  `✅ <b>Fleet ${orderType === 'tp_sl' ? 'Take Profit / Stop Loss' : 'Limit Sell'} Executed!</b>\n\n` +
                  `🪙 <b>Token</b>: <code>${tokenAddress}</code>\n` +
                  `📦 <b>Wallets Executed</b>: ${res.successCount} wallets`,
                  { parse_mode: 'HTML' }
                ).catch(() => {});
              } else {
                _bot!.telegram.sendMessage(
                  telegramId,
                  `❌ <b>Fleet Sell Failed:</b> ${res.errors[0] || 'Unknown error'}`,
                  { parse_mode: 'HTML' }
                ).catch(() => {});
              }
            })
            .catch((err) => {
              _bot!.telegram.sendMessage(
                telegramId,
                `❌ <b>Fleet Order Execution Error:</b> ${err?.message || err}`,
                { parse_mode: 'HTML' }
              ).catch(() => {});
            });
        }
      }
      break;
    }

    case 'limit_order_failed': {
      const symbol = (data.symbol as string) || 'TOKEN';
      const side = (data.side as string) || 'buy';
      const reason = (data.reason as string) || 'Unknown error';

      const msg =
        `⚠️ <b>Limit ${side.toUpperCase()} Failed</b>\n\n` +
        `🪙 <b>Token:</b> $${symbol}\n` +
        `❌ <b>Reason:</b> ${reason}\n\n` +
        `<i>Please deposit funds or update your order to resume.</i>`;

      await _bot.telegram.sendMessage(telegramId, msg, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '💳 Wallet', callback_data: 'menu_wallet' },
              { text: '🎯 Active Orders', callback_data: 'menu_lo' },
            ],
          ],
        },
      }).catch(() => {});
      break;
    }
  }
}

// Anti-loop deposit alert tracking: per user and chain
interface DepositAlertRecord {
  timestamp: number;
  amount: number;
}
const lastDepositAlertByUser = new Map<string, DepositAlertRecord>();
const depositSuppressionMap = new Map<string, number>();

/**
 * Explicitly suppress native deposit alerts for a user on a chain
 * (e.g. when multichain deposit already notified the user of settled funds).
 */
export function suppressDepositAlert(telegramId: number, chain = 'near', durationMs = 10 * 60 * 1000): void {
  const key = `${telegramId}:${chain}`;
  depositSuppressionMap.set(key, Date.now() + durationMs);
}

/**
 * Send an immediate deposit notification to a Telegram user with strict anti-loop deduplication.
 */
export async function notifyDeposit(
  telegramId: number,
  params: {
    chain: 'near' | 'sui' | 'starknet' | 'solana';
    amount: string;
    symbol?: string;
    address: string;
    usdValue?: string;
  }
): Promise<void> {
  if (!_bot || !telegramId) return;

  const chain = params.chain;
  const userChainKey = `${telegramId}:${chain}`;
  const now = Date.now();
  const amtNum = parseFloat(params.amount) || 0;

  // 1. Check explicit suppression (e.g. multichain deposit poller already notified)
  const suppressedUntil = depositSuppressionMap.get(userChainKey);
  if (suppressedUntil && now < suppressedUntil) {
    console.log(`[NOTIFY] Suppressed deposit alert for ${telegramId} on ${chain} (explicit suppression active)`);
    return;
  }

  // 2. Anti-Loop: Strict per-user time cooldown (minimum 60s between ANY deposit alerts on this chain)
  const lastAlert = lastDepositAlertByUser.get(userChainKey);
  if (lastAlert) {
    if (now - lastAlert.timestamp < 60_000) {
      console.warn(`[NOTIFY] Suppressed looping deposit alert for ${telegramId} on ${chain} (${Math.round((now - lastAlert.timestamp) / 1000)}s < 60s cooldown)`);
      return;
    }

    // 3. Duplicate/Flicker suppression within 15 minutes:
    // If the amount is identical or within 5% / 0.05 units of the previous alert, suppress it!
    if (now - lastAlert.timestamp < 15 * 60_000) {
      const diff = Math.abs(amtNum - lastAlert.amount);
      if (diff < 0.05 || (lastAlert.amount > 0 && (diff / lastAlert.amount) < 0.05)) {
        console.warn(`[NOTIFY] Suppressed duplicate/flicker deposit alert for ${telegramId} on ${chain} (amt=${amtNum}, prev=${lastAlert.amount})`);
        return;
      }
    }
  }

  // Record this alert to permanently prevent looping
  lastDepositAlertByUser.set(userChainKey, { timestamp: now, amount: amtNum });

  const amount = params.amount;
  const symbol = params.symbol || (chain === 'solana' ? 'SOL' : chain === 'starknet' ? 'STRK' : chain === 'sui' ? 'SUI' : 'NEAR');
  const address = params.address;
  const usdValue = params.usdValue || '';
  const icon = chain === 'solana' ? '🟣' : chain === 'starknet' ? '✨' : chain === 'sui' ? '🔷' : '⬛';
  const tokenIcon = chain === 'solana' ? '◎' : chain === 'starknet' ? '✨' : chain === 'sui' ? '💧' : 'Ⓝ';
  const chainLabel = chain === 'solana' ? 'Solana' : chain === 'starknet' ? 'Starknet' : chain === 'sui' ? 'SUI' : 'NEAR';

  const msg =
    `💰 <b>Deposit Confirmed!</b>\n\n` +
    `${icon} <b>+${amount} ${symbol}</b> ${tokenIcon} ${usdValue ? `(${usdValue})` : ''}\n` +
    `<u>${chainLabel}</u>: <code>${address}</code>\n\n` +
    `Your funds are credited and ready to trade.`;

  await _bot.telegram.sendMessage(telegramId, msg, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🎒 Your Bags', callback_data: 'menu_holdings' },
          { text: '💳 Wallet', callback_data: 'menu_wallet' },
        ],
        [
          { text: '🎯 Snipe', callback_data: 'menu_snipe' },
          { text: '👥 Copy Trade', callback_data: 'menu_copy' },
        ],
      ],
    },
  }).catch((err) => {
    console.error(`[NOTIFY] Error sending deposit notification to ${telegramId}:`, err.message);
  });
}

/**
 * Send a token deposit notification when an external token/meme coin is detected.
 */
const recentDepositNotifyCache = new Map<string, number>();

// Token symbols come from untrusted on-chain metadata; unescaped `<` or `&`
// makes Telegram reject the whole HTML message.
function escHtml(s: string): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function notifyTokenDeposit(
  telegramId: number,
  params: {
    tokenSymbol: string;
    tokenName?: string;
    amountFormatted: string;
    address: string;
    chain?: 'near' | 'sui' | 'solana' | 'hyperevm' | 'elysium';
    /** Position created for the deposit, so the alert can open its details directly. */
    positionId?: string;
  }
): Promise<void> {
  if (!_bot || !telegramId) return;

  const dedupKey = `token:${telegramId}:${params.chain || 'near'}:${params.address}:${params.tokenSymbol}:${params.amountFormatted}`;
  const lastSent = recentDepositNotifyCache.get(dedupKey) || 0;
  if (Date.now() - lastSent < 15 * 60 * 1000) {
    return; // Suppress duplicate alert within 15 minutes
  }
  recentDepositNotifyCache.set(dedupKey, Date.now());

  const chain = params.chain || 'near';
  const chainLabel = chain === 'solana' ? 'Solana' : chain === 'sui' ? 'SUI' : chain === 'elysium' ? 'Elysium' : chain === 'hyperevm' ? 'HyperEVM' : 'NEAR';

  const msg =
    `💰 <b>Token Deposit Received!</b>\n\n` +
    `🪙 <b>+${escHtml(params.amountFormatted)} $${escHtml(params.tokenSymbol)}</b>\n` +
    `<u>${chainLabel}</u>: <code>${escHtml(params.address)}</code>\n\n` +
    `Tracked and ready in your bags.`;

  const keyboard: any[][] = [];
  if (params.positionId) {
    keyboard.push([{ text: '📊 View Token Details', callback_data: `token_detail:${params.positionId}`, style: 'primary' }]);
  }
  keyboard.push([
    { text: '🎒 Your Bags', callback_data: 'menu_holdings' },
    { text: '💳 Wallet', callback_data: 'menu_wallet' },
  ]);

  await _bot.telegram.sendMessage(telegramId, msg, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard } as any,
  }).catch((err) => {
    console.error(`[NOTIFY] Error sending token deposit notification to ${telegramId}:`, err.message);
  });
}

/**
 * Send a PNL card after a trade confirms.
 * Called async — never blocks trade confirmation message.
 */
export async function sendPnlCard(telegramId: number, pnlData: {
  tokenName?: string;
  tokenTicker?: string;
  tokenSymbol?: string;
  entryPrice: number;
  exitPrice?: number;
  currentPrice?: number;
  quantity?: number;
  positionSize?: number;
  realizedPnlNear?: number;
  realizedPnlPercent?: number;
  profitAmount?: number;
  pnlPercent?: number;
  holdDuration?: string;
  duration?: string;
  positionId?: string;
  handle?: string;
  date?: string;
}): Promise<void> {
  if (!_bot) return;
  // Fire-and-forget — do not await
  sendNotification(telegramId, {
    type: 'notify_user',
    telegram_id: telegramId,
    event: 'pnl_card',
    data: pnlData as any,
  }).catch(() => {});
}
