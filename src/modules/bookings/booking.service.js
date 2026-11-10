import mongoose from 'mongoose';
import Booking from '../../models/Booking.js';
import Guest from '../../models/Guest.js';
import Invoice from '../../models/Invoice.js';
import Room from '../../models/Room.js';
import RoomType from '../../models/RoomType.js';
import { BOOKING_SOURCE, BOOKING_STATUS as S, CHARGE_CATEGORIES } from '../../constants/index.js';
import { PERMISSIONS as P } from '../../constants/permissions.js';
import { ApiError } from '../../utils/ApiError.js';
import { addDaysToKey, localToUtc, nightKeys, startOfLocalDay, toLocalDateKey } from '../../utils/dates.js';
import { percentBps } from '../../utils/money.js';
import { buildPageMeta, escapeRegex, parsePagination } from '../../utils/pagination.js';
import { withTransaction } from '../../utils/transaction.js';
import { auditService } from '../audit-logs/audit.service.js';
import { availabilityService, resolveStay } from '../availability/availability.service.js';
import { quoteNights, sumNights } from '../availability/pricing.js';
import { billingService } from '../billing/billing.service.js';
import { counterService } from '../counters/counter.service.js';
import { settingsService } from '../settings/settings.service.js';
import { userService } from '../users/user.service.js';

const same = (a, b) => String(a) === String(b);
const TRANSITIONS = { [S.PENDING]: [S.CONFIRMED, S.CANCELLED, S.EXPIRED], [S.CONFIRMED]: [S.CHECKED_IN, S.CANCELLED, S.NO_SHOW], [S.CHECKED_IN]: [S.CHECKED_OUT] };
const bad = (from, to) => ApiError.conflict(`A ${from} booking cannot become ${to}`, 'INVALID_STATE_TRANSITION');

/** Moves a booking between states atomically: only succeeds if it is still in `from`. Exported for the stay service. */
export const transition = async (bookingId, from, to, { by = null, note, set = {} } = {}, { session }) => {
  if (!TRANSITIONS[from]?.includes(to)) throw bad(from, to);
  const updated = await Booking.findOneAndUpdate({ _id: bookingId, status: from }, { $set: { status: to, ...set }, $push: { statusHistory: { status: to, at: new Date(), by, note } } }, { new: true, session });
  if (!updated) throw ApiError.conflict('The booking was changed by someone else; reload and try again', 'BOOKING_CHANGED');
  return updated;
};

const roomCharge = (booking, account, line, n, createdBy) => ({
  billingAccountId: account._id, bookingId: booking._id, sourceType: 'ROOM_NIGHT', sourceId: booking._id, sourceKey: `${line.roomId}:${n.date}`,
  category: CHARGE_CATEGORIES.ROOM, description: `Room ${line.roomNumber} - ${n.date}`, quantity: 1, unitPriceMinor: n.priceMinor, occurredAt: n.date ? startOfLocalDay(n.date, booking._tz) : new Date(), createdBy,
});

/** Penalty for cancelling late / not showing up: the first N nights across all rooms, never more than the stay. */
const penaltyFor = (booking, nights) => {
  const keys = new Set(nightKeys(booking.checkInDate, booking.checkOutDate).slice(0, nights));
  return booking.rooms.reduce((sum, r) => sum + r.nightly.filter((n) => keys.has(n.date)).reduce((a, n) => a + n.priceMinor, 0), 0);
};

const present = async (booking) => {
  const account = await billingService.getByBooking(booking._id);
  return { ...booking.toJSON(), billing: account ? { accountId: String(account._id), totalChargesMinor: account.totalChargesMinor, paidMinor: account.paidMinor, status: account.status } : null };
};

const loadFor = async (caller, id, { write = false } = {}) => {
  const b = mongoose.isValidObjectId(id) ? await Booking.findById(id) : null;
  const all = caller.permissions.has(write ? P.BOOKING_MANAGE : P.BOOKING_READ_ALL) || (!write && caller.permissions.has(P.BOOKING_READ_ALL));
  const own = b?.customerId && same(b.customerId, caller.user._id);
  if (!b || (!all && !(own && (caller.permissions.has(P.BOOKING_READ_OWN) || caller.permissions.has(P.BOOKING_CANCEL_OWN))))) throw ApiError.notFound('Booking not found', 'BOOKING_NOT_FOUND');
  return b;
};

export const bookingService = {
  transition,

  async create(caller, p, ctx) {
    const asStaff = caller.permissions.has(P.BOOKING_CREATE_FOR_GUEST);
    if (!asStaff && !caller.permissions.has(P.BOOKING_CREATE_OWN)) throw ApiError.forbidden();
    const { nights, settings } = await resolveStay(p.checkInDate, p.checkOutDate);

    let customerId = asStaff ? (p.customerId ?? null) : caller.user._id;
    if (asStaff && customerId) await userService.assertCustomer(customerId);
    const guestIds = p.guestIds ?? [];
    if (asStaff && !guestIds.length) throw ApiError.unprocessable('At least one guest is required', [{ field: 'body.guestIds', message: 'required' }], 'GUEST_REQUIRED');
    if (guestIds.length) {
      const guests = await Guest.find({ _id: { $in: guestIds }, deletedAt: null, ...(asStaff ? {} : { $or: [{ createdBy: caller.user._id }, { userId: caller.user._id }] }) }).select('_id');
      if (guests.length !== new Set(guestIds.map(String)).size) throw ApiError.unprocessable('Unknown guest', [{ field: 'body.guestIds', message: 'not found' }], 'GUEST_NOT_FOUND');
    }

    const roomIds = [...new Set(p.rooms.map(String))];
    const rooms = await Room.find({ _id: { $in: roomIds }, isActive: true, deletedAt: null, status: { $nin: ['OUT_OF_SERVICE', 'MAINTENANCE'] } });
    if (rooms.length !== roomIds.length) throw ApiError.unprocessable('One or more rooms do not exist or cannot be booked', [{ field: 'body.rooms', message: 'unavailable' }], 'ROOM_UNAVAILABLE');
    const types = new Map((await RoomType.find({ _id: { $in: rooms.map((r) => r.roomTypeId) }, status: 'ACTIVE' })).map((t) => [String(t._id), t]));
    if (rooms.some((r) => !types.has(String(r.roomTypeId)))) throw ApiError.unprocessable('A selected room type is inactive', [], 'ROOM_UNAVAILABLE');
    const guestsCount = p.adults + (p.children ?? 0);
    if (rooms.reduce((a, r) => a + types.get(String(r.roomTypeId)).capacity, 0) < guestsCount) throw ApiError.unprocessable('The party is larger than the rooms can hold', [{ field: 'body.adults', message: 'over capacity' }], 'CAPACITY_EXCEEDED');

    const lines = rooms.map((r) => { const t = types.get(String(r.roomTypeId)); const nightly = quoteNights(t, nights); return { roomId: r._id, roomNumber: r.roomNumber, roomTypeId: t._id, roomTypeName: t.name, capacity: t.capacity, nightly, subtotalMinor: sumNights(nightly) }; });
    const roomTotalMinor = lines.reduce((a, l) => a + l.subtotalMinor, 0);
    const depositRequiredMinor = percentBps(roomTotalMinor, settings.depositBps);
    const needsDeposit = !asStaff && depositRequiredMinor > 0;
    const status = needsDeposit ? S.PENDING : S.CONFIRMED;
    const holdExpiresAt = needsDeposit ? new Date(Date.now() + settings.reservation.holdMinutes * 60_000) : null;

    await availabilityService.purgeExpired(rooms.map((r) => r._id), nights); // before the transaction: a duplicate key inside one aborts it
    const bookingCode = await counterService.formatted('booking', 'BK', 6);
    const booking = await withTransaction(async (session) => {
      const [b] = await Booking.create([{ bookingCode, customerId, guestIds, rooms: lines, checkInDate: p.checkInDate, checkOutDate: p.checkOutDate, nights: nights.length, numberOfAdults: p.adults, numberOfChildren: p.children ?? 0, source: asStaff ? (p.source ?? BOOKING_SOURCE.RECEPTION) : BOOKING_SOURCE.WEBSITE, status, holdExpiresAt, priceSnapshot: { currency: settings.currency, roomTotalMinor, depositRequiredMinor }, specialRequests: p.specialRequests, createdBy: caller.user._id, statusHistory: [{ status, at: new Date(), by: caller.user._id }] }], { session });
      await availabilityService.acquire({ roomIds: rooms.map((r) => r._id), nights, bookingId: b._id, state: needsDeposit ? 'HELD' : 'SOLD', holdExpiresAt }, { session });
      const account = await billingService.openAccount({ bookingId: b._id, customerId, currency: settings.currency }, { session });
      b._tz = settings.timezone;
      for (const line of lines) for (const n of line.nightly) await billingService.postCharge(roomCharge(b, account, line, n, caller.user._id), { session });
      return b;
    });
    await auditService.log(caller.user, ctx, 'BOOKING_CREATED', 'Booking', booking._id, { after: { bookingCode, status, roomTotalMinor } });
    return present(booking);
  },

  async list(caller, q) {
    const all = caller.permissions.has(P.BOOKING_READ_ALL);
    if (!all && !caller.permissions.has(P.BOOKING_READ_OWN)) throw ApiError.forbidden();
    const filter = all ? {} : { customerId: caller.user._id };
    if (q.status) filter.status = q.status;
    if (all && q.customerId) filter.customerId = q.customerId;
    if (q.roomId) filter['rooms.roomId'] = q.roomId;
    if (q.from || q.to) filter.checkInDate = { ...(q.from && { $gte: q.from }), ...(q.to && { $lte: q.to }) };
    if (q.search) filter.bookingCode = new RegExp(escapeRegex(q.search), 'i');
    const paging = parsePagination(q, { allowedSort: ['createdAt', 'checkInDate'], defaultSort: 'createdAt' });
    const [items, total] = await Promise.all([Booking.find(filter).sort(paging.sort).skip(paging.skip).limit(paging.limit), Booking.countDocuments(filter)]);
    return { items: items.map((b) => b.toJSON()), meta: buildPageMeta({ ...paging, total }) };
  },

  async get(caller, id) { return present(await loadFor(caller, id)); },

  /** Manual confirmation (pay-later / phone bookings). Needs the hold to still be alive. */
  async confirm(caller, id, ctx) {
    const b = await loadFor(caller, id, { write: true });
    if (b.status !== S.PENDING) throw bad(b.status, S.CONFIRMED);
    if (b.holdExpiresAt && b.holdExpiresAt < new Date()) throw ApiError.conflict('The hold has expired', 'HOLD_EXPIRED');
    const out = await withTransaction(async (session) => { const u = await transition(id, S.PENDING, S.CONFIRMED, { by: caller.user._id, set: { holdExpiresAt: null } }, { session }); await availabilityService.confirm(id, { session }); return u; });
    await auditService.log(caller.user, ctx, 'BOOKING_CONFIRMED', 'Booking', id, {});
    return present(out);
  },

  /** Called inside the payment transaction: a deposit confirms a held booking; settling the invoice closes the account. */
  async onPaymentApplied(bookingId, { session }) {
    const b = await Booking.findById(bookingId).session(session);
    if (!b) return;
    const account = await billingService.getByBooking(bookingId, { session });
    if (b.status === S.PENDING && account.paidMinor >= (b.priceSnapshot?.depositRequiredMinor ?? 0) && (!b.holdExpiresAt || b.holdExpiresAt > new Date())) {
      await transition(bookingId, S.PENDING, S.CONFIRMED, { note: 'deposit received', set: { holdExpiresAt: null } }, { session });
      await availabilityService.confirm(bookingId, { session });
    }
    if (b.status === S.CHECKED_OUT && account.status === 'OPEN' && (await Invoice.exists({ billingAccountId: account._id, isActive: true, status: 'PAID' }).session(session))) await billingService.closeAccount(account._id, { session });
  },

  /** Release inventory, void room charges, and (if a penalty applies) bill it. Runs in the caller's transaction. */
  async _unwind(booking, { penaltyMinor, reason }, { session, actorId }) {
    const account = await billingService.getByBooking(booking._id, { session });
    await availabilityService.release(booking._id, { session });
    await billingService.voidCharges(account._id, { sourceType: 'ROOM_NIGHT', sourceId: booking._id }, reason, { session });
    if (penaltyMinor > 0) await billingService.postCharge({ billingAccountId: account._id, bookingId: booking._id, sourceType: 'BOOKING', sourceId: booking._id, sourceKey: 'cancellation-fee', category: CHARGE_CATEGORIES.SURCHARGE, description: `${reason} fee`, quantity: 1, unitPriceMinor: penaltyMinor, createdBy: actorId }, { session });
    const fresh = await billingService.findById(account._id, { session });
    if (penaltyMinor === 0 && fresh.paidMinor === 0) await billingService.closeAccount(account._id, { session });
    return fresh;
  },

  async cancel(caller, id, { reason, waivePenalty = false }, ctx) {
    const b = await loadFor(caller, id);
    const mayCancel = caller.permissions.has(P.BOOKING_CANCEL_ANY) || (caller.permissions.has(P.BOOKING_CANCEL_OWN) && b.customerId && same(b.customerId, caller.user._id));
    if (!mayCancel) throw ApiError.forbidden();
    if (![S.PENDING, S.CONFIRMED].includes(b.status)) throw bad(b.status, S.CANCELLED);
    if (waivePenalty && !caller.permissions.has(P.BOOKING_MANAGE)) throw ApiError.forbidden('Only managers can waive the cancellation fee');

    const settings = await settingsService.get();
    const policy = settings.cancellationPolicy;
    const deadline = new Date(localToUtc(...b.checkInDate.split('-').map(Number), ...settings.checkInTime.split(':').map(Number), settings.timezone).getTime() - policy.freeCancellationHoursBeforeCheckIn * 3_600_000);
    const free = b.status === S.PENDING || new Date() <= deadline || waivePenalty;
    const penaltyMinor = free ? 0 : Math.min(penaltyFor(b, policy.penaltyNights), b.priceSnapshot.roomTotalMinor);

    const out = await withTransaction(async (session) => {
      const u = await transition(id, b.status, S.CANCELLED, { by: caller.user._id, note: reason, set: { cancellation: { at: new Date(), by: caller.user._id, reason, penaltyMinor, penaltyNights: free ? 0 : policy.penaltyNights, freeCancellation: free }, holdExpiresAt: null } }, { session });
      const account = await this._unwind(u, { penaltyMinor, reason: 'Cancellation' }, { session, actorId: caller.user._id });
      return { u, refundDueMinor: Math.max(0, account.paidMinor - penaltyMinor) };
    });
    await auditService.log(caller.user, ctx, 'BOOKING_CANCELLED', 'Booking', id, { after: { reason, penaltyMinor, free } });
    return { ...(await present(out.u)), refundDueMinor: out.refundDueMinor };
  },

  async markNoShow(caller, id, ctx) {
    const b = await loadFor(caller, id, { write: true });
    const settings = await settingsService.get();
    if (b.checkInDate > toLocalDateKey(new Date(), settings.timezone)) throw ApiError.conflict('The arrival date has not passed yet', 'TOO_EARLY');
    return this._noShow(b, caller.user, settings, ctx);
  },

  async _noShow(b, actor, settings, ctx) {
    const penaltyMinor = Math.min(penaltyFor(b, settings.cancellationPolicy.penaltyNights), b.priceSnapshot.roomTotalMinor);
    const u = await withTransaction(async (session) => {
      const x = await transition(b._id, S.CONFIRMED, S.NO_SHOW, { by: actor?._id ?? null, set: { cancellation: { at: new Date(), by: actor?._id ?? null, reason: 'No show', penaltyMinor, penaltyNights: settings.cancellationPolicy.penaltyNights, freeCancellation: false } } }, { session });
      await this._unwind(x, { penaltyMinor, reason: 'No-show' }, { session, actorId: actor?._id ?? null });
      return x;
    });
    await auditService.log(actor, ctx, 'BOOKING_NO_SHOW', 'Booking', b._id, { after: { penaltyMinor } });
    return present(u);
  },

  /** Changes dates, rooms or party size. Nights that stay keep their original price; only new nights use today's rates. */
  async modify(caller, id, p, ctx) {
    const b = await loadFor(caller, id);
    const isOwner = b.customerId && same(b.customerId, caller.user._id) && caller.permissions.has(P.BOOKING_CREATE_OWN);
    if (!caller.permissions.has(P.BOOKING_MANAGE) && !isOwner) throw ApiError.forbidden();
    if (![S.PENDING, S.CONFIRMED].includes(b.status)) throw ApiError.conflict('Only pending or confirmed bookings can be modified', 'INVALID_STATE_TRANSITION');

    const checkIn = p.checkInDate ?? b.checkInDate; const checkOut = p.checkOutDate ?? b.checkOutDate;
    const { nights, settings } = await resolveStay(checkIn, checkOut);
    const roomIds = [...new Set((p.rooms ?? b.rooms.map((r) => r.roomId)).map(String))];
    const rooms = await Room.find({ _id: { $in: roomIds }, isActive: true, deletedAt: null, status: { $nin: ['OUT_OF_SERVICE', 'MAINTENANCE'] } });
    if (rooms.length !== roomIds.length) throw ApiError.unprocessable('One or more rooms cannot be booked', [{ field: 'body.rooms', message: 'unavailable' }], 'ROOM_UNAVAILABLE');
    const types = new Map((await RoomType.find({ _id: { $in: rooms.map((r) => r.roomTypeId) } })).map((t) => [String(t._id), t]));
    const adults = p.adults ?? b.numberOfAdults; const children = p.children ?? b.numberOfChildren;
    if (rooms.reduce((a, r) => a + types.get(String(r.roomTypeId)).capacity, 0) < adults + children) throw ApiError.unprocessable('The party is larger than the rooms can hold', [], 'CAPACITY_EXCEEDED');

    const oldPrice = new Map(b.rooms.flatMap((r) => r.nightly.map((n) => [`${r.roomId}:${n.date}`, n.priceMinor])));
    const lines = rooms.map((r) => { const t = types.get(String(r.roomTypeId)); const nightly = quoteNights(t, nights).map((n) => ({ date: n.date, priceMinor: oldPrice.get(`${r._id}:${n.date}`) ?? n.priceMinor })); return { roomId: r._id, roomNumber: r.roomNumber, roomTypeId: t._id, roomTypeName: t.name, capacity: t.capacity, nightly, subtotalMinor: sumNights(nightly) }; });
    const newKeys = new Set(lines.flatMap((l) => l.nightly.map((n) => `${l.roomId}:${n.date}`)));
    const removed = [...oldPrice.keys()].filter((k) => !newKeys.has(k)).map((k) => { const [roomId, date] = k.split(':'); return { roomId, date, key: k }; });
    const added = lines.flatMap((l) => l.nightly.filter((n) => !oldPrice.has(`${l.roomId}:${n.date}`)).map((n) => ({ roomId: l.roomId, line: l, n })));
    const roomTotalMinor = lines.reduce((a, l) => a + l.subtotalMinor, 0);
    await availabilityService.purgeExpired(added.map((a) => a.roomId), [...new Set(added.map((a) => a.n.date))]);

    const out = await withTransaction(async (session) => {
      const account = await billingService.getByBooking(id, { session });
      await availabilityService.releaseKeys(id, removed, { session });
      if (removed.length) await billingService.voidCharges(account._id, { sourceType: 'ROOM_NIGHT', sourceId: b._id, sourceKey: { $in: removed.map((r) => r.key) } }, 'Booking modified', { session });
      const state = b.status === S.PENDING ? 'HELD' : 'SOLD';
      for (const roomId of [...new Set(added.map((a) => String(a.roomId)))]) {
        await availabilityService.acquire({ roomIds: [roomId], nights: added.filter((a) => String(a.roomId) === roomId).map((a) => a.n.date), bookingId: b._id, state, holdExpiresAt: b.holdExpiresAt }, { session });
      }
      b._tz = settings.timezone;
      for (const a of added) await billingService.postCharge(roomCharge(b, account, a.line, a.n, caller.user._id), { session });
      return Booking.findOneAndUpdate({ _id: id, status: b.status }, { $set: { rooms: lines, checkInDate: checkIn, checkOutDate: checkOut, nights: nights.length, numberOfAdults: adults, numberOfChildren: children, specialRequests: p.specialRequests ?? b.specialRequests, 'priceSnapshot.roomTotalMinor': roomTotalMinor, 'priceSnapshot.depositRequiredMinor': percentBps(roomTotalMinor, settings.depositBps) } }, { new: true, session });
    });
    if (!out) throw ApiError.conflict('The booking was changed by someone else', 'BOOKING_CHANGED');
    await auditService.log(caller.user, ctx, 'BOOKING_MODIFIED', 'Booking', id, { before: { checkInDate: b.checkInDate, checkOutDate: b.checkOutDate }, after: { checkInDate: checkIn, checkOutDate: checkOut, roomTotalMinor } });
    return present(out);
  },

  // ---------------- scheduled jobs ----------------
  /** Pending bookings whose hold ran out: free the rooms, void the charges. */
  async processExpired(now = new Date()) {
    const due = await Booking.find({ status: S.PENDING, holdExpiresAt: { $lt: now } }).limit(100);
    let n = 0;
    for (const b of due) {
      try {
        await withTransaction(async (session) => { const u = await transition(b._id, S.PENDING, S.EXPIRED, { note: 'hold expired', set: { holdExpiresAt: null } }, { session }); await this._unwind(u, { penaltyMinor: 0, reason: 'Hold expired' }, { session, actorId: null }); });
        n += 1;
      } catch (err) { if (err.code !== 'BOOKING_CHANGED' && err.code !== 'INVALID_STATE_TRANSITION') throw err; }
    }
    return n;
  },

  /** Confirmed bookings whose arrival day has fully passed become NO_SHOW (and the no-show fee is billed). */
  async processNoShows(now = new Date()) {
    const settings = await settingsService.get();
    const today = toLocalDateKey(now, settings.timezone);
    const due = await Booking.find({ status: S.CONFIRMED, checkInDate: { $lt: today } }).limit(100);
    let n = 0;
    for (const b of due) { try { await this._noShow(b, null, settings, {}); n += 1; } catch (err) { if (err.code !== 'BOOKING_CHANGED' && err.code !== 'INVALID_STATE_TRANSITION') throw err; } }
    return n;
  },
};
export { addDaysToKey };
