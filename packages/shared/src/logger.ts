import { randomUUID } from 'crypto';
import { redactSecrets } from './errors.js';

export enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
}

export interface LogContext {
  correlationId?: string;
  service?: string;
  userId?: string;
  positionId?: string;
  tokenAddress?: string;
  [key: string]: any;
}

export interface LogEntry {
  level: LogLevel;
  timestamp: string;
  message: string;
  context: LogContext;
  error?: {
    name: string;
    message: string;
    stack?: string;
    code?: string;
  };
  duration?: number;
  metadata?: Record<string, any>;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  [LogLevel.DEBUG]: 0,
  [LogLevel.INFO]: 1,
  [LogLevel.WARN]: 2,
  [LogLevel.ERROR]: 3,
};

function getMinLogLevel(): number {
  const envLevel = (process.env.LOG_LEVEL || '').toLowerCase();
  if (envLevel === 'debug') return LEVEL_PRIORITY[LogLevel.DEBUG];
  if (envLevel === 'warn') return LEVEL_PRIORITY[LogLevel.WARN];
  if (envLevel === 'error') return LEVEL_PRIORITY[LogLevel.ERROR];
  if (envLevel === 'info') return LEVEL_PRIORITY[LogLevel.INFO];
  return process.env.NODE_ENV === 'production' ? LEVEL_PRIORITY[LogLevel.INFO] : LEVEL_PRIORITY[LogLevel.DEBUG];
}

/**
 * Recursively deep-scrubs objects and strings to redact sensitive tokens,
 * passwords, private keys, and session secrets from logs.
 */
function deepScrub(val: any): any {
  if (val === null || val === undefined) return val;
  if (typeof val === 'string') return redactSecrets(val);
  if (typeof val !== 'object') return val;
  if (Array.isArray(val)) return val.map(deepScrub);

  const scrubbed: Record<string, any> = {};
  for (const [k, v] of Object.entries(val)) {
    const lowerKey = k.toLowerCase();
    if (
      lowerKey.includes('secret') ||
      lowerKey.includes('privatekey') ||
      lowerKey.includes('password') ||
      lowerKey.includes('seedphrase') ||
      lowerKey.includes('mnemonic') ||
      lowerKey.includes('masterkey')
    ) {
      scrubbed[k] = '[REDACTED]';
    } else {
      scrubbed[k] = deepScrub(v);
    }
  }
  return scrubbed;
}

export class Logger {
  private service: string;
  private context: LogContext = {};

  constructor(service: string) {
    this.service = service;
  }

  withContext(context: LogContext): Logger {
    const logger = new Logger(this.service);
    logger.context = { ...this.context, ...context };
    return logger;
  }

  withCorrelationId(correlationId: string): Logger {
    return this.withContext({ correlationId });
  }

  private formatLog(level: LogLevel, message: string, error?: Error, duration?: number, metadata?: Record<string, any>): LogEntry {
    const logContext = deepScrub({ ...this.context });

    let errorData;
    if (error) {
      errorData = {
        name: error.name,
        message: redactSecrets(error.message || ''),
        stack: error.stack ? redactSecrets(error.stack) : undefined,
        code: (error as any).code,
      };
    }

    return {
      level,
      timestamp: new Date().toISOString(),
      message: redactSecrets(message),
      context: logContext,
      error: errorData,
      duration,
      metadata: metadata ? deepScrub(metadata) : undefined,
    };
  }

  private output(logEntry: LogEntry): void {
    if (LEVEL_PRIORITY[logEntry.level] < getMinLogLevel()) {
      return;
    }

    const logString = JSON.stringify(logEntry);

    switch (logEntry.level) {
      case LogLevel.DEBUG:
        console.debug(logString);
        break;
      case LogLevel.INFO:
        console.log(logString);
        break;
      case LogLevel.WARN:
        console.warn(logString);
        break;
      case LogLevel.ERROR:
        console.error(logString);
        break;
    }
  }

  debug(message: string, metadata?: Record<string, any>): void {
    this.output(this.formatLog(LogLevel.DEBUG, message, undefined, undefined, metadata));
  }

  info(message: string, metadata?: Record<string, any>): void {
    this.output(this.formatLog(LogLevel.INFO, message, undefined, undefined, metadata));
  }

  warn(message: string, metadata?: Record<string, any>): void {
    this.output(this.formatLog(LogLevel.WARN, message, undefined, undefined, metadata));
  }

  error(message: string, error?: Error, metadata?: Record<string, any>): void {
    this.output(this.formatLog(LogLevel.ERROR, message, error, undefined, metadata));
  }

  time<T>(message: string, fn: () => Promise<T> | T, metadata?: Record<string, any>): Promise<T> {
    const startTime = Date.now();
    return Promise.resolve(fn()).then(
      (result) => {
        const duration = Date.now() - startTime;
        this.info(message, { ...metadata, duration, success: true });
        return result;
      },
      (error) => {
        const duration = Date.now() - startTime;
        this.error(message, error as Error, { ...metadata, duration, success: false });
        throw error;
      }
    );
  }
}

export function createLogger(service: string): Logger {
  return new Logger(service);
}

export function generateCorrelationId(): string {
  return randomUUID();
}
