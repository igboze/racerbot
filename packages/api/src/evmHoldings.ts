/**
 * Tokens an EVM wallet already holds (an imported wallet, or coins sent in from outside) show in the
 * bot as positions, as NEAR and Sui deposits already do.
 *
 * Neither chain offers a free way to list a wallet's tokens (their RPCs refuse Transfer-log scans over
 * real ranges), so:
 *  - Elysium: the wallet's balance of every coin on the Kleos board is read in a few Multicall3 calls;
 *  - any EVM token (HyperEVM, RonsPad, Kleos coins newer than the board): its card checks the wallet's
 *    balance when opened and starts tracking a holding it finds.
 */
import { ethers } from 'ethers';
import { createLogger, getEvmProvider, listKleosBoardCoins, type EvmChain } from '@racerbot/shared';
import { createPosition, getDb, getOpenPositions, getUserById, type UserRecord } from '@racerbot/db';
import { notifyTokenDeposit } from './notify.js';

const logger = createLogger('evm-holdings');
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const MULTICALL3_ABI = ['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[] returnData)'];
const ERC20 = new ethers.Interface([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);
const BATCH = 250;
const SCAN_EVERY_MS = 60_000;
const lastScan = new Map<string, number>();

const formatAmount = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n.toLocaleString('en-US', { maximumFractionDigits: 4 }));

/**
 * Starts tracking a token the wallet already holds: an open position at the current price, marked as an
 * external deposit (no PnL from before it was found). Skips a token sold or closed in the last 15 minutes,
 * so a slow balance read never revives a position the user just exited. Returns the position id, or null.
 */
export async function trackEvmHolding(p: {
  user: UserRecord;
  chain: EvmChain;
  token: string;
  balanceRaw: bigint;
  decimals: number;
  priceHype: number;
  symbol?: string;
  name?: string;
  notify?: boolean;
}): Promise<string | null> {
  if (p.balanceRaw <= 0n) return null;
  const token = ethers.getAddress(p.token);
  const db = await getDb();
  const recent = await db.query(
    `SELECT 1 FROM positions WHERE user_id = $1 AND LOWER(token_address) = LOWER($2)
       AND ((status = 'closed' AND closed_at > NOW() - INTERVAL '15 minutes')
         OR id IN (SELECT position_id FROM fills WHERE side = 'sell' AND executed_at > NOW() - INTERVAL '15 minutes'))
     LIMIT 1`,
    [p.user.id, token]
  ).catch(() => null);
  if (recent?.rows?.length) return null;

  const human = ethers.formatUnits(p.balanceRaw, p.decimals);
  const position = await createPosition({
    user_id: p.user.id,
    chain: p.chain,
    token_address: token,
    quantity_held: human,
    avg_entry_price: (p.priceHype > 0 ? p.priceHype : 0).toString(),
  });
  await db.query('UPDATE positions SET is_external_deposit = TRUE, external_deposit_detected_at = NOW() WHERE id = $1', [position.id]).catch(() => {});
  logger.info(`Tracking ${p.chain} holding ${token} for user ${p.user.id}: ${human}`);

  if (p.notify && p.user.telegram_id) {
    notifyTokenDeposit(Number(p.user.telegram_id), {
      tokenSymbol: p.symbol || 'TOKEN',
      tokenName: p.name,
      amountFormatted: formatAmount(Number(human)),
      address: p.user.evm_address || '',
      chain: p.chain,
      positionId: position.id,
    }).catch(() => {});
  }
  return position.id;
}

/** Balances of many tokens for one owner, in Multicall3 batches; a failed read is left out, never read as 0 */
async function balancesOf(chain: EvmChain, owner: string, tokens: string[]): Promise<Map<string, bigint>> {
  const provider = getEvmProvider(chain, false);
  const multicall = new ethers.Contract(MULTICALL3, MULTICALL3_ABI, provider);
  const out = new Map<string, bigint>();
  const data = ERC20.encodeFunctionData('balanceOf', [owner]);
  for (let i = 0; i < tokens.length; i += BATCH) {
    const batch = tokens.slice(i, i + BATCH);
    const results = await multicall.aggregate3(batch.map(target => ({ target, allowFailure: true, callData: data })));
    results.forEach((r: any, j: number) => {
      if (r.success && r.returnData && r.returnData !== '0x') out.set(batch[j].toLowerCase(), BigInt(r.returnData));
    });
  }
  return out;
}

/**
 * Finds the Kleos coins the user's EVM wallet holds and tracks those it is not tracking yet. Runs at most
 * once a minute per user unless forced (right after a wallet import). Returns how many it started tracking.
 */
export async function syncUserEvmHoldings(userId: string, force = false): Promise<number> {
  const last = lastScan.get(userId);
  if (!force && last && Date.now() - last < SCAN_EVERY_MS) return 0;
  lastScan.set(userId, Date.now());

  const user = await getUserById(userId).catch(() => null);
  if (!user?.evm_address) return 0;
  const coins = await listKleosBoardCoins().catch(() => [] as any[]);
  if (coins.length === 0) return 0;

  const balances = await balancesOf('elysium', user.evm_address, coins.map(c => String(c.address)));
  const held = coins.filter(c => (balances.get(String(c.address).toLowerCase()) ?? 0n) > 0n);
  if (held.length === 0) return 0;

  const open = await getOpenPositions(user.id).catch(() => []);
  const tracked = new Set(open.filter(p => p.chain === 'elysium' || p.chain === 'hyperevm').map(p => p.token_address.toLowerCase()));
  let added = 0;
  for (const coin of held) {
    if (tracked.has(String(coin.address).toLowerCase())) continue;
    const id = await trackEvmHolding({
      user,
      chain: 'elysium',
      token: coin.address,
      balanceRaw: balances.get(String(coin.address).toLowerCase())!,
      decimals: 18, // every Kleos coin has 18 decimals
      priceHype: Number(coin.launch?.price) || 0,
      symbol: coin.symbol,
      name: coin.name,
      notify: true,
    }).catch((err: any) => {
      logger.warn(`Could not track ${coin.address} for ${user.id}: ${err?.message}`);
      return null;
    });
    if (id) added++;
  }
  return added;
}

/**
 * When a token card opens for an EVM token the user is not tracking, checks the wallet's balance and
 * tracks a holding it finds (covers HyperEVM and RonsPad tokens, which no scan can list). Returns true
 * when it started tracking one.
 */
export async function trackEvmHoldingOnView(user: UserRecord, chain: EvmChain, token: string, priceHype: number, symbol?: string, name?: string): Promise<boolean> {
  if (!user.evm_address || !ethers.isAddress(token)) return false;
  const provider = getEvmProvider(chain, chain === 'hyperevm' && process.env.HYPEREVM_TESTNET === 'true');
  const erc20 = new ethers.Contract(token, ERC20, provider);
  const [balance, decimals] = await Promise.all([
    erc20.balanceOf(user.evm_address) as Promise<bigint>,
    (erc20.decimals() as Promise<bigint>).then(Number).catch(() => 18),
  ]);
  if (balance <= 0n) return false;
  const id = await trackEvmHolding({ user, chain, token, balanceRaw: balance, decimals, priceHype, symbol, name, notify: false });
  return Boolean(id);
}
