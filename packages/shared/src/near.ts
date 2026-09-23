import { connect, keyStores, Near, Account, KeyPair } from 'near-api-js';
import { rotateProvider, markProviderError, markProviderSuccess, createProvider, RPCProvider } from './rpc.js';

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

  constructor(rpcUrls: string[], networkId = 'mainnet') {
    this.providers = rpcUrls.map((url, i) => createProvider(url, `near-rpc-${i}`));
    this.keyStore = new keyStores.InMemoryKeyStore();
    this.networkId = networkId;
  }

  private async getConnection(providerUrl: string): Promise<Near> {
    if (this.connections.has(providerUrl)) {
      return this.connections.get(providerUrl)!;
    }

    const apiKey = process.env.FASTNEAR_API_KEY;
    let nodeUrl = providerUrl;
    const isMainnetFastnear = nodeUrl.includes('rpc.mainnet.fastnear.com');

    if (isMainnetFastnear && apiKey && !nodeUrl.includes('apiKey=')) {
      const sep = nodeUrl.includes('?') ? '&' : '?';
      nodeUrl = `${nodeUrl}${sep}apiKey=${apiKey}`;
    }

    const conn = await connect({
      networkId: this.networkId,
      nodeUrl,
      keyStore: this.keyStore,
    });

    if (isMainnetFastnear && apiKey) {
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
    const healthy = this.providers.filter(p => p.healthy);
    if (healthy.length === 0) throw new Error('No healthy NEAR RPC providers');

    let lastErr: Error | null = null;
    for (const provider of healthy) {
      const start = Date.now();
      try {
        const near = await this.getConnection(provider.url);
        const account = await near.account('');
        const result = await account.viewFunction({ contractId, methodName, args });
        markProviderSuccess(provider, Date.now() - start);
        return result as T;
      } catch (err) {
        markProviderError(provider);
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
    const account = await this.getAccount(accountId);
    const state = await account.state();
    return state.amount;
  }

  /**
   * Get pool reserves from Rhea Finance.
   * Rhea uses get_return to compute output, and ft_balances_of for reserves.
   */
  async getRheaPoolReserves(poolAddress: string, tokenIn: string, tokenOut: string): Promise<{ reserveIn: string; reserveOut: string; fee: number }> {
    try {
      const poolInfo = await this.view<any>(
        'rhea.finance',
        'get_pool',
        { pool_id: poolAddress }
      );
      return {
        reserveIn: poolInfo.amounts?.[0] ?? '0',
        reserveOut: poolInfo.amounts?.[1] ?? '0',
        fee: poolInfo.total_fee ?? 30,
      };
    } catch {
      return { reserveIn: '0', reserveOut: '0', fee: 30 };
    }
  }

  /**
   * Get pool reserves from Shardsmarket.
   */
  async getShardsmarketPoolReserves(tokenAddress: string): Promise<{ reserveNear: string; reserveToken: string }> {
    try {
      const poolInfo = await this.view<any>(
        'factory.shardsmarket.near',
        'get_pool',
        { token_id: tokenAddress }
      );
      return {
        reserveNear: poolInfo.near_amount ?? '0',
        reserveToken: poolInfo.token_amount ?? '0',
      };
    } catch {
      return { reserveNear: '0', reserveToken: '0' };
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

