import 'dotenv/config';
import { getNear, NEAR_USDC_CONTRACT } from '@racerbot/shared';
import { KeyPair, transactions, utils } from 'near-api-js';

const ROUTER_ACCOUNT = process.env.ROUTER_CONTRACT_ID || 'racerbotrouter.near';
const BENEFICIARY = 'racerbot.near';
const ROUTER_KEY = (process.env.ROUTER_CONTRACT_PRIVATE_KEY || '').trim();

if (!ROUTER_KEY) {
  console.error('ROUTER_CONTRACT_PRIVATE_KEY is not configured in .env');
  process.exit(1);
}

async function main() {
  console.log(`=== CLOSING CONTRACT & SWEEPING FUNDS ===`);
  console.log(`Source Account:      ${ROUTER_ACCOUNT}`);
  console.log(`Beneficiary Account: ${BENEFICIARY}\n`);

  const near = getNear();
  const kp = KeyPair.fromString(ROUTER_KEY);
  await near.addKey(ROUTER_ACCOUNT, kp);
  const account = await near.getAccount(ROUTER_ACCOUNT);

  // 1. Check initial state
  const state = await account.state();
  console.log(`Initial Native NEAR: ${(Number(BigInt(state.amount)) / 1e24).toFixed(4)} NEAR`);
  console.log(`Code Hash: ${state.code_hash}\n`);

  // 2. Tokens to sweep
  const tokens = [
    { id: NEAR_USDC_CONTRACT, name: 'USDC' },
    { id: 'nearly-993927.nearlytrade.near', name: 'NEARLY-993927' },
    { id: 'batman-4.nearlytrade.near', name: 'BATMAN-4' },
    { id: 'wrap.near', name: 'wNEAR' },
  ];

  for (const token of tokens) {
    try {
      const bal = await near.view(token.id, 'ft_balance_of', { account_id: ROUTER_ACCOUNT }).catch(() => '0');
      if (bal && bal !== '0' && BigInt(bal) > 0n) {
        console.log(`Found ${token.name} (${token.id}) balance: ${bal}`);

        // Ensure storage on beneficiary
        try {
          const benefStorage = await near.view(token.id, 'storage_balance_of', { account_id: BENEFICIARY }).catch(() => null);
          if (!benefStorage) {
            console.log(`Registering storage for ${BENEFICIARY} on ${token.name}...`);
            await account.functionCall({
              contractId: token.id,
              methodName: 'storage_deposit',
              args: { account_id: BENEFICIARY, registration_only: true },
              gas: BigInt('30000000000000'),
              attachedDeposit: BigInt(utils.format.parseNearAmount('0.00125')),
            });
            console.log(`Storage registered for ${BENEFICIARY}`);
          }
        } catch (storageErr) {
          console.warn(`Storage check/deposit warning for ${token.name}:`, storageErr.message);
        }

        // Transfer token to beneficiary
        console.log(`Transferring ${bal} of ${token.name} to ${BENEFICIARY}...`);
        const transferRes = await account.functionCall({
          contractId: token.id,
          methodName: 'ft_transfer',
          args: { receiver_id: BENEFICIARY, amount: bal },
          gas: BigInt('30000000000000'),
          attachedDeposit: BigInt('1'),
        });
        console.log(`Transferred ${token.name}. Tx: ${transferRes.transaction?.hash || 'OK'}`);
      } else {
        console.log(`No balance for ${token.name} (${token.id}): 0`);
      }
    } catch (err) {
      console.warn(`Error processing ${token.name}:`, err.message);
    }
  }

  // 3. Verify FT balances
  console.log('\n--- Verifying All Token Balances are 0 ---');
  for (const token of tokens) {
    try {
      const bal = await near.view(token.id, 'ft_balance_of', { account_id: ROUTER_ACCOUNT }).catch(() => '0');
      console.log(`${token.name} final balance: ${bal || '0'}`);
    } catch {
      console.log(`${token.name} final balance: 0`);
    }
  }

  // 4. Close the contract and delete account / sweep all native NEAR
  console.log(`\nClosing contract on ${ROUTER_ACCOUNT} and sending all native NEAR to ${BENEFICIARY}...`);
  try {
    const deleteRes = await account.deleteAccount(BENEFICIARY);
    console.log(`Account ${ROUTER_ACCOUNT} successfully deleted and contract closed!`);
    console.log(`Delete Tx Hash: ${deleteRes.transaction?.hash || 'OK'}`);
  } catch (err) {
    console.error(`deleteAccount failed: ${err.message}`);
    console.log('Attempting alternative: clearing contract code and sweeping NEAR balance...');

    // Alternative: clear WASM code
    try {
      await account.signAndSendTransaction({
        receiverId: ROUTER_ACCOUNT,
        actions: [transactions.deployContract(new Uint8Array(0))],
      });
      console.log('Contract code cleared (undeployed).');
    } catch (codeErr) {
      console.warn('Could not clear code:', codeErr.message);
    }

    // Sweep native NEAR
    const updatedState = await account.state();
    const nearYocto = BigInt(updatedState.amount);
    const gasReserve = BigInt(utils.format.parseNearAmount('0.01'));
    if (nearYocto > gasReserve) {
      const sendAmount = nearYocto - gasReserve;
      console.log(`Sweeping ${(Number(sendAmount) / 1e24).toFixed(4)} NEAR to ${BENEFICIARY}...`);
      await account.sendMoney(BENEFICIARY, sendAmount);
      console.log('NEAR sweep complete.');
    }
  }

  console.log('\n=== DONE ===');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});

