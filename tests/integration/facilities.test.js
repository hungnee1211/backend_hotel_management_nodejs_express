import { as, cast, inDays, makeRooms, makeStaff, makeUser, models, setupDb, suite, uniq, DEPTS } from '../helpers/api.js';
import { maintenanceService } from '../../src/modules/maintenance/maintenance.service.js';

const { Equipment, MaintenanceRequest, MaintenanceHistory, RoomNight, Notification, Facility } = models;

suite('facilities, equipment and maintenance (real MongoDB)', () => {
  setupDb();
  let c; let other; let gym; let treadmill;
  const mkEquip = async (over = {}) => (await as(c.manager).post('/api/equipment', { name: uniq('Treadmill'), facilityId: gym.id, category: 'Cardio', maintenanceIntervalDays: 90, ...over })).body.data;
  const report = (u, over = {}) => as(u).post('/api/maintenance', { equipmentId: treadmill.id, title: 'Belt is slipping', priority: 'HIGH', ...over });

  beforeEach(async () => {
    c = await cast(); other = await makeUser('MANAGER');
    gym = (await as(c.manager).post('/api/facilities', { name: uniq('Gym'), type: 'GYM', location: 'Level 2', operatingHours: [{ day: 1, open: '06:00', close: '22:00' }] })).body.data;
    treadmill = await mkEquip();
  });

  describe('facilities', () => {
    test('a manager\'s facility is theirs; Admin can assign; other managers cannot touch it but everyone on staff can read', async () => {
      expect(gym.managerId).toBe(String(c.manager._id));
      expect((await as(other).patch(`/api/facilities/${gym.id}`, { location: 'x' })).status).toBe(404);
      expect((await as(c.manager).patch(`/api/facilities/${gym.id}`, { location: 'Level 3', status: 'MAINTENANCE' })).body.data).toMatchObject({ location: 'Level 3', status: 'MAINTENANCE' });
      expect((await as(c.manager).patch(`/api/facilities/${gym.id}`, { managerId: String(other._id) })).status).toBe(403);
      const pool = (await as(c.admin).post('/api/facilities', { name: uniq('Pool'), type: 'SWIMMING_POOL', managerId: String(other._id) })).body.data;
      expect(pool.managerId).toBe(String(other._id));
      expect((await as(c.admin).post('/api/facilities', { name: uniq('Bad'), type: 'SPA', managerId: String(c.customer._id) })).body.code).toBe('INVALID_MANAGER');
      expect((await as(c.reception).get(`/api/facilities/${gym.id}`)).status).toBe(200);
      expect((await as(c.reception).get('/api/facilities')).body.meta.total).toBeGreaterThanOrEqual(2);
      expect((await as(c.reception).post('/api/facilities', { name: 'x', type: 'GYM' })).status).toBe(403);
      expect((await as(c.customer).get('/api/facilities')).status).toBe(403);
      expect((await as(c.admin).patch(`/api/facilities/${gym.id}`, { managerId: String(other._id) })).body.data.managerId).toBe(String(other._id));
    });

    test('operating hours validation, duplicate names, and deactivation guards', async () => {
      expect((await as(c.manager).post('/api/facilities', { name: uniq('F'), type: 'GYM', operatingHours: [{ day: 1, open: '06:00', close: '10:00' }, { day: 1, open: '12:00', close: '14:00' }] })).status).toBe(422);
      expect((await as(c.manager).post('/api/facilities', { name: uniq('F'), type: 'GYM', operatingHours: [{ day: 9, open: '06:00', close: '10:00' }] })).status).toBe(422);
      expect((await as(c.manager).post('/api/facilities', { name: gym.name, type: 'GYM' })).status).toBe(409);
      expect((await as(c.manager).delete(`/api/facilities/${gym.id}`)).body.code).toBe('FACILITY_IN_USE'); // still has equipment
      const bare = (await as(c.manager).post('/api/facilities', { name: uniq('Bare'), type: 'PARKING' })).body.data;
      expect((await as(c.manager).delete(`/api/facilities/${bare.id}`)).status).toBe(200);
      expect((await as(c.manager).get(`/api/facilities/${bare.id}`)).status).toBe(404);
      expect((await Facility.findById(bare.id))).toBeTruthy();
    });
  });

  describe('equipment', () => {
    test('registration, codes, scope, filters, retirement', async () => {
      expect(treadmill.equipmentCode).toMatch(/^EQ-\d{5}$/);
      expect(treadmill.nextMaintenanceAt).toBeTruthy();
      const bike = await mkEquip({ name: uniq('Bike'), warrantyExpiration: new Date(Date.now() + 10 * 86_400_000).toISOString(), purchasePriceMinor: 15_000_000 });
      expect((await as(other).post('/api/equipment', { name: 'x', facilityId: gym.id })).status).toBe(404); // not their facility
      expect((await as(c.admin).post('/api/equipment', { name: uniq('AdminBike'), facilityId: gym.id })).status).toBe(201);
      expect((await as(c.manager).post('/api/equipment', { name: 'x', facilityId: gym.id, purchasePriceMinor: 1.5 })).status).toBe(422);
      expect((await as(c.reception).get('/api/equipment')).status).toBe(403);
      expect((await as(c.maintenance).get('/api/equipment')).status).toBe(200);
      expect((await as(c.manager).get(`/api/equipment?facilityId=${gym.id}&warrantyExpiringDays=30`)).body.data.map((e) => e.id)).toEqual([bike.id]);
      expect((await as(c.manager).get(`/api/equipment?search=${bike.equipmentCode}`)).body.meta.total).toBe(1);
      expect((await as(c.manager).get(`/api/facilities/${gym.id}/equipment`)).body.meta.total).toBeGreaterThanOrEqual(3);
      expect((await as(c.manager).delete(`/api/equipment/${bike.id}`)).body.data.status).toBe('RETIRED');
      expect((await as(c.manager).patch(`/api/equipment/${bike.id}`, { name: 'Zombie' })).body.code).toBe('EQUIPMENT_RETIRED');
      expect((await as(c.manager).post('/api/maintenance', { equipmentId: bike.id, title: 'retired item' })).body.code).toBe('INVALID_EQUIPMENT');
      expect((await as(c.manager).get(`/api/equipment/${bike.id}/history`)).body.data.audit.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('maintenance workflow', () => {
    test('a reported fault makes equipment non-operational and alerts the facility manager', async () => {
      const r = await report(c.reception);
      expect(r.status).toBe(201);
      expect(r.body.data).toMatchObject({ status: 'PENDING', priority: 'HIGH', reportedBy: String(c.reception._id), facilityId: gym.id });
      expect((await Equipment.findById(treadmill.id)).status).toBe('DAMAGED');
      expect(await Notification.countDocuments({ userId: c.manager._id, type: 'MAINTENANCE_REPORTED' })).toBe(1);
      expect((await as(c.customer).post('/api/maintenance', { equipmentId: treadmill.id, title: 'hello' })).status).toBe(403);
      expect((await as(c.manager).post('/api/maintenance', { title: 'no target' })).body.code).toBe('TARGET_REQUIRED');
      expect((await as(c.reception).post('/api/maintenance', { equipmentId: treadmill.id, title: 'sched', type: 'PREVENTIVE' })).status).toBe(403);
    });

    test('visibility: reporter, assignee and the facility\'s manager see it; others do not', async () => {
      const r = (await report(c.reception)).body.data;
      expect((await as(c.reception).get(`/api/maintenance/${r.id}`)).status).toBe(200);
      expect((await as(c.kitchen).get(`/api/maintenance/${r.id}`)).status).toBe(404);
      expect((await as(other).get(`/api/maintenance/${r.id}`)).status).toBe(404); // another manager's facility
      expect((await as(c.manager).get(`/api/maintenance/${r.id}`)).status).toBe(200);
      expect((await as(c.admin).get(`/api/maintenance/${r.id}`)).status).toBe(200);
      expect((await as(c.kitchen).get('/api/maintenance')).body.meta.total).toBe(0);
      expect((await as(c.reception).get('/api/maintenance')).body.meta.total).toBe(1);
    });

    test('assign, start, complete: equipment returns to service, repair history and next due date recorded', async () => {
      const r = (await report(c.reception)).body.data;
      const act = (u, a, body) => as(u).post(`/api/maintenance/${r.id}/${a}`, body);
      expect((await act(c.manager, 'assign', { assignedStaffId: String(c.reception._id) })).body.code).toBe('INVALID_ASSIGNEE');
      const foreign = await makeStaff(DEPTS.MAINTENANCE, other._id);
      expect((await act(c.manager, 'assign', { assignedStaffId: String(foreign._id) })).body.code).toBe('INVALID_ASSIGNEE');
      expect((await act(other, 'assign', { assignedStaffId: String(foreign._id) })).status).toBe(404);
      expect((await act(c.reception, 'assign', { assignedStaffId: String(c.maintenance._id) })).status).toBe(403);
      expect((await act(c.manager, 'assign', { assignedStaffId: String(c.maintenance._id) })).body.data.status).toBe('ASSIGNED');
      expect(await Notification.countDocuments({ userId: c.maintenance._id, type: 'MAINTENANCE_ASSIGNED' })).toBe(1);
      expect((await act(c.maintenance, 'complete', {})).body.code).toBe('INVALID_STATE_TRANSITION');
      const stranger = await makeStaff(DEPTS.MAINTENANCE, c.manager._id);
      expect((await act(stranger, 'start')).status).toBe(404);
      expect((await act(c.maintenance, 'start')).status).toBe(200);
      expect((await Equipment.findById(treadmill.id)).status).toBe('IN_MAINTENANCE');
      expect((await as(c.maintenance).patch(`/api/maintenance/${r.id}`, { description: 'Replaced belt', actualCostMinor: 1_800_000 })).status).toBe(200);
      const done = await act(c.maintenance, 'complete', { actualCostMinor: 1_800_000, resolution: 'Belt replaced' });
      expect(done.body.data).toMatchObject({ status: 'COMPLETED', actualCostMinor: 1_800_000 });
      const eq = await Equipment.findById(treadmill.id);
      expect(eq.status).toBe('ACTIVE');
      expect(eq.lastMaintenanceAt).toBeTruthy();
      expect(Math.round((eq.nextMaintenanceAt - eq.lastMaintenanceAt) / 86_400_000)).toBe(90);
      expect(await MaintenanceHistory.countDocuments({ maintenanceRequestId: r.id, costMinor: 1_800_000 })).toBe(1);
      expect((await act(c.maintenance, 'complete', {})).body.code).toBe('INVALID_STATE_TRANSITION');
      expect(await MaintenanceHistory.countDocuments({ maintenanceRequestId: r.id })).toBe(1);
      expect((await as(c.manager).get(`/api/equipment/${treadmill.id}`)).body.data.maintenanceHistory).toHaveLength(1);
    });

    test('cancelling restores the equipment unless another fault is still open', async () => {
      const a = (await report(c.reception)).body.data; const b = (await report(c.maintenance, { title: 'Also noisy' })).body.data;
      await as(c.manager).post(`/api/maintenance/${a.id}/cancel`);
      expect((await Equipment.findById(treadmill.id)).status).toBe('DAMAGED'); // b is still open
      await as(c.manager).post(`/api/maintenance/${b.id}/cancel`);
      expect((await Equipment.findById(treadmill.id)).status).toBe('ACTIVE');
      expect((await as(c.manager).post(`/api/maintenance/${b.id}/cancel`)).body.code).toBe('INVALID_STATE_TRANSITION');
      const mine = (await report(c.reception)).body.data;
      expect((await as(c.reception).post(`/api/maintenance/${mine.id}/cancel`)).status).toBe(200); // a reporter may withdraw while pending
    });
  });

  describe('rooms out of service', () => {
    test('a maintenance window blocks the room in the booking ledger and completion releases it', async () => {
      const { type, rooms } = await makeRooms(c.admin, 1);
      const from = await inDays(20); const to = await inDays(23);
      const search = async () => (await as(c.customer).get(`/api/rooms/availability?checkIn=${from}&checkOut=${to}&roomTypeId=${type.id}`)).body.data.items.length;
      expect(await search()).toBe(1);
      expect((await as(c.reception).post('/api/maintenance', { roomId: rooms[0].id, title: 'Repaint', blockFrom: from, blockTo: to })).status).toBe(403);
      const r = (await as(c.manager).post('/api/maintenance', { roomId: rooms[0].id, title: 'Repaint walls', blockFrom: from, blockTo: to })).body.data;
      expect(await RoomNight.countDocuments({ roomId: rooms[0].id, state: 'BLOCKED', blockRef: r.id })).toBe(3);
      expect(await search()).toBe(0);
      expect((await as(c.customer).post('/api/bookings', { rooms: [rooms[0].id], checkInDate: from, checkOutDate: to, adults: 1 })).body.code).toBe('ROOM_UNAVAILABLE');
      await as(c.manager).post(`/api/maintenance/${r.id}/assign`, { assignedStaffId: String(c.maintenance._id) });
      await as(c.maintenance).post(`/api/maintenance/${r.id}/start`);
      await as(c.maintenance).post(`/api/maintenance/${r.id}/complete`, { actualCostMinor: 500_000 });
      expect(await RoomNight.countDocuments({ blockRef: r.id })).toBe(0);
      expect(await search()).toBe(1);
    });

    test('a window that overlaps a booking is refused and leaves no request behind', async () => {
      const { rooms } = await makeRooms(c.admin, 1);
      const b = await as(c.customer).post('/api/bookings', { rooms: [rooms[0].id], checkInDate: await inDays(30), checkOutDate: await inDays(32), adults: 1 });
      expect(b.status).toBe(201);
      const before = await MaintenanceRequest.countDocuments();
      const r = await as(c.manager).post('/api/maintenance', { roomId: rooms[0].id, title: 'Repaint', blockFrom: await inDays(31), blockTo: await inDays(34) });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('ROOM_HAS_BOOKINGS');
      expect(await MaintenanceRequest.countDocuments()).toBe(before); // the whole transaction rolled back
    });

    test('housekeeping can report room damage and raise a maintenance request from it', async () => {
      const { rooms } = await makeRooms(c.admin, 1);
      const task = (await as(c.manager).post('/api/housekeeping/tasks', { roomId: rooms[0].id, taskType: 'DEEP_CLEAN', assignedStaffId: String(c.housekeeper._id) })).body.data;
      const res = await as(c.housekeeper).post(`/api/housekeeping/tasks/${task.id}/damage`, { description: 'Cracked bathroom mirror', createMaintenance: true });
      expect(res.status).toBe(200);
      const linked = res.body.data.damageReports[0].maintenanceRequestId;
      const req = await MaintenanceRequest.findById(linked);
      expect(req).toMatchObject({ priority: 'HIGH', reportedBy: c.housekeeper._id });
      expect(String(req.roomId)).toBe(rooms[0].id);
    });
  });

  describe('scheduled jobs and notifications', () => {
    test('equipment due soon gets ONE preventive request; reminders are sent once per day', async () => {
      await Equipment.updateOne({ _id: treadmill.id }, { $set: { nextMaintenanceAt: new Date(Date.now() + 3 * 86_400_000) } });
      expect(await maintenanceService.schedulePreventive()).toBeGreaterThanOrEqual(1);
      expect(await maintenanceService.schedulePreventive()).toBe(0);
      const prev = await MaintenanceRequest.find({ equipmentId: treadmill.id, type: 'PREVENTIVE' });
      expect(prev).toHaveLength(1);
      expect(String(prev[0].reportedBy)).toBe(String(c.manager._id));
      expect(prev[0].status).toBe('PENDING');
      expect(await maintenanceService.notifyDue()).toBeGreaterThanOrEqual(1);
      expect(await maintenanceService.notifyDue()).toBe(0);
      await Equipment.updateOne({ _id: treadmill.id }, { $set: { nextMaintenanceAt: new Date(Date.now() - 86_400_000) } });
      expect(await maintenanceService.notifyDue()).toBeGreaterThanOrEqual(1); // now it is overdue: a new kind of alert
      expect(await Notification.countDocuments({ userId: c.manager._id, type: 'MAINTENANCE_OVERDUE' })).toBe(1);
    });

    test('notifications are private: list, unread count, mark read', async () => {
      await report(c.reception);
      const mine = await as(c.manager).get('/api/notifications?unread=true');
      expect(mine.body.meta.unread).toBeGreaterThanOrEqual(1);
      const id = mine.body.data[0].id;
      expect((await as(other).post(`/api/notifications/${id}/read`)).status).toBe(404);
      expect((await as(c.manager).post(`/api/notifications/${id}/read`)).body.data.readAt).toBeTruthy();
      expect((await as(c.manager).post('/api/notifications/read-all')).status).toBe(200);
      expect((await as(c.manager).get('/api/notifications?unread=true')).body.meta.total).toBe(0);
      expect((await as(c.customer).get('/api/notifications')).body.meta.total).toBe(0);
    });
  });
});
