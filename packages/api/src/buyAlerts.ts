import type { Telegraf, Context } from 'telegraf';
import { Markup } from 'telegraf';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
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
  getTokenCache,
  type GroupBuyAlertRecord,
} from '@racerbot/db';
import { getTokenInfo, isSuiToken } from './wallet.js';

let _bot: Telegraf | null = null;

// ── Default alert banner (RacerBot logo) ──────────────────────────────────────
let defaultLogoFileId: string | null = null;
let defaultLogoPath: string | null | undefined;

function resolveDefaultLogoPath(): string | null {
  if (defaultLogoPath !== undefined) return defaultLogoPath;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '..', 'assets', 'logo.png'),
    path.resolve(here, 'assets', 'logo.png'),
    path.resolve(here, '..', '..', '..', 'assets', 'logo.png'),
    path.resolve(process.cwd(), 'assets', 'logo.png'),
  ];
  defaultLogoPath = candidates.find(p => fs.existsSync(p)) ?? null;
  if (!defaultLogoPath) console.warn('[BUY_ALERTS] RacerBot logo.png not found — default banner disabled');
  return defaultLogoPath;
}

function getDefaultLogoInput(): string | { source: string } | null {
  if (defaultLogoFileId) return defaultLogoFileId;
  const p = resolveDefaultLogoPath();
  return p ? { source: p } : null;
}
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

export function setBotInstance(bot: Telegraf): void {
  _bot = bot;
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

const seenBuyAlerts = new Map<string, number>();

/**
 * Dispatches a buy alert to all Telegram groups tracking the token.
 */
export async function dispatchBuyAlert(event: BuyAlertEvent): Promise<void> {
  if (!_bot) return;

  // Deduplicate alerts across executor and detector streams
  const dedupKey = event.tx_hash
    ? `${event.tx_hash}:${event.token_address.toLowerCase()}`
    : `${event.token_address.toLowerCase()}:${event.buyer_address}:${event.spent_amount_native}:${Math.floor(event.timestamp / 5000)}`;

  const now = Date.now();
  if (seenBuyAlerts.has(dedupKey) && (now - (seenBuyAlerts.get(dedupKey) || 0)) < 300_000) {
    return;
  }
  seenBuyAlerts.set(dedupKey, now);

  if (seenBuyAlerts.size > 5000) {
    for (const [k, v] of seenBuyAlerts.entries()) {
      if (now - v > 300_000) seenBuyAlerts.delete(k);
    }
  }

  const alerts = await getGroupBuyAlertsByToken(event.token_address).catch(() => []);
  if (!alerts || alerts.length === 0) return;

  const botUsername = _bot.botInfo?.username || 'racertradingbot';

  for (const alert of alerts) {
    if (!alert.is_active) continue;
    const minBuy = parseFloat(String(alert.min_buy_usd ?? '0')) || 0;
    if (event.spent_usd < minBuy) continue;

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
  const step = parseFloat(String(alert.emoji_step_usd ?? '5')) || 5;
  const count = Math.min(35, Math.max(1, Math.floor(event.spent_usd / step)));
  const emojiBar = emoji.repeat(count);

  const whaleThreshold = parseFloat(String(alert.whale_threshold_usd ?? '200')) || 200;
  const isWhale = event.spent_usd >= whaleThreshold;
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
    ? (event.tx_hash ? `https://suiscan.xyz/mainnet/tx/${event.tx_hash}` : `https://suiscan.xyz/mainnet/coin/${event.token_address}`)
    : (event.tx_hash ? `https://nearblocks.io/txns/${event.tx_hash}` : `https://nearblocks.io/token/${event.token_address}`);

  const dexUrl = `https://dexscreener.com/${isSui ? 'sui' : 'near'}/${event.token_address}`;

  // Check if token has bonded on DEX (or is a standard non-curve pool)
  const tokenCache = await getTokenCache(event.token_address).catch(() => null);
  const isPrebonded = tokenCache?.bonding_phase === 'prebonded' ||
    (event.token_address.endsWith('.nearlytrade.near') && tokenCache?.bonding_phase !== 'bonded');
  const isBonded = !isPrebonded;

  // Resolve market cap — use event value if present, otherwise fetch live from token info cache
  let resolvedMcapUsd = event.market_cap_usd;
  if (!resolvedMcapUsd || resolvedMcapUsd <= 0) {
    try {
      const liveInfo = await getTokenInfo(event.token_address);
      if (liveInfo?.market_cap_usd && liveInfo.market_cap_usd > 0) {
        resolvedMcapUsd = liveInfo.market_cap_usd;
      }
    } catch { /* non-fatal */ }
  }

  const priceLine = event.price_usd != null && event.price_usd > 0
    ? `\n💵 <b>Price:</b> $${event.price_usd < 0.0001 ? event.price_usd.toExponential(3) : event.price_usd.toFixed(4)}`
    : '';

  const mcapLine = resolvedMcapUsd != null && resolvedMcapUsd > 0
    ? `\n📊 <b>MCap:</b> $${resolvedMcapUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
    : '';

  // Buyer balance line — shows NEAR or SUI balance to help spot whale buys
  const nativeToken = isSui ? 'SUI' : 'NEAR';
  const buyerBalance = isSui ? event.buyer_sui_balance : event.buyer_near_balance;
  const buyerBalanceLine = buyerBalance != null && buyerBalance > 0
    ? `\n💼 <b>Buyer Balance:</b> ${buyerBalance.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${nativeToken}`
    : '';

  const caption =
    `🏎️ <b>RACERBOT BUY ALERT</b> 🏎️\n` +
    whaleHeader +
    `${emojiBar}\n\n` +
    `🪙 <b>Token:</b> ${escapeHtml(event.token_name)} ($${escapeHtml(event.token_symbol)})\n` +
    `📄 <b>CA:</b> <code>${event.token_address}</code>\n` +
    `💰 <b>Spent:</b> <b>${event.spent_amount_native}</b> ($${event.spent_usd.toFixed(2)} USD)\n` +
    `📦 <b>Got:</b> ${event.tokens_received}\n` +
    `👤 <b>Buyer:</b> <code>${maskAddress(event.buyer_address)}</code>${buyerBalanceLine}` +
    priceLine +
    mcapLine;

  const actionButtons: any[] = [
    Markup.button.url('🔍 Explorer', explorerUrl),
  ];

  if (isBonded) {
    actionButtons.push(Markup.button.url('📈 DexScreener', dexUrl));
  } else if (event.token_address.endsWith('.nearlytrade.near')) {
    actionButtons.push(Markup.button.url('💧 NearlyTrade', `https://nearlytrade.com/token/${event.token_address}`));
  }

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.url(`⚡ BUY $${event.token_symbol} on RacerBot`, buyDeepLink)],
    actionButtons,
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
      console.warn(`[BUY_ALERTS] Media send failed, falling back to default logo:`, mediaErr?.message);
    }
  }

  // Default banner: RacerBot logo (unless the admin explicitly chose text-only)
  if (alert.media_type !== 'none') {
    const photo = getDefaultLogoInput();
    if (photo) {
      try {
        const sent: any = await _bot.telegram.sendPhoto(alert.chat_id, photo as any, {
          caption,
          parse_mode: 'HTML',
          ...keyboard,
        });
        // Cache Telegram file_id so the logo is uploaded only once
        const sizes = sent?.photo;
        if (!defaultLogoFileId && Array.isArray(sizes) && sizes.length > 0) {
          defaultLogoFileId = sizes[sizes.length - 1].file_id;
        }
        return;
      } catch (logoErr: any) {
        const msg = logoErr?.message || '';
        // Kicked / no-rights errors must propagate so the alert gets auto-paused
        if (/chat not found|bot was kicked|bot was blocked|deactivated|not enough rights/i.test(msg)) {
          throw logoErr;
        }
        defaultLogoFileId = null;
        console.warn(`[BUY_ALERTS] Default logo send failed, falling back to text:`, msg);
      }
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
  const mediaLabel = alert.media_file_id
    ? 'Custom Media 🖼️'
    : alert.media_type === 'none'
      ? 'Text Only 📝'
      : 'RacerBot Logo 🏎️ (default)';

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
 * Handle /track or /buybot or /buyalert command.
 * Works seamlessly in Telegram groups as well as private DMs (for previewing & 1-tap group adding).
 */
export async function handleBuyBotCommand(ctx: Context): Promise<void> {
  try {
    const chatType = ctx.chat?.type;
    const isGroup = chatType === 'group' || chatType === 'supergroup';
    const botUsername = ctx.botInfo?.username || 'racertradingbot';

    const text = (ctx.message as any)?.text || '';
    const args = text.trim().split(/\s+/).slice(1);
    const rawTokenInput = args[0]?.trim();

    // ── Handle Private DM Chat ────────────────────────────────────────────────
    if (!isGroup) {
      if (rawTokenInput) {
        // Resolve token
        let tokenAddress = rawTokenInput;
        if (tokenAddress.length <= 12 && !tokenAddress.includes('.')) {
          const resolved = resolveTokenAddressFromKey(tokenAddress);
          if (resolved) tokenAddress = resolved;
        }

        const isSui = isSuiToken(tokenAddress) || tokenAddress.startsWith('0x');
        let tokenInfo: any = null;
        try {
          tokenInfo = await getTokenInfo(tokenAddress);
        } catch {
          // fallback
        }

        const sym = tokenInfo?.symbol || (isSui ? 'TOKEN' : tokenAddress.split('.')[0].toUpperCase());
        const name = tokenInfo?.name || sym;
        const addGroupUrl = `https://t.me/${botUsername}?startgroup=track_${tokenAddress.replace(/\./g, '_')}&admin=post_messages+edit_messages+delete_messages`;

        const sampleEvent: BuyAlertEvent = {
          type: 'buy_alert',
          chain: isSui ? 'sui' : 'near',
          token_address: tokenAddress,
          token_name: name,
          token_symbol: sym,
          buyer_address: isSui ? '0x8b3...4f1' : 'whale.near',
          spent_amount_native: isSui ? '25.00 SUI' : '10.00 NEAR',
          spent_usd: 50.00,
          tokens_received: `1,500,000 ${sym}`,
          price_usd: tokenInfo?.price_usd ? parseFloat(tokenInfo.price_usd) : 0.000033,
          market_cap_usd: tokenInfo?.market_cap_usd || 16200,
          tx_hash: 'sample_preview_tx',
          timestamp: Date.now(),
        };

        const previewAlert: GroupBuyAlertRecord = {
          id: 'preview',
          chat_id: String(ctx.chat!.id),
          chat_title: 'Preview',
          admin_id: String(ctx.from!.id),
          token_address: tokenAddress,
          chain: isSui ? 'sui' : 'near',
          min_buy_usd: 5.0,
          emoji: '🏎️',
          emoji_step_usd: 5.0,
          media_type: 'default',
          whale_threshold_usd: 200.0,
          is_active: true,
          created_at: new Date(),
          updated_at: new Date(),
        };

        await ctx.reply(
          `🏎️ <b>RacerBot Buy Alert Preview for $${escapeHtml(sym)}</b>\n\n` +
          `Here is how live buy alerts will look in your group:`,
          { parse_mode: 'HTML' }
        );

        await sendGroupAlertMessage(previewAlert, sampleEvent, botUsername);

        await ctx.reply(
          `📢 <b>Ready to activate for your community?</b>\n\n` +
          `1️⃣ Tap the button below to add RacerBot to your Telegram Group:\n` +
          `2️⃣ Promote RacerBot as Administrator.\n` +
          `3️⃣ Then type: <code>/track ${escapeHtml(tokenAddress)}</code> in your group!`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.url(`➕ Add RacerBot to Group ($${sym})`, addGroupUrl)],
            ]),
          }
        );
        return;
      }

      await ctx.reply(
        `🏎️ <b>RacerBot Group Buy Alert Bot</b>\n\n` +
        `To activate live BUY alerts in your Telegram group:\n\n` +
        `1️⃣ Add <b>@${botUsername}</b> to your Telegram group.\n` +
        `2️⃣ Promote the bot to <b>Administrator</b> (with Send Messages permission).\n` +
        `3️⃣ Send the command in your group:\n` +
        `<code>/track &lt;token_contract_address&gt;</code>\n\n` +
        `✨ <b>Features:</b>\n` +
        `• High-energy buy alerts with custom emojis & GIFs\n` +
        `• Whale alert detection\n` +
        `• 1-Tap Buy button redirecting to DM\n` +
        `• <b>Earn 5% fee share</b> on every buy your community makes!\n\n` +
        `💡 <i>Tip: You can preview a token alert right here in DM by typing:</i>\n` +
        `<code>/buyalert lili.nearlytrade.near</code>`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    // ── Handle Group Chat ─────────────────────────────────────────────────────
    // Verify caller is group administrator (supports standard admins and anonymous admins)
    const isAnonymousAdmin = Boolean(ctx.senderChat && ctx.chat && (ctx.senderChat.id === ctx.chat.id));
    let isAdmin = isAnonymousAdmin;
    if (!isAdmin && ctx.from?.id) {
      const member = await ctx.getChatMember(ctx.from.id).catch(() => null);
      isAdmin = Boolean(member && (member.status === 'creator' || member.status === 'administrator'));
    }

    if (!isAdmin) {
      await ctx.reply('⚠️ Only group administrators can configure RacerBot buy alerts.');
      return;
    }

    if (!rawTokenInput) {
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

      const alert = existing[0];
      const card = buildAlertSettingsCard(alert);
      const dmConfigUrl = `https://t.me/${botUsername}?start=cfg_${alert.id}`;
      const adminMention = ctx.from?.username ? `@${ctx.from.username}` : (ctx.from?.first_name || 'Admin');

      let sentToDm = false;
      if (ctx.from?.id && !isAnonymousAdmin) {
        try {
          await ctx.telegram.sendMessage(ctx.from.id, card.text, {
            parse_mode: 'HTML',
            ...card.keyboard,
          });
          sentToDm = true;
        } catch {
          // Admin has not started bot in DM yet
        }
      }

      if (sentToDm) {
        await ctx.reply(
          `⚙️ <b>RacerBot Group Buy Alert Settings</b>\n\n` +
          `📬 <i>${escapeHtml(adminMention)}, I've sent the settings & customization menu to your <b>private chat (DM)</b> to avoid cluttering this group!</i>`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.url('⚙️ Open Settings in DM', dmConfigUrl)],
            ]),
          }
        );
      } else {
        await ctx.reply(
          `⚙️ <b>RacerBot Group Buy Alert Settings</b>\n\n` +
          `📬 <i>${escapeHtml(adminMention)}, tap below to open your DM with RacerBot and manage settings without cluttering this group:</i>`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.url('⚙️ Configure in DM', dmConfigUrl)],
            ]),
          }
        );
      }
      return;
    }

    // Resolve token address
    let tokenAddress = rawTokenInput;
    if (tokenAddress.length <= 12 && !tokenAddress.includes('.')) {
      const resolved = resolveTokenAddressFromKey(tokenAddress);
      if (resolved) tokenAddress = resolved;
    }

    const isSui = isSuiToken(tokenAddress) || tokenAddress.startsWith('0x');

    // Fetch token info
    let tokenInfo: any = null;
    try {
      tokenInfo = await getTokenInfo(tokenAddress);
    } catch (err: any) {
      console.warn(`[/track] Token verification notice for ${tokenAddress}: ${err?.message}`);
    }

    const adminId = ctx.from?.id ? ctx.from.id : ctx.chat!.id;
    const adminMention = ctx.from?.username ? `@${ctx.from.username}` : (ctx.from?.first_name || 'Admin');

    const alert = await upsertGroupBuyAlert({
      chatId: ctx.chat!.id,
      chatTitle: (ctx.chat as any)?.title || 'Group',
      adminId,
      tokenAddress,
      chain: isSui ? 'sui' : 'near',
      minBuyUsd: 5.0,
      emoji: '🏎️',
      emojiStepUsd: 5.0,
      whaleThresholdUsd: 200.0,
    });

    const sym = tokenInfo?.symbol || (isSui ? 'TOKEN' : tokenAddress.split('.')[0].toUpperCase());
    const card = buildAlertSettingsCard(alert);
    const dmConfigUrl = `https://t.me/${botUsername}?start=cfg_${alert.id}`;

    let sentToDm = false;
    if (ctx.from?.id && !isAnonymousAdmin) {
      try {
        await ctx.telegram.sendMessage(ctx.from.id, card.text, {
          parse_mode: 'HTML',
          ...card.keyboard,
        });
        sentToDm = true;
      } catch {
        // DM couldn't be sent directly (user hasn't initiated /start with bot in DM yet)
      }
    }

    if (sentToDm) {
      await ctx.reply(
        `✅ <b>RacerBot Buy Alerts Activated!</b>\n\n` +
        `🪙 Tracking: <b>$${escapeHtml(sym)}</b> (<code>${escapeHtml(tokenAddress)}</code>)\n` +
        `⚡ Status: 🟢 <b>ACTIVE</b>\n\n` +
        `📬 <i>${escapeHtml(adminMention)}, I've sent the setup & customization menu to your <b>private chat (DM)</b> so you can adjust minimum buys, emojis, whale alerts, and GIFs without cluttering this group!</i>`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.url('⚙️ Configure in DM', dmConfigUrl)],
          ]),
        }
      );
    } else {
      await ctx.reply(
        `✅ <b>RacerBot Buy Alerts Activated!</b>\n\n` +
        `🪙 Tracking: <b>$${escapeHtml(sym)}</b> (<code>${escapeHtml(tokenAddress)}</code>)\n` +
        `⚡ Status: 🟢 <b>ACTIVE</b>\n\n` +
        `📬 <i>${escapeHtml(adminMention)}, tap below to open your DM with RacerBot and finish customizing minimum buys, emojis, GIFs, and whale alerts without cluttering this group!</i>`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.url('⚙️ Finish Setup in DM', dmConfigUrl)],
          ]),
        }
      );
    }
  } catch (err: any) {
    console.error('[/track] Error in handleBuyBotCommand:', err);
    await ctx.reply(`⚠️ Failed to configure buy alert: ${err?.message || 'internal error'}`).catch(() => {});
  }
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
      const promptText =
        `🖼️ <b>Upload Custom GIF or Photo Banner</b>\n\n` +
        `Send a GIF (animation) or photo to this DM right now, and it will be displayed on all live BUY alerts for <b>${escapeHtml(currentAlert.chat_title || currentAlert.chat_id)}</b>!\n\n` +
        `<i>(Send /cancel anytime to cancel)</i>`;

      if (ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup') {
        try {
          await ctx.telegram.sendMessage(fromId, promptText, { parse_mode: 'HTML' });
          await ctx.answerCbQuery('📬 Check your DM to send the GIF or Photo!').catch(() => {});
        } catch {
          await ctx.answerCbQuery('⚠️ Please start a chat with RacerBot in DM first!').catch(() => {});
        }
        return;
      }

      await ctx.reply(promptText, { parse_mode: 'HTML' });
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
      let tokenName = currentAlert.chain === 'sui' ? 'Sui Token' : 'Near Token';
      let tokenSymbol = currentAlert.chain === 'sui' ? 'TOKEN' : 'TOKEN';
      let priceUsd = 0.00005;
      let marketCapUsd = 50000;

      try {
        const cached = await getTokenCache(currentAlert.token_address).catch(() => null);
        if (cached) {
          if (cached.name) tokenName = cached.name;
          if (cached.symbol) tokenSymbol = cached.symbol;
          if (cached.last_price && parseFloat(String(cached.last_price)) > 0) {
            priceUsd = parseFloat(String(cached.last_price)) * 4.8;
          }
        }
        const live = await getTokenInfo(currentAlert.token_address).catch(() => null);
        if (live) {
          if (live.name) tokenName = live.name;
          if (live.symbol) tokenSymbol = live.symbol;
          if (live.price_usd && Number(live.price_usd) > 0) priceUsd = Number(live.price_usd);
          if (live.market_cap_usd && Number(live.market_cap_usd) > 0) marketCapUsd = Number(live.market_cap_usd);
        }
      } catch { /* use defaults */ }

      const spentNear = 10;
      const nearPriceUsd = 4.8;
      const spentUsd = spentNear * nearPriceUsd;
      const tokensGotNum = priceUsd > 0 ? spentUsd / priceUsd : 100000;

      const sampleEvent: BuyAlertEvent = {
        type: 'buy_alert',
        chain: currentAlert.chain,
        token_address: currentAlert.token_address,
        token_name: tokenName,
        token_symbol: tokenSymbol,
        buyer_address: currentAlert.chain === 'sui' ? '0x7a3...c91' : (ctx.from?.username ? `${ctx.from.username}.near` : 'racer_whale.near'),
        spent_amount_native: currentAlert.chain === 'sui' ? '25.00 SUI' : `${spentNear.toFixed(2)} NEAR`,
        spent_usd: spentUsd,
        tokens_received: `${tokensGotNum.toLocaleString('en-US', { maximumFractionDigits: 0 })} ${tokenSymbol}`,
        price_usd: priceUsd,
        market_cap_usd: marketCapUsd,
        tx_hash: '',
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

/**
 * Handle /testalert or /testbuy command in groups or DMs.
 * Allows admins to verify bot permissions and preview real alert appearance.
 */
export async function handleTestAlertCommand(ctx: Context): Promise<void> {
  try {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const fromId = ctx.from?.id;
    const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';

    if (isGroup && fromId) {
      const member = await ctx.getChatMember(fromId).catch(() => null);
      const isAdmin = member && (member.status === 'creator' || member.status === 'administrator');
      if (!isAdmin) {
        await ctx.reply('⚠️ Only group administrators can use /testalert.');
        return;
      }
    }

    const alerts = isGroup
      ? await getGroupBuyAlertsByChat(chatId)
      : (fromId ? await (await import('@racerbot/db')).getDb().then(db => db.query('SELECT * FROM group_buy_alerts WHERE admin_id = $1 ORDER BY updated_at DESC LIMIT 1', [fromId]).then(r => r.rows)) : []);

    if (!alerts || alerts.length === 0) {
      await ctx.reply(
        isGroup
          ? '⚠️ No token is currently tracked in this group. Use <code>/track &lt;token_address&gt;</code> to set up buy alerts!'
          : '⚠️ You have not set up any group buy alerts yet. Add the bot to your group and use <code>/track &lt;token_address&gt;</code>!',
        { parse_mode: 'HTML' }
      );
      return;
    }

    const alert = alerts[0];
    let tokenName = alert.chain === 'sui' ? 'Sui Token' : 'Near Token';
    let tokenSymbol = alert.chain === 'sui' ? 'TOKEN' : 'TOKEN';
    let priceUsd = 0.00005;
    let marketCapUsd = 50000;

    try {
      const cached = await getTokenCache(alert.token_address).catch(() => null);
      if (cached) {
        if (cached.name) tokenName = cached.name;
        if (cached.symbol) tokenSymbol = cached.symbol;
        if (cached.last_price && parseFloat(String(cached.last_price)) > 0) {
          priceUsd = parseFloat(String(cached.last_price)) * 4.8;
        }
      }
      const live = await getTokenInfo(alert.token_address).catch(() => null);
      if (live) {
        if (live.name) tokenName = live.name;
        if (live.symbol) tokenSymbol = live.symbol;
        if (live.price_usd && Number(live.price_usd) > 0) priceUsd = Number(live.price_usd);
        if (live.market_cap_usd && Number(live.market_cap_usd) > 0) marketCapUsd = Number(live.market_cap_usd);
      }
    } catch { /* use defaults */ }

    const spentNear = 10;
    const spentUsd = 48.0;
    const tokensGotNum = priceUsd > 0 ? spentUsd / priceUsd : 100000;

    const sampleEvent: BuyAlertEvent = {
      type: 'buy_alert',
      chain: alert.chain,
      token_address: alert.token_address,
      token_name: tokenName,
      token_symbol: tokenSymbol,
      buyer_address: alert.chain === 'sui' ? '0x7a3...c91' : (ctx.from?.username ? `${ctx.from.username}.near` : 'racer_whale.near'),
      spent_amount_native: alert.chain === 'sui' ? '25.00 SUI' : `${spentNear.toFixed(2)} NEAR`,
      spent_usd: spentUsd,
      tokens_received: `${tokensGotNum.toLocaleString('en-US', { maximumFractionDigits: 0 })} ${tokenSymbol}`,
      price_usd: priceUsd,
      market_cap_usd: marketCapUsd,
      tx_hash: '',
      timestamp: Date.now(),
    };

    const botUsername = ctx.botInfo?.username || 'racertradingbot';
    await sendGroupAlertMessage(alert, sampleEvent, botUsername);

    if (!isGroup) {
      await ctx.reply(`✅ Test alert sent to <b>${escapeHtml(alert.chat_title || alert.chat_id)}</b>!`, { parse_mode: 'HTML' });
    }
  } catch (err: any) {
    await ctx.reply(`❌ Failed to send test alert: ${err?.message || err}`).catch(() => {});
  }
}
