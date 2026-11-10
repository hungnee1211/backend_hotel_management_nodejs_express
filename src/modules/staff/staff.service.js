import { AUDIT_ACTIONS, ROLES } from '../../constants/index.js';
import {
  DEPARTMENT_PERMISSIONS, PERMISSIONS, ROLE_PERMISSIONS, STAFF_GRANTABLE, effectivePermissions, hasPermission,
} from '../../constants/permissions.js';
import { ApiError } from '../../utils/ApiError.js';
import { hashPassword } from '../../utils/crypto.js';
import { buildPageMeta, parsePagination } from '../../utils/pagination.js';
import { withTransaction } from '../../utils/transaction.js';
import { auditService } from '../audit-logs/audit.service.js';
import { counterService } from '../counters/counter.service.js';
import { userService } from '../users/user.service.js';
import { staffRepository } from './staff.repository.js';

const same = (a, b) => String(a) === String(b);
const audit = (action, { actor, userId, before, after, ctx }) =>
  auditService.record({ actorId: actor._id, action, resourceType: 'StaffProfile', resourceId: userId, before, after, ctx });

/**
 * Validates an override request. Rules:
 *  - only roles holding STAFF_PERMISSIONS_MANAGE (Admin, Manager) may touch overrides;
 *  - only permissions in STAFF_GRANTABLE can be granted (never financial/admin ones);
 *  - a Manager can only delegate permissions they hold themselves;
 *  - grant and revoke must not overlap.
 */
const normalizeOverrides = (actor, overrides) => {
  if (!overrides) return undefined;
  if (!hasPermission(actor.role, PERMISSIONS.STAFF_PERMISSIONS_MANAGE)) throw ApiError.forbidden('You cannot change staff permissions');
  const grant = [...new Set(overrides.grant ?? [])];
  const revoke = [...new Set(overrides.revoke ?? [])];
  const overlap = grant.filter((p) => revoke.includes(p));
  if (overlap.length) throw ApiError.unprocessable('A permission cannot be granted and revoked at once', overlap.map((p) => ({ field: 'body.permissionOverrides', message: p })));
  for (const p of grant) {
    if (!STAFF_GRANTABLE.has(p)) {
      throw ApiError.unprocessable('This permission can never be granted to staff', [{ field: 'body.permissionOverrides.grant', message: p }], 'PERMISSION_NOT_GRANTABLE');
    }
    if (actor.role !== ROLES.ADMIN && !hasPermission(actor.role, p)) {
      throw ApiError.forbidden(`You cannot grant a permission you do not hold: ${p}`, 'PERMISSION_NOT_DELEGABLE');
    }
  }
  return { grant, revoke };
};

/** Admin sees any staff member; a Manager only their direct reports (404 otherwise). */
const getViewInScope = async (actor, id) => {
  const view = await staffRepository.findView(id);
  if (!view) throw ApiError.notFound('Staff member not found', 'STAFF_NOT_FOUND');
  if (actor.role === ROLES.ADMIN) return view;
  if (actor.role === ROLES.MANAGER && same(view.managerId, actor._id)) return view;
  if (actor.role === ROLES.STAFF && same(view.id, actor._id)) return view;
  throw actor.role === ROLES.MANAGER ? ApiError.notFound('Staff member not found', 'STAFF_NOT_FOUND') : ApiError.forbidden();
};

export const staffService = {
  async create(actor, payload, ctx) {
    // A Manager's new staff always report to that Manager; the client-supplied managerId is ignored.
    let managerId = null;
    if (actor.role === ROLES.MANAGER) managerId = actor._id;
    else if (payload.managerId) {
      await userService.assertActiveManager(payload.managerId);
      managerId = payload.managerId;
    }
    const permissionOverrides = normalizeOverrides(actor, payload.permissionOverrides);

    // Slow / non-transactional work first, so the transaction stays short.
    const passwordHash = await hashPassword(payload.password);
    const employeeCode = await counterService.formatted('employee', 'EMP');

    // User + profile are created atomically: no staff user without a profile, ever.
    const { user } = await withTransaction(async (session) => {
      const created = await userService.createManagedUser(
        actor,
        { fullName: payload.fullName, email: payload.email, phone: payload.phone, passwordHash, role: ROLES.STAFF },
        { session },
      );
      const profile = await staffRepository.createProfile(
        {
          userId: created._id, employeeCode, department: payload.department, jobTitle: payload.jobTitle,
          managerId, hiredAt: payload.hiredAt, ...(permissionOverrides && { permissionOverrides }),
        },
        { session },
      );
      return { user: created, profile };
    });

    const view = await staffRepository.findView(user._id);
    await audit(AUDIT_ACTIONS.STAFF_CREATED, { actor, userId: user._id, after: view, ctx });
    return view;
  },

  async list(actor, query) {
    const paging = parsePagination(query, { defaultSort: 'createdAt' });
    const filter = { department: query.department, status: query.status, search: query.search };
    // A manager can only ever list their own team, whatever filters they send.
    filter.managerId = actor.role === ROLES.MANAGER ? actor._id : query.managerId;
    const { items, total } = await staffRepository.search(filter, {
      skip: paging.skip, limit: paging.limit, sortBy: query.sortBy, dir: Object.values(paging.sort)[0],
    });
    return { items, meta: buildPageMeta({ ...paging, total }) };
  },

  get: getViewInScope,

  async update(actor, id, payload, ctx) {
    const before = await getViewInScope(actor, id);
    const profileChanges = {};

    for (const key of ['department', 'jobTitle', 'hiredAt']) if (payload[key] !== undefined) profileChanges[key] = payload[key];

    if (payload.managerId !== undefined) {
      if (actor.role !== ROLES.ADMIN) throw ApiError.forbidden('Only Admins can reassign staff to another manager');
      if (payload.managerId) await userService.assertActiveManager(payload.managerId);
      profileChanges.managerId = payload.managerId; // null = unassign
    }
    const overrides = normalizeOverrides(actor, payload.permissionOverrides);
    if (overrides) profileChanges.permissionOverrides = overrides;

    if (payload.fullName !== undefined) await userService.update(actor, id, { fullName: payload.fullName }, ctx);
    if (Object.keys(profileChanges).length) await staffRepository.updateProfile(id, { $set: profileChanges });

    const after = await staffRepository.findView(id);
    await audit(AUDIT_ACTIONS.STAFF_UPDATED, { actor, userId: id, before, after, ctx });
    if (overrides || profileChanges.department) {
      await audit(AUDIT_ACTIONS.STAFF_PERMISSIONS_CHANGED, {
        actor, userId: id,
        before: { department: before.department, permissionOverrides: before.permissionOverrides },
        after: { department: after.department, permissionOverrides: after.permissionOverrides },
        ctx,
      });
    }
    return after;
  },

  /** Breakdown of what a staff member can do and why. */
  async getPermissions(actor, id) {
    const view = await getViewInScope(actor, id);
    const profile = await staffRepository.findProfileByUserId(id);
    return {
      department: view.department,
      base: [...ROLE_PERMISSIONS[ROLES.STAFF]],
      fromDepartment: DEPARTMENT_PERMISSIONS[view.department] ?? [],
      granted: view.permissionOverrides?.grant ?? [],
      revoked: view.permissionOverrides?.revoke ?? [],
      effective: [...effectivePermissions({ role: ROLES.STAFF, staffProfile: profile })].sort(),
    };
  },

  /** Admin: move every staff member from one manager to another (e.g. before deactivating a manager). */
  async transferStaff(actor, fromManagerId, toManagerId, ctx) {
    if (same(fromManagerId, toManagerId)) throw ApiError.badRequest('Source and target manager are the same', 'SAME_MANAGER');
    const from = await userService.getById(actor, fromManagerId);
    if (from.role !== ROLES.MANAGER) throw ApiError.unprocessable('Source must be a manager', [{ field: 'params.id', message: 'not a manager' }], 'INVALID_MANAGER');
    await userService.assertActiveManager(toManagerId, 'body.toManagerId');
    const transferred = await staffRepository.reassignAll(fromManagerId, toManagerId);
    await auditService.record({
      actorId: actor._id, action: AUDIT_ACTIONS.STAFF_REASSIGNED, resourceType: 'User', resourceId: fromManagerId,
      before: { managerId: fromManagerId }, after: { managerId: toManagerId, transferred }, ctx,
    });
    return { transferred };
  },
};
