/**
 * RacerBot-managed NEAR wallets for Racer Alpha web users who sign in with their own NEAR wallet.
 *
 * The wallet is an implicit account: its address is the new key's public key, so creating it costs
 * RacerBot nothing (it cannot be farmed) and it exists on-chain once the user first sends NEAR to it.
 * Like a Telegram user's wallet, its key is generated and encrypted on the server and never leaves
 * it: no route returns it, so nothing in the browser (or its developer console) can see it.
 *
 * The connected wallet stays linked as the way to sign in, so the same signature that proves who the
 * user is keeps reaching this account.
 */
import { createLogger, encrypt, generateScopedAccessKey } from '@racerbot/shared';
import { createUserWallet, getUserById, getUserWallets, type UserRecord } from '@racerbot/db';

const logger = createLogger('web-wallet');
const MASTER_KEY = process.env.KEY_ENCRYPTION_MASTER_KEY || process.env.ENCRYPTION_MASTER_KEY || '';

/** user_wallets marker for a linked wallet RacerBot holds no key for */
export const EXTERNAL_WALLET_MARKER = 'EXTERNAL_CONNECTED_WALLET';

/** Whether RacerBot holds the key for the user's active NEAR wallet */
export function hasManagedWallet(user: Pick<UserRecord, 'scoped_key_encrypted'>): boolean {
  return Boolean(user.scoped_key_encrypted) && user.scoped_key_encrypted !== EXTERNAL_WALLET_MARKER;
}

/** NEAR implicit account ID of an ed25519 public key: its 32 bytes in hex */
export function implicitAccountId(publicKeyData: Uint8Array): string {
  return Buffer.from(publicKeyData).toString('hex');
}

const creating = new Set<string>();

/**
 * Give a signed-in web user a RacerBot-managed wallet and make it their active NEAR wallet.
 * Returns only the new public address. Idempotent: a user who already has one gets it back.
 */
export async function createWebManagedWallet(userId: string): Promise<{ address: string; created: boolean }> {
  if (!MASTER_KEY) throw new Error('Wallet creation is not configured on this server');
  if (creating.has(userId)) throw new Error('Your wallet is already being created');
  creating.add(userId);
  try {
    const user = await getUserById(userId);
    if (!user) throw new Error('Sign in again');
    if (hasManagedWallet(user)) return { address: user.subaccount_id, created: false };

    // Keep the wallet they signed in with linked, so its signature still finds this account
    const connected = user.subaccount_id;
    const linked = await getUserWallets(userId, 'near').catch(() => []);
    if (connected && !linked.some(w => w.address === connected)) {
      await createUserWallet({
        userId, chain: 'near', address: connected, name: 'Connected wallet',
        encryptedPrivateKey: EXTERNAL_WALLET_MARKER, isImported: true, isActive: false,
      });
    }

    const keyPair = generateScopedAccessKey();
    const address = implicitAccountId(keyPair.getPublicKey().data);
    await createUserWallet({
      userId, chain: 'near', address, name: 'RacerBot wallet',
      encryptedPrivateKey: encrypt(keyPair.toString(), MASTER_KEY), isImported: false, isActive: true,
    });
    logger.info(`Created managed web wallet ${address} for user ${userId}`);
    return { address, created: true };
  } finally {
    creating.delete(userId);
  }
}
