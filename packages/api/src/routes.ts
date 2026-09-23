import { Telegraf, Markup, Context } from 'telegraf';
import {
  getUserByTelegramId,
  getOpenPositions,
  getFillsByPosition,
  getTokenCache,
  createTrigger,
  updateUserDefaults,
} from '@racerbot/db';
import { getTokenInfo, onboardUser, publishSwap } from './wallet.js';
import { computePnL, fuzzyMatch } from '@racerbot/shared';
import { utils as nearUtils } from 'near-api-js';

// ── Token cache for snipe-by-name fuzzy matching ──────────────────────────────
// Populated by subscribing to detector events in index.ts
export const localTokenNames = new Map<string, { address: string; symbol: string }>();

export function setupRoutes(bot: Telegraf): void {

  // ── /start — onboarding ─────────────────────────────────────────────────────
  bot.command('start', async (ctx) => {
    const telegramId = ctx.from!.id;
    const existing = await getUserByTelegramId(telegramId).catch(() => null);

    if (existing) {
      await ctx.reply(
        `👋 Welcome back to RacerBot!\n\n` +
        `🔑 Account: \`${existing.subaccount_id}\`\n\n` +
        `Commands:\n` +
        `/buy — Quick buy\n` +
        `/sell — Quick sell open position\n` +
        `/positions — View open positions\n` +
        `/pnl — View PNL summary\n` +
        `/filters — Set auto-buy filters\n` +
        `/snipe <token_ca> — Snipe by contract address\n` +
        `/info <token_ca> — Token info`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // New user — generate wallet
    await ctx.reply('🚀 Setting up your RacerBot wallet...\n\nGenerating your secure keypair...');

    try {
      const result = await onboardUser(telegramId);

      // Send seed phrase ONCE — this is the only time it is ever shown
      await ctx.reply(
        `✅ *Wallet created!*\n\n` +
        `🔑 Your account: \`${result.subaccountId}\`\n\n` +
        `⚠️ *SAVE YOUR SEED PHRASE NOW — it will NOT be shown again:*\n\n` +
        `\`\`\`\n${result.seedPhrase}\n\`\`\`\n\n` +
        `This is your ONLY way to recover your funds. RacerBot cannot recover it for you.\n\n` +
        `Your trading key has been securely stored. You are ready to trade!`,
        { parse_mode: 'Markdown' }
      );
    } catch (err: any) {
      if (err.message === 'already_onboarded') {
        await ctx.reply('You already have a wallet. Use /start to see your account.');
      } else {
        await ctx.reply('❌ Failed to create wallet. Please try /start again.');
        console.error('[BOT] Onboard error:', err.message);
      }
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

      await ctx.reply(
        `🪙 *${info.name}* (${info.symbol})\n\n` +
        `📝 CA: \`${info.address}\`\n` +
        `💧 Venue: ${info.venue}\n` +
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

    // Determine venue from cache
    const cached = await getTokenCache(tokenAddress).catch(() => null);
    const venue = (cached?.venue as 'rhea' | 'shardsmarket') ?? 'shardsmarket';

    await publishSwap({
      user_id: user.id,
      token_in: 'wrap.near',
      token_out: tokenAddress,
      amount_in: nearUtils.format.parseNearAmount(amountNear.toString()) ?? '0',
      min_amount_out: '0',
      venue,
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
    const venue = (cached?.venue as 'rhea' | 'shardsmarket') ?? 'shardsmarket';

    await publishSwap({
      user_id: user.id,
      token_in: 'wrap.near',
      token_out: tokenAddress,
      amount_in: nearUtils.format.parseNearAmount(amountNear.toString()) ?? '0',
      min_amount_out: '0',
      venue,
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
      const venue = (cached?.venue as 'rhea' | 'shardsmarket') ?? 'shardsmarket';

      await ctx.reply(`⚡ Sniping \`${query}\` with ${amountNear} NEAR...`, { parse_mode: 'Markdown' });

      await publishSwap({
        user_id: user.id,
        token_in: 'wrap.near',
        token_out: query,
        amount_in: nearUtils.format.parseNearAmount(amountNear.toString()) ?? '0',
        min_amount_out: '0',
        venue,
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
    const venue = (cached?.venue as 'rhea' | 'shardsmarket') ?? 'shardsmarket';

    await publishSwap({
      user_id: user.id,
      token_in: 'wrap.near',
      token_out: tokenAddress,
      amount_in: nearUtils.format.parseNearAmount(amountNear.toString()) ?? '0',
      min_amount_out: '0',
      venue,
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
        `  Default Sell %: ${user.default_sell_pct ?? 100}%\n\n` +
        `Commands:\n` +
        `/filters auto_buy on|off — Enable/disable auto-buy\n` +
        `/filters amount <near> — Fixed NEAR amount per auto-buy\n` +
        `/filters min_liquidity <near> — Min pool liquidity (NEAR) to trigger auto-buy\n` +
        `/filters buy_pct <1-100> — Set default manual buy percentage\n` +
        `/filters sell_pct <1-100> — Set default manual sell percentage`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const [key, value] = args;

    if (key === 'buy_pct') {
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