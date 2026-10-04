import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  getDb,
  createUser,
  createPosition,
  createFill,
  getPositionById,
  getUserWallets,
  getActiveWallet,
  createUserWallet,
  setActiveWallet,
  renameUserWallet,
  deleteUserWallet,
} from './db.js';

describe('db: fill idempotency and position math', () => {
  const telegramId = Math.floor(300000000 + Math.random() * 600000000);
  let userId: string;
  const tokenAddress = `token-${Date.now()}.near`;

  beforeAll(async () => {
    const user = await createUser({
      telegram_id: telegramId,
      subaccount_id: `test-${telegramId}.racerbot.near`,
      scoped_key_encrypted: 'dummy_encrypted_key',
    });
    userId = user.id;
  });

  afterAll(async () => {
    const db = await getDb();
    if (userId) {
      await db.query('DELETE FROM users WHERE id = $1', [userId]);
    }
  });

  describe('5. Fill idempotency', () => {
    it('creates only one fill row for duplicate tx_hash and position reflects single fill', async () => {
      // Create a position with zero values (genuinely empty starting position)
      const position = await createPosition({
        user_id: userId,
        token_address: tokenAddress,
        quantity_held: '0',
        avg_entry_price: '0',
      });

      const txHash = `tx-${Date.now()}-${Math.random()}`;

      // First call to createFill with a specific amount and price
      const firstResult = await createFill({
        user_id: userId,
        position_id: position.id,
        side: 'buy',
        token_address: tokenAddress,
        amount: '100',
        price: '1.5',
        fee_paid: '0.01',
        venue: 'rhea',
        tx_hash: txHash,
      });

      // Assert the first call was inserted
      expect(firstResult.inserted).toBe(true);

      // Query the position and assert it now reflects the first fill
      const posAfterFirst = await getPositionById(position.id);
      expect(Number(posAfterFirst?.quantity_held)).toBe(100);
      expect(Number(posAfterFirst?.avg_entry_price)).toBeCloseTo(1.5, 2);

      // Second call to createFill with same tx_hash but different amount and price
      const secondResult = await createFill({
        user_id: userId,
        position_id: position.id,
        side: 'buy',
        token_address: tokenAddress,
        amount: '200',
        price: '2.5',
        fee_paid: '0.02',
        venue: 'shardsmarket',
        tx_hash: txHash,
      });

      // Assert the second call was NOT inserted (duplicate)
      expect(secondResult.inserted).toBe(false);

      // Assert only one row exists in fills for that tx_hash
      const db = await getDb();
      const fillsRes = await db.query('SELECT * FROM fills WHERE tx_hash = $1', [txHash]);
      expect(fillsRes.rows.length).toBe(1);
      expect(fillsRes.rows[0].amount).toBe('100');

      // Assert position quantity_held and avg_entry_price are unchanged from the first fill
      // This proves the second call was correctly ignored by the position math
      const posAfterSecond = await getPositionById(position.id);
      expect(Number(posAfterSecond?.quantity_held)).toBe(100);
      expect(Number(posAfterSecond?.avg_entry_price)).toBeCloseTo(1.5, 2);
    });
  });

  describe('6. Position math', () => {
    it('calculates weighted average entry price across two buys, and preserves avg_entry_price on partial sell with exact realized PNL', async () => {
      const db = await getDb();
      const token = `token-math-${Date.now()}.near`;

      // Initial position with 0 quantity
      const position = await createPosition({
        user_id: userId,
        token_address: token,
        quantity_held: '0',
        avg_entry_price: '0',
      });

      // Buy 1: 100 tokens at price 1.0 NEAR, 0 fee
      await db.query('SELECT update_position_fill($1, $2, $3, $4, $5)', [
        position.id,
        'buy',
        100,
        1.0,
        0,
      ]);

      let pos = await getPositionById(position.id);
      expect(Number(pos?.quantity_held)).toBe(100);
      expect(Number(pos?.avg_entry_price)).toBe(1.0);

      // Buy 2: 100 tokens at price 2.0 NEAR, 0 fee
      // Total cost = (100 * 1.0) + (100 * 2.0) = 300. Total qty = 200. Avg price = 1.5
      await db.query('SELECT update_position_fill($1, $2, $3, $4, $5)', [
        position.id,
        'buy',
        100,
        2.0,
        0,
      ]);

      pos = await getPositionById(position.id);
      const expectedAvgEntryPrice = (100 * 1.0 + 100 * 2.0) / (100 + 100); // 1.5
      expect(Number(pos?.quantity_held)).toBe(200);
      expect(Number(pos?.avg_entry_price)).toBe(expectedAvgEntryPrice);

      // Partial sell: sell 50 tokens at price 2.5 NEAR
      const sellPrice = 2.5;
      const quantitySold = 50;
      await db.query('SELECT update_position_fill($1, $2, $3, $4, $5)', [
        position.id,
        'sell',
        quantitySold,
        sellPrice,
        0,
      ]);

      pos = await getPositionById(position.id);
      // Assert quantity_held decreased by 50 to 150
      expect(Number(pos?.quantity_held)).toBe(150);
      // Assert avg_entry_price is unchanged after partial sell
      expect(Number(pos?.avg_entry_price)).toBe(expectedAvgEntryPrice);

      // Assert realized PNL matches (sell_price - avg_entry_price) * quantity_sold exactly
      const realizedPnl = (sellPrice - expectedAvgEntryPrice) * quantitySold;
      expect(realizedPnl).toBe((2.5 - 1.5) * 50); // 50.0
    });
  });

  describe('6. Multi-Wallet Management (Option A)', () => {
    it('creates initial default wallet automatically on user creation', async () => {
      const wallets = await getUserWallets(userId, 'near');
      expect(wallets.length).toBeGreaterThanOrEqual(1);
      const active = await getActiveWallet(userId, 'near');
      expect(active).not.toBeNull();
      expect(active?.is_active).toBe(true);
      expect(active?.name).toBe('Wallet 1');
    });

    it('creates an imported wallet and allows setting it active', async () => {
      const importedAddress = `imported-${Date.now()}.near`;
      const importedWallet = await createUserWallet({
        userId,
        chain: 'near',
        address: importedAddress,
        name: 'Sniper',
        encryptedPrivateKey: 'encrypted_priv_key_sniper',
        isImported: true,
        isActive: true,
      });

      expect(importedWallet.is_imported).toBe(true);
      expect(importedWallet.is_active).toBe(true);
      expect(importedWallet.name).toBe('Sniper');

      // Check that only ONE wallet is active now
      const wallets = await getUserWallets(userId, 'near');
      const activeWallets = wallets.filter(w => w.is_active);
      expect(activeWallets.length).toBe(1);
      expect(activeWallets[0].id).toBe(importedWallet.id);

      // Check that users table was updated with the active wallet credentials
      const db = await getDb();
      const userRes = await db.query('SELECT subaccount_id, scoped_key_encrypted FROM users WHERE id = $1', [userId]);
      expect(userRes.rows[0].subaccount_id).toBe(importedAddress);
      expect(userRes.rows[0].scoped_key_encrypted).toBe('encrypted_priv_key_sniper');
    });

    it('allows switching active wallet back to Wallet 1', async () => {
      const wallets = await getUserWallets(userId, 'near');
      const defaultWallet = wallets.find(w => w.name === 'Wallet 1')!;
      expect(defaultWallet).toBeDefined();

      const switched = await setActiveWallet(userId, 'near', defaultWallet.id);
      expect(switched.is_active).toBe(true);
      expect(switched.name).toBe('Wallet 1');

      const active = await getActiveWallet(userId, 'near');
      expect(active?.id).toBe(defaultWallet.id);

      // Users table is synced back to default wallet
      const db = await getDb();
      const userRes = await db.query('SELECT subaccount_id FROM users WHERE id = $1', [userId]);
      expect(userRes.rows[0].subaccount_id).toBe(defaultWallet.address);
    });

    it('allows renaming a wallet', async () => {
      const wallets = await getUserWallets(userId, 'near');
      const imported = wallets.find(w => w.is_imported)!;
      expect(imported).toBeDefined();

      const renamed = await renameUserWallet(userId, imported.id, 'Degen Main');
      expect(renamed.name).toBe('Degen Main');

      const rechecked = await getUserWallets(userId, 'near');
      const found = rechecked.find(w => w.id === imported.id);
      expect(found?.name).toBe('Degen Main');
    });

    it('prevents deleting primary default wallet', async () => {
      const wallets = await getUserWallets(userId, 'near');
      const defaultWallet = wallets.find(w => !w.is_imported)!;
      await expect(deleteUserWallet(userId, defaultWallet.id)).rejects.toThrow('Cannot delete your primary generated wallet.');
    });

    it('allows deleting an imported wallet and falls back gracefully if active', async () => {
      const wallets = await getUserWallets(userId, 'near');
      const imported = wallets.find(w => w.is_imported)!;

      // Set it active first
      await setActiveWallet(userId, 'near', imported.id);

      // Now delete it
      const res = await deleteUserWallet(userId, imported.id);
      expect(res.success).toBe(true);
      expect(res.fallbackWallet).toBeDefined();
      expect(res.fallbackWallet?.is_active).toBe(true);

      const remaining = await getUserWallets(userId, 'near');
      expect(remaining.some(w => w.id === imported.id)).toBe(false);
    });
  });
});
