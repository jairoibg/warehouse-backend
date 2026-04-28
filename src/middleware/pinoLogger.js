// ==================================================================================
//  src/middleware/pinoLogger.js
//  Logger estructurado con pino (Fase 3.A.2 auditoría 2026-04-28).
//
//  IMPORTANTE — coexiste con los 2 loggers ya existentes y NO los reemplaza:
//  - `./logger.js` (raíz):       aiLogger con console.log + emojis (uso actual)
//  - `src/middleware/logger.js`: logger con niveles INFO/WARN/ERROR/DEBUG
//
//  Este `pinoLogger.js` añade JSON estructurado para futuras integraciones
//  (Logtail, Datadog, CloudWatch). Disponible para código nuevo. No bloquea ni
//  modifica ninguna llamada existente.
//
//  Niveles ajustables vía env LOG_LEVEL (default `info`).
//  Redacta automáticamente claves sensibles (password, apiKey, token...).
// ==================================================================================

import pino from 'pino';

const isDev = process.env.NODE_ENV !== 'production';
const level = process.env.LOG_LEVEL || (isDev ? 'debug' : 'info');

const transport = isDev
  ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss',
        ignore: 'pid,hostname',
      },
    }
  : undefined;

export const pinoLogger = pino({
  level,
  transport,
  redact: {
    paths: [
      'password', 'apiKey', 'api_key', 'token', 'authorization',
      'req.headers.authorization', 'req.headers.cookie',
      '*.password', '*.apiKey',
    ],
    censor: '[REDACTED]',
    remove: false,
  },
  base: { service: 'warehouse-backend' },
});

// Subnamespaces (child loggers) para distintos dominios.
export const aiLogger = pinoLogger.child({ ns: 'ai' });
export const odooLogger = pinoLogger.child({ ns: 'odoo' });
export const httpLogger = pinoLogger.child({ ns: 'http' });
export const journalLogger = pinoLogger.child({ ns: 'journal' });

// Middleware Express opcional: log de cada request HTTP.
export function requestLoggerMiddleware(opts = {}) {
  const { ignorePaths = ['/api/last-sync'] } = opts;
  return (req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      if (ignorePaths.includes(req.path)) return;
      httpLogger.info(
        {
          method: req.method,
          path: req.path,
          status: res.statusCode,
          duration_ms: Date.now() - start,
          ip: req.ip,
        },
        'http'
      );
    });
    next();
  };
}
