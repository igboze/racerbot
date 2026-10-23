import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { getNear } from '@racerbot/shared';
import { KeyPair, transactions } from 'near-api-js';

async function main() {
  const contractId = process.env.ROUTER_CONTRACT_ID || 'racerbotrouter.near';
  const privateKey = (process.env.ROUTER_CONTRACT_PRIVATE_KEY || '').trim();
  const parentAccount = process.env.RACERBOT_PARENT_ACCOUNT || 'racerbot.near';
  const treasuryAccount = process.env.TREASURY_ACCOUNT_ID || 'racerbottreasury.near';

  const wasmPath = path.resolve('packages/contract/target/wasm32-unknown-unknown/release/racerbot_router.wasm');
  if (!fs.existsSync(wasmPath)) {
    throw new Error(`WASM binary not found at ${wasmPath}`);
  }
  const wasmBytes = fs.readFileSync(wasmPath);
  console.log(`WASM size: ${Math.round(wasmBytes.length / 1024)} KB`);

  const near = getNear();
  const kp = KeyPair.fromString(privateKey);
  await near.addKey(contractId, kp);
  const account = await near.getAccount(contractId);

  console.log(`Checking existing state for ${contractId}...`);
  const currentState = await account.state();
  const isAlreadyInitialized = currentState.code_hash !== '11111111111111111111111111111111';

  console.log(`Deploying updated contract code to ${contractId}...`);
  const deployAction = transactions.deployContract(wasmBytes);
  const actions = [deployAction];

  if (!isAlreadyInitialized) {
    console.log('Initializing fresh contract state...');
    actions.push(
      transactions.functionCall(
        'new',
        {
          owner_id: parentAccount,
          treasury_id: treasuryAccount,
          buy_fee_bps: 150,
          sell_fee_bps: 150,
          snipe_fee_bps: 250,
        },
        BigInt('30000000000000'), // 30 Tgas
        0n
      )
    );
  } else {
    console.log('Contract already initialized. Performing seamless in-place code upgrade.');
  }

  const res = await account.signAndSendTransaction({
    receiverId: contractId,
    actions,
  });

  const txHash = res?.transaction?.hash || res?.transaction_outcome?.id;
  console.log(`Deployment and initialization successful!`);
  console.log(`Tx: https://nearblocks.io/txns/${txHash}`);

  // Verify on-chain deployment
  const state = await account.state();
  console.log(`Updated Code Hash: ${state.code_hash}`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('Deployment error:', err);
  process.exit(1);
});
