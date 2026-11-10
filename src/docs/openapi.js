import { DEPARTMENT_PERMISSIONS, ROLE_PERMISSIONS } from '../constants/permissions.js';
import { ROLES } from '../constants/index.js';
import { toJsonSchema } from './joi-schema.js';

/** Static mount path of an Express 4 router layer ("/auth"), or '' when it is not a plain path. */
const mountPath = (layer) => {
  if (layer.regexp?.fast_slash) return '';
  const m = layer.regexp?.source.match(/^\^((?:\\\/[^\\/?()]+)+)\\\/\?\(\?=\\\/\|\$\)$/);
  return m ? m[1].replace(/\\\//g, '/') : '';
};

/** Walks the real router tree, collecting every route with the middlewares that guard it (router.use ones included). */
const collect = (stack, prefix = '', inherited = []) => {
  const out = []; const active = [...inherited];
  for (const layer of stack) {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods)) out.push({ method, path: prefix + layer.route.path, handlers: [...active, ...layer.route.stack.map((l) => l.handle)] });
    } else if (layer.name === 'router') out.push(...collect(layer.handle.stack, prefix + mountPath(layer), active));
    else if (layer.handle?.meta || layer.handle?.schemas) active.push(layer.handle);
  }
  return out;
};

const STAFF_BASE = ROLE_PERMISSIONS[ROLES.STAFF];
/** Which roles (and, for staff, which departments) satisfy a permission requirement. */
const whoCan = ({ permissions, mode }) => {
  const ok = (held) => (mode === 'any' ? permissions.some((p) => held.includes(p)) : permissions.every((p) => held.includes(p)));
  const roles = [ROLES.ADMIN, ROLES.MANAGER, ROLES.CUSTOMER].filter((r) => ok(ROLE_PERMISSIONS[r]));
  const depts = Object.entries(DEPARTMENT_PERMISSIONS).filter(([, perms]) => ok([...STAFF_BASE, ...perms])).map(([d]) => d);
  return { roles, staffDepartments: ok(STAFF_BASE) ? 'all' : depts };
};

const humanize = (s) => s.replace(/-/g, ' ');
const summarize = (method, path) => {
  const parts = path.split('/').filter(Boolean).slice(1); const last = parts.at(-1); const isParam = (p) => p?.startsWith('{');
  const resource = humanize(parts.filter((p) => !isParam(p))[0] ?? '');
  if (isParam(last)) return `${{ get: 'Get', patch: 'Update', put: 'Update', delete: 'Delete' }[method] ?? method} ${resource}`;
  const sub = parts.filter((p) => !isParam(p));
  if (sub.length > 1 && method === 'post') return `${humanize(sub.at(-1))} (${resource})`;
  if (sub.length > 1) return `${method === 'get' ? 'Get' : method} ${humanize(sub.slice(1).join(' '))} (${resource})`;
  return `${{ get: 'List', post: 'Create' }[method] ?? method} ${resource}`;
};

export const buildOpenApi = (app, { title = 'Hotel Management API', version = '1.0.0' } = {}) => {
  const paths = {};
  const routes = collect(app._router.stack).filter((r) => r.path.startsWith('/api/') && !r.path.startsWith('/api/docs'));
  for (const r of routes) {
    const path = r.path.replace(/:([A-Za-z]+)/g, '{$1}').replace(/\/$/, '');
    const metas = r.handlers.map((h) => h.meta).filter(Boolean);
    const schemas = r.handlers.map((h) => h.schemas).find(Boolean) ?? {};
    const authenticated = metas.some((m) => m.auth);
    const perm = metas.find((m) => m.permissions); const roleRule = metas.find((m) => m.roles);
    const tag = path.split('/')[2];
    const parameters = [];
    for (const where of ['params', 'query']) {
      if (!schemas[where]) continue;
      const d = schemas[where].describe();
      for (const [name, v] of Object.entries(d.keys ?? {})) parameters.push({ name, in: where === 'params' ? 'path' : 'query', required: where === 'params' || v.flags?.presence === 'required', schema: toJsonSchema(v) });
    }
    for (const m of path.matchAll(/\{(\w+)\}/g)) if (!parameters.some((p) => p.in === 'path' && p.name === m[1])) parameters.push({ name: m[1], in: 'path', required: true, schema: { type: 'string' } });

    const access = perm ? whoCan(perm) : null;
    const op = {
      tags: [tag], summary: summarize(r.method, path), parameters,
      ...(authenticated ? { security: [{ bearerAuth: [] }, { cookieAuth: [] }] } : { security: [] }),
      'x-permissions': perm ? { mode: perm.mode, permissions: perm.permissions } : undefined,
      'x-roles': roleRule?.roles,
      'x-who-can': access ?? undefined,
      description: [
        !authenticated ? 'Public endpoint.' : perm ? `Requires ${perm.mode === 'any' ? 'at least one' : 'all'} of: ${perm.permissions.map((p) => `\`${p}\``).join(', ')}.\n\nHeld by: ${access.roles.join(', ') || 'no role directly'}${access.staffDepartments === 'all' ? ', every STAFF member' : access.staffDepartments.length ? `, STAFF in departments ${access.staffDepartments.join(', ')}` : ''}. Scope (own records / own team) is enforced per resource.` : roleRule ? `Restricted to roles: ${roleRule.roles.join(', ')}.` : 'Any authenticated user (the data returned is always the caller\'s own).',
        authenticated && !['get', 'head'].includes(r.method) ? 'Cookie-authenticated browsers must send `X-Requested-With: XMLHttpRequest` (CSRF protection); Bearer clients are exempt.' : '',
      ].filter(Boolean).join('\n\n'),
      responses: {
        200: { description: 'Success', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
        400: { $ref: '#/components/responses/Error' }, 401: { $ref: '#/components/responses/Error' }, 403: { $ref: '#/components/responses/Error' }, 404: { $ref: '#/components/responses/Error' }, 409: { $ref: '#/components/responses/Error' }, 422: { $ref: '#/components/responses/Error' }, 429: { $ref: '#/components/responses/Error' },
      },
    };
    if (schemas.body) op.requestBody = { required: true, content: { 'application/json': { schema: toJsonSchema(schemas.body.describe()) } } };
    (paths[path] ??= {})[r.method] = op;
  }
  return {
    openapi: '3.0.3',
    info: { title, version, description: 'Generated from the live route table: paths, required permissions and request schemas come from the code itself.\n\n**Conventions** — Money is an integer in minor units (VND has none: 150000 = 150,000 VND). Dates in stays are hotel-local `YYYY-MM-DD` keys; instants are ISO-8601 UTC. Lists return `data: []` plus `meta: {page, limit, total, totalPages}`. Errors: `{success:false, message, code, errors[], requestId}`. Browser clients authenticate with HTTP-only cookies and must send `X-Requested-With: XMLHttpRequest` on state-changing requests.' },
    servers: [{ url: '/' }],
    tags: [...new Set(Object.values(paths).flatMap((p) => Object.values(p).flatMap((o) => o.tags)))].sort().map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, cookieAuth: { type: 'apiKey', in: 'cookie', name: 'access_token' } },
      schemas: { Success: { type: 'object', properties: { success: { type: 'boolean', example: true }, message: { type: 'string' }, data: {}, meta: { type: 'object' } } }, Error: { type: 'object', properties: { success: { type: 'boolean', example: false }, message: { type: 'string' }, code: { type: 'string' }, errors: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' }, message: { type: 'string' } } } }, requestId: { type: 'string' } } } },
      responses: { Error: { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } },
    },
  };
};
