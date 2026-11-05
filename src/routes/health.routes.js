import { Router } from 'express';
import mongoose from 'mongoose';
import { supportsTransactions } from '../config/database.js';
import { ApiError } from '../utils/ApiError.js';
import { sendSuccess } from '../utils/response.js';

const router = Router();

/** Liveness: the process is up. */
router.get('/', (_req, res) =>
  sendSuccess(res, { message: 'OK', data: { status: 'ok', uptimeSeconds: Math.round(process.uptime()), timestamp: new Date().toISOString() } }),
);

/** Readiness: the database is connected (use this for load balancer / orchestrator checks). */
router.get('/ready', (_req, res, next) => {
  if (mongoose.connection.readyState !== 1) return next(ApiError.unavailable('Database is not connected', 'DB_NOT_READY'));
  return sendSuccess(res, { message: 'Ready', data: { database: 'connected', transactions: supportsTransactions() } });
});

export default router;
