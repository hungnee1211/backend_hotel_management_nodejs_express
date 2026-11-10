import Booking from '../../models/Booking.js';
import HousekeepingTask from '../../models/HousekeepingTask.js';
import MaintenanceRequest from '../../models/MaintenanceRequest.js';
import Room from '../../models/Room.js';
import RoomType from '../../models/RoomType.js';
import AuditLog from '../../models/AuditLog.js';
import { PERMISSIONS as P } from '../../constants/permissions.js';
import { HOUSEKEEPING_STATUS, ROOM_STATUS } from '../../constants/index.js';
import { ApiError } from '../../utils/ApiError.js';
import { toLocalDateKey } from '../../utils/dates.js';
import { buildPageMeta, escapeRegex, parsePagination } from '../../utils/pagination.js';
import { auditService } from '../audit-logs/audit.service.js';
import { availabilityService } from '../availability/availability.service.js';
import { settingsService } from '../settings/settings.service.js';

const isStaffView = (caller) => caller.permissions.has(P.ROOM_MANAGE) || caller.permissions.has(P.HOUSEKEEPING_READ);
const present = (room, type, caller) => {
  const base = { id: String(room._id), roomNumber: room.roomNumber, floor: room.floor, amenities: room.amenities, roomType: type && { id: String(type._id), name: type.name, capacity: type.capacity, basePriceMinor: type.basePriceMinor, amenities: type.amenities, images: type.images } };
  // Guests only see what helps them choose; operational state is for staff.
  return isStaffView(caller) ? { ...base, status: room.status, housekeepingStatus: room.housekeepingStatus, notes: room.notes, isActive: room.isActive, createdAt: room.createdAt } : base;
};
const todayKey = async () => toLocalDateKey(new Date(), (await settingsService.get()).timezone);
const load = async (id) => { const r = await Room.findOne({ _id: id, deletedAt: null }); if (!r) throw ApiError.notFound('Room not found', 'ROOM_NOT_FOUND'); return r; };
const assertType = async (id) => { const t = await RoomType.findById(id); if (!t || t.status !== 'ACTIVE') throw ApiError.unprocessable('roomTypeId must reference an active room type', [{ field: 'body.roomTypeId', message: 'invalid' }]); return t; };

/** Commitments that make removing or closing a room unsafe. */
const blockers = async (roomId) => {
  const out = [];
  if (await availabilityService.hasFutureCommitments(roomId, await todayKey())) out.push('upcoming bookings');
  if (await HousekeepingTask.exists({ roomId, status: { $in: ['PENDING', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED'] } })) out.push('unfinished housekeeping tasks');
  if (await MaintenanceRequest.exists({ roomId, status: { $in: ['PENDING', 'ASSIGNED', 'IN_PROGRESS'] } })) out.push('open maintenance requests');
  return out;
};

export const roomService = {
  async list(caller, query) {
    const paging = parsePagination(query, { allowedSort: ['roomNumber', 'floor', 'createdAt'], defaultSort: 'roomNumber', defaultLimit: 50 });
    const filter = { deletedAt: null };
    if (!isStaffView(caller)) { filter.isActive = true; filter.status = { $nin: [ROOM_STATUS.OUT_OF_SERVICE] }; }
    for (const k of ['floor', 'status', 'housekeepingStatus']) if (query[k] !== undefined && isStaffView(caller)) filter[k] = query[k];
    if (query.floor !== undefined) filter.floor = query.floor;
    if (query.search) { const rx = new RegExp(escapeRegex(query.search), 'i'); filter.$or = [{ roomNumber: rx }, { notes: rx }]; }

    const typeFilter = {};
    if (query.roomTypeId) typeFilter._id = query.roomTypeId;
    if (query.capacity) typeFilter.capacity = { $gte: query.capacity };
    if (query.minPrice !== undefined || query.maxPrice !== undefined) typeFilter.basePriceMinor = { ...(query.minPrice !== undefined && { $gte: query.minPrice }), ...(query.maxPrice !== undefined && { $lte: query.maxPrice }) };
    if (!isStaffView(caller)) typeFilter.status = 'ACTIVE';
    let types = await RoomType.find(typeFilter).lean();
    const and = [];
    for (const a of query.amenities ?? []) {
      const rx = new RegExp(`^${escapeRegex(a)}$`, 'i');
      and.push({ $or: [{ amenities: rx }, { roomTypeId: { $in: types.filter((t) => t.amenities.some((x) => rx.test(x))).map((t) => t._id) } }] });
    }
    filter.roomTypeId = { $in: types.map((t) => t._id) };
    if (and.length) filter.$and = and;

    const [rooms, total] = await Promise.all([Room.find(filter).sort(paging.sort).skip(paging.skip).limit(paging.limit).lean(), Room.countDocuments(filter)]);
    const byId = new Map(types.map((t) => [String(t._id), t]));
    const missing = rooms.filter((r) => !byId.has(String(r.roomTypeId)));
    if (missing.length) types = types.concat(await RoomType.find({ _id: { $in: missing.map((r) => r.roomTypeId) } }).lean()), types.forEach((t) => byId.set(String(t._id), t));
    return { items: rooms.map((r) => present(r, byId.get(String(r.roomTypeId)), caller)), meta: buildPageMeta({ ...paging, total }) };
  },

  async get(caller, id) {
    const room = await load(id);
    if (!isStaffView(caller) && (!room.isActive || room.status === ROOM_STATUS.OUT_OF_SERVICE)) throw ApiError.notFound('Room not found', 'ROOM_NOT_FOUND');
    return present(room, await RoomType.findById(room.roomTypeId).lean(), caller);
  },

  async create(caller, data, ctx) {
    await assertType(data.roomTypeId);
    const room = await Room.create(data); // unique roomNumber -> 409 via the error handler
    await auditService.log(caller.user, ctx, 'ROOM_CREATED', 'Room', room._id, { after: room });
    return present(room, await RoomType.findById(room.roomTypeId).lean(), caller);
  },

  async update(caller, id, patch, ctx) {
    const before = await load(id);
    if (patch.roomTypeId && String(patch.roomTypeId) !== String(before.roomTypeId)) {
      await assertType(patch.roomTypeId);
      if (await availabilityService.hasFutureCommitments(id, await todayKey())) throw ApiError.conflict('This room has upcoming bookings; its type cannot change', 'ROOM_IN_USE');
    }
    const after = await Room.findByIdAndUpdate(id, { $set: patch }, { new: true, runValidators: true });
    await auditService.log(caller.user, ctx, 'ROOM_UPDATED', 'Room', id, { before, after });
    return present(after, await RoomType.findById(after.roomTypeId).lean(), caller);
  },

  /** Manual operational status. OCCUPIED and CLEANING are set only by check-in/out and housekeeping. */
  async setStatus(caller, id, { status, reason }, ctx) {
    const room = await load(id);
    if (room.status === ROOM_STATUS.OCCUPIED) throw ApiError.conflict('The room is occupied by a guest', 'ROOM_OCCUPIED');
    if (status !== ROOM_STATUS.AVAILABLE) {
      const b = await blockers(id);
      if (b.length) throw ApiError.conflict(`Cannot take the room out of service: it has ${b.join(', ')}`, 'ROOM_IN_USE');
    } else if (![HOUSEKEEPING_STATUS.INSPECTED, HOUSEKEEPING_STATUS.CLEAN].includes(room.housekeepingStatus)) {
      throw ApiError.conflict('The room has not been cleaned yet', 'ROOM_NOT_READY');
    }
    const after = await Room.findByIdAndUpdate(id, { $set: { status } }, { new: true });
    await auditService.log(caller.user, ctx, 'ROOM_STATUS_CHANGED', 'Room', id, { before: { status: room.status }, after: { status, reason } });
    return present(after, await RoomType.findById(after.roomTypeId).lean(), caller);
  },

  /** Rooms with history are deactivated (soft-deleted), never destroyed. */
  async remove(caller, id, ctx) {
    const room = await load(id);
    const b = await blockers(id);
    if (b.length) throw ApiError.conflict(`Cannot remove the room: it has ${b.join(', ')}`, 'ROOM_IN_USE');
    await Room.updateOne({ _id: id }, { $set: { deletedAt: new Date(), isActive: false } });
    await auditService.log(caller.user, ctx, 'ROOM_DELETED', 'Room', id, { before: room });
  },

  async history(id) {
    await load(id);
    const [bookings, tasks, audit] = await Promise.all([
      Booking.find({ 'rooms.roomId': id }).sort({ checkInDate: -1 }).limit(100).select('bookingCode status checkInDate checkOutDate customerId').lean(),
      HousekeepingTask.find({ roomId: id }).sort({ createdAt: -1 }).limit(50).select('taskType status completedAt inspectedAt').lean(),
      AuditLog.find({ resourceType: 'Room', resourceId: id }).sort({ createdAt: -1 }).limit(50).select('action actorId createdAt before after').lean(),
    ]);
    return { bookings, housekeepingTasks: tasks, audit };
  },

  async availability(query) {
    return availabilityService.search({ ...query, adults: query.adults, children: query.children });
  },
};
