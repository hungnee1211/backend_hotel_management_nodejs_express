import { ROLES } from '../../src/constants/index.js';
import { PERMISSIONS as P } from '../../src/constants/permissions.js';
import { authorizeAnyPermission, authorizePermissions, authorizeResourceOwnership, authorizeRoles } from '../../src/middlewares/authorize.js';

const run = async (mw, user, req = {}) => {
  let error;
  await new Promise((resolve) => {
    mw({ user, params: {}, ...req }, {}, (err) => { error = err; resolve(); });
  });
  return error;
};
const asUser = (role, id = 'u1') => ({ _id: id, role });

describe('authorizeRoles', () => {
  test('allows listed roles, rejects others and anonymous', async () => {
    const mw = authorizeRoles(ROLES.ADMIN, ROLES.MANAGER);
    expect(await run(mw, asUser(ROLES.ADMIN))).toBeUndefined();
    expect((await run(mw, asUser(ROLES.STAFF))).statusCode).toBe(403);
    expect((await run(mw, undefined)).statusCode).toBe(403);
  });
});

describe('authorizePermissions', () => {
  test('requires every listed permission', async () => {
    const both = authorizePermissions(P.BOOKING_CHECKIN_CHECKOUT, P.GUEST_READ);
    expect(await run(both, asUser(ROLES.MANAGER))).toBeUndefined();
    expect((await run(both, asUser(ROLES.STAFF))).statusCode).toBe(403); // department-less staff
    // permissions computed by `authenticate` (department/overrides) take precedence over the role table
    expect(await run(both, asUser(ROLES.STAFF), { permissions: new Set([P.BOOKING_CHECKIN_CHECKOUT, P.GUEST_READ]) })).toBeUndefined();
    expect((await run(both, asUser(ROLES.CUSTOMER))).statusCode).toBe(403);
    const mixed = authorizePermissions(P.GUEST_READ, P.REPORT_FINANCIAL);
    expect(await run(mixed, asUser(ROLES.MANAGER))).toBeUndefined();
    expect((await run(mixed, asUser(ROLES.STAFF))).statusCode).toBe(403);
  });
});

describe('authorizeResourceOwnership', () => {
  const mw = authorizeResourceOwnership(async (req) => req.params.ownerId);

  test('owner passes, other users are rejected, Admin bypasses', async () => {
    expect(await run(mw, asUser(ROLES.CUSTOMER, 'u1'), { params: { ownerId: 'u1' } })).toBeUndefined();
    expect((await run(mw, asUser(ROLES.CUSTOMER, 'u1'), { params: { ownerId: 'u2' } })).statusCode).toBe(403);
    expect(await run(mw, asUser(ROLES.ADMIN, 'a1'), { params: { ownerId: 'u2' } })).toBeUndefined();
  });

  test('Manager is NOT a bypass role by default (scope is checked by services)', async () => {
    expect((await run(mw, asUser(ROLES.MANAGER, 'm1'), { params: { ownerId: 'u2' } })).statusCode).toBe(403);
  });

  test('a missing owner is forbidden, and resolver errors propagate', async () => {
    expect((await run(mw, asUser(ROLES.CUSTOMER), { params: { ownerId: undefined } })).statusCode).toBe(403);
    const failing = authorizeResourceOwnership(async () => { throw new Error('boom'); });
    expect((await run(failing, asUser(ROLES.CUSTOMER))).message).toBe('boom');
  });
});

describe('authorizeAnyPermission', () => {
  test('passes with at least one listed permission', async () => {
    const mw = authorizeAnyPermission(P.GUEST_READ, P.GUEST_MANAGE_OWN);
    expect(await run(mw, asUser(ROLES.CUSTOMER))).toBeUndefined();
    expect(await run(mw, asUser(ROLES.MANAGER))).toBeUndefined();
    expect((await run(mw, asUser(ROLES.STAFF))).statusCode).toBe(403);
  });
});
