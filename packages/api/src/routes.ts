import { Telegraf, Markup, Context } from 'telegraf';
import {
  getUserByTelegramId,
  getOpenPositions,
  getFillsByPosition,
  getTokenCache,
  createTrigger,
  updateUserDefaults,
} from '@racerbot/db';
import {
  getTokenInfo,
  publishSwap,
  onboardUser,
  rotateUserKey,
  getUserBalances,
  unwrapUserWrapNear,
  withdrawFunds,
} from './wallet.js';
import { computePnL, fuzzyMatch, decrypt } from '@racerbot/shared';
import { utils as nearUtils } from 'near-api-js';
import { MASTER_KEY } from './config.js';

// ── Token cache for snipe-by-name fuzzy matching ──────────────────────────────
// Populated by subscribing to detector events in index.ts
export const localTokenNames = new Map<string, { address: string; symbol: string }>();

// ── Rate limiting for /export command (1 export per 5 minutes per user) ───────
const lastExportTime = new Map<number, number>();
const EXPORT_COOLDOWN_MS = 5 * 60 * 1000;

export function setupRoutes(bot: Telegraf): void {

  // ── /start — custodial onboarding (Telegram-only, no Mini App) ──────────────
  bot.command('start', async (ctx) => {
    const telegramId = ctx.from!.id;

    try {
      const result = await onboardUser(telegramId);

      if (result.isExisting) {
        await ctx.reply(
          `👋 *Welcome back to RacerBot!*\n\n` +
          `🔑 Account: \`${result.subaccountId}\`\n\n` +
          `*Commands*:\n` +
          `/wallet — View balance & deposit address\n` +
          `/withdraw <address> [amount] — Withdraw NEAR\n` +
          `/buy — Quick buy\n` +
          `/sell — Quick sell open position\n` +
          `/positions — View open positions\n` +
          `/pnl — View PNL summary\n` +
          `/filters — Set auto-buy filters\n` +
          `/snipe <token_ca> — Snipe by contract address\n` +
          `/info <token_ca> — Token info\n` +
          `/export — Export your private key\n` +
          `/rotatekey — Rotate trading key\n\n` +
          `💬 Join our official trading community: https://t.me/racertrading`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // Freshly created account
      await ctx.reply(
        `🚀 *Welcome to RacerBot!*\n\n` +
        `Your dedicated NEAR trading wallet is ready:\n` +
        `🔑 Account: \`${result.subaccountId}\`\n\n` +
        `⚠️ *YOUR PRIVATE KEY (EXPORT)*:\n` +
        `\`${result.privateKey}\`\n\n` +
        `*Important Security Notice*:\n` +
        `• This string is your real full-access private key. Anyone with this key controls your account.\n` +
        `• To execute lightning-fast trades automatically on your behalf, this key is also stored encrypted on RacerBot's server.\n` +
        `• Save this private key in a safe place. You can import it into MyNearWallet, Meteor Wallet, or NEAR CLI.\n` +
        `• If you ever suspect your key was compromised, use /rotatekey immediately to generate a new key on-chain.\n` +
        `• You can retrieve this key later with /export.\n\n` +
        `💬 Join our official community: https://t.me/racertrading\n\n` +
        `*Commands*:\n` +
        `/wallet — View balance & deposit address\n` +
        `/withdraw <address> [amount] — Withdraw NEAR\n` +
        `/buy <token_ca> [amount] — Quick buy\n` +
        `/sell — Sell open positions\n` +
        `/positions — View open positions\n` +
        `/pnl — View profit/loss summary\n` +
        `/filters — Configure auto-buy settings\n` +
        `/snipe <token_ca> — Snipe newly launched token\n` +
        `/info <token_ca> — Token info & quick-buy\n` +
        `/export — Export account private key\n` +
        `/rotatekey — Rotate your key on-chain`,
        { parse_mode: 'Markdown' }
      );
    } catch (err: any) {
      console.error('[API] Onboarding error for telegramId:', telegramId, err);
      await ctx.reply(`❌ Account setup failed: ${err.message}\n\nPlease try running /start again.`);
    }
  });

  // ── /rotatekey — Rotate trading key on-chain ────────────────────────────────
  bot.command('rotatekey', async (ctx) => {
    const telegramId = ctx.from!.id;
    await ctx.reply('🔄 Rotating your trading key on-chain. Please wait...');
    try {
      const res = await rotateUserKey(telegramId);
      await ctx.reply(
        `✅ *Trading Key Rotated Successfully!*\n\n` +
        `Account: \`${res.subaccountId}\`\n\n` +
        `⚠️ *NEW PRIVATE KEY*:\n` +
        `\`${res.newPrivateKey}\`\n\n` +
        `*Notice*:\n` +
        `• The old key has been removed from your account on-chain.\n` +
        `• The new key has been encrypted and stored on RacerBot to continue automated trading.\n` +
        `• Save this new key securely.`,
        { parse_mode: 'Markdown' }
      );
    } catch (err: any) {
      await ctx.reply(`❌ Key rotation failed: ${err.message}`);
    }
  });

  // ── /export — Export private key with confirmation & rate limiting ───────────
  bot.command('export', async (ctx) => {
    const telegramId = ctx.from!.id;
    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) {
      await ctx.reply('Use /start to set up your wallet first.');
      return;
    }

    const last = lastExportTime.get(telegramId);
    if (last && Date.now() - last < EXPORT_COOLDOWN_MS) {
      const remainingSec = Math.ceil((EXPORT_COOLDOWN_MS - (Date.now() - last)) / 1000);
      await ctx.reply(`⏳ Export is on cooldown. Please wait ${remainingSec}s before requesting again.`);
      return;
    }

    await ctx.reply(
      `⚠️ *Export Private Key*\n\n` +
      `You are requesting to view your raw private key for account \`${user.subaccount_id}\`.\n\n` +
      `Anyone who sees this key will have full control over your funds.\n\n` +
      `Are you sure you want to display your private key?`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('⚠️ Yes, show my private key', 'export_confirm'),
            Markup.button.callback('Cancel', 'export_cancel'),
          ],
        ]),
      }
    );
  });

  bot.action('export_cancel', async (ctx) => {
    await ctx.answerCbQuery('Export cancelled.');
    await ctx.editMessageText('Export cancelled.');
  });

  bot.action('export_confirm', async (ctx) => {
    const telegramId = ctx.from!.id;
    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) {
      await ctx.answerCbQuery('Wallet not found.');
      return;
    }

    const last = lastExportTime.get(telegramId);
    if (last && Date.now() - last < EXPORT_COOLDOWN_MS) {
      const remainingSec = Math.ceil((EXPORT_COOLDOWN_MS - (Date.now() - last)) / 1000);
      await ctx.answerCbQuery(`Cooldown active. Wait ${remainingSec}s.`);
      await ctx.editMessageText(`⏳ Export is on cooldown. Please wait ${remainingSec}s before requesting again.`);
      return;
    }

    lastExportTime.set(telegramId, Date.now());

    // Audit log (never log key material)
    console.log(`[AUDIT] Private key exported for user_id=${user.id}, telegram_id=${telegramId}, timestamp=${new Date().toISOString()}`);

    try {
      const rawPrivateKey = decrypt(user.scoped_key_encrypted, MASTER_KEY);
      await ctx.answerCbQuery('Key decrypted.');

      await ctx.reply(
        `🔑 *Private Key for Account* \`${user.subaccount_id}\`:\n\n` +
        `\`${rawPrivateKey}\`\n\n` +
        `*Import Instructions*:\n` +
        `Paste this string into MyNearWallet, Meteor Wallet, or near-cli via "Import Private Key" to control your account outside RacerBot.`,
        { parse_mode: 'Markdown' }
      );

      await ctx.reply(
        `🛡️ *Security Reminder*:\n` +
        `• Anyone with this private key has full control of your account.\n` +
        `• RacerBot also holds an encrypted copy to execute trades on your behalf. Exporting does not revoke RacerBot's copy.\n` +
        `• If you suspect this key was exposed or you want to move away, withdraw your funds and/or run /rotatekey immediately.`,
        { parse_mode: 'Markdown' }
      );
    } catch (err: any) {
      await ctx.reply(`❌ Could not decrypt key: ${err.message}`);
    }
  });

  // ── /wallet & /balance — View account balance and deposit address ──────────
  const handleWallet = async (ctx: Context) => {
    const telegramId = ctx.from!.id;
    try {
      const b = await getUserBalances(telegramId);
      const buttons = [
        [
          Markup.button.callback('🔄 Refresh', 'wallet_refresh'),
          Markup.button.callback('💸 Withdraw', 'wallet_withdraw_prompt'),
        ],
      ];

      if (Number(b.wrapNearFormatted) > 0.0001) {
        buttons.push([Markup.button.callback(`🔄 Unwrap ${b.wrapNearFormatted} wNEAR to NEAR`, 'wallet_unwrap')]);
      }

      await ctx.reply(
        `💳 *RacerBot Trading Wallet*\n\n` +
        `🔑 Account: \`${b.subaccountId}\`\n\n` +
        `💰 *Balances*:\n` +
        `• *Native NEAR*: \`${b.nativeNearFormatted} NEAR\`\n` +
        `• *Wrapped NEAR*: \`${b.wrapNearFormatted} wNEAR\`\n` +
        `• *Total*: \`${b.totalNearFormatted} NEAR\`\n\n` +
        `📥 *Deposit Address*:\n` +
        `Send native NEAR directly to:\n` +
        `\`${b.subaccountId}\`\n\n` +
        `⚡ *Instant Execution*:\n` +
        `Deposited NEAR is immediately ready for manual and automated sniping.`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard(buttons),
        }
      );
    } catch (err: any) {
      await ctx.reply(`❌ Could not load wallet: ${err.message}`);
    }
  };

  bot.command('wallet', handleWallet);
  bot.command('balance', handleWallet);

  bot.action('wallet_refresh', async (ctx) => {
    const telegramId = ctx.from!.id;
    try {
      const b = await getUserBalances(telegramId);
      const buttons = [
        [
          Markup.button.callback('🔄 Refresh', 'wallet_refresh'),
          Markup.button.callback('💸 Withdraw', 'wallet_withdraw_prompt'),
        ],
      ];
      if (Number(b.wrapNearFormatted) > 0.0001) {
        buttons.push([Markup.button.callback(`🔄 Unwrap ${b.wrapNearFormatted} wNEAR to NEAR`, 'wallet_unwrap')]);
      }

      await ctx.answerCbQuery('Wallet refreshed.');
      await ctx.editMessageText(
        `💳 *RacerBot Trading Wallet*\n\n` +
        `🔑 Account: \`${b.subaccountId}\`\n\n` +
        `💰 *Balances*:\n` +
        `• *Native NEAR*: \`${b.nativeNearFormatted} NEAR\`\n` +
        `• *Wrapped NEAR*: \`${b.wrapNearFormatted} wNEAR\`\n` +
        `• *Total*: \`${b.totalNearFormatted} NEAR\`\n\n` +
        `📥 *Deposit Address*:\n` +
        `Send native NEAR directly to:\n` +
        `\`${b.subaccountId}\`\n\n` +
        `⚡ *Instant Execution*:\n` +
        `Deposited NEAR is immediately ready for manual and automated sniping.`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard(buttons),
        }
      );
    } catch (err: any) {
      await ctx.answerCbQuery(`Error: ${err.message}`);
    }
  });

  bot.action('wallet_unwrap', async (ctx) => {
    const telegramId = ctx.from!.id;
    await ctx.answerCbQuery('Unwrapping wrap.near...');
    try {
      const res = await unwrapUserWrapNear(telegramId);
      await ctx.reply(`✅ Successfully unwrapped ${res.unwrappedAmount} wNEAR into native NEAR!`);
    } catch (err: any) {
      await ctx.reply(`❌ Unwrap failed: ${err.message}`);
    }
  });

  bot.command('unwrap', async (ctx) => {
    const telegramId = ctx.from!.id;
    try {
      const res = await unwrapUserWrapNear(telegramId);
      if (res.unwrappedAmount === '0') {
        await ctx.reply('You do not have any wrap.near balance to unwrap.');
      } else {
        await ctx.reply(`✅ Successfully unwrapped ${res.unwrappedAmount} wNEAR into native NEAR!`);
      }
    } catch (err: any) {
      await ctx.reply(`❌ Unwrap failed: ${err.message}`);
    }
  });

  bot.action('wallet_withdraw_prompt', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
      `💸 *Withdraw NEAR*\n\n` +
      `Usage: \`/withdraw <destination_address> [amount]\`\n\n` +
      `Examples:\n` +
      `• \`/withdraw mywallet.near 1.5\` — Withdraw 1.5 NEAR\n` +
      `• \`/withdraw mywallet.near all\` — Withdraw all available balance\n\n` +
      `_Note: 0.05 NEAR is always retained to cover on-chain account storage._`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── /withdraw <destination> [amount] — Withdraw funds to external wallet ──────
  bot.command('withdraw', async (ctx) => {
    const telegramId = ctx.from!.id;
    const args = ctx.message!.text!.split(' ').slice(1).filter(Boolean);

    if (args.length === 0) {
      await ctx.reply(
        `💸 *Withdraw NEAR*\n\n` +
        `Usage: \`/withdraw <destination_address> [amount]\`\n\n` +
        `Examples:\n` +
        `• \`/withdraw mywallet.near 1.5\` — Withdraw 1.5 NEAR\n` +
        `• \`/withdraw mywallet.near all\` — Withdraw all available balance\n\n` +
        `_Note: Any wrapped NEAR is automatically converted to native NEAR before transferring._`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const destination = args[0].trim();
    const amountArg = args[1]?.toLowerCase();
    const amountNear: number | 'all' = amountArg === 'all' || !amountArg ? 'all' : parseFloat(amountArg);

    if (typeof amountNear === 'number' && (isNaN(amountNear) || amountNear <= 0)) {
      await ctx.reply('❌ Invalid amount. Please specify a positive number or "all".');
      return;
    }

    await ctx.reply(`⏳ Processing withdrawal to \`${destination}\`...`, { parse_mode: 'Markdown' });

    try {
      const result = await withdrawFunds(telegramId, destination, amountNear);
      await ctx.reply(
        `✅ *Withdrawal Successful!*\n\n` +
        `💸 Amount: \`${result.amountWithdrawn} NEAR\`\n` +
        `📬 Destination: \`${result.destination}\`\n\n` +
        `🔗 Explorer: [View on NearBlocks](https://nearblocks.io/txns/${result.txHash})`,
        { parse_mode: 'Markdown' }
      );
    } catch (err: any) {
      await ctx.reply(`❌ Withdrawal failed: ${err.message}`);
    }
  });

  // ── /info <token_ca> — Token info with quick-buy buttons ───────────────────
  bot.command('info', async (ctx) => {
    const args = ctx.message!.text!.split(' ').slice(1);
    if (!args[0]) {
      await ctx.reply('Usage: /info <token_contract_address>');
      return;
    }

    const tokenAddress = args[0].trim();
    await ctx.reply('🔍 Fetching token info...');

    try {
      const info = await getTokenInfo(tokenAddress);

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('Buy 10%', `buy:${tokenAddress}:10`),
          Markup.button.callback('Buy 25%', `buy:${tokenAddress}:25`),
          Markup.button.callback('Buy 50%', `buy:${tokenAddress}:50`),
          Markup.button.callback('Buy 100%', `buy:${tokenAddress}:100`),
        ],
      ]);

      let venueText = `💧 Venue: ${info.venue}`;
      if (info.venue === 'nearlytrade') {
        const phaseStr = info.bonding_phase === 'bonded' ? 'Bonded (DEX)' : 'Prebonded (Bonding Curve)';
        const progressStr =
          info.bonding_progress_pct !== null && info.bonding_progress_pct !== undefined
            ? ` (${info.bonding_progress_pct.toFixed(1)}%)`
            : '';
        venueText = `💧 Venue: NearlyTrade\n📈 Bonding Phase: ${phaseStr}${progressStr}`;
      }

      await ctx.reply(
        `🪙 *${info.name}* (${info.symbol})\n\n` +
        `📝 CA: \`${info.address}\`\n` +
        `${venueText}\n` +
        `💰 Price: ${parseFloat(info.price).toFixed(8)} NEAR\n` +
        `💧 Liquidity: ${parseFloat(info.liquidity).toFixed(2)} NEAR\n` +
        `📊 Market Cap: ${info.market_cap.toFixed(2)} NEAR\n` +
        `📦 Supply: ${info.total_supply}\n` +
        `🔢 Decimals: ${info.decimals}`,
        { parse_mode: 'Markdown', ...keyboard }
      );
    } catch {
      await ctx.reply('❌ Could not fetch token info. Check the contract address and try again.');
    }
  });

  // ── /buy — Quick-buy buttons ────────────────────────────────────────────────
  bot.command('buy', async (ctx) => {
    const telegramId = ctx.from!.id;
    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) {
      await ctx.reply('Use /start to set up your wallet first.');
      return;
    }

    const args = ctx.message!.text!.split(' ').slice(1);
    if (!args[0]) {
      await ctx.reply('Usage: /buy <token_ca> [amount_near]\nExample: /buy token.near 5\n\nOr use /info <token_ca> for quick-buy buttons.');
      return;
    }

    const tokenAddress = args[0].trim();
    const amountNear = parseFloat(args[1] ?? '0');

    if (amountNear <= 0) {
      await ctx.reply('Specify amount in NEAR: /buy <token_ca> <amount_near>');
      return;
    }

    await ctx.reply(`⚡ Sending buy order for ${amountNear} NEAR of \`${tokenAddress}\`...`, { parse_mode: 'Markdown' });

    // Determine venue without blind fallback
    const cached = await getTokenCache(tokenAddress).catch(() => null);
    let venue = cached?.venue as 'rhea' | 'shardsmarket' | 'nearlytrade' | undefined;
    if (!venue) {
      const info = await getTokenInfo(tokenAddress).catch(() => null);
      if (info && info.venue !== 'unknown') {
        venue = info.venue;
      }
    }

    if (!venue) {
      await ctx.reply('❌ Could not determine venue for this token. Verify the contract address and try again.');
      return;
    }

    const slippagePct = user.slippage_pct ? Number(user.slippage_pct) : 2.0;
    const amountInYocto = nearUtils.format.parseNearAmount(amountNear.toString()) ?? '0';
    const near = (await import('@racerbot/shared')).getNear();
    const { minAmountOut } = await near.computeMinAmountOut(
      venue,
      'wrap.near',
      tokenAddress,
      amountInYocto,
      slippagePct,
      cached?.rhea_pool_id
    );

    await publishSwap({
      user_id: user.id,
      token_in: 'wrap.near',
      token_out: tokenAddress,
      amount_in: amountInYocto,
      min_amount_out: minAmountOut,
      venue,
      dcl_pool_id: cached?.dcl_pool_id ?? undefined,
    });

    await ctx.reply(`✅ Buy order queued. You'll be notified when it confirms.`);
  });

  // ── Inline button handlers for quick-buy ──────────────────────────────────
  bot.action(/^buy:(.+):(\d+)$/, async (ctx) => {
    const match = ctx.match!;
    const tokenAddress = match[1];
    const pct = parseInt(match[2]);
    const telegramId = ctx.from!.id;

    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) {
      await ctx.answerCbQuery('Please use /start to set up your wallet first.');
      return;
    }

    // Get user's NEAR balance to compute percentage
    const near = (await import('@racerbot/shared')).getNear();
    let balanceNear = 0;
    try {
      const balanceYocto = await near.getNearBalance(user.subaccount_id);
      balanceNear = parseFloat(nearUtils.format.formatNearAmount(balanceYocto));
    } catch {
      await ctx.answerCbQuery('Could not fetch balance. Try again.');
      return;
    }

    const amountNear = (balanceNear * pct) / 100;
    if (amountNear < 0.01) {
      await ctx.answerCbQuery('Balance too low to buy.');
      return;
    }

    const cached = await getTokenCache(tokenAddress).catch(() => null);
    let venue = cached?.venue as 'rhea' | 'shardsmarket' | 'nearlytrade' | undefined;
    if (!venue) {
      const info = await getTokenInfo(tokenAddress).catch(() => null);
      if (info && info.venue !== 'unknown') {
        venue = info.venue;
      }
    }

    if (!venue) {
      await ctx.answerCbQuery('Could not determine venue for token.');
      return;
    }

    const slippagePct = user.slippage_pct ? Number(user.slippage_pct) : 2.0;
    const amountInYocto = nearUtils.format.parseNearAmount(amountNear.toString()) ?? '0';
    const { minAmountOut } = await near.computeMinAmountOut(
      venue,
      'wrap.near',
      tokenAddress,
      amountInYocto,
      slippagePct,
      cached?.rhea_pool_id
    );

    await publishSwap({
      user_id: user.id,
      token_in: 'wrap.near',
      token_out: tokenAddress,
      amount_in: amountInYocto,
      min_amount_out: minAmountOut,
      venue,
      dcl_pool_id: cached?.dcl_pool_id ?? undefined,
    });

    await ctx.answerCbQuery(`✅ Buying ${amountNear.toFixed(4)} NEAR worth (${pct}% of balance)`);
    await ctx.editMessageText(`⚡ Buy order sent: ${amountNear.toFixed(4)} NEAR → \`${tokenAddress}\`\n\nYou'll be notified on confirmation.`, { parse_mode: 'Markdown' });
  });

  // ── /sell — Quick-sell open position ──────────────────────────────────────
  bot.command('sell', async (ctx) => {
    const telegramId = ctx.from!.id;
    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) { await ctx.reply('Use /start first.'); return; }

    const positions = await getOpenPositions(user.id).catch(() => []);
    if (positions.length === 0) {
      await ctx.reply('📭 No open positions.');
      return;
    }

    for (const pos of positions) {
      const tokenInfo = await getTokenInfo(pos.token_address).catch(() => null);
      const tokenLabel = tokenInfo ? `${tokenInfo.symbol} (${pos.token_address.slice(0, 12)}...)` : pos.token_address.slice(0, 20) + '...';
      const currentPrice = tokenInfo ? parseFloat(tokenInfo.price) : 0;
      const pnlPct = currentPrice > 0 && parseFloat(pos.avg_entry_price) > 0
        ? ((currentPrice - parseFloat(pos.avg_entry_price)) / parseFloat(pos.avg_entry_price) * 100).toFixed(1)
        : 'N/A';

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('Sell 25%', `sell:${pos.id}:25`),
          Markup.button.callback('Sell 50%', `sell:${pos.id}:50`),
          Markup.button.callback('Sell 75%', `sell:${pos.id}:75`),
          Markup.button.callback('Sell 100%', `sell:${pos.id}:100`),
        ],
      ]);

      await ctx.reply(
        `📊 *${tokenLabel}*\n` +
        `📦 Holding: ${pos.quantity_held}\n` +
        `📥 Avg Entry: ${parseFloat(pos.avg_entry_price).toFixed(8)} NEAR\n` +
        `💰 Current: ${currentPrice.toFixed(8)} NEAR\n` +
        `📈 PNL: ${pnlPct}%\n\nChoose sell amount:`,
        { parse_mode: 'Markdown', ...keyboard }
      );
    }
  });

  // ── Inline sell button handlers ───────────────────────────────────────────
  bot.action(/^sell:([^:]+):(\d+)$/, async (ctx) => {
    const positionId = ctx.match![1];
    const pct = parseInt(ctx.match![2]);
    const telegramId = ctx.from!.id;
    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) { await ctx.answerCbQuery('Wallet not found.'); return; }

    const { sellAtTarget } = await import('./sellHelper.js');
    await sellAtTarget(user.id, positionId, pct);

    await ctx.answerCbQuery(`✅ Sell order sent (${pct}%)`);
    await ctx.editMessageText(`⚡ Sell order sent: ${pct}% of position.\n\nYou'll be notified on confirmation.`);
  });

  // ── /positions — List all open positions ──────────────────────────────────
  bot.command('positions', async (ctx) => {
    const telegramId = ctx.from!.id;
    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) { await ctx.reply('Use /start first.'); return; }

    const positions = await getOpenPositions(user.id).catch(() => []);
    if (positions.length === 0) {
      await ctx.reply('📭 No open positions.');
      return;
    }

    let msg = `📊 *Open Positions (${positions.length})*\n\n`;
    for (const pos of positions) {
      const info = await getTokenInfo(pos.token_address).catch(() => null);
      const symbol = info?.symbol ?? '???';
      const currentPrice = info ? parseFloat(info.price) : 0;
      const pnlPct = currentPrice > 0 && parseFloat(pos.avg_entry_price) > 0
        ? ((currentPrice - parseFloat(pos.avg_entry_price)) / parseFloat(pos.avg_entry_price) * 100).toFixed(1)
        : 'N/A';
      const emoji = parseFloat(pnlPct) >= 0 ? '🟢' : '🔴';

      msg += `${emoji} *${symbol}*\n`;
      msg += `  Entry: ${parseFloat(pos.avg_entry_price).toFixed(8)} NEAR\n`;
      msg += `  Current: ${currentPrice.toFixed(8)} NEAR\n`;
      msg += `  PNL: ${pnlPct}%\n`;
      msg += `  CA: \`${pos.token_address}\`\n\n`;
    }

    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  // ── /pnl — PNL summary with real computation ──────────────────────────────
  bot.command('pnl', async (ctx) => {
    const telegramId = ctx.from!.id;
    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) { await ctx.reply('Use /start first.'); return; }

    const positions = await getOpenPositions(user.id).catch(() => []);
    const db = await (await import('@racerbot/db')).getDb();
    const closedResult = await db.query(
      'SELECT * FROM positions WHERE user_id = $1 AND status = $2 ORDER BY closed_at DESC LIMIT 10',
      [user.id, 'closed']
    );

    let msg = `📊 *PNL Summary*\n\n`;
    msg += `🟢 Open positions: ${positions.length}\n`;
    msg += `✅ Closed positions (last 10): ${closedResult.rows.length}\n\n`;

    let totalRealizedNear = 0;
    for (const pos of closedResult.rows) {
      const fills = await getFillsByPosition(pos.id).catch(() => []);
      const buys = fills.filter(f => f.side === 'buy');
      const sells = fills.filter(f => f.side === 'sell');

      if (buys.length && sells.length) {
        const avgEntry = parseFloat(pos.avg_entry_price);
        const lastSell = sells[sells.length - 1];
        const sellPrice = parseFloat(lastSell.price);
        const qty = parseFloat(lastSell.amount);
        const buyFee = parseFloat(buys[0]?.fee_paid ?? '0') / (parseFloat(buys[0]?.amount ?? '1'));
        const sellFee = parseFloat(lastSell.fee_paid) / qty;

        const pnl = computePnL(avgEntry, sellPrice, qty, buyFee, sellFee);
        totalRealizedNear += pnl.netNear;

        const tokenInfo = await getTokenInfo(pos.token_address).catch(() => null);
        const symbol = tokenInfo?.symbol ?? pos.token_address.slice(0, 8) + '...';
        const emoji = pnl.pnlPercent >= 0 ? '🟢' : '🔴';
        msg += `${emoji} *${symbol}*: ${pnl.netNear.toFixed(4)} NEAR (${pnl.pnlPercent >= 0 ? '+' : ''}${pnl.pnlPercent.toFixed(2)}%)\n`;
      }
    }

    msg += `\n💰 *Total Realized: ${totalRealizedNear.toFixed(4)} NEAR*`;

    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  // ── /snipe <token_ca|name> — Snipe by CA or name ─────────────────────────
  bot.command('snipe', async (ctx) => {
    const telegramId = ctx.from!.id;
    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) { await ctx.reply('Use /start first.'); return; }

    const args = ctx.message!.text!.split(' ').slice(1);
    if (!args[0]) {
      await ctx.reply('Usage: /snipe <token_ca_or_name> [amount_near]\nExample: /snipe MYTOKEN.near 2');
      return;
    }

    const query = args[0].trim();
    const amountNear = parseFloat(args[1] ?? user.default_buy_pct?.toString() ?? '1');

    if (amountNear <= 0) {
      await ctx.reply('Specify amount: /snipe <token> <amount_near>');
      return;
    }

    // Determine if CA or name
    const isCA = query.includes('.near') || query.length === 64;

    if (isCA) {
      // Direct CA snipe — no fuzzy matching needed
      const cached = await getTokenCache(query).catch(() => null);
      let venue = cached?.venue as 'rhea' | 'shardsmarket' | 'nearlytrade' | undefined;
      if (!venue) {
        const info = await getTokenInfo(query).catch(() => null);
        if (info && info.venue !== 'unknown') {
          venue = info.venue;
        }
      }

      if (!venue) {
        await ctx.reply('❌ Could not determine venue for token. Please verify the contract address.');
        return;
      }

      await ctx.reply(`⚡ Sniping \`${query}\` with ${amountNear} NEAR...`, { parse_mode: 'Markdown' });

      const slippagePct = user.slippage_pct ? Number(user.slippage_pct) : 2.0;
      const amountInYocto = nearUtils.format.parseNearAmount(amountNear.toString()) ?? '0';
      const near = (await import('@racerbot/shared')).getNear();
      const { minAmountOut } = await near.computeMinAmountOut(
        venue,
        'wrap.near',
        query,
        amountInYocto,
        slippagePct,
        cached?.rhea_pool_id
      );

      await publishSwap({
        user_id: user.id,
        token_in: 'wrap.near',
        token_out: query,
        amount_in: amountInYocto,
        min_amount_out: minAmountOut,
        venue,
        dcl_pool_id: cached?.dcl_pool_id ?? undefined,
      });

      await ctx.reply('✅ Snipe order queued! You\'ll be notified on confirmation.');
    } else {
      // Name-based fuzzy match
      const names = Array.from(localTokenNames.keys());
      const { match, score } = fuzzyMatch(query, names);

      if (!match || score < 0.5) {
        await ctx.reply(`❌ No token found matching "${query}".\n\nTry pasting the full contract address (CA) for a direct snipe.`);
        return;
      }

      const tokenData = localTokenNames.get(match)!;

      // Confirm before firing (name collisions are possible)
      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback(`✅ Yes, snipe ${match}`, `snipe_confirm:${tokenData.address}:${amountNear}`),
          Markup.button.callback('❌ Cancel', 'snipe_cancel'),
        ],
      ]);

      await ctx.reply(
        `Found: *${match}* (${tokenData.symbol})\nCA: \`${tokenData.address}\`\n\nSnipe ${amountNear} NEAR?`,
        { parse_mode: 'Markdown', ...keyboard }
      );
    }
  });

  // ── Snipe confirmation button ─────────────────────────────────────────────
  bot.action(/^snipe_confirm:([^:]+):(.+)$/, async (ctx) => {
    const tokenAddress = ctx.match![1];
    const amountNear = parseFloat(ctx.match![2]);
    const telegramId = ctx.from!.id;
    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) { await ctx.answerCbQuery('Wallet not found.'); return; }

    const cached = await getTokenCache(tokenAddress).catch(() => null);
    let venue = cached?.venue as 'rhea' | 'shardsmarket' | 'nearlytrade' | undefined;
    if (!venue) {
      const info = await getTokenInfo(tokenAddress).catch(() => null);
      if (info && info.venue !== 'unknown') {
        venue = info.venue;
      }
    }

    if (!venue) {
      await ctx.answerCbQuery('Could not determine venue.');
      return;
    }

    const slippagePct = user.slippage_pct ? Number(user.slippage_pct) : 2.0;
    const amountInYocto = nearUtils.format.parseNearAmount(amountNear.toString()) ?? '0';
    const near = (await import('@racerbot/shared')).getNear();
    const { minAmountOut } = await near.computeMinAmountOut(
      venue,
      'wrap.near',
      tokenAddress,
      amountInYocto,
      slippagePct,
      cached?.rhea_pool_id
    );

    await publishSwap({
      user_id: user.id,
      token_in: 'wrap.near',
      token_out: tokenAddress,
      amount_in: amountInYocto,
      min_amount_out: minAmountOut,
      venue,
      dcl_pool_id: cached?.dcl_pool_id ?? undefined,
    });

    await ctx.answerCbQuery('Snipe order sent!');
    await ctx.editMessageText(`⚡ Snipe confirmed: ${amountNear} NEAR → \`${tokenAddress}\``, { parse_mode: 'Markdown' });
  });

  bot.action('snipe_cancel', async (ctx) => {
    await ctx.answerCbQuery('Cancelled.');
    await ctx.editMessageText('Snipe cancelled.');
  });

  // ── /filters — Set auto-buy filters ──────────────────────────────────────
  bot.command('filters', async (ctx) => {
    const telegramId = ctx.from!.id;
    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) { await ctx.reply('Use /start first.'); return; }

    const args = ctx.message!.text!.split(' ').slice(1);

    if (args.length === 0) {
      await ctx.reply(
        `⚙️ *Auto-buy & Trading Filters*\n\n` +
        `Current Settings:\n` +
        `  Auto-buy: ${user.auto_buy_enabled ? '🟢 ON' : '🔴 OFF'}\n` +
        `  Auto-buy Amount: ${user.auto_buy_amount_near ?? 1} NEAR\n` +
        `  Min Liquidity: ${user.auto_buy_min_liquidity_near ?? 0} NEAR\n` +
        `  Default Buy %: ${user.default_buy_pct ?? 10}%\n` +
        `  Default Sell %: ${user.default_sell_pct ?? 100}%\n` +
        `  Slippage: ${user.slippage_pct ?? 2.0}%\n\n` +
        `Commands:\n` +
        `/filters auto_buy on|off — Enable/disable auto-buy\n` +
        `/filters amount <near> — Fixed NEAR amount per auto-buy\n` +
        `/filters min_liquidity <near> — Min pool liquidity (NEAR) to trigger auto-buy\n` +
        `/filters buy_pct <1-100> — Set default manual buy percentage\n` +
        `/filters sell_pct <1-100> — Set default manual sell percentage\n` +
        `/filters slippage <0.1-50> — Set slippage tolerance percentage (default 2%)`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const [key, value] = args;

    if (key === 'slippage') {
      const pct = parseFloat(value);
      if (isNaN(pct) || pct < 0.1 || pct > 50) {
        await ctx.reply('slippage must be between 0.1 and 50 percent');
        return;
      }
      const db = await (await import('@racerbot/db')).getDb();
      await db.query('UPDATE users SET slippage_pct = $1 WHERE id = $2', [pct, user.id]);
      await ctx.reply(`✅ Slippage tolerance set to ${pct}%`);

    } else if (key === 'buy_pct') {
      const pct = parseFloat(value);
      if (isNaN(pct) || pct <= 0 || pct > 100) {
        await ctx.reply('buy_pct must be between 1 and 100');
        return;
      }
      await updateUserDefaults(user.id, pct, user.default_sell_pct ?? undefined);
      await ctx.reply(`✅ Default buy set to ${pct}%`);

    } else if (key === 'sell_pct') {
      const pct = parseFloat(value);
      if (isNaN(pct) || pct <= 0 || pct > 100) {
        await ctx.reply('sell_pct must be between 1 and 100');
        return;
      }
      await updateUserDefaults(user.id, user.default_buy_pct ?? undefined, pct);
      await ctx.reply(`✅ Default sell set to ${pct}%`);

    } else if (key === 'auto_buy') {
      const enabled = value === 'on';
      const db = await (await import('@racerbot/db')).getDb();
      await db.query('UPDATE users SET auto_buy_enabled = $1 WHERE id = $2', [enabled, user.id]);
      await ctx.reply(`✅ Auto-buy ${enabled ? 'enabled' : 'disabled'}`);

    } else if (key === 'amount') {
      const amt = parseFloat(value);
      if (isNaN(amt) || amt <= 0) {
        await ctx.reply('amount must be a positive number in NEAR');
        return;
      }
      const db = await (await import('@racerbot/db')).getDb();
      await db.query('UPDATE users SET auto_buy_amount_near = $1 WHERE id = $2', [amt, user.id]);
      await ctx.reply(`✅ Auto-buy amount set to ${amt} NEAR`);

    } else if (key === 'min_liquidity') {
      const minLiq = parseFloat(value);
      if (isNaN(minLiq) || minLiq < 0) {
        await ctx.reply('min_liquidity must be a positive number in NEAR');
        return;
      }
      const db = await (await import('@racerbot/db')).getDb();
      await db.query('UPDATE users SET auto_buy_min_liquidity_near = $1 WHERE id = $2', [minLiq, user.id]);
      await ctx.reply(`✅ Minimum liquidity set to ${minLiq} NEAR`);

    } else {
      await ctx.reply('Unknown filter. Use /filters to see available options.');
    }
  });

  // ── /stoploss <position_id> <pct> — Set stop loss ─────────────────────────
  bot.command('stoploss', async (ctx) => {
    const telegramId = ctx.from!.id;
    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) { await ctx.reply('Use /start first.'); return; }

    const args = ctx.message!.text!.split(' ').slice(1);
    const tokenCA = args[0];
    const pct = parseFloat(args[1] ?? '');

    if (!tokenCA || isNaN(pct) || pct <= 0 || pct >= 100) {
      await ctx.reply('Usage: /stoploss <token_ca> <percent>\nExample: /stoploss mytoken.near 20 (stops at -20%)');
      return;
    }

    const positions = await getOpenPositions(user.id).catch(() => []);
    const position = positions.find(p => p.token_address === tokenCA);

    if (!position) {
      await ctx.reply(`No open position found for \`${tokenCA}\``, { parse_mode: 'Markdown' });
      return;
    }

    await createTrigger({
      user_id: user.id,
      position_id: position.id,
      type: 'stop_loss',
      target_value: pct.toString(),
    });

    await ctx.reply(`✅ Stop loss set at -${pct}% for \`${tokenCA}\``, { parse_mode: 'Markdown' });
  });

  // ── /takeprofit <token_ca> <pct> — Set take profit ───────────────────────
  bot.command('takeprofit', async (ctx) => {
    const telegramId = ctx.from!.id;
    const user = await getUserByTelegramId(telegramId).catch(() => null);
    if (!user) { await ctx.reply('Use /start first.'); return; }

    const args = ctx.message!.text!.split(' ').slice(1);
    const tokenCA = args[0];
    const pct = parseFloat(args[1] ?? '');

    if (!tokenCA || isNaN(pct) || pct <= 0) {
      await ctx.reply('Usage: /takeprofit <token_ca> <percent>\nExample: /takeprofit mytoken.near 50 (takes profit at +50%)');
      return;
    }

    const positions = await getOpenPositions(user.id).catch(() => []);
    const position = positions.find(p => p.token_address === tokenCA);

    if (!position) {
      await ctx.reply(`No open position found for \`${tokenCA}\``, { parse_mode: 'Markdown' });
      return;
    }

    await createTrigger({
      user_id: user.id,
      position_id: position.id,
      type: 'take_profit',
      target_value: pct.toString(),
    });

    await ctx.reply(`✅ Take profit set at +${pct}% for \`${tokenCA}\``, { parse_mode: 'Markdown' });
  });
}