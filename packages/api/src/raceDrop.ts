import { Context, Markup, Telegraf } from 'telegraf';
import {
  RaceDropRecord,
  RaceDropClaimRecord,
  CreateRaceDropParams,
  createRaceDrop,
  getRaceDropById,
  getRaceDropsByUser,
  updateRaceDropGroupMessage,
  recordRaceDropGroupMessage,
  getRaceDropGroupMessages,
  hasUserClaimedDrop,
  recordRaceDropClaim,
  getRaceDropClaimsByDrop,
  cancelRaceDrop,
  getUserById,
  getUserByTelegramId,
  getOpenPositions,
  generateReferralCode,
  getDb,
} from '@racerbot/db';
import {
  onboardUser,
  withdrawFunds,
  withdrawSuiFunds,
  withdrawTokenFunds,
  syncUserTokenDeposits,
  getTokenInfo,
  isSuiToken,
} from './wallet.js';
import { getUserFriendlyError } from './routes.js';
import { tryAcquireInFlight, releaseInFlight } from './inflight.js';
import {
  getNear,
  getSuiBalance,
  getSuiTokenBalance,
  formatTokenUnits,
  createRedis,
} from '@racerbot/shared';
import { REDIS_URL } from './config.js';

let _raceDropRedis: ReturnType<typeof createRedis> | null = null;
let _raceDropBot: Telegraf | null = null;
function getRaceDropRedis() {
  if (!_raceDropRedis && REDIS_URL) {
    try {
      _raceDropRedis = createRedis(REDIS_URL);
    } catch {
      _raceDropRedis = null;
    }
  }
  return _raceDropRedis;
}

export async function setRaceDropWizardState(
  telegramId: number,
  state: any,
  userPendingActions?: Map<number, any>
): Promise<void> {
  state.expiresAt = Date.now() + 15 * 60 * 1000; // 15 mins TTL
  userPendingActions?.set(telegramId, state);

  try {
    const redis = getRaceDropRedis();
    if (redis) {
      await redis.set(`racedrop:wizard:${telegramId}`, JSON.stringify(state), 900);
    }
  } catch {
    // non-fatal in-memory fallback
  }
}

export async function getRaceDropWizardState(
  telegramId: number,
  userPendingActions?: Map<number, any>
): Promise<any | null> {
  const mem = userPendingActions?.get(telegramId);
  if (mem && Date.now() < mem.expiresAt) {
    return mem;
  }

  try {
    const redis = getRaceDropRedis();
    if (redis) {
      const data = await redis.get(`racedrop:wizard:${telegramId}`);
      if (data) {
        const state = JSON.parse(data);
        if (state && Date.now() < state.expiresAt) {
          userPendingActions?.set(telegramId, state);
          return state;
        }
      }
    }
  } catch {
    // ignore
  }

  return null;
}

export async function clearRaceDropWizardState(
  telegramId: number,
  userPendingActions?: Map<number, any>
): Promise<void> {
  userPendingActions?.delete(telegramId);
  try {
    const redis = getRaceDropRedis();
    if (redis) {
      await redis.del(`racedrop:wizard:${telegramId}`);
    }
  } catch {
    // ignore
  }
}

export function getBotUsername(ctx: Context): string {
  return ctx.botInfo?.username || 'racertradingbot';
}

export function getTelegramDisplayName(from?: { first_name?: string; last_name?: string; username?: string }): string {
  if (!from) return 'A Racer';
  const fullName = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
  if (fullName) return fullName;
  if (from.username) return `@${from.username}`;
  return 'A Racer';
}

export function formatDropAmount(val: string | number): string {
  const n = typeof val === 'string' ? parseFloat(val) : val;
  if (isNaN(n)) return '0';
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 2 })}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toLocaleString('en-US', { maximumFractionDigits: 2 })}k`;
  }
  return n.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Builds the Telegram message card posted in groups.
 * Presents a verified, high-trust community token airdrop/giveaway
 * with clean institutional formatting, zero spam cues, and no emojis.
 */
export function buildRaceDropGroupCard(
  drop: RaceDropRecord,
  creatorUsername?: string,
  botUsername: string = 'racertradingbot',
  claimants: Array<{ claimant_name?: string; claim_amount: string }> = []
): { text: string; keyboard: ReturnType<typeof Markup.inlineKeyboard> } {
  const creatorDisplay = drop.creator_name || (creatorUsername ? `@${creatorUsername}` : `User #${drop.creator_telegram_id}`);
  const totalFormatted = `${formatDropAmount(drop.total_amount)} ${drop.token_symbol}`;
  const perUserFormatted = drop.amount_per_user
    ? `${formatDropAmount(drop.amount_per_user)} ${drop.token_symbol}`
    : `${formatDropAmount(parseFloat(drop.total_amount) / drop.total_claims)} ${drop.token_symbol}`;

  const isCompleted = drop.status === 'completed' || drop.claims_count >= drop.total_claims;
  const isExpired = drop.status === 'expired' || (!isCompleted && new Date() > drop.expires_at);

  let statusBadge = '<b>ACTIVE AIRDROP</b>';
  if (isCompleted) {
    statusBadge = '<b>COMPLETED (ALL CLAIMED)</b>';
  } else if (isExpired) {
    statusBadge = '<b>EXPIRED</b>';
  } else if (drop.status === 'cancelled') {
    statusBadge = '<b>CANCELLED</b>';
  }

  const progressPercent = Math.min(100, Math.round((drop.claims_count / drop.total_claims) * 100));
  const progressBar = '▓'.repeat(Math.floor(progressPercent / 10)) + '░'.repeat(10 - Math.floor(progressPercent / 10));
  const remainingSpots = Math.max(0, drop.total_claims - drop.claims_count);
  const shortDropId = drop.id.replace(/-/g, '').slice(0, 8);

  let noteSection = '';
  if (drop.message_text) {
    noteSection = `\n<b>Sponsor Note:</b> <i>"${escapeHtml(drop.message_text)}"</i>\n`;
  }

  let claimersSection = '';
  if (claimants && claimants.length > 0) {
    claimersSection = `\n<b>Recent Claimers (${claimants.length}/${drop.total_claims}):</b>\n`;
    const recent = claimants.slice(-10).reverse();
    recent.forEach((c) => {
      claimersSection += `• ${escapeHtml(c.claimant_name || 'Racer')} (<code>+${formatDropAmount(c.claim_amount)} ${drop.token_symbol}</code>)\n`;
    });
    if (claimants.length > 10) {
      claimersSection += `<i>...and ${claimants.length - 10} more</i>\n`;
    }
  }

  const claimUrl = `https://t.me/${botUsername}?start=drop_${drop.id}`;

  const actionLine = isCompleted
    ? `\n<b>All spots have been claimed.</b> Follow for upcoming airdrops.`
    : isExpired
    ? `\n<b>This giveaway has ended.</b>`
    : `\nTap below to deposit tokens directly into your wallet.`;

  const claimLinkLine = (!isCompleted && !isExpired && drop.status === 'active')
    ? `\n<a href="${claimUrl}"><b>Tap Here to Claim Your Free ${drop.token_symbol} →</b></a>\n`
    : '';

  const text =
    `<b>COMMUNITY TOKEN AIRDROP</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `<b>Sponsored by:</b> <b>${escapeHtml(creatorDisplay)}</b>\n` +
    `<b>Token:</b> <b>${drop.token_symbol}</b>\n` +
    `<b>Claim Reward:</b> <code>+${perUserFormatted}</code> / person (<b>100% Free</b>)\n` +
    `<b>Total Pool:</b> <code>${totalFormatted}</code> (${drop.total_claims} spots)\n` +
    `<b>Spots Left:</b> <b>${remainingSpots}</b> of <b>${drop.total_claims}</b> remaining (${progressPercent}% claimed)\n` +
    `<b>Progress:</b> [${progressBar}]\n` +
    `<b>Status:</b> ${statusBadge}\n` +
    noteSection +
    claimersSection +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `<i>100% Free • No Gas Required • Direct Wallet Deposit • Zero Approvals</i>\n` +
    claimLinkLine +
    actionLine +
    `\n<code>#drop_${shortDropId}</code>`;

  const buttons: any[] = [];
  if (!isCompleted && !isExpired && drop.status === 'active') {
    buttons.push([
      Markup.button.callback(`Claim ${perUserFormatted} (Free)`, `racedrop_claim_exec:${drop.id}`),
    ]);
    buttons.push([
      Markup.button.switchToChat('Share Airdrop with Friends', `drop_${drop.id}`),
    ]);
  } else {
    buttons.push([
      Markup.button.url('Open RacerBot', `https://t.me/${botUsername}?start=menu`),
    ]);
  }

  if (drop.token_address && drop.token_address !== 'near' && drop.token_address !== 'sui') {
    const chartUrl = `https://dexscreener.com/${drop.chain === 'sui' ? 'sui' : 'near'}/${drop.token_address}`;
    buttons.push([
      Markup.button.url(`View ${drop.token_symbol} Chart`, chartUrl),
    ]);
  }

  return { text, keyboard: Markup.inlineKeyboard(buttons) };
}

/**
 * Builds the interactive Claim MENU Page shown when someone opens a drop in DM.
 * Displays rich drop details with direct interactive buttons.
 */
export function buildRaceDropClaimMenuCard(
  drop: RaceDropRecord,
  hasClaimed: boolean,
  creatorUsername?: string,
  botUsername: string = 'racertradingbot',
  claimants: Array<{ claimant_name?: string; claim_amount: string }> = [],
  isCreator: boolean = false
): { text: string; keyboard: ReturnType<typeof Markup.inlineKeyboard> } {
  const creatorDisplay = drop.creator_name || (creatorUsername ? `@${creatorUsername}` : `User #${drop.creator_telegram_id}`);
  const totalFormatted = `${formatDropAmount(drop.total_amount)} ${drop.token_symbol}`;
  const perUserFormatted = drop.amount_per_user
    ? `${formatDropAmount(drop.amount_per_user)} ${drop.token_symbol}`
    : `${formatDropAmount(parseFloat(drop.total_amount) / drop.total_claims)} ${drop.token_symbol}`;

  const isCompleted = drop.status === 'completed' || drop.claims_count >= drop.total_claims;
  const isExpired = drop.status === 'expired' || (!isCompleted && new Date() > drop.expires_at);

  let statusBadge = '<b>ACTIVE AIRDROP</b>';
  if (isCompleted) {
    statusBadge = '<b>COMPLETED (ALL CLAIMED)</b>';
  } else if (isExpired) {
    statusBadge = '<b>EXPIRED</b>';
  } else if (drop.status === 'cancelled') {
    statusBadge = '<b>CANCELLED</b>';
  }

  const progressPercent = Math.min(100, Math.round((drop.claims_count / drop.total_claims) * 100));
  const progressBar = '▓'.repeat(Math.floor(progressPercent / 10)) + '░'.repeat(10 - Math.floor(progressPercent / 10));
  const remainingSpots = Math.max(0, drop.total_claims - drop.claims_count);
  const shortDropId = drop.id.replace(/-/g, '').slice(0, 8);

  let noteSection = '';
  if (drop.message_text) {
    noteSection = `\n<b>Sponsor Note:</b> <i>"${escapeHtml(drop.message_text)}"</i>\n`;
  }

  let claimersSection = '';
  if (claimants && claimants.length > 0) {
    claimersSection = `\n<b>Recent Claimers (${claimants.length}/${drop.total_claims}):</b>\n`;
    const recent = claimants.slice(-10).reverse();
    recent.forEach((c) => {
      claimersSection += `• ${escapeHtml(c.claimant_name || 'Racer')} (<code>+${formatDropAmount(c.claim_amount)} ${drop.token_symbol}</code>)\n`;
    });
    if (claimants.length > 10) {
      claimersSection += `<i>...and ${claimants.length - 10} more</i>\n`;
    }
  }

  let promptSection = '';
  const buttons: any[] = [];

  if (isCreator) {
    promptSection = `\n<b>You created this Community Airdrop.</b>\nShare this drop to your groups or chats so members can claim directly with the 1-click Claim button:`;
    const startGroupUrl = `https://t.me/${botUsername}?startgroup=drop_${drop.id}`;
    buttons.push([
      Markup.button.switchToChat('Share to Group (With Claim Button)', `drop_${drop.id}`),
      Markup.button.url('Post to Group', startGroupUrl),
    ]);
    buttons.push([
      Markup.button.callback('View Wallet', 'wallet_refresh'),
      Markup.button.callback('Main Menu', 'menu_home'),
    ]);
  } else if (hasClaimed) {
    promptSection = `\n<b>You have already claimed this Airdrop.</b>\nYour tokens have been credited to your RacerBot wallet balance.`;
    buttons.push([
      Markup.button.callback('View Wallet', 'wallet_refresh'),
      Markup.button.callback('Main Menu', 'menu_home'),
    ]);
  } else if (isCompleted) {
    promptSection = `\n<b>This Airdrop is completed.</b> All ${drop.total_claims} claim spots have been filled.`;
    buttons.push([
      Markup.button.callback('View Wallet', 'wallet_refresh'),
      Markup.button.callback('Main Menu', 'menu_home'),
    ]);
  } else if (isExpired || drop.status !== 'active') {
    promptSection = `\n<b>This Airdrop is no longer active.</b>`;
    buttons.push([
      Markup.button.callback('View Wallet', 'wallet_refresh'),
      Markup.button.callback('Main Menu', 'menu_home'),
    ]);
  } else {
    promptSection = `\n<b>Tap the button below to claim your free tokens:</b>`;
    buttons.push([
      Markup.button.callback(`Claim ${perUserFormatted} (Free)`, `racedrop_claim_exec:${drop.id}`),
    ]);
    buttons.push([
      Markup.button.switchToChat('Share Airdrop with Friends', `drop_${drop.id}`),
    ]);
    buttons.push([
      Markup.button.callback('View Wallet', 'wallet_refresh'),
      Markup.button.callback('Main Menu', 'menu_home'),
    ]);
  }

  const text =
    `<b>COMMUNITY TOKEN AIRDROP</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `<b>Sponsored by:</b> <b>${escapeHtml(creatorDisplay)}</b>\n` +
    `<b>Token:</b> <b>${drop.token_symbol}</b>\n` +
    `<b>Your Reward:</b> <code>+${perUserFormatted}</code> (<b>100% Free</b>)\n` +
    `<b>Total Pool:</b> <code>${totalFormatted}</code> (${drop.total_claims} spots)\n` +
    `<b>Spots Left:</b> <b>${remainingSpots}</b> of <b>${drop.total_claims}</b> remaining (${progressPercent}% claimed)\n` +
    `<b>Progress:</b> [${progressBar}]\n` +
    `<b>Status:</b> ${statusBadge}\n` +
    noteSection +
    claimersSection +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `<i>100% Free • No Gas Fees • Instant Direct Wallet Deposit</i>\n` +
    promptSection +
    `\n<code>#drop_${shortDropId}</code>`;

  return { text, keyboard: Markup.inlineKeyboard(buttons as any) };
}

/**
 * Builds the DM success message shown to the user who claimed a drop.
 */
export function buildRaceDropClaimSuccessCard(
  drop: RaceDropRecord,
  claim: RaceDropClaimRecord,
  creatorUsername?: string
): { text: string; keyboard: ReturnType<typeof Markup.inlineKeyboard> } {
  const creatorDisplay = drop.creator_name || (creatorUsername ? `@${creatorUsername}` : `User #${drop.creator_telegram_id}`);
  const amountFormatted = `${formatDropAmount(claim.claim_amount)} ${drop.token_symbol}`;

  let welcomeBanner = '';
  if (claim.is_new_user) {
    welcomeBanner =
      `<b>Welcome to RacerBot.</b>\n` +
      `Your secure non-custodial wallet has been automatically generated and funded. ` +
      `You are now connected with ${escapeHtml(creatorDisplay)} as your sponsor.\n\n`;
  }

  let txSection = '';
  if (claim.tx_hash) {
    const explorerUrl = drop.chain === 'sui'
      ? `https://suiscan.xyz/mainnet/tx/${claim.tx_hash}`
      : `https://nearblocks.io/txns/${claim.tx_hash}`;
    const explorerName = drop.chain === 'sui' ? 'Suiscan' : 'NearBlocks';
    txSection = `<a href="${explorerUrl}">View Transaction on ${explorerName}</a>\n\n`;
  }

  const text =
    `<b>AIRDROP CLAIMED SUCCESSFULLY</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    welcomeBanner +
    `<b>Received:</b> <code>+${amountFormatted}</code> (<b>100% Free</b>)\n` +
    `<b>Sponsored by:</b> ${escapeHtml(creatorDisplay)}\n` +
    `<b>Token:</b> <code>${drop.token_symbol}</code>\n` +
    txSection +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `<i>Tokens have been credited directly to your RacerBot wallet.</i>\n\n` +
    `Zero gas fees were required. You can trade, transfer, or hold your tokens anytime.`;

  const buttons: any[] = [
    [
      Markup.button.switchToChat('Share Airdrop with Friends', `drop_${drop.id}`),
    ],
    [
      Markup.button.callback(`Buy More ${drop.token_symbol}`, `token_${drop.token_address}`),
      Markup.button.callback('View Wallet', 'wallet_refresh'),
    ],
    [Markup.button.callback('Main Menu', 'menu_home')],
  ];

  if (drop.token_address && drop.token_address !== 'near' && drop.token_address !== 'sui') {
    const chartUrl = `https://dexscreener.com/${drop.chain === 'sui' ? 'sui' : 'near'}/${drop.token_address}`;
    buttons.push([Markup.button.url(`View ${drop.token_symbol} Chart`, chartUrl)]);
  }

  return { text, keyboard: Markup.inlineKeyboard(buttons as any) };
}

/**
 * Builds the card sent to the creator after successfully creating a drop in DM.
 */
export function buildRaceDropCreatorShareCard(
  drop: RaceDropRecord,
  botUsername: string = 'racertradingbot'
): { text: string; keyboard: ReturnType<typeof Markup.inlineKeyboard> } {
  const creatorDisplay = drop.creator_name || `User #${drop.creator_telegram_id}`;
  const totalFormatted = `${formatDropAmount(drop.total_amount)} ${drop.token_symbol}`;
  const perUserFormatted = drop.amount_per_user
    ? `${formatDropAmount(drop.amount_per_user)} ${drop.token_symbol}`
    : `${formatDropAmount(parseFloat(drop.total_amount) / drop.total_claims)} ${drop.token_symbol}`;
  const shortDropId = drop.id.replace(/-/g, '').slice(0, 8);
  const claimUrl = `https://t.me/${botUsername}?start=drop_${drop.id}`;
  const startGroupUrl = `https://t.me/${botUsername}?startgroup=drop_${drop.id}`;
  const shareText = `${creatorDisplay} is giving away ${perUserFormatted} in a free community airdrop! Claim directly into your wallet:`;
  const tgShareUrl = `https://t.me/share/url?url=${encodeURIComponent(claimUrl)}&text=${encodeURIComponent(shareText)}`;

  const text =
    `<b>Token Airdrop Created Successfully</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `<b>Creator:</b> ${escapeHtml(creatorDisplay)}\n` +
    `<b>Token:</b> <code>${drop.token_symbol}</code>\n` +
    `<b>Reward per User:</b> <code>+${perUserFormatted}</code> (<b>100% Free</b>)\n` +
    `<b>Total Claimers:</b> ${drop.total_claims} spots\n` +
    `<b>Total Pool:</b> <code>${totalFormatted}</code>\n` +
    (drop.message_text ? `<b>Message:</b> "${escapeHtml(drop.message_text)}"\n` : '') +
    `<b>Airdrop Ref:</b> <code>#drop_${shortDropId}</code>\n\n` +
    `<b>Choose how to share with your group:</b>\n` +
    `• <b>Post to Group:</b> Automatically post the official card with the 1-click Claim button.\n` +
    `• <b>Share Inline:</b> Send via inline bot to chats that allow inline bots.\n` +
    `• <b>Share Link:</b> Share the direct claim link to any channel or chat.\n\n` +
    `<i>Important: Keep your ${drop.token_symbol} and NEAR in your RacerBot wallet so on-chain claim transfers can process smoothly.</i>`;

  const buttons = [
    [Markup.button.url('Post to Group', startGroupUrl)],
    [
      Markup.button.switchToChat('Share Inline', `drop_${drop.id}`),
      Markup.button.url('Share Link', tgShareUrl),
    ],
    [
      Markup.button.callback('View Wallet', 'wallet_refresh'),
      Markup.button.callback('Main Menu', 'menu_home'),
    ],
  ];

  return { text, keyboard: Markup.inlineKeyboard(buttons as any) };
}

/**
 * Posts the official interactive RaceDrop card into a group/channel and
 * registers the message for live claim updates.
 */
export async function handleRaceDropGroupPost(
  ctx: Context,
  dropId: string
): Promise<void> {
  const drop = await getRaceDropById(dropId).catch(() => null);
  if (!drop) return;

  const botUsername = getBotUsername(ctx);
  const allClaims = await getRaceDropClaimsByDrop(drop.id).catch(() => []);
  const creatorUser = await getUserById(drop.creator_id).catch(() => null);
  const creatorTgUser = creatorUser
    ? (await ctx.telegram.getChat(creatorUser.telegram_id).catch(() => null) as any)
    : null;
  const creatorUsername = creatorTgUser?.username || undefined;

  const groupCard = buildRaceDropGroupCard(drop, creatorUsername, botUsername, allClaims);
  const sentMsg = await ctx.reply(groupCard.text, {
    parse_mode: 'HTML',
    ...groupCard.keyboard,
  });

  if (ctx.chat?.id) {
    await updateRaceDropGroupMessage(drop.id, ctx.chat.id, sentMsg.message_id).catch(() => {});
    await recordRaceDropGroupMessage(drop.id, ctx.chat.id, sentMsg.message_id).catch(() => {});
  }
  ctx.deleteMessage().catch(() => {});
}

/**
 * Displays the interactive RaceDrop Claim MENU Page to the claimant in DM.
 */
export async function showRaceDropClaimMenu(ctx: Context, dropId: string): Promise<void> {
  const telegramId = ctx.from!.id;
  try {
    const drop = await getRaceDropById(dropId);
    if (!drop) {
      await ctx.reply('❌ RaceDrop not found or has ended.', {
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🏁 Main Menu', 'menu_home')],
        ]),
      });
      return;
    }

    const user = await getUserByTelegramId(telegramId).catch(() => null);
    const hasClaimed = user ? await hasUserClaimedDrop(drop.id, user.id) : false;
    const isCreator = Boolean(user && user.id === drop.creator_id);

    const creatorUser = await getUserById(drop.creator_id).catch(() => null);
    const creatorTgUser = creatorUser
      ? (await ctx.telegram.getChat(creatorUser.telegram_id).catch(() => null) as any)
      : null;
    const creatorUsername = creatorTgUser?.username || undefined;
    const botUsername = getBotUsername(ctx);

    const allClaims = await getRaceDropClaimsByDrop(drop.id).catch(() => []);
    const card = buildRaceDropClaimMenuCard(drop, hasClaimed, creatorUsername, botUsername, allClaims, isCreator);

    await ctx.reply(card.text, {
      parse_mode: 'HTML',
      ...card.keyboard,
    });
  } catch (err: any) {
    console.error('[RACEDROP] Error displaying claim menu:', err);
    await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
  }
}

/**
 * Executes the on-chain transfer, records claim, updates group messages,
 * notifies creator, and updates the claimant view automatically.
 */
export async function executeRaceDropClaim(ctx: Context, dropId: string): Promise<void> {
  const telegramId = ctx.from!.id;
  const username = ctx.from!.username || undefined;

  const isInline = Boolean(ctx.inlineMessageId);
  const isGroup = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup' || isInline;

  const sendErrorFeedback = async (msg: string) => {
    const plainMsg = msg.replace(/<[^>]+>/g, '');
    if ((isGroup || isInline) && ctx.callbackQuery) {
      await ctx.answerCbQuery(plainMsg, { show_alert: true }).catch(() => {});
    } else {
      await ctx.reply(msg, { parse_mode: 'HTML' }).catch(() => {});
    }
  };

  // 1. Guard against concurrent duplicate claim requests (e.g. rapid double-tapping Claim button)
  const claimLockKey = `inflight:racedrop_claim:${dropId}:${telegramId}`;
  if (!(await tryAcquireInFlight(claimLockKey))) {
    await sendErrorFeedback('🏎️ Your claim is already being processed! Please wait a moment.');
    return;
  }

  try {
    const drop = await getRaceDropById(dropId);
    if (!drop) {
      await sendErrorFeedback('❌ RaceDrop not found or has ended.');
      return;
    }

    if (drop.status !== 'active') {
      await sendErrorFeedback(`🏁 This RaceDrop is no longer active (status: ${drop.status}).`);
      return;
    }

    if (new Date() > drop.expires_at) {
      await sendErrorFeedback('⌛ This RaceDrop has expired.');
      return;
    }

    if (drop.claims_count >= drop.total_claims || parseFloat(drop.remaining_amount) <= 0) {
      await sendErrorFeedback('🏁 All drops have already been claimed! All spots are filled.');
      return;
    }

    // User verification & referral linking
    let user = await getUserByTelegramId(telegramId).catch(() => null);
    let isNewUser = false;

    if (!user) {
      isNewUser = true;
      const creatorUser = await getUserById(drop.creator_id).catch(() => null);
      let creatorRefCode = creatorUser?.referral_code || undefined;
      if (!creatorRefCode && creatorUser) {
        creatorRefCode = (await generateReferralCode(creatorUser.id, 'user').catch(() => undefined)) || undefined;
      }

      await onboardUser(telegramId, creatorRefCode || undefined, username);
      user = await getUserByTelegramId(telegramId).catch(() => null);
      if (!user) {
        await sendErrorFeedback('❌ Failed to initialize wallet. Please start @' + getBotUsername(ctx) + ' in DM and try again.');
        return;
      }
    }

    // Creators cannot claim their own RaceDrop
    if (user.id === drop.creator_id) {
      await sendErrorFeedback(
        '👑 <b>You are the creator of this RaceDrop!</b>\n\n' +
        'Creators cannot claim their own drop. Share the link with friends, in direct messages, channels, or groups for them to claim!'
      );
      return;
    }

    // Prevent duplicate claims
    const alreadyClaimed = await hasUserClaimedDrop(drop.id, user.id);
    if (alreadyClaimed) {
      await sendErrorFeedback('⚠️ You have already claimed this RaceDrop!');
      return;
    }

    // Calculate claim amount
    let claimAmountNum: number;
    const remainingNum = parseFloat(drop.remaining_amount);
    const spotsRemaining = drop.total_claims - drop.claims_count;

    if (drop.amount_per_user) {
      claimAmountNum = parseFloat(drop.amount_per_user);
    } else if (spotsRemaining <= 1) {
      claimAmountNum = remainingNum;
    } else if (drop.split_mode === 'lucky') {
      const avg = remainingNum / spotsRemaining;
      const max = Math.min(avg * 2, remainingNum * 0.8);
      const min = Math.max(avg * 0.1, 0.000001);
      const rand = Math.random() * (max - min) + min;
      claimAmountNum = Number(rand.toFixed(6));
    } else {
      claimAmountNum = Number((parseFloat(drop.total_amount) / drop.total_claims).toFixed(6));
    }

    claimAmountNum = Math.min(claimAmountNum, remainingNum);
    if (claimAmountNum <= 0) {
      await sendErrorFeedback('🏁 All drops have already been claimed!');
      return;
    }

    const creatorUser = await getUserById(drop.creator_id);
    if (!creatorUser) {
      await sendErrorFeedback('❌ Drop creator account not found.');
      return;
    }

    let txHash: string | undefined = undefined;
    const claimantName = getTelegramDisplayName(ctx.from);

    // Provide immediate in-chat feedback only in DM to avoid cluttering groups
    let pendingMsg: any = null;
    if (!isGroup) {
      pendingMsg = await ctx.reply(
        `🏎️ <i>Securing your RaceDrop of ${formatDropAmount(claimAmountNum)} ${drop.token_symbol}...</i>`,
        { parse_mode: 'HTML' }
      ).catch(() => null);
    }

    try {
      if (drop.token_address.toLowerCase() === 'near') {
        const res = await withdrawFunds(creatorUser.telegram_id, user.subaccount_id, claimAmountNum);
        txHash = res.txHash;
      } else if (drop.token_address.toLowerCase() === 'sui') {
        if (!user.sui_address) {
          throw new Error('Claimant SUI address not initialized.');
        }
        const res = await withdrawSuiFunds(creatorUser.telegram_id, user.sui_address, claimAmountNum);
        txHash = res.txHash;
      } else {
        const dest = drop.chain === 'sui' ? user.sui_address : user.subaccount_id;
        if (!dest) {
          throw new Error('Claimant wallet address not initialized.');
        }
        const res = await withdrawTokenFunds(creatorUser.telegram_id, drop.token_address, dest, claimAmountNum);
        txHash = res.txHash;
      }
    } catch (err: any) {
      console.error('[RACEDROP] On-chain transfer failed:', err?.message || err);
      if (pendingMsg) ctx.deleteMessage(pendingMsg.message_id).catch(() => {});
      const friendlyErr = getUserFriendlyError(err);
      await sendErrorFeedback(
        `❌ <b>Claim Failed:</b> ${friendlyErr}\n\nThe creator's wallet balance or gas may be depleted. Please notify the creator to ensure they have enough ${drop.token_symbol} and NEAR in their wallet.`
      );
      try {
        if (_raceDropBot && creatorUser?.telegram_id) {
          await _raceDropBot.telegram.sendMessage(
            creatorUser.telegram_id,
            `⚠️ <b>RaceDrop Claim Alert:</b> A user tried to claim your <b>${drop.token_symbol}</b> RaceDrop (<code>drop_${drop.id}</code>), but the transfer failed:\n\n` +
            `<i>${friendlyErr}</i>\n\n` +
            `Please top up your RacerBot wallet with <b>${drop.token_symbol}</b> and <b>NEAR</b> so claimers can receive their tokens!`,
            { parse_mode: 'HTML' }
          ).catch(() => {});
        }
      } catch {
        // ignore notification failure
      }
      return;
    }

    if (pendingMsg) ctx.deleteMessage(pendingMsg.message_id).catch(() => {});

    // Record Claim in DB
    let claimResult: { claim: RaceDropClaimRecord; drop: RaceDropRecord };
    try {
      claimResult = await recordRaceDropClaim({
        dropId: drop.id,
        userId: user.id,
        telegramId,
        claimantName,
        claimAmount: claimAmountNum.toString(),
        isNewUser,
        txHash,
      });
    } catch (claimErr: any) {
      const errStr = String(claimErr?.message || claimErr).toLowerCase();
      if (errStr.includes('uq_drop_claim_user') || errStr.includes('uq drop claim user') || claimErr?.code === '23505' || errStr.includes('already claimed')) {
        await sendErrorFeedback('⚠️ You have already claimed this RaceDrop! Your tokens are already in your wallet.');
        return;
      }
      throw claimErr;
    }

    const { claim, drop: updatedDrop } = claimResult;

    if (user.subaccount_id) {
      syncUserTokenDeposits(user.id, user.subaccount_id, true).catch(() => {});
    }

    const creatorTgUser = await ctx.telegram.getChat(creatorUser.telegram_id).catch(() => null) as any;
    const creatorUsername = creatorTgUser?.username || undefined;
    const successCard = buildRaceDropClaimSuccessCard(updatedDrop, claim, creatorUsername);

    // PRIVACY ENFORCEMENT:
    // In public groups, NEVER post wallet buttons, balances, or private menus into the group.
    // Send success card privately to claimant's DM, and notify via popup alert in group.
    if (isGroup) {
      await ctx.telegram.sendMessage(telegramId, successCard.text, {
        parse_mode: 'HTML',
        ...successCard.keyboard,
      }).catch(() => {
        // Claimant may not have DM open yet
      });

      if (ctx.callbackQuery) {
        await ctx.answerCbQuery(
          `You claimed +${formatDropAmount(claimAmountNum)} ${drop.token_symbol}. Details sent to your private DM.`,
          { show_alert: true }
        ).catch(() => {});
      }
    } else {
      if (ctx.callbackQuery) {
        await ctx.editMessageText(successCard.text, {
          parse_mode: 'HTML',
          ...successCard.keyboard,
        }).catch(async () => {
          await ctx.reply(successCard.text, {
            parse_mode: 'HTML',
            ...successCard.keyboard,
          });
        });
      } else {
        await ctx.reply(successCard.text, {
          parse_mode: 'HTML',
          ...successCard.keyboard,
        });
      }
    }

    const isCompleted = updatedDrop.claims_count >= updatedDrop.total_claims || parseFloat(updatedDrop.remaining_amount) <= 0;

    // ── 1. Notify Creator in DM (ONLY WHEN ALL SPOTS HAVE BEEN CLAIMED) ───────
    try {
      if (isCompleted && creatorUser.telegram_id !== telegramId) {
        const creatorNotice =
          `<b>Airdrop Completed</b>\n\n` +
          `All <b>${updatedDrop.total_claims}</b> spots in your <b>${drop.token_symbol}</b> airdrop have been claimed.\n` +
          `<b>Total Distributed:</b> <code>${formatDropAmount(updatedDrop.total_amount)} ${drop.token_symbol}</code>\n` +
          `<b>Final Claimant:</b> ${escapeHtml(claimantName)}\n\n` +
          `Thank you for using RacerBot.`;

        await ctx.telegram.sendMessage(creatorUser.telegram_id, creatorNotice, { parse_mode: 'HTML' }).catch(() => {});
      }
    } catch (err: any) {
      console.warn('[RACEDROP] Failed to notify creator:', err?.message);
    }

    // ── 2. Live Update Group Messages (Main Claim Card Only) ─────────────────
    try {
      const allClaims = await getRaceDropClaimsByDrop(drop.id).catch(() => [] as any[]);
      const groupMsgs: Array<{ chat_id: number; message_id: number }> =
        await getRaceDropGroupMessages(drop.id).catch(() => []);

      if (updatedDrop.group_chat_id && updatedDrop.group_message_id) {
        if (!groupMsgs.some((m) => m.chat_id === updatedDrop.group_chat_id)) {
          groupMsgs.push({ chat_id: updatedDrop.group_chat_id, message_id: updatedDrop.group_message_id });
        }
      }

      const botUsername = getBotUsername(ctx);
      const creatorDisplay = drop.creator_name || (creatorUsername ? `@${creatorUsername}` : `User #${drop.creator_telegram_id}`);
      const updatedGroupCard = buildRaceDropGroupCard(updatedDrop, creatorUsername, botUsername, allClaims);

      if (ctx.inlineMessageId) {
        await ctx.telegram
          .editMessageText(
            undefined,
            undefined,
            ctx.inlineMessageId,
            updatedGroupCard.text,
            { parse_mode: 'HTML', ...updatedGroupCard.keyboard }
          )
          .catch(() => {});
      }

      for (const gm of groupMsgs) {
        // Edit group card with new count and claimers list
        await ctx.telegram
          .editMessageText(
            gm.chat_id,
            gm.message_id,
            undefined,
            updatedGroupCard.text,
            { parse_mode: 'HTML', ...updatedGroupCard.keyboard }
          )
          .catch(() => {});

        // ONLY send a separate notification when the drop is fully completed!
        if (isCompleted) {
          const groupAnnouncement = `<b>All spots filled.</b> <b>${escapeHtml(claimantName)}</b> claimed the final <b>${formatDropAmount(claimAmountNum)} ${drop.token_symbol}</b> from <b>${escapeHtml(creatorDisplay)}</b>'s airdrop (${updatedDrop.total_claims} spots claimed).`;
          await ctx.telegram.sendMessage(gm.chat_id, groupAnnouncement, { parse_mode: 'HTML' }).catch(() => {});
        }
      }
    } catch (err: any) {
      console.warn('[RACEDROP] Group live update error:', err?.message);
    }
  } catch (err: any) {
    console.error('[RACEDROP] Claim execution error:', err);
    const errStr = String(err?.message || err).toLowerCase();
    if (errStr.includes('uq_drop_claim_user') || errStr.includes('uq drop claim user') || err?.code === '23505' || errStr.includes('already claimed')) {
      await sendErrorFeedback('⚠️ You have already claimed this RaceDrop! Your tokens are already in your wallet.');
    } else {
      await sendErrorFeedback(`❌ ${getUserFriendlyError(err)}`);
    }
  } finally {
    await releaseInFlight(claimLockKey);
  }
}

// Backwards-compatibility alias
export const handleRaceDropClaim = showRaceDropClaimMenu;

/**
 * Resolves user's available balance for a token.
 */
export async function getUserAvailableBalance(
  telegramId: number,
  tokenAddress: string,
  chain: 'near' | 'sui' = 'near'
): Promise<{ balance: number; symbol: string; decimals: number }> {
  const user = await getUserByTelegramId(telegramId);
  if (!user) return { balance: 0, symbol: 'NEAR', decimals: 24 };

  if (tokenAddress.toLowerCase() === 'near') {
    const near = getNear();
    const yocto = await near.getNearBalance(user.subaccount_id).catch(() => '0');
    const nearBal = Math.max(0, (Number(BigInt(yocto) / 1000000000000000000n) / 1e6) - 0.05);
    return { balance: nearBal, symbol: 'NEAR', decimals: 24 };
  }

  if (tokenAddress.toLowerCase() === 'sui') {
    if (!user.sui_address) return { balance: 0, symbol: 'SUI', decimals: 9 };
    const bal = await getSuiBalance(user.sui_address);
    const suiBal = Math.max(0, Number(bal.sui) - 0.025);
    return { balance: suiBal, symbol: 'SUI', decimals: 9 };
  }

  // Token: fetch metadata to get actual decimals and symbol
  const isSuiTok = chain === 'sui' || isSuiToken(tokenAddress);
  const info = await getTokenInfo(tokenAddress).catch(() => null);
  const decimals = info?.decimals ?? (isSuiTok ? 9 : 18);
  const symbol = info?.symbol || tokenAddress.split('.')[0].toUpperCase();

  // 1. Check live on-chain balance first
  let rawBalance = '0';
  if (isSuiTok && user.sui_address) {
    const suiBal = await getSuiTokenBalance(user.sui_address, tokenAddress).catch(() => null);
    if (suiBal) {
      rawBalance = suiBal.raw.toString();
    }
  } else if (user.subaccount_id) {
    const near = getNear();
    rawBalance = await near.getTokenBalance(tokenAddress, user.subaccount_id).catch(() => '0');
  }

  // 2. Fallback to position record in DB if on-chain returned 0 / failed
  if ((!rawBalance || rawBalance === '0') && user.id) {
    const positions = await getOpenPositions(user.id).catch(() => []);
    const pos = positions.find(
      (p) => p.token_address.toLowerCase() === tokenAddress.toLowerCase()
    );
    if (pos && pos.quantity_held) {
      rawBalance = pos.quantity_held;
    }
  }

  // 3. Convert raw atomic units to human units using actual token decimals
  let humanBal = 0;
  try {
    const rawClean = rawBalance.split('.')[0] || '0';
    const rawBig = BigInt(rawClean);
    if (rawBig > 0n) {
      const formatted = formatTokenUnits(rawBig, decimals);
      humanBal = parseFloat(formatted) || 0;
    }
  } catch {
    const num = parseFloat(rawBalance || '0');
    humanBal = decimals > 0 && num > 1e6 ? num / Math.pow(10, decimals) : num;
  }

  return { balance: humanBal, symbol, decimals };
}

/**
 * Handles Step 2: Amount of tokens per user to claim.
 */
export async function handleRaceDropAmountPerUserInput(
  ctx: Context,
  telegramId: number,
  amountPerUser: number,
  userPendingActions: Map<number, any>
): Promise<void> {
  const pending = await getRaceDropWizardState(telegramId, userPendingActions);
  if (!pending || !pending.raceDropToken) {
    await ctx.reply('❌ Session expired. Please tap Create RaceDrop again.');
    return;
  }

  if (isNaN(amountPerUser) || amountPerUser <= 0) {
    await ctx.reply('❌ Invalid amount. Please enter a positive number.');
    return;
  }

  const { balance, symbol } = await getUserAvailableBalance(
    telegramId,
    pending.raceDropToken,
    pending.raceDropChain || 'near'
  );

  if (amountPerUser > balance) {
    await ctx.reply(`❌ Amount per user (${formatDropAmount(amountPerUser)} ${symbol}) exceeds your balance (${formatDropAmount(balance)} ${symbol}).`);
    return;
  }

  const maxUsers = Math.min(100, Math.floor(balance / amountPerUser));
  if (maxUsers < 1) {
    await ctx.reply(`❌ Balance too low to fund even 1 claim.`);
    return;
  }

  await setRaceDropWizardState(
    telegramId,
    {
      ...pending,
      action: 'racedrop_claims',
      raceDropAmountPerUser: amountPerUser,
    },
    userPendingActions
  );

  const buttons: any[] = [];
  const claimPresets = [5, 10, 20, 50, 100].filter((n) => n <= maxUsers);
  if (claimPresets.length > 0) {
    const row1 = claimPresets.slice(0, 3).map((n) =>
      Markup.button.callback(`🏎️ ${n} Users`, `racedrop_set_claims:${n}`)
    );
    buttons.push(row1);
    if (claimPresets.length > 3) {
      const row2 = claimPresets.slice(3).map((n) =>
        Markup.button.callback(`🏎️ ${n} Users`, `racedrop_set_claims:${n}`)
      );
      buttons.push(row2);
    }
  }

  buttons.push([
    Markup.button.callback(`⚡ Max (${maxUsers} Users)`, `racedrop_set_claims:${maxUsers}`),
    Markup.button.callback('✏️ Custom Count', 'racedrop_prompt_custom_claims'),
  ]);
  buttons.push([Markup.button.callback('❌ Cancel', 'racedrop_cancel')]);

  const text =
    `👥 <b>Step 2 of 2: Number of Users</b>\n\n` +
    `🪙 <b>Amount per User:</b> <code>${formatDropAmount(amountPerUser)} ${pending.raceDropSymbol || symbol}</code>\n` +
    `💰 <b>Available Balance:</b> <code>${formatDropAmount(balance)} ${pending.raceDropSymbol || symbol}</code>\n` +
    `📊 <b>Maximum Claimers:</b> <b>${maxUsers} users</b>\n\n` +
    `How many users should be able to claim this RaceDrop?\n\n` +
    `Tap a preset below or <b>reply with any number</b> in this chat (1–${maxUsers}):`;

  await ctx.reply(text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(buttons),
  });
}

/**
 * Handles Step 3: Number of users, creates the drop, and renders the share card.
 */
export async function handleRaceDropClaimsInput(
  ctx: Context,
  telegramId: number,
  claims: number,
  userPendingActions: Map<number, any>
): Promise<void> {
  const pending = await getRaceDropWizardState(telegramId, userPendingActions);
  if (!pending || !pending.raceDropToken || !pending.raceDropAmountPerUser) {
    await ctx.reply('❌ Session expired. Please tap Create RaceDrop again.');
    return;
  }

  if (isNaN(claims) || claims < 1 || claims > 100) {
    await ctx.reply('❌ Number of users must be between 1 and 100.');
    return;
  }

  const { balance, symbol } = await getUserAvailableBalance(
    telegramId,
    pending.raceDropToken,
    pending.raceDropChain || 'near'
  );

  const totalAmount = Number((pending.raceDropAmountPerUser * claims).toFixed(6));
  if (totalAmount > balance) {
    await ctx.reply(
      `❌ Total drop amount (${formatDropAmount(totalAmount)} ${symbol}) exceeds your available balance (${formatDropAmount(balance)} ${symbol}).`
    );
    return;
  }

  const user = await getUserByTelegramId(telegramId);
  if (!user) {
    await ctx.reply('❌ User account not found. Please run /start.');
    return;
  }

  const creatorName = pending.raceDropCreatorName || getTelegramDisplayName(ctx.from);

  const drop = await createRaceDrop({
    creator_id: user.id,
    creator_telegram_id: telegramId,
    creator_name: creatorName,
    chain: pending.raceDropChain || 'near',
    token_address: pending.raceDropToken,
    token_symbol: pending.raceDropSymbol || symbol,
    amount_per_user: pending.raceDropAmountPerUser,
    total_amount: totalAmount,
    total_claims: claims,
    split_mode: 'equal',
  });

  await clearRaceDropWizardState(telegramId, userPendingActions);

  const botUsername = getBotUsername(ctx);
  const shareCard = buildRaceDropCreatorShareCard(drop, botUsername);

  await ctx.reply(shareCard.text, {
    parse_mode: 'HTML',
    ...shareCard.keyboard,
  });

  // Wizard complete — creator receives interactive Share Card with 'Post to Group' button
}

/**
 * Initiates the interactive token selection wizard in DM.
 */
export async function startRaceDropWizard(ctx: Context): Promise<void> {
  const telegramId = ctx.from!.id;
  const user = await getUserByTelegramId(telegramId);
  if (!user) {
    await ctx.reply('Please run /start first to initialize your wallet.');
    return;
  }

  const nearBalObj = await getUserAvailableBalance(telegramId, 'near', 'near');
  const positions = await getOpenPositions(user.id).catch(() => []);

  const buttons: any[] = [];
  if (nearBalObj.balance > 0) {
    buttons.push([
      Markup.button.callback(
        `🏎️ NEAR (${nearBalObj.balance.toFixed(2)} available)`,
        'racedrop_pick:near'
      ),
    ]);
  }

  if (user.sui_address) {
    const suiBalObj = await getUserAvailableBalance(telegramId, 'sui', 'sui').catch(() => null);
    if (suiBalObj && suiBalObj.balance > 0) {
      buttons.push([
        Markup.button.callback(
          `🌊 SUI (${suiBalObj.balance.toFixed(2)} available)`,
          'racedrop_pick:sui'
        ),
      ]);
    }
  }

  for (const pos of positions) {
    const isSuiPos = pos.chain === 'sui' || isSuiToken(pos.token_address);
    const { balance: humanQty, symbol } = await getUserAvailableBalance(
      telegramId,
      pos.token_address,
      isSuiPos ? 'sui' : 'near'
    );
    if (humanQty > 0) {
      buttons.push([
        Markup.button.callback(
          `🎒 ${symbol} (${formatDropAmount(humanQty)} available)`,
          `racedrop_pick:${pos.token_address}`
        ),
      ]);
    }
  }

  if (buttons.length === 0) {
    await ctx.reply(
      '❌ <b>No Available Funds</b>\n\n' +
      'You need tokens or NEAR in your wallet to create a RaceDrop. Deposit NEAR or buy tokens first!',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🎒 View Wallet / Deposit', 'wallet_refresh')],
        ]),
      }
    );
    return;
  }

  buttons.push([Markup.button.callback('❌ Cancel', 'racedrop_cancel')]);

  const text =
    `🏎️ <b>Create a RaceDrop</b> 🏁\n\n` +
    `Airdrop tokens to any Telegram group! When members click <b>Claim</b>, tokens are automatically sent to their wallet.\n\n` +
    `🎁 <b>Viral Referral Boost:</b> New users who claim will be permanently linked under your referral link, earning you 30%–45% of their future trading fees!\n\n` +
    `👇 <b>Select a token from your wallet to drop:</b>`;

  await ctx.reply(text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(buttons),
  });
}

/**
 * Registers all RaceDrop bot commands, action callbacks, and text triggers.
 */
export function setupRaceDropRoutes(
  bot: Telegraf,
  userPendingActions: Map<number, any>
): void {
  _raceDropBot = bot;
  // ── Action: racedrop_claim_exec:<id> (from the Claim MENU page or Group Card) ─
  bot.action(/^racedrop_claim_exec:(.+)$/, async (ctx) => {
    const dropId = ctx.match[1];
    try {
      await ctx.answerCbQuery('Processing claim...').catch(() => {});
      await executeRaceDropClaim(ctx, dropId);
    } catch (err: any) {
      const friendly = getUserFriendlyError(err);
      await ctx.answerCbQuery(friendly.replace(/<[^>]+>/g, ''), { show_alert: true }).catch(() => {});
    }
  });

  // ── Inline Query: lets users share RaceDrop cards with 1-click Claim buttons directly into any group ──
  bot.on('inline_query', async (ctx) => {
    const rawQuery = ctx.inlineQuery.query?.trim() || '';
    const botUsername = getBotUsername(ctx);

    try {
      let drops: RaceDropRecord[] = [];
      const uuidMatch = rawQuery.match(/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/i);

      if (uuidMatch) {
        const drop = await getRaceDropById(uuidMatch[1]).catch(() => null);
        if (drop) drops.push(drop);
      } else {
        const user = await getUserByTelegramId(ctx.from.id).catch(() => null);
        if (user) {
          const userDrops = await getRaceDropsByUser(user.id, 10).catch(() => []);
          drops = userDrops.filter((d) => d.status === 'active' && new Date() <= d.expires_at && d.claims_count < d.total_claims);
        }
      }

      if (drops.length === 0) {
        await ctx.answerInlineQuery([], { cache_time: 1, is_personal: true }).catch(() => {});
        return;
      }

      const results = await Promise.all(
        drops.map(async (drop) => {
          const perUserFormatted = drop.amount_per_user
            ? `${formatDropAmount(drop.amount_per_user)} ${drop.token_symbol}`
            : `${formatDropAmount(parseFloat(drop.total_amount) / drop.total_claims)} ${drop.token_symbol}`;
          const allClaims = await getRaceDropClaimsByDrop(drop.id).catch(() => []);
          const creatorUser = await getUserById(drop.creator_id).catch(() => null);
          const creatorTgUser = creatorUser
            ? (await ctx.telegram.getChat(creatorUser.telegram_id).catch(() => null) as any)
            : null;
          const creatorUsername = creatorTgUser?.username || undefined;

          const creatorDisplay = drop.creator_name || (creatorUsername ? `@${creatorUsername}` : `User #${drop.creator_telegram_id}`);
          const groupCard = buildRaceDropGroupCard(drop, creatorUsername, botUsername, allClaims);
          const spotsRemaining = Math.max(0, drop.total_claims - drop.claims_count);
          return {
            type: 'article' as const,
            id: `drop_${drop.id}`,
            title: `Community Airdrop: +${perUserFormatted}`,
            description: `Sponsored by ${creatorDisplay} • ${spotsRemaining} spots left • Tap to share with Claim button`,
            input_message_content: {
              message_text: groupCard.text,
              parse_mode: 'HTML' as const,
              link_preview_options: { is_disabled: true },
            },
            reply_markup: groupCard.keyboard.reply_markup,
          };
        })
      );

      await ctx.answerInlineQuery(results as any, { cache_time: 2, is_personal: true }).catch(() => {});
    } catch (err: any) {
      console.warn('[RACEDROP] Inline query error:', err?.message || err);
      await ctx.answerInlineQuery([], { cache_time: 1, is_personal: true }).catch(() => {});
    }
  });

  // ── Listener for @bot drop_<id> or drop_<id> or raw UUID anywhere ──────────
  bot.hears(
    /(?:@\w+\s+)?(?:drop_|racedrop_)?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/i,
    async (ctx) => {
      const dropId = ctx.match[1];
      const drop = await getRaceDropById(dropId).catch(() => null);
      if (!drop) return;

      const botUsername = getBotUsername(ctx);
      const isGroup = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';

      if (isGroup) {
        await handleRaceDropGroupPost(ctx, dropId);
      } else {
        await showRaceDropClaimMenu(ctx, dropId);
      }
    }
  );

  // ── /racedrop & /drop command ──────────────────────────────────────────────
  bot.command(['racedrop', 'drop', 'redpacket'], async (ctx) => {
    const telegramId = ctx.from!.id;
    const botUsername = getBotUsername(ctx);
    const isGroup = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
    const msgText = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
    const args = msgText.split(' ').slice(1).filter(Boolean);

    try {
      // Check if argument is a drop ID (e.g. /drop <id> or /drop drop_<id>)
      if (args.length === 1) {
        const uuidMatch = args[0].match(/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/i);
        if (uuidMatch) {
          const drop = await getRaceDropById(uuidMatch[1]).catch(() => null);
          if (drop) {
            if (isGroup) {
              await handleRaceDropGroupPost(ctx, drop.id);
            } else {
              await showRaceDropClaimMenu(ctx, drop.id);
            }
            return;
          }
        }
      }

      const user = await getUserByTelegramId(telegramId);
      if (!user) {
        if (isGroup) {
          await ctx.reply(
            `🏎️ <b>Hey @${ctx.from!.username || 'there'}!</b> Please start @${botUsername} in DM first to initialize your wallet.`,
            { parse_mode: 'HTML' }
          );
        } else {
          await ctx.reply('Please run /start first to initialize your wallet.');
        }
        return;
      }

      // If called in group without a drop ID, direct them to DM to setup the drop securely
      if (isGroup) {
        await ctx.reply(
          `🏎️ <b>Want to send a RaceDrop to this group?</b>\n\n` +
          `Airdrop tokens for group members to claim!\n\n` +
          `To protect your wallet details, please configure your RaceDrop in private DM:`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.url('🏎️ Setup RaceDrop in DM', `https://t.me/${botUsername}?start=racedrop`)],
            ]),
          }
        );
        return;
      }

      // DM called with arguments: instant creation & share card
      if (args.length >= 3) {
        const rawToken = args[0].toLowerCase();
        const amountPerUser = parseFloat(args[1]);
        const totalClaims = parseInt(args[2], 10);
        const note = args.slice(3).join(' ') || undefined;

        if (isNaN(amountPerUser) || amountPerUser <= 0) {
          await ctx.reply('❌ Invalid amount per user. Please specify a positive number.');
          return;
        }
        if (isNaN(totalClaims) || totalClaims < 1 || totalClaims > 100) {
          await ctx.reply('❌ Total claimers must be between 1 and 100.');
          return;
        }

        const totalAmount = Number((amountPerUser * totalClaims).toFixed(6));
        const isNear = rawToken === 'near';
        const isSui = rawToken === 'sui';
        const chain: 'near' | 'sui' = isSui ? 'sui' : 'near';
        const tokenAddress = isNear ? 'near' : isSui ? 'sui' : args[0];
        const { balance, symbol } = await getUserAvailableBalance(telegramId, tokenAddress, chain);

        if (balance < totalAmount) {
          await ctx.reply(
            `❌ Insufficient balance. You need ${formatDropAmount(totalAmount)} ${symbol}, but have ${formatDropAmount(balance)} ${symbol}.`
          );
          return;
        }

        const creatorName = getTelegramDisplayName(ctx.from);

        const drop = await createRaceDrop({
          creator_id: user.id,
          creator_telegram_id: telegramId,
          creator_name: creatorName,
          chain,
          token_address: tokenAddress,
          token_symbol: symbol,
          amount_per_user: amountPerUser,
          total_amount: totalAmount,
          total_claims: totalClaims,
          split_mode: 'equal',
          message_text: note,
        });

        const shareCard = buildRaceDropCreatorShareCard(drop, botUsername);
        await ctx.reply(shareCard.text, {
          parse_mode: 'HTML',
          ...shareCard.keyboard,
        });

        return;
      }

      // DM called without arguments -> Interactive Wizard
      await startRaceDropWizard(ctx);
    } catch (err: any) {
      console.error('[RACEDROP] Error in racedrop command:', err);
      await ctx.reply(`❌ ${getUserFriendlyError(err)}`);
    }
  });

  // ── Action: racedrop_start & menu_racedrop (from MENU card) ────────────────
  bot.action(['racedrop_start', 'menu_racedrop'], async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      await startRaceDropWizard(ctx);
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => {});
    }
  });

  // ── Action: racedrop_pick:<token_address> (Step 1 -> Step 2) ───────────────
  bot.action(/^racedrop_pick:(.+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const tokenAddress = ctx.match[1];

    try {
      const isSui = tokenAddress === 'sui' || tokenAddress.startsWith('0x');
      const chain: 'near' | 'sui' = isSui ? 'sui' : 'near';
      const { balance, symbol } = await getUserAvailableBalance(telegramId, tokenAddress, chain);

      if (balance <= 0) {
        await ctx.answerCbQuery(`You have 0 ${symbol} in your wallet.`).catch(() => {});
        return;
      }

      await ctx.answerCbQuery().catch(() => {});

      const creatorName = getTelegramDisplayName(ctx.from);

      await setRaceDropWizardState(
        telegramId,
        {
          action: 'racedrop_amount',
          raceDropToken: tokenAddress,
          raceDropSymbol: symbol,
          raceDropChain: chain,
          raceDropCreatorName: creatorName,
        },
        userPendingActions
      );

      // Calculate quick presets for amount per user (beginning from 50, 100, 200 for tokens)
      const presets: number[] = [];
      const isNativeMajor = tokenAddress === 'near' || tokenAddress === 'sui';

      if (isNativeMajor) {
        if (balance >= 10) {
          presets.push(0.5, 1, 2, 5);
        } else if (balance >= 1) {
          presets.push(0.1, 0.25, 0.5, 1);
        } else {
          presets.push(
            Number((balance * 0.1).toFixed(4)),
            Number((balance * 0.25).toFixed(4)),
            Number((balance * 0.5).toFixed(4))
          );
        }
      } else {
        // Larger numbers beginning from 50, 100, 200 as requested
        const candidates = [50, 100, 200, 500, 1000, 5000];
        const validCandidates = candidates.filter((amt) => amt <= balance);

        if (validCandidates.length >= 3) {
          presets.push(...validCandidates.slice(0, 4));
        } else if (validCandidates.length > 0) {
          presets.push(...validCandidates);
        } else if (balance >= 10) {
          presets.push(5, 10, 25);
        } else {
          presets.push(
            Number((balance * 0.1).toFixed(2)),
            Number((balance * 0.25).toFixed(2)),
            Number((balance * 0.5).toFixed(2))
          );
        }
      }

      const presetButtons = presets.map((amt) =>
        Markup.button.callback(`${formatDropAmount(amt)} ${symbol}`, `racedrop_set_amt_user:${amt}`)
      );

      // Arrange buttons in clean rows
      const keyboardRows: any[] = [];
      if (presetButtons.length <= 3) {
        keyboardRows.push(presetButtons);
      } else {
        keyboardRows.push(presetButtons.slice(0, 3));
        keyboardRows.push(presetButtons.slice(3));
      }

      keyboardRows.push([
        Markup.button.callback('✏️ Custom Amount', 'racedrop_prompt_custom_amt'),
        Markup.button.callback('❌ Cancel', 'racedrop_cancel'),
      ]);

      const text =
        `🪙 <b>Selected Token:</b> <code>${symbol}</code>\n` +
        `💰 <b>Available Balance:</b> <code>${formatDropAmount(balance)} ${symbol}</code>\n\n` +
        `👉 <b>Step 1 of 2: Amount of tokens per user to claim</b>\n\n` +
        `How many <b>${symbol}</b> should each user receive when they claim?\n\n` +
        `Tap a preset below or <b>reply with any custom amount</b> in this chat (e.g. <code>${presets[0] || '100'}</code>):`;

      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(keyboardRows),
      }).catch(async () => {
        await ctx.reply(text, {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard(keyboardRows),
        });
      });
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => {});
    }
  });

  // ── Action: racedrop_prompt_custom_amt & racedrop_prompt_custom_claims ──────
  bot.action('racedrop_prompt_custom_amt', async (ctx) => {
    await ctx.answerCbQuery('💡 Type any custom amount in this chat (e.g. 300, 750, 5000)').catch(() => {});
  });

  bot.action('racedrop_prompt_custom_claims', async (ctx) => {
    await ctx.answerCbQuery('💡 Type the number of users in this chat (e.g. 15, 30, 50)').catch(() => {});
  });

  // ── Action: racedrop_set_amt_user:<amount> (Step 2 -> Step 3) ──────────────
  bot.action(/^racedrop_set_amt_user:(.+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const amountStr = ctx.match[1];
    const amountPerUser = parseFloat(amountStr);

    try {
      await ctx.answerCbQuery().catch(() => {});
      await handleRaceDropAmountPerUserInput(ctx, telegramId, amountPerUser, userPendingActions);
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => {});
    }
  });

  // ── Action: racedrop_set_claims:<claims> (Step 3 -> Done) ──────────────────
  bot.action(/^racedrop_set_claims:(\d+)$/, async (ctx) => {
    const telegramId = ctx.from!.id;
    const claims = parseInt(ctx.match[1], 10);

    try {
      await ctx.answerCbQuery('Creating RaceDrop...').catch(() => {});
      await handleRaceDropClaimsInput(ctx, telegramId, claims, userPendingActions);
    } catch (err: any) {
      await ctx.answerCbQuery(getUserFriendlyError(err)).catch(() => {});
    }
  });

  // ── Action: racedrop_cancel ────────────────────────────────────────────────
  bot.action('racedrop_cancel', async (ctx) => {
    await clearRaceDropWizardState(ctx.from!.id, userPendingActions);
    await ctx.answerCbQuery('RaceDrop cancelled.').catch(() => {});
    await ctx.deleteMessage().catch(() => {});
  });
}
