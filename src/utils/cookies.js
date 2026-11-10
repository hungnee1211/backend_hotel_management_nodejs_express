import { env } from '../config/environment.js';

export const ACCESS_COOKIE = 'access_token';
export const REFRESH_COOKIE = 'refresh_token';
export const REFRESH_COOKIE_PATH = '/api/auth'; // the refresh token is only ever sent to auth endpoints

const base = () => ({
  httpOnly: true, // not readable from JavaScript, so XSS cannot steal it
  secure: env.cookieSecure,
  sameSite: env.COOKIE_SAME_SITE,
  ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
});

export const setAuthCookies = (res, { accessToken, refreshToken }) => {
  res.cookie(ACCESS_COOKIE, accessToken, { ...base(), path: '/', maxAge: env.accessTokenTtlMs });
  res.cookie(REFRESH_COOKIE, refreshToken, { ...base(), path: REFRESH_COOKIE_PATH, maxAge: env.refreshTokenTtlMs });
};

export const clearAuthCookies = (res) => {
  res.clearCookie(ACCESS_COOKIE, { ...base(), path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...base(), path: REFRESH_COOKIE_PATH });
};
