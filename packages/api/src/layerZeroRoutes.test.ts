const MASTER_KEY = 'test-master-key-32-bytes-long-for-tests';
process.env.KEY_ENCRYPTION_MASTER_KEY = MASTER_KEY;

import { describe, it, expect, vi } from 'vitest';
import { ethers } from 'ethers';
import { buildBridgeMenu, registerLayerZeroRoutes } from './layerZeroRoutes.js';
import { encrypt } from '@racerbot/shared';
import * as db from '@racerbot/db';

describe('LayerZero Routes & UI Module', () => {
  const TEST_WALLET = ethers.Wallet.createRandom();
  const TEST_USER: any = {
    id: '123e4567-e89b-12d3-a456-426614174000',
    telegram_id: 99887766,
    evm_address: TEST_WALLET.address,
    evm_private_key_enc: encrypt(TEST_WALLET.privateKey, MASTER_KEY),
  };

  it('builds interactive LayerZero bridge menu with sovereign EOA banner and balances', async () => {
    vi.spyOn(db, 'getUserByTelegramId').mockResolvedValue(TEST_USER);

    const menu = await buildBridgeMenu(TEST_USER.telegram_id, {
      sourceChain: 'base',
      destChain: 'arbitrum',
      asset: 'USDC',
      amount: '50.0',
    });

    expect(menu.text).toContain('LayerZero & Stargate V2 Bridge');
    expect(menu.text).toContain(TEST_WALLET.address);
    expect(menu.text).toContain('Universal Sovereign EVM Wallet');
    expect(menu.text).toContain('funds cannot be trapped');
    expect(menu.text).toContain('Base');
    expect(menu.text).toContain('Arbitrum');
    expect(menu.text).toContain('50.0 USDC');

    // Inline keyboard checks
    expect(menu.keyboard).toBeDefined();
    const rows = menu.keyboard.reply_markup.inline_keyboard;
    expect(rows.length).toBeGreaterThanOrEqual(5);

    // Route buttons present
    const flattened = rows.flat();
    const routeBtn = flattened.find((b: any) => b.callback_data?.includes('lz_route:base:arbitrum'));
    expect(routeBtn).toBeDefined();

    // Confirm button present
    const confirmBtn = flattened.find((b: any) => b.callback_data?.includes('lz_confirm:base:arbitrum:USDC:50.0'));
    expect(confirmBtn).toBeDefined();
  });

  it('registers commands and action handlers onto Telegraf bot', () => {
    const registeredCommands: string[] = [];
    const registeredActions: any[] = [];

    const mockBot: any = {
      command: vi.fn((cmd: any) => {
        if (Array.isArray(cmd)) registeredCommands.push(...cmd);
        else registeredCommands.push(cmd);
      }),
      action: vi.fn((act: any) => {
        registeredActions.push(act);
      }),
    };

    registerLayerZeroRoutes(mockBot);

    expect(registeredCommands).toContain('bridge');
    expect(registeredCommands).toContain('lz');
    expect(registeredCommands).toContain('stargate');
    expect(registeredCommands).toContain('layerzero');
    expect(mockBot.action).toHaveBeenCalledWith('menu_bridge', expect.any(Function));
    expect(registeredActions.some((a) => a instanceof RegExp && a.test('lz_confirm:base:arbitrum:USDC:10.0'))).toBe(true);
  });
});
