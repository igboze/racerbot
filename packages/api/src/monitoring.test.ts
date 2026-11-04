import { describe, it, expect, beforeEach } from 'vitest';
import { Request, Response } from 'express';
import { metrics, MetricNames } from '@racerbot/shared';
import { metricsMiddleware, monitoringRoutes } from './monitoring.js';

describe('API Monitoring Middleware', () => {
  beforeEach(() => {
    metrics.reset();
  });

  it('should track HTTP requests', () => {
    const req = { method: 'GET', path: '/test', baseUrl: '', route: { path: '/test' } } as unknown as Request;
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

  it('records the route pattern, never IDs in the path', () => {
    const req = { method: 'GET', path: '/auth/session/sess_0123456789abcdef0123456789abcdef', baseUrl: '/api', route: { path: '/auth/session/:sessionId' } } as unknown as Request;
    const res = { statusCode: 200, send: (body: any) => body } as Response;
    metricsMiddleware(req, res, () => {});
    res.send('ok');
    const labels = JSON.stringify(metrics.getMetrics());
    expect(labels).toContain('/api/auth/session/:sessionId');
    expect(labels).not.toContain('sess_0123');
  });

  it('hides /metrics and /health-detailed unless the operator token is sent', () => {
    const handlers: Record<string, Function> = {};
    monitoringRoutes({ get: (p: string, fn: Function) => { handlers[p] = fn; } });
    const call = (path: string, auth?: string) => {
      const out: any = {};
      const res: any = { status(c: number) { out.code = c; return res; }, json(b: any) { out.body = b; out.code ??= 200; return res; } };
      handlers[path]({ headers: auth ? { authorization: auth } : {} }, res);
      return out.code;
    };
    delete process.env.METRICS_TOKEN;
    expect(call('/metrics')).toBe(404);
    expect(call('/health-detailed', 'Bearer anything')).toBe(404);
    process.env.METRICS_TOKEN = 'op-secret';
    expect(call('/metrics', 'Bearer wrong')).toBe(404);
    expect(call('/metrics', 'Bearer op-secret')).toBe(200);
    delete process.env.METRICS_TOKEN;
  });
});
