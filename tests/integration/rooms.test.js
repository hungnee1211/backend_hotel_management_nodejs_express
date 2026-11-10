import { as, cast, dbUp, inDays, makeRooms, models, request, app, setupDb, suite, uniq } from '../helpers/api.js';

suite('rooms, room types, pricing and availability', () => {
  setupDb();
  let c;
  beforeEach(async () => { c = await cast(); });

  test('only Admin/Manager manage room types; customers and staff can browse active ones', async () => {
    const body = { name: uniq('Suite'), capacity: 4, basePriceMinor: 2_500_000 };
    expect((await as(c.reception).post('/api/room-types', body)).status).toBe(403);
    expect((await as(c.customer).post('/api/room-types', body)).status).toBe(403);
    const created = await as(c.manager).post('/api/room-types', body);
    expect(created.status).toBe(201);
    expect((await as(c.admin).post('/api/room-types', body)).status).toBe(409); // unique name
    expect((await as(c.customer).get('/api/room-types')).body.data.some((t) => t.id === created.body.data.id)).toBe(true);
    await as(c.admin).patch(`/api/room-types/${created.body.data.id}`, { status: 'INACTIVE' });
    expect((await as(c.customer).get(`/api/room-types/${created.body.data.id}`)).status).toBe(404);
    expect((await as(c.manager).get(`/api/room-types/${created.body.data.id}`)).status).toBe(200);
  });

  test('prices must be integers; seasonal rates may not overlap or end before they start', async () => {
    const base = { name: uniq('T'), capacity: 2, basePriceMinor: 1_000_000 };
    expect((await as(c.admin).post('/api/room-types', { ...base, basePriceMinor: 99.5 })).status).toBe(422);
    const rate = (from, to, priceMinor) => ({ name: 's', from, to, priceMinor });
    expect((await as(c.admin).post('/api/room-types', { ...base, name: uniq('T'), rates: [rate('2027-01-01', '2027-01-31', 1), rate('2027-01-15', '2027-02-10', 2)] })).body.code).toBe('RATE_OVERLAP');
    expect((await as(c.admin).post('/api/room-types', { ...base, name: uniq('T'), rates: [rate('2027-02-10', '2027-02-01', 1)] })).body.code).toBe('INVALID_RATE');
  });

  test('room creation, duplicate numbers, filters, search and pagination', async () => {
    const { type, rooms } = await makeRooms(c.admin, 3, { name: uniq('Filt'), price: 1_200_000, capacity: 3 });
    expect((await as(c.admin).post('/api/rooms', { roomNumber: rooms[0].roomNumber, floor: 1, roomTypeId: type.id })).status).toBe(409);
    expect((await as(c.admin).post('/api/rooms', { roomNumber: uniq('R'), floor: 1, roomTypeId: '6aec681b114df5d08d3c9916' })).status).toBe(422);
    const q = (s) => as(c.manager).get(`/api/rooms?roomTypeId=${type.id}${s}`);
    expect((await q('')).body.meta.total).toBe(3);
    expect((await q('&floor=2')).body.data.map((r) => r.roomNumber)).toEqual([rooms[1].roomNumber]);
    expect((await q('&minPrice=1300000')).body.meta.total).toBe(0);
    expect((await q('&maxPrice=1300000&minPrice=1000000')).body.meta.total).toBe(3);
    expect((await q('&capacity=4')).body.meta.total).toBe(0);
    expect((await q('&amenities=wifi,tv')).body.meta.total).toBe(3);
    expect((await q('&amenities=jacuzzi')).body.meta.total).toBe(0);
    expect((await q(`&search=${rooms[2].roomNumber}`)).body.meta.total).toBe(1);
    const page = await q('&limit=2&page=2&sortBy=roomNumber&order=asc');
    expect(page.body.data).toHaveLength(1);
    expect(page.body.meta).toMatchObject({ total: 3, totalPages: 2 });
  });

  test('guests see a trimmed view without operational fields; staff see everything', async () => {
    const { rooms } = await makeRooms(c.admin, 1);
    const guestView = (await as(c.customer).get(`/api/rooms/${rooms[0].id}`)).body.data;
    expect(guestView).not.toHaveProperty('housekeepingStatus');
    expect(guestView).not.toHaveProperty('status');
    const staffView = (await as(c.reception).get(`/api/rooms/${rooms[0].id}`)).body.data;
    expect(staffView).toMatchObject({ status: 'AVAILABLE', housekeepingStatus: 'INSPECTED' });
    expect((await as(c.customer).patch(`/api/rooms/${rooms[0].id}`, { notes: 'x' })).status).toBe(403);
    expect((await as(c.reception).patch(`/api/rooms/${rooms[0].id}`, { notes: 'x' })).status).toBe(403);
  });

  test('availability: nightly quote with seasonal rate, capacity, price and amenity filters, date validation', async () => {
    const d1 = await inDays(10); const d2 = await inDays(12);
    const t = (await as(c.admin).post('/api/room-types', { name: uniq('Season'), capacity: 2, basePriceMinor: 1_000_000, amenities: ['wifi'], rates: [{ name: 'peak', from: await inDays(11), to: await inDays(20), priceMinor: 1_500_000 }] })).body.data;
    const r = (await as(c.admin).post('/api/rooms', { roomNumber: uniq('S'), floor: 5, roomTypeId: t.id })).body.data;
    const res = await as(c.customer).get(`/api/rooms/availability?checkIn=${d1}&checkOut=${d2}&adults=2&roomTypeId=${t.id}`);
    expect(res.status).toBe(200);
    const item = res.body.data.items.find((i) => i.room.id === r.id);
    expect(item.nightly.map((n) => n.priceMinor)).toEqual([1_000_000, 1_500_000]);
    expect(item.totalMinor).toBe(2_500_000);
    expect(item.averageNightlyMinor).toBe(1_250_000);
    const q = (s) => as(c.customer).get(`/api/rooms/availability?checkIn=${d1}&checkOut=${d2}&roomTypeId=${t.id}${s}`);
    expect((await q('&adults=3')).body.data.items).toHaveLength(0); // over capacity
    expect((await q('&maxPrice=1000000')).body.data.items).toHaveLength(0);
    expect((await q('&amenities=wifi')).body.data.items).toHaveLength(1);
    expect((await q('&amenities=pool')).body.data.items).toHaveLength(0);
    expect((await as(c.customer).get(`/api/rooms/availability?checkIn=${d2}&checkOut=${d1}`)).body.code).toBe('INVALID_DATES');
    expect((await as(c.customer).get(`/api/rooms/availability?checkIn=2020-01-01&checkOut=2020-01-03`)).body.code).toBe('INVALID_DATES');
    expect((await as(c.customer).get('/api/rooms/availability?checkIn=2026-13-01&checkOut=2026-13-03')).status).toBe(422);
  });

  test('ledger rows (sold, live holds, blocks) make a room unavailable; expired holds do not', async () => {
    const { type, rooms } = await makeRooms(c.admin, 3);
    const d = [await inDays(30), await inDays(31), await inDays(32)];
    const { RoomNight } = models;
    const oid = (x) => x.id;
    await RoomNight.create([
      { roomId: oid(rooms[0]), date: d[0], state: 'SOLD', bookingId: null },
      { roomId: oid(rooms[1]), date: d[0], state: 'HELD', holdExpiresAt: new Date(Date.now() + 60_000) },
      { roomId: oid(rooms[2]), date: d[0], state: 'HELD', holdExpiresAt: new Date(Date.now() - 60_000) },
    ]);
    const res = await as(c.customer).get(`/api/rooms/availability?checkIn=${d[0]}&checkOut=${d[1]}&roomTypeId=${type.id}`);
    expect(res.body.data.items.map((i) => i.room.id)).toEqual([rooms[2].id]);
    // a stay that only touches the SOLD night in its middle is also blocked; one that starts on the check-out day is not
    expect((await as(c.customer).get(`/api/rooms/availability?checkIn=${await inDays(29)}&checkOut=${d[1]}&roomTypeId=${type.id}`)).body.data.items.map((i) => i.room.id)).toEqual([rooms[2].id]);
    expect((await as(c.customer).get(`/api/rooms/availability?checkIn=${await inDays(29)}&checkOut=${d[0]}&roomTypeId=${type.id}`)).body.data.items).toHaveLength(3);
  });

  test('rooms out of service never appear as available; setting status rules', async () => {
    const { type, rooms } = await makeRooms(c.admin, 2);
    const stay = `checkIn=${await inDays(40)}&checkOut=${await inDays(41)}&roomTypeId=${type.id}`;
    expect((await as(c.manager).patch(`/api/rooms/${rooms[0].id}/status`, { status: 'OUT_OF_SERVICE', reason: 'flood' })).status).toBe(200);
    expect((await as(c.customer).get(`/api/rooms/availability?${stay}`)).body.data.items.map((i) => i.room.id)).toEqual([rooms[1].id]);
    expect((await as(c.manager).patch(`/api/rooms/${rooms[0].id}/status`, { status: 'OCCUPIED' })).status).toBe(422); // system-only status
    expect((await as(c.manager).patch(`/api/rooms/${rooms[0].id}/status`, { status: 'AVAILABLE' })).status).toBe(200);
  });

  test('a room with upcoming bookings cannot be closed, retyped or deleted; others are soft-deleted', async () => {
    const { rooms } = await makeRooms(c.admin, 2);
    await models.RoomNight.create({ roomId: rooms[0].id, date: await inDays(5), state: 'SOLD' });
    expect((await as(c.manager).patch(`/api/rooms/${rooms[0].id}/status`, { status: 'MAINTENANCE' })).body.code).toBe('ROOM_IN_USE');
    expect((await as(c.manager).delete(`/api/rooms/${rooms[0].id}`)).body.code).toBe('ROOM_IN_USE');
    expect((await as(c.manager).delete(`/api/rooms/${rooms[1].id}`)).status).toBe(200);
    expect((await as(c.manager).get(`/api/rooms/${rooms[1].id}`)).status).toBe(404);
    expect(await models.Room.findById(rooms[1].id)).toBeTruthy();
    expect((await as(c.manager).get(`/api/rooms/${rooms[0].id}/history`)).status).toBe(200);
    expect((await as(c.customer).get(`/api/rooms/${rooms[0].id}/history`)).status).toBe(403);
  });

  test('settings, tax rules and audit logs are Admin-controlled; tax rates are immutable history', async () => {
    expect((await as(c.manager).patch('/api/settings', { depositBps: 1000 })).status).toBe(403);
    const upd = await as(c.admin).patch('/api/settings', { depositBps: 1000, cancellationPolicy: { penaltyNights: 2 } });
    expect(upd.body.data).toMatchObject({ depositBps: 1000, cancellationPolicy: { penaltyNights: 2, freeCancellationHoursBeforeCheckIn: 48 } });
    await as(c.admin).patch('/api/settings', { depositBps: 0, cancellationPolicy: { penaltyNights: 1 } });
    const rule = await as(c.admin).post('/api/tax-rules', { code: uniq('vat').toUpperCase(), name: 'VAT', rateBps: 1000, appliesTo: ['ROOM'], effectiveFrom: '2026-01-01' });
    expect(rule.status).toBe(201);
    expect((await as(c.admin).patch(`/api/tax-rules/${rule.body.data._id}`, { rateBps: 800 })).body.code).toBe('TAX_RATE_IMMUTABLE');
    expect((await as(c.admin).patch(`/api/tax-rules/${rule.body.data._id}`, { effectiveTo: '2026-12-31' })).status).toBe(200);
    expect((await as(c.manager).post('/api/tax-rules', { code: 'X', name: 'X', rateBps: 1, appliesTo: ['ROOM'], effectiveFrom: '2026-01-01' })).status).toBe(403);
    const logs = await as(c.admin).get('/api/audit-logs?action=SETTINGS_UPDATED');
    expect(logs.body.meta.total).toBeGreaterThanOrEqual(2);
    expect((await as(c.manager).get('/api/audit-logs')).status).toBe(403);
  });
});
