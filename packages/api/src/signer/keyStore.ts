/**
 * Where the signer finds a key: by owner and address only. A request names a user and an
 * address; the key is used only if that address really belongs to that user (their main
 * wallet, an imported wallet or one of their fleet wallets).
 */
import { getDb } from '@racerbot/db';
import type { RemoteSignChain } from '@racerbot/shared';

const WALLET_CHAINS: Record<RemoteSignChain, string[]> = {
  evm: ['hyperevm', 'elysium', 'evm'],
  solana: ['solana'],
  near: ['near'],
  sui: ['sui'],
  starknet: ['starknet'],
};
const USER_COLUMNS: Record<RemoteSignChain, { address: string; key: string }> = {
  evm: { address: 'evm_address', key: 'evm_private_key_enc' },
  solana: { address: 'solana_address', key: 'solana_private_key_enc' },
  near: { address: 'subaccount_id', key: 'scoped_key_encrypted' },
  sui: { address: 'sui_address', key: 'sui_private_key_enc' },
  starknet: { address: 'starknet_address', key: 'starknet_private_key_enc' },
};

/**
 * One spelling per address: Solana is case-sensitive; EVM, NEAR and Sui are lowercased;
 * Starknet felts are stored with and without leading zeros, so they compare by value.
 */
export function normalizeAddress(chain: RemoteSignChain, address: string): string {
  const a = String(address).trim();
  if (chain === 'solana') return a;
  if (chain === 'starknet') {
    try {
      return '0x' + BigInt(a).toString(16);
    } catch {
      return a.toLowerCase();
    }
  }
  return a.toLowerCase();
}

/** Every (address, encrypted key) the user has on this chain */
async function userKeys(userId: string, chain: RemoteSignChain): Promise<Array<{ address: string; key: string | null }>> {
  const db = await getDb();
  const cols = USER_COLUMNS[chain];
  const res = await db.query(
    `SELECT ${cols.address} AS address, ${cols.key} AS key FROM users WHERE id = $1::uuid AND ${cols.address} IS NOT NULL
     UNION ALL
     SELECT address, encrypted_private_key FROM user_wallets WHERE user_id = $1::uuid AND chain = ANY($2::text[])
     UNION ALL
     SELECT account_id, encrypted_private_key FROM race_fleet_wallets WHERE user_id = $1::uuid AND chain = ANY($2::text[])`,
    [userId, WALLET_CHAINS[chain]]
  );
  return res.rows.map((r: any) => ({ address: String(r.address), key: r.key ?? null }));
}

/** The encrypted key for this user's address on this chain, or null when it is not theirs */
export async function findSigningKey(userId: string, chain: RemoteSignChain, address: string): Promise<string | null> {
  const wanted = normalizeAddress(chain, address);
  const match = (await userKeys(userId, chain)).find(r => normalizeAddress(chain, r.address) === wanted && r.key);
  // Wallets the user connected themselves have no key stored here
  return match?.key && match.key !== 'EXTERNAL_CONNECTED_WALLET' ? match.key : null;
}

/** Every address on this chain that belongs to the user: transfers between them are not withdrawals */
export async function ownAddresses(userId: string, chain: RemoteSignChain): Promise<Set<string>> {
  const addresses = (await userKeys(userId, chain)).map(r => r.address);
  if (chain === 'near') {
    // The user's private-balance account and their confidential executors are theirs too
    const db = await getDb();
    const extra = await db.query(
      `SELECT private_account_id AS address FROM confidential_accounts WHERE user_id = $1::uuid
       UNION
       SELECT account_id FROM confidential_executors WHERE user_id = $1::uuid`,
      [userId]
    ).catch(() => ({ rows: [] as any[] }));
    for (const r of extra.rows) addresses.push(String(r.address));
  }
  return new Set(addresses.map(a => normalizeAddress(chain, a)));
}
