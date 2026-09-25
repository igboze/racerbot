import { randomUUID } from 'crypto';

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
    const logContext = { ...this.context };
    
    let errorData;
    if (error) {
      errorData = {
        name: error.name,
        message: error.message,
        stack: error.stack,
        code: (error as any).code,
      };
    }

    return {
      level,
      timestamp: new Date().toISOString(),
      message,
      context: logContext,
      error: errorData,
      duration,
      metadata,
    };
  }

  private output(logEntry: LogEntry): void {
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