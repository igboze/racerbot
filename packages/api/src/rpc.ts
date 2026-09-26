import { RPCProvider, createProvider, markProviderError, markProviderSuccess, getRpcProvider, rotateProvider, QuickNodeProvider, createQuickNodeProvider } from '@racerbot/shared';
import { retryWithBackoff, sleep } from '@racerbot/shared';

export class MultiRpcProvider {
  private providers: RPCProvider[];
  private readonly healthCheckIntervalMs: number;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private quickNodeProvider: QuickNodeProvider | null = null;

  constructor(providerUrls: string[]) {
    // Initialize QuickNode if available
    this.quickNodeProvider = createQuickNodeProvider();

    // Add QuickNode URL to providers if configured
    const quickNodeUrl = process.env.QUICKNODE_ENDPOINT_URL;
    const allUrls = quickNodeUrl ? [quickNodeUrl, ...providerUrls] : providerUrls;

    this.providers = allUrls.map((url, i) => {
      const isQuickNode = url === quickNodeUrl;
      return createProvider(url, `provider-${i}`, isQuickNode);
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
   * Get QuickNode provider if available and healthy
   */
  getQuickNodeProvider(): QuickNodeProvider | null {
    if (this.quickNodeProvider && this.quickNodeProvider.isHealthy()) {
      return this.quickNodeProvider;
    }
    return null;
  }

  async read<T>(fn: (url: string) => Promise<T>): Promise<T> {
    // Try QuickNode first if available
    const qn = this.getQuickNodeProvider();
    if (qn) {
      try {
        const start = Date.now();
        const quickNodeUrl = process.env.QUICKNODE_ENDPOINT_URL || '';
        const result = await fn(quickNodeUrl);
        // Mark QuickNode as healthy
        qn.markHealthy();
        return result;
      } catch (err) {
        console.error('[RPC] QuickNode failed, falling back to standard providers');
        qn.markUnhealthy();
      }
    }

    // Fallback to standard provider rotation
    const provider = rotateProvider(this.providers);
    const start = Date.now();
    try {
      const result = await fn(provider.url);
      markProviderSuccess(provider, Date.now() - start);
      return result;
    } catch (err) {
      markProviderError(provider);
      throw err;
    }
  }

  async broadcast<T>(fn: (url: string) => Promise<T>): Promise<T> {
    const results = await Promise.allSettled(
      this.providers.filter(p => p.healthy).map(async (provider) => {
        const start = Date.now();
        try {
          const result = await fn(provider.url);
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
          await fetch(provider.url + '/status');
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