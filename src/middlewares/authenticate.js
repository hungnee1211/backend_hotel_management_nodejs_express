import mongoose from 'mongoose';
import { ROLES, USER_STATUS } from '../constants/index.js';
import { effectivePermissions } from '../constants/permissions.js';
import { staffRepository } from '../modules/staff/staff.repository.js';
import { userRepository } from '../modules/users/user.repository.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ACCESS_COOKIE } from '../utils/cookies.js';
import { verifyAccessToken } from '../utils/token.js';

/** Browser clients use the HTTP-only cookie; API tools (Postman, Swagger) may send "Authorization: Bearer". */
const extractToken = (req) => {
  const header = req.get('authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  return req.cookies?.[ACCESS_COOKIE] ?? null;
};

/**
 * Verifies the access token, then loads the user (and, for Staff, their profile) from the database on EVERY request. That makes
 * deactivation, role changes and logout-all effective immediately, even though the JWT lives 15 minutes.
 * The role is taken from the database, never from the token.
 */
export const authenticate = asyncHandler(async (req, _res, next) => {
  const token = extractToken(req);
  if (!token) throw ApiError.unauthorized();

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch (err) {
    throw err.name === 'TokenExpiredError'
      ? ApiError.unauthorized('Access token has expired', 'TOKEN_EXPIRED')
      : ApiError.unauthorized('Invalid access token', 'INVALID_TOKEN');
  }
  if (!mongoose.isValidObjectId(payload.sub)) throw ApiError.unauthorized('Invalid access token', 'INVALID_TOKEN');

  const user = await userRepository.findById(payload.sub);
  if (!user) throw ApiError.unauthorized('Account no longer exists', 'INVALID_TOKEN');
  if (user.status !== USER_STATUS.ACTIVE) throw ApiError.forbidden('This account has been deactivated', 'ACCOUNT_DISABLED');
  if (!user.isVerified) throw ApiError.forbidden('Account is not verified', 'ACCOUNT_NOT_VERIFIED');
  if ((user.tokenVersion ?? 0) !== payload.ver) throw ApiError.unauthorized('Session has been revoked', 'TOKEN_REVOKED');

  // Staff permissions depend on their department and overrides, so they are recomputed on every request:
  // a department change or revoked permission takes effect immediately.
  const staffProfile = user.role === ROLES.STAFF ? await staffRepository.findProfileByUserId(user._id) : null;
  req.user = user;
  req.staffProfile = staffProfile;
  req.permissions = effectivePermissions({ role: user.role, staffProfile });
  return next();
});
