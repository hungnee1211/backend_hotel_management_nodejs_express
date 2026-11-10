import AuditLog from '../../models/AuditLog.js';
import Attendance from '../../models/Attendance.js';
import Booking from '../../models/Booking.js';
import HousekeepingTask from '../../models/HousekeepingTask.js';
import Invoice from '../../models/Invoice.js';
import MaintenanceRequest from '../../models/MaintenanceRequest.js';
import Notification from '../../models/Notification.js';
import Payment from '../../models/Payment.js';
import ServiceOrder from '../../models/ServiceOrder.js';
import ServiceRequest from '../../models/ServiceRequest.js';
import Shift from '../../models/Shift.js';
import User from '../../models/User.js';
import BillingAccount from '../../models/BillingAccount.js';
import { ROLES } from '../../constants/index.js';
import { addDaysToKey, toLocalDateKey } from '../../utils/dates.js';
import { analyticsService } from '../analytics/analytics.service.js';
import { resolveRange } from '../analytics/range.js';
import { facilityService } from '../facilities/facility.service.js';
import { settingsService } from '../settings/settings.service.js';
import { shiftWindow, visibleStaffIds } from '../shifts/shift.service.js';

const counts = async (Model, match, field = 'status') => Object.fromEntries((await Model.aggregate([{ $match: match }, { $group: { _id: `$${field}`, n: { $sum: 1 } } }])).map((r) => [r._id, r.n]));

export const dashboardService = {
  async forCaller(caller) {
    const settings = await settingsService.get(); const tz = settings.timezone;
    const today = toLocalDateKey(new Date(), tz);
    const month = resolveRange({}, tz);
    const base = { role: caller.user.role, today, timezone: tz };
    if (caller.user.role === ROLES.ADMIN) return { ...base, ...(await this._admin(tz, month)) };
    if (caller.user.role === ROLES.MANAGER) return { ...base, ...(await this._manager(caller, tz, today, month)) };
    if (caller.user.role === ROLES.STAFF) return { ...base, ...(await this._staff(caller, tz, today)) };
    return { ...base, ...(await this._customer(caller, today)) };
  },

  async _admin(tz, month) {
    const year = Number(month.fromKey.slice(0, 4));
    const [revenue, occupancy, bookings, customers, staff, trend, activity] = await Promise.all([
      analyticsService.revenue(month), analyticsService.occupancy(month, tz),
      Booking.aggregate([{ $match: { createdAt: { $gte: month.start, $lt: month.end } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
      User.countDocuments({ role: ROLES.CUSTOMER, deletedAt: null }), User.countDocuments({ role: ROLES.STAFF, deletedAt: null, status: 'ACTIVE' }),
      analyticsService.monthly({ year }),
      AuditLog.find().sort({ createdAt: -1 }).limit(10).select('action resourceType resourceId actorId createdAt').lean(),
    ]);
    return {
      month: month.label,
      revenue: { netRevenueMinor: revenue.earned.netRevenueMinor, invoicedMinor: revenue.invoiced.totalMinor, collectedMinor: revenue.cash.netCollectedMinor, outstandingMinor: revenue.outstanding.totalMinor },
      bookings: { total: bookings.reduce((a, b) => a + b.n, 0), byStatus: Object.fromEntries(bookings.map((b) => [b._id, b.n])) },
      occupancy: { ratePercent: occupancy.occupancyRatePercent, current: occupancy.current }, totalCustomers: customers, totalStaff: staff,
      charts: { monthlyRevenue: trend.months.map((m) => ({ month: m.month, netRevenueMinor: m.netRevenueMinor, collectedMinor: m.collectedMinor })), revenueByCategory: [{ category: 'ROOM', amountMinor: revenue.earned.roomRevenueMinor }, { category: 'FOOD_AND_BEVERAGE', amountMinor: revenue.earned.fnbRevenueMinor }, { category: 'ADDITIONAL_SERVICE', amountMinor: revenue.earned.serviceRevenueMinor }, { category: 'SURCHARGE', amountMinor: revenue.earned.surchargeRevenueMinor }], roomOccupancy: occupancy.current },
      recentActivity: activity.map((a) => ({ ...a, id: String(a._id), _id: undefined })),
    };
  },

  async _manager(caller, tz, today, month) {
    const ids = await visibleStaffIds(caller); const managed = await facilityService.managedIds(caller);
    const [revenue, occupancy, arrivals, departures, pending, att, tasks, orders, maintenance, overdue] = await Promise.all([
      analyticsService.revenue(month), analyticsService.occupancy(month, tz),
      Booking.countDocuments({ status: 'CONFIRMED', checkInDate: today }), Booking.countDocuments({ status: 'CHECKED_IN', checkOutDate: today }), Booking.countDocuments({ status: 'PENDING' }),
      counts(Attendance, { staffId: { $in: ids }, date: today }), counts(HousekeepingTask, { status: { $in: ['PENDING', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED'] } }), counts(ServiceOrder, { status: { $in: ['PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'DELIVERING'] } }),
      MaintenanceRequest.find({ status: { $in: ['PENDING', 'ASSIGNED', 'IN_PROGRESS'] }, priority: { $in: ['HIGH', 'URGENT'] }, $or: [{ facilityId: { $in: managed } }, { facilityId: null }] }).limit(10).select('requestCode title priority status').lean(),
      MaintenanceRequest.countDocuments({ status: { $in: ['PENDING', 'ASSIGNED', 'IN_PROGRESS'] }, scheduledFor: { $lt: new Date() }, facilityId: { $in: managed } }),
    ]);
    return { currentOccupancy: occupancy.current, todaysCheckIns: arrivals, todaysCheckOuts: departures, pendingReservations: pending, staffAttendanceToday: att, housekeepingTasks: tasks, foodOrdersInProgress: orders, maintenanceAlerts: { urgentOpen: maintenance.map((m) => ({ ...m, id: String(m._id), _id: undefined })), overdueScheduled: overdue }, financialSummary: { month: month.label, netRevenueMinor: revenue.earned.netRevenueMinor, collectedMinor: revenue.cash.netCollectedMinor, outstandingMinor: revenue.outstanding.totalMinor } };
  },

  async _staff(caller, tz, today) {
    const me = caller.user._id; const now = new Date();
    const shifts = await Shift.find({ staffId: me, status: 'SCHEDULED', date: { $in: [addDaysToKey(today, -1), today, addDaysToKey(today, 1)] } });
    const current = shifts.find((s) => { const w = shiftWindow(s, tz); return now >= new Date(w.start.getTime() - 3_600_000) && now <= w.end; });
    const att = await Attendance.findOne({ staffId: me, status: 'OPEN' });
    const [hk, mt, sv, orders, arrivals, unread] = await Promise.all([
      HousekeepingTask.countDocuments({ assignedStaffId: me, status: { $in: ['ASSIGNED', 'IN_PROGRESS'] } }), MaintenanceRequest.countDocuments({ assignedStaffId: me, status: { $in: ['ASSIGNED', 'IN_PROGRESS'] } }), ServiceRequest.countDocuments({ assignedStaffId: me, status: { $in: ['ASSIGNED', 'IN_PROGRESS'] } }),
      caller.permissions.has('order:process') ? ServiceOrder.countDocuments({ status: { $in: ['PENDING', 'CONFIRMED', 'PREPARING', 'READY'] } }) : 0,
      caller.permissions.has('booking:checkin-checkout') ? Booking.countDocuments({ status: 'CONFIRMED', checkInDate: today }) : 0, Notification.countDocuments({ userId: me, readAt: null }),
    ]);
    return { assignedTasks: { housekeeping: hk, maintenance: mt, serviceRequests: sv }, currentShift: current ? { id: String(current._id), date: current.date, startTime: current.startTime, endTime: current.endTime } : null, attendance: { checkedIn: Boolean(att), since: att?.checkInAt ?? null }, pendingOrders: orders, arrivalsToday: arrivals, unreadNotifications: unread };
  },

  async _customer(caller, today) {
    const me = caller.user._id;
    const accounts = await BillingAccount.find({ customerId: me }).distinct('_id');
    const [current, upcoming, historyCount, orders, outstanding, payments, requests] = await Promise.all([
      Booking.findOne({ customerId: me, status: 'CHECKED_IN' }), Booking.find({ customerId: me, status: { $in: ['PENDING', 'CONFIRMED'] }, checkOutDate: { $gte: today } }).sort({ checkInDate: 1 }).limit(5),
      Booking.countDocuments({ customerId: me, status: { $in: ['CHECKED_OUT', 'CANCELLED', 'NO_SHOW', 'EXPIRED'] } }),
      ServiceOrder.find({ customerId: me }).sort({ createdAt: -1 }).limit(5), Invoice.find({ customerId: me, isActive: true, status: { $in: ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'] } }).select('invoiceNumber outstandingMinor dueAt status'),
      Payment.find({ billingAccountId: { $in: accounts } }).sort({ createdAt: -1 }).limit(5), ServiceRequest.find({ customerId: me }).sort({ createdAt: -1 }).limit(5),
    ]);
    return { currentBooking: current?.toJSON() ?? null, upcomingBookings: upcoming.map((b) => b.toJSON()), bookingHistoryCount: historyCount, recentOrders: orders.map((o) => o.toJSON()), outstandingInvoices: outstanding.map((i) => i.toJSON()), outstandingTotalMinor: outstanding.reduce((a, i) => a + i.outstandingMinor, 0), recentPayments: payments.map((p) => p.toJSON()), serviceRequests: requests.map((r) => r.toJSON()) };
  },
};
