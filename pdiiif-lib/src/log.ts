type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  setLevel(level: LogLevel): void;
  debug(message: string, ...args: any[]): void;
  info(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  error(message: string, ...args: any[]): void;
}

/** Simple logger that simply outputs to the console */
export class ConsoleLogger implements Logger {
  private level: LogLevel;
  constructor(level: LogLevel = 'warn') {
    this.level = level;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  debug(message: string, ...args: any[]): void {
    if (this.level === 'debug') {
      console.debug(message, ...args);
    }
  }

  info(message: string, ...args: any[]): void {
    if (this.level !== 'error' && this.level !== 'warn') {
      console.info(message, ...args);
    }
  }

  warn(message: string, ...args: any[]): void {
    if (this.level !== 'error') {
      console.warn(message, ...args);
    }
  }

  error(message: string, ...args: any[]): void {
    console.error(message, ...args);
  }
}

let logger: Logger = new ConsoleLogger();

export function setLogger(newLogger: Logger): void {
  logger = newLogger;
}

export { logger as default };
