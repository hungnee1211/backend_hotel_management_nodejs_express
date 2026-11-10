import { as, cast, inDays, makeRooms, models, setupDb, suite, uniq } from '../helpers/api.js';
import { bookingService } from '../../src/modules/bookings/booking.service.js';
import { billingService } from '../../src/modules/billing/billing.service.js';

const { Booking, BillingAccount, BillingCharge, RoomNight, Room, HousekeepingTask, Invoice } = models;

suite('bookings, stays and housekeeping (real MongoDB)', () => {
  setupDb();
  let c; let type; let rooms;
  const guest = async (withId = true) => (await as(c.reception).post('/api/guests', { fullName: 'Guest ' + uniq('g'), phone: `+8493${String(Date.now()).slice(-7)}`, ...(withId ? { identification: { type: 'PASSPORT', number: uniq('P').toUpperCase().slice(0, 9) } } : {}) })).body.data.guest;
  const book = async (who, over = {}) => as(who).post('/api/bookings', { rooms: [rooms[0].id], checkInDate: await inDays(10), checkOutDate: await inDays(12), adults: 2, ...over });
  const staffBook = async (over = {}) => book(c.reception, { guestIds: [(await guest()).id], ...over });
  const setSettings = (p) => as(c.admin).patch('/api/settings', p);

  beforeAll(async () => {
    const admin = await (await import('../helpers/api.js')).makeUser('ADMIN');
    await as(admin).post('/api/tax-rules', { code: 'VAT', name: 'VAT', rateBps: 1000, appliesTo: ['ROOM', 'FOOD_AND_BEVERAGE', 'ADDITIONAL_SERVICE', 'SURCHARGE'], effectiveFrom: '2020-01-01' });
  });
  beforeEach(async () => { c = await cast(); ({ type, rooms } = await makeRooms(c.admin, 3, { price: 1_000_000 })); });

  // ------------------------------------------------------------------ creation
  test('customer booking: confirmed, priced per night, charges posted, inventory sold', async () => {
    const res = await book(c.customer);
    expect(res.status).toBe(201);
    const b = res.body.data;
    expect(b).toMatchObject({ status: 'CONFIRMED', nights: 2, customerId: String(c.customer._id), source: 'WEBSITE', billing: { totalChargesMinor: 2_000_000, paidMinor: 0, status: 'OPEN' } });
    expect(b.bookingCode).toMatch(/^BK-\d{6}$/);
    expect(b.rooms[0].nightly).toHaveLength(2);
    expect(await RoomNight.countDocuments({ bookingId: b.id, state: 'SOLD' })).toBe(2);
    const charges = await BillingCharge.find({ bookingId: b.id });
    expect(charges).toHaveLength(2);
    expect(charges.every((x) => x.category === 'ROOM' && x.status === 'POSTED' && x.amountMinor === 1_000_000)).toBe(true);
    expect((await billingService.reconcile(b.billing.accountId)).consistent).toBe(true);
    const search = await as(c.customer).get(`/api/rooms/availability?checkIn=${b.checkInDate}&checkOut=${b.checkOutDate}&roomTypeId=${type.id}`);
    expect(search.body.data.items.map((i) => i.room.id)).not.toContain(rooms[0].id);
  });

  test('price snapshot: later price changes never alter an existing booking', async () => {
    const b = (await book(c.customer)).body.data;
    await as(c.admin).patch(`/api/room-types/${type.id}`, { basePriceMinor: 5_000_000 });
    const again = (await as(c.customer).get(`/api/bookings/${b.id}`)).body.data;
    expect(again.rooms[0].nightly.map((n) => n.priceMinor)).toEqual([1_000_000, 1_000_000]);
    expect(again.billing.totalChargesMinor).toBe(2_000_000);
    await as(c.admin).patch(`/api/room-types/${type.id}`, { basePriceMinor: 1_000_000 });
  });

  test('DOUBLE BOOKING: concurrent requests for the same room and dates, exactly one wins and nothing is left half-created', async () => {
    const ci = await inDays(20); const co = await inDays(23);
    const attempts = await Promise.all([c.customer, c.customer2, c.customer, c.customer2, c.customer, c.customer2].map((u) => book(u, { checkInDate: ci, checkOutDate: co })));
    const ok = attempts.filter((r) => r.status === 201);
    const lost = attempts.filter((r) => r.status !== 201);
    expect(ok).toHaveLength(1);
    expect(lost.every((r) => r.status === 409 && r.body.code === 'ROOM_UNAVAILABLE')).toBe(true);
    expect(await Booking.countDocuments({ 'rooms.roomId': rooms[0].id, checkInDate: ci })).toBe(1);
    expect(await RoomNight.countDocuments({ roomId: rooms[0].id, date: { $gte: ci, $lt: co } })).toBe(3);
    expect(await BillingAccount.countDocuments({ bookingId: ok[0].body.data.id })).toBe(1);
    expect(await BillingCharge.countDocuments({ bookingId: ok[0].body.data.id })).toBe(3);
    expect(await BillingAccount.countDocuments({ bookingId: { $nin: (await Booking.find().distinct('_id')) } })).toBe(0); // no orphan accounts
  });

  test('overlap rules: any shared night conflicts, back-to-back stays are fine, other rooms are unaffected', async () => {
    const d = (n) => inDays(n);
    expect((await book(c.customer, { checkInDate: await d(30), checkOutDate: await d(33) })).status).toBe(201);
    for (const [a, b] of [[29, 31], [31, 32], [32, 35], [28, 36]]) expect((await book(c.customer2, { checkInDate: await d(a), checkOutDate: await d(b) })).body.code).toBe('ROOM_UNAVAILABLE');
    expect((await book(c.customer2, { checkInDate: await d(33), checkOutDate: await d(35) })).status).toBe(201); // starts on the other's check-out day
    expect((await book(c.customer2, { checkInDate: await d(27), checkOutDate: await d(30) })).status).toBe(201); // ends on the other's check-in day
    expect((await book(c.customer2, { rooms: [rooms[1].id], checkInDate: await d(30), checkOutDate: await d(33) })).status).toBe(201);
  });

  test('multi-room booking is atomic: if one room is taken nothing is booked', async () => {
    await book(c.customer, { rooms: [rooms[1].id] });
    const res = await book(c.customer2, { rooms: [rooms[0].id, rooms[1].id], adults: 4 });
    expect(res.status).toBe(409);
    expect(await RoomNight.countDocuments({ roomId: rooms[0].id })).toBe(0);
    const ok = await book(c.customer2, { rooms: [rooms[0].id, rooms[2].id], adults: 4 });
    expect(ok.body.data.billing.totalChargesMinor).toBe(4_000_000);
  });

  test('validation: dates, capacity, rooms, guests and who may set what', async () => {
    expect((await book(c.customer, { checkInDate: await inDays(12), checkOutDate: await inDays(10) })).body.code).toBe('INVALID_DATES');
    expect((await book(c.customer, { checkInDate: '2020-01-01', checkOutDate: '2020-01-03' })).body.code).toBe('INVALID_DATES');
    expect((await book(c.customer, { checkInDate: await inDays(10), checkOutDate: await inDays(90) })).body.code).toBe('STAY_TOO_LONG');
    expect((await book(c.customer, { adults: 5 })).body.code).toBe('CAPACITY_EXCEEDED');
    expect((await book(c.customer, { rooms: ['6aec681b114df5d08d3c9916'] })).body.code).toBe('ROOM_UNAVAILABLE');
    await as(c.manager).patch(`/api/rooms/${rooms[2].id}/status`, { status: 'MAINTENANCE' });
    expect((await book(c.customer, { rooms: [rooms[2].id] })).body.code).toBe('ROOM_UNAVAILABLE');
    expect((await book(c.reception, {})).body.code).toBe('GUEST_REQUIRED');
    expect((await book(c.customer, { guestIds: ['6aec681b114df5d08d3c9916'] })).body.code).toBe('GUEST_NOT_FOUND');
    const forged = await book(c.customer, { customerId: String(c.customer2._id) }); // a customer cannot book on someone else's behalf
    expect(forged.body.data.customerId).toBe(String(c.customer._id));
    expect((await book(c.housekeeper, {})).status).toBe(403);
    expect((await as(c.customer).post('/api/bookings', {})).status).toBe(422);
  });

  test('visibility: customers see only their bookings; front desk sees all', async () => {
    const b = (await book(c.customer)).body.data;
    expect((await as(c.customer2).get(`/api/bookings/${b.id}`)).status).toBe(404);
    expect((await as(c.customer2).get('/api/bookings')).body.meta.total).toBe(0);
    expect((await as(c.customer).get('/api/bookings')).body.meta.total).toBe(1);
    expect((await as(c.reception).get(`/api/bookings/${b.id}`)).status).toBe(200);
    expect((await as(c.reception).get(`/api/bookings?search=${b.bookingCode}`)).body.meta.total).toBe(1);
    expect((await as(c.housekeeper).get('/api/bookings')).status).toBe(403);
  });

  // ------------------------------------------------------------------ deposit & expiry
  test('deposit: booking is held PENDING, confirmed only when the deposit is paid, hold expiry frees everything', async () => {
    await setSettings({ depositBps: 3000 });
    const b = (await book(c.customer)).body.data; // 30% of 2,000,000 = 600,000
    expect(b).toMatchObject({ status: 'PENDING', priceSnapshot: { depositRequiredMinor: 600_000 } });
    expect(b.holdExpiresAt).toBeTruthy();
    expect(await RoomNight.countDocuments({ bookingId: b.id, state: 'HELD' })).toBe(2);
    const pay = (amountMinor, key) => as(c.reception).post('/api/payments', { bookingId: b.id, amountMinor, method: 'CASH', idempotencyKey: key });
    await pay(200_000, uniq('k1k1k1k1'));
    expect((await as(c.reception).get(`/api/bookings/${b.id}`)).body.data.status).toBe('PENDING');
    await pay(400_000, uniq('k2k2k2k2'));
    const after = (await as(c.reception).get(`/api/bookings/${b.id}`)).body.data;
    expect(after).toMatchObject({ status: 'CONFIRMED', holdExpiresAt: null });
    expect(await RoomNight.countDocuments({ bookingId: b.id, state: 'SOLD' })).toBe(2);

    const b2 = (await book(c.customer2, { rooms: [rooms[1].id] })).body.data;
    await Booking.collection.updateOne({ _id: new (await import('mongoose')).default.Types.ObjectId(b2.id) }, { $set: { holdExpiresAt: new Date(Date.now() - 1000) } });
    await RoomNight.collection.updateMany({ bookingId: new (await import('mongoose')).default.Types.ObjectId(b2.id) }, { $set: { holdExpiresAt: new Date(Date.now() - 1000) } });
    expect(await bookingService.processExpired()).toBeGreaterThanOrEqual(1);
    expect((await as(c.reception).get(`/api/bookings/${b2.id}`)).body.data).toMatchObject({ status: 'EXPIRED', billing: { totalChargesMinor: 0, status: 'CLOSED' } });
    expect(await RoomNight.countDocuments({ bookingId: b2.id })).toBe(0);
    expect((await book(c.customer, { rooms: [rooms[1].id] })).status).toBe(201); // the room is bookable again
    await setSettings({ depositBps: 0 });
  });

  test('an expired hold no longer blocks new bookings even before the cleanup job runs', async () => {
    await setSettings({ depositBps: 1000 });
    const b = (await book(c.customer)).body.data;
    const oid = new (await import('mongoose')).default.Types.ObjectId(b.id);
    await RoomNight.collection.updateMany({ bookingId: oid }, { $set: { holdExpiresAt: new Date(Date.now() - 1000) } });
    await setSettings({ depositBps: 0 });
    expect((await book(c.customer2)).status).toBe(201);
  });

  // ------------------------------------------------------------------ cancellation & no-show
  test('cancellation far ahead is free: inventory released, charges voided, account closed', async () => {
    const b = (await book(c.customer, { checkInDate: await inDays(40), checkOutDate: await inDays(42) })).body.data;
    const res = await as(c.customer).post(`/api/bookings/${b.id}/cancel`, { reason: 'Plans changed' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'CANCELLED', cancellation: { penaltyMinor: 0, freeCancellation: true }, billing: { totalChargesMinor: 0, status: 'CLOSED' } });
    expect(await RoomNight.countDocuments({ bookingId: b.id })).toBe(0);
    expect((await BillingCharge.find({ bookingId: b.id })).every((x) => x.status === 'VOIDED')).toBe(true);
    expect((await as(c.customer).post(`/api/bookings/${b.id}/cancel`, { reason: 'again' })).body.code).toBe('INVALID_STATE_TRANSITION');
  });

  test('late cancellation bills the penalty night and computes the refund due; managers may waive it', async () => {
    const mk = async (customer, roomId) => (await book(customer, { rooms: [roomId], checkInDate: await inDays(1), checkOutDate: await inDays(3) })).body.data;
    const b = await mk(c.customer, rooms[0].id);
    await as(c.reception).post('/api/payments', { bookingId: b.id, amountMinor: 1_500_000, method: 'CASH', idempotencyKey: uniq('deposit-key') });
    const res = await as(c.customer).post(`/api/bookings/${b.id}/cancel`, { reason: 'Sick' });
    expect(res.body.data).toMatchObject({ status: 'CANCELLED', cancellation: { penaltyMinor: 1_000_000, freeCancellation: false }, refundDueMinor: 500_000, billing: { totalChargesMinor: 1_000_000, status: 'OPEN' } });
    const fee = await BillingCharge.findOne({ bookingId: b.id, category: 'SURCHARGE' });
    expect(fee).toMatchObject({ amountMinor: 1_000_000, status: 'POSTED' });
    expect((await billingService.reconcile(b.billing.accountId)).consistent).toBe(true);

    const b2 = await mk(c.customer2, rooms[1].id);
    expect((await as(c.customer2).post(`/api/bookings/${b2.id}/cancel`, { reason: 'x1x', waivePenalty: true })).status).toBe(403);
    const waived = await as(c.manager).post(`/api/bookings/${b2.id}/cancel`, { reason: 'Goodwill', waivePenalty: true });
    expect(waived.body.data.cancellation).toMatchObject({ penaltyMinor: 0, freeCancellation: true });
    const other = await mk(c.customer, rooms[2].id);
    expect((await as(c.customer2).post(`/api/bookings/${other.id}/cancel`, { reason: 'not mine' })).status).toBe(404);
  });

  test('no-show: arrival day passed => NO_SHOW, rooms freed, no-show fee billed (job and manual)', async () => {
    const b = (await book(c.customer, { checkInDate: await inDays(1), checkOutDate: await inDays(3) })).body.data;
    expect((await as(c.manager).post(`/api/bookings/${b.id}/no-show`)).body.code).toBe('TOO_EARLY');
    expect(await bookingService.processNoShows(new Date(Date.now() + 3 * 86_400_000))).toBeGreaterThanOrEqual(1);
    const after = (await as(c.manager).get(`/api/bookings/${b.id}`)).body.data;
    expect(after).toMatchObject({ status: 'NO_SHOW', cancellation: { penaltyMinor: 1_000_000 }, billing: { totalChargesMinor: 1_000_000 } });
    expect(await RoomNight.countDocuments({ bookingId: b.id })).toBe(0);
  });

  // ------------------------------------------------------------------ modification
  test('modify: kept nights keep their price, new nights use current rates, conflicts change nothing', async () => {
    const ci = await inDays(50); const co = await inDays(52);
    const b = (await book(c.customer, { checkInDate: ci, checkOutDate: co })).body.data;
    await as(c.admin).patch(`/api/room-types/${type.id}`, { basePriceMinor: 1_200_000 });
    const m = await as(c.customer).patch(`/api/bookings/${b.id}`, { checkOutDate: await inDays(53) });
    expect(m.status).toBe(200);
    expect(m.body.data.rooms[0].nightly.map((n) => n.priceMinor)).toEqual([1_000_000, 1_000_000, 1_200_000]);
    expect(m.body.data.billing.totalChargesMinor).toBe(3_200_000);
    expect(await RoomNight.countDocuments({ bookingId: b.id })).toBe(3);
    const shrink = await as(c.customer).patch(`/api/bookings/${b.id}`, { checkInDate: await inDays(51) });
    expect(shrink.body.data.billing.totalChargesMinor).toBe(2_200_000);
    expect(await RoomNight.countDocuments({ bookingId: b.id })).toBe(2);
    expect((await billingService.reconcile(b.billing.accountId)).consistent).toBe(true);

    await book(c.customer2, { checkInDate: await inDays(53), checkOutDate: await inDays(55) });
    const clash = await as(c.customer).patch(`/api/bookings/${b.id}`, { checkOutDate: await inDays(54) });
    expect(clash.body.code).toBe('ROOM_UNAVAILABLE');
    expect((await as(c.customer).get(`/api/bookings/${b.id}`)).body.data.checkOutDate).toBe(await inDays(53));
    expect((await as(c.customer2).patch(`/api/bookings/${b.id}`, { adults: 1 })).status).toBe(404);
    await as(c.admin).patch(`/api/room-types/${type.id}`, { basePriceMinor: 1_000_000 });
  });

  // ------------------------------------------------------------------ check-in / check-out / housekeeping
  const stayToday = async (roomId = rooms[0].id, nights = 2, over = {}) => (await staffBook({ rooms: [roomId], checkInDate: await inDays(0), checkOutDate: await inDays(nights), ...over })).body.data;

  test('check-in rules: date, guest ID, room readiness, state; success occupies the room', async () => {
    const future = (await staffBook()).body.data;
    expect((await as(c.reception).post(`/api/bookings/${future.id}/check-in`)).body.code).toBe('TOO_EARLY');

    const noId = (await staffBook({ rooms: [rooms[1].id], checkInDate: await inDays(0), checkOutDate: await inDays(1), guestIds: [(await guest(false)).id] })).body.data;
    expect((await as(c.reception).post(`/api/bookings/${noId.id}/check-in`)).body.code).toBe('GUEST_ID_REQUIRED');

    await Room.updateOne({ _id: rooms[2].id }, { $set: { housekeepingStatus: 'DIRTY' } });
    const dirty = await stayToday(rooms[2].id, 1);
    expect((await as(c.reception).post(`/api/bookings/${dirty.id}/check-in`)).body.code).toBe('ROOM_NOT_READY');

    const ok = await stayToday(rooms[0].id);
    expect((await as(c.housekeeper).post(`/api/bookings/${ok.id}/check-in`)).status).toBe(403);
    expect((await as(c.customer).post(`/api/bookings/${ok.id}/check-in`)).status).toBe(403);
    const res = await as(c.reception).post(`/api/bookings/${ok.id}/check-in`);
    expect(res.body.data).toMatchObject({ status: 'CHECKED_IN', checkedInBy: String(c.reception._id) });
    expect((await Room.findById(rooms[0].id)).status).toBe('OCCUPIED');
    expect((await as(c.reception).post(`/api/bookings/${ok.id}/check-in`)).body.code).toBe('INVALID_STATE_TRANSITION');
    expect((await as(c.reception).post(`/api/bookings/${ok.id}/cancel`, { reason: 'too late' })).status).toBe(403); // front desk cannot cancel
    expect((await as(c.manager).post(`/api/bookings/${ok.id}/cancel`, { reason: 'too late' })).body.code).toBe('INVALID_STATE_TRANSITION');
  });

  test('check-in needs the deposit', async () => {
    await setSettings({ depositBps: 5000 });
    const b = await stayToday(rooms[0].id, 1);
    expect(b.priceSnapshot.depositRequiredMinor).toBe(500_000);
    await Booking.updateOne({ _id: b.id }, { $set: { 'priceSnapshot.depositRequiredMinor': 500_000 } });
    expect((await as(c.reception).post(`/api/bookings/${b.id}/check-in`)).body.code).toBe('DEPOSIT_REQUIRED');
    await setSettings({ depositBps: 0 });
  });

  test('FULL STAY: charges -> draft -> issued invoice -> partial and full payment -> check-out -> housekeeping -> room back in stock', async () => {
    const b = await stayToday(rooms[0].id, 2);
    await as(c.reception).post(`/api/bookings/${b.id}/check-in`);
    const acct = b.billing.accountId;

    expect((await as(c.reception).post(`/api/billing-accounts/${acct}/charges`, { category: 'SURCHARGE', description: 'Late check-out', unitPriceMinor: 100_000 })).status).toBe(403);
    expect((await as(c.manager).post(`/api/billing-accounts/${acct}/charges`, { category: 'SURCHARGE', description: 'Late check-out', unitPriceMinor: 100_000 })).status).toBe(201);
    expect((await as(c.manager).post(`/api/billing-accounts/${acct}/charges`, { category: 'DISCOUNT', description: 'Loyalty', unitPriceMinor: 50_000 })).status).toBe(201);

    const early = await as(c.reception).post(`/api/bookings/${b.id}/check-out`);
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('OUTSTANDING_BALANCE');
    expect((await Booking.findById(b.id)).status).toBe('CHECKED_IN'); // the whole transaction rolled back
    expect(await Invoice.countDocuments({ bookingId: b.id, status: { $ne: 'DRAFT' } })).toBe(0);
    expect((await Room.findById(rooms[0].id)).status).toBe('OCCUPIED');
    expect(await HousekeepingTask.countDocuments({ bookingId: b.id })).toBe(0);

    const draft = (await as(c.manager).post(`/api/billing-accounts/${acct}/invoices`)).body.data;
    expect(draft).toMatchObject({ status: 'DRAFT', subtotalMinor: 2_000_000, discountTotalMinor: 50_000, surchargeTotalMinor: 100_000, taxTotalMinor: 205_000, grandTotalMinor: 2_255_000 });
    expect((await as(c.customer).get(`/api/invoices/${draft.id}`)).status).toBe(404); // guests never see drafts
    const issued = (await as(c.manager).post(`/api/invoices/${draft.id}/issue`)).body.data;
    expect(issued).toMatchObject({ status: 'ISSUED', outstandingMinor: 2_255_000 });
    expect(issued.invoiceNumber).toMatch(/^INV-\d{6}$/);
    expect((await as(c.manager).post(`/api/billing-accounts/${acct}/charges`, { category: 'SURCHARGE', description: 'Too late', unitPriceMinor: 1 })).body.code).toBe('INVOICE_ISSUED');

    const pay = (amountMinor) => as(c.reception).post('/api/payments', { accountId: acct, amountMinor, method: 'CASH', idempotencyKey: uniq('pay-key-') });
    expect((await pay(1_000_000)).status).toBe(201);
    expect((await as(c.manager).get(`/api/invoices/${draft.id}`)).body.data).toMatchObject({ status: 'PARTIALLY_PAID', paidMinor: 1_000_000, outstandingMinor: 1_255_000 });
    expect((await pay(1_255_001)).body.code).toBe('OVERPAYMENT');
    await pay(1_255_000);

    const out = await as(c.reception).post(`/api/bookings/${b.id}/check-out`);
    expect(out.status).toBe(200);
    expect(out.body.data.invoice).toMatchObject({ status: 'PAID', outstandingMinor: 0, invoiceNumber: issued.invoiceNumber });
    expect(out.body.data.booking.status).toBe('CHECKED_OUT');
    expect((await BillingAccount.findById(acct)).status).toBe('CLOSED');
    expect(await Invoice.countDocuments({ bookingId: b.id, isActive: true })).toBe(1); // still exactly one invoice
    expect((await Room.findById(rooms[0].id))).toMatchObject({ status: 'CLEANING', housekeepingStatus: 'DIRTY' });
    expect(await HousekeepingTask.countDocuments({ bookingId: b.id, status: 'PENDING' })).toBe(1);
    expect((await as(c.reception).post(`/api/bookings/${b.id}/check-out`)).body.code).toBe('INVALID_STATE_TRANSITION');
    expect((await billingService.reconcile(acct)).consistent).toBe(true);

    const tomorrow = await as(c.customer).get(`/api/rooms/availability?checkIn=${await inDays(1)}&checkOut=${await inDays(2)}&roomTypeId=${type.id}`);
    expect(tomorrow.body.data.items.map((i) => i.room.id)).toContain(rooms[0].id); // the unused night went back on sale

    // ---- housekeeping: finishing the cleaning is not enough; the room returns only after inspection
    const task = (await as(c.manager).get(`/api/housekeeping/tasks?roomId=${rooms[0].id}`)).body.data[0];
    const other = await (await import('../helpers/api.js')).makeStaff('HOUSEKEEPING', null);
    expect((await as(c.manager).patch(`/api/housekeeping/tasks/${task.id}`, { assignedStaffId: String(c.reception._id) })).body.code).toBe('INVALID_ASSIGNEE');
    expect((await as(c.manager).patch(`/api/housekeeping/tasks/${task.id}`, { assignedStaffId: String(other._id) })).body.code).toBe('INVALID_ASSIGNEE'); // not on this manager's team
    expect((await as(c.manager).patch(`/api/housekeeping/tasks/${task.id}`, { assignedStaffId: String(c.housekeeper._id) })).body.data.status).toBe('ASSIGNED');
    expect((await as(other).get(`/api/housekeeping/tasks/${task.id}`)).status).toBe(404);
    expect((await as(c.reception).post(`/api/housekeeping/tasks/${task.id}/start`)).status).toBe(403);
    expect((await as(c.housekeeper).post(`/api/housekeeping/tasks/${task.id}/complete`, {})).body.code).toBe('INVALID_STATE_TRANSITION');
    expect((await as(c.housekeeper).post(`/api/housekeeping/tasks/${task.id}/start`)).body.data.status).toBe('IN_PROGRESS');
    expect((await Room.findById(rooms[0].id)).housekeepingStatus).toBe('CLEANING');
    expect((await as(c.housekeeper).post(`/api/housekeeping/tasks/${task.id}/complete`, { notes: 'done' })).body.data.status).toBe('COMPLETED');
    expect(await Room.findById(rooms[0].id)).toMatchObject({ status: 'CLEANING', housekeepingStatus: 'CLEAN' }); // cleaned, NOT yet available
    expect((await as(c.housekeeper).post(`/api/housekeeping/tasks/${task.id}/inspect`, { passed: true })).status).toBe(403);

    expect((await as(c.manager).post(`/api/housekeeping/tasks/${task.id}/inspect`, { passed: false, notes: 'dust' })).body.data.status).toBe('ASSIGNED');
    expect(await Room.findById(rooms[0].id)).toMatchObject({ status: 'CLEANING', housekeepingStatus: 'DIRTY' });
    await as(c.housekeeper).post(`/api/housekeeping/tasks/${task.id}/start`);
    await as(c.housekeeper).post(`/api/housekeeping/tasks/${task.id}/complete`, {});
    expect((await as(c.manager).post(`/api/housekeeping/tasks/${task.id}/inspect`, { passed: true })).body.data.status).toBe('INSPECTED');
    expect(await Room.findById(rooms[0].id)).toMatchObject({ status: 'AVAILABLE', housekeepingStatus: 'INSPECTED' });
    expect((await as(c.manager).get('/api/housekeeping/rooms')).body.data.map((r) => r.id)).not.toContain(rooms[0].id);
  });

  test('check-out with an unpaid balance needs a manager; the account stays open until it is settled', async () => {
    const b = await stayToday(rooms[1].id, 1);
    await as(c.reception).post(`/api/bookings/${b.id}/check-in`);
    expect((await as(c.reception).post(`/api/bookings/${b.id}/check-out`, { authorizeOutstanding: true })).status).toBe(403);
    const out = await as(c.manager).post(`/api/bookings/${b.id}/check-out`, { authorizeOutstanding: true, reason: 'Corporate account' });
    expect(out.status).toBe(200);
    expect(out.body.data.invoice).toMatchObject({ status: 'ISSUED', outstandingMinor: 1_100_000 });
    expect((await BillingAccount.findById(b.billing.accountId)).status).toBe('OPEN');
    await as(c.reception).post('/api/payments', { accountId: b.billing.accountId, amountMinor: 1_100_000, method: 'BANK_TRANSFER', idempotencyKey: uniq('late-pay-') });
    expect((await as(c.manager).get(`/api/invoices/${out.body.data.invoice.id}`)).body.data.status).toBe('PAID');
    expect((await BillingAccount.findById(b.billing.accountId)).status).toBe('CLOSED');
  });

  test('extending an in-house stay bills the extra nights and refuses taken ones', async () => {
    const b = await stayToday(rooms[0].id, 1);
    await as(c.reception).post(`/api/bookings/${b.id}/check-in`);
    await book(c.customer2, { checkInDate: await inDays(3), checkOutDate: await inDays(4) });
    expect((await as(c.reception).post(`/api/bookings/${b.id}/extend`, { newCheckOutDate: await inDays(3) })).body.data.billing).toBeUndefined();
    expect((await billingService.reconcile(b.billing.accountId)).cached).toBe(3_000_000);
    expect((await as(c.reception).post(`/api/bookings/${b.id}/extend`, { newCheckOutDate: await inDays(4) })).body.code).toBe('ROOM_UNAVAILABLE');
    expect((await as(c.reception).post(`/api/bookings/${b.id}/extend`, { newCheckOutDate: await inDays(1) })).status).toBe(422);
  });

  test('guests with no account (walk-ins) can be booked, stay, and be invoiced', async () => {
    const g = await guest();
    const b = (await book(c.reception, { guestIds: [g.id], checkInDate: await inDays(0), checkOutDate: await inDays(1), source: 'PHONE' })).body.data;
    expect(b).toMatchObject({ customerId: null, source: 'PHONE' });
    await as(c.reception).post(`/api/bookings/${b.id}/check-in`);
    const draft = (await as(c.manager).post(`/api/billing-accounts/${b.billing.accountId}/invoices`)).body.data;
    expect(draft.customerSnapshot.fullName).toBe(g.fullName);
  });
});
