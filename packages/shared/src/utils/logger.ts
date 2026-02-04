import winston from 'winston';

export type Logger = winston.Logger;

export function createLogger(serviceName: string): Logger {
  // Build transports array
  const transports: winston.transport[] = [];

  // Only add Console transport if not in MCP STDIO mode
  // In STDIO mode, stdout is reserved for MCP protocol communication
  if (process.env.MCP_STDIO_MODE !== 'true') {
    transports.push(
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.simple()
        ),
      })
    );
  }

  // Always add file transports
  transports.push(
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' })
  );

  return winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.json()
    ),
    defaultMeta: { service: serviceName },
    transports,
  });
}

export const logger: Logger = createLogger('shared');
