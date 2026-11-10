import { as, cast, makeStaff, models, setupDb, suite, DEPTS } from '../helpers/api.js';
import { addDaysToKey, toLocalDateKey } from '../../src/utils/dates.js';
import { attendanceService } from '../../src/modules/attendance/attendance.service.js';
import { shiftWindow } from '../../src/modules/shifts/shift.service.js';

const { Shift, Attendance } = models;
const TZ = 'Asia/Ho_Chi_Minh';
const hmOf = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
const keyOf = (d) => toLocalDateKey(d, TZ);
const min = (n) => new Date(Date.now() + n * 60_000);
/** A shift that started `startedMinAgo` minutes ago and ends `endsInMin` minutes from now (local clock times). */
const shiftBody = (staff, startedMinAgo, endsInMin) => ({ staffId: String(staff._id), date: keyOf(min(-startedMinAgo)), startTime: hmOf(min(-startedMinAgo)), endTime: hmOf(min(endsInMin)) });

suite('shifts and attendance (real MongoDB)', () => {
  setupDb();
  let c;
  beforeEach(async () => { c = await cast(); });

  test('shiftWindow handles overnight shifts and the hotel timezone', () => {
    const w = shiftWindow({ date: '2026-11-04', startTime: '22:00', endTime: '06:00' }, TZ);
    expect(w.start.toISOString()).toBe('2026-11-04T15:00:00.000Z');
    expect(w.end.toISOString()).toBe('2026-11-04T23:00:00.000Z'); // 06:00 next day local
  });

  test('scheduling: manager scope, overlap, length and permission rules', async () => {
    const mine = await makeStaff(DEPTS.RECEPTION, c.manager._id);
    const otherManager = (await import('../helpers/api.js')).makeUser('MANAGER');
    const theirs = await makeStaff(DEPTS.KITCHEN, (await otherManager)._id);
    const body = { staffId: String(mine._id), date: '2027-03-10', startTime: '08:00', endTime: '16:00' };
    const created = await as(c.manager).post('/api/shifts', body);
    expect(created.status).toBe(201);
    expect(created.body.data.department).toBe('RECEPTION');
    expect((await as(c.manager).post('/api/shifts', { ...body, startTime: '15:00', endTime: '23:00' })).body.code).toBe('SHIFT_OVERLAP');
    expect((await as(c.manager).post('/api/shifts', { ...body, startTime: '16:00', endTime: '23:00' })).status).toBe(201); // back-to-back is fine
    expect((await as(c.manager).post('/api/shifts', { ...body, date: '2027-03-11', startTime: '01:00', endTime: '20:00' })).body.code).toBe('SHIFT_TOO_LONG');
    expect((await as(c.manager).post('/api/shifts', { ...body, staffId: String(theirs._id) })).status).toBe(404);
    expect((await as(c.admin).post('/api/shifts', { ...body, staffId: String(theirs._id) })).status).toBe(201);
    expect((await as(mine).post('/api/shifts', body)).status).toBe(403);
    expect((await as(c.customer).get('/api/shifts')).status).toBe(403);
    expect((await as(mine).get('/api/shifts')).body.meta.total).toBe(2); // staff see their own
    expect((await as(c.manager).get('/api/shifts?from=2027-03-01&to=2027-03-31')).body.data.every((s) => String(s.staffId) === String(mine._id))).toBe(true);
    expect((await as(c.manager).patch(`/api/shifts/${created.body.data.id}`, { endTime: '14:00' })).status).toBe(200);
    expect((await as(c.manager).delete(`/api/shifts/${created.body.data.id}`)).body.data.status).toBe('CANCELLED');
  });

  test('check-in / check-out: late and early-departure detection, one check-in per shift, no checkout without check-in', async () => {
    const s = c.reception;
    expect((await as(s).post('/api/attendance/check-in')).body.code).toBe('NO_SHIFT');
    expect((await as(s).post('/api/attendance/check-out')).body.code).toBe('NOT_CHECKED_IN');
    await as(c.manager).post('/api/shifts', shiftBody(s, 45, 480));
    const inRes = await as(s).post('/api/attendance/check-in');
    expect(inRes.status).toBe(201);
    expect(inRes.body.data.lateMinutes).toBeGreaterThanOrEqual(44);
    expect((await as(s).post('/api/attendance/check-in')).body.code).toBe('ALREADY_CHECKED_IN');
    const out = await as(s).post('/api/attendance/check-out');
    expect(out.body.data).toMatchObject({ status: 'CLOSED' });
    expect(out.body.data.earlyDepartureMinutes).toBeGreaterThan(470);
    expect((await as(s).post('/api/attendance/check-in')).body.code).toBe('NO_SHIFT'.length ? 'ALREADY_CHECKED_IN' : '');
    expect((await as(s).post('/api/attendance/check-out')).body.code).toBe('NOT_CHECKED_IN');
  });

  test('on-time arrival is not late; the early check-in window is respected; customers cannot clock in', async () => {
    const a = await makeStaff(DEPTS.KITCHEN, c.manager._id); const b = await makeStaff(DEPTS.KITCHEN, c.manager._id); const far = await makeStaff(DEPTS.KITCHEN, c.manager._id);
    await as(c.manager).post('/api/shifts', shiftBody(a, 5, 480));
    await as(c.manager).post('/api/shifts', shiftBody(b, -30, 480)); // starts in 30 minutes: inside the 60-minute window
    await as(c.manager).post('/api/shifts', shiftBody(far, -180, 480)); // starts in 3 hours
    expect((await as(a).post('/api/attendance/check-in')).body.data.lateMinutes).toBe(0);
    expect((await as(b).post('/api/attendance/check-in')).body.data.lateMinutes).toBe(0);
    expect((await as(far).post('/api/attendance/check-in')).body.code).toBe('NO_SHIFT');
    expect((await as(c.customer).post('/api/attendance/check-in')).status).toBe(403);
  });

  test('corrections: staff request, manager approves (recomputed), rejects, or edits directly; all audited', async () => {
    const s = c.reception;
    await as(c.manager).post('/api/shifts', shiftBody(s, 45, 480));
    const rec = (await as(s).post('/api/attendance/check-in')).body.data;
    await as(s).post('/api/attendance/check-out');
    const earlier = new Date(Date.now() - 60 * 60_000).toISOString();
    expect((await as(s).post(`/api/attendance/${rec.id}/correction-request`, { checkInAt: earlier, reason: 'x' })).status).toBe(422);
    const req = await as(s).post(`/api/attendance/${rec.id}/correction-request`, { checkInAt: earlier, reason: 'Forgot to clock in on arrival' });
    expect(req.body.data.correction.status).toBe('PENDING');
    expect((await as(s).post(`/api/attendance/${rec.id}/correction-request`, { checkInAt: earlier, reason: 'again please' })).body.code).toBe('CORRECTION_PENDING');
    expect((await as(s).post(`/api/attendance/${rec.id}/correction/approve`)).status).toBe(403);
    const otherMgr = await (await import('../helpers/api.js')).makeUser('MANAGER');
    expect((await as(otherMgr).post(`/api/attendance/${rec.id}/correction/approve`)).status).toBe(404);
    const ok = await as(c.manager).post(`/api/attendance/${rec.id}/correction/approve`);
    expect(ok.body.data).toMatchObject({ approvedBy: String(c.manager._id), correction: { status: 'APPROVED' } });
    expect(rec.lateMinutes).toBeGreaterThanOrEqual(44);
    expect(ok.body.data.lateMinutes).toBe(0); // the corrected arrival (60 min ago) is BEFORE the shift started (45 min ago), so not late
    expect((await as(c.manager).post(`/api/attendance/${rec.id}/correction/approve`)).body.code).toBe('NO_PENDING_CORRECTION');
    const direct = await as(c.manager).patch(`/api/attendance/${rec.id}`, { checkInAt: new Date(Date.now() - 50 * 60_000 - 3_600_000).toISOString(), note: 'Verified on CCTV' });
    expect(direct.status).toBe(200);
    expect((await as(s).patch(`/api/attendance/${rec.id}`, { note: 'hack' })).status).toBe(403);
    expect(await models.AuditLog.countDocuments({ resourceType: 'Attendance', resourceId: rec.id, action: { $in: ['ATTENDANCE_CORRECTION_APPROVED', 'ATTENDANCE_CORRECTED'] } })).toBe(2);
  });

  test('visibility: staff see only their own records; managers their team; GET /staff/:id/attendance is scoped', async () => {
    const a = c.reception; const b = c.kitchen;
    await as(c.manager).post('/api/shifts', shiftBody(a, 5, 480)); await as(c.manager).post('/api/shifts', shiftBody(b, 5, 480));
    const ra = (await as(a).post('/api/attendance/check-in')).body.data; await as(b).post('/api/attendance/check-in');
    expect((await as(a).get('/api/attendance')).body.meta.total).toBe(1);
    expect((await as(b).get(`/api/attendance/${ra.id}`)).status).toBe(404);
    expect((await as(c.manager).get('/api/attendance')).body.meta.total).toBe(2);
    expect((await as(c.manager).get(`/api/staff/${a._id}/attendance`)).body.meta.total).toBe(1);
    const stranger = await (await import('../helpers/api.js')).makeUser('MANAGER');
    expect((await as(stranger).get(`/api/staff/${a._id}/attendance`)).status).toBe(404);
    expect((await as(c.admin).get('/api/attendance')).body.meta.total).toBeGreaterThanOrEqual(2);
  });

  test('jobs: open attendance becomes MISSING_CHECKOUT; shifts nobody attended become ABSENT exactly once', async () => {
    const a = await makeStaff(DEPTS.KITCHEN, c.manager._id); const b = await makeStaff(DEPTS.KITCHEN, c.manager._id);
    await as(c.manager).post('/api/shifts', shiftBody(a, 5, 60)); await as(c.manager).post('/api/shifts', shiftBody(b, 5, 60));
    await as(a).post('/api/attendance/check-in');
    const later = new Date(Date.now() + 24 * 3_600_000);
    expect(await attendanceService.markMissingCheckouts(later)).toBeGreaterThanOrEqual(1);
    expect((await Attendance.findOne({ staffId: a._id })).status).toBe('MISSING_CHECKOUT');
    expect(await attendanceService.markAbsences(later)).toBeGreaterThanOrEqual(1);
    expect((await Attendance.findOne({ staffId: b._id })).status).toBe('ABSENT');
    expect(await attendanceService.markAbsences(later)).toBe(0); // idempotent
    expect(await Attendance.countDocuments({ staffId: b._id })).toBe(1);
  });

  test('monthly report: present / late / absent / hours per staff and department, team-scoped', async () => {
    const past = addDaysToKey(keyOf(new Date()), -40); const month = past.slice(0, 7);
    const p = await makeStaff(DEPTS.KITCHEN, c.manager._id); const q = await makeStaff(DEPTS.KITCHEN, c.manager._id);
    const mk = async (u, date) => Shift.create({ staffId: u._id, date, startTime: '08:00', endTime: '16:00', department: 'KITCHEN' });
    const s1 = await mk(p, past); const s2 = await mk(p, addDaysToKey(past, 0).slice(0, 8) + '28'); await mk(q, past);
    const w = shiftWindow(s1, TZ);
    await Attendance.create({ staffId: p._id, shiftId: s1._id, date: past, checkInAt: new Date(w.start.getTime() + 30 * 60_000), checkOutAt: w.end, status: 'CLOSED', lateMinutes: 30, workedMinutes: 450 });
    await Attendance.create({ staffId: p._id, shiftId: s2._id, date: s2.date, checkInAt: shiftWindow(s2, TZ).start, checkOutAt: shiftWindow(s2, TZ).end, status: 'CLOSED', workedMinutes: 480 });
    const rep = (await as(c.manager).get(`/api/attendance/reports?month=${month}`)).body.data;
    const rp = rep.staff.find((r) => r.staffId === String(p._id)); const rq = rep.staff.find((r) => r.staffId === String(q._id));
    expect(rp).toMatchObject({ scheduledShifts: 2, present: 2, late: 1, absent: 0, workedMinutes: 930, attendanceRate: 100 });
    expect(rq).toMatchObject({ scheduledShifts: 1, present: 0, absent: 1, attendanceRate: 0 });
    expect(rep.byDepartment.find((d) => d.department === 'KITCHEN')).toMatchObject({ staff: 2, present: 2, absent: 1, late: 1 });
    const stranger = await (await import('../helpers/api.js')).makeUser('MANAGER');
    expect((await as(stranger).get(`/api/attendance/reports?month=${month}`)).body.data.staff).toHaveLength(0);
    expect((await as(c.admin).get(`/api/attendance/reports?month=${month}&department=KITCHEN`)).body.data.staff.length).toBeGreaterThanOrEqual(2);
    expect((await as(c.manager).get('/api/attendance/reports?month=2026-13')).status).toBe(422);
    expect((await as(p).get(`/api/attendance/reports?month=${month}`)).status).toBe(403);
  });
});
