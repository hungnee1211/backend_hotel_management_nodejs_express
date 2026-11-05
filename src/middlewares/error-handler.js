import { env } from '../config/environment.js';
import { ApiError } from '../utils/ApiError.js';
import { logger } from '../utils/logger.js';

/** Maps known library errors onto ApiError so clients always get the same envelope. */
const normalize = (err) => {
  if (err instanceof ApiError) return err;

  if (err.type === 'entity.parse.failed') return ApiError.badRequest('Malformed JSON body', 'INVALID_JSON');
  if (err.type === 'entity.too.large') return new ApiError(413, 'Request body too large', 'PAYLOAD_TOO_LARGE');

  if (err.name === 'ValidationError' && err.errors) {
    const errors = Object.values(err.errors).map((e) => ({ field: e.path, message: e.message }));
    return ApiError.unprocessable('Validation failed', errors);
  }
  if (err.name === 'CastError') return ApiError.badRequest(`Invalid value for "${err.path}"`, 'INVALID_ID');
  if (err.code === 11000) {
    const fields = Object.keys(err.keyPattern || {});
    return ApiError.conflict(`Duplicate value${fields.length ? ` for: ${fields.join(', ')}` : ''}`, 'DUPLICATE_KEY');
  }
  if (err.name === 'TokenExpiredError') return ApiError.unauthorized('Token has expired', 'TOKEN_EXPIRED');
  if (err.name === 'JsonWebTokenError') return ApiError.unauthorized('Invalid token', 'INVALID_TOKEN');
  return null;
};

// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, req, res, _next) => {
  const known = normalize(err);

  if (!known) {
    logger.error(err.message, { stack: err.stack, requestId: req.id, method: req.method, url: req.originalUrl });
  } else if (known.statusCode >= 500) {
    logger.error(known.message, { stack: err.stack, requestId: req.id });
  }

  const statusCode = known?.statusCode ?? 500;
  const body = {
    success: false,
    // Unknown errors never leak internals in production.
    message: known ? known.message : env.isProd ? 'Internal server error' : err.message,
    code: known?.code ?? 'INTERNAL_ERROR',
    errors: known?.errors ?? [],
  };
  if (!env.isProd && !known) body.stack = err.stack;
  if (req.id) body.requestId = req.id;

  res.status(statusCode).json(body);
};
