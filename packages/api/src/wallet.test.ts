import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { getDb } from '@racerbot/db';

process.env.KEY_ENCRYPTION_MASTER_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.MAIN_WALLET_PRIVATE_KEY =
  'ed25519:46rV5h6XvKY5wDGty1Jd3LeUePVvccfKGmdPtT7sUbyq1Tw7Z4e3mQZXvGKpq6rHpV8Xxto5GAaus5tWpdFfY4V4';
process.env.RACERBOT_PARENT_ACCOUNT = 'racerbot.near';

// Track calls and order across mock accounts
const callOrder: string[] = [];
const createAccountMock = vi.fn().mockImplementation(async () => {
  callOrder.push('createAccount');
  return {};
});
const addKeyMock = vi.fn().mockImplementation(async () => {
  callOrder.push('addKey');
  return {};
});
const deleteKeyMock = vi.fn().mockImplementation(async () => {
  callOrder.push('deleteKey');
  return {};
});

// Mock NEAR RPC at the network boundary (near-api-js connect/account)
vi.mock('near-api-js', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    connect: vi.fn().mockResolvedValue({
      account: vi.fn().mockImplementation(async (accountId: string) => {
        return {
          accountId,
          createAccount: createAccountMock,
          addKey: addKeyMock,
          deleteKey: deleteKeyMock,
        };
      }),
    }),
  };
});

// Import onboardUser and rotateUserKey after mocks
const { onboardUser, rotateUserKey } = await import('./wallet.js');

describe('wallet: onboarding and key rotation', () => {
  const testTelegramIds: number[] = [];

  function generateTelegramId(): number {
    const id = Math.floor(100000000 + Math.random() * 900000000);
    testTelegramIds.push(id);
    return id;
  }

  afterAll(async () => {
    // Clean up created test users from real database
    if (testTelegramIds.length > 0) {
      const db = await getDb();
      await db.query('DELETE FROM users WHERE telegram_id = ANY($1)', [testTelegramIds]);
    }
  });

  describe('1. Onboarding idempotency', () => {
    it('calling onboardUser twice returns same subaccount, creates on-chain once, and does not regenerate keypair', async () => {
      const telegramId = generateTelegramId();
      createAccountMock.mockClear();

      const first = await onboardUser(telegramId);
      expect(first.isExisting).toBe(false);
      expect(first.subaccountId).toBeDefined();
      expect(first.privateKey).toBeDefined();
      expect(createAccountMock).toHaveBeenCalledTimes(1);

      const second = await onboardUser(telegramId);
      expect(second.isExisting).toBe(true);
      expect(second.subaccountId).toBe(first.subaccountId);
      expect(second.userId).toBe(first.userId);
      // Second call does not submit a second create_account transaction
      expect(createAccountMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('2. Key rotation ordering', () => {
    it('adds new key before deleting old key in correct sequential order', async () => {
      const telegramId = generateTelegramId();
      await onboardUser(telegramId);

      callOrder.length = 0;
      addKeyMock.mockClear();
      deleteKeyMock.mockClear();

      const result = await rotateUserKey(telegramId);
      expect(result.success).toBe(true);
      expect(result.newPrivateKey).toBeDefined();

      expect(addKeyMock).toHaveBeenCalledTimes(1);
      expect(deleteKeyMock).toHaveBeenCalledTimes(1);
      expect(callOrder).toEqual(['addKey', 'deleteKey']);
    });

    it('never calls deleteKey if addKey fails', async () => {
      const telegramId = generateTelegramId();
      await onboardUser(telegramId);

      addKeyMock.mockRejectedValueOnce(new Error('RPC network timeout on addKey'));
      deleteKeyMock.mockClear();

      await expect(rotateUserKey(telegramId)).rejects.toThrow('RPC network timeout on addKey');
      expect(deleteKeyMock).not.toHaveBeenCalled();
    });

    it('rejects a second concurrent rotation call for the same user while one is in progress', async () => {
      const telegramId = generateTelegramId();
      await onboardUser(telegramId);

      // Make addKey hang until we release it
      let releaseAddKey: () => void = () => {};
      const hangingPromise = new Promise<void>((resolve) => {
        releaseAddKey = resolve;
      });
      addKeyMock.mockImplementationOnce(async () => {
        await hangingPromise;
        return {};
      });

      // Launch first rotation (in progress)
      const firstRotation = rotateUserKey(telegramId);

      // Launch concurrent second rotation: must be rejected immediately, not queued
      await expect(rotateUserKey(telegramId)).rejects.toThrow(
        /A key rotation is already in progress for this account/i,
      );

      // Release first rotation
      releaseAddKey();
      const res = await firstRotation;
      expect(res.success).toBe(true);
    });
  });
});
