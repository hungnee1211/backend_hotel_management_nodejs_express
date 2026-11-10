import mongoose from 'mongoose';
import Equipment from '../../models/Equipment.js';
import Facility from '../../models/Facility.js';
import MaintenanceHistory from '../../models/MaintenanceHistory.js';
import MaintenanceRequest from '../../models/MaintenanceRequest.js';
import Room from '../../models/Room.js';
import StaffProfile from '../../models/StaffProfile.js';
import User from '../../models/User.js';
import { EQUIPMENT_STATUS as E, MAINT_STATUS as S, ROLES } from '../../constants/index.js';
import { PERMISSIONS as P, effectivePermissions } from '../../constants/permissions.js';
import { ApiError } from '../../utils/ApiError.js';
import { buildPageMeta, parsePagination } from '../../utils/pagination.js';
import { withTransaction } from '../../utils/transaction.js';
import { auditService } from '../audit-logs/audit.service.js';
import { availabilityService } from '../availability/availability.service.js';
import { counterService } from '../counters/counter.service.js';
import { facilityService } from '../facilities/facility.service.js';
import { inAppNotifications } from '../notifications/notification.repository.service.js';

const same = (a, b) => String(a) === String(b);
const OPEN = [S.PENDING, S.ASSIGNED, S.IN_PROGRESS];
const manage = (c) => c.permissions.has(P.MAINTENANCE_MANAGE);

/** Managers decide on requests for facilities they run; room and general requests are shared among managers. */
const assertManageable = async (caller, r) => {
  if (caller.user.role === ROLES.ADMIN || !r.facilityId) return;
  const fac = await Facility.findById(r.facilityId);
  if (!fac || !same(fac.managerId, caller.user._id)) throw ApiError.notFound('Maintenance request not found', 'MAINTENANCE_NOT_FOUND');
};
const load = async (caller, id) => {
  const r = mongoose.isValidObjectId(id) ? await MaintenanceRequest.findById(id) : null;
  const mine = r && (same(r.reportedBy, caller.user._id) || (r.assignedStaffId && same(r.assignedStaffId, caller.user._id)));
  if (!r || (!mine && !manage(caller))) throw ApiError.notFound('Maintenance request not found', 'MAINTENANCE_NOT_FOUND');
  if (!mine && manage(caller)) await assertManageable(caller, r);
  return r;
};

export const maintenanceService = {
  /** Anyone on staff can report a fault. Scheduling preventive work or taking a room out of service needs maintenance authority. */
  async create(caller, p, ctx) {
    if (!caller.permissions.has(P.MAINTENANCE_REPORT)) throw ApiError.forbidden();
    const preventive = p.type === 'PREVENTIVE';
    if ((preventive || p.blockFrom) && !manage(caller)) throw ApiError.forbidden('Only maintenance managers can schedule preventive work or block rooms');
    let { facilityId } = p; let equipment = null;
    if (p.equipmentId) {
      equipment = await Equipment.findOne({ _id: p.equipmentId, deletedAt: null });
      if (!equipment || equipment.status === E.RETIRED) throw ApiError.unprocessable('Unknown or retired equipment', [{ field: 'body.equipmentId', message: 'invalid' }], 'INVALID_EQUIPMENT');
      facilityId = equipment.facilityId;
    }
    if (facilityId && !(await Facility.exists({ _id: facilityId, deletedAt: null }))) throw ApiError.unprocessable('Unknown facility', [{ field: 'body.facilityId', message: 'invalid' }]);
    if (p.roomId && !(await Room.exists({ _id: p.roomId, deletedAt: null }))) throw ApiError.unprocessable('Unknown room', [{ field: 'body.roomId', message: 'invalid' }]);
    if (!p.equipmentId && !facilityId && !p.roomId) throw ApiError.unprocessable('Specify equipment, facility or room', [{ field: 'body', message: 'target required' }], 'TARGET_REQUIRED');
    if (preventive && facilityId) await assertManageable(caller, { facilityId });
    const requestCode = await counterService.formatted('maintenance', 'MNT', 6);
    const data = { requestCode, type: p.type ?? 'CORRECTIVE', equipmentId: p.equipmentId, facilityId, roomId: p.roomId, blockFrom: p.blockFrom, blockTo: p.blockTo, title: p.title, description: p.description, priority: p.priority, estimatedCostMinor: p.estimatedCostMinor, scheduledFor: p.scheduledFor, reportedBy: caller.user._id };

    const r = await withTransaction(async (session) => {
      const [created] = await MaintenanceRequest.create([data], { session });
      if (equipment && !preventive && equipment.status === E.ACTIVE) await Equipment.updateOne({ _id: equipment._id, status: E.ACTIVE }, { $set: { status: E.DAMAGED } }, { session }); // a reported fault means it must not be treated as operational
      if (p.roomId && p.blockFrom) await availabilityService.block({ roomId: p.roomId, from: p.blockFrom, to: p.blockTo, blockRef: created._id, reason: p.title }, { session });
      return created;
    });
    const fac = facilityId && (await Facility.findById(facilityId));
    if (fac?.managerId) await inAppNotifications.notify([fac.managerId], { type: 'MAINTENANCE_REPORTED', title: `Maintenance: ${p.title}`, body: p.priority, refType: 'MaintenanceRequest', refId: r._id, dedupeKey: `mnt-new:${r._id}` });
    await auditService.log(caller.user, ctx, 'MAINTENANCE_CREATED', 'MaintenanceRequest', r._id, { after: { requestCode, title: p.title, priority: r.priority } });
    return r.toJSON();
  },

  async list(caller, q) {
    let filter;
    if (caller.user.role === ROLES.ADMIN) filter = {};
    else if (manage(caller)) filter = { $or: [{ facilityId: { $in: await facilityService.managedIds(caller) } }, { facilityId: null }, { reportedBy: caller.user._id }] };
    else filter = { $or: [{ assignedStaffId: caller.user._id }, { reportedBy: caller.user._id }] };
    const and = [filter];
    for (const k of ['status', 'priority', 'type', 'equipmentId', 'facilityId', 'roomId', 'assignedStaffId']) if (q[k]) and.push({ [k]: q[k] });
    const paging = parsePagination(q, { allowedSort: ['createdAt', 'priority', 'scheduledFor'], defaultSort: 'createdAt' });
    const [items, total] = await Promise.all([MaintenanceRequest.find({ $and: and }).sort(paging.sort).skip(paging.skip).limit(paging.limit), MaintenanceRequest.countDocuments({ $and: and })]);
    return { items: items.map((r) => r.toJSON()), meta: buildPageMeta({ ...paging, total }) };
  },
  async get(caller, id) { return (await load(caller, id)).toJSON(); },

  async assign(caller, id, staffId, ctx) {
    const r = await load(caller, id);
    if (!manage(caller)) throw ApiError.forbidden();
    if (![S.PENDING, S.ASSIGNED].includes(r.status)) throw ApiError.conflict('Only pending or assigned requests can be assigned', 'INVALID_STATE_TRANSITION');
    const user = await User.findOne({ _id: staffId, deletedAt: null, status: 'ACTIVE', role: ROLES.STAFF });
    const profile = user && (await StaffProfile.findOne({ userId: staffId }));
    if (!profile || !effectivePermissions({ role: ROLES.STAFF, staffProfile: profile }).has(P.MAINTENANCE_WORK)) throw ApiError.unprocessable('Not a maintenance staff member', [{ field: 'body.assignedStaffId', message: 'invalid' }], 'INVALID_ASSIGNEE');
    if (caller.user.role === ROLES.MANAGER && !same(profile.managerId, caller.user._id)) throw ApiError.unprocessable('That staff member is not on your team', [{ field: 'body.assignedStaffId', message: 'not your team' }], 'INVALID_ASSIGNEE');
    const u = await MaintenanceRequest.findOneAndUpdate({ _id: id, status: { $in: [S.PENDING, S.ASSIGNED] } }, { $set: { assignedStaffId: staffId, status: S.ASSIGNED } }, { new: true });
    if (!u) throw ApiError.conflict('The request was changed by someone else', 'REQUEST_CHANGED');
    await inAppNotifications.notify([staffId], { type: 'MAINTENANCE_ASSIGNED', title: `Assigned: ${r.title}`, refType: 'MaintenanceRequest', refId: id, dedupeKey: `mnt-assign:${id}:${staffId}` });
    await auditService.log(caller.user, ctx, 'MAINTENANCE_ASSIGNED', 'MaintenanceRequest', id, { after: { assignedStaffId: staffId } });
    return u.toJSON();
  },

  async start(caller, id, ctx) {
    const r = await load(caller, id);
    if (!(r.assignedStaffId && same(r.assignedStaffId, caller.user._id)) && !manage(caller)) throw ApiError.forbidden('Only the assigned staff member can start the work');
    const u = await withTransaction(async (session) => {
      const x = await MaintenanceRequest.findOneAndUpdate({ _id: id, status: S.ASSIGNED }, { $set: { status: S.IN_PROGRESS, startedAt: new Date() } }, { new: true, session });
      if (!x) throw ApiError.conflict('Only assigned requests can be started', 'INVALID_STATE_TRANSITION');
      if (x.equipmentId) await Equipment.updateOne({ _id: x.equipmentId, status: { $in: [E.ACTIVE, E.DAMAGED] } }, { $set: { status: E.IN_MAINTENANCE } }, { session });
      return x;
    });
    await auditService.log(caller.user, ctx, 'MAINTENANCE_STARTED', 'MaintenanceRequest', id, {});
    return u.toJSON();
  },

  /** Progress notes and cost estimates while the work is under way. */
  async update(caller, id, patch, ctx) {
    const r = await load(caller, id);
    if (!(r.assignedStaffId && same(r.assignedStaffId, caller.user._id)) && !manage(caller)) throw ApiError.forbidden();
    if (!OPEN.includes(r.status)) throw ApiError.conflict('Closed requests cannot be changed', 'INVALID_STATE_TRANSITION');
    const u = await MaintenanceRequest.findByIdAndUpdate(id, { $set: patch }, { new: true, runValidators: true });
    await auditService.log(caller.user, ctx, 'MAINTENANCE_UPDATED', 'MaintenanceRequest', id, { before: r, after: u });
    return u.toJSON();
  },

  /** Completion writes the permanent repair record, restores the equipment, and puts a blocked room back on sale. */
  async complete(caller, id, { actualCostMinor = 0, resolution }, ctx) {
    const r = await load(caller, id);
    if (!(r.assignedStaffId && same(r.assignedStaffId, caller.user._id)) && !manage(caller)) throw ApiError.forbidden('Only the assigned staff member can complete the work');
    const u = await withTransaction(async (session) => {
      const now = new Date();
      const x = await MaintenanceRequest.findOneAndUpdate({ _id: id, status: S.IN_PROGRESS }, { $set: { status: S.COMPLETED, completedAt: now, actualCostMinor, resolution } }, { new: true, session });
      if (!x) throw ApiError.conflict('Only requests in progress can be completed', 'INVALID_STATE_TRANSITION');
      let next;
      if (x.equipmentId) {
        const eq = await Equipment.findById(x.equipmentId).session(session);
        next = eq.maintenanceIntervalDays ? new Date(now.getTime() + eq.maintenanceIntervalDays * 86_400_000) : eq.nextMaintenanceAt;
        const stillOpen = await MaintenanceRequest.exists({ equipmentId: eq._id, status: { $in: OPEN }, _id: { $ne: x._id } }).session(session);
        await Equipment.updateOne({ _id: eq._id, status: { $in: [E.IN_MAINTENANCE, E.DAMAGED] } }, { $set: { ...(stillOpen ? {} : { status: E.ACTIVE }), lastMaintenanceAt: now, nextMaintenanceAt: next } }, { session });
      }
      await MaintenanceHistory.create([{ equipmentId: x.equipmentId, facilityId: x.facilityId, roomId: x.roomId, maintenanceRequestId: x._id, maintenanceType: x.type, description: resolution ?? x.title, costMinor: actualCostMinor, performedBy: x.assignedStaffId ?? caller.user._id, maintenanceDate: now, nextMaintenanceDate: next }], { session });
      await availabilityService.unblock(x._id, { session });
      return x;
    });
    await auditService.log(caller.user, ctx, 'MAINTENANCE_COMPLETED', 'MaintenanceRequest', id, { after: { actualCostMinor } });
    return u.toJSON();
  },

  async cancel(caller, id, ctx) {
    const r = await load(caller, id);
    const reporterWhilePending = same(r.reportedBy, caller.user._id) && r.status === S.PENDING;
    if (!manage(caller) && !reporterWhilePending) throw ApiError.forbidden();
    const u = await withTransaction(async (session) => {
      const x = await MaintenanceRequest.findOneAndUpdate({ _id: id, status: { $in: OPEN } }, { $set: { status: S.CANCELLED } }, { new: true, session });
      if (!x) throw ApiError.conflict('Only open requests can be cancelled', 'INVALID_STATE_TRANSITION');
      if (x.equipmentId && !(await MaintenanceRequest.exists({ equipmentId: x.equipmentId, status: { $in: OPEN } }).session(session))) await Equipment.updateOne({ _id: x.equipmentId, status: { $in: [E.DAMAGED, E.IN_MAINTENANCE] } }, { $set: { status: E.ACTIVE } }, { session });
      await availabilityService.unblock(x._id, { session });
      return x;
    });
    await auditService.log(caller.user, ctx, 'MAINTENANCE_CANCELLED', 'MaintenanceRequest', id, {});
    return u.toJSON();
  },

  // ---------------- jobs ----------------
  async _recipients(facilityId) {
    const fac = facilityId && (await Facility.findById(facilityId));
    return fac?.managerId ? [fac.managerId] : User.find({ role: ROLES.ADMIN, status: 'ACTIVE', deletedAt: null }).distinct('_id');
  },
  /** Equipment due within a week gets a preventive request (once) and its manager is told. */
  async schedulePreventive(now = new Date()) {
    const due = await Equipment.find({ deletedAt: null, status: E.ACTIVE, nextMaintenanceAt: { $lte: new Date(now.getTime() + 7 * 86_400_000) } }).limit(200);
    let n = 0;
    for (const eq of due) {
      if (await MaintenanceRequest.exists({ equipmentId: eq._id, type: 'PREVENTIVE', status: { $in: OPEN } })) continue;
      const [owner] = await this._recipients(eq.facilityId);
      if (!owner) continue;
      await MaintenanceRequest.create({ requestCode: await counterService.formatted('maintenance', 'MNT', 6), type: 'PREVENTIVE', equipmentId: eq._id, facilityId: eq.facilityId, title: `Scheduled maintenance: ${eq.name}`, priority: 'MEDIUM', scheduledFor: eq.nextMaintenanceAt, reportedBy: owner });
      n += 1;
    }
    return n;
  },
  /** Daily reminders: upcoming and overdue maintenance (one notification per equipment per day/date). */
  async notifyDue(now = new Date()) {
    const eqs = await Equipment.find({ deletedAt: null, status: { $ne: E.RETIRED }, nextMaintenanceAt: { $lte: new Date(now.getTime() + 7 * 86_400_000) } }).limit(500);
    let n = 0;
    for (const eq of eqs) {
      const overdue = eq.nextMaintenanceAt < now;
      n += await inAppNotifications.notify(await this._recipients(eq.facilityId), { type: overdue ? 'MAINTENANCE_OVERDUE' : 'MAINTENANCE_UPCOMING', title: `${overdue ? 'Overdue' : 'Upcoming'} maintenance: ${eq.name}`, body: eq.nextMaintenanceAt.toISOString().slice(0, 10), refType: 'Equipment', refId: eq._id, dedupeKey: `${overdue ? 'overdue' : 'upcoming'}:${eq._id}:${overdue ? now.toISOString().slice(0, 10) : eq.nextMaintenanceAt.toISOString().slice(0, 10)}` });
    }
    return n;
  },
};
