/**
 * Screens a brand-new user meets first: the welcome and empty-wallet menu, How it works, the
 * "what do you have?" deposit picker, trending tokens on Buy Token and the empty-wallet buy error.
 * Plain words only: no chain IDs, bps or protocol names before the user has funded the wallet.
 */
import { Markup } from 'telegraf';
import { isZeroChainEnabled, isGiwaEnabled } from '@racerbot/shared';

type Style = 'success' | 'danger' | 'primary';
function btn(text: string, data: string, style?: Style): any {
  const b: any = { text, callback_data: data };
  if (style) b.style = style;
  return b;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const COMMUNITY_ROW = [
  Markup.button.url('💬 Chat', 'https://t.me/racerbot_community'),
  Markup.button.url('📢 Updates', 'https://t.me/racertrading'),
  Markup.button.url('𝕏 X', 'https://x.com/racertradingbot'),
];

// ── Welcome and the empty-wallet menu ────────────────────────────────────────

/** The home screen while nothing is funded: what RacerBot is for, in three steps. */
export function emptyWalletMenuText(isNewUser: boolean): string {
  const head = isNewUser
    ? `🏎 <b>Welcome to RacerBot!</b>\nYour trading wallet is ready.\n\n`
    : `🏎 <b>RacerBot</b>\n💰 Balance: <b>$0.00</b>\n\n`;
  return head +
    `<b>Start in 3 steps</b>\n` +
    `1️⃣ <b>Fund your wallet</b> with crypto you already have\n` +
    `2️⃣ <b>Find a token</b>: pick one from 🔥 Trending, or paste its address or link\n` +
    `3️⃣ <b>Buy</b>: tap an amount on the token card\n\n` +
    `❓ New to this? Tap <b>How it works</b>.`;
}

/** Fewer, clearer buttons until the wallet is funded; ☰ All features keeps everything reachable. */
export function emptyWalletMenuButtons(): any[][] {
  return [
    [btn('📥 Fund my wallet', 'menu_multichain_deposit', 'success')],
    [btn('🛒 Buy Token', 'menu_buy_prompt', 'primary'), btn('❓ How it works', 'help:0', 'primary')],
    [btn('💳 Wallet', 'menu_wallet', 'primary'), btn('⚙️ Settings', 'menu_settings', 'primary'), btn('🏁 Card', 'racer_card', 'primary')],
    [btn('☰ All features', 'menu_full', 'primary')],
    COMMUNITY_ROW,
  ];
}

// ── How it works (/help) ─────────────────────────────────────────────────────

export const HELP_PAGES: { title: string; body: string }[] = [
  {
    title: '📥 Funding your wallet',
    body:
      `RacerBot keeps a trading wallet for you, so trades go through instantly.\n\n` +
      `To fund it, tap <b>📥 Fund my wallet</b>, choose the coin you have, and send it to the address shown, ` +
      `<b>on the network shown</b>.\n\n` +
      `🏦 Sending from an exchange? When you withdraw there, pick that same network.\n` +
      `🔄 Your coin is on another chain? Use <b>Swap in</b> on the same screen (1% fee).`,
  },
  {
    title: '🛒 Buying a token',
    body:
      `Tap <b>🛒 Buy Token</b> and pick one from 🔥 Trending, or paste a token's address or a link ` +
      `from DexScreener, Pump.fun and similar sites.\n\n` +
      `The token card shows the price, liquidity and any taxes. Tap a fixed amount, or a % of your balance, to buy.\n\n` +
      `⚠️ Read any warnings on the card, such as low liquidity, before you buy.`,
  },
  {
    title: '🎒 Selling and your bags',
    body:
      `<b>🎒 Your Bags</b> lists what you hold, with your profit or loss.\n\n` +
      `Open a token and tap 25%, 50% or 100% to sell. The proceeds land back in your wallet in that chain's coin.\n\n` +
      `To take money out of RacerBot, use <b>💸 Withdraw</b>.`,
  },
  {
    title: '🛡️ Fees and safety',
    body:
      `RacerBot's fee is <b>1.5%</b> per trade (2% when selling on Elysium). Each chain also charges a small network fee, ` +
      `so keep a little of its coin for gas.\n\n` +
      `🔐 Never share your private key or the codes RacerBot sends you. RacerBot never DMs you first to ask for them.\n\n` +
      `📉 New tokens are risky. Only trade what you can afford to lose.`,
  },
];

export function buildHelpPage(index: number): { text: string; keyboard: ReturnType<typeof Markup.inlineKeyboard> } {
  const i = Math.max(0, Math.min(HELP_PAGES.length - 1, Math.floor(index) || 0));
  const page = HELP_PAGES[i];
  const dots = HELP_PAGES.map((_, n) => (n === i ? '●' : '○')).join(' ');
  const text = `❓ <b>How RacerBot works</b>  ${dots}\n\n<b>${page.title}</b>\n\n${page.body}`;
  const nav: any[] = [];
  if (i > 0) nav.push(btn('◀ Back', `help:${i - 1}`, 'primary'));
  if (i < HELP_PAGES.length - 1) nav.push(btn('Next ▶', `help:${i + 1}`, 'primary'));
  const rows: any[][] = [nav];
  if (i === HELP_PAGES.length - 1) rows.push([btn('📥 Fund my wallet', 'menu_multichain_deposit', 'success')]);
  rows.push([btn('🏠 Main Menu', 'menu_home', 'primary')]);
  return { text, keyboard: Markup.inlineKeyboard(rows) };
}

// ── Deposit: what do you have? ───────────────────────────────────────────────

export type DepositAsset = 'near' | 'sol' | 'eth' | 'hype' | 'sui' | 'strk' | 'zro' | 'giwa';

interface WalletAddresses {
  subaccount_id?: string | null;
  solana_address?: string | null;
  evm_address?: string | null;
  sui_address?: string | null;
  starknet_address?: string | null;
}

const DEPOSIT_ASSETS: Record<DepositAsset, {
  button: string;
  coin: string;
  network: string;
  address: (u: WalletAddresses) => string | null | undefined;
  /** Arrival is announced in the chat for these chains */
  notifies: boolean;
  note?: string;
}> = {
  near: { button: '⬛ NEAR or USDC', coin: 'NEAR or USDC', network: 'NEAR', address: u => u.subaccount_id, notifies: true },
  sol: { button: '🟣 SOL', coin: 'SOL', network: 'Solana', address: u => u.solana_address, notifies: true },
  eth: {
    button: '💎 ETH', coin: 'ETH', network: 'Base, Arbitrum or Ethereum', address: u => u.evm_address, notifies: false,
    note: 'Base, Arbitrum and Ethereum share this one address.',
  },
  hype: {
    button: '⚡ HYPE', coin: 'HYPE', network: 'HyperEVM', address: u => u.evm_address, notifies: false,
    note: 'HYPE on HyperEVM also pays for Kleos coins on Elysium.',
  },
  sui: { button: '🔷 SUI', coin: 'SUI', network: 'Sui', address: u => u.sui_address, notifies: true },
  strk: { button: '✨ STRK', coin: 'STRK or ETH', network: 'Starknet', address: u => u.starknet_address, notifies: true },
  zro: { button: '🅾️ ZRO', coin: 'ZRO', network: 'Zero', address: u => u.evm_address, notifies: false },
  // GIWA (Upbit's L2) is testnet-only so far: its ETH is free from the faucet and has no value
  giwa: {
    button: '🧱 GIWA testnet ETH', coin: 'testnet ETH', network: 'GIWA Sepolia', address: u => u.evm_address, notifies: false,
    note: 'GIWA is still in testnet: its ETH has no value. Get some free at faucet.giwa.io.',
  },
};

export function isDepositAsset(v: string): v is DepositAsset {
  if (v === 'zro' && !isZeroChainEnabled()) return false;
  if (v === 'giwa' && !isGiwaEnabled()) return false;
  return Object.prototype.hasOwnProperty.call(DEPOSIT_ASSETS, v);
}

/** First deposit screen: one question, then the one address that answers it. */
export function buildDepositAssetPicker(): { text: string; keyboard: ReturnType<typeof Markup.inlineKeyboard> } {
  const a = DEPOSIT_ASSETS;
  const text =
    `📥 <b>Fund your wallet</b>\n\n` +
    `<b>Which coin do you want to send?</b>\n` +
    `You'll get the address to send it to. RacerBot charges nothing to fund your wallet.`;
  const rows: any[][] = [
    [btn(a.near.button, 'dep_have:near', 'success'), btn(a.sol.button, 'dep_have:sol', 'success')],
    [btn(a.eth.button, 'dep_have:eth', 'success'), btn(a.hype.button, 'dep_have:hype', 'success')],
    [btn(a.sui.button, 'dep_have:sui', 'success'), btn(a.strk.button, 'dep_have:strk', 'success'), ...(isZeroChainEnabled() ? [btn(a.zro.button, 'dep_have:zro', 'success')] : [])],
    ...(isGiwaEnabled() ? [[btn(a.giwa.button, 'dep_have:giwa', 'primary')]] : []),
    [btn('🔄 Coin on another chain? Swap in (1% fee)', 'dep_swap_menu', 'primary')],
    [btn('🏠 Main Menu', 'menu_home', 'primary')],
  ];
  return { text, keyboard: Markup.inlineKeyboard(rows) };
}

/** The address for one coin, with the network to use and what happens next. */
export function buildDepositAssetScreen(asset: DepositAsset, user: WalletAddresses): { text: string; keyboard: ReturnType<typeof Markup.inlineKeyboard> } {
  const a = DEPOSIT_ASSETS[asset];
  const address = a.address(user);
  const back = [btn('◀ Other coins', 'menu_multichain_deposit', 'primary'), btn('🏠 Main Menu', 'menu_home', 'primary')];
  if (!address) {
    return {
      text: `📥 <b>Deposit ${a.coin}</b>\n\nYour ${a.network} wallet isn't ready yet. Send /start, then try again.`,
      keyboard: Markup.inlineKeyboard([back]),
    };
  }
  const text =
    `📥 <b>Deposit ${a.coin}</b>\n\n` +
    `Send it to this address on the <b>${a.network}</b> network:\n\n` +
    `<code>${escapeHtml(address)}</code>\n` +
    `<i>Tap the address to copy it.</i>\n\n` +
    (a.note ? `ℹ️ ${a.note}\n` : '') +
    `⚠️ Only send ${a.coin} on ${a.network}. Coins sent on another network can be lost.\n` +
    `🏦 From an exchange? Choose <b>${a.network}</b> as the withdrawal network.\n\n` +
    (a.notifies
      ? `You'll get a message here when it arrives.`
      : `Open 💳 Wallet to see it arrive.`);
  return { text, keyboard: Markup.inlineKeyboard([[btn('🛒 Then: Buy Token', 'menu_buy_prompt', 'success')], back]) };
}

// ── Buy Token: trending ──────────────────────────────────────────────────────

export interface TrendingToken {
  address: string;
  symbol: string;
  change24h: number;
  liquidityUsd: number;
}

/** Below this a pool is too thin to suggest to a newcomer. */
export const TRENDING_MIN_LIQUIDITY_USD = 1_000;

/** Up to six tappable tokens, two per row, each opening its token card. */
export function trendingRows(tokens: TrendingToken[], keyFor: (address: string) => string): any[][] {
  const picks = tokens
    .filter(t => t.address && t.symbol && t.liquidityUsd >= TRENDING_MIN_LIQUIDITY_USD)
    .slice(0, 6);
  const buttons = picks.map(t => {
    const ch = Number.isFinite(t.change24h) && t.change24h !== 0
      ? ` ${t.change24h > 0 ? '+' : ''}${t.change24h.toFixed(0)}%`
      : '';
    return btn(`🔥 ${t.symbol.slice(0, 12)}${ch}`, `token_refresh:${keyFor(t.address)}`, 'success');
  });
  const rows: any[][] = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  return rows;
}

export function buyTokenPromptText(hasTrending: boolean): string {
  return (
    `🛒 <b>Buy a token</b>\n\n` +
    (hasTrending ? `🔥 <b>Trending on NEAR</b>: tap one to open it.\n\n` : '') +
    `Or paste a token's <b>address or link</b> (DexScreener, Pump.fun and similar) into this chat.\n\n` +
    `<i>Works for tokens on NEAR, Solana, Base, Arbitrum, Ethereum, HyperEVM, Elysium, Sui and Starknet.</i>`
  );
}

// ── Empty-wallet buy error ───────────────────────────────────────────────────

/** True for the errors a newcomer gets when their wallet can't cover the buy. */
export function isInsufficientFundsMessage(message: string): boolean {
  const m = message.toLowerCase();
  if (m.includes('liquidity')) return false;
  return m.includes('insufficient')
    || (m.includes('balance') && m.includes('too low'))
    || m.includes('not enough balance')
    || m.includes('does not have enough')
    || m.includes("doesn't have enough");
}

export function fundWalletKeyboard(): ReturnType<typeof Markup.inlineKeyboard> {
  return Markup.inlineKeyboard([
    [btn('📥 Fund my wallet', 'menu_multichain_deposit', 'success'), btn('🏠 Main Menu', 'menu_home', 'primary')],
  ]);
}
