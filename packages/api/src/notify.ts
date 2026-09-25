import type { Telegraf } from 'telegraf';
import { createRedis, CHANNELS, type NotifyUserEvent } from '@racerbot/shared';
import { getUserById } from '@racerbot/db';
import { PUBLIC_URL } from './config.js';

let _bot: Telegraf | null = null;

/** Strip Telegram Markdown control chars so user/data strings can't break messages. */
function sanitize(s: string): string {
  return String(s ?? '').replace(/[_*`\[]/g, ' ').slice(0, 300);
}

export function setBotInstance(bot: Telegraf): void {
  _bot = bot;
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

    // Resolve telegram_id from user_id if not set
    let telegramId = event.telegram_id;
    if (!telegramId && event.data?.user_id) {
      const user = await getUserById(event.data.user_id as string).catch(() => null);
      telegramId = user?.telegram_id ?? 0;
    }

    if (!telegramId || !_bot) return;

    await sendNotification(telegramId, event).catch(err => {
      console.error('[NOTIFY] Failed to send notification:', err.message);
    });
  });
}

async function sendNotification(telegramId: number, event: NotifyUserEvent): Promise<void> {
  if (!_bot) return;

  const data = event.data ?? {};

  switch (event.event) {
    case 'trigger_fired': {
      const triggerType = data.trigger_type as string;
      const token = data.token_address as string;
      const currentPrice = Number(data.current_price).toFixed(8);
      const label = triggerType === 'stop_loss' ? '🔴 Stop Loss' : triggerType === 'take_profit' ? '🟢 Take Profit' : '📈 Market Cap Target';
      await _bot.telegram.sendMessage(telegramId,
        `${label} triggered!\n\n🪙 Token: \`${token}\`\n💰 Price: ${currentPrice} NEAR\n\nSell order sent to executor.`,
        { parse_mode: 'Markdown' }
      );
      break;
    }

    case 'rug_check_failed':
    case 'auto_buy_skipped': {
      const token = data.token as string ?? data.token_address as string ?? 'unknown';
      const reason = data.reason as string ?? 'rug check failed';
      await _bot.telegram.sendMessage(telegramId,
        `⚠️ Auto-buy skipped\n\n🪙 Token: \`${token}\`\n📋 Reason: ${reason}\n\nThis is a safety measure — no funds were used.`,
        { parse_mode: 'Markdown' }
      );
      break;
    }

    case 'allowance_low': {
      await _bot.telegram.sendMessage(telegramId,
        `⚡ Scoped key allowance is running low.\n\nYour bot cannot execute more trades until you top up.\n\nUse /topup to add more allowance.`
      );
      break;
    }

    case 'pnl_card': {
      const pnl = data as any;
      const pnlPercent = pnl.realizedPnlPercent ?? pnl.pnlPercent ?? 0;
      const pnlSign = pnlPercent >= 0 ? '+' : '';
      const emoji = pnlPercent >= 0 ? '🟢' : '🔴';
      const tokenSym = pnl.tokenTicker || pnl.tokenSymbol || pnl.tokenName || 'TOKEN';
      const tokenName = pnl.tokenName || tokenSym;
      const exitPrice = pnl.exitPrice ?? pnl.currentPrice ?? 0;
      const realizedNear = pnl.realizedPnlNear ?? pnl.profitAmount ?? 0;
      const holdDuration = pnl.holdDuration || pnl.duration || '—';
      const quantity = pnl.quantity ?? pnl.positionSize ?? 0;

      const extra: any = { parse_mode: 'Markdown' };

      const cardUrl = pnl.positionId && PUBLIC_URL
        ? `${PUBLIC_URL}/pnl-card?positionId=${encodeURIComponent(pnl.positionId)}`
        : PUBLIC_URL
        ? `${PUBLIC_URL}/pnl-card?tokenSymbol=${encodeURIComponent(tokenSym)}&entryPrice=${pnl.entryPrice}&currentPrice=${exitPrice}&profitAmount=${realizedNear}&duration=${encodeURIComponent(holdDuration)}`
        : '';

      if (cardUrl) {
        extra.reply_markup = {
          inline_keyboard: [
            [
              { text: '🖼️ View PnL Card', web_app: { url: cardUrl } },
              { text: '📤 Share Card', url: `https://t.me/share/url?url=${encodeURIComponent(cardUrl)}&text=${encodeURIComponent(`🏎️ Made ${pnlSign}${Number(pnlPercent).toFixed(1)}% on $${tokenSym} with @racerbot!`)}` }
            ]
          ]
        };
      }

      await _bot.telegram.sendMessage(telegramId,
        `${emoji} *Trade Closed — PNL Summary*\n\n` +
        `🪙 ${tokenName} (${tokenSym})\n` +
        `📥 Entry: ${pnl.entryPrice} NEAR\n` +
        `📤 Exit: ${exitPrice} NEAR\n` +
        `📦 Quantity: ${quantity}\n` +
        `💰 Realized PNL: ${Number(realizedNear).toFixed(4)} NEAR (${pnlSign}${Number(pnlPercent).toFixed(2)}%)\n` +
        `⏱ Hold: ${holdDuration}`,
        extra
      );
      break;
    }

    case 'trade_failed': {
      const txHash = data.txHash as string ?? 'unknown';
      const reason = (data.reason as string) ?? 'transaction failed or slippage breach';
      await _bot.telegram.sendMessage(telegramId,
        `❌ *Trade Failed*\n\n` +
        `📋 Reason: ${sanitize(reason)}\n` +
        `🧾 TX: \`${sanitize(txHash)}\`\n\n` +
        `No position was opened by this transaction.`,
        { parse_mode: 'Markdown' }
      );
      break;
    }

    case 'token_not_found': {
      await _bot.telegram.sendMessage(telegramId,
        `❌ Token not found in cache.\n\nTry pasting the contract address (CA) directly for an exact match.`
      );
      break;
    }
  }
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
