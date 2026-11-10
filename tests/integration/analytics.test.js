import { as, cast, inDays, makeRooms, makeUser, models, setupDb, suite, today, uniq } from '../helpers/api.js';
import { resolveRange, previousRange } from '../../src/modules/analytics/range.js';

const { BillingCharge, Invoice } = models;
const TZ = 'Asia/Ho_Chi_Minh';
const hmOf = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);

suite('analytics and dashboards (real MongoDB)', () => {
  setupDb();
  let c; let rooms; let range; let invoiceA;

  beforeAll(async () => {
    c = await cast();
    const admin = c.admin;
    await as(admin).post('/api/tax-rules', { code: 'VAT', name: 'VAT', rateBps: 1000, appliesTo: ['ROOM', 'FOOD_AND_BEVERAGE', 'ADDITIONAL_SERVICE', 'SURCHARGE'], effectiveFrom: '2020-01-01' });
    ({ rooms } = await makeRooms(admin, 2, { price: 1_000_000 }));
    range = `from=${await inDays(-1)}&to=${await inDays(7)}`;
    const guest = async () => (await as(c.reception).post('/api/guests', { fullName: 'Report Guest', phone: `+8497${String(Date.now()).slice(-7)}`, identification: { type: 'PASSPORT', number: uniq('R').toUpperCase().slice(0, 9) } })).body.data.guest;

    // --- stay A: full stay with room service, laundry, a discount, early check-out with an authorised balance
    const a = (await as(c.reception).post('/api/bookings', { rooms: [rooms[0].id], checkInDate: await inDays(0), checkOutDate: await inDays(2), adults: 1, guestIds: [(await guest()).id], customerId: String(c.customer._id) })).body.data;
    await as(c.reception).post(`/api/bookings/${a.id}/check-in`);
    const o = (await as(c.customer).post('/api/orders', { items: [], paymentMethod: 'ROOM_CHARGE' })); // invalid on purpose (empty)
    expect(o.status).toBe(422);
    const cat = (await as(c.manager).post('/api/menu/categories', { name: uniq('Mains') })).body.data;
    const pho = (await as(c.manager).post('/api/menu/items', { categoryId: cat.id, name: 'Pho', priceMinor: 80_000 })).body.data;
    const ord = (await as(c.customer).post('/api/orders', { items: [{ menuItemId: pho.id, quantity: 2 }], paymentMethod: 'ROOM_CHARGE' })).body.data;
    for (const s of ['CONFIRMED', 'PREPARING', 'READY', 'DELIVERING', 'DELIVERED']) await as(c.kitchen).patch(`/api/orders/${ord.id}/status`, { status: s });
    const cancelled = (await as(c.customer).post('/api/orders', { items: [{ menuItemId: pho.id, quantity: 1 }], paymentMethod: 'ROOM_CHARGE' })).body.data;
    await as(c.customer).post(`/api/orders/${cancelled.id}/cancel`, { reason: 'Changed my mind' });
    const laundry = (await as(c.manager).post('/api/services', { name: uniq('Laundry'), priceMinor: 40_000, pricingType: 'PER_UNIT' })).body.data;
    const sr = (await as(c.customer).post('/api/service-requests', { bookingId: a.id, hotelServiceId: laundry.id, quantity: 5 })).body.data;
    for (const s of ['ASSIGNED', 'IN_PROGRESS', 'COMPLETED']) await as(c.housekeeper).patch(`/api/service-requests/${sr.id}/status`, { status: s });
    await as(c.manager).post(`/api/billing-accounts/${a.billing.accountId}/charges`, { category: 'DISCOUNT', description: 'Loyalty', unitPriceMinor: 50_000 });
    const out = await as(c.manager).post(`/api/bookings/${a.id}/check-out`, { authorizeOutstanding: true, reason: 'Corporate' });
    invoiceA = out.body.data.invoice;
    await as(c.reception).post('/api/payments', { accountId: a.billing.accountId, amountMinor: 1_000_000, method: 'CASH', idempotencyKey: uniq('pay-a-') });

    // --- stay B: booked for tomorrow, paid 1.5m, cancelled late (1 night fee), 500k refunded
    const b = (await as(c.reception).post('/api/bookings', { rooms: [rooms[1].id], checkInDate: await inDays(1), checkOutDate: await inDays(3), adults: 1, guestIds: [(await guest()).id], customerId: String(c.customer2._id) })).body.data;
    const pay = (await as(c.reception).post('/api/payments', { bookingId: b.id, amountMinor: 1_500_000, method: 'CASH', idempotencyKey: uniq('pay-b-') })).body.data;
    await as(c.customer2).post(`/api/bookings/${b.id}/cancel`, { reason: 'Sick' });
    await as(c.manager).post(`/api/payments/${pay.id}/refund`, { amountMinor: 500_000, reason: 'Partial refund after fee' });

    // --- maintenance with a cost, a shift with a late check-in
    const gym = (await as(c.manager).post('/api/facilities', { name: uniq('Gym'), type: 'GYM' })).body.data;
    const eq = (await as(c.manager).post('/api/equipment', { name: 'Treadmill', facilityId: gym.id })).body.data;
    const mr = (await as(c.reception).post('/api/maintenance', { equipmentId: eq.id, title: 'Belt slipping' })).body.data;
    await as(c.manager).post(`/api/maintenance/${mr.id}/assign`, { assignedStaffId: String(c.maintenance._id) });
    await as(c.maintenance).post(`/api/maintenance/${mr.id}/start`);
    await as(c.maintenance).post(`/api/maintenance/${mr.id}/complete`, { actualCostMinor: 700_000 });
    const started = new Date(Date.now() - 30 * 60_000);
    await as(c.manager).post('/api/shifts', { staffId: String(c.reception._id), date: new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(started), startTime: hmOf(started), endTime: hmOf(new Date(Date.now() + 8 * 3_600_000)) });
    await as(c.reception).post('/api/attendance/check-in');
  });

  test('range resolution: month, quarter, year, custom; previous period; validation', () => {
    expect(resolveRange({ period: 'month', year: 2026, month: 12 }, TZ)).toMatchObject({ fromKey: '2026-12-01', toKey: '2027-01-01', days: 31, label: '2026-12' });
    expect(resolveRange({ period: 'quarter', year: 2026, quarter: 4 }, TZ)).toMatchObject({ fromKey: '2026-10-01', toKey: '2027-01-01', days: 92 });
    expect(resolveRange({ period: 'year', year: 2028 }, TZ).days).toBe(366);
    const custom = resolveRange({ from: '2026-11-01', to: '2026-11-30' }, TZ);
    expect(custom).toMatchObject({ toKey: '2026-12-01', days: 30 });
    expect(custom.start.toISOString()).toBe('2026-10-31T17:00:00.000Z'); // hotel-local midnight
    expect(previousRange(custom, TZ)).toMatchObject({ fromKey: '2026-10-02', toKey: '2026-11-01', days: 30 });
    expect(() => resolveRange({ from: '2026-11-01' }, TZ)).toThrow();
    expect(() => resolveRange({ from: '2026-11-10', to: '2026-11-01' }, TZ)).toThrow();
  });

  test('revenue: every figure matches the scenario, and the ledger is the single source (no double counting)', async () => {
    const r = (await as(c.manager).get(`/api/analytics/revenue?${range}`)).body.data;
    expect(r.earned).toEqual({ roomRevenueMinor: 2_000_000, fnbRevenueMinor: 160_000, serviceRevenueMinor: 200_000, surchargeRevenueMinor: 1_000_000, discountsMinor: 50_000, netRevenueMinor: 3_310_000 });
    const ledger = await BillingCharge.aggregate([{ $match: { status: 'POSTED' } }, { $group: { _id: null, t: { $sum: '$amountMinor' } } }]);
    expect(r.earned.netRevenueMinor).toBe(ledger[0].t); // identical to the ledger total
    expect(r.invoiced).toMatchObject({ invoices: 1, totalMinor: invoiceA.grandTotalMinor, taxesMinor: invoiceA.taxTotalMinor, discountsMinor: 50_000 });
    expect(invoiceA.grandTotalMinor).toBe(2_541_000);
    expect(r.cash).toMatchObject({ collectedMinor: 2_500_000, refundsMinor: 500_000, netCollectedMinor: 2_000_000, payments: 2, refunds: 1 });
    expect(r.outstanding).toMatchObject({ invoices: 1, totalMinor: 1_541_000 });
    expect(r.expenses).toMatchObject({ maintenanceMinor: 700_000, repairs: 1 });
    expect(r.definitions.cash).toMatch(/payment date/);
    expect((await Invoice.countDocuments({ isActive: true, status: { $nin: ['DRAFT', 'VOID'] } }))).toBe(1);
  });

  test('revenue is period-aware: a range that excludes the activity reports zero', async () => {
    const r = (await as(c.manager).get('/api/analytics/revenue?from=2020-01-01&to=2020-01-31')).body.data;
    expect(r.earned.netRevenueMinor).toBe(0);
    expect(r.cash.collectedMinor).toBe(0);
    expect(r.outstanding.totalMinor).toBe(1_541_000); // outstanding is "as of now", not period-based
  });

  test('occupancy, ADR and RevPAR follow the documented definitions', async () => {
    const o = (await as(c.manager).get(`/api/analytics/occupancy?${range}`)).body.data;
    expect(o).toMatchObject({ totalRooms: 2, days: 9, availableNights: 18, soldNights: 1, billedRoomNights: 2, roomRevenueMinor: 2_000_000, adrMinor: 1_000_000, revparMinor: 111_111, occupancyRatePercent: 5.56 });
    expect(o.current.total).toBe(2);
    expect(o.current.cleaning).toBe(1); // room A awaits housekeeping
  });

  test('food & beverage: counts, average order value, best sellers, categories', async () => {
    const f = (await as(c.manager).get(`/api/analytics/food-beverage?${range}`)).body.data;
    expect(f).toMatchObject({ totalOrders: 2, deliveredOrders: 1, cancelledOrders: 1, revenueMinor: 160_000, averageOrderValueMinor: 160_000 });
    expect(f.bestSelling[0]).toEqual({ item: 'Pho', quantity: 2, revenueMinor: 160_000 });
    expect(f.revenueByCategory.reduce((a, x) => a + x.revenueMinor, 0)).toBe(f.revenueMinor); // order breakdown == billing revenue
  });

  test('staff analytics are team-scoped; maintenance analytics are facility-scoped', async () => {
    const s = (await as(c.manager).get(`/api/analytics/staff?${range}`)).body.data;
    expect(s).toMatchObject({ totalStaff: 4, scheduledShifts: 1, present: 1, absent: 0, late: 1, attendanceRatePercent: 100 });
    expect(s.byDepartment).toHaveLength(1);
    const stranger = await makeUser('MANAGER');
    expect((await as(stranger).get(`/api/analytics/staff?${range}`)).body.data).toMatchObject({ totalStaff: 0, scheduledShifts: 0 });
    expect((await as(c.admin).get(`/api/analytics/staff?${range}`)).body.data.totalStaff).toBe(4);
    const m = (await as(c.manager).get(`/api/analytics/maintenance?${range}`)).body.data;
    expect(m).toMatchObject({ totalFacilities: 1, totalEquipment: 1, maintenanceCostMinor: 700_000, repairs: 1, totalRequests: 1, overdueMaintenance: 0 });
    expect(m.mostFrequentlyServiced[0]).toMatchObject({ name: 'Treadmill', requests: 1 });
    expect((await as(stranger).get(`/api/analytics/maintenance?${range}`)).body.data).toMatchObject({ totalFacilities: 0, totalEquipment: 0, maintenanceCostMinor: 0 });
    expect((await as(c.admin).get(`/api/analytics/maintenance?${range}`)).body.data.maintenanceCostMinor).toBe(700_000);
  });

  test('overview compares with the previous period; monthly returns 12 months and year-over-year', async () => {
    const ov = (await as(c.admin).get(`/api/analytics/overview?${range}`)).body.data;
    expect(ov.current).toMatchObject({ netRevenueMinor: 3_310_000, collectedMinor: 2_000_000, invoicedMinor: 2_541_000 });
    expect(ov.previous.netRevenueMinor).toBe(0);
    expect(ov.changePercent.netRevenue).toBeNull(); // no baseline, so no percentage
    const year = Number((await today()).slice(0, 4));
    const mo = (await as(c.admin).get(`/api/analytics/monthly?year=${year}&compareYear=${year - 1}`)).body.data;
    expect(mo.months).toHaveLength(12);
    expect(mo.compareMonths).toHaveLength(12);
    expect(mo.months.reduce((a, m) => a + m.collectedMinor, 0)).toBe(2_000_000);
    expect(mo.months.reduce((a, m) => a + m.fnbRevenueMinor, 0)).toBe(160_000);
    expect(mo.months.reduce((a, m) => a + m.maintenanceExpenseMinor, 0)).toBe(700_000);
    expect(mo.compareMonths.every((m) => m.netRevenueMinor === 0)).toBe(true);
  });

  test('access control and parameter validation', async () => {
    for (const u of [c.reception, c.housekeeper, c.customer]) {
      for (const p of ['revenue', 'occupancy', 'overview', 'staff', 'maintenance', 'food-beverage', 'monthly']) expect((await as(u).get(`/api/analytics/${p}`)).status).toBe(403);
    }
    for (const bad of ['from=2026-11-01', 'from=2026-11-10&to=2026-11-01', 'month=13', 'period=decade', 'quarter=5']) expect((await as(c.manager).get(`/api/analytics/revenue?${bad}`)).status).toBe(422);
    expect((await as(c.manager).get('/api/analytics/revenue?period=year')).status).toBe(200);
  });

  describe('dashboards', () => {
    test('Admin: money, bookings, occupancy, charts and recent activity', async () => {
      const d = (await as(c.admin).get('/api/dashboard')).body.data;
      expect(d).toMatchObject({ role: 'ADMIN', totalStaff: 4, revenue: { collectedMinor: 2_000_000, outstandingMinor: 1_541_000 } });
      expect(d.totalCustomers).toBeGreaterThanOrEqual(2);
      expect(d.bookings.byStatus.CANCELLED).toBe(1);
      expect(d.charts.monthlyRevenue).toHaveLength(12);
      expect(d.recentActivity.length).toBeGreaterThan(0);
      expect(d.recentActivity.length).toBeLessThanOrEqual(10);
    });
    test('Manager: operations board and a financial summary', async () => {
      const d = (await as(c.manager).get('/api/dashboard')).body.data;
      expect(d).toMatchObject({ role: 'MANAGER', todaysCheckIns: 0, todaysCheckOuts: 0, pendingReservations: 0, foodOrdersInProgress: {}, financialSummary: { collectedMinor: 2_000_000 } });
      expect(d.staffAttendanceToday).toMatchObject({ OPEN: 1 });
      expect(d.housekeepingTasks.PENDING).toBe(1);
      expect(d.currentOccupancy.cleaning).toBe(1);
    });
    test('Staff: own tasks, shift and attendance; no financial data', async () => {
      const d = (await as(c.reception).get('/api/dashboard')).body.data;
      expect(d.role).toBe('STAFF');
      expect(d.currentShift).toBeTruthy();
      expect(d.attendance.checkedIn).toBe(true);
      expect(d).not.toHaveProperty('financialSummary');
      expect(d).not.toHaveProperty('revenue');
      const hk = (await as(c.housekeeper).get('/api/dashboard')).body.data;
      expect(hk.assignedTasks).toMatchObject({ housekeeping: 0, serviceRequests: 0 });
      expect(hk.currentShift).toBeNull();
    });
    test('Customer: only their own stay, orders, balance and payments', async () => {
      const d = (await as(c.customer).get('/api/dashboard')).body.data;
      expect(d).toMatchObject({ role: 'CUSTOMER', currentBooking: null, bookingHistoryCount: 1, outstandingTotalMinor: 1_541_000 });
      expect(d.recentOrders).toHaveLength(2);
      expect(d.outstandingInvoices).toHaveLength(1);
      expect(d.recentPayments).toHaveLength(1);
      expect(d.serviceRequests).toHaveLength(1);
      const d2 = (await as(c.customer2).get('/api/dashboard')).body.data;
      expect(d2).toMatchObject({ bookingHistoryCount: 1, outstandingTotalMinor: 0, upcomingBookings: [], recentOrders: [] });
      expect(d2.recentPayments).toHaveLength(1);
      expect((await (await import('../helpers/api.js')).request(( await import('../helpers/api.js')).app).get('/api/dashboard')).status).toBe(401);
    });
  });
});
