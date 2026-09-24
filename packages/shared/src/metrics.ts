interface MetricValue {
  value: number;
  timestamp: number;
  labels?: Record<string, string>;
}

interface Metric {
  name: string;
  type: 'counter' | 'gauge' | 'histogram';
  description: string;
  values: MetricValue[];
}

class MetricsCollector {
  private metrics: Map<string, Metric> = new Map();

  private getOrCreateMetric(name: string, type: 'counter' | 'gauge' | 'histogram', description: string): Metric {
    if (!this.metrics.has(name)) {
      this.metrics.set(name, {
        name,
        type,
        description,
        values: [],
      });
    }
    return this.metrics.get(name)!;
  }

  increment(name: string, value: number = 1, labels?: Record<string, string>, description: string = ''): void {
    const metric = this.getOrCreateMetric(name, 'counter', description);
    const existingValue = metric.values.find(v => 
      JSON.stringify(v.labels) === JSON.stringify(labels)
    );
    
    if (existingValue) {
      existingValue.value += value;
      existingValue.timestamp = Date.now();
    } else {
      metric.values.push({
        value,
        timestamp: Date.now(),
        labels,
      });
    }
  }

  set(name: string, value: number, labels?: Record<string, string>, description: string = ''): void {
    const metric = this.getOrCreateMetric(name, 'gauge', description);
    const existingValue = metric.values.find(v => 
      JSON.stringify(v.labels) === JSON.stringify(labels)
    );
    
    if (existingValue) {
      existingValue.value = value;
      existingValue.timestamp = Date.now();
    } else {
      metric.values.push({
        value,
        timestamp: Date.now(),
        labels,
      });
    }
  }

  observe(name: string, value: number, labels?: Record<string, string>, description: string = ''): void {
    const metric = this.getOrCreateMetric(name, 'histogram', description);
    metric.values.push({
      value,
      timestamp: Date.now(),
      labels,
    });
  }

  timing(name: string, duration: number, labels?: Record<string, string>, description: string = ''): void {
    this.observe(name, duration, labels, description);
  }

  getMetrics(): Record<string, Metric> {
    const result: Record<string, Metric> = {};
    for (const [name, metric] of this.metrics.entries()) {
      result[name] = {
        ...metric,
        values: metric.values.slice(-100), // Keep last 100 values per metric
      };
    }
    return result;
  }

  reset(): void {
    this.metrics.clear();
  }

  getMetric(name: string): Metric | undefined {
    return this.metrics.get(name);
  }
}

// Global metrics collector
export const metrics = new MetricsCollector();

// Export class for testing
export { MetricsCollector };

// Common metric names
export const MetricNames = {
  // HTTP metrics
  HTTP_REQUESTS_TOTAL: 'http_requests_total',
  HTTP_REQUEST_DURATION: 'http_request_duration_ms',
  HTTP_ERRORS_TOTAL: 'http_errors_total',
  
  // Database metrics
  DB_QUERY_DURATION: 'db_query_duration_ms',
  DB_CONNECTIONS_ACTIVE: 'db_connections_active',
  DB_ERRORS_TOTAL: 'db_errors_total',
  
  // RPC metrics
  RPC_REQUESTS_TOTAL: 'rpc_requests_total',
  RPC_REQUEST_DURATION: 'rpc_request_duration_ms',
  RPC_ERRORS_TOTAL: 'rpc_errors_total',
  
  // Redis metrics
  REDIS_COMMANDS_TOTAL: 'redis_commands_total',
  REDIS_COMMAND_DURATION: 'redis_command_duration_ms',
  REDIS_ERRORS_TOTAL: 'redis_errors_total',
  
  // Business metrics
  SWAPS_TOTAL: 'swaps_total',
  SWAPS_SUCCESSFUL: 'swaps_successful',
  SWAPS_FAILED: 'swaps_failed',
  AUTO_BUYS_TOTAL: 'auto_buys_total',
  TRIGGERS_FIRED: 'triggers_fired',
  
  // System metrics
  MEMORY_USAGE: 'memory_usage_bytes',
  CPU_USAGE: 'cpu_usage_percent',
  
  // Custom service metrics
  API_ACTIVE_USERS: 'api_active_users',
  EXECUTOR_KEYS_WARMED: 'executor_keys_warmed',
  DETECTOR_BLOCKS_PROCESSED: 'detector_blocks_processed',
  DETECTOR_TOKENS_DETECTED: 'detector_tokens_detected',
  TRIGGERS_EVALUATED: 'triggers_evaluated',
} as const;