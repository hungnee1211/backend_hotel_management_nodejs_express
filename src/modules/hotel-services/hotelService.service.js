import mongoose from 'mongoose';
import Booking from '../../models/Booking.js';
import HotelService from '../../models/HotelService.js';
import ServiceRequest from '../../models/ServiceRequest.js';
import StaffProfile from '../../models/StaffProfile.js';
import User from '../../models/User.js';
import { BOOKING_STATUS, CHARGE_CATEGORIES, PRICING_TYPE, ROLES, SERVICE_REQUEST_STATUS as S } from '../../constants/index.js';
import { PERMISSIONS as P, effectivePermissions } from '../../constants/permissions.js';
import { ApiError } from '../../utils/ApiError.js';
import { mulInt } from '../../utils/money.js';
import { buildPageMeta, escapeRegex, parsePagination } from '../../utils/pagination.js';
import { withTransaction } from '../../utils/transaction.js';
import { auditService } from '../audit-logs/audit.service.js';
import { billingService } from '../billing/billing.service.js';
import { counterService } from '../counters/counter.service.js';

const same = (a, b) => String(a) === String(b);
const NEXT = { [S.REQUESTED]: [S.ASSIGNED, S.REJECTED], [S.ASSIGNED]: [S.IN_PROGRESS], [S.IN_PROGRESS]: [S.COMPLETED] };
const fulfil = (c) => c.permissions.has(P.SERVICE_FULFILL) || c.permissions.has(P.SERVICE_MANAGE);

export const hotelServiceService = {
  // ---------------- catalogue ----------------
  async list(caller, q) {
    const filter = caller.permissions.has(P.SERVICE_MANAGE) ? {} : { status: 'ACTIVE' };
    if (q.category) filter.category = q.category;
    if (q.search) filter.name = new RegExp(escapeRegex(q.search), 'i');
    const paging = parsePagination(q, { allowedSort: ['name', 'priceMinor', 'createdAt'], defaultSort: 'name', defaultLimit: 50 });
    const [items, total] = await Promise.all([HotelService.find(filter).sort(paging.sort).skip(paging.skip).limit(paging.limit), HotelService.countDocuments(filter)]);
    return { items: items.map((s) => s.toJSON()), meta: buildPageMeta({ ...paging, total }) };
  },
  async create(caller, data, ctx) { const s = await HotelService.create(data); await auditService.log(caller.user, ctx, 'SERVICE_CREATED', 'HotelService', s._id, { after: s }); return s.toJSON(); },
  async update(caller, id, patch, ctx) {
    const before = await HotelService.findById(id);
    if (!before) throw ApiError.notFound('Service not found', 'SERVICE_NOT_FOUND');
    const after = await HotelService.findByIdAndUpdate(id, { $set: patch }, { new: true, runValidators: true });
    await auditService.log(caller.user, ctx, 'SERVICE_UPDATED', 'HotelService', id, { before, after }); // existing requests keep their price snapshot
    return after.toJSON();
  },

  // ---------------- requests ----------------
  /** A guest asks for a service on their own confirmed or in-house booking. The price is snapshotted. */
  async request(caller, { bookingId, hotelServiceId, quantity = 1, scheduledAt, notes }, ctx) {
    if (!caller.permissions.has(P.SERVICE_REQUEST_OWN)) throw ApiError.forbidden();
    const booking = await Booking.findOne({ _id: bookingId, customerId: caller.user._id });
    if (!booking) throw ApiError.notFound('Booking not found', 'BOOKING_NOT_FOUND'); // also covers other people's bookings
    if (![BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.CHECKED_IN].includes(booking.status)) throw ApiError.conflict('Services can only be requested for confirmed or in-house bookings', 'BOOKING_NOT_ACTIVE');
    const svc = await HotelService.findById(hotelServiceId);
    if (!svc || svc.status !== 'ACTIVE' || !svc.availability) throw ApiError.unprocessable('That service is not available', [{ field: 'body.hotelServiceId', message: 'unavailable' }], 'SERVICE_UNAVAILABLE');
    const qty = svc.pricingType === PRICING_TYPE.FIXED ? 1 : quantity; // FIXED = one price; PER_PERSON/HOUR/UNIT multiply
    const requestCode = await counterService.formatted('service-request', 'SRQ', 6);
    const r = await ServiceRequest.create({ requestCode, bookingId, customerId: caller.user._id, hotelServiceId, serviceSnapshot: { name: svc.name, category: svc.category, pricingType: svc.pricingType, unitPriceMinor: svc.priceMinor }, quantity: qty, totalMinor: mulInt(svc.priceMinor, qty), scheduledAt, notes, statusHistory: [{ status: S.REQUESTED, at: new Date(), by: caller.user._id }] });
    await auditService.log(caller.user, ctx, 'SERVICE_REQUESTED', 'ServiceRequest', r._id, { after: { requestCode, totalMinor: r.totalMinor } });
    return r.toJSON();
  },

  async listRequests(caller, q) {
    const all = fulfil(caller);
    if (!all && !caller.permissions.has(P.SERVICE_REQUEST_OWN)) throw ApiError.forbidden();
    const filter = all ? {} : { customerId: caller.user._id };
    if (all && !caller.permissions.has(P.SERVICE_MANAGE)) filter.$or = [{ assignedStaffId: caller.user._id }, { status: S.REQUESTED }]; // fulfilment staff: the queue plus their own jobs
    for (const k of ['status', 'bookingId']) if (q[k]) filter[k] = q[k];
    const paging = parsePagination(q, { allowedSort: ['createdAt'], defaultSort: 'createdAt' });
    const [items, total] = await Promise.all([ServiceRequest.find(filter).sort(paging.sort).skip(paging.skip).limit(paging.limit), ServiceRequest.countDocuments(filter)]);
    return { items: items.map((r) => r.toJSON()), meta: buildPageMeta({ ...paging, total }) };
  },

  async _load(caller, id) {
    const r = mongoose.isValidObjectId(id) ? await ServiceRequest.findById(id) : null;
    const own = r && same(r.customerId, caller.user._id);
    if (!r || (!own && !fulfil(caller))) throw ApiError.notFound('Service request not found', 'SERVICE_REQUEST_NOT_FOUND');
    return r;
  },
  async getRequest(caller, id) { return (await this._load(caller, id)).toJSON(); },

  async _assertAssignee(caller, staffId) {
    const user = await User.findOne({ _id: staffId, deletedAt: null, status: 'ACTIVE', role: ROLES.STAFF });
    const profile = user && (await StaffProfile.findOne({ userId: staffId }));
    if (!profile || !effectivePermissions({ role: ROLES.STAFF, staffProfile: profile }).has(P.SERVICE_FULFILL)) throw ApiError.unprocessable('Not a staff member who can fulfil services', [{ field: 'body.assignedStaffId', message: 'invalid' }], 'INVALID_ASSIGNEE');
    if (caller.user.role === ROLES.MANAGER && !same(profile.managerId, caller.user._id)) throw ApiError.unprocessable('That staff member is not on your team', [{ field: 'body.assignedStaffId', message: 'not your team' }], 'INVALID_ASSIGNEE');
  },

  async updateStatus(caller, id, { status, assignedStaffId, reason }, ctx) {
    if (!fulfil(caller)) throw ApiError.forbidden();
    const r = await this._load(caller, id);
    if (!NEXT[r.status]?.includes(status)) throw ApiError.conflict(`A ${r.status} request cannot become ${status}`, 'INVALID_STATE_TRANSITION');
    const manager = caller.permissions.has(P.SERVICE_MANAGE);
    let assignee = r.assignedStaffId;
    if (status === S.ASSIGNED) {
      assignee = assignedStaffId ?? caller.user._id; // staff may pick a job up themselves
      if (!same(assignee, caller.user._id) && !manager) throw ApiError.forbidden('Only managers can assign work to others');
      if (!manager || same(assignee, caller.user._id)) { if (!same(assignee, caller.user._id)) await this._assertAssignee(caller, assignee); } else await this._assertAssignee(caller, assignee);
    }
    if ([S.IN_PROGRESS, S.COMPLETED].includes(status) && !manager && !(assignee && same(assignee, caller.user._id))) throw ApiError.forbidden('Only the assigned staff member can do this');
    if (status === S.REJECTED && !reason) throw ApiError.unprocessable('A reason is required', [{ field: 'body.reason', message: 'required' }]);

    const out = status === S.COMPLETED ? await this._complete(caller, r) : await ServiceRequest.findOneAndUpdate({ _id: id, status: r.status }, { $set: { status, assignedStaffId: assignee, ...(reason ? { cancelReason: reason } : {}) }, $push: { statusHistory: { status, at: new Date(), by: caller.user._id } } }, { new: true });
    if (!out) throw ApiError.conflict('The request was changed by someone else', 'REQUEST_CHANGED');
    await auditService.log(caller.user, ctx, 'SERVICE_REQUEST_STATUS_CHANGED', 'ServiceRequest', id, { before: { status: r.status }, after: { status } });
    return out.toJSON();
  },

  /** Completion is the billing moment: one ADDITIONAL_SERVICE charge per request (idempotent). */
  async _complete(caller, r) {
    return withTransaction(async (session) => {
      const u = await ServiceRequest.findOneAndUpdate({ _id: r._id, status: S.IN_PROGRESS }, { $set: { status: S.COMPLETED, completedAt: new Date() }, $push: { statusHistory: { status: S.COMPLETED, at: new Date(), by: caller.user._id } } }, { new: true, session });
      if (!u) throw ApiError.conflict('The request was changed by someone else', 'REQUEST_CHANGED');
      const booking = await Booking.findById(u.bookingId).session(session);
      if (booking.status !== BOOKING_STATUS.CHECKED_IN) throw ApiError.conflict('The guest must be checked in for the service to be billed', 'BOOKING_NOT_ACTIVE');
      const account = await billingService.getByBooking(u.bookingId, { session });
      await billingService.postCharge({ billingAccountId: account._id, bookingId: u.bookingId, sourceType: 'SERVICE_REQUEST', sourceId: u._id, sourceKey: 'request', category: CHARGE_CATEGORIES.ADDITIONAL_SERVICE, description: `${u.serviceSnapshot.name} x${u.quantity} (${u.requestCode})`, quantity: u.quantity, unitPriceMinor: u.serviceSnapshot.unitPriceMinor, createdBy: caller.user._id }, { session });
      return u;
    });
  },

  async cancel(caller, id, { reason }, ctx) {
    const r = await this._load(caller, id);
    const own = same(r.customerId, caller.user._id);
    if (!own && !caller.permissions.has(P.SERVICE_MANAGE)) throw ApiError.forbidden();
    if (![S.REQUESTED, S.ASSIGNED].includes(r.status)) throw ApiError.conflict(`A ${r.status} request cannot be cancelled`, 'INVALID_STATE_TRANSITION');
    const out = await ServiceRequest.findOneAndUpdate({ _id: id, status: r.status }, { $set: { status: S.CANCELLED, cancelReason: reason }, $push: { statusHistory: { status: S.CANCELLED, at: new Date(), by: caller.user._id } } }, { new: true });
    if (!out) throw ApiError.conflict('The request was changed by someone else', 'REQUEST_CHANGED');
    await auditService.log(caller.user, ctx, 'SERVICE_REQUEST_CANCELLED', 'ServiceRequest', id, { after: { reason } });
    return out.toJSON();
  },
};
