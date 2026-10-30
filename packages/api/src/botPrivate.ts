/**
 * Private trading in the Telegram bot: the 🛡 Private screen (private balance, ready pool, private
 * positions), the private-mode switch that routes bot buys through executors, and the deposit,
 * withdraw and pool-size prompts. Trading itself lives in executorPool.ts.
 */
import { Markup, type Telegraf } from 'telegraf';
import { getShortTokenKey, resolveTokenAddressFromKey } from '@racerbot/shared';
import { getUserByTelegramId, updateConfidentialSettings, type UserRecord } from '@racerbot/db';
import {
  EXECUTORS_ENABLED,
  POOL_LIMITS,
  confidentialOverview,
  confidentialSell,
  depositFromWallet,
  ensureConfidentialAccount,
  poolSizesForTotal,
  quoteCrossChainDeposit,
  refillPool,
  withdrawPrivate,
} from './executorPool.js';
import { generateQrBuffer, generateWalletDeepLink, SUPPORTED_CHAINS, unitsToRaw, type OneClickToken } from './multichainDeposit.js';

const NEAR = 10n ** 24n;

export type PrivatePromptAction = 'private_deposit' | 'private_withdraw' | 'private_pool';

/** Bot route lookup (venue and pool ids), provided by routes.ts */
export type RouteLookup = (token: string) => Promise<{ venue?: string; rhea_pool_id?: number | null; dcl_pool_id?: string | null } | null>;

const fmtNear = (raw: string | bigint | null | undefined, dp = 4): string => {
  const v = BigInt(raw ?? '0');
  return (Number(v / 10n ** 18n) / 1e6).toFixed(dp).replace(/\.?0+$/, '') || '0';
};

function fmtUnits(raw: string, decimals: number): string {
  const v = BigInt(raw || '0');
  const base = 10n ** BigInt(decimals);
  const frac = (v % base).toString().padStart(decimals, '0').slice(0, 4).replace(/0+$/, '');
  return (v / base).toLocaleString('en-US') + (frac ? '.' + frac : '');
}

const toYocto = (n: number): bigint => BigInt(Math.round(n * 1e6)) * 10n ** 18n;

/** The 🛡 Private screen */
export async function buildPrivateView(user: UserRecord): Promise<{ text: string; keyboard: any }> {
  if (!EXECUTORS_ENABLED) {
    return {
      text: '🛡 *Private Trading*\n\nPrivate trading switches on once its contracts are deployed. Check back soon.',
      keyboard: Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'menu_home')]]),
    };
  }
  const acct = await ensureConfidentialAccount(user);
  const o: any = await confidentialOverview(user);
  const pool: any[] = o.pool || [];
  const ready = pool.filter(p => p.status === 'ready');
  const readyTotal = ready.reduce((s, p) => s + BigInt(p.size), 0n);
  const funding = pool.length - ready.length;

  // One row per token, summed across its executors
  const byToken = new Map<string, { symbol: string; decimals: number; balance: bigint }>();
  for (const p of o.positions || []) {
    const cur = byToken.get(p.token) ?? { symbol: p.symbol || p.token.split('.')[0].toUpperCase(), decimals: p.decimals ?? 18, balance: 0n };
    cur.balance += BigInt(p.balance || '0');
    byToken.set(p.token, cur);
  }

  let text =
    `🛡 *Private Trading*\n\n` +
    `Your private balance sits in NEAR Intents. With private mode on, every buy runs from its own executor account, so your wallet never appears in a trade.\n\n` +
    `🔒 *Private balance*: \`${o.privateBalance == null ? '—' : fmtNear(o.privateBalance)} NEAR\`\n` +
    `⚡ *Ready to trade*: \`${fmtNear(readyTotal)} NEAR\` in ${ready.length} executor${ready.length === 1 ? '' : 's'}${funding ? ` (+${funding} funding)` : ''}\n` +
    `⚙️ *Pool size*: \`${fmtNear(acct.pool_cap_yocto)} NEAR\`\n` +
    `🛡 *Private mode*: ${acct.bot_private ? '✅ On: your buys are private' : '⏸ Off: buys use your wallet'}\n`;
  if (byToken.size > 0) {
    text += `\n*Private positions*\n`;
    for (const [, t] of byToken) text += `• ${t.symbol}: \`${fmtUnits(t.balance.toString(), t.decimals)}\`\n`;
  } else {
    text += `\n_No private positions yet._\n`;
  }
  text += `\n_Deposits take ~20 s, withdrawals ~15 s. Use round amounts for more privacy._`;

  const rows: any[] = [
    [Markup.button.callback(acct.bot_private ? '🛡 Private mode: ON' : '🛡 Private mode: OFF', 'pv_toggle')],
    [Markup.button.callback('📥 Deposit', 'pv_dep'), Markup.button.callback('📤 Withdraw', 'pv_wd')],
    [Markup.button.callback('🌐 Deposit from another chain', 'pv_xchain')],
    [Markup.button.callback('⚙️ Pool size', 'pv_pool')],
  ];
  for (const [token, t] of [...byToken].slice(0, 8)) {
    const key = getShortTokenKey(token);
    rows.push([
      Markup.button.callback(`🔴 ${t.symbol} 50%`, `pv_sell:${key}:50`),
      Markup.button.callback(`🔴 ${t.symbol} 100%`, `pv_sell:${key}:100`),
    ]);
  }
  rows.push([Markup.button.callback('🔄 Refresh', 'menu_private'), Markup.button.callback('🔙 Back', 'menu_home')]);
  return { text, keyboard: Markup.inlineKeyboard(rows) };
}

// ── Deposits from other chains ───────────────────────────────────────────────
// The multi-chain picker (chain → token → amount) is shared with public deposits. Starting it from
// the Private screen marks the user for a while, so the final quote goes to the private balance.

const PRIVATE_DEPOSIT_TTL_MS = 15 * 60_000;
const privateDepositUntil = new Map<number, number>();

export function isPrivateDeposit(telegramId: number): boolean {
  const until = privateDepositUntil.get(telegramId);
  if (until && until > Date.now()) return true;
  privateDepositUntil.delete(telegramId);
  return false;
}

export function setPrivateDeposit(telegramId: number, on: boolean): void {
  if (on) privateDepositUntil.set(telegramId, Date.now() + PRIVATE_DEPOSIT_TTL_MS);
  else privateDepositUntil.delete(telegramId);
}

/** The chain picker, labelled as a private deposit, with a way back to an ordinary one */
export function privatizeDepositPicker<T extends { text: string; keyboard: any }>(menu: T): T {
  menu.text =
    `🛡 <b>Private deposit from another chain</b>\n\n` +
    `What you send arrives in your <b>private balance</b> as NEAR, without passing through a public NEAR wallet. ` +
    `1% fee, the same as regular deposits.\n\n` +
    `🪙 <b>Select the chain you are sending from:</b>`;
  const rows = menu.keyboard?.reply_markup?.inline_keyboard;
  if (Array.isArray(rows)) rows.unshift([Markup.button.callback('↩️ Deposit to my wallet instead', 'pv_xchain_off')]);
  return menu;
}

/** Final step of a private cross-chain deposit: the one-time address, as a QR card */
export async function renderPrivateDepositCard(ctx: any, user: UserRecord, token: OneClickToken, amount: number): Promise<void> {
  const chain = SUPPORTED_CHAINS[token.blockchain.toLowerCase()];
  const chainName = chain ? `${chain.icon} ${chain.name}` : token.blockchain.toUpperCase();
  const wait = await ctx.reply(`⏳ Getting a private deposit address for ${amount} ${token.symbol}...`).catch(() => null);
  try {
    const quote = await quoteCrossChainDeposit(user, token.assetId, unitsToRaw(amount, token.decimals));
    setPrivateDeposit(ctx.from!.id, false);
    const qr = await generateQrBuffer(quote.depositAddress);
    const link = generateWalletDeepLink(token.blockchain, quote.depositAddress, amount);
    const caption =
      `🛡 <b>Private deposit address</b>\n\n` +
      `Send exactly <code>${amount} ${token.symbol}</code> on ${chainName} to:\n` +
      `<code>${quote.depositAddress}</code>\n` +
      (quote.depositMemo ? `\n📝 <b>Memo (required):</b> <code>${quote.depositMemo}</code>\n` : '') +
      `\n💰 About <b>${fmtNear(quote.amountOut)} NEAR</b> arrives in your private balance (at least ${fmtNear(quote.minAmountOut)}).\n` +
      `🔒 It never passes through your public wallet. Refunds return to your private balance.\n` +
      `⏱️ This address is for this deposit only and expires in 30 minutes.`;
    const rows: any[] = [];
    if (link && /^https?:\/\//.test(link)) rows.push([Markup.button.url(token.blockchain === 'sol' ? '🟣 Open in Phantom' : '🦊 Open in wallet', link)]);
    rows.push([Markup.button.callback('🛡 Private', 'menu_private')]);
    await ctx.replyWithPhoto({ source: qr }, { caption, parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) });
  } catch (err: any) {
    await ctx.reply(`❌ Could not create the private deposit: ${err?.message || 'unknown error'}`);
  } finally {
    if (wait) await ctx.deleteMessage(wait.message_id).catch(() => {});
  }
}

/** Telegram callbacks for the Private screen. `setPrompt` stores the next text reply's meaning. */
export function registerPrivateActions(
  bot: Telegraf,
  deps: {
    setPrompt: (telegramId: number, action: PrivatePromptAction) => void;
    lookupRoute: RouteLookup;
    /** Shows the multi-chain deposit picker (private or ordinary, by the user's mark) */
    openDepositPicker: (ctx: any) => Promise<void>;
  },
): void {
  const withUser = async (ctx: any): Promise<UserRecord | null> => {
    const user = await getUserByTelegramId(ctx.from!.id).catch(() => null);
    if (!user) await ctx.answerCbQuery('Please run /start first.').catch(() => {});
    return user;
  };
  const show = async (ctx: any, user: UserRecord, edit = true) => {
    const view = await buildPrivateView(user);
    if (edit) await ctx.editMessageText(view.text, { parse_mode: 'Markdown', ...view.keyboard }).catch(() => ctx.reply(view.text, { parse_mode: 'Markdown', ...view.keyboard }));
    else await ctx.reply(view.text, { parse_mode: 'Markdown', ...view.keyboard });
  };

  bot.action('menu_private', async (ctx) => {
    const user = await withUser(ctx);
    if (!user) return;
    await ctx.answerCbQuery().catch(() => {});
    await show(ctx, user).catch(async (err: any) => { await ctx.reply(`❌ ${err?.message || 'Could not load private trading'}`); });
  });

  bot.action('pv_toggle', async (ctx) => {
    const user = await withUser(ctx);
    if (!user || !EXECUTORS_ENABLED) return;
    const acct = await ensureConfidentialAccount(user);
    const updated = await updateConfidentialSettings(user.id, { bot_private: !acct.bot_private });
    await ctx.answerCbQuery(updated?.bot_private ? 'Private mode on: your buys are now private' : 'Private mode off').catch(() => {});
    if (updated?.bot_private) void refillPool(updated).catch(() => {});
    await show(ctx, user);
  });

  const prompt = (action: PrivatePromptAction, question: string) => async (ctx: any) => {
    const user = await withUser(ctx);
    if (!user || !EXECUTORS_ENABLED) return;
    await ctx.answerCbQuery().catch(() => {});
    deps.setPrompt(ctx.from!.id, action);
    await ctx.reply(question, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Cancel', 'menu_private')]]) });
  };
  bot.action('pv_dep', prompt('private_deposit', '📥 How much NEAR should move from your wallet into your private balance? (e.g. `5`)'));
  bot.action('pv_wd', prompt('private_withdraw', '📤 How much NEAR should leave your private balance? Reply with an amount (e.g. `2`), optionally followed by a NEAR account to send it to. It goes to your RacerBot wallet by default.'));
  bot.action('pv_pool', prompt('private_pool', `⚙️ How much NEAR should stay ready in executors? (${fmtNear(POOL_LIMITS.min)}–${fmtNear(POOL_LIMITS.hardCap)}, split into 1 NEAR executors; e.g. \`5\`)`));

  bot.action('pv_xchain', async (ctx) => {
    const user = await withUser(ctx);
    if (!user || !EXECUTORS_ENABLED) return;
    await ctx.answerCbQuery().catch(() => {});
    await ensureConfidentialAccount(user);
    setPrivateDeposit(ctx.from!.id, true);
    await deps.openDepositPicker(ctx);
  });

  bot.action('pv_xchain_off', async (ctx) => {
    await ctx.answerCbQuery('Deposits go to your wallet again').catch(() => {});
    setPrivateDeposit(ctx.from!.id, false);
    await deps.openDepositPicker(ctx);
  });

  bot.action(/^pv_sell:([^:]+):(50|100)$/, async (ctx) => {
    const user = await withUser(ctx);
    if (!user || !EXECUTORS_ENABLED) return;
    const token = resolveTokenAddressFromKey(ctx.match![1]);
    const pct = Number(ctx.match![2]);
    await ctx.answerCbQuery(`Selling ${pct}% privately...`).catch(() => {});
    const route = await deps.lookupRoute(token).catch(() => null);
    const res = await confidentialSell({
      user, tokenAddress: token, venue: route?.venue || 'rhea', percent: pct,
      slippagePct: user.slippage_pct ? Number(user.slippage_pct) : 2,
      poolId: route?.rhea_pool_id ?? undefined, dclPoolId: route?.dcl_pool_id ?? undefined,
    }).catch((err: any) => ({ success: false, reason: err?.message, txHashes: [] as string[] }));
    await ctx.reply(res.success
      ? `✅ Sold ${pct}% privately. ${pct === 100 ? 'The NEAR returns to your private balance once the position closes (about a minute).' : ''}`
      : `❌ Private sell failed: ${res.reason || 'unknown error'}. Your tokens are still in the position.`);
    await show(ctx, user, false).catch(() => {});
  });
}

/** Handles a text reply to one of the Private prompts. */
export async function handlePrivatePrompt(ctx: any, user: UserRecord, action: PrivatePromptAction, rawText: string): Promise<void> {
  const [amountText, destination] = rawText.trim().split(/\s+/);
  const amount = Number(amountText);
  try {
    if (action === 'private_pool') {
      if (!(amount >= Number(POOL_LIMITS.min) / 1e24 && amount <= Number(POOL_LIMITS.hardCap / NEAR))) {
        await ctx.reply(`❌ Pool size must be between ${fmtNear(POOL_LIMITS.min)} and ${fmtNear(POOL_LIMITS.hardCap)} NEAR.`);
        return;
      }
      const sizes = poolSizesForTotal(toYocto(amount));
      const updated = await updateConfidentialSettings(user.id, { pool_sizes: sizes, pool_cap_yocto: toYocto(amount).toString() });
      if (updated) void refillPool(updated).catch(() => {});
      await ctx.reply(`✅ Pool set to ${amount} NEAR. Executors are being funded from your private balance.`);
    } else if (action === 'private_deposit') {
      if (!(amount >= 0.1)) {
        await ctx.reply('❌ Deposit at least 0.1 NEAR.');
        return;
      }
      await ctx.reply('⏳ Sending your deposit...');
      await depositFromWallet(user, toYocto(amount));
      await ctx.reply(`✅ Deposit of ${amount} NEAR sent. It reaches your private balance in about 20 seconds.`);
    } else {
      if (!(amount > 0)) {
        await ctx.reply('❌ Enter an amount to withdraw.');
        return;
      }
      if (destination && !/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$|^[0-9a-f]{64}$/.test(destination)) {
        await ctx.reply('❌ That is not a valid NEAR account.');
        return;
      }
      await withdrawPrivate(user, toYocto(amount), destination);
      await ctx.reply(`✅ Withdrawal of ${amount} NEAR sent${destination ? ` to \`${destination}\`` : ' to your wallet'}. It arrives in about 15 seconds.`, { parse_mode: 'Markdown' });
    }
  } catch (err: any) {
    await ctx.reply(`❌ ${err?.message || 'Request failed'}. Nothing left your balance.`);
  }
  const view = await buildPrivateView(user).catch(() => null);
  if (view) await ctx.reply(view.text, { parse_mode: 'Markdown', ...view.keyboard });
}
