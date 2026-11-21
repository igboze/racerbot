import { describe, it, expect, vi, afterEach } from 'vitest';

// Never reach a real database from this test: dotenv does not override a variable that is already set
process.env.DATABASE_URL = 'postgres://giwa-card-test@127.0.0.1:1/none';

const TOKEN = '0xBCdB22f56642DE57624CfC2fBb9eE398cF3CA268';
const cardInfo = {
  address: TOKEN, chain: 'giwa', name: 'TestToken', symbol: 'TEST', decimals: 18, total_supply: '0', price: '0',
  price_usd: '0', liquidity: '0', liquidity_usd: '0', market_cap: 0, market_cap_usd: 0, near_usd: 0,
  venue: 'giwa', launchpad: 'GIWA testnet', tradeable: false, buy_tax_pct: 0, sell_tax_pct: 0,
};

vi.mock('./wallet.js', async (importActual) => ({
  ...(await importActual<typeof import('./wallet.js')>()),
  getTokenInfo: vi.fn(async () => cardInfo),
  getUserBalances: vi.fn(async () => ({ evmAddress: '0x00000000000000000000000000000000000000A1', giwaBalanceFormatted: '0.0050' })),
  getUserByTelegramId: vi.fn(async () => ({ id: 'u1', telegram_id: 1, slippage_pct: 10 })),
}));
vi.mock('@racerbot/shared', async (importActual) => ({
  ...(await importActual<typeof import('@racerbot/shared')>()),
  checkTokenSafety: vi.fn(async () => ({ isHoneypot: false, reasons: [], dangerousMethods: [] })),
}));
vi.mock('@racerbot/db', async (importActual) => ({
  ...(await importActual<typeof import('@racerbot/db')>()),
  getOpenPositions: vi.fn(async () => []),
}));

const { buildTokenCard } = await import('./routes.js');

afterEach(() => vi.unstubAllEnvs());

describe('GIWA token card', () => {
  it('shows the card read-only, with no way to buy', async () => {
    vi.stubEnv('GIWA_ENABLED', 'on');
    const { text, keyboard } = await buildTokenCard(TOKEN, 1);
    expect(text).toContain('GIWA (testnet, read-only)');
    expect(text).toContain('RacerBot shows GIWA tokens read-only until GIWA mainnet launches');
    const buttons: string[] = keyboard.reply_markup.inline_keyboard.flat().map((b: any) => b.text);
    expect(buttons.join(' | ')).not.toMatch(/Buy|HypurrScan|DexScreener/);
    expect(buttons).toContain('🔍 GIWA Explorer');
  });
});
