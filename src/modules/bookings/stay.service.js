import Booking from '../../models/Booking.js';
import Guest from '../../models/Guest.js';
import Room from '../../models/Room.js';
import RoomType from '../../models/RoomType.js';
import { BOOKING_STATUS as S, CHARGE_CATEGORIES, HOUSEKEEPING_STATUS as H, ROOM_STATUS } from '../../constants/index.js';
import { PERMISSIONS as P } from '../../constants/permissions.js';
import { ApiError } from '../../utils/ApiError.js';
import { addDaysToKey, nightKeys, startOfLocalDay, toLocalDateKey } from '../../utils/dates.js';
import { withTransaction } from '../../utils/transaction.js';
import { auditService } from '../audit-logs/audit.service.js';
import { availabilityService, resolveStay } from '../availability/availability.service.js';
import { quoteNights, sumNights } from '../availability/pricing.js';
import { billingService } from '../billing/billing.service.js';
import { housekeepingService } from '../housekeeping/housekeeping.service.js';
import { invoiceService } from '../invoices/invoice.service.js';
import { settingsService } from '../settings/settings.service.js';
import { bookingService, transition } from './booking.service.js';

const load = async (id) => { const b = await Booking.findById(id); if (!b) throw ApiError.notFound('Booking not found', 'BOOKING_NOT_FOUND'); return b; };
const readyForGuest = (room, requireInspection) => room.status === ROOM_STATUS.AVAILABLE && (requireInspection ? room.housekeepingStatus === H.INSPECTED : [H.CLEAN, H.INSPECTED].includes(room.housekeepingStatus));

export const stayService = {
  async checkIn(caller, id, ctx) {
    const b = await load(id);
    if (b.status !== S.CONFIRMED) throw ApiError.conflict(`A ${b.status} booking cannot be checked in`, 'INVALID_STATE_TRANSITION');
    const settings = await settingsService.get();
    const today = toLocalDateKey(new Date(), settings.timezone);
    if (today < b.checkInDate) throw ApiError.conflict(`Check-in opens on ${b.checkInDate}`, 'TOO_EARLY');
    if (today >= b.checkOutDate) throw ApiError.conflict('This stay has already ended', 'STAY_OVER');

    if (!b.guestIds.length) throw ApiError.unprocessable('Add guest details before check-in', [{ field: 'guestIds', message: 'required' }], 'GUEST_REQUIRED');
    const primary = await Guest.findOne({ _id: b.guestIds[0], deletedAt: null }).select('identification.type fullName');
    if (!primary?.identification?.type) throw ApiError.unprocessable('The primary guest needs an identification document on file', [{ field: 'guestIds[0]', message: 'identification missing' }], 'GUEST_ID_REQUIRED');

    const rooms = await Room.find({ _id: { $in: b.rooms.map((r) => r.roomId) } });
    const notReady = rooms.filter((r) => !readyForGuest(r, settings.housekeeping.requireInspection));
    if (notReady.length) throw ApiError.conflict(`Not ready: ${notReady.map((r) => `${r.roomNumber} (${r.status}/${r.housekeepingStatus})`).join(', ')}`, 'ROOM_NOT_READY');

    const account = await billingService.getByBooking(id);
    const deposit = b.priceSnapshot?.depositRequiredMinor ?? 0;
    if (account.paidMinor < deposit) throw ApiError.conflict(`A deposit of ${deposit} is required before check-in`, 'DEPOSIT_REQUIRED');

    const out = await withTransaction(async (session) => {
      const u = await transition(id, S.CONFIRMED, S.CHECKED_IN, { by: caller.user._id, set: { actualCheckInAt: new Date(), checkedInBy: caller.user._id } }, { session });
      const r = await Room.updateMany({ _id: { $in: rooms.map((x) => x._id) }, status: ROOM_STATUS.AVAILABLE }, { $set: { status: ROOM_STATUS.OCCUPIED } }, { session });
      if (r.modifiedCount !== rooms.length) throw ApiError.conflict('A room is no longer available', 'ROOM_NOT_READY');
      return u;
    });
    await auditService.log(caller.user, ctx, 'BOOKING_CHECKED_IN', 'Booking', id, {});
    return out.toJSON();
  },

  /**
   * One transaction: lock the bill into an issued invoice, check the balance, move the booking to CHECKED_OUT,
   * send the rooms to housekeeping, and release unused nights. Any failure rolls everything back.
   */
  async checkOut(caller, id, { authorizeOutstanding = false, reason } = {}, ctx) {
    const b = await load(id);
    if (b.status !== S.CHECKED_IN) throw ApiError.conflict(`A ${b.status} booking cannot be checked out`, 'INVALID_STATE_TRANSITION');
    const settings = await settingsService.get();
    if (authorizeOutstanding && !caller.permissions.has(P.BOOKING_MANAGE)) throw ApiError.forbidden('Only a manager can authorise check-out with an unpaid balance');
    const today = toLocalDateKey(new Date(), settings.timezone);
    const invoiceNumber = await invoiceService.prepareNumber();

    const { booking, invoice } = await withTransaction(async (session) => {
      const u = await transition(id, S.CHECKED_IN, S.CHECKED_OUT, { by: caller.user._id, set: { actualCheckOutAt: new Date(), checkedOutBy: caller.user._id } }, { session });
      const account = await billingService.getByBooking(id, { session });
      const inv = await invoiceService.issueForAccount(account._id, caller.user._id, { session, invoiceNumber });
      if (inv.outstandingMinor > 0 && !settings.allowCheckoutWithOutstandingBalance && !authorizeOutstanding) {
        throw new ApiError(409, `Outstanding balance of ${inv.outstandingMinor} must be paid before check-out`, 'OUTSTANDING_BALANCE', [{ field: 'outstandingMinor', message: String(inv.outstandingMinor) }]);
      }
      await Room.updateMany({ _id: { $in: u.rooms.map((r) => r.roomId) } }, { $set: { status: ROOM_STATUS.CLEANING, housekeepingStatus: H.DIRTY } }, { session });
      await housekeepingService.createCheckoutTasks(u, { session });
      await availabilityService.release(id, { session, fromDate: addDaysToKey(today, 1) }); // leaving early frees the unused nights
      if (inv.outstandingMinor <= 0) await billingService.closeAccount(account._id, { session });
      return { booking: u, invoice: inv };
    });
    await auditService.log(caller.user, ctx, 'BOOKING_CHECKED_OUT', 'Booking', id, { after: { invoiceNumber: invoice.invoiceNumber, outstandingMinor: invoice.outstandingMinor, authorizedWithBalance: authorizeOutstanding && invoice.outstandingMinor > 0, reason } });
    return { booking: booking.toJSON(), invoice: invoice.toJSON() };
  },

  /** In-house guests extending their stay: the extra nights are claimed (or refused if someone else holds them) and billed. */
  async extend(caller, id, { newCheckOutDate }, ctx) {
    const b = await load(id);
    if (b.status !== S.CHECKED_IN) throw ApiError.conflict('Only guests currently in the hotel can extend', 'INVALID_STATE_TRANSITION');
    if (newCheckOutDate <= b.checkOutDate) throw ApiError.unprocessable('The new check-out must be later than the current one', [], 'INVALID_DATES');
    const { settings } = await resolveStay(b.checkInDate, newCheckOutDate, { allowPast: true });
    const extra = nightKeys(b.checkOutDate, newCheckOutDate);
    const types = new Map((await RoomType.find({ _id: { $in: b.rooms.map((r) => r.roomTypeId) } })).map((t) => [String(t._id), t]));
    const rooms = b.rooms.map((r) => ({ ...r.toObject(), nightly: [...r.nightly, ...quoteNights(types.get(String(r.roomTypeId)), extra)] }));
    await availabilityService.purgeExpired(b.rooms.map((r) => r.roomId), extra);
    const out = await withTransaction(async (session) => {
      await availabilityService.acquire({ roomIds: b.rooms.map((r) => r.roomId), nights: extra, bookingId: b._id, state: 'SOLD' }, { session });
      const account = await billingService.getByBooking(id, { session });
      for (const line of rooms) for (const n of quoteNights(types.get(String(line.roomTypeId)), extra)) {
        await billingService.postCharge({ billingAccountId: account._id, bookingId: b._id, sourceType: 'ROOM_NIGHT', sourceId: b._id, sourceKey: `${line.roomId}:${n.date}`, category: CHARGE_CATEGORIES.ROOM, description: `Room ${line.roomNumber} - ${n.date}`, quantity: 1, unitPriceMinor: n.priceMinor, occurredAt: startOfLocalDay(n.date, settings.timezone), createdBy: caller.user._id }, { session });
      }
      return Booking.findOneAndUpdate({ _id: id, status: S.CHECKED_IN }, { $set: { rooms: rooms.map((l) => ({ ...l, subtotalMinor: sumNights(l.nightly) })), checkOutDate: newCheckOutDate, nights: b.nights + extra.length, 'priceSnapshot.roomTotalMinor': rooms.reduce((a, l) => a + sumNights(l.nightly), 0) } }, { new: true, session });
    });
    await auditService.log(caller.user, ctx, 'STAY_EXTENDED', 'Booking', id, { before: { checkOutDate: b.checkOutDate }, after: { checkOutDate: newCheckOutDate } });
    return out.toJSON();
  },
};
export { bookingService };
