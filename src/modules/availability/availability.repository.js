import Room from '../../models/Room.js';
import RoomNight from '../../models/RoomNight.js';
import RoomType from '../../models/RoomType.js';

const live = (now = new Date()) => ({ $or: [{ state: { $ne: 'HELD' } }, { holdExpiresAt: { $gt: now } }] });

export const availabilityRepository = {
  /** Rooms that have ANY non-expired claim on any of these nights. */
  busyRoomIds: (nights, now = new Date()) => RoomNight.distinct('roomId', { date: { $in: nights }, ...live(now) }),
  candidateRooms: (filter) => Room.find({ isActive: true, deletedAt: null, status: { $nin: ['OUT_OF_SERVICE', 'MAINTENANCE'] }, ...filter }).sort({ roomNumber: 1 }).lean(),
  activeRoomTypes: (filter = {}) => RoomType.find({ status: 'ACTIVE', ...filter }).lean(),
  purgeExpiredHolds: (roomIds, nights, now = new Date()) =>
    RoomNight.deleteMany({ roomId: { $in: roomIds }, date: { $in: nights }, state: 'HELD', holdExpiresAt: { $lte: now } }),
  insertNights: (rows, { session }) => RoomNight.insertMany(rows, { session, ordered: true }),
  deleteByBooking: (bookingId, { session, fromDate } = {}) =>
    RoomNight.deleteMany({ bookingId, ...(fromDate ? { date: { $gte: fromDate } } : {}) }, { session }),
  deleteByBookingAndKeys: (bookingId, keys, { session }) =>
    Promise.all(keys.map(({ roomId, date }) => RoomNight.deleteOne({ bookingId, roomId, date }, { session }))),
  confirmByBooking: (bookingId, { session }) =>
    RoomNight.updateMany({ bookingId, state: 'HELD' }, { $set: { state: 'SOLD', holdExpiresAt: null } }, { session }),
  conflictsFor: (roomId, nights, now = new Date()) => RoomNight.find({ roomId, date: { $in: nights }, ...live(now) }).lean(),
  deleteByBlock: (blockRef, { session } = {}) => RoomNight.deleteMany({ blockRef }, { session }),
  countSoldBetween: (fromKey, toKeyExclusive) => RoomNight.countDocuments({ state: 'SOLD', date: { $gte: fromKey, $lt: toKeyExclusive } }),
  countBlockedBetween: (fromKey, toKeyExclusive) => RoomNight.countDocuments({ state: 'BLOCKED', date: { $gte: fromKey, $lt: toKeyExclusive } }),
  hasBlockOn: (roomId, dateKey) => RoomNight.exists({ roomId, date: dateKey, state: 'BLOCKED' }),
  futureCommitments: (roomId, fromKey, now = new Date()) => RoomNight.exists({ roomId, date: { $gte: fromKey }, state: { $in: ['SOLD', 'HELD'] }, ...live(now) }),
  roomHistoryNights: (roomId) => RoomNight.find({ roomId, bookingId: { $ne: null } }).distinct('bookingId'),
};
