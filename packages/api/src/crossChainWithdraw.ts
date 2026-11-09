/**
 * Withdraw to another chain: a user who signed in with an EVM or Solana wallet trades on NEAR, then
 * sends NEAR back out to their own chain through 1Click, from either balance:
 *   • private balance: the private account signs an unshield to that chain's asset;
 *   • RacerBot wallet: the wallet pays wNEAR to a 1Click deposit address; refunds come back to it.
 * Only EVM chains and Solana are offered, so the destination address can always be checked.
 */
import { PublicKey } from '@solana/web3.js';
import type { UserRecord } from '@racerbot/db';
import { notifyDeposit, quotePublicSwap } from './intentsPrivate.js';
import { getTokensForChain, SUPPORTED_CHAINS, type OneClickToken } from './multichainDeposit.js';
import {
  assertWalletCovers,
  isExternalWallet,
  payDepositAddressFromWallet,
  withdrawPrivate,
} from './executorPool.js';

const WNEAR_ASSET = 'nep141:wrap.near';
const SLIPPAGE_BPS = 100;
/** 1Click's own floor is per route; below this NEAR amount a cross-chain payout is mostly fees */
export const MIN_WITHDRAW_YOCTO = 10n ** 23n; // 0.1 NEAR

export type WithdrawSource = 'private' | 'wallet';
type AddressKind = 'evm' | 'solana';

/** Chains a withdrawal can go to, with the kind of address each one uses */
const WITHDRAW_CHAINS: Record<string, AddressKind> = {
  sol: 'solana',
  eth: 'evm',
  base: 'evm',
  arb: 'evm',
  bsc: 'evm',
  op: 'evm',
  pol: 'evm',
  avax: 'evm',
  gnosis: 'evm',
  bera: 'evm',
  monad: 'evm',
  abs: 'evm',
  scroll: 'evm',
  plasma: 'evm',
  xlayer: 'evm',
};

/** The tokens offered per chain: its native coin and the main stablecoins, in that order */
const OFFERED_SYMBOLS = ['USDC', 'USDT'];

export interface WithdrawDestination {
  chain: string;
  name: string;
  icon: string;
  addressKind: AddressKind;
  tokens: { symbol: string; decimals: number }[];
}

function offeredTokens(chain: string): OneClickToken[] {
  const all = getTokensForChain(chain);
  const native = SUPPORTED_CHAINS[chain]?.nativeSymbol?.toUpperCase();
  const picked: OneClickToken[] = [];
  for (const sym of [native, ...OFFERED_SYMBOLS]) {
    const t = all.find(x => (x.symbol || '').toUpperCase() === sym);
    if (t && !picked.includes(t)) picked.push(t);
  }
  return picked;
}

export function listWithdrawDestinations(): WithdrawDestination[] {
  return Object.entries(WITHDRAW_CHAINS)
    .map(([chain, addressKind]) => {
      const c = SUPPORTED_CHAINS[chain];
      return {
        chain,
        name: c?.name || chain,
        icon: c?.icon || '',
        addressKind,
        tokens: offeredTokens(chain).map(t => ({ symbol: t.symbol, decimals: t.decimals })),
      };
    })
    .filter(d => d.tokens.length > 0);
}

export function isValidWithdrawAddress(chain: string, address: string): boolean {
  const kind = WITHDRAW_CHAINS[chain];
  const a = String(address || '').trim();
  if (kind === 'evm') return /^0x[0-9a-fA-F]{40}$/.test(a);
  if (kind === 'solana') {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) return false;
    try {
      return PublicKey.isOnCurve(new PublicKey(a).toBytes());
    } catch {
      return false;
    }
  }
  return false;
}

export interface WithdrawRequest {
  amountYocto: bigint;
  chain: string;
  symbol: string;
  address: string;
}

function resolve(req: WithdrawRequest): { token: OneClickToken; address: string } {
  const chain = String(req.chain || '').toLowerCase();
  if (!WITHDRAW_CHAINS[chain]) throw new Error('Withdrawals go to Solana or an EVM chain. Pick one from the list.');
  const token = offeredTokens(chain).find(t => (t.symbol || '').toUpperCase() === String(req.symbol || '').toUpperCase());
  if (!token) throw new Error(`${req.symbol || 'That token'} cannot be sent to ${SUPPORTED_CHAINS[chain]?.name || chain}.`);
  const address = String(req.address || '').trim();
  if (!isValidWithdrawAddress(chain, address)) {
    throw new Error(WITHDRAW_CHAINS[chain] === 'evm'
      ? 'Enter a valid EVM address (0x followed by 40 characters).'
      : 'Enter a valid Solana wallet address.');
  }
  if (req.amountYocto < MIN_WITHDRAW_YOCTO) throw new Error('The minimum withdrawal to another chain is 0.1 NEAR.');
  return { token, address };
}

/** Raw base units as a short human number */
function formatUnits(raw: string | undefined, decimals: number): string {
  if (!raw) return '0';
  const v = BigInt(raw);
  const whole = v / 10n ** BigInt(decimals);
  const frac = (v % 10n ** BigInt(decimals)).toString().padStart(decimals, '0').slice(0, 6).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

export interface WithdrawQuote {
  receive: string;
  minReceive: string;
  symbol: string;
  chain: string;
  timeEstimateSec?: number;
}

/** What the user would receive, without reserving anything. The price is the same from either balance. */
export async function quoteWithdrawToChain(user: UserRecord, req: WithdrawRequest): Promise<WithdrawQuote> {
  const { token, address } = resolve(req);
  const q = await quotePublicSwap({
    dry: true,
    originAsset: WNEAR_ASSET,
    destinationAsset: token.assetId,
    amount: req.amountYocto.toString(),
    recipient: address,
    refundTo: user.subaccount_id,
    slippageBps: SLIPPAGE_BPS,
  });
  return {
    receive: formatUnits(q.amountOut, token.decimals),
    minReceive: formatUnits(q.minAmountOut, token.decimals),
    symbol: token.symbol,
    chain: req.chain.toLowerCase(),
    timeEstimateSec: q.timeEstimate,
  };
}

export interface WithdrawResult {
  /** The 1Click deposit address: GET /deposit/status?address= tracks the payout */
  depositAddress: string;
  txHash?: string;
  intentHash?: string;
  receive: string;
  symbol: string;
}

/** Send NEAR from the chosen balance to `address` on another chain as the chosen token */
export async function withdrawToChain(user: UserRecord, source: WithdrawSource, req: WithdrawRequest): Promise<WithdrawResult> {
  const { token, address } = resolve(req);
  if (source === 'private') {
    const move = await withdrawPrivate(user, req.amountYocto, address, token.assetId);
    return {
      depositAddress: move.depositAddress,
      intentHash: move.intentHash,
      receive: formatUnits(move.amountOut, token.decimals),
      symbol: token.symbol,
    };
  }
  if (isExternalWallet(user)) {
    throw new Error('RacerBot holds no key for this wallet. Send from your private balance, or from the wallet itself.');
  }
  await assertWalletCovers(user, req.amountYocto, 'withdrawal');
  const quote = await quotePublicSwap({
    originAsset: WNEAR_ASSET,
    destinationAsset: token.assetId,
    amount: req.amountYocto.toString(),
    recipient: address,
    refundTo: user.subaccount_id,
    slippageBps: SLIPPAGE_BPS,
  });
  const txHash = await payDepositAddressFromWallet(user, req.amountYocto, quote.depositAddress, 'Withdrawal');
  void notifyDeposit(quote.depositAddress, txHash);
  return {
    depositAddress: quote.depositAddress,
    txHash,
    receive: formatUnits(quote.amountOut, token.decimals),
    symbol: token.symbol,
  };
}
