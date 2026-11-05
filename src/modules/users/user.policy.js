import { ROLES } from '../../constants/index.js';

const same = (a, b) => String(a) === String(b);

export const isSelf = (actor, target) => same(actor._id, target._id);

/**
 * May `actor` administer `target`'s account?
 *   ADMIN   : anyone, except OTHER admins (admin accounts are protected from each other).
 *   MANAGER : only STAFF whose profile says they report to this manager.
 *   others  : nobody.
 * `targetProfile` is the target's StaffProfile (needed for the manager check).
 */
export const canManageUser = (actor, target, targetProfile) => {
  if (!actor || !target) return false;
  if (actor.role === ROLES.ADMIN) return target.role !== ROLES.ADMIN || isSelf(actor, target);
  if (actor.role === ROLES.MANAGER) {
    return target.role === ROLES.STAFF && Boolean(targetProfile) && same(targetProfile.managerId, actor._id);
  }
  return false;
};
