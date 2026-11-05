import { DEPARTMENTS, ROLES } from './index.js';

/**
 * Central permission catalogue. Routes reference these names; the tables below are the ONLY place that
 * decides what each role / department may do.
 *
 * A permission grants the *kind* of action. Scope (own records, own staff, own facilities) is still
 * enforced per resource in services. "Manager scope" is not encoded here.
 */
export const PERMISSIONS = Object.freeze({
  // Users & staff
  USER_READ: 'user:read',
  USER_MANAGE_MANAGERS: 'user:manage:managers',
  USER_MANAGE_STAFF: 'user:manage:staff',
  STAFF_PERMISSIONS_MANAGE: 'staff:permissions:manage',
  // Hotel configuration
  SETTINGS_MANAGE: 'settings:manage',
  TAX_RULE_MANAGE: 'tax-rule:manage',
  // Rooms
  ROOM_READ: 'room:read',
  ROOM_MANAGE: 'room:manage',
  ROOM_PRICING_MANAGE: 'room:pricing:manage',
  // Bookings & guests
  BOOKING_CREATE_OWN: 'booking:create:own',
  BOOKING_CREATE_FOR_GUEST: 'booking:create:guest',
  BOOKING_READ_OWN: 'booking:read:own',
  BOOKING_READ_ALL: 'booking:read:all',
  BOOKING_MANAGE: 'booking:manage',
  BOOKING_CANCEL_OWN: 'booking:cancel:own',
  BOOKING_CANCEL_ANY: 'booking:cancel:any',
  BOOKING_CHECKIN_CHECKOUT: 'booking:checkin-checkout',
  GUEST_READ: 'guest:read',
  GUEST_MANAGE: 'guest:manage',
  GUEST_MANAGE_OWN: 'guest:manage:own',
  GUEST_VIEW_IDENTIFICATION: 'guest:view-identification',
  GUEST_DELETE: 'guest:delete',
  // Housekeeping
  HOUSEKEEPING_READ: 'housekeeping:read',
  HOUSEKEEPING_UPDATE: 'housekeeping:update',
  HOUSEKEEPING_ASSIGN: 'housekeeping:assign',
  // Shifts & attendance
  SHIFT_MANAGE: 'shift:manage',
  ATTENDANCE_SELF: 'attendance:self',
  ATTENDANCE_READ_TEAM: 'attendance:read:team',
  ATTENDANCE_APPROVE: 'attendance:approve',
  // Food & beverage
  MENU_READ: 'menu:read',
  MENU_MANAGE: 'menu:manage',
  ORDER_CREATE_OWN: 'order:create:own',
  ORDER_READ_OWN: 'order:read:own',
  ORDER_PROCESS: 'order:process',
  ORDER_MANAGE: 'order:manage',
  // Additional services
  SERVICE_READ: 'service:read',
  SERVICE_MANAGE: 'service:manage',
  SERVICE_REQUEST_OWN: 'service:request:own',
  SERVICE_FULFILL: 'service:fulfill',
  // Facilities, equipment, maintenance
  FACILITY_READ: 'facility:read',
  FACILITY_MANAGE: 'facility:manage',
  EQUIPMENT_READ: 'equipment:read',
  EQUIPMENT_MANAGE: 'equipment:manage',
  MAINTENANCE_REPORT: 'maintenance:report',
  MAINTENANCE_WORK: 'maintenance:work',
  MAINTENANCE_MANAGE: 'maintenance:manage',
  // Billing & payments
  BILLING_READ_OWN: 'billing:read:own',
  BILLING_READ_ALL: 'billing:read:all',
  BILLING_ADJUST: 'billing:adjust',
  PAYMENT_CREATE: 'payment:create',
  PAYMENT_REFUND: 'payment:refund',
  INVOICE_READ_OWN: 'invoice:read:own',
  INVOICE_MANAGE: 'invoice:manage',
  // Reports & system
  REPORT_OPERATIONAL: 'report:operational',
  REPORT_FINANCIAL: 'report:financial',
  AUDIT_LOG_READ: 'audit-log:read',
});

const P = PERMISSIONS;
export const ALL_PERMISSIONS = Object.freeze(Object.values(P));

const MANAGER = [
  P.USER_READ, P.USER_MANAGE_STAFF, P.STAFF_PERMISSIONS_MANAGE,
  P.ROOM_READ, P.ROOM_MANAGE, P.ROOM_PRICING_MANAGE,
  P.BOOKING_CREATE_FOR_GUEST, P.BOOKING_READ_ALL, P.BOOKING_MANAGE, P.BOOKING_CANCEL_ANY,
  P.BOOKING_CHECKIN_CHECKOUT,
  P.GUEST_READ, P.GUEST_MANAGE, P.GUEST_VIEW_IDENTIFICATION, P.GUEST_DELETE,
  P.HOUSEKEEPING_READ, P.HOUSEKEEPING_UPDATE, P.HOUSEKEEPING_ASSIGN,
  P.SHIFT_MANAGE, P.ATTENDANCE_SELF, P.ATTENDANCE_READ_TEAM, P.ATTENDANCE_APPROVE,
  P.MENU_READ, P.MENU_MANAGE, P.ORDER_PROCESS, P.ORDER_MANAGE,
  P.SERVICE_READ, P.SERVICE_MANAGE, P.SERVICE_FULFILL,
  P.FACILITY_READ, P.FACILITY_MANAGE, P.EQUIPMENT_READ, P.EQUIPMENT_MANAGE,
  P.MAINTENANCE_REPORT, P.MAINTENANCE_MANAGE,
  P.BILLING_READ_ALL, P.BILLING_ADJUST, P.PAYMENT_CREATE, P.PAYMENT_REFUND, P.INVOICE_MANAGE,
  P.REPORT_OPERATIONAL, P.REPORT_FINANCIAL, // both limited to the manager's scope by the services
];

/** What EVERY staff member gets, whatever their department. */
const STAFF_BASE = [P.ROOM_READ, P.ATTENDANCE_SELF, P.MENU_READ, P.SERVICE_READ, P.FACILITY_READ, P.MAINTENANCE_REPORT];

/** Added on top of STAFF_BASE according to the staff member's department. */
export const DEPARTMENT_PERMISSIONS = Object.freeze({
  [DEPARTMENTS.RECEPTION]: [
    P.BOOKING_CREATE_FOR_GUEST, P.BOOKING_READ_ALL, P.BOOKING_CHECKIN_CHECKOUT,
    P.GUEST_READ, P.GUEST_MANAGE, P.GUEST_VIEW_IDENTIFICATION,
    P.HOUSEKEEPING_READ, P.PAYMENT_CREATE,
  ],
  [DEPARTMENTS.HOUSEKEEPING]: [P.HOUSEKEEPING_READ, P.HOUSEKEEPING_UPDATE, P.SERVICE_FULFILL],
  [DEPARTMENTS.RESTAURANT]: [P.ORDER_PROCESS, P.PAYMENT_CREATE],
  [DEPARTMENTS.KITCHEN]: [P.ORDER_PROCESS],
  [DEPARTMENTS.MAINTENANCE]: [P.MAINTENANCE_WORK, P.EQUIPMENT_READ],
});

/**
 * The ONLY permissions an individual override may grant to a staff member: whatever some department
 * already has. Financial, reporting, pricing, user-management and audit permissions can never be
 * granted to Staff, however an override is written.
 */
export const STAFF_GRANTABLE = Object.freeze(new Set(Object.values(DEPARTMENT_PERMISSIONS).flat()));

const CUSTOMER = [
  P.ROOM_READ,
  P.BOOKING_CREATE_OWN, P.BOOKING_READ_OWN, P.BOOKING_CANCEL_OWN,
  P.GUEST_MANAGE_OWN,
  P.MENU_READ, P.ORDER_CREATE_OWN, P.ORDER_READ_OWN,
  P.SERVICE_READ, P.SERVICE_REQUEST_OWN,
  P.BILLING_READ_OWN, P.INVOICE_READ_OWN,
];

/** Role-level permissions. For STAFF this is only the base; use effectivePermissions() for a real user. */
export const ROLE_PERMISSIONS = Object.freeze({
  [ROLES.ADMIN]: ALL_PERMISSIONS,
  [ROLES.MANAGER]: Object.freeze(MANAGER),
  [ROLES.STAFF]: Object.freeze(STAFF_BASE),
  [ROLES.CUSTOMER]: Object.freeze(CUSTOMER),
});

/**
 * The permissions a user actually holds.
 *   ADMIN / MANAGER / CUSTOMER: the role table.
 *   STAFF: base + department permissions + individually granted - individually revoked.
 * Revokes win over grants. Grants outside STAFF_GRANTABLE are ignored even if stored.
 */
export const effectivePermissions = ({ role, staffProfile } = {}) => {
  const set = new Set(ROLE_PERMISSIONS[role] ?? []);
  if (role === ROLES.STAFF && staffProfile) {
    for (const p of DEPARTMENT_PERMISSIONS[staffProfile.department] ?? []) set.add(p);
    for (const p of staffProfile.permissionOverrides?.grant ?? []) if (STAFF_GRANTABLE.has(p)) set.add(p);
    for (const p of staffProfile.permissionOverrides?.revoke ?? []) set.delete(p);
  }
  return set;
};

/** Role-only check (for STAFF this ignores department; prefer req.permissions inside requests). */
export const hasPermission = (role, permission) => ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
