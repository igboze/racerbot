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
};
const USER_COLUMNS: Record<RemoteSignChain, { address: string; key: string }> = {
  evm: { address: 'evm_address', key: 'evm_private_key_enc' },
  solana: { address: 'solana_address', key: 'solana_private_key_enc' },
  near: { address: 'subaccount_id', key: 'scoped_key_encrypted' },
};

// EVM addresses and NEAR account ids compare case-insensitively; Solana addresses do not
const normalize = (chain: RemoteSignChain, address: string) => (chain === 'solana' ? address : address.toLowerCase());

/** The encrypted key for this user's address on this chain, or null when it is not theirs */
export async function findSigningKey(userId: string, chain: RemoteSignChain, address: string): Promise<string | null> {
  const db = await getDb();
  const cols = USER_COLUMNS[chain];
  const wanted = normalize(chain, address);
  const cmp = chain === 'solana' ? '' : 'LOWER';
  const res = await db.query(
    `SELECT ${cols.key} AS key FROM users WHERE id = $1::uuid AND ${cmp}(${cols.address}) = $2::text AND ${cols.key} IS NOT NULL
     UNION ALL
     SELECT encrypted_private_key FROM user_wallets
       WHERE user_id = $1::uuid AND chain = ANY($3::text[]) AND ${cmp}(address) = $2::text
     UNION ALL
     SELECT encrypted_private_key FROM race_fleet_wallets
       WHERE user_id = $1::uuid AND chain = ANY($3::text[]) AND ${cmp}(account_id) = $2::text
     LIMIT 1`,
    [userId, wanted, WALLET_CHAINS[chain]]
  );
  const key = res.rows[0]?.key ?? null;
  // Wallets the user connected themselves have no key stored here
  return key && key !== 'EXTERNAL_CONNECTED_WALLET' ? key : null;
}

/** Every address on this chain that belongs to the user: transfers between them are not withdrawals */
export async function ownAddresses(userId: string, chain: RemoteSignChain): Promise<Set<string>> {
  const db = await getDb();
  const cols = USER_COLUMNS[chain];
  const res = await db.query(
    `SELECT ${cols.address} AS address FROM users WHERE id = $1::uuid AND ${cols.address} IS NOT NULL
     UNION
     SELECT address FROM user_wallets WHERE user_id = $1::uuid AND chain = ANY($2::text[])
     UNION
     SELECT account_id FROM race_fleet_wallets WHERE user_id = $1::uuid AND chain = ANY($2::text[])`,
    [userId, WALLET_CHAINS[chain]]
  );
  if (chain === 'near') {
    // The user's private-balance account and their confidential executors are theirs too
    const extra = await db.query(
      `SELECT private_account_id AS address FROM confidential_accounts WHERE user_id = $1::uuid
       UNION
       SELECT account_id FROM confidential_executors WHERE user_id = $1::uuid`,
      [userId]
    ).catch(() => ({ rows: [] as any[] }));
    for (const r of extra.rows) res.rows.push(r);
  }
  return new Set(res.rows.map((r: any) => normalize(chain, String(r.address))));
}
