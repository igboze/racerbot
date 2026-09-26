import { RPCProvider, createProvider, markProviderError, markProviderSuccess, getRpcProvider, rotateProvider, QuickNodeProvider, createQuickNodeProvider } from '@racerbot/shared';
import { retryWithBackoff, sleep } from '@racerbot/shared';

export class MultiRpcProvider {
  private providers: RPCProvider[];
  private readonly healthCheckIntervalMs: number;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private quickNodeProvider: QuickNodeProvider | null = null;
  private fastNearProvider: RPCProvider | null = null;

  constructor(providerUrls: string[]) {
    // Initialize QuickNode for data updates
    this.quickNodeProvider = createQuickNodeProvider();

    // Prepare FastNear premium API key for trading
    const apiKey = process.env.FASTNEAR_API_KEY?.trim();
    const hasValidKey = apiKey && !apiKey.startsWith('TEMP') && !apiKey.startsWith('change-me');

    // Add QuickNode URL to providers if configured
    const quickNodeUrl = process.env.QUICKNODE_ENDPOINT_URL;
    const allUrls = quickNodeUrl ? [quickNodeUrl, ...providerUrls] : providerUrls;

    this.providers = allUrls.map((url, i) => {
      const isQuickNode = url === quickNodeUrl;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      // Add Bearer token for FastNear premium (trading)
      if (url.includes('rpc.mainnet.fastnear.com') && hasValidKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
        // Store reference to FastNear provider for trading operations
        this.fastNearProvider = { url, name: `provider-${i}`, healthy: true, latency: 0, errorCount: 0, successCount: 0, isQuickNode: false, headers };
      }

      return createProvider(url, `provider-${i}`, isQuickNode, headers);
    });

    this.healthCheckIntervalMs = parseInt(process.env.HEALTH_CHECK_INTERVAL_MS || '30000');
    this.startHealthChecks();
  }

  getProviders(): RPCProvider[] {
    return this.providers;
  }

  getHealthyProviders(): RPCProvider[] {
    return this.providers.filter(p => p.healthy);
  }

  /**
   * Get QuickNode provider for data updates
   */
  getQuickNodeProvider(): QuickNodeProvider | null {
    if (this.quickNodeProvider && this.quickNodeProvider.isHealthy()) {
      return this.quickNodeProvider;
    }
    return null;
  }

  /**
   * Get FastNear provider for trading operations
   */
  getFastNearProvider(): RPCProvider | null {
    if (this.fastNearProvider && this.fastNearProvider.healthy) {
      return this.fastNearProvider;
    }
    return null;
  }

  /**
   * Trading operations: Use FastNear (NEAR-optimized)
   */
  async trade<T>(fn: (url: string, headers?: Record<string, string>) => Promise<T>): Promise<T> {
    // Use FastNear for trading (swaps, buys, sells)
    const fastNear = this.getFastNearProvider();
    if (fastNear) {
      const start = Date.now();
      try {
        const result = await fn(fastNear.url, fastNear.headers);
        markProviderSuccess(fastNear, Date.now() - start);
        return result;
      } catch (err) {
        markProviderError(fastNear);
        console.error('[RPC] FastNear trading failed, falling back to other providers');
      }
    }

    // Fallback to any healthy provider
    const provider = rotateProvider(this.providers);
    const start = Date.now();
    try {
      const result = await fn(provider.url, provider.headers);
      markProviderSuccess(provider, Date.now() - start);
      return result;
    } catch (err) {
      markProviderError(provider);
      throw err;
    }
  }

  /**
   * Data operations: Use QuickNode (enhanced indexing)
   */
  async data<T>(fn: (url: string, headers?: Record<string, string>) => Promise<T>): Promise<T> {
    // Use QuickNode for data updates (block scanning, indexing)
    const qn = this.getQuickNodeProvider();
    if (qn) {
      try {
        const start = Date.now();
        const quickNodeUrl = process.env.QUICKNODE_ENDPOINT_URL || '';
        const result = await fn(quickNodeUrl);
        qn.markHealthy();
        return result;
      } catch (err) {
        console.error('[RPC] QuickNode data failed, falling back to FastNear');
        qn.markUnhealthy();
      }
    }

    // Fallback to FastNear for data
    const fastNear = this.getFastNearProvider();
    if (fastNear) {
      const start = Date.now();
      try {
        const result = await fn(fastNear.url, fastNear.headers);
        markProviderSuccess(fastNear, Date.now() - start);
        return result;
      } catch (err) {
        markProviderError(fastNear);
      }
    }

    // Final fallback to any healthy provider
    const provider = rotateProvider(this.providers);
    const start = Date.now();
    try {
      const result = await fn(provider.url, provider.headers);
      markProviderSuccess(provider, Date.now() - start);
      return result;
    } catch (err) {
      markProviderError(provider);
      throw err;
    }
  }

  /**
   * Legacy read method (defaults to trading/fastNear)
   */
  async read<T>(fn: (url: string, headers?: Record<string, string>) => Promise<T>): Promise<T> {
    return this.trade(fn);
  }

  async broadcast<T>(fn: (url: string, headers?: Record<string, string>) => Promise<T>): Promise<T> {
    // Broadcast to all healthy providers for critical operations
    const results = await Promise.allSettled(
      this.providers.filter(p => p.healthy).map(async (provider) => {
        const start = Date.now();
        try {
          const result = await fn(provider.url, provider.headers);
          markProviderSuccess(provider, Date.now() - start);
          return result;
        } catch (err) {
          markProviderError(provider);
          throw err;
        }
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        return result.value;
      }
    }

    throw new Error('All RPC providers failed');
  }

  private startHealthChecks(): void {
    this.healthCheckTimer = setInterval(async () => {
      for (const provider of this.providers) {
        try {
          const start = Date.now();
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
          };

          // Add Bearer token for FastNear premium
          const apiKey = process.env.FASTNEAR_API_KEY?.trim();
          const hasValidKey = apiKey && !apiKey.startsWith('TEMP') && !apiKey.startsWith('change-me');
          if (provider.url.includes('rpc.mainnet.fastnear.com') && hasValidKey) {
            headers['Authorization'] = `Bearer ${apiKey}`;
          }

          await fetch(provider.url + '/status', { headers });
          markProviderSuccess(provider, Date.now() - start);
        } catch {
          markProviderError(provider);
        }
      }

      // Also check QuickNode health
      if (this.quickNodeProvider) {
        try {
          await this.quickNodeProvider.getBlockNumber();
          this.quickNodeProvider.markHealthy();
        } catch {
          this.quickNodeProvider.markUnhealthy();
        }
      }
    }, this.healthCheckIntervalMs);
  }

  async destroy(): Promise<void> {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }
  }
}

export function createMultiRpc(providerUrls: string[]): MultiRpcProvider {
  return new MultiRpcProvider(providerUrls);
}