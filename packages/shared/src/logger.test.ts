import { describe, it, expect } from 'vitest';
import { createLogger, generateCorrelationId, LogLevel } from './logger.js';

describe('Structured Logging', () => {
  it('should create logger with service name', () => {
    const logger = createLogger('test-service');
    expect(logger).toBeDefined();
  });

  it('should generate unique correlation IDs', () => {
    const id1 = generateCorrelationId();
    const id2 = generateCorrelationId();
    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^[0-9a-f-]{36}$/); // UUID format
  });

  it('should add context to logger', () => {
    const logger = createLogger('test-service');
    const contextLogger = logger.withContext({ userId: '123', action: 'test' });
    expect(contextLogger).toBeDefined();
  });

  it('should add correlation ID to logger', () => {
    const logger = createLogger('test-service');
    const correlationId = generateCorrelationId();
    const contextLogger = logger.withCorrelationId(correlationId);
    expect(contextLogger).toBeDefined();
  });

  it('should time async operations', async () => {
    const logger = createLogger('test-service');
    const startTime = Date.now();
    
    await logger.time('test operation', async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
    }, { customField: 'test' });

    const duration = Date.now() - startTime;
    expect(duration).toBeGreaterThanOrEqual(50);
  });

  it('should handle errors in timed operations', async () => {
    const logger = createLogger('test-service');
    
    await expect(
      logger.time('failing operation', async () => {
        throw new Error('Test error');
      })
    ).rejects.toThrow('Test error');
  });
});