import { describe, it, expect, vi, afterEach } from 'vitest';

// Never reach a real database from this test: dotenv does not override a variable that is already set
process.env.DATABASE_URL = 'postgres://kleos-card-test@127.0.0.1:1/none';

const KSOCKS = '0xd8C9bd555DEcc4Ae694E6C3e492Ef9DD96d2979d';
const kleosInfo = (tradeable: boolean) => ({
  address: KSOCKS, chain: 'elysium', name: 'kSocks', symbol: 'KSOCKS', decimals: 18,
  total_supply: (10n ** 27n).toString(), price: '1.275e-7', price_usd: '0.00001104',
  liquidity: '32.4', liquidity_usd: '2800', market_cap: 127.5, market_cap_usd: 11050, near_usd: 86.59,
  venue: 'kleos', launchpad: 'Kleos', tradeable, buy_tax_pct: 1, sell_tax_pct: 1,
});
let tokenInfo: any = kleosInfo(false);
let nearTradeCurrency = 'near';

vi.mock('./wallet.js', async (importActual) => ({
  ...(await importActual<typeof import('./wallet.js')>()),
  getTokenInfo: vi.fn(async () => tokenInfo),
  getUserBalances: vi.fn(async () => ({ evmAddress: '0x00000000000000000000000000000000000000A1', hyperevmBalanceFormatted: '0.0123', elysiumBalanceFormatted: '9.9999' })),
  getUserByTelegramId: vi.fn(async () => ({ id: 'u1', telegram_id: 1, slippage_pct: 15, near_trade_currency: nearTradeCurrency })),
}));
vi.mock('@racerbot/shared', async (importActual) => ({
  ...(await importActual<typeof import('@racerbot/shared')>()),
  // The NEAR safety audit "passes" any 0x address
  checkTokenSafety: vi.fn(async () => ({ isHoneypot: false, reasons: [], dangerousMethods: [] })),
  getHypeBalance: vi.fn(async (_a: string, _c: string, isTestnet: boolean) => ({ raw: 0n, formatted: isTestnet ? '9.9999' : '0.004712', human: 0 })),
}));
vi.mock('@racerbot/db', async (importActual) => ({
  ...(await importActual<typeof import('@racerbot/db')>()),
  getOpenPositions: vi.fn(async () => []),
}));

const { buildTokenCard, kleosSpendableHype } = await import('./routes.js');

afterEach(() => { tokenInfo = kleosInfo(false); nearTradeCurrency = 'near'; });

describe('Kleos token card', () => {
  it('says once that it cannot be traded yet, without NEAR wording or the testnet balance', async () => {
    const { text } = await buildTokenCard(KSOCKS, 1);
    expect(text).toContain('🪙 *kSocks* (`KSOCKS`) • 🏛️ Kleos (Elysium mainnet)');
    expect(text).not.toContain('Venue:');
    expect(text).not.toMatch(/NEP-141|NEAR|Security/);
    expect(text).toContain('_1 HYPE ≈ $86.59_');
    expect(text).toContain('💳 *HYPE*: HyperEVM `0.0123` • Elysium `0.0047`');
    expect(text).not.toContain('9.9999');
    expect(text).toContain('Tax   : 1.0%/1.0%');
    expect(text.match(/can.t trade Kleos/g)).toHaveLength(1);
  });

  it('shows buy buttons and the settlement note once trading is on', async () => {
    tokenInfo = kleosInfo(true);
    const { text, keyboard } = await buildTokenCard(KSOCKS, 1);
    expect(text).toContain('Trades settle on Elysium in about 1–5 min');
    expect(text).not.toMatch(/can.t trade Kleos/);
    const buttons = keyboard.reply_markup.inline_keyboard.flat().map((b: any) => b.text);
    expect(buttons.some((t: string) => /Buy/.test(t))).toBe(true);
  });
});

describe('Kleos buy keyboard', () => {
  it('shows only HYPE buying: no NEAR/USDC mode, RaceFleet, DCA or limit orders, even for a USDC-mode user', async () => {
    tokenInfo = kleosInfo(true);
    nearTradeCurrency = 'usdc';
    const { text, keyboard } = await buildTokenCard(KSOCKS, 1);
    const buttons: string[] = keyboard.reply_markup.inline_keyboard.flat().map((b: any) => b.text);
    expect(buttons.join(' | ')).not.toMatch(/NEAR|USDC|Fleet|DCA|Limit/);
    expect(buttons.some(b => /HYPE/.test(b))).toBe(true);
    expect(text).toContain('⚡ *Buy with HYPE*: a fixed amount, or a % of your HYPE:');
    expect(text).not.toMatch(/NEAR|USDC|Fleet/);
  });
});

describe('% buys of a Kleos coin', () => {
  it('spend HyperEVM HYPE after the ticket reserve, or Elysium HYPE when there is more there', () => {
    expect(kleosSpendableHype(1.003, 0)).toBeCloseTo(1, 9);
    // Proceeds from earlier sells on Elysium; posting the order still needs a little HyperEVM HYPE
    expect(kleosSpendableHype(0.001, 0.5004)).toBeCloseTo(0.5, 9);
    expect(kleosSpendableHype(0.0001, 0.5)).toBe(0);
    expect(kleosSpendableHype(0, 0)).toBe(0);
  });
});
