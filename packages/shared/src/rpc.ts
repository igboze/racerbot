export interface RPCProvider {
  url: string;
  name: string;
  healthy: boolean;
  latency: number;
  errorCount: number;
  successCount: number;
}

export interface RPCConfig {
  providers: string[];
  currentIndex: number;
  healthCheckIntervalMs: number;
}

export interface RpcHealthStatus {
  url: string;
  healthy: boolean;
  latencyMs: number;
  lastChecked: number;
  errors: number;
}

export interface RoundRobinResult {
  provider: RPCProvider;
  url: string;
}

export interface BroadcastResult {
  providerUrl: string;
  txHash: string | null;
  status: 'success' | 'failed' | 'timeout';
  latencyMs: number;
}

export function createProvider(url: string, name: string): RPCProvider {
  return { url, name, healthy: true, latency: 0, errorCount: 0, successCount: 0 };
}

export function getRpcProvider(providers: RPCProvider[], index: number): RPCProvider {
  return providers[index % providers.length];
}

export function rotateProvider(providers: RPCProvider[]): RPCProvider {
  const healthy = providers.filter(p => p.healthy);
  if (healthy.length === 0) throw new Error('No healthy RPC providers available');
  const idx = Math.floor(Math.random() * healthy.length);
  return healthy[idx];
}

export function markProviderError(provider: RPCProvider): void {
  provider.errorCount++;
  const errorRate = provider.errorCount / (provider.errorCount + provider.successCount);
  if (errorRate > 0.5 || provider.errorCount > 10) {
    provider.healthy = false;
  }
}

export function markProviderSuccess(provider: RPCProvider, latencyMs: number): void {
  provider.successCount++;
  provider.latency = latencyMs;
  const errorRate = provider.errorCount / (provider.errorCount + provider.successCount);
  if (errorRate < 0.1 && !provider.healthy) {
    provider.healthy = true;
  }
}