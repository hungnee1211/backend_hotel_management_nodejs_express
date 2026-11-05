import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { REFRESH_COOKIE, clearAuthCookies, setAuthCookies } from '../../utils/cookies.js';
import { getRequestContext } from '../../utils/requestContext.js';
import { sendCreated, sendSuccess } from '../../utils/response.js';
import { authService } from './auth.service.js';

/** Controllers only translate HTTP <-> service calls. All rules live in auth.service.js. */

const sessionResponse = (res, { user, session }, message) => {
  setAuthCookies(res, session); // tokens travel only in HTTP-only cookies, never in the JSON body
  return sendSuccess(res, {
    message,
    data: { user: user.toJSON(), accessTokenExpiresAt: session.accessTokenExpiresAt },
  });
};

export const register = asyncHandler(async (req, res) => {
  const user = await authService.register(req.body, getRequestContext(req));
  return sendCreated(res, {
    message: 'Account created. Enter the verification code we sent to activate it.',
    data: { user: user.toJSON() },
  });
});

export const verifyOtp = asyncHandler(async (req, res) => {
  const user = await authService.verifyRegistration(req.body, getRequestContext(req));
  return sendSuccess(res, { message: 'Account verified. You can now log in.', data: { user: user.toJSON() } });
});

export const resendOtp = asyncHandler(async (req, res) => {
  await authService.resendRegistrationOtp(req.body);
  return sendSuccess(res, { message: 'If the account exists and is not verified, a new code has been sent.' });
});

export const login = asyncHandler(async (req, res) =>
  sessionResponse(res, await authService.login(req.body, getRequestContext(req)), 'Logged in successfully'));

export const refresh = asyncHandler(async (req, res) =>
  sessionResponse(res, await authService.refresh(req.cookies?.[REFRESH_COOKIE], getRequestContext(req)), 'Session refreshed'));

export const logout = asyncHandler(async (req, res) => {
  await authService.logout(req.cookies?.[REFRESH_COOKIE], getRequestContext(req));
  clearAuthCookies(res);
  return sendSuccess(res, { message: 'Logged out' });
});

export const logoutAll = asyncHandler(async (req, res) => {
  await authService.logoutAll(req.user, getRequestContext(req));
  clearAuthCookies(res);
  return sendSuccess(res, { message: 'Logged out from all devices' });
});

export const forgotPassword = asyncHandler(async (req, res) => {
  await authService.forgotPassword(req.body);
  return sendSuccess(res, { message: 'If the account exists, a password reset code has been sent.' });
});

export const resetPassword = asyncHandler(async (req, res) => {
  await authService.resetPassword(req.body, getRequestContext(req));
  clearAuthCookies(res);
  return sendSuccess(res, { message: 'Password has been reset. Please log in with your new password.' });
});

export const changePassword = asyncHandler(async (req, res) => {
  await authService.changePassword(req.user, req.body, getRequestContext(req));
  clearAuthCookies(res);
  return sendSuccess(res, { message: 'Password changed. Please log in again.' });
});

/** `permissions` lets the frontend show/hide features; the backend still enforces them on every route. */
export const me = asyncHandler(async (req, res) =>
  sendSuccess(res, { data: { user: req.user.toJSON(), permissions: [...req.permissions].sort() } }));

export const updateMe = asyncHandler(async (req, res) => {
  const user = await authService.updateProfile(req.user, req.body, getRequestContext(req));
  if (!user) throw ApiError.notFound('User not found');
  return sendSuccess(res, { message: 'Profile updated', data: { user: user.toJSON() } });
});

export const deactivateMe = asyncHandler(async (req, res) => {
  await authService.deactivateOwnAccount(req.user, req.body, getRequestContext(req));
  clearAuthCookies(res);
  return sendSuccess(res, { message: 'Your account has been deactivated' });
});
