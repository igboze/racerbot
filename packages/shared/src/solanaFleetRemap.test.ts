import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { buildSolanaSwapPlan, remapSolanaSwapPlan, setSolanaPlanSlippage, compileSolanaPlan, SOL_MINT } from './solana.js';

const fx = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__/jupiterPumpBuild.json'), 'utf8'));

function mockJupiter() {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(fx.build), { status: 200 })));
}

describe('RaceFleet: one Jupiter route re-targeted to many wallets', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('maps the owner, its token accounts and the pump.fun volume PDA exactly like the copy that simulated OK on mainnet', async () => {
    mockJupiter();
    const plan = await buildSolanaSwapPlan({ owner: fx.owner, inputMint: SOL_MINT, outputMint: fx.mint, amount: 10_000_000n, slippageBps: 1000 });
    const ixs = remapSolanaSwapPlan(plan, fx.other)!;
    expect(ixs).not.toBeNull();
    const keys = ixs.map((ix) => ix.keys.map((k) => k.pubkey.toBase58()));
    expect(keys).toEqual(fx.expectedKeys);
    // Nothing from the template wallet may survive in the copy.
    expect(keys.flat()).not.toContain(fx.owner);
  });

  it('patches the input amount and quoted output for a different sell size, and slippage in place', async () => {
    mockJupiter();
    const plan = await buildSolanaSwapPlan({ owner: fx.owner, inputMint: SOL_MINT, outputMint: fx.mint, amount: 10_000_000n, slippageBps: 1000 });
    expect(setSolanaPlanSlippage(plan, 1800)).toBe(true);
    const ixs = remapSolanaSwapPlan(plan, fx.other, 25_000_000n)!;
    const d = Buffer.from(ixs[plan.swapIndex].data);
    expect(d.readBigUInt64LE(8)).toBe(25_000_000n);
    expect(d.readBigUInt64LE(16)).toBe((87_309_727_696n * 25_000_000n) / 10_000_000n);
    expect(d.readUInt16LE(24)).toBe(1800);
    // Compiles into a transaction that fits.
    const tx = compileSolanaPlan(plan, ixs, fx.other, '11111111111111111111111111111111');
    expect(tx.serialize().length).toBeLessThanOrEqual(1232);
  });

  it('refuses to change the amount when the instruction layout is unknown', async () => {
    mockJupiter();
    const plan = await buildSolanaSwapPlan({ owner: fx.owner, inputMint: SOL_MINT, outputMint: fx.mint, amount: 10_000_000n, slippageBps: 1000 });
    plan.slippageBps = 999; // layout check now fails on purpose
    expect(remapSolanaSwapPlan(plan, fx.other, 5n)).toBeNull();
    // Same amount (buys) still works: no data change needed.
    expect(remapSolanaSwapPlan(plan, fx.other)).not.toBeNull();
  });
});
