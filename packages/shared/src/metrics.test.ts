import { describe, it, expect, beforeEach } from 'vitest';
import { MetricsCollector, MetricNames } from './metrics.js';

describe('Metrics Collection', () => {
  let testMetrics: MetricsCollector;

  beforeEach(() => {
    testMetrics = new MetricsCollector();
  });

  it('should increment counter metrics', () => {
    testMetrics.increment(MetricNames.HTTP_REQUESTS_TOTAL, 1, { method: 'GET' });
    const metric = testMetrics.getMetric(MetricNames.HTTP_REQUESTS_TOTAL);
    expect(metric).toBeDefined();
    expect(metric?.values).toHaveLength(1);
    expect(metric?.values[0].value).toBe(1);
  });

  it('should increment counter with custom value', () => {
    testMetrics.increment(MetricNames.HTTP_REQUESTS_TOTAL, 5, { method: 'POST' });
    const metric = testMetrics.getMetric(MetricNames.HTTP_REQUESTS_TOTAL);
    expect(metric?.values[0].value).toBe(5);
  });

  it('should set gauge metrics', () => {
    testMetrics.set(MetricNames.DB_CONNECTIONS_ACTIVE, 10, { pool: 'main' });
    const metric = testMetrics.getMetric(MetricNames.DB_CONNECTIONS_ACTIVE);
    expect(metric?.values[0].value).toBe(10);
  });

  it('should observe histogram metrics', () => {
    testMetrics.observe(MetricNames.HTTP_REQUEST_DURATION, 150, { endpoint: '/api/swap' });
    const metric = testMetrics.getMetric(MetricNames.HTTP_REQUEST_DURATION);
    expect(metric?.values[0].value).toBe(150);
  });

  it('should track timing with helper method', () => {
    testMetrics.timing(MetricNames.RPC_REQUEST_DURATION, 200, { method: 'get_block' });
    const metric = testMetrics.getMetric(MetricNames.RPC_REQUEST_DURATION);
    expect(metric?.values[0].value).toBe(200);
  });

  it('should update existing metric with same labels', () => {
    testMetrics.increment(MetricNames.HTTP_REQUESTS_TOTAL, 1, { method: 'GET' });
    testMetrics.increment(MetricNames.HTTP_REQUESTS_TOTAL, 2, { method: 'GET' });
    const metric = testMetrics.getMetric(MetricNames.HTTP_REQUESTS_TOTAL);
    expect(metric?.values).toHaveLength(1);
    expect(metric?.values[0].value).toBe(3);
  });

  it('should keep separate values for different labels', () => {
    testMetrics.increment(MetricNames.HTTP_REQUESTS_TOTAL, 1, { method: 'GET' });
    testMetrics.increment(MetricNames.HTTP_REQUESTS_TOTAL, 2, { method: 'POST' });
    const metric = testMetrics.getMetric(MetricNames.HTTP_REQUESTS_TOTAL);
    expect(metric?.values).toHaveLength(2);
  });

  it('should get all metrics', () => {
    testMetrics.increment(MetricNames.HTTP_REQUESTS_TOTAL, 1);
    testMetrics.set(MetricNames.DB_CONNECTIONS_ACTIVE, 5);
    const allMetrics = testMetrics.getMetrics();
    expect(Object.keys(allMetrics)).toHaveLength(2);
  });

  it('should reset all metrics', () => {
    testMetrics.increment(MetricNames.HTTP_REQUESTS_TOTAL, 1);
    testMetrics.reset();
    const allMetrics = testMetrics.getMetrics();
    expect(Object.keys(allMetrics)).toHaveLength(0);
  });
});