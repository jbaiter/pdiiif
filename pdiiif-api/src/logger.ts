import winston from 'winston';

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
        format: winston.format.json({ space: 2 }),
        level,
      })
    );
  }
  return winston.createLogger({
    level,
    format: winston.format.combine(
      winston.format.timestamp({ alias: '@timestamp' }),
      winston.format.json(),
    ),
    defaultMeta: { service: 'pdiiif' },
    transports,
  });
}

export default createLogger(
  process.env.CFG_LOG_LEVEL ?? process.env.NODE_ENV === 'production'
    ? 'info'
    : 'debug',
  process.env.CFG_LOG_TOFILES !== 'false'
);