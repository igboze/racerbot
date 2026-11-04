// Mainnet rehearsal of the position executor BEFORE its global deploy (which cannot be patched in
// place). The same optimized wasm runs as a normal contract on <name>.<owner>, with the owner
// account as its controller (as racerbot.near is in production), and trades tiny amounts on the real venues.
// Cost: ~0.95 NEAR locked for the code's storage, returned when `close` deletes the account,
// plus the test trade (sold back) and gas (~0.01 NEAR). No fee is charged unless --fee-bps is given:
// --fee-bps 150 on buy and exit pays a real 1.5% fee to racerbottreasury.near, checking the fee path.
//
// Preview by default; pass --send to submit. Run the steps in order:
//   node scripts/rehearse-executor.mjs create --send
//   node scripts/rehearse-executor.mjs fund --amount 0.1 --send
//   node scripts/rehearse-executor.mjs buy --venue RefAmm --token <token> --pool <id> --amount 0.1 --send
//        (--venue Dcl --dcl "<token>|wrap.near|<fee>",  --venue Intear --pool <id>)
//   node scripts/rehearse-executor.mjs sell --venue RefAmm --token <token> --pool <id> --send
//   node scripts/rehearse-executor.mjs exit --send                (NEAR back to the owner)
//   node scripts/rehearse-executor.mjs exit --prepare-only --send  (then quote the exact exit_amount)
//   node scripts/rehearse-executor.mjs exit --intents <deposit address> --send
//   node scripts/rehearse-executor.mjs close --send               (20+ blocks after the exit)
//   node scripts/rehearse-executor.mjs state
import 'dotenv/config';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Account, JsonRpcProvider, actions } from 'near-api-js-v7';

const argv = process.argv.slice(2);
const step = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'state';
const send = argv.includes('--send');
const opt = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };

const RPC = process.env.DEPLOY_RPC_URL || 'https://rpc.mainnet.fastnear.com';
const ownerId = process.env.RACERBOT_PARENT_ACCOUNT || 'racerbot.near';
const ownerKey = (process.env.RELAYER_PRIVATE_KEY || process.env.MAIN_WALLET_PRIVATE_KEY || '').trim();
const execId = `${opt('name') || 'rehearse1'}.${ownerId}`;
const WASM = 'packages/position-executor/target/racerbot_position_executor.opt.wasm';
const NEAR = 10n ** 24n;
const TGAS = 10n ** 12n;
const feeBps = Number(opt('fee-bps') || '0');
if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 200) throw new Error('--fee-bps must be 0..200');
const toYocto = (n) => BigInt(Math.round(Number(n) * 1e6)) * 10n ** 18n;
const fmt = (y) => (Number(BigInt(y) / 10n ** 18n) / 1e6).toFixed(4);

// The owner salt lives beside the deploy keys so the exit step can prove ownership
const saltFile = path.join('.secrets', `${execId}.salt`);
function salt() {
  if (fs.existsSync(saltFile)) return fs.readFileSync(saltFile, 'utf8').trim();
  const s = crypto.randomBytes(16).toString('hex');
  if (send) { fs.mkdirSync('.secrets', { recursive: true }); fs.writeFileSync(saltFile, s, { mode: 0o600 }); }
  return s;
}

// ── Borsh (mirrors packages/api/src/executorPlan.ts) ──────────────────────────
class Writer {
  parts = [];
  u8(v) { this.parts.push(Buffer.from([v])); return this; }
  u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v); this.parts.push(b); return this; }
  u64(v) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); this.parts.push(b); return this; }
  u128(v) {
    const n = BigInt(v), b = Buffer.alloc(16);
    b.writeBigUInt64LE(n & ((1n << 64n) - 1n), 0); b.writeBigUInt64LE(n >> 64n, 8);
    this.parts.push(b); return this;
  }
  str(v) { const b = Buffer.from(v, 'utf8'); this.u32(b.length); this.parts.push(b); return this; }
  bytes(v) { this.u32(v.length); this.parts.push(Buffer.from(v)); return this; }
  option(v, write) { if (v == null) this.u8(0); else { this.u8(1); write(v); } return this; }
  done() { return new Uint8Array(Buffer.concat(this.parts)); }
}
const VENUES = { Dcl: 0, RefAmm: 1, Intear: 2, Shardsmarket: 3, BondingCurve: 4, Launchpad: 5 };

function encodePlan(p) {
  const w = new Writer().u8(VENUES[p.venue]).str(p.token).u32(p.hops.length);
  for (const h of p.hops) {
    w.option(h.pool_id, v => w.u64(v)).option(h.dcl_pool_id, v => w.str(v)).str(h.token_in).str(h.token_out).u128(h.min_amount_out);
  }
  return w.u128(p.amount_in).u128(p.min_amount_out).option(p.receiver, v => w.str(v))
    .u64(Math.floor(Date.now() / 1000) + 600).str(`rehearse-${Date.now()}`).done();
}

function plan(buy, amount) {
  const venue = opt('venue') || 'RefAmm';
  const token = opt('token');
  if (!VENUES.hasOwnProperty(venue)) throw new Error(`--venue must be one of ${Object.keys(VENUES).join(', ')}`);
  if (!token) throw new Error('--token is required');
  const min = String(opt('min') || '1');
  const pool = opt('pool') != null ? Number(opt('pool')) : null;
  const hop = {
    pool_id: pool, dcl_pool_id: opt('dcl') ?? null,
    token_in: buy ? 'near' : token, token_out: buy ? token : 'near', min_amount_out: min,
  };
  return encodePlan({ venue, token, hops: [hop], amount_in: amount, min_amount_out: min, receiver: opt('receiver') ?? null });
}

// ── Chain helpers ─────────────────────────────────────────────────────────────
const provider = new JsonRpcProvider({ url: RPC });
async function rpc(method, params) {
  const res = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
}
async function view(contract, method, args = {}) {
  const r = await rpc('query', { request_type: 'call_function', finality: 'optimistic', account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
  const text = Buffer.from(r.result).toString();
  return text ? JSON.parse(text) : null;
}
const state = () => view(execId, 'get_state').catch(() => null);

function report(res) {
  for (const r of res.receipts_outcome || []) {
    for (const log of r.outcome.logs) {
      const m = log.match(/^EVENT_JSON:(.*)$/);
      if (m) { const ev = JSON.parse(m[1]); if (ev.standard === 'racerbot-executor') console.log(`  event ${ev.event} ${JSON.stringify(ev.data)}`); }
    }
    if (r.outcome.status?.Failure) console.log(`  FAILED in ${r.outcome.executor_id}: ${JSON.stringify(r.outcome.status.Failure).slice(0, 300)}`);
  }
  console.log(`  https://nearblocks.io/txns/${res.transaction.hash}`);
}

async function call(method, args, gasT, deposit = 0n) {
  if (!send) { console.log(`Would call ${execId}.${method} (${gasT} TGas). Re-run with --send.`); return null; }
  if (!ownerKey) throw new Error('Owner key (RELAYER_PRIVATE_KEY) is not set');
  const acct = new Account(ownerId, provider, ownerKey);
  const res = await acct.callFunctionRaw({ contractId: execId, methodName: method, args, gas: BigInt(gasT) * TGAS, deposit });
  report(res);
  return res;
}

// ── Steps ─────────────────────────────────────────────────────────────────────
const before = await state();
console.log(`Executor ${execId} (controller: ${ownerId})`);
console.log(before ? `  state ${JSON.stringify(before)}` : '  not created yet');

if (step === 'state') {
  // printed above
} else if (step === 'create') {
  if (before) throw new Error('Already created');
  const code = fs.readFileSync(WASM);
  const deposit = toYocto(opt('deposit') || '1.0');
  const ownerHash = crypto.createHash('sha256').update(salt() + ownerId).digest();
  const init = new Writer().str(ownerId).bytes(ownerHash).done();
  console.log(`Create with ${fmt(deposit)} NEAR (code ${code.length} bytes needs ${fmt(BigInt(code.length) * 10n ** 19n)} staked; all returned at close)`);
  if (send) {
    if (!ownerKey) throw new Error('Owner key (RELAYER_PRIVATE_KEY) is not set');
    const acct = new Account(ownerId, provider, ownerKey);
    report(await acct.signAndSendTransaction({
      receiverId: execId,
      actions: [actions.createAccount(), actions.transfer(deposit), actions.deployContract(new Uint8Array(code)), actions.functionCall('new', init, 30n * TGAS, 0n)],
    }));
  } else console.log('Re-run with --send.');
} else if (step === 'fund') {
  const amount = toYocto(opt('amount') || '0.1');
  console.log(`Fund with ${fmt(amount)} NEAR (the trading balance)`);
  if (send) report(await new Account(ownerId, provider, ownerKey).transfer({ receiverId: execId, amount }));
  else console.log('Re-run with --send.');
} else if (step === 'buy') {
  const amount = toYocto(opt('amount') || '0.1');
  const args = Buffer.concat([Buffer.from(plan(true, amount)), new Writer().u32(feeBps).done()]);
  if (feeBps) console.log(`Fee ${feeBps} bps of what the venue uses goes to racerbottreasury.near`);
  await call('buy', new Uint8Array(args), 300);
} else if (step === 'sell') {
  const token = opt('token');
  const bal = opt('amount') ? String(opt('amount')) : String(await view(token, 'ft_balance_of', { account_id: execId }));
  console.log(`Sell ${bal} of ${token}`);
  await call('sell', plan(false, bal), 300);
} else if (step === 'exit') {
  if (before?.status !== 'Exiting') {
    await call('prepare_exit', new Writer().u32(feeBps).done(), 100);
  }
  const s = send ? await state() : before;
  // --prepare-only: measure now, so a NEAR Intents quote can be made for the exact amount
  if (send && s?.status === 'Exiting' && !argv.includes('--prepare-only')) {
    const intents = opt('intents');
    if (intents) await call('exit_to_intents', new Writer().str(intents).u128(s.exit_amount).done(), 100);
    else await call('exit_to_owner', new Writer().str(ownerId).str(salt()).done(), 100);
  }
} else if (step === 'close') {
  await call('finish_close', new Uint8Array(Buffer.from('{}')), 200);
} else {
  throw new Error(`Unknown step "${step}"`);
}
const after = send ? await state() : null;
if (after) console.log(`  state now ${JSON.stringify(after)}`);
