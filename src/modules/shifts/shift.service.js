import mongoose from 'mongoose';
import Shift from '../../models/Shift.js';
import Attendance from '../../models/Attendance.js';
import StaffProfile from '../../models/StaffProfile.js';
import { ROLES } from '../../constants/index.js';
import { PERMISSIONS as P } from '../../constants/permissions.js';
import { ApiError } from '../../utils/ApiError.js';
import { addDaysToKey, localToUtc } from '../../utils/dates.js';
import { buildPageMeta, parsePagination } from '../../utils/pagination.js';
import { auditService } from '../audit-logs/audit.service.js';
import { settingsService } from '../settings/settings.service.js';
import { staffScopeService } from '../staff/staff-scope.service.js';

const same = (a, b) => String(a) === String(b);
const hm = (s) => s.split(':').map(Number);

/** Absolute start/end instants of a shift in the hotel's timezone. An end time earlier than the start means "next day". */
export const shiftWindow = (shift, tz) => {
  const [y, m, d] = shift.date.split('-').map(Number);
  const [sh, sm] = hm(shift.startTime); const [eh, em] = hm(shift.endTime);
  const start = localToUtc(y, m, d, sh, sm, tz);
  let end = localToUtc(y, m, d, eh, em, tz);
  if (end <= start) { const [ny, nm, nd] = addDaysToKey(shift.date, 1).split('-').map(Number); end = localToUtc(ny, nm, nd, eh, em, tz); }
  return { start, end };
};

/** Admin: any staff. Manager: their own team (404 otherwise). Staff: only themselves. */
export const assertStaffInScope = async (caller, staffId) => {
  if (caller.user.role === ROLES.ADMIN) return;
  if (same(staffId, caller.user._id) && caller.user.role === ROLES.STAFF) return;
  if (caller.user.role === ROLES.MANAGER) {
    const profile = mongoose.isValidObjectId(staffId) ? await staffScopeService.findProfile(staffId) : null;
    if (profile && same(profile.managerId, caller.user._id)) return;
    throw ApiError.notFound('Staff member not found', 'STAFF_NOT_FOUND');
  }
  // Staff asking about someone else's records: 404, not 403, so they cannot probe what exists.
  throw caller.user.role === ROLES.STAFF ? ApiError.notFound('Staff member not found', 'STAFF_NOT_FOUND') : ApiError.forbidden();
};

/** Ids a caller may look at: everyone (Admin), their team (Manager) or just themselves (Staff). null = no restriction. */
export const visibleStaffIds = async (caller) => {
  if (caller.user.role === ROLES.ADMIN) return null;
  if (caller.user.role === ROLES.MANAGER) return staffScopeService.listManagedUserIds(caller.user._id);
  return [caller.user._id];
};

export const shiftService = {
  async create(caller, { staffId, date, startTime, endTime }, ctx) {
    await assertStaffInScope(caller, staffId);
    const profile = await StaffProfile.findOne({ userId: staffId });
    if (!profile) throw ApiError.unprocessable('Not a staff member', [{ field: 'body.staffId', message: 'invalid' }], 'INVALID_STAFF');
    const tz = (await settingsService.get()).timezone;
    const candidate = { date, startTime, endTime };
    const w = shiftWindow(candidate, tz);
    if (w.end - w.start > 16 * 3_600_000) throw ApiError.unprocessable('A shift cannot be longer than 16 hours', [], 'SHIFT_TOO_LONG');
    if (startTime === endTime) throw ApiError.unprocessable('Start and end time must differ', [], 'INVALID_SHIFT');
    const near = await Shift.find({ staffId, status: 'SCHEDULED', date: { $in: [addDaysToKey(date, -1), date, addDaysToKey(date, 1)] } });
    if (near.some((s) => { const o = shiftWindow(s, tz); return o.start < w.end && w.start < o.end; })) throw ApiError.conflict('The staff member already has an overlapping shift', 'SHIFT_OVERLAP');
    const shift = await Shift.create({ staffId, date, startTime, endTime, department: profile.department, createdBy: caller.user._id });
    await auditService.log(caller.user, ctx, 'SHIFT_CREATED', 'Shift', shift._id, { after: shift });
    return shift.toJSON();
  },

  async list(caller, q) {
    const ids = await visibleStaffIds(caller);
    const filter = {};
    if (ids) filter.staffId = { $in: ids };
    if (q.staffId) { if (ids && !ids.map(String).includes(String(q.staffId))) return { items: [], meta: buildPageMeta({ page: 1, limit: q.limit ?? 20, total: 0 }) }; filter.staffId = q.staffId; }
    if (q.status) filter.status = q.status;
    if (q.department) filter.department = q.department;
    if (q.from || q.to) filter.date = { ...(q.from && { $gte: q.from }), ...(q.to && { $lte: q.to }) };
    const paging = parsePagination(q, { allowedSort: ['date', 'createdAt'], defaultSort: 'date', defaultLimit: 50 });
    const [items, total] = await Promise.all([Shift.find(filter).sort(paging.sort).skip(paging.skip).limit(paging.limit), Shift.countDocuments(filter)]);
    return { items: items.map((s) => s.toJSON()), meta: buildPageMeta({ ...paging, total }) };
  },

  async _loadManageable(caller, id) {
    const s = mongoose.isValidObjectId(id) ? await Shift.findById(id) : null;
    if (!s) throw ApiError.notFound('Shift not found', 'SHIFT_NOT_FOUND');
    await assertStaffInScope(caller, s.staffId);
    if (await Attendance.exists({ shiftId: s._id })) throw ApiError.conflict('This shift already has attendance records', 'SHIFT_HAS_ATTENDANCE');
    return s;
  },

  async update(caller, id, patch, ctx) {
    const s = await this._loadManageable(caller, id);
    const before = s.toJSON();
    Object.assign(s, patch);
    const tz = (await settingsService.get()).timezone; const w = shiftWindow(s, tz);
    if (w.end - w.start > 16 * 3_600_000 || s.startTime === s.endTime) throw ApiError.unprocessable('Invalid shift times', [], 'INVALID_SHIFT');
    const others = await Shift.find({ staffId: s.staffId, status: 'SCHEDULED', _id: { $ne: s._id }, date: { $in: [addDaysToKey(s.date, -1), s.date, addDaysToKey(s.date, 1)] } });
    if (others.some((o) => { const x = shiftWindow(o, tz); return x.start < w.end && w.start < x.end; })) throw ApiError.conflict('The staff member already has an overlapping shift', 'SHIFT_OVERLAP');
    await s.save();
    await auditService.log(caller.user, ctx, 'SHIFT_UPDATED', 'Shift', id, { before, after: s.toJSON() });
    return s.toJSON();
  },

  async cancel(caller, id, ctx) {
    const s = await this._loadManageable(caller, id);
    s.status = 'CANCELLED'; await s.save();
    await auditService.log(caller.user, ctx, 'SHIFT_CANCELLED', 'Shift', id, {});
    return s.toJSON();
  },
};
export const requirePerm = P;
