import { getDb } from './db.js';
import { decrypt } from '@racerbot/shared';
import { MAIN_WALLET_PRIVATE_KEY } from './config.js';
import { SwapExecutor } from './executor.js';

export class TriggerEngine {
  private executor: SwapExecutor;

  constructor() {
    this.executor = new SwapExecutor();
  }

  async checkAllTriggers() {
    const activeTriggers = await (await import('./db.js')).getActiveTriggers();
    for (const trigger of activeTriggers) {
      const position = await (await import('./db.js')).getPositionById(trigger.position_id);
      if (!position || position.status === 'closed') continue;

      const currentPrice = parseFloat((await (await import('./api/src/wallet.js')).getTokenInfo(position.token_address)).price || '0');
      const entryPrice = parseFloat(position.avg_entry_price);
      let triggered = false;

      switch (trigger.type) {
        case 'stop_loss':
          triggered = currentPrice <= entryPrice * (1 - parseFloat(trigger.target_value) / 100);
          break;
        case 'take_profit':
          triggered = currentPrice >= entryPrice * (1 + parseFloat(trigger.target_value) / 100);
          break;
        case 'market_cap':
          const tokenInfo = await (await import('./api/src/wallet.js')).getTokenInfo(position.token_address);
          triggered = (tokenInfo.marketCap || 0) >= parseFloat(trigger.target_value);
          break;
      }

      if (triggered) {
        await this.fireTrigger(trigger, position);
      }
    }
  }

  private async fireTrigger(trigger: any, position: any) {
    await (await import('./db.js')).markTriggerFired(trigger.id);
    await this.executor.execute({
      type: 'execute_swap',
      user_id: position.user_id,
      token_in: position.token_address,
      token_out: 'near',
      amount_in: position.quantity_held,
      min_amount_out: '0',
      venue: 'rhea',
      timestamp: Date.now(),
    });
    await (await import('./db.js')).updatePosition({ position_id: position.id, status: 'closed', closed_at: new Date() });
  }
}

export async function sellAtTarget(userId: string, positionId: string, percentage: number) {
  const position = await (await import('./db.js')).getPositionById(positionId);
  if (!position) return { success: false, reason: 'position_not_found' };
  const sellQty = (parseFloat(position.quantity_held) * percentage) / 100;
  const executor = new SwapExecutor();
  await executor.execute({
    type: 'execute_swap', user_id: userId, token_in: position.token_address,
    token_out: 'near', amount_in: sellQty.toString(), min_amount_out: '0', venue: 'rhea', timestamp: Date.now(),
  });
  return { success: true };
}