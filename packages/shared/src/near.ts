import { connect, keyStores, Near, Account, KeyPair, utils, transactions } from 'near-api-js';
import { rotateProvider, markProviderError, markProviderSuccess, createProvider, RPCProvider } from './rpc.js';
import { calculateExpectedOutput, calculateMinAmountOut } from './utils.js';
import { upsertTokenCache } from '@racerbot/db';

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
const dclPoolIdCache = new Map<string, string>();
const registeredCache = new Set<string>();

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
  private accountCache: Map<string, Account> = new Map();
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
        const isNetworkErr =
          msg.includes('timeout') ||
          msg.includes('fetch') ||
          msg.includes('ECONN') ||
          msg.includes('ETIMEDOUT') ||
          msg.includes('EAI_AGAIN') ||
          /\b50[0-4]\b/.test(msg) ||
          msg.includes('socket hang up');
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
   * Wait for transaction confirmation by polling with improved error handling.
   * Used after broadcast to confirm the tx landed.
   */
  async waitForTx(txHash: string, accountId: string, maxWaitMs = 60000): Promise<any> {
    const deadline = Date.now() + maxWaitMs;
    const providers = this.providers.filter(p => p.healthy);
    
    if (providers.length === 0) {
      throw new Error('No healthy RPC providers available for transaction confirmation');
    }

    let lastError: Error | null = null;
    let parseErrors = 0;
    const maxParseErrors = 5;

    while (Date.now() < deadline) {
      // Try each healthy provider in sequence for better resilience
      for (const provider of providers) {
        try {
          const near = await this.getConnection(provider.url);
          const outcome = await near.connection.provider.txStatus(txHash, accountId, 'EXECUTED_OPTIMISTIC');
          
          if (outcome.status && typeof outcome.status === 'object' && 'SuccessValue' in outcome.status) {
            return outcome;
          }
          
          if (outcome.status && typeof outcome.status === 'object' && 'Failure' in outcome.status) {
            const failureDetails = outcome.status.Failure;
            throw new Error(`Transaction failed: ${JSON.stringify(failureDetails)}`);
          }
          
          // Transaction exists but not yet executed
          lastError = null;
          break; // Success in getting status, move to next provider
          
        } catch (err) {
          lastError = err as Error;
          const errorMessage = (err as Error).message.toLowerCase();
          
          // Track parse errors specifically
          if (errorMessage.includes('parse') || errorMessage.includes('json')) {
            parseErrors++;
            if (parseErrors >= maxParseErrors) {
              throw new Error(`Transaction ${txHash} confirmation failed after ${parseErrors} parse errors. Last error: ${lastError.message}`);
            }
          }
          
          // Try next provider
          continue;
        }
      }
      
      // Wait before next polling round
      await sleep(1000);
    }

    // If we exit the loop, transaction wasn't confirmed
    const timeElapsed = Date.now() - (deadline - maxWaitMs);
    throw new Error(`Transaction ${txHash} not confirmed within ${maxWaitMs}ms (waited ${timeElapsed}ms). Last error: ${lastError?.message || 'Unknown'}`);
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
   * Cached per accountId for the process lifetime so the nonce cache persists.
   */
  async getAccount(accountId: string): Promise<Account> {
    if (this.accountCache.has(accountId)) {
      return this.accountCache.get(accountId)!;
    }
    const provider = rotateProvider(this.providers);
    const near = await this.getConnection(provider.url);
    const account = await near.account(accountId);
    this.accountCache.set(accountId, account);
    return account;
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
    const cacheKey = `${accountId}:${tokenAddress}`;
    if (registeredCache.has(cacheKey)) {
      return;
    }

    try {
      const balance = await this.view<any>(tokenAddress, 'storage_balance_of', { account_id: accountId });
      if (balance && balance.total) {
        registeredCache.add(cacheKey);
        return; // Already registered
      }
    } catch {
      // Some tokens don't implement storage_balance_of
    }

    try {
      // Query token's storage balance bounds to get exact required deposit if possible
      let deposit = BigInt('12500000000000000000000'); // 0.0125 NEAR fallback
      if (tokenAddress === 'wrap.near') {
        deposit = BigInt('1250000000000000000000'); // 0.00125 NEAR
      } else {
        const bounds = await this.view<any>(tokenAddress, 'storage_balance_bounds', {}).catch(() => null);
        if (bounds && bounds.min) {
          deposit = BigInt(bounds.min);
        }
      }

      await this.signAndSendTransactionAll(accountId, tokenAddress, [
        transactions.functionCall(
          'storage_deposit',
          { account_id: accountId, registration_only: true },
          BigInt('30000000000000'),
          deposit
        ),
      ]);
      registeredCache.add(cacheKey);
    } catch (err) {
      console.warn(`[NEAR] storage_deposit registration_only failed for ${accountId} on ${tokenAddress}:`, (err as Error).message);
      // Try once more without registration_only for older token contracts
      try {
        const deposit = tokenAddress === 'wrap.near'
          ? BigInt('1250000000000000000000')
          : BigInt('12500000000000000000000');
        await this.signAndSendTransactionAll(accountId, tokenAddress, [
          transactions.functionCall(
            'storage_deposit',
            { account_id: accountId },
            BigInt('30000000000000'),
            deposit
          ),
        ]);
        registeredCache.add(cacheKey);
      } catch (err2) {
        console.warn(`[NEAR] fallback storage_deposit failed for ${accountId} on ${tokenAddress}:`, (err2 as Error).message);
      }
    }
  }

  /**
   * Find Rhea pool ID for a token pair with in-memory caching and fast parallel scanning.
   * Scans both newly created pools (backwards from latest) and top historical pools in parallel.
   */
  async findRheaPoolId(tokenA: string, tokenB: string): Promise<number> {
    const cacheKey1 = `${tokenA}:${tokenB}`;
    const cacheKey2 = `${tokenB}:${tokenA}`;
    if (rheaPoolIdCache.has(cacheKey1)) return rheaPoolIdCache.get(cacheKey1)!;
    if (rheaPoolIdCache.has(cacheKey2)) return rheaPoolIdCache.get(cacheKey2)!;

    const batchSize = 100;
    const batchStarts = [0, 100, 200, 300, 400]; // Top 500 active Ref pools

    // Also probe recent pools created near the end of the pool list
    const numPools = await this.view<number>('v2.ref-finance.near', 'get_number_of_pools', {}).catch(() => 0);
    const recentStarts: number[] = [];
    if (numPools && numPools > 500) {
      for (let s = Math.max(500, numPools - batchSize); s >= Math.max(500, numPools - 1000); s -= batchSize) {
        recentStarts.push(s);
      }
    }

    const allStarts = [...recentStarts, ...batchStarts];

    const results = await Promise.allSettled(
      allStarts.map(async (fromIndex) => {
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
   * Find DCL (Discretized Concentrated Liquidity) pool on dclv2.ref-labs.near.
   * Probes standard fee tiers [10000, 3000, 2000, 400, 100] in parallel.
   */
  async findDclPoolId(tokenA: string, tokenB: string): Promise<string | null> {
    const key = `${tokenA}:${tokenB}`;
    const cached = dclPoolIdCache.get(key);
    if (cached) return cached;

    const tokenX = tokenA < tokenB ? tokenA : tokenB;
    const tokenY = tokenA < tokenB ? tokenB : tokenA;
    const feeTiers = [10000, 3000, 2000, 400, 100];

    const results = await Promise.allSettled(
      feeTiers.map(async (fee) => {
        const poolId = `${tokenX}|${tokenY}|${fee}`;
        const pool = await this.view<any>('dclv2.ref-labs.near', 'get_pool', { pool_id: poolId });
        if (pool && pool.state === 'Running') {
          return poolId;
        }
        throw new Error('not running');
      })
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        dclPoolIdCache.set(key, r.value);
        dclPoolIdCache.set(`${tokenB}:${tokenA}`, r.value);
        return r.value;
      }
    }
    return null;
  }

  /**
   * Get DCL pool state including spot price and liquidity from dclv2.ref-labs.near.
   */
  async getDclPoolState(poolId: string, baseToken?: string): Promise<{
    poolId: string;
    tokenX: string;
    tokenY: string;
    price: number;
    liquidityNear: number;
    reserveNear: string;
    reserveToken: string;
  }> {
    const pool = await this.view<any>('dclv2.ref-labs.near', 'get_pool', { pool_id: poolId });
    if (!pool) {
      throw new Error(`DCL pool ${poolId} not found`);
    }

    const isBaseTokenX = pool.token_x === (baseToken || 'wrap.near');
    const isBaseTokenY = pool.token_y === (baseToken || 'wrap.near');
    const baseIsX = isBaseTokenX || (!isBaseTokenY);
    const targetToken = baseIsX ? pool.token_y : pool.token_x;
    const baseAccount = baseIsX ? pool.token_x : pool.token_y;

    const [targetMeta, baseMeta] = await Promise.all([
      this.getTokenMetadata(targetToken).catch(() => ({ decimals: 18 })),
      this.getTokenMetadata(baseAccount).catch(() => ({ decimals: 24 })),
    ]);
    const targetDecimals = targetMeta?.decimals ?? 18;
    const baseDecimals = baseMeta?.decimals ?? 24;

    const currentPoint = Number(pool.current_point);
    let price = 0;
    if (pool.current_point !== undefined && pool.current_point !== null && !isNaN(currentPoint)) {
      const rawPrice = Math.pow(1.0001, currentPoint) * Math.pow(10, (baseIsX ? baseDecimals - targetDecimals : targetDecimals - baseDecimals));
      price = baseIsX ? (rawPrice > 0 ? 1 / rawPrice : 0) : rawPrice;
    }

    const reserveNear = baseIsX ? (pool.total_x || '0') : (pool.total_y || '0');
    const reserveToken = baseIsX ? (pool.total_y || '0') : (pool.total_x || '0');
    const reserveNearNum = parseFloat(reserveNear) / Math.pow(10, baseDecimals);
    const liquidityNear = reserveNearNum * 2;

    return {
      poolId,
      tokenX: pool.token_x,
      tokenY: pool.token_y,
      price,
      liquidityNear,
      reserveNear,
      reserveToken,
    };
  }

  /**
   * Get OneTokenHub launchpad state and associated DCL pool state on dclv2.ref-labs.near.
   */
  async getOneTokenHubState(tokenAddress: string): Promise<{
    token: string;
    step: string;
    dclPoolId: string | null;
    pairedToken: string;
    price: number;
    liquidityNear: number;
    reserveNear: string;
    reserveToken: string;
    totalSupply: string;
  }> {
    const launch = await this.view<any>(
      'pad.onetokenhub.near',
      'get_launch_by_token',
      { token: tokenAddress }
    ).catch(() => null);

    if (!launch) {
      throw new Error(`Token ${tokenAddress} not found on OneTokenHub launchpad`);
    }

    const dclPoolId = launch.pool_id || null;
    let pairedToken = 'wrap.near';
    if (dclPoolId) {
      const parts = dclPoolId.split('|');
      if (parts.length >= 2) {
        pairedToken = parts[0] === tokenAddress ? parts[1] : parts[0];
      }
    }

    let price = 0;
    let liquidityNear = 0;
    let reserveNear = '0';
    let reserveToken = '0';

    if (dclPoolId) {
      try {
        const dcl = await this.getDclPoolState(dclPoolId, pairedToken);
        price = dcl.price;
        liquidityNear = dcl.liquidityNear;
        reserveNear = dcl.reserveNear;
        reserveToken = dcl.reserveToken;
      } catch {
        // Pool may be newly creating or not yet seeded
      }
    }

    return {
      token: tokenAddress,
      step: launch.step || 'Unknown',
      dclPoolId,
      pairedToken,
      price,
      liquidityNear,
      reserveNear,
      reserveToken,
      totalSupply: launch.total_supply || '0',
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
              upsertTokenCache({
                token_address: tokenAddress,
                venue: 'intear',
                // Store pool ID in dcl_pool_id column (reuse existing column; intear uses integer IDs)
                dcl_pool_id: String(r.id),
                updated_at: new Date(),
              }).catch(() => {});
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
    venue: 'rhea' | 'shardsmarket' | 'nearlytrade' | 'intear' | 'onetokenhub',
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
      if (dclPoolId) {
        try {
          const inToken = tokenIn === 'near' ? 'wrap.near' : tokenIn;
          const outToken = tokenOut === 'near' ? 'wrap.near' : tokenOut;
          const quote = await this.view<any>('dclv2.ref-labs.near', 'quote', {
            pool_ids: [dclPoolId],
            input_token: inToken,
            output_token: outToken,
            input_amount: amountIn,
          });
          const expected = BigInt(quote?.amount || '0');
          if (expected > 0n) {
            const minOut = calculateMinAmountOut(expected, slippagePct);
            return { expectedOutput: expected.toString(), minAmountOut: minOut };
          }
        } catch {
          // fallback to simple pool if quote view fails
        }
      }
      let poolId = rheaPoolId;
      if (poolId === null || poolId === undefined) {
        poolId = await this.findRheaPoolId(tokenIn, tokenOut);
      }

      const inToken = tokenIn === 'near' ? 'wrap.near' : tokenIn;
      const outToken = tokenOut === 'near' ? 'wrap.near' : tokenOut;

      // Try on-chain get_return on v2.ref-finance.near first (supports SIMPLE_POOL, STABLE_SWAP, RATED_SWAP)
      try {
        const ret = await this.view<string>('v2.ref-finance.near', 'get_return', {
          pool_id: poolId,
          token_in: inToken,
          amount_in: amountIn,
          token_out: outToken,
        });
        const expected = BigInt(ret || '0');
        if (expected > 0n) {
          const minOut = calculateMinAmountOut(expected, slippagePct);
          return { expectedOutput: expected.toString(), minAmountOut: minOut };
        }
      } catch {
        // Fallback to local reserve calculation
      }

      const reserves = await this.getRheaPoolReserves(poolId, tokenIn, tokenOut);
      const reserveIn = BigInt(reserves.reserveIn);
      const reserveOut = BigInt(reserves.reserveOut);

      const expected = calculateExpectedOutput(amountIn, reserveIn, reserveOut, reserves.fee);
      const minOut = calculateMinAmountOut(expected, slippagePct);
      return { expectedOutput: expected.toString(), minAmountOut: minOut };
    } else if (venue === 'nearlytrade') {
      const targetToken = tokenIn === 'wrap.near' ? tokenOut : tokenIn;
      let state;
      try {
        state = await this.getNearlytradeTokenState(targetToken);
      } catch {
        // If NearlyTrade RPC fails, check if Rhea has a pool as fallback
        try {
          const rheaPoolId = await this.findRheaPoolId(tokenIn, tokenOut);
          if (rheaPoolId) {
            // Use Rhea pool calculation
            const inToken = tokenIn === 'near' ? 'wrap.near' : tokenIn;
            const outToken = tokenOut === 'near' ? 'wrap.near' : tokenOut;
            const ret = await this.view<string>('v2.ref-finance.near', 'get_return', {
              pool_id: rheaPoolId,
              token_in: inToken,
              amount_in: amountIn,
              token_out: outToken,
            });
            const expected = BigInt(ret || '0');
            if (expected > 0n) {
              const minOut = calculateMinAmountOut(expected, slippagePct);
              return { expectedOutput: expected.toString(), minAmountOut: minOut };
            }
          }
        } catch {
          // Ignore Rhea lookup errors
        }
        throw new Error(
          `NearlyTrade token ${targetToken} is not yet bonded and has no Rhea pool. Wait for bonding or pool creation.`
        );
      }
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
      let state;
      try {
        state = await this.getIntearTokenState(targetToken);
      } catch {
        throw new Error(
          `Intear RPC failed for ${targetToken}. Token may be on Intear but RPC is unreachable.`
        );
      }
      const reserveNear = BigInt(state.reserveNear);
      const reserveToken = BigInt(state.reserveToken);

      const isBuy = tokenIn === 'wrap.near' || tokenIn === 'near';
      const reserveIn = isBuy ? reserveNear : reserveToken;
      const reserveOut = isBuy ? reserveToken : reserveNear;

      // Intear XYK pool fee (30 bps / 0.3%)
      const expected = calculateExpectedOutput(amountIn, reserveIn, reserveOut, 30);
      const minOut = calculateMinAmountOut(expected, slippagePct);
      return { expectedOutput: expected.toString(), minAmountOut: minOut };
    } else if (venue === 'onetokenhub') {
      const targetToken = (tokenIn === 'wrap.near' || tokenIn === 'near') ? tokenOut : tokenIn;
      let poolId = dclPoolId;
      if (!poolId) {
        const state = await this.getOneTokenHubState(targetToken);
        poolId = state.dclPoolId;
      }
      if (!poolId) {
        throw new Error(`No DCL pool found for OneTokenHub token ${targetToken}`);
      }

      const inToken = tokenIn === 'near' ? 'wrap.near' : tokenIn;
      const outToken = tokenOut === 'near' ? 'wrap.near' : tokenOut;
      const quote = await this.view<any>('dclv2.ref-labs.near', 'quote', {
        pool_ids: [poolId],
        input_token: inToken,
        output_token: outToken,
        input_amount: amountIn,
      });
      const expected = BigInt(quote?.amount || '0');
      if (expected <= 0n) {
        throw new Error(`Insufficient liquidity or zero output for OneTokenHub quote on pool ${poolId}`);
      }
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
          // Timeout guards a hung provider from piling up overlapping checks
          await withTimeout(near.connection.provider.status(), 5000, `Health check timeout ${provider.url}`);
          markProviderSuccess(provider, Date.now() - start);
        } catch {
          markProviderError(provider);
        }
      }
    }, intervalMs);
  }

  /**
   * Current spot price of `tokenAddress` in NEAR plus the NEAR-side reserve,
   * read from the venue's live pool state. Used for trigger price refreshes
   * and initial token pricing. Returns null when no live pool is found.
   */
  async getVenueSpotPrice(
    venue: string,
    tokenAddress: string,
    decimals: number
  ): Promise<{ price: number; reserveNearYocto: string } | null> {
    if (venue === 'rhea') {
      const poolId = await this.findRheaPoolId('wrap.near', tokenAddress).catch(() => null);
      if (poolId !== null) {
        const r = await this.getRheaPoolReserves(poolId, 'wrap.near', tokenAddress);
        const rIn = parseFloat(r.reserveIn);
        const rOut = parseFloat(r.reserveOut);
        if (rIn > 0 && rOut > 0) {
          return {
            reserveNearYocto: r.reserveIn,
            price: rIn / 1e24 / (rOut / Math.pow(10, decimals)),
          };
        }
      }
      const dclPoolId = await this.findDclPoolId('wrap.near', tokenAddress).catch(() => null);
      if (dclPoolId) {
        const dcl = await this.getDclPoolState(dclPoolId).catch(() => null);
        if (dcl && dcl.price > 0) {
          return {
            reserveNearYocto: dcl.reserveNear,
            price: dcl.price,
          };
        }
      }
      return null;
    }
    if (venue === 'shardsmarket') {
      const st = await this.getShardsmarketTokenState(tokenAddress);
      const rNear = parseFloat(st.poolQuote);
      const rTok = parseFloat(st.poolToken);
      if (rNear <= 0 || rTok <= 0) return null;
      return {
        reserveNearYocto: st.poolQuote,
        price: rNear / 1e24 / (rTok / Math.pow(10, decimals)),
      };
    }
    if (venue === 'nearlytrade') {
      const st = await this.getNearlytradeTokenState(tokenAddress);
      if (!(st.price > 0)) return null;
      return { reserveNearYocto: st.reserveNear, price: st.price };
    }
    if (venue === 'intear') {
      const st = await this.getIntearTokenState(tokenAddress);
      if (!(st.price > 0)) return null;
      return { reserveNearYocto: st.reserveNear, price: st.price };
    }
    if (venue === 'onetokenhub') {
      const st = await this.getOneTokenHubState(tokenAddress).catch(() => null);
      if (!st || !(st.price > 0)) return null;
      return { reserveNearYocto: st.reserveNear, price: st.price };
    }
    return null;
  }

  /**
   * Build + sign the transaction ONCE, then broadcast the same signed bytes
   * to ALL healthy RPC providers simultaneously, then poll for the execution
   * outcome. This is the write path used by the executor — a single slow or
   * dead RPC can no longer delay or drop a trade.
   *
   * Returns a FinalExecutionOutcome-shaped object:
   *   { status, transaction: { hash }, transaction_outcome, receipts_outcome }
   */
  async signAndSendTransactionAll(
    accountId: string,
    receiverId: string,
    actions: any[],
    waitForMs = 90_000
  ): Promise<any> {
    const account = await this.getAccount(accountId);
    // signTransaction is protected on Account — sign via the same code path
    // near-api-js uses internally (returns [txHash, signedTx]).
    const signOnce = async (): Promise<{ hash: string; signedB64: string }> => {
      const [txHash, signedTx] = await withTimeout<any[]>(
        (account as any).signTransaction(receiverId, actions),
        8_000,
        `Signing timed out for ${accountId}`
      );
      return {
        hash: utils.serialize.base_encode(txHash as Uint8Array),
        signedB64: Buffer.from(transactions.encodeTransaction(signedTx)).toString('base64'),
      };
    };

    let signed = await signOnce();
    let results = await this.broadcastSignedToAll(signed.signedB64);

    // All providers rejected the nonce → the cached access-key nonce is stale.
    // Clear it, re-sign with a fresh nonce and rebroadcast exactly once.
    const allNonceErrors = results.every(
      (r) => r.status === 'rejected' && /nonce/i.test((r.reason as Error)?.message ?? '')
    );
    if (allNonceErrors && results.length > 0) {
      (account as any).accessKeyByPublicKeyCache = {};
      signed = await signOnce();
      results = await this.broadcastSignedToAll(signed.signedB64);
    }

    if (!results.some((r) => r.status === 'fulfilled')) {
      const errors = results
        .map((r) => (r.status === 'rejected' ? (r.reason as Error).message : ''))
        .filter(Boolean)
        .join('; ');
      throw new Error(`All NEAR RPC broadcast failed: ${errors}`);
    }

    return this.awaitOutcome(signed.hash, accountId, waitForMs);
  }

  /** Broadcast identical signed bytes to every healthy provider in parallel. */
  private async broadcastSignedToAll(
    signedB64: string
  ): Promise<PromiseSettledResult<string>[]> {
    const healthy = this.providers.filter((p) => p.healthy);
    const targets = healthy.length > 0 ? healthy : this.providers;
    if (targets.length === 0) throw new Error('No NEAR RPC providers configured');

    return Promise.allSettled(
      targets.map(async (provider) => {
        const start = Date.now();
        try {
          const res = await fetch(provider.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 'racerbot-broadcast',
              method: 'broadcast_tx_async',
              params: [signedB64],
            }),
            signal: AbortSignal.timeout(7000),
          });
          const data: any = await res.json();
          if (data?.error) {
            throw new Error(data.error.message || JSON.stringify(data.error));
          }
          markProviderSuccess(provider, Date.now() - start);
          return data?.result as string;
        } catch (err) {
          markProviderError(provider);
          throw err;
        }
      })
    );
  }

  /**
   * Poll for a transaction outcome using two tracks in parallel:
   *   A) NEAR JSON-RPC `tx` method with `wait_until: EXECUTED_OPTIMISTIC` — non-long-polling;
   *      returns immediately once the tx appears in the chain (no receipt-tree wait).
   *   B) FastNEAR indexer REST API — indexes NEAR in ~1 s, responds instantly.
   *
   * HANDLER_ERROR / TIMEOUT_ERROR from the RPC is treated as "pending, retry" — NOT fatal.
   * The old `txStatus` long-poll was causing false failures when the RPC held the connection
   * open waiting for cross-contract receipt trees, then returned TIMEOUT_ERROR.
   */
  private async awaitOutcome(txHash: string, accountId: string, maxMs: number): Promise<any> {
    const deadline = Date.now() + maxMs;
    let lastErr: Error | null = null;

    const fastnearApiBase =
      (process.env.FASTNEAR_API_URL || 'https://api.fastnear.com').replace(/\/$/, '');

    /** Try FastNEAR indexer REST — resolves immediately once tx is indexed */
    const tryFastnear = async (): Promise<any | null> => {
      try {
        const res = await fetch(`${fastnearApiBase}/v0/tx/${txHash}`, {
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return null;
        const data: any = await res.json();
        // FastNEAR returns { receipts_outcome, transaction_outcome, ... }
        if (data && data.transaction_outcome) return data;
      } catch {
        // indexer not available — fall through
      }
      return null;
    };

    /**
     * Try a single RPC provider for tx status.
     *
     * Strategy: try the newer `tx` method first (non-long-polling, fast).
     * If the provider returns -32601 (method not found), fall back to
     * `EXPERIMENTAL_tx_status` with array params (universally supported).
     * In both cases, TIMEOUT_ERROR / HANDLER_ERROR / UNKNOWN_TRANSACTION
     * are treated as "pending" — return null so the caller retries.
     * -32601 (method not found) is also treated as "skip, retry later".
     */
    const tryRpc = async (providerUrl: string): Promise<any | null> => {
      const callRpc = async (method: string, params: any): Promise<any | null> => {
        try {
          const res = await fetch(providerUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 'await-outcome', method, params }),
            signal: AbortSignal.timeout(6000),
          });
          
          if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${res.statusText}`);
          }
          
          const text = await res.text();
          if (!text || text.trim() === '') {
            throw new Error('Empty response from RPC');
          }
          
          return JSON.parse(text);
        } catch (err: any) {
          // Enhanced error handling for parse errors
          if (err instanceof SyntaxError) {
            throw new Error(`Parse error: Invalid JSON response from ${providerUrl}`);
          }
          throw err;
        }
      };

      try {
        // First attempt: newer `tx` method with array params (NEAR node ≥ 1.30)
        let data: any = await callRpc('tx', [txHash, accountId, 'EXECUTED_OPTIMISTIC']);

        // If provider doesn't know `tx`, fall back to EXPERIMENTAL_tx_status
        if (data?.error?.code === -32601) {
          data = await callRpc('EXPERIMENTAL_tx_status', [txHash, accountId, 'EXECUTED_OPTIMISTIC']);
        }

        if (data?.error) {
          const code: number = data.error?.code ?? 0;
          const errName: string = data.error?.cause?.name ?? data.error?.name ?? data.error?.message ?? '';
          // Transient / "not yet indexed" conditions — return null to retry
          if (
            code === -32601 ||                         // method still not available
            errName.includes('TIMEOUT') ||
            errName.includes('HANDLER_ERROR') ||
            errName.includes('UNKNOWN_TRANSACTION') ||
            errName.includes('does not exist') ||
            errName.includes('Parse error')           // Treat parse errors as transient
          ) {
            return null;
          }
          throw new Error(data.error.message || JSON.stringify(data.error));
        }

        const outcome = data?.result;
        if (outcome && outcome.status !== undefined && outcome.status !== null) {
          return outcome;
        }
      } catch (err: any) {
        // Network-level or thrown error — record and continue
        lastErr = err as Error;
        
        // If it's a parse error, mark the provider as unhealthy
        if (err.message?.includes('Parse error')) {
          const provider = this.providers.find(p => p.url === providerUrl);
          if (provider) {
            markProviderError(provider);
          }
        }
      }
      return null;
    };


    while (Date.now() < deadline) {
      // Race FastNEAR indexer and all healthy RPC providers
      const healthy = this.providers.filter((p) => p.healthy);
      const candidates = healthy.length > 0 ? healthy : this.providers;

      const polls = [
        tryFastnear(),
        ...candidates.map((p) => tryRpc(p.url)),
      ];

      const results = await Promise.allSettled(polls);
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value !== null) {
          return r.value;
        }
        if (r.status === 'rejected') {
          lastErr = (r as PromiseRejectedResult).reason as Error;
        }
      }

      await sleep(800);
    }

    throw new Error(
      `Transaction ${txHash} not confirmed within ${maxMs}ms${lastErr ? `: ${lastErr.message}` : ''}`
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Safe defaults so a missing/partial RPC_PROVIDERS never crashes a service. */
export const DEFAULT_RPC_URLS = [
  'https://rpc.mainnet.fastnear.com',
  'https://free.rpc.fastnear.com',
  'https://rpc.near.org',
];

/** Singleton factory — call once per process, reuse the connection pool */
let _nearInstance: MultiRpcNear | null = null;

export function getNear(rpcUrls?: string[]): MultiRpcNear {
  if (!_nearInstance) {
    const urls =
      rpcUrls ??
      (process.env.RPC_PROVIDERS ?? '')
        .split(',')
        .map((u) => u.trim())
        .filter(Boolean);
    _nearInstance = new MultiRpcNear(urls.length > 0 ? urls : DEFAULT_RPC_URLS);
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

