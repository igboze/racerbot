import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── In-memory stand-in for the few tables a key purchase touches ──────────────
const TRADER = {
  id: 'trader_1', user_id: 'creator.near', handle: 'caller', display_name: 'Caller', is_active: true,
  tier_basic_price_near: '1.5', tier_copy_price_near: '3.5', tier_premium_price_near: '8.0', key_price_near: '3.5',
  copy_fee_pct: '10', payout_wallet_address: 'creator.near', keys_sold: 0, keys_reserved: 0, max_keys: 100,
  equity_curve: [], total_revenue_near: 0,
};
let keys: Map<string, any>;
let creatorPayments: string[];
let traderRow: any;

function fakeQuery(sql: string, params: any[] = []): { rows: any[] } {
  const q = sql.replace(/\s+/g, ' ').trim();
  if (/^(BEGIN|COMMIT|ROLLBACK)/.test(q)) return { rows: [] };
  if (q.startsWith('SELECT * FROM racer_alpha_traders')) return { rows: [traderRow] };
  if (q.startsWith('SELECT id, key_token, payment_status')) {
    return { rows: [...keys.values()].filter(k => k.trader_id === params[0] && k.buyer_user_id === params[1]) };
  }
  if (q.startsWith('UPDATE racer_alpha_traders SET keys_reserved = keys_reserved + 1')) {
    traderRow.keys_reserved++;
    return { rows: [{ id: traderRow.id }] };
  }
  if (q.startsWith('INSERT INTO racer_alpha_keys')) {
    keys.set(params[0], { id: params[0], trader_id: params[1], buyer_user_id: params[2], price_paid_near: params[4], tier: params[5], key_token: params[6], payment_status: 'pending', copy_fee_pct: params[13], risk_multiplier: params[10] });
    return { rows: [] };
  }
  if (q.startsWith('UPDATE racer_alpha_keys SET treasury_tx_hash = $1, payment_status = \'treasury_paid\'')) {
    const [hash, id] = params;
    const key = keys.get(id);
    const reused = [...keys.values()].some(k => k.treasury_tx_hash === hash && k.id !== id) || creatorPayments.includes(hash);
    if (!key || key.payment_status !== 'pending' || reused) return { rows: [] };
    key.treasury_tx_hash = hash;
    key.payment_status = 'treasury_paid';
    return { rows: [{ id }] };
  }
  if (q.startsWith('UPDATE racer_alpha_keys SET creator_tx_hash')) {
    Object.assign(keys.get(params[3]), { creator_tx_hash: params[0], creator_payout_status: params[1] });
    return { rows: [] };
  }
  if (q.startsWith('SELECT payment_status FROM racer_alpha_keys')) return { rows: [{ payment_status: keys.get(params[0])?.payment_status }] };
  if (q.startsWith('UPDATE racer_alpha_keys SET payment_status = \'completed\'')) {
    keys.get(params[0]).payment_status = 'completed';
    return { rows: [] };
  }
  if (q.startsWith('UPDATE racer_alpha_traders SET keys_reserved = GREATEST(keys_reserved - 1, 0), keys_sold')) {
    traderRow.keys_reserved--;
    traderRow.keys_sold++;
    traderRow.total_revenue_near += Number(params[0]);
    return { rows: [] };
  }
  if (q.startsWith('UPDATE racer_alpha_keys SET payment_status = $1')) {
    keys.get(params[3]).payment_status = params[0];
    return { rows: [] };
  }
  if (q.startsWith('UPDATE racer_alpha_traders SET keys_reserved = GREATEST(keys_reserved - 1, 0), updated_at')) {
    traderRow.keys_reserved--;
    return { rows: [] };
  }
  if (q.startsWith('SELECT tier FROM racer_alpha_keys')) {
    return { rows: [...keys.values()].filter(k => k.buyer_user_id === params[0] && k.payment_status === 'completed') };
  }
  if (q.startsWith('UPDATE racer_alpha_keys SET allocation_pct')) {
    const key = [...keys.values()].find(k => k.buyer_user_id === params[5] && k.payment_status === 'completed');
    if (!key) return { rows: [] };
    if (params[1] !== null) key.risk_multiplier = params[1];
    if (params[3] !== null) key.auto_copy_enabled = params[3];
    return { rows: [{ trader_id: key.trader_id, auto_copy_enabled: key.auto_copy_enabled, auto_copy_amount_near: 1 }] };
  }
  return { rows: [] };
}
const db = {
  query: vi.fn(async (sql: string, params?: any[]) => fakeQuery(sql, params)),
  connect: async () => ({ query: async (sql: string, params?: any[]) => fakeQuery(sql, params), release: () => {} }),
};
const createCopyTradeTarget = vi.fn();
vi.mock('@racerbot/db', async (orig) => ({
  ...(await orig<any>()),
  getDb: async () => db,
  getUserById: async () => null,
  createCopyTradeTarget,
}));
vi.mock('./notify.js', () => ({ getBotInstance: () => null }));

const { buyViewingKey, setAlphaPaymentDepsForTests, updateKeyCopySettings, keyPriceProblem } = await import('./racerAlpha.js');
const { verifyNearPayment, transferredYocto } = await import('./nearPayments.js');

const HASH = '6Xq1vV8hJm5bH9u7p2s3k4L5n6M7o8P9q1R2s3T4u5V';
const NEAR = 10n ** 24n;
const buyer = { id: 'buyer-1', subaccount_id: 'buyer.racerbot.near' };
const payment = (o: { signer?: string; receiver?: string; yocto?: bigint; failed?: boolean } = {}) => ({
  transaction: {
    signer_id: o.signer ?? 'buyer.near',
    receiver_id: o.receiver ?? 'racerbottreasury.near',
    actions: [{ Transfer: { deposit: String(o.yocto ?? (35n * NEAR) / 10n) } }],
  },
  status: o.failed ? { Failure: {} } : { SuccessValue: '' },
});

describe('checking a NEAR payment on-chain', () => {
  const check = (outcome: any, over: Partial<{ txHash: string; minYocto: bigint }> = {}) => verifyNearPayment(
    { txHash: over.txHash ?? HASH, signerIds: ['buyer.near'], receiverId: 'racerbottreasury.near', minYocto: over.minYocto ?? (35n * NEAR) / 10n },
    async () => outcome,
  );
  it('accepts a real, big enough, successful payment to the treasury from the buyer', async () => {
    expect(await check(payment())).toEqual({ ok: true, signerId: 'buyer.near', paidYocto: (35n * NEAR) / 10n });
  });
  it('refuses made-up hashes, other receivers, small amounts, failures and other signers', async () => {
    expect((await check(payment(), { txHash: 'anything' })).ok).toBe(false);
    expect((await check(payment({ receiver: 'someone.near' }))).ok).toBe(false);
    expect((await check(payment({ yocto: NEAR }))).ok).toBe(false);
    expect((await check(payment({ failed: true }))).ok).toBe(false);
    expect((await check(payment({ signer: 'stranger.near' }))).ok).toBe(false);
    expect((await check(null)).ok).toBe(false);
  });
  it('adds up Transfer actions only', () => {
    expect(transferredYocto({ transaction: { actions: ['CreateAccount', { Transfer: { deposit: '5' } }, { Transfer: { deposit: '7' } }] } })).toBe(12n);
  });
});

describe('buying a viewing key from a browser wallet', () => {
  let paidTo: { to: string; yocto: bigint }[];
  beforeEach(() => {
    keys = new Map();
    creatorPayments = [];
    traderRow = { ...TRADER };
    paidTo = [];
    setAlphaPaymentDepsForTests({
      fetchOutcome: async (hash, signer) => (hash === HASH && signer === 'buyer.near' ? payment() as any : null),
      payFromTreasury: async (to, yocto) => { paidTo.push({ to, yocto }); return { txHash: 'creator-payout-tx' }; },
    });
  });

  it('refuses a made-up transaction instead of handing out a free key', async () => {
    const r = await buyViewingKey(buyer, 'trader_1', { tier: 'copy', txHash: 'free-key-please', payerAccountId: 'buyer.near' });
    expect(r.success).toBe(false);
    expect([...keys.values()][0].payment_status).toBe('failed');
    expect(traderRow.keys_reserved).toBe(0);
    expect(paidTo).toEqual([]);
  });

  it('grants the key for a real payment, pays the creator 95% and records the sale', async () => {
    const r = await buyViewingKey(buyer, 'trader_1', { tier: 'copy', txHash: HASH, payerAccountId: 'buyer.near' });
    expect(r.success).toBe(true);
    const key = [...keys.values()][0];
    expect(key).toMatchObject({ payment_status: 'completed', treasury_tx_hash: HASH, creator_payout_status: 'paid', copy_fee_pct: 10 });
    expect(paidTo).toEqual([{ to: 'creator.near', yocto: (35n * NEAR * 95n) / 1000n }]);
    expect(traderRow).toMatchObject({ keys_sold: 1, keys_reserved: 0 });
    expect(traderRow.total_revenue_near).toBeCloseTo(3.325);
  });

  it('lets one payment buy one key only', async () => {
    expect((await buyViewingKey(buyer, 'trader_1', { tier: 'copy', txHash: HASH, payerAccountId: 'buyer.near' })).success).toBe(true);
    const other = { id: 'buyer-2', subaccount_id: 'other.racerbot.near' };
    const again = await buyViewingKey(other, 'trader_1', { tier: 'copy', txHash: HASH, payerAccountId: 'buyer.near' });
    expect(again).toEqual({ success: false, reason: 'That payment has already been used.' });
  });

  it('still grants the key when the creator payout fails, and leaves it pending for the retry job', async () => {
    setAlphaPaymentDepsForTests({
      fetchOutcome: async () => payment() as any,
      payFromTreasury: async () => { throw new Error('treasury busy'); },
    });
    const r = await buyViewingKey(buyer, 'trader_1', { tier: 'copy', txHash: HASH, payerAccountId: 'buyer.near' });
    expect(r.success).toBe(true);
    expect([...keys.values()][0]).toMatchObject({ payment_status: 'completed', creator_payout_status: 'pending' });
  });

  it('copies 1 NEAR per trade when the follower picks 1 NEAR (no hidden 1.5x)', async () => {
    await buyViewingKey(buyer, 'trader_1', { tier: 'copy', txHash: HASH, payerAccountId: 'buyer.near', autoCopyAmountNear: 1 });
    expect([...keys.values()][0].risk_multiplier).toBe(1);
  });
});

describe('copy settings', () => {
  beforeEach(() => {
    keys = new Map([['k1', { id: 'k1', trader_id: 'trader_1', buyer_user_id: 'buyer-1', tier: 'basic', payment_status: 'completed' }]]);
    createCopyTradeTarget.mockClear();
  });
  it('a Basic (view-only) key cannot switch on auto-copy', async () => {
    const r = await updateKeyCopySettings('buyer-1', 'trader_1', { autoCopyEnabled: true });
    expect(r.success).toBe(false);
    expect(r.reason).toMatch(/Copy or Premium/);
  });
  it('switching on auto-copy no longer adds a second, plain wallet-copy of the creator', async () => {
    keys.get('k1').tier = 'copy';
    expect((await updateKeyCopySettings('buyer-1', 'trader_1', { autoCopyEnabled: true, riskMultiplier: 50 })).success).toBe(true);
    expect(createCopyTradeTarget).not.toHaveBeenCalled();
    expect(keys.get('k1').risk_multiplier).toBe(5);
  });
});

describe('creator key prices', () => {
  it('must be payable: at least 0.1 NEAR, at most 1000, two decimals', () => {
    expect(keyPriceProblem(3.5)).toBeNull();
    expect(keyPriceProblem(2.555)).toMatch(/two decimal/);
    expect(keyPriceProblem(0)).toMatch(/at least/);
    expect(keyPriceProblem(5000)).toMatch(/at most/);
  });
});
