/**
 * Sistema de logging centralizado
 */

const LOG_LEVELS = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3
};

const currentLogLevel = LOG_LEVELS[process.env.LOG_LEVEL?.toUpperCase() || 'INFO'];

function formatLog(level, message, data = {}) {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level}]`;
  
  if (Object.keys(data).length > 0) {
    return `${prefix} ${message} ${JSON.stringify(data)}`;
  }
  return `${prefix} ${message}`;
}

export const logger = {
  error: (message, data) => {
    if (currentLogLevel >= LOG_LEVELS.ERROR) {
      console.error(formatLog('ERROR', message, data));
    }
  },
  
  warn: (message, data) => {
    if (currentLogLevel >= LOG_LEVELS.WARN) {
      console.warn(formatLog('WARN', message, data));
    }
  },
  
  info: (message, data) => {
    if (currentLogLevel >= LOG_LEVELS.INFO) {
      console.log(formatLog('INFO', message, data));
    }
  },
  
  debug: (message, data) => {
    if (currentLogLevel >= LOG_LEVELS.DEBUG) {
      console.log(formatLog('DEBUG', message, data));
    }
  }
};



