import 'dotenv/config';
import { getNear } from '@racerbot/shared';
import { KeyPair } from 'near-api-js';

async function main() {
  const contractId = process.env.ROUTER_CONTRACT_ID || 'racerbotrouter.near';
  const privateKey = (process.env.ROUTER_CONTRACT_PRIVATE_KEY || '').trim();

  console.log(`Checking account: ${contractId}`);
  const near = getNear();

  try {
    const account = await near.getAccount(contractId);
    const state = await account.state();
    console.log(`Account state:`, {
      amount: state.amount,
      formattedNear: (Number(BigInt(state.amount)) / 1e24).toFixed(4) + ' NEAR',
      code_hash: state.code_hash,
      isDeployed: state.code_hash !== '11111111111111111111111111111111',
    });

    if (privateKey) {
      const kp = KeyPair.fromString(privateKey);
      const pk = kp.getPublicKey().toString();
      console.log(`Configured public key: ${pk}`);
      await near.addKey(contractId, kp);
      const accessKeys = await account.getAccessKeys();
      const hasKey = accessKeys.some((k) => k.public_key === pk);
      console.log(`Key authorized on-chain: ${hasKey}`);
    }
  } catch (err) {
    console.error(`Check error:`, err.message);
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
