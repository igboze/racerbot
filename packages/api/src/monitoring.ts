import { Request, Response, NextFunction } from 'express';
import { metrics, MetricNames, createLogger } from '@racerbot/shared';

const logger = createLogger('api-monitoring');

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startTime = Date.now();
  const originalSend = res.send;

  res.send = function (body: any) {
    const duration = Date.now() - startTime;
    const statusCode = res.statusCode;
    
    // Record request duration
    metrics.timing(MetricNames.HTTP_REQUEST_DURATION, duration, {
      method: req.method,
      path: req.path,
      status: statusCode.toString(),
    });

    // Record request count
    metrics.increment(MetricNames.HTTP_REQUESTS_TOTAL, 1, {
      method: req.method,
      path: req.path,
      status: statusCode.toString(),
    });

    // Record errors
    if (statusCode >= 400) {
      metrics.increment(MetricNames.HTTP_ERRORS_TOTAL, 1, {
        method: req.method,
        path: req.path,
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