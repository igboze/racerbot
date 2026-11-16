/**
 * The signer's rules for transactions it signs on a trader's behalf (swaps, fleet funding,
 * Kleos inbox orders). Withdrawals do not come here: they run inside the signer through
 * the money-out route with their own rules.
 *
 * Two tiers:
 * - hard: what only a theft looks like. Native funds or tokens leaving to an address that is
 *   not the user's own or RacerBot's fee wallet, token approvals to unknown spenders, account
 *   authority changes. A real trade never does these.
 * - soft: a call to a contract or program not on the allowlist yet. New launchpads and routers
 *   show up here first; the audit log says which ones to add.
 *
 * SIGNER_POLICY_MODE: monitor (default: log both, block nothing), enforce_hard (block hard),
 * enforce (block both). Extra allowlist entries: SIGNER_EVM_ALLOWED_CONTRACTS and
 * SIGNER_SOLANA_ALLOWED_PROGRAMS (comma separated).
 */
import { ethers } from 'ethers';
import { PublicKey, VersionedMessage } from '@solana/web3.js';
import {
  HYPERSWAP_V2_ROUTER,
  WHYPE_ADDRESS,
  MULTICALL3_ADDRESS,
  DEFAULT_EVM_TREASURY_ADDRESS,
  DEFAULT_SOLANA_DEV_FEE_WALLET,
  KLEOS,
  KLEOS_V5_DEPLOYMENTS,
  ELYSIUM_BRIDGE,
  RONSPAD,
} from '@racerbot/shared';

export type PolicyMode = 'monitor' | 'enforce_hard' | 'enforce';

export function policyMode(): PolicyMode {
  const m = (process.env.SIGNER_POLICY_MODE || 'monitor').trim().toLowerCase();
  return m === 'enforce' || m === 'enforce_hard' ? m : 'monitor';
}

export interface Findings {
  hard: string[];
  soft: string[];
}

/** Whether these findings block the signature in the current mode */
export function blocks(f: Findings, mode: PolicyMode = policyMode()): boolean {
  if (mode === 'enforce') return f.hard.length > 0 || f.soft.length > 0;
  if (mode === 'enforce_hard') return f.hard.length > 0;
  return false;
}

const envList = (name: string) =>
  (process.env[name] || '').split(',').map(s => s.trim()).filter(Boolean);

const addressesIn = (value: unknown): string[] => {
  if (typeof value === 'string') return /^0x[0-9a-fA-F]{40}$/.test(value) ? [value.toLowerCase()] : [];
  if (Array.isArray(value)) return value.flatMap(addressesIn);
  if (value && typeof value === 'object') return Object.values(value).flatMap(addressesIn);
  return [];
};

/** Contracts RacerBot trades through on HyperEVM and Elysium */
export function evmAllowedContracts(): Set<string> {
  return new Set([
    HYPERSWAP_V2_ROUTER, process.env.HYPEREVM_ROUTER_ADDRESS, WHYPE_ADDRESS, MULTICALL3_ADDRESS,
    ELYSIUM_BRIDGE.inbox, ELYSIUM_BRIDGE.bridge,
    ...addressesIn(KLEOS), ...addressesIn(KLEOS_V5_DEPLOYMENTS), ...addressesIn(RONSPAD),
    process.env.ELYSIUM_ROUTER_ADDRESS, process.env.ELYSIUM_COREPAD_ROUTER,
    ...envList('SIGNER_EVM_ALLOWED_CONTRACTS'),
  ].filter((a): a is string => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a)).map(a => a.toLowerCase()));
}

function evmFeeRecipients(): Set<string> {
  return new Set([DEFAULT_EVM_TREASURY_ADDRESS, process.env.EVM_TREASURY_ADDRESS, process.env.TREASURY_EVM_ADDRESS]
    .filter((a): a is string => Boolean(a)).map(a => a.toLowerCase()));
}

const ERC20 = new ethers.Interface([
  'function transfer(address to, uint256 amount)',
  'function transferFrom(address from, address to, uint256 amount)',
  'function approve(address spender, uint256 amount)',
  'function increaseAllowance(address spender, uint256 added)',
  'function setApprovalForAll(address operator, bool approved)',
  'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
]);

/** Checks one EVM transaction the signer is asked to sign for a trade */
export function evaluateEvmTx(tx: ethers.Transaction, own: Set<string>): Findings {
  const f: Findings = { hard: [], soft: [] };
  const allowed = evmAllowedContracts();
  const fees = evmFeeRecipients();
  const to = tx.to?.toLowerCase() ?? null;
  const data = tx.data && tx.data !== '0x' ? tx.data : null;
  const isKnown = (a: string) => allowed.has(a) || fees.has(a) || own.has(a);

  if (!to) {
    f.hard.push('contract deployment');
    return f;
  }
  if (!data) {
    // A plain HYPE transfer: only to the fee wallet or the user's own wallets
    if (tx.value > 0n && !fees.has(to) && !own.has(to)) f.hard.push(`sends ${ethers.formatEther(tx.value)} HYPE to ${to}`);
    return f;
  }
  if (allowed.has(to)) return f;

  // Not an allowlisted contract: token methods that move or unlock funds are theft-shaped
  let parsed: ethers.TransactionDescription | null = null;
  try {
    parsed = ERC20.parseTransaction({ data, value: tx.value });
  } catch {
    parsed = null;
  }
  if (parsed) {
    const name = parsed.name;
    if (name === 'transfer' || name === 'transferFrom') {
      const dest = String(parsed.args[name === 'transfer' ? 0 : 1]).toLowerCase();
      if (!own.has(dest) && !fees.has(dest)) f.hard.push(`token ${name} to ${dest} on ${to}`);
      return f;
    }
    if (name === 'approve' || name === 'increaseAllowance' || name === 'setApprovalForAll' || name === 'permit') {
      const spender = String(parsed.args[name === 'permit' ? 1 : 0]).toLowerCase();
      const revoking = (name === 'approve' && parsed.args[1] === 0n) || (name === 'setApprovalForAll' && parsed.args[1] === false);
      if (!revoking && !isKnown(spender)) f.hard.push(`token ${name} for unknown spender ${spender} on ${to}`);
      return f;
    }
  }
  f.soft.push(`call to contract not on the allowlist: ${to} (selector ${data.slice(0, 10)})`);
  if (tx.value > 0n) f.soft.push(`sends ${ethers.formatEther(tx.value)} HYPE to that contract`);
  return f;
}

const PROGRAMS = {
  system: '11111111111111111111111111111111',
  token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  token2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  ata: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
};

/** Programs RacerBot's Solana trades use */
export function solanaAllowedPrograms(): Set<string> {
  return new Set([
    ...Object.values(PROGRAMS),
    'ComputeBudget111111111111111111111111111111',
    'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter v6
    '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // pump.fun
    'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', // PumpSwap
    'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
    'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
    ...envList('SIGNER_SOLANA_ALLOWED_PROGRAMS'),
  ]);
}

const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

/** The user's wSOL accounts: a swap wraps SOL by transferring it there */
function ownWsolAccounts(own: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const owner of own) {
    try {
      const ownerKey = new PublicKey(owner);
      for (const program of [PROGRAMS.token, PROGRAMS.token2022]) {
        const [ata] = PublicKey.findProgramAddressSync(
          [ownerKey.toBuffer(), new PublicKey(program).toBuffer(), WSOL_MINT.toBuffer()],
          new PublicKey(PROGRAMS.ata)
        );
        out.add(ata.toBase58());
      }
    } catch {
      // not a Solana address
    }
  }
  return out;
}

/** Checks one Solana transaction message the signer is asked to sign for a trade */
export function evaluateSolanaMessage(message: VersionedMessage, own: Set<string>): Findings {
  const f: Findings = { hard: [], soft: [] };
  const allowedPrograms = solanaAllowedPrograms();
  const fee = DEFAULT_SOLANA_DEV_FEE_WALLET;
  const ownWsol = ownWsolAccounts(own);
  const keys = message.staticAccountKeys.map(k => k.toBase58());
  // Accounts loaded from lookup tables cannot be resolved offline
  const keyAt = (i: number): string | null => keys[i] ?? null;

  for (const ix of message.compiledInstructions) {
    const program = keyAt(ix.programIdIndex);
    if (!program) {
      f.soft.push('instruction program not resolvable');
      continue;
    }
    if (!allowedPrograms.has(program)) {
      f.soft.push(`program not on the allowlist: ${program}`);
      continue;
    }
    const data = Buffer.from(ix.data);
    const account = (n: number) => (ix.accountKeyIndexes[n] === undefined ? null : keyAt(ix.accountKeyIndexes[n]));

    if (program === PROGRAMS.system && data.length >= 4) {
      const kind = data.readUInt32LE(0);
      if (kind === 2) {
        // Transfer: only to the user's own wallets, their wSOL accounts or the fee wallet
        const dest = account(1);
        const lamports = data.length >= 12 ? data.readBigUInt64LE(4) : 0n;
        if (!dest) f.hard.push('SOL transfer to an address from a lookup table');
        else if (dest !== fee && !own.has(dest) && !ownWsol.has(dest)) f.hard.push(`sends ${Number(lamports) / 1e9} SOL to ${dest}`);
      } else if (kind === 1 || kind === 10) {
        f.hard.push('changes the owner program of an account (Assign)');
      }
    }

    if ((program === PROGRAMS.token || program === PROGRAMS.token2022) && data.length >= 1) {
      const kind = data[0];
      if (kind === 6) f.hard.push('changes a token account authority (SetAuthority)');
      else if (kind === 4 || kind === 13) f.hard.push('delegates a token account to someone else (Approve)');
      else if (kind === 9) {
        // CloseAccount: the rent must go back to the user
        const dest = account(1);
        if (!dest || (!own.has(dest) && dest !== fee)) f.hard.push(`closes a token account into ${dest ?? 'an unresolved address'}`);
      } else if (kind === 3 || kind === 12) {
        // Direct token transfers are not part of a swap; withdrawals use the money-out route
        f.soft.push('direct token transfer in a trade transaction');
      }
    }
  }
  return f;
}
