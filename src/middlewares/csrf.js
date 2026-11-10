import { ApiError } from '../utils/ApiError.js';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '../utils/cookies.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence for cookie authentication. Requests that change state AND carry auth cookies must also
 * send "X-Requested-With: XMLHttpRequest". A cross-site page cannot set a custom header without a CORS
 * preflight, and CORS only allows our configured frontend origins, so a forged request is rejected.
 * Not needed for Bearer-token clients (nothing is sent automatically) or for cookie-less requests
 * such as login and register.
 */
export const csrfProtection = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();
  const usesCookies = Boolean(req.cookies?.[ACCESS_COOKIE] || req.cookies?.[REFRESH_COOKIE]);
  const usesBearer = req.get('authorization')?.startsWith('Bearer ');
  if (!usesCookies || usesBearer) return next();
  if (req.get('x-requested-with') === 'XMLHttpRequest') return next();
  return next(ApiError.forbidden('Missing X-Requested-With header', 'CSRF_REJECTED'));
};
