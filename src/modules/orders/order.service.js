import mongoose from 'mongoose';
import Booking from '../../models/Booking.js';
import MenuCategory from '../../models/MenuCategory.js';
import MenuItem from '../../models/MenuItem.js';
import ServiceOrder from '../../models/ServiceOrder.js';
import { BOOKING_STATUS, CHARGE_CATEGORIES, ORDER_PAYMENT, ORDER_STATUS as S } from '../../constants/index.js';
import { PERMISSIONS as P } from '../../constants/permissions.js';
import { ApiError } from '../../utils/ApiError.js';
import { mulInt } from '../../utils/money.js';
import { buildPageMeta, parsePagination } from '../../utils/pagination.js';
import { withTransaction } from '../../utils/transaction.js';
import { auditService } from '../audit-logs/audit.service.js';
import { billingService } from '../billing/billing.service.js';
import { counterService } from '../counters/counter.service.js';
import { paymentService } from '../payments/payment.service.js';

const same = (a, b) => String(a) === String(b);
const NEXT = { [S.PENDING]: [S.CONFIRMED, S.REJECTED], [S.CONFIRMED]: [S.PREPARING], [S.PREPARING]: [S.READY], [S.READY]: [S.DELIVERING], [S.DELIVERING]: [S.DELIVERED], [S.DELIVERED]: [S.COMPLETED] };
const kitchen = (c) => c.permissions.has(P.ORDER_PROCESS) || c.permissions.has(P.ORDER_MANAGE);

const load = async (caller, id) => {
  const o = mongoose.isValidObjectId(id) ? await ServiceOrder.findById(id) : null;
  const own = o && same(o.customerId, caller.user._id) && caller.permissions.has(P.ORDER_READ_OWN);
  if (!o || (!own && !kitchen(caller))) throw ApiError.notFound('Order not found', 'ORDER_NOT_FOUND');
  return o;
};
const step = (o, status, by, extra = {}) => ServiceOrder.findOneAndUpdate({ _id: o._id, status: o.status }, { $set: { status, ...extra }, $push: { statusHistory: { status, at: new Date(), by } } }, { new: true });

export const orderService = {
  /** Only a guest who is checked in, on their own booking and room, can order. Prices and names are frozen into the order. */
  async create(caller, { bookingId, roomId, items, paymentMethod, notes, deliveryLocation }, ctx) {
    if (!caller.permissions.has(P.ORDER_CREATE_OWN)) throw ApiError.forbidden();
    const active = await Booking.find({ customerId: caller.user._id, status: BOOKING_STATUS.CHECKED_IN, ...(bookingId ? { _id: bookingId } : {}) });
    if (!active.length) throw ApiError.forbidden('Room service is available only during an active stay', 'NO_ACTIVE_STAY');
    if (active.length > 1) throw ApiError.unprocessable('You have several active stays; pass bookingId', [{ field: 'body.bookingId', message: 'required' }], 'BOOKING_REQUIRED');
    const booking = active[0];
    const room = roomId ? booking.rooms.find((r) => same(r.roomId, roomId)) : booking.rooms.length === 1 ? booking.rooms[0] : null;
    if (!room) throw ApiError.unprocessable('Choose one of the rooms on your booking', [{ field: 'body.roomId', message: roomId ? 'not your room' : 'required' }], 'ROOM_REQUIRED');

    const qty = new Map();
    for (const i of items) qty.set(String(i.menuItemId), { quantity: (qty.get(String(i.menuItemId))?.quantity ?? 0) + i.quantity, note: i.note });
    const docs = await MenuItem.find({ _id: { $in: [...qty.keys()] } });
    const cats = new Map((await MenuCategory.find({ _id: { $in: docs.map((d) => d.categoryId) } })).map((c) => [String(c._id), c]));
    const lines = [...qty.entries()].map(([id, v]) => {
      const m = docs.find((d) => String(d._id) === id);
      const cat = m && cats.get(String(m.categoryId));
      if (!m || m.status !== 'ACTIVE' || !m.availability || cat?.status !== 'ACTIVE') throw ApiError.unprocessable(`"${m?.name ?? id}" is not available`, [{ field: 'body.items', message: m?.name ?? id }], 'ITEM_UNAVAILABLE');
      if (v.quantity > 50) throw ApiError.unprocessable('Quantity per item is limited to 50', [], 'QUANTITY_TOO_LARGE');
      return { menuItemId: m._id, name: m.name, categoryName: cat.name, priceMinor: m.priceMinor, quantity: v.quantity, note: v.note };
    });
    const subtotalMinor = lines.reduce((a, l) => a + mulInt(l.priceMinor, l.quantity), 0);
    const orderCode = await counterService.formatted('order', 'ORD', 6);
    const o = await ServiceOrder.create({ orderCode, bookingId: booking._id, roomId: room.roomId, customerId: caller.user._id, items: lines, subtotalMinor, paymentMethod, notes, deliveryLocation: deliveryLocation ?? `Room ${room.roomNumber}`, statusHistory: [{ status: S.PENDING, at: new Date(), by: caller.user._id }] });
    await auditService.log(caller.user, ctx, 'ORDER_CREATED', 'ServiceOrder', o._id, { after: { orderCode, subtotalMinor, paymentMethod } });
    return o.toJSON();
  },

  async list(caller, q) {
    const all = kitchen(caller);
    if (!all && !caller.permissions.has(P.ORDER_READ_OWN)) throw ApiError.forbidden();
    const filter = all ? {} : { customerId: caller.user._id };
    for (const k of ['status', 'bookingId', 'roomId']) if (q[k]) filter[k] = q[k];
    if (q.active) filter.status = { $in: [S.PENDING, S.CONFIRMED, S.PREPARING, S.READY, S.DELIVERING] };
    const paging = parsePagination(q, { allowedSort: ['createdAt'], defaultSort: 'createdAt' });
    const [items, total] = await Promise.all([ServiceOrder.find(filter).sort(paging.sort).skip(paging.skip).limit(paging.limit), ServiceOrder.countDocuments(filter)]);
    return { items: items.map((o) => o.toJSON()), meta: buildPageMeta({ ...paging, total }) };
  },
  async get(caller, id) { return (await load(caller, id)).toJSON(); },

  /** Kitchen / delivery workflow. Every step is a conditional update, so two staff cannot both advance the same order. */
  async updateStatus(caller, id, { status, deliveryStaffId, reason }, ctx) {
    if (!kitchen(caller)) throw ApiError.forbidden();
    const o = await load(caller, id);
    if (!NEXT[o.status]?.includes(status)) throw ApiError.conflict(`A ${o.status} order cannot become ${status}`, 'INVALID_STATE_TRANSITION');
    if (status === S.REJECTED && !reason) throw ApiError.unprocessable('A reason is required to reject an order', [{ field: 'body.reason', message: 'required' }]);
    const extra = { ...(status === S.PREPARING ? { assignedStaffId: caller.user._id } : {}), ...(status === S.DELIVERING ? { deliveryStaffId: deliveryStaffId ?? caller.user._id } : {}), ...(reason ? { cancelReason: reason } : {}) };

    let out;
    if (status === S.DELIVERED) out = await this._deliver(caller, o);
    else { out = await step(o, status, caller.user._id, extra); if (!out) throw ApiError.conflict('The order was changed by someone else', 'ORDER_CHANGED'); }
    await auditService.log(caller.user, ctx, 'ORDER_STATUS_CHANGED', 'ServiceOrder', id, { before: { status: o.status }, after: { status } });
    return out.toJSON();
  },

  /** Delivery is the billing moment: ONE charge per order (idempotent), plus the payment if the guest paid on the spot. */
  async _deliver(caller, o) {
    return withTransaction(async (session) => {
      const u = await ServiceOrder.findOneAndUpdate({ _id: o._id, status: S.DELIVERING }, { $set: { status: S.DELIVERED, deliveredAt: new Date() }, $push: { statusHistory: { status: S.DELIVERED, at: new Date(), by: caller.user._id } } }, { new: true, session });
      if (!u) throw ApiError.conflict('The order was changed by someone else', 'ORDER_CHANGED');
      const booking = await Booking.findById(u.bookingId).session(session);
      if (booking.status !== BOOKING_STATUS.CHECKED_IN) throw ApiError.conflict('The guest has already checked out', 'BOOKING_NOT_ACTIVE');
      const account = await billingService.getByBooking(u.bookingId, { session });
      await billingService.postCharge({ billingAccountId: account._id, bookingId: u.bookingId, sourceType: 'FNB_ORDER', sourceId: u._id, sourceKey: 'order', category: CHARGE_CATEGORIES.FOOD_AND_BEVERAGE, description: `Room service ${u.orderCode}`, quantity: 1, unitPriceMinor: u.subtotalMinor, createdBy: caller.user._id }, { session });
      if (u.paymentMethod !== ORDER_PAYMENT.ROOM_CHARGE && u.subtotalMinor > 0) {
        await paymentService.recordInSession({ billingAccountId: account._id, bookingId: u.bookingId, amountMinor: u.subtotalMinor, method: u.paymentMethod, receivedBy: caller.user._id, idempotencyKey: `order:${u._id}`, currency: account.currency, note: u.orderCode }, { session });
      }
      return u;
    });
  },

  async cancel(caller, id, { reason }, ctx) {
    const o = await load(caller, id);
    const own = same(o.customerId, caller.user._id);
    const staff = caller.permissions.has(P.ORDER_MANAGE);
    if (!own && !staff) throw ApiError.forbidden();
    const cancellable = staff ? [S.PENDING, S.CONFIRMED, S.PREPARING, S.READY, S.DELIVERING] : [S.PENDING, S.CONFIRMED]; // guests: until the kitchen starts
    if (!cancellable.includes(o.status)) throw ApiError.conflict(`A ${o.status} order cannot be cancelled`, 'INVALID_STATE_TRANSITION');
    const out = await step(o, S.CANCELLED, caller.user._id, { cancelReason: reason });
    if (!out) throw ApiError.conflict('The order was changed by someone else', 'ORDER_CHANGED');
    await auditService.log(caller.user, ctx, 'ORDER_CANCELLED', 'ServiceOrder', id, { after: { reason } });
    return out.toJSON();
  },

  async complete(caller, id, ctx) {
    const o = await load(caller, id);
    if (!same(o.customerId, caller.user._id) && !kitchen(caller)) throw ApiError.forbidden();
    if (o.status !== S.DELIVERED) throw ApiError.conflict('Only delivered orders can be completed', 'INVALID_STATE_TRANSITION');
    const out = await step(o, S.COMPLETED, caller.user._id);
    if (!out) throw ApiError.conflict('The order was changed by someone else', 'ORDER_CHANGED');
    await auditService.log(caller.user, ctx, 'ORDER_COMPLETED', 'ServiceOrder', id, {});
    return out.toJSON();
  },

  /** Job: delivered orders nobody closed become COMPLETED after an hour. */
  async autoComplete(now = new Date()) {
    const r = await ServiceOrder.updateMany({ status: S.DELIVERED, deliveredAt: { $lt: new Date(now.getTime() - 3_600_000) } }, { $set: { status: S.COMPLETED }, $push: { statusHistory: { status: S.COMPLETED, at: now, by: null } } });
    return r.modifiedCount;
  },
};
