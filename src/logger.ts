type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LOG_LEVELS: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

const currentLevel: LogLevel = 'DEBUG';

function formatTimestamp(): string {
  return new Date().toISOString();
}

function log(level: LogLevel, prefix: string, message: string, data?: any): void {
  if (LOG_LEVELS[level] < LOG_LEVELS[currentLevel]) return;

  const timestamp = formatTimestamp();
  const prefix_str = `[${timestamp}] [${level}] [${prefix}]`;

  if (data !== undefined) {
    console.log(`${prefix_str} ${message}`, data);
  } else {
    console.log(`${prefix_str} ${message}`);
  }
}

export const logger = {
  debug: (prefix: string, message: string, data?: any) => log('DEBUG', prefix, message, data),
  info: (prefix: string, message: string, data?: any) => log('INFO', prefix, message, data),
  warn: (prefix: string, message: string, data?: any) => log('WARN', prefix, message, data),
  error: (prefix: string, message: string, data?: any) => log('ERROR', prefix, message, data),
};
