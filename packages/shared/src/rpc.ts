export interface RPCProvider {
  url: string;
  name: string;
  healthy: boolean;
  latency: number;
  errorCount: number;
  successCount: number;
  isQuickNode?: boolean;
  headers?: Record<string, string>;
  circuitBreakerOpen: boolean;
  circuitBreakerUntil: number;
  lastSuccessTime: number;
  lastErrorTime: number;
  averageLatency: number;
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

const CIRCUIT_BREAKER_COOLDOWN_MS = 60000; // 1 minute cooldown
const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 5; // Open after 5 consecutive failures
const CIRCUIT_BREAKER_LATENCY_THRESHOLD_MS = 5000; // Open if consistently slow (>5s)

export function createProvider(url: string, name: string, isQuickNode: boolean = false, headers?: Record<string, string>): RPCProvider {
  return {
    url,
    name,
    healthy: true,
    latency: 0,
    errorCount: 0,
    successCount: 0,
    isQuickNode,
    headers,
    circuitBreakerOpen: false,
    circuitBreakerUntil: 0,
    lastSuccessTime: 0,
    lastErrorTime: 0,
    averageLatency: 0,
  };
}

export function getRpcProvider(providers: RPCProvider[], index: number): RPCProvider {
  return providers[index % providers.length];
}

export function rotateProvider(providers: RPCProvider[]): RPCProvider {
  const healthy = providers.filter(p => p.healthy && !isCircuitBreakerOpen(p));
  if (healthy.length === 0) throw new Error('No healthy RPC providers available');
  const idx = Math.floor(Math.random() * healthy.length);
  return healthy[idx];
}

function isCircuitBreakerOpen(provider: RPCProvider): boolean {
  if (!provider.circuitBreakerOpen) return false;
  const now = Date.now();
  if (now > provider.circuitBreakerUntil) {
    // Cooldown period over, reset circuit breaker
    provider.circuitBreakerOpen = false;
    provider.circuitBreakerUntil = 0;
    return false;
  }
  return true;
}

export function markProviderError(provider: RPCProvider): void {
  provider.errorCount++;
  provider.lastErrorTime = Date.now();
  const errorRate = provider.errorCount / (provider.errorCount + provider.successCount);

  // Mark unhealthy if error rate is high
  if (errorRate > 0.5 || provider.errorCount > 10) {
    provider.healthy = false;
  }

  // Open circuit breaker if consecutive failures exceed threshold
  if (provider.errorCount >= CIRCUIT_BREAKER_FAILURE_THRESHOLD && provider.successCount === 0) {
    provider.circuitBreakerOpen = true;
    provider.circuitBreakerUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
  }
}

export function markProviderSuccess(provider: RPCProvider, latencyMs: number): void {
  provider.successCount++;
  provider.lastSuccessTime = Date.now();
  provider.latency = latencyMs;

  // Calculate exponential moving average for latency
  if (provider.averageLatency === 0) {
    provider.averageLatency = latencyMs;
  } else {
    provider.averageLatency = (provider.averageLatency * 0.9) + (latencyMs * 0.1);
  }

  // Reset error count on success
  provider.errorCount = 0;

  // Restore health if error rate is low
  const errorRate = provider.errorCount / (provider.errorCount + provider.successCount);
  if (errorRate < 0.1 && !provider.healthy) {
    provider.healthy = true;
  }

  // Open circuit breaker if consistently slow
  if (provider.averageLatency > CIRCUIT_BREAKER_LATENCY_THRESHOLD_MS && provider.successCount > 20) {
    provider.circuitBreakerOpen = true;
    provider.circuitBreakerUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
  }
}

export function getHealthyProviderCount(providers: RPCProvider[]): number {
  return providers.filter(p => p.healthy && !isCircuitBreakerOpen(p)).length;
}