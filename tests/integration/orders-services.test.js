import { as, cast, inDays, makeRooms, makeUser, models, setupDb, suite, uniq } from '../helpers/api.js';
import { orderService } from '../../src/modules/orders/order.service.js';

const { BillingCharge, BillingAccount, Payment, ServiceOrder, Booking } = models;

suite('menu, room-service orders and additional services (real MongoDB)', () => {
  setupDb();
  let c; let rooms; let stay; let items;
  const status = (u, id, s, extra = {}) => as(u).patch(`/api/orders/${id}/status`, { status: s, ...extra });
  const order = (u = c.customer, over = {}) => as(u).post('/api/orders', { items: [{ menuItemId: items.pho.id, quantity: 2 }], paymentMethod: 'ROOM_CHARGE', ...over });
  const walk = async (id, upTo) => { for (const s of ['CONFIRMED', 'PREPARING', 'READY', 'DELIVERING', 'DELIVERED'].slice(0, upTo)) { const r = await status(c.kitchen, id, s); if (r.status !== 200) return r; } };
  const checkedInStay = async (customer = c.customer, roomId = rooms[0].id) => {
    const g = (await as(c.reception).post('/api/guests', { fullName: 'Stay Guest', phone: `+8495${String(Date.now()).slice(-7)}`, identification: { type: 'PASSPORT', number: uniq('S').toUpperCase().slice(0, 9) } })).body.data.guest;
    const b = (await as(c.reception).post('/api/bookings', { rooms: [roomId], checkInDate: await inDays(0), checkOutDate: await inDays(2), adults: 1, guestIds: [g.id], customerId: String(customer._id) })).body.data;
    await as(c.reception).post(`/api/bookings/${b.id}/check-in`);
    return b;
  };

  beforeAll(async () => {
    const admin = await makeUser('ADMIN');
    await as(admin).post('/api/tax-rules', { code: 'VAT', name: 'VAT', rateBps: 1000, appliesTo: ['ROOM', 'FOOD_AND_BEVERAGE', 'ADDITIONAL_SERVICE', 'SURCHARGE'], effectiveFrom: '2020-01-01' });
  });
  beforeEach(async () => {
    c = await cast(); ({ rooms } = await makeRooms(c.admin, 2, { price: 1_000_000 }));
    const cat = (await as(c.manager).post('/api/menu/categories', { name: uniq('Mains') })).body.data;
    const mk = async (name, priceMinor, extra = {}) => (await as(c.manager).post('/api/menu/items', { categoryId: cat.id, name, priceMinor, ...extra })).body.data;
    items = { cat, pho: await mk('Pho', 80_000), coffee: await mk('Coffee', 30_000), soldOut: await mk('Lobster', 900_000, { availability: false }) };
    stay = await checkedInStay();
  });

  describe('menu', () => {
    test('browse, filter, hide unavailable categories; only managers edit', async () => {
      const menu = (await as(c.customer).get('/api/menu')).body.data;
      const mine = menu.find((m) => m.id === items.cat.id);
      expect(mine.items.map((i) => i.name).sort()).toEqual(['Coffee', 'Lobster', 'Pho']);
      expect((await as(c.customer).get(`/api/menu?categoryId=${items.cat.id}&available=true&maxPrice=50000`)).body.data[0].items.map((i) => i.name)).toEqual(['Coffee']);
      expect((await as(c.customer).post('/api/menu/items', { categoryId: items.cat.id, name: 'x', priceMinor: 1 })).status).toBe(403);
      expect((await as(c.kitchen).post('/api/menu/categories', { name: 'x' })).status).toBe(403);
      expect((await as(c.manager).post('/api/menu/items', { categoryId: items.cat.id, name: 'x', priceMinor: 1.5 })).status).toBe(422);
      await as(c.manager).patch(`/api/menu/categories/${items.cat.id}`, { status: 'INACTIVE' });
      expect((await as(c.customer).get('/api/menu')).body.data.some((m) => m.id === items.cat.id)).toBe(false);
      expect((await as(c.manager).get('/api/menu?includeInactive=true')).body.data.some((m) => m.id === items.cat.id)).toBe(true);
      await as(c.manager).patch(`/api/menu/categories/${items.cat.id}`, { status: 'ACTIVE' });
    });
  });

  describe('ordering rules', () => {
    test('only a checked-in guest, on their own booking, can order; items are validated', async () => {
      expect((await order(c.customer2)).body.code).toBe('NO_ACTIVE_STAY');
      expect((await order(c.customer2, { bookingId: stay.id })).body.code).toBe('NO_ACTIVE_STAY'); // someone else's booking
      expect((await order(c.reception)).status).toBe(403);
      expect((await order(c.customer, { items: [{ menuItemId: items.soldOut.id, quantity: 1 }] })).body.code).toBe('ITEM_UNAVAILABLE');
      expect((await order(c.customer, { items: [{ menuItemId: items.pho.id, quantity: 51 }] })).status).toBe(422);
      expect((await order(c.customer, { items: [] })).status).toBe(422);
      expect((await order(c.customer, { roomId: rooms[1].id })).body.code).toBe('ROOM_REQUIRED'); // not their room
      const guestNotInHouse = await makeUser('CUSTOMER');
      const fres = (await as(c.reception).post('/api/bookings', { rooms: [rooms[1].id], checkInDate: await inDays(5), checkOutDate: await inDays(6), adults: 1, guestIds: [(await as(c.reception).post('/api/guests', { fullName: 'Future Guest', phone: `+8496${String(Date.now()).slice(-7)}` })).body.data.guest.id], customerId: String(guestNotInHouse._id) }));
      if (fres.status !== 201) throw new Error(JSON.stringify(fres.body));
      const future = fres.body.data;
      expect((await order(guestNotInHouse, { bookingId: future.id })).body.code).toBe('NO_ACTIVE_STAY'); // booked but not checked in
    });

    test('totals, duplicate lines, and frozen price/name snapshots', async () => {
      const res = await order(c.customer, { items: [{ menuItemId: items.pho.id, quantity: 2 }, { menuItemId: items.coffee.id, quantity: 1, note: 'no sugar' }, { menuItemId: items.pho.id, quantity: 1 }] });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ status: 'PENDING', subtotalMinor: 3 * 80_000 + 30_000, deliveryLocation: expect.stringContaining('Room'), customerId: String(c.customer._id) });
      expect(res.body.data.orderCode).toMatch(/^ORD-\d{6}$/);
      expect(res.body.data.items.find((i) => i.name === 'Pho').quantity).toBe(3);
      await as(c.manager).patch(`/api/menu/items/${items.pho.id}`, { priceMinor: 999_000, name: 'Renamed' });
      const again = (await as(c.customer).get(`/api/orders/${res.body.data.id}`)).body.data;
      expect(again.subtotalMinor).toBe(270_000);
      expect(again.items.find((i) => i.name === 'Pho').priceMinor).toBe(80_000);
      await as(c.manager).patch(`/api/menu/items/${items.pho.id}`, { priceMinor: 80_000, name: 'Pho' });
    });

    test('visibility: guests see their own orders; kitchen staff see all; others none', async () => {
      const o = (await order()).body.data;
      expect((await as(c.customer2).get(`/api/orders/${o.id}`)).status).toBe(404);
      expect((await as(c.customer2).get('/api/orders')).body.meta.total).toBe(0);
      expect((await as(c.kitchen).get('/api/orders?active=true')).body.meta.total).toBeGreaterThanOrEqual(1);
      expect((await as(c.housekeeper).get('/api/orders')).status).toBe(403);
      expect((await as(c.customer).get('/api/orders')).body.meta.total).toBe(1);
    });
  });

  describe('workflow and billing', () => {
    test('status transitions follow the workflow and need kitchen permission', async () => {
      const o = (await order()).body.data;
      expect((await status(c.customer, o.id, 'CONFIRMED')).status).toBe(403);
      expect((await status(c.housekeeper, o.id, 'CONFIRMED')).status).toBe(403);
      expect((await status(c.kitchen, o.id, 'READY')).body.code).toBe('INVALID_STATE_TRANSITION');
      expect((await status(c.kitchen, o.id, 'REJECTED')).status).toBe(422); // reason required
      expect((await status(c.kitchen, o.id, 'CONFIRMED')).status).toBe(200);
      expect((await status(c.kitchen, o.id, 'PREPARING')).body.data.assignedStaffId).toBe(String(c.kitchen._id));
      expect((await status(c.kitchen, o.id, 'CONFIRMED')).body.code).toBe('INVALID_STATE_TRANSITION');
      const r = await order(); expect((await status(c.kitchen, r.body.data.id, 'REJECTED', { reason: 'Out of stock' })).body.data.status).toBe('REJECTED');
      expect((await ServiceOrder.findById(o.id)).statusHistory.map((h) => h.status)).toEqual(['PENDING', 'CONFIRMED', 'PREPARING']);
    });

    test('room charge: delivery creates exactly ONE F&B charge and no payment; double delivery is impossible', async () => {
      const o = (await order()).body.data; // 160,000
      await walk(o.id, 4);
      expect(await BillingCharge.countDocuments({ bookingId: stay.id, sourceType: 'FNB_ORDER' })).toBe(0); // nothing billed before delivery
      const race = await Promise.all([1, 2, 3, 4].map(() => status(c.kitchen, o.id, 'DELIVERED')));
      expect(race.filter((r) => r.status === 200)).toHaveLength(1);
      expect(race.filter((r) => r.status !== 200).every((r) => ['INVALID_STATE_TRANSITION', 'ORDER_CHANGED'].includes(r.body.code))).toBe(true);
      const charges = await BillingCharge.find({ sourceType: 'FNB_ORDER', sourceId: o.id });
      expect(charges).toHaveLength(1);
      expect(charges[0]).toMatchObject({ category: 'FOOD_AND_BEVERAGE', amountMinor: 160_000, status: 'POSTED' });
      expect(await Payment.countDocuments({ bookingId: stay.id })).toBe(0); // a room charge is NOT money received
      expect((await BillingAccount.findById(stay.billing.accountId))).toMatchObject({ paidMinor: 0, totalChargesMinor: 2_160_000 });
      const draft = (await as(c.manager).post(`/api/billing-accounts/${stay.billing.accountId}/invoices`)).body.data;
      expect(draft.lineItems.filter((l) => l.category === 'FOOD_AND_BEVERAGE')).toHaveLength(1);
      expect(draft).toMatchObject({ subtotalMinor: 2_160_000, taxTotalMinor: 216_000 });
    });

    test('paying on delivery records the payment and the charge together', async () => {
      const o = (await order(c.customer, { paymentMethod: 'CASH' })).body.data;
      await walk(o.id, 5);
      const pay = await Payment.findOne({ bookingId: stay.id });
      expect(pay).toMatchObject({ amountMinor: 160_000, method: 'CASH', status: 'SUCCEEDED', receivedBy: c.kitchen._id });
      expect((await BillingAccount.findById(stay.billing.accountId)).paidMinor).toBe(160_000);
      expect(await BillingCharge.countDocuments({ sourceType: 'FNB_ORDER', sourceId: o.id })).toBe(1);
    });

    test('delivery after the guest has checked out is refused and nothing is half-written', async () => {
      const o = (await order()).body.data; await walk(o.id, 4);
      await Booking.updateOne({ _id: stay.id }, { $set: { status: 'CHECKED_OUT' } });
      expect((await status(c.kitchen, o.id, 'DELIVERED')).body.code).toBe('BOOKING_NOT_ACTIVE');
      expect((await ServiceOrder.findById(o.id)).status).toBe('DELIVERING');
      expect(await BillingCharge.countDocuments({ bookingId: stay.id, sourceType: 'FNB_ORDER' })).toBe(0);
      await Booking.updateOne({ _id: stay.id }, { $set: { status: 'CHECKED_IN' } });
    });

    test('cancellation: guests until the kitchen starts, managers until delivery; cancelled orders are never billed', async () => {
      const a = (await order()).body.data;
      expect((await as(c.customer2).post(`/api/orders/${a.id}/cancel`, { reason: 'not mine' })).status).toBe(404);
      expect((await as(c.customer).post(`/api/orders/${a.id}/cancel`, { reason: 'Changed my mind' })).body.data.status).toBe('CANCELLED');
      const b = (await order()).body.data; await walk(b.id, 2);
      expect((await as(c.customer).post(`/api/orders/${b.id}/cancel`, { reason: 'too late now' })).body.code).toBe('INVALID_STATE_TRANSITION');
      expect((await as(c.kitchen).post(`/api/orders/${b.id}/cancel`, { reason: 'x1x' })).status).toBe(403);
      expect((await as(c.manager).post(`/api/orders/${b.id}/cancel`, { reason: 'Kitchen fire' })).body.data.status).toBe('CANCELLED');
      expect(await BillingCharge.countDocuments({ bookingId: stay.id, sourceType: 'FNB_ORDER' })).toBe(0);
    });

    test('completion: by guest or staff, and automatically an hour after delivery', async () => {
      const a = (await order()).body.data; await walk(a.id, 5);
      expect((await as(c.customer).post(`/api/orders/${a.id}/complete`)).body.data.status).toBe('COMPLETED');
      expect((await as(c.customer).post(`/api/orders/${a.id}/complete`)).body.code).toBe('INVALID_STATE_TRANSITION');
      const b = (await order()).body.data; await walk(b.id, 5);
      expect((await ServiceOrder.findById(b.id)).status).toBe('DELIVERED');
      expect(await orderService.autoComplete(new Date(Date.now() + 2 * 3_600_000))).toBeGreaterThanOrEqual(1);
      expect((await ServiceOrder.findById(b.id)).status).toBe('COMPLETED');
    });
  });

  describe('additional services', () => {
    let spa; let laundry; let transfer;
    const request = (u, over) => as(u).post('/api/service-requests', { bookingId: stay.id, hotelServiceId: laundry.id, ...over });
    beforeEach(async () => {
      const mk = async (body) => (await as(c.manager).post('/api/services', { description: 'd', ...body })).body.data;
      spa = await mk({ name: uniq('Spa'), category: 'SPA', priceMinor: 500_000, pricingType: 'PER_PERSON' });
      laundry = await mk({ name: uniq('Laundry'), category: 'LAUNDRY', priceMinor: 40_000, pricingType: 'PER_UNIT' });
      transfer = await mk({ name: uniq('Airport'), category: 'TRANSPORT', priceMinor: 350_000, pricingType: 'FIXED' });
    });

    test('catalogue: guests see active services; managers manage', async () => {
      expect((await as(c.customer).post('/api/services', { name: 'x', priceMinor: 1 })).status).toBe(403);
      await as(c.manager).patch(`/api/services/${spa.id}`, { status: 'INACTIVE' });
      expect((await as(c.customer).get('/api/services?limit=100')).body.data.map((s) => s.id)).not.toContain(spa.id);
      expect((await as(c.manager).get('/api/services?limit=100')).body.data.map((s) => s.id)).toContain(spa.id);
      expect((await as(c.manager).post('/api/services', { name: 'bad', priceMinor: 10.5 })).status).toBe(422);
    });

    test('request pricing by type, snapshots, and who may request what', async () => {
      const r = (await request(c.customer, { hotelServiceId: laundry.id, quantity: 5 })).body.data;
      expect(r).toMatchObject({ quantity: 5, totalMinor: 200_000, status: 'REQUESTED', serviceSnapshot: { name: laundry.name, unitPriceMinor: 40_000 } });
      expect((await request(c.customer, { hotelServiceId: transfer.id, quantity: 4 })).body.data).toMatchObject({ quantity: 1, totalMinor: 350_000 }); // FIXED ignores quantity
      await as(c.manager).patch(`/api/services/${laundry.id}`, { priceMinor: 99_000 });
      expect((await as(c.customer).get(`/api/service-requests/${r.id}`)).body.data.totalMinor).toBe(200_000);
      expect((await request(c.customer2, {})).status).toBe(404); // another guest's booking
      expect((await request(c.reception, {})).status).toBe(403);
      await as(c.manager).patch(`/api/services/${spa.id}`, { status: 'INACTIVE' });
      expect((await request(c.customer, { hotelServiceId: spa.id })).body.code).toBe('SERVICE_UNAVAILABLE');
      expect((await request(c.customer, { quantity: 0 })).status).toBe(422);
    });

    test('fulfilment workflow: assignment rules, only the assignee progresses, completion bills ONE charge', async () => {
      const r = (await request(c.customer, { quantity: 3 })).body.data;
      const patch = (u, s, extra = {}) => as(u).patch(`/api/service-requests/${r.id}/status`, { status: s, ...extra });
      expect((await patch(c.reception, 'ASSIGNED')).status).toBe(403); // no fulfilment permission
      expect((await patch(c.customer, 'ASSIGNED')).status).toBe(403);
      expect((await patch(c.manager, 'ASSIGNED', { assignedStaffId: String(c.reception._id) })).body.code).toBe('INVALID_ASSIGNEE');
      expect((await patch(c.housekeeper, 'IN_PROGRESS')).body.code).toBe('INVALID_STATE_TRANSITION');
      expect((await patch(c.housekeeper, 'ASSIGNED')).body.data.assignedStaffId).toBe(String(c.housekeeper._id)); // picks the job up
      const other = await (await import('../helpers/api.js')).makeStaff('HOUSEKEEPING', c.manager._id);
      expect((await patch(other, 'IN_PROGRESS')).status).toBe(403);
      expect((await patch(c.housekeeper, 'IN_PROGRESS')).status).toBe(200);
      expect(await BillingCharge.countDocuments({ bookingId: stay.id, sourceType: 'SERVICE_REQUEST' })).toBe(0);
      const race = await Promise.all([1, 2, 3].map(() => patch(c.housekeeper, 'COMPLETED')));
      expect(race.filter((x) => x.status === 200)).toHaveLength(1);
      const charges = await BillingCharge.find({ sourceType: 'SERVICE_REQUEST', sourceId: r.id });
      expect(charges).toHaveLength(1);
      expect(charges[0]).toMatchObject({ category: 'ADDITIONAL_SERVICE', quantity: 3, unitPriceMinor: 40_000, amountMinor: 120_000 });
      expect((await as(c.customer).post(`/api/service-requests/${r.id}/cancel`, { reason: 'too late' })).body.code).toBe('INVALID_STATE_TRANSITION');
    });

    test('billing needs an in-house guest; cancel rules; queue visibility', async () => {
      const r = (await request(c.customer)).body.data;
      await as(c.housekeeper).patch(`/api/service-requests/${r.id}/status`, { status: 'ASSIGNED' });
      await as(c.housekeeper).patch(`/api/service-requests/${r.id}/status`, { status: 'IN_PROGRESS' });
      await Booking.updateOne({ _id: stay.id }, { $set: { status: 'CHECKED_OUT' } });
      expect((await as(c.housekeeper).patch(`/api/service-requests/${r.id}/status`, { status: 'COMPLETED' })).body.code).toBe('BOOKING_NOT_ACTIVE');
      expect(await BillingCharge.countDocuments({ bookingId: stay.id, sourceType: 'SERVICE_REQUEST' })).toBe(0);
      await Booking.updateOne({ _id: stay.id }, { $set: { status: 'CHECKED_IN' } });

      const q = (await request(c.customer)).body.data;
      expect((await as(c.customer2).post(`/api/service-requests/${q.id}/cancel`, { reason: 'not mine' })).status).toBe(404);
      expect((await as(c.customer).post(`/api/service-requests/${q.id}/cancel`, { reason: 'Changed plans' })).body.data.status).toBe('CANCELLED');
      expect((await as(c.customer2).get('/api/service-requests')).body.meta.total).toBe(0);
      expect((await as(c.customer).get('/api/service-requests')).body.meta.total).toBe(2);
      const fresh = (await request(c.customer)).body.data;
      expect((await as(c.housekeeper).get('/api/service-requests')).body.data.map((x) => x.id)).toContain(fresh.id); // the open queue
      expect((await as(c.reception).get('/api/service-requests')).status).toBe(403);
    });
  });
});
