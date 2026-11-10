import { ApiError } from '../../utils/ApiError.js';
import { nightKeys, toLocalDateKey, isValidDateKey, addDaysToKey } from '../../utils/dates.js';
import { settingsService } from '../settings/settings.service.js';
import { availabilityRepository as repo } from './availability.repository.js';
import { quoteNights, sumNights } from './pricing.js';

/** Validates a stay request against hotel settings and returns { nights, settings }. */
export const resolveStay = async (checkIn, checkOut, { allowPast = false } = {}) => {
  const settings = await settingsService.get();
  if (!isValidDateKey(checkIn) || !isValidDateKey(checkOut)) throw ApiError.unprocessable('Dates must be YYYY-MM-DD', [{ field: 'query.checkIn', message: 'invalid date' }]);
  if (checkOut <= checkIn) throw ApiError.unprocessable('Check-out must be after check-in', [{ field: 'checkOutDate', message: 'must be after check-in' }], 'INVALID_DATES');
  const today = toLocalDateKey(new Date(), settings.timezone);
  if (!allowPast && checkIn < today) throw ApiError.unprocessable('Check-in cannot be in the past', [{ field: 'checkInDate', message: 'in the past' }], 'INVALID_DATES');
  const nights = nightKeys(checkIn, checkOut);
  if (nights.length > settings.reservation.maxNightsPerBooking) throw ApiError.unprocessable(`A booking can span at most ${settings.reservation.maxNightsPerBooking} nights`, [], 'STAY_TOO_LONG');
  if (checkIn > addDaysToKey(today, settings.reservation.maxAdvanceBookingDays)) throw ApiError.unprocessable('Check-in is too far in the future', [], 'TOO_FAR_AHEAD');
  return { nights, settings, today };
};

export const availabilityService = {
  /** Rooms free for EVERY night of the stay that fit the party, with a per-night price quote. */
  async search({ checkIn, checkOut, adults = 1, children = 0, roomTypeId, minPrice, maxPrice, amenities = [], limit = 100 }) {
    const { nights } = await resolveStay(checkIn, checkOut);
    const guests = adults + children;
    const types = await repo.activeRoomTypes({ capacity: { $gte: guests }, ...(roomTypeId ? { _id: roomTypeId } : {}) });
    const typeById = new Map(types.map((t) => [String(t._id), t]));
    const busy = await repo.busyRoomIds(nights);
    const rooms = await repo.candidateRooms({ roomTypeId: { $in: types.map((t) => t._id) }, _id: { $nin: busy } });

    const results = [];
    for (const room of rooms) {
      const type = typeById.get(String(room.roomTypeId));
      const have = new Set([...(type.amenities ?? []), ...(room.amenities ?? [])].map((a) => a.toLowerCase()));
      if (!amenities.every((a) => have.has(a.toLowerCase()))) continue;
      const nightly = quoteNights(type, nights);
      const totalMinor = sumNights(nightly);
      const averageNightlyMinor = Math.round(totalMinor / nights.length);
      if (minPrice !== undefined && averageNightlyMinor < minPrice) continue;
      if (maxPrice !== undefined && averageNightlyMinor > maxPrice) continue;
      results.push({
        room: { id: String(room._id), roomNumber: room.roomNumber, floor: room.floor, amenities: [...have] },
        roomType: { id: String(type._id), name: type.name, capacity: type.capacity, bedConfiguration: type.bedConfiguration, images: type.images },
        nights: nights.length, nightly, totalMinor, averageNightlyMinor,
      });
      if (results.length >= limit) break;
    }
    return { checkIn, checkOut, nights: nights.length, items: results };
  },

  /** Claims every (room, night) in one transaction. The unique index rejects any overlap. */
  async acquire({ roomIds, nights, bookingId, state, holdExpiresAt = null }, { session }) {
    const rows = roomIds.flatMap((roomId) => nights.map((date) => ({ roomId, date, state, bookingId, holdExpiresAt })));
    try {
      await repo.insertNights(rows, { session });
    } catch (err) {
      if (err?.code === 11000 || err?.writeErrors?.some?.((e) => e.code === 11000)) {
        throw new ApiError(409, 'One or more rooms are no longer available for these dates', 'ROOM_UNAVAILABLE');
      }
      throw err;
    }
  },

  /** Frees expired holds BEFORE a booking transaction (a duplicate-key error inside a transaction aborts it). */
  purgeExpired: (roomIds, nights) => repo.purgeExpiredHolds(roomIds, nights),
  release: (bookingId, opts) => repo.deleteByBooking(bookingId, opts),
  releaseKeys: (bookingId, keys, opts) => repo.deleteByBookingAndKeys(bookingId, keys, opts),
  confirm: (bookingId, opts) => repo.confirmByBooking(bookingId, opts),

  /** Takes a room out of inventory for [from, to) (maintenance). Refuses if guests are booked in that window. */
  async block({ roomId, from, to, blockRef, reason }, { session } = {}) {
    const nights = nightKeys(from, to);
    const conflicts = await repo.conflictsFor(roomId, nights);
    if (conflicts.length) {
      throw new ApiError(409, 'The room has bookings or holds in that period', 'ROOM_HAS_BOOKINGS', conflicts.map((c) => ({ field: 'dates', message: `${c.date} is ${c.state}` })));
    }
    await repo.insertNights(nights.map((date) => ({ roomId, date, state: 'BLOCKED', blockRef, reason })), { session });
  },
  unblock: (blockRef, opts) => repo.deleteByBlock(blockRef, opts),
  hasBlockOn: (roomId, dateKey) => repo.hasBlockOn(roomId, dateKey),
  hasFutureCommitments: (roomId, fromKey) => repo.futureCommitments(roomId, fromKey),
};
