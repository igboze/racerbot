import { describe, it, expect, vi, afterEach } from 'vitest';

// Never reach a real database: dotenv does not override a variable that is already set
process.env.DATABASE_URL = 'postgres://giwa-test@127.0.0.1:1/none';

const TOKEN = '0xBCdB22f56642DE57624CfC2fBb9eE398cF3CA268';
const getErc20TokenInfo = vi.fn();
const cardInfo = {
  address: TOKEN, chain: 'giwa', name: 'TestToken', symbol: 'TEST', decimals: 18, total_supply: '0', price: '0',
  price_usd: '0', liquidity: '0', liquidity_usd: '0', market_cap: 0, market_cap_usd: 0, near_usd: 0,
  venue: 'giwa', tradeable: false, buy_tax_pct: 0, sell_tax_pct: 0,
};

vi.mock('@racerbot/shared', async (importActual) => ({
  ...(await importActual<typeof import('@racerbot/shared')>()),
  getErc20TokenInfo: (...args: any[]) => getErc20TokenInfo(...args),
  checkTokenSafety: vi.fn(async () => ({ isHoneypot: false, reasons: [], dangerousMethods: [] })),
}));
vi.mock('./wallet.js', async (importActual) => {
  const actual = await importActual<typeof import('./wallet.js')>();
  return {
    ...actual,
    getTokenInfo: vi.fn(async () => cardInfo),
    getUserBalances: vi.fn(async () => ({ evmAddress: '0x00000000000000000000000000000000000000A1', giwaBalanceFormatted: '0.0050' })),
    getUserByTelegramId: vi.fn(async () => ({ id: 'u1', telegram_id: 1, slippage_pct: 10 })),
  };
});
vi.mock('@racerbot/db', async (importActual) => ({
  ...(await importActual<typeof import('@racerbot/db')>()),
  getOpenPositions: vi.fn(async () => []),
}));

const shared = await import('@racerbot/shared');
const { lookupGiwaToken } = await import('./wallet.js');
const { buildDepositAssetPicker, isDepositAsset, buildDepositAssetScreen } = await import('./newUserUx.js');

afterEach(() => {
  vi.unstubAllEnvs();
  getErc20TokenInfo.mockReset();
});

const meta = { address: TOKEN, name: 'TestToken', symbol: 'TEST', decimals: 18, totalSupply: (10n ** 24n).toString(), chain: 'giwa' };
const pickerData = (kb: any): string[] => kb.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);

describe('GIWA chain config', () => {
  it('is GIWA Sepolia, pays gas in ETH, and has no router to trade through', () => {
    expect(shared.getEvmChainId('giwa')).toBe(91342);
    expect(shared.getEvmRpcUrl('giwa')).toBe('https://sepolia-rpc.giwa.io');
    expect(shared.getEvmNativeSymbol('giwa')).toBe('ETH');
    expect(shared.getDefaultWrappedNative('giwa')).toBe('0x4200000000000000000000000000000000000006');
    expect(shared.getDefaultRouter('giwa')).toBe('');
    expect(shared.getEvmExplorerUrl('giwa', TOKEN)).toBe(`https://sepolia-explorer.giwa.io/address/${TOKEN}`);
    expect(shared.isEvmChainName('giwa')).toBe(true);
  });

  it('moves to mainnet by configuration alone', () => {
    vi.stubEnv('GIWA_CHAIN_ID', '91341');
    vi.stubEnv('GIWA_RPC_URL', 'https://rpc.example-giwa-mainnet.io');
    expect(shared.getEvmChainId('giwa')).toBe(91341);
    expect(shared.getEvmRpcUrl('giwa')).toBe('https://rpc.example-giwa-mainnet.io');
  });

  it('is off unless GIWA_ENABLED=on', () => {
    expect(shared.isGiwaEnabled()).toBe(false);
    vi.stubEnv('GIWA_ENABLED', 'on');
    expect(shared.isGiwaEnabled()).toBe(true);
  });
});

describe('while GIWA is switched off', () => {
  it('looks nothing up and offers no GIWA deposit', async () => {
    getErc20TokenInfo.mockResolvedValue(meta);
    expect(await lookupGiwaToken(TOKEN)).toBeNull();
    expect(getErc20TokenInfo).not.toHaveBeenCalled();
    expect(pickerData(buildDepositAssetPicker().keyboard)).not.toContain('dep_have:giwa');
    expect(isDepositAsset('giwa')).toBe(false);
  });
});

describe('with GIWA switched on', () => {
  it('reads a GIWA token as a read-only card', async () => {
    vi.stubEnv('GIWA_ENABLED', 'on');
    getErc20TokenInfo.mockResolvedValue(meta);
    const info = await lookupGiwaToken(TOKEN);
    expect(getErc20TokenInfo).toHaveBeenCalledWith(TOKEN, 'giwa', false);
    expect(info).toMatchObject({ chain: 'giwa', venue: 'giwa', symbol: 'TEST', tradeable: false });
  });

  it('offers testnet ETH as a deposit, pointing to the faucet', () => {
    vi.stubEnv('GIWA_ENABLED', 'on');
    expect(pickerData(buildDepositAssetPicker().keyboard)).toContain('dep_have:giwa');
    expect(isDepositAsset('giwa')).toBe(true);
    const screen = buildDepositAssetScreen('giwa', { evm_address: '0x00000000000000000000000000000000000000A1' });
    expect(screen.text).toContain('GIWA Sepolia');
    expect(screen.text).toContain('faucet.giwa.io');
  });

});
