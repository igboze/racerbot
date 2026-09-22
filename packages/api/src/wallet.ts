import { getDb } from './db.js';
import { encrypt, decrypt, generateScopedAccessKey, generateSeedPhrase } from '@racerbot/shared';

const MASTER_KEY = process.env.KEY_ENCRYPTION_MASTER_KEY!;

export async function onboardUser(telegramId: number) {
  const keypair = generateScopedAccessKey();
  const seedPhrase = generateSeedPhrase();
  const subaccountId = `${telegramId}.racerbot.near`;
  const encryptedKey = encrypt(JSON.stringify({ publicKey: keypair.publicKey, secretKey: keypair.secretKey }), MASTER_KEY);

  await (await import('./db.js')).createUser({
    telegram_id: telegramId,
    subaccount_id: subaccountId,
    scoped_key_encrypted: encryptedKey,
  });

  return { subaccountId, seedPhrase, publicKey: keypair.publicKey };
}

export async function getTokenInfo(tokenAddress: string) {
  const cached = await (await import('./db.js')).getTokenCache(tokenAddress);
  if (cached && cached.name && Date.now() - cached.updated_at.getTime() < 5000) {
    return cached;
  }
  const meta = { name: 'Token', symbol: 'TKN', decimals: 24, total_supply: '1000000' };
  const reserves = { price: '0.01', liquidity: '10000', totalSupply: '1000000', pool_address: '0x...', venue: 'rhea' };
  return { ...meta, ...reserves, marketCap: parseFloat(reserves.price) * parseFloat(reserves.totalSupply) };
}

export async function executeSwap(event: any) {
  const executor = new (await import('./executor.js')).SwapExecutor();
  return executor.execute(event);
}