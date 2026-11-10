import fs from 'node:fs';

// Building the route table needs no real secrets or database: fall back to placeholders so this runs anywhere (CI included).
process.env.MONGODB_URI ??= 'mongodb://localhost:27017/docs';
process.env.JWT_ACCESS_SECRET ??= 'docs-only-secret-docs-only-secret-0000';
process.env.OTP_SECRET ??= 'docs-only-secret-docs-only-secret-1111';
process.env.PII_ENCRYPTION_KEY ??= '0'.repeat(64);
process.env.NODE_ENV ??= 'test';
const { default: app } = await import('../src/app.js');
const { example } = await import('../src/docs/joi-schema.js');
const { buildOpenApi } = await import('../src/docs/openapi.js');

/** Writes docs/openapi.json and docs/postman_collection.json from the live route table. */
const spec = buildOpenApi(app);
fs.mkdirSync('docs', { recursive: true });
fs.writeFileSync('docs/openapi.json', `${JSON.stringify(spec, null, 2)}\n`);

const folders = {};
for (const [path, ops] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(ops)) {
    const url = `{{baseUrl}}${path.replace(/\{(\w+)\}/g, ':$1')}`;
    const query = (op.parameters ?? []).filter((p) => p.in === 'query').map((p) => ({ key: p.name, value: String(example(p.schema, p.name) ?? ''), disabled: !p.required }));
    const item = {
      name: `${method.toUpperCase()} ${path}`,
      request: {
        method: method.toUpperCase(),
        header: [{ key: 'Content-Type', value: 'application/json' }, { key: 'X-Requested-With', value: 'XMLHttpRequest' }],
        url: { raw: url, host: ['{{baseUrl}}'], path: path.split('/').filter(Boolean).map((p) => p.replace(/^\{(\w+)\}$/, ':$1')), query, variable: (op.parameters ?? []).filter((p) => p.in === 'path').map((p) => ({ key: p.name, value: `{{${p.name}}}` })) },
        description: op.description,
        ...(op.requestBody ? { body: { mode: 'raw', raw: JSON.stringify(example(op.requestBody.content['application/json'].schema), null, 2), options: { raw: { language: 'json' } } } } : {}),
      },
    };
    (folders[op.tags[0]] ??= []).push(item);
  }
}
fs.writeFileSync('docs/postman_collection.json', `${JSON.stringify({
  info: { name: 'Hotel Management API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json', description: 'Log in with POST /api/auth/login first: Postman keeps the HTTP-only cookies. The X-Requested-With header is already set (CSRF).' },
  variable: [{ key: 'baseUrl', value: 'http://localhost:5000' }, { key: 'id', value: '' }],
  item: Object.entries(folders).sort(([a], [b]) => a.localeCompare(b)).map(([name, item]) => ({ name, item })),
}, null, 2)}\n`);
// eslint-disable-next-line no-console
console.log(`OpenAPI: ${Object.values(spec.paths).reduce((n, p) => n + Object.keys(p).length, 0)} operations in ${spec.tags.length} groups`);
