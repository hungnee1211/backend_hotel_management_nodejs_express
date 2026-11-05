import { ApiError } from '../utils/ApiError.js';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_DEPTH = 20;

const hasUnsafeKey = (value, depth = 0) => {
  if (depth > MAX_DEPTH) return true;
  if (Array.isArray(value)) return value.some((v) => hasUnsafeKey(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.keys(value).some(
      (k) => k.startsWith('$') || k.includes('.') || FORBIDDEN_KEYS.has(k) || hasUnsafeKey(value[k], depth + 1),
    );
  }
  return false;
};

/**
 * NoSQL-injection guard: rejects any request whose body, query or params contain MongoDB operator keys
 * ("$ne", "$gt"...), dotted paths, or prototype-pollution keys. Joi validation is the second layer.
 */
export const rejectUnsafeInput = (req, _res, next) => {
  if (['body', 'query', 'params'].some((part) => hasUnsafeKey(req[part]))) {
    return next(ApiError.badRequest('Request contains disallowed field names', 'INVALID_INPUT'));
  }
  return next();
};
