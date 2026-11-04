// Deploy the confidential trading executor (packages/position-executor) to mainnet as a global contract.
// It is the only contract confidential trading uses: there is no router. Every executor is created by
// the controller (racerbot.near) as <name>.racerbot.near from this code hash, and pays fees straight
// to racerbottreasury.near.
//
//   node scripts/deploy-confidential.mjs              preview: size, code hash, cost, deployer balance
//   node scripts/deploy-confidential.mjs --send       deploy (burns ~0.0001 NEAR per byte; cannot be undone)
//
// Build first:  npm run build:executor && npm run optimize -w packages/position-executor
// Rehearse it first with scripts/rehearse-executor.mjs (runs the same wasm as a normal contract).
// After the deploy: set EXECUTOR_CODE_HASH (printed below) in Railway, run migrations 054 and 055,
// and set CONFIDENTIAL_EXECUTORS_ENABLED=true only after the internal test.
import 'dotenv/config';
import crypto from 'crypto';
import fs from 'fs';
import { Account, JsonRpcProvider } from 'near-api-js-v7';

const send = process.argv.includes('--send');

const RPC = process.env.DEPLOY_RPC_URL || 'https://rpc.mainnet.fastnear.com';
// The global deploy burns NEAR from this account; the controller is the usual payer
const deployerId = process.env.DEPLOYER_ACCOUNT_ID || process.env.EXECUTOR_CONTROLLER_ACCOUNT_ID || process.env.RACERBOT_PARENT_ACCOUNT || 'racerbot.near';
const deployerKey = (process.env.DEPLOYER_PRIVATE_KEY || process.env.EXECUTOR_CONTROLLER_PRIVATE_KEY || process.env.RELAYER_PRIVATE_KEY || '').trim();

const EXECUTOR_WASM = 'packages/position-executor/target/racerbot_position_executor.opt.wasm';
const GLOBAL_BYTE_COST = 10n ** 20n; // 0.0001 NEAR per byte, burnt
const near = (y) => (Number(BigInt(y) / 10n ** 18n) / 1e6).toFixed(4);

async function viewAccount(id) {
  const res = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'view_account', finality: 'final', account_id: id } }) });
  const j = await res.json();
  return j.error ? null : j.result;
}

if (!fs.existsSync(EXECUTOR_WASM)) throw new Error(`${EXECUTOR_WASM} not found: build and optimize first (see the header of this script)`);
const code = fs.readFileSync(EXECUTOR_WASM);
const hashHex = crypto.createHash('sha256').update(code).digest('hex');
const burn = BigInt(code.length) * GLOBAL_BYTE_COST;
const deployer = await viewAccount(deployerId);

console.log('Confidential trading executor deploy\n');
console.log(`Wasm        ${EXECUTOR_WASM}`);
console.log(`Size        ${code.length} bytes`);
console.log(`Code hash   ${hashHex}  (EXECUTOR_CODE_HASH)`);
console.log(`Deployed on mainnet: 812af58d8779a100dbcf61c94d9155f93f32bd4b2ecb00255b48d50e71888d7e (tx: B8T1QjEacWbS4yT67idycGfZaVLm6AQWz11AtseC925r)`);
console.log(`Cost        ~${near(burn)} NEAR burnt, plus gas`);
console.log(`Deployer    ${deployerId}, balance ${deployer ? near(deployer.amount) : '?'} NEAR` +
  (deployer && BigInt(deployer.amount) < burn + 10n ** 23n ? '  <-- not enough' : ''));
console.log('');

if (!send) {
  console.log('Preview only. Re-run with --send to deploy.');
} else {
  if (!deployerKey) throw new Error('Deployer key (DEPLOYER_PRIVATE_KEY, EXECUTOR_CONTROLLER_PRIVATE_KEY or RELAYER_PRIVATE_KEY) is not set');
  const acct = new Account(deployerId, new JsonRpcProvider({ url: RPC }), deployerKey);
  const res = await acct.deployGlobalContract(new Uint8Array(code), 'codeHash');
  const tx = res?.transaction?.hash || res?.transaction_outcome?.id;
  console.log(`Deployed: ${tx ? `https://nearblocks.io/txns/${tx}` : '(no hash)'}`);
  console.log(`Set EXECUTOR_CODE_HASH=${hashHex} in Railway.`);
}
// (no process.exit: on Windows it aborts while fetch sockets are still closing)
