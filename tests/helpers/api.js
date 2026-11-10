import mongoose from 'mongoose';
import request from 'supertest';
import app from '../../src/app.js';
import { connectDatabase, disconnectDatabase } from '../../src/config/database.js';
import { DEPARTMENTS, ROLES, USER_STATUS } from '../../src/constants/index.js';
import * as models from '../../src/models/index.js';
import { hashPassword } from '../../src/utils/crypto.js';
import { addDaysToKey, toLocalDateKey } from '../../src/utils/dates.js';
import { signAccessToken } from '../../src/utils/token.js';
import { isDbAvailable } from './db.js';

export { app, models, request, mongoose };
export const PASSWORD = 'Passw0rdOK';
export const dbUp = await isDbAvailable();
export const suite = dbUp ? describe : describe.skip;
let n = 0;
export const uniq = (label = 'x') => `${label}${Date.now().toString(36)}${n++}`;
export const email = (label = 'u') => `${uniq(label)}@example.com`;

export const setupDb = () => {
  beforeAll(async () => { await connectDatabase(); await Promise.all(Object.values(models).map((m) => m.init())); });
  afterAll(async () => { await mongoose.connection.dropDatabase(); await disconnectDatabase(); });
};

export const makeUser = async (role, extra = {}) =>
  models.User.create({ fullName: `${role} ${uniq('')}`, email: email(role.toLowerCase()), password: await hashPassword(PASSWORD), role, status: USER_STATUS.ACTIVE, isVerified: true, ...extra });

/** Creates a STAFF user + profile directly (fast path for tests). */
export const makeStaff = async (department, managerId = null, extra = {}) => {
  const user = await makeUser(ROLES.STAFF, extra);
  await models.StaffProfile.create({ userId: user._id, employeeCode: `T-${uniq('')}`, department, managerId });
  return user;
};
export const as = (user) => {
  const h = { Authorization: `Bearer ${signAccessToken(user)}` };
  return {
    get: (u) => request(app).get(u).set(h),
    post: (u, b) => request(app).post(u).set(h).send(b),
    patch: (u, b) => request(app).patch(u).set(h).send(b),
    put: (u, b) => request(app).put(u).set(h).send(b),
    delete: (u) => request(app).delete(u).set(h),
    raw: (u) => request(app).get(u).set(h).buffer(true),
  };
};
export const today = async () => toLocalDateKey(new Date(), (await (await import('../../src/modules/settings/settings.service.js')).settingsService.get()).timezone);
export const inDays = async (d) => addDaysToKey(await today(), d);
export const DEPTS = DEPARTMENTS;
export { ROLES };

/** A cast of users for most scenarios. */
export const cast = async () => {
  const [admin, manager, customer, customer2] = await Promise.all([makeUser(ROLES.ADMIN), makeUser(ROLES.MANAGER), makeUser(ROLES.CUSTOMER), makeUser(ROLES.CUSTOMER)]);
  const [reception, housekeeper, kitchen, maintenance] = await Promise.all([
    makeStaff(DEPARTMENTS.RECEPTION, manager._id), makeStaff(DEPARTMENTS.HOUSEKEEPING, manager._id), makeStaff(DEPARTMENTS.RESTAURANT, manager._id), makeStaff(DEPARTMENTS.MAINTENANCE, manager._id),
  ]);
  return { admin, manager, customer, customer2, reception, housekeeper, kitchen, maintenance };
};

/** Room type + N rooms through the API. Returns { type, rooms }. */
export const makeRooms = async (admin, count = 2, { price = 1_000_000, capacity = 2, name } = {}) => {
  const t = await as(admin).post('/api/room-types', { name: name ?? uniq('Deluxe'), capacity, basePriceMinor: price, amenities: ['wifi', 'tv'] });
  const type = t.body.data;
  const rooms = [];
  for (let i = 0; i < count; i += 1) {
    const r = await as(admin).post('/api/rooms', { roomNumber: uniq('R'), floor: 1 + i, roomTypeId: type.id });
    rooms.push(r.body.data);
  }
  return { type, rooms };
};
