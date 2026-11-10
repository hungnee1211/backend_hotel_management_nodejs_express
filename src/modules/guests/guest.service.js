import { AUDIT_ACTIONS } from '../../constants/index.js';
import { PERMISSIONS as P } from '../../constants/permissions.js';
import { ApiError } from '../../utils/ApiError.js';
import { buildPageMeta, escapeRegex, parsePagination } from '../../utils/pagination.js';
import { blindIndex, decryptPii, encryptPii, lastFour } from '../../utils/pii.js';
import { auditService } from '../audit-logs/audit.service.js';
import { userService } from '../users/user.service.js';
import { guestRepository } from './guest.repository.js';

/**
 * `caller` is { user, permissions } (permissions from req.permissions, so Staff departments count).
 *   GUEST_READ / GUEST_MANAGE  : staff, managers, admins work with ALL guests.
 *   GUEST_MANAGE_OWN           : customers work only with guests they created or that are their own account.
 */
const same = (a, b) => String(a) === String(b);
const isOwn = (caller, guest) => same(guest.createdBy, caller.user._id) || (guest.userId && same(guest.userId, caller.user._id));

const audit = (action, { caller, guest, before, after, ctx }) =>
  auditService.record({ actorId: caller.user._id, action, resourceType: 'Guest', resourceId: guest._id, before, after, ctx });

const toStoredIdentification = ({ type, number }) => ({
  type,
  numberEncrypted: encryptPii(number),
  numberHash: blindIndex(number),
  last4: lastFour(number),
});

/** Masked by default; the full number appears only when explicitly revealed. */
const present = (guest, { reveal = false } = {}) => {
  const view = guest.toJSON();
  const id = guest.identification;
  view.identification = id?.type
    ? { type: id.type, maskedNumber: `****${id.last4}`, ...(reveal ? { number: decryptPii(id.numberEncrypted) } : {}) }
    : null;
  return view;
};

/** Returns the guest if the caller may access it; 403 if they could never, 404 if it is simply not theirs. */
const loadAccessible = async (caller, id, { write = false, withSecrets = false } = {}) => {
  const allRight = write ? P.GUEST_MANAGE : P.GUEST_READ;
  const hasAll = caller.permissions.has(allRight);
  const hasOwn = caller.permissions.has(P.GUEST_MANAGE_OWN);
  if (!hasAll && !hasOwn) throw ApiError.forbidden();

  const guest = await guestRepository.findById(id, { withSecrets });
  if (!guest) throw ApiError.notFound('Guest not found', 'GUEST_NOT_FOUND');
  if (hasAll) return guest;
  if (hasOwn && isOwn(caller, guest)) return guest;
  throw ApiError.notFound('Guest not found', 'GUEST_NOT_FOUND'); // do not reveal other people's guests exist
};

export const guestService = {
  async create(caller, payload, ctx) {
    const privileged = caller.permissions.has(P.GUEST_MANAGE);
    if (!privileged && !caller.permissions.has(P.GUEST_MANAGE_OWN)) throw ApiError.forbidden();
    if (payload.userId && !privileged) throw ApiError.forbidden('You cannot link a guest to an account', 'FORBIDDEN');
    if (payload.userId) await userService.assertCustomer(payload.userId);

    const data = {
      fullName: payload.fullName, email: payload.email, phone: payload.phone, nationality: payload.nationality,
      address: payload.address, notes: payload.notes || undefined, userId: payload.userId ?? null, createdBy: caller.user._id,
    };
    if (payload.identification) {
      data.identification = toStoredIdentification(payload.identification);
      if (privileged) {
        // Front-desk safety net: the same ID number is probably the same returning guest.
        const existing = await guestRepository.findByNumberHash(data.identification.numberHash);
        if (existing) {
          throw new ApiError(409, 'A guest with this identification number already exists', 'GUEST_EXISTS',
            [{ field: 'body.identification.number', message: 'already registered', guestId: String(existing._id) }]);
        }
      }
    }
    const guest = await guestRepository.create(data);
    await audit(AUDIT_ACTIONS.GUEST_CREATED, { caller, guest, after: present(guest), ctx });
    return present(guest);
  },

  async list(caller, query) {
    const hasAll = caller.permissions.has(P.GUEST_READ);
    if (!hasAll && !caller.permissions.has(P.GUEST_MANAGE_OWN)) throw ApiError.forbidden();

    const and = [];
    if (!hasAll) and.push({ $or: [{ createdBy: caller.user._id }, { userId: caller.user._id }] });
    if (query.email) and.push({ email: query.email });
    if (query.phone) and.push({ phone: query.phone });
    if (query.idNumber) and.push({ 'identification.numberHash': blindIndex(query.idNumber) });
    if (query.search) {
      const rx = new RegExp(escapeRegex(query.search), 'i');
      and.push({ $or: [{ fullName: rx }, { email: rx }, { phone: rx }] });
    }
    const paging = parsePagination(query, { allowedSort: ['createdAt', 'fullName'] });
    const { items, total } = await guestRepository.list(and.length ? { $and: and } : {}, paging);
    return { items: items.map((g) => present(g)), meta: buildPageMeta({ ...paging, total }) };
  },

  async get(caller, id, { revealIdentification = false } = {}, ctx) {
    if (revealIdentification && !caller.permissions.has(P.GUEST_VIEW_IDENTIFICATION)) {
      throw ApiError.forbidden('You are not allowed to view identification numbers', 'ID_VIEW_FORBIDDEN');
    }
    const guest = await loadAccessible(caller, id, { withSecrets: revealIdentification });
    if (revealIdentification && guest.identification?.type) {
      // Every look at a full ID number leaves a trace, even though nothing is changed.
      await audit(AUDIT_ACTIONS.GUEST_ID_VIEWED, { caller, guest, after: { idType: guest.identification.type }, ctx });
    }
    return present(guest, { reveal: revealIdentification });
  },

  async update(caller, id, payload, ctx) {
    const guest = await loadAccessible(caller, id, { write: true });
    const privileged = caller.permissions.has(P.GUEST_MANAGE);
    if (payload.userId !== undefined && !privileged) throw ApiError.forbidden('You cannot link a guest to an account');
    if (payload.userId) await userService.assertCustomer(payload.userId);

    const set = {};
    const unset = {};
    for (const key of ['fullName', 'email', 'phone', 'nationality', 'address']) if (payload[key] !== undefined) set[key] = payload[key];
    if (payload.notes !== undefined) set.notes = payload.notes;
    if (payload.userId !== undefined) set.userId = payload.userId;
    if (payload.identification === null) unset.identification = '';
    else if (payload.identification) {
      const stored = toStoredIdentification(payload.identification);
      if (privileged) {
        const existing = await guestRepository.findByNumberHash(stored.numberHash);
        if (existing && !same(existing._id, guest._id)) {
          throw new ApiError(409, 'Another guest already has this identification number', 'GUEST_EXISTS',
            [{ field: 'body.identification.number', message: 'already registered', guestId: String(existing._id) }]);
        }
      }
      set.identification = stored;
    }

    const before = present(guest);
    const updated = await guestRepository.updateById(id, { ...(Object.keys(set).length && { $set: set }), ...(Object.keys(unset).length && { $unset: unset }) });
    await audit(AUDIT_ACTIONS.GUEST_UPDATED, { caller, guest, before, after: present(updated), ctx });
    return present(updated);
  },

  /** Soft delete. (Phase 6 will anonymize instead when the guest has booking history.) */
  async remove(caller, id, ctx) {
    if (!caller.permissions.has(P.GUEST_DELETE)) throw ApiError.forbidden();
    const guest = await guestRepository.findById(id);
    if (!guest) throw ApiError.notFound('Guest not found', 'GUEST_NOT_FOUND');
    await guestRepository.updateById(id, { $set: { deletedAt: new Date() } });
    await audit(AUDIT_ACTIONS.GUEST_DELETED, { caller, guest, before: present(guest), ctx });
  },
};
