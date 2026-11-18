import { ethers } from 'ethers';
import {
  isSolanaAddress,
  isValidNearAccountId,
  isValidStarknetAddress,
  isValidSuiAddress,
} from '@racerbot/shared';
import { evmRecipientProblem } from './evmWallet.js';
import { isSuiToken, isStarknetToken } from './wallet.js';

export type WithdrawChainId =
  | 'near'
  | 'solana'
  | 'sui'
  | 'starknet'
  | 'starknet_eth'
  | 'base'
  | 'arbitrum'
  | 'ethereum'
  | 'zero'
  | 'hyperevm'
  | 'elysium';

export interface WithdrawChainMeta {
  id: WithdrawChainId;
  label: string;
  icon: string;
  nativeSymbol: string;
  isEvm: boolean;
  addressHint: string;
  addressExample: string;
}

export const WITHDRAW_CHAIN_META: Record<WithdrawChainId, WithdrawChainMeta> = {
  near: {
    id: 'near',
    label: 'NEAR',
    icon: '⬛',
    nativeSymbol: 'NEAR',
    isEvm: false,
    addressHint: 'a valid NEAR account ID (e.g. `mywallet.near` or a 64-character hex implicit account)',
    addressExample: 'mywallet.near',
  },
  solana: {
    id: 'solana',
    label: 'Solana',
    icon: '🟣',
    nativeSymbol: 'SOL',
    isEvm: false,
    addressHint: 'a valid Solana wallet address (base58, 32–44 characters)',
    addressExample: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
  },
  sui: {
    id: 'sui',
    label: 'SUI',
    icon: '🔷',
    nativeSymbol: 'SUI',
    isEvm: false,
    addressHint: 'a valid SUI wallet address (`0x` followed by 64 hex characters)',
    addressExample: '0x1234...abcd (66 characters total)',
  },
  starknet: {
    id: 'starknet',
    label: 'Starknet',
    icon: '✨',
    nativeSymbol: 'STRK',
    isEvm: false,
    addressHint: 'a valid Starknet wallet address (`0x...`, e.g. Argent X or Braavos)',
    addressExample: '0x0679...b39a',
  },
  starknet_eth: {
    id: 'starknet_eth',
    label: 'Starknet (ETH)',
    icon: '✨',
    nativeSymbol: 'ETH',
    isEvm: false,
    addressHint: 'a valid Starknet wallet address (`0x...`, e.g. Argent X or Braavos)',
    addressExample: '0x0679...b39a',
  },
  base: {
    id: 'base',
    label: 'Base',
    icon: '🔵',
    nativeSymbol: 'ETH',
    isEvm: true,
    addressHint: 'a valid EVM wallet address (`0x` followed by 40 hex characters)',
    addressExample: '0x71C...89A',
  },
  arbitrum: {
    id: 'arbitrum',
    label: 'Arbitrum',
    icon: '💙',
    nativeSymbol: 'ETH',
    isEvm: true,
    addressHint: 'a valid EVM wallet address (`0x` followed by 40 hex characters)',
    addressExample: '0x71C...89A',
  },
  ethereum: {
    id: 'ethereum',
    label: 'Ethereum',
    icon: '💎',
    nativeSymbol: 'ETH',
    isEvm: true,
    addressHint: 'a valid EVM wallet address (`0x` followed by 40 hex characters)',
    addressExample: '0x71C...89A',
  },
  zero: {
    id: 'zero',
    label: 'Zero Network',
    icon: '🅾️',
    nativeSymbol: 'ZRO',
    isEvm: true,
    addressHint: 'a valid EVM wallet address (`0x` followed by 40 hex characters)',
    addressExample: '0x71C...89A',
  },
  hyperevm: {
    id: 'hyperevm',
    label: 'HyperEVM',
    icon: '⚡',
    nativeSymbol: 'HYPE',
    isEvm: true,
    addressHint: 'a valid EVM wallet address (`0x` followed by 40 hex characters)',
    addressExample: '0x71C...89A',
  },
  elysium: {
    id: 'elysium',
    label: 'Elysium (Kleos)',
    icon: '🏛️',
    nativeSymbol: 'HYPE',
    isEvm: true,
    addressHint: 'a valid EVM wallet address (`0x` followed by 40 hex characters)',
    addressExample: '0x71C...89A',
  },
};

export function isWithdrawChainId(value: string): value is WithdrawChainId {
  return Object.prototype.hasOwnProperty.call(WITHDRAW_CHAIN_META, value);
}

export interface UserOwnAddresses {
  near?: string | null;
  solana?: string | null;
  sui?: string | null;
  starknet?: string | null;
  evm?: string | null;
}

/**
 * Strictly validates a recipient wallet address for the selected withdrawal chain.
 * Rejects inputs containing spaces (such as `<address> <amount>`) so the user enters
 * only the wallet address in Step 2 and the amount in Step 3.
 */
export function validateWithdrawAddress(
  chain: WithdrawChainId,
  rawInput: string,
  ownAddresses: UserOwnAddresses = {}
): { ok: true; address: string } | { ok: false; error: string } {
  const trimmed = (rawInput || '').trim();
  if (!trimmed) {
    return { ok: false, error: 'Please enter a destination wallet address.' };
  }
  if (/\s/.test(trimmed)) {
    return {
      ok: false,
      error: 'Please enter only the destination wallet address in this step (do not include the amount yet).',
    };
  }

  const meta = WITHDRAW_CHAIN_META[chain];
  if (!meta) {
    return { ok: false, error: 'Unsupported chain selected.' };
  }

  if (meta.isEvm) {
    const problem = evmRecipientProblem(trimmed, ownAddresses.evm);
    if (problem) {
      return { ok: false, error: problem };
    }
    return { ok: true, address: ethers.getAddress(trimmed) };
  }

  if (chain === 'near') {
    const lower = trimmed.toLowerCase();
    if (lower.startsWith('0x')) {
      return {
        ok: false,
        error: 'That looks like a 0x address. For NEAR withdrawals, enter a NEAR account ID (e.g. `mywallet.near` or a 64-character hex address without 0x).',
      };
    }
    if (isSolanaAddress(trimmed) && !lower.endsWith('.near')) {
      return {
        ok: false,
        error: 'That looks like a Solana address. Please enter a valid NEAR account ID (e.g. `mywallet.near`).',
      };
    }
    const isImplicitNear = /^[0-9a-f]{64}$/.test(lower);
    const isNamedNear = lower.includes('.') && isValidNearAccountId(lower);
    if (!isImplicitNear && !isNamedNear) {
      return {
        ok: false,
        error: 'Invalid NEAR account ID. Enter a named NEAR account (e.g. `mywallet.near` or `name.tg`) or a 64-character hex implicit account.',
      };
    }
    if (ownAddresses.near && lower === ownAddresses.near.trim().toLowerCase()) {
      return { ok: false, error: 'That is your own RacerBot NEAR wallet address.' };
    }
    return { ok: true, address: lower };
  }

  if (chain === 'solana') {
    if (!isSolanaAddress(trimmed)) {
      return {
        ok: false,
        error: 'Invalid Solana wallet address. Please enter a valid base58 Solana address.',
      };
    }
    if (ownAddresses.solana && trimmed === ownAddresses.solana.trim()) {
      return { ok: false, error: 'That is your own RacerBot Solana wallet address.' };
    }
    return { ok: true, address: trimmed };
  }

  if (chain === 'sui') {
    if (/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
      return {
        ok: false,
        error: 'That is a 40-character EVM address (MetaMask / Rabby). SUI wallet addresses have 64 hex characters after `0x`.',
      };
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(trimmed) || !isValidSuiAddress(trimmed)) {
      return {
        ok: false,
        error: 'Invalid SUI wallet address. Please enter a full 66-character `0x...` SUI address (0x followed by 64 hex characters).',
      };
    }
    if (ownAddresses.sui && trimmed.toLowerCase() === ownAddresses.sui.trim().toLowerCase()) {
      return { ok: false, error: 'That is your own RacerBot SUI wallet address.' };
    }
    return { ok: true, address: trimmed.toLowerCase() };
  }

  if (chain === 'starknet' || chain === 'starknet_eth') {
    if (/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
      return {
        ok: false,
        error: 'That is a 40-character EVM address (MetaMask / Rabby). Please enter a Starknet wallet address (e.g. Argent X or Braavos).',
      };
    }
    if (!isValidStarknetAddress(trimmed)) {
      return {
        ok: false,
        error: 'Invalid Starknet wallet address. Please enter a valid `0x...` Starknet address.',
      };
    }
    if (ownAddresses.starknet && trimmed.toLowerCase() === ownAddresses.starknet.trim().toLowerCase()) {
      return { ok: false, error: 'That is your own RacerBot Starknet wallet address.' };
    }
    return { ok: true, address: trimmed };
  }

  return { ok: false, error: 'Unsupported withdrawal chain.' };
}

/**
 * Strictly parses a withdrawal amount input in Step 3.
 * Never defaults to 'all' unless the user explicitly types 'all' or 'max'.
 */
export function parseWithdrawAmount(
  rawInput: string
): { ok: true; amount: number | 'all' } | { ok: false; error: string } {
  const trimmed = (rawInput || '').trim().toLowerCase();
  if (!trimmed) {
    return { ok: false, error: 'Please enter the amount you want to send (e.g. `1.5` or `all`).' };
  }
  if (/\s/.test(trimmed)) {
    return {
      ok: false,
      error: 'Please enter only a single number for the amount (e.g. `1.5`) or `all`.',
    };
  }
  if (trimmed === 'all' || trimmed === 'max' || trimmed === '100%') {
    return { ok: true, amount: 'all' };
  }
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    return {
      ok: false,
      error: 'Invalid amount. Please enter a positive number (e.g. `1.5`) or `all`.',
    };
  }
  const num = parseFloat(trimmed);
  if (!Number.isFinite(num) || num <= 0) {
    return {
      ok: false,
      error: 'Withdrawal amount must be greater than 0.',
    };
  }
  return { ok: true, amount: num };
}

/**
 * Determines the withdrawal chain for a token position from the user's bags.
 */
export function resolvePositionWithdrawChain(
  positionChain?: string | null,
  tokenAddress?: string | null
): WithdrawChainId {
  const c = (positionChain || '').trim().toLowerCase();
  if (c === 'solana' || c === 'sol') return 'solana';
  if (c === 'sui') return 'sui';
  if (c === 'starknet') return 'starknet';
  if (c === 'base') return 'base';
  if (c === 'arbitrum' || c === 'arb') return 'arbitrum';
  if (c === 'ethereum' || c === 'eth') return 'ethereum';
  if (c === 'zero' || c === 'zro') return 'zero';
  if (c === 'hyperevm' || c === 'hype') return 'hyperevm';
  if (c === 'elysium' || c === 'kleos') return 'elysium';

  const tok = (tokenAddress || '').trim();
  if (tok && isSuiToken(tok)) return 'sui';
  if (tok && isStarknetToken(tok)) return 'starknet';
  if (tok && isSolanaAddress(tok) && !tok.endsWith('.near')) return 'solana';
  return 'near';
}
