import { Telegraf, Context } from 'telegraf';
import { onBoarding, getTokenInfo, getOpenPositions, executeSwap, autoBuySwap } from './wallet.js';
import { getDb } from './db.js';

export function setupRoutes(bot: Telegraf) {
  bot.command('start', async (ctx) => {
    const telegramId = ctx.from!.id;
    const user = await (await import('./db.js')).getUserByTelegramId(telegramId);

    if (!user) {
      await ctx.reply('Welcome to RacerBot! Use the Mini App to generate your wallet and get started.');
      return;
    }

    await ctx.reply(`Welcome back! Your subaccount: ${user.subaccount_id}\nUse /info <token_address> for token info, /buy to trade.`);
  });

  bot.command('info', async (ctx) => {
    const args = ctx.message!.text!.split(' ').slice(1);
    if (!args[0]) {
      await ctx.reply('Usage: /info <token_address>');
      return;
    }

    try {
      const info = await getTokenInfo(args[0]);
      await ctx.reply(
        `Name: ${info.name}\nSymbol: ${info.symbol}\nPrice: ${info.price}\nLiquidity: ${info.liquidity}\nMarket Cap: ${info.marketCap}\nSupply: ${info.supply}`
      );
    } catch (err) {
      await ctx.reply('Could not fetch token info.');
    }
  });

  bot.command('buy', async (ctx) => {
    const telegramId = ctx.from!.id;
    const user = await (await import('./db.js')).getUserByTelegramId(telegramId);
    if (!user) {
      await ctx.reply('Please onboard via the Mini App first.');
      return;
    }
    // Open Quick-Buy UI with percentage buttons
    await ctx.reply('Quick Buy - select percentage of balance:');
  });

  bot.command('sell', async (ctx) => {
    const telegramId = ctx.from!.id;
    const positions = await (await import('./db.js')).getOpenPositions(telegramId.toString());
    if (positions.length === 0) {
      await ctx.reply('No open positions.');
      return;
    }
    // Open Quick-Sell UI
    await ctx.reply('Quick Sell positions:');
  });

  bot.command('snipe', async (ctx) => {
    const args = ctx.message!.text!.split(' ').slice(1);
    if (!args[0]) {
      await ctx.reply('Usage: /snipe <token_address_or_name>');
      return;
    }

    // Check if it's a CA or name
    if (args[0].length === 64 && /^0x/.test(args[0])) {
      await executeSnipe(ctx.from!.id, args[0], 'ca');
    } else {
      await executeSnipe(ctx.from!.id, args[0], 'name');
    }
  });

  bot.command('pnl', async (ctx) => {
    const telegramId = ctx.from!.id;
    const user = await (await import('./db.js')).getUserByTelegramId(telegramId);
    if (!user) return;

    const fills = await (await import('./db.js')).getFillsByPosition('');
    await ctx.reply('PNL Summary - see Mini App for detailed PNL card.');
  });

  bot.command('filters', async (ctx) => {
    await ctx.reply('Set filters: /filters min_liquidity <n> max_holder <n>');
  });
}

async function executeSnipe(telegramId: number, query: string, mode: 'ca' | 'name') {
  if (mode === 'ca') {
    await (await import('./wallet.js')).executeSwap({
      user_id: telegramId.toString(),
      token_in: 'near',
      token_out: query,
      amount_in: '0',
      min_amount_out: '0',
      venue: 'rhea',
      timestamp: Date.now(),
    });
  } else {
    const tokenCache = await (await import('./db.js')).getTokenCache(query);
    if (!tokenCache) {
      await (await import('./webapp/index.js')).notifyUser(telegramId, 'token_not_found');
      return;
    }
    await (await import('./wallet.js')).executeSwap({
      user_id: telegramId.toString(),
      token_in: 'near',
      token_out: tokenCache.token_address,
      amount_in: '0',
      min_amount_out: '0',
      venue: 'rhea',
      timestamp: Date.now(),
    });
  }
}