import winston from 'winston';

export default function createLogger(level: string, logToFiles = true): winston.Logger {
  const transports = [];
  if (process.env.NODE_ENV === 'production' && logToFiles) {
    transports.push(
      new winston.transports.File({ filename: 'error.log', level: 'error' })
    );
    transports.push(new winston.transports.File({ filename: 'combined.log' }));
  } else {
    transports.push(
      new winston.transports.Console({
        format: winston.format.simple(),
        level,
      })
    );
  }
  return winston.createLogger({
    level,
    format: winston.format.json(),
    defaultMeta: { service: 'pdiiif' },
    transports,
  });
}
