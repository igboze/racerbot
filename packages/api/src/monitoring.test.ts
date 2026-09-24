import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Request, Response } from 'express';
import { metrics, MetricNames } from '@racerbot/shared';
import { metricsMiddleware, monitoringRoutes } from './monitoring.js';

describe('API Monitoring Middleware', () => {
  beforeEach(() => {
    metrics.reset();
  });

  it('should track HTTP requests', () => {
    const req = { method: 'GET', path: '/test' } as Request;
    const res = { 
      statusCode: 200, 
      send: (body: any) => body 
    } as Response;
    const next = () => {};

    metricsMiddleware(req, res, next);

    res.send('test');
    
    const metric = metrics.getMetric(MetricNames.HTTP_REQUESTS_TOTAL);
    expect(metric?.values).toHaveLength(1);
    expect(metric?.values[0].labels?.method).toBe('GET');
    expect(metric?.values[0].labels?.path).toBe('/test');
  });

  it('should track request duration', async () => {
    const req = { method: 'POST', path: '/api/swap' } as Request;
    const res = { 
      statusCode: 200, 
      send: (body: any) => body 
    } as Response;
    const next = () => {};

    metricsMiddleware(req, res, next);
    
    // Simulate some processing time
    await new Promise(resolve => setTimeout(resolve, 50));
    res.send('response');
    
    const durationMetric = metrics.getMetric(MetricNames.HTTP_REQUEST_DURATION);
    expect(durationMetric?.values).toHaveLength(1);
    expect(durationMetric?.values[0].value).toBeGreaterThanOrEqual(0);
  });

  it('should track HTTP errors', () => {
    const req = { method: 'GET', path: '/error' } as Request;
    const res = { 
      statusCode: 500, 
      send: (body: any) => body 
    } as Response;
    const next = () => {};

    metricsMiddleware(req, res, next);
    res.send('error');

    const errorMetric = metrics.getMetric(MetricNames.HTTP_ERRORS_TOTAL);
    expect(errorMetric?.values).toHaveLength(1);
    expect(errorMetric?.values[0].labels?.status).toBe('500');
  });
});