// Owner-only router ledger correction for a swap flagged by an `unaccounted_output` event.
// Preview by default; pass --send to submit reconcile_ledger from the owner account.
//
//   node scripts/reconcile-ledger.mjs <user> <debitToken> <debitAmount> <creditToken> <creditAmount> <txHash> [--send]
import 'dotenv/config';
import { getNear } from '@racerbot/shared';
import { KeyPair, transactions } from 'near-api-js';

const args = process.argv.slice(2).filter(a => a !== '--send');
const send = process.argv.includes('--send');
if (args.length !== 6) {
  console.error('Usage: node scripts/reconcile-ledger.mjs <user> <debitToken> <debitAmount> <creditToken> <creditAmount> <txHash> [--send]');
  process.exit(1);
}
const [user, debitToken, debitAmount, creditToken, creditAmount, reference] = args;
const routerId = process.env.ROUTER_CONTRACT_ID || 'racerbotrouter.near';
const ownerId = process.env.RACERBOT_PARENT_ACCOUNT || 'racerbot.near';
const ownerKey = (process.env.RELAYER_PRIVATE_KEY || process.env.MAIN_WALLET_PRIVATE_KEY || '').trim();

const near = getNear();
const balance = (token) => near.view(routerId, 'vault_balance', { user, token });

console.log(`Router ${routerId}, owner ${ownerId}`);
console.log(`Ledger now: ${debitToken}=${await balance(debitToken)}  ${creditToken}=${await balance(creditToken)}`);
console.log(`Change:     -${debitAmount} ${debitToken}  +${creditAmount} ${creditToken}  (reference ${reference})`);

if (!send) {
  console.log('Preview only. Re-run with --send to submit.');
  process.exit(0);
}
if (!ownerKey) throw new Error('Owner key (RELAYER_PRIVATE_KEY / MAIN_WALLET_PRIVATE_KEY) is not set');

await near.addKey(ownerId, KeyPair.fromString(ownerKey));
const res = await near.signAndSendTransactionAll(ownerId, routerId, [
  transactions.functionCall('reconcile_ledger', {
    user, debit_token: debitToken, debit_amount: debitAmount,
    credit_token: creditToken, credit_amount: creditAmount, reference,
  }, BigInt('30000000000000'), 0n),
]);
const txHash = res?.transaction?.hash || res?.transaction_outcome?.id;
if (res?.status?.Failure) throw new Error(`reconcile_ledger failed: ${JSON.stringify(res.status.Failure)}`);
console.log(`Submitted: https://nearblocks.io/txns/${txHash}`);
console.log(`Ledger after: ${debitToken}=${await balance(debitToken)}  ${creditToken}=${await balance(creditToken)}`);
process.exit(0);
