import { ROLES } from '../../src/constants/index.js';
import { DEPARTMENTS } from '../../src/constants/index.js';
import { PERMISSIONS as P, ROLE_PERMISSIONS, STAFF_GRANTABLE, effectivePermissions, hasPermission } from '../../src/constants/permissions.js';

describe('role / permission matrix', () => {
  test('Admin has every permission', () => {
    expect(ROLE_PERMISSIONS[ROLES.ADMIN]).toEqual(Object.values(P));
  });

  test('only Admin manages managers, settings, tax rules and reads audit logs', () => {
    for (const perm of [P.USER_MANAGE_MANAGERS, P.SETTINGS_MANAGE, P.TAX_RULE_MANAGE, P.AUDIT_LOG_READ]) {
      expect(hasPermission(ROLES.ADMIN, perm)).toBe(true);
      expect(hasPermission(ROLES.MANAGER, perm)).toBe(false);
      expect(hasPermission(ROLES.STAFF, perm)).toBe(false);
      expect(hasPermission(ROLES.CUSTOMER, perm)).toBe(false);
    }
  });

  test('Manager manages staff but not other managers', () => {
    expect(hasPermission(ROLES.MANAGER, P.USER_MANAGE_STAFF)).toBe(true);
    expect(hasPermission(ROLES.MANAGER, P.USER_MANAGE_MANAGERS)).toBe(false);
  });

  test('Staff role alone (no department) gets only the common base permissions', () => {
    expect(hasPermission(ROLES.STAFF, P.ROOM_READ)).toBe(true);
    expect(hasPermission(ROLES.STAFF, P.ATTENDANCE_SELF)).toBe(true);
    expect(hasPermission(ROLES.STAFF, P.BOOKING_CHECKIN_CHECKOUT)).toBe(false);
    expect(hasPermission(ROLES.STAFF, P.ORDER_PROCESS)).toBe(false);
  });

  test('Staff can never hold financial, pricing, reporting or user-management permissions via any department', () => {
    const forbidden = [P.REPORT_FINANCIAL, P.REPORT_OPERATIONAL, P.ROOM_PRICING_MANAGE, P.USER_MANAGE_STAFF, P.USER_MANAGE_MANAGERS,
      P.INVOICE_MANAGE, P.BILLING_ADJUST, P.PAYMENT_REFUND, P.AUDIT_LOG_READ, P.SETTINGS_MANAGE, P.STAFF_PERMISSIONS_MANAGE];
    for (const dept of Object.values(DEPARTMENTS)) {
      const eff = effectivePermissions({ role: ROLES.STAFF, staffProfile: { department: dept } });
      for (const perm of forbidden) expect(eff.has(perm)).toBe(false);
    }
    for (const perm of forbidden) expect(STAFF_GRANTABLE.has(perm)).toBe(false);
  });

  test('Customer only gets "own" permissions plus read-only catalogue access', () => {
    const ownOrReadOnly = /:own$|^(room|menu|service):read$/;
    for (const perm of ROLE_PERMISSIONS[ROLES.CUSTOMER]) expect(perm).toMatch(ownOrReadOnly);
  });

  test('unknown roles and permissions are denied', () => {
    expect(hasPermission('HACKER', P.ROOM_READ)).toBe(false);
    expect(hasPermission(ROLES.ADMIN, 'not:a:permission')).toBe(false); // deny by default, even for Admin
  });
});
