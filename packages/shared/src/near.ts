import { connect, keyStores, Near, Account, KeyPair, utils } from 'near-api-js';
import { rotateProvider, markProviderError, markProviderSuccess, createProvider, RPCProvider } from './rpc.js';
import { calculateExpectedOutput, calculateMinAmountOut } from './utils.js';

export interface NearConfig {
  rpcUrls: string[];
  networkId?: string;
}

export interface TokenMetadata {
  name: string;
  symbol: string;
  decimals: number;
  total_supply: string;
  icon?: string;
}

export interface PoolReserves {
  token_in: string;
  token_out: string;
  reserve_in: string;
  reserve_out: string;
  total_fee: number;
}

const rheaPoolIdCache = new Map<string, number>();
const intearPoolCache = new Map<string, number>();

export function parseIntearPool(rawBytes: Buffer): { asset1: string; reserve1: string; asset2: string; reserve2: string } | null {
  if (!rawBytes || rawBytes.length < 5 || rawBytes[0] !== 1) return null;
  let offset = 1;

  // Asset 1
  const asset1Type = rawBytes.readUInt8(offset);
  offset += 1;
  let asset1 = 'near';
  if (asset1Type === 1) {
    const len = rawBytes.readUInt32LE(offset);
    offset += 4;
    asset1 = rawBytes.toString('utf8', offset, offset + len);
    offset += len;
  }
  // Reserve 1 (u128)
  const r1Buf = rawBytes.subarray(offset, offset + 16);
  offset += 16;
  let reserve1 = 0n;
  for (let i = 0; i < 16; i++) {
    reserve1 |= BigInt(r1Buf[i]) << BigInt(8 * i);
  }

  // Asset 2
  const asset2Type = rawBytes.readUInt8(offset);
  offset += 1;
  let asset2 = 'near';
  if (asset2Type === 1) {
    const len = rawBytes.readUInt32LE(offset);
    offset += 4;
    asset2 = rawBytes.toString('utf8', offset, offset + len);
    offset += len;
  }
  // Reserve 2 (u128)
  const r2Buf = rawBytes.subarray(offset, offset + 16);
  offset += 16;
  let reserve2 = 0n;
  for (let i = 0; i < 16; i++) {
    reserve2 |= BigInt(r2Buf[i]) << BigInt(8 * i);
  }

  return { asset1, reserve1: reserve1.toString(), asset2, reserve2: reserve2.toString() };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, errMsg: string): Promise<T> {
  let timeoutId: any;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(errMsg)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

/**
 * Multi-RPC NEAR connection.
 * Reads use round-robin across healthy providers.
 * Writes broadcast to all healthy providers simultaneously.
 */
export class MultiRpcNear {
  private providers: RPCProvider[];
  private keyStore: keyStores.InMemoryKeyStore;
  private networkId: string;
  private connections: Map<string, Near> = new Map();
  private currentIndex = 0;

  constructor(rpcUrls: string[], networkId = 'mainnet') {
    this.providers = rpcUrls.map((url, i) => createProvider(url, `near-rpc-${i}`));
    this.keyStore = new keyStores.InMemoryKeyStore();
    this.networkId = networkId;
  }

  private async getConnection(providerUrl: string): Promise<Near> {
    if (this.connections.has(providerUrl)) {
      return this.connections.get(providerUrl)!;
    }

    const apiKey = (process.env.FASTNEAR_API_KEY || '').trim();
    const hasValidKey = apiKey && !apiKey.startsWith('TEMP') && !apiKey.startsWith('change-me');
    let nodeUrl = providerUrl;
    const isMainnetFastnear = nodeUrl.includes('rpc.mainnet.fastnear.com');

    if (isMainnetFastnear && hasValidKey && !nodeUrl.includes('apiKey=')) {
      const sep = nodeUrl.includes('?') ? '&' : '?';
      nodeUrl = `${nodeUrl}${sep}apiKey=${apiKey}`;
    }

    const conn = await connect({
      networkId: this.networkId,
      nodeUrl,
      keyStore: this.keyStore,
    });

    if (isMainnetFastnear && hasValidKey) {
      try {
        const provider = conn.connection.provider as any;
        if (provider && provider.connection) {
          provider.connection.headers = {
            ...(provider.connection.headers || {}),
            Authorization: `Bearer ${apiKey}`,
          };
        }
      } catch {
        // Best-effort header injection
      }
    }

    this.connections.set(providerUrl, conn);
    return conn;
  }

  /** Add a signing key for an account into the in-memory key store */
  async addKey(accountId: string, keyPair: KeyPair): Promise<void> {
    await this.keyStore.setKey(this.networkId, accountId, keyPair);
  }

  /** Remove a key (e.g. on user logout or key rotation) */
  async removeKey(accountId: string): Promise<void> {
    await this.keyStore.removeKey(this.networkId, accountId);
  }

  /**
   * Read-only view call — round-robins across healthy providers.
   * Falls back to next provider on error.
   */
  async view<T>(contractId: string, methodName: string, args: object = {}): Promise<T> {
    const candidates = this.providers.filter(p => p.healthy).length > 0
      ? this.providers.filter(p => p.healthy)
      : this.providers;

    if (candidates.length === 0) throw new Error('No NEAR RPC providers configured');

    const startIndex = (this.currentIndex++) % candidates.length;
    let lastErr: Error | null = null;
    for (let i = 0; i < candidates.length; i++) {
      const provider = candidates[(startIndex + i) % candidates.length];
      const start = Date.now();
      try {
        const near = await this.getConnection(provider.url);
        const account = await near.account('');
        const result = await withTimeout(
          account.viewFunction({ contractId, methodName, args }),
          4000,
          `RPC timeout on ${provider.url}`
        );
        markProviderSuccess(provider, Date.now() - start);
        return result as T;
      } catch (err: any) {
        const msg = err?.message || '';
        const isNetworkErr = msg.includes('timeout') || msg.includes('fetch') || msg.includes('ECONN') || msg.includes('ETIMEDOUT') || msg.includes('50');
        if (isNetworkErr) {
          markProviderError(provider);
        }
        lastErr = err as Error;
      }
    }
    throw lastErr ?? new Error('All NEAR RPC providers failed');
  }

  /**
   * Broadcast a signed transaction to ALL healthy providers simultaneously.
   * Returns the first successful tx hash.
   * This is the write path — maximum redundancy for lowest miss rate.
   */
  async broadcastTransaction(signedTxBase64: string): Promise<string> {
    const healthy = this.providers.filter(p => p.healthy);
    if (healthy.length === 0) throw new Error('No healthy NEAR RPC providers');

    const results = await Promise.allSettled(
      healthy.map(async (provider) => {
        const start = Date.now();
        const near = await this.getConnection(provider.url);
        // Use the JSON-RPC directly for broadcast
        const result = await (near.connection.provider as any).sendJsonRpc('broadcast_tx_async', [signedTxBase64]);
        markProviderSuccess(provider, Date.now() - start);
        return result as string;
      })
    );

    for (const r of results) {
      if (r.status === 'fulfilled') return r.value;
    }

    const errors = results.map(r => r.status === 'rejected' ? (r.reason as Error).message : '').join('; ');
    throw new Error(`All NEAR RPC broadcast failed: ${errors}`);
  }

  /**
   * Wait for transaction confirmation by polling.
   * Used after broadcast to confirm the tx landed.
   */
  async waitForTx(txHash: string, accountId: string, maxWaitMs = 10000): Promise<any> {
    const provider = rotateProvider(this.providers);
    const near = await this.getConnection(provider.url);
    const deadline = Date.now() + maxWaitMs;

    while (Date.now() < deadline) {
      try {
        const outcome = await near.connection.provider.txStatus(txHash, accountId, 'EXECUTED_OPTIMISTIC');
        if (outcome.status && typeof outcome.status === 'object' && 'SuccessValue' in outcome.status) {
          return outcome;
        }
        if (outcome.status && typeof outcome.status === 'object' && 'Failure' in outcome.status) {
          throw new Error(`Transaction failed: ${JSON.stringify(outcome.status)}`);
        }
      } catch (err) {
        // Not yet indexed — keep polling
      }
      await sleep(500);
    }
    throw new Error(`Transaction ${txHash} not confirmed within ${maxWaitMs}ms`);
  }

  /**
   * Get ft_metadata for a token contract.
   * Returns name, symbol, decimals, total_supply.
   */
  async getTokenMetadata(tokenAddress: string): Promise<TokenMetadata> {
    return this.view<TokenMetadata>(tokenAddress, 'ft_metadata', {});
  }

  /**
   * Get total supply of a fungible token.
   */
  async getTokenTotalSupply(tokenAddress: string): Promise<string> {
    return this.view<string>(tokenAddress, 'ft_total_supply', {});
  }

  /**
   * Get ft_balance_of for a specific account.
   */
  async getTokenBalance(tokenAddress: string, accountId: string): Promise<string> {
    return this.view<string>(tokenAddress, 'ft_balance_of', { account_id: accountId });
  }

  /**
   * Get an Account instance connected with the internal KeyStore.
   */
  async getAccount(accountId: string): Promise<Account> {
    const provider = rotateProvider(this.providers);
    const near = await this.getConnection(provider.url);
    return near.account(accountId);
  }

  /**
   * Get account NEAR balance.
   */
  async getNearBalance(accountId: string): Promise<string> {
    const healthy = this.providers.filter(p => p.healthy);
    const providersToTry = healthy.length > 0 ? healthy : this.providers;
    let lastErr: Error | null = null;
    for (const provider of providersToTry) {
      try {
        const near = await this.getConnection(provider.url);
        const account = await near.account(accountId);
        const state = await withTimeout<any>(account.state(), 3500, `RPC timeout on ${provider.url}`);
        return state.amount;
      } catch (err) {
        lastErr = err as Error;
      }
    }
    throw lastErr ?? new Error(`Failed to get NEAR balance for ${accountId}`);
  }

  /**
   * Check if account is registered for NEP-141 storage and register if not.
   */
  async ensureStorageDeposit(accountId: string, tokenAddress: string): Promise<void> {
    if (!tokenAddress || tokenAddress === 'near') return;
    try {
      const balance = await this.view<any>(tokenAddress, 'storage_balance_of', { account_id: accountId });
      if (balance && balance.total) {
        return; // Already registered
      }
    } catch {
      // Some tokens don't implement storage_balance_of
    }

    try {
      const account = await this.getAccount(accountId);
      const isWrapNear = tokenAddress === 'wrap.near';
      const deposit = isWrapNear
        ? BigInt('1250000000000000000000') // 0.00125 NEAR
        : BigInt('12500000000000000000000'); // 0.0125 NEAR
      await account.functionCall({
        contractId: tokenAddress,
        methodName: 'storage_deposit',
        args: { account_id: accountId, registration_only: true },
        gas: BigInt('30000000000000'),
        attachedDeposit: deposit,
      });
    } catch {
      // Ignore if already registered or contract doesn't support storage_deposit
    }
  }

  /**
   * Find Rhea pool ID for a token pair with in-memory caching and fast parallel scanning.
   */
  async findRheaPoolId(tokenA: string, tokenB: string): Promise<number> {
    const cacheKey1 = `${tokenA}:${tokenB}`;
    const cacheKey2 = `${tokenB}:${tokenA}`;
    if (rheaPoolIdCache.has(cacheKey1)) return rheaPoolIdCache.get(cacheKey1)!;
    if (rheaPoolIdCache.has(cacheKey2)) return rheaPoolIdCache.get(cacheKey2)!;

    const batchSize = 100;
    const batchStarts = [0, 100, 200, 300, 400]; // Top 500 active Ref pools in parallel

    const results = await Promise.allSettled(
      batchStarts.map(async (fromIndex) => {
        const pools = await this.view<any[]>(
          'v2.ref-finance.near',
          'get_pools',
          { from_index: fromIndex, limit: batchSize }
        );
        return { fromIndex, pools: pools || [] };
      })
    );

    for (const res of results) {
      if (res.status === 'fulfilled') {
        const { fromIndex, pools } = res.value;
        for (let i = 0; i < pools.length; i++) {
          const pool = pools[i];
          const tokens: string[] = pool.token_account_ids || [];
          if (tokens.includes(tokenA) && tokens.includes(tokenB)) {
            const foundId = fromIndex + i;
            rheaPoolIdCache.set(cacheKey1, foundId);
            rheaPoolIdCache.set(cacheKey2, foundId);
            return foundId;
          }
        }
      }
    }

    throw new Error(`Rhea pool not found for pair ${tokenA} / ${tokenB}`);
  }

  /**
   * Get pool reserves from Rhea Finance (v2.ref-finance.near).
   * poolId is strictly required.
   */
  async getRheaPoolReserves(poolId: number, tokenIn: string, tokenOut: string): Promise<{ reserveIn: string; reserveOut: string; fee: number }> {
    const poolInfo = await this.view<any>(
      'v2.ref-finance.near',
      'get_pool',
      { pool_id: poolId }
    );
    const tokenAccounts: string[] = poolInfo.token_account_ids || [];
    const inIdx = tokenAccounts.indexOf(tokenIn);
    const outIdx = tokenAccounts.indexOf(tokenOut);

    if (inIdx === -1 || outIdx === -1) {
      throw new Error(`Tokens ${tokenIn} and ${tokenOut} not in Rhea pool ${poolId}`);
    }

    return {
      reserveIn: poolInfo.amounts?.[inIdx] ?? '0',
      reserveOut: poolInfo.amounts?.[outIdx] ?? '0',
      fee: poolInfo.total_fee ?? 30,
    };
  }

  /**
   * Get pool reserves from Shardsmarket.
   * On Shardsmarket, each token IS its own AMM pool contract.
   * We call get_state() directly on the token address.
   */
  async getShardsmarketPoolReserves(tokenAddress: string): Promise<{ reserveNear: string; reserveToken: string }> {
    const state = await this.getShardsmarketTokenState(tokenAddress);
    return {
      reserveNear: state.poolQuote,
      reserveToken: state.poolToken,
    };
  }

  /**
   * Get full Shardsmarket token state including reserves, phase, supply.
   * Calls get_state() on the token contract itself (each token IS its own AMM pool).
   */
  async getShardsmarketTokenState(tokenAddress: string): Promise<{
    poolQuote: string;      // NEAR reserves in yoctoNEAR
    poolToken: string;      // Token reserves in raw units
    totalSupply: string;    // Total supply in raw units
    phase: string;          // "live_amm" | "presale" | etc.
    progressBps: number;    // bonding progress in basis points (10000 = 100%)
  }> {
    // Shardsmarket tokens: token address IS the pool contract
    // Only *.factory.shardsmarket.near tokens are supported
    if (!tokenAddress.endsWith('.factory.shardsmarket.near')) {
      throw new Error(`Not a Shardsmarket token: ${tokenAddress}`);
    }
    const state = await this.view<any>(tokenAddress, 'get_state', {});
    if (!state || !state.pool_quote) {
      throw new Error(`No active Shardsmarket pool found for token ${tokenAddress}`);
    }
    return {
      poolQuote: state.pool_quote,
      poolToken: state.pool_token,
      totalSupply: state.total_supply,
      phase: state.phase || 'unknown',
      progressBps: Number(state.progress_bps ?? 0),
    };
  }

  /**
   * View access key on chain to verify permissions.
   */
  async viewAccessKey(accountId: string, publicKey: string): Promise<any> {
    const healthy = this.providers.filter(p => p.healthy);
    if (healthy.length === 0) throw new Error('No healthy NEAR RPC providers');
    const startIndex = (this.currentIndex++) % healthy.length;
    let lastErr: Error | null = null;
    for (let i = 0; i < healthy.length; i++) {
      const provider = healthy[(startIndex + i) % healthy.length];
      try {
        const near = await this.getConnection(provider.url);
        const result = await (near.connection.provider as any).query({
          request_type: 'view_access_key',
          finality: 'optimistic',
          account_id: accountId,
          public_key: publicKey,
        });
        return result;
      } catch (err) {
        lastErr = err as Error;
      }
    }
    throw lastErr ?? new Error(`Failed to view access key for ${accountId}`);
  }

  /**
   * Create an on-chain subaccount funded by parent account.
   */
  async createSubaccount(
    parentAccountId: string,
    newAccountId: string,
    userPublicKey: string,
    initialBalanceNear = '0.05'
  ): Promise<any> {
    const account = await this.getAccount(parentAccountId);
    const initialDeposit = utils.format.parseNearAmount(initialBalanceNear);
    if (!initialDeposit) throw new Error('Invalid initialBalanceNear');

    return account.createAccount(
      newAccountId,
      utils.PublicKey.from(userPublicKey),
      BigInt(initialDeposit)
    );
  }

  /**
   * Query NearlyTrade token state and DCL pool details on-chain.
   * Throws real error if token or pool cannot be fetched (no fallback data).
   */
  async getNearlytradeTokenState(tokenAddress: string): Promise<{
    pool_id: string;
    dclPoolId: string;
    phase: 'prebonded' | 'bonded';
    bonding_phase: 'prebonded' | 'bonded';
    bondingProgressPct: number;
    bonding_progress_pct: number;
    price: number;
    liquidityNear: number;
    reserveNear: string;
    reserveToken: string;
    totalSupply: string;
  }> {
    // FIX 7: Start metadata + supply fetches in parallel with the launch lookup
    // instead of waiting for it first. All 3 calls are independent at this point.
    const [launchRes, metaRes, supplyRes] = await Promise.allSettled([
      this.view<any>('nearlytrade.near', 'get_launch_by_token', { token: tokenAddress }),
      this.getTokenMetadata(tokenAddress),
      this.view<string>(tokenAddress, 'ft_total_supply', {}),
    ]);

    const launch = launchRes.status === 'fulfilled' ? launchRes.value : null;
    if (!launch || !launch.pool_id) {
      throw new Error(`NearlyTrade token ${tokenAddress} not found or has no pool_id`);
    }

    const meta = metaRes.status === 'fulfilled' ? metaRes.value : { decimals: 18 };
    const supplyOnChain = supplyRes.status === 'fulfilled' ? supplyRes.value : (launch.total_supply || '0');

    const pool = await this.view<any>('dclv2.ref-labs.near', 'get_pool', { pool_id: launch.pool_id });

    if (!pool) {
      throw new Error(`DCL pool ${launch.pool_id} not found on dclv2.ref-labs.near`);
    }

    const leftPoint = Number(launch.left_point);
    const rightPoint = Number(launch.right_point);
    const currentPoint = Number(pool.current_point);
    const span = rightPoint - leftPoint;
    const offset = currentPoint - leftPoint;
    const progressPct = span > 0 ? Math.min(100, Math.max(0, (offset / span) * 100)) : 100;

    const isBonded = launch.step === 'Done' && (progressPct >= 100 || pool.state !== 'Running');
    const bondingPhase: 'prebonded' | 'bonded' = isBonded ? 'bonded' : 'prebonded';

    const isTokenX = launch.token_is_x !== false;
    const reserveToken = isTokenX ? pool.total_x : pool.total_y;
    const reserveNear = isTokenX ? pool.total_y : pool.total_x;

    const tokenDecimals = meta?.decimals ?? 18;
    let price = 0;
    if (pool.current_point !== undefined && pool.current_point !== null && !isNaN(currentPoint)) {
      // In Ref DCL, 1.0001^current_point gives raw price of token_x in token_y base units.
      // Normalize by token decimals (wrap.near has 24 decimals).
      if (isTokenX) {
        price = Math.pow(1.0001, currentPoint) * Math.pow(10, tokenDecimals - 24);
      } else {
        price = (1 / Math.pow(1.0001, currentPoint)) * Math.pow(10, tokenDecimals - 24);
      }
    }

    const reserveNearNum = parseFloat(reserveNear || '0') / 1e24;
    const liquidityNear = reserveNearNum * 2;
    const totalSupply = supplyOnChain && supplyOnChain !== '0' ? supplyOnChain : (launch.total_supply || '0');

    return {
      pool_id: launch.pool_id,
      dclPoolId: launch.pool_id,
      phase: bondingPhase,
      bonding_phase: bondingPhase,
      bondingProgressPct: Number(progressPct.toFixed(2)),
      bonding_progress_pct: Number(progressPct.toFixed(2)),
      price,
      liquidityNear,
      reserveNear: reserveNear || '0',
      reserveToken: reserveToken || '0',
      totalSupply,
    };
  }

  /**
   * Find pool ID on dex.intear.near (slimedragon.near/xyk) for a token
   */
  async findIntearPoolId(tokenAddress: string): Promise<number> {
    if (intearPoolCache.has(tokenAddress)) {
      return intearPoolCache.get(tokenAddress)!;
    }

    // Scan pools from newest (250 down to 0) in parallel batches of 25
    for (let start = 250; start >= 0; start -= 25) {
      const promises: Promise<{ id: number; data: any } | null>[] = [];
      const batchStart = Math.max(0, start - 24);
      for (let i = start; i >= batchStart; i--) {
        const buf = Buffer.alloc(4);
        buf.writeUInt32LE(i, 0);
        promises.push(
          this.view<string>('dex.intear.near', 'dex_view', {
            dex_id: 'slimedragon.near/xyk',
            method: 'get_pool',
            args: buf.toString('base64'),
          })
            .then((res) => {
              if (!res) return null;
              const rawBytes = Buffer.from(typeof res === 'string' ? res : JSON.stringify(res), 'base64');
              const pool = parseIntearPool(rawBytes);
              return pool ? { id: i, data: pool } : null;
            })
            .catch(() => null)
        );
      }

      const results = await Promise.all(promises);
      for (const r of results) {
        if (r) {
          if (r.data.asset1.includes('.near')) intearPoolCache.set(r.data.asset1, r.id);
          if (r.data.asset2.includes('.near')) intearPoolCache.set(r.data.asset2, r.id);
          if (r.data.asset1 === tokenAddress || r.data.asset2 === tokenAddress) {
            intearPoolCache.set(tokenAddress, r.id);
            // FIX 5: Persist found pool ID to DB so it survives process restarts.
            // This prevents the expensive 250-pool scan from repeating after a Railway redeploy.
            setImmediate(() => {
              // @ts-ignore
              import('@racerbot/db').then(({ upsertTokenCache }) =>
                upsertTokenCache({
                  token_address: tokenAddress,
                  venue: 'intear',
                  // Store pool ID in dcl_pool_id column (reuse existing column; intear uses integer IDs)
                  dcl_pool_id: String(r.id),
                  updated_at: new Date(),
                }).catch(() => {})
              ).catch(() => {});
            });
            return r.id;
          }
        }
      }
    }

    throw new Error(`Intear pool for ${tokenAddress} not found on dex.intear.near`);
  }

  /**
   * Query Intear token state, reserves, real spot price, and liquidity on-chain.
   */
  async getIntearTokenState(tokenAddress: string): Promise<{
    poolId: number;
    poolMsg: string;
    price: number;
    liquidityNear: number;
    reserveNear: string;
    reserveToken: string;
    name: string;
    symbol: string;
    decimals: number;
    totalSupply: string;
    launchData?: {
      telegram?: string | null;
      x?: string | null;
      website?: string | null;
      description?: string | null;
      launched_by?: string | null;
    };
  }> {
    const meta = await this.getTokenMetadata(tokenAddress).catch(() => ({
      name: tokenAddress.split('.')[0] || 'Unknown',
      symbol: (tokenAddress.split('.')[0] || 'TKN').toUpperCase(),
      decimals: 24,
      total_supply: '0',
    }));

    const poolId = await this.findIntearPoolId(tokenAddress);
    const poolBuf = Buffer.alloc(4);
    poolBuf.writeUInt32LE(poolId, 0);
    const poolMsg = poolBuf.toString('base64');

    const poolRaw = await this.view<string>('dex.intear.near', 'dex_view', {
      dex_id: 'slimedragon.near/xyk',
      method: 'get_pool',
      args: poolMsg,
    });

    if (!poolRaw) {
      throw new Error(`Failed to fetch Intear pool ${poolId}`);
    }

    const rawBytes = Buffer.from(typeof poolRaw === 'string' ? poolRaw : JSON.stringify(poolRaw), 'base64');
    const pool = parseIntearPool(rawBytes);
    if (!pool) {
      throw new Error(`Failed to parse Intear pool ${poolId}`);
    }

    const isToken1 = pool.asset1 === tokenAddress;
    const reserveNear = BigInt(isToken1 ? pool.reserve2 : pool.reserve1);
    const reserveToken = BigInt(isToken1 ? pool.reserve1 : pool.reserve2);

    const nearAmt = Number(reserveNear) / 1e24;
    const tokenDecFactor = Math.pow(10, meta.decimals);
    const tokenAmt = Number(reserveToken) / tokenDecFactor;

    const price = tokenAmt > 0 ? nearAmt / tokenAmt : 0;
    const liquidityNear = nearAmt * 2;

    const launchData = await this.view<any>('launch.intear.near', 'get_launch_data', {
      token_account_id: tokenAddress,
    }).catch(() => undefined);

    return {
      poolId,
      poolMsg,
      price,
      liquidityNear,
      reserveNear: reserveNear.toString(),
      reserveToken: reserveToken.toString(),
      name: meta.name,
      symbol: meta.symbol,
      decimals: meta.decimals,
      totalSupply: meta.total_supply,
      launchData,
    };
  }

  /**
   * Compute expected output and min_amount_out dynamically from live pool reserves.
   * Never uses cached reserves older than the call itself.
   */
  async computeMinAmountOut(
    venue: 'rhea' | 'shardsmarket' | 'nearlytrade' | 'intear',
    tokenIn: string,
    tokenOut: string,
    amountIn: string,
    slippagePct: number = 2,
    rheaPoolId?: number | null,
    dclPoolId?: string | null
  ): Promise<{ expectedOutput: string; minAmountOut: string }> {
    if (venue === 'shardsmarket') {
      const targetToken = tokenIn === 'wrap.near' ? tokenOut : tokenIn;
      const reserves = await this.getShardsmarketPoolReserves(targetToken);
      const reserveNear = BigInt(reserves.reserveNear);
      const reserveToken = BigInt(reserves.reserveToken);

      const isBuy = tokenIn === 'wrap.near';
      const reserveIn = isBuy ? reserveNear : reserveToken;
      const reserveOut = isBuy ? reserveToken : reserveNear;

      const expected = calculateExpectedOutput(amountIn, reserveIn, reserveOut);
      const minOut = calculateMinAmountOut(expected, slippagePct);
      return { expectedOutput: expected.toString(), minAmountOut: minOut };
    } else if (venue === 'rhea') {
      let poolId = rheaPoolId;
      if (poolId === null || poolId === undefined) {
        poolId = await this.findRheaPoolId(tokenIn, tokenOut);
      }
      const reserves = await this.getRheaPoolReserves(poolId, tokenIn, tokenOut);
      const reserveIn = BigInt(reserves.reserveIn);
      const reserveOut = BigInt(reserves.reserveOut);

      const expected = calculateExpectedOutput(amountIn, reserveIn, reserveOut);
      const minOut = calculateMinAmountOut(expected, slippagePct);
      return { expectedOutput: expected.toString(), minAmountOut: minOut };
    } else if (venue === 'nearlytrade') {
      const targetToken = tokenIn === 'wrap.near' ? tokenOut : tokenIn;
      const state = await this.getNearlytradeTokenState(targetToken);
      const reserveNear = BigInt(state.reserveNear);
      const reserveToken = BigInt(state.reserveToken);

      const isBuy = tokenIn === 'wrap.near';
      const reserveIn = isBuy ? reserveNear : reserveToken;
      const reserveOut = isBuy ? reserveToken : reserveNear;

      // NearlyTrade DCL pools have 1% pool fee (100 bps)
      const expected = calculateExpectedOutput(amountIn, reserveIn, reserveOut, 100);
      const minOut = calculateMinAmountOut(expected, slippagePct);
      return { expectedOutput: expected.toString(), minAmountOut: minOut };
    } else if (venue === 'intear') {
      const targetToken = (tokenIn === 'wrap.near' || tokenIn === 'near') ? tokenOut : tokenIn;
      const state = await this.getIntearTokenState(targetToken);
      const reserveNear = BigInt(state.reserveNear);
      const reserveToken = BigInt(state.reserveToken);

      const isBuy = tokenIn === 'wrap.near' || tokenIn === 'near';
      const reserveIn = isBuy ? reserveNear : reserveToken;
      const reserveOut = isBuy ? reserveToken : reserveNear;

      // Intear XYK pool fee (30 bps / 0.3%)
      const expected = calculateExpectedOutput(amountIn, reserveIn, reserveOut, 30);
      const minOut = calculateMinAmountOut(expected, slippagePct);
      return { expectedOutput: expected.toString(), minAmountOut: minOut };
    } else {
      throw new Error(`Unsupported venue: ${venue}`);
    }
  }

  /** Start health-check interval for all providers */
  startHealthChecks(intervalMs = 30_000): NodeJS.Timeout {
    return setInterval(async () => {
      for (const provider of this.providers) {
        const start = Date.now();
        try {
          const near = await this.getConnection(provider.url);
          await near.connection.provider.status();
          markProviderSuccess(provider, Date.now() - start);
        } catch {
          markProviderError(provider);
        }
      }
    }, intervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Singleton factory — call once per process, reuse the connection pool */
let _nearInstance: MultiRpcNear | null = null;

export function getNear(rpcUrls?: string[]): MultiRpcNear {
  if (!_nearInstance) {
    const urls = rpcUrls ?? process.env.RPC_PROVIDERS!.split(',').map(u => u.trim());
    _nearInstance = new MultiRpcNear(urls);
  }
  return _nearInstance;
}

/**
 * FastNEAR Indexer REST API helpers (https://api.fastnear.com)
 */
export async function getFastnearAccountTokens(
  accountId: string,
  apiUrl = process.env.FASTNEAR_API_URL || 'https://api.fastnear.com'
): Promise<{ account_id: string; contract_ids: string[] }> {
  const res = await fetch(`${apiUrl}/v1/account/${accountId}/ft`);
  if (!res.ok) throw new Error(`FastNEAR API error: ${res.statusText}`);
  return res.json() as Promise<{ account_id: string; contract_ids: string[] }>;
}

export async function getFastnearPublicKeyAccounts(
  publicKey: string,
  apiUrl = process.env.FASTNEAR_API_URL || 'https://api.fastnear.com'
): Promise<{ public_key: string; account_ids: string[] }> {
  const res = await fetch(`${apiUrl}/v0/public_key/${publicKey}/all`);
  if (!res.ok) throw new Error(`FastNEAR API error: ${res.statusText}`);
  return res.json() as Promise<{ public_key: string; account_ids: string[] }>;
}

