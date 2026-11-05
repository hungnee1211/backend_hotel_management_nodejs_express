import rateLimit from 'express-rate-limit';
import { env } from '../config/environment.js';
import { ApiError } from '../utils/ApiError.js';

/** Factory so later phases can create stricter limiters (login, OTP, payments webhook). */
export const createRateLimiter = ({ windowMs = 15 * 60 * 1000, limit = 300, message = 'Too many requests, please try again later', keyGenerator } = {}) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => env.isTest,
    ...(keyGenerator ? { keyGenerator } : {}),
    handler: (_req, _res, next) => next(ApiError.tooManyRequests(message)),
  });

export const globalRateLimiter = createRateLimiter();
