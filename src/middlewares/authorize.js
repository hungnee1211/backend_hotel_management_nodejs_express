import { ROLES } from '../constants/index.js';
import { ROLE_PERMISSIONS } from '../constants/permissions.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';

/** Attaches the policy to the middleware so the API documentation can be generated from the real routes. */
const tag = (fn, meta) => { fn.meta = meta; return fn; };

/** Permissions of the caller: computed by `authenticate` (includes department/overrides for Staff). */
const permissionsOf = (req) => req.permissions ?? new Set(ROLE_PERMISSIONS[req.user?.role] ?? []);

/** Must run after `authenticate`. Allows only the listed roles. */
export const authorizeRoles = (...roles) => tag((req, _res, next) =>
  roles.includes(req.user?.role) ? next() : next(ApiError.forbidden()), { roles });

/** Must run after `authenticate`. The caller must hold EVERY listed permission. */
export const authorizePermissions = (...permissions) => tag((req, _res, next) => {
  const held = permissionsOf(req);
  return permissions.every((p) => held.has(p)) ? next() : next(ApiError.forbidden());
}, { permissions, mode: 'all' });

/** Must run after `authenticate`. The caller must hold AT LEAST ONE of the listed permissions. */
export const authorizeAnyPermission = (...permissions) => tag((req, _res, next) => {
  const held = permissionsOf(req);
  return permissions.some((p) => held.has(p)) ? next() : next(ApiError.forbidden());
}, { permissions, mode: 'any' });

/**
 * Resource-level check: the caller must own the resource unless their role is in `bypassRoles`.
 * `resolveOwnerId(req)` loads the resource and returns its owner's id (it should throw a 404 when the
 * resource doesn't exist). Never compare against an id the client sent in the body.
 */
export const authorizeResourceOwnership = (resolveOwnerId, { bypassRoles = [ROLES.ADMIN] } = {}) =>
  asyncHandler(async (req, _res, next) => {
    if (bypassRoles.includes(req.user.role)) return next();
    const ownerId = await resolveOwnerId(req);
    if (!ownerId || String(ownerId) !== String(req.user._id)) throw ApiError.forbidden();
    return next();
  });
