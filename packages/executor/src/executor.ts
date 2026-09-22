import { decrypt } from '@racerbot/shared';
import { getDb } from './db.js';
import { MAIN_WALLET_PRIVATE_KEY } from './config.js';

const MASTER_KEY = process.env.KEY_ENCRYPTION_MASTER_KEY!;

export class SwapExecutor {
  private walletKey: string;

  constructor() {
    this.walletKey = MAIN_WALLET_PRIVATE_KEY;
    if (!this.walletKey) {
      throw new Error('MAIN_WALLET_PRIVATE_KEY is required');
    }
  }

  async execute(event: any) {
    const { user_id, token_in, token_out, amount_in, min_amount_out, venue } = event;
    const user = await (await import('./db.js')).getUserById(user_id);
    if (!user) throw new Error('User not found');

    const keyData = decrypt(user.scoped_key_encrypted, MASTER_KEY);
    if (!keyData) throw new Error('Failed to decrypt scoped key');

    const result = await this.sendSwap(user_id, { token_in, token_out, amount_in, min_amount_out, venue });
    await this.recordFill(user_id, token_out, amount_in, result);
    return result;
  }

  private async sendSwap(userId: string, params: any) {
    return { tx_hash: '0x' + Math.random().toString(16).slice(2), position_id: userId };
  }

  private async recordFill(userId: string, tokenOut: string, amount: string, result: any) {
    await (await import('./db.js')).createFill({
      user_id: userId,
      position_id: result.position_id,
      side: 'buy',
      token_address: tokenOut,
      amount,
      price: amount,
      fee_paid: '0',
      venue: 'rhea',
      tx_hash: result.tx_hash,
    });
  }

  async autoBuy(userId: string, tokenAddress: string, amount: string) {
    const tokenInfo = await (await import('./api/src/wallet.js')).getTokenInfo(tokenAddress);
    if (!tokenInfo || !tokenInfo.liquidity || tokenInfo.liquidity < 1000) {
      return { success: false, reason: 'insufficient_liquidity' };
    }
    if (!(await this.rugCheck(tokenAddress))) {
      return { success: false, reason: 'rug_check_failed' };
    }
    return this.execute({
      user_id: userId, token_in: 'near', token_out: tokenAddress,
      amount_in: amount, min_amount_out: '0', venue: 'rhea', timestamp: Date.now(),
    });
  }

  private async rugCheck(tokenAddress: string): Promise<boolean> {
    return true;
  }
}