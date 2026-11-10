import request from 'supertest';
import app from '../../src/app.js';

describe('app shell', () => {
  test('GET /api/health returns the standard success envelope', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, message: 'OK', data: { status: 'ok' } });
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  test('sets security headers and hides Express', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  test('readiness is 503 when the database is not connected', async () => {
    const res = await request(app).get('/api/health/ready');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ success: false, code: 'DB_NOT_READY', errors: [] });
  });

  test('unknown routes return the standard error envelope', async () => {
    const res = await request(app).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, code: 'ROUTE_NOT_FOUND' });
    expect(res.body.stack).toBeUndefined();
  });

  test('malformed JSON gives 400, not a 500', async () => {
    const res = await request(app).post('/api/health').set('Content-Type', 'application/json').send('{bad');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_JSON');
  });

  test('NoSQL operator payloads are rejected', async () => {
    const res = await request(app).post('/api/health').send({ email: { $ne: null } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
  });

  test('CORS: allowed origin gets credentials, unknown origin is refused', async () => {
    const ok = await request(app).get('/api/health').set('Origin', 'http://localhost:3000');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const bad = await request(app).get('/api/health').set('Origin', 'https://evil.example');
    expect(bad.status).toBe(403);
    expect(bad.body.code).toBe('CORS_FORBIDDEN');
  });
});
