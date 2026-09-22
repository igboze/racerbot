import { RPCProvider, createProvider, markProviderError, markProviderSuccess, getRpcProvider, rotateProvider } from '@racerbot/shared';
import { retryWithBackoff, sleep } from '@racerbot/shared';

export class MultiRpcProvider {
  private providers: RPCProvider[];
  private readonly healthCheckIntervalMs: number;
  private healthCheckTimer: NodeJS.Timeout | null = null;

  constructor(providerUrls: string[]) {
    this.providers = providerUrls.map((url, i) => createProvider(url, `provider-${i}`));
    this.healthCheckIntervalMs = parseInt(process.env.HEALTH_CHECK_INTERVAL_MS || '30000');
    this.startHealthChecks();
  }

  getProviders(): RPCProvider[] {
    return this.providers;
  }

  getHealthyProviders(): RPCProvider[] {
    return this.providers.filter(p => p.healthy);
  }

  async read<T>(fn: (url: string) => Promise<T>): Promise<T> {
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