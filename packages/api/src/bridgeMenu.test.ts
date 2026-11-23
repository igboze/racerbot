import { describe, it, expect, vi, afterEach } from 'vitest';

// Never reach a real database: dotenv does not override a variable that is already set
process.env.DATABASE_URL = 'postgres://bridge-menu-test@127.0.0.1:1/none';

const ADDRESS = '0x00000000000000000000000000000000000000A1';
const quoteStargateSend = vi.fn();

vi.mock('@racerbot/shared', async (importActual) => ({
  ...(await importActual<typeof import('@racerbot/shared')>()),
  quoteStargateSend: (...args: any[]) => quoteStargateSend(...args),
}));
vi.mock('@racerbot/db', async (importActual) => ({
  ...(await importActual<typeof import('@racerbot/db')>()),
  getUserByTelegramId: vi.fn(async () => ({ id: 'u1', telegram_id: 1, evm_address: ADDRESS })),
}));
vi.mock('./wallet.js', async (importActual) => ({
  ...(await importActual<typeof import('./wallet.js')>()),
  ensureUserEvmWallet: vi.fn(async (u: any) => u),
}));
vi.mock('./layerZeroBridge.js', async (importActual) => ({
  ...(await importActual<typeof import('./layerZeroBridge.js')>()),
  scanCrossChainEvmBalances: vi.fn(async () => ({ evmAddress: ADDRESS, balances: {}, totalPortfolioUsd: 0 })),
}));

const { buildBridgeMenu } = await import('./layerZeroRoutes.js');

const buttons = (menu: any): { text: string; data: string }[] =>
  menu.keyboard.reply_markup.inline_keyboard.flat().map((b: any) => ({ text: b.text, data: b.callback_data }));
const goodQuote = { humanNativeFee: '0.000745', amountReceivedLD: 24_870_000n, approxDurationSec: 45, platformFeeLD: 125_000n, platformFeeBps: 50 };

afterEach(() => {
  vi.unstubAllEnvs();
  quoteStargateSend.mockReset();
});

describe('bridge menu', () => {
  it('opens on Base -> Arbitrum, with no Zero routes while Zero is off', async () => {
    quoteStargateSend.mockResolvedValue(goodQuote);
    const menu = await buildBridgeMenu(1);
    const data = buttons(menu).map((b) => b.data);
    expect(data).toContain('lz_confirm:base:arbitrum:USDC:25.0');
    expect(data.some((d) => d.includes('zero'))).toBe(false);
    expect(menu.text).toContain('RacerBot fee (0.5%): <b>0.13 USDC</b>');
    expect(menu.text).toContain('You receive: <b>~24.87 USDC</b>');
  });

  it('falls back from a Zero route someone still has in an old message', async () => {
    quoteStargateSend.mockResolvedValue(goodQuote);
    const menu = await buildBridgeMenu(1, { sourceChain: 'base', destChain: 'zero', asset: 'USDC', amount: '25.0' });
    expect(buttons(menu).map((b) => b.data)).toContain('lz_confirm:base:arbitrum:USDC:25.0');
  });

  it('offers ETH amounts in ETH, never "$10" that would send 10 ETH', async () => {
    quoteStargateSend.mockResolvedValue({ ...goodQuote, amountReceivedLD: 9_940_000_000_000_000n, platformFeeLD: 50_000_000_000_000n });
    const menu = await buildBridgeMenu(1, { sourceChain: 'base', destChain: 'arbitrum', asset: 'ETH', amount: '10.0' });
    const amountButtons = buttons(menu).filter((b) => b.data.startsWith('lz_amt:'));
    expect(amountButtons.map((b) => b.text)).toEqual(['0.005 ETH', '✅ 0.01 ETH', '0.025 ETH', '0.05 ETH']);
    expect(buttons(menu).map((b) => b.data)).toContain('lz_confirm:base:arbitrum:ETH:0.01');
    expect(quoteStargateSend).toHaveBeenCalledWith(expect.objectContaining({ asset: 'ETH', humanAmount: '0.01' }));
  });

  it('shows no Bridge button when Stargate cannot quote the route', async () => {
    quoteStargateSend.mockRejectedValue(new Error('Stargate has no USDT pool on Base. Pick another asset or chain.'));
    const menu = await buildBridgeMenu(1, { sourceChain: 'base', destChain: 'arbitrum', asset: 'USDT', amount: '25.0' });
    expect(buttons(menu).some((b) => b.data.startsWith('lz_confirm:'))).toBe(false);
    expect(menu.text).toContain('Stargate has no USDT pool on Base');
  });

  it('offers Zero routes once ZERO_CHAIN_ENABLED=on', async () => {
    vi.stubEnv('ZERO_CHAIN_ENABLED', 'on');
    quoteStargateSend.mockResolvedValue(goodQuote);
    const menu = await buildBridgeMenu(1);
    expect(buttons(menu).map((b) => b.data)).toContain('lz_route:base:zero:USDC:25.0');
  });

  it('bridges ZRO between any two chains, with ZRO amounts', async () => {
    quoteStargateSend.mockResolvedValue({ humanNativeFee: '0.000149', amountReceivedLD: 995n * 10n ** 16n, approxDurationSec: 45, platformFeeLD: 5n * 10n ** 16n, platformFeeBps: 50 });
    const menu = await buildBridgeMenu(1, { sourceChain: 'arbitrum', destChain: 'bsc', asset: 'ZRO', amount: '10.0' });
    const all = buttons(menu);
    expect(all.find((b) => b.data === 'lz_asset:arbitrum:bsc:ZRO')?.text).toContain('✅');
    expect(all.filter((b) => b.data.startsWith('lz_amt:')).map((b) => b.text)).toEqual(['5 ZRO', '✅ 10 ZRO', '25 ZRO', '50 ZRO']);
    expect(all.map((b) => b.data)).toContain('lz_confirm:arbitrum:bsc:ZRO:10.0');
    expect(menu.text).toContain('RacerBot fee (0.5%): <b>0.0500 ZRO</b>');
    expect(menu.text).toContain('You receive: <b>~9.9500 ZRO</b>');
  });

  it('moves a route the asset cannot take to one it can (USDT is not on Base)', async () => {
    quoteStargateSend.mockResolvedValue(goodQuote);
    const menu = await buildBridgeMenu(1, { sourceChain: 'base', destChain: 'arbitrum', asset: 'USDT', amount: '25.0' });
    const confirm = buttons(menu).find((b) => b.data.startsWith('lz_confirm:'))!.data;
    expect(confirm).not.toContain(':base:');
    expect(confirm).toMatch(/:USDT:25\.0$/);
  });
});
