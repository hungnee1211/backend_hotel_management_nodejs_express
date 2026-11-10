import BillingCharge from '../../models/BillingCharge.js';
import Attendance from '../../models/Attendance.js';
import Equipment from '../../models/Equipment.js';
import Facility from '../../models/Facility.js';
import Invoice from '../../models/Invoice.js';
import MaintenanceHistory from '../../models/MaintenanceHistory.js';
import MaintenanceRequest from '../../models/MaintenanceRequest.js';
import Payment from '../../models/Payment.js';
import Refund from '../../models/Refund.js';
import Room from '../../models/Room.js';
import RoomNight from '../../models/RoomNight.js';
import ServiceOrder from '../../models/ServiceOrder.js';
import Shift from '../../models/Shift.js';
import User from '../../models/User.js';
import { ROLES } from '../../constants/index.js';
import { facilityService } from '../facilities/facility.service.js';
import { settingsService } from '../settings/settings.service.js';
import { visibleStaffIds } from '../shifts/shift.service.js';
import { previousRange, resolveRange } from './range.js';

const sum = (rows, key = 'total') => rows.reduce((a, r) => a + (r[key] ?? 0), 0);
const pct = (num, den) => (den > 0 ? Math.round((num / den) * 10_000) / 100 : null); // percent, 2 decimals
const div = (num, den) => (den > 0 ? Math.round(num / den) : null); // minor units, rounded

export const analyticsService = {
  async range(q) { const tz = (await settingsService.get()).timezone; return { tz, range: resolveRange(q, tz) }; },

  /**
   * MONEY. Every figure states its date basis; none is derived from order or service records, only from the billing ledger,
   * invoices and payments, so one transaction can never be counted twice.
   */
  async revenue(range) {
    const [byCat, invoiced, paid, refunded, outstanding, maint] = await Promise.all([
      BillingCharge.aggregate([{ $match: { status: 'POSTED', occurredAt: { $gte: range.start, $lt: range.end } } }, { $group: { _id: '$category', total: { $sum: '$amountMinor' }, count: { $sum: 1 } } }]),
      Invoice.aggregate([{ $match: { isActive: true, status: { $nin: ['DRAFT', 'VOID'] }, issuedAt: { $gte: range.start, $lt: range.end } } }, { $group: { _id: null, count: { $sum: 1 }, grand: { $sum: { $add: ['$grandTotalMinor', '$adjustmentsTotalMinor'] } }, discounts: { $sum: '$discountTotalMinor' }, taxes: { $sum: '$taxTotalMinor' }, surcharges: { $sum: '$surchargeTotalMinor' }, serviceCharge: { $sum: '$serviceChargeMinor' } } }]),
      Payment.aggregate([{ $match: { status: { $in: ['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'] }, paidAt: { $gte: range.start, $lt: range.end } } }, { $group: { _id: null, total: { $sum: '$amountMinor' }, count: { $sum: 1 } } }]),
      Refund.aggregate([{ $match: { createdAt: { $gte: range.start, $lt: range.end } } }, { $group: { _id: null, total: { $sum: '$amountMinor' }, count: { $sum: 1 } } }]),
      Invoice.aggregate([{ $match: { isActive: true, status: { $in: ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'] }, outstandingMinor: { $gt: 0 } } }, { $group: { _id: null, total: { $sum: '$outstandingMinor' }, count: { $sum: 1 } } }]),
      MaintenanceHistory.aggregate([{ $match: { maintenanceDate: { $gte: range.start, $lt: range.end } } }, { $group: { _id: null, total: { $sum: '$costMinor' }, count: { $sum: 1 } } }]),
    ]);
    const cat = (c) => byCat.find((r) => r._id === c)?.total ?? 0;
    const roomRevenueMinor = cat('ROOM'); const fnbRevenueMinor = cat('FOOD_AND_BEVERAGE'); const serviceRevenueMinor = cat('ADDITIONAL_SERVICE');
    const surchargeRevenueMinor = cat('SURCHARGE'); const discountsMinor = -cat('DISCOUNT');
    const inv = invoiced[0] ?? {};
    return {
      period: range.label,
      earned: { roomRevenueMinor, fnbRevenueMinor, serviceRevenueMinor, surchargeRevenueMinor, discountsMinor, netRevenueMinor: roomRevenueMinor + fnbRevenueMinor + serviceRevenueMinor + surchargeRevenueMinor - discountsMinor },
      invoiced: { invoices: inv.count ?? 0, totalMinor: inv.grand ?? 0, discountsMinor: inv.discounts ?? 0, taxesMinor: inv.taxes ?? 0, surchargesMinor: inv.surcharges ?? 0, serviceChargeMinor: inv.serviceCharge ?? 0 },
      cash: { collectedMinor: paid[0]?.total ?? 0, payments: paid[0]?.count ?? 0, refundsMinor: refunded[0]?.total ?? 0, refunds: refunded[0]?.count ?? 0, netCollectedMinor: (paid[0]?.total ?? 0) - (refunded[0]?.total ?? 0) },
      outstanding: { asOf: new Date().toISOString(), invoices: outstanding[0]?.count ?? 0, totalMinor: outstanding[0]?.total ?? 0 },
      expenses: { maintenanceMinor: maint[0]?.total ?? 0, repairs: maint[0]?.count ?? 0 },
      definitions: {
        earned: 'Billing charges (not voided) by their service date: room nights by the night, orders by delivery, services by completion. Pre-tax.',
        invoiced: 'Issued invoices by issue date, including tax and adjustments.',
        cash: 'Succeeded payments by payment date, minus refunds by refund date.',
        outstanding: 'Unpaid balance of live issued invoices right now (not period-based).',
        expenses: 'Maintenance costs by repair date. Shown separately; never netted into revenue.',
      },
    };
  },

  /** Occupancy = sold ledger nights / available nights. ADR = room revenue / room nights billed. RevPAR = room revenue / available nights. */
  async occupancy(range, tz) {
    const [roomsTotal, closedRooms, sold, blocked, roomCharges, byStatus] = await Promise.all([
      Room.countDocuments({ isActive: true, deletedAt: null }),
      Room.countDocuments({ isActive: true, deletedAt: null, status: { $in: ['OUT_OF_SERVICE', 'MAINTENANCE'] } }),
      RoomNight.countDocuments({ state: 'SOLD', date: { $gte: range.fromKey, $lt: range.toKey } }),
      RoomNight.countDocuments({ state: 'BLOCKED', date: { $gte: range.fromKey, $lt: range.toKey } }),
      BillingCharge.aggregate([{ $match: { status: 'POSTED', category: 'ROOM', occurredAt: { $gte: range.start, $lt: range.end } } }, { $group: { _id: null, total: { $sum: '$amountMinor' }, nights: { $sum: 1 } } }]),
      Room.aggregate([{ $match: { isActive: true, deletedAt: null } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    ]);
    const availableNights = Math.max(0, roomsTotal * range.days - blocked - closedRooms * range.days);
    const roomRevenueMinor = roomCharges[0]?.total ?? 0; const billedNights = roomCharges[0]?.nights ?? 0;
    const today = (await import('../../utils/dates.js')).toLocalDateKey(new Date(), tz);
    const reservedTonight = await RoomNight.countDocuments({ state: { $in: ['SOLD', 'HELD'] }, date: today });
    const status = Object.fromEntries(byStatus.map((r) => [r._id, r.n]));
    return {
      period: range.label, totalRooms: roomsTotal, days: range.days, availableNights, soldNights: sold, billedRoomNights: billedNights, blockedNights: blocked,
      occupancyRatePercent: pct(sold, availableNights), roomRevenueMinor, adrMinor: div(roomRevenueMinor, billedNights), revparMinor: div(roomRevenueMinor, availableNights),
      current: { total: roomsTotal, available: status.AVAILABLE ?? 0, occupied: status.OCCUPIED ?? 0, cleaning: status.CLEANING ?? 0, maintenance: (status.MAINTENANCE ?? 0) + (status.OUT_OF_SERVICE ?? 0), reservedTonight },
    };
  },

  async foodBeverage(range) {
    const m = { createdAt: { $gte: range.start, $lt: range.end } };
    const delivered = { status: { $in: ['DELIVERED', 'COMPLETED'] }, deliveredAt: { $gte: range.start, $lt: range.end } };
    const [counts, rev, best, byCat] = await Promise.all([
      ServiceOrder.aggregate([{ $match: m }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
      BillingCharge.aggregate([{ $match: { status: 'POSTED', category: 'FOOD_AND_BEVERAGE', occurredAt: { $gte: range.start, $lt: range.end } } }, { $group: { _id: null, total: { $sum: '$amountMinor' }, n: { $sum: 1 } } }]),
      ServiceOrder.aggregate([{ $match: delivered }, { $unwind: '$items' }, { $group: { _id: '$items.name', quantity: { $sum: '$items.quantity' }, revenueMinor: { $sum: { $multiply: ['$items.priceMinor', '$items.quantity'] } } } }, { $sort: { quantity: -1, revenueMinor: -1 } }, { $limit: 10 }]),
      ServiceOrder.aggregate([{ $match: delivered }, { $unwind: '$items' }, { $group: { _id: '$items.categoryName', revenueMinor: { $sum: { $multiply: ['$items.priceMinor', '$items.quantity'] } }, quantity: { $sum: '$items.quantity' } } }, { $sort: { revenueMinor: -1 } }]),
    ]);
    const n = (s) => counts.find((r) => r._id === s)?.n ?? 0;
    const deliveredOrders = n('DELIVERED') + n('COMPLETED'); const revenueMinor = rev[0]?.total ?? 0;
    return { period: range.label, totalOrders: sum(counts, 'n'), deliveredOrders, cancelledOrders: n('CANCELLED'), rejectedOrders: n('REJECTED'), revenueMinor, averageOrderValueMinor: div(revenueMinor, rev[0]?.n ?? 0), bestSelling: best.map((b) => ({ item: b._id, quantity: b.quantity, revenueMinor: b.revenueMinor })), revenueByCategory: byCat.map((b) => ({ category: b._id, revenueMinor: b.revenueMinor, quantity: b.quantity })), definitions: { revenue: 'Food & beverage billing charges by delivery date (the order list only supplies the breakdown).' } };
  },

  async staff(caller, range) {
    const ids = await visibleStaffIds({ user: caller.user, permissions: caller.permissions });
    const scope = ids ? { $in: ids } : { $exists: true };
    const [totalStaff, shifts, att] = await Promise.all([
      User.countDocuments({ role: ROLES.STAFF, deletedAt: null, status: 'ACTIVE', ...(ids ? { _id: { $in: ids } } : {}) }),
      Shift.aggregate([{ $match: { staffId: scope, status: 'SCHEDULED', date: { $gte: range.fromKey, $lt: range.toKey } } }, { $group: { _id: '$department', shifts: { $sum: 1 } } }]),
      Attendance.aggregate([{ $match: { staffId: scope, date: { $gte: range.fromKey, $lt: range.toKey } } }, { $lookup: { from: Shift.collection.name, localField: 'shiftId', foreignField: '_id', as: 's' } }, { $unwind: '$s' }, { $group: { _id: '$s.department', present: { $sum: { $cond: [{ $in: ['$status', ['ABSENT']] }, 0, 1] } }, absent: { $sum: { $cond: [{ $eq: ['$status', 'ABSENT'] }, 1, 0] } }, late: { $sum: { $cond: [{ $gt: ['$lateMinutes', 0] }, 1, 0] } }, workedMinutes: { $sum: '$workedMinutes' } } }]),
    ]);
    const depts = [...new Set([...shifts.map((s) => s._id), ...att.map((a) => a._id)])].filter(Boolean);
    const byDepartment = depts.map((d) => { const s = shifts.find((x) => x._id === d)?.shifts ?? 0; const a = att.find((x) => x._id === d) ?? {}; return { department: d, scheduledShifts: s, present: a.present ?? 0, absent: a.absent ?? 0, late: a.late ?? 0, workedMinutes: a.workedMinutes ?? 0, attendanceRatePercent: pct(a.present ?? 0, s) }; });
    const t = (k) => byDepartment.reduce((a, d) => a + d[k], 0);
    return { period: range.label, totalStaff, scheduledShifts: t('scheduledShifts'), present: t('present'), absent: t('absent'), late: t('late'), workedMinutes: t('workedMinutes'), attendanceRatePercent: pct(t('present'), t('scheduledShifts')), byDepartment };
  },

  /** Managers see their own facilities; Admins see everything. */
  async maintenance(caller, range) {
    const managed = await facilityService.managedIds({ user: caller.user });
    const fac = managed ? { facilityId: { $in: managed } } : {};
    const [facilities, equipment, requests, cost, frequent, overdue] = await Promise.all([
      Facility.countDocuments({ deletedAt: null, ...(managed ? { _id: { $in: managed } } : {}) }),
      Equipment.aggregate([{ $match: { deletedAt: null, ...fac } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
      MaintenanceRequest.aggregate([{ $match: { createdAt: { $gte: range.start, $lt: range.end }, ...fac } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
      MaintenanceHistory.aggregate([{ $match: { maintenanceDate: { $gte: range.start, $lt: range.end }, ...fac } }, { $group: { _id: null, total: { $sum: '$costMinor' }, repairs: { $sum: 1 } } }]),
      MaintenanceRequest.aggregate([{ $match: { createdAt: { $gte: range.start, $lt: range.end }, equipmentId: { $ne: null }, ...fac } }, { $group: { _id: '$equipmentId', requests: { $sum: 1 } } }, { $sort: { requests: -1 } }, { $limit: 5 }, { $lookup: { from: Equipment.collection.name, localField: '_id', foreignField: '_id', as: 'e' } }, { $unwind: '$e' }, { $project: { _id: 0, equipmentId: '$_id', name: '$e.name', code: '$e.equipmentCode', requests: 1 } }]),
      Equipment.countDocuments({ deletedAt: null, status: { $ne: 'RETIRED' }, nextMaintenanceAt: { $lt: new Date() }, ...fac }),
    ]);
    const es = Object.fromEntries(equipment.map((r) => [r._id, r.n]));
    return { period: range.label, totalFacilities: facilities, totalEquipment: sum(equipment, 'n'), equipmentByStatus: es, underMaintenance: es.IN_MAINTENANCE ?? 0, requestsByStatus: Object.fromEntries(requests.map((r) => [r._id, r.n])), totalRequests: sum(requests, 'n'), maintenanceCostMinor: cost[0]?.total ?? 0, repairs: cost[0]?.repairs ?? 0, mostFrequentlyServiced: frequent, overdueMaintenance: overdue };
  },

  /** Headline numbers for a range with the change against the previous period of equal length. */
  async overview(caller, q) {
    const { tz, range } = await this.range(q); const prev = previousRange(range, tz);
    const snap = async (r) => { const [rev, occ] = await Promise.all([this.revenue(r), this.occupancy(r, tz)]); return { period: r.label, netRevenueMinor: rev.earned.netRevenueMinor, invoicedMinor: rev.invoiced.totalMinor, collectedMinor: rev.cash.netCollectedMinor, occupancyRatePercent: occ.occupancyRatePercent, adrMinor: occ.adrMinor, revparMinor: occ.revparMinor }; };
    const [current, previous] = await Promise.all([snap(range), snap(prev)]);
    const change = (a, b) => (b ? Math.round(((a - b) / Math.abs(b)) * 10_000) / 100 : null);
    return { current, previous, changePercent: { netRevenue: change(current.netRevenueMinor, previous.netRevenueMinor), invoiced: change(current.invoicedMinor, previous.invoicedMinor), collected: change(current.collectedMinor, previous.collectedMinor) } };
  },

  /** Twelve-month trend for a year, optionally next to another year (year-over-year). */
  async monthly({ year, compareYear }) {
    const tz = (await settingsService.get()).timezone;
    const one = async (y) => { const out = []; for (let m = 1; m <= 12; m += 1) { const r = resolveRange({ period: 'month', year: y, month: m }, tz); const [rev, occ] = await Promise.all([this.revenue(r), this.occupancy(r, tz)]); out.push({ month: r.label, roomRevenueMinor: rev.earned.roomRevenueMinor, fnbRevenueMinor: rev.earned.fnbRevenueMinor, serviceRevenueMinor: rev.earned.serviceRevenueMinor, netRevenueMinor: rev.earned.netRevenueMinor, invoicedMinor: rev.invoiced.totalMinor, collectedMinor: rev.cash.netCollectedMinor, maintenanceExpenseMinor: rev.expenses.maintenanceMinor, occupancyRatePercent: occ.occupancyRatePercent, adrMinor: occ.adrMinor }); } return out; };
    return { year, months: await one(year), ...(compareYear ? { compareYear, compareMonths: await one(compareYear) } : {}) };
  },
};
