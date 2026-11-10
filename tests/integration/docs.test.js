import request from 'supertest';
import app from '../../src/app.js';
import { buildOpenApi } from '../../src/docs/openapi.js';
import { toJsonSchema } from '../../src/docs/joi-schema.js';
import Joi from 'joi';

const spec = buildOpenApi(app);
const ops = Object.entries(spec.paths).flatMap(([path, o]) => Object.entries(o).map(([method, op]) => ({ method: method.toUpperCase(), path, op })));

/** Endpoints that intentionally allow ANY logged-in user (they only ever return/modify the caller's own data). */
const ANY_AUTHENTICATED = new Set([
  'GET /api/auth/me', 'PATCH /api/auth/me', 'POST /api/auth/change-password', 'POST /api/auth/logout-all', 'POST /api/auth/deactivate',
  'GET /api/dashboard', 'GET /api/notifications', 'POST /api/notifications/read-all', 'POST /api/notifications/{id}/read',
]);
const PUBLIC = new Set(['POST /api/auth/register', 'POST /api/auth/verify-otp', 'POST /api/auth/resend-otp', 'POST /api/auth/login', 'POST /api/auth/refresh', 'POST /api/auth/logout', 'POST /api/auth/forgot-password', 'POST /api/auth/reset-password', 'GET /api/health', 'GET /api/health/ready', 'POST /api/payments/webhook']);

describe('generated API documentation', () => {
  test('covers the whole API surface', () => {
    expect(ops.length).toBeGreaterThan(150);
    for (const tag of ['auth', 'users', 'staff', 'guests', 'rooms', 'bookings', 'billing-accounts', 'invoices', 'payments', 'housekeeping', 'attendance', 'orders', 'maintenance', 'analytics', 'dashboard']) expect(spec.tags.map((t) => t.name)).toContain(tag);
    expect(spec.paths['/api/rooms/{id}'].get.parameters[0]).toMatchObject({ name: 'id', in: 'path', required: true });
  });

  test('EVERY protected endpoint has an explicit authorization policy (no route is left open by accident)', () => {
    const missing = ops.filter(({ method, path, op }) => {
      const key = `${method} ${path}`;
      if (PUBLIC.has(key)) return op.security.length > 0; // public ones must not claim auth
      if (op.security.length === 0) return true; // everything else must require authentication
      return !(op['x-permissions'] || op['x-roles'] || ANY_AUTHENTICATED.has(key));
    }).map(({ method, path }) => `${method} ${path}`);
    expect(missing).toEqual([]);
  });

  test('permissions in the docs match the real policy', () => {
    const get = (m, p) => spec.paths[p][m.toLowerCase()];
    expect(get('POST', '/api/rooms')['x-permissions']).toEqual({ mode: 'all', permissions: ['room:manage'] });
    expect(get('POST', '/api/rooms')['x-who-can'].roles).toEqual(['ADMIN', 'MANAGER']);
    expect(get('POST', '/api/managers')['x-who-can'].roles).toEqual(['ADMIN']);
    expect(get('POST', '/api/bookings/{id}/check-in')['x-who-can']).toMatchObject({ roles: ['ADMIN', 'MANAGER'], staffDepartments: ['RECEPTION'] });
    expect(get('GET', '/api/analytics/revenue')['x-who-can'].roles).toEqual(['ADMIN', 'MANAGER']);
    expect(get('POST', '/api/orders')['x-who-can'].roles).toEqual(['ADMIN', 'CUSTOMER']); // the matrix gives Admin every permission; the service still demands an active stay
    expect(get('GET', '/api/audit-logs')['x-who-can'].roles).toEqual(['ADMIN']);
  });

  test('request bodies come from the real Joi schemas', () => {
    const body = spec.paths['/api/auth/register'].post.requestBody.content['application/json'].schema;
    expect(body.properties.fullName).toMatchObject({ type: 'string', minLength: 2, maxLength: 120 });
    expect(body.required).toContain('fullName');
    const pay = spec.paths['/api/payments'].post.requestBody.content['application/json'].schema;
    expect(pay.properties.method.enum).toEqual(['CASH', 'CARD', 'BANK_TRANSFER']);
    expect(pay.properties.amountMinor).toMatchObject({ type: 'integer', minimum: 1 });
    expect(spec.paths['/api/rooms/availability'].get.parameters.find((p) => p.name === 'checkIn').required).toBe(true);
  });

  test('Swagger UI and the raw spec are served', async () => {
    const json = await request(app).get('/api/docs/openapi.json');
    expect(json.status).toBe(200);
    expect(json.body.openapi).toBe('3.0.3');
    const ui = await request(app).get('/api/docs/');
    expect(ui.status).toBe(200);
    expect(ui.text).toContain('swagger-ui');
  });

  test('Joi to JSON-schema conversion handles the common shapes', () => {
    const s = toJsonSchema(Joi.object({ a: Joi.string().valid('X', 'Y').required(), b: Joi.number().integer().min(1).max(5), c: Joi.array().items(Joi.string()).max(3), d: Joi.string().allow(null), e: Joi.boolean().default(true) }).describe());
    expect(s).toMatchObject({ type: 'object', required: ['a'], properties: { a: { enum: ['X', 'Y'] }, b: { type: 'integer', minimum: 1, maximum: 5 }, c: { type: 'array', maxItems: 3 }, d: { nullable: true }, e: { default: true } } });
  });
});
