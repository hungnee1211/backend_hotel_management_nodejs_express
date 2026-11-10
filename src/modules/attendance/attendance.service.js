import mongoose from 'mongoose';
import Attendance from '../../models/Attendance.js';
import Shift from '../../models/Shift.js';
import StaffProfile from '../../models/StaffProfile.js';
import User from '../../models/User.js';
import { ATTENDANCE_STATUS as A } from '../../constants/index.js';
import { PERMISSIONS as P } from '../../constants/permissions.js';
import { ApiError } from '../../utils/ApiError.js';
import { addDaysToKey, monthRangeUtc, toLocalDateKey } from '../../utils/dates.js';
import { buildPageMeta, parsePagination } from '../../utils/pagination.js';
import { auditService } from '../audit-logs/audit.service.js';
import { settingsService } from '../settings/settings.service.js';
import { assertStaffInScope, shiftWindow, visibleStaffIds } from '../shifts/shift.service.js';

const same = (a, b) => String(a) === String(b);
const minutes = (ms) => Math.max(0, Math.floor(ms / 60_000));

/** Late / early / worked minutes for given in-out times against a shift, honouring the configured grace periods. */
const measure = (shift, tz, settings, checkInAt, checkOutAt) => {
  const w = shiftWindow(shift, tz);
  const late = minutes(checkInAt - w.start);
  const early = checkOutAt ? minutes(w.end - checkOutAt) : 0;
  return {
    lateMinutes: late > settings.attendance.lateGraceMinutes ? late : 0,
    earlyDepartureMinutes: early > settings.attendance.earlyLeaveGraceMinutes ? early : 0,
    workedMinutes: checkOutAt ? minutes(checkOutAt - checkInAt) : 0,
  };
};

const loadScoped = async (caller, id) => {
  const a = mongoose.isValidObjectId(id) ? await Attendance.findById(id) : null;
  if (!a) throw ApiError.notFound('Attendance record not found', 'ATTENDANCE_NOT_FOUND');
  await assertStaffInScope(caller, a.staffId);
  return a;
};

export const attendanceService = {
  /** Clock in against the shift that is on now (from `earlyCheckInMinutes` before it starts). One check-in per shift. */
  async checkIn(caller, ctx, now = new Date()) {
    const settings = await settingsService.get(); const tz = settings.timezone;
    const today = toLocalDateKey(now, tz);
    const shifts = await Shift.find({ staffId: caller.user._id, status: 'SCHEDULED', date: { $in: [addDaysToKey(today, -1), today, addDaysToKey(today, 1)] } });
    const open = shifts.map((s) => ({ s, w: shiftWindow(s, tz) })).filter(({ w }) => now >= new Date(w.start.getTime() - settings.attendance.earlyCheckInMinutes * 60_000) && now <= w.end).sort((a, b) => a.w.start - b.w.start);
    if (!open.length) throw ApiError.conflict('You have no shift right now', 'NO_SHIFT');
    const { s } = open[0];
    if (await Attendance.exists({ staffId: caller.user._id, shiftId: s._id })) throw ApiError.conflict('You have already checked in for this shift', 'ALREADY_CHECKED_IN');
    if (await Attendance.exists({ staffId: caller.user._id, status: A.OPEN })) throw ApiError.conflict('Check out of your previous shift first', 'ALREADY_CHECKED_IN');
    let a;
    try { a = await Attendance.create({ staffId: caller.user._id, shiftId: s._id, date: s.date, checkInAt: now, status: A.OPEN, ...measure(s, tz, settings, now, null) }); }
    catch (err) { if (err.code === 11000) throw ApiError.conflict('You have already checked in for this shift', 'ALREADY_CHECKED_IN'); throw err; }
    await auditService.log(caller.user, ctx, 'ATTENDANCE_CHECK_IN', 'Attendance', a._id, { after: { lateMinutes: a.lateMinutes } });
    return a.toJSON();
  },

  async checkOut(caller, ctx, now = new Date()) {
    const open = await Attendance.findOne({ staffId: caller.user._id, status: A.OPEN }).sort({ checkInAt: -1 });
    if (!open) throw ApiError.conflict('You are not checked in', 'NOT_CHECKED_IN');
    const settings = await settingsService.get(); const shift = await Shift.findById(open.shiftId);
    const m = measure(shift, settings.timezone, settings, open.checkInAt, now);
    const a = await Attendance.findOneAndUpdate({ _id: open._id, status: A.OPEN }, { $set: { checkOutAt: now, status: A.CLOSED, ...m } }, { new: true });
    if (!a) throw ApiError.conflict('You are not checked in', 'NOT_CHECKED_IN');
    await auditService.log(caller.user, ctx, 'ATTENDANCE_CHECK_OUT', 'Attendance', a._id, { after: m });
    return a.toJSON();
  },

  async list(caller, q) {
    const ids = await visibleStaffIds(caller);
    const filter = {};
    if (ids) filter.staffId = { $in: ids };
    if (q.staffId) { if (ids && !ids.map(String).includes(String(q.staffId))) throw ApiError.notFound('Staff member not found', 'STAFF_NOT_FOUND'); filter.staffId = q.staffId; }
    if (q.status) filter.status = q.status;
    if (q.from || q.to) filter.date = { ...(q.from && { $gte: q.from }), ...(q.to && { $lte: q.to }) };
    if (q.late) filter.lateMinutes = { $gt: 0 };
    const paging = parsePagination(q, { allowedSort: ['date', 'createdAt'], defaultSort: 'date', defaultLimit: 50 });
    const [items, total] = await Promise.all([Attendance.find(filter).sort(paging.sort).skip(paging.skip).limit(paging.limit), Attendance.countDocuments(filter)]);
    return { items: items.map((a) => a.toJSON()), meta: buildPageMeta({ ...paging, total }) };
  },

  async get(caller, id) { return (await loadScoped(caller, id)).toJSON(); },

  /** Staff ask for a correction; nothing changes until a manager approves. */
  async requestCorrection(caller, id, { checkInAt, checkOutAt, reason }, ctx) {
    const a = await loadScoped(caller, id);
    if (!same(a.staffId, caller.user._id)) throw ApiError.forbidden('You can only correct your own attendance');
    if (a.correction?.status === 'PENDING') throw ApiError.conflict('A correction request is already pending', 'CORRECTION_PENDING');
    a.correction = { requestedCheckInAt: checkInAt, requestedCheckOutAt: checkOutAt, reason, status: 'PENDING', requestedAt: new Date() };
    await a.save();
    await auditService.log(caller.user, ctx, 'ATTENDANCE_CORRECTION_REQUESTED', 'Attendance', id, { after: a.correction });
    return a.toJSON();
  },

  async _apply(a, checkInAt, checkOutAt, approver) {
    const settings = await settingsService.get(); const shift = await Shift.findById(a.shiftId);
    const inAt = checkInAt ?? a.checkInAt; const outAt = checkOutAt ?? a.checkOutAt;
    if (!inAt) throw ApiError.unprocessable('A check-in time is required', [], 'INVALID_TIMES');
    if (outAt && outAt <= inAt) throw ApiError.unprocessable('Check-out must be after check-in', [], 'INVALID_TIMES');
    Object.assign(a, { checkInAt: inAt, checkOutAt: outAt ?? undefined, status: outAt ? A.CLOSED : A.OPEN, approvedBy: approver._id, ...measure(shift, settings.timezone, settings, inAt, outAt) });
  },

  async decideCorrection(caller, id, approve, ctx) {
    const a = await loadScoped(caller, id);
    if (a.correction?.status !== 'PENDING') throw ApiError.conflict('There is no pending correction', 'NO_PENDING_CORRECTION');
    if (same(a.staffId, caller.user._id)) throw ApiError.forbidden('You cannot approve your own correction');
    const before = a.toJSON();
    if (approve) await this._apply(a, a.correction.requestedCheckInAt, a.correction.requestedCheckOutAt, caller.user);
    a.correction.status = approve ? 'APPROVED' : 'REJECTED'; a.correction.decidedBy = caller.user._id; a.correction.decidedAt = new Date();
    await a.save();
    await auditService.log(caller.user, ctx, approve ? 'ATTENDANCE_CORRECTION_APPROVED' : 'ATTENDANCE_CORRECTION_REJECTED', 'Attendance', id, { before, after: a.toJSON() });
    return a.toJSON();
  },

  /** Direct correction by a manager/admin (audited with before/after). */
  async correct(caller, id, { checkInAt, checkOutAt, note }, ctx) {
    const a = await loadScoped(caller, id);
    if (same(a.staffId, caller.user._id)) throw ApiError.forbidden('You cannot edit your own attendance');
    const before = a.toJSON();
    await this._apply(a, checkInAt, checkOutAt, caller.user);
    if (note) a.note = note;
    await a.save();
    await auditService.log(caller.user, ctx, 'ATTENDANCE_CORRECTED', 'Attendance', id, { before, after: a.toJSON() });
    return a.toJSON();
  },

  /** Monthly summary per staff member (hotel-local month). Shifts that ended with no attendance count as absences. */
  async report(caller, { month, staffId, department }, now = new Date()) {
    const settings = await settingsService.get(); const tz = settings.timezone;
    const [y, m] = month.split('-').map(Number);
    const from = `${month}-01`; const to = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
    const ids = await visibleStaffIds(caller);
    const sf = { date: { $gte: from, $lt: to }, status: 'SCHEDULED', ...(ids ? { staffId: { $in: ids } } : {}), ...(staffId ? { staffId: new mongoose.Types.ObjectId(String(staffId)) } : {}), ...(department ? { department } : {}) };
    if (staffId && ids && !ids.map(String).includes(String(staffId))) throw ApiError.notFound('Staff member not found', 'STAFF_NOT_FOUND');
    const shifts = await Shift.find(sf).lean();
    const att = await Attendance.find({ shiftId: { $in: shifts.map((s) => s._id) } }).lean();
    const byShift = new Map(att.map((a) => [String(a.shiftId), a]));
    const users = new Map((await User.find({ _id: { $in: [...new Set(shifts.map((s) => String(s.staffId)))] } }).select('fullName').lean()).map((u) => [String(u._id), u.fullName]));
    const rows = new Map();
    for (const s of shifts) {
      const r = rows.get(String(s.staffId)) ?? { staffId: String(s.staffId), fullName: users.get(String(s.staffId)), department: s.department, scheduledShifts: 0, endedShifts: 0, present: 0, late: 0, absent: 0, earlyDepartures: 0, missingCheckouts: 0, workedMinutes: 0 };
      const a = byShift.get(String(s._id)); const ended = shiftWindow(s, tz).end <= now;
      r.scheduledShifts += 1; if (ended) r.endedShifts += 1;
      if (a && a.status !== A.ABSENT) { r.present += 1; if (a.lateMinutes > 0) r.late += 1; if (a.earlyDepartureMinutes > 0) r.earlyDepartures += 1; if (a.status === A.MISSING_CHECKOUT) r.missingCheckouts += 1; r.workedMinutes += a.workedMinutes; }
      else if (ended) r.absent += 1;
      rows.set(String(s.staffId), r);
    }
    const staff = [...rows.values()].map((r) => ({ ...r, attendanceRate: r.endedShifts ? Math.round((r.present / r.endedShifts) * 10_000) / 100 : null }));
    const byDepartment = {};
    for (const r of staff) { const d = (byDepartment[r.department] ??= { department: r.department, staff: 0, endedShifts: 0, present: 0, late: 0, absent: 0, workedMinutes: 0 }); d.staff += 1; for (const k of ['endedShifts', 'present', 'late', 'absent', 'workedMinutes']) d[k] += r[k]; }
    return { month, timezone: tz, range: monthRangeUtc(y, m, tz), staff, byDepartment: Object.values(byDepartment) };
  },

  // ---------------- jobs ----------------
  /** Open attendance whose shift ended long ago: flagged for correction instead of staying "open" forever. */
  async markMissingCheckouts(now = new Date()) {
    const settings = await settingsService.get(); let n = 0;
    for (const a of await Attendance.find({ status: A.OPEN }).limit(200)) {
      const shift = await Shift.findById(a.shiftId);
      if (shift && now.getTime() > shiftWindow(shift, settings.timezone).end.getTime() + 4 * 3_600_000) { await Attendance.updateOne({ _id: a._id, status: A.OPEN }, { $set: { status: A.MISSING_CHECKOUT } }); n += 1; }
    }
    return n;
  },
  /** Shifts that ended with nobody clocking in get an ABSENT record (unique index prevents duplicates). */
  async markAbsences(now = new Date()) {
    const settings = await settingsService.get(); const today = toLocalDateKey(now, settings.timezone); let n = 0;
    const shifts = await Shift.find({ status: 'SCHEDULED', date: { $in: [addDaysToKey(today, -2), addDaysToKey(today, -1), today] } });
    for (const s of shifts) {
      if (shiftWindow(s, settings.timezone).end.getTime() + 30 * 60_000 > now.getTime()) continue;
      const r = await Attendance.updateOne({ staffId: s.staffId, shiftId: s._id }, { $setOnInsert: { staffId: s.staffId, shiftId: s._id, date: s.date, status: A.ABSENT } }, { upsert: true });
      if (r.upsertedCount) n += 1;
    }
    return n;
  },
};
export { P as _P, StaffProfile as _SP };
