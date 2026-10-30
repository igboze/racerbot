// Deploy confidential trading (per-position executors) to mainnet, one step at a time.
// Preview by default (sizes, hashes, costs, balances); pass --send to submit the chosen step.
//
//   node scripts/deploy-confidential.mjs                     preview everything
//   node scripts/deploy-confidential.mjs executor --send     deploy the executor as a global contract (burns NEAR)
//   node scripts/deploy-confidential.mjs router --send       upgrade racerbotrouter.near
//   node scripts/deploy-confidential.mjs relayer --send [--fund 5]   create and fund relayer1.<owner>
//   node scripts/deploy-confidential.mjs config --send       set_executor_code + set_relayer on the router
//
// Build first:  npm run build:contract && npm run optimize -w packages/contract
//               npm run build:executor && npm run optimize -w packages/position-executor
// Then run migration 054 and 055 and set CONFIDENTIAL_EXECUTORS_ENABLED=true only after the internal test.
import 'dotenv/config';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Account, JsonRpcProvider, KeyPair } from 'near-api-js-v7';

const step = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'preview';
const send = process.argv.includes('--send');
const fundArg = process.argv.indexOf('--fund');
const relayerFund = fundArg > 0 ? Number(process.argv[fundArg + 1]) : 5;

const RPC = process.env.DEPLOY_RPC_URL || 'https://rpc.mainnet.fastnear.com';
const routerId = process.env.ROUTER_CONTRACT_ID || 'racerbotrouter.near';
const routerKey = (process.env.ROUTER_CONTRACT_PRIVATE_KEY || '').trim();
const ownerId = process.env.RACERBOT_PARENT_ACCOUNT || 'racerbot.near';
const ownerKey = (process.env.RELAYER_PRIVATE_KEY || process.env.MAIN_WALLET_PRIVATE_KEY || '').trim();
// The global deploy burns ~0.0001 NEAR per byte: pay it from an account that holds enough
const deployerId = process.env.DEPLOYER_ACCOUNT_ID || ownerId;
const deployerKey = (process.env.DEPLOYER_PRIVATE_KEY || ownerKey).trim();

const EXECUTOR_WASM = 'packages/position-executor/target/racerbot_position_executor.opt.wasm';
const ROUTER_WASM = 'packages/contract/target/racerbot_router.opt.wasm';
const GLOBAL_BYTE_COST = 10n ** 20n; // 0.0001 NEAR per byte, burnt
const STORAGE_BYTE_COST = 10n ** 19n; // 0.00001 NEAR per byte, staked

const provider = new JsonRpcProvider({ url: RPC });
const near = (y) => (Number(BigInt(y) / 10n ** 18n) / 1e6).toFixed(4);
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(buf) {
  let n = BigInt('0x' + buf.toString('hex'));
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b === 0) out = '1' + out; else break; }
  return out;
}

async function rpc(method, params) {
  const res = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
}
const viewAccount = (id) => rpc('query', { request_type: 'view_account', finality: 'final', account_id: id }).catch(() => null);

function readWasm(file) {
  if (!fs.existsSync(file)) throw new Error(`${file} not found: build and optimize first (see the header of this script)`);
  const code = fs.readFileSync(file);
  const hash = crypto.createHash('sha256').update(code).digest();
  return { code, size: code.length, hex: hash.toString('hex'), b58: base58(hash) };
}

function relayerAccounts() {
  const spec = (process.env.EXECUTOR_RELAYERS || '').split(',').map(s => s.trim()).filter(Boolean).map(s => s.split('=')[0]);
  if (spec.length) return spec;
  return process.env.EXECUTOR_RELAYER_ACCOUNT_ID ? [process.env.EXECUTOR_RELAYER_ACCOUNT_ID] : [];
}

function txLink(res) {
  const hash = res?.transaction?.hash || res?.transaction_outcome?.id;
  return hash ? `https://nearblocks.io/txns/${hash}` : '(no hash)';
}

// ── Preview ───────────────────────────────────────────────────────────────────
const executor = fs.existsSync(EXECUTOR_WASM) ? readWasm(EXECUTOR_WASM) : null;
const router = fs.existsSync(ROUTER_WASM) ? readWasm(ROUTER_WASM) : null;
const [routerState, deployerState] = await Promise.all([viewAccount(routerId), viewAccount(deployerId)]);

console.log('Confidential trading deploy\n');
if (executor) {
  console.log(`Executor   ${EXECUTOR_WASM}`);
  console.log(`           ${executor.size} bytes, code hash ${executor.b58} (hex ${executor.hex})`);
  const burn = BigInt(executor.size) * GLOBAL_BYTE_COST;
  console.log(`           global deploy burns ~${near(burn)} NEAR from ${deployerId} (balance ${deployerState ? near(deployerState.amount) : '?'} NEAR)` +
    (deployerState && BigInt(deployerState.amount) < burn + 10n ** 23n ? '  <-- fund it or set DEPLOYER_ACCOUNT_ID' : ''));
} else console.log(`Executor   ${EXECUTOR_WASM} missing: build and optimize it first`);
if (router) {
  console.log(`Router     ${ROUTER_WASM}`);
  console.log(`           ${router.size} bytes, code hash ${router.b58}; deployed now ${routerState?.code_hash ?? '?'}`);
  if (routerState) {
    const code = await rpc('query', { request_type: 'view_code', finality: 'final', account_id: routerId }).catch(() => null);
    const oldSize = code ? Buffer.from(code.code_base64, 'base64').length : 0;
    const usageAfter = BigInt(routerState.storage_usage) - BigInt(oldSize) + BigInt(router.size);
    const needed = usageAfter * STORAGE_BYTE_COST;
    console.log(`           storage after upgrade ~${usageAfter} bytes needs ${near(needed)} NEAR staked; router holds ${near(routerState.amount)} NEAR` +
      (BigInt(routerState.amount) < needed ? '  <-- top up the router first' : ''));
  }
} else console.log(`Router     ${ROUTER_WASM} missing: build and optimize it first`);
const relayers = relayerAccounts();
console.log(`Relayers   ${relayers.length ? relayers.join(', ') : '(none configured: run the relayer step)'}`);
console.log('');

if (step === 'preview') console.log('Steps: executor, router, relayer, config. Each needs --send to submit.');
else if (!send) console.log(`Preview of step "${step}" only. Re-run with --send to submit it.`);
else await runStep();

// ── Steps ─────────────────────────────────────────────────────────────────────
// (no process.exit: on Windows it aborts while fetch sockets are still closing)
async function runStep() {
if (step === 'executor') {
  if (!executor) throw new Error('Executor wasm missing');
  if (!deployerKey) throw new Error('Deployer key (DEPLOYER_PRIVATE_KEY or the owner key) is not set');
  const acct = new Account(deployerId, provider, deployerKey);
  const res = await acct.deployGlobalContract(new Uint8Array(executor.code), 'codeHash');
  console.log(`Executor deployed as global contract ${executor.b58}: ${txLink(res)}`);
} else if (step === 'router') {
  if (!router) throw new Error('Router wasm missing');
  if (!routerKey) throw new Error('ROUTER_CONTRACT_PRIVATE_KEY is not set');
  const acct = new Account(routerId, provider, routerKey);
  const res = await acct.deployContract(new Uint8Array(router.code));
  console.log(`Router upgraded to ${router.b58}: ${txLink(res)}`);
} else if (step === 'relayer') {
  if (!ownerKey) throw new Error('Owner key is not set');
  const name = process.env.EXECUTOR_RELAYER_NAME || 'relayer1';
  const keyPair = KeyPair.fromRandom('ed25519');
  const acct = new Account(ownerId, provider, ownerKey);
  const res = await acct.createSubAccount({
    accountOrPrefix: name,
    publicKey: keyPair.getPublicKey().toString(),
    nearToTransfer: BigInt(Math.round(relayerFund * 1e6)) * 10n ** 18n,
  });
  const accountId = `${name}.${ownerId}`;
  fs.mkdirSync('.secrets', { recursive: true });
  const file = path.join('.secrets', `${accountId}.json`);
  fs.writeFileSync(file, JSON.stringify({ account_id: accountId, private_key: keyPair.toString() }, null, 2), { mode: 0o600 });
  console.log(`Created ${accountId} with ${relayerFund} NEAR: ${txLink(res)}`);
  console.log(`Key saved to ${file} (gitignored). Set EXECUTOR_RELAYERS=${accountId}=<private_key> in Railway, then run the config step.`);
} else if (step === 'config') {
  if (!executor) throw new Error('Executor wasm missing (its hash is what the router is told to use)');
  if (!ownerKey) throw new Error('Owner key is not set');
  if (relayers.length === 0) throw new Error('No relayer configured (EXECUTOR_RELAYERS or EXECUTOR_RELAYER_ACCOUNT_ID)');
  const acct = new Account(ownerId, provider, ownerKey);
  const gas = 30n * 10n ** 12n;
  await acct.callFunction({ contractId: routerId, methodName: 'set_executor_code', args: { code_hash: executor.hex }, gas });
  console.log(`set_executor_code ${executor.hex}: ok`);
  for (const r of relayers) {
    await acct.callFunction({ contractId: routerId, methodName: 'set_relayer', args: { account_id: r, allowed: true }, gas });
    console.log(`set_relayer ${r}: ok`);
  }
} else {
  throw new Error(`Unknown step "${step}" (executor, router, relayer, config)`);
}
}
