const MASTER_KEY = 'test-master-key-32-bytes-long-for-tests';
process.env.KEY_ENCRYPTION_MASTER_KEY = MASTER_KEY;

import { describe, it, expect, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  getUserEvmSigner,
  planCrossChain1ClickBuy,
  executeLayerZeroBridge,
} from './layerZeroBridge.js';
import { encrypt } from '@racerbot/shared';
import * as db from '@racerbot/db';

describe('LayerZero Bridge & 1-Click Buy API Module', () => {

  const TEST_WALLET = ethers.Wallet.createRandom();
  const TEST_USER: any = {
    id: '123e4567-e89b-12d3-a456-426614174000',
    telegram_id: 99887766,
    evm_address: TEST_WALLET.address,
    evm_private_key_enc: encrypt(TEST_WALLET.privateKey, MASTER_KEY),
  };

  it('verifies sovereign EVM wallet and returns signer', async () => {
    vi.spyOn(db, 'getUserById').mockResolvedValue(TEST_USER);

    const { wallet, user } = await getUserEvmSigner(TEST_USER.id, 'arbitrum');
    expect(wallet.address.toLowerCase()).toBe(TEST_WALLET.address.toLowerCase());
    expect(user.id).toBe(TEST_USER.id);
  });

  it('rejects user without EVM wallet with helpful instruction', async () => {
    vi.spyOn(db, 'getUserById').mockResolvedValue({
      id: 'no-evm',
      telegram_id: 111,
      evm_address: null,
      evm_private_key_enc: null,
    } as any);

    await expect(getUserEvmSigner('no-evm', 'arbitrum')).rejects.toThrow(
      'No EVM wallet found for this account. Run /wallet to initialize your unified EVM address.'
    );
  });

  it('rejects Starknet recipient addresses during bridge execution to prevent trapped funds', async () => {
    vi.spyOn(db, 'getUserById').mockResolvedValue(TEST_USER);

    const starknetRecipient = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';

    await expect(
      executeLayerZeroBridge({
        userId: TEST_USER.id,
        sourceChain: 'base',
        destChain: 'arbitrum',
        asset: 'USDC',
        humanAmount: '10.0',
        recipientAddress: starknetRecipient,
      })
    ).rejects.toThrow('Invalid recipient address');
  });

  it('enforces pre-flight native gas and balance checks before broadcasting', async () => {
    vi.spyOn(db, 'getUserById').mockResolvedValue(TEST_USER);

    // Wallet has 0 balance on mock provider
    await expect(
      executeLayerZeroBridge({
        userId: TEST_USER.id,
        sourceChain: 'arbitrum',
        destChain: 'base',
        asset: 'ETH',
        humanAmount: '1.0',
      })
    ).rejects.toThrow(/Insufficient ETH balance|Insufficient native gas/);
  });
});
