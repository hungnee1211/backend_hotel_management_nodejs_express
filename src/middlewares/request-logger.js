import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';

/** Assigns a request id (also returned as X-Request-Id) and logs one line per finished request. */
export const requestLogger = (req, res, next) => {
  req.id = req.get('x-request-id') || randomUUID();
  res.setHeader('X-Request-Id', req.id);
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    logger.http(`${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(1)}ms`, { requestId: req.id, ip: req.ip });
  });
  next();
};
