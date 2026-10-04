import type { Telegraf, Context } from 'telegraf';
import { Markup } from 'telegraf';
import {
  createRedis,
  CHANNELS,
  type BuyAlertEvent,
  getShortTokenKey,
  resolveTokenAddressFromKey,
} from '@racerbot/shared';
import {
  upsertGroupBuyAlert,
  getGroupBuyAlert,
  getGroupBuyAlertsByChat,
  getGroupBuyAlertsByToken,
  updateGroupBuyAlert,
  deleteGroupBuyAlert,
  getOrCreateTokenShare,
  getUserByTelegramId,
  type GroupBuyAlertRecord,
} from '@racerbot/db';
import { getTokenInfo, isSuiToken } from './wallet.js';

let _bot: Telegraf | null = null;
const lastChatAlertTime = new Map<string, number>();
const CHAT_ALERT_COOLDOWN_MS = 1500; // 1.5s rate limit per group

// In-memory pending admin wizard actions
export interface BuyAlertPendingAction {
  adminId: number;
  chatId: string;
  alertId: string;
  type: 'custom_min_buy' | 'custom_emoji' | 'custom_whale' | 'upload_media';
  expiresAt: number;
}

export const buyAlertPendingActions = new Map<number, BuyAlertPendingAction>();

function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function maskAddress(addr: string): string {
  if (!addr) return 'Anonymous';
  if (addr.endsWith('.near') || addr.endsWith('.tg')) {
    return addr;
  }
  if (addr.length > 14) {
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  }
  return addr;
}

/**
 * Initialize Redis subscription to BUY_ALERT events and broadcast to Telegram groups.
 */
export async function startBuyAlertListener(redisUrl: string, bot: Telegraf): Promise<void> {
  _bot = bot;
  const redis = createRedis(redisUrl);

  await redis.subscribe(CHANNELS.BUY_ALERT, async (message: string) => {
    try {
      const event: BuyAlertEvent = JSON.parse(message);
      if (event.type !== 'buy_alert' || !event.token_address) return;
      await dispatchBuyAlert(event);
    } catch (err: any) {
      console.warn('[BUY_ALERTS] Error processing buy alert event:', err?.message);
    }
  });

  console.log('[BUY_ALERTS] Listener subscribed to channel:', CHANNELS.BUY_ALERT);
}

/**
 * Dispatches a buy alert to all Telegram groups tracking the token.
 */
export async function dispatchBuyAlert(event: BuyAlertEvent): Promise<void> {
  if (!_bot) return;

  const alerts = await getGroupBuyAlertsByToken(event.token_address).catch(() => []);
  if (!alerts || alerts.length === 0) return;

  const botUsername = _bot.botInfo?.username || 'racertradingbot';
  const now = Date.now();

  for (const alert of alerts) {
    if (!alert.is_active) continue;
    if (event.spent_usd < alert.min_buy_usd) continue;

    // Rate-limit per group to prevent message spam / 429
    const lastTime = lastChatAlertTime.get(alert.chat_id) || 0;
    if (now - lastTime < CHAT_ALERT_COOLDOWN_MS) {
      continue;
    }
    lastChatAlertTime.set(alert.chat_id, now);

    try {
      await sendGroupAlertMessage(alert, event, botUsername);
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      console.warn(`[BUY_ALERTS] Failed to send alert to chat ${alert.chat_id}:`, errMsg);

      // Auto-deactivate if bot was kicked or chat deleted
      if (
        errMsg.includes('chat not found') ||
        errMsg.includes('bot was kicked') ||
        errMsg.includes('bot was blocked') ||
        errMsg.includes('group chat was deactivated') ||
        errMsg.includes('not enough rights')
      ) {
        try {
          await updateGroupBuyAlert(alert.id, { is_active: false });
        } catch {
          // ignore
        }
      }
    }
  }
}

/**
 * Formats and sends the alert message to a specific Telegram group.
 */
async function sendGroupAlertMessage(
  alert: GroupBuyAlertRecord,
  event: BuyAlertEvent,
  botUsername: string
): Promise<void> {
  if (!_bot) return;

  const emoji = alert.emoji || '🏎️';
  const step = alert.emoji_step_usd > 0 ? alert.emoji_step_usd : 5;
  const count = Math.min(35, Math.max(1, Math.floor(event.spent_usd / step)));
  const emojiBar = emoji.repeat(count);

  const isWhale = event.spent_usd >= (alert.whale_threshold_usd || 200);
  const whaleHeader = isWhale ? '🚨 <b>WHALE BUY DETECTED!</b> 🚨\n\n' : '';

  // Generate 1-tap Buy URL with group admin referral attribution
  let startParam = getShortTokenKey(event.token_address);
  try {
    const adminUser = await getUserByTelegramId(Number(alert.admin_id));
    if (adminUser) {
      const shareCode = await getOrCreateTokenShare(adminUser.id, event.token_address);
      if (shareCode) {
        startParam = shareCode;
      }
    }
  } catch {
    // fallback to short token key
  }

  const buyDeepLink = `https://t.me/${botUsername}?start=${startParam}`;

  const isSui = event.chain === 'sui';
  const explorerUrl = isSui
    ? `https://suiscan.xyz/mainnet/tx/${event.tx_hash}`
    : `https://nearblocks.io/txns/${event.tx_hash}`;

  const dexUrl = `https://dexscreener.com/${isSui ? 'sui' : 'near'}/${event.token_address}`;

  const priceLine = event.price_usd != null && event.price_usd > 0
    ? `\n💵 <b>Price:</b> $${event.price_usd < 0.0001 ? event.price_usd.toExponential(3) : event.price_usd.toFixed(4)}`
    : '';

  const mcapLine = event.market_cap_usd != null && event.market_cap_usd > 0
    ? `\n📊 <b>MCap:</b> $${event.market_cap_usd.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
    : '';

  const caption =
    `🏎️ <b>RACERBOT BUY ALERT</b> 🏎️\n` +
    whaleHeader +
    `${emojiBar}\n\n` +
    `🪙 <b>Token:</b> ${escapeHtml(event.token_name)} ($${escapeHtml(event.token_symbol)})\n` +
    `💰 <b>Spent:</b> <b>${event.spent_amount_native}</b> ($${event.spent_usd.toFixed(2)} USD)\n` +
    `📦 <b>Got:</b> ${event.tokens_received}\n` +
    `👤 <b>Buyer:</b> <code>${maskAddress(event.buyer_address)}</code>` +
    priceLine +
    mcapLine +
    `\n\n` +
    `🔗 <a href="${explorerUrl}">TX</a> | <a href="${dexUrl}">DexScreener</a>`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.url('⚡ Buy on RacerBot', buyDeepLink)],
  ]);

  if (alert.media_file_id && alert.media_type !== 'none' && alert.media_type !== 'default') {
    try {
      if (alert.media_type === 'animation') {
        await _bot.telegram.sendAnimation(alert.chat_id, alert.media_file_id, {
          caption,
          parse_mode: 'HTML',
          ...keyboard,
        });
        return;
      } else if (alert.media_type === 'photo') {
        await _bot.telegram.sendPhoto(alert.chat_id, alert.media_file_id, {
          caption,
          parse_mode: 'HTML',
          ...keyboard,
        });
        return;
      }
    } catch (mediaErr: any) {
      console.warn(`[BUY_ALERTS] Media send failed, falling back to text:`, mediaErr?.message);
    }
  }

  // Fallback to text message
  await _bot.telegram.sendMessage(alert.chat_id, caption, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: false },
    ...keyboard,
  } as any);
}

/**
 * Build the interactive settings menu for an alert configuration.
 */
export function buildAlertSettingsCard(alert: GroupBuyAlertRecord): { text: string; keyboard: any } {
  const statusIcon = alert.is_active ? '🟢 ACTIVE' : '🔴 PAUSED';
  const chainIcon = alert.chain === 'sui' ? '💧 SUI' : '⬛ NEAR';
  const mediaLabel = alert.media_file_id ? 'Custom Media 🖼️' : 'Default Text 🏎️';

  const text =
    `🏎️ <b>RacerBot Group Buy Alert Settings</b>\n\n` +
    `👥 <b>Group:</b> ${escapeHtml(alert.chat_title || alert.chat_id)}\n` +
    `⛓️ <b>Chain:</b> ${chainIcon}\n` +
    `🪙 <b>Token CA:</b> <code>${alert.token_address}</code>\n` +
    `⚡ <b>Status:</b> ${statusIcon}\n\n` +
    `⚙️ <b>Current Configuration:</b>\n` +
    `• <b>Min Buy Alert:</b> $${alert.min_buy_usd.toFixed(2)} USD\n` +
    `• <b>Emoji:</b> ${alert.emoji} (1 per $${alert.emoji_step_usd.toFixed(2)})\n` +
    `• <b>Whale Alert:</b> $${alert.whale_threshold_usd.toFixed(2)} USD\n` +
    `• <b>Banner Media:</b> ${mediaLabel}\n\n` +
    `💡 <i>Members tapping "⚡ Buy on RacerBot" will auto-credit 5% of their trading fees to you!</i>`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(`💵 Min: $${alert.min_buy_usd}`, `ba_cycle_min:${alert.id}`),
      Markup.button.callback(`🎨 Emoji: ${alert.emoji}`, `ba_cycle_emoji:${alert.id}`),
    ],
    [
      Markup.button.callback(`🐋 Whale: $${alert.whale_threshold_usd}`, `ba_cycle_whale:${alert.id}`),
      Markup.button.callback(`🖼️ Set GIF/Pic`, `ba_prompt_media:${alert.id}`),
    ],
    [
      Markup.button.callback(alert.is_active ? '⏸️ Pause' : '▶️ Activate', `ba_toggle:${alert.id}`),
      Markup.button.callback('⚡ Test Alert', `ba_test:${alert.id}`),
    ],
    [
      Markup.button.callback('🔄 Reset Media', `ba_clear_media:${alert.id}`),
      Markup.button.callback('🗑️ Stop Tracking', `ba_delete:${alert.id}`),
    ],
  ]);

  return { text, keyboard };
}

/**
 * Handle /track or /buybot command.
 */
export async function handleBuyBotCommand(ctx: Context): Promise<void> {
  const chatType = ctx.chat?.type;
  const isGroup = chatType === 'group' || chatType === 'supergroup';

  if (!isGroup) {
    await ctx.reply(
      `🏎️ <b>RacerBot Group Buy Alert Bot</b>\n\n` +
      `To activate live BUY alerts in your Telegram group:\n\n` +
      `1️⃣ Add <b>@${ctx.botInfo?.username || 'racertradingbot'}</b> to your Telegram group.\n` +
      `2️⃣ Promote the bot to <b>Administrator</b> (with Send Messages permission).\n` +
      `3️⃣ Send the command in your group:\n` +
      `<code>/track &lt;token_contract_address&gt;</code>\n\n` +
      `✨ <b>Features:</b>\n` +
      `• High-energy buy alerts with custom emojis & GIFs\n` +
      `• Whale alert detection\n` +
      `• 1-Tap Buy button redirecting to DM\n` +
      `• <b>Earn 5% fee share</b> on every buy your community makes!`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  // Verify caller is group administrator
  const member = await ctx.getChatMember(ctx.from!.id).catch(() => null);
  const isAdmin = member && (member.status === 'creator' || member.status === 'administrator');
  if (!isAdmin) {
    await ctx.reply('⚠️ Only group administrators can configure RacerBot buy alerts.');
    return;
  }

  const text = (ctx.message as any)?.text || '';
  const args = text.trim().split(/\s+/).slice(1);
  const rawTokenInput = args[0]?.trim();

  if (!rawTokenInput) {
    // Show existing alerts for this chat or help
    const existing = await getGroupBuyAlertsByChat(ctx.chat!.id).catch(() => []);
    if (existing.length === 0) {
      await ctx.reply(
        `🏎️ <b>Track Token Buys in this Group</b>\n\n` +
        `Usage: <code>/track &lt;token_contract_address&gt;</code>\n\n` +
        `Examples:\n` +
        `• NEAR: <code>/track blackdragon.tkn.near</code>\n` +
        `• SUI: <code>/track 0x2::sui::SUI</code>`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    // Display first alert settings card
    const card = buildAlertSettingsCard(existing[0]);
    await ctx.reply(card.text, { parse_mode: 'HTML', ...card.keyboard });
    return;
  }

  // Resolve token address
  let tokenAddress = rawTokenInput;
  if (tokenAddress.length <= 12 && !tokenAddress.includes('.')) {
    const resolved = resolveTokenAddressFromKey(tokenAddress);
    if (resolved) tokenAddress = resolved;
  }

  const isSui = isSuiToken(tokenAddress) || tokenAddress.startsWith('0x');

  // Verify token exists via getTokenInfo
  try {
    await getTokenInfo(tokenAddress);
  } catch (err: any) {
    console.warn(`[/track] Token verification notice: ${err?.message}`);
  }

  const alert = await upsertGroupBuyAlert({
    chatId: ctx.chat!.id,
    chatTitle: (ctx.chat as any)?.title || 'Group',
    adminId: ctx.from!.id,
    tokenAddress,
    chain: isSui ? 'sui' : 'near',
    minBuyUsd: 5.0,
    emoji: '🏎️',
    emojiStepUsd: 5.0,
    whaleThresholdUsd: 200.0,
  });

  const card = buildAlertSettingsCard(alert);
  await ctx.reply(
    `✅ <b>RacerBot is now tracking buys for this group!</b>\n\n` + card.text,
    { parse_mode: 'HTML', ...card.keyboard }
  );
}

/**
 * Handle inline button actions (ba_...)
 */
export async function handleBuyAlertAction(ctx: Context): Promise<void> {
  const cbQuery = ctx.callbackQuery;
  const data = (cbQuery as any)?.data as string;
  if (!data || !data.startsWith('ba_')) return;

  const fromId = ctx.from?.id;
  if (!fromId) return;

  // Check admin rights if in group
  if (ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup') {
    const member = await ctx.getChatMember(fromId).catch(() => null);
    const isAdmin = member && (member.status === 'creator' || member.status === 'administrator');
    if (!isAdmin) {
      await ctx.answerCbQuery('⚠️ Only group administrators can edit settings.').catch(() => {});
      return;
    }
  }

  const parts = data.split(':');
  const action = parts[0];
  const alertId = parts[1];

  const db = await (await import('@racerbot/db')).getDb();
  const res = await db.query('SELECT * FROM group_buy_alerts WHERE id = $1', [alertId]);
  if (!res.rows[0]) {
    await ctx.answerCbQuery('Alert configuration not found.').catch(() => {});
    return;
  }
  const currentAlert: GroupBuyAlertRecord = {
    id: res.rows[0].id,
    chat_id: res.rows[0].chat_id.toString(),
    chat_title: res.rows[0].chat_title || undefined,
    admin_id: res.rows[0].admin_id.toString(),
    token_address: res.rows[0].token_address,
    chain: res.rows[0].chain || 'near',
    min_buy_usd: parseFloat(res.rows[0].min_buy_usd || '5.00'),
    emoji: res.rows[0].emoji || '🏎️',
    emoji_step_usd: parseFloat(res.rows[0].emoji_step_usd || '5.00'),
    media_file_id: res.rows[0].media_file_id || undefined,
    media_type: res.rows[0].media_type || 'default',
    whale_threshold_usd: parseFloat(res.rows[0].whale_threshold_usd || '200.00'),
    is_active: Boolean(res.rows[0].is_active),
    created_at: new Date(res.rows[0].created_at),
    updated_at: new Date(res.rows[0].updated_at),
  };

  switch (action) {
    case 'ba_toggle': {
      const updated = await updateGroupBuyAlert(alertId, { is_active: !currentAlert.is_active });
      const card = buildAlertSettingsCard(updated);
      await ctx.editMessageText(card.text, { parse_mode: 'HTML', ...card.keyboard }).catch(() => {});
      await ctx.answerCbQuery(updated.is_active ? '✅ Activated!' : '⏸️ Paused!').catch(() => {});
      break;
    }

    case 'ba_cycle_min': {
      const steps = [1, 5, 10, 25, 50, 100];
      const curIdx = steps.indexOf(currentAlert.min_buy_usd);
      const nextVal = curIdx === -1 || curIdx >= steps.length - 1 ? steps[0] : steps[curIdx + 1];
      const updated = await updateGroupBuyAlert(alertId, { min_buy_usd: nextVal });
      const card = buildAlertSettingsCard(updated);
      await ctx.editMessageText(card.text, { parse_mode: 'HTML', ...card.keyboard }).catch(() => {});
      await ctx.answerCbQuery(`Min buy set to $${nextVal}`).catch(() => {});
      break;
    }

    case 'ba_cycle_emoji': {
      const emojis = ['🏎️', '🚀', '🟢', '🔥', '💎', '🐂', '⚡', '💰'];
      const curIdx = emojis.indexOf(currentAlert.emoji);
      const nextEmoji = curIdx === -1 || curIdx >= emojis.length - 1 ? emojis[0] : emojis[curIdx + 1];
      const updated = await updateGroupBuyAlert(alertId, { emoji: nextEmoji });
      const card = buildAlertSettingsCard(updated);
      await ctx.editMessageText(card.text, { parse_mode: 'HTML', ...card.keyboard }).catch(() => {});
      await ctx.answerCbQuery(`Emoji set to ${nextEmoji}`).catch(() => {});
      break;
    }

    case 'ba_cycle_whale': {
      const whales = [50, 100, 200, 500, 1000];
      const curIdx = whales.indexOf(currentAlert.whale_threshold_usd);
      const nextWhale = curIdx === -1 || curIdx >= whales.length - 1 ? whales[0] : whales[curIdx + 1];
      const updated = await updateGroupBuyAlert(alertId, { whale_threshold_usd: nextWhale });
      const card = buildAlertSettingsCard(updated);
      await ctx.editMessageText(card.text, { parse_mode: 'HTML', ...card.keyboard }).catch(() => {});
      await ctx.answerCbQuery(`Whale threshold set to $${nextWhale}`).catch(() => {});
      break;
    }

    case 'ba_prompt_media': {
      buyAlertPendingActions.set(fromId, {
        adminId: fromId,
        chatId: currentAlert.chat_id,
        alertId: currentAlert.id,
        type: 'upload_media',
        expiresAt: Date.now() + 5 * 60_000,
      });
      await ctx.reply(
        `🖼️ <b>Upload Custom GIF or Photo Banner</b>\n\n` +
        `Send a GIF (animation) or photo to this chat right now, and it will be displayed on all live BUY alerts for this group!\n\n` +
        `<i>(Send /cancel anytime to cancel)</i>`,
        { parse_mode: 'HTML' }
      );
      await ctx.answerCbQuery('Send your GIF or Photo now').catch(() => {});
      break;
    }

    case 'ba_clear_media': {
      const updated = await updateGroupBuyAlert(alertId, {
        media_file_id: undefined,
        media_type: 'default',
      });
      const card = buildAlertSettingsCard(updated);
      await ctx.editMessageText(card.text, { parse_mode: 'HTML', ...card.keyboard }).catch(() => {});
      await ctx.answerCbQuery('Media reset to default text').catch(() => {});
      break;
    }

    case 'ba_test': {
      await ctx.answerCbQuery('⚡ Sending test alert...').catch(() => {});
      const sampleEvent: BuyAlertEvent = {
        type: 'buy_alert',
        chain: currentAlert.chain,
        token_address: currentAlert.token_address,
        token_name: 'Sample Token',
        token_symbol: currentAlert.chain === 'sui' ? 'SUI_TOKEN' : 'NEAR_TOKEN',
        buyer_address: currentAlert.chain === 'sui' ? '0x7a3...c91' : 'racer_whale.near',
        spent_amount_native: currentAlert.chain === 'sui' ? '25.00 SUI' : '15.00 NEAR',
        spent_usd: 50.00,
        tokens_received: '1,250,000 TOKEN',
        price_usd: 0.00004,
        market_cap_usd: 40000,
        tx_hash: 'test_tx_hash_preview',
        timestamp: Date.now(),
      };
      const botUsername = ctx.botInfo?.username || 'racertradingbot';
      await sendGroupAlertMessage(currentAlert, sampleEvent, botUsername).catch((err) => {
        ctx.reply(`❌ Test alert failed: ${err?.message || err}`);
      });
      break;
    }

    case 'ba_delete': {
      await deleteGroupBuyAlert(currentAlert.chat_id, currentAlert.token_address);
      await ctx.editMessageText(
        `🗑️ <b>Tracking removed</b> for <code>${currentAlert.token_address}</code>.\n\nUse <code>/track &lt;token_address&gt;</code> to set up alerts again.`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
      await ctx.answerCbQuery('Tracking deleted').catch(() => {});
      break;
    }

    default:
      await ctx.answerCbQuery().catch(() => {});
  }
}

/**
 * Handle media uploads (animations/photos) when in pending upload_media state.
 */
export async function handleBuyAlertMediaUpload(ctx: Context): Promise<boolean> {
  const fromId = ctx.from?.id;
  if (!fromId) return false;

  const pending = buyAlertPendingActions.get(fromId);
  if (!pending || pending.type !== 'upload_media' || Date.now() > pending.expiresAt) {
    return false;
  }

  buyAlertPendingActions.delete(fromId);

  const message = ctx.message as any;
  let fileId: string | null = null;
  let mediaType: 'animation' | 'photo' = 'photo';

  if (message?.animation?.file_id) {
    fileId = message.animation.file_id;
    mediaType = 'animation';
  } else if (message?.photo && Array.isArray(message.photo) && message.photo.length > 0) {
    fileId = message.photo[message.photo.length - 1].file_id;
    mediaType = 'photo';
  } else if (message?.document?.mime_type?.includes('gif')) {
    fileId = message.document.file_id;
    mediaType = 'animation';
  }

  if (!fileId) {
    await ctx.reply('⚠️ Please send a valid GIF or photo to set as the alert banner.');
    return true;
  }

  try {
    const updated = await updateGroupBuyAlert(pending.alertId, {
      media_file_id: fileId,
      media_type: mediaType,
    });
    const card = buildAlertSettingsCard(updated);
    await ctx.reply(
      `✅ <b>Custom banner updated successfully!</b>\n\n` + card.text,
      { parse_mode: 'HTML', ...card.keyboard }
    );
  } catch (err: any) {
    await ctx.reply(`❌ Failed to update banner: ${err?.message || err}`);
  }

  return true;
}
