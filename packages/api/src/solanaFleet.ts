/**
 * RaceFleet on Solana.
 *
 * A fleet keeps its NEAR wallets and gets a second set of Solana wallets
 * (same count, same W1..Wn numbering). Solana wallets are plain keypairs, so
 * creating them costs nothing on-chain; they are generated the first time the
 * user does anything Solana-related with the fleet.
 *
 * Fees mirror NEAR RaceFleet exactly: the monthly subscription (2 NEAR, or the
 * same USD value in SOL) and NO per-trade platform fee on fleet bundle swaps.
 *
 * RPC use: balances come from one getMultipleAccounts call; swaps are built by
 * Jupiter (no RPC) and broadcast to the free endpoints first.
 */
import type { Keypair } from '@solana/web3.js';
import { Markup } from 'telegraf';
import {
  createLogger,
  generateSolanaWallet,
  restoreSolanaKeypair,
  exportSolanaPrivateKey,
  getSolanaTokenInfo,
  getSolanaLamportsMulti,
  getSolanaTokenBalanceOnChain,
  getSolUsdPrice,
  getNearUsdPrice,
  buildSolanaSwapPlan,
  compileSolanaPlan,
  remapSolanaSwapPlan,
  setSolanaPlanSlippage,
  getJupiterQuoteOut,
  simulateSolanaTx,
  getSolanaLatestBlockhash,
  sendAndConfirmManySolana,
  type SolanaSwapPlan,
  sendSolToMany,
  sweepSolFromMany,
  transferSol,
  lamportsToSol,
  solToLamports,
  isSolanaToken,
  invalidateSolanaBalanceCache,
  SOL_MINT,
  SOLANA_MIN_RESERVE_LAMPORTS,
  DEFAULT_SOLANA_DEV_FEE_WALLET,
} from '@racerbot/shared';
import {
  getUserByTelegramId,
  getActiveWallet,
  getRaceFleetByUserId,
  getRaceFleetById,
  getRaceFleetWallets,
  createRaceFleetWallets,
  upsertRaceFleet,
  renewRaceFleet,
  recordRaceFleetFill,
  getRaceFleetFills,
  type RaceFleetRecord,
  type RaceFleetWalletRecord,
  type UserRecord,
} from '@racerbot/db';
import { MASTER_KEY } from './config.js';
import { recordUserTrade } from './depositWatcher.js';

const logger = createLogger('race_fleet_sol');

/** SOL a fleet wallet keeps beside a buy: token account rent (~0.00204) + fees. */
const FLEET_BUY_RESERVE_LAMPORTS = 4_000_000n;
/** Smallest amount sent to a fleet wallet (must exceed the rent-exempt minimum). */
const MIN_FLEET_FUND_LAMPORTS = 2_000_000n;
/** RaceFleet monthly fee, same as NEAR. */
const FLEET_FEE_NEAR = 2.0;

export function isSolanaFleetToken(tokenAddress: string): boolean {
  return isSolanaToken(tokenAddress);
}

/** The user's main Solana keypair (active wallet first, like the executor). */
async function mainSolanaKeypair(user: UserRecord): Promise<{ address: string; keypair: Keypair }> {
  const active = await getActiveWallet(user.id, 'solana').catch(() => null);
  const address = active?.address || user.solana_address;
  const enc = active?.encrypted_private_key || user.solana_private_key_enc;
  if (!address || !enc) throw new Error('Your Solana wallet is not ready yet. Send /start and try again.');
  const keypair = restoreSolanaKeypair(enc, MASTER_KEY);
  if (keypair.publicKey.toBase58() !== address) throw new Error('Solana wallet key mismatch. Please contact support.');
  return { address, keypair };
}

/** Returns the fleet's Solana wallets, creating them (off-chain, free) on first use. */
export async function ensureSolanaFleetWallets(fleet: RaceFleetRecord): Promise<RaceFleetWalletRecord[]> {
  const existing = await getRaceFleetWallets(fleet.id, 'solana');
  if (existing.length >= fleet.wallet_count) return existing;
  const have = new Set(existing.map((w) => w.wallet_index));
  const toCreate = [];
  for (let i = 1; i <= fleet.wallet_count; i++) {
    if (have.has(i)) continue;
    const w = generateSolanaWallet(MASTER_KEY);
    toCreate.push({
      fleet_id: fleet.id,
      user_id: fleet.user_id,
      account_id: w.address,
      wallet_index: i,
      encrypted_private_key: w.encryptedPrivateKey,
      chain: 'solana' as const,
    });
  }
  if (toCreate.length > 0) {
    await createRaceFleetWallets(toCreate).catch((err) => {
      // A concurrent request may have created them first (unique index); re-read below.
      logger.warn('Solana fleet wallet insert raced', { error: String(err?.message || err) });
    });
    logger.info(`Created ${toCreate.length} Solana fleet wallets for fleet ${fleet.id}`);
  }
  return getRaceFleetWallets(fleet.id, 'solana');
}

function keypairOf(w: RaceFleetWalletRecord): Keypair {
  return restoreSolanaKeypair(w.encrypted_private_key, MASTER_KEY);
}

// ── Subscription paid in SOL ────────────────────────────────────────────────

/** 2 NEAR expressed in SOL at live prices (rounded up to 0.0001 SOL). */
export async function getFleetFeeInSol(): Promise<number> {
  const [nearUsd, solUsd] = await Promise.all([getNearUsdPrice().catch(() => 0), getSolUsdPrice()]);
  if (!(nearUsd > 0) || !(solUsd > 0)) throw new Error('Price feed unavailable. Please try again in a minute.');
  return Math.ceil(((FLEET_FEE_NEAR * nearUsd) / solUsd) * 10_000) / 10_000;
}

async function paySubscriptionInSol(user: UserRecord): Promise<{ feeSol: number; signature: string }> {
  const feeSol = await getFleetFeeInSol();
  const { address, keypair } = await mainSolanaKeypair(user);
  const bal = (await getSolanaLamportsMulti([address])).get(address) ?? 0n;
  const fee = solToLamports(feeSol);
  if (bal < fee + SOLANA_MIN_RESERVE_LAMPORTS) {
    throw new Error(`Insufficient SOL. The RaceFleet subscription is ${feeSol} SOL (2 NEAR). You have ${lamportsToSol(bal).toFixed(4)} SOL.`);
  }
  const signature = await transferSol(keypair, DEFAULT_SOLANA_DEV_FEE_WALLET, fee);
  return { feeSol, signature };
}

/** Deploys a fleet paid in SOL. Creates Solana fleet wallets only (no NEAR subaccounts). */
export async function deployRaceFleetWithSol(telegramId: number, walletCount: number): Promise<{
  success: boolean; fleet?: RaceFleetRecord; wallets?: RaceFleetWalletRecord[]; feeSol?: number; reason?: string;
}> {
  const user = await getUserByTelegramId(telegramId);
  if (!user) return { success: false, reason: 'User not found. Please run /start first.' };
  const existing = await getRaceFleetByUserId(user.id);
  if (existing && new Date(existing.expires_at).getTime() > Date.now()) {
    return { success: false, reason: 'You already have an active RaceFleet. Open the Fleet Dashboard to use its Solana wallets.' };
  }
  const count = Math.max(1, Math.min(25, walletCount));
  let paid: { feeSol: number; signature: string };
  try {
    paid = await paySubscriptionInSol(user);
  } catch (err: any) {
    return { success: false, reason: err?.message || 'Subscription payment failed' };
  }
  logger.info(`RaceFleet paid in SOL by ${user.id}: ${paid.feeSol} SOL (${paid.signature})`);
  const fleet = existing
    ? await renewRaceFleet(existing.id, 30)
    : await upsertRaceFleet({
        user_id: user.id,
        name: 'Alpha Fleet',
        fleet_tag: `f-sol-${Math.floor(100 + Math.random() * 900)}-${Date.now().toString(36).slice(-4)}`,
        wallet_count: count,
        monthly_fee_near: FLEET_FEE_NEAR,
        duration_days: 30,
        auto_renew: true,
      });
  const wallets = await ensureSolanaFleetWallets(fleet);
  return { success: true, fleet, wallets, feeSol: paid.feeSol };
}

export async function renewRaceFleetWithSol(telegramId: number): Promise<{ success: boolean; expiresAt?: Date; feeSol?: number; reason?: string }> {
  const user = await getUserByTelegramId(telegramId);
  if (!user) return { success: false, reason: 'User not found' };
  const fleet = await getRaceFleetByUserId(user.id);
  if (!fleet) return { success: false, reason: 'No RaceFleet found' };
  try {
    const paid = await paySubscriptionInSol(user);
    const updated = await renewRaceFleet(fleet.id, 30);
    return { success: true, expiresAt: updated.expires_at, feeSol: paid.feeSol };
  } catch (err: any) {
    return { success: false, reason: err?.message || 'Renewal payment failed' };
  }
}

// ── Balances ────────────────────────────────────────────────────────────────

export interface SolanaFleetBalances {
  totalSol: number;
  wallets: { address: string; walletIndex: number; sol: number; tokenRaw: bigint }[];
  tokenTotalRaw: bigint;
}

export async function getSolanaFleetBalances(fleet: RaceFleetRecord, mint?: string): Promise<SolanaFleetBalances> {
  const wallets = await ensureSolanaFleetWallets(fleet);
  const lamports = await getSolanaLamportsMulti(wallets.map((w) => w.account_id)).catch(() => new Map<string, bigint>());
  const tokenRaws = mint
    ? await Promise.all(wallets.map((w) => getSolanaTokenBalanceOnChain(w.account_id, mint).then((v) => v ?? 0n).catch(() => 0n)))
    : wallets.map(() => 0n);
  const rows = wallets.map((w, i) => ({
    address: w.account_id,
    walletIndex: w.wallet_index,
    sol: lamportsToSol(lamports.get(w.account_id) ?? 0n),
    tokenRaw: tokenRaws[i],
  }));
  return {
    totalSol: rows.reduce((a, r) => a + r.sol, 0),
    wallets: rows,
    tokenTotalRaw: rows.reduce((a, r) => a + r.tokenRaw, 0n),
  };
}

// ── Distribute / Sweep ──────────────────────────────────────────────────────

export async function distributeSolToFleet(telegramId: number, totalSol: number): Promise<{
  success: boolean; perWalletSol?: number; walletCount?: number; failed?: number; reason?: string;
}> {
  const user = await getUserByTelegramId(telegramId);
  if (!user) return { success: false, reason: 'User not found' };
  const fleet = await getRaceFleetByUserId(user.id);
  if (!fleet) return { success: false, reason: 'No active RaceFleet found' };
  const wallets = await ensureSolanaFleetWallets(fleet);
  if (wallets.length === 0) return { success: false, reason: 'No Solana wallets in fleet' };

  const { address, keypair } = await mainSolanaKeypair(user);
  const bal = (await getSolanaLamportsMulti([address])).get(address) ?? 0n;
  const total = solToLamports(totalSol);
  // Keep the main-wallet reserve plus the network fees of the batches.
  const fees = 20_000n * BigInt(Math.ceil(wallets.length / 10));
  if (bal < total + SOLANA_MIN_RESERVE_LAMPORTS + fees) {
    return {
      success: false,
      reason: `Insufficient SOL in main wallet. Available: ${lamportsToSol(bal).toFixed(4)} SOL, requested: ${totalSol} SOL (keep 0.005 SOL for fees).`,
    };
  }
  const per = total / BigInt(wallets.length);
  if (per < MIN_FLEET_FUND_LAMPORTS) {
    return { success: false, reason: `Too small: each wallet must get at least 0.002 SOL (send at least ${(0.002 * wallets.length).toFixed(3)} SOL).` };
  }
  const res = await sendSolToMany(keypair, wallets.map((w) => ({ to: w.account_id, lamports: per })));
  if (res.sent.length === 0) return { success: false, reason: res.failed[0]?.error || 'Transfers failed' };
  return { success: true, perWalletSol: lamportsToSol(per), walletCount: res.sent.length, failed: res.failed.length };
}

export async function sweepSolanaFleet(telegramId: number): Promise<{
  success: boolean; totalSweptSol: number; successCount: number; failCount: number; reason?: string;
}> {
  const user = await getUserByTelegramId(telegramId);
  if (!user) return { success: false, totalSweptSol: 0, successCount: 0, failCount: 0, reason: 'User not found' };
  const fleet = await getRaceFleetByUserId(user.id);
  if (!fleet) return { success: false, totalSweptSol: 0, successCount: 0, failCount: 0, reason: 'No RaceFleet found' };
  const wallets = await getRaceFleetWallets(fleet.id, 'solana');
  if (wallets.length === 0) return { success: false, totalSweptSol: 0, successCount: 0, failCount: 0, reason: 'No Solana fleet wallets' };
  const { address, keypair } = await mainSolanaKeypair(user);
  const res = await sweepSolFromMany(wallets.map(keypairOf), address, keypair);
  // SOL coming back from the fleet is not an external deposit: do not announce it as one.
  if (res.sweptLamports > 0n) recordUserTrade(user.id, 'solana', lamportsToSol(res.sweptLamports));
  return {
    success: res.walletsSwept > 0,
    totalSweptSol: Number(lamportsToSol(res.sweptLamports).toFixed(4)),
    successCount: res.walletsSwept,
    failCount: res.failed,
  };
}

// ── Bundle trades: every wallet fires at the same instant ──────────────────
//
// One tap = one coordinated wave:
//  1. One Jupiter quote for the WHOLE fleet size, to price in the impact of all
//     wallets hitting the same pool in the same block (sets the slippage).
//  2. One Jupiter build for the first wallet.
//  3. That route is re-targeted to every other wallet locally (owner, token
//     accounts, pump.fun volume PDAs, and the amount for sells), then each copy
//     is simulated on the free RPC. Any wallet whose copy does not simulate
//     cleanly gets its own Jupiter build instead (rare).
//  4. All transactions are signed with ONE fresh blockhash and broadcast at
//     the same moment, then confirmed together.
// Result: 2 Jupiter calls instead of one per wallet, and the swaps land in the
// same or the next block instead of ~2 s apart.

interface FleetLeg { wallet: RaceFleetWalletRecord; amount: bigint }
interface FleetLegResult { wallet: RaceFleetWalletRecord; amount: bigint; out: bigint; signature: string | null; ok: boolean; error: string | null }

const MAX_FLEET_SLIPPAGE_BPS = 5000;

/**
 * Slippage that still fills the LAST wallet when every wallet hits the same
 * pool in one block. Compares the single-wallet route (already built) with a
 * quote for the whole fleet size; the last fill loses about 2x the average.
 */
async function fleetSlippageBps(plan: SolanaSwapPlan, legs: FleetLeg[], baseBps: number): Promise<number> {
  if (legs.length <= 1) return baseBps;
  const total = legs.reduce((a, l) => a + l.amount, 0n);
  const outTotal = await getJupiterQuoteOut(plan.inputMint, plan.outputMint, total);
  if (!outTotal || plan.outAmount <= 0n) return Math.min(MAX_FLEET_SLIPPAGE_BPS, baseBps * 2);
  const avgLoss = 1 - (Number(outTotal) / Number(total)) / (Number(plan.outAmount) / Number(plan.inAmount));
  const extra = Math.max(0, Math.ceil(avgLoss * 2 * 10_000 * 1.15));
  return Math.min(MAX_FLEET_SLIPPAGE_BPS, baseBps + extra);
}

async function runLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

async function fireSolanaFleetWave(legs: FleetLeg[], inputMint: string, outputMint: string, baseSlippageBps: number): Promise<FleetLegResult[]> {
  if (legs.length === 0) return [];
  const template = legs[0];
  const buildFor = (owner: string, amount: bigint, slippageBps: number) => buildSolanaSwapPlan({
    owner, inputMint, outputMint, amount, slippageBps,
    feeLamports: 0n, // no per-trade fee on fleet bundles (same as NEAR RaceFleet)
  });
  let plan = await buildFor(template.wallet.account_id, template.amount, baseSlippageBps);
  const slippageBps = await fleetSlippageBps(plan, legs, baseSlippageBps);
  if (slippageBps !== plan.slippageBps && !setSolanaPlanSlippage(plan, slippageBps)) {
    plan = await buildFor(template.wallet.account_id, template.amount, slippageBps);
  }
  const bh = await getSolanaLatestBlockhash();

  type Prepared = { leg: FleetLeg; plan: SolanaSwapPlan; ixs: any[] | null; error: string | null };
  const prepared: Prepared[] = legs.map((leg) => ({
    leg,
    plan,
    ixs: leg === template ? plan.instructions : remapSolanaSwapPlan(plan, leg.wallet.account_id, leg.amount),
    error: null,
  }));

  // Simulate every copy (free RPC, 5 at a time). Wallets with too little SOL are dropped here, before anything is sent.
  const ownBuild: Prepared[] = [];
  await runLimited(prepared, 5, async (p) => {
    if (!p.ixs) { ownBuild.push(p); return; }
    const sim = await simulateSolanaTx(compileSolanaPlan(p.plan, p.ixs, p.leg.wallet.account_id, bh.blockhash));
    if (sim.ok) return;
    if (/insufficient/i.test(sim.error || '')) { p.error = `Wallet ${p.leg.wallet.wallet_index}: ${sim.error}`; return; }
    if (p.leg === template) { p.error = `Wallet ${p.leg.wallet.wallet_index}: ${sim.error}`; return; }
    ownBuild.push(p);
  });
  // Rare fallback: a dedicated route for wallets the shared route did not fit.
  for (const p of ownBuild) {
    try {
      p.plan = await buildFor(p.leg.wallet.account_id, p.leg.amount, slippageBps);
      p.ixs = p.plan.instructions;
    } catch (err: any) {
      p.ixs = null;
      p.error = `Wallet ${p.leg.wallet.wallet_index}: ${err?.message || 'no route'}`;
    }
  }

  const ready = prepared.filter((p) => p.ixs && !p.error);
  const txs = ready.map((p) => {
    const tx = compileSolanaPlan(p.plan, p.ixs!, p.leg.wallet.account_id, bh.blockhash);
    tx.sign([keypairOf(p.leg.wallet)]);
    return tx;
  });
  const sent = txs.length > 0 ? await sendAndConfirmManySolana(txs, bh.lastValidBlockHeight) : [];
  const bySig = new Map(ready.map((p, i) => [p, sent[i]]));

  return prepared.map((p) => {
    const r = bySig.get(p);
    const out = p.plan.inAmount > 0n ? (p.plan.outAmount * p.leg.amount) / p.plan.inAmount : 0n;
    return {
      wallet: p.leg.wallet,
      amount: p.leg.amount,
      out,
      signature: r?.signature ?? null,
      ok: Boolean(r?.confirmed),
      error: p.error ?? (r && !r.confirmed ? `Wallet ${p.leg.wallet.wallet_index}: ${r.error}` : null),
    };
  });
}

export async function executeSolanaFleetBundleBuy(
  fleetId: string,
  mint: string,
  solPerWallet: number,
  slippagePct = 3.0,
): Promise<{ success: boolean; successCount: number; failCount: number; totalSpentNear: number; txHashes: string[]; errors: string[] }> {
  const fail = (errors: string[], failCount = 0) => ({ success: false, successCount: 0, failCount, totalSpentNear: 0, txHashes: [], errors });
  const fleet = await getRaceFleetById(fleetId);
  if (!fleet) return fail(['Fleet not found']);
  const wallets = await ensureSolanaFleetWallets(fleet);
  const info = await getSolanaTokenInfo(mint).catch(() => null);
  if (!info) return fail(['Token not found on Solana'], wallets.length);
  if (info.freezeAuthorityDisabled === false) return fail(['Blocked: this token has an active freeze authority (it can freeze your tokens).'], wallets.length);
  const lamports = solToLamports(solPerWallet);
  if (lamports <= 0n) return fail(['Invalid amount']);

  const balances = await getSolanaLamportsMulti(wallets.map((w) => w.account_id)).catch(() => new Map<string, bigint>());
  const errors: string[] = [];
  const legs: FleetLeg[] = [];
  for (const w of wallets) {
    const bal = balances.get(w.account_id) ?? 0n;
    if (bal < lamports + FLEET_BUY_RESERVE_LAMPORTS) errors.push(`Wallet ${w.wallet_index} low balance (${lamportsToSol(bal).toFixed(3)} SOL)`);
    else legs.push({ wallet: w, amount: lamports });
  }
  if (legs.length === 0) return fail(errors.length ? errors : ['No funded Solana fleet wallets. Use 📥 Distribute SOL first.'], wallets.length);

  const baseBps = Math.round(Math.max(slippagePct, info.bondingPhase === 'prebonded' ? 10 : 3) * 100);
  let results: FleetLegResult[];
  try {
    results = await fireSolanaFleetWave(legs, SOL_MINT, mint, baseBps);
  } catch (err: any) {
    return fail([err?.message || 'Bundle buy failed', ...errors], wallets.length);
  }
  const done = results.filter((r) => r.ok);
  for (const r of results) if (r.error) errors.push(r.error);
  const spentLamports = done.reduce((a, d) => a + d.amount, 0n);
  if (done.length > 0) {
    const tokens = Number(done.reduce((a, d) => a + d.out, 0n)) / Math.pow(10, info.decimals);
    await recordRaceFleetFill({
      fleet_id: fleet.id,
      user_id: fleet.user_id,
      side: 'buy',
      token_address: mint,
      amount: tokens.toString(),
      price: tokens > 0 ? lamportsToSol(spentLamports) / tokens : info.priceSol,
      fee_paid: 0,
      venue: 'jupiter',
      tx_hash: done[0].signature!,
    }).catch((err) => logger.warn('Failed to record Solana fleet buy fill', { error: String(err) }));
  }
  return {
    success: done.length > 0,
    successCount: done.length,
    failCount: errors.length,
    totalSpentNear: Number(lamportsToSol(spentLamports).toFixed(4)), // SOL for Solana fleets
    txHashes: done.map((d) => d.signature!),
    errors,
  };
}

export async function executeSolanaFleetBundleSell(
  fleetId: string,
  mint: string,
  sellPct = 100,
  slippagePct = 3.0,
): Promise<{ success: boolean; successCount: number; failCount: number; txHashes: string[]; errors: string[] }> {
  const fleet = await getRaceFleetById(fleetId);
  if (!fleet) return { success: false, successCount: 0, failCount: 0, txHashes: [], errors: ['Fleet not found'] };
  const wallets = await getRaceFleetWallets(fleet.id, 'solana');
  const info = await getSolanaTokenInfo(mint).catch(() => null);
  const decimals = info?.decimals ?? 6;
  const pct = Math.max(1, Math.min(100, Math.floor(sellPct)));
  const [lamports, raws] = await Promise.all([
    getSolanaLamportsMulti(wallets.map((w) => w.account_id)).catch(() => new Map<string, bigint>()),
    Promise.all(wallets.map((w) => getSolanaTokenBalanceOnChain(w.account_id, mint).then((v) => v ?? 0n).catch(() => 0n))),
  ]);

  const errors: string[] = [];
  const legs: FleetLeg[] = [];
  wallets.forEach((w, i) => {
    const raw = raws[i];
    if (raw <= 0n) return;
    if ((lamports.get(w.account_id) ?? 0n) < 100_000n) { errors.push(`Wallet ${w.wallet_index} has no SOL for the network fee`); return; }
    const amount = pct === 100 ? raw : (raw * BigInt(pct)) / 100n;
    if (amount > 0n) legs.push({ wallet: w, amount });
  });
  if (legs.length === 0) {
    return { success: false, successCount: 0, failCount: errors.length, txHashes: [], errors: errors.length ? errors : ['No fleet wallet holds this token'] };
  }

  const baseBps = Math.round(Math.max(slippagePct, info?.bondingPhase === 'prebonded' ? 10 : 3) * 100);
  let results: FleetLegResult[];
  try {
    results = await fireSolanaFleetWave(legs, mint, SOL_MINT, baseBps);
  } catch (err: any) {
    return { success: false, successCount: 0, failCount: legs.length, txHashes: [], errors: [err?.message || 'Bundle sell failed', ...errors] };
  }
  const done = results.filter((r) => r.ok);
  for (const r of results) if (r.error) errors.push(r.error);
  if (done.length > 0) {
    const tokens = Number(done.reduce((a, d) => a + d.amount, 0n)) / Math.pow(10, decimals);
    const outLamports = done.reduce((a, d) => a + d.out, 0n);
    await recordRaceFleetFill({
      fleet_id: fleet.id,
      user_id: fleet.user_id,
      side: 'sell',
      token_address: mint,
      amount: tokens.toString(),
      price: tokens > 0 ? lamportsToSol(outLamports) / tokens : info?.priceSol ?? 0,
      fee_paid: 0,
      venue: 'jupiter',
      tx_hash: done[0].signature!,
    }).catch((err) => logger.warn('Failed to record Solana fleet sell fill', { error: String(err) }));
  }
  return { success: done.length > 0, successCount: done.length, failCount: errors.length, txHashes: done.map((d) => d.signature!), errors };
}

// ── Keys ────────────────────────────────────────────────────────────────────

export async function exportSolanaFleetKeys(fleetId: string): Promise<{ accountId: string; privateKey: string }[]> {
  const wallets = await getRaceFleetWallets(fleetId, 'solana');
  return wallets.map((w) => {
    let pk = '';
    try { pk = exportSolanaPrivateKey(w.encrypted_private_key, MASTER_KEY); } catch { pk = 'Decryption error'; }
    return { accountId: w.account_id, privateKey: pk };
  });
}

// ── Position & cockpit ──────────────────────────────────────────────────────

async function avgEntrySol(fleetId: string, mint: string): Promise<number> {
  const fills = await getRaceFleetFills(fleetId, mint).catch(() => []);
  let qty = 0;
  let cost = 0;
  for (const f of fills) {
    if (f.side !== 'buy') continue;
    const q = parseFloat(f.amount || '0');
    const p = parseFloat(f.price || '0');
    if (q > 0 && p > 0) { qty += q; cost += q * p; }
  }
  return qty > 0 ? cost / qty : 0;
}

export async function buildSolanaFleetCockpit(fleet: RaceFleetRecord, mint: string, shortKey: string): Promise<{ text: string; keyboard: any }> {
  const [bal, info, entry] = await Promise.all([
    getSolanaFleetBalances(fleet, mint),
    getSolanaTokenInfo(mint).catch(() => null),
    avgEntrySol(fleet.id, mint),
  ]);
  const sym = info?.symbol || 'TOKEN';
  const decimals = info?.decimals ?? 6;
  const holdHuman = Number(bal.tokenTotalRaw) / Math.pow(10, decimals);
  const priceSol = info?.priceSol ?? 0;
  const pnl = entry > 0 && priceSol > 0 ? ((priceSol - entry) / entry) * 100 : null;
  const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(2)}K` : n.toFixed(2));
  const holdingsText = bal.tokenTotalRaw > 0n
    ? `🎒 <b>Fleet Holdings</b>: <b>${fmt(holdHuman)} ${sym}</b> (${bal.wallets.filter((w) => w.tokenRaw > 0n).length}/${bal.wallets.length} wallets)\n` +
      (pnl !== null ? `📈 <b>Fleet PnL</b>: ${pnl >= 0 ? '🟢' : '🔴'} <b>${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}%</b> (Entry: <code>${entry.toExponential(4)} SOL</code>)\n` : '')
    : '';
  const fundingTip = bal.totalSol < 0.01
    ? `⚠️ <i>Your Solana fleet wallets are empty. Tap [📥 Distribute SOL] to fund them from your main Solana wallet.</i>\n\n`
    : '';
  const text =
    `🏎 <b>RACEFLEET COCKPIT [BETA]</b> — $${sym} ◎ Solana\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🏷 <b>Fleet Tag</b>: <code>${fleet.fleet_tag}</code> (${bal.wallets.length} Solana Wallets)\n` +
    `💰 <b>Fleet Balance</b>: <b>${bal.totalSol.toFixed(4)} SOL</b>\n` +
    holdingsText +
    `🪙 <b>Target Token</b>: <code>${mint}</code>\n` +
    `📍 <b>Price</b>: ${priceSol > 0 ? `${priceSol.toExponential(4)} SOL` : '—'}${info?.priceUsd ? ` ($${info.priceUsd.toPrecision(4)})` : ''}\n` +
    (info?.launchpad === 'pump.fun' ? `🏪 <b>Phase</b>: ${info.bondingPhase === 'prebonded' ? 'pump.fun bonding curve' : 'bonded (PumpSwap / DEX)'}\n` : '') +
    `\n` + fundingTip +
    `⚡ <i>One tap fires all ${bal.wallets.length} Solana fleet wallets at the same moment.</i>`;
  const keyboard = Markup.inlineKeyboard([
    // One tap fires every fleet wallet at the same instant.
    [
      Markup.button.callback('🟢 Fleet BUY', `fleet_buy_prompt:${shortKey}`),
      Markup.button.callback('🔴 Fleet SELL', `fleet_sell_prompt:${shortKey}`),
    ],
    [Markup.button.callback('🎯 Snipe (0.1 SOL + 50% TP / 15% SL)', `fleet_snipe_protect:${shortKey}`)],
    [
      Markup.button.callback('🎯 Fleet Limit Order', `fleet_lo_start:${shortKey}`),
      Markup.button.callback('🌊 Volume Maker', `fleet_volume_prompt:${shortKey}`),
    ],
    [
      Markup.button.callback('📥 Distribute SOL', 'fleet_fund_sol_prompt'),
      Markup.button.callback('📤 Sweep SOL', 'fleet_sweep_sol'),
    ],
    [
      Markup.button.callback('« 👤 Switch to Personal Wallet', `token_refresh:${shortKey}`),
      Markup.button.callback('🏎️ Fleet Dashboard', 'racefleet_menu'),
    ],
  ]);
  return { text, keyboard };
}

/** Solana section for the holdings view: tokens the fleet traded that are still held. */
export async function buildSolanaFleetHoldingsSection(fleet: RaceFleetRecord): Promise<{ text: string; rows: { symbol: string; mint: string }[] }> {
  const solWallets = await getRaceFleetWallets(fleet.id, 'solana');
  if (solWallets.length === 0) return { text: '', rows: [] };
  const fills = await getRaceFleetFills(fleet.id).catch(() => []);
  // Most recent Solana tokens first; capped to keep RPC use small.
  const mints = [...new Set(fills.map((f) => f.token_address).filter((t) => isSolanaToken(t)))].slice(0, 5);
  const bal = await getSolanaFleetBalances(fleet);
  let text = `\n◎ <b>Solana Fleet</b>: <b>${bal.totalSol.toFixed(4)} SOL</b> across ${bal.wallets.length} wallets\n`;
  const rows: { symbol: string; mint: string }[] = [];
  for (const mint of mints) {
    const [info, entry, raws] = await Promise.all([
      getSolanaTokenInfo(mint).catch(() => null),
      avgEntrySol(fleet.id, mint),
      Promise.all(solWallets.map((w) => getSolanaTokenBalanceOnChain(w.account_id, mint).then((v) => v ?? 0n).catch(() => 0n))),
    ]);
    const raw = raws.reduce((a, r) => a + r, 0n);
    const holding = raws.filter((r) => r > 0n).length;
    if (raw <= 0n) continue;
    const human = Number(raw) / Math.pow(10, info?.decimals ?? 6);
    const valueSol = human * (info?.priceSol ?? 0);
    const pnl = entry > 0 && (info?.priceSol ?? 0) > 0 ? ((info!.priceSol - entry) / entry) * 100 : null;
    const sym = info?.symbol || mint.slice(0, 6);
    text +=
      `${pnl === null ? '⚪' : pnl >= 0 ? '🟢' : '🔴'} <b>$${sym}</b> (${pnl === null ? 'LIVE' : `${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}%`})\n` +
      `• <b>Value</b>: <b>${valueSol.toFixed(4)} SOL</b> | <b>Wallets</b>: ${holding}/${solWallets.length}\n`;
    rows.push({ symbol: sym, mint });
  }
  return { text, rows };
}

export function invalidateSolanaFleetBalances(addresses: string[]): void {
  for (const a of addresses) invalidateSolanaBalanceCache(a);
}

/**
 * Fleet position in a Solana token, in the same shape the NEAR token card uses
 * (prices in SOL). Returns null when the fleet has no Solana wallets yet, and
 * never creates wallets (this runs on every token card view).
 */
export async function getSolanaFleetTokenPosition(fleet: RaceFleetRecord, mint: string): Promise<{
  fleetId: string; tokenAddress: string; symbol: string; totalBalanceRaw: bigint; totalBalanceHuman: number;
  walletsHoldingCount: number; walletCount: number; avgEntryPriceNear: number; currentPriceNear: number;
  currentPriceUsd: number; totalValueNear: number; totalValueUsd: number; pnlPct: number; pnlDisplay: string; emoji: string;
} | null> {
  const wallets = await getRaceFleetWallets(fleet.id, 'solana');
  if (wallets.length === 0) return null;
  const [info, entry, raws] = await Promise.all([
    getSolanaTokenInfo(mint).catch(() => null),
    avgEntrySol(fleet.id, mint),
    Promise.all(wallets.map((w) => getSolanaTokenBalanceOnChain(w.account_id, mint).then((v) => v ?? 0n).catch(() => 0n))),
  ]);
  const totalBalanceRaw = raws.reduce((a, r) => a + r, 0n);
  const decimals = info?.decimals ?? 6;
  const totalBalanceHuman = Number(totalBalanceRaw) / Math.pow(10, decimals);
  const price = info?.priceSol ?? 0;
  const solUsd = info?.solUsd ?? 0;
  let pnlPct = 0;
  let pnlDisplay = 'N/A';
  let emoji = '⚪';
  if (price > 0 && entry > 0) {
    pnlPct = ((price - entry) / entry) * 100;
    emoji = pnlPct >= 100 ? '🚀' : pnlPct > 0 ? '🟢' : pnlPct < 0 ? '🔴' : '⚪';
    pnlDisplay = `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`;
  } else if (price > 0) {
    pnlDisplay = 'LIVE';
    emoji = '🟢';
  }
  return {
    fleetId: fleet.id,
    tokenAddress: mint,
    symbol: info?.symbol || mint.slice(0, 6),
    totalBalanceRaw,
    totalBalanceHuman,
    walletsHoldingCount: raws.filter((r) => r > 0n).length,
    walletCount: wallets.length,
    avgEntryPriceNear: entry,
    currentPriceNear: price,
    currentPriceUsd: price * solUsd,
    totalValueNear: totalBalanceHuman * price,
    totalValueUsd: totalBalanceHuman * price * solUsd,
    pnlPct,
    pnlDisplay,
    emoji,
  };
}
