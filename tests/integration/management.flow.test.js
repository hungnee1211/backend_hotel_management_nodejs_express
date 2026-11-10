import mongoose from 'mongoose';
import request from 'supertest';
import app from '../../src/app.js';
import { connectDatabase, disconnectDatabase } from '../../src/config/database.js';
import { AUDIT_ACTIONS, DEPARTMENTS, ROLES, USER_STATUS } from '../../src/constants/index.js';
import { PERMISSIONS as P } from '../../src/constants/permissions.js';
import * as models from '../../src/models/index.js';
import { hashPassword } from '../../src/utils/crypto.js';
import { signAccessToken } from '../../src/utils/token.js';
import { isDbAvailable } from '../helpers/db.js';

const { User, StaffProfile, Guest, AuditLog } = models;
const dbUp = await isDbAvailable();
const suite = dbUp ? describe : describe.skip;
if (!dbUp) console.warn('SKIPPING management integration tests: no MongoDB replica set reachable.'); // eslint-disable-line no-console

const PASSWORD = 'Passw0rdOK';
let n = 0;
const uniq = (label) => `${label}${Date.now()}${n++}`;
const email = (label = 'u') => `${uniq(label)}@example.com`;

const makeUser = async (role, extra = {}) =>
  User.create({ fullName: `${role} ${uniq('')}`, email: email(role.toLowerCase()), password: await hashPassword(PASSWORD), role, status: USER_STATUS.ACTIVE, isVerified: true, ...extra });
const bearer = (user) => ({ Authorization: `Bearer ${signAccessToken(user)}` });
const as = (user) => ({
  get: (url) => request(app).get(url).set(bearer(user)),
  post: (url, body) => request(app).post(url).set(bearer(user)).send(body),
  patch: (url, body) => request(app).patch(url).set(bearer(user)).send(body),
  delete: (url) => request(app).delete(url).set(bearer(user)),
});
const staffBody = (over = {}) => ({ fullName: 'Le Van Staff', email: email('staff'), password: PASSWORD, department: DEPARTMENTS.RECEPTION, ...over });

/** Creates a staff member through the API as `actor` and returns { id, body }. */
const createStaff = async (actor, over) => {
  const res = await as(actor).post('/api/staff', staffBody(over));
  expect(res.status).toBe(201);
  return { id: res.body.data.staff.id, staff: res.body.data.staff, email: res.body.data.staff.email };
};

suite('user, staff and guest management (real MongoDB)', () => {
  let admin; let managerA; let managerB;

  beforeAll(async () => {
    await connectDatabase();
    await Promise.all(Object.values(models).map((m) => m.init()));
  });
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await disconnectDatabase();
  });
  beforeEach(async () => {
    [admin, managerA, managerB] = await Promise.all([makeUser(ROLES.ADMIN), makeUser(ROLES.MANAGER), makeUser(ROLES.MANAGER)]);
  });

  // ------------------------------------------------------------------ managers
  describe('manager accounts', () => {
    test('Admin creates a verified manager; no secrets in the response; duplicates are refused', async () => {
      const body = { fullName: 'New Manager', email: email('mgr'), password: PASSWORD };
      const res = await as(admin).post('/api/managers', body);
      expect(res.status).toBe(201);
      expect(res.body.data.user).toMatchObject({ role: 'MANAGER', isVerified: true, status: 'ACTIVE' });
      expect(JSON.stringify(res.body)).not.toMatch(/password|tokenVersion|deletedAt/i);
      expect((await as(admin).post('/api/managers', body)).status).toBe(409);
      const login = await request(app).post('/api/auth/login').send({ identifier: body.email, password: PASSWORD });
      expect(login.status).toBe(200);
    });

    test('Managers, Staff, Customers and anonymous callers cannot create managers', async () => {
      const staff = await makeUser(ROLES.STAFF);
      const customer = await makeUser(ROLES.CUSTOMER);
      const body = { fullName: 'Sneaky', email: email('x'), password: PASSWORD };
      expect((await as(managerA).post('/api/managers', body)).status).toBe(403);
      expect((await as(staff).post('/api/managers', body)).status).toBe(403);
      expect((await as(customer).post('/api/managers', body)).status).toBe(403);
      expect((await request(app).post('/api/managers').send(body)).status).toBe(401);
    });
  });

  // ------------------------------------------------------------------ staff creation & scope
  describe('staff creation and manager scope', () => {
    test("a Manager's staff always report to that manager, even if another managerId is sent", async () => {
      const { staff } = await createStaff(managerA, { managerId: String(managerB._id) });
      expect(staff.managerId).toBe(String(managerA._id));
      expect(staff).toMatchObject({ role: 'STAFF', status: 'ACTIVE', department: 'RECEPTION', manager: { fullName: managerA.fullName } });
      expect(staff.employeeCode).toMatch(/^EMP-\d{5}$/);
      expect(JSON.stringify(staff)).not.toMatch(/password|tokenVersion/i);
    });

    test('Admin can place staff under any active manager, or leave them unassigned; invalid managers are refused', async () => {
      expect((await createStaff(admin, { managerId: String(managerB._id) })).staff.managerId).toBe(String(managerB._id));
      expect((await createStaff(admin)).staff.managerId).toBeNull();
      const customer = await makeUser(ROLES.CUSTOMER);
      expect((await as(admin).post('/api/staff', staffBody({ managerId: String(customer._id) }))).body.code).toBe('INVALID_MANAGER');
    });

    test('staff can log in with the credentials they were given', async () => {
      const { email: staffEmail } = await createStaff(managerA);
      expect((await request(app).post('/api/auth/login').send({ identifier: staffEmail, password: PASSWORD })).status).toBe(200);
    });

    test('creation is atomic: a duplicate email leaves no orphan user or profile behind', async () => {
      const taken = email('taken');
      await createStaff(managerA, { email: taken });
      const profilesBefore = await StaffProfile.countDocuments();
      const usersBefore = await User.countDocuments();
      const dup = await as(managerA).post('/api/staff', staffBody({ email: taken }));
      expect(dup.status).toBe(409);
      expect(await StaffProfile.countDocuments()).toBe(profilesBefore);
      expect(await User.countDocuments()).toBe(usersBefore);
    });

    test('employee codes are unique under concurrent creation', async () => {
      const results = await Promise.all(Array.from({ length: 6 }, () => as(managerA).post('/api/staff', staffBody())));
      expect(results.every((r) => r.status === 201)).toBe(true);
      expect(new Set(results.map((r) => r.body.data.staff.employeeCode)).size).toBe(6);
    });

    test('a Manager only sees and touches their own team; others get 404, Admin sees everyone', async () => {
      const mine = await createStaff(managerA);
      const theirs = await createStaff(managerB);
      const list = await as(managerA).get('/api/staff?limit=100');
      const ids = list.body.data.map((s) => s.id);
      expect(ids).toContain(mine.id);
      expect(ids).not.toContain(theirs.id);
      expect((await as(managerA).get(`/api/staff/${theirs.id}`)).status).toBe(404);
      expect((await as(managerA).patch(`/api/staff/${theirs.id}`, { jobTitle: 'Hacked' })).status).toBe(404);
      expect((await as(managerA).get(`/api/users/${theirs.id}`)).status).toBe(404);
      expect((await as(managerA).post(`/api/users/${theirs.id}/deactivate`)).status).toBe(404);
      expect((await as(managerA).get('/api/staff?limit=100')).body.data.every((s) => s.managerId === String(managerA._id))).toBe(true);
      expect((await as(managerA).get(`/api/staff?managerId=${managerB._id}`)).body.data.map((s) => s.id)).not.toContain(theirs.id);
      const all = (await as(admin).get('/api/staff?limit=100')).body.data.map((s) => s.id);
      expect(all).toEqual(expect.arrayContaining([mine.id, theirs.id]));
    });

    test('Staff, Customers and anonymous callers cannot use the staff directory', async () => {
      const staffUser = await makeUser(ROLES.STAFF);
      const customer = await makeUser(ROLES.CUSTOMER);
      for (const u of [staffUser, customer]) {
        expect((await as(u).get('/api/staff')).status).toBe(403);
        expect((await as(u).post('/api/staff', staffBody())).status).toBe(403);
        expect((await as(u).get('/api/users')).status).toBe(403);
      }
      expect((await request(app).get('/api/staff')).status).toBe(401);
    });

    test('listing supports search, department filter, sorting and pagination', async () => {
      const marker = uniq('Zed');
      await createStaff(managerA, { fullName: `${marker} Alpha`, department: DEPARTMENTS.KITCHEN });
      await createStaff(managerA, { fullName: `${marker} Beta`, department: DEPARTMENTS.HOUSEKEEPING });
      const found = await as(managerA).get(`/api/staff?search=${marker}&sortBy=fullName&order=asc`);
      expect(found.body.data.map((s) => s.fullName)).toEqual([`${marker} Alpha`, `${marker} Beta`]);
      expect(found.body.meta).toMatchObject({ page: 1, total: 2, totalPages: 1 });
      expect((await as(managerA).get(`/api/staff?search=${marker}&department=KITCHEN`)).body.meta.total).toBe(1);
      const page = await as(managerA).get(`/api/staff?search=${marker}&limit=1&page=2&sortBy=fullName&order=asc`);
      expect(page.body.data).toHaveLength(1);
      expect(page.body.data[0].fullName).toBe(`${marker} Beta`);
      expect((await as(managerA).get('/api/staff?limit=1000')).status).toBe(422);
    });

    test('regex characters in search are treated literally', async () => {
      expect((await as(admin).get('/api/staff?search=.*')).body.meta.total).toBe(0);
      expect((await as(admin).get('/api/users?search=(')).status).toBe(200);
    });

    test('updates: manager edits own staff details but cannot reassign managers; Admin can', async () => {
      const { id } = await createStaff(managerA);
      const ok = await as(managerA).patch(`/api/staff/${id}`, { department: 'KITCHEN', jobTitle: 'Sous chef', fullName: 'Renamed Person' });
      expect(ok.status).toBe(200);
      expect(ok.body.data.staff).toMatchObject({ department: 'KITCHEN', jobTitle: 'Sous chef', fullName: 'Renamed Person' });
      expect((await as(managerA).patch(`/api/staff/${id}`, { managerId: String(managerB._id) })).status).toBe(403);
      const moved = await as(admin).patch(`/api/staff/${id}`, { managerId: String(managerB._id) });
      expect(moved.body.data.staff.managerId).toBe(String(managerB._id));
      expect((await as(managerA).get(`/api/staff/${id}`)).status).toBe(404); // no longer theirs
      expect((await as(admin).patch(`/api/staff/${id}`, { managerId: null })).body.data.staff.managerId).toBeNull();
    });

    test('mass assignment: role, status and password in an update body are ignored', async () => {
      const { id } = await createStaff(managerA);
      const res = await as(managerA).patch(`/api/staff/${id}`, { jobTitle: 'Clerk', role: 'ADMIN', status: 'INACTIVE', password: 'Hacked12345' });
      expect(res.status).toBe(200);
      const user = await User.findById(id);
      expect(user.role).toBe('STAFF');
      expect(user.status).toBe('ACTIVE');
    });
  });

  // ------------------------------------------------------------------ permissions
  describe('staff permissions (department + overrides)', () => {
    const permsOf = async (user) => (await as(user).get('/api/auth/me')).body.data.permissions;

    test('permissions follow the department, and a department change applies immediately', async () => {
      const { id } = await createStaff(managerA, { department: DEPARTMENTS.RECEPTION });
      const staffUser = await User.findById(id);
      expect(await permsOf(staffUser)).toEqual(expect.arrayContaining([P.BOOKING_CHECKIN_CHECKOUT, P.GUEST_VIEW_IDENTIFICATION]));
      expect(await permsOf(staffUser)).not.toContain(P.HOUSEKEEPING_UPDATE);

      await as(managerA).patch(`/api/staff/${id}`, { department: 'HOUSEKEEPING' });
      const after = await permsOf(staffUser);
      expect(after).toContain(P.HOUSEKEEPING_UPDATE);
      expect(after).not.toContain(P.BOOKING_CHECKIN_CHECKOUT);
    });

    test('GET /staff/:id/permissions explains where each permission comes from', async () => {
      const { id } = await createStaff(managerA, { department: DEPARTMENTS.MAINTENANCE });
      const { data } = (await as(managerA).get(`/api/staff/${id}/permissions`)).body;
      expect(data.fromDepartment).toEqual(expect.arrayContaining([P.MAINTENANCE_WORK]));
      expect(data.effective).toEqual(expect.arrayContaining([P.ATTENDANCE_SELF, P.MAINTENANCE_WORK]));
    });

    test('overrides: grant and revoke work; revoke beats department; Admin may grant anything grantable', async () => {
      const { id } = await createStaff(managerA, { department: DEPARTMENTS.KITCHEN });
      const staffUser = await User.findById(id);
      const res = await as(managerA).patch(`/api/staff/${id}`, { permissionOverrides: { grant: [P.HOUSEKEEPING_READ], revoke: [P.ORDER_PROCESS] } });
      expect(res.status).toBe(200);
      const eff = await permsOf(staffUser);
      expect(eff).toContain(P.HOUSEKEEPING_READ);
      expect(eff).not.toContain(P.ORDER_PROCESS);
      expect((await as(admin).patch(`/api/staff/${id}`, { permissionOverrides: { grant: [P.MAINTENANCE_WORK] } })).status).toBe(200);
      expect(await permsOf(staffUser)).toContain(P.MAINTENANCE_WORK);
    });

    test('privilege escalation is blocked: sensitive permissions are never grantable, managers cannot delegate what they lack', async () => {
      const { id } = await createStaff(managerA);
      for (const caller of [managerA, admin]) {
        for (const sensitive of [P.BILLING_ADJUST, P.REPORT_FINANCIAL, P.USER_MANAGE_STAFF, P.PAYMENT_REFUND, P.AUDIT_LOG_READ]) {
          const res = await as(caller).patch(`/api/staff/${id}`, { permissionOverrides: { grant: [sensitive] } });
          expect(res.status).toBe(422);
          expect(res.body.code).toBe('PERMISSION_NOT_GRANTABLE');
        }
      }
      const delegate = await as(managerA).patch(`/api/staff/${id}`, { permissionOverrides: { grant: [P.MAINTENANCE_WORK] } }); // manager lacks it
      expect(delegate.status).toBe(403);
      expect(delegate.body.code).toBe('PERMISSION_NOT_DELEGABLE');
      expect((await as(admin).patch(`/api/staff/${id}`, { permissionOverrides: { grant: [P.ORDER_PROCESS], revoke: [P.ORDER_PROCESS] } })).status).toBe(422);
      expect((await as(admin).patch(`/api/staff/${id}`, { permissionOverrides: { grant: ['made:up'] } })).status).toBe(422);
    });

    test('a stored but non-grantable override is ignored when permissions are computed', async () => {
      const { id } = await createStaff(managerA);
      await StaffProfile.collection.updateOne({ userId: new mongoose.Types.ObjectId(id) }, { $set: { 'permissionOverrides.grant': [P.REPORT_FINANCIAL] } });
      expect(await permsOf(await User.findById(id))).not.toContain(P.REPORT_FINANCIAL);
    });

    test('staff cannot edit their own profile, department or permissions', async () => {
      const { id } = await createStaff(managerA);
      const self = await User.findById(id);
      expect((await as(self).patch(`/api/staff/${id}`, { department: 'RECEPTION', permissionOverrides: { grant: [P.ORDER_PROCESS] } })).status).toBe(403);
    });

    test('GET /staff/me returns the staff member their own profile only', async () => {
      const { id } = await createStaff(managerA);
      const res = await as(await User.findById(id)).get('/api/staff/me');
      expect(res.status).toBe(200);
      expect(res.body.data.staff.id).toBe(id);
      expect((await as(managerA).get('/api/staff/me')).status).toBe(403);
    });

    test('permission changes are audited with before and after', async () => {
      const { id } = await createStaff(managerA, { department: DEPARTMENTS.KITCHEN });
      await as(managerA).patch(`/api/staff/${id}`, { department: 'RESTAURANT' });
      const entry = await AuditLog.findOne({ action: AUDIT_ACTIONS.STAFF_PERMISSIONS_CHANGED, resourceId: id });
      expect(entry.actorId.toString()).toBe(String(managerA._id));
      expect(entry.before.department).toBe('KITCHEN');
      expect(entry.after.department).toBe('RESTAURANT');
    });
  });

  // ------------------------------------------------------------------ lifecycle
  describe('deactivation, reactivation, deletion and manager hand-over', () => {
    test('deactivating staff blocks login and live tokens; reactivation restores access', async () => {
      const { id, email: staffEmail } = await createStaff(managerA);
      const staffUser = await User.findById(id);
      const token = signAccessToken(staffUser);
      expect((await as(managerA).post(`/api/users/${id}/deactivate`)).status).toBe(200);
      expect((await request(app).post('/api/auth/login').send({ identifier: staffEmail, password: PASSWORD })).body.code).toBe('ACCOUNT_DISABLED');
      expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`)).body.code).toBe('ACCOUNT_DISABLED');
      expect((await as(managerA).post(`/api/users/${id}/reactivate`)).status).toBe(200);
      // reactivation does NOT resurrect old sessions: the token from before the deactivation stays dead
      expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`)).body.code).toBe('TOKEN_REVOKED');
      expect((await request(app).post('/api/auth/login').send({ identifier: staffEmail, password: PASSWORD })).status).toBe(200);
    });

    test('nobody can deactivate themselves; admin accounts are protected from other admins', async () => {
      const otherAdmin = await makeUser(ROLES.ADMIN);
      expect((await as(admin).post(`/api/users/${admin._id}/deactivate`)).body.code).toBe('SELF_ACTION_FORBIDDEN');
      for (const call of [
        as(admin).post(`/api/users/${otherAdmin._id}/deactivate`),
        as(admin).patch(`/api/users/${otherAdmin._id}`, { fullName: 'Taken Over' }),
        as(admin).delete(`/api/users/${otherAdmin._id}`),
      ]) {
        const res = await call;
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('ADMIN_PROTECTED');
      }
    });

    test('managers cannot touch admins, other managers or customers', async () => {
      const customer = await makeUser(ROLES.CUSTOMER);
      for (const target of [admin, managerB, customer]) {
        expect((await as(managerA).post(`/api/users/${target._id}/deactivate`)).status).toBe(404);
        expect((await as(managerA).get(`/api/users/${target._id}`)).status).toBe(404);
      }
    });

    test('a manager with active staff cannot be deactivated or deleted until the staff are transferred', async () => {
      const { id } = await createStaff(managerA);
      expect((await as(admin).post(`/api/users/${managerA._id}/deactivate`)).body.code).toBe('MANAGER_HAS_ACTIVE_STAFF');
      expect((await as(admin).delete(`/api/users/${managerA._id}`)).body.code).toBe('MANAGER_HAS_ACTIVE_STAFF');

      expect((await as(managerA).post(`/api/managers/${managerA._id}/transfer-staff`, { toManagerId: String(managerB._id) })).status).toBe(403);
      const moved = await as(admin).post(`/api/managers/${managerA._id}/transfer-staff`, { toManagerId: String(managerB._id) });
      expect(moved.status).toBe(200);
      expect(moved.body.data.transferred).toBe(1);
      expect((await as(managerB).get(`/api/staff/${id}`)).status).toBe(200);
      expect((await as(admin).post(`/api/users/${managerA._id}/deactivate`)).status).toBe(200);
    });

    test('transfer validates both managers', async () => {
      const customer = await makeUser(ROLES.CUSTOMER);
      expect((await as(admin).post(`/api/managers/${managerA._id}/transfer-staff`, { toManagerId: String(managerA._id) })).body.code).toBe('SAME_MANAGER');
      expect((await as(admin).post(`/api/managers/${managerA._id}/transfer-staff`, { toManagerId: String(customer._id) })).body.code).toBe('INVALID_MANAGER');
      await User.updateOne({ _id: managerB._id }, { $set: { status: USER_STATUS.INACTIVE } });
      expect((await as(admin).post(`/api/managers/${managerA._id}/transfer-staff`, { toManagerId: String(managerB._id) })).body.code).toBe('INVALID_MANAGER');
    });

    test('soft delete: Admin only, hides the user, ends sessions, keeps the email reserved', async () => {
      const { id, email: staffEmail } = await createStaff(managerA);
      expect((await as(managerA).delete(`/api/users/${id}`)).status).toBe(403);
      expect((await as(admin).delete(`/api/users/${id}`)).status).toBe(200);
      expect((await as(admin).get(`/api/users/${id}`)).status).toBe(404);
      expect((await as(admin).get(`/api/staff/${id}`)).status).toBe(404);
      expect((await request(app).post('/api/auth/login').send({ identifier: staffEmail, password: PASSWORD })).status).toBe(401);
      expect((await as(admin).post('/api/staff', staffBody({ email: staffEmail }))).status).toBe(409);
      expect(await User.findById(id)).toBeTruthy(); // the record itself is kept
    });
  });

  // ------------------------------------------------------------------ users directory
  describe('user directory', () => {
    test('Admin filters by role/status/search with pagination; Manager sees only their own staff', async () => {
      const marker = uniq('Findme');
      const customer = await makeUser(ROLES.CUSTOMER, { fullName: `${marker} Customer` });
      const { id } = await createStaff(managerA, { fullName: `${marker} Staff` });
      const byRole = await as(admin).get(`/api/users?search=${marker}&role=CUSTOMER`);
      expect(byRole.body.data.map((u) => u.id)).toEqual([String(customer._id)]);
      expect(byRole.body.meta.total).toBe(1);
      expect((await as(admin).get(`/api/users?search=${marker}`)).body.meta.total).toBe(2);
      expect(JSON.stringify(byRole.body)).not.toMatch(/"password"/);

      const mine = await as(managerA).get(`/api/users?search=${marker}`);
      expect(mine.body.data.map((u) => u.id)).toEqual([id]);
      expect((await as(managerA).get(`/api/users?search=${marker}&role=CUSTOMER`)).body.meta.total).toBe(0);
    });

    test('profile edit by a manager is limited to name/avatar and scoped to their team', async () => {
      const { id } = await createStaff(managerA);
      const res = await as(managerA).patch(`/api/users/${id}`, { fullName: 'Edited Name', email: 'new@x.com', role: 'ADMIN' });
      expect(res.status).toBe(200);
      expect(res.body.data.user.fullName).toBe('Edited Name');
      expect(res.body.data.user.role).toBe('STAFF');
      expect(res.body.data.user.email).not.toBe('new@x.com');
      expect((await as(managerA).patch(`/api/users/${id}`, {})).status).toBe(422);
    });

    test('invalid ids are rejected before touching the database', async () => {
      expect((await as(admin).get('/api/users/not-an-id')).status).toBe(422);
      expect((await as(admin).get(`/api/staff/${new mongoose.Types.ObjectId()}`)).status).toBe(404);
    });
  });

  // ------------------------------------------------------------------ guests
  describe('guests', () => {
    const guestBody = (over = {}) => ({
      fullName: 'Nguyen Khach', phone: `+8490${String(Date.now()).slice(-7)}${n++ % 10}`, nationality: 'VN',
      identification: { type: 'PASSPORT', number: `B${String(Date.now()).slice(-6)}${n++}` }, ...over,
    });
    let reception; let housekeeper; let customer;
    beforeEach(async () => {
      reception = await User.findById((await createStaff(managerA, { department: DEPARTMENTS.RECEPTION })).id);
      housekeeper = await User.findById((await createStaff(managerA, { department: DEPARTMENTS.HOUSEKEEPING })).id);
      customer = await makeUser(ROLES.CUSTOMER);
    });

    test('ID numbers are encrypted at rest and masked in every default response', async () => {
      const body = guestBody({ identification: { type: 'PASSPORT', number: 'B9988776' } });
      const res = await as(reception).post('/api/guests', body);
      expect(res.status).toBe(201);
      expect(res.body.data.guest.identification).toEqual({ type: 'PASSPORT', maskedNumber: '****8776' });
      expect(JSON.stringify(res.body)).not.toContain('B9988776');

      const raw = await Guest.collection.findOne({ _id: new mongoose.Types.ObjectId(res.body.data.guest.id) });
      expect(JSON.stringify(raw)).not.toContain('B9988776');
      expect(raw.identification.numberEncrypted.startsWith('v1.')).toBe(true);

      const fetched = await as(reception).get(`/api/guests/${res.body.data.guest.id}`);
      expect(JSON.stringify(fetched.body)).not.toContain('B9988776');
      const listed = await as(admin).get('/api/guests?limit=100');
      expect(JSON.stringify(listed.body)).not.toContain('B9988776');
    });

    test('revealing the full number needs the permission and is audited every time', async () => {
      const created = (await as(reception).post('/api/guests', guestBody({ identification: { type: 'PASSPORT', number: 'C5544332' } }))).body.data.guest;
      const reveal = await as(reception).get(`/api/guests/${created.id}?revealIdentification=true`);
      expect(reveal.body.data.guest.identification).toMatchObject({ number: 'C5544332', maskedNumber: '****4332' });
      await as(managerA).get(`/api/guests/${created.id}?revealIdentification=true`);
      expect(await AuditLog.countDocuments({ action: AUDIT_ACTIONS.GUEST_ID_VIEWED, resourceId: created.id })).toBe(2);

      expect((await as(housekeeper).get(`/api/guests/${created.id}?revealIdentification=true`)).status).toBe(403);
      expect((await as(customer).get(`/api/guests/${created.id}?revealIdentification=true`)).body.code).toBe('ID_VIEW_FORBIDDEN');
    });

    test('lookup by ID number finds a returning guest; the same ID cannot be registered twice', async () => {
      const body = guestBody({ identification: { type: 'NATIONAL_ID', number: '079 090 123456' } });
      const first = (await as(reception).post('/api/guests', body)).body.data.guest;
      const found = await as(reception).get('/api/guests?idNumber=079090123456');
      expect(found.body.data.map((g) => g.id)).toEqual([first.id]);
      const dup = await as(reception).post('/api/guests', guestBody({ identification: { type: 'NATIONAL_ID', number: '079-090-123456' } }));
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe('GUEST_EXISTS');
      expect(dup.body.errors[0].guestId).toBe(first.id);
    });

    test('staff outside the front desk cannot read or create guests; anonymous is 401', async () => {
      expect((await as(housekeeper).get('/api/guests')).status).toBe(403);
      expect((await as(housekeeper).post('/api/guests', guestBody())).status).toBe(403);
      expect((await request(app).get('/api/guests')).status).toBe(401);
    });

    test('customers only see and edit guests they own; they cannot link accounts or look into others', async () => {
      const walkIn = (await as(reception).post('/api/guests', guestBody())).body.data.guest;
      const companion = await as(customer).post('/api/guests', guestBody({ fullName: 'My Companion' }));
      expect(companion.status).toBe(201);
      const companionId = companion.body.data.guest.id;

      const mine = await as(customer).get('/api/guests?limit=100');
      expect(mine.body.data.map((g) => g.id)).toEqual([companionId]);
      expect((await as(customer).get(`/api/guests/${walkIn.id}`)).status).toBe(404);
      expect((await as(customer).patch(`/api/guests/${walkIn.id}`, { notes: 'x' })).status).toBe(404);
      expect((await as(customer).patch(`/api/guests/${companionId}`, { notes: 'Vegetarian' })).body.data.guest.notes).toBe('Vegetarian');
      expect((await as(customer).post('/api/guests', guestBody({ userId: String(customer._id) }))).status).toBe(403);
      expect((await as(customer).delete(`/api/guests/${companionId}`)).status).toBe(403);
      // customers are not told whether an ID is already registered by someone else
      const sameId = guestBody({ identification: { type: 'PASSPORT', number: 'D1112223' } });
      await as(reception).post('/api/guests', sameId);
      expect((await as(customer).post('/api/guests', sameId)).status).toBe(201);
      // another customer cannot see it either
      const other = await makeUser(ROLES.CUSTOMER);
      expect((await as(other).get(`/api/guests/${companionId}`)).status).toBe(404);
    });

    test('front desk can link a walk-in to a customer account, but only to real customers', async () => {
      const guest = (await as(reception).post('/api/guests', guestBody())).body.data.guest;
      const linked = await as(reception).patch(`/api/guests/${guest.id}`, { userId: String(customer._id) });
      expect(linked.status).toBe(200);
      expect(linked.body.data.guest.userId).toBe(String(customer._id));
      expect((await as(customer).get(`/api/guests/${guest.id}`)).status).toBe(200); // now their own profile
      expect((await as(reception).patch(`/api/guests/${guest.id}`, { userId: String(managerA._id) })).status).toBe(422);
      expect((await as(reception).post('/api/guests', guestBody({ userId: String(housekeeper._id) }))).status).toBe(422);
    });

    test('updating and clearing identification; validation of ID format and addresses', async () => {
      const guest = (await as(reception).post('/api/guests', guestBody())).body.data.guest;
      const changed = await as(reception).patch(`/api/guests/${guest.id}`, { identification: { type: 'DRIVER_LICENSE', number: 'DL-556677' }, address: { city: 'Da Nang', country: 'Vietnam' } });
      expect(changed.body.data.guest.identification).toEqual({ type: 'DRIVER_LICENSE', maskedNumber: '****6677' });
      expect(changed.body.data.guest.address).toMatchObject({ city: 'Da Nang' });
      expect((await as(reception).patch(`/api/guests/${guest.id}`, { identification: null })).body.data.guest.identification).toBeNull();
      expect((await as(reception).post('/api/guests', guestBody({ identification: { type: 'PASSPORT', number: '12' } }))).status).toBe(422);
      expect((await as(reception).post('/api/guests', guestBody({ identification: { type: 'ALIEN_CARD', number: 'ABCD1234' } }))).status).toBe(422);
    });

    test('delete is Manager/Admin only, hides the guest, and is audited', async () => {
      const guest = (await as(reception).post('/api/guests', guestBody())).body.data.guest;
      expect((await as(reception).delete(`/api/guests/${guest.id}`)).status).toBe(403);
      expect((await as(managerA).delete(`/api/guests/${guest.id}`)).status).toBe(200);
      expect((await as(admin).get(`/api/guests/${guest.id}`)).status).toBe(404);
      expect(await AuditLog.countDocuments({ action: AUDIT_ACTIONS.GUEST_DELETED, resourceId: guest.id })).toBe(1);
      expect(await Guest.findById(guest.id)).toBeTruthy();
    });

    test('audit entries for guests never contain the ID number or its ciphertext', async () => {
      const guest = (await as(reception).post('/api/guests', guestBody({ identification: { type: 'PASSPORT', number: 'E7766554' } }))).body.data.guest;
      await as(reception).patch(`/api/guests/${guest.id}`, { notes: 'late arrival' });
      const entries = await AuditLog.find({ resourceId: guest.id });
      expect(entries.length).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(entries)).not.toMatch(/E7766554|numberEncrypted|numberHash|v1\./);
    });
  });
});
