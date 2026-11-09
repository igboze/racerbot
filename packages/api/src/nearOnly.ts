/**
 * On the webapp, RaceFleet and AI Swarm trade NEAR tokens only: EVM and Solana wallets sign in and
 * deposit, but every trade runs on NEAR. The Telegram bot has its own rules and does not use this.
 */
import { isValidNearAccountId } from '@racerbot/shared';

export const NEAR_ONLY_MESSAGE = 'Fleet and AI Swarm trade NEAR tokens only. Use a NEAR token contract, such as blackdragon.tkn.near.';

/**
 * A NEAR token is a NEAR contract account: a named account (it has a dot, like wrap.near) or a 64-hex
 * implicit account. An EVM `0x…` address passes NEAR's own account rules, so it needs this stricter test.
 */
export function isNearTokenAddress(address: unknown): boolean {
  const id = String(address ?? '').trim();
  if (!isValidNearAccountId(id)) return false;
  return /^[0-9a-f]{64}$/.test(id) || id.includes('.');
}
