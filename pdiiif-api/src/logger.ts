import { omit } from 'lodash';
import winston from 'winston';
import { Logger, setLogger } from 'pdiiif';

function createLogger(level: string, logToFiles = true): winston.Logger {
  const transports = [];
  if (process.env.NODE_ENV === 'production' && logToFiles) {
    transports.push(
      new winston.transports.File({ filename: 'error.log', level: 'error' })
    );
    transports.push(new winston.transports.File({ filename: 'combined.log' }));
  } else {
    transports.push(
      new winston.transports.Console({
        format: winston.format.json({
          space: process.env.NODE_ENV === 'production' ? 0 : 2,
        }),
        level,
      })
    );
  }
  return winston.createLogger({
    level,
    format: winston.format.combine(
      winston.format.timestamp({ alias: '@timestamp' }),
      winston.format((info) => omit(info, 'timestamp') as any)(),
      winston.format.json()
    ),
    defaultMeta: { service: 'pdiiif' },
    transports,
  });
}

class WinstonLogger implements Logger {
  private logger: winston.Logger;
  constructor(logger: winston.Logger) {
    this.logger = logger;
  }

  setLevel(level: 'debug' | 'info' | 'error' | 'warn'): void {
    this.logger.level = level;
  }

  debug(msg, ...args): void {
    this.logger.debug(msg, ...args);
  }

  info(msg, ...args): void {
    this.logger.info(msg, ...args);
  }

  warn(msg, ...args): void {
    this.logger.warn(msg, ...args);
  }

  error(msg, ...args): void {
    this.logger.error(msg, ...args);
  }
}

const logger = createLogger(
  process.env.CFG_LOG_LEVEL ?? process.env.NODE_ENV === 'production'
    ? 'warn'
    : 'debug',
  process.env.CFG_LOG_TOFILES !== 'false'
);

setLogger(new WinstonLogger(logger));

export default logger;
