import { describe, it, expect, vi, beforeEach } from 'vitest';

// Never reach a real database: dotenv does not override a variable that is already set
process.env.DATABASE_URL = 'postgres://new-user-ux-test@127.0.0.1:1/none';

const USER = {
  id: 'u1', telegram_id: 7, subaccount_id: 'newbie.racerbot.near', solana_address: 'SoLAddr1111',
  evm_address: '0x00000000000000000000000000000000000000A1', sui_address: null, starknet_address: '0xstark',
};
let balances: any = {};
let pointsEnd = new Date('2026-10-15T23:59:59Z');

vi.mock('@racerbot/db', async (importActual) => ({
  ...(await importActual<typeof import('@racerbot/db')>()),
  getUserByTelegramId: vi.fn(async () => USER),
  getPointsSummary: vi.fn(async () => ({
    effectivePoints: 12345, basePoints: 12345, earlyBird: false, rank: 42, totalUsers: 900,
    seasonEnd: pointsEnd, breakdown: { trade: 12345 },
  })),
  getPointsLeaderboard: vi.fn(async () => []),
}));
vi.mock('./wallet.js', async (importActual) => ({
  ...(await importActual<typeof import('./wallet.js')>()),
  ensureUserAllWallets: vi.fn(async (u: any) => u),
  getUserBalances: vi.fn(async () => balances),
}));

const {
  buildDepositAssetPicker, buildDepositAssetScreen, buildHelpPage, HELP_PAGES, isDepositAsset,
  isInsufficientFundsMessage, trendingRows, buyTokenPromptText, TRENDING_MIN_LIQUIDITY_USD,
} = await import('./newUserUx.js');
const { buildMainMenu, buildPointsView } = await import('./routes.js');

const buttons = (keyboard: any): { text: string; data?: string }[] =>
  keyboard.reply_markup.inline_keyboard.flat().map((b: any) => ({ text: b.text, data: b.callback_data }));

beforeEach(() => {
  balances = { totalNearFormatted: '0', usdcNearFormatted: '0', solBalanceFormatted: '0', hyperevmBalanceFormatted: '0' };
  pointsEnd = new Date('2026-10-15T23:59:59Z');
});

describe('home screen', () => {
  it('welcomes a new user in three plain steps with a short menu', async () => {
    const menu = await buildMainMenu(7, true, true);
    expect(menu.text).toContain('Welcome to RacerBot!');
    expect(menu.text).toContain('Start in 3 steps');
    expect(menu.text).not.toMatch(/HyperEVM|Starknet|bps|Intents/);
    const b = buttons(menu.keyboard);
    expect(b[0]).toEqual({ text: '📥 Fund my wallet', data: 'menu_multichain_deposit' });
    expect(b.map(x => x.data)).toEqual(expect.arrayContaining(['menu_buy_prompt', 'help:0', 'menu_full']));
    expect(b.map(x => x.text).join(' ')).not.toMatch(/Withdraw|PnL|Points|Pro Tools/);
  });

  it('keeps every feature one tap away with All features', async () => {
    const menu = await buildMainMenu(7, true, false, true);
    expect(buttons(menu.keyboard).map(x => x.data)).toEqual(expect.arrayContaining(['wallet_withdraw_prompt', 'menu_pro_tools', 'menu_points']));
  });

  it('shows the full menu once the wallet is funded', async () => {
    balances = { ...balances, totalNearFormatted: '12.5', nearUsd: 4 };
    const menu = await buildMainMenu(7, true);
    expect(menu.text).toContain('NEAR: <b>12.5</b>');
    expect(buttons(menu.keyboard).map(x => x.data)).toContain('menu_pro_tools');
  });
});

describe('How it works', () => {
  it('pages through funding, buying, selling and safety, and ends at Fund my wallet', () => {
    expect(HELP_PAGES.map(p => p.title)).toEqual(['📥 Funding your wallet', '🛒 Buying a token', '🎒 Selling and your bags', '🛡️ Fees and safety']);
    const first = buildHelpPage(0);
    expect(buttons(first.keyboard).map(x => x.data)).toEqual(['help:1', 'menu_home']);
    const last = buildHelpPage(99);
    expect(last.text).toContain('Fees and safety');
    expect(last.text).toContain('1.5%');
    expect(buttons(last.keyboard).map(x => x.data)).toEqual(['help:2', 'menu_multichain_deposit', 'menu_home']);
  });
});

describe('deposit', () => {
  it('asks which coin first, with swap-in second', () => {
    const picker = buildDepositAssetPicker();
    expect(picker.text).toContain('Which coin do you want to send?');
    expect(picker.text).not.toMatch(/bps|Intents|Dual-Unwrap/);
    const data = buttons(picker.keyboard).map(x => x.data);
    // No ZRO while Zero is switched off (its mainnet launches 2026-11-30)
    expect(data.slice(0, 6)).toEqual(['dep_have:near', 'dep_have:sol', 'dep_have:eth', 'dep_have:hype', 'dep_have:sui', 'dep_have:strk']);
    expect(data).not.toContain('dep_have:zro');
    expect(isDepositAsset('zro')).toBe(false);
    expect(data).toContain('dep_swap_menu');
    expect(isDepositAsset('eth')).toBe(true);
    expect(isDepositAsset('__proto__')).toBe(false);
  });

  it('shows one address with the network to use', () => {
    const eth = buildDepositAssetScreen('eth', USER);
    expect(eth.text).toContain(`<code>${USER.evm_address}</code>`);
    expect(eth.text).toContain('Base, Arbitrum or Ethereum');
    expect(eth.text).toContain('Only send ETH on Base, Arbitrum or Ethereum');
    const near = buildDepositAssetScreen('near', USER);
    expect(near.text).toContain('newbie.racerbot.near');
    expect(near.text).toContain("You'll get a message here when it arrives.");
    const sui = buildDepositAssetScreen('sui', USER);
    expect(sui.text).toContain("isn't ready yet");
  });
});

describe('Buy Token', () => {
  it('offers liquid trending tokens to tap, two per row', () => {
    const rows = trendingRows([
      { address: 'a.near', symbol: 'AAA', change24h: 12.4, liquidityUsd: 50_000 },
      { address: 'thin.near', symbol: 'THIN', change24h: 900, liquidityUsd: TRENDING_MIN_LIQUIDITY_USD - 1 },
      { address: 'b.near', symbol: 'BBB', change24h: -3, liquidityUsd: 5_000 },
      { address: 'c.near', symbol: 'CCC', change24h: 0, liquidityUsd: 5_000 },
    ], a => `k_${a}`);
    expect(rows.map(r => r.map((b: any) => b.text))).toEqual([['🔥 AAA +12%', '🔥 BBB -3%'], ['🔥 CCC']]);
    expect(rows[0][0].callback_data).toBe('token_refresh:k_a.near');
    expect(buyTokenPromptText(true)).toContain('Trending on NEAR');
    expect(buyTokenPromptText(false)).not.toContain('Trending');
  });
});

describe('empty-wallet buy error', () => {
  it('recognises balance errors but not thin liquidity', () => {
    expect(isInsufficientFundsMessage('Insufficient HYPE balance for 0.5 HYPE purchase + network gas.')).toBe(true);
    expect(isInsufficientFundsMessage('Available balance (0.0010 NEAR after gas/storage reserve) is too low to buy.')).toBe(true);
    expect(isInsufficientFundsMessage('DEX pool has insufficient liquidity to complete your trade.')).toBe(false);
    expect(isInsufficientFundsMessage('The price moved past your slippage limit.')).toBe(false);
  });
});

describe('Points', () => {
  it('says Season 1 is over instead of listing ways to earn', async () => {
    const view = await buildPointsView(7);
    expect(view.text).toContain('Season 1 is over');
    expect(view.text).toContain('Oct 15');
    expect(view.text).toContain('12,345');
    expect(view.text).not.toContain('Earn Points');
  });

  it('still lists ways to earn while a season runs', async () => {
    pointsEnd = new Date(Date.now() + 5 * 86_400_000);
    const view = await buildPointsView(7);
    expect(view.text).toContain('Earn Points');
  });
});
