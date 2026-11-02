/**
 * Confidential recovery kit: what a user needs to get their money out of
 * their executors without RacerBot.
 *
 * Each executor accepts two calls from anyone who knows the owner's salt, and
 * both can only pay the owner's own address:
 * - `sweep(token, to, salt)`: move a token (not wNEAR) to the owner, any time.
 * - `owner_exit(to, salt)`: after 7 days without RacerBot activity, measure
 *   (first call) and then send (second call) the executor's NEAR to the owner.
 * Both take borsh arguments, so the kit carries them ready to paste.
 */
import { ownerHash } from './intentsPrivate.js';

export interface RecoveryExecutor {
  account_id: string;
  status: string;
  token: string | null;
}

/** Borsh string: u32 little-endian length, then UTF-8 bytes. */
function borshString(s: string): Buffer {
  const bytes = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([len, bytes]);
}

export function ownerExitArgs(payoutAddress: string, salt: string): string {
  return Buffer.concat([borshString(payoutAddress), borshString(salt)]).toString('base64');
}

export function sweepArgs(token: string, payoutAddress: string, salt: string): string {
  return Buffer.concat([borshString(token), borshString(payoutAddress), borshString(salt)]).toString('base64');
}

const NEAR_CLI_CALL = (account: string, method: string, args: string) =>
  `near contract call-function as-transaction ${account} ${method} base64-args '${args}' prepaid-gas '150.0 Tgas' attached-deposit '0 NEAR' sign-as <YOUR_ACCOUNT> network-config mainnet sign-with-keychain send`;

/** Executors still worth recovering from: anything not yet deleted. */
const LIVE = new Set(['creating', 'funding', 'ready', 'claimed', 'open', 'exiting', 'exited', 'failed']);

export function buildRecoveryKit(p: {
  payoutAddress: string;
  salt: string;
  executors: RecoveryExecutor[];
  generatedAt?: Date;
}) {
  const exitArgs = ownerExitArgs(p.payoutAddress, p.salt);
  const executors = p.executors
    .filter(e => LIVE.has(e.status))
    .map(e => ({
      account: e.account_id,
      statusAtExport: e.status,
      token: e.token,
      ownerExit: {
        argsBase64: exitArgs,
        command: NEAR_CLI_CALL(e.account_id, 'owner_exit', exitArgs),
      },
      ...(e.token && e.token !== 'wrap.near'
        ? {
          sweepToken: {
            argsBase64: sweepArgs(e.token, p.payoutAddress, p.salt),
            command: NEAR_CLI_CALL(e.account_id, 'sweep', sweepArgs(e.token, p.payoutAddress, p.salt)),
          },
        }
        : {}),
    }));

  return {
    kind: 'racerbot-confidential-recovery-kit',
    version: 1,
    generatedAt: (p.generatedAt ?? new Date()).toISOString(),
    payoutAddress: p.payoutAddress,
    ownerSalt: p.salt,
    ownerHash: ownerHash(p.salt, p.payoutAddress),
    executors,
    howToRecover: [
      'Keep this file private: the salt links these executors to your payout address. It cannot send money anywhere except your payout address.',
      'Tokens (not wNEAR): run the sweepToken command for an executor at any time. The token goes to your payout address.',
      'NEAR: if RacerBot has not touched an executor for 7 days, run its ownerExit command twice: the first call measures the NEAR, the second sends it to your payout address.',
      'Any NEAR account can send these calls (replace <YOUR_ACCOUNT>); it only pays the gas. Install near-cli-rs from https://github.com/near/near-cli-rs.',
      'Executors created after this export are not listed: download a new kit after you add funds.',
    ],
  };
}
