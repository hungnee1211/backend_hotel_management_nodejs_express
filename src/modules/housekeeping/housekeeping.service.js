import mongoose from 'mongoose';
import HousekeepingTask from '../../models/HousekeepingTask.js';
import Room from '../../models/Room.js';
import RoomType from '../../models/RoomType.js';
import StaffProfile from '../../models/StaffProfile.js';
import User from '../../models/User.js';
import { HK_TASK_STATUS as T, HOUSEKEEPING_STATUS as H, ROLES, ROOM_STATUS } from '../../constants/index.js';
import { PERMISSIONS as P, effectivePermissions } from '../../constants/permissions.js';
import { ApiError } from '../../utils/ApiError.js';
import { toLocalDateKey } from '../../utils/dates.js';
import { buildPageMeta, parsePagination } from '../../utils/pagination.js';
import { auditService } from '../audit-logs/audit.service.js';
import { availabilityService } from '../availability/availability.service.js';
import { settingsService } from '../settings/settings.service.js';

const same = (a, b) => String(a) === String(b);
const OPEN = [T.PENDING, T.ASSIGNED, T.IN_PROGRESS, T.COMPLETED];

const loadTask = async (id) => { const t = mongoose.isValidObjectId(id) ? await HousekeepingTask.findById(id) : null; if (!t) throw ApiError.notFound('Task not found', 'TASK_NOT_FOUND'); return t; };
/** Housekeeping staff see only their own tasks; people who can assign see everything. */
const assertVisible = (caller, t) => { if (!caller.permissions.has(P.HOUSEKEEPING_ASSIGN) && !(t.assignedStaffId && same(t.assignedStaffId, caller.user._id))) throw ApiError.notFound('Task not found', 'TASK_NOT_FOUND'); };

export const housekeepingService = {
  /**
   * A room returns to inventory only when it is clean (and inspected, if the hotel requires it), has no
   * unfinished tasks, and is not blocked. Finishing the cleaning alone is not enough.
   */
  async releaseRoomIfReady(roomId, { session } = {}) {
    const room = await Room.findById(roomId).session(session ?? null);
    if (!room || room.status !== ROOM_STATUS.CLEANING) return false;
    const settings = await settingsService.get({ session });
    const ready = settings.housekeeping.requireInspection ? room.housekeepingStatus === H.INSPECTED : [H.CLEAN, H.INSPECTED].includes(room.housekeepingStatus);
    if (!ready || (await HousekeepingTask.exists({ roomId, status: { $in: OPEN } }).session(session ?? null))) return false;
    if (await availabilityService.hasBlockOn(roomId, toLocalDateKey(new Date(), settings.timezone))) return false;
    await Room.updateOne({ _id: roomId, status: ROOM_STATUS.CLEANING }, { $set: { status: ROOM_STATUS.AVAILABLE } }, { session });
    return true;
  },

  /** Called by check-out inside its transaction. */
  async createCheckoutTasks(booking, { session }) {
    await HousekeepingTask.create(booking.rooms.map((r) => ({ roomId: r.roomId, bookingId: booking._id, taskType: 'CHECKOUT_CLEAN', priority: 'HIGH', status: T.PENDING })), { session, ordered: true });
  },

  async create(caller, { roomId, taskType = 'DAILY_CLEAN', priority = 'MEDIUM', assignedStaffId, notes }, ctx) {
    const room = await Room.findOne({ _id: roomId, deletedAt: null });
    if (!room) throw ApiError.notFound('Room not found', 'ROOM_NOT_FOUND');
    if (assignedStaffId) await this._assertAssignable(caller, assignedStaffId);
    const task = await HousekeepingTask.create({ roomId, taskType, priority, notes, createdBy: caller.user._id, assignedStaffId: assignedStaffId ?? null, status: assignedStaffId ? T.ASSIGNED : T.PENDING });
    if (['CHECKOUT_CLEAN', 'DEEP_CLEAN'].includes(taskType) && room.housekeepingStatus !== H.CLEANING) await Room.updateOne({ _id: roomId }, { $set: { housekeepingStatus: H.DIRTY } });
    await auditService.log(caller.user, ctx, 'HK_TASK_CREATED', 'HousekeepingTask', task._id, { after: task });
    return task.toJSON();
  },

  /** The assignee must be an active staff member who can do housekeeping and, for a Manager, report to them. */
  async _assertAssignable(caller, staffId) {
    const user = await User.findOne({ _id: staffId, deletedAt: null, status: 'ACTIVE', role: ROLES.STAFF });
    const profile = user && (await StaffProfile.findOne({ userId: staffId }));
    if (!profile || !effectivePermissions({ role: ROLES.STAFF, staffProfile: profile }).has(P.HOUSEKEEPING_UPDATE)) throw ApiError.unprocessable('Not an active housekeeping staff member', [{ field: 'body.staffId', message: 'invalid' }], 'INVALID_ASSIGNEE');
    if (caller.user.role === ROLES.MANAGER && !same(profile.managerId, caller.user._id)) throw ApiError.unprocessable('That staff member is not on your team', [{ field: 'body.staffId', message: 'not your team' }], 'INVALID_ASSIGNEE');
  },

  async list(caller, q) {
    const filter = caller.permissions.has(P.HOUSEKEEPING_ASSIGN) ? {} : { assignedStaffId: caller.user._id };
    for (const k of ['status', 'roomId', 'priority', 'assignedStaffId']) if (q[k] && (caller.permissions.has(P.HOUSEKEEPING_ASSIGN) || k !== 'assignedStaffId')) filter[k] = q[k];
    const paging = parsePagination(q, { allowedSort: ['createdAt', 'priority', 'completedAt'], defaultSort: 'createdAt' });
    const [items, total] = await Promise.all([HousekeepingTask.find(filter).sort(paging.sort).skip(paging.skip).limit(paging.limit), HousekeepingTask.countDocuments(filter)]);
    return { items: items.map((t) => t.toJSON()), meta: buildPageMeta({ ...paging, total }) };
  },

  /** Rooms that are not guest-ready (the "rooms requiring cleaning" board). */
  async roomsNeedingCleaning(q) {
    const filter = { deletedAt: null, isActive: true, housekeepingStatus: q.housekeepingStatus ? q.housekeepingStatus : { $ne: H.INSPECTED } };
    const paging = parsePagination(q, { allowedSort: ['roomNumber', 'floor'], defaultSort: 'roomNumber', defaultLimit: 50 });
    const [rooms, total] = await Promise.all([Room.find(filter).sort(paging.sort).skip(paging.skip).limit(paging.limit).lean(), Room.countDocuments(filter)]);
    const types = new Map((await RoomType.find({ _id: { $in: rooms.map((r) => r.roomTypeId) } }).select('name').lean()).map((t) => [String(t._id), t.name]));
    return { items: rooms.map((r) => ({ id: String(r._id), roomNumber: r.roomNumber, floor: r.floor, roomType: types.get(String(r.roomTypeId)), status: r.status, housekeepingStatus: r.housekeepingStatus })), meta: buildPageMeta({ ...paging, total }) };
  },

  async get(caller, id) { const t = await loadTask(id); assertVisible(caller, t); return t.toJSON(); },

  async assign(caller, id, staffId, ctx) {
    const t = await loadTask(id);
    if (![T.PENDING, T.ASSIGNED].includes(t.status)) throw ApiError.conflict('Only pending or assigned tasks can be (re)assigned', 'INVALID_STATE_TRANSITION');
    await this._assertAssignable(caller, staffId);
    const u = await HousekeepingTask.findOneAndUpdate({ _id: id, status: { $in: [T.PENDING, T.ASSIGNED] } }, { $set: { assignedStaffId: staffId, status: T.ASSIGNED } }, { new: true });
    await auditService.log(caller.user, ctx, 'HK_TASK_ASSIGNED', 'HousekeepingTask', id, { after: { assignedStaffId: staffId } });
    return u.toJSON();
  },

  async start(caller, id, ctx) {
    const t = await loadTask(id);
    const isAssignee = t.assignedStaffId && same(t.assignedStaffId, caller.user._id);
    if (!isAssignee && !(t.status === T.PENDING && !t.assignedStaffId && caller.permissions.has(P.HOUSEKEEPING_UPDATE)) && !caller.permissions.has(P.HOUSEKEEPING_ASSIGN)) throw ApiError.notFound('Task not found', 'TASK_NOT_FOUND');
    const u = await HousekeepingTask.findOneAndUpdate({ _id: id, status: { $in: [T.PENDING, T.ASSIGNED] } }, { $set: { status: T.IN_PROGRESS, startedAt: new Date(), assignedStaffId: t.assignedStaffId ?? caller.user._id } }, { new: true });
    if (!u) throw ApiError.conflict('The task cannot be started in its current state', 'INVALID_STATE_TRANSITION');
    await Room.updateOne({ _id: u.roomId }, { $set: { housekeepingStatus: H.CLEANING } });
    await auditService.log(caller.user, ctx, 'HK_TASK_STARTED', 'HousekeepingTask', id, {});
    return u.toJSON();
  },

  async complete(caller, id, { notes } = {}, ctx) {
    const t = await loadTask(id);
    if (!(t.assignedStaffId && same(t.assignedStaffId, caller.user._id)) && !caller.permissions.has(P.HOUSEKEEPING_ASSIGN)) throw ApiError.notFound('Task not found', 'TASK_NOT_FOUND');
    const u = await HousekeepingTask.findOneAndUpdate({ _id: id, status: T.IN_PROGRESS }, { $set: { status: T.COMPLETED, completedAt: new Date(), ...(notes ? { notes } : {}) } }, { new: true });
    if (!u) throw ApiError.conflict('Only tasks in progress can be completed', 'INVALID_STATE_TRANSITION');
    const settings = await settingsService.get();
    await Room.updateOne({ _id: u.roomId }, { $set: { housekeepingStatus: settings.housekeeping.requireInspection ? H.CLEAN : H.INSPECTED } });
    if (!settings.housekeeping.requireInspection) { await HousekeepingTask.updateOne({ _id: id }, { $set: { status: T.INSPECTED } }); u.status = T.INSPECTED; }
    await this.releaseRoomIfReady(u.roomId);
    await auditService.log(caller.user, ctx, 'HK_TASK_COMPLETED', 'HousekeepingTask', id, {});
    return u.toJSON();
  },

  /** Quality check by someone other than the cleaner. Failing sends the task back for re-cleaning. */
  async inspect(caller, id, { passed, notes }, ctx) {
    const t = await loadTask(id);
    if (t.assignedStaffId && same(t.assignedStaffId, caller.user._id)) throw ApiError.forbidden('You cannot inspect your own work', 'SELF_INSPECTION');
    const set = passed ? { status: T.INSPECTED, inspectedBy: caller.user._id, inspectedAt: new Date(), inspectionPassed: true } : { status: T.ASSIGNED, inspectionPassed: false, inspectedBy: caller.user._id, inspectedAt: new Date() };
    const u = await HousekeepingTask.findOneAndUpdate({ _id: id, status: T.COMPLETED }, { $set: { ...set, ...(notes ? { notes } : {}) } }, { new: true });
    if (!u) throw ApiError.conflict('Only completed tasks can be inspected', 'INVALID_STATE_TRANSITION');
    await Room.updateOne({ _id: u.roomId }, { $set: { housekeepingStatus: passed ? H.INSPECTED : H.DIRTY } });
    if (passed) await this.releaseRoomIfReady(u.roomId);
    await auditService.log(caller.user, ctx, 'HK_TASK_INSPECTED', 'HousekeepingTask', id, { after: { passed } });
    return u.toJSON();
  },

  async reportDamage(caller, id, { description, createMaintenance = false }, ctx) {
    const t = await loadTask(id);
    assertVisible(caller, t);
    let maintenanceRequestId;
    if (createMaintenance) {
      const { maintenanceService } = await import('../maintenance/maintenance.service.js'); // lazy: avoids a module cycle
      maintenanceRequestId = (await maintenanceService.create(caller, { roomId: t.roomId, title: `Room damage: ${description.slice(0, 60)}`, description, priority: 'HIGH' }, ctx)).id;
    }
    t.damageReports.push({ description, reportedBy: caller.user._id, at: new Date(), maintenanceRequestId });
    await t.save();
    await auditService.log(caller.user, ctx, 'HK_DAMAGE_REPORTED', 'HousekeepingTask', id, { after: { description } });
    return t.toJSON();
  },
};
