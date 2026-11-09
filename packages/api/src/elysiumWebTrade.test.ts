import { describe, it, expect, vi, beforeEach } from 'vitest';

const COIN = '0x5e5Df82d563FCF36b6f853c4D09f89e2d18825B4';
const tokenInfo = vi.fn();
const publishSwap = vi.fn();
const sellAtTarget = vi.fn();
const getOpenPositions = vi.fn();

vi.mock('./wallet.js', () => ({
  getTokenInfo: (...a: unknown[]) => tokenInfo(...a),
  publishSwap: (...a: unknown[]) => publishSwap(...a),
  ensureUserEvmWallet: async (u: any) => ({ ...u, evm_address: '0x00000000000000000000000000000000000000A1' }),
}));
vi.mock('./sellHelper.js', () => ({ sellAtTarget: (...a: unknown[]) => sellAtTarget(...a) }));
vi.mock('@racerbot/db', () => ({ getOpenPositions: (...a: unknown[]) => getOpenPositions(...a) }));

const { executeWebElysiumTrade, isElysiumTradeVenue } = await import('./elysiumWebTrade.js');
const user = { id: 'u1', slippage_pct: '3' } as any;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.KLEOS_TRADING;
  tokenInfo.mockResolvedValue({ chain: 'elysium', venue: 'kleos', symbol: 'AGORA' });
});

describe('Racer Alpha web trades of Elysium coins', () => {
  it('only takes Kleos and RonsPad coins on Elysium; everything else stays on the NEAR path', async () => {
    expect(isElysiumTradeVenue({ chain: 'elysium', venue: 'ronspad' })).toBe(true);
    expect(isElysiumTradeVenue({ chain: 'hyperevm', venue: 'kleos' })).toBe(false);
    expect(await executeWebElysiumTrade(user, 'token.near', { side: 'BUY', amountHype: 1 })).toBeNull();
    tokenInfo.mockResolvedValue({ chain: 'hyperevm', venue: 'hyperevm_dex' });
    expect(await executeWebElysiumTrade(user, COIN, { side: 'BUY', amountHype: 1 })).toBeNull();
    expect(publishSwap).not.toHaveBeenCalled();
  });

  it('buys with HYPE on the Elysium executor and links the Elysium transaction', async () => {
    publishSwap.mockResolvedValue({ success: true, txHash: '0xabc', tokenQty: '980', tokenSymbol: 'AGORA' });
    const res = await executeWebElysiumTrade(user, COIN, { side: 'buy', amountHype: '0.01' });
    expect(res?.status).toBe(200);
    expect(res?.body).toMatchObject({ success: true, chain: 'elysium', txHash: '0xabc', tokenQty: '980', hypeSpent: 0.01 });
    expect(res?.body.explorerUrl).toBe('https://www.thekleos.xyz/scan/tx/0xabc');
    expect(publishSwap).toHaveBeenCalledWith(
      expect.objectContaining({ chain: 'elysium', token_in: 'HYPE', token_out: COIN, amount_in: '0.01', venue: 'kleos', slippage_pct: 3 }),
      undefined, { suppressAlphaSignal: true },
    );
  });

  it('asks for a HYPE amount instead of guessing from a NEAR one', async () => {
    const res = await executeWebElysiumTrade(user, COIN, { side: 'BUY' });
    expect(res).toMatchObject({ status: 400, body: { error: expect.stringMatching(/bought with HYPE/) } });
    expect(publishSwap).not.toHaveBeenCalled();
  });

  it('passes the executor’s plain-language reason back to the page', async () => {
    publishSwap.mockResolvedValue({ success: false, reason: 'Not enough HYPE. Nothing was spent.' });
    const res = await executeWebElysiumTrade(user, COIN, { side: 'BUY', amountHype: 5 });
    expect(res).toMatchObject({ status: 400, body: { success: false, error: 'Not enough HYPE. Nothing was spent.' } });
  });

  it('sells a share of the RacerBot Elysium position', async () => {
    getOpenPositions.mockResolvedValue([{ id: 'p1', chain: 'elysium', token_address: COIN.toLowerCase() }]);
    sellAtTarget.mockResolvedValue({ success: true });
    const res = await executeWebElysiumTrade(user, COIN, { side: 'SELL', sellPercent: 50 });
    expect(res).toMatchObject({ status: 200, body: { success: true, sellPercent: 50 } });
    expect(sellAtTarget).toHaveBeenCalledWith('u1', 'p1', 50, undefined, { suppressAlphaSignal: true, slippagePct: 3 });
  });

  it('says so when there is nothing to sell, and refuses when Kleos trading is switched off', async () => {
    getOpenPositions.mockResolvedValue([]);
    expect((await executeWebElysiumTrade(user, COIN, { side: 'SELL' }))?.body.error).toMatch(/no AGORA position/);
    process.env.KLEOS_TRADING = 'off';
    expect(await executeWebElysiumTrade(user, COIN, { side: 'BUY', amountHype: 1 })).toMatchObject({ status: 503 });
  });
});
