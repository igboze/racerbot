import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { metrics, MetricNames, createLogger } from '@racerbot/shared';

const logger = createLogger('api-monitoring');

/**
 * The route pattern a request matched (`/auth/session/:sessionId`), never its concrete path: paths carry
 * session and login IDs, accounts and share codes, and every distinct label is kept in memory.
 */
function routeLabel(req: Request): string {
  const route = (req as any).route?.path;
  if (typeof route === 'string') return `${req.baseUrl || ''}${route}`;
  if (Array.isArray(route)) return `${req.baseUrl || ''}${route[0]}`;
  return req.path.startsWith('/assets/') ? '/assets/*' : '(unmatched)';
}

/** Metrics are for operators: only with `Authorization: Bearer $METRICS_TOKEN`, and hidden when it is unset */
function metricsAllowed(req: Request): boolean {
  const token = (process.env.METRICS_TOKEN || '').trim();
  if (!token) return false;
  const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startTime = Date.now();
  const originalSend = res.send;

  res.send = function (body: any) {
    const duration = Date.now() - startTime;
    const statusCode = res.statusCode;
    
    // Record request duration
    metrics.timing(MetricNames.HTTP_REQUEST_DURATION, duration, {
      method: req.method,
      path: routeLabel(req),
      status: statusCode.toString(),
    });

    // Record request count
    metrics.increment(MetricNames.HTTP_REQUESTS_TOTAL, 1, {
      method: req.method,
      path: routeLabel(req),
      status: statusCode.toString(),
    });

    // Record errors
    if (statusCode >= 400) {
      metrics.increment(MetricNames.HTTP_ERRORS_TOTAL, 1, {
        method: req.method,
        path: routeLabel(req),
        status: statusCode.toString(),
      });
    }

    return originalSend.call(this, body);
  };

  next();
}

export function monitoringRoutes(app: any): void {
  // Metrics endpoint
  app.get('/metrics', (req: Request, res: Response) => {
    if (!metricsAllowed(req)) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    try {
      const allMetrics = metrics.getMetrics();
      res.json({
        timestamp: new Date().toISOString(),
        metrics: allMetrics,
      });
    } catch (err) {
      logger.error('Failed to get metrics', err as Error);
      res.status(500).json({ error: 'Failed to get metrics' });
    }
  });

  // Health check with metrics
  app.get('/health-detailed', (req: Request, res: Response) => {
    if (!metricsAllowed(req)) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    try {
      const allMetrics = metrics.getMetrics();
      const httpErrors = allMetrics[MetricNames.HTTP_ERRORS_TOTAL]?.values.reduce((sum, v) => sum + v.value, 0) || 0;
      const recentErrors = allMetrics[MetricNames.HTTP_ERRORS_TOTAL]?.values.filter(
        v => Date.now() - v.timestamp < 300000
      ).length || 0;

      const health = {
        status: recentErrors > 10 ? 'degraded' : 'healthy',
        timestamp: new Date().toISOString(),
        metrics: {
          httpErrors,
          recentErrors,
          uptime: process.uptime(),
          memory: process.memoryUsage(),
        },
      };

      res.status(health.status === 'degraded' ? 503 : 200).json(health);
    } catch (err) {
      logger.error('Health check failed', err as Error);
      res.status(500).json({ status: 'error', error: 'Health check failed' });
    }
  });
}