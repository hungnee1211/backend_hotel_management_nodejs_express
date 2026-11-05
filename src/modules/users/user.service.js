import { AUDIT_ACTIONS, ROLES, USER_STATUS } from '../../constants/index.js';
import { ApiError } from '../../utils/ApiError.js';
import { hashPassword } from '../../utils/crypto.js';
import { buildPageMeta, escapeRegex, parsePagination } from '../../utils/pagination.js';
import { auditService } from '../audit-logs/audit.service.js';
import { authService } from '../auth/auth.service.js';
import { staffScopeService } from '../staff/staff-scope.service.js';
import { userRepository } from './user.repository.js';
import { canManageUser, isSelf } from './user.policy.js';

/** Who may create which role. Public registration (Phase 3) can only ever create CUSTOMERs. */
const CREATABLE_ROLES = { [ROLES.ADMIN]: [ROLES.MANAGER, ROLES.STAFF], [ROLES.MANAGER]: [ROLES.STAFF] };

const audit = (action, { actor, target, before, after, ctx }) =>
  auditService.record({ actorId: actor._id, action, resourceType: 'User', resourceId: target._id, before, after, ctx });

/**
 * Loads a user the actor is allowed to administer. A manager asking about someone outside their team
 * gets 404 (not 403), so they cannot probe which accounts exist.
 */
const loadInScope = async (actor, id) => {
  const target = await userRepository.findById(id);
  const profile = target?.role === ROLES.STAFF ? await staffScopeService.findProfile(target._id) : null;
  if (!target) throw ApiError.notFound('User not found', 'USER_NOT_FOUND');
  if (canManageUser(actor, target, profile)) return target;
  if (actor.role === ROLES.MANAGER) throw ApiError.notFound('User not found', 'USER_NOT_FOUND');
  throw ApiError.forbidden(
    target.role === ROLES.ADMIN ? 'Admin accounts cannot be modified by other users' : undefined,
    target.role === ROLES.ADMIN ? 'ADMIN_PROTECTED' : 'FORBIDDEN',
  );
};

const assertNotSelf = (actor, target, what) => {
  if (isSelf(actor, target)) throw ApiError.forbidden(`You cannot ${what} your own account`, 'SELF_ACTION_FORBIDDEN');
};

/** A manager who still has active staff must hand them over first (see POST /api/managers/:id/transfer-staff). */
const assertNoActiveReports = async (target) => {
  if (target.role !== ROLES.MANAGER) return;
  if ((await staffScopeService.countActiveReports(target._id)) > 0) {
    throw ApiError.conflict('This manager still has active staff. Transfer them to another manager first.', 'MANAGER_HAS_ACTIVE_STAFF');
  }
};

export const userService = {
  /**
   * Creates an Admin/Manager-provisioned account (already verified, no OTP). `passwordHash` must be
   * pre-hashed by the caller so no slow hashing happens inside a database transaction.
   * Does NOT write the audit entry: the caller does that after its transaction commits.
   */
  async createManagedUser(actor, { fullName, email, phone, passwordHash, role }, { session } = {}) {
    if (!CREATABLE_ROLES[actor.role]?.includes(role)) {
      throw ApiError.forbidden(`${actor.role} accounts cannot create ${role} accounts`, 'ROLE_NOT_CREATABLE');
    }
    if (await userRepository.findDuplicate({ email, phone }, { session })) {
      throw ApiError.conflict('An account with this email or phone number already exists', 'ACCOUNT_EXISTS');
    }
    return userRepository.create(
      { fullName, email, phone, password: passwordHash, role, status: USER_STATUS.ACTIVE, isVerified: true, createdBy: actor._id },
      { session },
    );
  },

  async createManager(actor, payload, ctx) {
    const user = await this.createManagedUser(actor, { ...payload, passwordHash: await hashPassword(payload.password), role: ROLES.MANAGER });
    await audit(AUDIT_ACTIONS.USER_CREATED, { actor, target: user, after: user, ctx });
    return user;
  },

  async list(actor, query) {
    const filter = {};
    if (actor.role === ROLES.MANAGER) filter._id = { $in: await staffScopeService.listManagedUserIds(actor._id) };
    else if (actor.role !== ROLES.ADMIN) throw ApiError.forbidden();

    if (query.role) filter.role = query.role;
    if (query.status) filter.status = query.status;
    if (query.isVerified !== undefined) filter.isVerified = query.isVerified;
    if (query.search) {
      const rx = new RegExp(escapeRegex(query.search), 'i');
      filter.$or = [{ fullName: rx }, { email: rx }, { phone: rx }];
    }
    const paging = parsePagination(query, { allowedSort: ['createdAt', 'fullName', 'email', 'role', 'status'] });
    const { items, total } = await userRepository.list(filter, paging);
    return { items, meta: buildPageMeta({ ...paging, total }) };
  },

  getById: (actor, id) => loadInScope(actor, id),

  /** Admin/Manager edit of someone else's basic details (role, email, phone are not editable here). */
  async update(actor, id, { fullName, avatar }, ctx) {
    const target = await loadInScope(actor, id);
    const changes = {};
    if (fullName !== undefined) changes.fullName = fullName;
    if (avatar !== undefined) changes.avatar = avatar;
    const before = { fullName: target.fullName, avatar: target.avatar };
    const updated = await userRepository.updateById(id, { $set: changes });
    await audit(AUDIT_ACTIONS.USER_UPDATED, { actor, target, before, after: changes, ctx });
    return updated;
  },

  async deactivate(actor, id, ctx) {
    const target = await loadInScope(actor, id);
    assertNotSelf(actor, target, 'deactivate');
    if (target.status === USER_STATUS.INACTIVE) return target;
    await assertNoActiveReports(target);
    const updated = await userRepository.updateById(id, { $set: { status: USER_STATUS.INACTIVE } });
    await authService.revokeAllSessions(id);
    await audit(AUDIT_ACTIONS.USER_DEACTIVATED, { actor, target, before: { status: target.status }, after: { status: USER_STATUS.INACTIVE }, ctx });
    return updated;
  },

  async reactivate(actor, id, ctx) {
    const target = await loadInScope(actor, id);
    if (target.status === USER_STATUS.ACTIVE) return target;
    const updated = await userRepository.updateById(id, { $set: { status: USER_STATUS.ACTIVE } });
    await audit(AUDIT_ACTIONS.USER_REACTIVATED, { actor, target, before: { status: target.status }, after: { status: USER_STATUS.ACTIVE }, ctx });
    return updated;
  },

  /** Soft delete (Admin only): hidden everywhere, history kept, email/phone stay reserved. */
  async softDelete(actor, id, ctx) {
    if (actor.role !== ROLES.ADMIN) throw ApiError.forbidden();
    const target = await loadInScope(actor, id);
    assertNotSelf(actor, target, 'delete');
    await assertNoActiveReports(target);
    await userRepository.updateById(id, { $set: { deletedAt: new Date(), status: USER_STATUS.INACTIVE } });
    await authService.revokeAllSessions(id);
    await audit(AUDIT_ACTIONS.USER_DELETED, { actor, target, before: target, ctx });
  },

  /** Throws 422 unless `id` is an active, verified CUSTOMER (used when linking a guest to an account). */
  async assertCustomer(id) {
    const user = await userRepository.findById(id);
    if (!user || user.role !== ROLES.CUSTOMER || user.status !== USER_STATUS.ACTIVE) {
      throw ApiError.unprocessable('userId must reference an active customer account', [{ field: 'body.userId', message: 'not an active customer' }]);
    }
    return user;
  },

  /** Throws 422 unless `id` is an active MANAGER. */
  async assertActiveManager(id, field = 'body.managerId') {
    const user = await userRepository.findById(id);
    if (!user || user.role !== ROLES.MANAGER || user.status !== USER_STATUS.ACTIVE) {
      throw ApiError.unprocessable('Must reference an active manager', [{ field, message: 'not an active manager' }], 'INVALID_MANAGER');
    }
    return user;
  },
};
